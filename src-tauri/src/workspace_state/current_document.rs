//! Current-document context shared by the reading area and the agent tools.
//!
//! The reading area owns the identity of the document that the user is looking
//! at.  This module keeps that identity scoped to a conversation and resolves a
//! bounded, text-oriented representation only when the agent asks for it.  The
//! original path or URL is deliberately preserved in the result so the agent
//! can use its normal file/web tools for a deeper read instead of receiving a
//! giant binary blob through MCP.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use berth_control_proto::{
    excerpt_tail, WorkspaceDocumentParams, WorkspaceDocumentRange, WorkspaceDocumentResult,
    MAX_EXCERPT_BYTES,
};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::sync::RwLock;

/// Maximum text sent from a browser/editor snapshot into the backend store.
/// This is intentionally smaller than the MCP frame limit: the context store
/// is updated from UI events and must not become an unbounded memory sink.
pub const MAX_CONTEXT_SNAPSHOT_CHARS: usize = 512 * 1024;

/// Maximum selected excerpt retained for the agent and composer bridge.
pub const MAX_SELECTED_TEXT_CHARS: usize = 64 * 1024;

/// Maximum text returned by `get_current_document_content`.
pub const MAX_DOCUMENT_CONTENT_CHARS: usize = 256 * 1024;
const MAX_STORED_DOCUMENT_CONTEXTS: usize = 64;

const OFFICE_MAX_LINES: &str = "12000";
const EXTRACTOR_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_EXTRACTOR_STDERR_BYTES: u64 = 16 * 1024;

/// A location hint supplied by a viewer (line range, page number, or an
/// application-specific DOM/path locator).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentDocumentSelection {
    pub text: String,
    #[serde(default)]
    pub location: Option<String>,
}

/// 文档上下文的作用域；工作区槽独立于会话。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DocumentContextScope {
    #[default]
    Conversation,
    Workspace,
}

/// UI-to-backend registration payload.  A single shape is used for text,
/// markdown/html, PDF, Office, image, diff, and live web documents.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetCurrentDocumentContextRequest {
    #[serde(default)]
    pub scope: DocumentContextScope,
    #[serde(default)]
    pub conversation_id: i32,
    /// Remove the conversation's current document instead of registering one.
    /// This keeps close-tab transitions explicit and prevents stale context.
    #[serde(default)]
    pub clear: bool,
    pub kind: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub mime: Option<String>,
    /// Optional frontend snapshot.  It is used for unsaved editors and live
    /// WebView/PDF text that is not available from the backend process.
    #[serde(default)]
    pub content: Option<String>,
    /// Explicitly discard a previous snapshot when the current viewer has no
    /// replacement body. `content: null` alone remains backward-compatible
    /// with metadata-only updates from older clients.
    #[serde(default)]
    pub clear_content: bool,
    #[serde(default)]
    pub revision: Option<String>,
    #[serde(default)]
    pub selection: Option<CurrentDocumentSelection>,
    /// `selection: null` normally means "not supplied" for backward
    /// compatibility; this flag makes a deliberate clear unambiguous.
    #[serde(default)]
    pub clear_selection: bool,
}

#[derive(Debug, Clone)]
struct StoredCurrentDocumentContext {
    request: SetCurrentDocumentContextRequest,
    content_truncated: bool,
    selection_truncated: bool,
}

/// Structured result returned by the current-document MCP tool.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct CurrentDocumentContent {
    pub found: bool,
    pub conversation_id: i32,
    pub kind: Option<String>,
    pub title: Option<String>,
    pub source_path: Option<String>,
    pub source_url: Option<String>,
    pub mime: Option<String>,
    pub selected_text: Option<String>,
    pub selected_location: Option<String>,
    pub content: Option<String>,
    pub content_truncated: bool,
    pub source_revision: Option<String>,
    pub note: Option<String>,
}

impl CurrentDocumentContent {
    pub fn not_found(conversation_id: i32, note: impl Into<String>) -> Self {
        Self {
            found: false,
            conversation_id,
            kind: None,
            title: None,
            source_path: None,
            source_url: None,
            mime: None,
            selected_text: None,
            selected_location: None,
            content: None,
            content_truncated: false,
            source_revision: None,
            note: Some(note.into()),
        }
    }
}

struct WorkspaceDocument {
    source_path: String,
    content: String,
    input_truncated: bool,
    available_start_line: u64,
    first_line_complete: bool,
    total_lines: u64,
    committed_at_ms: u64,
    revision: u64,
}

struct WorkspaceDocumentState {
    current: Option<WorkspaceDocument>,
    revision: u64,
    scope: uuid::Uuid,
}

impl Default for WorkspaceDocumentState {
    fn default() -> Self {
        Self {
            current: None,
            revision: 0,
            scope: uuid::Uuid::new_v4(),
        }
    }
}

