//! 会话分类的宿主侧。两个入口共用同一套逐轮分类与进度：
//! - 后台：每 10 秒看一遍启动栏选了专家的终端；Agent 停下来（pane 不是 `working`）、会话文件有新内容
//!   且已落盘 5 秒，就把开关打开之后的新轮次交给 Jev 判别。只看终端状态和文件时间，没有新轮次不调 Jev；
//!   分类中途关掉开关，下一轮前停下；
//! - 手动：会话查看页「Jev 分类」（`knowledge.classify`），对指定会话还没分类的轮次跑一遍，不看开关。
//!
//! 切段、出题、分流在 `berth_project_core::knowledge::classifier`，命中直接写文件在 `…::journal`；
//! 同一请求里再问交接题，每处理完一个会话就更新它的交接（`…::handoff`）。没选专家的会话只写交接，不写 `记录/`；
//! 按会话页的一问一答分组（`berth_project_core::knowledge::exchanges`），调用记录里的「第 N 问」与会话页一致。

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use berth_project_core::knowledge::classifier::{self, Config};
use berth_project_core::knowledge::exchanges::{self, Exchange};
use berth_project_core::knowledge::handoff::{self, Picked};
use berth_project_core::knowledge::journal::{self, Entry, Source};
use berth_project_core::tasks::{self, group};
use chrono::{DateTime, Utc};
use sea_orm::DatabaseConnection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::models::{AgentType, ConversationDetail};
use crate::sessions::declarative::DeclarativeSessionParser;
use crate::sessions::AgentParser;
use crate::terminal::manager::TerminalManager;

const TICK: Duration = Duration::from_secs(10);
/// Agent 停下后会话文件再静止这么久才读（最后一条消息可能稍后落盘）。
const SETTLE: Duration = Duration::from_secs(5);
/// 旧 termd 不报告 Agent 状态时，会话文件静止这么久才算这一轮结束（还在调工具时文件一直在写）。
const QUIET: Duration = Duration::from_secs(60);
/// 开关打开前这么久以内的轮次也处理。
const ENABLE_GRACE: chrono::TimeDelta = chrono::TimeDelta::minutes(10);
/// 调用记录里的调用方。
const CALLER: &str = "knowledge.classify";
const STATE_FILE: &str = "classifier-state.json";
/// 没有专家的会话（手动分类时没选）记在这个名下。
const NO_EXPERT: &str = "_";

