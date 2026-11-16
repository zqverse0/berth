use berth_term_proto::{LayoutName, TerminalError};

use super::Session;

impl Session {
    /// Applies a layout to the session's active window.
    pub fn select_layout(&mut self, layout: LayoutName) {
        self.select_layout_in_window(self.active_window, layout)
            .expect("active session window must exist");
    }

    /// Applies a layout to the addressed window.
    pub fn select_layout_in_window(
        &mut self,
        window_index: u32,
        layout: LayoutName,
    ) -> Result<(), TerminalError> {
        self.select_layout_in_window_with_main_pane_size(window_index, layout, None, None)
    }

    /// Applies a layout to the addressed window using tmux `main-pane-*` option values.
    pub fn select_layout_in_window_with_main_pane_size(
        &mut self,
        window_index: u32,
        layout: LayoutName,
        main_width: Option<u16>,
        main_height: Option<u16>,
    ) -> Result<(), TerminalError> {
        self.resolve_window_target_mut(window_index)?
            .set_layout_with_main_pane_size(layout, main_width, main_height);
        Ok(())
    }

    /// Saves the current serialized layout as the window old layout.
    pub fn save_old_layout_in_window(&mut self, window_index: u32) -> Result<(), TerminalError> {
        self.resolve_window_target_mut(window_index)?
            .save_old_layout();
        Ok(())
    }

    /// Spreads the addressed window around its active pane, matching tmux `select-layout -E`.
    pub fn spread_layout_in_window(&mut self, window_index: u32) -> Result<bool, TerminalError> {
        let window = self.resolve_window_target_mut(window_index)?;
        Ok(window.spread_layout(window.active_pane_index()))
    }
}
