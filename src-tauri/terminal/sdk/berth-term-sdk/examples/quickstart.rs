//! Quickstart example: connect through the [`Terminal`] facade, ensure a session,
//! and capture the first pane snapshot.
//!
//! This example is compile-tested by `cargo build --workspace --examples`
//! and `cargo clippy --workspace --all-targets --locked`. It documents
//! the primary daemon-backed public surface.
//!
//! The example uses only types re-exported from `berth_term_sdk` and does not
//! depend on `berth-cli`, `berth-term-engine`, `berth-term-server`, or `berth-term-pty`.

use std::time::Duration;

use berth_term_sdk::{EnsureSession, EnsureSessionPolicy, SessionName, Terminal, TerminalSizeSpec};

#[tokio::main]
async fn main() -> berth_term_sdk::Result<()> {
    let terminal = Terminal::builder()
        .default_timeout(Duration::from_secs(5))
        .connect_or_start()
        .await?;
    assert_eq!(
        terminal.configured_default_timeout(),
        Some(Duration::from_secs(5))
    );

    let session_name = SessionName::new("quickstart").expect("valid session name");
    let session = terminal
        .ensure_session(
            EnsureSession::named(session_name.clone())
                .policy(EnsureSessionPolicy::CreateOrReuse)
                .detached(true)
                .size(TerminalSizeSpec::new(120, 32))
                .window_name("main"),
        )
        .await?;

    assert!(session.exists().await?);
    let snapshot = session.pane(0, 0).snapshot().await?;
    println!(
        "quickstart connected: session={}, endpoint={:?}, snapshot={}x{}",
        session_name,
        terminal.endpoint(),
        snapshot.cols,
        snapshot.rows,
    );

    Ok(())
}