/// 只读失败不触发磁盘回退，也不保留历史快照以满足旧引用。
#[derive(Debug, thiserror::Error)]
pub enum WorkspaceDocumentReadError {
    #[error("{0}")]
    InvalidParams(&'static str),
    #[error("no unique visible text document is available")]
    NotFound,
    #[error("workspace snapshot changed; read the current document again")]
    StaleSnapshot,
    #[error("line {requested} is unavailable; buffered tail starts at line {available_start_line} (first line complete: {first_line_complete}), total lines: {total_lines}")]
    RangeUnavailable {
        requested: u64,
        available_start_line: u64,
        first_line_complete: bool,
        total_lines: u64,
    },
}

fn workspace_line_count(text: &str) -> u64 {
    text.split_inclusive('\n').count().max(1) as u64
}

/// 会话级文档注册表；当前工作区使用独立槽位。
#[derive(Default)]
pub struct CurrentDocumentContextStore {
    contexts: RwLock<HashMap<i32, StoredCurrentDocumentContext>>,
    workspace: std::sync::RwLock<WorkspaceDocumentState>,
}

impl CurrentDocumentContextStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// 提交编辑器缓冲快照，包括未修改与空内容，不读取磁盘。
    pub async fn set_workspace(&self, source_path: String, content: String) {
        let total_lines = workspace_line_count(&content);
        let mut start = content.len().saturating_sub(MAX_CONTEXT_SNAPSHOT_CHARS);
        while !content.is_char_boundary(start) {
            start += 1;
        }
        let input_truncated = start > 0;
        let available_start_line = 1 + content[..start]
            .bytes()
            .filter(|byte| *byte == b'\n')
            .count() as u64;
        let first_line_complete = start == 0 || content.as_bytes()[start - 1] == b'\n';
        let content = if input_truncated {
            content[start..].to_owned()
        } else {
            content
        };
        let committed_at_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let mut workspace = self.workspace.write().expect("workspace document lock");
        workspace.revision = workspace.revision.saturating_add(1);
        workspace.current = Some(WorkspaceDocument {
            source_path,
            content,
            input_truncated,
            available_start_line,
            first_line_complete,
            total_lines,
            committed_at_ms,
            revision: workspace.revision,
        });
    }

    /// 窗口隐藏时同步清空当前工作区文档。
    pub fn clear_workspace(&self) {
        let mut workspace = self.workspace.write().expect("workspace document lock");
        workspace.revision = workspace.revision.saturating_add(1);
        workspace.current = None;
    }

    /// 仅读取最近一次提交的 GUI 缓冲，不执行源文件提取。
    pub async fn get_workspace(
        &self,
        params: WorkspaceDocumentParams,
    ) -> Result<WorkspaceDocumentResult, WorkspaceDocumentReadError> {
        let (lines, bytes) = params
            .limits()
            .map_err(WorkspaceDocumentReadError::InvalidParams)?;
        let bytes = bytes.min(MAX_DOCUMENT_CONTENT_CHARS).min(MAX_EXCERPT_BYTES);
        let workspace = self.workspace.read().expect("workspace document lock");
        let snapshot_ref = format!("v1.{}.{}", workspace.scope.simple(), workspace.revision);
        // 引用比较与正文切片持有同一个读锁，不能检查 A 后又取到 B。
        if params
            .snapshot_ref
            .as_ref()
            .is_some_and(|reference| *reference != snapshot_ref)
        {
            return Err(WorkspaceDocumentReadError::StaleSnapshot);
        }
        let current = workspace
            .current
            .as_ref()
            .ok_or(WorkspaceDocumentReadError::NotFound)?;
        let (content, start_line, end_line, start_complete, end_complete, clipped) =
            if let Some(offset) = params.offset {
                if offset < current.available_start_line
                    || offset > current.total_lines
                    || (offset == current.available_start_line && !current.first_line_complete)
                {
                    return Err(WorkspaceDocumentReadError::RangeUnavailable {
                        requested: offset,
                        available_start_line: current.available_start_line,
                        first_line_complete: current.first_line_complete,
                        total_lines: current.total_lines,
                    });
                }
                let start: usize = current
                    .content
                    .split_inclusive('\n')
                    .take((offset - current.available_start_line) as usize)
                    .map(str::len)
                    .sum();
                let remaining = &current.content[start..];
                let requested_bytes: usize = remaining
                    .split_inclusive('\n')
                    .take(lines as usize)
                    .map(str::len)
                    .sum();
                let mut end = requested_bytes.min(bytes);
                while !remaining.is_char_boundary(end) {
                    end -= 1;
                }
                let content = remaining[..end].to_owned();
                let end_line = offset + workspace_line_count(&content) - 1;
                let end_complete = end == requested_bytes || content.ends_with('\n');
                let clipped = start > 0 || end < remaining.len();
                (content, offset, end_line, true, end_complete, clipped)
            } else {
                let (content, clipped) = excerpt_tail(&current.content, lines, bytes);
                let start = current.content.len() - content.len();
                let start_line = current.available_start_line
                    + current.content[..start]
                        .bytes()
                        .filter(|byte| *byte == b'\n')
                        .count() as u64;
                let start_complete = if start == 0 {
                    current.first_line_complete
                } else {
                    current.content.as_bytes()[start - 1] == b'\n'
                };
                (
                    content,
                    start_line,
                    current.total_lines,
                    start_complete,
                    true,
                    clipped,
                )
            };
        let next_offset = (end_complete && end_line < current.total_lines).then_some(end_line + 1);
        Ok(WorkspaceDocumentResult {
            source_path: current.source_path.clone(),
            content,
            committed_at_ms: current.committed_at_ms,
            revision: current.revision,
            truncated: current.input_truncated || clipped,
            snapshot_ref: Some(snapshot_ref),
            range: Some(WorkspaceDocumentRange {
                start_line,
                end_line,
                total_lines: current.total_lines,
                available_start_line: current.available_start_line,
                start_line_complete: start_complete,
                end_line_complete: end_complete,
                next_offset,
            }),
        })
    }

