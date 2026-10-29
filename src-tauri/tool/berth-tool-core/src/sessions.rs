//! `sessions.json` 声明（Tool Asset 的 `session-parser-spec` 资源）的共享契约层：
//! 声明类型、selector 取值与消息记录的角色判定。桌面会话 reader
//! （`src-tauri/src/sessions/declarative.rs`）与 CLI `berth session last` 共用这一份，
//! 不各自维护 selector 语义；读哪些文件、如何投影成会话由各消费者负责。

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::Deserialize;
use serde_json::Value;

/// 读取 `sessions.json` 声明失败。
#[derive(Debug, thiserror::Error)]
pub enum SessionSpecError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON parse error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("Invalid data: {0}")]
    Invalid(String),
}

pub const MAX_SPEC_BYTES: u64 = 1024 * 1024;
/// `storage: "json"` 单个会话文档的上限。
pub const MAX_DOCUMENT_BYTES: u64 = 64 * 1024 * 1024;

/// A field selector is either one location or an ordered fallback list.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum Selector {
    One(String),
    Many(Vec<String>),
}

impl Selector {
    pub fn entries(&self) -> Box<dyn Iterator<Item = &str> + '_> {
        match self {
            Self::One(value) => Box::new(std::iter::once(value.as_str())),
            Self::Many(values) => Box::new(values.iter().map(String::as_str)),
        }
    }

    pub fn first(&self) -> Option<&str> {
        self.entries().next()
    }
}

/// JSONL `type` / `kind` 判别器：一个值或一组值。
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum RecordMatch {
    One(String),
    Many(Vec<String>),
}

impl RecordMatch {
    pub fn matches(&self, actual: &str) -> bool {
        match self {
            Self::One(expected) => expected == actual,
            Self::Many(expected) => expected.iter().any(|value| value == actual),
        }
    }

