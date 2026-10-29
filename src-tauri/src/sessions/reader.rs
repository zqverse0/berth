use std::path::{Path, PathBuf};

use super::declarative;
use crate::models::agent::AgentType;

/// Return the Agent identities whose Tool Assets currently declare a session
/// resource.  Session consumers must use this discovery result instead of
/// maintaining a second fixed Agent list.
pub(crate) fn declared_session_agent_types() -> Vec<AgentType> {
    declarative::declared_agent_types()
}

/// Resolve the filesystem root declared for an Agent's sessions, plus whether
/// that root is a file (rather than a directory).
///
/// Used by `list_conversations_sync` to skip agents whose session store is
/// absent — an existence short-circuit that avoids paying filesystem scan cost
/// for agents the user has not installed.
///
/// This probe is intentionally read-path only and its result is never
/// relied on from storage: which Agents can be browsed is resolved from the
/// declaration plus this probe on every read
/// (`agent_setting_service::enabled_conversation_agent_types`), so Agents
/// installed or declared later show up without any setting.
///
/// Returns `None` when the root cannot be determined (for example, no home
/// directory). This is not an I/O probe failure and is treated as undetected;
/// actual `try_exists`/metadata errors remain conservatively enabled.
/// There is deliberately no built-in or Agent-specific fallback.  A missing
/// declaration means that the Agent has no session reader and therefore no
/// session filesystem is touched.
pub fn agent_session_root(agent: AgentType) -> Option<(PathBuf, bool)> {
    declarative::declared_root(agent)
}

/// Check whether an agent's session root exists on disk.
///
/// - `Ok(true)` ⇒ the path exists; the parser should be constructed and scanned.
/// - `Ok(false)` ⇒ the path does not exist; the parser can be skipped.
/// - `Err(_)` ⇒ the probe itself failed (permission denied, broken symlink,
///   network mount timeout). Per design §2.1 constraint 2, callers MUST treat
///   this as "exists" to avoid silently hiding an installed agent.
pub fn agent_session_exists(agent: AgentType) -> bool {
    match agent_session_root(agent) {
        Some((path, is_file)) => session_root_matches(&path, is_file),
        None => false, // no resolvable root ⇒ agent is not detected
    }
}

fn session_root_matches(path: &Path, is_file: bool) -> bool {
    match path.try_exists() {
        Ok(false) => false,
        Err(_) => true,
        Ok(true) => match path.metadata() {
            Ok(metadata) => {
                if is_file {
                    metadata.is_file()
                } else {
                    metadata.is_dir()
                }
            }
            Err(_) => true,
        },
    }
}

#[cfg(test)]
fn conservative_probe_result(result: std::io::Result<bool>) -> bool {
    result.unwrap_or(true) // probe failed ⇒ conservative: treat as installed
}

#[cfg(test)]
mod session_root_tests {
    use super::{conservative_probe_result, session_root_matches};

    #[test]
    fn failed_session_root_probe_is_treated_as_existing() {
        let error = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "denied");
        assert!(conservative_probe_result(Err(error)));
    }

    #[test]
    fn successful_session_root_probe_preserves_result() {
        assert!(conservative_probe_result(Ok(true)));
        assert!(!conservative_probe_result(Ok(false)));
    }

    #[test]
    fn session_root_probe_honors_file_vs_directory_shape() {
        let temp = tempfile::tempdir().expect("tempdir");
        let file = temp.path().join("sessions.db");
        std::fs::write(&file, b"").expect("write file");

        assert!(session_root_matches(temp.path(), false));
        assert!(!session_root_matches(temp.path(), true));
        assert!(session_root_matches(&file, true));
        assert!(!session_root_matches(&file, false));
        assert!(!session_root_matches(&temp.path().join("missing"), false));
    }
}

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::models::{
    ConversationDetail, ConversationSummary, MessageTurn, SessionStats, TurnUsage,
};

#[derive(Debug, thiserror::Error)]
pub enum ParseError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON parse error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("Database error: {0}")]
    Db(#[from] sea_orm::DbErr),
    #[error("Conversation not found: {0}")]
    ConversationNotFound(String),
    #[error("Invalid data: {0}")]
    InvalidData(String),
}

