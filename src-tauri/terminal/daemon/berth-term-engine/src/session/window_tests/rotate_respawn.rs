use super::*;

#[test]
fn respawn_window_retains_first_pane_identity_even_when_another_pane_is_active_like_tmux() {
    let mut session = Session::new(
        session_name("alpha"),
        TerminalSize {
            cols: 120,
            rows: 40,
        },
    );
    session.split_active_pane().expect("first split succeeds");
    session.split_active_pane().expect("second split succeeds");
    session.select_pane(2).expect("pane 2 exists");

    let first_pane_id = session.window().panes()[0].id();
    let active_pane_id = session
        .window()
        .active_pane()
        .expect("active pane exists")
        .id();
    assert_ne!(first_pane_id, active_pane_id);

    let respawned_pane_id = session.respawn_window(0).expect("respawn succeeds");

    assert_eq!(respawned_pane_id, first_pane_id);
    assert_eq!(session.window().panes().len(), 1);
    assert_eq!(session.window().panes()[0].id(), first_pane_id);
    assert_eq!(session.active_pane_index(), 0);
    assert_eq!(
        session.window().panes()[0].geometry(),
        PaneGeometry::new(0, 0, 120, 40)
    );
}

#[test]
fn move_window_to_the_same_index_is_a_noop() {
    let mut session = Session::new(
        session_name("alpha"),
        TerminalSize {
            cols: 120,
            rows: 40,
        },
    );
    session
        .insert_window_with_initial_pane(2, TerminalSize { cols: 90, rows: 30 })
        .expect("window 2 insert succeeds");
    session.select_window(2).expect("window 2 select succeeds");

    let result = session
        .move_window(2, 2, false, false)
        .expect("self-move succeeds");

    assert_eq!(result, None);
    assert_eq!(session.active_window_index(), 2);
    assert_eq!(session.last_window_index(), Some(0));
}

#[test]
fn move_window_with_does_not_follow_the_active_source_window() {
    let mut session = Session::new(
        session_name("alpha"),
        TerminalSize {
            cols: 120,
            rows: 40,
        },
    );
    session
        .insert_window_with_initial_pane(2, TerminalSize { cols: 90, rows: 30 })
        .expect("window 2 insert succeeds");
    session.select_window(2).expect("window 2 select succeeds");
    session.select_window(0).expect("window 0 select succeeds");

    session
        .move_window(0, 4, false, false)
        .expect("move succeeds");

    assert_eq!(session.active_window_index(), 2);
    assert_eq!(session.last_window_index(), None);
}
