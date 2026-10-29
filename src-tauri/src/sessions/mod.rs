//! Unified declarative Agent session domain.
//!
//! This module owns session readers and project-scoped session discovery. Tauri
//! commands and database services remain adapters around this interface.

pub(crate) mod declarative;
mod project;
mod reader;
mod scan_diagnostics;

#[cfg(feature = "tauri-runtime")]
pub(crate) use project::{
    list_project_agent_sessions_core, project_session_overview, ProjectSessionOverview,
};
pub(crate) use project::{
    build_agent_parser, session_group_link, forget_project_index, ProjectAgentSessionDbCursor,
    ProjectAgentSessionDbIdentity,
};
pub(crate) use reader::*;