#[derive(Debug, Clone)]
pub struct NativeConversationPageRequest {
    pub project_path: String,
    pub cursor: Option<String>,
    pub limit: usize,
    pub scan_budget: usize,
    pub search: Option<String>,
}

#[derive(Debug, Clone)]
pub struct NativeConversationPage {
    pub items: Vec<ConversationSummary>,
    pub next_cursor: Option<String>,
    pub scan_complete: bool,
}

pub(crate) fn encode_native_page_cursor<T: Serialize>(value: &T) -> Result<String, ParseError> {
    let bytes = serde_json::to_vec(value).map_err(|error| {
        ParseError::InvalidData(format!("failed to encode page cursor: {error}"))
    })?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

pub(crate) fn decode_native_page_cursor<T: DeserializeOwned>(
    encoded: &str,
) -> Result<T, ParseError> {
    let bytes = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| ParseError::InvalidData("invalid page cursor".into()))?;
    serde_json::from_slice(&bytes)
        .map_err(|_| ParseError::InvalidData("invalid page cursor".into()))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize)]
pub(crate) struct NativeFilePageCursor {
    pub modified_ns: u64,
    pub key: String,
}

#[derive(Debug, Clone)]
pub(crate) struct NativeFileCandidate {
    pub path: PathBuf,
    pub cursor: NativeFilePageCursor,
}

pub(crate) fn native_file_candidate(path: PathBuf) -> Option<NativeFileCandidate> {
    let metadata = std::fs::symlink_metadata(&path).ok()?;
    if metadata.file_type().is_symlink() {
        return None;
    }
    let modified_ns = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| u64::try_from(duration.as_nanos()).unwrap_or(u64::MAX))
        .unwrap_or(0);
    let key = path.to_string_lossy().into_owned();
    Some(NativeFileCandidate {
        path,
        cursor: NativeFilePageCursor { modified_ns, key },
    })
}

pub(crate) fn bounded_native_file_candidates(
    paths: impl IntoIterator<Item = PathBuf>,
    after: Option<&NativeFilePageCursor>,
    scan_budget: usize,
) -> (Vec<NativeFileCandidate>, bool) {
    // Phase 1: metadata stat — `native_file_candidate` does `symlink_metadata`
    // + `modified` per path. Time the entire filter_map + cursor filter.
    // Count ALL paths entering the pipeline as `stat_attempts` (including
    // those whose stat fails — symlinks, missing files, etc.).
    let stat_start = std::time::Instant::now();
    let all_paths: Vec<PathBuf> = paths.into_iter().collect();
    let stat_attempts = all_paths.len() as u64;
    let mut candidates: Vec<_> = all_paths
        .into_iter()
        .filter_map(native_file_candidate)
        .filter(|candidate| {
            after.is_none_or(|cursor| {
                (candidate.cursor.modified_ns, candidate.cursor.key.as_str())
                    < (cursor.modified_ns, cursor.key.as_str())
            })
        })
        .collect();
    let stat_elapsed = stat_start.elapsed();
    let stat_successes = candidates.len() as u64;
    crate::sessions::scan_diagnostics::record_metadata_stat(stat_attempts, stat_successes, stat_elapsed);

    // Phase 2: sort by (modified_ns DESC, key DESC).
    let sort_start = std::time::Instant::now();
    candidates.sort_by(|left, right| {
        (right.cursor.modified_ns, right.cursor.key.as_str())
            .cmp(&(left.cursor.modified_ns, left.cursor.key.as_str()))
    });
    let sort_elapsed = sort_start.elapsed();
    crate::sessions::scan_diagnostics::record_sort(sort_elapsed);

    // Phase 3: budget truncation.
    let budget = scan_budget.max(1);
    let has_more = candidates.len() > budget;
    candidates.truncate(budget);
    let kept = candidates.len() as u64;
    crate::sessions::scan_diagnostics::record_native_candidates(kept, has_more);
    (candidates, has_more)
}

