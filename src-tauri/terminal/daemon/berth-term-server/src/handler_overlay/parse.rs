use std::path::PathBuf;

use berth_term_engine::BoxLines;

#[derive(Debug, Clone)]
pub(in super::super) struct ParsedDisplayPopupCommand {
    pub(super) title: String,
    pub(super) x: Option<String>,
    pub(super) y: Option<String>,
    pub(super) width: Option<PopupSizeSpec>,
    pub(super) height: Option<PopupSizeSpec>,
    pub(super) style: Option<String>,
    pub(super) border_style: Option<String>,
    pub(super) border_lines: Option<BoxLines>,
    pub(super) close_on_exit: bool,
    pub(super) close_on_zero_exit: bool,
    pub(super) close_any_key: bool,
    pub(super) no_job: bool,
    pub(super) start_directory: Option<PathBuf>,
    pub(super) environment: Vec<String>,
    pub(super) command: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum PopupSizeSpec {
    Percent(u8),
}

#[cfg(test)]
mod tests {}
