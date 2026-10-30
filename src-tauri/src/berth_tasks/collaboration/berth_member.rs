//! 群内置成员 Berth 的宿主侧：GUI 发给 `berth` 的消息（带服务商与模型）在后台跑 berth-agent，
//! 回答写回群（账本一侧见 `berth_group::builtin`）。不开终端、不是插件；Key 只在本进程内存里用。
//! 系统提示词只取内置专家「工具专家」的提示词文件（`$BERTH_HOME/prompts/`），不附加别的。
//! 上下文只来自当前会话文件（`$BERTH_HOME/experts/sessions/<项目目录名>/<会话>.jsonl`，一轮一行）；
//! 群账本只负责显示。输入框里发 `/new` 开始新会话。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};

use berth_agent::model::{GenaiModel, Tally};
use berth_agent::{record, session, Agent, ChatMessage, Event};
use berth_group::builtin::{self, BERTH};
use berth_project_core::tasks::{self, group};
use sea_orm::DatabaseConnection;
use serde_json::{json, Value};
use tokio::sync::watch;

/// berth-agent 支持的接口。
const APIS: [&str; 4] = ["anthropic", "openai-chat", "openai-responses", "gemini"];
/// 服务商档案按这个 Agent 类型叠加模型清单。
const AGENT_TYPE: &str = "berth";
/// 提示词来源：内置的「工具专家」（`berth_tool_core::builtin` 缺失时补上）。
const EXPERT: &str = "tool-expert";

/// 被停下的消息的回答。
const STOPPED: &str = "（已停止）";

/// 每个主项目排队与进行中的消息数：大于 0 即「处理中」。
static PENDING: LazyLock<Mutex<HashMap<PathBuf, usize>>> = LazyLock::new(Default::default);
/// 每个主项目一把锁：同一项目的消息按顺序回答，上下文才连贯。
static TURNS: LazyLock<Mutex<HashMap<PathBuf, Arc<tokio::sync::Mutex<()>>>>> =
    LazyLock::new(Default::default);
/// 每个主项目一个停止信号：值是停止的次数。每条消息排队时记下当时的值，值变了就不再回答。
static STOPS: LazyLock<Mutex<HashMap<PathBuf, watch::Sender<u64>>>> =
    LazyLock::new(Default::default);
/// 每个主项目正在回答的那条提问：执行过程 `group.read` 带给前端实时显示，回答写回时
/// 过程与用量一起进回答事件。
static LOGS: LazyLock<Mutex<HashMap<PathBuf, Live>>> = LazyLock::new(Default::default);

#[derive(Default)]
struct Live {
    ask: u64,
    lines: Vec<Value>,
    usage: Value,
    /// 完整结束时这一轮的全部消息（进会话文件）。
    turn: Option<Vec<ChatMessage>>,
}

/// 选中的模型：`group.post` 的 `model` 参数 `{ providerId, modelId }`。
pub struct Choice {
    pub provider_id: i32,
    pub model: String,
}

impl Choice {
    pub fn from_params(params: &Value) -> Option<Self> {
        let model = params.get("model")?;
        Some(Self {
            provider_id: i32::try_from(model.get("providerId")?.as_i64()?).ok()?,
            model: model.get("modelId")?.as_str()?.trim().to_owned(),
        })
    }
}

pub fn busy(main: &Path) -> bool {
    PENDING
        .lock()
        .map(|pending| pending.get(main).copied().unwrap_or(0) > 0)
        .unwrap_or(false)
}

fn stop_signal(main: &Path) -> watch::Receiver<u64> {
    let mut stops = STOPS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    stops
        .entry(main.to_path_buf())
        .or_insert_with(|| watch::channel(0).0)
        .subscribe()
}

/// 停下这个项目里 Berth 正在回答和排队的消息（`group.stopBerth`）；各自回一句「已停止」。
pub fn stop(project_root: &Path) -> Result<Value, String> {
    let main = tasks::resolve(project_root)
        .map_err(|error| error.message)?
        .main;
    let busy = busy(&main);
    if let Some(sender) = STOPS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(&main)
    {
        sender.send_modify(|count| *count += 1);
    }
    Ok(json!({ "stopped": busy }))
}

fn adjust(main: &Path, delta: isize) {
    if let Ok(mut pending) = PENDING.lock() {
        let count = pending.entry(main.to_path_buf()).or_default();
        *count = count.saturating_add_signed(delta);
    }
}

