use super::*;

#[test]
fn swap_panes_self_swap_is_a_no_op() {
    let mut session = Session::new(
        session_name("alpha"),
        TerminalSize {
            cols: 120,
            rows: 40,
        },
    );
    session.split_active_pane().expect("split succeeds");
    let active_before = session.active_pane_index();

    session
        .swap_panes(
            SessionPaneTarget::new(0, 0),
            SessionPaneTarget::new(0, 0),
            PaneSwapOptions::new(false, false),
        )
        .expect("self-swap succeeds as no-op");

    assert_eq!(session.active_pane_index(), active_before);
}