/// 分类进度：开关打开的时刻，以及每个会话（按会话 id）已分类到的位置。存在应用数据目录。
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct State {
    enabled_since: Option<DateTime<Utc>>,
    #[serde(default)]
    sessions: HashMap<String, Cursor>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Cursor {
    /// 后台上次处理时的文件修改时间；没变就不重读。
    modified: Option<SystemTime>,
    /// 已分类的最后一轮的时间。
    latest: Option<DateTime<Utc>>,
    /// 最近几问里 Jev 为交接挑出的段（第几问 → 段）。
    #[serde(default)]
    picks: BTreeMap<usize, Picked>,
}

/// 进度文件读改写的锁：后台与手动分类各自只改自己那个会话的条目。
static STATE_LOCK: Mutex<()> = Mutex::new(());
/// 正在分类的会话：同一会话不并发分类（否则候选重复计数）。
static RUNNING: Mutex<Option<HashSet<String>>> = Mutex::new(None);

fn state_path() -> PathBuf {
    std::env::var_os("BERTH_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(berth_tool_core::paths::berth_home_dir)
        .join(STATE_FILE)
}

fn update_state<T>(change: impl FnOnce(&mut State) -> T) -> T {
    let _guard = STATE_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let path = state_path();
    let mut state: State = std::fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    let result = change(&mut state);
    if let Ok(bytes) = serde_json::to_vec(&state) {
        let _ = std::fs::write(&path, bytes);
    }
    result
}

/// 占住一个会话；已被占用返回 `None`。
fn claim(session_id: &str) -> Option<Claim> {
    let mut running = RUNNING.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    running
        .get_or_insert_with(HashSet::new)
        .insert(session_id.to_owned())
        .then(|| Claim(session_id.to_owned()))
}

struct Claim(String);

impl Drop for Claim {
    fn drop(&mut self) {
        let mut running = RUNNING.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(running) = running.as_mut() {
            running.remove(&self.0);
        }
    }
}

/// 命中的归属：哪个专家、哪个 Agent，写进哪个项目，挂哪个任务。
struct Owner {
    /// 没选专家时为 `None`：只写交接。
    expert: Option<String>,
    agent: String,
    main: PathBuf,
    task: Option<String>,
}

/// 本群只有一个进行中的任务才挂上，对应不上就不挂。
fn single_task(main: &Path, group: &str) -> Option<String> {
    tasks::open_tasks_in_group(main, group, None)
        .ok()
        .filter(|open| open.len() == 1)
        .and_then(|open| open.into_iter().next())
}

pub(crate) async fn run(conn: DatabaseConnection, terminals: TerminalManager) {
    // 同一个问题只记一次日志，配置修好后重置。
    let mut last_problem: Option<String> = None;
    loop {
        tokio::time::sleep(TICK).await;
        let problem = tick(&conn, &terminals).await.err();
        if problem.is_some() && problem != last_problem {
            tracing::warn!("[classifier] {}", problem.as_deref().unwrap_or_default());
        }
        last_problem = problem;
    }
}

fn load_config() -> Result<Config, String> {
    classifier::load_config(&berth_tool_core::paths::berth_home_dir())
        .map_err(|error| format!("classifier.json 无效，分类已停用：{error}"))
}

async fn tick(conn: &DatabaseConnection, terminals: &TerminalManager) -> Result<(), String> {
    let config = load_config()?;
    if !config.enabled {
        update_state(|state| state.enabled_since = None);
        return Ok(());
    }
    // 往前多算一段：开开关前刚发出的那一轮也要处理（pi 等记的是请求发出时刻，回复晚于开关也会被当成旧轮）。
    let since = update_state(|state| *state.enabled_since.get_or_insert_with(Utc::now)) - ENABLE_GRACE;
    let decider = crate::decision::resolve(conn).await?;

    let terminals = terminals.clone_ref();
    let bodies = tokio::task::spawn_blocking(move || bodies(&terminals))
        .await
        .map_err(|error| error.to_string())?;
    let mut result = Ok(());
    for Body { owner, path, session_id, working } in bodies {
        if working == Some(true) {
            continue;
        }
        let Ok(modified) = std::fs::metadata(&path).and_then(|meta| meta.modified()) else {
            continue;
        };
        let cursor = update_state(|state| state.sessions.get(&session_id).cloned().unwrap_or_default());
        let settle = if working.is_some() { SETTLE } else { QUIET };
        if cursor.modified == Some(modified) || modified.elapsed().unwrap_or_default() < settle {
            continue;
        }
        let Some(_claim) = claim(&session_id) else {
            continue;
        };
        let agent = owner.agent.clone();
        let read = tokio::task::spawn_blocking(move || -> Result<ConversationDetail, String> {
            parser(&agent)?.detail_at(&path).map_err(|error| error.to_string())
        })
        .await
        .map_err(|error| error.to_string())
        .and_then(|detail| detail);
        let detail = match read {
            Ok(detail) => detail,
            Err(error) => {
                result = Err(error);
                continue;
            }
        };
        let from = cursor.latest.map_or(since, |latest| latest.max(since));
        let outcome = classify(conn, &decider, &config, &owner, &detail, from, cursor.picks, true).await;
        update_state(|state| {
            let entry = state.sessions.entry(session_id.clone()).or_default();
            entry.latest = outcome.latest.or(entry.latest);
            entry.picks = outcome.picks;
            // 失败或中途暂停的轮不推进，下次增量时重试。
            if outcome.error.is_none() && !outcome.paused {
                entry.modified = Some(modified);
            }
        });
        if let Some(error) = outcome.error {
            result = Err(error);
        }
    }
    result
}

/// 已在群里绑定会话文件的 Agent 终端（启动栏选了专家的带上专家）。
struct Body {
    owner: Owner,
    path: PathBuf,
    session_id: String,
    /// Agent 是否在干活；旧 termd 不报告时为 `None`。
    working: Option<bool>,
}

fn bodies(terminals: &TerminalManager) -> Vec<Body> {
    let tools = berth_tool_core::paths::tools_root();
    terminals
        .list()
        .into_iter()
        .filter_map(|terminal| {
            let agent = terminal.agent_id?;
            let working = terminal.agent_signal.as_ref().map(|signal| signal.state == "working");
            let expert = terminal
                .launch_inputs
                .as_ref()
                .and_then(|inputs| berth_tool_core::paths::launch_expert(&tools.join(&agent), inputs));
            let target = terminal.target_ref?;
            let main = tasks::resolve(Path::new(&terminal.initial_cwd)).ok()?.main;
            // 成员状态由 Agent 的 hook 写（`sessionPath`）；这里只读，不自己猜会话文件。成员都在项目群里。
            let name = group::MAIN_GROUP;
            let member = group::member_of(&group::events(&main, name).ok()?, &target)?;
            let state: Value =
                serde_json::from_slice(&std::fs::read(group::member_state_path(&main, name, &member.name, &target)).ok()?)
                    .ok()?;
            let path = PathBuf::from(state.get("sessionPath")?.as_str()?);
            let session_id = state
                .get("sessionId")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .or_else(|| Some(path.file_stem()?.to_string_lossy().into_owned()))?;
            // 任务按终端所在的 checkout 分配。
            let task = group::checkout_group(Path::new(&terminal.initial_cwd))
                .ok()
                .and_then(|(checkout, _)| single_task(&main, &checkout));
            Some(Body { owner: Owner { expert, agent, main, task }, path, session_id, working })
        })
        .collect()
}

/// 一次分类的结果：处理到的最后一轮、新写入的条目、交接挑出的段、出错原因（出错时停在出错的轮）、是否被开关叫停。
struct Outcome {
    latest: Option<DateTime<Utc>>,
    picks: BTreeMap<usize, Picked>,
    found: Vec<Entry>,
    error: Option<String>,
    paused: bool,
}

/// 会话的统一格式（`MessageTurn`）→ 一问一答；只取有回答的（还没回答的等回答了再分类）。
fn answered(detail: &ConversationDetail) -> Result<Vec<Exchange>, String> {
    let turns: Vec<exchanges::Turn> = serde_json::to_value(&detail.turns)
        .and_then(serde_json::from_value)
        .map_err(|error| format!("会话格式无法分组：{error}"))?;
    Ok(exchanges::exchanges(&turns).into_iter().filter(|exchange| exchange.answer.is_some()).collect())
}

/// 分类 `from` 之后的各问，命中直接写进 `记录/<类名>.md`，处理到新的问就更新交接。
/// `picks`：之前各问为交接挑出的段。`pausable`：每问前重读开关，关了就停（后台用）。
#[allow(clippy::too_many_arguments)]
async fn classify(
    conn: &DatabaseConnection,
    decider: &crate::decision::Decider,
    config: &Config,
    owner: &Owner,
    detail: &ConversationDetail,
    from: DateTime<Utc>,
    picks: BTreeMap<usize, Picked>,
    pausable: bool,
) -> Outcome {
    let mut outcome = Outcome {
        latest: None,
        picks,
        found: Vec::new(),
        error: None,
        paused: false,
    };
    let all = match answered(detail) {
        Ok(all) => all,
        Err(error) => {
            outcome.error = Some(error);
            return outcome;
        }
    };
    for (position, exchange) in all.iter().enumerate().filter(|(_, exchange)| exchange.latest > from) {
        if pausable && !load_config().is_ok_and(|config| config.enabled) {
            outcome.paused = true;
            break;
        }
        let segments = classifier::segments(exchange);
        let prompt = exchange.prompt.as_deref().unwrap_or_default();
        let next_prompt = all.get(position + 1).and_then(|next| next.prompt.as_deref()).unwrap_or_default();
        let previous = position.checked_sub(1).and_then(|previous| classifier::last_answer_part(&all[previous]));
        let from_end = all.len() - 1 - position;
        let mut scores = BTreeMap::new();
        let handoff_questions = handoff::questions(&segments, from_end);
        let request = owner
            .expert
            .as_ref()
            .and_then(|_| classifier::request(config, prompt, previous.as_deref(), &segments, next_prompt, from_end));
        let request = match request {
            Some((state, Value::Object(mut questions))) => {
                questions.extend(handoff_questions);
                Some((state, questions))
            }
            _ if !handoff_questions.is_empty() => {
                Some((json!({ "segments": classifier::segment_map(&segments) }), handoff_questions))
            }
            _ => None,
        };
        if let Some((state, questions)) = request {
            let request = serde_json::from_value(Value::Object(questions)).map(|questions| crate::decision::Request {
                caller: CALLER.to_owned(),
                subject: crate::decision::Subject {
                    project: Some(owner.main.to_string_lossy().into_owned()),
                    session: Some(detail.summary.id.clone()),
                    turn: Some(exchange.index),
                },
                state,
                questions,
            });
            let response = match request {
                Ok(request) => decider.decide(conn, &request).await,
                Err(error) => Err(error.to_string()),
            };
            match response {
                Ok(response) => {
                    scores = response.answers.iter().filter_map(|(key, answer)| Some((key.clone(), answer.noul()?))).collect();
                }
                Err(error) => {
                    outcome.error = Some(error);
                    break;
                }
            }
        }
        outcome.picks.insert(exchange.index, handoff::pick(&segments, &scores));
        if let Some(expert) = &owner.expert {
            let hits = classifier::route(config, &segments, &scores, prompt, previous.as_deref());
            let source = Source {
                expert: expert.clone(),
                agent: owner.agent.clone(),
                session_id: detail.summary.id.clone(),
                task: owner.task.clone(),
            };
            match journal::write(&owner.main, config, &source, exchange.index, &exchange.latest.to_rfc3339(), &hits) {
                Ok(written) => outcome.found.extend(written),
                Err(error) => {
                    outcome.error = Some(error.to_string());
                    break;
                }
            }
        }
        outcome.latest = Some(exchange.latest);
    }
    // 只留交接用得到的最近几问。
    let keep: HashSet<usize> = all.iter().rev().take(handoff::DONE_TURNS).map(|exchange| exchange.index).collect();
    outcome.picks.retain(|index, _| keep.contains(index));
    if outcome.latest.is_some() {
        if let Err(error) = write_handoff(owner, detail, &all, &outcome.picks) {
            outcome.error.get_or_insert(format!("交接写入失败：{error}"));
        }
    }
    outcome
}

fn write_handoff(
    owner: &Owner,
    detail: &ConversationDetail,
    all: &[Exchange],
    picks: &BTreeMap<usize, Picked>,
) -> std::io::Result<String> {
    let started = detail.turns.first().map_or(detail.summary.started_at, |turn| turn.timestamp);
    let ended = all.last().map_or(started, |exchange| exchange.latest);
    let cwd = detail.summary.folder_path.as_deref().map_or(owner.main.as_path(), Path::new);
    let folder = owner.expert.as_deref().filter(|expert| *expert != NO_EXPERT).unwrap_or(&owner.agent);
    let state = all
        .iter()
        .rev()
        .find(|exchange| classifier::segments(exchange).iter().any(|segment| segment.field == classifier::ANSWER))
        .or(all.last());
    handoff::write(
        &owner.main,
        &handoff::Session {
            folder,
            agent: &owner.agent,
            session_id: &detail.summary.id,
            title: detail.summary.title.as_deref(),
            started,
            ended,
            prompts: all.iter().filter(|exchange| exchange.index > 0).map(|exchange| (exchange.index, exchange.prompt.as_deref())).collect(),
            picks,
            commits: commits(cwd, started, ended),
            uncommitted: git_lines(cwd, &["status", "--short", "--untracked-files=normal", "--", ".", ":!.berth"]),
            state_turn: state.map_or(0, |exchange| exchange.index),
            last_answer: state.and_then(classifier::last_answer_part),
        },
    )
}

/// 会话期间所在目录的提交（`hash 标题`，新的在前）；不是 git 目录时为空。
fn commits(cwd: &Path, started: DateTime<Utc>, ended: DateTime<Utc>) -> Vec<String> {
    let since = format!("--since={}", started.to_rfc3339());
    // 提交常在最后一问回答之后才做，多算几分钟。
    let until = format!("--until={}", (ended + chrono::TimeDelta::minutes(10)).to_rfc3339());
    git_lines(cwd, &["log", "--format=%h %s", &since, &until])
}

/// 在 `cwd` 跑 git，按行返回输出；不是 git 目录或出错时为空。
fn git_lines(cwd: &Path, args: &[&str]) -> Vec<String> {
    std::process::Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).lines().map(str::to_owned).collect())
        .unwrap_or_default()
}