/// `posted` 是刚写进群的那条发给 Berth 的消息；回答（或出错说明）稍后作为群消息写回。
/// 没带模型时当场回一句说明，不让消息悬空。
pub fn start(
    conn: DatabaseConnection,
    project_root: &Path,
    posted: Value,
    choice: Option<Choice>,
    env: HashMap<String, String>,
) {
    let Ok(main) = tasks::resolve(project_root).map(|resolved| resolved.main) else {
        return;
    };
    let Some(choice) = choice else {
        reply(
            &main,
            &posted,
            "Berth 需要先选模型：请在 GUI 群组里与 Berth 单聊，在输入框选择服务商和模型后再发。",
            "",
            &[],
            &Value::Null,
        );
        return;
    };
    let turn = TURNS
        .lock()
        .map(|mut turns| turns.entry(main.clone()).or_default().clone())
        .unwrap_or_default();
    let stop = stop_signal(&main);
    let epoch = *stop.borrow();
    adjust(&main, 1);
    tokio::spawn(async move {
        let _turn = turn.lock().await;
        // 排队期间发了 /new 的话，这条进新会话：拿到锁后再定。
        let file = session_file(&main);
        let text = if *stop.borrow() != epoch {
            STOPPED.to_owned()
        } else {
            log_start(&main, group::seq(&posted));
            match answer(&conn, &main, &posted, &choice, env, &file, stop, epoch).await {
                Ok(text) if !text.trim().is_empty() => text,
                Ok(_) => "（没有回答）".to_owned(),
                Err(error) if error == STOPPED => error,
                Err(error) => format!("出错了：{error}"),
            }
        };
        // 先写回答再清日志：前端轮询时过程不会在两者之间闪空。
        let (steps, usage, turn) = logs(|logs| {
            logs.get_mut(&main)
                .map(|live| (live.lines.clone(), live.usage.clone(), live.turn.take()))
                .unwrap_or_default()
        });
        reply(&main, &posted, &text, &choice.model, &steps, &usage);
        logs(|logs| logs.remove(&main));
        // 停下或出错的一轮只记提问和那句回答：完整过程里可能有没结果的工具调用，回放会被拒收。
        let complete = turn.is_some();
        let messages = turn.unwrap_or_else(|| {
            let ask = posted
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default();
            vec![
                ChatMessage::user(ask),
                ChatMessage::assistant(text.as_str()),
            ]
        });
        let line = json!({
            "ask": group::seq(&posted),
            "at": posted.get("timestamp_ms"),
            "model": choice.model,
            "usage": usage,
            "steps": steps,
            "complete": complete,
            "messages": messages,
        });
        if let Err(error) = file.and_then(|file| session::append(&file, &line)) {
            tracing::warn!("[berth-member] cannot save the turn: {error}");
        }
        adjust(&main, -1);
    });
}

/// 这个项目的会话目录：`$BERTH_HOME/experts/sessions/<项目目录名>/`。
// ponytail: 按目录名分，不同位置的同名项目共用会话；要区分时改成目录名加路径摘要。
fn sessions_dir(main: &Path) -> PathBuf {
    let name = main
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "root".to_owned());
    crate::platform::paths::berth_home_dir()
        .join("experts")
        .join("sessions")
        .join(name)
}

fn session_name() -> String {
    chrono::Local::now().format("%Y%m%d-%H%M%S").to_string()
}

/// 当前会话文件；还没有就新建。
fn session_file(main: &Path) -> std::io::Result<PathBuf> {
    session::current_or_create(&sessions_dir(main), &session_name())
}

/// 输入框里的 `/new`（`group.berthNew`）：新建会话，之后的提问从空上下文开始；群里记一句作分隔。
pub fn new_session(project_root: &Path) -> Result<Value, String> {
    let main = tasks::resolve(project_root)
        .map_err(|error| error.message)?
        .main;
    let name = session_name();
    session::create(&sessions_dir(&main), &name).map_err(|error| error.to_string())?;
    let notice = json!({
        "kind": "message", "author": BERTH, "to": group::USER,
        "text": format!("（已开始新会话 {name}）"),
    });
    group::append(&main, group::MAIN_GROUP, notice).map_err(|error| error.message)?;
    Ok(json!({ "session": name }))
}

fn logs<T>(f: impl FnOnce(&mut HashMap<PathBuf, Live>) -> T) -> T {
    f(&mut LOGS.lock().unwrap_or_else(|poisoned| poisoned.into_inner()))
}

