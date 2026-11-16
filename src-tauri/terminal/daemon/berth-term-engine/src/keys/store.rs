use std::collections::BTreeMap;

use crate::command_parser::{
    parse_command_string, CommandArgument, CommandParseError, ParsedCommand, ParsedCommands,
};

use super::{defaults, key_string_lookup_string, strip_flags, KeyCode};

/// One bound key in a table.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyBinding {
    key: KeyCode,
    note: Option<String>,
    repeat: bool,
    commands: ParsedCommands,
}

impl KeyBinding {
    /// Returns the bound key code.
    #[must_use]
    pub const fn key(&self) -> KeyCode {
        self.key
    }

    /// Returns the optional binding note.
    #[must_use]
    pub fn note(&self) -> Option<&str> {
        self.note.as_deref()
    }

    /// Returns whether the binding repeats.
    #[must_use]
    pub const fn repeat(&self) -> bool {
        self.repeat
    }

    /// Returns the parsed tmux command list.
    #[must_use]
    pub const fn commands(&self) -> &ParsedCommands {
        &self.commands
    }
}

/// One key table.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyBindingTable {
    name: String,
    references: usize,
    active: BTreeMap<KeyCode, KeyBinding>,
    defaults: BTreeMap<KeyCode, KeyBinding>,
}

impl KeyBindingTable {
    /// Returns the table name.
    #[must_use]
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Returns the current reference count.
    #[must_use]
    pub const fn references(&self) -> usize {
        self.references
    }

    /// Returns the active binding tree.
    #[must_use]
    pub const fn active(&self) -> &BTreeMap<KeyCode, KeyBinding> {
        &self.active
    }

    /// Returns the default binding tree snapshot.
    #[must_use]
    pub const fn defaults(&self) -> &BTreeMap<KeyCode, KeyBinding> {
        &self.defaults
    }
}

/// A mutable table reference operation result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyBindingTableRef {
    name: String,
    created: bool,
}

impl KeyBindingTableRef {
    /// Returns the table name.
    #[must_use]
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Returns whether the table was created.
    #[must_use]
    pub const fn created(&self) -> bool {
        self.created
    }
}

/// Global key table store with tmux-style default snapshots.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyBindingStore {
    tables: BTreeMap<String, KeyBindingTable>,
}

impl Default for KeyBindingStore {
    fn default() -> Self {
        Self::with_defaults().expect("embedded default bindings must parse")
    }
}

impl KeyBindingStore {
    /// Creates an empty key store with no tables.
    #[must_use]
    pub fn new() -> Self {
        Self {
            tables: BTreeMap::new(),
        }
    }

    /// Creates a store populated with the frozen tmux default bindings.
    pub fn with_defaults() -> Result<Self, CommandParseError> {
        let mut store = Self::new();
        for default in defaults::DEFAULT_BINDING_STRINGS {
            let parsed = parse_command_string(default)?;
            for command in parsed.commands() {
                store.apply_parsed_default(command)?;
            }
        }
        store.snapshot_defaults();
        Ok(store)
    }

    /// Returns the named table, when present.
    #[must_use]
    pub fn table(&self, name: &str) -> Option<&KeyBindingTable> {
        self.tables.get(name)
    }

    /// Iterates every table in name order.
    pub fn tables(&self) -> impl Iterator<Item = &KeyBindingTable> {
        self.tables.values()
    }

    /// Finds or creates a table and increments its reference count.
    pub fn get_table(&mut self, name: &str, create: bool) -> Option<KeyBindingTableRef> {
        if let Some(table) = self.tables.get_mut(name) {
            table.references = table.references.saturating_add(1);
            return Some(KeyBindingTableRef {
                name: name.to_owned(),
                created: false,
            });
        }
        if !create {
            return None;
        }

        self.tables.insert(
            name.to_owned(),
            KeyBindingTable {
                name: name.to_owned(),
                references: 1,
                active: BTreeMap::new(),
                defaults: BTreeMap::new(),
            },
        );
        Some(KeyBindingTableRef {
            name: name.to_owned(),
            created: true,
        })
    }

    /// Drops one reference from a table and removes it if it is fully empty.
    pub fn unref_table(&mut self, name: &str) {
        let should_remove = if let Some(table) = self.tables.get_mut(name) {
            table.references = table.references.saturating_sub(1);
            table.references == 0 && table.active.is_empty() && table.defaults.is_empty()
        } else {
            false
        };
        if should_remove {
            self.tables.remove(name);
        }
    }

