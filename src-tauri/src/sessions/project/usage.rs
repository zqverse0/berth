//! 项目 token 用量（首页「Token 用量」）：本项目全部 Agent 会话里每次请求报回的用量，按天 × Agent × 模型汇总。
//! 会话范围与侧栏「会话」视图一致（主 checkout 与各群目录）；单个文件的汇总按 mtime 缓存，没变的文件不重读。

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use berth_project_core::tasks::{main_project, session_links::session_links};
use berth_tool_core::session_files::{appended_records, readable_spec, recent_sessions, records};
use berth_tool_core::sessions::{
    parse_usage, record_matches, select_json, select_relative, value_string, SessionSpec, Usage,
};
use chrono::{Local, NaiveDate};
use serde::Serialize;

use crate::sessions::declarative::parse_time;

/// 一天 × 一个 Agent × 一个模型的用量。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsageRow {
    /// 本地日期 `YYYY-MM-DD`
    pub date: String,
    /// 工具 id（`tools/<id>`）
    pub agent: String,
    pub model: Option<String>,
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    /// 请求次数（报回用量的回复条数）
    pub requests: u64,
}

type DayModel = (NaiveDate, Option<String>);

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct Totals {
    usage: Usage,
    requests: u64,
}

impl Totals {
    fn add(&mut self, other: Totals) {
        self.usage.input += other.usage.input;
        self.usage.output += other.usage.output;
        self.usage.cache_read += other.usage.cache_read;
        self.usage.cache_write += other.usage.cache_write;
        self.requests += other.requests;
    }
}

/// 一个会话文件的汇总；JSONL 记着读到的位置与上一份用量，追加后接着读。
#[derive(Debug, Default, Clone)]
struct Scanned {
    totals: BTreeMap<DayModel, Totals>,
    previous: Option<Usage>,
    offset: u64,
}

/// ponytail: 缓存只增不删（每个会话文件几行），会话很多时再按最近访问裁剪。
type FileCache = HashMap<PathBuf, (u64, Arc<Scanned>)>;

fn cache() -> &'static Mutex<FileCache> {
    static CACHE: OnceLock<Mutex<FileCache>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// `project_path` 所在项目近 `days` 天（含今天）的用量，按日期、Agent、模型排序。
pub(crate) fn project_token_usage(
    project_path: &Path,
    days: u32,
) -> Result<Vec<TokenUsageRow>, String> {
    // ponytail: 全局锁，冷缓存时并发请求（多个页面 / 重连补发）只扫一遍，后来者命中缓存；
    // 多项目同时冷启动互相等待，真成问题再按项目分锁。
    static SCAN: Mutex<()> = Mutex::new(());
    let _scan = SCAN.lock().unwrap_or_else(|e| e.into_inner());
    let main = main_project(project_path).map_err(|error| error.to_string())?;
    let links = session_links(&main).map_err(|error| error.to_string())?;
    let today = Local::now().date_naive();
    let first = today - chrono::Days::new(u64::from(days.max(1) - 1));
    // 文件 mtime 早于起始日前一天的会话不可能有这段时间的请求
    let since_ms =
        (Local::now().timestamp_millis() - i64::from(days + 1) * 86_400_000).max(0) as u64;
    let mut totals = BTreeMap::<(NaiveDate, String, Option<String>), Totals>::new();
    for agent in berth_tool_core::repository::list_tool_asset_ids() {
        let Ok(spec) = readable_spec(&agent) else {
            continue;
        };
        for session in recent_sessions(&spec, since_ms, |cwd| links.group_of(cwd).is_some()) {
            for ((date, model), value) in file_usage(&spec, &session.path, session.updated_at)
                .totals
                .iter()
            {
                if *date >= first {
                    totals
                        .entry((*date, agent.clone(), model.clone()))
                        .or_default()
                        .add(*value);
                }
            }
        }
    }
    Ok(totals
        .into_iter()
        .map(|((date, agent, model), value)| TokenUsageRow {
            date: date.format("%Y-%m-%d").to_string(),
            agent,
            model,
            input: value.usage.input,
            output: value.usage.output,
            cache_read: value.usage.cache_read,
            cache_write: value.usage.cache_write,
            requests: value.requests,
        })
        .collect())
}

