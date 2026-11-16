use super::*;

#[test]
fn unset_at_global_scope_restores_default() {
    let mut store = OptionStore::new();

    store
        .set_by_name(
            OptionScopeSelector::SessionGlobal,
            "status",
            Some("off".to_owned()),
            SetOptionMode::Replace,
            false,
            false,
            false,
        )
        .expect("set succeeds");
    assert_eq!(store.global_value(OptionName::Status), Some("off"));

    store
        .set_by_name(
            OptionScopeSelector::SessionGlobal,
            "status",
            None,
            SetOptionMode::Replace,
            false,
            true,
            false,
        )
        .expect("unset succeeds");
    assert_eq!(store.global_value(OptionName::Status), Some("on"));
}

#[test]
fn unset_at_session_scope_removes_entry_so_global_takes_over() {
    let mut store = OptionStore::new();
    let alpha = session_name("alpha");

    store
        .set_by_name(
            OptionScopeSelector::SessionGlobal,
            "status",
            Some("off".to_owned()),
            SetOptionMode::Replace,
            false,
            false,
            false,
        )
        .expect("global set succeeds");

    store
        .set_by_name(
            OptionScopeSelector::Session(alpha.clone()),
            "status",
            Some("on".to_owned()),
            SetOptionMode::Replace,
            false,
            false,
            false,
        )
        .expect("session set succeeds");

    assert_eq!(store.resolve(Some(&alpha), OptionName::Status), Some("on"));

    store
        .set_by_name(
            OptionScopeSelector::Session(alpha.clone()),
            "status",
            None,
            SetOptionMode::Replace,
            false,
            true,
            false,
        )
        .expect("unset succeeds");

    assert_eq!(store.resolve(Some(&alpha), OptionName::Status), Some("off"));
}

#[test]
fn only_if_unset_rejects_already_set_option() {
    let mut store = OptionStore::new();

    store
        .set_by_name(
            OptionScopeSelector::SessionGlobal,
            "status",
            Some("off".to_owned()),
            SetOptionMode::Replace,
            false,
            false,
            false,
        )
        .expect("first set succeeds");

    let error = store
        .set_by_name(
            OptionScopeSelector::SessionGlobal,
            "status",
            Some("on".to_owned()),
            SetOptionMode::Replace,
            true,
            false,
            false,
        )
        .expect_err("second set must fail");

    assert!(error.to_string().contains("already set"));
}

#[test]
fn only_if_unset_allows_default_or_inherited_values() {
    let mut store = OptionStore::new();
    let alpha = SessionName::new("alpha").expect("valid session name");

    store
        .set_by_name(
            OptionScopeSelector::Session(alpha.clone()),
            "status",
            Some("off".to_owned()),
            SetOptionMode::Replace,
            true,
            false,
            false,
        )
        .expect("default value does not count as explicitly set");
    assert_eq!(store.resolve(Some(&alpha), OptionName::Status), Some("off"));

    store
        .set_by_name(
            OptionScopeSelector::SessionGlobal,
            "status-left",
            Some("global".to_owned()),
            SetOptionMode::Replace,
            false,
            false,
            false,
        )
        .expect("global set succeeds");

    store
        .set_by_name(
            OptionScopeSelector::Session(alpha.clone()),
            "status-left",
            Some("session".to_owned()),
            SetOptionMode::Replace,
            true,
            false,
            false,
        )
        .expect("inherited value does not count as explicitly set");
    assert_eq!(
        store.resolve(Some(&alpha), OptionName::StatusLeft),
        Some("session")
    );
}

#[test]
fn prefix_matching_resolves_unambiguous_prefix() {
    let query = super::resolve_option_name("buffer-l").expect("prefix matches");
    assert_eq!(query.canonical_name(), "buffer-limit");
}

#[test]
fn prefix_matching_rejects_ambiguous_prefix() {
    // "status-l" matches both "status-left" and "status-left-length" (and
    // "status-left-style") so it must be ambiguous.
    let result = super::resolve_option_name("status-l");
    assert!(result.is_err());
    assert!(result.unwrap_err().to_string().contains("ambiguous"));
}