/// 手动分类一个会话（`knowledge.classify`）：从上次分类到的位置往后，跑完为止；不看开关。
pub(crate) async fn classify_session(
    conn: &DatabaseConnection,
    root: &Path,
    params: &Value,
) -> Result<Value, String> {
    let text = |key: &str| params.get(key).and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty());
    let agent_type = text("agentType").ok_or("缺少 agentType")?.to_owned();
    let session_id = text("sessionId").ok_or("缺少 sessionId")?.to_owned();
    let expert = Some(text("expert").unwrap_or(NO_EXPERT).to_owned());
    let scope = tasks::resolve(root).map_err(|error| error.message)?;
    let group = group::checkout_group(root).ok().map(|(name, _)| name);
    let config = load_config()?;
    let decider = crate::decision::resolve(conn).await?;
    let _claim = claim(&session_id).ok_or("这个会话正在分类，稍后再试")?;

    let agent: AgentType =
        serde_json::from_value(Value::String(agent_type.clone())).map_err(|_| format!("未知的 Agent：{agent_type}"))?;
    let id = session_id.clone();
    let detail = tokio::task::spawn_blocking(move || -> Result<ConversationDetail, String> {
        DeclarativeSessionParser::for_agent(agent)
            .map_err(|error| error.to_string())?
            .ok_or("这个 Agent 没有声明会话读取")?
            .get_conversation(&id)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())??;

    let owner = Owner {
        task: group.as_deref().and_then(|group| single_task(&scope.main, group)),
        expert,
        agent: tool_of(&agent_type),
        main: scope.main,
    };
    let cursor = update_state(|state| state.sessions.get(&session_id).cloned().unwrap_or_default());
    let from = cursor.latest.unwrap_or(DateTime::<Utc>::UNIX_EPOCH);
    let outcome = classify(conn, &decider, &config, &owner, &detail, from, cursor.picks, false).await;
    update_state(|state| {
        let entry = state.sessions.entry(session_id.clone()).or_default();
        entry.latest = outcome.latest.or(entry.latest);
        entry.picks = outcome.picks;
    });
    let all = answered(&detail).unwrap_or_default();
    let reached = outcome.latest.unwrap_or(from);
    let done = all.iter().filter(|exchange| exchange.latest <= reached).count();
    Ok(json!({
        "expert": owner.expert,
        "provider": decider.name,
        "rounds": all.len(),
        "classified": done,
        "written": outcome.found,
        "error": outcome.error,
    }))
}

