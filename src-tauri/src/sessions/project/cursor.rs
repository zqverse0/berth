use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::models::AgentType;
use crate::sessions::normalize_path_for_matching;

pub(crate) const PROJECT_AGENT_SESSION_CURSOR_VERSION: u8 = 1;
pub(crate) const DEFAULT_PROJECT_AGENT_SESSION_PAGE_LIMIT: u32 = 40;
pub(crate) const MAX_PROJECT_AGENT_SESSION_PAGE_LIMIT: u32 = 100;

pub(crate) fn clamp_project_agent_session_page_limit(limit: Option<u32>) -> u32 {
    limit
        .unwrap_or(DEFAULT_PROJECT_AGENT_SESSION_PAGE_LIMIT)
        .clamp(1, MAX_PROJECT_AGENT_SESSION_PAGE_LIMIT)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct ProjectAgentSessionDbCursor {
    pub updated_at: DateTime<Utc>,
    pub id: i32,
}

/// Versioned cursor envelope shared by the independently bounded DB and native
/// sources. It is intentionally serialized as an opaque base64url token at the
/// transport boundary; clients must never inspect or synthesize its fields.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct ProjectAgentSessionCursor {
    pub(super) version: u8,
    pub(super) agent_type: AgentType,
    pub(super) normalized_project_path: String,
    pub(super) normalized_search: Option<String>,
    pub db: Option<ProjectAgentSessionDbCursor>,
    pub db_complete: bool,
    /// Provider-owned cursor payload. Parser adapters version and validate the
    /// inner value; this envelope only binds it to the request scope.
    pub native: Option<String>,
    pub native_complete: bool,
}

impl ProjectAgentSessionCursor {
    pub(crate) fn new(
        agent_type: AgentType,
        project_path: &str,
        search: Option<&str>,
        db: Option<ProjectAgentSessionDbCursor>,
        db_complete: bool,
        native: Option<String>,
        native_complete: bool,
    ) -> Self {
        Self {
            version: PROJECT_AGENT_SESSION_CURSOR_VERSION,
            agent_type,
            normalized_project_path: normalize_path_for_matching(project_path),
            normalized_search: normalize_search(search),
            db,
            db_complete,
            native,
            native_complete,
        }
    }

    pub(crate) fn encode(&self) -> Result<String, ProjectAgentSessionCursorError> {
        let bytes = serde_json::to_vec(self)
            .map_err(|error| ProjectAgentSessionCursorError::Encode(error.to_string()))?;
        Ok(URL_SAFE_NO_PAD.encode(bytes))
    }

    pub(crate) fn decode_for_scope(
        encoded: &str,
        agent_type: AgentType,
        project_path: &str,
        search: Option<&str>,
    ) -> Result<Self, ProjectAgentSessionCursorError> {
        let bytes = URL_SAFE_NO_PAD
            .decode(encoded)
            .map_err(|_| ProjectAgentSessionCursorError::Malformed)?;
        let cursor: Self = serde_json::from_slice(&bytes)
            .map_err(|_| ProjectAgentSessionCursorError::Malformed)?;
        if cursor.version != PROJECT_AGENT_SESSION_CURSOR_VERSION {
            return Err(ProjectAgentSessionCursorError::UnsupportedVersion(
                cursor.version,
            ));
        }
        if cursor.agent_type != agent_type
            || cursor.normalized_project_path != normalize_path_for_matching(project_path)
            || cursor.normalized_search != normalize_search(search)
        {
            return Err(ProjectAgentSessionCursorError::ScopeMismatch);
        }
        Ok(cursor)
    }
}

fn normalize_search(search: Option<&str>) -> Option<String> {
    search
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_lowercase())
}

#[derive(Debug, Error, PartialEq, Eq)]
pub(crate) enum ProjectAgentSessionCursorError {
    #[error("project Agent session cursor is malformed")]
    Malformed,
    #[error("project Agent session cursor version {0} is unsupported")]
    UnsupportedVersion(u8),
    #[error("project Agent session cursor does not belong to this request scope")]
    ScopeMismatch,
    #[error("failed to encode project Agent session cursor: {0}")]
    Encode(String),
}