    /// Replace the current document for a conversation.  Truncation happens at
    /// the boundary so every caller (Tauri, HTTP, and tests) gets the same
    /// memory and response guarantees.
    pub async fn set(&self, mut request: SetCurrentDocumentContextRequest) {
        if request.clear {
            self.clear(request.conversation_id).await;
            return;
        }
        let mut contexts = self.contexts.write().await;
        let preserve_existing_fields = (!request.clear_content && request.content.is_none())
            || (request.selection.is_none() && !request.clear_selection);
        let existing_fields = if preserve_existing_fields {
            contexts
                .get(&request.conversation_id)
                .filter(|existing| {
                    same_document(&existing.request, &request)
                        && (request.revision.is_none()
                            || existing.request.revision.as_ref() == request.revision.as_ref())
                })
                .map(|existing| {
                    (
                        existing.request.content.clone(),
                        existing.content_truncated,
                        existing.request.selection.clone(),
                        existing.selection_truncated,
                    )
                })
        } else {
            None
        };
        let (content, content_truncated) = if request.clear_content {
            (None, false)
        } else {
            match request.content.take() {
                Some(content) => {
                    let (content, truncated) = truncate_text(content, MAX_CONTEXT_SNAPSHOT_CHARS);
                    (Some(content), truncated)
                }
                None => existing_fields
                    .as_ref()
                    .and_then(|(snapshot, truncated, _, _)| {
                        snapshot
                            .clone()
                            .map(|snapshot| (Some(snapshot), *truncated))
                    })
                    .unwrap_or((None, false)),
            }
        };
        let (selection, selection_truncated) = if request.clear_selection {
            (None, false)
        } else {
            request
                .selection
                .take()
                .map(|mut selection| {
                    let (text, truncated) =
                        truncate_text(std::mem::take(&mut selection.text), MAX_SELECTED_TEXT_CHARS);
                    selection.text = text;
                    (Some(selection), truncated)
                })
                .or_else(|| {
                    existing_fields
                        .as_ref()
                        .and_then(|(_, _, selection, truncated)| {
                            selection
                                .clone()
                                .map(|selection| (Some(selection), *truncated))
                        })
                })
                .unwrap_or((None, false))
        };

        // `Some("")` is a valid current snapshot (for example an unsaved empty
        // editor). Keep it distinct from `None`, which means that the caller
        // did not provide a snapshot and the source may be read from disk.
        request.content = content;
        request.clear_content = false;
        request.selection = selection;
        request.clear_selection = false;

        let stored = StoredCurrentDocumentContext {
            request,
            content_truncated,
            selection_truncated,
        };
        let conversation_id = stored.request.conversation_id;
        contexts.insert(conversation_id, stored);
        if contexts.len() > MAX_STORED_DOCUMENT_CONTEXTS {
            // This registry is process-local and ephemeral. Keep a hard cap so
            // abandoned conversations cannot retain one bounded snapshot each
            // forever; never evict the context that was just updated.
            if let Some(evicted) = contexts
                .keys()
                .copied()
                .find(|candidate| *candidate != conversation_id)
            {
                contexts.remove(&evicted);
            }
        }
    }

    pub async fn clear(&self, conversation_id: i32) {
        self.contexts.write().await.remove(&conversation_id);
    }

    pub async fn get(&self, conversation_id: i32) -> CurrentDocumentContent {
        let Some(stored) = self.contexts.read().await.get(&conversation_id).cloned() else {
            return CurrentDocumentContent::not_found(
                conversation_id,
                "No document is currently associated with this conversation.",
            );
        };

        resolve_context(conversation_id, stored).await
    }
}

fn same_document(
    left: &SetCurrentDocumentContextRequest,
    right: &SetCurrentDocumentContextRequest,
) -> bool {
    left.kind == right.kind && left.path == right.path && left.url == right.url
}

/// Access seam used by the MCP listener.  Keeping it separate from the store
/// makes the listener testable without bringing up the file readers.
#[async_trait]
pub trait CurrentDocumentContentAccess: Send + Sync {
    async fn get_current_document_content(&self, conversation_id: i32) -> CurrentDocumentContent;
}

#[async_trait]
impl CurrentDocumentContentAccess for CurrentDocumentContextStore {
    async fn get_current_document_content(&self, conversation_id: i32) -> CurrentDocumentContent {
        self.get(conversation_id).await
    }
}

/// A no-op implementation used by old listener unit tests that do not need a
/// document context. Production always supplies the real store.
pub struct EmptyCurrentDocumentContentAccess;

#[async_trait]
impl CurrentDocumentContentAccess for EmptyCurrentDocumentContentAccess {
    async fn get_current_document_content(&self, conversation_id: i32) -> CurrentDocumentContent {
        CurrentDocumentContent::not_found(
            conversation_id,
            "Current-document context is unavailable in this test/runtime.",
        )
    }
}

