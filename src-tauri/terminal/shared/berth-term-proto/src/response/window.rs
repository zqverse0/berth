use serde::de::{self, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};

use super::{compat_next_response_element, CommandOutput, CreatedPane};
use crate::{LayoutName, SessionName, TerminalSize, WindowTarget};

/// Response payload for `new-window`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NewWindowResponse {
    /// The newly created window target.
    pub target: WindowTarget,
    /// 本次真正创建的初始 pane 身份；旧 daemon 的回执缺失此字段。
    /// 装箱以让 `Response` 枚举保持紧凑（`Option<Box<_>>` 借非空指针占位仅 8 字节）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_pane: Option<Box<CreatedPane>>,
}

impl<'de> Deserialize<'de> for NewWindowResponse {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_struct(
            "NewWindowResponse",
            &["target", "created_pane"],
            NewWindowResponseVisitor,
        )
    }
}

struct NewWindowResponseVisitor;

impl<'de> Visitor<'de> for NewWindowResponseVisitor {
    type Value = NewWindowResponse;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("a new-window response")
    }

    fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        let target = seq
            .next_element()?
            .ok_or_else(|| de::Error::invalid_length(0, &self))?;
        let created_pane = compat_next_response_element(&mut seq)?;
        Ok(NewWindowResponse {
            target,
            created_pane,
        })
    }

    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut target = None;
        let mut created_pane = None;
        while let Some(key) = map.next_key::<String>()? {
            match key.as_str() {
                "target" => target = Some(map.next_value()?),
                "created_pane" => created_pane = map.next_value()?,
                _ => {
                    let _: de::IgnoredAny = map.next_value()?;
                }
            }
        }
        Ok(NewWindowResponse {
            target: target.ok_or_else(|| de::Error::missing_field("target"))?,
            created_pane,
        })
    }
}

/// Response payload for `kill-window`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KillWindowResponse {
    /// The surviving active window after the kill completes.
    pub target: WindowTarget,
}

/// Response payload for `select-window`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SelectWindowResponse {
    /// The window that became active.
    pub target: WindowTarget,
}

/// Response payload for `rename-window`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RenameWindowResponse {
    /// The renamed window target.
    pub target: WindowTarget,
}

/// Response payload for `next-window`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NextWindowResponse {
    /// The window that became active.
    pub target: WindowTarget,
}

/// Response payload for `previous-window`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PreviousWindowResponse {
    /// The window that became active.
    pub target: WindowTarget,
}

/// Response payload for `last-window`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LastWindowResponse {
    /// The window that became active.
    pub target: WindowTarget,
}

/// Structured list-windows entry data paired with rendered stdout.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WindowListEntry {
    /// The exact window target for the entry.
    pub target: WindowTarget,
    /// The stable tmux-style window identifier such as `@3`.
    pub window_id: String,
    /// The user-visible window name when one exists.
    pub name: Option<String>,
    /// The number of panes in the window.
    pub pane_count: u32,
    /// The current window dimensions.
    pub size: TerminalSize,
    /// The active layout recorded for the window.
    pub layout: LayoutName,
    /// Whether the window is currently active in the session.
    pub active: bool,
    /// Whether the window is the session's last-active window.
    pub last: bool,
    /// The exact rendered line contributed to command stdout.
    pub rendered: String,
}

/// Response payload for `list-windows`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ListWindowsResponse {
    /// The structured window data emitted by the server.
    pub windows: Vec<WindowListEntry>,
    /// The pre-rendered stdout bytes for the CLI.
    pub output: CommandOutput,
}

impl ListWindowsResponse {
    /// Returns the reusable stdout payload for the list command.
    #[must_use]
    pub fn command_output(&self) -> &CommandOutput {
        &self.output
    }
}

/// Response payload for `link-window`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LinkWindowResponse {
    /// The linked destination slot.
    pub target: WindowTarget,
}

/// Response payload for `move-window`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MoveWindowResponse {
    /// The session affected by the operation.
    pub session_name: SessionName,
    /// The moved window target when one specific window was relocated.
    pub target: Option<WindowTarget>,
}

/// Response payload for `swap-window`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SwapWindowResponse {
    /// The source slot involved in the swap.
    pub source: WindowTarget,
    /// The target slot involved in the swap.
    pub target: WindowTarget,
}

/// Response payload for `rotate-window`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RotateWindowResponse {
    /// The window whose pane positions were rotated.
    pub target: WindowTarget,
}

/// Response payload for `resize-window`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResizeWindowResponse {
    /// The resized window target.
    pub target: WindowTarget,
}

/// Response payload for `respawn-window`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RespawnWindowResponse {
    /// The respawned window target.
    pub target: WindowTarget,
}

/// Response payload for `unlink-window`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UnlinkWindowResponse {
    /// The surviving active window after the unlink completes.
    pub target: WindowTarget,
}