    /// Adds or updates a binding in a table.
    pub fn add_binding(
        &mut self,
        table_name: &str,
        key: KeyCode,
        note: Option<String>,
        repeat: bool,
        commands: Option<ParsedCommands>,
    ) -> bool {
        let table = self.ensure_table_mut(table_name);
        let key = strip_flags(key);
        if commands.is_none() {
            if let Some(binding) = table.active.get_mut(&key) {
                if let Some(note) = note {
                    binding.note = Some(note);
                }
                if repeat {
                    binding.repeat = true;
                }
                return true;
            }
            return false;
        }

        table.active.insert(
            key,
            KeyBinding {
                key,
                note,
                repeat,
                commands: commands.expect("checked commands presence"),
            },
        );
        true
    }

    /// Returns a binding from the active tree.
    #[must_use]
    pub fn get_binding(&self, table_name: &str, key: KeyCode) -> Option<&KeyBinding> {
        self.tables
            .get(table_name)
            .and_then(|table| table.active.get(&strip_flags(key)))
    }

    fn apply_parsed_default(&mut self, command: &ParsedCommand) -> Result<(), CommandParseError> {
        let (table, key, note, repeat, commands) = parse_bind_command(command)?;
        let _ = self.add_binding(&table, key, note, repeat, Some(commands));
        Ok(())
    }

    fn snapshot_defaults(&mut self) {
        for table in self.tables.values_mut() {
            if table.defaults.is_empty() {
                table.defaults = table.active.clone();
            }
        }
    }

    fn ensure_table_mut(&mut self, name: &str) -> &mut KeyBindingTable {
        self.tables
            .entry(name.to_owned())
            .or_insert_with(|| KeyBindingTable {
                name: name.to_owned(),
                references: 0,
                active: BTreeMap::new(),
                defaults: BTreeMap::new(),
            })
    }
}

fn parse_bind_command(
    command: &ParsedCommand,
) -> Result<(String, KeyCode, Option<String>, bool, ParsedCommands), CommandParseError> {
    let mut index = 0;
    let mut table_name: Option<String> = None;
    let mut note = None;
    let mut repeat = false;
    let arguments = command.arguments();

    while let Some(argument) = arguments.get(index) {
        let Some(value) = argument.as_string() else {
            break;
        };
        match value {
            "-T" => {
                index += 1;
                table_name = Some(
                    arguments
                        .get(index)
                        .and_then(|argument| argument.as_string())
                        .ok_or_else(|| CommandParseError::new(1, "bind-key missing -T key-table"))?
                        .to_owned(),
                );
            }
            _ if value.starts_with("-T") && value.len() > 2 => {
                table_name = Some(value[2..].to_owned());
            }
            "-n" => table_name = Some("root".to_owned()),
            "-N" => {
                index += 1;
                note = Some(
                    arguments
                        .get(index)
                        .and_then(|argument| argument.as_string())
                        .ok_or_else(|| CommandParseError::new(1, "bind-key missing -N note"))?
                        .to_owned(),
                );
            }
            _ if value.starts_with("-N") && value.len() > 2 => {
                note = Some(value[2..].to_owned());
            }
            "-r" => repeat = true,
            _ if value.starts_with('-') && value.len() > 1 => {
                return Err(CommandParseError::new(
                    1,
                    format!("unsupported default bind-key flag: {value}"),
                ));
            }
            _ => break,
        }
        index += 1;
    }

    let key_string = arguments
        .get(index)
        .and_then(|argument| argument.as_string())
        .ok_or_else(|| CommandParseError::new(1, "bind-key missing key"))?;
    index += 1;
    let key = key_string_lookup_string(key_string)
        .ok_or_else(|| CommandParseError::new(1, format!("unknown key: {key_string}")))?;

    let commands = match arguments.get(index) {
        Some(CommandArgument::Commands(commands)) => commands.clone(),
        Some(CommandArgument::String(command)) => parse_command_string(command)?,
        None => {
            return Err(CommandParseError::new(
                1,
                "default bind-key must include a command list",
            ))
        }
    };

    Ok((
        table_name.unwrap_or_else(|| "prefix".to_owned()),
        key,
        note,
        repeat,
        commands,
    ))
}