pub(crate) fn native_page_matches_search(
    summary: &ConversationSummary,
    search: Option<&str>,
) -> bool {
    let Some(query) = search.map(str::trim).filter(|query| !query.is_empty()) else {
        return true;
    };
    let query = query.to_lowercase();
    [
        summary.title.as_deref(),
        summary.model.as_deref(),
        summary.git_branch.as_deref(),
    ]
    .into_iter()
    .flatten()
    .any(|value| value.to_lowercase().contains(&query))
}

pub trait AgentParser {
    fn list_conversations(&self) -> Result<Vec<ConversationSummary>, ParseError>;

    /// Bounded project history page. Providers must override this before they
    /// are exposed by the project Agent browser. The default is an explicit
    /// unsupported error — never a fallback to full `list_conversations()`.
    fn list_conversation_page(
        &self,
        _request: &NativeConversationPageRequest,
    ) -> Result<NativeConversationPage, ParseError> {
        Err(ParseError::InvalidData(
            "bounded project history is not supported for this Agent".into(),
        ))
    }

    fn get_conversation(&self, conversation_id: &str) -> Result<ConversationDetail, ParseError>;

    /// Read only the metadata needed to resolve a native session into the
    /// project database.  Implementations can override this to avoid parsing
    /// transcript turns before the user opens the session.
    fn get_conversation_summary(
        &self,
        conversation_id: &str,
    ) -> Result<ConversationSummary, ParseError> {
        Ok(self.get_conversation(conversation_id)?.summary)
    }
}

/// Truncate a string to `max_len` characters, appending "..." if truncated.
pub fn truncate_str(s: &str, max_len: usize) -> String {
    if s.chars().count() <= max_len {
        s.to_string()
    } else {
        let truncated: String = s.chars().take(max_len).collect();
        format!("{}...", truncated)
    }
}

/// Punctuation the serializer escapes with a leading backslash inside a
/// reference label (mirrors `escapeMarkdownText` in `src/lib/reference-text.ts`
/// and the class in the frontend `unescapeReferenceLabel`).
fn is_escapable_reference_punct(c: char) -> bool {
    matches!(
        c,
        '\\' | '`' | '*' | '_' | '~' | '[' | ']' | '(' | ')' | '<' | '>'
    )
}

/// Reverse the serializer's label escaping: drop the backslash from each escaped
/// inline-significant punctuation char so the recovered label reads literally.
/// Mirrors the frontend `unescapeReferenceLabel`.
fn unescape_reference_label(label: &[char]) -> String {
    let mut out = String::with_capacity(label.len());
    let mut i = 0;
    while i < label.len() {
        if label[i] == '\\' && i + 1 < label.len() && is_escapable_reference_punct(label[i + 1]) {
            out.push(label[i + 1]);
            i += 2;
        } else {
            out.push(label[i]);
            i += 1;
        }
    }
    out
}

/// Mirror ECMAScript's `/\s/` — the whitespace class the frontend
/// `foldReferenceLinks` (`src/lib/reference-link.ts`) scans destinations with —
/// so this port stays in step with it. It deliberately differs from Rust's
/// `char::is_whitespace()` in exactly two code points: `U+FEFF` (BOM) is
/// whitespace to JS but not to Rust, and `U+0085` (NEL) is whitespace to Rust
/// but not to JS. The set is ECMAScript WhiteSpace + LineTerminator.
fn is_markdown_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{0009}'..='\u{000D}'      // tab, LF, VT, FF, CR
            | '\u{0020}'             // space
            | '\u{00A0}'             // no-break space
            | '\u{1680}'
            | '\u{2000}'..='\u{200A}'
            | '\u{2028}'             // line separator
            | '\u{2029}'             // paragraph separator
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
            | '\u{FEFF}'             // zero-width no-break space (BOM)
    )
}

