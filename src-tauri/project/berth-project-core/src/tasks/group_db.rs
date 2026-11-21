//! 群记录库 `<空间目录>/local/groups/group.db`（SQLite，WAL，0600）：每个群的事件按 seq 存一行。
//! 会被过滤的字段（群、seq、时间、类型、作者、收件人、任务、引用、幂等键）单独成列并建索引；
//! `json` 列只存原样事件、只整行取出，不在它上面做文本搜索。追加在 IMMEDIATE 事务里分配 seq，
//! GUI / CLI / watch 多进程并发写由 SQLite 串行化。旧的 `<群>.jsonl` 首次打开时一次性导入，原文件改名 `.jsonl.imported` 留底。

use std::fs;
use std::path::Path;
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::{json, Map, Value};

use super::{TaskError, TaskResult};

const SCHEMA: &str = r#"
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS events (
    grp TEXT NOT NULL,
    seq INTEGER NOT NULL,
    at INTEGER,
    kind TEXT,
    author TEXT,
    "to" TEXT,
    task TEXT,
    reply_to INTEGER,
    idem TEXT,
    json TEXT NOT NULL,
    PRIMARY KEY (grp, seq)
);
CREATE INDEX IF NOT EXISTS events_to ON events (grp, "to", seq);
CREATE INDEX IF NOT EXISTS events_kind ON events (grp, kind, seq);
CREATE UNIQUE INDEX IF NOT EXISTS events_idem ON events (grp, idem) WHERE idem IS NOT NULL;
"#;

fn db_error(error: rusqlite::Error) -> TaskError {
    TaskError::new("io_error", format!("group.db: {error}"))
}

