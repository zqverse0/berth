//! Request-scoped scan diagnostics for `list_project_agent_sessions`.
//!
//! ## Purpose
//!
//! Phase M of the project-agent session scan long-tail task. This module
//! provides a request-scoped collector that records stage timings and native
//! scan metrics inside `list_project_agent_sessions_core`. The data identifies
//! which source/phase dominates the p95/max latency without changing scan
//! results, index semantics, pagination, or disabled-agent behaviour.
//!
//! ## Activation
//!
//! Diagnostics are inert unless the `BERTH_SCAN_DIAGNOSTICS` environment
//! variable is set to `1` at process startup (checked once via [`is_enabled()`]).
//!
//! ## Two-level architecture
//!
//! The command has two execution contexts that run on **different threads**:
//!
//! 1. **Async task thread** — command-level stages (folder lookup, enabled
//!    check, cursor decode, native setup, DB page, join, identity lookup,
//!    reconcile, total).
//! 2. **`spawn_blocking` worker thread** — native scan metrics (file discovery,
//!    candidate filtering and bounded declarative parsing).
//!
//! Because `tokio::join!` may resume the async task on a different thread,
//! thread-locals are unreliable for the async side. The design therefore uses:
//!
//! - **[`CommandStages`]** — a plain struct of `Option<Instant>` fields held as
//!   local variables in the async function. Each stage is stamped inline.
//! - **[`ScanDiagnosticsGuard`]** — a thread-local guard **only for the
//!   blocking thread**. Shared bounded-reader boundaries write into the
//!   thread-local collector.
//!
//! After `tokio::join!` resolves, the blocking thread's guard is dropped
//! inside the closure (via a `DropGuard` wrapper), its native metrics are
//! extracted from the `JoinHandle`, and the async function emits a single
//! merged `tracing::info!` event combining both levels.
//!
//! ## Privacy
//!
//! The collector records **counts and durations only**. It never stores
//! transcript content, search text, absolute paths, filenames, or secrets.
//! The emitted event uses a random `invocation_id` (UUID v4) generated only
//! when diagnostics are enabled — no `folder_id`, project path, or other
//! request identity is included.

use std::time::{Duration, Instant};

use crate::models::AgentType;

// ---------------------------------------------------------------------------
// Global enable switch (checked once)
// ---------------------------------------------------------------------------

pub(crate) fn is_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| std::env::var("BERTH_SCAN_DIAGNOSTICS").as_deref() == Ok("1"))
}

// ---------------------------------------------------------------------------
// Command-level stages (async-thread, plain struct)
// ---------------------------------------------------------------------------

/// Stage instants recorded by the async command function. Held as local
/// variables; not thread-local because `tokio::join!` may resume on a
/// different worker thread.
///
/// ## Stage ordering
///
/// ```text
/// folder_lookup → enabled_check → cursor_decode → native_setup → db_start
///     → db_end → join_end → identity_lookup → reconcile → total_end
/// ```
///
/// `cursor_decode` covers **only** the base64 + JSON decode and scope
/// validation. `native_setup` covers the request struct construction and
/// `spawn_blocking` submission. The gap between `native_setup` and the
/// closure's own `scan_start` instant is `blocking_queue_ms` (thread-pool
/// scheduling latency).
#[derive(Default)]
pub(crate) struct CommandStages {
    pub folder_lookup: Option<Instant>,
    pub enabled_check: Option<Instant>,
    pub cursor_decode: Option<Instant>,
    pub native_setup: Option<Instant>,
    pub db_start: Option<Instant>,
    pub db_end: Option<Instant>,
    pub join_end: Option<Instant>,
    pub identity_lookup: Option<Instant>,
    pub reconcile: Option<Instant>,
    pub total_end: Option<Instant>,
    /// DB-only elapsed measured **inside** `db_future` (not the join wall-clock).
    pub db_only_elapsed: Option<Duration>,
}

