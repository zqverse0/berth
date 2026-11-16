use serde::{Deserialize, Serialize};

/// Response payload for `kill-server`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct KillServerResponse;