#[test]
fn split_array_index_parses_valid_syntax() {
    let query = super::resolve_option_name("terminal-features[0]").expect("index parses");
    assert_eq!(query.canonical_name(), "terminal-features");
    assert_eq!(query.index(), Some(0));
}

#[test]
fn split_array_index_rejects_malformed_syntax() {
    assert!(super::resolve_option_name("terminal-features[]").is_err());
    assert!(super::resolve_option_name("terminal-features[abc]").is_err());
    assert!(super::resolve_option_name("terminal-features[0").is_err());
    assert!(super::resolve_option_name("]").is_err());
}

#[test]
fn flag_toggle_on_empty_value() {
    let mut store = OptionStore::new();

    // Default is "on", toggle should switch to "off"
    store
        .set_by_name(
            OptionScopeSelector::WindowGlobal,
            "automatic-rename",
            None,
            SetOptionMode::Replace,
            false,
            false,
            false,
        )
        .expect("toggle set succeeds");

    assert_eq!(store.global_value(OptionName::AutomaticRename), Some("off"));

    // Toggle again should switch back to "on"
    store
        .set_by_name(
            OptionScopeSelector::WindowGlobal,
            "automatic-rename",
            None,
            SetOptionMode::Replace,
            false,
            false,
            false,
        )
        .expect("second toggle succeeds");

    assert_eq!(store.global_value(OptionName::AutomaticRename), Some("on"));
}

#[test]
fn flag_accepts_yes_no_case_insensitive() {
    let mut store = OptionStore::new();

    store
        .set_by_name(
            OptionScopeSelector::WindowGlobal,
            "automatic-rename",
            Some("YES".to_owned()),
            SetOptionMode::Replace,
            false,
            false,
            false,
        )
        .expect("YES set succeeds");
    assert_eq!(store.global_value(OptionName::AutomaticRename), Some("on"));

    store
        .set_by_name(
            OptionScopeSelector::WindowGlobal,
            "automatic-rename",
            Some("No".to_owned()),
            SetOptionMode::Replace,
            false,
            false,
            false,
        )
        .expect("No set succeeds");
    assert_eq!(store.global_value(OptionName::AutomaticRename), Some("off"));
}

#[test]
fn array_indexed_set_and_unset() {
    let mut store = OptionStore::new();

    store
        .set_by_name(
            OptionScopeSelector::ServerGlobal,
            "terminal-features[0]",
            Some("xterm:RGB".to_owned()),
            SetOptionMode::Replace,
            false,
            false,
            false,
        )
        .expect("indexed set succeeds");

    assert_eq!(
        store.resolve_name(None, "terminal-features[0]"),
        Some("xterm:RGB".to_owned())
    );

    store
        .set_by_name(
            OptionScopeSelector::ServerGlobal,
            "terminal-features[0]",
            None,
            SetOptionMode::Replace,
            false,
            true,
            false,
        )
        .expect("indexed unset succeeds");
}

#[test]
fn unset_pane_overrides_clears_matching_pane_entries() {
    let mut store = OptionStore::new();
    let alpha = session_name("alpha");
    let window = WindowTarget::with_window(alpha.clone(), 1);
    let pane = PaneTarget::with_window(alpha.clone(), 1, 0);

    store
        .set(
            ScopeSelector::Window(window.clone()),
            OptionName::WindowStyle,
            "fg=colour7".to_owned(),
            SetOptionMode::Replace,
        )
        .expect("window set succeeds");
    store
        .set(
            ScopeSelector::Pane(pane.clone()),
            OptionName::WindowStyle,
            "fg=colour8".to_owned(),
            SetOptionMode::Replace,
        )
        .expect("pane set succeeds");

    assert_eq!(
        store.pane_value(&pane, OptionName::WindowStyle),
        Some("fg=colour8")
    );

    store
        .set_by_name(
            OptionScopeSelector::Window(window),
            "window-style",
            None,
            SetOptionMode::Replace,
            false,
            true,
            true,
        )
        .expect("unset with pane overrides succeeds");

    assert_eq!(store.pane_value(&pane, OptionName::WindowStyle), None);
}
