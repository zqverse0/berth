//! 测试用假 ACP Agent（`acp` 模块的单测驱动它，`cargo test` 顺带构建）：stdio 上用官方 crate 的 Agent 端。
//!
//! 状态目录 `FAKE_DIR`：`log` 逐行记收到的 new / load / resume 及其 `_meta`，`sessions/<id>` 存各会话的历史提示，
//! `child.pid` 是 `crash` 前起的子进程。`FAKE_RESUME=1` 时声明 `sessionCapabilities.resume`；`FAKE_LOAD_FAIL=1` 时 load 回内部错误。
//! `FAKE_MODELS=a,b` 时 new / load 回一个 model 配置项（当前为第一个），`session/set_config_option` 记 `model <值>`。
//!
//! 提示词决定行为：`say <词…>` 逐词流式回答；`recall` 回答本会话第一条提示；`tool` 先报一个工具调用；
//! `ask` 发一个四选项审批，回答选中的 id；`wait` 等到取消；`crash` 起一个子进程后退出。
//! `session/new` 返回前先推一条一轮之外的 `agent_message_chunk`。

use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use agent_client_protocol::v1::schema::{
    AgentCapabilities, CancelNotification, ContentBlock, ContentChunk, InitializeRequest, InitializeResponse,
    LoadSessionRequest, LoadSessionResponse, NewSessionRequest, NewSessionResponse, PermissionOption,
    PermissionOptionKind, PromptRequest, PromptResponse, RequestPermissionOutcome, RequestPermissionRequest,
    ResumeSessionRequest, ResumeSessionResponse, SessionCapabilities, SessionConfigOption, SessionConfigOptionCategory,
    SessionConfigOptionValue, SessionConfigSelectOption, SetSessionConfigOptionRequest, SetSessionConfigOptionResponse,
    SessionId, SessionNotification,
    SessionResumeCapabilities, SessionUpdate, StopReason, TextContent, ToolCall, ToolCallUpdate,
    ToolCallUpdateFields,
};
use agent_client_protocol::{Agent, ErrorCode, Stdio};
use futures::channel::oneshot;

fn dir() -> PathBuf {
    PathBuf::from(std::env::var("FAKE_DIR").expect("FAKE_DIR"))
}

fn log(line: String) {
    let mut file = std::fs::OpenOptions::new().create(true).append(true).open(dir().join("log")).unwrap();
    writeln!(file, "{line}").unwrap();
}

fn history(id: &str) -> Option<Vec<String>> {
    let text = std::fs::read_to_string(dir().join("sessions").join(id)).ok()?;
    Some(text.lines().map(str::to_owned).collect())
}

fn remember(id: &str, prompt: &str) {
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir().join("sessions").join(id))
        .unwrap();
    writeln!(file, "{prompt}").unwrap();
}

fn chunk(id: &SessionId, update: fn(ContentChunk) -> SessionUpdate, text: &str) -> SessionNotification {
    SessionNotification::new(id.clone(), update(ContentChunk::new(ContentBlock::Text(TextContent::new(text)))))
}

fn meta_text(meta: &Option<serde_json::Map<String, serde_json::Value>>) -> String {
    serde_json::to_string(meta).unwrap()
}

/// `FAKE_MODELS` 声明的 model 配置项，当前值为 `current`（缺省第一个）。
fn models(current: Option<&str>) -> Option<Vec<SessionConfigOption>> {
    let list = std::env::var("FAKE_MODELS").ok()?;
    let values: Vec<String> = list.split(',').map(str::to_owned).collect();
    let current = current.map_or_else(|| values[0].clone(), str::to_owned);
    let options: Vec<SessionConfigSelectOption> =
        values.iter().map(|value| SessionConfigSelectOption::new(value.clone(), value.clone())).collect();
    Some(vec![SessionConfigOption::select("model", "Model", current, options).category(SessionConfigOptionCategory::Model)])
}