    pub fn is_blank(&self) -> bool {
        match self {
            Self::One(value) => value.trim().is_empty(),
            Self::Many(values) => {
                values.is_empty() || values.iter().all(|value| value.trim().is_empty())
            }
        }
    }
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct FieldSpec {
    #[serde(default)]
    pub record: Option<RecordMatch>,
    #[serde(default)]
    pub table: Option<String>,
    #[serde(default)]
    pub id: Option<Selector>,
    #[serde(default)]
    pub project: Option<Selector>,
    #[serde(default)]
    pub title: Option<Selector>,
    #[serde(default)]
    pub created: Option<Selector>,
    #[serde(default)]
    pub updated: Option<Selector>,
    #[serde(default)]
    pub time: Option<Selector>,
    #[serde(default)]
    pub model: Option<Selector>,
    #[serde(default)]
    pub value: Option<Selector>,
    #[serde(default)]
    pub session: Option<Selector>,
    #[serde(default)]
    pub message: Option<Selector>,
    #[serde(default)]
    pub order: Option<Vec<String>>,
    #[serde(default)]
    pub role: Option<Selector>,
    /// 源记录没有标准 `role` 时，将事件类型映射到固定 Berth 角色。
    #[serde(default, alias = "roleMap")]
    pub role_map: HashMap<String, String>,
    /// 仅用于通用语义映射的源事件类型；`kind` 仍保留为旧契约的记录判别器。
    #[serde(default)]
    pub variant: Option<Selector>,
    #[serde(default)]
    pub content: Option<Selector>,
    #[serde(default)]
    pub usage: Option<Selector>,
    #[serde(default, alias = "toolCallId", alias = "toolUseId")]
    pub tool_use_id: Option<Selector>,
    #[serde(default, alias = "isError")]
    pub is_error: Option<Selector>,
    #[serde(default, alias = "toolName")]
    pub tool_name: Option<Selector>,
    #[serde(default, alias = "toolInput")]
    pub tool_input: Option<Selector>,
    #[serde(default, alias = "toolOutput")]
    pub tool_output: Option<Selector>,
    #[serde(default, alias = "toolCalls")]
    pub tool_calls: Option<Selector>,
    #[serde(default)]
    pub kind: Option<Selector>,
    #[serde(default)]
    pub text: Option<Selector>,
    /// 来源字段原样转发；宿主不解释名称或值。
    #[serde(default)]
    pub fields: BTreeMap<String, Selector>,
    /// 声明哪些 user 记录是 Agent 注入的上下文而非用户提问；命中后按 system 读取。
    #[serde(default)]
    pub injected: Option<InjectedSpec>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct InjectedSpec {
    /// 为真即视为注入（如 `/isMeta`）。
    #[serde(default)]
    pub flag: Option<Selector>,
    /// 正文（去掉前导空白后）以任一前缀开头即视为注入。
    #[serde(default)]
    pub text_prefixes: Vec<String>,
}

impl InjectedSpec {
    pub fn matches(&self, flag: Option<&Value>, content: Option<&Value>) -> bool {
        if flag.is_some_and(value_bool) {
            return true;
        }
        !self.text_prefixes.is_empty()
            && content.and_then(value_text).is_some_and(|text| {
                let text = text.trim_start();
                self.text_prefixes
                    .iter()
                    .any(|prefix| !prefix.is_empty() && text.starts_with(prefix.as_str()))
            })
    }
}

/// user 记录命中注入声明时改按 system 读取，不再算作提问或会话标题。
pub fn demote_injected(
    role: Option<Value>,
    content: Option<&Value>,
    flag: Option<&Value>,
    spec: Option<&InjectedSpec>,
) -> Option<Value> {
    let is_user = role.as_ref().and_then(value_string).as_deref() == Some("user");
    if is_user && spec.is_some_and(|spec| spec.matches(flag, content)) {
        return Some(Value::String("system".to_owned()));
    }
    role
}

#[derive(Debug, Clone, Deserialize)]
pub struct SessionSpec {
    pub storage: String,
    pub path: String,
    #[serde(default)]
    pub files: Option<String>,
    /// 会话 id 在路径里的位置：带 `{id}` 的文件模式（语法同 `files`），如 `**/*-{id}.jsonl`。
    /// 声明了就只核对路径对得上的文件；缺省时按 id 找会话要逐个读文件头。
    #[serde(default)]
    pub locate: Option<String>,
    #[serde(default)]
    pub session: FieldSpec,
    #[serde(default)]
    pub message: Option<FieldSpec>,
    #[serde(default)]
    pub part: Option<FieldSpec>,
    #[serde(default)]
    pub skills: SkillSpec,
    /// `storage: "json"`：消息记录数组在文档里的位置。
    #[serde(default)]
    pub records: Option<Selector>,
    /// `storage: "json"`：会话记录所在的同目录文档（文件名模板，可用 `{@path.…}` 路径投影），
    /// 缺省为文档本身。
    #[serde(default, rename = "sessionDocument")]
    pub session_document: Option<String>,
    /// 会话信息不在会话文件里、在 SQLite 表里时（如 agy）：按会话文件路径查出那一行，作为会话记录
    /// 放在记录流最前；`session.*` selector 读这一行（列名为键）。见 [`SessionIndexSpec`]。
    #[serde(default, rename = "sessionIndex")]
    pub session_index: Option<SessionIndexSpec>,
    /// 启动时注入给 Agent 的上下文在哪些记录里，见 [`ContextSpec`]。
    #[serde(default)]
    pub context: Vec<ContextSpec>,
}

/// `sessionIndex`：会话元数据所在的 SQLite 表。`match` 从会话文件路径取出键值（`@path.…` 投影），
/// 按 `key` 列查出一行；只读打开，查不到时会话记录为空对象（`@path` 回退仍然可用）。
#[derive(Debug, Clone, Deserialize)]
pub struct SessionIndexSpec {
    pub path: String,
    pub table: String,
    pub key: String,
    #[serde(rename = "match")]
    pub matches: Selector,
}

/// 声明了 `sessionIndex` 时，会话文件对应的那一行（列名 → 值；BLOB 为 null）。
pub fn session_index_record(spec: &SessionSpec, path: &Path) -> Option<Value> {
    let index = spec.session_index.as_ref()?;
    let key = index
        .matches
        .entries()
        .find_map(|selector| select_path(path, selector))
        .and_then(|value| value_string(&value));
    // ponytail: 每个会话文件开一次连接；会话上千时改成按列表调用复用连接。
    let row = key.and_then(|key| query_index_row(index, &key).ok().flatten());
    Some(row.unwrap_or_else(|| Value::Object(Default::default())))
}

fn query_index_row(index: &SessionIndexSpec, key: &str) -> rusqlite::Result<Option<Value>> {
    use rusqlite::{types::ValueRef, OpenFlags, OptionalExtension};
    if !is_identifier(&index.table) || !is_identifier(&index.key) {
        return Ok(None);
    }
    let connection = rusqlite::Connection::open_with_flags(
        expand_path(&index.path),
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let mut statement = connection.prepare(&format!(
        "SELECT * FROM \"{}\" WHERE \"{}\" = ?1 LIMIT 1",
        index.table, index.key
    ))?;
    let columns: Vec<String> = statement.column_names().into_iter().map(str::to_owned).collect();
    statement
        .query_row([key], |row| {
            let mut object = serde_json::Map::new();
            for (position, column) in columns.iter().enumerate() {
                let value = match row.get_ref(position)? {
                    ValueRef::Null | ValueRef::Blob(_) => Value::Null,
                    ValueRef::Integer(number) => Value::from(number),
                    ValueRef::Real(number) => Value::from(number),
                    ValueRef::Text(text) => Value::String(String::from_utf8_lossy(text).into_owned()),
                };
                object.insert(column.clone(), value);
            }
            Ok(Value::Object(object))
        })
        .optional()
}

/// SQL 标识符只认字母、数字、下划线（表名 / 列名来自声明，拼进 SQL 前校验）。
pub fn is_identifier(value: &str) -> bool {
    !value.is_empty() && value.chars().all(|char| char.is_ascii_alphanumeric() || char == '_')
}

/// 一类启动上下文（系统提示、指令文件、技能 / MCP 目录、hook 输出…）在会话记录里的位置。
/// 按 `record` + `kind` 认记录（同 [`FieldSpec`]）；`items` 指向数组时每个元素是一项、指向对象时
/// 每个键值对是一项（键名作缺省 `name`），
/// `name` / `path` / `text` 先对元素取值、取不到再对整条记录取。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextSpec {
    /// 来源类别，原样交给查看器，宿主不解释（如 `system`、`instructions`、`skills`、`mcp`、`hook`）。
    pub source: String,
    pub record: RecordMatch,
    /// 判别值的位置；缺省读记录的 `type`。
    #[serde(default)]
    pub kind: Option<Selector>,
    /// 同一种记录只有部分是注入时：正文以任一前缀开头才算。
    #[serde(default)]
    pub text_prefixes: Vec<String>,
    #[serde(default)]
    pub items: Option<Selector>,
    #[serde(default)]
    pub name: Option<Selector>,
    #[serde(default)]
    pub path: Option<Selector>,
    pub text: Selector,
}

/// 从一条记录里取出的一项启动上下文。
#[derive(Debug, Clone, PartialEq)]
pub struct ContextItem {
    pub source: String,
    pub name: Option<String>,
    pub path: Option<String>,
    pub text: String,
}

/// 按全部 `context` 声明取出这条记录里的启动上下文；不是注入记录时为空。
pub fn context_items(specs: &[ContextSpec], record: &Value) -> Vec<ContextItem> {
    let mut found = Vec::new();
    for spec in specs {
        if !kind_matches(record, &spec.record, spec.kind.as_ref()) {
            continue;
        }
        // （键名，元素）：对象按键值对展开，键名作缺省名称（如分段存的系统提示）。
        let items: Vec<(Option<String>, Value)> =
            match spec.items.as_ref().and_then(|selector| select_json(record, selector)) {
                Some(Value::Array(items)) => items.into_iter().map(|item| (None, item)).collect(),
                Some(Value::Object(items)) => items.into_iter().map(|(key, item)| (Some(key), item)).collect(),
                Some(item) => vec![(None, item)],
                None if spec.items.is_some() => continue,
                None => vec![(None, record.clone())],
            };
        for (key, item) in &items {
            let Some(text) = select_relative(Some(item), record, Some(&spec.text))
                .as_ref()
                .and_then(context_text)
                .filter(|text| !text.trim().is_empty())
            else {
                continue;
            };
            let head = text.trim_start();
            if !spec.text_prefixes.is_empty()
                && !spec.text_prefixes.iter().any(|prefix| !prefix.is_empty() && head.starts_with(prefix.as_str()))
            {
                continue;
            }
            let string = |selector: Option<&Selector>| {
                select_relative(Some(item), record, selector)
                    .as_ref()
                    .and_then(value_string)
                    .filter(|value| !value.is_empty())
            };
            found.push(ContextItem {
                source: spec.source.clone(),
                name: string(spec.name.as_ref()).or_else(|| key.clone()),
                path: string(spec.path.as_ref()),
                text,
            });
        }
    }
    found
}

/// 同一内容只留第一份：Claude 每次 `/clear` 都会再记一遍系统提示。
pub fn push_context(items: &mut Vec<ContextItem>, item: ContextItem) {
    let seen = items
        .iter()
        .any(|known| known.source == item.source && known.name == item.name && known.text == item.text);
    if !seen {
        items.push(item);
    }
}

/// 离线估算 token：中日韩字符约 1 个 1 token，其余约 4 个字符 1 token。各家分词器不同，
/// 只用来比较各块大小；精确总量看 API 报回的用量（[`parse_usage`]）。
// ponytail: 字符比例近似，误差约两三成；要精确再接各家的 count_tokens 接口。
pub fn estimate_tokens(text: &str) -> u64 {
    let (wide, other) = text.chars().fold((0u64, 0u64), |(wide, other), c| {
        if matches!(c as u32, 0x3000..=0x9FFF | 0xAC00..=0xD7AF | 0xF900..=0xFAFF | 0xFF00..=0xFFEF) {
            (wide + 1, other)
        } else {
            (wide, other + 1)
        }
    });
    wide + other.div_ceil(4)
}

/// 一次请求报回的 token 用量，各家字段名归一后的四项。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Usage {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
}

impl Usage {
    /// 这次请求的上下文：输入 + 缓存读 + 缓存写。
    pub fn context(&self) -> u64 {
        self.input + self.cache_read + self.cache_write
    }
}

/// 按常见字段名读用量；四项都为 0 时为 `None`。
pub fn parse_usage(value: &Value) -> Option<Usage> {
    let number = |keys: &[&str]| {
        keys.iter()
            .find_map(|key| value.get(*key).and_then(Value::as_u64))
            .unwrap_or(0)
    };
    let mut usage = Usage {
        input: number(&["input", "input_tokens", "prompt_tokens"]),
        output: number(&["output", "output_tokens", "completion_tokens"]),
        cache_read: number(&["cacheRead", "cache_read_input_tokens"]),
        cache_write: number(&["cacheWrite", "cache_creation_input_tokens"]),
    };
    // `cached_input_tokens` 口径（OpenAI）的输入已含缓存命中：拆出来，与其余口径一样「输入 + 缓存 = 上下文」。
    let cached = number(&["cached_input_tokens"]);
    if cached > 0 {
        usage.input = usage.input.saturating_sub(cached);
        usage.cache_read += cached;
    }
    (usage != Usage::default()).then_some(usage)
}

/// 字符串数组（分段的系统提示、逐行的目录）按段落拼回；其余同 [`value_text`]。
fn context_text(value: &Value) -> Option<String> {
    match value.as_array() {
        Some(parts) if !parts.is_empty() && parts.iter().all(Value::is_string) => Some(
            parts
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join("\n\n"),
        ),
        _ => value_text(value),
    }
}

/// 声明哪些工具调用是在加载技能；`skills/<名字>/SKILL.md` 路径约定无需声明。
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SkillSpec {
    /// 专用技能工具名（如 `Skill`）。
    #[serde(default)]
    pub tool_names: Vec<String>,
    /// 专用技能工具输入里技能名所在的键，缺省 `skill`。
    #[serde(default)]
    pub name_key: Option<String>,
}

pub fn load_session_spec(
    tool_id: &str,
    asset: &crate::asset::ToolAsset,
) -> Result<Option<SessionSpec>, SessionSpecError> {
    let Some(extension) = asset.agent_extension() else {
        return Ok(None);
    };
    let Some(resource_id) = extension.get("sessions").and_then(Value::as_str) else {
        return Ok(None);
    };
    let Some(resource) = asset
        .raw()
        .get("resources")
        .and_then(Value::as_object)
        .and_then(|resources| resources.get(resource_id))
    else {
        return Err(SessionSpecError::Invalid(format!(
            "sessions resource {resource_id:?} is not declared"
        )));
    };
    let locator = resource
        .get("locator")
        .and_then(Value::as_object)
        .ok_or_else(|| SessionSpecError::Invalid("sessions resource has no locator".into()))?;
    if locator.get("base").and_then(Value::as_str) != Some("package") {
        return Err(SessionSpecError::Invalid(
            "sessions resource must use package base".into(),
        ));
    }
    let relative = locator
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| SessionSpecError::Invalid("sessions resource path is missing".into()))?;
    let package = crate::repository::tool_package_dir(tool_id)
        .map_err(|error| SessionSpecError::Invalid(error.to_string()))?;
    let spec_path = safe_package_path(&package, relative)?;
    let metadata = fs::metadata(&spec_path)?;
    if metadata.len() > MAX_SPEC_BYTES {
        return Err(SessionSpecError::Invalid(
            "sessions.json is too large".into(),
        ));
    }
    let bytes = fs::read(spec_path)?;
    Ok(Some(serde_json::from_slice(&bytes)?))
}

