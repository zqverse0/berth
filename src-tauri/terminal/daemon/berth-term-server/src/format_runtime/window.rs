use berth_term_engine::formats::{FormatVariable, FormatVariables};
use berth_term_engine::{AlertFlags, Window, WINLINK_ACTIVITY, WINLINK_BELL, WINLINK_SILENCE};
use berth_term_proto::SessionName;

use super::{bool_string, path, RuntimeFormatContext};

impl RuntimeFormatContext<'_> {
    pub(super) fn session_display_name(&self) -> Option<String> {
        self.session_path_value()
            .and_then(|path| path::readable_path_name(&path))
            .or_else(|| {
                let name = self.session_name()?.to_string();
                // Folder-scoped Berth sessions are numeric folder ids — keep them
                // readable when path context is missing.
                if !name.is_empty() && name.chars().all(|c| c.is_ascii_digit()) {
                    Some(format!("session {name}"))
                } else {
                    Some(name)
                }
            })
    }

    pub(super) fn window_display_name(&self) -> Option<String> {
        Some(readable_window_name(
            self.window_name().as_deref(),
            self.pane_current_command().as_deref(),
            self.pane_title().as_deref(),
        ))
    }

    pub(super) fn window_path(&self) -> Option<String> {
        self.session_path_value()
    }

    pub(super) fn window_cwd_name(&self) -> Option<String> {
        self.window_path()
            .as_deref()
            .and_then(path::readable_path_name)
    }

    pub(super) fn session_path_value(&self) -> Option<String> {
        self.pane_current_path()
            .or_else(|| self.environment_value_by_name("PWD"))
            .or_else(|| self.environment_value_by_name("HOME"))
            .filter(|path| !path.trim().is_empty())
    }

    pub(super) fn session_id(&self) -> Option<String> {
        self.session.map(|session| session.id().to_string())
    }

    pub(super) fn session_group_name(&self) -> Option<SessionName> {
        let session = self.session?;
        self.session_store
            .and_then(|store| store.session_group_name(session.name()).cloned())
            .or_else(|| session.group_name().cloned())
    }

    pub(super) fn session_group_members(&self) -> Vec<SessionName> {
        let Some(session) = self.session else {
            return Vec::new();
        };
        if self.session_group_name().is_none() {
            return Vec::new();
        }
        self.session_store
            .map(|store| store.session_group_members(session.name()))
            .unwrap_or_default()
    }

    pub(super) fn session_attached_count(&self) -> usize {
        self.base
            .format_value(FormatVariable::SessionAttached)
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(0)
    }

    pub(super) fn window_flags(&self) -> Option<String> {
        Some(self.printable_window_flags(true))
    }

    pub(super) fn window_linked(&self) -> Option<String> {
        let session_name = self.session_name()?;
        let window_index = self.window_index?;
        Some(bool_string(
            self.state?
                .window_link_count(session_name, window_index)
                .saturating_sub(1)
                > 0,
        ))
    }

    pub(super) fn window_linked_sessions(&self) -> Option<String> {
        let session_name = self.session_name()?;
        let window_index = self.window_index?;
        Some(
            self.state?
                .window_linked_session_count(session_name, window_index)
                .to_string(),
        )
    }

    pub(super) fn window_linked_sessions_list(&self) -> Option<String> {
        let session_name = self.session_name()?;
        let window_index = self.window_index?;
        Some(
            self.state?
                .window_linked_sessions_list(session_name, window_index)
                .into_iter()
                .map(|session_name| session_name.to_string())
                .collect::<Vec<_>>()
                .join(","),
        )
    }

    fn window_alert_flags(&self) -> AlertFlags {
        self.session
            .zip(self.window_index)
            .map(|(session, window_index)| session.winlink_alert_flags(window_index))
            .unwrap_or_else(AlertFlags::empty)
    }

    pub(super) fn printable_window_flags(&self, escape_activity: bool) -> String {
        let active = self
            .base
            .format_value(FormatVariable::WindowActive)
            .is_some_and(|value| value == "1");
        let last = self
            .base
            .format_value(FormatVariable::WindowLastFlag)
            .is_some_and(|value| value == "1");
        let zoomed = self.window.is_some_and(Window::is_zoomed);
        let alerts = self.window_alert_flags();

        let mut flags = String::new();
        if alerts.contains(WINLINK_ACTIVITY) {
            if escape_activity {
                flags.push_str("##");
            } else {
                flags.push('#');
            }
        }
        if alerts.contains(WINLINK_BELL) {
            flags.push('!');
        }
        if alerts.contains(WINLINK_SILENCE) {
            flags.push('~');
        }
        if active {
            flags.push('*');
        } else if last {
            flags.push('-');
        }
        if zoomed {
            flags.push('Z');
        }
        flags
    }

    pub(super) fn session_alert(&self) -> Option<String> {
        let session = self.session?;
        let flags = session.session_alert_flags();
        let mut value = String::new();
        if flags.contains(WINLINK_ACTIVITY) {
            value.push('#');
        }
        if flags.contains(WINLINK_BELL) {
            value.push('!');
        }
        if flags.contains(WINLINK_SILENCE) {
            value.push('~');
        }
        Some(value)
    }

    pub(super) fn session_alerts(&self) -> Option<String> {
        let session = self.session?;
        let alerts = session
            .alerted_window_indexes()
            .into_iter()
            .filter_map(|window_index| {
                let flags = session.winlink_alert_flags(window_index);
                if flags.is_empty() {
                    return None;
                }

                let mut value = window_index.to_string();
                if flags.contains(WINLINK_ACTIVITY) {
                    value.push('#');
                }
                if flags.contains(WINLINK_BELL) {
                    value.push('!');
                }
                if flags.contains(WINLINK_SILENCE) {
                    value.push('~');
                }
                Some(value)
            })
            .collect::<Vec<_>>();
        Some(alerts.join(","))
    }

    pub(super) fn session_flag(&self, flag: AlertFlags) -> Option<String> {
        self.session
            .map(|session| bool_string(session.session_alert_flags().contains(flag)))
    }

    pub(super) fn window_flag(&self, flag: AlertFlags) -> Option<String> {
        self.window_index
            .map(|_| bool_string(self.window_alert_flags().contains(flag)))
    }
}

