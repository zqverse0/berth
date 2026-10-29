use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeHeading {
    pub level: u32,
    pub text: String,
}

/// vault 内一篇笔记；字段语义见 `berth guide knowledge`。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeDocument {
    pub id: String,
    /// 项目相对路径，如 `.berth/knowledge/模块/终端运行时.md`。
    pub path: String,
    /// 文件名即标题。
    pub title: String,
    pub excerpt: String,
    pub note_type: String,
    pub status: String,
    pub tags: Vec<String>,
    pub aliases: Vec<String>,
    pub code: Vec<String>,
    pub sources: Vec<String>,
    pub verified_at: Option<String>,
    /// 来源笔记的链接。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// 来源笔记是否已读（专家写过摘要）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub digested: Option<bool>,
    pub headings: Vec<KnowledgeHeading>,
    /// 文件 mtime（Unix 秒）。
    pub modified_at: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeEdge {
    pub id: String,
    pub source: String,
    pub target: String,
    /// `wikilink` | `supersedes`
    pub kind: String,
    pub unresolved: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeDiagnostic {
    pub kind: String,
    pub message: String,
    pub path: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeSnapshot {
    /// vault 所在项目（主项目）的绝对路径；笔记 `path` 相对它。
    pub root: String,
    pub revision: String,
    pub generated_at: String,
    pub documents: Vec<KnowledgeDocument>,
    pub edges: Vec<KnowledgeEdge>,
    pub diagnostics: Vec<KnowledgeDiagnostic>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchRequest {
    pub query: String,
    #[serde(default = "default_limit")]
    pub limit: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetStatusRequest {
    pub path: String,
    pub status: String,
}

fn default_limit() -> usize {
    50
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub query: String,
    pub documents: Vec<KnowledgeDocument>,
}

/// 给 Agent 的一条检索结果：够判断要不要 `show`，不带正文。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub title: String,
    pub note_type: String,
    pub status: String,
    pub excerpt: String,
    /// 正文里第一处命中所在行的片段；只命中标题 / 别名 / 标签时为空。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snippet: Option<String>,
}

/// 一篇笔记的正文与关系（只列标题，不展开）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteView {
    pub title: String,
    pub path: String,
    pub note_type: String,
    pub status: String,
    pub code: Vec<String>,
    pub verified_at: Option<String>,
    /// 去掉 frontmatter 的正文。
    pub body: String,
    pub outgoing: Vec<String>,
    pub backlinks: Vec<String>,
    pub broken: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StaleResult {
    /// 可能过期的笔记路径（项目相对）。
    pub paths: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetStatusResult {
    pub path: String,
    pub status: String,
}

/// 一条想法（`<vault>/想法/<id>.md`）。`text` 是用户原话：正文第一个 `## ` 之前。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Idea {
    /// 文件名（不含 `.md`），即创建时间 `YYYY-MM-DD-HHMMSS`。
    pub id: String,
    pub path: String,
    pub status: String,
    pub tags: Vec<String>,
    pub text: String,
    pub modified_at: u64,
}