/// 模板里的 `{@path.…}` 换成 `path` 的路径投影；投影取不到时为 None。
fn expand_path_template(path: &Path, template: &str) -> Option<String> {
    let mut out = String::new();
    let mut rest = template;
    while let Some(start) = rest.find('{') {
        out.push_str(&rest[..start]);
        let end = rest[start..].find('}')? + start;
        out.push_str(&value_string(&select_path(path, &rest[start + 1..end])?)?);
        rest = &rest[end + 1..];
    }
    out.push_str(rest);
    Some(out)
}

/// `pattern` 可含 `{@path.…}` 投影（如 `**/{@path.parent.name}.messages.json` 只认与目录同名的主文件）。
pub fn matches_file_pattern(root: &Path, path: &Path, pattern: &str) -> bool {
    let expanded;
    let pattern = if pattern.contains('{') {
        let Some(text) = expand_path_template(path, pattern) else {
            return false;
        };
        expanded = text;
        expanded.as_str()
    } else {
        pattern
    };
    let relative = path.strip_prefix(root).unwrap_or(path);
    let relative = relative.to_string_lossy();
    match pattern {
        "*.jsonl" => !relative.contains('/') && relative.ends_with(".jsonl"),
        "**/*.jsonl" => relative.ends_with(".jsonl"),
        // `**/*.<后缀>`：任意深度、以该后缀结尾。
        pattern if pattern.starts_with("**/*") => relative.ends_with(&pattern[4..]),
        pattern if pattern.starts_with("**/") => relative.ends_with(&pattern[3..]),
        pattern if pattern.ends_with("/*.jsonl") => {
            let prefix = pattern.trim_end_matches("/*.jsonl");
            relative.starts_with(&format!("{prefix}/")) && relative.ends_with(".jsonl")
        }
        pattern => relative == pattern,
    }
}

