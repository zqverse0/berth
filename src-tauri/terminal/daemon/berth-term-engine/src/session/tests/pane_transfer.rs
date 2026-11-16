use super::*;

#[test]
fn detached_swap_panes_within_window_preserves_active_and_last_pane_tracking() {
    let mut session = Session::new(
        session_name("alpha"),
        TerminalSize {
            cols: 120,
            rows: 40,
        },
    );
    session.split_active_pane().expect("split succeeds");
    session.select_pane(1).expect("pane 1 exists");
    session.select_pane(0).expect("pane 0 exists");
    let pane_zero_geometry = session.window().pane(0).expect("pane 0 exists").geometry();
    let pane_one_geometry = session.window().pane(1).expect("pane 1 exists").geometry();
    let pane_zero_id = session.pane_id_in_window(0, 0).expect("pane 0 id exists");

    session
        .swap_panes(
            SessionPaneTarget::new(0, 0),
            SessionPaneTarget::new(0, 1),
            PaneSwapOptions::new(true, false),
        )
        .expect("detached same-window swap succeeds");

    assert_eq!(session.active_pane_index(), 1);
    assert_eq!(session.window().last_pane_index(), Some(0));
    assert_eq!(session.pane_id_in_window(0, 1), Some(pane_zero_id));
    assert_eq!(
        session
            .window()
            .panes()
            .iter()
            .map(|pane| pane.index())
            .collect::<Vec<_>>(),
        vec![0, 1]
    );
    assert_eq!(
        session.window().pane(0).expect("pane 0 exists").geometry(),
        pane_zero_geometry
    );
    assert_eq!(
        session.window().pane(1).expect("pane 1 exists").geometry(),
        pane_one_geometry
    );
}

#[test]
fn swap_panes_across_windows_clears_last_pane_references_to_swapped_out_panes() {
    let mut session = Session::new(
        session_name("alpha"),
        TerminalSize {
            cols: 120,
            rows: 40,
        },
    );
    session
        .split_active_pane()
        .expect("window 0 split succeeds");
    session
        .insert_window_with_initial_pane(
            1,
            TerminalSize {
                cols: 120,
                rows: 40,
            },
        )
        .expect("window 1 insert succeeds");
    session
        .split_pane_in_window(1, 0)
        .expect("window 1 split succeeds");
    session
        .select_pane_in_window(0, 1)
        .expect("window 0 pane 1 exists");
    session
        .select_pane_in_window(0, 0)
        .expect("window 0 pane 0 exists");
    session
        .select_pane_in_window(1, 1)
        .expect("window 1 pane 1 exists");
    session
        .select_pane_in_window(1, 0)
        .expect("window 1 pane 0 exists");

    session
        .swap_panes(
            SessionPaneTarget::new(0, 1),
            SessionPaneTarget::new(1, 1),
            PaneSwapOptions::new(true, false),
        )
        .expect("swap succeeds");

    assert_eq!(
        session
            .window_at(0)
            .expect("window 0 exists")
            .last_pane_index(),
        None
    );
    assert_eq!(
        session
            .window_at(1)
            .expect("window 1 exists")
            .last_pane_index(),
        None
    );
    assert_eq!(
        session
            .window_at(0)
            .expect("window 0 exists")
            .panes()
            .iter()
            .map(|pane| pane.index())
            .collect::<Vec<_>>(),
        vec![0, 1]
    );
    assert_eq!(
        session
            .window_at(1)
            .expect("window 1 exists")
            .panes()
            .iter()
            .map(|pane| pane.index())
            .collect::<Vec<_>>(),
        vec![0, 1]
    );
}
