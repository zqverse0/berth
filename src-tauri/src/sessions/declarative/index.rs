//! 会话索引：只记每一轮在源文件里的位置和一行摘要，正文与工具原文不留（照 magpie 的
//! `transcript.go` / `tail.go` / `thin.go`）。
//!
//! - JSONL：记下读到的偏移、文件头与偏移前一段的摘要；文件只长不改时从偏移续读，变短、换文件、
//!   摘要不符就整份重读。只吃以换行结尾的完整行，没写完的行等下次再读。
//! - JSON 文档、SQLite：源文件变了就整份重建，位置是第几条记录。
//! - 扫描时字符串最多留 [`THIN_KEEP`] 字节，几十 MB 的截图行不整行进内存，这一轮也不丢。
//! - 最多 [`MAX_SESSIONS`] 个会话、合计 [`MAX_ENTRIES`] 条；[`IDLE`] 内没人读就放掉。

use std::collections::hash_map::DefaultHasher;
use std::hash::Hasher;
use std::io::{BufRead, Read, Seek, SeekFrom};
use std::sync::Once;
use std::time::{Duration, Instant};

use berth_tool_core::tool_parts::{cut_text, text_part, tool_part, Part};
use serde::Serialize;

use crate::models::SessionStats;

use super::*;

/// 扫描时一个字符串最多留这么多字节：键和短值都在，摘要够用。
const THIN_KEEP: usize = 4 * 1024;
/// 文件头、偏移前各取这么多字节算摘要。
const DIGEST_BYTES: u64 = 4 * 1024;
const MAX_SESSIONS: usize = 8;
const MAX_ENTRIES: usize = 8192;
const IDLE: Duration = Duration::from_secs(5 * 60);
const TITLE_CHARS: usize = 120;

/// 一轮在源文件里的位置。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Locator {
    /// JSONL 的一行，`[from, to)` 含行尾换行。
    Bytes { from: u64, to: u64 },
    /// JSON 文档或 SQLite 里的第几条消息。
    Record { index: usize },
}

/// 索引里的一轮：角色、时间、位置与一行摘要（测试用它逐轮比对续读与整份重读）。
#[cfg(test)]
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct IndexEntry {
    pub id: String,
    pub role: TurnRole,
    pub time: DateTime<Utc>,
    pub at: Locator,
    /// 提问（分段起点）：用户的一轮带文字或图片，与前端 `isPromptTurn` 同一规则。
    pub prompt: bool,
    /// 正文第一行，没有正文时为空。
    pub title: Option<String>,
    pub tools: Vec<String>,
    pub error: bool,
    pub usage: Option<TurnUsage>,
}

/// 这次读取做了什么：日志与测试用来确认续读只解析了新写入的行。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Refresh {
    Unchanged,
    Tail { lines: usize, bytes: u64 },
    Full { lines: usize, bytes: u64 },
}

#[cfg(test)]
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct SessionIndex {
    pub entries: Vec<IndexEntry>,
    /// 按提问分好的段：`entries[start..end]`，第一段可能没有提问。
    pub segments: Vec<(usize, usize)>,
}

/// 读出会话索引：有缓存就续读或原样返回，没有就整份建。
#[cfg(test)]
pub(crate) fn session_index(
    parser: &DeclarativeSessionParser,
    id: &str,
) -> Result<(SessionIndex, Refresh), ParseError> {
    refreshed(parser, id, Built::view)
}

/// 刷新索引（续读或整份建）后在缓存里读它。
fn refreshed<T>(
    parser: &DeclarativeSessionParser,
    id: &str,
    read: impl FnOnce(&Built) -> T,
) -> Result<(T, Refresh), ParseError> {
    start_idle_sweeper();
    let key = (parser.agent_type, id.to_owned());
    let cached = cache().lock().ok().and_then(|mut cache| cache.remove(&key));
    let (mut built, refresh) = match storage_kind(&parser.spec.storage)? {
        Storage::Jsonl => jsonl_index(parser, id, cached)?,
        Storage::Json | Storage::Sqlite => record_index(parser, id, cached)?,
    };
    built.used = Instant::now();
    let value = read(&built);
    if let Ok(mut cache) = cache().lock() {
        cache.insert(key, built);
        evict(&mut cache);
    }
    Ok((value, refresh))
}

