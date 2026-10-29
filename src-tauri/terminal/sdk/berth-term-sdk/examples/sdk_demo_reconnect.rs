//! Demonstrates picking up an existing session by name.
//!
//! Pairs with `Run an app detached`. After leaving an app running in
//! a daemon-managed session, a caller uses `Terminal::session(name)` to
//! grab a handle and verifies the session is still alive with
//! `Session::exists()`. Reading the live state via `Pane::snapshot()`
//! belongs to the dedicated "Snapshot pane" example — keeping it out
//! of this snippet avoids duplicating the same pattern across docs.

use berth_term_sdk::Result;

#[path = "sdk_demo_helpers/mod.rs"]
mod sdk_demo_helpers;

#[tokio::main]
async fn main() -> Result<()> {
    let (terminal, _demo) = sdk_demo_helpers::demo_session("reconnect").await?;
    // Pre-create the session the snippet will reconnect to so the
    // example is rejouable on its own (not dependent on `run-detached`
    // running first in the daemon).
    let _api_server = sdk_demo_helpers::throwaway_session(&terminal, "api-server").await?;

    // example:start
    use berth_term_sdk::{SessionName, Terminal};
    let terminal = Terminal::builder().connect_or_start().await?;
    let session = terminal
        .session(SessionName::try_from("api-server".to_owned())?)
        .await?;
    assert!(session.exists().await?);
    // example:end

    Ok(())
}
