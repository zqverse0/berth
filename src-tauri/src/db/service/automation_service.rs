//! TUI automation persistence and cron math. Legacy ACP config blobs are never
//! returned as runnable definitions.

use std::str::FromStr;

use chrono::{DateTime, Utc};
use chrono_tz::Tz;
use cron::Schedule;
use sea_orm::{
    ActiveModelTrait, ActiveValue::NotSet, ColumnTrait, DatabaseConnection, EntityTrait,
    IntoActiveModel, QueryFilter, QueryOrder, QuerySelect, Set, TransactionTrait,
};
use serde::{Deserialize, Serialize};

use berth_project_core::entities::automation::{self, IsolationMode, TriggerKind};
use berth_project_core::entities::automation_run::{self, AutomationRunStatus};
use berth_project_core::error::DbError;

pub const TUI_CONFIG_SCHEMA: &str = "tui_terminal_v1";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TuiAutomationConfig {
    pub schema: String,
    /// 任务定时：补充说明，可空；提示词由任务生成。
    pub prompt: String,
    /// 挂在哪个任务上（任务名）；没有的是旧的独立自动化，不再触发。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationDraft {
    pub name: String,
    pub enabled: bool,
    pub cron: String,
    pub timezone: String,
    pub agent_id: String,
    pub folder_id: i32,
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub task: Option<String>,
    #[serde(default = "default_grace")]
    pub missed_run_grace_minutes: i32,
}