/// Whether the backslash at `k` escapes the next character. CommonMark never
/// lets a backslash escape whitespace, so `\` + whitespace ENDS (not extends) a
/// label/destination scan — only `\` + a non-whitespace char is a real escape.
fn reference_escapes_next(chars: &[char], k: usize) -> bool {
    chars.get(k) == Some(&'\\')
        && chars
            .get(k + 1)
            .is_some_and(|c| !is_markdown_whitespace(*c))
}

/// If a well-formed `(destination)` begins at `start`, return the index just
/// past its closing `)`; otherwise `None`. Mirrors the frontend `destinationEnd`
/// and the serializer's two forms: a `<…>`-wrapped destination (interior `\`,
/// `<`, `>` backslash-escaped) or a bare run with no `(`, `)`, whitespace, `<` or
/// `>`.
fn reference_destination_end(chars: &[char], start: usize) -> Option<usize> {
    let n = chars.len();
    if start >= n || chars[start] != '(' {
        return None;
    }
    let mut k = start + 1;
    if chars.get(k) == Some(&'<') {
        k += 1;
        while k < n {
            if reference_escapes_next(chars, k) {
                k += 2;
                continue;
            }
            match chars[k] {
                '>' => {
                    return if chars.get(k + 1) == Some(&')') {
                        Some(k + 2)
                    } else {
                        None
                    };
                }
                // An unescaped `<` or a line break is forbidden inside `<…>`;
                // bailing here also bounds the scan so a missing `>` stops at the
                // next `<` instead of running to EOF (keeps adversarial input
                // linear).
                '<' | '\n' | '\r' => return None,
                _ => k += 1,
            }
        }
        return None;
    }
    while k < n {
        if reference_escapes_next(chars, k) {
            k += 2;
            continue;
        }
        let c = chars[k];
        if c == ')' {
            return Some(k + 1);
        }
        if c == '(' || c == '<' || c == '>' || is_markdown_whitespace(c) {
            return None;
        }
        k += 1;
    }
    None
}

/// Replace every inline `[label](destination)` reference link in `text` with its
/// unescaped `label`, leaving all other prose (including malformed `[…]`/`(…)`
/// fragments and invocation tokens like `@Codex`) untouched.
///
/// This is the Rust counterpart of the frontend canonical fold
/// (`foldReferenceLinks` in `src/lib/reference-link.ts`) and MUST stay in step
/// with it: a single O(n) left-to-right scan over a stack of unmatched `[`
/// positions, matching each `]` against the most recent opener so a balanced
/// nested label closes at the right bracket, requiring a non-empty label and a
/// well-formed `(dest)` for a link, and recovering later links after a
/// stray/unbalanced `[`. Used to derive conversation titles from a user's first
/// message: folding BEFORE truncation means a long `file://` destination can
/// never be sliced mid-link into an unterminable `[label](file://…` fragment.
pub fn fold_reference_links(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let n = chars.len();
    let mut out = String::with_capacity(text.len());
    // Start of the pending prose run; flushed before each link and at the end.
    let mut text_start = 0usize;
    // Indices of `[` seen but not yet matched by a `]` (most recent on top).
    let mut openers: Vec<usize> = Vec::new();
    let mut i = 0usize;

    while i < n {
        if reference_escapes_next(&chars, i) {
            // `\[` / `\]` (and any `\x`) is literal — skip both chars.
            i += 2;
            continue;
        }
        match chars[i] {
            '[' => {
                openers.push(i);
                i += 1;
            }
            ']' if !openers.is_empty() => {
                let open = openers.pop().expect("openers is non-empty");
                match reference_destination_end(&chars, i + 1) {
                    // A link needs a well-formed `(dest)` right after `]` and a
                    // non-empty label between the brackets.
                    Some(end) if i > open + 1 => {
                        out.extend(chars[text_start..open].iter());
                        out.push_str(&unescape_reference_label(&chars[open + 1..i]));
                        // Everything up to `open` is committed, so any still-open
                        // outer `[` can no longer span a link.
                        openers.clear();
                        i = end;
                        text_start = end;
                    }
                    // Not a link: keep the brackets in the pending prose run and
                    // keep scanning so a later valid link is still found.
                    _ => i += 1,
                }
            }
            _ => i += 1,
        }
    }
    out.extend(chars[text_start..n].iter());
    out
}