fn readable_window_name(name: Option<&str>, command: Option<&str>, title: Option<&str>) -> String {
    let name = name.filter(|value| !value.trim().is_empty());
    let command = command
        .filter(|value| !value.trim().is_empty())
        .map(short_process_name);
    let title = title
        .filter(|value| !value.trim().is_empty())
        .filter(|value| !looks_like_berth_terminal_id(value));

    if name.is_some_and(looks_like_berth_terminal_id) {
        return command
            .or_else(|| title.map(str::to_owned))
            .or_else(|| name.map(str::to_owned))
            .unwrap_or_else(|| "Terminal".to_owned());
    }

    name.map(str::to_owned)
        .or(command)
        .or_else(|| title.map(str::to_owned))
        .unwrap_or_else(|| "Terminal".to_owned())
}

fn short_process_name(value: &str) -> String {
    let trimmed = value.trim().trim_matches('"').trim_matches('\'');
    trimmed
        .rsplit(['/', '\\'])
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or(trimmed)
        .to_owned()
}

fn looks_like_berth_terminal_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    (bytes.len() == 36
        && [8, 13, 18, 23]
            .into_iter()
            .all(|index| bytes.get(index) == Some(&b'-'))
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| [8, 13, 18, 23].contains(&index) || byte.is_ascii_hexdigit()))
        || (bytes.len() == 32 && bytes.iter().all(u8::is_ascii_hexdigit))
}

#[cfg(test)]
mod tests {
    use super::{looks_like_berth_terminal_id, readable_window_name};

    #[test]
    fn recognizes_uuid_like_terminal_names_without_hiding_normal_names() {
        assert!(looks_like_berth_terminal_id(
            "123e4567-e89b-12d3-a456-426614174000"
        ));
        assert!(looks_like_berth_terminal_id(
            "123e4567e89b12d3a456426614174000"
        ));
        assert!(!looks_like_berth_terminal_id("logs"));
        assert!(!looks_like_berth_terminal_id(
            "123e4567-e89b-12d3-a456-42661417400z"
        ));
    }

    #[test]
    fn window_display_name_prefers_command_for_terminal_ids_and_keeps_renames() {
        assert_eq!(
            readable_window_name(
                Some("123e4567-e89b-12d3-a456-426614174000"),
                Some("/usr/bin/zsh"),
                Some("shell title")
            ),
            "zsh"
        );
        assert_eq!(
            readable_window_name(Some("logs"), Some("bash"), Some("shell title")),
            "logs"
        );
        assert_eq!(
            readable_window_name(Some(""), Some(""), Some("title")),
            "title"
        );
        assert_eq!(readable_window_name(None, None, None), "Terminal");
        assert_eq!(
            readable_window_name(
                Some("123e4567-e89b-12d3-a456-426614174000"),
                None,
                Some("123e4567-e89b-12d3-a456-426614174000")
            ),
            "123e4567-e89b-12d3-a456-426614174000"
        );
    }
}