fn default_grace() -> i32 {
    720
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationInfo {
    pub id: i32,
    pub name: String,
    pub enabled: bool,
    pub cron: String,
    pub timezone: String,
    pub next_run_at: Option<DateTime<Utc>>,
    pub last_run_at: Option<DateTime<Utc>>,
    pub last_run_status: Option<String>,
    pub agent_id: String,
    pub folder_id: i32,
    pub prompt: String,
    pub task: Option<String>,
    pub missed_run_grace_minutes: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRunInfo {
    pub id: i32,
    pub automation_id: i32,
    pub status: AutomationRunStatus,
    pub trigger: String,
    pub scheduled_for: Option<DateTime<Utc>>,
    pub terminal_id: Option<String>,
    pub ended_at: Option<DateTime<Utc>>,
    pub error: Option<String>,
    pub stop_reason: Option<String>,
    pub summary: Option<String>,
    pub reviewed_at: Option<DateTime<Utc>>,
    pub result_path: Option<String>,
    pub created_at: DateTime<Utc>,
}

fn to_run_info(r: automation_run::Model) -> AutomationRunInfo {
    AutomationRunInfo {
        id: r.id,
        automation_id: r.automation_id,
        status: r.status,
        trigger: r.trigger,
        scheduled_for: r.scheduled_for,
        terminal_id: r.terminal_id,
        ended_at: r.ended_at,
        error: r.error,
        stop_reason: r.stop_reason,
        summary: r.summary,
        reviewed_at: r.reviewed_at,
        result_path: r.result_path,
        created_at: r.created_at,
    }
}

fn remap_dow(field: &str) -> Result<String, DbError> {
    if field == "*" || field.chars().any(|c| c.is_ascii_alphabetic()) {
        return Ok(field.to_string());
    }
    let invalid = || DbError::Validation(format!("invalid cron day-of-week field '{field}'"));
    let mut days = Vec::new();
    for token in field.split(',') {
        let (lo, hi) = if let Some((a, b)) = token.split_once('-') {
            (
                a.parse::<u32>().map_err(|_| invalid())?,
                b.parse::<u32>().map_err(|_| invalid())?,
            )
        } else {
            let day = token.parse::<u32>().map_err(|_| invalid())?;
            (day, day)
        };
        if lo > hi || hi > 7 {
            return Err(invalid());
        }
        days.extend((lo..=hi).map(|day| (day % 7) + 1));
    }
    days.sort_unstable();
    days.dedup();
    Ok(days
        .into_iter()
        .map(|d| d.to_string())
        .collect::<Vec<_>>()
        .join(","))
}

fn normalize_cron(expr: &str) -> Result<String, DbError> {
    let fields = expr.split_whitespace().collect::<Vec<_>>();
    if fields.len() != 5 {
        return Err(DbError::Validation(format!(
            "cron must have 5 fields, got {}",
            fields.len()
        )));
    }
    Ok(format!(
        "0 {} {} {} {} {}",
        fields[0],
        fields[1],
        fields[2],
        fields[3],
        remap_dow(fields[4])?
    ))
}

pub fn compute_next_run(
    expr: &str,
    timezone: &str,
    after: DateTime<Utc>,
) -> Result<Option<DateTime<Utc>>, DbError> {
    let schedule = Schedule::from_str(&normalize_cron(expr)?)
        .map_err(|e| DbError::Validation(format!("invalid cron '{expr}': {e}")))?;
    let tz: Tz = timezone
        .parse()
        .map_err(|_| DbError::Validation(format!("invalid timezone '{timezone}'")))?;
    Ok(schedule
        .after(&after.with_timezone(&tz))
        .next()
        .map(|dt| dt.with_timezone(&Utc)))
}

pub fn config(model: &automation::Model) -> Option<TuiAutomationConfig> {
    serde_json::from_str::<TuiAutomationConfig>(&model.config)
        .ok()
        .filter(|c| c.schema == TUI_CONFIG_SCHEMA)
}

fn to_info(model: automation::Model) -> Option<AutomationInfo> {
    let cfg = config(&model)?;
    Some(AutomationInfo {
        id: model.id,
        name: model.name,
        enabled: model.enabled,
        cron: model.cron.unwrap_or_default(),
        timezone: model.timezone,
        next_run_at: model.next_run_at,
        last_run_at: model.last_run_at,
        last_run_status: model.last_run_status,
        agent_id: model.agent_type,
        folder_id: model.root_folder_id?,
        prompt: cfg.prompt,
        task: cfg.task,
        missed_run_grace_minutes: model.missed_run_grace_minutes,
    })
}

fn validate(draft: &AutomationDraft) -> Result<(), DbError> {
    let task = draft
        .task
        .as_deref()
        .is_some_and(|task| !task.trim().is_empty());
    if draft.name.trim().is_empty()
        || (!task && draft.prompt.trim().is_empty())
        || draft.agent_id.trim().is_empty()
    {
        return Err(DbError::Validation(
            "name, agent and a task or prompt are required".into(),
        ));
    }
    if draft.missed_run_grace_minutes < 0 {
        return Err(DbError::Validation(
            "missed run grace must be non-negative".into(),
        ));
    }
    compute_next_run(&draft.cron, &draft.timezone, Utc::now())?;
    Ok(())
}

pub async fn list(
    conn: &DatabaseConnection,
    folder_id: i32,
) -> Result<Vec<AutomationInfo>, DbError> {
    let rows = automation::Entity::find()
        .filter(automation::Column::RootFolderId.eq(folder_id))
        .filter(automation::Column::DeletedAt.is_null())
        .order_by_desc(automation::Column::UpdatedAt)
        .all(conn)
        .await?;
    Ok(rows.into_iter().filter_map(to_info).collect())
}

pub async fn get_model(conn: &DatabaseConnection, id: i32) -> Result<automation::Model, DbError> {
    let row = automation::Entity::find_by_id(id)
        .filter(automation::Column::DeletedAt.is_null())
        .one(conn)
        .await?
        .ok_or_else(|| DbError::NotFound(format!("automation {id}")))?;
    if config(&row).is_none() {
        return Err(DbError::Validation(
            "legacy ACP automation cannot run as a TUI automation".into(),
        ));
    }
    Ok(row)
}

pub async fn create(
    conn: &DatabaseConnection,
    draft: AutomationDraft,
) -> Result<AutomationInfo, DbError> {
    validate(&draft)?;
    let now = Utc::now();
    let next = if draft.enabled {
        compute_next_run(&draft.cron, &draft.timezone, now)?
    } else {
        None
    };
    let config = serde_json::to_string(&TuiAutomationConfig {
        schema: TUI_CONFIG_SCHEMA.into(),
        prompt: draft.prompt,
        task: draft.task,
    })
    .map_err(|e| DbError::Validation(e.to_string()))?;
    let row = automation::ActiveModel {
        id: NotSet,
        name: Set(draft.name.trim().into()),
        enabled: Set(draft.enabled),
        trigger_kind: Set(TriggerKind::Schedule),
        cron: Set(Some(draft.cron)),
        timezone: Set(draft.timezone),
        next_run_at: Set(next),
        agent_type: Set(draft.agent_id),
        root_folder_id: Set(Some(draft.folder_id)),
        isolation: Set(IsolationMode::SharedInRoot),
        branch: Set(None),
        is_remote_branch: Set(false),
        config: Set(config),
        last_run_at: Set(None),
        last_run_status: Set(None),
        last_run_conversation_id: Set(None),
        unseen_failures: Set(0),
        missed_run_grace_minutes: Set(draft.missed_run_grace_minutes),
        created_at: Set(now),
        updated_at: Set(now),
        deleted_at: Set(None),
    }
    .insert(conn)
    .await?;
    to_info(row).ok_or_else(|| DbError::Validation("invalid TUI automation config".into()))
}

pub async fn update(
    conn: &DatabaseConnection,
    id: i32,
    draft: AutomationDraft,
) -> Result<AutomationInfo, DbError> {
    validate(&draft)?;
    let row = get_model(conn, id).await?;
    if row.root_folder_id != Some(draft.folder_id) {
        return Err(DbError::Validation(
            "automation belongs to another folder".into(),
        ));
    }
    let now = Utc::now();
    let next = if draft.enabled {
        compute_next_run(&draft.cron, &draft.timezone, now)?
    } else {
        None
    };
    let mut active = row.into_active_model();
    active.name = Set(draft.name.trim().into());
    active.enabled = Set(draft.enabled);
    active.cron = Set(Some(draft.cron));
    active.timezone = Set(draft.timezone);
    active.next_run_at = Set(next);
    active.agent_type = Set(draft.agent_id);
    active.config = Set(serde_json::to_string(&TuiAutomationConfig {
        schema: TUI_CONFIG_SCHEMA.into(),
        prompt: draft.prompt,
        task: draft.task,
    })
    .map_err(|e| DbError::Validation(e.to_string()))?);
    active.missed_run_grace_minutes = Set(draft.missed_run_grace_minutes);
    active.updated_at = Set(now);
    to_info(active.update(conn).await?)
        .ok_or_else(|| DbError::Validation("invalid TUI automation config".into()))
}

/// 停用：任务归档后定时随之结束。
pub async fn disable(conn: &DatabaseConnection, row: automation::Model) -> Result<(), DbError> {
    let mut active = row.into_active_model();
    active.enabled = Set(false);
    active.next_run_at = Set(None);
    active.updated_at = Set(Utc::now());
    active.update(conn).await?;
    Ok(())
}

pub async fn delete(conn: &DatabaseConnection, id: i32) -> Result<(), DbError> {
    let mut active = get_model(conn, id).await?.into_active_model();
    active.enabled = Set(false);
    active.next_run_at = Set(None);
    active.deleted_at = Set(Some(Utc::now()));
    active.update(conn).await?;
    Ok(())
}

pub async fn list_runs(
    conn: &DatabaseConnection,
    id: i32,
) -> Result<Vec<AutomationRunInfo>, DbError> {
    let rows = automation_run::Entity::find()
        .filter(automation_run::Column::AutomationId.eq(id))
        .order_by_desc(automation_run::Column::CreatedAt)
        .limit(50)
        .all(conn)
        .await?;
    Ok(rows.into_iter().map(to_run_info).collect())
}

pub async fn list_active_runs(
    conn: &DatabaseConnection,
) -> Result<Vec<automation_run::Model>, DbError> {
    Ok(automation_run::Entity::find()
        .filter(automation_run::Column::Status.eq(AutomationRunStatus::Running))
        .all(conn)
        .await?)
}

pub async fn due(
    conn: &DatabaseConnection,
    now: DateTime<Utc>,
) -> Result<Vec<automation::Model>, DbError> {
    let rows = automation::Entity::find()
        .filter(automation::Column::Enabled.eq(true))
        .filter(automation::Column::DeletedAt.is_null())
        .filter(automation::Column::NextRunAt.lte(now))
        .all(conn)
        .await?;
    // 只有挂在任务上的才触发；旧的独立自动化停用（自动化已并入任务）。
    Ok(rows
        .into_iter()
        .filter(|r| config(r).is_some_and(|c| c.task.is_some()))
        .collect())
}

/// 最近的下次执行时间;deadline 驱动调度的休眠依据,零启用计划时返回 None。
pub async fn next_deadline(
    conn: &DatabaseConnection,
    now: DateTime<Utc>,
) -> Result<Option<DateTime<Utc>>, DbError> {
    let row = automation::Entity::find()
        .filter(automation::Column::Enabled.eq(true))
        .filter(automation::Column::DeletedAt.is_null())
        .filter(automation::Column::NextRunAt.gt(now))
        .order_by_asc(automation::Column::NextRunAt)
        .one(conn)
        .await?;
    Ok(row.and_then(|model| model.next_run_at))
}

pub async fn claim_run(
    conn: &DatabaseConnection,
    automation_id: i32,
    trigger: &str,
    scheduled_for: Option<DateTime<Utc>>,
) -> Result<automation_run::Model, DbError> {
    let now = Utc::now();
    automation_run::ActiveModel {
        id: NotSet,
        automation_id: Set(automation_id),
        status: Set(AutomationRunStatus::Running),
        trigger: Set(trigger.into()),
        scheduled_for: Set(scheduled_for),
        started_at: Set(Some(now)),
        ended_at: Set(None),
        conversation_id: Set(None),
        connection_id: Set(None),
        worktree_folder_id: Set(None),
        terminal_id: Set(None),
        stop_reason: Set(None),
        error: Set(None),
        summary: Set(None),
        reviewed_at: Set(None),
        result_path: Set(None),
        created_at: Set(now),
    }
    .insert(conn)
    .await
    .map_err(DbError::from)
}

/// 执行结果必须有明确证据，不能以缺少错误推断成功。
#[derive(Debug, PartialEq, Eq)]
pub enum RunOutcome {
    Exited(i32),
    Failed(String),
    Unverified(String),
    /// 任务定时：Agent 交了结果文件。
    Submitted(String),
    /// 任务定时：没交结果就停了（退出、续跑用尽），需要人到终端看。
    NeedsAttention(String),
    /// 任务定时：超过运行上限仍没交结果。
    TimedOut,
}

pub async fn settle_run(
    conn: &DatabaseConnection,
    run: automation_run::Model,
    terminal_id: Option<String>,
    outcome: RunOutcome,
) -> Result<bool, DbError> {
    let result_path = match &outcome {
        RunOutcome::Submitted(path) => Set(Some(path.clone())),
        _ => NotSet,
    };
    let (status, reason, error) = match outcome {
        RunOutcome::Submitted(_) => (AutomationRunStatus::Succeeded, "result_submitted", None),
        RunOutcome::NeedsAttention(error) => {
            (AutomationRunStatus::Failed, "needs_attention", Some(error))
        }
        RunOutcome::TimedOut => (
            AutomationRunStatus::Failed,
            "timeout",
            Some("run exceeded the time limit without a result".into()),
        ),
        RunOutcome::Exited(0) => (AutomationRunStatus::Succeeded, "process_exited", None),
        RunOutcome::Exited(code) => (
            AutomationRunStatus::Failed,
            "process_exited",
            Some(format!("automation process exited with code {code}")),
        ),
        RunOutcome::Failed(error) => (AutomationRunStatus::Failed, "execution_failed", Some(error)),
        RunOutcome::Unverified(error) => (
            AutomationRunStatus::Failed,
            "execution_unverified",
            Some(error),
        ),
    };
    let now = Utc::now();
    let transaction = conn.begin().await?;
    let updated = automation_run::Entity::update_many()
        .set(automation_run::ActiveModel {
            status: Set(status.clone()),
            terminal_id: Set(terminal_id),
            stop_reason: Set(Some(reason.into())),
            error: Set(error),
            ended_at: Set(Some(now)),
            result_path,
            ..Default::default()
        })
        .filter(automation_run::Column::Id.eq(run.id))
        .filter(automation_run::Column::Status.eq(AutomationRunStatus::Running))
        .exec(&transaction)
        .await?
        .rows_affected
        > 0;
    // 结算与摘要一起提交；旧回调不能覆盖已结算事实或更新一轮的状态。
    if updated
        && automation_run::Entity::find()
            .filter(automation_run::Column::AutomationId.eq(run.automation_id))
            .filter(automation_run::Column::Id.gt(run.id))
            .one(&transaction)
            .await?
            .is_none()
    {
        automation::Entity::update_many()
            .set(automation::ActiveModel {
                last_run_at: Set(Some(now)),
                last_run_status: Set(Some(
                    if status == AutomationRunStatus::Succeeded {
                        "succeeded"
                    } else {
                        "failed"
                    }
                    .into(),
                )),
                updated_at: Set(now),
                ..Default::default()
            })
            .filter(automation::Column::Id.eq(run.automation_id))
            .exec(&transaction)
            .await?;
    }
    transaction.commit().await?;
    Ok(updated)
}

/// 规范化并校验人工关联的结果文件路径:要求已存在、解析软链接后仍位于
/// 项目根内、且为普通文件。空输入表示清除关联;不由此执行任何文件/命令。
fn resolve_result_path(root: &str, raw: &str) -> Result<Option<String>, DbError> {
    const MAX_RESULT_PATH_LEN: usize = 1024;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.len() > MAX_RESULT_PATH_LEN {
        return Err(DbError::Validation("result path is too long".into()));
    }
    let root = std::fs::canonicalize(root)
        .map_err(|_| DbError::Validation("automation folder is no longer accessible".into()))?;
    let candidate = std::fs::canonicalize(trimmed)
        .map_err(|_| DbError::Validation(format!("result file does not exist: {trimmed}")))?;
    if !candidate.starts_with(&root) {
        return Err(DbError::Validation(
            "result file must stay inside the automation folder".into(),
        ));
    }
    if !candidate.is_file() {
        return Err(DbError::Validation(
            "result path is not a regular file".into(),
        ));
    }
    Ok(Some(candidate.to_string_lossy().into_owned()))
}

/// 记录人工检查状态与结果文件关联。校验 run 所属自动化与项目仍存在;
/// 标已检查不改写执行结果字段,旧行无 reviewed_at 即默认未检查。
pub async fn update_run_review(
    conn: &DatabaseConnection,
    run_id: i32,
    reviewed: bool,
    result_path: Option<String>,
) -> Result<AutomationRunInfo, DbError> {
    let run = automation_run::Entity::find_by_id(run_id)
        .one(conn)
        .await?
        .ok_or_else(|| DbError::NotFound(format!("automation run {run_id}")))?;
    let automation = get_model(conn, run.automation_id).await?;
    let root_folder_id = automation
        .root_folder_id
        .ok_or_else(|| DbError::Validation("automation has no folder".into()))?;
    let folder =
        berth_project_core::service::folder_service::get_folder_by_id(conn, root_folder_id)
            .await?
            .ok_or_else(|| DbError::NotFound("automation folder no longer exists".into()))?;
    let result_path = match result_path {
        Some(raw) => resolve_result_path(&folder.path, &raw)?,
        None => None,
    };
    let now = Utc::now();
    automation_run::Entity::update_many()
        .set(automation_run::ActiveModel {
            reviewed_at: Set(reviewed.then_some(now)),
            result_path: Set(result_path),
            ..Default::default()
        })
        .filter(automation_run::Column::Id.eq(run.id))
        .exec(conn)
        .await?;
    let stored = automation_run::Entity::find_by_id(run.id)
        .one(conn)
        .await?
        .ok_or_else(|| DbError::NotFound(format!("automation run {run_id}")))?;
    Ok(to_run_info(stored))
}

pub async fn mark_dispatched(
    conn: &DatabaseConnection,
    run: automation_run::Model,
    terminal_id: String,
) -> Result<(), DbError> {
    let mut active = run.into_active_model();
    active.terminal_id = Set(Some(terminal_id));
    active.update(conn).await?;
    Ok(())
}

pub async fn skip_run(
    conn: &DatabaseConnection,
    run: automation_run::Model,
    reason: &str,
) -> Result<(), DbError> {
    let mut active = run.into_active_model();
    active.status = Set(AutomationRunStatus::Skipped);
    active.error = Set(Some(reason.into()));
    active.ended_at = Set(Some(Utc::now()));
    active.update(conn).await?;
    Ok(())
}

pub async fn record_last_run(
    conn: &DatabaseConnection,
    row: automation::Model,
    status: &str,
) -> Result<(), DbError> {
    let now = Utc::now();
    let mut active = row.into_active_model();
    active.last_run_at = Set(Some(now));
    active.last_run_status = Set(Some(status.into()));
    active.updated_at = Set(now);
    active.update(conn).await?;
    Ok(())
}

pub async fn advance(
    conn: &DatabaseConnection,
    row: automation::Model,
    status: &str,
) -> Result<(), DbError> {
    let now = Utc::now();
    // Dispatch can take long enough for the user to edit or disable the
    // automation. Re-read it before advancing so an old cron/timezone snapshot
    // cannot overwrite the newly saved schedule.
    let current = get_model(conn, row.id).await?;
    let next = if current.enabled {
        compute_next_run(
            current.cron.as_deref().unwrap_or(""),
            &current.timezone,
            now,
        )?
    } else {
        None
    };
    let mut active = current.into_active_model();
    active.next_run_at = Set(next);
    active.last_run_at = Set(Some(now));
    active.last_run_status = Set(Some(status.into()));
    active.updated_at = Set(now);
    active.update(conn).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn automation_result_review_settlement_is_final() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let folder_id = crate::db::test_helpers::seed_folder(&db, "/tmp/automation-review").await;
        let automation = create(
            &db.conn,
            AutomationDraft {
                name: "review".into(),
                enabled: false,
                cron: "0 9 * * *".into(),
                timezone: "UTC".into(),
                agent_id: "custom-cli".into(),
                folder_id,
                prompt: "check".into(),
                task: None,
                missed_run_grace_minutes: 1,
            },
        )
        .await
        .unwrap();
        let run = claim_run(&db.conn, automation.id, "manual", None)
            .await
            .unwrap();
        assert!(
            settle_run(&db.conn, run.clone(), None, RunOutcome::Exited(7))
                .await
                .unwrap()
        );
        assert!(
            !settle_run(&db.conn, run.clone(), None, RunOutcome::Exited(0))
                .await
                .unwrap()
        );
        let stored = automation_run::Entity::find_by_id(run.id)
            .one(&db.conn)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(stored.status, AutomationRunStatus::Failed);
        assert_eq!(
            stored.error.as_deref(),
            Some("automation process exited with code 7")
        );
        assert_eq!(
            get_model(&db.conn, automation.id)
                .await
                .unwrap()
                .last_run_status
                .as_deref(),
            Some("failed")
        );

        for (outcome, status, reason) in [
            (
                RunOutcome::Exited(0),
                AutomationRunStatus::Succeeded,
                "process_exited",
            ),
            (
                RunOutcome::Unverified("no exit evidence".into()),
                AutomationRunStatus::Failed,
                "execution_unverified",
            ),
            (
                RunOutcome::Failed("dispatch failed".into()),
                AutomationRunStatus::Failed,
                "execution_failed",
            ),
        ] {
            let run = claim_run(&db.conn, automation.id, "schedule", None)
                .await
                .unwrap();
            assert!(
                settle_run(&db.conn, run.clone(), Some("terminal-test".into()), outcome)
                    .await
                    .unwrap()
            );
            let stored = list_runs(&db.conn, automation.id)
                .await
                .unwrap()
                .into_iter()
                .find(|item| item.id == run.id)
                .unwrap();
            assert_eq!(stored.status, status);
            assert_eq!(stored.stop_reason.as_deref(), Some(reason));
            assert_eq!(
                stored.error.is_none(),
                status == AutomationRunStatus::Succeeded
            );
        }
        let latest = claim_run(&db.conn, automation.id, "manual", None)
            .await
            .unwrap();
        record_last_run(
            &db.conn,
            get_model(&db.conn, automation.id).await.unwrap(),
            "running",
        )
        .await
        .unwrap();
        assert!(!settle_run(&db.conn, run, None, RunOutcome::Exited(0))
            .await
            .unwrap());
        assert_eq!(
            get_model(&db.conn, automation.id)
                .await
                .unwrap()
                .last_run_status
                .as_deref(),
            Some("running")
        );
        assert_eq!(list_active_runs(&db.conn).await.unwrap()[0].id, latest.id);
    }
    #[test]
    fn automation_result_review_guards_result_path_boundary() {
        let project = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let root = project.path().to_string_lossy().into_owned();
        let inside = project.path().join("result.txt");
        std::fs::write(&inside, "ok").unwrap();
        let outside_file = outside.path().join("secret.txt");
        std::fs::write(&outside_file, "nope").unwrap();
        let missing = project.path().join("missing.txt");

        assert_eq!(
            resolve_result_path(&root, "").unwrap(),
            None,
            "空输入清除关联"
        );
        assert_eq!(
            resolve_result_path(&root, "  ").unwrap(),
            None,
            "纯空白同样清除"
        );
        assert!(
            resolve_result_path(&root, &format!("x{}", "a".repeat(1024))).is_err(),
            "超长路径拒绝"
        );
        let linked = resolve_result_path(&root, inside.to_str().unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(
            linked,
            std::fs::canonicalize(&inside).unwrap().to_string_lossy()
        );
        assert!(
            resolve_result_path(&root, outside_file.to_str().unwrap()).is_err(),
            "项目外文件拒绝"
        );
        assert!(
            resolve_result_path(&root, missing.to_str().unwrap()).is_err(),
            "缺失文件拒绝"
        );
        assert!(
            resolve_result_path(&root, project.path().to_str().unwrap()).is_err(),
            "目录不是普通文件"
        );
        // 软链接指向项目外时,canonicalize 解析后逃逸项目边界,必须拒绝。
        #[cfg(unix)]
        {
            let escape = project.path().join("escape.txt");
            std::os::unix::fs::symlink(&outside_file, &escape).unwrap();
            let error = resolve_result_path(&root, escape.to_str().unwrap()).unwrap_err();
            assert!(error.to_string().contains("inside"), "{error}");
            std::fs::remove_file(&escape).unwrap();
        }
    }

    #[tokio::test]
    async fn automation_result_review_persists_check_without_touching_facts() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let project = tempfile::tempdir().unwrap();
        let folder_id =
            crate::db::test_helpers::seed_folder(&db, project.path().to_str().unwrap()).await;
        let automation = create(
            &db.conn,
            AutomationDraft {
                name: "review-db".into(),
                enabled: false,
                cron: "0 9 * * *".into(),
                timezone: "UTC".into(),
                agent_id: "custom-cli".into(),
                folder_id,
                prompt: "check".into(),
                task: None,
                missed_run_grace_minutes: 1,
            },
        )
        .await
        .unwrap();
        let run = claim_run(&db.conn, automation.id, "manual", None)
            .await
            .unwrap();
        settle_run(&db.conn, run.clone(), None, RunOutcome::Exited(0))
            .await
            .unwrap();
        // 旧行默认未检查、无结果文件;执行事实保持原样。
        let stored = update_run_review(&db.conn, run.id, false, None)
            .await
            .unwrap();
        assert!(stored.reviewed_at.is_none());
        assert!(stored.result_path.is_none());
        assert_eq!(stored.status, AutomationRunStatus::Succeeded);
        assert_eq!(stored.stop_reason.as_deref(), Some("process_exited"));

        let result = project.path().join("report.txt");
        std::fs::write(&result, "done").unwrap();
        let checked = update_run_review(
            &db.conn,
            run.id,
            true,
            Some(result.to_string_lossy().into()),
        )
        .await
        .unwrap();
        assert!(checked.reviewed_at.is_some(), "标已检查写入时间");
        assert_eq!(
            checked.result_path.as_deref(),
            Some(std::fs::canonicalize(&result).unwrap().to_str().unwrap()),
            "存储规范化后的绝对路径"
        );
        assert_eq!(checked.status, AutomationRunStatus::Succeeded);
        assert_eq!(checked.stop_reason.as_deref(), Some("process_exited"));

        // 更新失败(越界路径)不写入,保留原值。
        let outside = tempfile::tempdir().unwrap();
        let secret = outside.path().join("secret.txt");
        std::fs::write(&secret, "nope").unwrap();
        assert!(update_run_review(
            &db.conn,
            run.id,
            true,
            Some(secret.to_string_lossy().into())
        )
        .await
        .is_err());
        let unchanged = list_runs(&db.conn, automation.id)
            .await
            .unwrap()
            .into_iter()
            .find(|item| item.id == run.id)
            .unwrap();
        assert_eq!(unchanged.reviewed_at, checked.reviewed_at);
        assert_eq!(unchanged.result_path, checked.result_path);

        // 标回待检查清空时间;再次结算不改人工检查字段。
        let unchecked = update_run_review(&db.conn, run.id, false, None)
            .await
            .unwrap();
        assert!(unchecked.reviewed_at.is_none());
        assert!(unchecked.result_path.is_none());
        assert!(
            !settle_run(&db.conn, run.clone(), None, RunOutcome::Exited(0))
                .await
                .unwrap()
        );
    }
    #[test]
    fn rejects_non_five_field_cron() {
        assert!(compute_next_run("* * * *", "UTC", Utc::now()).is_err());
    }
    #[test]
    fn accepts_posix_sunday() {
        assert!(compute_next_run("0 9 * * 0", "Asia/Shanghai", Utc::now())
            .unwrap()
            .is_some());
    }
}
