use berth_term_proto::{OptionName, TerminalError};
use std::collections::BTreeMap;

use crate::pane_terminals::HandlerState;

use super::super::RequestHandler;
use super::mode_tree_model::{ModeTreeBuild, ModeTreeClientState, TreeDepth};
use super::mode_tree_order::{pane_item_id, session_item_id, window_item_id};
use super::mode_tree_render::mode_tree_list_rows;
use super::mode_tree_selection::{clamp_scroll, ensure_selected_visible, normalize_selection};
use super::mode_tree_tree_build::build_tree_items;
#[cfg(test)]
pub(super) use super::mode_tree_tree_build::tree_item_display_line;

impl RequestHandler {
    pub(super) async fn build_mode_tree(
        &self,
        mode: &mut ModeTreeClientState,
        attach_pid: u32,
    ) -> Result<ModeTreeBuild, TerminalError> {
        let state = self.state.lock().await;
        let active_attach = self.active_attach.lock().await;
        let current_attach_session = active_attach
            .by_pid
            .get(&attach_pid)
            .map(|active| active.session_name.clone());
        let attached_counts = state
            .sessions
            .iter()
            .map(|(session_name, _)| {
                let mut count = active_attach.attached_count(session_name);
                if count == 0 && current_attach_session.as_ref() == Some(session_name) {
                    count = 1;
                }
                (session_name.clone(), count)
            })
            .collect::<Vec<_>>();
        let build = match mode.kind {
            super::mode_tree_model::ModeTreeKind::Tree => {
                build_tree_items(mode, &state, &attached_counts)?
            }
        };
        let visible = if build.visible.is_empty() {
            None
        } else {
            Some(build)
        };
        let build = if let Some(build) = visible {
            build
        } else if mode
            .filter_text
            .as_deref()
            .is_some_and(|filter| !filter.is_empty())
        {
            let original_filter = mode.filter_text.take();
            let mut fallback = match mode.kind {
                super::mode_tree_model::ModeTreeKind::Tree => {
                    build_tree_items(mode, &state, &attached_counts)?
                }
            };
            mode.filter_text = original_filter;
            fallback.no_matches = true;
            fallback
        } else {
            ModeTreeBuild {
                items: BTreeMap::new(),
                roots: Vec::new(),
                order: Vec::new(),
                visible: Vec::new(),
                no_matches: false,
            }
        };

        if build.visible.is_empty() {
            mode.selected_id = None;
            mode.scroll = 0;
        } else if mode
            .selected_id
            .as_ref()
            .map(|id| !build.items.contains_key(id))
            .unwrap_or(true)
        {
            mode.selected_id = mode_tree_default_selection(mode, &build, attach_pid, &state)
                .or_else(|| build.visible.first().cloned());
            mode.scroll = 0;
        }
        if let Some(session) = state.sessions.session(&mode.session_name) {
            let rows = session.window().size().rows;
            let status_on = state
                .options
                .resolve(Some(session.name()), OptionName::Status)
                .map(|value| value != "off")
                .unwrap_or(true);
            let usable = rows.saturating_sub(u16::from(status_on));
            mode.last_list_rows = usize::from(mode_tree_list_rows(
                usable,
                build.visible.len(),
                mode.preview_mode,
            ));
        }
        if let Some(selected) = mode
            .selected_id
            .as_ref()
            .and_then(|id| build.visible.iter().position(|visible| visible == id))
        {
            ensure_selected_visible(mode, selected);
        }
        clamp_scroll(mode, &build);
        normalize_selection(mode, &build);
        Ok(build)
    }

    pub(super) async fn seed_mode_tree_defaults(
        &self,
        mode: &mut ModeTreeClientState,
    ) -> Result<(), TerminalError> {
        if !matches!(mode.kind, super::mode_tree_model::ModeTreeKind::Tree) {
            return Ok(());
        }
        let state = self.state.lock().await;
        let mut sessions = state.sessions.iter().collect::<Vec<_>>();
        sessions.sort_by(|(left, _), (right, _)| left.as_str().cmp(right.as_str()));
        for (session_name, session) in sessions {
            let session_id = session_item_id(session_name);
            match mode.tree_depth {
                TreeDepth::Session => {}
                TreeDepth::Window | TreeDepth::Pane => {
                    mode.expanded.insert(session_id);
                }
            }
            if matches!(mode.tree_depth, TreeDepth::Pane) {
                for window_index in session.windows().keys() {
                    mode.expanded
                        .insert(window_item_id(session_name, *window_index));
                }
            }
        }
        Ok(())
    }
}

fn mode_tree_default_selection(
    mode: &ModeTreeClientState,
    build: &ModeTreeBuild,
    _attach_pid: u32,
    state: &HandlerState,
) -> Option<String> {
    match mode.kind {
        super::mode_tree_model::ModeTreeKind::Tree => {
            let session = state.sessions.session(&mode.session_name)?;
            let selected_id = match mode.tree_depth {
                TreeDepth::Session => session_item_id(session.name()),
                TreeDepth::Window => window_item_id(session.name(), session.active_window_index()),
                TreeDepth::Pane => pane_item_id(
                    session.name(),
                    session.active_window_index(),
                    session.active_pane_index(),
                ),
            };
            build
                .items
                .contains_key(&selected_id)
                .then_some(selected_id)
        }
    }
}
