//! Contract-driven session reader for ordinary JSONL and SQLite stores.
//!
//! The tool package declares field locations in `sessions.json`; this module
//! owns only selector projection, compatibility slots, and the two read-only
//! stores. A bad or missing declaration is an unsupported source; there is no
//! Agent-specific parser fallback.

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use chrono::{DateTime, TimeZone, Utc};
use rusqlite::{types::ValueRef, Connection, OpenFlags, Row};
use serde_json::{Map, Value};
use walkdir::WalkDir;

use crate::models::agent::parse_known_agent_type;
use crate::models::{
    AgentType, ContentBlock, ContextSource, ConversationDetail, ConversationSummary, MessageRole,
    MessageTurn,
    TurnRole, TurnUsage, UnifiedMessage,
};
use crate::sessions::{
    bounded_native_file_candidates, compute_session_stats, decode_native_page_cursor,
    encode_native_page_cursor, folder_name_from_path, native_page_matches_search,
    path_eq_for_matching, title_from_user_text, truncate_str, AgentParser, NativeConversationPage,
    NativeConversationPageRequest, NativeFilePageCursor, ParseError,
};
// 声明类型与 selector 语义在 berth-tool-core，CLI `berth session last` 共用同一份。
use berth_tool_core::sessions::*;

impl From<SessionSpecError> for ParseError {
    fn from(error: SessionSpecError) -> Self {
        match error {
            SessionSpecError::Io(error) => Self::Io(error),
            SessionSpecError::Json(error) => Self::Json(error),
            SessionSpecError::Invalid(message) => Self::InvalidData(message),
        }
    }
}

const MAX_LINE_BYTES: usize = 16 * 1024 * 1024;

/// 工具调用 meta 中的技能名列表键，前端据此统计与筛选。
const SKILL_META_KEY: &str = "berth.skills";

fn skill_names(tool_name: &str, input: &str, spec: &SkillSpec) -> Vec<String> {
    let mut names = Vec::new();
    if spec.tool_names.iter().any(|name| name == tool_name) {
        let key = spec.name_key.as_deref().unwrap_or("skill");
        if let Some(name) = serde_json::from_str::<Value>(input)
            .ok()
            .and_then(|value| value.get(key).and_then(Value::as_str).map(str::to_owned))
            .filter(|name| !name.is_empty())
        {
            names.push(name);
        }
    }
    for (index, _) in input.match_indices("/SKILL.md") {
        let mut segments = input[..index].rsplit(['/', '\\']);
        let name = segments.next().unwrap_or("");
        let valid = !name.is_empty()
            && segments.next() == Some("skills")
            && name
                .chars()
                .all(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '.' | ':'));
        if valid && !names.iter().any(|known| known == name) {
            names.push(name.to_owned());
        }
    }
    names
}