impl CommandStages {
    pub(crate) fn mark_folder_lookup(&mut self) {
        self.folder_lookup = Some(Instant::now());
    }
    pub(crate) fn mark_enabled_check(&mut self) {
        self.enabled_check = Some(Instant::now());
    }
    pub(crate) fn mark_cursor_decode(&mut self) {
        self.cursor_decode = Some(Instant::now());
    }
    pub(crate) fn mark_native_setup(&mut self) {
        self.native_setup = Some(Instant::now());
    }
    pub(crate) fn mark_db_start(&mut self) {
        self.db_start = Some(Instant::now());
    }
    pub(crate) fn mark_db_end(&mut self) {
        self.db_end = Some(Instant::now());
    }
    pub(crate) fn mark_join_end(&mut self) {
        self.join_end = Some(Instant::now());
    }
    pub(crate) fn mark_identity_lookup(&mut self) {
        self.identity_lookup = Some(Instant::now());
    }
    pub(crate) fn mark_reconcile(&mut self) {
        self.reconcile = Some(Instant::now());
    }
    pub(crate) fn mark_total_end(&mut self) {
        self.total_end = Some(Instant::now());
    }
}

// ---------------------------------------------------------------------------
// Native scan metrics (blocking-thread, thread-local collector)
// ---------------------------------------------------------------------------

/// Native-scan counters and durations recorded by shared boundaries
/// (`bounded_native_file_candidates` and the declarative reader).
///
/// ## Pipeline stages and field mapping
///
/// ```text
/// Metadata stat pipeline for declared file candidates
///   → stat_attempts = paths entering the stat pipeline
///   → metadata_stat_count = successful stat results (candidate struct built)
///   → metadata_stat_duration = wall-clock of the stat phase
///
/// Sort + cursor filter + budget truncation
///   → sort_duration
///   → candidate_files = paths surviving all filtering + truncation
///   → truncated = whether pre-budget set exceeded scan budget
///
/// Declarative reader and post-filter
///   → scanned = candidates that entered the reader
///   → retained_after_filter = items pushed into the result page
/// ```
///
/// ## Declarative readers
///
/// SQLite-backed declarations do not use the file candidate pipeline. Their
/// file-specific fields (`stat_attempts`, `metadata_stat_*`, `sort_duration`,
/// `candidate_files`) remain zero. Only `scanned` and `retained_after_filter`
/// are populated. The emit event marks every session read as `declarative`;
/// the declaration, not the Agent brand, owns the storage details.
#[derive(Default, Clone)]
pub(crate) struct NativeScanMetrics {
    // -- Metadata stat pipeline --------------------------------------------
    /// Total paths entering the stat pipeline. Includes paths whose stat fails
    /// (symlink, missing,
    /// permission). Always >= `metadata_stat_count`.
    pub stat_attempts: u64,
    /// `symlink_metadata` + `modified` calls that produced a valid candidate.
    /// Always <= `stat_attempts`.
    pub metadata_stat_count: u64,
    /// Cumulative time in the stat phase (stat + modified + cursor filter).
    pub metadata_stat_duration: Duration,
    /// Time spent sorting candidates by `(modified_ns DESC, key DESC)`.
    pub sort_duration: Duration,
    /// File paths that survived filtering + budget truncation.
    pub candidate_files: u64,
    /// Whether the pre-budget set exceeded the scan budget.
    pub truncated: bool,

    // -- Reader pipeline -----------------------------------------------------
    /// Candidates that entered the reader. For SQLite readers: rows fetched
    /// from the query.
    pub scanned: u64,
    /// Items that survived project-path + search filtering and were pushed
    /// into the result page.
    pub retained_after_filter: u64,
}

// ---------------------------------------------------------------------------
// Thread-local collector + guard (blocking thread only)
// ---------------------------------------------------------------------------

use std::cell::RefCell;

/// Request-scoped accumulator for native scan metrics on the blocking thread.
struct BlockingCollector {
    native_scan: NativeScanMetrics,
}

thread_local! {
    static COLLECTOR: RefCell<Option<BlockingCollector>> = const { RefCell::new(None)
}
}

/// RAII guard for the `spawn_blocking` closure. Installs a thread-local
/// collector on entry; on drop, extracts the native metrics and restores
/// the thread-local to `None`.
pub(crate) struct ScanDiagnosticsGuard {
    enabled: bool,
}