fn next_generation() -> u64 {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

// ---------------------------------------------------------------------------
// 缓存
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct Built {
    /// 整份建一次换一个号；续读不变。前端按段取内容时带上它，对不上就重取目录。
    generation: u64,
    source: Source,
    /// 每一轮的位置与摘要；用量、时间在 `parse` 里（之后的记录还会改它们）。
    marks: Vec<Mark>,
    parse: JsonlParse,
    path: PathBuf,
    used: Instant,
}

#[derive(Debug, Clone)]
enum Source {
    Jsonl(Tail),
    /// JSON 文档与 SQLite：变化标记不同就重建。
    Revision(Option<String>),
}

#[derive(Debug, Clone, PartialEq)]
struct Tail {
    file: FileId,
    offset: u64,
    head: u64,
    before: u64,
}

#[derive(Debug, Clone, PartialEq)]
struct Mark {
    at: Locator,
    prompt: bool,
    title: Option<String>,
    calls: Vec<CallMark>,
    results: Vec<ResultMark>,
    error: bool,
    blocks: bool,
    /// 有内容的思考块数。
    thinking: u32,
    /// 有内容的块数（目录据此判断一段有没有过程）。
    steps: u32,
}

/// 一次工具调用：目录按它数工具与技能、把结果的 token 记到工具名下。
#[derive(Debug, Clone, PartialEq)]
struct CallMark {
    id: Option<String>,
    name: String,
    skills: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
struct ResultMark {
    id: Option<String>,
    tokens: Option<u64>,
    error: bool,
}

type Key = (AgentType, String);

static CACHE: OnceLock<Mutex<HashMap<Key, Built>>> = OnceLock::new();

fn cache() -> &'static Mutex<HashMap<Key, Built>> {
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 超出上限时先放最久没读的；刚读的那一个总是留着。
fn evict(cache: &mut HashMap<Key, Built>) {
    loop {
        let total: usize = cache.values().map(|built| built.marks.len()).sum();
        if cache.len() <= 1 || (cache.len() <= MAX_SESSIONS && total <= MAX_ENTRIES) {
            return;
        }
        let Some(oldest) = cache
            .iter()
            .min_by_key(|(_, built)| built.used)
            .map(|(key, _)| key.clone())
        else {
            return;
        };
        cache.remove(&oldest);
    }
}

fn forget_idle(cache: &mut HashMap<Key, Built>, now: Instant) {
    cache.retain(|_, built| now.duration_since(built.used) < IDLE);
}

/// 第一次建索引时起一个线程，每分钟放掉闲置的索引；进程退出时随之结束。
fn start_idle_sweeper() {
    static START: Once = Once::new();
    START.call_once(|| {
        let _ = std::thread::Builder::new()
            .name("berth-session-index".into())
            .spawn(|| loop {
                std::thread::sleep(Duration::from_secs(60));
                if let Ok(mut cache) = cache().lock() {
                    forget_idle(&mut cache, Instant::now());
                }
            });
    });
}

#[cfg(test)]
impl Built {
    fn view(&self) -> SessionIndex {
        // 整个文件没有时间时与整份解析一样用文件修改时间（`JsonlParse::finish`）。
        let fallback = (!self.parse.observed_time)
            .then(|| file_time(&self.path))
            .flatten();
        let entries: Vec<IndexEntry> = self
            .parse
            .result
            .messages
            .iter()
            .zip(&self.marks)
            .map(|(message, mark)| IndexEntry {
                id: message.id.clone(),
                role: turn_role(&message.role),
                time: fallback.unwrap_or(message.timestamp),
                at: mark.at.clone(),
                prompt: mark.prompt,
                title: mark.title.clone(),
                tools: mark.calls.iter().map(|call| call.name.clone()).collect(),
                error: mark.error,
                usage: message.usage.clone(),
            })
            .collect();
        let segments = segments_of(&self.marks);
        SessionIndex { entries, segments }
    }
}

/// 与前端 `buildExchanges` 同一规则：遇到提问开新段；没有提问且全是空轮的段不要。
fn segments_of(marks: &[Mark]) -> Vec<(usize, usize)> {
    let mut segments = Vec::new();
    let mut start = 0;
    let close = |segments: &mut Vec<(usize, usize)>, start: usize, end: usize| {
        let has_prompt = marks.get(start).is_some_and(|mark| mark.prompt);
        if end > start && (has_prompt || marks[start..end].iter().any(|mark| mark.blocks)) {
            segments.push((start, end));
        }
    };
    for (index, mark) in marks.iter().enumerate() {
        if mark.prompt && index > start {
            close(&mut segments, start, index);
            start = index;
        }
    }
    close(&mut segments, start, marks.len());
    segments
}

// ---------------------------------------------------------------------------
// 目录
// ---------------------------------------------------------------------------

/// 阅读器的目录：每段的位置、提问摘要与统计，筛选、跳转、统计都用它，不带正文。
#[derive(Debug, Clone, Default, Serialize)]
pub struct Toc {
    pub generation: u64,
    /// `segments` 从第几段起（generation 对不上时为 0，即整份目录）。
    pub from: usize,
    /// 整个会话的轮数。
    pub turns: usize,
    pub segments: Vec<TocSegment>,
    /// 首次请求的输入 token（input + cache），即启动输入的精确总量。
    pub startup_tokens: Option<u64>,
    pub session_stats: Option<SessionStats>,
    /// 会话文件里的标题（自动标题回填用），不发给前端。
    #[serde(skip)]
    pub title: Option<String>,
}

/// 一段（一问一答）：`[start, end)` 是索引里的轮序号。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TocSegment {
    /// 第一轮的 id，与前端 `buildExchanges` 的段 id 相同（跳转用）。
    pub id: String,
    /// 第几个提问，从 1 开始；0 是首个提问之前的开场内容。
    pub index: usize,
    pub start: usize,
    pub end: usize,
    /// 第一轮是不是提问。
    pub prompt: bool,
    /// 提问首行。
    pub title: Option<String>,
    /// 回答所在的轮：本段最后一个带正文的 assistant 轮，它最后一段正文是回答。
    pub answer: Option<usize>,
    /// 除提问与回答外有内容的块数（为 0 就没有过程）。
    pub steps: u32,
    pub stats: SegmentStats,
}

/// 与前端 `ExchangeStats` 同形。
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentStats {
    pub tools: BTreeMap<String, u32>,
    pub tool_tokens: BTreeMap<String, u64>,
    pub skills: BTreeMap<String, u32>,
    pub tool_calls: u32,
    pub errors: u32,
    pub thinking: u32,
    pub context_tokens: Option<u64>,
    pub model: Option<String>,
    pub started_at: Option<DateTime<Utc>>,
    pub ended_at: Option<DateTime<Utc>>,
}

/// 读出目录。`known` 是前端手上的（generation，从第几段起要）：generation 相同时只回那段及之后
/// （续读只会改最后一段、在后面加段），不同或没有时回整份。
pub(crate) fn conversation_toc(
    parser: &DeclarativeSessionParser,
    id: &str,
    known: Option<(u64, usize)>,
) -> Result<(Toc, Refresh), ParseError> {
    refreshed(parser, id, |built| {
        let from = known
            .filter(|(generation, _)| *generation == built.generation)
            .map_or(0, |(_, from)| from);
        built.toc(from)
    })
}

fn context_tokens(usage: &TurnUsage) -> Option<u64> {
    let total =
        usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens;
    (total > 0).then_some(total)
}

impl Built {
    fn toc(&self, from: usize) -> Toc {
        let messages = &self.parse.result.messages;
        let fallback = (!self.parse.observed_time)
            .then(|| file_time(&self.path))
            .flatten();
        let ranges = segments_of(&self.marks);
        let mut prompts = 0;
        let mut segments = Vec::new();
        for (position, &(start, end)) in ranges.iter().enumerate() {
            let prompt = self.marks[start].prompt;
            prompts += usize::from(prompt);
            if position < from {
                continue;
            }
            let answer = (start..end).rev().find(|&at| {
                matches!(messages[at].role, MessageRole::Assistant) && self.marks[at].title.is_some()
            });
            let mut stats = SegmentStats::default();
            let mut names: HashMap<&str, &str> = HashMap::new();
            let mut steps = 0;
            for (message, mark) in messages[start..end].iter().zip(&self.marks[start..end]) {
                let time = fallback.unwrap_or(message.timestamp);
                stats.started_at.get_or_insert(time);
                stats.ended_at = Some(fallback.or(message.completed_at).unwrap_or(time));
                if let Some(tokens) = message.usage.as_ref().and_then(context_tokens) {
                    stats.context_tokens = Some(tokens);
                }
                if let Some(model) = &message.model {
                    stats.model = Some(model.clone());
                }
                for call in &mark.calls {
                    *stats.tools.entry(call.name.clone()).or_default() += 1;
                    stats.tool_calls += 1;
                    if let Some(id) = &call.id {
                        names.insert(id, &call.name);
                    }
                    for skill in &call.skills {
                        *stats.skills.entry(skill.clone()).or_default() += 1;
                    }
                }
                for result in &mark.results {
                    stats.errors += u32::from(result.error);
                    let name = result.id.as_deref().and_then(|id| names.get(id));
                    if let (Some(name), Some(tokens)) = (name, result.tokens) {
                        *stats.tool_tokens.entry((*name).to_owned()).or_default() += tokens;
                    }
                }
                stats.thinking += mark.thinking;
                steps += mark.steps;
            }
            if prompt {
                steps = steps.saturating_sub(self.marks[start].steps);
            }
            if answer.is_some() {
                steps = steps.saturating_sub(1);
            }
            segments.push(TocSegment {
                id: messages[start].id.clone(),
                index: if prompt { prompts } else { 0 },
                start,
                end,
                prompt,
                title: if prompt { self.marks[start].title.clone() } else { None },
                answer,
                steps,
                stats,
            });
        }
        Toc {
            generation: self.generation,
            from: from.min(ranges.len()),
            turns: self.marks.len(),
            segments,
            startup_tokens: messages
                .iter()
                .find_map(|message| message.usage.as_ref().and_then(context_tokens)),
            session_stats: usage_stats(
                messages
                    .iter()
                    .map(|message| (message.usage.as_ref(), message.duration_ms)),
            ),
            title: self.parse.result.title.clone(),
        }
    }
}

// ---------------------------------------------------------------------------
// 建索引
// ---------------------------------------------------------------------------

/// 把这条消息记成一轮的位置与摘要，并丢掉正文、声明字段（索引不留内容）。
fn mark_message(message: &mut UnifiedMessage, at: Locator, skills: &SkillSpec) -> Mark {
    let mut calls = Vec::new();
    let mut results = Vec::new();
    let mut error = false;
    let mut title = None;
    let mut prompt_content = false;
    let mut thinking = 0;
    let mut steps = 0;
    for block in &message.content {
        match block {
            ContentBlock::Text { text } => {
                if let Some(line) = text.lines().map(str::trim).find(|line| !line.is_empty()) {
                    title.get_or_insert_with(|| truncate_str(line, TITLE_CHARS));
                    prompt_content = true;
                    steps += 1;
                }
            }
            ContentBlock::Image { .. } => {
                prompt_content = true;
                steps += 1;
            }
            ContentBlock::ToolUse {
                tool_use_id,
                tool_name,
                input_preview,
                ..
            } => {
                calls.push(CallMark {
                    id: tool_use_id.clone(),
                    name: tool_name.clone(),
                    skills: skill_names(tool_name, input_preview.as_deref().unwrap_or(""), skills),
                });
                steps += 1;
            }
            ContentBlock::ToolResult {
                tool_use_id,
                output_tokens,
                is_error,
                ..
            } => {
                error |= *is_error;
                results.push(ResultMark {
                    id: tool_use_id.clone(),
                    tokens: *output_tokens,
                    error: *is_error,
                });
                steps += 1;
            }
            ContentBlock::Thinking { text } => {
                if !text.trim().is_empty() {
                    thinking += 1;
                    steps += 1;
                }
            }
            ContentBlock::ImageGeneration { .. } => steps += 1,
        }
    }
    let mark = Mark {
        at,
        prompt: matches!(message.role, MessageRole::User) && prompt_content,
        title,
        calls,
        results,
        error,
        blocks: !message.content.is_empty(),
        thinking,
        steps,
    };
    message.content = Vec::new();
    message.fields = BTreeMap::new();
    mark
}

fn turn_role(role: &MessageRole) -> TurnRole {
    match role {
        MessageRole::User => TurnRole::User,
        MessageRole::Assistant => TurnRole::Assistant,
        MessageRole::System | MessageRole::Tool => TurnRole::System,
    }
}

fn record_index(
    parser: &DeclarativeSessionParser,
    id: &str,
    cached: Option<Built>,
) -> Result<(Built, Refresh), ParseError> {
    let revision = record_revision(parser, id);
    if let Some(built) = cached {
        if matches!(&built.source, Source::Revision(known) if known.is_some() && *known == revision)
        {
            return Ok((built, Refresh::Unchanged));
        }
    }
    let detail = parser.get_conversation(id)?;
    // JSON 文档的整份解析会填定位缓存；第一次读时先取的标记可能还是空的。
    let revision = revision.or_else(|| record_revision(parser, id));
    let path = record_path(parser, id).unwrap_or_else(|| parser.root.clone());
    let mut parse = JsonlParse {
        observed_time: true,
        ..JsonlParse::default()
    };
    let mut marks = Vec::with_capacity(detail.turns.len());
    for (index, turn) in detail.turns.into_iter().enumerate() {
        let mut message = UnifiedMessage {
            id: turn.id,
            role: match turn.role {
                TurnRole::User => MessageRole::User,
                TurnRole::Assistant => MessageRole::Assistant,
                TurnRole::System => MessageRole::System,
            },
            content: turn.blocks,
            fields: BTreeMap::new(),
            timestamp: turn.timestamp,
            usage: turn.usage,
            duration_ms: None,
            model: None,
            completed_at: None,
        };
        marks.push(mark_message(
            &mut message,
            Locator::Record { index },
            &parser.spec.skills,
        ));
        parse.result.messages.push(message);
    }
    let lines = marks.len();
    Ok((
        Built {
            generation: next_generation(),
            source: Source::Revision(revision),
            marks,
            parse,
            path,
            used: Instant::now(),
        },
        Refresh::Full { lines, bytes: 0 },
    ))
}

/// SQLite 是声明的那个库文件；JSON 文档是这个会话的文件。
fn record_path(parser: &DeclarativeSessionParser, id: &str) -> Option<PathBuf> {
    match storage_kind(&parser.spec.storage).ok()? {
        Storage::Sqlite => Some(parser.root.clone()),
        _ => cached_source_locator(parser.agent_type, id),
    }
}

fn record_revision(parser: &DeclarativeSessionParser, id: &str) -> Option<String> {
    path_revision(&record_path(parser, id)?)
}

fn jsonl_index(
    parser: &DeclarativeSessionParser,
    id: &str,
    cached: Option<Built>,
) -> Result<(Built, Refresh), ParseError> {
    if let Some(mut built) = cached {
        if let Source::Jsonl(tail) = &built.source {
            match tail_state(&built.path, tail) {
                Some(TailCheck::Same) => return Ok((built, Refresh::Unchanged)),
                Some(TailCheck::Grown) => {
                    let (lines, bytes) = read_lines(parser, &mut built)?;
                    return Ok((built, Refresh::Tail { lines, bytes }));
                }
                None => {}
            }
        }
    }
    let path = jsonl_path(parser, id)?;
    let mut built = Built {
        generation: next_generation(),
        source: Source::Jsonl(Tail {
            file: FileId::default(),
            offset: 0,
            head: 0,
            before: 0,
        }),
        marks: Vec::new(),
        parse: JsonlParse::default(),
        path,
        used: Instant::now(),
    };
    // sessionIndex：索引里的那一行是会话记录（不作消息），文件里的行都不是会话记录。
    if let Some(row) = session_index_record(&parser.spec, &built.path) {
        built
            .parse
            .feed(&parser.spec, &built.path, true, false, row, true, false);
    }
    let (lines, bytes) = read_lines(parser, &mut built)?;
    let found = built.parse.result.id.as_deref() == Some(id)
        || built.path.file_stem().and_then(|stem| stem.to_str()) == Some(id);
    if !found {
        return Err(ParseError::ConversationNotFound(id.to_owned()));
    }
    Ok((built, Refresh::Full { lines, bytes }))
}

/// 与整份解析一样定位：先用定位缓存，没有再按契约找。
fn jsonl_path(parser: &DeclarativeSessionParser, id: &str) -> Result<PathBuf, ParseError> {
    if let Some(path) = cached_source_locator(parser.agent_type, id) {
        if path.starts_with(&parser.root) && path.is_file() {
            return Ok(path);
        }
    }
    let (path, _) = berth_tool_core::session_files::find_session(&parser.spec, id)
        .ok_or_else(|| ParseError::ConversationNotFound(id.to_owned()))?;
    remember_locator(parser.agent_type, id, &path);
    Ok(path)
}

/// 从上次的偏移读到最后一个完整行，逐行喂给解析状态；返回（行数，字节数）。
fn read_lines(
    parser: &DeclarativeSessionParser,
    built: &mut Built,
) -> Result<(usize, u64), ParseError> {
    let Source::Jsonl(tail) = &built.source else {
        return Ok((0, 0));
    };
    let start = tail.offset;
    let mut file = fs::File::open(&built.path)?;
    let file_id = FileId::of(&file.metadata()?);
    file.seek(SeekFrom::Start(start))?;
    let lines_have_session = parser.spec.session_index.is_none();
    let mut reader = ThinLines::new(BufReader::with_capacity(64 * 1024, file), start);
    let mut line = Vec::new();
    let mut count = 0;
    while let Some((from, to)) = reader.next_line(&mut line)? {
        count += 1;
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let Ok(value) = serde_json::from_slice::<Value>(&line) else {
            continue;
        };
        let session_record = lines_have_session && record_matches(&value, &parser.spec.session);
        if let Some(index) = built.parse.feed(
            &parser.spec,
            &built.path,
            session_record,
            true,
            value,
            true,
            false,
        ) {
            let message = &mut built.parse.result.messages[index];
            built
                .marks
                .push(mark_message(message, Locator::Bytes { from, to }, &parser.spec.skills));
        }
    }
    let offset = reader.pos;
    built.source = Source::Jsonl(Tail {
        file: file_id,
        offset,
        head: digest(&built.path, 0, offset.min(DIGEST_BYTES))?,
        before: digest(
            &built.path,
            offset.saturating_sub(DIGEST_BYTES),
            offset.min(DIGEST_BYTES),
        )?,
    });
    Ok((count, offset - start))
}

enum TailCheck {
    Same,
    Grown,
}

/// 文件只长不改才能续读：同一个文件、不比偏移短、文件头与偏移前的摘要都对得上。
fn tail_state(path: &Path, tail: &Tail) -> Option<TailCheck> {
    let meta = fs::metadata(path).ok()?;
    if FileId::of(&meta) != tail.file || meta.len() < tail.offset {
        return None;
    }
    let head = digest(path, 0, tail.offset.min(DIGEST_BYTES)).ok()?;
    let before = digest(
        path,
        tail.offset.saturating_sub(DIGEST_BYTES),
        tail.offset.min(DIGEST_BYTES),
    )
    .ok()?;
    if head != tail.head || before != tail.before {
        return None;
    }
    Some(if meta.len() == tail.offset {
        TailCheck::Same
    } else {
        TailCheck::Grown
    })
}

fn digest(path: &Path, from: u64, len: u64) -> std::io::Result<u64> {
    let mut file = fs::File::open(path)?;
    file.seek(SeekFrom::Start(from))?;
    let mut bytes = Vec::with_capacity(len as usize);
    file.take(len).read_to_end(&mut bytes)?;
    let mut hasher = DefaultHasher::new();
    hasher.write(&bytes);
    Ok(hasher.finish())
}

/// 认同一个文件：Unix 上是设备号 + inode（换文件、整份重写成新文件都会变）。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct FileId(u64, u64);

impl FileId {
    #[cfg(unix)]
    fn of(meta: &fs::Metadata) -> Self {
        use std::os::unix::fs::MetadataExt;
        Self(meta.dev(), meta.ino())
    }

    // ponytail: 非 Unix 只靠长度与摘要认文件；原地换成同样开头且更长的文件认不出，需要时用文件索引号。
    #[cfg(not(unix))]
    fn of(_meta: &fs::Metadata) -> Self {
        Self::default()
    }
}

// ---------------------------------------------------------------------------
// 按位置读出几轮，算成可显示的 Part
// ---------------------------------------------------------------------------

/// 读 Part 时一个字符串最多留的字节数：工具参数完整读出，几 MB 的截图 base64 不整段进内存。
// ponytail: 单个旧 / 新文本超过 1 MB 时增删行数只按前 1 MB 算；遇到再改成流式数行。
const PART_KEEP: usize = 1024 * 1024;

/// 按轮序号读出的几轮。`generation` 与索引对不上时 `turns` 为空，前端据此重取目录。
#[derive(Debug, Clone, Serialize)]
pub struct ReadTurns<T> {
    pub generation: u64,
    pub turns: Vec<T>,
}

impl<T> Default for ReadTurns<T> {
    fn default() -> Self {
        Self {
            generation: 0,
            turns: Vec::new(),
        }
    }
}

/// 一轮的 Part。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PartTurn {
    /// 索引里的轮序号。
    pub entry: usize,
    pub id: String,
    pub role: TurnRole,
    pub parts: Vec<Part>,
}

