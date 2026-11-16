use std::collections::{BTreeMap, HashMap, HashSet};

use berth_term_proto::{SessionName, TerminalError, WindowTarget};

use super::{session_not_found, HandlerState};

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(super) struct WindowLinkSlot {
    pub(super) session_name: SessionName,
    pub(super) window_index: u32,
}

impl WindowLinkSlot {
    fn new(session_name: SessionName, window_index: u32) -> Self {
        Self {
            session_name,
            window_index,
        }
    }
}

#[derive(Debug, Clone)]
pub(super) struct WindowLinkGroup {
    pub(super) runtime_session_name: SessionName,
    pub(super) slots: Vec<WindowLinkSlot>,
}

impl HandlerState {
    fn window_link_slot(&self, session_name: &SessionName, window_index: u32) -> WindowLinkSlot {
        WindowLinkSlot::new(session_name.clone(), window_index)
    }

    pub(crate) fn window_link_count(&self, session_name: &SessionName, window_index: u32) -> usize {
        self.window_link_group_id_for_slot_or_group_peer(session_name, window_index)
            .and_then(|group_id| self.window_link_groups.get(group_id))
            .map(|group| group.slots.len())
            .unwrap_or(1)
    }

    pub(crate) fn window_linked_session_count(
        &self,
        session_name: &SessionName,
        window_index: u32,
    ) -> usize {
        self.window_linked_session_family_list(session_name, window_index)
            .len()
    }

    pub(crate) fn window_linked_sessions_list(
        &self,
        session_name: &SessionName,
        window_index: u32,
    ) -> Vec<SessionName> {
        self.window_linked_session_family_list(session_name, window_index)
    }

    pub(crate) fn window_linked_session_family_list(
        &self,
        session_name: &SessionName,
        window_index: u32,
    ) -> Vec<SessionName> {
        let slots = self.window_link_slots_for(session_name, window_index);
        let mut seen = HashSet::new();
        let mut sessions = Vec::new();
        for slot in slots {
            if seen.insert(slot.session_name.clone()) {
                sessions.push(slot.session_name.clone());
            }
            for member in self
                .sessions
                .session_group_members(&slot.session_name)
                .into_iter()
                .filter(|member| member != &slot.session_name)
            {
                if seen.insert(member.clone()) {
                    sessions.push(member);
                }
            }
        }
        sessions
    }

    pub(in crate::pane_terminals) fn runtime_session_name_for_window(
        &self,
        session_name: &SessionName,
        window_index: u32,
    ) -> SessionName {
        self.window_link_group_id_for_slot_or_group_peer(session_name, window_index)
            .and_then(|group_id| self.window_link_groups.get(group_id))
            .map(|group| group.runtime_session_name.clone())
            .unwrap_or_else(|| self.runtime_session_name(session_name))
    }

    pub(in crate::pane_terminals) fn window_link_slots_for(
        &self,
        session_name: &SessionName,
        window_index: u32,
    ) -> Vec<WindowLinkSlot> {
        let slot = self.window_link_slot(session_name, window_index);
        self.window_link_group_id_for_slot_or_group_peer(session_name, window_index)
            .and_then(|group_id| self.window_link_groups.get(group_id))
            .map(|group| group.slots.clone())
            .unwrap_or_else(|| vec![slot])
    }

    pub(crate) fn synchronize_linked_window_options_from_slot(
        &mut self,
        session_name: &SessionName,
        window_index: u32,
    ) {
        let source = WindowTarget::with_window(session_name.clone(), window_index);
        for slot in self.window_link_slots_for(session_name, window_index) {
            let target = WindowTarget::with_window(slot.session_name, slot.window_index);
            if target != source {
                self.options.copy_window_overrides(&source, &target);
            }
        }
    }

    fn window_link_group_id_for_slot_or_group_peer(
        &self,
        session_name: &SessionName,
        window_index: u32,
    ) -> Option<&u64> {
        self.window_link_group_slot_for_slot_or_group_peer(session_name, window_index)
            .and_then(|slot| self.window_link_slots.get(&slot))
    }

    fn window_link_group_slot_for_slot_or_group_peer(
        &self,
        session_name: &SessionName,
        window_index: u32,
    ) -> Option<WindowLinkSlot> {
        let slot = self.window_link_slot(session_name, window_index);
        if self.window_link_slots.contains_key(&slot) {
            return Some(slot);
        }

        self.sessions
            .session_group_members(session_name)
            .into_iter()
            .filter(|member| member != session_name)
            .find_map(|member| {
                let member_slot = self.window_link_slot(&member, window_index);
                self.window_link_slots
                    .contains_key(&member_slot)
                    .then_some(member_slot)
            })
    }