async fn resolve_context(
    conversation_id: i32,
    stored: StoredCurrentDocumentContext,
) -> CurrentDocumentContent {
    let request = stored.request;
    let mut notes = Vec::new();

    if stored.content_truncated {
        notes.push("the viewer snapshot was truncated".to_string());
    }
    if stored.selection_truncated {
        notes.push("the selected excerpt was truncated".to_string());
    }

    let (content, extracted_truncated, extraction_note) = if let Some(content) = request.content {
        let (content, truncated) = truncate_text(content, MAX_DOCUMENT_CONTENT_CHARS);
        (Some(content), truncated, None)
    } else if let Some(path) = request.path.as_deref() {
        extract_from_path(path, &request.kind).await
    } else {
        (
            None,
            false,
            Some("This document has no backend-readable text snapshot.".to_string()),
        )
    };

    if extracted_truncated {
        notes.push("document content was truncated".to_string());
    }
    if let Some(note) = extraction_note {
        notes.push(note);
    }
    if request.kind == "web" && content.is_none() && request.url.is_some() {
        notes.push(
            "Use the source URL with the agent's web tools when a live-page snapshot is needed."
                .to_string(),
        );
    }
    if request.kind == "image" && content.is_none() {
        notes.push(
            "The original image is available at the source path; visual analysis should use the image input/file tool."
                .to_string(),
        );
    }

    CurrentDocumentContent {
        found: true,
        conversation_id,
        kind: Some(request.kind),
        title: (!request.title.trim().is_empty()).then_some(request.title),
        source_path: request.path,
        source_url: request.url,
        mime: request.mime,
        selected_text: request
            .selection
            .as_ref()
            .map(|selection| selection.text.clone()),
        selected_location: request.selection.and_then(|selection| selection.location),
        content,
        content_truncated: extracted_truncated || stored.content_truncated,
        source_revision: request.revision,
        note: (!notes.is_empty()).then_some(notes.join("; ")),
    }
}

/// Return `(text, truncated)` while preserving valid UTF-8 boundaries.
fn truncate_text(mut text: String, limit: usize) -> (String, bool) {
    if text.len() <= limit {
        return (text, false);
    }
    const SUFFIX: &str = "\n[… truncated by Berth …]";
    if limit <= SUFFIX.len() {
        let mut end = limit;
        while end > 0 && !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
        return (text, true);
    }
    let mut end = limit.saturating_sub(SUFFIX.len());
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
    text.push_str(SUFFIX);
    (text, true)
}

async fn extract_from_path(raw_path: &str, kind: &str) -> (Option<String>, bool, Option<String>) {
    let path = PathBuf::from(raw_path);
    if !path.is_absolute() {
        return (
            None,
            false,
            Some("The source path is not absolute; refusing to read it.".to_string()),
        );
    }

    match kind {
        "office" => extract_with_plugin(&path).await,
        "pdf" => extract_with_pdftotext(&path).await,
        "image" => (
            None,
            false,
            Some("Images do not have a text extraction provider.".to_string()),
        ),
        "web" => (
            None,
            false,
            Some("A web document needs a live-page or saved snapshot.".to_string()),
        ),
        _ => read_text_file_bounded(&path).await,
    }
}

async fn read_text_file_bounded(path: &Path) -> (Option<String>, bool, Option<String>) {
    let file = match tokio::fs::File::open(path).await {
        Ok(file) => file,
        Err(error) => {
            return (
                None,
                false,
                Some(format!("Unable to read the source file: {error}")),
            )
        }
    };
    let mut bytes = Vec::new();
    let read_result = file
        .take((MAX_DOCUMENT_CONTENT_CHARS + 1) as u64)
        .read_to_end(&mut bytes)
        .await;
    if let Err(error) = read_result {
        return (
            None,
            false,
            Some(format!("Unable to read the source file: {error}")),
        );
    }

    let output_truncated = bytes.len() > MAX_DOCUMENT_CONTENT_CHARS;
    let text = String::from_utf8_lossy(&bytes).into_owned();
    let (text, truncated) = truncate_text(text, MAX_DOCUMENT_CONTENT_CHARS);
    let truncated = truncated || output_truncated;
    let note = output_truncated.then(|| "source file exceeds the context limit".to_string());
    (Some(text), truncated, note)
}

/// Office 文本抽取由启用插件的 `org.berth.extract` 提供（`{file}` / `{maxLines}` 占位）。
async fn extract_with_plugin(path: &Path) -> (Option<String>, bool, Option<String>) {
    use berth_tool_core::file_tools;
    let Some(tool) = file_tools::provider_for(file_tools::EXTRACT, path) else {
        return (
            None,
            false,
            Some("No enabled plugin extracts text from this file type; the original file is still referenced.".into()),
        );
    };
    let Some(binary) = crate::commands::preview_tools::resolve_bin(&tool.install) else {
        return (
            None,
            false,
            Some(format!(
                "{} is not available; the original file is still referenced.",
                tool.name
            )),
        );
    };
    let file = path.to_string_lossy();
    run_text_extractor(
        Command::new(binary).args(file_tools::expand_argv(
            &tool.argv,
            &[("file", &file), ("maxLines", OFFICE_MAX_LINES)],
        )),
        &tool.name,
    )
    .await
}

async fn extract_with_pdftotext(path: &Path) -> (Option<String>, bool, Option<String>) {
    let Some(binary) = locate_binary("pdftotext") else {
        return (
            None,
            false,
            Some("pdftotext is not available; provide a PDF viewer snapshot or use the original file.".into()),
        );
    };

    run_text_extractor(Command::new(binary).arg(path).arg("-"), "pdftotext").await
}

