//! Project-scoped Agent session browsing domain.
//!
//! The Tauri command layer delegates cursor validation and native/DB identity
//! reconciliation here. Persistent indexing and provider discovery build on
//! this boundary without growing `commands/conversations.rs` further.

mod cursor;
mod discovery;
mod overview;
mod provider;
#[cfg(feature = "tauri-runtime")]
mod query;
mod reconcile;

pub(crate) use cursor::{
    clamp_project_agent_session_page_limit, ProjectAgentSessionCursor, ProjectAgentSessionDbCursor,
};
pub(crate) use discovery::forget_project_index;
pub(crate) use overview::session_group_link;
#[cfg(feature = "tauri-runtime")]
pub(crate) use overview::{project_session_overview, ProjectSessionOverview};
pub(crate) use provider::build_agent_parser;
#[cfg(feature = "tauri-runtime")]
pub(crate) use query::list_project_agent_sessions_core;
pub(crate) use reconcile::{reconcile_project_agent_session_page, ProjectAgentSessionDbIdentity};
#[cfg(test)]
mod tests {
    use chrono::{DateTime, TimeZone, Utc};

    use super::cursor::{ProjectAgentSessionCursorError, PROJECT_AGENT_SESSION_CURSOR_VERSION};
    use super::*;
    use berth_project_core::entities::conversation::ConversationKind;
    use crate::models::{
        AgentType, ConversationSummary, DbConversationSummary, ProjectAgentSessionSource,
    };

    fn at(second: i64) -> DateTime<Utc> {
        Utc.timestamp_opt(second, 0).single().unwrap()
    }

    fn native(id: &str, second: i64) -> ConversationSummary {
        ConversationSummary {
            id: id.into(),
            agent_type: AgentType::new("codex"),
            folder_path: Some("/repo".into()),
            folder_name: Some("repo".into()),
            title: Some(format!("native-{id}")),
            started_at: at(second),
            ended_at: None,
            message_count: 2,
            model: Some("native-model".into()),
            git_branch: None,
            parent_id: None,
            parent_tool_use_id: None,
            delegation_call_id: None,
        }
    }

    fn db(id: i32, external_id: Option<&str>, second: i64) -> DbConversationSummary {
        DbConversationSummary {
            id,
            folder_id: 7,
            title: Some(format!("db-{id}")),
            title_locked: false,
            agent_type: AgentType::new("codex"),
            kind: ConversationKind::Regular,
            model: Some("db-model".into()),
            git_branch: None,
            external_id: external_id.map(str::to_owned),
            message_count: 1,
            child_count: 0,
            created_at: at(second),
            updated_at: at(second),
            pinned_at: None,
            parent_id: None,
            parent_tool_use_id: None,
            delegation_call_id: None,
        }
    }

    #[test]
    fn cursor_round_trips_only_in_its_bound_scope() {
        let cursor = ProjectAgentSessionCursor::new(
            AgentType::new("codex"),
            "/repo/",
            Some("  Fix Me "),
            Some(ProjectAgentSessionDbCursor {
                updated_at: at(9),
                id: 3,
            }),
            false,
            Some("provider-cursor".into()),
            false,
        );
        let encoded = cursor.encode().unwrap();
        let decoded = ProjectAgentSessionCursor::decode_for_scope(
            &encoded,
            AgentType::new("codex"),
            "/repo",
            Some("fix me"),
        )
        .unwrap();
        assert_eq!(decoded, cursor);
        assert_eq!(
            ProjectAgentSessionCursor::decode_for_scope(
                &encoded,
                AgentType::new("claude_code"),
                "/repo",
                Some("fix me")
            ),
            Err(ProjectAgentSessionCursorError::ScopeMismatch)
        );
        assert_eq!(
            ProjectAgentSessionCursor::decode_for_scope(
                &encoded,
                AgentType::new("codex"),
                "/other",
                Some("fix me")
            ),
            Err(ProjectAgentSessionCursorError::ScopeMismatch)
        );
        assert_eq!(
            ProjectAgentSessionCursor::decode_for_scope(
                &encoded,
                AgentType::new("codex"),
                "/repo",
                Some("other")
            ),
            Err(ProjectAgentSessionCursorError::ScopeMismatch)
        );
    }