fn log_start(main: &Path, ask: u64) {
    logs(|logs| {
        logs.insert(
            main.to_path_buf(),
            Live {
                ask,
                ..Live::default()
            },
        )
    });
}

fn log(main: &Path, line: Value) {
    logs(|logs| {
        if let Some(Live { lines, .. }) = logs.get_mut(main) {
            lines.push(line);
            let over = lines.len().saturating_sub(builtin::STEP_LINES);
            lines.drain(..over);
        }
    });
}

/// 正在回答的提问与它到目前的执行过程（`group.read` 的 `builtin.log`）；没有为 null。
pub fn live_log(main: &Path) -> Value {
    logs(|logs| {
        logs.get(main).map_or(
            Value::Null,
            |live| json!({ "ask": live.ask, "lines": live.lines }),
        )
    })
}

fn reply(main: &Path, posted: &Value, text: &str, model: &str, steps: &[Value], usage: &Value) {
    let event = builtin::reply_event(posted, text, model, steps, usage);
    if let Err(error) = group::append(main, group::MAIN_GROUP, event) {
        tracing::warn!("[berth-member] cannot write the reply: {}", error.message);
    }
}

async fn answer(
    conn: &DatabaseConnection,
    main: &Path,
    posted: &Value,
    choice: &Choice,
    env: HashMap<String, String>,
    file: &std::io::Result<PathBuf>,
    mut stop: watch::Receiver<u64>,
    epoch: u64,
) -> Result<String, String> {
    let apis: Vec<String> = APIS.iter().map(|api| (*api).to_owned()).collect();
    let profile = crate::model_provider::injection::launch_profile(
        conn,
        choice.provider_id,
        AGENT_TYPE,
        Some(&apis),
        Some(&choice.model),
    )
    .await
    .map_err(|error| error.to_string())?
    .ok_or("找不到这个服务商，或它是官方登录；Berth 需要填了 Key 的服务商")?;
    let entry = profile
        .models
        .iter()
        .find(|model| model.id == choice.model)
        .or_else(|| profile.models.first())
        .ok_or("这个服务商没有 Berth 能用的模型")?;
    let api = entry.api.clone().ok_or("这个模型没有 Berth 能用的接口")?;
    let endpoint = entry
        .endpoint
        .as_deref()
        .and_then(|endpoint| profile.endpoints.get(endpoint))
        .ok_or("这个模型的端点没有配置地址")?;
    let (base_url, api_key, model_id) = (
        endpoint.base_url.clone(),
        endpoint.api_key.clone(),
        entry.id.clone(),
    );

    let file = file
        .as_ref()
        .map_err(|error| format!("打不开会话文件：{error}"))?;
    let history = session::messages(file);
    let ask = posted
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let system = system_prompt();
    let cwd = main.to_path_buf();
    let log_main = main.to_path_buf();
    let env: Vec<(String, String)> = env.into_iter().collect();

    // berth-agent 的循环不是 Send：放到自己的线程、用自己的 runtime 跑。
    let (sender, receiver) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        let result = (|| {
            let model = GenaiModel::new(&api, &base_url, &api_key, &model_id)?;
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|error| error.to_string())?;
            let mut agent = Agent::new(model, system, cwd);
            agent.set_env(env);
            agent.restore(history);
            let mut tally = Tally::default();
            // 模型的话按一次调用攒起来，到工具调用或这一轮结束时记第一行（同会话日志）。
            let mut said = String::new();
            let mut on_event = |event: Event| match event {
                Event::Usage(usage) => tally.add(usage),
                Event::Text(text) => said.push_str(text),
                Event::ToolStart { name, args } => {
                    if let Some(line) = builtin::text_line(&std::mem::take(&mut said)) {
                        log(&log_main, line);
                    }
                    log(&log_main, builtin::tool_line(name, &args));
                }
                Event::ToolEnd {
                    output,
                    failed: true,
                    ..
                } => log(&log_main, builtin::error_line(output)),
                Event::ToolEnd { .. } => {}
            };
            // 停下时丢弃这一轮：进行中的 bash 子进程随之被杀（kill_on_drop）。
            let result = runtime.block_on(async {
                tokio::select! {
                    result = agent.prompt(&ask, &mut on_event) => result,
                    Ok(_) = stop.wait_for(|count| *count != epoch) => Err(STOPPED.to_owned()),
                }
            });
            if let Some(line) = builtin::text_line(&said) {
                log(&log_main, line);
            }
            if result.is_ok() {
                let turn = agent.last_turn();
                logs(|logs| {
                    if let Some(live) = logs.get_mut(&log_main) {
                        live.turn = Some(turn);
                    }
                });
            }
            if tally.calls > 0 {
                let usage = json!({
                    "calls": tally.calls, "input": tally.input, "output": tally.output,
                    "cached": tally.cached, "context": tally.context,
                });
                logs(|logs| {
                    if let Some(live) = logs.get_mut(&log_main) {
                        live.usage = usage;
                    }
                });
            }
            result
        })();
        let _ = sender.send(result);
    });
    receiver.await.map_err(|_| "Berth 运行中断".to_owned())?
}