async fn run_text_extractor(
    command: &mut Command,
    name: &str,
) -> (Option<String>, bool, Option<String>) {
    let mut child = match command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => return (None, false, Some(format!("Unable to run {name}: {error}"))),
    };
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill().await;
        let _ = child.wait().await;
        return (
            None,
            false,
            Some(format!("{name} did not provide a stdout pipe")),
        );
    };
    let stderr = child.stderr.take();
    let mut stdout_task = tokio::spawn(async move {
        let mut bytes = Vec::new();
        stdout
            .take((MAX_DOCUMENT_CONTENT_CHARS + 1) as u64)
            .read_to_end(&mut bytes)
            .await
            .map(|_| bytes)
    });
    let stderr_task = tokio::spawn(async move {
        let Some(stderr) = stderr else {
            return Ok(Vec::new());
        };
        let mut bytes = Vec::new();
        stderr
            .take(MAX_EXTRACTOR_STDERR_BYTES)
            .read_to_end(&mut bytes)
            .await
            .map(|_| bytes)
    });

    let stdout = match tokio::time::timeout(EXTRACTOR_TIMEOUT, &mut stdout_task).await {
        Ok(Ok(Ok(bytes))) => bytes,
        Ok(Ok(Err(error))) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            let _ = stderr_task.await;
            return (
                None,
                false,
                Some(format!("{name} output read failed: {error}")),
            );
        }
        Ok(Err(error)) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            let _ = stderr_task.await;
            return (
                None,
                false,
                Some(format!("{name} output task failed: {error}")),
            );
        }
        Err(_) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            let _ = stdout_task.await;
            let _ = stderr_task.await;
            return (
                None,
                false,
                Some(format!(
                    "{name} timed out after {} seconds",
                    EXTRACTOR_TIMEOUT.as_secs()
                )),
            );
        }
    };
    let output_truncated = stdout.len() > MAX_DOCUMENT_CONTENT_CHARS;
    if output_truncated {
        let _ = child.kill().await;
    }
    let status = match tokio::time::timeout(EXTRACTOR_TIMEOUT, child.wait()).await {
        Ok(Ok(status)) => status,
        Ok(Err(error)) => {
            let _ = stderr_task.await;
            return (None, false, Some(format!("{name} wait failed: {error}")));
        }
        Err(_) => {
            let _ = child.kill().await;
            let _ = stderr_task.await;
            return (
                None,
                false,
                Some(format!("{name} timed out while finishing")),
            );
        }
    };
    let stderr = stderr_task
        .await
        .ok()
        .and_then(Result::ok)
        .map(|bytes| String::from_utf8_lossy(&bytes).trim().to_string())
        .unwrap_or_default();

    if !status.success() && !output_truncated {
        let detail = if stderr.is_empty() {
            format!("{name} failed with status {status}")
        } else {
            format!("{name} failed: {stderr}")
        };
        return (None, false, Some(detail));
    }

    let text = String::from_utf8_lossy(&stdout).into_owned();
    let (text, truncated) = truncate_text(text, MAX_DOCUMENT_CONTENT_CHARS);
    let note = output_truncated.then(|| format!("{name} output exceeded the context limit"));
    (Some(text), truncated || output_truncated, note)
}