/// 一轮的原文（工具参数与结果不截断，单个字符串最多 [`PART_KEEP`] 字节）。
#[derive(Debug, Clone, Serialize)]
pub struct RawTurn {
    pub entry: usize,
    #[serde(flatten)]
    pub turn: MessageTurn,
}

/// 这几轮的 Part。先刷新索引，再按每一轮记下的位置读：JSONL 只读那几行，JSON 文档整份读一次
/// （不截工具参数）后取那几条。
pub(crate) fn turn_parts(
    parser: &DeclarativeSessionParser,
    id: &str,
    generation: Option<u64>,
    entries: &[usize],
) -> Result<ReadTurns<PartTurn>, ParseError> {
    let (generation, messages) = read_turns(parser, id, generation, entries)?;
    let turns = messages
        .into_iter()
        .map(|(entry, message)| PartTurn {
            entry,
            parts: message_parts(&parser.spec, &message),
            id: message.id,
            role: turn_role(&message.role),
        })
        .collect();
    Ok(ReadTurns { generation, turns })
}

/// 这几轮的原文，形状与整份 detail 的 `turns` 相同（技能已标注）。
pub(crate) fn raw_turns(
    parser: &DeclarativeSessionParser,
    id: &str,
    generation: Option<u64>,
    entries: &[usize],
) -> Result<ReadTurns<RawTurn>, ParseError> {
    let (generation, messages) = read_turns(parser, id, generation, entries)?;
    let turns = messages
        .into_iter()
        .map(|(entry, message)| {
            let mut turns = group_turns(vec![message]);
            annotate_skills(&mut turns, &parser.spec.skills);
            RawTurn {
                entry,
                turn: turns.remove(0),
            }
        })
        .collect();
    Ok(ReadTurns { generation, turns })
}