pub fn safe_package_path(package: &Path, relative: &str) -> Result<PathBuf, SessionSpecError> {
    let path = Path::new(relative);
    if path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(SessionSpecError::Invalid(
            "sessions resource path escapes package".into(),
        ));
    }
    Ok(package.join(path))
}

pub fn expand_path(value: &str) -> PathBuf {
    if value == "~" {
        return dirs::home_dir().unwrap_or_else(|| PathBuf::from("~"));
    }
    if let Some(rest) = value.strip_prefix("~/") {
        return dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("~"))
            .join(rest);
    }
    PathBuf::from(value)
}

pub fn select_json(root: &Value, selector: &Selector) -> Option<Value> {
    selector
        .entries()
        .find_map(|selector| select_json_one(root, selector).filter(is_non_empty_selector_value))
}

/// 按 selector 读取 JSON 记录或来源文件路径。路径 selector 只暴露文件名、stem、父目录名和
/// 可选 URL 解码，不执行表达式，也不访问任意文件系统状态。
pub fn select_json_with_path(root: &Value, selector: &Selector, path: &Path) -> Option<Value> {
    selector.entries().find_map(|selector| {
        select_json_one(root, selector)
            .filter(is_non_empty_selector_value)
            .or_else(|| select_path(path, selector))
    })
}