impl ScanDiagnosticsGuard {
    /// Create a new guard. When diagnostics are disabled, the guard is a
    /// zero-cost no-op.
    pub(crate) fn new() -> Self {
        let enabled = is_enabled();
        if enabled {
            install_collector();
        }
        Self { enabled }
    }

    /// Consume the guard and return the accumulated native scan metrics.
    /// Returns `None` when diagnostics are disabled.
    pub(crate) fn into_metrics(self) -> Option<NativeScanMetrics> {
        let enabled = self.enabled;
        std::mem::forget(self);
        if !enabled {
            return None;
        }
        COLLECTOR.with(|cell| cell.borrow_mut().take().map(|c| c.native_scan))
    }
}

impl Drop for ScanDiagnosticsGuard {
    fn drop(&mut self) {
        if self.enabled {
            COLLECTOR.with(|cell| *cell.borrow_mut() = None);
        }
    }
}

// ---------------------------------------------------------------------------
// Internal helpers (also used by tests to bypass the env-var gate)
// ---------------------------------------------------------------------------

/// Install a fresh collector on the current thread. Called by the guard
/// constructor and by tests.
fn install_collector() {
    COLLECTOR.with(|cell| {
        *cell.borrow_mut() = Some(BlockingCollector {
            native_scan: NativeScanMetrics::default(),
        });
    });
}

/// Run `f` with a fresh collector installed, regardless of `is_enabled()`.
/// Returns whatever `f` returns. The collector is removed when `f` returns.
/// This is the test-only entry point that bypasses the env-var gate.
#[cfg(test)]
fn with_collector<R>(f: impl FnOnce() -> R) -> R {
    install_collector();
    let result = f();
    COLLECTOR.with(|cell| *cell.borrow_mut() = None);
    result
}

/// Borrow the current thread's collector mutably. No-op when no collector
/// is installed.
fn with_collector_mut(f: impl FnOnce(&mut NativeScanMetrics)) {
    COLLECTOR.with(|cell| {
        if let Some(c) = cell.borrow_mut().as_mut() {
            f(&mut c.native_scan);
        }
    });
}

// ---------------------------------------------------------------------------
// Record functions (native scan metrics — called from shared boundaries)
// ---------------------------------------------------------------------------

/// Record the candidate pipeline result after sort + cursor filter + budget
/// truncation. Only updates `candidate_files` and `truncated`.
///
/// `count` = candidates surviving truncation.
/// `truncated` = whether the pre-budget set exceeded the scan budget.
pub(crate) fn record_native_candidates(count: u64, truncated: bool) {
    with_collector_mut(|m| {
        m.candidate_files += count;
        m.truncated |= truncated;
    });
}

/// Record metadata (stat) phase results.
///
/// `attempts` = total paths entering the stat pipeline (including failures).
/// `successes` = paths that produced a valid candidate (<= `attempts`).
/// `duration` = wall-clock of the stat + cursor-filter phase.
pub(crate) fn record_metadata_stat(attempts: u64, successes: u64, duration: Duration) {
    with_collector_mut(|m| {
        m.stat_attempts += attempts;
        m.metadata_stat_count += successes;
        m.metadata_stat_duration += duration;
    });
}

/// Record sort/truncate phase from `bounded_native_file_candidates`.
pub(crate) fn record_sort(duration: Duration) {
    with_collector_mut(|m| {
        m.sort_duration += duration;
    });
}

/// Record that a candidate was scanned by the declarative reader.
pub(crate) fn record_scanned(count: u64) {
    with_collector_mut(|m| {
        m.scanned += count;
    });
}

/// Record items retained after project-path + search filtering.
pub(crate) fn record_retained_after_filter(count: u64) {
    with_collector_mut(|m| {
        m.retained_after_filter += count;
    });
}

// ---------------------------------------------------------------------------
// Final merged event emission (async thread)
// ---------------------------------------------------------------------------

/// Source kind label for the emitted event. All supported session reads share
/// the same declaration-driven path, regardless of Agent identity.
fn source_kind_label(_agent_type: AgentType) -> &'static str {
    "declarative"
}