/// Derive a conversation title from a user's first message: take its headline
/// (skipping wrapper lines such as group delivery headers, shared with the CLI
/// and the Sessions view), fold inline reference links to their labels, then cap
/// the length. Folding first ensures a `[name](file://<long path>)` mention
/// becomes `name` instead of a raw — and, once truncated, unterminable — Markdown link.
pub fn title_from_user_text(text: &str) -> String {
    let line = berth_tool_core::session_files::headline_line(text).unwrap_or(text);
    truncate_str(&fold_reference_links(line), 100)
}

/// Aggregate turn-level usage and duration into a single `SessionStats`.
pub fn compute_session_stats(turns: &[MessageTurn]) -> Option<SessionStats> {
    let mut total_in = 0u64;
    let mut total_out = 0u64;
    let mut total_cache_create = 0u64;
    let mut total_cache_read = 0u64;
    let mut total_duration = 0u64;
    let mut has_data = false;

    for turn in turns {
        if let Some(ref u) = turn.usage {
            total_in += u.input_tokens;
            total_out += u.output_tokens;
            total_cache_create += u.cache_creation_input_tokens;
            total_cache_read += u.cache_read_input_tokens;
            has_data = true;
        }
        if let Some(d) = turn.duration_ms {
            total_duration += d;
        }
    }

    if !has_data {
        return None;
    }

    Some(SessionStats {
        total_usage: Some(TurnUsage {
            input_tokens: total_in,
            output_tokens: total_out,
            cache_creation_input_tokens: total_cache_create,
            cache_read_input_tokens: total_cache_read,
        }),
        total_tokens: Some(total_in + total_out + total_cache_create + total_cache_read),
        total_duration_ms: total_duration,
        context_window_used_tokens: None,
        context_window_max_tokens: None,
        context_window_usage_percent: None,
    })
}


/// Extract the last path component as the folder name.
pub fn folder_name_from_path(path: &str) -> String {
    path.rsplit(['/', '\\']).next().unwrap_or(path).to_string()
}

/// Normalize a filesystem path string for tolerant cross-platform comparison.
/// This intentionally does not hit the filesystem (no canonicalize), and only
/// normalizes separators/casing differences that commonly break exact matching.
pub fn normalize_path_for_matching(path: &str) -> String {
    let mut normalized = path.trim().replace('\\', "/");

    #[cfg(target_os = "windows")]
    {
        if let Some(stripped) = normalized.strip_prefix("//?/") {
            normalized = stripped.to_string();
        }
        normalized = normalized.to_ascii_lowercase();
    }

    while normalized.ends_with('/') {
        if normalized == "/" {
            break;
        }
        // Keep Windows drive root such as "c:/" intact.
        if normalized.len() == 3
            && normalized.as_bytes().get(1) == Some(&b':')
            && normalized.as_bytes().get(2) == Some(&b'/')
        {
            break;
        }
        normalized.pop();
    }

    normalized
}

pub fn path_eq_for_matching(left: &str, right: &str) -> bool {
    normalize_path_for_matching(left) == normalize_path_for_matching(right)
}

#[cfg(test)]
mod tests {
    use super::{fold_reference_links, path_eq_for_matching, title_from_user_text};

    #[test]
    fn fold_reference_links_reduces_links_to_labels() {
        // Plain prose is untouched.
        assert_eq!(fold_reference_links("hello world"), "hello world");
        // A file link folds to its label; surrounding text is preserved.
        assert_eq!(
            fold_reference_links("看看 [README.md](file:///Users/x/README.md) 这是什么"),
            "看看 README.md 这是什么"
        );
        // berth:// links fold too; an agent mention keeps its `@`.
        assert_eq!(
            fold_reference_links("调用 [@Codex CLI](berth://agent/codex) 执行"),
            "调用 @Codex CLI 执行"
        );
        // Multiple links in one string.
        assert_eq!(
            fold_reference_links("compare [a.ts](file:///a.ts) and [b.ts](file:///b.ts)"),
            "compare a.ts and b.ts"
        );
    }