    fn canonical_window_link_slot(
        &self,
        session_name: &SessionName,
        window_index: u32,
    ) -> WindowLinkSlot {
        self.window_link_group_slot_for_slot_or_group_peer(session_name, window_index)
            .unwrap_or_else(|| {
                self.window_link_slot(&self.runtime_session_name(session_name), window_index)
            })
    }

    pub(in crate::pane_terminals) fn detach_window_link_slot(
        &mut self,
        session_name: &SessionName,
        window_index: u32,
    ) -> usize {
        let slot = self.canonical_window_link_slot(session_name, window_index);
        let Some(group_id) = self.window_link_slots.remove(&slot) else {
            return 1;
        };

        let remaining = if let Some(group) = self.window_link_groups.get_mut(&group_id) {
            group.slots.retain(|candidate| candidate != &slot);
            group.slots.len()
        } else {
            0
        };

        if remaining <= 1 {
            if let Some(group) = self.window_link_groups.remove(&group_id) {
                for group_slot in group.slots {
                    let _ = self.window_link_slots.remove(&group_slot);
                }
            }
        }

        remaining.max(1)
    }

    pub(in crate::pane_terminals) fn remap_window_indexed_state(
        &mut self,
        session_name: &SessionName,
        index_map: &BTreeMap<u32, u32>,
    ) {
        self.auto_named_windows = self
            .auto_named_windows
            .iter()
            .map(|(name, window_index)| {
                let next_index = if name == session_name {
                    index_map
                        .get(window_index)
                        .copied()
                        .unwrap_or(*window_index)
                } else {
                    *window_index
                };
                (name.clone(), next_index)
            })
            .collect();

        let mut remapped_slots = HashMap::with_capacity(self.window_link_slots.len());
        for (slot, group_id) in &self.window_link_slots {
            let next_slot = remapped_window_link_slot(slot, session_name, index_map);
            remapped_slots.insert(next_slot, *group_id);
        }
        self.window_link_slots = remapped_slots;

        for group in self.window_link_groups.values_mut() {
            group.slots = group
                .slots
                .iter()
                .map(|slot| remapped_window_link_slot(slot, session_name, index_map))
                .collect();
        }
    }

    pub(in crate::pane_terminals) fn rename_window_link_session(
        &mut self,
        session_name: &SessionName,
        new_name: &SessionName,
    ) {
        let mut renamed_slots = HashMap::with_capacity(self.window_link_slots.len());
        for (slot, group_id) in &self.window_link_slots {
            renamed_slots.insert(
                renamed_window_link_slot(slot, session_name, new_name),
                *group_id,
            );
        }
        self.window_link_slots = renamed_slots;

        for group in self.window_link_groups.values_mut() {
            rename_window_link_runtime_session(group, session_name, new_name);
            group.slots = group
                .slots
                .iter()
                .map(|slot| renamed_window_link_slot(slot, session_name, new_name))
                .collect();
        }
    }

    pub(in crate::pane_terminals) fn rename_window_link_runtime_session(
        &mut self,
        session_name: &SessionName,
        new_name: &SessionName,
    ) {
        for group in self.window_link_groups.values_mut() {
            rename_window_link_runtime_session(group, session_name, new_name);
        }
    }

    pub(in crate::pane_terminals) fn linked_runtime_transfer_slots_for_removed_session(
        &self,
        session_name: &SessionName,
    ) -> Vec<WindowLinkSlot> {
        let mut slots = self
            .window_link_groups
            .values()
            .filter(|group| group.runtime_session_name == *session_name)
            .filter_map(|group| {
                group
                    .slots
                    .iter()
                    .filter(|slot| slot.session_name != *session_name)
                    .filter(|slot| {
                        self.sessions
                            .session(&slot.session_name)
                            .and_then(|session| session.window_at(slot.window_index))
                            .is_some()
                    })
                    .min_by(|left, right| {
                        left.session_name
                            .as_str()
                            .cmp(right.session_name.as_str())
                            .then_with(|| left.window_index.cmp(&right.window_index))
                    })
                    .cloned()
            })
            .collect::<Vec<_>>();
        slots.sort_by(|left, right| {
            left.session_name
                .as_str()
                .cmp(right.session_name.as_str())
                .then_with(|| left.window_index.cmp(&right.window_index))
        });
        slots
    }

    pub(in crate::pane_terminals) fn set_window_link_runtime_session_for_slot(
        &mut self,
        slot: &WindowLinkSlot,
        runtime_session_name: SessionName,
    ) {
        let Some(group_id) = self.window_link_slots.get(slot).copied() else {
            return;
        };
        if let Some(group) = self.window_link_groups.get_mut(&group_id) {
            group.runtime_session_name = runtime_session_name;
        }
    }