pub fn is_non_empty_selector_value(value: &Value) -> bool {
    // fallback 只跳过 null、空字符串和空数组；空对象、false、0 都是有效声明值。
    match value {
        Value::Null => false,
        Value::String(value) => !value.trim().is_empty(),
        Value::Array(values) => !values.is_empty(),
        Value::Bool(_) | Value::Number(_) | Value::Object(_) => true,
    }
}

pub fn select_relative(
    primary: Option<&Value>,
    root: &Value,
    selector: Option<&Selector>,
) -> Option<Value> {
    let selector = selector?;
    selector.entries().find_map(|selector| {
        if selector == "@record" {
            return Some(root.clone());
        }
        primary
            .and_then(|value| select_json_one(value, selector).filter(is_non_empty_selector_value))
            .or_else(|| select_json_one(root, selector).filter(is_non_empty_selector_value))
    })
}

pub fn select_relative_with_path(
    primary: Option<&Value>,
    root: &Value,
    selector: Option<&Selector>,
    path: &Path,
) -> Option<Value> {
    let selector = selector?;
    selector.entries().find_map(|selector| {
        // `@record` exposes the complete JSONL line. It is only a declaration
        // marker; the reader does not inspect or reshape the returned value.
        if selector == "@record" {
            return Some(root.clone());
        }
        primary
            .and_then(|value| {
                select_json_one(value, selector)
                    .filter(is_non_empty_selector_value)
                    .or_else(|| select_path(path, selector))
            })
            .or_else(|| {
                select_json_one(root, selector)
                    .filter(is_non_empty_selector_value)
                    .or_else(|| select_path(path, selector))
            })
    })
}

