use serde::de::{self, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};

use super::{compat_next_response_element, CommandOutput, CreatedPane};
use crate::SessionName;

/// Response payload for `new-session`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NewSessionResponse {
    /// The created session name.
    pub session_name: SessionName,
    /// Whether the server left the session detached.
    pub detached: bool,
    /// Optional printable output for `new-session -P`.
    #[serde(default)]
    pub output: Option<CommandOutput>,
    /// 本次真正创建的 pane；复用 session 或共享 group pane 时为 None。
    /// 装箱以让 `Response` 枚举保持紧凑（`Option<Box<_>>` 借非空指针占位仅 8 字节）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_pane: Option<Box<CreatedPane>>,
}

impl<'de> Deserialize<'de> for NewSessionResponse {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_struct(
            "NewSessionResponse",
            &["session_name", "detached", "output", "created_pane"],
            NewSessionResponseVisitor,
        )
    }
}

struct NewSessionResponseVisitor;

impl<'de> Visitor<'de> for NewSessionResponseVisitor {
    type Value = NewSessionResponse;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("a new-session response")
    }

    fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        let session_name = seq
            .next_element()?
            .ok_or_else(|| de::Error::invalid_length(0, &self))?;
        let detached = seq
            .next_element()?
            .ok_or_else(|| de::Error::invalid_length(1, &self))?;
        let output = seq
            .next_element()?
            .ok_or_else(|| de::Error::invalid_length(2, &self))?;
        // bincode 的旧回执在尾部直接 EOF，serde(default) 不能处理此情形。
        let created_pane = compat_next_response_element(&mut seq)?;
        Ok(NewSessionResponse {
            session_name,
            detached,
            output,
            created_pane,
        })
    }

    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut session_name = None;
        let mut detached = None;
        let mut output = None;
        let mut created_pane = None;
        while let Some(key) = map.next_key::<String>()? {
            match key.as_str() {
                "session_name" => session_name = Some(map.next_value()?),
                "detached" => detached = Some(map.next_value()?),
                "output" => output = map.next_value()?,
                "created_pane" => created_pane = map.next_value()?,
                _ => {
                    let _: de::IgnoredAny = map.next_value()?;
                }
            }
        }
        Ok(NewSessionResponse {
            session_name: session_name.ok_or_else(|| de::Error::missing_field("session_name"))?,
            detached: detached.ok_or_else(|| de::Error::missing_field("detached"))?,
            output,
            created_pane,
        })
    }
}

impl NewSessionResponse {
    /// Returns the optional printable session output.
    #[must_use]
    pub const fn command_output(&self) -> Option<&CommandOutput> {
        self.output.as_ref()
    }
}

/// Response payload for `has-session`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct HasSessionResponse {
    /// Whether the target session exists.
    pub exists: bool,
}

/// Response payload for `kill-session`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct KillSessionResponse {
    /// Whether a session existed and was removed.
    pub existed: bool,
}

/// Response payload for creating an app-owner session lease.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreateSessionLeaseResponse {
    /// Server-issued lease token.
    pub token: u64,
    /// Effective lease time-to-live in milliseconds.
    pub ttl_millis: u64,
}

/// Response payload for renewing an app-owner session lease.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct RenewSessionLeaseResponse {
    /// Whether the lease was renewed.
    pub renewed: bool,
}

/// Response payload for releasing an app-owner session lease.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReleaseSessionLeaseResponse {
    /// Whether a matching lease was released.
    pub released: bool,
}

/// Response payload for `rename-session`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RenameSessionResponse {
    /// The renamed session name after the operation succeeds.
    pub session_name: SessionName,
}

/// Response payload for `list-sessions`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ListSessionsResponse {
    /// The pre-rendered stdout bytes for the CLI.
    pub output: CommandOutput,
}

impl ListSessionsResponse {
    /// Returns the reusable stdout payload for the list command.
    #[must_use]
    pub fn command_output(&self) -> &CommandOutput {
        &self.output
    }
}