/// 给加载技能的工具调用写入 `meta["berth.skills"]`。
fn annotate_skills(turns: &mut [MessageTurn], spec: &SkillSpec) {
    for block in turns.iter_mut().flat_map(|turn| turn.blocks.iter_mut()) {
        let ContentBlock::ToolUse {
            tool_name,
            input_preview: Some(input),
            meta,
            ..
        } = block
        else {
            continue;
        };
        let names = skill_names(tool_name, input, spec);
        if names.is_empty() {
            continue;
        }
        let meta = meta.get_or_insert_with(|| Value::Object(Map::new()));
        if let Some(object) = meta.as_object_mut() {
            object.insert(SKILL_META_KEY.to_owned(), Value::from(names));
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Storage {
    Jsonl,
    /// 一个文件一份会话文档，展开成与 JSONL 同形的记录流（会话记录在前），见
    /// `berth_tool_core::sessions::json_document_records`。
    Json,
    Sqlite,
}

#[derive(Debug, Clone)]
struct ParsedSession {
    id: Option<String>,
    project: Option<String>,
    title: Option<String>,
    first_user_text: Option<String>,
    model: Option<String>,
    session_fields: BTreeMap<String, Value>,
    first_ts: Option<DateTime<Utc>>,
    last_ts: Option<DateTime<Utc>>,
    message_count: u32,
    messages: Vec<UnifiedMessage>,
    context: Vec<ContextItem>,
}

impl Default for ParsedSession {
    fn default() -> Self {
        Self {
            id: None,
            project: None,
            title: None,
            first_user_text: None,
            model: None,
            session_fields: BTreeMap::new(),
            first_ts: None,
            last_ts: None,
            message_count: 0,
            messages: Vec::new(),
            context: Vec::new(),
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct DeclarativeSessionParser {
    agent_type: AgentType,
    spec: SessionSpec,
    root: PathBuf,
}

/// One valid session declaration discovered from a Tool Asset.
///
/// Keeping declaration discovery here prevents the conversation command and
/// importer from carrying a second hard-coded Agent list.
#[derive(Debug, Clone)]
pub(crate) struct DeclaredSessionSource {
    pub tool_id: String,
    pub root: PathBuf,
    pub is_file: bool,
}

static LOCATORS: OnceLock<Mutex<HashMap<(AgentType, String), PathBuf>>> = OnceLock::new();

fn locator_cache() -> &'static Mutex<HashMap<(AgentType, String), PathBuf>> {
    LOCATORS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) fn cached_source_locator(agent_type: AgentType, id: &str) -> Option<PathBuf> {
    locator_cache()
        .lock()
        .ok()
        .and_then(|cache| cache.get(&(agent_type, id.to_owned())).cloned())
}

/// Hydrate the in-process locator cache from the persisted project-session
/// index.  The index stores only a path (never executable/query text), so a
/// stale value is harmless: the JSONL reader validates it and falls back to
/// the declared root when the file no longer exists.
pub(crate) fn remember_source_locator(agent_type: AgentType, id: &str, path: &Path) {
    remember_locator(agent_type, id, path);
}

/// 会话源文件的变化标记（大小 + 修改时间，SQLite 另含 WAL）。只 stat 不解析，
/// 阅读器据此判断是否需要重读；定位不到源文件时为 `None`。
pub(crate) fn source_revision(agent_type: AgentType, id: &str) -> Option<String> {
    let path = match cached_source_locator(agent_type, id) {
        Some(path) => path,
        None => match declared_root(agent_type)? {
            (root, true) => root,
            (_, false) => return None,
        },
    };
    let stamp = |path: &Path| {
        fs::metadata(path).ok().map(|meta| {
            let modified = meta
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |elapsed| elapsed.as_nanos());
            format!("{}:{modified}", meta.len())
        })
    };
    let mut revision = stamp(&path)?;
    let mut wal = path.into_os_string();
    wal.push("-wal");
    if let Some(wal) = stamp(Path::new(&wal)) {
        revision.push('+');
        revision.push_str(&wal);
    }
    Some(revision)
}

pub(crate) fn declared_root(agent_type: AgentType) -> Option<(PathBuf, bool)> {
    let parser = DeclarativeSessionParser::for_agent(agent_type)
        .ok()
        .flatten()?;
    Some((
        parser.root,
        matches!(storage_kind(&parser.spec.storage), Ok(Storage::Sqlite)),
    ))
}

impl DeclarativeSessionParser {
    /// Load the optional `sessions.json` referenced by the Tool Asset.
    pub(crate) fn for_agent(agent_type: AgentType) -> Result<Option<Self>, ParseError> {
        let Some((tool_id, asset)) = find_agent_tool_asset(agent_type)? else {
            return Ok(None);
        };
        let Some(spec) = load_session_spec(&tool_id, &asset)? else {
            return Ok(None);
        };
        Self::new(agent_type, spec)
    }

    pub(crate) fn declared(agent_type: AgentType) -> bool {
        matches!(Self::for_agent(agent_type), Ok(Some(_)))
    }

    #[cfg(test)]
    fn from_spec(agent_type: AgentType, spec: SessionSpec) -> Result<Self, ParseError> {
        Self::new(agent_type, spec)?
            .ok_or_else(|| ParseError::InvalidData("empty session spec".into()))
    }

    fn new(agent_type: AgentType, spec: SessionSpec) -> Result<Option<Self>, ParseError> {
        let storage = storage_kind(&spec.storage)?;
        if spec.path.trim().is_empty() {
            return Err(ParseError::InvalidData("sessions path is empty".into()));
        }
        validate_spec(storage, &spec)?;
        Ok(Some(Self {
            agent_type,
            root: expand_path(&spec.path),
            spec,
        }))
    }

    /// `since` 之后改动过、属于 `projects` 之一的会话详情，供知识整理摘要（`knowledge.digest`）。
    /// 先按文件修改时间过滤，只解析改动过的文件；只支持 jsonl 存储。
    pub(crate) fn recent_details(
        &self,
        projects: &[String],
        since: std::time::SystemTime,
    ) -> Result<Vec<ConversationDetail>, ParseError> {
        if storage_kind(&self.spec.storage)? == Storage::Sqlite {
            return Err(ParseError::InvalidData(
                "only jsonl / json session storage is supported".into(),
            ));
        }
        let mut details = Vec::new();
        for path in self.jsonl_files() {
            // ponytail: 按目录名排除子代理记录（其 user 是主 agent 的指令）；声明里有标记字段时再改。
            if path.components().any(|part| part.as_os_str() == "subagents") {
                continue;
            }
            let modified = fs::metadata(&path).and_then(|metadata| metadata.modified());
            if modified.map_or(true, |time| time <= since) {
                continue;
            }
            // 先读文件开头的会话记录判断项目，别的项目不做完整解析；判断不了再走完整解析。
            if jsonl_project(&path, &self.spec).is_some_and(|project| {
                !projects
                    .iter()
                    .any(|candidate| path_eq_for_matching(&project, candidate))
            }) {
                continue;
            }
            let Ok(parsed) = parse_jsonl(&path, &self.spec, true) else {
                continue;
            };
            let in_project = parsed.project.as_deref().is_some_and(|project| {
                projects
                    .iter()
                    .any(|candidate| path_eq_for_matching(project, candidate))
            });
            if !in_project {
                continue;
            }
            let id = parsed.id.clone().unwrap_or_else(|| {
                path.file_stem()
                    .map(|value| value.to_string_lossy().into_owned())
                    .unwrap_or_default()
            });
            details.push(self.detail_from_parsed(parsed, &id)?);
        }
        Ok(details)
    }

    /// 已知会话文件的详情（会话分类按成员绑定的文件读取）；只支持 jsonl 存储。
    pub(crate) fn detail_at(&self, path: &Path) -> Result<ConversationDetail, ParseError> {
        if storage_kind(&self.spec.storage)? == Storage::Sqlite {
            return Err(ParseError::InvalidData(
                "only jsonl / json session storage is supported".into(),
            ));
        }
        let parsed = parse_jsonl(path, &self.spec, true)?;
        let id = parsed.id.clone().unwrap_or_else(|| {
            path.file_stem()
                .map(|value| value.to_string_lossy().into_owned())
                .unwrap_or_default()
        });
        self.detail_from_parsed(parsed, &id)
    }

    fn list_jsonl(
        &self,
        request: &NativeConversationPageRequest,
    ) -> Result<NativeConversationPage, ParseError> {
        let paths = self.jsonl_files();
        let after = request
            .cursor
            .as_deref()
            .map(decode_native_page_cursor::<NativeFilePageCursor>)
            .transpose()?;
        let (candidates, more) =
            bounded_native_file_candidates(paths, after.as_ref(), request.scan_budget);
        let mut items = Vec::new();
        let mut last = None;
        let mut stopped = false;
        for candidate in candidates {
            last = Some(candidate.cursor.clone());
            crate::sessions::scan_diagnostics::record_scanned(1);
            // Summary pages must not materialize transcript blocks.  The
            // declared file is streamed once for metadata; detail opens it
            // again only after the user selects a session.
            let parsed = parse_jsonl(&candidate.path, &self.spec, false)?;
            let Some(summary) = self.summary_from_parsed(&candidate.path, parsed) else {
                continue;
            };
            if (!request.project_path.trim().is_empty()
                && !path_eq_for_matching(
                    summary.folder_path.as_deref().unwrap_or_default(),
                    &request.project_path,
                ))
                || !native_page_matches_search(&summary, request.search.as_deref())
            {
                continue;
            }
            items.push(summary);
            crate::sessions::scan_diagnostics::record_retained_after_filter(1);
            if items.len() >= request.limit.max(1) {
                stopped = true;
                break;
            }
        }
        let has_more = more || stopped;
        Ok(NativeConversationPage {
            items,
            next_cursor: if has_more {
                last.as_ref().map(encode_native_page_cursor).transpose()?
            } else {
                None
            },
            scan_complete: !has_more,
        })
    }

    fn list_sqlite(
        &self,
        request: &NativeConversationPageRequest,
    ) -> Result<NativeConversationPage, ParseError> {
        let offset = request
            .cursor
            .as_deref()
            .map(decode_native_page_cursor::<usize>)
            .transpose()?
            .unwrap_or_default();
        let conn = self.open_sqlite()?;
        let rows = self.sqlite_sessions(
            &conn,
            Some((request.limit.max(1), offset)),
            None,
            (!request.project_path.trim().is_empty()).then_some(request.project_path.as_str()),
        )?;
        let fetched = rows.len();
        let mut items = Vec::new();
        for (row, locator) in rows {
            crate::sessions::scan_diagnostics::record_scanned(1);
            let Some(summary) = self.sqlite_summary(&row, &locator)? else {
                continue;
            };
            if (!request.project_path.trim().is_empty()
                && !path_eq_for_matching(
                    summary.folder_path.as_deref().unwrap_or_default(),
                    &request.project_path,
                ))
                || !native_page_matches_search(&summary, request.search.as_deref())
            {
                continue;
            }
            items.push(summary);
            crate::sessions::scan_diagnostics::record_retained_after_filter(1);
        }
        let complete = fetched < request.limit.max(1);
        Ok(NativeConversationPage {
            items,
            next_cursor: (!complete)
                .then(|| encode_native_page_cursor(&(offset + request.limit.max(1))))
                .transpose()?,
            scan_complete: complete,
        })
    }

    fn summary_from_parsed(
        &self,
        path: &Path,
        parsed: ParsedSession,
    ) -> Option<ConversationSummary> {
        let first_ts = parsed.first_ts.or_else(|| file_time(path))?;
        let id = parsed.id.or_else(|| {
            path.file_stem()
                .map(|value| value.to_string_lossy().into_owned())
        })?;
        let project = parsed.project.filter(|value| !value.trim().is_empty());
        let title = parsed.title.or(parsed.first_user_text);
        remember_locator(self.agent_type, &id, path);
        Some(ConversationSummary {
            id,
            agent_type: self.agent_type,
            folder_name: project.as_deref().map(folder_name_from_path),
            folder_path: project,
            title,
            started_at: first_ts,
            ended_at: parsed.last_ts,
            message_count: parsed.message_count,
            model: parsed.model,
            git_branch: None,
            parent_id: None,
            parent_tool_use_id: None,
            delegation_call_id: None,
        })
    }

    fn jsonl_files(&self) -> Vec<PathBuf> {
        let Some(extension) = file_extension(&self.spec.storage) else {
            return Vec::new();
        };
        if self.root.is_file() {
            return if self.root.extension().and_then(|ext| ext.to_str()) == Some(extension)
                && self.spec.files.as_deref().is_none_or(|pattern| {
                    matches_file_pattern(
                        self.root.parent().unwrap_or(&self.root),
                        &self.root,
                        pattern,
                    )
                }) {
                vec![self.root.clone()]
            } else {
                Vec::new()
            };
        }
        if !self.root.is_dir() {
            return Vec::new();
        }
        let mut paths: Vec<_> = WalkDir::new(&self.root)
            .follow_links(false)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().is_file())
            .filter(|entry| {
                entry.path().extension().and_then(|ext| ext.to_str()) == Some(extension)
            })
            .filter(|_entry| {
                self.spec
                    .files
                    .as_deref()
                    .is_none_or(|pattern| matches_file_pattern(&self.root, _entry.path(), pattern))
            })
            .map(|entry| entry.into_path())
            .collect();
        paths.sort();
        paths
    }

    fn get_jsonl(&self, id: &str) -> Result<ConversationDetail, ParseError> {
        if let Some(path) = cached_source_locator(self.agent_type, id) {
            if path.starts_with(&self.root) {
                if let Some(parsed) = parse_jsonl(&path, &self.spec, true).ok() {
                    if parsed.id.as_deref() == Some(id)
                        || path.file_stem().and_then(|v| v.to_str()) == Some(id)
                    {
                        return self.detail_from_parsed(parsed, id);
                    }
                }
            }
        }
        // 缓存没有：按契约定位（只核对文件头），只完整解析命中的那一个文件。
        let (path, _) = berth_tool_core::session_files::find_session(&self.spec, id)
            .ok_or_else(|| ParseError::ConversationNotFound(id.to_owned()))?;
        let parsed = parse_jsonl(&path, &self.spec, true)?;
        remember_locator(self.agent_type, id, &path);
        self.detail_from_parsed(parsed, id)
    }

    fn get_jsonl_summary(&self, id: &str) -> Result<ConversationSummary, ParseError> {
        if let Some(path) = cached_source_locator(self.agent_type, id) {
            if path.starts_with(&self.root) {
                if let Ok(parsed) = parse_jsonl(&path, &self.spec, false) {
                    if parsed.id.as_deref() == Some(id)
                        || path.file_stem().and_then(|value| value.to_str()) == Some(id)
                    {
                        if let Some(summary) = self.summary_from_parsed(&path, parsed) {
                            return Ok(summary);
                        }
                    }
                }
            }
        }
        let (path, _) = berth_tool_core::session_files::find_session(&self.spec, id)
            .ok_or_else(|| ParseError::ConversationNotFound(id.to_owned()))?;
        let parsed = parse_jsonl(&path, &self.spec, false)?;
        remember_locator(self.agent_type, id, &path);
        self.summary_from_parsed(&path, parsed)
            .ok_or_else(|| ParseError::ConversationNotFound(id.to_owned()))
    }

    fn detail_from_parsed(
        &self,
        parsed: ParsedSession,
        id: &str,
    ) -> Result<ConversationDetail, ParseError> {
        let project = parsed.project.clone();
        let summary = ConversationSummary {
            id: id.to_owned(),
            agent_type: self.agent_type,
            folder_name: project.as_deref().map(folder_name_from_path),
            folder_path: project,
            title: parsed.title.or(parsed.first_user_text),
            started_at: parsed.first_ts.unwrap_or_else(Utc::now),
            ended_at: parsed.last_ts,
            message_count: parsed.message_count,
            model: parsed.model,
            git_branch: None,
            parent_id: None,
            parent_tool_use_id: None,
            delegation_call_id: None,
        };
        let mut turns = group_turns(parsed.messages);
        annotate_skills(&mut turns, &self.spec.skills);
        Ok(ConversationDetail {
            summary,
            context: parsed
                .context
                .into_iter()
                .map(|item| ContextSource {
                    tokens: estimate_tokens(&item.text),
                    source: item.source,
                    name: item.name,
                    path: item.path,
                    text: item.text,
                })
                .collect(),
            session_stats: compute_session_stats(&turns),
            session_fields: parsed.session_fields,
            turns,
            transcript_watermark: None,
        })
    }

    fn open_sqlite(&self) -> Result<Connection, ParseError> {
        Connection::open_with_flags(
            &self.root,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
        )
        .map_err(|error| ParseError::InvalidData(format!("read-only SQLite open failed: {error}")))
    }

    fn sqlite_sessions(
        &self,
        conn: &Connection,
        page: Option<(usize, usize)>,
        id: Option<&str>,
        project_filter: Option<&str>,
    ) -> Result<Vec<(SqlRow, String)>, ParseError> {
        let session = &self.spec.session;
        let table = required_table(session.table.as_deref(), "session.table")?;
        let id_selector = session
            .id
            .as_ref()
            .ok_or_else(|| ParseError::InvalidData("session.id is required".into()))?;
        let mut projection = SqlProjection::default();
        let id_field = projection.add(id_selector, "s")?;
        let project_field = projection.add_opt(session.project.as_ref(), "s")?;
        let title_field = projection.add_opt(session.title.as_ref(), "s")?;
        let created_field = projection.add_opt(session.created.as_ref(), "s")?;
        let updated_field = projection.add_opt(session.updated.as_ref(), "s")?;
        let time_field = projection.add_opt(session.time.as_ref(), "s")?;
        let model_field = projection.add_opt(session.model.as_ref(), "s")?;
        let declared_fields = session
            .fields
            .iter()
            .map(|(name, selector)| {
                projection
                    .add(selector, "s")
                    .map(|field| (name.clone(), field))
            })
            .collect::<Result<Vec<_>, ParseError>>()?;
        // Count messages in the same session query.  The old implementation
        // issued one COUNT(*) per summary row, which turned a paged list into
        // an avoidable N+1 query sequence.  Keep the count optional when a
        // declaration has no message relation; details still load messages on
        // demand below.
        let message_count_index = if let Some(message) = self.spec.message.as_ref() {
            let message_table = required_table(message.table.as_deref(), "message.table")?;
            let message_session_column =
                direct_column(message.session.as_ref().ok_or_else(|| {
                    ParseError::InvalidData("message.session is required".into())
                })?)
                .ok_or_else(|| {
                    ParseError::InvalidData("message.session must name a column".into())
                })?;
            let session_id_column = direct_column(id_selector).ok_or_else(|| {
                ParseError::InvalidData("SQLite session.id must name a column".into())
            })?;
            let index = projection.expressions.len();
            projection.expressions.push(format!(
                "(SELECT COUNT(*) FROM \"{message_table}\" AS mc WHERE mc.\"{message_session_column}\" = s.\"{session_id_column}\") AS \"c{index}\""
            ));
            Some(index)
        } else {
            None
        };
        let mut sql = format!(
            "SELECT {} FROM \"{}\" AS s",
            projection.select_list(),
            table
        );
        let mut binds: Vec<BindValue> = Vec::new();
        let mut conditions = Vec::new();
        if let Some(id) = id {
            let id_column = direct_column(id_selector).ok_or_else(|| {
                ParseError::InvalidData("SQLite session.id must name a column".into())
            })?;
            let slot = binds.len() + 1;
            conditions.push(format!("s.\"{id_column}\" = ?{slot}"));
            binds.push(BindValue::Text(id.to_owned()));
        }
        if let Some(project) = project_filter {
            if let Some(project_selector) = session.project.as_ref() {
                if let Some(project_column) = direct_column(project_selector) {
                    let slot = binds.len() + 1;
                    conditions.push(format!("s.\"{project_column}\" = ?{slot}"));
                    binds.push(BindValue::Text(project.to_owned()));
                }
            }
        }
        if !conditions.is_empty() {
            sql.push_str(" WHERE ");
            sql.push_str(&conditions.join(" AND "));
        }
        let order = session
            .order
            .as_deref()
            .unwrap_or(&[])
            .iter()
            .map(|column| quote_identifier(column).map(|name| format!("s.{name} ASC")))
            .collect::<Result<Vec<_>, _>>()?;
        if order.is_empty() {
            let fallback = direct_column(
                session
                    .updated
                    .as_ref()
                    .or(session.created.as_ref())
                    .unwrap_or(id_selector),
            )
            .ok_or_else(|| {
                ParseError::InvalidData("SQLite session needs an order column".into())
            })?;
            sql.push_str(&format!(" ORDER BY s.\"{fallback}\" DESC"));
        } else {
            sql.push_str(" ORDER BY ");
            sql.push_str(&order.join(", "));
        }
        if let Some((limit, offset)) = page {
            let limit_slot = binds.len() + 1;
            let offset_slot = binds.len() + 2;
            sql.push_str(&format!(" LIMIT ?{limit_slot} OFFSET ?{offset_slot}"));
            binds.push(BindValue::Integer(limit as i64));
            binds.push(BindValue::Integer(offset as i64));
        }
        let mut statement = conn.prepare(&sql).map_err(|error| {
            ParseError::InvalidData(format!("SQLite session query failed: {error}"))
        })?;
        let mut rows = statement
            .query(rusqlite::params_from_iter(
                binds.iter().map(BindValue::as_ref),
            ))
            .map_err(|error| {
                ParseError::InvalidData(format!("SQLite session query failed: {error}"))
            })?;
        let mut result = Vec::new();
        while let Some(row) = rows.next().map_err(|error| {
            ParseError::InvalidData(format!("SQLite session row failed: {error}"))
        })? {
            let values = projection.values(row)?;
            let mut fields = Map::new();
            let mut declared_values = BTreeMap::new();
            insert_projected(&mut fields, "id", projection.value(&values, &id_field));
            insert_projected(
                &mut fields,
                "project",
                project_field
                    .as_ref()
                    .and_then(|f| projection.value(&values, f)),
            );
            insert_projected(
                &mut fields,
                "title",
                title_field
                    .as_ref()
                    .and_then(|f| projection.value(&values, f)),
            );
            insert_projected(
                &mut fields,
                "created",
                created_field
                    .as_ref()
                    .and_then(|f| projection.value(&values, f)),
            );
            insert_projected(
                &mut fields,
                "updated",
                updated_field
                    .as_ref()
                    .and_then(|f| projection.value(&values, f)),
            );
            insert_projected(
                &mut fields,
                "time",
                time_field
                    .as_ref()
                    .and_then(|f| projection.value(&values, f)),
            );
            insert_projected(
                &mut fields,
                "model",
                model_field
                    .as_ref()
                    .and_then(|f| projection.value(&values, f)),
            );
            for (name, field) in &declared_fields {
                if let Some(value) = projection.value(&values, field) {
                    declared_values.insert(name.clone(), value);
                }
            }
            if let Some(index) = message_count_index {
                fields.insert(
                    "message_count".to_owned(),
                    values.get(index).cloned().unwrap_or(Value::Null),
                );
            }
            let id_value = fields.get("id").and_then(value_string).unwrap_or_default();
            result.push((
                SqlRow {
                    fields,
                    declared_fields: declared_values,
                },
                id_value,
            ));
        }
        Ok(result)
    }

    fn sqlite_summary(
        &self,
        row: &SqlRow,
        id: &str,
    ) -> Result<Option<ConversationSummary>, ParseError> {
        let project = field_string(row.fields.get("project"));
        let started = field_time(row.fields.get("created").or_else(|| row.fields.get("time")))
            .or_else(|| file_time(&self.root))
            .unwrap_or_else(Utc::now);
        let updated = field_time(row.fields.get("updated").or_else(|| row.fields.get("time")));
        let title = field_string(row.fields.get("title"));
        let model = field_string(row.fields.get("model"));
        let message_count = field_u32(row.fields.get("message_count")).unwrap_or_default();
        let summary = ConversationSummary {
            id: id.to_owned(),
            agent_type: self.agent_type,
            folder_path: project.clone(),
            folder_name: project.as_deref().map(folder_name_from_path),
            title,
            started_at: started,
            ended_at: updated,
            message_count,
            model,
            git_branch: None,
            parent_id: None,
            parent_tool_use_id: None,
            delegation_call_id: None,
        };
        remember_locator(self.agent_type, id, &self.root);
        Ok(Some(summary))
    }

    fn get_sqlite_summary(&self, id: &str) -> Result<ConversationSummary, ParseError> {
        let conn = self.open_sqlite()?;
        let rows = self.sqlite_sessions(&conn, None, Some(id), None)?;
        let Some((row, locator)) = rows.into_iter().next() else {
            return Err(ParseError::ConversationNotFound(id.to_owned()));
        };
        self.sqlite_summary(&row, &locator)?
            .ok_or_else(|| ParseError::ConversationNotFound(id.to_owned()))
    }

    fn get_sqlite(&self, id: &str) -> Result<ConversationDetail, ParseError> {
        let conn = self.open_sqlite()?;
        let rows = self.sqlite_sessions(&conn, None, Some(id), None)?;
        let Some((session_row, _)) = rows.into_iter().next() else {
            return Err(ParseError::ConversationNotFound(id.to_owned()));
        };
        let mut parsed = ParsedSession {
            id: Some(id.to_owned()),
            project: field_string(session_row.fields.get("project")),
            title: field_string(session_row.fields.get("title")),
            model: field_string(session_row.fields.get("model")),
            session_fields: session_row.declared_fields.clone(),
            first_ts: field_time(
                session_row
                    .fields
                    .get("created")
                    .or_else(|| session_row.fields.get("time")),
            ),
            last_ts: field_time(
                session_row
                    .fields
                    .get("updated")
                    .or_else(|| session_row.fields.get("time")),
            ),
            ..ParsedSession::default()
        };
        let message = self
            .spec
            .message
            .as_ref()
            .ok_or_else(|| ParseError::InvalidData("message declaration is required".into()))?;
        let table = required_table(message.table.as_deref(), "message.table")?;
        let session_column = direct_column(
            message
                .session
                .as_ref()
                .ok_or_else(|| ParseError::InvalidData("message.session is required".into()))?,
        )
        .ok_or_else(|| ParseError::InvalidData("message.session must name a column".into()))?;
        let mut projection = SqlProjection::default();
        let id_field = projection.add_opt(message.id.as_ref(), "m")?;
        let role_field = projection.add(
            message
                .role
                .as_ref()
                .ok_or_else(|| ParseError::InvalidData("message.role is required".into()))?,
            "m",
        )?;
        let content_field = projection.add_opt(message.content.as_ref(), "m")?;
        let model_field = projection.add_opt(message.model.as_ref(), "m")?;
        let time_field = projection.add_opt(message.time.as_ref(), "m")?;
        let usage_field = projection.add_opt(message.usage.as_ref(), "m")?;
        let tool_use_id_field = projection.add_opt(message.tool_use_id.as_ref(), "m")?;
        let is_error_field = projection.add_opt(message.is_error.as_ref(), "m")?;
        let declared_fields = message
            .fields
            .iter()
            .map(|(name, selector)| {
                projection
                    .add(selector, "m")
                    .map(|field| (name.clone(), field))
            })
            .collect::<Result<Vec<_>, ParseError>>()?;
        let order = message.order.as_deref().unwrap_or(&[]);
        let order_sql = order
            .iter()
            .map(|column| quote_identifier(column).map(|name| format!("m.{name} ASC")))
            .collect::<Result<Vec<_>, _>>()?;
        let mut sql = format!(
            "SELECT {} FROM \"{table}\" AS m WHERE m.\"{session_column}\" = ?1",
            projection.select_list()
        );
        if !order_sql.is_empty() {
            sql.push_str(" ORDER BY ");
            sql.push_str(&order_sql.join(", "));
        }
        let mut statement = conn.prepare(&sql).map_err(|error| {
            ParseError::InvalidData(format!("SQLite message query failed: {error}"))
        })?;
        let mut rows = statement.query([id]).map_err(|error| {
            ParseError::InvalidData(format!("SQLite message query failed: {error}"))
        })?;
        let mut row_index = 0usize;
        while let Some(row) = rows.next().map_err(|error| {
            ParseError::InvalidData(format!("SQLite message row failed: {error}"))
        })? {
            let values = projection.values(row)?;
            let record_id = id_field
                .as_ref()
                .and_then(|f| projection.value(&values, f))
                .and_then(|value| value_string(&value))
                .unwrap_or_else(|| format!("{id}-message-{row_index}"));
            let content = content_field
                .as_ref()
                .and_then(|f| projection.value(&values, f));
            let role = demote_injected(
                projection.value(&values, &role_field),
                content.as_ref(),
                None,
                message.injected.as_ref(),
            );
            let model = model_field
                .as_ref()
                .and_then(|f| projection.value(&values, f));
            let timestamp = time_field
                .as_ref()
                .and_then(|f| projection.value(&values, f));
            let usage = usage_field
                .as_ref()
                .and_then(|f| projection.value(&values, f));
            let tool_use_id = tool_use_id_field
                .as_ref()
                .and_then(|f| projection.value(&values, f));
            let is_error = is_error_field
                .as_ref()
                .and_then(|f| projection.value(&values, f));
            let fields = declared_fields
                .iter()
                .filter_map(|(name, field)| {
                    projection
                        .value(&values, field)
                        .map(|value| (name.clone(), value))
                })
                .collect();
            let Some(message_index) = append_message_fields(
                &mut parsed,
                record_id,
                role,
                content,
                model,
                timestamp,
                usage,
                tool_use_id,
                is_error,
                None,
                None,
                None,
                None,
                None,
                fields,
                true,
            ) else {
                row_index += 1;
                continue;
            };
            if let Some(part) = self.spec.part.as_ref() {
                self.append_sqlite_parts(&conn, part, &mut parsed.messages[message_index])?;
            }
            row_index += 1;
        }
        if parsed.message_count == 0 {
            parsed.message_count = u32::try_from(parsed.messages.len()).unwrap_or(u32::MAX);
        }
        self.detail_from_parsed(parsed, id)
    }

    fn append_sqlite_parts(
        &self,
        conn: &Connection,
        part: &FieldSpec,
        message: &mut UnifiedMessage,
    ) -> Result<(), ParseError> {
        let table = required_table(part.table.as_deref(), "part.table")?;
        let message_column = direct_column(
            part.message
                .as_ref()
                .ok_or_else(|| ParseError::InvalidData("part.message is required".into()))?,
        )
        .ok_or_else(|| ParseError::InvalidData("part.message must name a column".into()))?;
        let mut projection = SqlProjection::default();
        let kind_field = projection.add(
            part.kind
                .as_ref()
                .ok_or_else(|| ParseError::InvalidData("part.kind is required".into()))?,
            "p",
        )?;
        let text_field = projection.add_opt(part.text.as_ref(), "p")?;
        let declared_fields = part
            .fields
            .iter()
            .map(|(name, selector)| {
                projection
                    .add(selector, "p")
                    .map(|field| (name.clone(), field))
            })
            .collect::<Result<Vec<_>, ParseError>>()?;
        let mut sql = format!(
            "SELECT {} FROM \"{table}\" AS p WHERE p.\"{message_column}\" = ?1",
            projection.select_list()
        );
        if let Some(order) = part.order.as_deref().filter(|order| !order.is_empty()) {
            let order_sql = order
                .iter()
                .map(|column| quote_identifier(column).map(|name| format!("p.{name} ASC")))
                .collect::<Result<Vec<_>, _>>()?;
            sql.push_str(" ORDER BY ");
            sql.push_str(&order_sql.join(", "));
        }
        let mut statement = conn.prepare(&sql).map_err(|error| {
            ParseError::InvalidData(format!("SQLite part query failed: {error}"))
        })?;
        let mut rows = statement.query([message.id.as_str()]).map_err(|error| {
            ParseError::InvalidData(format!("SQLite part query failed: {error}"))
        })?;
        while let Some(row) = rows
            .next()
            .map_err(|error| ParseError::InvalidData(format!("SQLite part row failed: {error}")))?
        {
            let values = projection.values(row)?;
            let kind = projection
                .value(&values, &kind_field)
                .and_then(|value| value_string(&value))
                .unwrap_or_default();
            let text = text_field
                .as_ref()
                .and_then(|f| projection.value(&values, f))
                .and_then(|value| value_text(&value));
            if let Some(block) = part_block(&kind, text) {
                message.content.push(block);
            }
            for (name, field) in &declared_fields {
                if let Some(value) = projection.value(&values, field) {
                    message.fields.insert(name.clone(), value);
                }
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone)]
struct DeclaredSession {
    tool_id: String,
    agent_type: AgentType,
    storage: Storage,
    spec: SessionSpec,
}

/// Discover only valid Tool Asset session declarations and map their declared
/// `projectType` to the existing persistence identity. This is the sole
/// runtime registry for session listing/import; callers must not keep a
/// parallel Agent array.
fn declared_sessions() -> Vec<DeclaredSession> {
    let mut sessions = Vec::new();
    for tool_id in berth_tool_core::repository::list_tool_asset_ids() {
        let asset = match berth_tool_core::repository::load_tool_asset(&tool_id) {
            Ok(Some(asset)) => asset,
            Ok(None) => continue,
            Err(error) => {
                tracing::warn!(
                    tool_id = %tool_id,
                    error = %error,
                    "session declaration ignored: tool asset could not be loaded"
                );
                continue;
            }
        };
        let Some(extension) = asset.agent_extension() else {
            continue;
        };
        let Some(sessions_value) = extension.get("sessions") else {
            continue;
        };
        let Some(resource_id) = sessions_value.as_str() else {
            tracing::warn!(
                tool_id = %tool_id,
                "session declaration ignored: extensions.org.berth.agent.sessions must be a resource id"
            );
            continue;
        };
        let Some(project_type_value) = extension.get("projectType") else {
            tracing::warn!(
                tool_id = %tool_id,
                resource_id,
                "session declaration ignored: projectType is missing"
            );
            continue;
        };
        let Some(project_type) = project_type_value.as_str() else {
            tracing::warn!(
                tool_id = %tool_id,
                resource_id,
                "session declaration ignored: projectType must be a string"
            );
            continue;
        };
        let Some(agent_type) = parse_known_agent_type(project_type) else {
            tracing::warn!(
                tool_id = %tool_id,
                resource_id,
                project_type,
                "session declaration ignored: projectType must match [a-z0-9][a-z0-9._-]*"
            );
            continue;
        };
        let spec = match load_session_spec(&tool_id, &asset) {
            Ok(Some(spec)) => spec,
            Ok(None) => {
                tracing::warn!(
                    tool_id = %tool_id,
                    resource_id,
                    "session declaration ignored: sessions resource is empty"
                );
                continue;
            }
            Err(error) => {
                tracing::warn!(
                    tool_id = %tool_id,
                    resource_id,
                    error = %error,
                    "session declaration ignored: sessions resource could not be read"
                );
                continue;
            }
        };
        let storage = match storage_kind(&spec.storage) {
            Ok(storage) => storage,
            Err(error) => {
                tracing::warn!(
                    tool_id = %tool_id,
                    resource_id,
                    error = %error,
                    "session declaration ignored: unsupported storage"
                );
                continue;
            }
        };
        if spec.path.trim().is_empty() {
            tracing::warn!(
                tool_id = %tool_id,
                resource_id,
                "session declaration ignored: sessions path is empty"
            );
            continue;
        }
        if let Err(error) = validate_spec(storage, &spec) {
            tracing::warn!(
                tool_id = %tool_id,
                resource_id,
                error = %error,
                "session declaration ignored: sessions fields are invalid"
            );
            continue;
        }
        sessions.push(DeclaredSession {
            tool_id,
            agent_type,
            storage,
            spec,
        });
    }
    sessions
}

/// Return the Agent identities whose Tool Assets currently declare a valid
/// session resource. Session consumers use this discovery result instead of a
/// second fixed Agent list.
pub(crate) fn declared_agent_types() -> Vec<AgentType> {
    let mut agents = Vec::new();
    for session in declared_sessions() {
        if !agents.contains(&session.agent_type) {
            agents.push(session.agent_type);
        }
    }
    agents
}

/// Resolve the same declarations for the optional backup feature.  The
/// session path is read from `sessions.json`; no Agent-specific path table is
/// maintained here.
pub(crate) fn declared_session_sources() -> Vec<DeclaredSessionSource> {
    let mut sources = Vec::new();
    for session in declared_sessions() {
        let root = expand_path(&session.spec.path);
        let is_file = matches!(session.storage, Storage::Sqlite)
            || root.is_file()
            || root.extension().and_then(|value| value.to_str()) == Some("jsonl");
        if sources
            .iter()
            .any(|source: &DeclaredSessionSource| source.root == root)
        {
            continue;
        }
        sources.push(DeclaredSessionSource {
            tool_id: session.tool_id,
            root,
            is_file,
        });
    }
    sources
}

/// 按资产声明的 `projectType` 找到工具包，不猜测目录名必须与内部枚举同名。
/// 工具 id 因此可以由用户维护（例如 `claude` 声明 `claude_code`），无需 Agent 别名表。
fn find_agent_tool_asset(
    agent_type: AgentType,
) -> Result<Option<(String, berth_tool_core::asset::ToolAsset)>, ParseError> {
    let project_type = serde_json::to_value(agent_type)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .ok_or_else(|| ParseError::InvalidData("invalid Agent identity".into()))?;
    // 停用的插件不读会话（与 `list_tool_asset_ids` 同一启用状态）。
    let direct = if berth_tool_core::plugins::is_enabled(&project_type) {
        berth_tool_core::repository::load_tool_asset(&project_type)
            .map_err(|error| ParseError::InvalidData(error.to_string()))?
    } else {
        None
    };
    if let Some(asset) = direct {
        if asset.agent_extension().is_some_and(|extension| {
            extension
                .get("projectType")
                .and_then(Value::as_str)
                .is_none_or(|value| value == project_type)
                && extension.get("sessions").and_then(Value::as_str).is_some()
        }) {
            return Ok(Some((project_type, asset)));
        }
    }
    for tool_id in berth_tool_core::repository::list_tool_asset_ids() {
        let Some(asset) = berth_tool_core::repository::load_tool_asset(&tool_id)
            .map_err(|error| ParseError::InvalidData(error.to_string()))?
        else {
            continue;
        };
        if asset
            .agent_extension()
            .and_then(|extension| extension.get("projectType"))
            .and_then(Value::as_str)
            == Some(project_type.as_str())
            && asset
                .agent_extension()
                .and_then(|extension| extension.get("sessions"))
                .and_then(Value::as_str)
                .is_some()
        {
            return Ok(Some((tool_id, asset)));
        }
    }
    Ok(None)
}

impl AgentParser for DeclarativeSessionParser {
    fn list_conversations(&self) -> Result<Vec<ConversationSummary>, ParseError> {
        let mut request = NativeConversationPageRequest {
            project_path: String::new(),
            cursor: None,
            limit: usize::MAX.min(200),
            scan_budget: usize::MAX.min(50_000),
            search: None,
        };
        let mut result = Vec::new();
        loop {
            let page = self.list_conversation_page(&request)?;
            result.extend(page.items);
            let Some(cursor) = page.next_cursor else {
                break;
            };
            request.cursor = Some(cursor);
        }
        Ok(result)
    }

    fn list_conversation_page(
        &self,
        request: &NativeConversationPageRequest,
    ) -> Result<NativeConversationPage, ParseError> {
        match storage_kind(&self.spec.storage)? {
            Storage::Jsonl | Storage::Json => self.list_jsonl(request),
            Storage::Sqlite => self.list_sqlite(request),
        }
    }

    fn get_conversation(&self, conversation_id: &str) -> Result<ConversationDetail, ParseError> {
        match storage_kind(&self.spec.storage)? {
            Storage::Jsonl | Storage::Json => self.get_jsonl(conversation_id),
            Storage::Sqlite => self.get_sqlite(conversation_id),
        }
    }

    fn get_conversation_summary(
        &self,
        conversation_id: &str,
    ) -> Result<ConversationSummary, ParseError> {
        match storage_kind(&self.spec.storage)? {
            Storage::Jsonl | Storage::Json => self.get_jsonl_summary(conversation_id),
            Storage::Sqlite => self.get_sqlite_summary(conversation_id),
        }
    }
}

fn storage_kind(value: &str) -> Result<Storage, ParseError> {
    match value {
        "jsonl" => Ok(Storage::Jsonl),
        "json" => Ok(Storage::Json),
        "sqlite" => Ok(Storage::Sqlite),
        other => Err(ParseError::InvalidData(format!(
            "unsupported sessions storage {other:?}"
        ))),
    }
}

fn validate_spec(storage: Storage, spec: &SessionSpec) -> Result<(), ParseError> {
    if let Some(index) = spec.session_index.as_ref() {
        if storage != Storage::Jsonl {
            return Err(ParseError::InvalidData(
                "sessionIndex is only supported with jsonl storage".into(),
            ));
        }
        validate_identifier(&index.table)?;
        validate_identifier(&index.key)?;
        if index.matches.entries().any(|value| !value.starts_with("@path.")) {
            return Err(ParseError::InvalidData(
                "sessionIndex.match must be @path.… selectors".into(),
            ));
        }
    }
    match storage {
        Storage::Json => {
            // 会话记录按位置（文档的第一条）认，不需要 `session.record`。
            if spec.records.is_none() {
                return Err(ParseError::InvalidData("json records is required".into()));
            }
            if spec.session.id.is_none() {
                return Err(ParseError::InvalidData(
                    "json session.id is required".into(),
                ));
            }
            let message = spec.message.as_ref().ok_or_else(|| {
                ParseError::InvalidData("json message declaration is required".into())
            })?;
            if message.role.is_none() && (message.role_map.is_empty() || message.variant.is_none())
            {
                return Err(ParseError::InvalidData(
                    "json message.role or role_map + variant is required".into(),
                ));
            }
        }
        Storage::Jsonl => {
            let has_record = spec
                .session
                .record
                .as_ref()
                .is_some_and(|record| !record.is_blank());
            // 有 sessionIndex 时会话记录是索引里的那一行，文件里没有会话记录。
            match (spec.session_index.as_ref(), has_record) {
                (None, false) => {
                    return Err(ParseError::InvalidData(
                        "jsonl session.record is required".into(),
                    ))
                }
                (Some(_), true) => {
                    return Err(ParseError::InvalidData(
                        "jsonl session.record must be omitted with sessionIndex".into(),
                    ))
                }
                _ => {}
            }
            if spec.session.id.is_none() {
                return Err(ParseError::InvalidData(
                    "jsonl session.id is required".into(),
                ));
            }
            let message = spec.message.as_ref().ok_or_else(|| {
                ParseError::InvalidData("jsonl message declaration is required".into())
            })?;
            if message.role.is_none() {
                if message.role_map.is_empty() || message.variant.is_none() {
                    return Err(ParseError::InvalidData(
                        "jsonl message.role or role_map + variant is required".into(),
                    ));
                }
            }
        }
        Storage::Sqlite => {
            required_table(spec.session.table.as_deref(), "session.table")?;
            if spec.session.id.is_none() {
                return Err(ParseError::InvalidData(
                    "sqlite session.id is required".into(),
                ));
            }
            if let Some(message) = spec.message.as_ref() {
                required_table(message.table.as_deref(), "message.table")?;
                if message.session.is_none() || message.role.is_none() {
                    return Err(ParseError::InvalidData(
                        "sqlite message.session and message.role are required".into(),
                    ));
                }
            }
            if let Some(part) = spec.part.as_ref() {
                required_table(part.table.as_deref(), "part.table")?;
            }
        }
    }
    for fields in std::iter::once(&spec.session)
        .chain(spec.message.iter())
        .chain(spec.part.iter())
    {
        for selector in [
            fields.id.as_ref(),
            fields.project.as_ref(),
            fields.title.as_ref(),
            fields.created.as_ref(),
            fields.updated.as_ref(),
            fields.time.as_ref(),
            fields.model.as_ref(),
            fields.value.as_ref(),
            fields.session.as_ref(),
            fields.role.as_ref(),
            fields.variant.as_ref(),
            fields.content.as_ref(),
            fields.usage.as_ref(),
            fields.tool_use_id.as_ref(),
            fields.is_error.as_ref(),
            fields.tool_name.as_ref(),
            fields.tool_input.as_ref(),
            fields.tool_output.as_ref(),
            fields.tool_calls.as_ref(),
            fields.kind.as_ref(),
            fields.text.as_ref(),
        ]
        .into_iter()
        .flatten()
        {
            for value in selector.entries() {
                if value == "@record" || value.starts_with("@path.") {
                    continue;
                }
                if let Some(column) = value
                    .split_once('#')
                    .map(|(column, _)| column)
                    .or_else(|| (!value.starts_with('/')).then_some(value))
                {
                    if !column.is_empty() {
                        validate_identifier(column)?;
                    }
                }
            }
        }
        for (name, selector) in &fields.fields {
            if name.trim().is_empty() {
                return Err(ParseError::InvalidData(
                    "sessions fields must use non-empty names".into(),
                ));
            }
            for value in selector.entries() {
                if value == "@record" || value.starts_with("@path.") {
                    continue;
                }
                if let Some(column) = value
                    .split_once('#')
                    .map(|(column, _)| column)
                    .or_else(|| (!value.starts_with('/')).then_some(value))
                {
                    if !column.is_empty() {
                        validate_identifier(column)?;
                    }
                }
            }
        }
        if let Some(order) = fields.order.as_ref() {
            for column in order {
                validate_identifier(column)?;
            }
        }
    }
    Ok(())
}

fn required_table(value: Option<&str>, name: &str) -> Result<String, ParseError> {
    let value = value.ok_or_else(|| ParseError::InvalidData(format!("{name} is required")))?;
    validate_identifier(value)?;
    Ok(value.to_owned())
}

fn validate_identifier(value: &str) -> Result<(), ParseError> {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return Err(ParseError::InvalidData("empty SQLite identifier".into()));
    };
    if !(first == '_' || first.is_ascii_alphabetic())
        || !chars.all(|c| c == '_' || c.is_ascii_alphanumeric())
    {
        return Err(ParseError::InvalidData(format!(
            "invalid SQLite identifier {value:?}"
        )));
    }
    Ok(())
}

fn quote_identifier(value: &str) -> Result<String, ParseError> {
    validate_identifier(value)?;
    Ok(format!("\"{value}\""))
}

fn direct_column(selector: &Selector) -> Option<String> {
    let value = selector.first()?;
    let value = value
        .split_once('#')
        .map(|(column, _)| column)
        .unwrap_or(value);
    (!value.starts_with('/')).then(|| value.to_owned())
}

/// 只扫文件开头的若干行，取第一条会话记录声明的项目路径；找不到返回 `None`。
fn jsonl_project(path: &Path, spec: &SessionSpec) -> Option<String> {
    const HEAD_LINES: usize = 50;
    let selector = spec.session.project.as_ref()?;
    if spec.storage == "json" {
        let session = json_document_records(spec, path)?.into_iter().next()?;
        return select_json_with_path(&session, selector, path)
            .and_then(|value| value_string(&value));
    }
    if let Some(index) = session_index_record(spec, path) {
        return select_json_with_path(&index, selector, path).and_then(|value| value_string(&value));
    }
    let reader = BufReader::new(fs::File::open(path).ok()?);
    reader
        .split(b'\n')
        .take(HEAD_LINES)
        .filter_map(Result::ok)
        .filter(|line| line.len() <= MAX_LINE_BYTES)
        .filter_map(|line| serde_json::from_slice::<Value>(&line).ok())
        .filter(|value| record_matches(value, &spec.session))
        .find_map(|value| {
            select_json_with_path(&value, selector, path).and_then(|value| value_string(&value))
        })
}

fn parse_jsonl(
    path: &Path,
    spec: &SessionSpec,
    capture_messages: bool,
) -> Result<ParsedSession, ParseError> {
    // （是会话记录，可作消息，记录）：JSONL 按 `session.record` 认会话记录；JSON 文档的第一条是会话记录，其余是消息。
    let records: Box<dyn Iterator<Item = Result<(bool, bool, Value), ParseError>>> =
        if spec.storage == "json" {
            let records = json_document_records(spec, path).ok_or_else(|| {
                ParseError::InvalidData(format!("unreadable session document {}", path.display()))
            })?;
            Box::new(
                records
                    .into_iter()
                    .enumerate()
                    .map(|(index, value)| Ok((index == 0, index > 0, value))),
            )
        } else {
            // sessionIndex：索引里的那一行是会话记录（不作消息），文件里的行都不是会话记录。
            let index = session_index_record(spec, path);
            let lines_have_session = index.is_none();
            let reader = BufReader::new(fs::File::open(path)?);
            Box::new(index.map(|row| Ok((true, false, row))).into_iter().chain(reader.split(b'\n').filter_map(move |line| {
                let line = match line {
                    Ok(line) => line,
                    Err(error) => return Some(Err(error.into())),
                };
                if line.len() > MAX_LINE_BYTES || line.iter().all(u8::is_ascii_whitespace) {
                    return None;
                }
                let value = serde_json::from_slice::<Value>(&line).ok()?;
                Some(Ok((lines_have_session && record_matches(&value, &spec.session), true, value)))
            })))
        };
    let mut result = ParsedSession::default();
    let message_spec = spec.message.as_ref();
    let mut observed_time = false;
    // 启动输入只算首次请求之前的记录；之后的注入（压缩后的 hook、增量列表）不属于启动。
    // 不记用量的会话找不到分界点，仍按整个文件收集。
    let mut context_done = false;
    for (index, record) in records.enumerate() {
        let (session_record, message_candidate, value) = record?;
        if session_record {
            if result.id.is_none() {
                result.id = select_json_with_path(
                    &value,
                    spec.session.id.as_ref().expect("validated"),
                    path,
                )
                .and_then(|value| value_string(&value));
            }
            if result.project.is_none() {
                result.project = spec
                    .session
                    .project
                    .as_ref()
                    .and_then(|selector| select_json_with_path(&value, selector, path))
                    .and_then(|value| value_string(&value));
            }
            if result.title.is_none() {
                result.title = spec
                    .session
                    .title
                    .as_ref()
                    .or(spec.session.value.as_ref())
                    .and_then(|selector| select_json_with_path(&value, selector, path))
                    .and_then(|value| value_string(&value));
            }
            if result.model.is_none() {
                result.model = spec
                    .session
                    .model
                    .as_ref()
                    .and_then(|selector| select_json_with_path(&value, selector, path))
                    .and_then(|value| value_string(&value));
            }
            observed_time |= note_session_time(
                &mut result,
                spec.session
                    .time
                    .as_ref()
                    .or(spec.session.created.as_ref())
                    .and_then(|selector| select_json_with_path(&value, selector, path)),
            );
            for (name, value) in select_declared_fields(None, &value, &spec.session.fields, path) {
                result.session_fields.entry(name).or_insert(value);
            }
        }
        if capture_messages && !context_done {
            for item in context_items(&spec.context, &value) {
                push_context(&mut result.context, item);
            }
        }
        let Some(message) = message_spec.filter(|_| message_candidate) else {
            continue;
        };
        if !record_matches(&value, message) {
            continue;
        }
        let MessageRecord {
            nested,
            variant,
            role,
            content,
        } = message_record(message, &value);
        let id = select_relative_with_path(nested.as_ref(), &value, message.id.as_ref(), path)
            .and_then(|value| value_string(&value))
            .unwrap_or_else(|| format!("message-{index}"));
        let fields = capture_messages
            .then(|| select_declared_fields(nested.as_ref(), &value, &message.fields, path))
            .unwrap_or_default();
        let model = select_relative(nested.as_ref(), &value, message.model.as_ref());
        let timestamp = select_relative(nested.as_ref(), &value, message.time.as_ref());
        observed_time |= timestamp.as_ref().and_then(parse_time).is_some();
        let usage = capture_messages
            .then(|| select_relative(nested.as_ref(), &value, message.usage.as_ref()))
            .flatten();
        context_done |= usage.as_ref().and_then(parse_usage).is_some();
        let tool_use_id = capture_messages
            .then(|| select_relative(nested.as_ref(), &value, message.tool_use_id.as_ref()))
            .flatten();
        let is_error = capture_messages
            .then(|| select_relative(nested.as_ref(), &value, message.is_error.as_ref()))
            .flatten();
        let tool_name = capture_messages
            .then(|| select_relative(nested.as_ref(), &value, message.tool_name.as_ref()))
            .flatten();
        let tool_input = capture_messages
            .then(|| select_relative(nested.as_ref(), &value, message.tool_input.as_ref()))
            .flatten();
        let tool_output = capture_messages
            .then(|| select_relative(nested.as_ref(), &value, message.tool_output.as_ref()))
            .flatten();
        let tool_calls = capture_messages
            .then(|| select_relative(nested.as_ref(), &value, message.tool_calls.as_ref()))
            .flatten();
        let _ = append_message_fields(
            &mut result,
            id,
            role,
            content,
            model,
            timestamp,
            usage,
            tool_use_id,
            is_error,
            variant.and_then(|value| value_string(&value)),
            tool_name,
            tool_input,
            tool_output,
            tool_calls,
            fields,
            capture_messages,
        );
    }
    if !observed_time {
        if let Some(timestamp) = file_time(path) {
            result.first_ts = Some(timestamp);
            result.last_ts = Some(timestamp);
            for message in &mut result.messages {
                message.timestamp = timestamp;
                message.completed_at = Some(timestamp);
            }
        }
    }
    Ok(result)
}

fn note_session_time(result: &mut ParsedSession, value: Option<Value>) -> bool {
    let Some(timestamp) = value.and_then(|value| parse_time(&value)) else {
        return false;
    };
    result.first_ts.get_or_insert(timestamp);
    result.last_ts = Some(timestamp);
    true
}

fn append_message_fields(
    result: &mut ParsedSession,
    id: String,
    role: Option<Value>,
    content: Option<Value>,
    model: Option<Value>,
    timestamp: Option<Value>,
    usage: Option<Value>,
    tool_use_id: Option<Value>,
    is_error: Option<Value>,
    variant: Option<String>,
    tool_name: Option<Value>,
    tool_input: Option<Value>,
    tool_output: Option<Value>,
    tool_calls: Option<Value>,
    fields: BTreeMap<String, Value>,
    capture_messages: bool,
) -> Option<usize> {
    let role = role
        .and_then(|value| value_string(&value))
        .unwrap_or_else(|| "system".to_owned());
    let timestamp = timestamp
        .and_then(|value| parse_time(&value))
        .or(result.last_ts)
        .unwrap_or_else(Utc::now);
    result.first_ts.get_or_insert(timestamp);
    result.last_ts = Some(timestamp);
    let model = model
        .and_then(|value| value_string(&value))
        .filter(|value| !value.is_empty());
    if model.is_some() {
        result.model = model.clone();
    }
    let mut message_role = match role.as_str() {
        "user" => MessageRole::User,
        "assistant" => MessageRole::Assistant,
        "system" | "developer" => MessageRole::System,
        "tool" | "toolResult" | "tool_result" => MessageRole::Tool,
        // 原始记录的 role 不必属于统一模型；声明字段仍应完整可见。
        _ => MessageRole::System,
    };
    if role == "user" && is_tool_result_content(content.as_ref()) {
        message_role = MessageRole::Tool;
    }
    if !capture_messages {
        if matches!(message_role, MessageRole::User | MessageRole::Assistant) {
            result.message_count = result.message_count.saturating_add(1);
        }
        if matches!(message_role, MessageRole::User) && result.first_user_text.is_none() {
            if let Some(text) = content
                .as_ref()
                .and_then(value_text)
                .filter(|text| !text.trim().is_empty())
            {
                result.first_user_text = Some(title_from_user_text(text.trim()));
            }
        }
        return None;
    }
    let blocks = message_blocks(
        &role,
        variant.as_deref(),
        content.as_ref(),
        tool_use_id.as_ref().and_then(value_string),
        is_error.as_ref().is_some_and(value_bool),
        tool_name.as_ref().and_then(value_string),
        tool_input.as_ref(),
        tool_output.as_ref(),
        tool_calls.as_ref(),
    );
    let usage = usage.and_then(|value| turn_usage(&value));
    // 声明字段非空的行必须进入详情，即使抽不出统一 content block。
    if blocks.is_empty() && fields.is_empty() {
        // 只带用量的记录（如 Codex 的 `token_count` 事件）：用量记到前面最近的 assistant 消息上。
        if let Some(usage) = usage {
            if let Some(last) = result
                .messages
                .iter_mut()
                .rev()
                .find(|message| matches!(message.role, MessageRole::Assistant))
            {
                last.usage.get_or_insert(usage);
            }
        }
        return None;
    }
    if matches!(message_role, MessageRole::User | MessageRole::Assistant) {
        result.message_count = result.message_count.saturating_add(1);
    }
    if matches!(message_role, MessageRole::User) && result.first_user_text.is_none() {
        if let Some(text) = content
            .as_ref()
            .and_then(|value| value_text(&value))
            .filter(|text| !text.trim().is_empty())
        {
            result.first_user_text = Some(title_from_user_text(text.trim()));
        }
    }
    // 一次回复拆成多行时每行都带同一份用量（Claude 按内容块写行）：与上一份 assistant 用量
    // 完全相同即同一次调用，只记一次，否则会话合计会翻倍。不同调用的输入一直在涨，不会恰好相等。
    let usage = usage.filter(|usage| {
        !matches!(message_role, MessageRole::Assistant)
            || result
                .messages
                .iter()
                .rev()
                .filter(|message| matches!(message.role, MessageRole::Assistant))
                .find_map(|message| message.usage.as_ref())
                != Some(usage)
    });
    let index = result.messages.len();
    result.messages.push(UnifiedMessage {
        id,
        role: message_role,
        content: blocks,
        fields,
        timestamp,
        usage,
        duration_ms: None,
        model,
        completed_at: Some(timestamp),
    });
    Some(index)
}

fn message_blocks(
    role: &str,
    variant: Option<&str>,
    content: Option<&Value>,
    tool_use_id: Option<String>,
    is_error: bool,
    tool_name: Option<String>,
    tool_input: Option<&Value>,
    tool_output: Option<&Value>,
    tool_calls: Option<&Value>,
) -> Vec<ContentBlock> {
    match role {
        "assistant" => {
            let mut blocks = if variant == Some("reasoning") {
                content
                    .and_then(value_text)
                    .filter(|value| !value.is_empty())
                    .map(|text| vec![ContentBlock::Thinking { text }])
                    .unwrap_or_default()
            } else if let Some(items) = content.and_then(Value::as_array) {
                let blocks: Vec<_> = items.iter().filter_map(content_block).collect();
                if blocks.is_empty() {
                    content
                        .and_then(value_text)
                        .filter(|value| !value.is_empty())
                        .map(|text| vec![ContentBlock::Text { text }])
                        .unwrap_or_default()
                } else {
                    blocks
                }
            } else {
                content
                    .and_then(value_text)
                    .filter(|value| !value.is_empty())
                    .map(|text| vec![ContentBlock::Text { text }])
                    .unwrap_or_default()
            };
            if let Some(tool_calls) = tool_calls {
                blocks.extend(tool_call_blocks(tool_calls));
            }
            if blocks.is_empty() {
                if let (Some(tool_name), Some(tool_input)) = (tool_name, tool_input) {
                    blocks.push(ContentBlock::ToolUse {
                        tool_use_id,
                        tool_name,
                        input_preview: value_preview(tool_input),
                        meta: None,
                    });
                }
            }
            blocks
        }
        "tool" | "toolResult" | "tool_result" => {
            // 纯文本数组是工具输出本身，仍须包成 ToolResult 才能与调用配对。
            if let Some(items) = content.and_then(Value::as_array) {
                let blocks: Vec<_> = items.iter().filter_map(content_block).collect();
                if blocks
                    .iter()
                    .any(|block| !matches!(block, ContentBlock::Text { .. }))
                {
                    return blocks;
                }
            }
            let (output_preview, output_tokens) =
                preview_and_tokens(tool_output.or(content).and_then(value_text));
            vec![ContentBlock::ToolResult {
                tool_use_id,
                output_preview,
                output_tokens,
                is_error,
                agent_stats: None,
                images: Vec::new(),
            }]
        }
        "user" | "system" | "developer" => {
            if let Some(items) = content.and_then(Value::as_array) {
                let blocks: Vec<_> = items.iter().filter_map(content_block).collect();
                if !blocks.is_empty() {
                    return blocks;
                }
            }
            content
                .and_then(value_text)
                .filter(|value| !value.is_empty())
                .map(|text| vec![ContentBlock::Text { text }])
                .unwrap_or_default()
        }
        _ => Vec::new(),
    }
}

fn is_tool_result_content(value: Option<&Value>) -> bool {
    let Some(items) = value.and_then(Value::as_array) else {
        return false;
    };
    !items.is_empty()
        && items.iter().all(|item| {
            matches!(
                item.get("type").and_then(Value::as_str),
                Some("toolResult" | "tool_result")
            )
        })
}

fn tool_call_blocks(value: &Value) -> Vec<ContentBlock> {
    let values: Vec<&Value> = value
        .as_array()
        .map(|values| values.iter().collect())
        .unwrap_or_else(|| vec![value]);
    values.into_iter().filter_map(tool_call_block).collect()
}

fn tool_call_block(value: &Value) -> Option<ContentBlock> {
    content_block(value).or_else(|| {
        let tool_name = value
            .get("name")
            .or_else(|| value.get("tool_name"))
            .and_then(Value::as_str)?;
        Some(ContentBlock::ToolUse {
            tool_use_id: value
                .get("id")
                .or_else(|| value.get("call_id"))
                .or_else(|| value.get("tool_call_id"))
                .and_then(Value::as_str)
                .map(str::to_owned),
            tool_name: tool_name.to_owned(),
            input_preview: value
                .get("arguments")
                .or_else(|| value.get("input"))
                .or_else(|| value.get("args"))
                .map(value_preview)
                .flatten(),
            meta: None,
        })
    })
}

fn content_block(value: &Value) -> Option<ContentBlock> {
    let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
    match kind {
        "text" | "input_text" | "output_text" => value
            .get("text")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .map(|text| ContentBlock::Text {
                text: text.to_owned(),
            }),
        "thinking" => value
            .get("thinking")
            .or_else(|| value.get("text"))
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .map(|text| ContentBlock::Thinking {
                text: text.to_owned(),
            }),
        "toolCall" | "tool_call" | "tool_use" => Some(ContentBlock::ToolUse {
            tool_use_id: value
                .get("id")
                .or_else(|| value.get("toolCallId"))
                .or_else(|| value.get("call_id"))
                .or_else(|| value.get("tool_call_id"))
                .and_then(Value::as_str)
                .map(str::to_owned),
            tool_name: value
                .get("name")
                .or_else(|| value.get("toolName"))
                .or_else(|| value.get("tool_name"))
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_owned(),
            input_preview: value
                .get("arguments")
                .or_else(|| value.get("input"))
                .and_then(value_preview),
            meta: None,
        }),
        "toolResult" | "tool_result" => {
            let (output_preview, output_tokens) = preview_and_tokens(
                value
                    .get("content")
                    .or_else(|| value.get("output"))
                    .or_else(|| value.get("tool_output"))
                    .and_then(value_text),
            );
            Some(ContentBlock::ToolResult {
                tool_use_id: value
                    .get("toolCallId")
                    .or_else(|| value.get("tool_call_id"))
                    .or_else(|| value.get("toolUseId"))
                    .or_else(|| value.get("tool_use_id"))
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                output_preview,
                output_tokens,
                is_error: value
                    .get("isError")
                    .or_else(|| value.get("is_error"))
                    .is_some_and(value_bool),
                agent_stats: None,
                images: Vec::new(),
            })
        }
        _ => None,
    }
}

fn part_block(kind: &str, text: Option<String>) -> Option<ContentBlock> {
    match kind {
        "text" => text
            .filter(|value| !value.is_empty())
            .map(|text| ContentBlock::Text { text }),
        "thinking" => text
            .filter(|value| !value.is_empty())
            .map(|text| ContentBlock::Thinking { text }),
        _ => None,
    }
}

/// 用量按 [`berth_tool_core::sessions::parse_usage`] 归一，再换成统一消息模型的形状。
fn turn_usage(value: &Value) -> Option<TurnUsage> {
    parse_usage(value).map(|usage| TurnUsage {
        input_tokens: usage.input,
        output_tokens: usage.output,
        cache_creation_input_tokens: usage.cache_write,
        cache_read_input_tokens: usage.cache_read,
    })
}

/// 工具结果的预览（前 4000 字）与截断前整份的估算 token。
fn preview_and_tokens(text: Option<String>) -> (Option<String>, Option<u64>) {
    match text {
        Some(text) => {
            let tokens = estimate_tokens(&text);
            (Some(truncate_str(&text, 4000)), Some(tokens))
        }
        None => (None, None),
    }
}

fn value_preview(value: &Value) -> Option<String> {
    value_text(value).map(|text| truncate_str(&text, 4000))
}

fn parse_time(value: &Value) -> Option<DateTime<Utc>> {
    if let Some(text) = value.as_str() {
        return text.parse::<DateTime<Utc>>().ok();
    }
    let number = value.as_i64()?;
    if number.unsigned_abs() > 10_000_000_000 {
        Utc.timestamp_millis_opt(number).single()
    } else {
        Utc.timestamp_opt(number, 0).single()
    }
}

fn file_time(path: &Path) -> Option<DateTime<Utc>> {
    path.metadata()
        .ok()?
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|duration| {
            Utc.timestamp_opt(duration.as_secs() as i64, duration.subsec_nanos())
                .single()
        })
}

fn remember_locator(agent_type: AgentType, id: &str, path: &Path) {
    if let Ok(mut cache) = locator_cache().lock() {
        if cache.len() >= 4096 {
            cache.clear();
        }
        cache.insert((agent_type, id.to_owned()), path.to_path_buf());
    }
}

fn group_turns(messages: Vec<UnifiedMessage>) -> Vec<MessageTurn> {
    messages
        .into_iter()
        .map(|message| MessageTurn {
            id: message.id,
            // TurnRole 是旧统一模型的有限角色；原始 role 已随声明字段完整保留。
            role: match message.role {
                MessageRole::User => TurnRole::User,
                MessageRole::Assistant => TurnRole::Assistant,
                MessageRole::System | MessageRole::Tool => TurnRole::System,
            },
            blocks: message.content,
            fields: message.fields,
            timestamp: message.timestamp,
            usage: message.usage,
            duration_ms: message.duration_ms,
            model: message.model,
            completed_at: message.completed_at,
        })
        .collect()
}

fn insert_projected(fields: &mut Map<String, Value>, name: &str, value: Option<Value>) {
    if let Some(value) = value {
        fields.insert(name.to_owned(), value);
    }
}

fn field_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(value_string)
        .filter(|value| !value.is_empty())
}

fn field_u32(value: Option<&Value>) -> Option<u32> {
    match value? {
        Value::Number(value) => value.as_u64().and_then(|value| u32::try_from(value).ok()),
        Value::String(value) => value.parse::<u32>().ok(),
        _ => None,
    }
}

fn field_time(value: Option<&Value>) -> Option<DateTime<Utc>> {
    value.and_then(parse_time)
}

#[derive(Debug, Clone)]
struct SqlRow {
    fields: Map<String, Value>,
    declared_fields: BTreeMap<String, Value>,
}

#[derive(Debug, Clone)]
struct SqlField {
    values: Vec<(usize, String)>,
}

#[derive(Default)]
struct SqlProjection {
    expressions: Vec<String>,
}

impl SqlProjection {
    fn add(&mut self, selector: &Selector, prefix: &str) -> Result<SqlField, ParseError> {
        let mut values = Vec::new();
        for selector in selector.entries() {
            let column = selector
                .split_once('#')
                .map(|(column, _)| column)
                .unwrap_or(selector);
            let column = quote_identifier(column)?;
            let index = self.expressions.len();
            self.expressions
                .push(format!("{prefix}.{column} AS \"c{index}\""));
            values.push((index, selector.to_owned()));
        }
        let field = SqlField { values };
        Ok(field)
    }

    fn add_opt(
        &mut self,
        selector: Option<&Selector>,
        prefix: &str,
    ) -> Result<Option<SqlField>, ParseError> {
        selector
            .map(|selector| self.add(selector, prefix))
            .transpose()
    }
    fn select_list(&self) -> String {
        self.expressions.join(", ")
    }
    fn values(&self, row: &Row<'_>) -> Result<Vec<Value>, ParseError> {
        self.expressions
            .iter()
            .enumerate()
            .map(|(index, _)| row_value(row, index))
            .collect()
    }
    fn value(&self, values: &[Value], field: &SqlField) -> Option<Value> {
        field.values.iter().find_map(|(index, selector)| {
            resolve_sql(&values[*index], selector).filter(is_non_empty_selector_value)
        })
    }
}

fn resolve_sql(raw: &Value, selector: &str) -> Option<Value> {
    if let Some(selector) = selector.strip_suffix(berth_tool_core::sessions::FILE_PATH_SUFFIX) {
        return resolve_sql(raw, selector).and_then(|value| berth_tool_core::sessions::file_uri_path(&value));
    }
    if let Some((_, pointer)) = selector.split_once('#') {
        return pointer_value(raw, pointer);
    }
    Some(raw.clone())
}

fn row_value(row: &Row<'_>, index: usize) -> Result<Value, ParseError> {
    let value = row
        .get_ref(index)
        .map_err(|error| ParseError::InvalidData(format!("SQLite value failed: {error}")))?;
    Ok(match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(value) => Value::Number(value.into()),
        ValueRef::Real(value) => serde_json::Number::from_f64(value)
            .map(Value::Number)
            .unwrap_or(Value::Null),
        ValueRef::Text(value) => Value::String(String::from_utf8_lossy(value).into_owned()),
        ValueRef::Blob(_) => Value::Null,
    })
}

#[derive(Debug)]
enum BindValue {
    Text(String),
    Integer(i64),
}
impl BindValue {
    fn as_ref(&self) -> &dyn rusqlite::ToSql {
        match self {
            Self::Text(value) => value,
            Self::Integer(value) => value,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn jsonl_spec(path: &Path) -> SessionSpec {
        serde_json::from_value(json!({
            "storage": "jsonl", "path": path,
            "files": "**/*.jsonl",
            "session": {"record": "session", "id": "/id", "project": "/cwd", "time": "/timestamp", "fields": {"source": "@record"}},
            "message": {"record": "message", "value": "/message", "role": "/role", "content": "/content", "model": "/model", "time": "/timestamp", "usage": "/usage", "tool_use_id": "/toolCallId", "is_error": "/isError", "fields": {"source": "@record"}}
        })).unwrap()
    }

    #[test]
    fn skill_loads_are_named_from_declaration_or_skill_path() {
        let spec: SkillSpec = serde_json::from_value(json!({"toolNames": ["Skill"]})).unwrap();
        assert_eq!(
            skill_names("Skill", r#"{"skill":"huashu:flash","args":"x"}"#, &spec),
            vec!["huashu:flash"]
        );
        assert_eq!(
            skill_names(
                "exec",
                "cat .agents/skills/diagnose/SKILL.md; cat ~/x/skills/ui-ux/SKILL.md",
                &SkillSpec::default()
            ),
            vec!["diagnose", "ui-ux"]
        );
        assert!(skill_names("Read", "/repo/docs/SKILL.md", &spec).is_empty());
    }

    #[test]
    fn injected_user_records_are_read_as_system() {
        let spec: InjectedSpec = serde_json::from_value(
            json!({"flag": "/isMeta", "textPrefixes": ["<environment_context>"]}),
        )
        .unwrap();
        let user = || Some(json!("user"));
        let demoted = |content: Value, flag: Option<Value>| {
            demote_injected(user(), Some(&content), flag.as_ref(), Some(&spec))
        };
        assert_eq!(demoted(json!("hi"), None), user());
        assert_eq!(
            demoted(json!("hi"), Some(json!(true))),
            Some(json!("system"))
        );
        assert_eq!(
            demoted(json!([{"text": "  <environment_context>x"}]), None),
            Some(json!("system"))
        );
        assert_eq!(
            demote_injected(
                Some(json!("assistant")),
                None,
                Some(&json!(true)),
                Some(&spec)
            ),
            Some(json!("assistant"))
        );
    }

    #[test]
    fn jsonl_contract_projects_text_thinking_tools_usage_and_bad_lines() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("s.jsonl");
        let lines = [
            json!({"type":"session","id":"s1","cwd":"/repo","timestamp":"2026-01-01T00:00:00Z"}).to_string(),
            "not-json".to_owned(),
            json!({"type":"message","timestamp":"2026-01-01T00:00:01Z","message":{"role":"user","content":"hello"}}).to_string(),
            json!({"type":"message","timestamp":"2026-01-01T00:00:02Z","message":{"role":"assistant","model":"m","content":[{"type":"thinking","thinking":"plan"},{"type":"text","text":"done"},{"type":"toolCall","id":"t1","name":"sh","arguments":{"cmd":"pwd"}}],"usage":{"input":2,"output":3}}}).to_string(),
            json!({"type":"message","timestamp":"2026-01-01T00:00:03Z","message":{"role":"toolResult","toolCallId":"t1","content":[{"type":"text","text":"ok"}],"isError":false}}).to_string(),
        ];
        fs::write(&file, lines.join("\n")).unwrap();
        let parser =
            DeclarativeSessionParser::from_spec(AgentType::new("pi"), jsonl_spec(temp.path())).unwrap();
        let page = parser
            .list_conversation_page(&NativeConversationPageRequest {
                project_path: "/repo".into(),
                cursor: None,
                limit: 10,
                scan_budget: 10,
                search: None,
            })
            .unwrap();
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].message_count, 2);
        let summary_pass = parse_jsonl(&file, &jsonl_spec(temp.path()), false).unwrap();
        assert!(summary_pass.messages.is_empty());
        assert_eq!(summary_pass.message_count, 2);
        let detail = parser.get_conversation("s1").unwrap();
        assert_eq!(detail.turns.len(), 3);
        assert_eq!(detail.session_fields["source"]["cwd"], json!("/repo"));
        assert_eq!(
            detail.turns[0].fields["source"]["message"]["content"],
            json!("hello")
        );
        assert_eq!(
            detail.turns[2].fields["source"]["message"]["content"],
            json!([{"type": "text", "text": "ok"}])
        );
        assert!(detail
            .turns
            .iter()
            .flat_map(|turn| turn.blocks.iter())
            .any(|block| matches!(block, ContentBlock::Thinking { .. })));
        assert!(detail
            .turns
            .iter()
            .flat_map(|turn| turn.blocks.iter())
            .any(|block| matches!(block, ContentBlock::ToolUse { .. })));
        assert!(detail
            .turns
            .iter()
            .flat_map(|turn| turn.blocks.iter())
            .any(|block| matches!(
                block,
                ContentBlock::ToolResult {
                    tool_use_id: Some(id),
                    is_error: false,
                    ..
                } if id == "t1"
            )));
        assert!(detail.session_stats.is_some());
    }

    #[test]
    fn jsonl_contract_accepts_role_mapped_event_records_and_path_metadata() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("%2Frepo%2Fapp").join("session-1");
        fs::create_dir_all(&project).unwrap();
        let file = project.join("chat_history.jsonl");
        let lines = [
            json!({"type":"system","content":"system prompt"}).to_string(),
            json!({"type":"user","content":[{"type":"text","text":"run it"}]}).to_string(),
            json!({"type":"reasoning","content":[],"summary":[{"type":"summary_text","text":"inspect first"}]}).to_string(),
            json!({"type":"reasoning","content":[],"summary":[]}).to_string(),
            json!({"type":"assistant","content":"done","tool_calls":[{"id":"call-1","name":"exec","arguments":{"cmd":"pwd"}}]}).to_string(),
            json!({"type":"tool_result","tool_call_id":"call-1","content":"/repo/app"}).to_string(),
            json!({"type":"custom_event","payload":{"ok":true}}).to_string(),
        ];
        fs::write(&file, lines.join("\n")).unwrap();
        let spec: SessionSpec = serde_json::from_value(json!({
            "storage": "jsonl",
            "path": temp.path(),
            "files": "**/chat_history.jsonl",
            "session": {
                "record": "system",
                "id": "@path.parent.name",
                "project": "@path.parent.parent.url_decode.name"
            },
            "message": {
                "variant": "/type",
                "roleMap": {
                    "system": "system",
                    "user": "user",
                    "assistant": "assistant",
                    "reasoning": "assistant",
                    "tool_result": "tool"
                },
                "content": ["/content", "/summary"],
                "tool_calls": "/tool_calls",
                "tool_use_id": "/tool_call_id",
                "fields": {"source": "@record"}
            }
        }))
        .unwrap();
        let parser = DeclarativeSessionParser::from_spec(AgentType::new("grok"), spec).unwrap();
        let page = parser
            .list_conversation_page(&NativeConversationPageRequest {
                project_path: "/repo/app".into(),
                cursor: None,
                limit: 10,
                scan_budget: 10,
                search: None,
            })
            .unwrap();
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].id, "session-1");
        assert_eq!(page.items[0].folder_path.as_deref(), Some("/repo/app"));
        let detail = parser.get_conversation("session-1").unwrap();
        assert!(detail.turns.iter().flat_map(|turn| turn.blocks.iter()).any(
            |block| matches!(block, ContentBlock::Thinking { text } if text == "inspect first")
        ));
        assert!(!detail
            .turns
            .iter()
            .flat_map(|turn| turn.blocks.iter())
            .any(|block| matches!(block, ContentBlock::Thinking { text } if text == "[]")));
        assert!(detail.turns.iter().flat_map(|turn| turn.blocks.iter()).any(
            |block| matches!(block, ContentBlock::ToolUse { tool_name, .. } if tool_name == "exec")
        ));
        assert!(detail
            .turns
            .iter()
            .flat_map(|turn| turn.blocks.iter())
            .any(|block| matches!(block, ContentBlock::ToolResult { tool_use_id: Some(id), .. } if id == "call-1")));
        assert!(detail.turns.iter().any(|turn| {
            turn.fields["source"]["type"] == json!("custom_event")
                && turn.fields["source"]["payload"]["ok"] == json!(true)
        }));
    }

    #[test]
    fn jsonl_reads_startup_context_tool_size_and_usage_once_per_call() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("session.jsonl");
        let usage = json!({"input_tokens": 10, "output_tokens": 2});
        let lines = [
            json!({"type":"attachment","attachment":{"type":"prompt_snapshot","systemPrompt":["sys"]}}).to_string(),
            json!({"type":"user","sessionId":"s1","cwd":"/repo","timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"hello"}}).to_string(),
            // 同一次回复拆成两行，用量相同
            json!({"type":"assistant","timestamp":"2026-01-01T00:00:01Z","message":{"role":"assistant","content":[{"type":"text","text":"a"}],"usage":usage}}).to_string(),
            json!({"type":"assistant","timestamp":"2026-01-01T00:00:01Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"sh","input":{}}],"usage":usage}}).to_string(),
            json!({"type":"user","timestamp":"2026-01-01T00:00:02Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"x".repeat(5000)}]}}).to_string(),
            json!({"type":"assistant","timestamp":"2026-01-01T00:00:03Z","message":{"role":"assistant","content":[{"type":"text","text":"b"}]}}).to_string(),
            // 只带用量的事件（OpenAI 口径，输入含缓存）
            json!({"type":"event","timestamp":"2026-01-01T00:00:03Z","message":{"usage":{"input_tokens":30,"cached_input_tokens":20,"output_tokens":1}}}).to_string(),
            // 首次请求之后的注入不算启动输入
            json!({"type":"attachment","attachment":{"type":"prompt_snapshot","systemPrompt":["later"]}}).to_string(),
        ];
        fs::write(&file, lines.join("\n")).unwrap();
        let spec: SessionSpec = serde_json::from_value(json!({
            "storage": "jsonl", "path": temp.path(), "files": "*.jsonl",
            "session": {"record": "user", "id": "/sessionId", "project": "/cwd", "time": "/timestamp"},
            "message": {"record": ["user", "assistant", "event"], "value": "/message", "role": "/role", "content": "/content", "time": "/timestamp", "usage": "/usage"},
            "context": [{"source": "system", "record": "prompt_snapshot", "kind": "/attachment/type", "text": "/attachment/systemPrompt"}]
        }))
        .unwrap();
        let parser = DeclarativeSessionParser::from_spec(AgentType::new("claude_code"), spec).unwrap();
        let detail = parser.get_conversation("s1").unwrap();
        assert_eq!(detail.context.len(), 1);
        assert_eq!((detail.context[0].source.as_str(), detail.context[0].tokens), ("system", 1));
        assert!(detail.turns.iter().flat_map(|turn| turn.blocks.iter()).any(|block| matches!(
            block,
            ContentBlock::ToolResult { output_tokens: Some(1250), .. }
        )));
        let usages: Vec<_> = detail.turns.iter().filter_map(|turn| turn.usage.as_ref()).collect();
        assert_eq!(usages.len(), 2);
        assert_eq!((usages[1].input_tokens, usages[1].cache_read_input_tokens), (10, 20));
        let total = detail.session_stats.unwrap().total_usage.unwrap();
        assert_eq!(total.output_tokens, 3);
    }

    #[test]
    fn jsonl_claude_shape_uses_nested_roles_and_tool_result_blocks() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("session.jsonl");
        let lines = [
            json!({"type":"user","sessionId":"s1","cwd":"/repo","timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"hello"}}).to_string(),
            json!({"type":"assistant","sessionId":"s1","timestamp":"2026-01-01T00:00:01Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"plan"},{"type":"tool_use","id":"t1","name":"sh","input":{"cmd":"pwd"}}]}}).to_string(),
            json!({"type":"user","sessionId":"s1","timestamp":"2026-01-01T00:00:02Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}).to_string(),
        ];
        fs::write(&file, lines.join("\n")).unwrap();
        let spec: SessionSpec = serde_json::from_value(json!({
            "storage": "jsonl",
            "path": temp.path(),
            "files": "*.jsonl",
            "session": {"record": "user", "id": "/sessionId", "project": "/cwd", "time": "/timestamp"},
            "message": {"value": "/message", "role": "/role", "content": "/content", "time": "/timestamp"}
        })).unwrap();
        let parser = DeclarativeSessionParser::from_spec(AgentType::new("claude_code"), spec).unwrap();
        let summary = parser
            .list_conversation_page(&NativeConversationPageRequest {
                project_path: "/repo".into(),
                cursor: None,
                limit: 10,
                scan_budget: 10,
                search: None,
            })
            .unwrap();
        assert_eq!(summary.items[0].message_count, 2);
        let summary_only = parser.get_conversation_summary("s1").unwrap();
        assert_eq!(summary_only.message_count, 2);
        assert_eq!(summary_only.folder_path.as_deref(), Some("/repo"));
        let detail = parser.get_conversation("s1").unwrap();
        assert_eq!(detail.summary.message_count, 2);
        assert!(detail
            .turns
            .iter()
            .flat_map(|turn| turn.blocks.iter())
            .any(|block| matches!(
                block,
                ContentBlock::ToolResult {
                    tool_use_id: Some(id),
                    output_preview: Some(output),
                    ..
                } if id == "t1" && output == "ok"
            )));
    }

    #[test]
    fn json_documents_read_the_session_from_a_sibling_and_messages_from_an_array() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("s1");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("s1.json"),
            json!({"session_id": "s1", "cwd": "/repo", "started_at": "2026-01-01T00:00:00Z"})
                .to_string(),
        )
        .unwrap();
        fs::write(
            dir.join("s1.messages.json"),
            json!({"messages": [
                {"id": "m1", "role": "user", "ts": 1767225601000_i64, "content": [{"type": "text", "text": "hello"}]},
                {"id": "m2", "role": "assistant", "ts": 1767225602000_i64, "content": [
                    {"type": "thinking", "thinking": "plan"},
                    {"type": "text", "text": "done"},
                    {"type": "tool_use", "id": "t1", "name": "sh", "input": {"cmd": "pwd"}}
                ]},
                {"id": "m3", "role": "user", "ts": 1767225603000_i64, "content": [{"type": "tool_result", "tool_use_id": "t1", "content": "ok"}]}
            ]})
            .to_string(),
        )
        .unwrap();
        let spec: SessionSpec = serde_json::from_value(json!({
            "storage": "json", "path": temp.path(), "files": "**/*.messages.json",
            "records": "/messages", "sessionDocument": "{@path.parent.name}.json",
            "session": {"id": "/session_id", "project": "/cwd", "time": "/started_at"},
            "message": {"id": "/id", "role": "/role", "content": "/content", "time": "/ts"}
        }))
        .unwrap();
        let parser = DeclarativeSessionParser::from_spec(AgentType::new("pi"), spec).unwrap();
        let page = parser
            .list_conversation_page(&NativeConversationPageRequest {
                project_path: "/repo".into(),
                cursor: None,
                limit: 10,
                scan_budget: 10,
                search: None,
            })
            .unwrap();
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].message_count, 2);
        let detail = parser.get_conversation("s1").unwrap();
        assert_eq!(detail.summary.folder_path.as_deref(), Some("/repo"));
        // 会话文档本身不算消息：只有 user / assistant / tool_result 三条记录。
        assert!(detail
            .turns
            .iter()
            .flat_map(|turn| turn.blocks.iter())
            .any(|block| matches!(
                block,
                ContentBlock::ToolResult {
                    tool_use_id: Some(id),
                    ..
                } if id == "t1"
            )));
    }

    #[test]
    fn jsonl_codex_shape_maps_response_items_without_custom_code() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("rollout.jsonl");
        let lines = [
            json!({"type":"session_meta","payload":{"id":"s1","cwd":"/repo","timestamp":"2026-01-01T00:00:00Z"}}).to_string(),
            json!({"type":"response_item","timestamp":"2026-01-01T00:00:01Z","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"run it"}]}}).to_string(),
            json!({"type":"response_item","timestamp":"2026-01-01T00:00:01Z","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"developer context"}]}}).to_string(),
            json!({"type":"response_item","timestamp":"2026-01-01T00:00:02Z","payload":{"type":"reasoning","summary":[{"type":"summary_text","text":"inspect first"}]}}).to_string(),
            json!({"type":"response_item","timestamp":"2026-01-01T00:00:02Z","payload":{"type":"reasoning","content":[],"summary":[]}}).to_string(),
            json!({"type":"response_item","timestamp":"2026-01-01T00:00:03Z","payload":{"type":"custom_tool_call","call_id":"call-1","name":"exec","input":"pwd"}}).to_string(),
            json!({"type":"response_item","timestamp":"2026-01-01T00:00:04Z","payload":{"type":"custom_tool_call_output","call_id":"call-1","output":"/repo"}}).to_string(),
        ];
        fs::write(&file, lines.join("\n")).unwrap();
        let spec: SessionSpec = serde_json::from_value(json!({
            "storage": "jsonl",
            "path": temp.path(),
            "files": "*.jsonl",
            "session": {"record": "session_meta", "id": "/payload/id", "project": "/payload/cwd", "time": "/payload/timestamp"},
            "message": {
                "record": "response_item",
                "value": "/payload",
                "variant": "/type",
                "role": "/role",
                "role_map": {"reasoning":"assistant", "custom_tool_call":"assistant", "custom_tool_call_output":"tool"},
                "content": ["/content", "/summary"],
                "tool_name": "/name",
                "tool_input": "/input",
                "tool_output": "/output",
                "tool_use_id": "/call_id",
                "time": "/timestamp"
            }
        })).unwrap();
        let parser = DeclarativeSessionParser::from_spec(AgentType::new("codex"), spec).unwrap();
        let detail = parser.get_conversation("s1").unwrap();
        assert!(detail.turns.iter().flat_map(|turn| turn.blocks.iter()).any(
            |block| matches!(block, ContentBlock::Thinking { text } if text == "inspect first")
        ));
        assert!(!detail
            .turns
            .iter()
            .flat_map(|turn| turn.blocks.iter())
            .any(|block| matches!(block, ContentBlock::Thinking { text } if text == "[]")));
        assert!(detail.turns.iter().any(|turn| {
            matches!(turn.role, TurnRole::System)
                && turn.blocks.iter().any(|block| {
                    matches!(block, ContentBlock::Text { text } if text == "developer context")
                })
        }));
        assert!(detail.turns.iter().flat_map(|turn| turn.blocks.iter()).any(
            |block| matches!(block, ContentBlock::ToolUse { tool_name, .. } if tool_name == "exec")
        ));
        assert!(detail
            .turns
            .iter()
            .flat_map(|turn| turn.blocks.iter())
            .any(|block| matches!(block, ContentBlock::ToolResult { tool_use_id: Some(id), .. } if id == "call-1")));
    }

    #[test]
    fn sqlite_contract_is_read_only_and_uses_declared_rows() {
        let temp = tempfile::tempdir().unwrap();
        let db = temp.path().join("sessions.db");
        let conn = Connection::open(&db).unwrap();
        conn.execute_batch("CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, title TEXT, created TEXT, updated TEXT); CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, time TEXT); INSERT INTO sessions VALUES ('s1','/repo','title','2026-01-01T00:00:00Z','2026-01-01T00:00:03Z'); INSERT INTO messages VALUES ('m1','s1','user','hi','2026-01-01T00:00:01Z'); INSERT INTO messages VALUES ('m2','s1','assistant','there','2026-01-01T00:00:02Z');").unwrap();
        drop(conn);
        let spec: SessionSpec = serde_json::from_value(json!({
            "storage":"sqlite","path":db,
            "session":{"table":"sessions","id":"id","project":"cwd","title":"title","created":"created","updated":"updated","order":["updated","id"],"fields":{"id":"cwd"}},
            "message":{"table":"messages","session":"session_id","id":"id","role":"role","content":"content","time":"time","order":["time","id"]}
        })).unwrap();
        let parser = DeclarativeSessionParser::from_spec(AgentType::new("open_code"), spec).unwrap();
        let page = parser
            .list_conversation_page(&NativeConversationPageRequest {
                project_path: "/repo".into(),
                cursor: None,
                limit: 10,
                scan_budget: 10,
                search: None,
            })
            .unwrap();
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].message_count, 2);
        let summary = parser.get_conversation_summary("s1").unwrap();
        assert_eq!(summary.message_count, 2);
        assert_eq!(summary.folder_path.as_deref(), Some("/repo"));
        let detail = parser.get_conversation("s1").unwrap();
        assert_eq!(detail.turns.len(), 2);
        assert_eq!(detail.session_fields.get("id"), Some(&json!("/repo")));
        assert!(
            Connection::open(&db)
                .unwrap()
                .query_row("SELECT COUNT(*) FROM sessions", [], |row| row
                    .get::<_, i64>(0))
                .unwrap()
                == 1
        );
    }

    #[test]
    fn sqlite_json_column_and_parts_use_the_same_projection() {
        let temp = tempfile::tempdir().unwrap();
        let db = temp.path().join("sessions.db");
        let conn = Connection::open(&db).unwrap();
        conn.execute_batch(
            "CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, created INTEGER);
             CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT, data TEXT, created INTEGER);
             CREATE TABLE parts (id TEXT PRIMARY KEY, message_id TEXT, data TEXT, created INTEGER);
             INSERT INTO sessions VALUES ('s1','/repo',1704067200);
             INSERT INTO messages VALUES ('m1','s1','{\"role\":\"assistant\",\"content\":\"answer\"}',1704067201);
             INSERT INTO parts VALUES ('p1','m1','{\"type\":\"thinking\",\"text\":\"reason\"}',1704067202);",
        )
        .unwrap();
        drop(conn);
        let spec: SessionSpec = serde_json::from_value(json!({
            "storage":"sqlite","path":db,
            "session":{"table":"sessions","id":"id","project":"cwd","created":"created"},
            "message":{"table":"messages","session":"session_id","id":"id","role":"data#/role","content":"data#/content","time":"created","order":["created"]},
            "part":{"table":"parts","message":"message_id","kind":"data#/type","text":"data#/text","order":["created"]}
        })).unwrap();
        let parser = DeclarativeSessionParser::from_spec(AgentType::new("open_code"), spec).unwrap();
        let detail = parser.get_conversation("s1").unwrap();
        assert!(detail
            .turns
            .iter()
            .flat_map(|turn| turn.blocks.iter())
            .any(|block| matches!(block, ContentBlock::Thinking { text } if text == "reason")));
    }

    /// `sessionIndex`（agy 形态）：会话信息来自 SQLite 那一行，消息来自会话文件；项目路径从 file URI 解码。
    #[test]
    fn jsonl_session_index_reads_the_session_from_sqlite() {
        let temp = tempfile::tempdir().unwrap();
        let db = temp.path().join("summaries.db");
        let conn = Connection::open(&db).unwrap();
        conn.execute_batch(
            "CREATE TABLE summaries (conversation_id TEXT, title TEXT, workspace_uris TEXT);
             INSERT INTO summaries VALUES ('c1', '修标题', '[\"file:///repo\"]');",
        )
        .unwrap();
        drop(conn);
        let dir = temp.path().join("brain/c1/.system_generated/logs");
        fs::create_dir_all(&dir).unwrap();
        let lines = [
            json!({"type": "USER_INPUT", "created_at": "2026-01-01T00:00:01Z", "content": "hi"}),
            json!({"type": "PLANNER_RESPONSE", "created_at": "2026-01-01T00:00:02Z", "content": "there",
                   "tool_calls": [{"name": "list_dir", "args": {"DirectoryPath": "/repo"}}]}),
        ];
        fs::write(dir.join("transcript.jsonl"), lines.map(|line| line.to_string()).join("\n")).unwrap();
        let spec: SessionSpec = serde_json::from_value(json!({
            "storage": "jsonl", "path": temp.path().join("brain"),
            "files": "**/.system_generated/logs/transcript.jsonl",
            "locate": "{id}/.system_generated/logs/transcript.jsonl",
            "sessionIndex": {"path": db, "table": "summaries", "key": "conversation_id",
                             "match": "@path.parent.parent.parent.name"},
            "session": {"id": ["conversation_id", "@path.parent.parent.parent.name"],
                        "project": "workspace_uris#/0|file_path", "title": "title"},
            "message": {"variant": "/type", "roleMap": {"USER_INPUT": "user", "PLANNER_RESPONSE": "assistant"},
                        "content": "/content", "tool_calls": "/tool_calls", "time": "/created_at"}
        }))
        .unwrap();
        let parser = DeclarativeSessionParser::from_spec(AgentType::new("antigravity"), spec.clone()).unwrap();
        let page = parser
            .list_conversation_page(&NativeConversationPageRequest {
                project_path: "/repo".into(),
                cursor: None,
                limit: 10,
                scan_budget: 10,
                search: None,
            })
            .unwrap();
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].id, "c1");
        assert_eq!(page.items[0].title.as_deref(), Some("修标题"));
        assert_eq!(page.items[0].message_count, 2);
        let detail = parser.get_conversation("c1").unwrap();
        assert_eq!(detail.summary.folder_path.as_deref(), Some("/repo"));
        assert!(detail.turns.iter().flat_map(|turn| turn.blocks.iter()).any(
            |block| matches!(block, ContentBlock::ToolUse { tool_name, .. } if tool_name == "list_dir")
        ));
        // 会话文件里另有会话记录声明时拒绝：两处来源会互相覆盖。
        let mut conflicting = spec;
        conflicting.session.record = Some(RecordMatch::One("USER_INPUT".into()));
        assert!(DeclarativeSessionParser::from_spec(AgentType::new("antigravity"), conflicting).is_err());
    }

    #[test]
    fn jsonl_keeps_declared_fields_without_content_blocks() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("s.jsonl");
        let lines = [
            json!({"type":"session","id":"s1","cwd":"/repo","timestamp":"2026-01-01T00:00:00Z"})
                .to_string(),
            json!({"type":"message","timestamp":"2026-01-01T00:00:01Z","note":"meta only"})
                .to_string(),
        ];
        fs::write(&file, lines.join("\n")).unwrap();
        let spec: SessionSpec = serde_json::from_value(json!({
            "storage": "jsonl",
            "path": temp.path(),
            "files": "**/*.jsonl",
            "session": {
                "record": "session",
                "id": "/id",
                "project": "/cwd",
                "time": "/timestamp"
            },
            "message": {
                "record": "message",
                "role": "/role",
                "content": "/content",
                "fields": {"source": "@record"}
            }
        }))
        .unwrap();
        let parser = DeclarativeSessionParser::from_spec(AgentType::new("pi"), spec.clone()).unwrap();
        let detail = parser.get_conversation("s1").unwrap();
        assert_eq!(detail.turns.len(), 1);
        assert!(detail.turns[0].blocks.is_empty());
        assert_eq!(detail.turns[0].fields["source"]["note"], json!("meta only"));
        let summary = parse_jsonl(&file, &spec, false).unwrap();
        assert!(summary.messages.is_empty());
        assert_eq!(summary.message_count, 0);
    }

    #[test]
    fn jsonl_record_list_keeps_matching_event_types() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("s.jsonl");
        let lines = [
            json!({"type":"session","id":"s1","cwd":"/repo","timestamp":"2026-01-01T00:00:00Z"})
                .to_string(),
            json!({"type":"message","role":"user","content":"hello"}).to_string(),
            json!({"type":"tool","name":"exec","output":"ok"}).to_string(),
            json!({"type":"heartbeat","ok":true}).to_string(),
        ];
        fs::write(&file, lines.join("\n")).unwrap();
        let spec: SessionSpec = serde_json::from_value(json!({
            "storage": "jsonl",
            "path": temp.path(),
            "files": "**/*.jsonl",
            "session": {
                "record": "session",
                "id": "/id",
                "project": "/cwd",
                "time": "/timestamp"
            },
            "message": {
                "record": ["message", "tool"],
                "role": "/role",
                "content": "/content",
                "fields": {"source": "@record"}
            }
        }))
        .unwrap();
        let parser = DeclarativeSessionParser::from_spec(AgentType::new("pi"), spec.clone()).unwrap();
        let detail = parser.get_conversation("s1").unwrap();
        assert_eq!(detail.turns.len(), 2);
        assert_eq!(detail.turns[0].fields["source"]["content"], json!("hello"));
        assert_eq!(detail.turns[1].fields["source"]["name"], json!("exec"));
        assert!(detail
            .turns
            .iter()
            .all(|turn| turn.fields["source"].get("type") != Some(&json!("heartbeat"))));
        let summary = parse_jsonl(&file, &spec, false).unwrap();
        assert!(summary.messages.is_empty());
        assert_eq!(summary.message_count, 1);
    }

    #[test]
    fn package_path_rejects_escape() {
        let error = safe_package_path(Path::new("/tmp/package"), "../sessions.json").unwrap_err();
        assert!(error.to_string().contains("escapes"));
    }

    #[test]
    fn tool_asset_reference_loads_without_agent_specific_parser_code() {
        let lock = berth_tool_core::paths::TEST_ENV_LOCK.get_or_init(|| std::sync::Mutex::new(()));
        let _guard = lock.lock().unwrap();
        let previous = std::env::var_os("BERTH_HOME");
        let home = tempfile::tempdir().unwrap();
        let package = home.path().join("tools/pi");
        fs::create_dir_all(&package).unwrap();
        fs::write(
            package.join("tool.json"),
            serde_json::to_vec(&json!({
                "id": "pi",
                "identity": {"name": "Fixture"},
                "extensions": {"org.berth.agent": {"sessions": "session-spec"}},
                "resources": {"session-spec": {"kind": "file", "locator": {"base": "package", "path": "sessions.json"}}}
            }))
            .unwrap(),
        )
        .unwrap();
        fs::write(
            package.join("sessions.json"),
            serde_json::to_vec(&json!({
                "storage": "jsonl",
                "path": home.path().join("sessions"),
                "session": {"record": "session", "id": "/id"},
                "message": {"record": "message", "role": "/role", "content": "/content"}
            }))
            .unwrap(),
        )
        .unwrap();
        std::env::set_var("BERTH_HOME", home.path());
        let parser = DeclarativeSessionParser::for_agent(AgentType::new("pi"))
            .unwrap()
            .expect("package declaration should be discovered");
        assert_eq!(parser.agent_type, AgentType::new("pi"));
        match previous {
            Some(value) => std::env::set_var("BERTH_HOME", value),
            None => std::env::remove_var("BERTH_HOME"),
        }
    }

    #[test]
    fn tool_lookup_matches_project_type_when_package_id_differs() {
        let lock = berth_tool_core::paths::TEST_ENV_LOCK.get_or_init(|| std::sync::Mutex::new(()));
        let _guard = lock.lock().unwrap();
        let previous = std::env::var_os("BERTH_HOME");
        let home = tempfile::tempdir().unwrap();
        let package = home.path().join("tools/claude");
        fs::create_dir_all(&package).unwrap();
        fs::write(
            package.join("tool.json"),
            serde_json::to_vec(&json!({
                "id": "claude",
                "identity": {"name": "Fixture"},
                "extensions": {
                    "org.berth.agent": {
                        "projectType": "claude_code",
                        "sessions": "session-spec"
                    }
                },
                "resources": {
                    "session-spec": {
                        "kind": "file",
                        "locator": {"base": "package", "path": "sessions.json"}
                    }
                }
            }))
            .unwrap(),
        )
        .unwrap();
        fs::write(
            package.join("sessions.json"),
            serde_json::to_vec(&json!({
                "storage": "jsonl",
                "path": home.path().join("sessions"),
                "session": {"record": "session", "id": "/id"},
                "message": {"record": "message", "role": "/role", "content": "/content"}
            }))
            .unwrap(),
        )
        .unwrap();
        std::env::set_var("BERTH_HOME", home.path());
        let parser = DeclarativeSessionParser::for_agent(AgentType::new("claude_code"))
            .unwrap()
            .expect("projectType should resolve the package id");
        assert_eq!(parser.agent_type, AgentType::new("claude_code"));
        assert_eq!(parser.root, home.path().join("sessions"));
        match previous {
            Some(value) => std::env::set_var("BERTH_HOME", value),
            None => std::env::remove_var("BERTH_HOME"),
        }
    }

    #[test]
    fn session_registry_uses_only_declared_known_assets() {
        let lock = berth_tool_core::paths::TEST_ENV_LOCK.get_or_init(|| std::sync::Mutex::new(()));
        let _guard = lock.lock().unwrap();
        let previous = std::env::var_os("BERTH_HOME");
        let home = tempfile::tempdir().unwrap();

        let write_asset = |id: &str, project_type: &str, path: &str| {
            let package = home.path().join("tools").join(id);
            fs::create_dir_all(&package).unwrap();
            fs::write(
                package.join("tool.json"),
                serde_json::to_vec(&json!({
                    "id": id,
                    "identity": {"name": id},
                    "extensions": {"org.berth.agent": {
                        "projectType": project_type,
                        "sessions": "session-spec"
                    }},
                    "resources": {"session-spec": {
                        "kind": "file",
                        "locator": {"base": "package", "path": "sessions.json"}
                    }}
                }))
                .unwrap(),
            )
            .unwrap();
            fs::write(
                package.join("sessions.json"),
                serde_json::to_vec(&json!({
                    "storage": "jsonl",
                    "path": path,
                    "session": {"record": "session", "id": "/id"},
                    "message": {"record": "message", "role": "/role", "content": "/content"}
                }))
                .unwrap(),
            )
            .unwrap();
        };

        write_asset(
            "claude",
            "claude_code",
            &home.path().join("claude-sessions").to_string_lossy(),
        );
        write_asset(
            "agy",
            "antigravity",
            &home.path().join("agy-sessions").to_string_lossy(),
        );
        std::env::set_var("BERTH_HOME", home.path());

        assert_eq!(declared_agent_types(), vec![AgentType::new("claude_code")]);
        let sources = declared_session_sources();
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].tool_id, "claude");
        assert_eq!(sources[0].root, home.path().join("claude-sessions"));

        match previous {
            Some(value) => std::env::set_var("BERTH_HOME", value),
            None => std::env::remove_var("BERTH_HOME"),
        }
    }
}
