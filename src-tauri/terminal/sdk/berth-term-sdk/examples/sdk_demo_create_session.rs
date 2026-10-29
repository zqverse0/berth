//! Demonstrates the `Terminal::ensure_session` builder pattern.
//!
//! Bootstrapping a daemon-managed session with a specific name, a
//! deterministic process spec, and a couple of environment overrides
//! — the canonical "create a workspace I can come back to" line of
//! code clients will hit on their first call.
//!
//! The captured snapshot just shows the post-create idle prompt;
//! the snippet itself is what the docs page lifts.

use berth_term_sdk::Result;

#[path = "sdk_demo_helpers/mod.rs"]
mod sdk_demo_helpers;

#[tokio::main]
async fn main() -> Result<()> {
    let (_terminal, session) = sdk_demo_helpers::demo_session("create").await?;
    sdk_demo_helpers::paint_idle_prompt(&session).await?;

    // example:start
    use berth_term_sdk::{EnsureSession, Terminal, TerminalSizeSpec};
    let terminal = Terminal::builder().connect_or_start().await?;
    let _session = terminal
        .ensure_session(
            EnsureSession::try_named("workspace")?
                .create_or_reuse()
                .detached(true)
                .size(TerminalSizeSpec::new(80, 24))
                .argv(["bash", "-i"])
                .environment(["EDITOR=nvim", "PROJECT_ROOT=/srv/app"]),
        )
        .await?;
    // example:end

    Ok(())
}