/// 按位置读出这几轮（不存在的序号跳过）。
fn read_turns(
    parser: &DeclarativeSessionParser,
    id: &str,
    generation: Option<u64>,
    entries: &[usize],
) -> Result<(u64, Vec<(usize, UnifiedMessage)>), ParseError> {
    let ((current, path, located), _) = refreshed(parser, id, |built| {
        // 没有 id 的消息按记录序号起名（`message-<序号>`），单独读一行时序号不对，用索引里的 id。
        let located: Vec<(usize, Locator, String)> =
            if generation.is_some_and(|g| g != built.generation) {
                Vec::new()
            } else {
                entries
                    .iter()
                    .filter_map(|&entry| {
                        let id = built.parse.result.messages.get(entry)?.id.clone();
                        Some((entry, built.marks.get(entry)?.at.clone(), id))
                    })
                    .collect()
            };
        (built.generation, built.path.clone(), located)
    })?;
    let mut document: Option<Vec<UnifiedMessage>> = None;
    let mut messages = Vec::with_capacity(located.len());
    for (entry, at, id_in_index) in located {
        let message = match at {
            Locator::Bytes { from, to } => line_message(parser, &path, from, to)?,
            Locator::Record { index } => {
                if document.is_none() {
                    document = Some(record_messages(parser, id, &path)?);
                }
                document
                    .as_ref()
                    .and_then(|messages| messages.get(index))
                    .cloned()
            }
        };
        if let Some(mut message) = message {
            message.id = id_in_index;
            messages.push((entry, message));
        }
    }
    Ok((current, messages))
}

/// 启动上下文（全文）。JSONL 从头读到首次请求为止，其余存储整份读。
pub(crate) fn startup_context(
    parser: &DeclarativeSessionParser,
    id: &str,
) -> Result<Vec<ContextSource>, ParseError> {
    let ((path, storage), _) = refreshed(parser, id, |built| {
        (built.path.clone(), storage_kind(&parser.spec.storage))
    })?;
    let items = match storage? {
        Storage::Jsonl => {
            let file = fs::File::open(&path)?;
            let mut reader = ThinLines {
                keep: PART_KEEP,
                ..ThinLines::new(BufReader::new(file), 0)
            };
            let mut parse = JsonlParse::default();
            let mut line = Vec::new();
            while !parse.context_done && reader.next_line(&mut line)?.is_some() {
                if let Ok(value) = serde_json::from_slice::<Value>(&line) {
                    parse.feed(&parser.spec, &path, false, true, value, true, true);
                }
            }
            parse.result.context
        }
        Storage::Json => parse_records(&path, &parser.spec, true, false)?.context,
        Storage::Sqlite => return Ok(parser.get_conversation(id)?.context),
    };
    Ok(items.into_iter().map(context_source).collect())
}

/// JSONL 的一行按声明解析成一条消息（工具参数不截断）。
fn line_message(
    parser: &DeclarativeSessionParser,
    path: &Path,
    from: u64,
    to: u64,
) -> Result<Option<UnifiedMessage>, ParseError> {
    let mut file = fs::File::open(path)?;
    file.seek(SeekFrom::Start(from))?;
    let mut reader = ThinLines {
        keep: PART_KEEP,
        ..ThinLines::new(BufReader::new(file.take(to - from)), from)
    };
    let mut line = Vec::new();
    if reader.next_line(&mut line)?.is_none() {
        return Ok(None);
    }
    let Ok(value) = serde_json::from_slice::<Value>(&line) else {
        return Ok(None);
    };
    let mut parse = JsonlParse {
        full: true,
        ..JsonlParse::default()
    };
    let index = parse.feed(&parser.spec, path, false, true, value, true, false);
    Ok(index.map(|index| parse.result.messages.swap_remove(index)))
}

/// JSON 文档整份读一次；SQLite 仍走整份读取，工具参数是截断过的。
// ponytail: SQLite 的 Part 用截断参数（现有 Agent 包都不是 SQLite）；有了再给 get_sqlite 加不截断的读法。
fn record_messages(
    parser: &DeclarativeSessionParser,
    id: &str,
    path: &Path,
) -> Result<Vec<UnifiedMessage>, ParseError> {
    if storage_kind(&parser.spec.storage)? == Storage::Json {
        return Ok(parse_records(path, &parser.spec, true, true)?.messages);
    }
    Ok(parser
        .get_conversation(id)?
        .turns
        .into_iter()
        .map(|turn| UnifiedMessage {
            id: turn.id,
            role: match turn.role {
                TurnRole::User => MessageRole::User,
                TurnRole::Assistant => MessageRole::Assistant,
                TurnRole::System => MessageRole::System,
            },
            content: turn.blocks,
            fields: turn.fields,
            timestamp: turn.timestamp,
            usage: turn.usage,
            duration_ms: turn.duration_ms,
            model: turn.model,
            completed_at: turn.completed_at,
        })
        .collect())
}