/// 提取声明字段。值保持 JSON 原形；空值由 selector 统一忽略。
pub fn select_declared_fields(
    primary: Option<&Value>,
    root: &Value,
    declarations: &BTreeMap<String, Selector>,
    path: &Path,
) -> BTreeMap<String, Value> {
    declarations
        .iter()
        .filter_map(|(name, selector)| {
            select_relative_with_path(primary, root, Some(selector), path)
                .map(|value| (name.clone(), value))
        })
        .collect()
}

pub fn select_json_one(root: &Value, selector: &str) -> Option<Value> {
    if let Some(selector) = selector.strip_suffix(FILE_PATH_SUFFIX) {
        return select_json_one(root, selector).and_then(|value| file_uri_path(&value));
    }
    // 空 selector 表示当前声明值本身，便于把完整来源记录交给通用查看器。
    if selector.is_empty() {
        return Some(root.clone());
    }
    if let Some((column, pointer)) = selector.split_once('#') {
        let value = root.get(column)?;
        return pointer_value(value, pointer);
    }
    if selector.starts_with('/') {
        return root.pointer(selector).cloned();
    }
    root.get(selector).cloned()
}

/// selector 后缀 `|file_path`：取到的 `file://` URI 转成本地路径（URL 解码）；不是 file URI 时原样返回。
pub const FILE_PATH_SUFFIX: &str = "|file_path";

pub fn file_uri_path(value: &Value) -> Option<Value> {
    let text = value.as_str()?;
    let Some(rest) = text.strip_prefix("file://") else {
        return Some(value.clone());
    };
    // `file:///p` 与 `file://localhost/p` 是本机；别的主机名不是本地路径。
    let path = rest.strip_prefix("localhost").unwrap_or(rest);
    if !path.starts_with('/') {
        return None;
    }
    let path = path.split(['?', '#']).next().unwrap_or(path);
    Some(Value::String(
        urlencoding::decode(path).map(|path| path.into_owned()).unwrap_or_else(|_| path.to_owned()),
    ))
}

pub fn select_path(path: &Path, selector: &str) -> Option<Value> {
    let mut operations = selector.strip_prefix("@path.")?.split('.');
    let mut current = path.to_path_buf();
    let mut decode = false;
    while let Some(operation) = operations.next() {
        match operation {
            "parent" => current = current.parent()?.to_path_buf(),
            "name" => {
                let value = current.file_name()?.to_string_lossy().into_owned();
                return Some(Value::String(if decode {
                    urlencoding::decode(&value)
                        .map(|value| value.into_owned())
                        .unwrap_or(value)
                } else {
                    value
                }));
            }
            "stem" => {
                let value = current.file_stem()?.to_string_lossy().into_owned();
                return Some(Value::String(value));
            }
            "url_decode" => decode = true,
            _ => return None,
        }
    }
    None
}

pub fn pointer_value(value: &Value, pointer: &str) -> Option<Value> {
    if pointer.is_empty() {
        return Some(value.clone());
    }
    if let Some(found) = value.pointer(pointer) {
        return Some(found.clone());
    }
    value
        .as_str()
        .and_then(|text| serde_json::from_str::<Value>(text).ok())
        .and_then(|json| json.pointer(pointer).cloned())
}

pub fn record_matches(value: &Value, fields: &FieldSpec) -> bool {
    let Some(expected) = fields.record.as_ref() else {
        return true;
    };
    kind_matches(value, expected, fields.kind.as_ref())
}

fn kind_matches(value: &Value, expected: &RecordMatch, kind: Option<&Selector>) -> bool {
    let actual = if let Some(selector) = kind {
        select_json(value, selector)
    } else {
        value.get("type").cloned()
    };
    actual
        .as_ref()
        .and_then(value_string)
        .is_some_and(|actual| expected.matches(&actual))
}

pub fn value_string(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => Some(value.trim().to_owned()),
        Value::Number(value) => Some(value.to_string()),
        Value::Bool(value) => Some(value.to_string()),
        _ => None,
    }
}

