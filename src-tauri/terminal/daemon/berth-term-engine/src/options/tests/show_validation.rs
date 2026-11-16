use super::*;

#[test]
fn numeric_and_flag_values_are_canonicalized_before_storage() {
    let mut store = OptionStore::new();
    let alpha = session_name("alpha");

    store
        .set(
            ScopeSelector::Session(alpha.clone()),
            OptionName::BaseIndex,
            "0007".to_owned(),
            SetOptionMode::Replace,
        )
        .expect("numeric set succeeds");
    store
        .set(
            ScopeSelector::Global,
            OptionName::AutomaticRename,
            "0".to_owned(),
            SetOptionMode::Replace,
        )
        .expect("flag set succeeds");

    assert_eq!(
        store.session_value(&alpha, OptionName::BaseIndex),
        Some("7")
    );
    assert_eq!(store.global_value(OptionName::AutomaticRename), Some("off"));
}

#[test]
fn input_buffer_size_can_be_lowered_below_default() {
    let mut store = OptionStore::new();

    store
        .set_by_name(
            OptionScopeSelector::ServerGlobal,
            "input-buffer-size",
            Some("0".to_owned()),
            SetOptionMode::Replace,
            false,
            false,
            false,
        )
        .expect("input-buffer-size accepts tmux-compatible zero minimum");

    assert_eq!(store.global_value(OptionName::InputBufferSize), Some("0"));
}

#[test]
fn bare_non_flag_choice_options_are_rejected() {
    let mut store = OptionStore::new();

    let error = store
        .set_by_name(
            OptionScopeSelector::WindowGlobal,
            "mode-keys",
            None,
            SetOptionMode::Replace,
            false,
            false,
            false,
        )
        .expect_err("bare mode-keys must not toggle between emacs and vi");

    assert!(
        error.to_string().contains("empty value"),
        "unexpected error: {error}"
    );
}

#[test]
fn literal_style_options_reject_invalid_styles() {
    let mut store = OptionStore::new();

    let error = store
        .set(
            ScopeSelector::Global,
            OptionName::StatusStyle,
            "fg=not-a-colour".to_owned(),
            SetOptionMode::Replace,
        )
        .expect_err("invalid style should be rejected");

    assert_eq!(
        error,
        TerminalError::InvalidSetOption("invalid style: fg=not-a-colour".to_owned())
    );
    assert_eq!(store.global_value(OptionName::StatusStyle), None);
}

#[test]
fn style_options_with_format_expansions_skip_eager_literal_validation() {
    let mut store = OptionStore::new();
    let alpha = session_name("alpha");
    let window = WindowTarget::with_window(alpha.clone(), 0);

    store
        .set(
            ScopeSelector::Window(window),
            OptionName::PaneActiveBorderStyle,
            "#{?pane_active,red,blue}".to_owned(),
            SetOptionMode::Replace,
        )
        .expect("format-backed style should be accepted");

    assert_eq!(
        store.resolve_for_window(&alpha, 0, OptionName::PaneActiveBorderStyle),
        Some("#{?pane_active,red,blue}")
    );
}

#[test]
fn colour_options_canonicalize_bare_decimal_palette_indices() {
    let mut store = OptionStore::new();

    store
        .set(
            ScopeSelector::Global,
            OptionName::ClockModeColour,
            "214".to_owned(),
            SetOptionMode::Replace,
        )
        .expect("bare decimal colour should be accepted");

    assert_eq!(
        store.global_value(OptionName::ClockModeColour),
        Some("colour214")
    );
}

#[test]
fn removing_a_window_discards_window_and_owned_pane_values() {
    let mut store = OptionStore::new();
    let alpha = session_name("alpha");
    let window = WindowTarget::with_window(alpha.clone(), 3);
    let pane_a = PaneTarget::with_window(alpha.clone(), 3, 0);
    let pane_b = PaneTarget::with_window(alpha.clone(), 3, 1);
    let other_pane = PaneTarget::with_window(alpha.clone(), 5, 0);

    store
        .set(
            ScopeSelector::Window(window.clone()),
            OptionName::MainPaneWidth,
            "100".to_owned(),
            SetOptionMode::Replace,
        )
        .expect("window set succeeds");
    store
        .set(
            ScopeSelector::Pane(pane_a.clone()),
            OptionName::WindowStyle,
            "fg=colour4".to_owned(),
            SetOptionMode::Replace,
        )
        .expect("pane a set succeeds");
    store
        .set(
            ScopeSelector::Pane(pane_b.clone()),
            OptionName::WindowStyle,
            "fg=colour5".to_owned(),
            SetOptionMode::Replace,
        )
        .expect("pane b set succeeds");
    store
        .set(
            ScopeSelector::Pane(other_pane.clone()),
            OptionName::WindowStyle,
            "fg=colour6".to_owned(),
            SetOptionMode::Replace,
        )
        .expect("other pane set succeeds");

    assert!(store.remove_window(&window).is_some());
    assert_eq!(store.window_value(&window, OptionName::MainPaneWidth), None);
    assert_eq!(store.pane_value(&pane_a, OptionName::WindowStyle), None);
    assert_eq!(store.pane_value(&pane_b, OptionName::WindowStyle), None);
    // Panes in other windows should be unaffected
    assert_eq!(
        store.pane_value(&other_pane, OptionName::WindowStyle),
        Some("fg=colour6")
    );
}

#[test]
fn show_options_inheritance_markers_do_not_mark_global_defaults() {
    let store = OptionStore::new();

    let session_global = store
        .show_options_lines_with_mode_filtered(
            &OptionScopeSelector::SessionGlobal,
            Some("status"),
            false,
            ShowOptionsMode::ResolvedWithInheritanceMarkers,
        )
        .expect("global session option shows");
    assert_eq!(session_global, vec!["status on".to_owned()]);

    let window_global = store
        .show_options_lines_with_mode_filtered(
            &OptionScopeSelector::WindowGlobal,
            Some("pane-border-lines"),
            false,
            ShowOptionsMode::ResolvedWithInheritanceMarkers,
        )
        .expect("global window option shows");
    assert_eq!(window_global, vec!["pane-border-lines single".to_owned()]);
}