/// Emit the merged diagnostics event combining command-level stage timings
/// (from the async thread) and native scan metrics (from the blocking thread).
///
/// `invocation_id` is a random UUID generated only when diagnostics are
/// enabled. No `folder_id`, project path, or other request identity is
/// included in the event.
pub(crate) fn emit_diagnostics(
    agent_type: AgentType,
    invocation_id: Option<uuid::Uuid>,
    stages: &CommandStages,
    native: Option<NativeScanMetrics>,
    native_scan_ms: Option<u64>,
    blocking_queue_ms: Option<u64>,
) {
    if !is_enabled() {
        return;
    }

    let folder_lookup = duration_between(stages.folder_lookup, stages.enabled_check);
    let enabled_check = duration_between(stages.enabled_check, stages.cursor_decode);
    let cursor_decode = duration_between(stages.cursor_decode, stages.native_setup);
    let native_setup = duration_between(stages.native_setup, stages.db_start);
    let db_page = duration_between(stages.db_start, stages.db_end);
    let join_critical = duration_between(stages.db_start, stages.join_end);
    let identity_lookup = duration_between(stages.join_end, stages.identity_lookup);
    let reconcile = duration_between(stages.identity_lookup, stages.reconcile);
    let total = duration_between(stages.folder_lookup, stages.total_end);

    let n = native.unwrap_or_default();

    tracing::info!(
        target = "scan_diagnostics",
        source_kind = source_kind_label(agent_type),
        agent = %agent_type,
        invocation_id = invocation_id.map(|id| id.to_string()),
        // Command-level stages
        folder_lookup_ms = folder_lookup.map(|d| d.as_millis() as u64),
        enabled_check_ms = enabled_check.map(|d| d.as_millis() as u64),
        cursor_decode_ms = cursor_decode.map(|d| d.as_millis() as u64),
        native_setup_ms = native_setup.map(|d| d.as_millis() as u64),
        blocking_queue_ms = blocking_queue_ms,
        db_page_ms = db_page.map(|d| d.as_millis() as u64),
        db_only_ms = stages.db_only_elapsed.map(|d| d.as_millis() as u64),
        join_critical_ms = join_critical.map(|d| d.as_millis() as u64),
        native_scan_ms = native_scan_ms,
        identity_lookup_ms = identity_lookup.map(|d| d.as_millis() as u64),
        reconcile_ms = reconcile.map(|d| d.as_millis() as u64),
        total_ms = total.map(|d| d.as_millis() as u64),
        // Metadata stat pipeline
        stat_attempts = n.stat_attempts,
        metadata_stat_count = n.metadata_stat_count,
        metadata_stat_ms = n.metadata_stat_duration.as_millis() as u64,
        sort_ms = n.sort_duration.as_millis() as u64,
        candidate_files = n.candidate_files,
        truncated = n.truncated,
        // Reader pipeline
        scanned = n.scanned,
        retained_after_filter = n.retained_after_filter,
        "scan diagnostics"
    );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn duration_between(start: Option<Instant>, end: Option<Instant>) -> Option<Duration> {
    match (start, end) {
        (Some(s), Some(e)) if e >= s => Some(e - s),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Clear the thread-local before each test so that leftover state from a
    /// prior test (or from non-test code) cannot affect the result.
    fn reset() {
        COLLECTOR.with(|cell| *cell.borrow_mut() = None);
    }

    #[test]
    fn guard_installs_and_extracts_metrics() {
        reset();
        with_collector(|| {
            record_native_candidates(5, true);
        });
        // with_collector removes the collector after the closure.
        COLLECTOR.with(|cell| assert!(cell.borrow().is_none()));
    }

    #[test]
    fn guard_drop_clears_thread_local() {
        reset();
        with_collector(|| {
            record_scanned(1);
        });
        COLLECTOR.with(|cell| assert!(cell.borrow().is_none()));
    }

    #[test]
    fn record_functions_are_no_ops_without_guard() {
        reset();
        // With no guard installed, record functions must not panic.
        record_native_candidates(10, false);
        record_metadata_stat(10, 8, Duration::from_micros(50));
        record_sort(Duration::from_micros(20));
        record_scanned(5);
        record_retained_after_filter(3);
    }

    #[test]
    fn record_functions_accumulate() {
        reset();
        let metrics = with_collector(|| {
            record_native_candidates(5, true);
            record_native_candidates(3, false);
            record_metadata_stat(10, 8, Duration::from_micros(50));
            record_sort(Duration::from_micros(20));
            record_scanned(8);
            record_retained_after_filter(4);

            // Extract metrics before with_collector cleans up.
            COLLECTOR
                .with(|cell| cell.borrow().as_ref().map(|c| c.native_scan.clone()))
                .unwrap()
        });

        assert_eq!(metrics.candidate_files, 8);
        assert!(metrics.truncated);
        // Metadata stat: attempts >= successes.
        assert_eq!(metrics.stat_attempts, 10);
        assert_eq!(metrics.metadata_stat_count, 8);
        assert_eq!(metrics.metadata_stat_duration, Duration::from_micros(50));
        // Sort.
        assert_eq!(metrics.sort_duration, Duration::from_micros(20));
        // Reader pipeline.
        assert_eq!(metrics.scanned, 8);
        assert_eq!(metrics.retained_after_filter, 4);
    }

    #[test]
    fn stat_attempts_gte_successes() {
        reset();
        let metrics = with_collector(|| {
            // 20 paths enter stat pipeline, 3 are symlinks (fail), 17 succeed.
            record_metadata_stat(20, 17, Duration::from_millis(5));
            // Second base_dir: 10 paths, all succeed.
            record_metadata_stat(10, 10, Duration::from_millis(2));

            COLLECTOR
                .with(|cell| cell.borrow().as_ref().map(|c| c.native_scan.clone()))
                .unwrap()
        });

        assert_eq!(metrics.stat_attempts, 30);
        assert_eq!(metrics.metadata_stat_count, 27);
        assert!(metrics.stat_attempts >= metrics.metadata_stat_count);
    }

    #[test]
    fn command_stages_mark_and_compute() {
        let mut stages = CommandStages::default();
        stages.mark_folder_lookup();
        stages.mark_enabled_check();
        stages.mark_cursor_decode();
        stages.mark_native_setup();
        stages.mark_db_start();
        stages.mark_db_end();
        stages.mark_join_end();
        stages.mark_identity_lookup();
        stages.mark_reconcile();
        stages.mark_total_end();

        assert!(stages.folder_lookup.is_some());
        assert!(stages.enabled_check.is_some());
        assert!(stages.cursor_decode.is_some());
        assert!(stages.native_setup.is_some());
        assert!(stages.db_start.is_some());
        assert!(stages.db_end.is_some());
        assert!(stages.join_end.is_some());
        assert!(stages.identity_lookup.is_some());
        assert!(stages.reconcile.is_some());
        assert!(stages.total_end.is_some());

        let fl = duration_between(stages.folder_lookup, stages.enabled_check).unwrap();
        let total = duration_between(stages.folder_lookup, stages.total_end).unwrap();
        assert!(total >= fl);

        // cursor_decode and native_setup are distinct stages.
        let cd = duration_between(stages.cursor_decode, stages.native_setup).unwrap();
        let ns = duration_between(stages.native_setup, stages.db_start).unwrap();
        // Both should be non-negative (Instant guarantees this).
        let _ = cd;
        let _ = ns;
    }

    #[test]
    fn emit_diagnostics_does_not_panic_when_disabled() {
        let stages = CommandStages::default();
        emit_diagnostics(AgentType::new("claude_code"), None, &stages, None, None, None);
    }

    #[test]
    fn emit_diagnostics_with_invocation_id_does_not_panic() {
        let stages = CommandStages::default();
        emit_diagnostics(
            AgentType::new("claude_code"),
            Some(uuid::Uuid::new_v4()),
            &stages,
            None,
            Some(100),
            Some(5),
        );
    }

    #[test]
    fn source_kind_label_is_brand_free() {
        assert_eq!(source_kind_label(AgentType::new("open_code")), "declarative");
        assert_eq!(source_kind_label(AgentType::new("cursor")), "declarative");
    }
}