fn main() -> agent_client_protocol::Result<()> {
    std::fs::create_dir_all(dir().join("sessions")).unwrap();
    let cancel: Arc<Mutex<Option<oneshot::Sender<()>>>> = Arc::default();
    let cancel_in = cancel.clone();
    futures::executor::block_on(
        Agent
            .v1()
            .on_receive_request(
                async move |request: InitializeRequest, responder, _cx| {
                    let mut sessions = SessionCapabilities::new();
                    if std::env::var_os("FAKE_RESUME").is_some() {
                        sessions = sessions.resume(SessionResumeCapabilities::new());
                    }
                    responder.respond(
                        InitializeResponse::new(request.protocol_version)
                            .agent_capabilities(AgentCapabilities::new().load_session(true).session_capabilities(sessions)),
                    )
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                async move |request: NewSessionRequest, responder, cx| {
                    let id = format!("s-{}", std::process::id());
                    std::fs::write(dir().join("sessions").join(&id), "").unwrap();
                    log(format!("new {} cwd={}", meta_text(&request.meta), request.cwd.display()));
                    let session = SessionId::new(id);
                    cx.send_notification(chunk(&session, SessionUpdate::AgentMessageChunk, "banner"))?;
                    responder.respond(NewSessionResponse::new(session).config_options(models(None)))
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                async move |request: LoadSessionRequest, responder, cx| {
                    log(format!("load {} {}", request.session_id.0, meta_text(&request.meta)));
                    if std::env::var_os("FAKE_LOAD_FAIL").is_some() {
                        return responder.respond_with_error(agent_client_protocol::Error::internal_error());
                    }
                    let Some(prompts) = history(&request.session_id.0) else {
                        return responder.respond_with_error(ErrorCode::RESOURCE_NOT_FOUND.into());
                    };
                    for prompt in prompts {
                        cx.send_notification(chunk(&request.session_id, SessionUpdate::UserMessageChunk, &prompt))?;
                        cx.send_notification(chunk(&request.session_id, SessionUpdate::AgentMessageChunk, "old answer"))?;
                    }
                    responder.respond(LoadSessionResponse::new().config_options(models(None)))
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                async move |request: ResumeSessionRequest, responder, _cx| {
                    log(format!("resume {} {}", request.session_id.0, meta_text(&request.meta)));
                    if history(&request.session_id.0).is_none() {
                        return responder.respond_with_error(ErrorCode::RESOURCE_NOT_FOUND.into());
                    }
                    responder.respond(ResumeSessionResponse::new())
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                async move |request: SetSessionConfigOptionRequest, responder, _cx| {
                    let SessionConfigOptionValue::ValueId { value } = request.value else {
                        return responder.respond_with_error(agent_client_protocol::Error::invalid_params());
                    };
                    log(format!("model {}", value.0));
                    responder.respond(SetSessionConfigOptionResponse::new(models(Some(&value.0)).unwrap_or_default()))
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_notification(
                async move |_: CancelNotification, _cx| {
                    if let Some(sender) = cancel_in.lock().unwrap().take() {
                        let _ = sender.send(());
                    }
                    Ok(())
                },
                agent_client_protocol::on_receive_notification!(),
            )
            .on_receive_request(
                async move |request: PromptRequest, responder, cx| {
                    let cancel = cancel.clone();
                    // 在独立任务里答：等审批 / 等取消时调度循环要能继续收消息。
                    cx.clone().spawn(async move {
                        let id = request.session_id.clone();
                        let prompt = match request.prompt.first() {
                            Some(ContentBlock::Text(text)) => text.text.clone(),
                            _ => String::new(),
                        };
                        let first = history(&id.0).unwrap_or_default().into_iter().next();
                        remember(&id.0, &prompt);
                        let say = |text: &str| cx.send_notification(chunk(&id, SessionUpdate::AgentMessageChunk, text));
                        let mut stop = StopReason::EndTurn;
                        if let Some(words) = prompt.strip_prefix("say ") {
                            for word in words.split(' ') {
                                say(&format!("{word} "))?;
                            }
                        } else if prompt == "recall" {
                            say(&first.unwrap_or_default())?;
                        } else if prompt == "tool" {
                            cx.send_notification(SessionNotification::new(
                                id.clone(),
                                SessionUpdate::ToolCall(ToolCall::new("t1", "Run echo")),
                            ))?;
                            say("done")?;
                        } else if prompt == "tool only" {
                            cx.send_notification(SessionNotification::new(
                                id.clone(),
                                SessionUpdate::ToolCall(ToolCall::new("t1", "Run echo")),
                            ))?;
                        } else if prompt == "ask" {
                            let options = vec![
                                PermissionOption::new("a1", "Allow", PermissionOptionKind::AllowOnce),
                                PermissionOption::new("a2", "Always", PermissionOptionKind::AllowAlways),
                                PermissionOption::new("r1", "Reject", PermissionOptionKind::RejectOnce),
                                PermissionOption::new("r2", "Never", PermissionOptionKind::RejectAlways),
                            ];
                            let call = ToolCallUpdate::new("t2", ToolCallUpdateFields::new().title("Write file"));
                            let response = cx
                                .send_request(RequestPermissionRequest::new(id.clone(), call, options))
                                .block_task()
                                .await?;
                            match response.outcome {
                                RequestPermissionOutcome::Selected(selected) => say(&format!("chose {}", selected.option_id.0))?,
                                _ => say("permission cancelled")?,
                            }
                        } else if prompt == "wait" {
                            let (sender, receiver) = oneshot::channel();
                            *cancel.lock().unwrap() = Some(sender);
                            say("waiting")?;
                            let _ = receiver.await;
                            stop = StopReason::Cancelled;
                        } else if prompt == "crash" {
                            let child = std::process::Command::new("sleep").arg("300").spawn().unwrap();
                            std::fs::write(dir().join("child.pid"), child.id().to_string()).unwrap();
                            std::process::exit(1);
                        }
                        responder.respond(PromptResponse::new(stop))
                    })
                },
                agent_client_protocol::on_receive_request!(),
            )
            .connect_to(Stdio::new()),
    )
}