/// Berth 在本项目的会话（`group.berthSessions`），新的在前：名字、标题（第一轮的提问）、最后修改时间（毫秒）。
pub fn sessions(project_root: &Path) -> Result<Value, String> {
    let main = tasks::resolve(project_root)
        .map_err(|error| error.message)?
        .main;
    let dir = sessions_dir(&main);
    let list: Vec<Value> = session::list(&dir)
        .into_iter()
        .map(|name| {
            let file = session::path(&dir, &name);
            let title = session::first(&file).map(|line| record::turn(&line)["text"].clone());
            let updated = std::fs::metadata(&file)
                .and_then(|meta| meta.modified())
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|age| age.as_millis() as u64);
            json!({ "name": name, "title": title, "updatedAt": updated })
        })
        .collect();
    Ok(Value::Array(list))
}

/// 一个会话（`session`，缺省为当前会话）的对话记录（`group.berthRecord`）：各轮的提问、模型的话、
/// 工具调用与完整输出、用量（见 `berth_agent::record::turn`）。
// ponytail: 一次给整个会话；会话很长、标签页打开变慢时再分页。
pub fn record(project_root: &Path, params: &Value) -> Result<Value, String> {
    let main = tasks::resolve(project_root)
        .map_err(|error| error.message)?
        .main;
    let dir = sessions_dir(&main);
    let sessions = session::list(&dir);
    let wanted = params.get("session").and_then(Value::as_str);
    let chosen = sessions
        .iter()
        .find(|name| Some(name.as_str()) == wanted)
        .or_else(|| sessions.first());
    let turns: Vec<Value> = chosen
        .map(|name| session::lines(&session::path(&dir, name)))
        .unwrap_or_default()
        .iter()
        .map(record::turn)
        .collect();
    Ok(json!({ "session": chosen, "turns": turns }))
}

/// 工具专家的提示词；文件不在（用户删了）就不发系统提示词。
fn system_prompt() -> Option<String> {
    let home = crate::platform::paths::berth_home_dir();
    let table: Value = serde_json::from_str(
        &std::fs::read_to_string(home.join(format!("experts/{EXPERT}.json"))).ok()?,
    )
    .ok()?;
    let prompt = table.get("prompt")?.as_str()?;
    if !berth_tool_core::paths::is_valid_manifest_id(prompt) {
        return None;
    }
    std::fs::read_to_string(home.join(format!("prompts/{prompt}.md"))).ok()
}

/// 发给 Berth 的消息的投递状态：已回答或正在处理为已送达；都不是（处理中 GUI 重启丢了）为未送达。
// ponytail: 处理中时所有未回答的都算已送达（含重启前丢的旧消息）；要逐条区分时把排队的序号记进 PENDING。
pub fn mark_delivered(
    main: &Path,
    events: &[Value],
    delivery: &mut serde_json::Map<String, Value>,
) {
    let answered = builtin::answered(events);
    let busy = busy(main);
    for event in events {
        if event.get("kind").and_then(Value::as_str) == Some("message")
            && event.get("to").and_then(Value::as_str) == Some(BERTH)
        {
            let seq = group::seq(event);
            let state = if busy || answered.contains(&seq) {
                "delivered"
            } else {
                "undelivered"
            };
            delivery.insert(seq.to_string(), Value::from(state));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn choice_reads_provider_and_model() {
        let choice = Choice::from_params(
            &json!({"model": {"providerId": 68, "modelId": " deepseek-flash "}}),
        )
        .unwrap();
        assert_eq!(
            (choice.provider_id, choice.model.as_str()),
            (68, "deepseek-flash")
        );
        assert!(Choice::from_params(&json!({"to": "berth"})).is_none());
    }
}