fn file_usage(spec: &SessionSpec, path: &Path, mtime: u64) -> Arc<Scanned> {
    let cached = cache()
        .lock()
        .ok()
        .and_then(|cache| cache.get(path).cloned());
    if let Some((cached_mtime, value)) = &cached {
        if *cached_mtime == mtime {
            return value.clone();
        }
    }
    let Some(message) = spec.message.as_ref() else {
        return Arc::default();
    };
    let value = Arc::new(if spec.storage == "json" {
        // JSON 文档整份重写，只能整份重读
        let mut scanned = Scanned::default();
        tally(message, records(spec, path), &mut scanned);
        scanned
    } else {
        // JSONL 只追加：接着上次的位置读；文件变短说明被重写，从头来
        let len = std::fs::metadata(path).map(|meta| meta.len()).unwrap_or(0);
        let mut scanned = cached
            .map(|(_, value)| (*value).clone())
            .filter(|value| value.offset <= len)
            .unwrap_or_default();
        let (values, offset) = appended_records(path, scanned.offset);
        tally(message, values.into_iter(), &mut scanned);
        scanned.offset = offset;
        scanned
    });
    if let Ok(mut cache) = cache().lock() {
        cache.insert(path.to_owned(), (mtime, value.clone()));
    }
    value
}

fn tally(
    message: &berth_tool_core::sessions::FieldSpec,
    values: impl Iterator<Item = serde_json::Value>,
    scanned: &mut Scanned,
) {
    let Scanned {
        totals: out,
        previous,
        ..
    } = scanned;
    for value in values {
        if !record_matches(&value, message) {
            continue;
        }
        let nested = message
            .value
            .as_ref()
            .and_then(|selector| select_json(&value, selector));
        let field = |selector| select_relative(nested.as_ref(), &value, selector);
        let Some(usage) = field(message.usage.as_ref()).as_ref().and_then(parse_usage) else {
            continue;
        };
        // 一次回复拆成多行时每行带同一份用量（Claude 按内容块写行）：与上一份相同只记一次
        if *previous == Some(usage) {
            continue;
        }
        *previous = Some(usage);
        let Some(time) = field(message.time.as_ref()).as_ref().and_then(parse_time) else {
            continue;
        };
        let model = field(message.model.as_ref())
            .as_ref()
            .and_then(value_string);
        out.entry((time.with_timezone(&Local).date_naive(), model))
            .or_default()
            .add(Totals { usage, requests: 1 });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn repeated_usage_lines_count_once_and_split_by_day_and_model() {
        let dir = std::env::temp_dir().join(format!("berth-usage-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("s.jsonl");
        let line = |time: &str, model: &str, input: u64| {
            format!(
                r#"{{"type":"assistant","timestamp":"{time}","message":{{"model":"{model}","usage":{{"input_tokens":{input},"output_tokens":5}}}}}}"#
            )
        };
        let noon = |day: u32| {
            Local
                .with_ymd_and_hms(2026, 11, day, 12, 0, 0)
                .unwrap()
                .with_timezone(&chrono::Utc)
                .to_rfc3339()
        };
        let text = [
            line(&noon(1), "m1", 10),
            line(&noon(1), "m1", 10), // 同一次回复的第二个内容块
            line(&noon(1), "m1", 20),
            line(&noon(2), "m2", 30),
        ]
        .join("\n")
            + "\n";
        let spec: SessionSpec = serde_json::from_value(serde_json::json!({
            "storage": "jsonl", "path": dir,
            "message": { "record": "assistant", "value": "/message", "model": "/model", "time": "/timestamp", "usage": "/usage" }
        }))
        .unwrap();
        // 先写到第二行中间（Agent 还在写），再补完：追加读取与一次读完结果相同，跨批次的重复行也只记一次
        let cut = text.find('\n').unwrap() + 20;
        std::fs::write(&path, &text[..cut]).unwrap();
        assert_eq!(
            file_usage(&spec, &path, 1)
                .totals
                .values()
                .map(|t| t.requests)
                .sum::<u64>(),
            1
        );
        std::fs::write(&path, &text).unwrap();
        let totals = file_usage(&spec, &path, 2).totals.clone();
        let day = |d| NaiveDate::from_ymd_opt(2026, 11, d).unwrap();
        let m1 = totals[&(day(1), Some("m1".into()))];
        assert_eq!((m1.usage.input, m1.usage.output, m1.requests), (30, 10, 2));
        assert_eq!(totals[&(day(2), Some("m2".into()))].requests, 1);
        std::fs::remove_dir_all(dir).ok();
    }
}
