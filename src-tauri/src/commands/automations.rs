use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::app_error::{AppCommandError, AppErrorCode};
use crate::commands::terminal::{create_terminal_core, CreatePersonalTerminalRequest};
use crate::db::service::automation_service;
use crate::db::service::automation_service::RunOutcome;
use crate::db::AppDatabase;
use crate::event_bridge::{emit_event, EventEmitter};
use crate::terminal::manager::TerminalSessionManager;
use crate::terminal::protocol::TerminalStatus;
use berth_project_core::service::folder_service;
use berth_project_core::tasks::{self, TaskError};

#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum AutomationsRequest {
    List {
        folder_id: i32,
    },
    Create {
        draft: automation_service::AutomationDraft,
    },
    Update {
        id: i32,
        draft: automation_service::AutomationDraft,
    },
    Delete {
        id: i32,
    },
    RunNow {
        id: i32,
    },
    ListRuns {
        automation_id: i32,
    },
    /// 人工检查操作:run id + 是否已检查 + 可选结果文件路径(空表示清除)。
    /// 请求携带期望的完整状态,旧版客户端省略 result_path 时保持原关联。
    CheckRun {
        run_id: i32,
        reviewed: bool,
        #[serde(default)]
        result_path: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AutomationsResponse {
    List {
        automations: Vec<automation_service::AutomationInfo>,
    },
    Automation {
        automation: automation_service::AutomationInfo,
    },
    Runs {
        runs: Vec<automation_service::AutomationRunInfo>,
    },
    Run {
        run: automation_service::AutomationRunInfo,
    },
    Ok,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AutomationChanged {
    folder_id: i32,
    automation_id: i32,
    run_id: Option<i32>,
}

async fn dispatch(
    db: &AppDatabase,
    manager: &TerminalSessionManager,
    emitter: EventEmitter,
    model: berth_project_core::entities::automation::Model,
    trigger: &str,
    scheduled_for: Option<chrono::DateTime<Utc>>,
) -> Result<automation_service::AutomationRunInfo, AppCommandError> {
    let run = automation_service::claim_run(&db.conn, model.id, trigger, scheduled_for)
        .await
        .map_err(|error| {
            if error.to_string().contains("UNIQUE constraint failed") {
                AppCommandError::new(
                    AppErrorCode::TurnInProgress,
                    "automation already has a run in progress",
                )
                .with_detail(error.to_string())
            } else {
                AppCommandError::from(error)
            }
        })?;
    let mut created_terminal_id = None;
    let result = async {
        let folder_id = model.root_folder_id.ok_or_else(|| {
            AppCommandError::new(AppErrorCode::InvalidInput, "automation has no folder")
        })?;
        let folder = folder_service::get_folder_by_id(&db.conn, folder_id)
            .await?
            .ok_or_else(|| {
                AppCommandError::new(AppErrorCode::NotFound, "automation folder no longer exists")
            })?;
        let config = serde_json::from_str::<automation_service::TuiAutomationConfig>(&model.config)
            .map_err(|_| {
                AppCommandError::new(
                    AppErrorCode::ConfigurationInvalid,
                    "legacy automation config cannot be dispatched",
                )
            })?;
        if config.schema != automation_service::TUI_CONFIG_SCHEMA {
            return Err(AppCommandError::new(
                AppErrorCode::ConfigurationInvalid,
                "legacy automation config cannot be dispatched",
            ));
        }
        let launch = launch_plan(&model, &config, &folder.path, &run)?;
        let descriptor = create_terminal_core(
            manager,
            emitter.clone(),
            CreatePersonalTerminalRequest {
                terminal_id: None,
                cwd: launch.cwd,
                shell: None,
                initial_command: None,
                executable: None,
                args: Vec::new(),
                env: HashMap::new(),
                agent_id: Some(model.agent_type.clone()),
                agent_mode_id: None,
                // 交互 CLI 把 positional prompt 当作首条消息自行提交，
                // 避免启动后模拟键盘。以 `-` 开头时加 `--` 防止被当成 flag。
                agent_extra_args: prompt_launch_args(&launch.prompt),
                agent_capability_values: BTreeMap::new(),
                agent_launch_inputs: launch.inputs,
                provider_injection_args: Vec::new(),
                folder_id: Some(folder_id),
                rows: 30,
                cols: 120,
                client_id: None,
            },
            // Agent 启动只带 launch.js 的环境，额外变量走 extra_env。
            Some(launch.env),
        )
        .await?;
        created_terminal_id = Some(descriptor.terminal_id);
        Ok::<(), AppCommandError>(())
    }
    .await;
    let error = result.err().map(|error| error.to_string());
    if let Some(error) = error.clone() {
        automation_service::settle_run(
            &db.conn,
            run.clone(),
            created_terminal_id,
            RunOutcome::Failed(error),
        )
        .await?;
    } else {
        automation_service::mark_dispatched(
            &db.conn,
            run.clone(),
            created_terminal_id.ok_or_else(|| {
                AppCommandError::new(
                    AppErrorCode::TerminalNotFound,
                    "automation terminal was not recorded",
                )
            })?,
        )
        .await?;
    }
    if trigger == "manual" && error.is_none() {
        automation_service::record_last_run(&db.conn, model.clone(), "running").await?;
    }
    let runs = automation_service::list_runs(&db.conn, model.id).await?;
    let info = runs
        .into_iter()
        .find(|item| item.id == run.id)
        .ok_or_else(|| AppCommandError::new(AppErrorCode::NotFound, "automation run not found"))?;
    emit_automation_changed(
        &emitter,
        AutomationChanged {
            folder_id: model.root_folder_id.unwrap_or_default(),
            automation_id: model.id,
            run_id: Some(run.id),
        },
    );
    if let Some(error) = error {
        return Err(AppCommandError::new(
            AppErrorCode::TaskExecutionFailed,
            error,
        ));
    }
    Ok(info)
}

pub async fn automations_core(
    db: &AppDatabase,
    manager: &TerminalSessionManager,
    emitter: EventEmitter,
    request: AutomationsRequest,
) -> Result<AutomationsResponse, AppCommandError> {
    match request {
        AutomationsRequest::List { folder_id } => Ok(AutomationsResponse::List {
            automations: automation_service::list(&db.conn, folder_id).await?,
        }),
        AutomationsRequest::Create { draft } => {
            let folder_id = draft.folder_id;
            let automation = automation_service::create(&db.conn, draft).await?;
            emit_automation_changed(
                &emitter,
                AutomationChanged {
                    folder_id,
                    automation_id: automation.id,
                    run_id: None,
                },
            );
            Ok(AutomationsResponse::Automation { automation })
        }
        AutomationsRequest::Update { id, draft } => {
            let folder_id = draft.folder_id;
            let automation = automation_service::update(&db.conn, id, draft).await?;
            emit_automation_changed(
                &emitter,
                AutomationChanged {
                    folder_id,
                    automation_id: id,
                    run_id: None,
                },
            );
            Ok(AutomationsResponse::Automation { automation })
        }
        AutomationsRequest::Delete { id } => {
            let model = automation_service::get_model(&db.conn, id).await?;
            automation_service::delete(&db.conn, id).await?;
            emit_automation_changed(
                &emitter,
                AutomationChanged {
                    folder_id: model.root_folder_id.unwrap_or_default(),
                    automation_id: id,
                    run_id: None,
                },
            );
            Ok(AutomationsResponse::Ok)
        }
        AutomationsRequest::RunNow { id } => {
            let model = automation_service::get_model(&db.conn, id).await?;
            if stop_if_task_closed(db, &emitter, &model).await {
                return Err(AppCommandError::new(
                    AppErrorCode::InvalidInput,
                    "task is archived; its schedule has stopped",
                ));
            }
            Ok(AutomationsResponse::Run {
                run: dispatch(db, manager, emitter, model, "manual", None).await?,
            })
        }
        AutomationsRequest::ListRuns { automation_id } => {
            automation_service::get_model(&db.conn, automation_id).await?;
            Ok(AutomationsResponse::Runs {
                runs: automation_service::list_runs(&db.conn, automation_id).await?,
            })
        }
        AutomationsRequest::CheckRun {
            run_id,
            reviewed,
            result_path,
        } => {
            let run =
                automation_service::update_run_review(&db.conn, run_id, reviewed, result_path)
                    .await?;
            let model = automation_service::get_model(&db.conn, run.automation_id).await?;
            emit_automation_changed(
                &emitter,
                AutomationChanged {
                    folder_id: model.root_folder_id.unwrap_or_default(),
                    automation_id: model.id,
                    run_id: Some(run.id),
                },
            );
            Ok(AutomationsResponse::Run { run })
        }
    }
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn automations(
    db: tauri::State<'_, AppDatabase>,
    manager: tauri::State<'_, TerminalSessionManager>,
    app: tauri::AppHandle,
    request: AutomationsRequest,
) -> Result<AutomationsResponse, AppCommandError> {
    automations_core(&db, &manager, EventEmitter::Tauri(app), request).await
}

/// 一次运行怎么启动：目录、首条消息、环境、启动输入。
struct Launch {
    cwd: String,
    prompt: String,
    env: HashMap<String, String>,
    inputs: Option<BTreeMap<String, serde_json::Value>>,
}

fn task_error(error: TaskError) -> AppCommandError {
    AppCommandError::new(AppErrorCode::InvalidInput, error.message)
}

/// 任务定时：在任务所在 worktree（没有就主项目）无人值守地跑任务；终端带 `BERTH_TASK_RUN` 供交结果。
/// 旧的独立自动化照原样用自己的提示词。
fn launch_plan(
    model: &berth_project_core::entities::automation::Model,
    config: &automation_service::TuiAutomationConfig,
    root: &str,
    run: &berth_project_core::entities::automation_run::Model,
) -> Result<Launch, AppCommandError> {
    let Some(task) = config.task.as_deref() else {
        return Ok(Launch {
            cwd: root.to_owned(),
            prompt: config.prompt.clone(),
            env: HashMap::new(),
            inputs: None,
        });
    };
    let main = tasks::resolve(Path::new(root)).map_err(task_error)?.main;
    let view = tasks::show(&main, Some(task)).map_err(task_error)?;
    let inputs =
        crate::commands::launchbar::unattended_inputs(&model.agent_type)?.ok_or_else(|| {
            AppCommandError::new(
                AppErrorCode::ConfigurationInvalid,
                "this agent declares no unattended launch option (launchbar.json `unattended`)",
            )
        })?;
    let name = view.task_dir_name;
    Ok(Launch {
        cwd: view
            .worktree
            .unwrap_or_else(|| main.to_string_lossy().into_owned()),
        prompt: task_prompt(&name, &config.prompt),
        env: HashMap::from([(
            tasks::TASK_RUN_ENV.to_owned(),
            format!("{name}/{}", tasks::run_stamp(run.created_at)),
        )]),
        inputs: Some(inputs),
    })
}

fn task_prompt(task: &str, note: &str) -> String {
    let mut prompt = format!(
        "定时执行任务 {task}。这是无人值守运行，没有人会回答你的问题。\
         先运行 `berth project . task show {task}` 读任务，按任务正文完成本次工作；\
         遇到不确定的地方自己做合理决定，并在结果里说明，不要提问，也不要等待确认。\
         完成后用 `berth project . task result --file <结果.md>`（或 `--text <正文>`）提交本次结果，\
         写清做了什么、发现了什么、需要人处理的事项。"
    );
    if !note.trim().is_empty() {
        prompt.push_str("\n补充说明：");
        prompt.push_str(note.trim());
    }
    prompt
}

/// 续跑指令带上完整任务说明：首条消息可能没进去（如启动时被确认框打断）。
fn continue_prompt(task: &str, note: &str) -> String {
    format!(
        "[berth] 还没有提交本次结果，继续完成，不要停下来等人。{}",
        task_prompt(task, note)
    )
}

/// 任务已归档或已不存在：停用它的定时，返回 true。读不到任务（项目没启用等）不算，交给运行报错。
async fn stop_if_task_closed(
    db: &AppDatabase,
    emitter: &EventEmitter,
    model: &berth_project_core::entities::automation::Model,
) -> bool {
    let Some(task) = automation_service::config(model).and_then(|config| config.task) else {
        return false;
    };
    let Some(root) = task_root(db, model).await else {
        return false;
    };
    let closed = match tasks::show(&root, Some(&task)) {
        Ok(view) => view.archived,
        Err(error) => error.code == "not_found",
    };
    if closed
        && automation_service::disable(&db.conn, model.clone())
            .await
            .is_ok()
    {
        emit_automation_changed(
            emitter,
            AutomationChanged {
                folder_id: model.root_folder_id.unwrap_or_default(),
                automation_id: model.id,
                run_id: None,
            },
        );
    }
    closed
}

/// 自动化所在项目的主项目目录。
async fn task_root(
    db: &AppDatabase,
    model: &berth_project_core::entities::automation::Model,
) -> Option<PathBuf> {
    let folder = folder_service::get_folder_by_id(&db.conn, model.root_folder_id?)
        .await
        .ok()??;
    tasks::resolve(Path::new(&folder.path))
        .ok()
        .map(|scope| scope.main)
}

/// 任务定时运行的结果文件与续跑指令；不是任务定时为 `None`。
async fn task_run_of(
    db: &AppDatabase,
    run: &berth_project_core::entities::automation_run::Model,
) -> Option<(PathBuf, String)> {
    let model = automation_service::get_model(&db.conn, run.automation_id)
        .await
        .ok()?;
    let config = automation_service::config(&model)?;
    let task = config.task?;
    let main = task_root(db, &model).await?;
    let path = tasks::run_result_path(&main, &task, &tasks::run_stamp(run.created_at)).ok()?;
    Some((path, continue_prompt(&task, &config.prompt)))
}

/// 运行上限：超过仍没交结果就记超时（终端留着可接管）。
const TASK_RUN_LIMIT: Duration = Duration::from_secs(2 * 60 * 60);
/// 刚启动的一分钟不判空闲：首条消息可能还没进一轮。
const TASK_RUN_START_GRACE: Duration = Duration::from_secs(60);
/// 空闲这么久才算这一轮真停了。
const TASK_RUN_IDLE: Duration = Duration::from_secs(20);
/// 两次续跑之间至少隔这么久。
const CONTINUE_GAP: Duration = Duration::from_secs(90);
const MAX_CONTINUES: u32 = 3;

#[derive(Debug, PartialEq, Eq)]
enum TaskRunStep {
    Wait,
    Continue,
    Settle(RunOutcome),
}

/// 任务定时运行这一拍该做什么：交了结果即完成；Agent 停在空闲却没交结果就催它继续，催满仍没有交给人。
/// `idle_for` 是 hook 报告的空闲时长（working / attention 时为 `None`）；`continued` 是（已催次数，距上次）。
fn task_run_step(
    submitted: Option<String>,
    alive: bool,
    age: Duration,
    idle_for: Option<Duration>,
    continued: Option<(u32, Duration)>,
) -> TaskRunStep {
    if let Some(path) = submitted {
        return TaskRunStep::Settle(RunOutcome::Submitted(path));
    }
    if !alive {
        return TaskRunStep::Settle(RunOutcome::NeedsAttention(
            "agent exited without submitting a result".into(),
        ));
    }
    if age >= TASK_RUN_LIMIT {
        return TaskRunStep::Settle(RunOutcome::TimedOut);
    }
    if age < TASK_RUN_START_GRACE || !idle_for.is_some_and(|idle| idle >= TASK_RUN_IDLE) {
        return TaskRunStep::Wait;
    }
    match continued {
        Some((_, since)) if since < CONTINUE_GAP => TaskRunStep::Wait,
        Some((count, _)) if count >= MAX_CONTINUES => {
            TaskRunStep::Settle(RunOutcome::NeedsAttention(format!(
                "no result after {MAX_CONTINUES} continuation prompts"
            )))
        }
        _ => TaskRunStep::Continue,
    }
}

/// 调度器跨拍的观察状态。
#[derive(Default)]
pub struct SchedulerState {
    unavailable_since: HashMap<i32, Instant>,
    /// run id → （已催次数，上次催的时间）。重启后从零计，至多多催几次。
    continued: HashMap<i32, (u32, Instant)>,
}

fn prompt_launch_args(prompt: &str) -> Vec<String> {
    if prompt.is_empty() {
        return Vec::new();
    }
    if prompt.starts_with('-') {
        vec!["--".to_string(), prompt.to_string()]
    } else {
        vec![prompt.to_string()]
    }
}

/// 广播 automation 变更并唤醒 deadline 驱动的调度器重算休眠时长。
fn emit_automation_changed(emitter: &EventEmitter, payload: AutomationChanged) {
    emit_event(emitter, "automation://changed", payload);
    crate::AUTOMATION_SCHEDULER_WAKE.notify_one();
}

/// deadline 驱动的调度器休眠时长:有活跃 run 时保持 30 秒结算对账;
/// 否则睡到最近的 `next_run_at`(上限 10 分钟兜底对账);零启用计划时长眠。
/// 计划变更由 `emit_automation_changed` 即时唤醒,不依赖轮询发现。
pub(crate) async fn scheduler_sleep(db: &AppDatabase) -> std::time::Duration {
    const SETTLE_INTERVAL: std::time::Duration = std::time::Duration::from_secs(30);
    const IDLE_RECONCILE: std::time::Duration = std::time::Duration::from_secs(600);
    if let Ok(active) = automation_service::list_active_runs(&db.conn).await {
        if !active.is_empty() {
            return SETTLE_INTERVAL;
        }
    }
    let now = Utc::now();
    match automation_service::next_deadline(&db.conn, now).await {
        Ok(Some(next)) => (next - now)
            .to_std()
            .unwrap_or(std::time::Duration::ZERO)
            .clamp(std::time::Duration::from_secs(1), IDLE_RECONCILE),
        _ => IDLE_RECONCILE,
    }
}

// 沿既有 30 秒节拍观察两分钟；从第一次查询失败计时，恢复后清除。
const OBSERVATION_GRACE: Duration = Duration::from_secs(120);

fn terminal_run_outcome(
    run_id: i32,
    observation: Result<Option<(TerminalStatus, Option<i32>)>, String>,
    unavailable_since: &mut HashMap<i32, Instant>,
    now: Instant,
) -> Option<RunOutcome> {
    let observation = match observation {
        Ok(observation) => {
            unavailable_since.remove(&run_id);
            observation
        }
        Err(error) => {
            let since = unavailable_since.entry(run_id).or_insert_with(|| {
                tracing::warn!(run_id, %error, "automation terminal observation unavailable; retrying");
                now
            });
            return (now.duration_since(*since) >= OBSERVATION_GRACE).then(|| {
                RunOutcome::Unverified(format!("terminal observation timed out: {error}"))
            });
        }
    };
    match observation {
        Some((TerminalStatus::Running, _)) => None,
        Some((TerminalStatus::Exited, Some(code))) => Some(RunOutcome::Exited(code)),
        Some((TerminalStatus::Exited, None)) => Some(RunOutcome::Unverified(
            "terminal exited without an exit code".into(),
        )),
        Some((TerminalStatus::Failed, _)) => {
            Some(RunOutcome::Failed("automation terminal failed".into()))
        }
        None => Some(RunOutcome::Unverified(
            "terminal is no longer in the live inventory".into(),
        )),
    }
}

pub async fn scheduler_tick(
    db: &AppDatabase,
    manager: &TerminalSessionManager,
    emitter: EventEmitter,
    state: &mut SchedulerState,
) {
    let SchedulerState {
        unavailable_since,
        continued,
    } = state;
    if let Ok(active_runs) = automation_service::list_active_runs(&db.conn).await {
        unavailable_since.retain(|id, _| active_runs.iter().any(|run| run.id == *id));
        continued.retain(|id, _| active_runs.iter().any(|run| run.id == *id));
        // 每轮共享一次保留错误的 inventory；无已发射 run 时不探测终端。
        let terminals = if active_runs.iter().any(|run| run.terminal_id.is_some()) {
            manager.try_list()
        } else {
            Ok(Vec::new())
        };
        for run in active_runs {
            let terminal_id = run.terminal_id.clone();
            let task_run = match terminal_id {
                Some(_) => task_run_of(db, &run).await,
                None => None,
            };
            let outcome = if let (Some(terminal_id), Some((result_path, continue_text))) =
                (terminal_id.as_deref(), task_run)
            {
                let submitted = result_path
                    .is_file()
                    .then(|| result_path.to_string_lossy().into_owned());
                let step = match &terminals {
                    // 观察不到终端时只认结果文件；终端情况等恢复后再判。
                    Err(_) => match submitted {
                        Some(path) => TaskRunStep::Settle(RunOutcome::Submitted(path)),
                        None => TaskRunStep::Wait,
                    },
                    Ok(terminals) => {
                        let descriptor = terminals
                            .iter()
                            .find(|item| item.terminal_id == terminal_id);
                        let alive =
                            descriptor.is_some_and(|item| item.status == TerminalStatus::Running);
                        let now = Utc::now();
                        let age = (now - run.created_at).to_std().unwrap_or_default();
                        // hook 还没报过状态（没有变化时间）时，空闲按自启动起算。
                        let idle_for = descriptor
                            .and_then(|item| item.agent_signal.as_ref())
                            .filter(|signal| signal.state == "idle")
                            .map(|signal| match signal.state_changed_at {
                                Some(at) => Duration::from_secs(
                                    u64::try_from(now.timestamp() - at).unwrap_or_default(),
                                ),
                                None => age,
                            });
                        let nudged = continued
                            .get(&run.id)
                            .map(|(count, at)| (*count, at.elapsed()));
                        task_run_step(submitted, alive, age, idle_for, nudged)
                    }
                };
                match step {
                    TaskRunStep::Wait => continue,
                    TaskRunStep::Continue => {
                        match manager.send_text_then_key(terminal_id, &continue_text, "Enter") {
                            Ok(()) => {
                                let entry = continued.entry(run.id).or_insert((0, Instant::now()));
                                *entry = (entry.0 + 1, Instant::now());
                            }
                            Err(error) => {
                                tracing::warn!(
                                    run_id = run.id,
                                    ?error,
                                    "automation continue prompt failed"
                                )
                            }
                        }
                        continue;
                    }
                    TaskRunStep::Settle(outcome) => outcome,
                }
            } else if let Some(terminal_id) = terminal_id.as_deref() {
                let observation = match &terminals {
                    Err(error) => Err(error.to_string()),
                    Ok(terminals) => match terminals
                        .iter()
                        .find(|item| item.terminal_id == terminal_id)
                    {
                        Some(item) if item.status == TerminalStatus::Exited => manager
                            .snapshot(terminal_id)
                            .map(|snapshot| Some((snapshot.status, snapshot.exit_code)))
                            .map_err(|error| error.to_string()),
                        Some(item) => Ok(Some((item.status, None))),
                        None => Ok(None),
                    },
                };
                let Some(outcome) =
                    terminal_run_outcome(run.id, observation, unavailable_since, Instant::now())
                else {
                    continue;
                };
                outcome
            } else {
                // Keep a concurrently claimed run alone, but recover a claim
                // abandoned by a process crash before terminal creation.
                if Utc::now() - run.created_at < chrono::Duration::minutes(2) {
                    continue;
                }
                RunOutcome::Failed("automation dispatch was interrupted".to_string())
            };
            let automation_id = run.automation_id;
            let run_id = run.id;
            if matches!(
                automation_service::settle_run(&db.conn, run, terminal_id, outcome).await,
                Ok(true)
            ) {
                unavailable_since.remove(&run_id);
                continued.remove(&run_id);
                if let Ok(model) = automation_service::get_model(&db.conn, automation_id).await {
                    let folder_id = model.root_folder_id.unwrap_or_default();
                    emit_automation_changed(
                        &emitter,
                        AutomationChanged {
                            folder_id,
                            automation_id,
                            run_id: None,
                        },
                    );
                }
            }
        }
    }
    let now = Utc::now();
    let Ok(rows) = automation_service::due(&db.conn, now).await else {
        return;
    };
    for row in rows {
        if stop_if_task_closed(db, &emitter, &row).await {
            continue;
        }
        let scheduled_for = row.next_run_at;
        let grace = chrono::Duration::minutes(i64::from(row.missed_run_grace_minutes));
        if scheduled_for.is_some_and(|at| now - at > grace) {
            if let Ok(run) =
                automation_service::claim_run(&db.conn, row.id, "schedule", scheduled_for).await
            {
                if automation_service::skip_run(&db.conn, run, "missed grace window")
                    .await
                    .is_ok()
                {
                    let folder_id = row.root_folder_id.unwrap_or_default();
                    let automation_id = row.id;
                    if automation_service::advance(&db.conn, row, "skipped_missed")
                        .await
                        .is_ok()
                    {
                        emit_automation_changed(
                            &emitter,
                            AutomationChanged {
                                folder_id,
                                automation_id,
                                run_id: None,
                            },
                        );
                    }
                }
            }
            continue;
        }
        let result = dispatch(
            db,
            manager,
            emitter.clone(),
            row.clone(),
            "schedule",
            scheduled_for,
        )
        .await;
        if result
            .as_ref()
            .is_err_and(|error| error.code == AppErrorCode::TurnInProgress)
        {
            continue;
        }
        let status = if result.is_ok() { "running" } else { "failed" };
        let folder_id = row.root_folder_id.unwrap_or_default();
        let automation_id = row.id;
        if automation_service::advance(&db.conn, row, status)
            .await
            .is_ok()
        {
            emit_automation_changed(
                &emitter,
                AutomationChanged {
                    folder_id,
                    automation_id,
                    run_id: None,
                },
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn automation_result_review_observes_exit_evidence_and_recovers() {
        let mut pending = HashMap::new();
        let now = Instant::now();
        for (observation, expected) in [
            (Ok(Some((TerminalStatus::Running, None))), None),
            (
                Ok(Some((TerminalStatus::Exited, Some(0)))),
                Some(RunOutcome::Exited(0)),
            ),
            (
                Ok(Some((TerminalStatus::Exited, Some(9)))),
                Some(RunOutcome::Exited(9)),
            ),
            (
                Ok(Some((TerminalStatus::Failed, None))),
                Some(RunOutcome::Failed("automation terminal failed".into())),
            ),
            (
                Ok(Some((TerminalStatus::Exited, None))),
                Some(RunOutcome::Unverified(
                    "terminal exited without an exit code".into(),
                )),
            ),
            (
                Ok(None),
                Some(RunOutcome::Unverified(
                    "terminal is no longer in the live inventory".into(),
                )),
            ),
        ] {
            assert_eq!(
                terminal_run_outcome(1, observation, &mut pending, now),
                expected
            );
        }
        let disconnected = || Err("runtime unavailable".to_string());
        assert_eq!(
            terminal_run_outcome(1, disconnected(), &mut pending, now),
            None
        );
        assert_eq!(
            terminal_run_outcome(
                1,
                disconnected(),
                &mut pending,
                now + Duration::from_secs(119)
            ),
            None
        );
        assert_eq!(
            terminal_run_outcome(
                1,
                Ok(Some((TerminalStatus::Running, None))),
                &mut pending,
                now + OBSERVATION_GRACE
            ),
            None
        );
        assert!(pending.is_empty());
        let later = now + OBSERVATION_GRACE;
        assert_eq!(
            terminal_run_outcome(1, disconnected(), &mut pending, later),
            None
        );
        assert!(matches!(
            terminal_run_outcome(1, disconnected(), &mut pending, later + OBSERVATION_GRACE),
            Some(RunOutcome::Unverified(_))
        ));
        assert_eq!(
            terminal_run_outcome(2, disconnected(), &mut pending, later + OBSERVATION_GRACE),
            None
        );
        assert_eq!(
            terminal_run_outcome(
                1,
                Ok(Some((TerminalStatus::Exited, Some(0)))),
                &mut pending,
                later + OBSERVATION_GRACE
            ),
            Some(RunOutcome::Exited(0))
        );
        assert!(!pending.contains_key(&1));
    }

    #[test]
    fn task_run_continues_idle_agent_then_hands_over() {
        let minute = Duration::from_secs(60);
        let idle = Some(Duration::from_secs(30));
        let step = |submitted: Option<&str>, alive, age, idle_for, continued| {
            task_run_step(
                submitted.map(str::to_owned),
                alive,
                age,
                idle_for,
                continued,
            )
        };
        assert_eq!(
            step(Some("r.md"), false, minute, None, None),
            TaskRunStep::Settle(RunOutcome::Submitted("r.md".into()))
        );
        assert!(matches!(
            step(None, false, minute, None, None),
            TaskRunStep::Settle(RunOutcome::NeedsAttention(_))
        ));
        assert_eq!(
            step(None, true, 3 * TASK_RUN_LIMIT, None, None),
            TaskRunStep::Settle(RunOutcome::TimedOut)
        );
        // 工作中、刚启动、刚空闲都等。
        assert_eq!(step(None, true, 5 * minute, None, None), TaskRunStep::Wait);
        assert_eq!(
            step(None, true, Duration::from_secs(10), idle, None),
            TaskRunStep::Wait
        );
        assert_eq!(
            step(None, true, 5 * minute, Some(Duration::from_secs(5)), None),
            TaskRunStep::Wait
        );
        assert_eq!(
            step(None, true, 5 * minute, idle, None),
            TaskRunStep::Continue
        );
        assert_eq!(
            step(
                None,
                true,
                5 * minute,
                idle,
                Some((1, Duration::from_secs(30)))
            ),
            TaskRunStep::Wait
        );
        assert_eq!(
            step(None, true, 5 * minute, idle, Some((2, 2 * minute))),
            TaskRunStep::Continue
        );
        assert!(matches!(
            step(
                None,
                true,
                5 * minute,
                idle,
                Some((MAX_CONTINUES, 2 * minute))
            ),
            TaskRunStep::Settle(RunOutcome::NeedsAttention(_))
        ));
    }

    #[test]
    fn prompt_launch_args_skips_empty_and_guards_leading_dash() {
        assert!(prompt_launch_args("").is_empty());
        assert_eq!(prompt_launch_args("review the diff"), ["review the diff"]);
        assert_eq!(prompt_launch_args("-p secret"), ["--", "-p secret"]);
    }
}