pub(super) fn open(dir: &Path) -> TaskResult<Connection> {
    fs::create_dir_all(dir)?;
    let path = dir.join("group.db");
    let fresh = !path.exists();
    let mut conn = Connection::open(&path).map_err(db_error)?;
    #[cfg(unix)]
    if fresh {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    let _ = fresh;
    conn.busy_timeout(Duration::from_secs(10)).map_err(db_error)?;
    conn.execute_batch(SCHEMA).map_err(db_error)?;
    import_jsonl(dir, &mut conn)?;
    Ok(conn)
}

fn text(event: &Map<String, Value>, key: &str) -> Option<String> {
    event
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn insert(conn: &Connection, name: &str, event: &Map<String, Value>) -> TaskResult<()> {
    let json = serde_json::to_string(event).map_err(|error| TaskError::new("io_error", error.to_string()))?;
    conn.execute(
        r#"INSERT OR IGNORE INTO events (grp, seq, at, kind, author, "to", task, reply_to, idem, json)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)"#,
        params![
            name,
            event.get("seq").and_then(Value::as_u64).unwrap_or(0) as i64,
            event.get("timestamp_ms").and_then(Value::as_i64),
            text(event, "kind"),
            text(event, "author"),
            text(event, "to"),
            text(event, "task"),
            event.get("reply_to").and_then(Value::as_i64),
            text(event, "idempotency_key"),
            json,
        ],
    )
    .map_err(db_error)?;
    Ok(())
}

/// `<群>.jsonl` 整份在一个事务里导入（按原 seq，重复导入被主键忽略），提交后改名留底。
fn import_jsonl(dir: &Path, conn: &mut Connection) -> TaskResult<()> {
    for entry in fs::read_dir(dir)?.flatten() {
        let path = entry.path();
        if path.extension().is_none_or(|ext| ext != "jsonl") {
            continue;
        }
        let Some(name) = path.file_stem().and_then(|stem| stem.to_str()).map(str::to_owned) else {
            continue;
        };
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        // 别的进程等锁时已导完并改名。
        let Ok(content) = fs::read_to_string(&path) else {
            continue;
        };
        let mut next = 0u64;
        for line in content.lines().filter(|line| !line.trim().is_empty()) {
            let Ok(Value::Object(mut event)) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            let seq = event.get("seq").and_then(Value::as_u64).unwrap_or(next + 1);
            next = next.max(seq);
            event.insert("seq".into(), json!(seq));
            insert(&tx, &name, &event)?;
        }
        tx.commit().map_err(db_error)?;
        fs::rename(&path, path.with_extension("jsonl.imported"))?;
    }
    Ok(())
}

/// 追加一条（补 `schema_version` / `seq` / `timestamp_ms`）；带 `idempotency_key` 且已有同键事件时返回旧事件与 `false`。
pub(super) fn append(dir: &Path, name: &str, mut event: Map<String, Value>) -> TaskResult<(Value, bool)> {
    let mut conn = open(dir)?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    if let Some(key) = text(&event, "idempotency_key") {
        let previous: Option<String> = tx
            .query_row(
                "SELECT json FROM events WHERE grp = ?1 AND idem = ?2",
                params![name, key],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_error)?;
        if let Some(previous) = previous {
            return Ok((parse(&previous)?, false));
        }
    }
    let last: i64 = tx
        .query_row("SELECT COALESCE(MAX(seq), 0) FROM events WHERE grp = ?1", [name], |row| row.get(0))
        .map_err(db_error)?;
    event.insert("schema_version".into(), json!(1));
    event.insert("seq".into(), json!(last + 1));
    event.insert("timestamp_ms".into(), json!(chrono::Utc::now().timestamp_millis()));
    insert(&tx, name, &event)?;
    tx.commit().map_err(db_error)?;
    Ok((Value::Object(event), true))
}

fn parse(json: &str) -> TaskResult<Value> {
    serde_json::from_str(json).map_err(|error| TaskError::new("invalid_json", format!("Malformed group event: {error}")))
}

fn collect(conn: &Connection, sql: &str, params: impl rusqlite::Params) -> TaskResult<Vec<Value>> {
    let mut statement = conn.prepare_cached(sql).map_err(db_error)?;
    let rows = statement
        .query_map(params, |row| row.get::<_, String>(0))
        .map_err(db_error)?;
    rows.map(|row| parse(&row.map_err(db_error)?)).collect()
}

/// `after` 之后的全部事件，按 seq。
pub(super) fn after(dir: &Path, name: &str, after: u64) -> TaskResult<Vec<Value>> {
    let conn = open(dir)?;
    collect(
        &conn,
        "SELECT json FROM events WHERE grp = ?1 AND seq > ?2 ORDER BY seq",
        params![name, after as i64],
    )
}

/// 一页：`after` 与 `before`（不含）之间、发给所有人或 `to` 的最近 `limit` 条，按 seq 升序；
/// 另返回群里最大的 seq 与这页之前是否还有更早的。
pub(super) fn page(
    dir: &Path,
    name: &str,
    after: u64,
    before: Option<u64>,
    limit: usize,
    to: Option<&str>,
) -> TaskResult<(Vec<Value>, u64, bool)> {
    let conn = open(dir)?;
    let before = before.map_or(i64::MAX, |before| before as i64);
    let filter = r#"grp = ?1 AND seq > ?2 AND seq < ?3 AND (?4 IS NULL OR "to" IS NULL OR "to" = ?4)"#;
    let mut events = collect(
        &conn,
        &format!("SELECT json FROM events WHERE {filter} ORDER BY seq DESC LIMIT ?5"),
        params![name, after as i64, before, to, limit as i64],
    )?;
    events.reverse();
    let first = events.first().map_or(before, |event| super::group::seq(event) as i64);
    let more: bool = conn
        .query_row(
            &format!("SELECT EXISTS (SELECT 1 FROM events WHERE {filter})"),
            params![name, after as i64, first, to],
            |row| row.get(0),
        )
        .map_err(db_error)?;
    let last: i64 = conn
        .query_row("SELECT COALESCE(MAX(seq), 0) FROM events WHERE grp = ?1", [name], |row| row.get(0))
        .map_err(db_error)?;
    Ok((events, last as u64, more))
}

pub(super) fn exists(dir: &Path, name: &str) -> bool {
    dir.join("group.db").is_file()
        && open(dir)
            .and_then(|conn| {
                conn.query_row("SELECT EXISTS (SELECT 1 FROM events WHERE grp = ?1)", [name], |row| row.get(0))
                    .map_err(db_error)
            })
            .unwrap_or(false)
}

pub(super) fn remove(dir: &Path, name: &str) -> TaskResult<()> {
    open(dir)?
        .execute("DELETE FROM events WHERE grp = ?1", [name])
        .map_err(db_error)?;
    Ok(())
}