fn locate_binary(name: &str) -> Option<PathBuf> {
    which::which(name).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Office 抽取走启用插件的 `org.berth.extract`：占位符替换后运行 `install.bin`；
    /// 停用后返回说明而不是报错。Unix-only（fixture 是 sh 脚本）。
    #[cfg(unix)]
    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn office_extraction_uses_the_enabled_plugin() {
        use std::os::unix::fs::PermissionsExt;

        let home = tempfile::tempdir().unwrap();
        let package = home.path().join("tools/fixture");
        let bin = home.path().join("fixture-extract");
        std::fs::create_dir_all(&package).unwrap();
        std::fs::write(&bin, "#!/bin/sh\necho \"$1|$2\"\n").unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(
            package.join("tool.json"),
            serde_json::json!({
                "id": "fixture",
                "identity": { "name": "Fixture" },
                "extensions": {
                    "org.berth.extract": { "extensions": ["docx"], "argv": ["{file}", "{maxLines}"] },
                    "org.berth.install": { "bin": "berth-fixture-not-on-path", "paths": { "unix": [bin.to_string_lossy()] } }
                }
            })
            .to_string(),
        )
        .unwrap();
        let doc = home.path().join("a.docx");
        std::fs::write(&doc, b"x").unwrap();

        let lock = berth_tool_core::paths::TEST_ENV_LOCK.get_or_init(|| std::sync::Mutex::new(()));
        let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
        let previous = std::env::var_os("BERTH_HOME");
        std::env::set_var("BERTH_HOME", home.path());
        let (text, _, _) = extract_from_path(doc.to_str().unwrap(), "office").await;
        std::fs::write(
            home.path().join("plugins.json"),
            r#"{"version":1,"plugins":{"fixture":{"enabled":false}}}"#,
        )
        .unwrap();
        let (disabled, _, note) = extract_from_path(doc.to_str().unwrap(), "office").await;
        match previous {
            Some(value) => std::env::set_var("BERTH_HOME", value),
            None => std::env::remove_var("BERTH_HOME"),
        }

        assert_eq!(
            text.as_deref().map(str::trim),
            Some(format!("{}|{OFFICE_MAX_LINES}", doc.display()).as_str())
        );
        assert!(disabled.is_none());
        assert!(note.unwrap().contains("No enabled plugin"));
    }

    #[tokio::test]
    async fn stores_context_per_conversation_and_truncates_snapshots() {
        let store = CurrentDocumentContextStore::new();
        store
            .set(SetCurrentDocumentContextRequest {
                scope: DocumentContextScope::Conversation,
                conversation_id: 7,
                clear: false,
                kind: "text".into(),
                title: "notes.md".into(),
                path: Some("/tmp/notes.md".into()),
                url: None,
                mime: Some("text/markdown".into()),
                content: Some("x".repeat(MAX_CONTEXT_SNAPSHOT_CHARS + 10)),
                clear_content: false,
                revision: Some("dirty".into()),
                selection: Some(CurrentDocumentSelection {
                    text: "selected".into(),
                    location: Some("lines 2-3".into()),
                }),
                clear_selection: false,
            })
            .await;

        let result = store.get(7).await;
        assert!(result.found);
        assert!(result.content_truncated);
        assert_eq!(result.selected_text.as_deref(), Some("selected"));
        assert!(!store.get(8).await.found);

        store
            .set(SetCurrentDocumentContextRequest {
                scope: DocumentContextScope::Conversation,
                conversation_id: 7,
                clear: false,
                kind: "text".into(),
                title: "notes.md".into(),
                path: Some("/tmp/notes.md".into()),
                url: None,
                mime: Some("text/markdown".into()),
                content: Some("fresh snapshot".into()),
                clear_content: false,
                revision: Some("dirty".into()),
                selection: None,
                clear_selection: false,
            })
            .await;
        assert_eq!(
            store.get(7).await.selected_text.as_deref(),
            Some("selected")
        );

        store
            .set(SetCurrentDocumentContextRequest {
                scope: DocumentContextScope::Conversation,
                conversation_id: 7,
                clear: false,
                kind: "text".into(),
                title: "notes.md".into(),
                path: Some("/tmp/notes.md".into()),
                url: None,
                mime: Some("text/markdown".into()),
                content: None,
                clear_content: false,
                revision: Some("dirty".into()),
                selection: None,
                clear_selection: true,
            })
            .await;
        assert!(store.get(7).await.selected_text.is_none());

        store.clear(7).await;
        assert!(!store.get(7).await.found);
    }

    #[tokio::test]
    async fn workspace_buffer_is_independent_of_conversations_and_never_reads_disk() {
        let store = CurrentDocumentContextStore::new();
        store
            .set_workspace(
                "/definitely/missing/clean.txt".into(),
                "clean buffer".into(),
            )
            .await;
        let first = store
            .get_workspace(WorkspaceDocumentParams::default())
            .await
            .unwrap();
        assert_eq!(first.content, "clean buffer");
        assert_eq!(first.source_path, "/definitely/missing/clean.txt");
        assert!(!store.get(7).await.found);

        store
            .set_workspace("/definitely/missing/dirty.txt".into(), "unsaved\n界".into())
            .await;
        let second = store
            .get_workspace(WorkspaceDocumentParams {
                lines: Some(1),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(second.content, "界");
        assert!(second.revision > first.revision);
        assert!(second.truncated);

        let large = format!("begin\n{}\nlast", "界".repeat(180_000));
        store
            .set_workspace("/definitely/missing/large.txt".into(), large)
            .await;
        let clipped = store
            .get_workspace(WorkspaceDocumentParams::default())
            .await
            .unwrap();
        assert!(clipped.content.ends_with("last"));
        assert!(!clipped.content.contains("begin"));
        assert!(clipped.content.len() <= 8 * 1024);
        assert!(clipped.truncated);

        store
            .set_workspace("/definitely/missing/empty.txt".into(), String::new())
            .await;
        assert_eq!(
            store
                .get_workspace(WorkspaceDocumentParams::default())
                .await
                .unwrap()
                .content,
            ""
        );
        store.clear_workspace();
        assert!(matches!(
            store
                .get_workspace(WorkspaceDocumentParams::default())
                .await,
            Err(WorkspaceDocumentReadError::NotFound)
        ));
        store
            .set_workspace("/definitely/missing/restored.txt".into(), "restored".into())
            .await;
        let restored = store
            .get_workspace(WorkspaceDocumentParams::default())
            .await
            .unwrap();
        assert_eq!(restored.content, "restored");
        assert!(restored.revision > second.revision);
    }

    #[tokio::test]
    async fn workspace_range_reads_the_requested_lines_and_reports_continuation() {
        let store = CurrentDocumentContextStore::new();
        store
            .set_workspace(
                "/synthetic/range.txt".into(),
                "first\n第二\n\nlast\n".into(),
            )
            .await;
        let params = serde_json::from_value(serde_json::json!({ "offset": 1, "lines": 2 }))
            .expect("document range parameters");
        let first = store.get_workspace(params).await.unwrap();
        assert_eq!(first.content, "first\n第二\n");
        let value = serde_json::to_value(&first).unwrap();
        assert!(value["snapshot_ref"]
            .as_str()
            .is_some_and(|reference| !reference.is_empty()));
        assert_eq!(value["range"]["start_line"], 1);
        assert_eq!(value["range"]["end_line"], 2);
        assert_eq!(value["range"]["total_lines"], 4);
        assert_eq!(value["range"]["next_offset"], 3);
        assert_eq!(value["range"]["start_line_complete"], true);
        assert_eq!(value["range"]["end_line_complete"], true);
        let params = serde_json::from_value(serde_json::json!({
            "offset": 3, "lines": 2, "snapshot_ref": value["snapshot_ref"],
        }))
        .unwrap();
        let second = store.get_workspace(params).await.unwrap();
        assert_eq!(second.content, "\nlast\n");
        let second = serde_json::to_value(second).unwrap();
        assert_eq!(second["snapshot_ref"], value["snapshot_ref"]);
        assert!(second["range"]["next_offset"].is_null());
    }

    #[tokio::test]
    async fn workspace_snapshot_ref_is_scoped_to_the_store_and_every_commit() {
        let store = CurrentDocumentContextStore::new();
        store
            .set_workspace("/synthetic/a.txt".into(), "same".into())
            .await;
        let first = store
            .get_workspace(serde_json::from_value(serde_json::json!({})).unwrap())
            .await
            .unwrap();
        let first = serde_json::to_value(first).unwrap();
        let reference = first["snapshot_ref"]
            .as_str()
            .expect("first read returns a snapshot ref");
        let restarted = CurrentDocumentContextStore::new();
        restarted
            .set_workspace("/synthetic/a.txt".into(), "same".into())
            .await;
        let other = restarted
            .get_workspace(serde_json::from_value(serde_json::json!({})).unwrap())
            .await
            .unwrap();
        assert_ne!(
            serde_json::to_value(other).unwrap()["snapshot_ref"],
            reference
        );
        store
            .set_workspace("/synthetic/b.txt".into(), "other".into())
            .await;
        store
            .set_workspace("/synthetic/a.txt".into(), "same".into())
            .await;
        let restored = store
            .get_workspace(serde_json::from_value(serde_json::json!({})).unwrap())
            .await
            .unwrap();
        assert_ne!(
            serde_json::to_value(restored).unwrap()["snapshot_ref"],
            reference
        );
    }

    #[tokio::test]
    async fn workspace_snapshot_guard_rejects_edit_switch_clear_and_restart() {
        let store = CurrentDocumentContextStore::new();
        store
            .set_workspace("/synthetic/a.txt".into(), "one\ntwo\nthree".into())
            .await;
        let first = store
            .get_workspace(WorkspaceDocumentParams::default())
            .await
            .unwrap();
        let guarded = WorkspaceDocumentParams {
            offset: Some(2),
            lines: Some(1),
            snapshot_ref: first.snapshot_ref.clone(),
        };
        assert_eq!(
            store.get_workspace(guarded.clone()).await.unwrap().content,
            "two\n"
        );
        store
            .set_workspace("/synthetic/a.txt".into(), "one\nEDIT\nthree".into())
            .await;
        assert!(matches!(
            store.get_workspace(guarded.clone()).await,
            Err(WorkspaceDocumentReadError::StaleSnapshot)
        ));
        store
            .set_workspace("/synthetic/b.txt".into(), "one\ntwo\nthree".into())
            .await;
        assert!(matches!(
            store.get_workspace(guarded.clone()).await,
            Err(WorkspaceDocumentReadError::StaleSnapshot)
        ));
        store
            .set_workspace("/synthetic/a.txt".into(), "one\ntwo\nthree".into())
            .await;
        assert!(matches!(
            store.get_workspace(guarded.clone()).await,
            Err(WorkspaceDocumentReadError::StaleSnapshot)
        ));
        let current = store
            .get_workspace(WorkspaceDocumentParams::default())
            .await
            .unwrap();
        store.clear_workspace();
        assert!(matches!(
            store
                .get_workspace(WorkspaceDocumentParams {
                    snapshot_ref: current.snapshot_ref,
                    ..Default::default()
                })
                .await,
            Err(WorkspaceDocumentReadError::StaleSnapshot)
        ));
        let restarted = CurrentDocumentContextStore::new();
        restarted
            .set_workspace("/synthetic/a.txt".into(), "one\ntwo\nthree".into())
            .await;
        assert!(matches!(
            restarted.get_workspace(guarded).await,
            Err(WorkspaceDocumentReadError::StaleSnapshot)
        ));
    }

    #[tokio::test]
    async fn workspace_large_input_keeps_real_source_lines_and_rejects_lost_head() {
        let store = CurrentDocumentContextStore::new();
        let text: String = (1..=60_000)
            .map(|line| format!("source-{line:06}\n"))
            .collect();
        assert!(text.len() > MAX_CONTEXT_SNAPSHOT_CHARS);
        store
            .set_workspace("/synthetic/large.txt".into(), text)
            .await;
        let tail = store
            .get_workspace(WorkspaceDocumentParams {
                lines: Some(2),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(tail.content, "source-059999\nsource-060000\n");
        let range = tail.range.unwrap();
        assert_eq!(
            (range.start_line, range.end_line, range.total_lines),
            (59_999, 60_000, 60_000)
        );
        assert!(range.available_start_line > 1);
        let read_line = |offset| WorkspaceDocumentParams {
            offset: Some(offset),
            lines: Some(1),
            ..Default::default()
        };
        assert!(matches!(
            store.get_workspace(read_line(1)).await,
            Err(WorkspaceDocumentReadError::RangeUnavailable { requested: 1, .. })
        ));
        assert!(matches!(
            store.get_workspace(read_line(60_001)).await,
            Err(WorkspaceDocumentReadError::RangeUnavailable { .. })
        ));
        let available = range.available_start_line + 1;
        let content = store.get_workspace(read_line(available)).await.unwrap();
        assert_eq!(content.content, format!("source-{available:06}\n"));
        assert_eq!(content.range.unwrap().start_line, available);
        let state = store.workspace.read().unwrap();
        assert!(state.current.as_ref().unwrap().content.len() <= MAX_CONTEXT_SNAPSHOT_CHARS);
    }

    #[tokio::test]
    async fn workspace_partial_lines_never_invent_a_next_offset() {
        let store = CurrentDocumentContextStore::new();
        store
            .set_workspace(
                "/synthetic/long-line.txt".into(),
                format!("{}\nlast", "界".repeat(100_000)),
            )
            .await;
        for lines in [None, Some(1)] {
            let result = store
                .get_workspace(WorkspaceDocumentParams {
                    offset: Some(1),
                    lines,
                    ..Default::default()
                })
                .await
                .unwrap();
            assert!(result.truncated);
            assert!(result.content.is_char_boundary(result.content.len()));
            let range = result.range.unwrap();
            assert_eq!(
                (range.start_line, range.end_line, range.total_lines),
                (1, 1, 2)
            );
            assert!(range.start_line_complete);
            assert!(!range.end_line_complete);
            assert_eq!(range.next_offset, None);
        }
        store
            .set_workspace(
                "/synthetic/lost-partial.txt".into(),
                format!("{}\nlast", "界".repeat(200_000)),
            )
            .await;
        assert!(matches!(
            store
                .get_workspace(WorkspaceDocumentParams {
                    offset: Some(1),
                    ..Default::default()
                })
                .await,
            Err(WorkspaceDocumentReadError::RangeUnavailable {
                first_line_complete: false,
                ..
            })
        ));
        let second = store
            .get_workspace(WorkspaceDocumentParams {
                offset: Some(2),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(second.content, "last");
    }

    #[tokio::test]
    async fn workspace_empty_crlf_and_default_tail_remain_literal() {
        let store = CurrentDocumentContextStore::new();
        store
            .set_workspace("/synthetic/empty.txt".into(), String::new())
            .await;
        let empty = store
            .get_workspace(WorkspaceDocumentParams {
                offset: Some(1),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(empty.content, "");
        let range = empty.range.unwrap();
        assert_eq!(
            (range.start_line, range.end_line, range.total_lines),
            (1, 1, 1)
        );
        assert!(
            range.start_line_complete && range.end_line_complete && range.next_offset.is_none()
        );
        store
            .set_workspace(
                "/synthetic/lines.txt".into(),
                "first\r\n第二\r\n\r\n".into(),
            )
            .await;
        let lines = store
            .get_workspace(WorkspaceDocumentParams {
                offset: Some(2),
                lines: Some(1),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(lines.content, "第二\r\n");
        assert_eq!(lines.range.unwrap().next_offset, Some(3));
        let tail = store
            .get_workspace(WorkspaceDocumentParams {
                lines: Some(1),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(tail.content, "\r\n");
        assert_eq!(tail.range.unwrap().start_line, 3);
    }

    #[test]
    fn truncation_preserves_utf8() {
        let (text, truncated) = truncate_text("界".repeat(10), 5);
        assert!(truncated);
        assert!(text.is_char_boundary(text.len()));
    }

    #[tokio::test]
    async fn explicit_empty_snapshot_does_not_fall_back_to_disk() {
        let store = CurrentDocumentContextStore::new();
        store
            .set(SetCurrentDocumentContextRequest {
                scope: DocumentContextScope::Conversation,
                conversation_id: 9,
                clear: false,
                kind: "text".into(),
                title: "empty.txt".into(),
                path: Some("/definitely/missing/empty.txt".into()),
                url: None,
                mime: Some("text/plain".into()),
                content: Some(String::new()),
                clear_content: false,
                revision: Some("dirty".into()),
                selection: None,
                clear_selection: false,
            })
            .await;

        let result = store.get(9).await;
        assert!(result.found);
        assert_eq!(result.content.as_deref(), Some(""));
    }

    #[tokio::test]
    async fn explicit_snapshot_clear_does_not_reuse_previous_viewer_body() {
        let store = CurrentDocumentContextStore::new();
        let base = SetCurrentDocumentContextRequest {
            scope: DocumentContextScope::Conversation,
            conversation_id: 10,
            clear: false,
            kind: "text".into(),
            title: "notes.txt".into(),
            path: Some("/definitely/missing/notes.txt".into()),
            url: None,
            mime: Some("text/plain".into()),
            content: Some("old unsaved body".into()),
            clear_content: false,
            revision: Some("dirty".into()),
            selection: None,
            clear_selection: false,
        };
        store.set(base.clone()).await;
        assert_eq!(
            store.get(10).await.content.as_deref(),
            Some("old unsaved body")
        );

        store
            .set(SetCurrentDocumentContextRequest {
                content: None,
                clear_content: true,
                revision: Some("saved".into()),
                ..base
            })
            .await;

        assert!(store.get(10).await.content.is_none());
    }
}
