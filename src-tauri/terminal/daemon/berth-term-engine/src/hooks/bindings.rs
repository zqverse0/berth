use std::collections::{BTreeMap, HashMap};

use berth_term_proto::{HookLifecycle, HookName};

use super::types::{HookDispatch, HookSetOptions};

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(super) struct HookBindings {
    hooks: HashMap<HookName, HookArray>,
}

impl HookBindings {
    pub(super) fn is_empty(&self) -> bool {
        self.hooks.is_empty()
    }

    pub(super) fn set(
        &mut self,
        hook: HookName,
        command: String,
        lifecycle: HookLifecycle,
        options: HookSetOptions,
    ) -> u32 {
        let array = self.hooks.entry(hook).or_default();
        let registered = RegisteredHook { command, lifecycle };
        array.set(registered, options)
    }

    pub(super) fn unset(&mut self, hook: HookName, index: Option<u32>) {
        let remove_hook = if let Some(array) = self.hooks.get_mut(&hook) {
            array.unset(index);
            array.is_empty()
        } else {
            false
        };
        if remove_hook {
            self.hooks.remove(&hook);
        }
    }

    pub(super) fn dispatch(&mut self, hook: HookName) -> Vec<HookDispatch> {
        let (dispatches, remove_hook) = if let Some(array) = self.hooks.get_mut(&hook) {
            let dispatches = array.dispatch();
            let should_remove = array.is_empty();
            (dispatches, should_remove)
        } else {
            (Vec::new(), false)
        };
        if remove_hook {
            self.hooks.remove(&hook);
        }
        dispatches
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
struct HookArray {
    entries: BTreeMap<u32, RegisteredHook>,
}

impl HookArray {
    fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    fn set(&mut self, registered: RegisteredHook, options: HookSetOptions) -> u32 {
        match (options.append, options.index) {
            (true, None) => {
                let index = self.next_index();
                self.entries.insert(index, registered);
                index
            }
            (true, Some(index)) | (false, Some(index)) => {
                self.entries.insert(index, registered);
                index
            }
            (false, None) => {
                self.entries.clear();
                self.entries.insert(0, registered);
                0
            }
        }
    }

    fn unset(&mut self, index: Option<u32>) {
        match index {
            Some(index) => {
                self.entries.remove(&index);
            }
            None => self.entries.clear(),
        }
    }

    fn dispatch(&mut self) -> Vec<HookDispatch> {
        let mut dispatches = Vec::with_capacity(self.entries.len());
        let mut one_shots = Vec::new();

        for (index, registered) in &self.entries {
            dispatches.push(HookDispatch {
                command: registered.command.clone(),
                lifecycle: registered.lifecycle,
            });
            if registered.lifecycle == HookLifecycle::OneShot {
                one_shots.push(*index);
            }
        }

        for index in one_shots {
            self.entries.remove(&index);
        }

        dispatches
    }

    fn next_index(&self) -> u32 {
        match self.entries.keys().next_back() {
            None => 0,
            Some(&max_key) => {
                if let Some(next) = max_key.checked_add(1) {
                    return next;
                }
                // Max key is u32::MAX - scan for the first unused index.
                (0..u32::MAX)
                    .find(|index| !self.entries.contains_key(index))
                    .unwrap_or(u32::MAX)
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RegisteredHook {
    command: String,
    lifecycle: HookLifecycle,
}