/// 一条消息的内容块逐个变成 Part；工具调用按 `sessions.json` 的 `tools` 声明讲清楚。
fn message_parts(spec: &SessionSpec, message: &UnifiedMessage) -> Vec<Part> {
    let role = match message.role {
        MessageRole::User => "user",
        MessageRole::Assistant => "assistant",
        MessageRole::System => "system",
        MessageRole::Tool => "tool",
    };
    message
        .content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => text_part(role, "text", None, text),
            ContentBlock::Thinking { text } => text_part(role, "thinking", None, text),
            ContentBlock::Image { .. } => Some(Part {
                role: role.to_owned(),
                kind: "image".to_owned(),
                ..Part::default()
            }),
            ContentBlock::ImageGeneration { revised_prompt, .. } => {
                let (text, cut) = cut_text(revised_prompt.as_deref().unwrap_or(""));
                Some(Part {
                    role: role.to_owned(),
                    kind: "image".to_owned(),
                    text: (!text.is_empty()).then_some(text),
                    cut,
                    ..Part::default()
                })
            }
            ContentBlock::ToolUse {
                tool_use_id,
                tool_name,
                input_preview,
                ..
            } => {
                let input = input_preview.as_deref().unwrap_or("");
                let mut part = tool_part(
                    &spec.tools,
                    role,
                    tool_name,
                    tool_use_id.clone(),
                    input_preview.clone().map(Value::String).as_ref(),
                );
                part.skills = skill_names(tool_name, input, &spec.skills);
                Some(part)
            }
            ContentBlock::ToolResult {
                tool_use_id,
                output_preview,
                is_error,
                ..
            } => text_part(
                role,
                if *is_error { "error" } else { "result" },
                tool_use_id.clone(),
                output_preview.as_deref().unwrap_or(""),
            ),
        })
        .collect()
}

// ---------------------------------------------------------------------------
// 逐行读，超长字符串边读边截
// ---------------------------------------------------------------------------

/// 逐行读以 `\n` 结尾的完整行；JSON 字符串超过 [`THIN_KEEP`] 字节的部分边读边丢，
/// 整行从不进内存，截出来的仍是合法 JSON。
struct ThinLines<R> {
    reader: R,
    /// 下一行的起始偏移。
    pos: u64,
    /// 一个字符串最多留的字节数。
    keep: usize,
}

#[derive(Default)]
struct Thin {
    keep: usize,
    in_string: bool,
    /// 上一个字节是 `\`。
    escape: bool,
    /// `\u` 之后还剩几位十六进制。
    hex_left: u8,
    hex: u16,
    /// 当前字符串已留的字节数。
    kept: usize,
    skipping: bool,
    /// 已留部分末尾是 `\uD800`–`\uDBFF`（代理对前半）时它在行里的起点，截在这里会留下孤立的代理。
    high_surrogate_at: Option<usize>,
    /// 这一行截掉了内容，或整行超过 [`MAX_LINE_BYTES`] 不要了。
    oversize: bool,
}

impl<R: BufRead> ThinLines<R> {
    fn new(reader: R, pos: u64) -> Self {
        Self {
            reader,
            pos,
            keep: THIN_KEEP,
        }
    }

    /// 读下一行到 `out`（不含换行），返回它在文件里的 `[from, to)`。文件结束或最后一行还没写完时为 `None`，
    /// 没写完的部分不算读过。
    fn next_line(&mut self, out: &mut Vec<u8>) -> std::io::Result<Option<(u64, u64)>> {
        out.clear();
        let from = self.pos;
        let mut consumed = 0u64;
        let mut thin = Thin {
            keep: self.keep,
            ..Thin::default()
        };
        loop {
            let chunk = self.reader.fill_buf()?;
            if chunk.is_empty() {
                return Ok(None);
            }
            let (used, done) = thin.scan(chunk, out);
            self.reader.consume(used);
            consumed += used as u64;
            if done {
                self.pos = from + consumed;
                if thin.oversize {
                    out.clear();
                }
                return Ok(Some((from, self.pos)));
            }
        }
    }
}

impl Thin {
    /// 扫一段字节，返回（用掉的字节数，这一行是否结束）。
    fn scan(&mut self, chunk: &[u8], out: &mut Vec<u8>) -> (usize, bool) {
        let mut i = 0;
        while i < chunk.len() {
            let byte = chunk[i];
            if byte == b'\n' {
                return (i + 1, true);
            }
            if self.skipping {
                // 跳过的部分只找字符串结尾，转义的下一个字节不算。
                if self.escape {
                    self.escape = false;
                } else if byte == b'\\' {
                    self.escape = true;
                } else if byte == b'"' {
                    self.skipping = false;
                    self.in_string = false;
                    self.push(out, byte);
                } else if let Some(skip) = chunk[i..]
                    .iter()
                    .position(|b| matches!(b, b'"' | b'\\' | b'\n'))
                {
                    i += skip;
                    continue;
                } else {
                    return (chunk.len(), false);
                }
                i += 1;
                continue;
            }
            if !self.in_string {
                if byte == b'"' {
                    self.in_string = true;
                    self.kept = 0;
                    self.high_surrogate_at = None;
                }
                self.push(out, byte);
                i += 1;
                continue;
            }
            if self.hex_left > 0 {
                self.hex = (self.hex << 4) | (byte as char).to_digit(16).unwrap_or(0) as u16;
                self.hex_left -= 1;
                self.push(out, byte);
                self.kept += 1;
                if self.hex_left == 0 && (0xD800..0xDC00).contains(&self.hex) {
                    // 起点是 `\uXXXX` 的反斜杠：已写入 6 个字节
                    self.high_surrogate_at = Some(out.len() - 6);
                }
                i += 1;
                continue;
            }
            if self.escape {
                self.escape = false;
                if byte == b'u' {
                    self.hex_left = 4;
                    self.hex = 0;
                }
                self.push(out, byte);
                self.kept += 1;
                i += 1;
                continue;
            }
            if byte == b'"' {
                self.in_string = false;
                self.push(out, byte);
                i += 1;
                continue;
            }
            // 只在一个字符（或转义）的开头截，不截断 UTF-8 多字节字符。
            let char_start = byte & 0xC0 != 0x80;
            if char_start && self.kept >= self.keep {
                if let Some(at) = self.high_surrogate_at.take() {
                    out.truncate(at);
                }
                self.skipping = true;
                continue;
            }
            if char_start {
                self.high_surrogate_at = None;
            }
            if byte == b'\\' {
                self.escape = true;
            }
            self.push(out, byte);
            self.kept += 1;
            i += 1;
        }
        (chunk.len(), false)
    }

