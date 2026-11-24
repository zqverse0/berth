//! The record ring: everything the bridge has seen go wrong, kept in memory
//! so it can be asked for after the fact.
//!
//! The bridge used to expose failures only as live WebSocket streams. That is
//! the wrong shape for the way agents actually work: drive the app, notice
//! something broke, *then* go looking. By the time you connect, the stream
//! has nothing to say, and the error that mattered is gone.
//!
//! So every event — JS console output, JS errors, Rust panics, and whatever
//! the host app pushes in through [`crate::record`] — lands in a bounded ring
//! first and is broadcast second. `GET /records` replays it; the WebSocket
//! endpoints still stream live for anyone watching.

use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

/// How many records to keep. Each is a few hundred bytes, so this is well
/// under a megabyte and deep enough to cover a whole debugging session.
const CAPACITY: usize = 1000;

/// Longest single message kept. A stack trace or a serialized blob can be
/// arbitrarily large, and one runaway message must not evict the ring.
const MAX_MESSAGE: usize = 16_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Debug,
    Log,
    Info,
    Warn,
    Error,
}

impl Level {
    /// Parse the level names that arrive from JS (`console.debug` and friends)
    /// and from host apps. Anything unrecognized is treated as `log` — an
    /// unknown level should never silently drop a record.
    pub fn parse(s: &str) -> Level {
        match s.trim().to_ascii_lowercase().as_str() {
            "debug" | "trace" => Level::Debug,
            "info" => Level::Info,
            "warn" | "warning" => Level::Warn,
            "error" | "fatal" | "panic" => Level::Error,
            _ => Level::Log,
        }
    }
}

/// One thing that happened. `origin` says which side of the bridge it came
/// from — `js` for the webview, `rust` for the host process — which is the
/// split the `console` and `logs` commands are built on.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Record {
    /// Milliseconds since the Unix epoch.
    pub ts: u128,
    pub level: Level,
    /// "js" | "rust"
    pub origin: &'static str,
    /// Short tag: "console", "error", "unhandledrejection", "panic", "app".
    pub kind: String,
    pub message: String,
    /// Webview label, for anything that came from a specific webview.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub webview: Option<String>,
    /// Stack trace or backtrace, when there is one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// Cap for the on-disk mirror. Small: it exists to survive a crash, not to
/// be an archive.
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;

struct Ring {
    records: std::collections::VecDeque<Record>,
    tx: broadcast::Sender<String>,
}

/// Where records are mirrored on disk. Set once at plugin setup.
static LOG_PATH: OnceLock<std::path::PathBuf> = OnceLock::new();

/// Mirror records to a file alongside the discovery file.
///
/// The ring alone loses everything the moment the process dies — which is
/// exactly when the records matter most. A panic in a synchronous Tauri
/// command unwinds across an Objective-C frame and aborts outright ("failed
/// to initiate panic"), taking the ring, the HTTP server, and any hope of
/// asking the app what happened with it. The file is still there afterwards.
pub fn set_log_path(path: std::path::PathBuf) {
    let _ = LOG_PATH.set(path);
}

/// The conventional path for an app's record file, given its bundle
/// identifier. The CLI computes the same path to read a dead app's records.
pub fn log_path_for(identifier: &str) -> std::path::PathBuf {
    std::path::Path::new(crate::DISCOVERY_DIR).join(format!("{identifier}.log"))
}

fn mirror_to_disk(json: &str) {
    let Some(path) = LOG_PATH.get() else {
        return;
    };
    let _ = (|| -> std::io::Result<()> {
        use std::io::Write as _;
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        if std::fs::metadata(path)
            .map(|m| m.len() > MAX_FILE_BYTES)
            .unwrap_or(false)
        {
            // One generation back is enough for a crash post-mortem.
            let _ = std::fs::rename(path, path.with_extension("log.1"));
        }
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)?;
        writeln!(f, "{json}")
    })();
}

static RING: OnceLock<Mutex<Ring>> = OnceLock::new();

fn ring() -> &'static Mutex<Ring> {
    RING.get_or_init(|| {
        let (tx, _) = broadcast::channel(256);
        Mutex::new(Ring {
            records: std::collections::VecDeque::with_capacity(CAPACITY),
            tx,
        })
    })
}

/// Subscribe to records as they arrive. Used by the streaming endpoints.
pub fn subscribe() -> broadcast::Receiver<String> {
    // A poisoned ring is recoverable here — the worst case is one lost
    // subscription, and panicking inside the debug bridge would be absurd.
    match ring().lock() {
        Ok(r) => r.tx.subscribe(),
        Err(poisoned) => poisoned.into_inner().tx.subscribe(),
    }
}

/// Store a record and broadcast it. Never panics: this is called from a panic
/// hook, among other places.
pub fn push(record: Record) {
    let json = match serde_json::to_string(&record) {
        Ok(json) => json,
        Err(_) => return,
    };
    let Ok(mut r) = ring().lock() else {
        return;
    };
    if r.records.len() == CAPACITY {
        r.records.pop_front();
    }
    r.records.push_back(record);
    let _ = r.tx.send(json.clone());
    // Held lock is fine: writes are small, appends are rare, and ordering on
    // disk matching ordering in the ring is worth more than the contention.
    mirror_to_disk(&json);
}

/// Build a record, clamping the message to something the ring can hold.
pub fn make(
    level: Level,
    origin: &'static str,
    kind: impl Into<String>,
    message: impl Into<String>,
) -> Record {
    Record {
        ts: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0),
        level,
        origin,
        kind: kind.into(),
        message: clamp(message.into()),
        webview: None,
        detail: None,
    }
}

