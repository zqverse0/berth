use serde::{Deserialize, Serialize};

use crate::SessionName;

/// Response payload for `attach-session`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttachSessionResponse {
    /// The session prepared for attach upgrade.
    pub session_name: SessionName,
}

/// Response payload for `switch-client`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SwitchClientResponse {
    /// The session chosen for the client.
    pub session_name: SessionName,
}

/// Response payload for `detach-client`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DetachClientResponse;