    fn push(&mut self, out: &mut Vec<u8>, byte: u8) {
        // ponytail: 截字符串后仍超过上限的行（成百万个短字符串）整行不要；遇到再按数组元素截。
        if out.len() >= MAX_LINE_BYTES {
            self.oversize = true;
            return;
        }
        out.push(byte);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn thin(line: &str) -> Value {
        let mut reader = ThinLines::new(std::io::Cursor::new(format!("{line}\n")), 0);
        let mut out = Vec::new();
        reader.next_line(&mut out).unwrap().unwrap();
        serde_json::from_slice(&out).unwrap()
    }

    #[test]
    fn thin_lines_cut_long_strings_and_keep_valid_json() {
        let long = "é".repeat(THIN_KEEP); // 2 字节一个，截点落在字符中间也要对齐
        let value = thin(&json!({"a": "short", "b": long, "c": [1, {"d": "x\"y"}]}).to_string());
        assert_eq!(value["a"], "short");
        assert_eq!(value["c"], json!([1, {"d": "x\"y"}]));
        let b = value["b"].as_str().unwrap();
        assert!(
            b.len() <= THIN_KEEP + 4 && b.len() >= THIN_KEEP - 4,
            "{}",
            b.len()
        );

        // 转义、`\u` 与代理对跨过截点都要保持合法
        let escaped = format!("{}\\n{}", "a".repeat(THIN_KEEP - 1), "b".repeat(10));
        let value = thin(&format!(r#"{{"s":"{escaped}","t":1}}"#));
        assert_eq!(value["t"], 1);
        let surrogate = format!(
            "{}\\ud83d\\ude00{}",
            "a".repeat(THIN_KEEP - 3),
            "b".repeat(10)
        );
        let value = thin(&format!(r#"{{"s":"{surrogate}","t":2}}"#));
        assert_eq!(value["t"], 2);
        assert!(!value["s"].as_str().unwrap().contains('\u{FFFD}'));
    }

    #[test]
    fn thin_lines_stop_before_an_unfinished_last_line() {
        let text = "{\"a\":1}\n{\"b\":2}\n{\"c\":";
        let mut reader = ThinLines::new(std::io::Cursor::new(text), 0);
        let mut out = Vec::new();
        assert_eq!(reader.next_line(&mut out).unwrap(), Some((0, 8)));
        assert_eq!(reader.next_line(&mut out).unwrap(), Some((8, 16)));
        assert_eq!(reader.next_line(&mut out).unwrap(), None);
        assert_eq!(reader.pos, 16);
    }

    fn write_lines(path: &Path, lines: &[Value]) {
        let mut text = String::new();
        for line in lines {
            text.push_str(&line.to_string());
            text.push('\n');
        }
        fs::write(path, text).unwrap();
    }

    fn append_lines(path: &Path, lines: &[Value]) {
        use std::io::Write;
        let mut file = fs::OpenOptions::new().append(true).open(path).unwrap();
        for line in lines {
            writeln!(file, "{line}").unwrap();
        }
    }

    fn jsonl_parser(root: &Path, agent: &'static str) -> DeclarativeSessionParser {
        let spec: SessionSpec = serde_json::from_value(json!({
            "storage": "jsonl", "path": root, "files": "**/*.jsonl",
            "session": {"record": "session", "id": "/id", "project": "/cwd", "time": "/timestamp", "fields": {"source": "@record"}},
            "message": {"record": "message", "value": "/message", "role": "/role", "content": "/content", "model": "/model",
                        "time": "/timestamp", "usage": "/usage", "tool_use_id": "/toolCallId", "is_error": "/isError"}
        }))
        .unwrap();
        DeclarativeSessionParser::from_spec(AgentType::new(agent), spec).unwrap()
    }

    fn turn(i: usize) -> Vec<Value> {
        let ts = |s: usize| {
            format!(
                "2026-01-01T00:{:02}:{:02}Z",
                (i * 3 + s) / 60,
                (i * 3 + s) % 60
            )
        };
        vec![
            json!({"type":"message","timestamp":ts(0),"message":{"role":"user","content":format!("问题 {i}\n第二行")}}),
            json!({"type":"message","timestamp":ts(1),"message":{"role":"assistant","model":"m","content":[
                {"type":"text","text":format!("回答 {i}")},
                {"type":"toolCall","id":format!("t{i}"),"name":"sh","arguments":{"cmd":"pwd"}}
            ],"usage":{"input":i + 1,"output":2}}}),
            json!({"type":"message","timestamp":ts(2),"message":{"role":"toolResult","toolCallId":format!("t{i}"),
                "content":[{"type":"text","text":"ok"}],"isError": i % 2 == 1}}),
        ]
    }

    /// 从头整份建一次（不用缓存）。
    fn fresh(parser: &DeclarativeSessionParser, id: &str) -> SessionIndex {
        jsonl_index(parser, id, None).unwrap().0.view()
    }

    #[test]
    fn jsonl_tail_equals_full_reread_and_parses_only_new_lines() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("s1.jsonl");
        let mut lines = vec![
            json!({"type":"session","id":"s1","cwd":"/repo","timestamp":"2026-01-01T00:00:00Z"}),
        ];
        lines.extend(turn(0));
        write_lines(&file, &lines);
        let parser = jsonl_parser(temp.path(), "index_tail");

        let (first, refresh) = session_index(&parser, "s1").unwrap();
        assert_eq!(
            refresh,
            Refresh::Full {
                lines: 4,
                bytes: fs::metadata(&file).unwrap().len()
            }
        );
        assert_eq!(first.entries.len(), 3);
        assert_eq!(first.entries[0].title.as_deref(), Some("问题 0"));
        assert_eq!(first.entries[1].tools, vec!["sh"]);

        let (_, refresh) = session_index(&parser, "s1").unwrap();
        assert_eq!(refresh, Refresh::Unchanged);

        // 追加两轮，外加一行没写完的
        append_lines(&file, &[turn(1), turn(2)].concat());
        let size = fs::metadata(&file).unwrap().len();
        {
            use std::io::Write;
            let mut f = fs::OpenOptions::new().append(true).open(&file).unwrap();
            write!(f, "{{\"type\":\"message\",").unwrap();
        }
        let (tailed, refresh) = session_index(&parser, "s1").unwrap();
        assert!(
            matches!(refresh, Refresh::Tail { lines: 6, .. }),
            "{refresh:?}"
        );
        let Locator::Bytes { to, .. } = tailed.entries.last().unwrap().at else {
            panic!()
        };
        assert_eq!(to, size);
        // 只比完整行：截掉没写完的那行后从头建，与续读结果相等
        let complete = fs::read(&file).unwrap()[..size as usize].to_vec();
        let copy = temp.path().join("copy");
        fs::create_dir_all(&copy).unwrap();
        fs::write(copy.join("s1.jsonl"), complete).unwrap();
        let reread = fresh(&jsonl_parser(&copy, "index_tail_copy"), "s1");
        assert_eq!(tailed, reread);
        assert_eq!(tailed.segments, vec![(0, 3), (3, 6), (6, 9)]);
        assert!(tailed.entries[5].error && !tailed.entries[2].error);
    }

    #[test]
    fn jsonl_tail_keeps_cross_line_state() {
        // 用量只在后一行（只带用量的记录记到前一个 assistant 上），时间全无（用文件时间）
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("s2.jsonl");
        let spec: SessionSpec = serde_json::from_value(json!({
            "storage": "jsonl", "path": temp.path(), "files": "**/*.jsonl",
            "session": {"record": "session", "id": "/id", "title": "/title"},
            "message": {"record": "message", "role": "/role", "content": "/content", "usage": "/usage"}
        }))
        .unwrap();
        let parser =
            DeclarativeSessionParser::from_spec(AgentType::new("index_state"), spec).unwrap();
        write_lines(
            &file,
            &[
                json!({"type":"session","id":"s2","title":"标题"}),
                json!({"type":"message","role":"user","content":"hi"}),
                json!({"type":"message","role":"assistant","content":"yo"}),
            ],
        );
        session_index(&parser, "s2").unwrap();
        append_lines(
            &file,
            &[
                json!({"type":"message","role":"assistant","usage":{"input":5,"output":1}}),
                json!({"type":"session","id":"other","title":"后到的不算"}),
                json!({"type":"message","role":"user","content":"again"}),
            ],
        );
        let (tailed, refresh) = session_index(&parser, "s2").unwrap();
        assert!(matches!(refresh, Refresh::Tail { lines: 3, .. }));
        let full = fresh(&parser, "s2");
        assert_eq!(tailed, full);
        assert_eq!(
            tailed.entries[1].usage.as_ref().map(|u| u.input_tokens),
            Some(5)
        );
        let built = cache()
            .lock()
            .unwrap()
            .get(&(AgentType::new("index_state"), "s2".into()))
            .cloned()
            .unwrap();
        assert_eq!(built.parse.result.title.as_deref(), Some("标题"));
        assert_eq!(tailed.entries[2].id, "message-5");
    }

    #[test]
    fn jsonl_truncate_rewrite_or_replace_rebuilds() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("s3.jsonl");
        let head =
            json!({"type":"session","id":"s3","cwd":"/repo","timestamp":"2026-01-01T00:00:00Z"});
        write_lines(&file, &[vec![head.clone()], turn(0), turn(1)].concat());
        let parser = jsonl_parser(temp.path(), "index_rebuild");
        session_index(&parser, "s3").unwrap();

        // 变短
        write_lines(&file, &[vec![head.clone()], turn(0)].concat());
        let (index, refresh) = session_index(&parser, "s3").unwrap();
        assert!(matches!(refresh, Refresh::Full { .. }));
        assert_eq!(index, fresh(&parser, "s3"));

        // 原地改写偏移前的内容、且变长
        let mut rewritten = vec![head.clone()];
        rewritten.extend(turn(5));
        rewritten.extend(turn(6));
        let text: String = rewritten.iter().map(|line| format!("{line}\n")).collect();
        {
            use std::io::Write;
            let mut f = fs::OpenOptions::new().write(true).open(&file).unwrap();
            f.write_all(text.as_bytes()).unwrap();
        }
        let (index, refresh) = session_index(&parser, "s3").unwrap();
        assert!(matches!(refresh, Refresh::Full { .. }), "{refresh:?}");
        assert_eq!(index.entries[0].title.as_deref(), Some("问题 5"));

        // 换成另一个文件（rename 覆盖），内容开头相同且更长
        let other = temp.path().join("s3.new");
        write_lines(&other, &[vec![head], turn(5), turn(6), turn(7)].concat());
        fs::rename(&other, &file).unwrap();
        let (index, refresh) = session_index(&parser, "s3").unwrap();
        assert!(matches!(refresh, Refresh::Full { .. }), "{refresh:?}");
        assert_eq!(index, fresh(&parser, "s3"));
    }

    #[test]
    fn json_and_sqlite_rebuild_when_revision_changes() {
        let temp = tempfile::tempdir().unwrap();
        let db = temp.path().join("sessions.db");
        let conn = Connection::open(&db).unwrap();
        conn.execute_batch("CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, created TEXT); CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, time TEXT); INSERT INTO sessions VALUES ('s1','/repo','2026-01-01T00:00:00Z'); INSERT INTO messages VALUES ('m1','s1','user','hi','2026-01-01T00:00:01Z');").unwrap();
        let spec: SessionSpec = serde_json::from_value(json!({
            "storage":"sqlite","path":db,
            "session":{"table":"sessions","id":"id","project":"cwd","created":"created","order":["created","id"]},
            "message":{"table":"messages","session":"session_id","id":"id","role":"role","content":"content","time":"time","order":["time","id"]}
        })).unwrap();
        let parser =
            DeclarativeSessionParser::from_spec(AgentType::new("index_sqlite"), spec).unwrap();
        let (index, _) = session_index(&parser, "s1").unwrap();
        assert_eq!(index.entries.len(), 1);
        assert_eq!(index.entries[0].at, Locator::Record { index: 0 });
        assert_eq!(session_index(&parser, "s1").unwrap().1, Refresh::Unchanged);
        // 修改时间是纳秒级，但有的文件系统只有秒级：等一下再写，保证变化标记不同
        std::thread::sleep(Duration::from_millis(1100));
        conn.execute_batch(
            "INSERT INTO messages VALUES ('m2','s1','assistant','yo','2026-01-01T00:00:02Z');",
        )
        .unwrap();
        drop(conn);
        let (index, refresh) = session_index(&parser, "s1").unwrap();
        assert!(
            matches!(refresh, Refresh::Full { lines: 2, .. }),
            "{refresh:?}"
        );
        assert_eq!(index.entries[1].role, TurnRole::Assistant);

        let dir = temp.path().join("docs");
        fs::create_dir_all(&dir).unwrap();
        let doc = |messages: Value| json!({"session_id": "d1", "cwd": "/repo", "started_at": 1767225600000_i64, "messages": messages});
        fs::write(
            dir.join("d1.json"),
            doc(json!([{"id": "m1", "role": "user", "ts": 1767225601000_i64, "content": "hi"}]))
                .to_string(),
        )
        .unwrap();
        let spec: SessionSpec = serde_json::from_value(json!({
            "storage": "json", "path": dir, "files": "**/*.json", "records": "/messages",
            "session": {"id": "/session_id", "project": "/cwd", "time": "/started_at"},
            "message": {"id": "/id", "role": "/role", "content": "/content", "time": "/ts"}
        }))
        .unwrap();
        let parser =
            DeclarativeSessionParser::from_spec(AgentType::new("index_json"), spec).unwrap();
        assert_eq!(session_index(&parser, "d1").unwrap().0.entries.len(), 1);
        std::thread::sleep(Duration::from_millis(1100));
        fs::write(
            dir.join("d1.json"),
            doc(json!([
                {"id": "m1", "role": "user", "ts": 1767225601000_i64, "content": "hi"},
                {"id": "m2", "role": "assistant", "ts": 1767225602000_i64, "content": "yo"}
            ]))
            .to_string(),
        )
        .unwrap();
        let (index, refresh) = session_index(&parser, "d1").unwrap();
        assert!(matches!(refresh, Refresh::Full { .. }));
        assert_eq!(index.entries.len(), 2);
    }

    #[test]
    fn index_matches_the_full_reader_turn_for_turn() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("s4.jsonl");
        let mut lines = vec![
            json!({"type":"session","id":"s4","cwd":"/repo","timestamp":"2026-01-01T00:00:00Z"}),
        ];
        for i in 0..5 {
            lines.extend(turn(i));
        }
        write_lines(&file, &lines);
        let parser = jsonl_parser(temp.path(), "index_match");
        let detail = parser.get_conversation("s4").unwrap();
        let (index, _) = session_index(&parser, "s4").unwrap();
        assert_eq!(index.entries.len(), detail.turns.len());
        for (entry, turn) in index.entries.iter().zip(&detail.turns) {
            assert_eq!(entry.id, turn.id);
            assert_eq!(entry.time, turn.timestamp);
            assert_eq!(entry.usage, turn.usage);
            assert_eq!(format!("{:?}", entry.role), format!("{:?}", turn.role));
        }
        // 每一轮的范围正好是它那一行
        let bytes = fs::read(&file).unwrap();
        let Locator::Bytes { from, to } = index.entries[1].at else {
            panic!()
        };
        let line: Value = serde_json::from_slice(&bytes[from as usize..to as usize]).unwrap();
        assert_eq!(line["message"]["role"], "assistant");
    }

    #[test]
    fn huge_screenshot_line_keeps_its_turn_with_small_peak() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("s5.jsonl");
        let image = "A".repeat(30 * 1024 * 1024);
        let shot = json!({"type":"message","timestamp":"2026-01-01T00:00:02Z","message":{"role":"user","content":[
            {"type":"text","text":"看这张图"},
            {"type":"image","data": image, "mimeType":"image/png"}
        ]}});
        let mut text =
            json!({"type":"session","id":"s5","cwd":"/repo","timestamp":"2026-01-01T00:00:00Z"})
                .to_string();
        text.push('\n');
        text.push_str(&shot.to_string());
        text.push('\n');
        drop(shot);
        drop(image);
        fs::write(&file, text).unwrap();
        let parser = jsonl_parser(temp.path(), "index_huge");
        // 对照：同样的会话，图片只有几个字节；先跑它，把第一次调用的一次性开销（清理线程、缓存）排除在外
        let small = temp.path().join("small");
        fs::create_dir_all(&small).unwrap();
        write_lines(
            &small.join("s6.jsonl"),
            &[
                json!({"type":"session","id":"s6","cwd":"/repo","timestamp":"2026-01-01T00:00:00Z"}),
                json!({"type":"message","timestamp":"2026-01-01T00:00:02Z","message":{"role":"user","content":[
                {"type":"text","text":"看这张图"}, {"type":"image","data":"AAAA","mimeType":"image/png"}]}}),
            ],
        );
        let control = jsonl_parser(&small, "index_huge_control");
        let (_, control_kb) = peak_during(|| session_index(&control, "s6").unwrap().0);
        eprintln!("对照（小图）：峰值增量 {control_kb:?} KB");

        let peak = peak_during(|| session_index(&parser, "s5").unwrap().0);
        let (index, peak_kb) = peak;
        assert_eq!(index.entries.len(), 1);
        assert_eq!(index.entries[0].title.as_deref(), Some("看这张图"));
        assert!(index.entries[0].prompt);
        if let Some(peak_kb) = peak_kb {
            eprintln!("30 MB 截图行：建索引期间整进程峰值增量 {peak_kb} KB");
            assert!(peak_kb < 5 * 1024, "peak grew {peak_kb} KB");
        }
    }

    /// 整进程峰值的增量（KB）；读不到 `/proc` 的平台返回 `None`。
    fn peak_during<T>(run: impl FnOnce() -> T) -> (T, Option<u64>) {
        crate::platform::memory::reset_peak();
        let before = crate::platform::memory::rss_and_peak_kb();
        let value = run();
        let after = crate::platform::memory::rss_and_peak_kb();
        let grown = before
            .zip(after)
            .map(|((rss, _), (_, peak))| peak.saturating_sub(rss));
        (value, grown)
    }

    #[test]
    fn cache_keeps_at_most_eight_sessions_and_forgets_idle_ones() {
        let mut cache = HashMap::new();
        let built = |used: Instant, marks: usize| Built {
            generation: 0,
            source: Source::Revision(None),
            marks: vec![
                Mark {
                    at: Locator::Record { index: 0 },
                    prompt: false,
                    title: None,
                    calls: vec![],
                    results: vec![],
                    error: false,
                    blocks: true,
                    thinking: 0,
                    steps: 1,
                };
                marks
            ],
            parse: JsonlParse::default(),
            path: PathBuf::new(),
            used,
        };
        let now = Instant::now();
        for i in 0..10 {
            cache.insert(
                (AgentType::new("x"), i.to_string()),
                built(now + Duration::from_millis(i), 1),
            );
        }
        evict(&mut cache);
        assert_eq!(cache.len(), MAX_SESSIONS);
        assert!(!cache.contains_key(&(AgentType::new("x"), "0".to_string())));

        cache.insert(
            (AgentType::new("x"), "big".into()),
            built(now + Duration::from_secs(1), MAX_ENTRIES),
        );
        evict(&mut cache);
        assert_eq!(cache.len(), 1, "条数超了只留最新的那个");

        forget_idle(&mut cache, now + Duration::from_secs(1) + IDLE);
        assert!(cache.is_empty());
    }

    #[test]
    fn parts_read_by_position_use_full_arguments() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("p1.jsonl");
        let old: String = (0..3000).map(|i| format!("line {i}\n")).collect();
        let new = old.replace("line 1500\n", "changed\n");
        write_lines(
            &file,
            &[
                json!({"type":"session","id":"p1","cwd":"/repo","timestamp":"2026-01-01T00:00:00Z"}),
                json!({"type":"message","timestamp":"2026-01-01T00:00:01Z","message":{"role":"user","content":"改一下"}}),
                json!({"type":"message","timestamp":"2026-01-01T00:00:02Z","message":{"role":"assistant","content":[
                    {"type":"thinking","thinking":"想"},
                    {"type":"toolCall","id":"e1","name":"Edit","arguments":{"file_path":"/repo/a.rs","old_string":old,"new_string":new}},
                    {"type":"toolCall","id":"u1","name":"Unknown","arguments":{"q":"x"}}
                ]}}),
                json!({"type":"message","timestamp":"2026-01-01T00:00:03Z","message":{"role":"toolResult","toolCallId":"e1",
                    "content":[{"type":"text","text":"y".repeat(9000)}],"isError":true}}),
            ],
        );
        let mut parser = jsonl_parser(temp.path(), "parts_jsonl");
        parser.spec.tools = serde_json::from_value(json!({
            "Edit": {"kind": "edit", "path": "/file_path", "old": "/old_string", "new": "/new_string"}
        }))
        .unwrap();
        let parts = parts_of(&parser, "p1", &[1, 2, 9]);
        assert_eq!(parts.len(), 2);
        let call = &parts[0];
        assert_eq!(call[0].kind, "thinking");
        // 参数远超整份 detail 的 4000 字预览，增删行数仍按完整旧 / 新文本算
        assert_eq!(
            (call[1].kind.as_str(), call[1].added, call[1].removed),
            ("edit", Some(1), Some(1))
        );
        assert_eq!(call[1].paths, vec!["/repo/a.rs"]);
        assert_eq!(call[1].call.as_deref(), Some("e1"));
        assert_eq!(
            (call[2].kind.as_str(), call[2].title.as_deref()),
            ("tool", Some("Unknown"))
        );
        let result = &parts[1][0];
        assert_eq!(
            (result.kind.as_str(), result.call.as_deref()),
            ("error", Some("e1"))
        );
        assert_eq!(result.cut, 1000);
        assert_eq!(
            parts_of(&parser, "p1", &[0])[0][0]
                .text
                .as_deref(),
            Some("改一下")
        );

        let dir = temp.path().join("docs");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("d2.json"),
            json!({"session_id": "d2", "cwd": "/repo", "messages": [
                {"id": "m1", "role": "user", "content": "跑"},
                {"id": "m2", "role": "assistant", "content": [
                    {"type": "tool_use", "id": "r1", "name": "run", "input": {"commands": ["ls", "pwd"]}}
                ]}
            ]})
            .to_string(),
        )
        .unwrap();
        let spec: SessionSpec = serde_json::from_value(json!({
            "storage": "json", "path": dir, "files": "**/*.json", "records": "/messages",
            "session": {"id": "/session_id", "project": "/cwd"},
            "message": {"id": "/id", "role": "/role", "content": "/content"},
            "tools": {"run": {"kind": "command", "items": "/commands", "command": ""}}
        }))
        .unwrap();
        let parser =
            DeclarativeSessionParser::from_spec(AgentType::new("parts_json"), spec).unwrap();
        let parts = parts_of(&parser, "d2", &[0, 1]);
        assert_eq!(parts[1][0].text.as_deref(), Some("ls\npwd"));
    }

    fn parts_of(parser: &DeclarativeSessionParser, id: &str, entries: &[usize]) -> Vec<Vec<Part>> {
        turn_parts(parser, id, None, entries)
            .unwrap()
            .turns
            .into_iter()
            .map(|turn| turn.parts)
            .collect()
    }

    #[test]
    fn toc_after_tail_matches_a_refetched_toc_and_stale_generation_rereads() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("s1.jsonl");
        let mut lines = vec![
            json!({"type":"session","id":"s1","cwd":"/repo","timestamp":"2026-01-01T00:00:00Z"}),
        ];
        lines.extend([turn(0), turn(1)].concat());
        write_lines(&file, &lines);
        let parser = jsonl_parser(temp.path(), "toc_tail");

        let (first, _) = conversation_toc(&parser, "s1", None).unwrap();
        assert_eq!((first.from, first.turns, first.segments.len()), (0, 6, 2));
        let second = &first.segments[1];
        assert_eq!(
            (second.index, second.start, second.end, second.answer),
            (2, 3, 6, Some(4))
        );
        assert_eq!(second.title.as_deref(), Some("问题 1"));
        // 过程：工具调用与结果两块（提问与回答不算）
        assert_eq!(second.steps, 2);
        assert_eq!(second.stats.tools, BTreeMap::from([("sh".to_owned(), 1)]));
        assert_eq!(
            (second.stats.errors, second.stats.context_tokens),
            (1, Some(2))
        );
        assert_eq!(first.startup_tokens, Some(1));

        // 续读：只回最后一段起的变化，与整份重取的目录一致
        append_lines(&file, &turn(2));
        let known = (first.generation, first.segments.len() - 1);
        let (tail, refresh) = conversation_toc(&parser, "s1", Some(known)).unwrap();
        assert!(matches!(refresh, Refresh::Tail { lines: 3, .. }), "{refresh:?}");
        assert_eq!((tail.generation, tail.from), (first.generation, 1));
        let (whole, _) =
            conversation_toc(&jsonl_parser(temp.path(), "toc_tail_whole"), "s1", None).unwrap();
        assert_eq!(tail.segments, whole.segments[1..]);
        assert_eq!(tail.turns, whole.turns);
        assert_eq!(
            serde_json::to_value(&tail.session_stats).unwrap(),
            serde_json::to_value(&whole.session_stats).unwrap()
        );

        // generation 对不上：回整份目录，按轮读什么都不回
        let stale = Some((first.generation + 1000, 2));
        let (reread, _) = conversation_toc(&parser, "s1", stale).unwrap();
        assert_eq!((reread.from, &reread.segments), (0, &whole.segments));
        let read = turn_parts(&parser, "s1", Some(first.generation + 1000), &[0]).unwrap();
        assert!(read.turns.is_empty());
        assert_eq!(read.generation, first.generation);

        // 文件被改写：整份重建，换 generation
        write_lines(&file, &lines);
        let (rebuilt, refresh) = conversation_toc(&parser, "s1", Some(known)).unwrap();
        assert!(matches!(refresh, Refresh::Full { .. }), "{refresh:?}");
        assert_ne!(rebuilt.generation, first.generation);
        assert_eq!((rebuilt.from, rebuilt.segments.len()), (0, 2));

        // 原文：工具参数完整，技能照整份 detail 标注
        let raw = raw_turns(&parser, "s1", Some(rebuilt.generation), &[1]).unwrap();
        assert_eq!(raw.turns[0].entry, 1);
        assert_eq!(raw.turns[0].turn.id, "message-2", "沿用索引里的 id");
        assert!(matches!(
            &raw.turns[0].turn.blocks[1],
            ContentBlock::ToolUse { input_preview: Some(input), .. } if input.contains("pwd")
        ));
    }
}