fn clamp(s: String) -> String {
    if s.len() <= MAX_MESSAGE {
        return s;
    }
    // Cut on a char boundary — a message can be anything, including UTF-8 the
    // host app never inspected.
    let mut end = MAX_MESSAGE;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}… ({} bytes truncated)", &s[..end], s.len() - end)
}

/// Filter for `GET /records` and the CLI's history modes.
#[derive(Debug, Default, Deserialize)]
pub struct Query {
    /// Newest N records. Defaults to 100.
    pub limit: Option<usize>,
    /// Lowest level to include.
    pub level: Option<String>,
    /// "js" or "rust"; omitted means both.
    pub origin: Option<String>,
}

/// Records matching the query, oldest first — reading a log top to bottom is
/// how a sequence of failures makes sense.
pub fn recent(query: &Query) -> Vec<Record> {
    let min = query.level.as_deref().map(Level::parse);
    let origin = query
        .origin
        .as_deref()
        .map(|o| o.trim().to_ascii_lowercase());
    let limit = query.limit.unwrap_or(100).min(CAPACITY);

    let Ok(r) = ring().lock() else {
        return Vec::new();
    };
    let mut out: Vec<Record> = r
        .records
        .iter()
        .rev()
        .filter(|rec| min.is_none_or(|m| rec.level >= m))
        .filter(|rec| origin.as_deref().is_none_or(|o| rec.origin == o))
        .take(limit)
        .cloned()
        .collect();
    out.reverse();
    out
}

/// Drop the frames between the capture and the panic itself — this hook,
/// `catch_unwind`, and the panic runtime. They are identical every time and
/// they push the frame that actually failed off the top, which is the one
/// thing anyone reading a backtrace is looking for.
fn trim_backtrace(raw: &str) -> String {
    let lines: Vec<&str> = raw.lines().collect();
    let start = lines
        .iter()
        .rposition(|l| l.contains("rust_begin_unwind") || l.contains("panic_fmt"))
        .map(|i| i + 1)
        .unwrap_or(0);
    let trimmed = lines[start..].join("\n");
    // An unhelpful backtrace beats a missing one when the shape surprises us.
    if trimmed.trim().is_empty() {
        raw.to_string()
    } else {
        trimmed
    }
}

/// Install the panic hook. Called once when the plugin initializes, so any
/// app that adds the bridge gets Rust panics captured without writing a line
/// of code — the panic is recorded with its location and backtrace, and the
/// previous hook still runs, so nothing an app already does is lost.
pub fn install_panic_hook() {
    static INSTALLED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if INSTALLED.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        // A panic inside a panic hook aborts the process. Nothing below
        // should panic, but a debugging tool must not be the reason an app
        // dies harder than it would have.
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let payload = info.payload();
            let message = payload
                .downcast_ref::<&str>()
                .map(|s| (*s).to_string())
                .or_else(|| payload.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "panic with a non-string payload".to_string());
            let location = info
                .location()
                .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
                .unwrap_or_else(|| "unknown location".to_string());
            let thread = std::thread::current()
                .name()
                .unwrap_or("unnamed")
                .to_string();
            let mut rec = make(
                Level::Error,
                "rust",
                "panic",
                format!("{message} (at {location}, thread {thread})"),
            );
            rec.detail = Some(clamp(trim_backtrace(
                &std::backtrace::Backtrace::force_capture().to_string(),
            )));
            push(rec);
        }));
        previous(info);
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn levels_order_by_severity() {
        assert!(Level::Error > Level::Warn);
        assert!(Level::Warn > Level::Info);
        assert_eq!(Level::parse("WARNING"), Level::Warn);
        assert_eq!(Level::parse("panic"), Level::Error);
        assert_eq!(Level::parse("nonsense"), Level::Log);
    }

    #[test]
    fn clamp_cuts_on_a_char_boundary() {
        let long = "é".repeat(MAX_MESSAGE);
        let cut = clamp(long);
        assert!(cut.ends_with("bytes truncated)"));
        // The point of the boundary walk: this must not panic or produce
        // invalid UTF-8.
        assert!(cut.chars().count() > 0);
    }

    #[test]
    fn clamp_leaves_short_messages_alone() {
        assert_eq!(clamp("hi".into()), "hi");
    }

    #[test]
    fn backtrace_trim_starts_at_the_frame_that_failed() {
        let raw = [
            "   0: <std::backtrace::Backtrace>::create",
            "   1: tauri_plugin_debug_bridge::record::install_panic_hook",
            "   2: __rustc::rust_begin_unwind",
            "   3: core::panicking::panic_fmt",
            "   4: my_app::the_guilty_one",
        ]
        .join("\n");
        assert!(trim_backtrace(&raw).starts_with("   4: my_app::the_guilty_one"));
        // An unfamiliar shape comes back whole rather than empty.
        assert_eq!(trim_backtrace("   0: mystery"), "   0: mystery");
    }

    #[test]
    fn the_ring_replays_newest_within_the_filter() {
        push(make(Level::Info, "js", "console", "quiet"));
        push(make(Level::Error, "js", "error", "loud"));
        push(make(Level::Error, "rust", "panic", "backend"));

        let errors = recent(&Query {
            limit: Some(10),
            level: Some("error".into()),
            origin: None,
        });
        assert!(errors.iter().all(|r| r.level == Level::Error));
        assert!(errors.iter().any(|r| r.message == "loud"));

        let rust_only = recent(&Query {
            limit: Some(10),
            level: None,
            origin: Some("rust".into()),
        });
        assert!(rust_only.iter().all(|r| r.origin == "rust"));

        // Oldest first: a log reads top to bottom.
        let all = recent(&Query {
            limit: Some(3),
            level: None,
            origin: None,
        });
        assert!(all.windows(2).all(|w| w[0].ts <= w[1].ts));
    }
}
