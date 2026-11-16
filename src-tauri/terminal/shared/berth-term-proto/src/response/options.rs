use serde::{Deserialize, Serialize};

use super::CommandOutput;
use crate::{OptionName, OptionScopeSelector, ScopeSelector, SetOptionMode};

/// Response payload for `set-option`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetOptionResponse {
    /// The applied scope.
    pub scope: ScopeSelector,
    /// The mutated option.
    pub option: OptionName,
    /// The mutation mode applied by the server.
    pub mode: SetOptionMode,
}

/// Response payload for string-based `set-option`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetOptionByNameResponse {
    /// The applied scope.
    pub scope: OptionScopeSelector,
    /// The canonical option name.
    pub name: String,
    /// The mutation mode applied by the server.
    pub mode: SetOptionMode,
}

/// Response payload for `show-options`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShowOptionsResponse {
    /// The selected option scope.
    pub scope: OptionScopeSelector,
    /// The pre-rendered stdout bytes for the CLI.
    pub output: CommandOutput,
}

impl ShowOptionsResponse {
    /// Returns the reusable stdout payload for the show command.
    #[must_use]
    pub fn command_output(&self) -> &CommandOutput {
        &self.output
    }
}
