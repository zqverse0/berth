use super::PaneSwapOptions;
use crate::{Pane, Window};
use berth_term_proto::TerminalError;

pub(super) fn validate_swap_destination(
    destination_window: &Window,
    incoming_pane: &Pane,
    replaced_pane_index: u32,
) -> Result<(), TerminalError> {
    let replaced_position = destination_window
        .pane_position(replaced_pane_index)
        .expect("validated replaced pane must exist");
    destination_window.ensure_accepts_pane(incoming_pane, Some(replaced_position))
}

pub(super) fn apply_swap_between_windows(
    source_window: &mut Window,
    source: SwapPaneEntry,
    target_window: &mut Window,
    target: SwapPaneEntry,
    options: PaneSwapOptions,
) -> Result<(), TerminalError> {
    let source_active_before = source_window.active_pane_index();
    let target_active_before = target_window.active_pane_index();
    source_window.push_zoom(options.preserve_zoom);
    target_window.push_zoom(options.preserve_zoom);
    source_window.replace_pane(source.index, target.pane)?;
    target_window.replace_pane(target.index, source.pane)?;

    if !options.detached || source_active_before == source.index {
        source_window.select_pane(target.index);
    }
    if !options.detached || target_active_before == target.index {
        target_window.select_pane(source.index);
    }

    source_window.clear_last_pane_reference(source.index);
    target_window.clear_last_pane_reference(target.index);
    source_window.recalculate_geometry();
    target_window.recalculate_geometry();
    source_window.pop_zoom();
    target_window.pop_zoom();
    Ok(())
}

pub(super) struct SwapPaneEntry {
    pub(super) index: u32,
    pub(super) pane: Pane,
}
