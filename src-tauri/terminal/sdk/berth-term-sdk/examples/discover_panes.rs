use berth_term_sdk::Result;

#[path = "support/terminal_example_fixture.rs"]
mod terminal_example_fixture;

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    let fixture = terminal_example_fixture::ready_pane("discover-panes").await?;
    let panes = fixture
        .terminal
        .find_panes()
        .session(fixture.session.name().as_str())
        .running()
        .all()
        .await?;

    for pane in panes {
        println!(
            "{} {} {:?}",
            pane.session_name,
            pane.pane_id,
            pane.title.as_deref().unwrap_or("<untitled>")
        );
    }
    fixture.session.kill().await?;
    Ok(())
}