pub fn value_text(value: &Value) -> Option<String> {
    if let Some(value) = value.as_str() {
        return Some(value.to_owned());
    }
    if let Some(values) = value.as_array() {
        let text = values
            .iter()
            .filter_map(|value| {
                value
                    .as_str()
                    .or_else(|| value.get("text").and_then(Value::as_str))
            })
            .collect::<String>();
        if !text.is_empty() {
            return Some(text);
        }
        return None;
    }
    (!value.is_null())
        .then(|| serde_json::to_string(value).ok())
        .flatten()
}

pub fn value_bool(value: &Value) -> bool {
    value
        .as_bool()
        .or_else(|| value.as_str().and_then(|text| text.parse().ok()))
        .unwrap_or(false)
}

/// 一条消息记录按声明取出的判别值、角色与正文。角色先取 `role`，缺失时按
/// `roleMap` 映射判别值；命中 `injected` 的 user 记录降为 system。
pub struct MessageRecord {
    /// `value` selector 指向的嵌套消息体。
    pub nested: Option<Value>,
    pub variant: Option<Value>,
    pub role: Option<Value>,
    pub content: Option<Value>,
}

pub fn message_record(message: &FieldSpec, value: &Value) -> MessageRecord {
    let nested = message
        .value
        .as_ref()
        .and_then(|selector| select_json(value, selector));
    let variant = select_relative(nested.as_ref(), value, message.variant.as_ref());
    let role = select_relative(nested.as_ref(), value, message.role.as_ref()).or_else(|| {
        variant
            .as_ref()
            .and_then(value_string)
            .and_then(|variant| message.role_map.get(&variant).cloned())
            .map(Value::String)
    });
    let content = select_relative(nested.as_ref(), value, message.content.as_ref());
    let injected = message.injected.as_ref();
    let flag =
        injected.and_then(|spec| select_relative(nested.as_ref(), value, spec.flag.as_ref()));
    let role = demote_injected(role, content.as_ref(), flag.as_ref(), injected);
    MessageRecord {
        nested,
        variant,
        role,
        content,
    }
}

/// 声明的存储里会话文件的扩展名（`jsonl` 一行一条记录，`json` 一个文件一份会话文档）；SQLite 等返回 None。
pub fn file_extension(storage: &str) -> Option<&'static str> {
    match storage {
        "jsonl" => Some("jsonl"),
        "json" => Some("json"),
        _ => None,
    }
}

/// `storage: "json"` 的会话文档展开成与 JSONL 行同形的记录流，两个 reader 都按 JSONL 处理：
/// 先是会话记录（`sessionDocument` 指向的同目录文档，缺省为文档本身），再是 `records` 数组的元素。
/// 文档读不了、超限或没有记录数组时返回 None。
pub fn json_document_records(spec: &SessionSpec, path: &Path) -> Option<Vec<Value>> {
    let document = read_document(path)?;
    // 不走 `select_json`：它把空数组当作「没有值」，而没有消息的会话是合法的。
    let records = spec.records.as_ref()?.entries().find_map(|selector| {
        match select_json_one(&document, selector) {
            Some(Value::Array(records)) => Some(records),
            _ => None,
        }
    })?;
    let session = match spec.session_document.as_deref() {
        Some(template) => read_document(&sibling_document(path, template)?)?,
        None => document,
    };
    Some(std::iter::once(session).chain(records).collect())
}