    pub(in crate::pane_terminals) fn remove_window_link_session_slots(
        &mut self,
        session_name: &SessionName,
    ) {
        let slots = self
            .window_link_slots
            .keys()
            .filter(|slot| slot.session_name == *session_name)
            .cloned()
            .collect::<Vec<_>>();
        for slot in slots {
            let _ = self.detach_window_link_slot(&slot.session_name, slot.window_index);
        }
    }

    pub(crate) fn synchronize_linked_window_from_slot(
        &mut self,
        session_name: &SessionName,
        window_index: u32,
    ) -> Result<(), TerminalError> {
        let source_slot = self.window_link_slot(session_name, window_index);
        let Some(group_id) = self
            .window_link_group_id_for_slot_or_group_peer(session_name, window_index)
            .copied()
        else {
            return Ok(());
        };
        let Some(group) = self.window_link_groups.get(&group_id).cloned() else {
            return Ok(());
        };
        if group.slots.len() <= 1 {
            return Ok(());
        }

        let source_window = self
            .sessions
            .session(session_name)
            .and_then(|session| session.window_at(window_index))
            .cloned()
            .ok_or_else(|| {
                TerminalError::invalid_target(
                    format!("{session_name}:{window_index}"),
                    "window index does not exist in session",
                )
            })?;

        for slot in group.slots {
            if slot == source_slot {
                continue;
            }
            self.sessions
                .session_mut(&slot.session_name)
                .ok_or_else(|| session_not_found(&slot.session_name))?
                .replace_window(slot.window_index, source_window.clone())?;
        }

        Ok(())
    }

    pub(crate) fn synchronize_linked_window_family_from_slot(
        &mut self,
        session_name: &SessionName,
        window_index: u32,
    ) -> Result<Vec<SessionName>, TerminalError> {
        let linked_slots = self.window_link_slots_for(session_name, window_index);
        self.synchronize_linked_window_from_slot(session_name, window_index)?;
        let mut synchronized = HashSet::new();
        for slot in linked_slots {
            if synchronized.insert(slot.session_name.clone()) {
                self.synchronize_session_group_from(&slot.session_name)?;
            }
        }
        Ok(self.window_linked_session_family_list(session_name, window_index))
    }

    fn auto_named_window_key(
        &self,
        session_name: &SessionName,
        window_index: u32,
    ) -> (SessionName, u32) {
        (self.runtime_session_name(session_name), window_index)
    }

    pub(crate) fn tracks_auto_named_window(
        &self,
        session_name: &SessionName,
        window_index: u32,
    ) -> bool {
        self.auto_named_windows
            .contains(&self.auto_named_window_key(session_name, window_index))
    }

    pub(crate) fn mark_auto_named_window(&mut self, session_name: &SessionName, window_index: u32) {
        let key = self.auto_named_window_key(session_name, window_index);
        let _ = self.auto_named_windows.insert(key);
    }

    pub(in crate::pane_terminals) fn clear_auto_named_window(
        &mut self,
        session_name: &SessionName,
        window_index: u32,
    ) {
        let key = self.auto_named_window_key(session_name, window_index);
        let _ = self.auto_named_windows.remove(&key);
    }

    pub(in crate::pane_terminals) fn clear_auto_named_window_family(
        &mut self,
        session_name: &SessionName,
        window_index: u32,
    ) {
        let linked_slots = self.window_link_slots_for(session_name, window_index);
        let mut slots = linked_slots.clone();
        for linked_slot in linked_slots {
            for member in self
                .sessions
                .session_group_members(&linked_slot.session_name)
            {
                slots.push(self.window_link_slot(&member, linked_slot.window_index));
            }
        }
        for slot in slots.into_iter().collect::<HashSet<_>>() {
            self.clear_auto_named_window(&slot.session_name, slot.window_index);
        }
    }
}

fn remapped_window_link_slot(
    slot: &WindowLinkSlot,
    session_name: &SessionName,
    index_map: &BTreeMap<u32, u32>,
) -> WindowLinkSlot {
    if &slot.session_name != session_name {
        return slot.clone();
    }
    WindowLinkSlot::new(
        slot.session_name.clone(),
        index_map
            .get(&slot.window_index)
            .copied()
            .unwrap_or(slot.window_index),
    )
}

fn renamed_window_link_slot(
    slot: &WindowLinkSlot,
    session_name: &SessionName,
    new_name: &SessionName,
) -> WindowLinkSlot {
    if &slot.session_name != session_name {
        return slot.clone();
    }
    WindowLinkSlot::new(new_name.clone(), slot.window_index)
}

fn rename_window_link_runtime_session(
    group: &mut WindowLinkGroup,
    session_name: &SessionName,
    new_name: &SessionName,
) {
    if group.runtime_session_name == *session_name {
        group.runtime_session_name = new_name.clone();
    }
}
