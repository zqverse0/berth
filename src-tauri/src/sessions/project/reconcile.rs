use std::collections::{HashMap, HashSet};

use crate::models::{
    AgentType, ConversationSummary, DbConversationSummary, ProjectAgentSessionSource,
    ProjectAgentSessionSummary,
};

/// DB identity input for pure native/DB reconciliation. Deleted rows carry the
/// same summary projection so duplicate historical rows can be resolved without
/// teaching the reconciliation layer about SeaORM models.
#[derive(Debug, Clone)]
pub(crate) struct ProjectAgentSessionDbIdentity {
    pub summary: DbConversationSummary,
    pub deleted: bool,
}

/// Reconcile one independently bounded native page and DB page.
///
/// A bounded native page cannot prove that an arbitrary DB-only row has no
/// source elsewhere in the provider's remaining candidates. Such rows use
/// `source_available: None`; a targeted selection lookup is the boundary that
/// can truthfully turn this into `Some(false)`.
pub(crate) fn reconcile_project_agent_session_page(
    native_items: Vec<ConversationSummary>,
    db_page: Vec<DbConversationSummary>,
    identity_rows: Vec<ProjectAgentSessionDbIdentity>,
) -> Vec<ProjectAgentSessionSummary> {
    let mut live_by_identity: HashMap<(AgentType, String), DbConversationSummary> = HashMap::new();
    let mut deleted_only: HashSet<(AgentType, String)> = HashSet::new();

    for record in identity_rows {
        let Some(external_id) = record.summary.external_id.clone() else {
            continue;
        };
        let key = (record.summary.agent_type, external_id);
        if record.deleted {
            if !live_by_identity.contains_key(&key) {
                deleted_only.insert(key);
            }
            continue;
        }
        deleted_only.remove(&key);
        match live_by_identity.get(&key) {
            Some(existing) if !db_summary_is_newer(&record.summary, existing) => {}
            _ => {
                live_by_identity.insert(key, record.summary);
            }
        }
    }

    let mut rows = Vec::new();
    let mut emitted_conversation_ids = HashSet::new();
    let mut emitted_native_identities = HashSet::new();

    for native in native_items {
        let key = (native.agent_type, native.id.clone());
        if !emitted_native_identities.insert(key.clone()) {
            continue;
        }
        if deleted_only.contains(&key) && !live_by_identity.contains_key(&key) {
            continue;
        }

        let native_updated_at = native.ended_at.unwrap_or(native.started_at);
        if let Some(db) = live_by_identity.get(&key) {
            emitted_conversation_ids.insert(db.id);
            rows.push(ProjectAgentSessionSummary {
                agent_type: native.agent_type,
                external_id: Some(native.id),
                conversation_id: Some(db.id),
                conversation: Some(db.clone()),
                title: if db.title_locked {
                    db.title.clone()
                } else {
                    native.title.or_else(|| db.title.clone())
                },
                model: native.model.or_else(|| db.model.clone()),
                git_branch: native.git_branch.or_else(|| db.git_branch.clone()),
                message_count: native.message_count.max(db.message_count),
                started_at: native.started_at,
                updated_at: native_updated_at.max(db.updated_at),
                source: ProjectAgentSessionSource::Both,
                source_available: Some(true),
            });
        } else {
            rows.push(ProjectAgentSessionSummary {
                agent_type: native.agent_type,
                external_id: Some(native.id),
                conversation_id: None,
                conversation: None,
                title: native.title,
                model: native.model,
                git_branch: native.git_branch,
                message_count: native.message_count,
                started_at: native.started_at,
                updated_at: native_updated_at,
                source: ProjectAgentSessionSource::NativeOnly,
                source_available: Some(true),
            });
        }
    }

    let mut emitted_db_identities = HashSet::new();
    for db in db_page {
        if emitted_conversation_ids.contains(&db.id) {
            continue;
        }
        let identity = db
            .external_id
            .as_ref()
            .map(|external_id| (db.agent_type, external_id.clone()));
        if identity.as_ref().is_some_and(|key| {
            emitted_native_identities.contains(key) || !emitted_db_identities.insert(key.clone())
        }) {
            continue;
        }
        emitted_conversation_ids.insert(db.id);
        rows.push(ProjectAgentSessionSummary {
            agent_type: db.agent_type,
            external_id: db.external_id.clone(),
            conversation_id: Some(db.id),
            conversation: Some(db.clone()),
            title: db.title,
            model: db.model,
            git_branch: db.git_branch,
            message_count: db.message_count,
            started_at: db.created_at,
            updated_at: db.updated_at,
            source: ProjectAgentSessionSource::DatabaseOnly,
            source_available: None,
        });
    }

    rows.sort_by(|left, right| {
        right
            .updated_at
            .cmp(&left.updated_at)
            .then_with(|| identity_sort_key(left).cmp(&identity_sort_key(right)))
    });
    rows
}

fn db_summary_is_newer(left: &DbConversationSummary, right: &DbConversationSummary) -> bool {
    (left.updated_at, left.id) > (right.updated_at, right.id)
}

fn identity_sort_key(row: &ProjectAgentSessionSummary) -> (AgentType, String, i32) {
    (
        row.agent_type,
        row.external_id.clone().unwrap_or_default(),
        row.conversation_id.unwrap_or_default(),
    )
}