fn read_document(path: &Path) -> Option<Value> {
    if fs::metadata(path).ok()?.len() > MAX_DOCUMENT_BYTES {
        return None;
    }
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

/// 同目录文档：模板里的 `{@path.…}` 换成会话文件的路径投影；结果只能是文件名（不含分隔符、不能是 `..`）。
fn sibling_document(path: &Path, template: &str) -> Option<PathBuf> {
    let name = expand_path_template(path, template)?;
    let safe = !name.is_empty() && !name.contains(['/', '\\']) && name != "." && name != "..";
    safe.then(|| path.parent().map(|parent| parent.join(&name)))?
}

#[cfg(test)]
mod json_document_tests {
    use super::*;
    use serde_json::json;

    fn spec(value: Value) -> SessionSpec {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn context_items_read_declared_injections_only() {
        let declared = spec(json!({
            "storage": "jsonl", "path": "/",
            "context": [
                {"source": "instructions", "record": "instructions", "kind": "/attachment/type",
                 "items": "/attachment/files", "path": "/path", "name": "/path", "text": "/content"},
                {"source": "system", "record": "prompt_snapshot", "kind": "/attachment/type",
                 "text": "/attachment/systemPrompt"},
                {"source": "instructions", "record": "user", "kind": "/payload/role",
                 "textPrefixes": ["# AGENTS.md instructions for"], "text": "/payload/content"}
            ]
        }));
        let files = json!({"type": "attachment", "attachment": {"type": "instructions", "files": [
            {"path": "/a/AGENTS.md", "content": "rule a"},
            {"path": "/b/AGENTS.md", "content": ""}
        ]}});
        assert_eq!(
            context_items(&declared.context, &files),
            [ContextItem {
                source: "instructions".into(),
                name: Some("/a/AGENTS.md".into()),
                path: Some("/a/AGENTS.md".into()),
                text: "rule a".into(),
            }]
        );
        let prompt = json!({"type": "attachment", "attachment": {"type": "prompt_snapshot", "systemPrompt": ["one", "two"]}});
        assert_eq!(context_items(&declared.context, &prompt)[0].text, "one\n\ntwo");
        let agents = json!({"type": "response_item", "payload": {"role": "user", "content": [
            {"type": "input_text", "text": "# AGENTS.md instructions for /w\nbody"}
        ]}});
        assert_eq!(context_items(&declared.context, &agents).len(), 1);
        // 对象按键值对展开，键名作名称；`text: ""` 取元素本身。
        let sections = spec(json!({"storage": "jsonl", "path": "/", "context": [
            {"source": "system", "record": "system", "kind": "/message/role", "items": "/message/sections", "text": ""},
            {"source": "tools", "record": "system", "kind": "/message/role", "items": "/message/tools", "name": "/name", "text": ""}
        ]}));
        let pi = json!({"type": "message", "message": {"role": "system",
            "sections": {"rules": "be brief", "cwd": "/w"},
            "tools": [{"name": "read", "description": "read a file"}]}});
        let found = context_items(&sections.context, &pi);
        let names: Vec<_> = found.iter().map(|item| (item.source.as_str(), item.name.as_deref())).collect();
        assert_eq!(names, [("system", Some("cwd")), ("system", Some("rules")), ("tools", Some("read"))]);
        assert!(found[2].text.contains("read a file"));
        // 前缀不符的 user 消息是真提问，不算注入。
        let question = json!({"type": "response_item", "payload": {"role": "user", "content": "hi"}});
        assert!(context_items(&declared.context, &question).is_empty());
    }

    #[test]
    fn json_documents_expand_to_a_session_record_then_messages() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("s1");
        fs::create_dir_all(&dir).unwrap();
        let messages = dir.join("s1.messages.json");
        fs::write(
            &messages,
            json!({"sessionId": "s1", "messages": [{"role": "user"}, {"role": "assistant"}]})
                .to_string(),
        )
        .unwrap();
        fs::write(dir.join("s1.json"), json!({"cwd": "/w"}).to_string()).unwrap();

        let split = spec(json!({
            "storage": "json", "path": "/", "records": "/messages",
            "sessionDocument": "{@path.parent.name}.json"
        }));
        let records = json_document_records(&split, &messages).unwrap();
        assert_eq!(records[0], json!({"cwd": "/w"}));
        assert_eq!(
            records[1..],
            [json!({"role": "user"}), json!({"role": "assistant"})]
        );

        let empty = dir.join("s2.messages.json");
        fs::write(&empty, json!({"messages": []}).to_string()).unwrap();
        fs::write(dir.join("s2.json"), json!({"cwd": "/w"}).to_string()).unwrap();
        let blank = json_document_records(
            &spec(json!({
                "storage": "json", "path": "/", "records": "/messages",
                "sessionDocument": "s2.json"
            })),
            &empty,
        )
        .unwrap();
        assert_eq!(blank, [json!({"cwd": "/w"})]);

        let single = spec(json!({"storage": "json", "path": "/", "records": "/messages"}));
        assert_eq!(
            json_document_records(&single, &messages).unwrap()[0]["sessionId"],
            "s1"
        );
        let escaping = spec(json!({
            "storage": "json", "path": "/", "records": "/messages",
            "sessionDocument": "../{@path.parent.name}.json"
        }));
        assert!(json_document_records(&escaping, &messages).is_none());
        assert!(matches_file_pattern(
            temp.path(),
            &messages,
            "**/*.messages.json"
        ));
        assert!(!matches_file_pattern(
            temp.path(),
            &dir.join("s1.json"),
            "**/*.messages.json"
        ));
        // 同目录的子 Agent 文件不当作独立会话。
        let named = "**/{@path.parent.name}.messages.json";
        assert!(matches_file_pattern(temp.path(), &messages, named));
        assert!(!matches_file_pattern(
            temp.path(),
            &dir.join("agent_x.messages.json"),
            named
        ));
    }
}