/// 手动分类时可选的专家（与启动栏 `optionsFrom: "experts"` 同一来源）。
pub(crate) fn experts() -> Result<Value, String> {
    crate::commands::launchbar::expert_options()
        .map(Value::from)
        .map_err(|error| error.to_string())
}

/// 设置页「会话分类」：当前配置（文件写错时为 null，附错误）与配置文件路径（问法、阈值在文件里改）。
pub(crate) fn settings() -> Value {
    let path = berth_tool_core::paths::berth_home_dir().join(classifier::CONFIG_FILE);
    match load_config() {
        Ok(config) => json!({ "config": config, "error": null, "path": path }),
        Err(error) => json!({ "config": null, "error": error, "path": path }),
    }
}

pub(crate) fn save_settings(params: &Value) -> Result<Value, String> {
    let config: Config = serde_json::from_value(params["config"].clone()).map_err(|error| format!("配置无效：{error}"))?;
    classifier::save_config(&berth_tool_core::paths::berth_home_dir(), &config).map_err(|error| error.to_string())?;
    Ok(json!(config))
}

/// 会话类型 → 工具 id（声明了这个 `projectType` 的工具）：手动分类与后台写到同一个交接目录。
fn tool_of(agent_type: &str) -> String {
    berth_tool_core::repository::list_tool_asset_ids()
        .into_iter()
        .find(|tool| {
            berth_tool_core::repository::load_tool_asset(tool).ok().flatten().is_some_and(|asset| {
                asset.agent_extension().and_then(|extension| extension.get("projectType")?.as_str().map(str::to_owned)).as_deref()
                    == Some(agent_type)
            })
        })
        .unwrap_or_else(|| agent_type.to_owned())
}

/// 工具 id → 会话读取器：工具声明了 `projectType` 用它，否则就是工具 id。
fn parser(tool: &str) -> Result<DeclarativeSessionParser, String> {
    let declared = berth_tool_core::repository::load_tool_asset(tool)
        .ok()
        .flatten()
        .and_then(|asset| asset.agent_extension()?.get("projectType")?.as_str().map(str::to_owned));
    let id = declared.unwrap_or_else(|| tool.to_owned());
    let agent: AgentType = serde_json::from_value(Value::String(id)).map_err(|_| format!("未知的 Agent：{tool}"))?;
    DeclarativeSessionParser::for_agent(agent)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "这个 Agent 没有声明会话读取".to_owned())
}