    #[test]
    fn fold_reference_links_handles_escapes_and_angle_destinations() {
        // A `<…>`-wrapped destination (spaces/parens in the path) still folds.
        assert_eq!(
            fold_reference_links("[report (1).pdf](<file:///tmp/report (1).pdf>)"),
            "report (1).pdf"
        );
        // Escaped punctuation in the label is unescaped.
        assert_eq!(fold_reference_links("[a\\]b\\(c](file:///x)"), "a]b(c");
        // A balanced nested-bracket label closes at the outer `]`.
        assert_eq!(fold_reference_links("[a [b]](https://x)"), "a [b]");
        // A later link is recovered after a stray/unbalanced `[`.
        assert_eq!(fold_reference_links("[a [b](url)"), "[a b");
    }

    #[test]
    fn fold_reference_links_matches_js_whitespace_class() {
        // Parity with the frontend `foldReferenceLinks`, whose destination scan
        // uses ECMAScript `/\s/` rather than Rust's `char::is_whitespace()`. The
        // two classes differ on exactly these code points (verified against the
        // TS module): U+FEFF (BOM) and U+00A0 (NBSP) ARE JS whitespace, so a bare
        // destination containing them is malformed and the text stays raw…
        assert_eq!(
            fold_reference_links("[a](foo\u{FEFF}bar)"),
            "[a](foo\u{FEFF}bar)"
        );
        assert_eq!(
            fold_reference_links("[a](foo\u{00A0}bar)"),
            "[a](foo\u{00A0}bar)"
        );
        // …while U+0085 (NEL) is NOT JS whitespace, so it is an ordinary
        // destination char and the link folds (Rust's is_whitespace would have
        // wrongly rejected it).
        assert_eq!(fold_reference_links("[a](foo\u{0085}bar)"), "a");
    }

    #[test]
    fn fold_reference_links_leaves_malformed_fragments_raw() {
        // An unterminated link (no closing `)`) is left verbatim — exactly the
        // truncated-title shape this fix keeps from ever being stored.
        assert_eq!(
            fold_reference_links("[oops no close](file:///x"),
            "[oops no close](file:///x"
        );
        // An empty-label `[](x)` is not a link.
        assert_eq!(fold_reference_links("[](x)"), "[](x)");
        // A bare destination with an unescaped space is malformed.
        assert_eq!(fold_reference_links("[a](foo bar)"), "[a](foo bar)");
    }

    #[test]
    fn title_from_user_text_folds_before_truncating() {
        // The regression: a long percent-encoded file mention used to be
        // truncated mid-destination into an unterminable `[label](file://…`
        // fragment. Folding first yields the short, clean filename.
        let long_path = "%E5%85%A8".repeat(40); // > 100 chars when raw
        let raw = format!("[全天候运维.xlsx](file:///Users/xggz/Desktop/{long_path}.xlsx)");
        assert!(raw.chars().count() > 100, "fixture must exceed the cap");
        assert_eq!(title_from_user_text(&raw), "全天候运维.xlsx");
    }

    #[test]
    fn title_from_user_text_skips_wrapper_lines() {
        assert_eq!(
            title_from_user_text("[berth 频道 main · 来自 user]\n\n修一下标题"),
            "修一下标题"
        );
        assert_eq!(title_from_user_text("<user_info>\nOS: linux"), "OS: linux");
    }

    #[test]
    fn title_from_user_text_still_caps_plain_prose() {
        let long = "x".repeat(250);
        let title = title_from_user_text(&long);
        assert_eq!(title.chars().count(), 103); // 100 + "..."
        assert!(title.ends_with("..."));
    }

    #[test]
    fn path_matching_handles_separator_differences() {
        assert!(path_eq_for_matching(
            "/Users/demo/workspace/codeg",
            "/Users/demo/workspace/codeg/"
        ));
        assert!(path_eq_for_matching(
            "C:\\Users\\demo\\workspace\\codeg",
            "C:/Users/demo/workspace/codeg"
        ));
    }
}
