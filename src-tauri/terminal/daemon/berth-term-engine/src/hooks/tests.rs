use super::{validate_hook_scope, HookSetOptions, HookStore};
use berth_term_proto::{
    HookLifecycle, HookName, ScopeSelector, SessionName, TerminalError, WindowTarget,
};

fn session_name(value: &str) -> SessionName {
    SessionName::new(value).expect("valid session name")
}

#[test]
fn one_shot_items_are_consumed_without_removing_persistent_neighbors() {
    let mut store = HookStore::new();
    let alpha = session_name("alpha");

    store
        .set_with_options(
            ScopeSelector::Session(alpha.clone()),
            HookName::ClientAttached,
            "printf persistent".to_owned(),
            HookLifecycle::Persistent,
            HookSetOptions {
                append: true,
                index: None,
            },
        )
        .expect("persistent append succeeds");
    store
        .set_with_options(
            ScopeSelector::Session(alpha.clone()),
            HookName::ClientAttached,
            "printf once".to_owned(),
            HookLifecycle::OneShot,
            HookSetOptions {
                append: true,
                index: None,
            },
        )
        .expect("one-shot append succeeds");

    let first = store.dispatch(
        &ScopeSelector::Session(alpha.clone()),
        HookName::ClientAttached,
    );
    let second = store.dispatch(
        &ScopeSelector::Session(alpha.clone()),
        HookName::ClientAttached,
    );

    assert_eq!(
        first
            .iter()
            .map(super::HookDispatch::command)
            .collect::<Vec<_>>(),
        vec!["printf persistent", "printf once"]
    );
    assert_eq!(
        second
            .iter()
            .map(super::HookDispatch::command)
            .collect::<Vec<_>>(),
        vec!["printf persistent"]
    );
}

#[test]
fn pane_hooks_fall_back_from_pane_to_window_to_global_window_scope() {
    let mut store = HookStore::new();
    let alpha = session_name("alpha");
    let window = WindowTarget::with_window(alpha.clone(), 1);
    let pane = berth_term_proto::PaneTarget::with_window(alpha.clone(), 1, 2);

    store
        .set(
            ScopeSelector::Global,
            HookName::PaneExited,
            "printf global".to_owned(),
            HookLifecycle::Persistent,
        )
        .expect("global set succeeds");
    store
        .set(
            ScopeSelector::Window(window.clone()),
            HookName::PaneExited,
            "printf window".to_owned(),
            HookLifecycle::Persistent,
        )
        .expect("window set succeeds");
    store
        .set(
            ScopeSelector::Pane(pane.clone()),
            HookName::PaneExited,
            "printf pane".to_owned(),
            HookLifecycle::Persistent,
        )
        .expect("pane set succeeds");

    assert_eq!(
        store
            .dispatch(&ScopeSelector::Pane(pane.clone()), HookName::PaneExited)
            .iter()
            .map(super::HookDispatch::command)
            .collect::<Vec<_>>(),
        vec!["printf pane"]
    );
    store
        .unset(
            ScopeSelector::Pane(pane.clone()),
            HookName::PaneExited,
            None,
        )
        .expect("pane unset succeeds");
    assert_eq!(
        store
            .dispatch(&ScopeSelector::Pane(pane.clone()), HookName::PaneExited)
            .iter()
            .map(super::HookDispatch::command)
            .collect::<Vec<_>>(),
        vec!["printf window"]
    );
    store
        .unset(
            ScopeSelector::Window(window.clone()),
            HookName::PaneExited,
            None,
        )
        .expect("window unset succeeds");
    assert_eq!(
        store
            .dispatch(&ScopeSelector::Pane(pane), HookName::PaneExited)
            .iter()
            .map(super::HookDispatch::command)
            .collect::<Vec<_>>(),
        vec!["printf global"]
    );
}

#[test]
fn incompatible_hook_scope_pairs_are_rejected() {
    let alpha = session_name("alpha");

    let error = validate_hook_scope(
        HookName::WindowLayoutChanged,
        &ScopeSelector::Session(alpha),
    )
    .expect_err("window hooks reject session scope");

    assert_eq!(
        error,
        TerminalError::Server("window-layout-changed does not support session scope".to_owned())
    );
}

#[test]
fn dispatch_returns_commands_in_sparse_index_order() {
    let mut store = HookStore::new();

    for (index, command) in [(10, "printf ten"), (2, "printf two"), (7, "printf seven")] {
        store
            .set_with_options(
                ScopeSelector::Global,
                HookName::ClientAttached,
                command.to_owned(),
                HookLifecycle::Persistent,
                HookSetOptions {
                    append: false,
                    index: Some(index),
                },
            )
            .expect("indexed set succeeds");
    }

    let dispatches = store.dispatch(&ScopeSelector::Global, HookName::ClientAttached);
    assert_eq!(
        dispatches
            .iter()
            .map(super::HookDispatch::command)
            .collect::<Vec<_>>(),
        vec!["printf two", "printf seven", "printf ten"]
    );
}

#[test]
fn all_one_shot_entries_consumed_leaves_hook_clean() {
    let mut store = HookStore::new();
    let alpha = session_name("alpha");

    store
        .set(
            ScopeSelector::Session(alpha.clone()),
            HookName::ClientAttached,
            "printf once".to_owned(),
            HookLifecycle::OneShot,
        )
        .expect("set succeeds");

    let first = store.dispatch(
        &ScopeSelector::Session(alpha.clone()),
        HookName::ClientAttached,
    );
    assert_eq!(first.len(), 1);

    // After the one-shot is consumed, the session bindings should be empty
    // and fall through to global.
    let second = store.dispatch(
        &ScopeSelector::Session(alpha.clone()),
        HookName::ClientAttached,
    );
    assert!(second.is_empty());
}

#[test]
fn new_hook_scope_classes_match_tmux_inventory() {
    let alpha = session_name("alpha");
    let window = WindowTarget::with_window(alpha.clone(), 1);
    let pane = berth_term_proto::PaneTarget::with_window(alpha.clone(), 1, 2);

    assert!(validate_hook_scope(HookName::AlertBell, &ScopeSelector::Global).is_ok());
    assert!(
        validate_hook_scope(HookName::AlertBell, &ScopeSelector::Session(alpha.clone())).is_ok()
    );
    assert!(
        validate_hook_scope(HookName::AlertBell, &ScopeSelector::Window(window.clone())).is_err()
    );

    assert!(validate_hook_scope(HookName::WindowResized, &ScopeSelector::Global).is_ok());
    assert!(validate_hook_scope(
        HookName::WindowResized,
        &ScopeSelector::Window(window.clone())
    )
    .is_ok());
    assert!(
        validate_hook_scope(HookName::WindowResized, &ScopeSelector::Pane(pane.clone())).is_err()
    );

    assert!(validate_hook_scope(HookName::PaneTitleChanged, &ScopeSelector::Global).is_ok());
    assert!(
        validate_hook_scope(HookName::PaneTitleChanged, &ScopeSelector::Window(window)).is_ok()
    );
    assert!(validate_hook_scope(HookName::PaneTitleChanged, &ScopeSelector::Pane(pane)).is_ok());
}
