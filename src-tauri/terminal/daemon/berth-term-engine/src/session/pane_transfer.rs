use super::pane_transfer_shared::{
    apply_swap_between_windows, validate_swap_destination, SwapPaneEntry,
};
use super::target_error::{invalid_pane_target, invalid_window_target};
use super::{PaneSwapOptions, Session, SessionPaneTarget};
use berth_term_proto::TerminalError;

#[path = "pane_transfer/break_window.rs"]
mod break_window;

impl Session {
    /// Swaps two panes within the same session without renumbering either pane.
    pub fn swap_panes(
        &mut self,
        source: SessionPaneTarget,
        target: SessionPaneTarget,
        options: PaneSwapOptions,
    ) -> Result<(), TerminalError> {
        if source.window_index == target.window_index {
            return self.swap_panes_within_window(
                source.window_index,
                source.pane_index,
                target.pane_index,
                options,
            );
        }

        let source_pane = self
            .window_at(source.window_index)
            .ok_or_else(|| invalid_window_target(&self.name, source.window_index))?
            .pane(source.pane_index)
            .cloned()
            .ok_or_else(|| {
                invalid_pane_target(
                    &self.name,
                    source.window_index,
                    source.pane_index,
                    "pane index does not exist in session",
                )
            })?;
        let target_pane = self
            .window_at(target.window_index)
            .ok_or_else(|| invalid_window_target(&self.name, target.window_index))?
            .pane(target.pane_index)
            .cloned()
            .ok_or_else(|| {
                invalid_pane_target(
                    &self.name,
                    target.window_index,
                    target.pane_index,
                    "pane index does not exist in session",
                )
            })?;

        validate_swap_destination(
            self.window_at(source.window_index)
                .expect("source window must exist"),
            &target_pane,
            source.pane_index,
        )?;
        validate_swap_destination(
            self.window_at(target.window_index)
                .expect("target window must exist"),
            &source_pane,
            target.pane_index,
        )?;

        let mut source_window = self
            .windows
            .remove(&source.window_index)
            .expect("source window must exist for swap");
        let mut target_window = self
            .windows
            .remove(&target.window_index)
            .expect("target window must exist for swap");
        apply_swap_between_windows(
            &mut source_window,
            SwapPaneEntry {
                index: source.pane_index,
                pane: source_pane,
            },
            &mut target_window,
            SwapPaneEntry {
                index: target.pane_index,
                pane: target_pane,
            },
            options,
        )?;
        self.windows.insert(source.window_index, source_window);
        self.windows.insert(target.window_index, target_window);

        Ok(())
    }

    fn swap_panes_within_window(
        &mut self,
        window_index: u32,
        source_pane_index: u32,
        target_pane_index: u32,
        options: PaneSwapOptions,
    ) -> Result<(), TerminalError> {
        if source_pane_index == target_pane_index {
            let window = self
                .window_at(window_index)
                .ok_or_else(|| invalid_window_target(&self.name, window_index))?;
            if window.pane(source_pane_index).is_none() {
                return Err(invalid_pane_target(
                    &self.name,
                    window_index,
                    source_pane_index,
                    "pane index does not exist in session",
                ));
            }
            return Ok(());
        }

        let window = self
            .window_at(window_index)
            .ok_or_else(|| invalid_window_target(&self.name, window_index))?;
        if window.pane(source_pane_index).is_none() {
            return Err(invalid_pane_target(
                &self.name,
                window_index,
                source_pane_index,
                "pane index does not exist in session",
            ));
        }
        if window.pane(target_pane_index).is_none() {
            return Err(invalid_pane_target(
                &self.name,
                window_index,
                target_pane_index,
                "pane index does not exist in session",
            ));
        }

        let window = self
            .window_at_mut(window_index)
            .expect("window must exist for in-window swap");
        window.push_zoom(options.preserve_zoom);
        let target_pane_id = window
            .pane(target_pane_index)
            .expect("validated target pane must exist before swap")
            .id();
        let swapped = window.swap_panes(source_pane_index, target_pane_index);
        debug_assert!(swapped, "validated in-window swap must succeed");

        if !options.detached {
            window.select_pane_by_id(target_pane_id);
        }
        window.pop_zoom();

        Ok(())
    }
}