    #[test]
    fn cursor_rejects_malformed_and_unsupported_versions() {
        assert_eq!(
            ProjectAgentSessionCursor::decode_for_scope(
                "not-base64!",
                AgentType::new("codex"),
                "/repo",
                None
            ),
            Err(ProjectAgentSessionCursorError::Malformed)
        );
        let unsupported = ProjectAgentSessionCursor {
            version: PROJECT_AGENT_SESSION_CURSOR_VERSION + 1,
            agent_type: AgentType::new("codex"),
            normalized_project_path: "/repo".into(),
            normalized_search: None,
            db: None,
            db_complete: false,
            native: None,
            native_complete: false,
        }
        .encode()
        .unwrap();
        assert_eq!(
            ProjectAgentSessionCursor::decode_for_scope(
                &unsupported,
                AgentType::new("codex"),
                "/repo",
                None
            ),
            Err(ProjectAgentSessionCursorError::UnsupportedVersion(2))
        );
    }

    #[test]
    fn page_limit_is_server_clamped() {
        assert_eq!(clamp_project_agent_session_page_limit(None), 40);
        assert_eq!(clamp_project_agent_session_page_limit(Some(0)), 1);
        assert_eq!(clamp_project_agent_session_page_limit(Some(500)), 100);
    }

    #[test]
    fn reconciliation_merges_live_identity_and_preserves_manual_title() {
        let mut live = db(4, Some("s1"), 20);
        live.title = Some("manual".into());
        live.title_locked = true;
        let rows = reconcile_project_agent_session_page(
            vec![native("s1", 10)],
            vec![live.clone()],
            vec![ProjectAgentSessionDbIdentity {
                summary: live,
                deleted: false,
            }],
        );
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].source, ProjectAgentSessionSource::Both);
        assert_eq!(rows[0].conversation_id, Some(4));
        assert_eq!(rows[0].title.as_deref(), Some("manual"));
        assert_eq!(rows[0].source_available, Some(true));
    }

    #[test]
    fn reconciliation_suppresses_deleted_only_and_keeps_db_only_unknown() {
        let deleted = db(5, Some("gone"), 5);
        let db_only = db(6, Some("db-only"), 6);
        let rows = reconcile_project_agent_session_page(
            vec![native("gone", 7), native("new", 8)],
            vec![db_only],
            vec![ProjectAgentSessionDbIdentity {
                summary: deleted,
                deleted: true,
            }],
        );
        assert_eq!(rows.len(), 2);
        assert!(rows
            .iter()
            .all(|row| row.external_id.as_deref() != Some("gone")));
        let native_only = rows
            .iter()
            .find(|row| row.external_id.as_deref() == Some("new"))
            .unwrap();
        assert_eq!(native_only.source, ProjectAgentSessionSource::NativeOnly);
        let db_only = rows
            .iter()
            .find(|row| row.external_id.as_deref() == Some("db-only"))
            .unwrap();
        assert_eq!(db_only.source, ProjectAgentSessionSource::DatabaseOnly);
        assert_eq!(db_only.source_available, None);
    }

    #[test]
    fn reconciliation_deduplicates_identity_across_bounded_sources() {
        let older = db(1, Some("same"), 1);
        let newer = db(2, Some("same"), 2);
        let rows = reconcile_project_agent_session_page(
            vec![native("same", 3), native("same", 3)],
            vec![older.clone(), newer.clone()],
            vec![
                ProjectAgentSessionDbIdentity {
                    summary: older,
                    deleted: false,
                },
                ProjectAgentSessionDbIdentity {
                    summary: newer,
                    deleted: false,
                },
            ],
        );
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].conversation_id, Some(2));
    }
}
