//! Tauri command wrappers for the personal terminal adapter.

use std::collections::{BTreeMap, HashMap};

use serde_json::Value;
use tauri::Manager;
use tauri::State;

use super::terminal_packet::{
    encode_local_terminal_packet, LOCAL_OUTPUT_BATCH_MAX_BYTES, LOCAL_OUTPUT_BATCH_MAX_EVENTS,
    LOCAL_OUTPUT_PACKET, LOCAL_RESYNC_PACKET,
};
use super::{
    attach_terminal_core, create_terminal_core, detach_terminal_core, get_terminal_core,
    list_terminals_core, prepare_credential_env, remove_terminal_record_core, resize_terminal_core,
    send_terminal_key_core, send_terminal_line_core, terminate_terminal_core, CreatePersonalTerminalRequest,
    ResizeAttachedTerminalRequest, TerminalClientRequest, TerminalIdRequest,
    MAX_TERMINAL_INPUT_BYTES,
};
use crate::app_error::AppCommandError;
use crate::db::AppDatabase;
use crate::event_bridge::EventEmitter;
use crate::terminal::manager::{TerminalDescriptor, TerminalManager};
use crate::terminal::protocol::TerminalSnapshot;

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn terminal_create(
    cwd: String,
    shell: Option<String>,
    initial_command: Option<String>,
    executable: Option<String>,
    args: Vec<String>,
    env: HashMap<String, String>,
    agent_id: Option<String>,
    agent_mode_id: Option<String>,
    agent_extra_args: Option<Vec<String>>,
    agent_capability_values: Option<BTreeMap<String, Value>>,
    agent_launch_inputs: Option<BTreeMap<String, Value>>,
    provider_id: Option<i32>,
    model_id: Option<String>,
    terminal_id: Option<String>,
    folder_id: Option<i32>,
    rows: u16,
    cols: u16,
    client_id: Option<String>,
    manager: State<'_, TerminalManager>,
    app_handle: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<TerminalDescriptor, AppCommandError> {
    let mut request = CreatePersonalTerminalRequest {
        terminal_id,
        cwd,
        shell,
        initial_command,
        executable,
        args,
        env,
        agent_id,
        agent_mode_id,
        agent_extra_args: agent_extra_args.unwrap_or_default(),
        agent_capability_values: agent_capability_values.unwrap_or_default(),
        agent_launch_inputs,
        provider_injection_args: Vec::new(),
        folder_id,
        rows,
        cols,
        client_id: client_id.or_else(|| Some(window.label().to_string())),
    };
    let app_data_dir = app_handle.path().app_data_dir().map_err(|error| {
        AppCommandError::task_execution_failed("Failed to resolve app data directory")
            .with_detail(error.to_string())
    })?;
    let effective_data_dir = crate::platform::paths::resolve_effective_data_dir(&app_data_dir);
    // 远程项目里的普通 shell：改为 ssh 到设备上的对应目录（Agent 与指定程序的终端不变）。
    if let (Some(folder_id), None, None, None) = (
        request.folder_id,
        request.agent_id.as_ref(),
        request.executable.as_ref(),
        request.initial_command.as_ref(),
    ) {
        let db = app_handle.state::<crate::db::AppDatabase>();
        if let Some(mut argv) = crate::devices::remote_shell(&db.conn, folder_id, &request.cwd).await {
            request.executable = Some(argv.remove(0));
            request.args = argv;
        }
    }
    let mut extra_env = prepare_credential_env(&effective_data_dir);
    if let Some(folder_id) = request.folder_id {
        let db = app_handle.state::<crate::db::AppDatabase>();
        if let Some(vars) = crate::devices::remote_env(&db.conn, folder_id).await {
            let env = extra_env.get_or_insert_with(HashMap::new);
            env.extend(vars.into_iter().map(|(key, value)| (key.to_owned(), value)));
        }
    }
    // Agent 启动：选中档案写成一次性启动档案，`--berth-provider <文件>` 走独立 argv
    // 通道（不混入 agent_extra_args，有 typed inputs 时那条会被丢掉）。不经 pane 环境：
    // termd 会把会话首个 pane 的环境当后续窗口的基底。任一环缺失则不注入。
    if let Some(agent_id) = request.agent_id.as_deref() {
        let db = app_handle.state::<crate::db::AppDatabase>();
        request.provider_injection_args = crate::model_provider::injection::resolve_for_launch(
            &db.conn,
            agent_id,
            provider_id,
            model_id.as_deref(),
        )
        .await?;
    }
    create_terminal_core(
        &manager,
        EventEmitter::Tauri(app_handle),
        request,
        extra_env,
    )
    .await
}

// 清单与描述要向 daemon 全量扫描 pane，前端每 2 秒轮询、启动 Agent 后更密：
// 同步 command 会在主线程上等 executor，改为 async 放进阻塞线程池（同 attach/write）。
#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn terminal_list_sessions(
    manager: State<'_, TerminalManager>,
) -> Result<Vec<TerminalDescriptor>, AppCommandError> {
    let manager = manager.inner().clone();
    run_blocking(move || list_terminals_core(&manager)).await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn terminal_get_session(
    terminal_id: String,
    tail_lines: Option<u32>,
    manager: State<'_, TerminalManager>,
) -> Result<TerminalDescriptor, AppCommandError> {
    let manager = manager.inner().clone();
    run_blocking(move || {
        get_terminal_core(&manager, TerminalIdRequest { terminal_id }, tail_lines)
    })
    .await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub fn terminal_send_key(
    terminal_id: String,
    key: String,
    manager: State<'_, TerminalManager>,
) -> Result<(), AppCommandError> {
    send_terminal_key_core(&manager, TerminalIdRequest { terminal_id }, &key)
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub fn terminal_send_line(
    terminal_id: String,
    text: String,
    manager: State<'_, TerminalManager>,
) -> Result<(), AppCommandError> {
    send_terminal_line_core(&manager, TerminalIdRequest { terminal_id }, &text)
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn terminal_attach_channel(
    terminal_id: String,
    client_id: String,
    on_output: tauri::ipc::Channel<tauri::ipc::Response>,
    manager: State<'_, TerminalManager>,
) -> Result<crate::terminal::protocol::TerminalSnapshot, AppCommandError> {
    attach_terminal_to_sink(manager.inner(), terminal_id, client_id, on_output).await
}

/// 终端输出包的去处：桌面窗口的 IPC Channel，或远程浏览器的流式连接（`crate::remote`）。
/// 返回 false 表示对端已断开，推流随即结束并 detach。
pub trait TerminalPacketSink: Send + 'static {
    fn send_packet(&mut self, packet: Vec<u8>) -> impl std::future::Future<Output = bool> + Send;
}

impl TerminalPacketSink for tauri::ipc::Channel<tauri::ipc::Response> {
    async fn send_packet(&mut self, packet: Vec<u8>) -> bool {
        self.send(tauri::ipc::Response::new(packet)).is_ok()
    }
}

/// attach 并返回快照；输出包在后台推给 `sink`，直到对端断开或流结束后 detach。
pub async fn attach_terminal_to_sink<S: TerminalPacketSink>(
    manager: &TerminalManager,
    terminal_id: String,
    client_id: String,
    mut sink: S,
) -> Result<crate::terminal::protocol::TerminalSnapshot, AppCommandError> {
    let detach_terminal_id = terminal_id.clone();
    let detach_client_id = client_id.clone();
    let detach_manager = manager.clone();
    let attach_manager = manager.clone();
    let mut attachment = run_blocking(move || {
        attach_terminal_core(
            &attach_manager,
            TerminalClientRequest {
                terminal_id,
                client_id,
            },
        )
    })
    .await?;
    let snapshot = attachment.snapshot.clone();
    tauri::async_runtime::spawn(async move {
        let mut pending_event: Option<crate::terminal::protocol::TerminalStreamEvent> = None;
        loop {
            let event = if let Some(event) = pending_event.take() {
                event
            } else {
                tokio::select! {
                    event = attachment.data_rx.recv() => {
                        let Some(event) = event else {
                            break;
                        };
                        event
                    }
                    changed = attachment.control_rx.changed() => {
                        if changed.is_err() {
                            break;
                        }
                        // 先取出值：读锁不能跨下面发送的 await。
                        let control = attachment.control_rx.borrow_and_update().clone();
                        if let crate::terminal::protocol::SubscriberControl::ResyncRequired {
                            sequence,
                        } = control
                        {
                            let packet = encode_local_terminal_packet(
                                LOCAL_RESYNC_PACKET,
                                sequence,
                                sequence,
                                &[],
                            );
                            if !sink.send_packet(packet).await {
                                break;
                            }
                        }
                        continue;
                    }
                }
            };

            match event {
                crate::terminal::protocol::TerminalStreamEvent::Output {
                    sequence, data, ..
                } => {
                    let sequence_start = sequence;
                    let mut sequence_end = sequence;
                    let mut output = data;
                    let mut event_count = 1;
                    let mut data_closed = false;
                    let mut sequence_gap = false;

                    while output.len() < LOCAL_OUTPUT_BATCH_MAX_BYTES
                        && event_count < LOCAL_OUTPUT_BATCH_MAX_EVENTS
                    {
                        match attachment.data_rx.try_recv() {
                            Ok(next) => match next {
                                crate::terminal::protocol::TerminalStreamEvent::Output {
                                    sequence: next_sequence,
                                    data: next_data,
                                    terminal_id,
                                } => {
                                    let contiguous =
                                        sequence_end.checked_add(1) == Some(next_sequence);
                                    let within_limit = next_data.len()
                                        <= LOCAL_OUTPUT_BATCH_MAX_BYTES - output.len();
                                    if !contiguous {
                                        sequence_gap = true;
                                        break;
                                    }
                                    if within_limit {
                                        sequence_end = next_sequence;
                                        output.extend_from_slice(&next_data);
                                        event_count += 1;
                                    } else {
                                        pending_event = Some(
                                            crate::terminal::protocol::TerminalStreamEvent::Output {
                                                terminal_id,
                                                sequence: next_sequence,
                                                data: next_data,
                                            },
                                        );
                                        break;
                                    }
                                }
                                other => {
                                    pending_event = Some(other);
                                    break;
                                }
                            },
                            Err(tokio::sync::mpsc::error::TryRecvError::Empty) => break,
                            Err(tokio::sync::mpsc::error::TryRecvError::Disconnected) => {
                                data_closed = true;
                                break;
                            }
                        }
                    }

                    let packet = encode_local_terminal_packet(
                        LOCAL_OUTPUT_PACKET,
                        sequence_start,
                        sequence_end,
                        &output,
                    );
                    if !sink.send_packet(packet).await {
                        break;
                    }
                    if sequence_gap {
                        let packet = encode_local_terminal_packet(
                            LOCAL_RESYNC_PACKET,
                            sequence_end,
                            sequence_end,
                            &[],
                        );
                        let _ = sink.send_packet(packet).await;
                        break;
                    }
                    if data_closed {
                        break;
                    }
                }
                ordered => {
                    let Some(sequence) = ordered.sequence() else {
                        continue;
                    };
                    let packet =
                        encode_local_terminal_packet(LOCAL_RESYNC_PACKET, sequence, sequence, &[]);
                    if !sink.send_packet(packet).await {
                        break;
                    }
                }
            }
        }
        detach_manager.detach_attachment(&detach_terminal_id, &detach_client_id, &attachment);
    });
    Ok(snapshot)
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub fn terminal_detach(
    terminal_id: String,
    client_id: String,
    manager: State<'_, TerminalManager>,
) -> Result<(), AppCommandError> {
    detach_terminal_core(
        &manager,
        TerminalClientRequest {
            terminal_id,
            client_id,
        },
    )
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn terminal_write_attached_raw(
    request: tauri::ipc::Request<'_>,
    manager: State<'_, TerminalManager>,
) -> Result<(), AppCommandError> {
    let header = |name: &'static str| {
        request
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .ok_or_else(|| AppCommandError::invalid_input(format!("Missing {name} header")))
    };
    let terminal_id = urlencoding::decode(header("x-berth-terminal-id")?)
        .map_err(|_| AppCommandError::invalid_input("Invalid terminal id header"))?
        .into_owned();
    let client_id = urlencoding::decode(header("x-berth-client-id")?)
        .map_err(|_| AppCommandError::invalid_input("Invalid terminal client id header"))?
        .into_owned();
    let input_sequence = header("x-berth-input-sequence")?
        .parse::<u64>()
        .map_err(|_| AppCommandError::invalid_input("Invalid terminal input sequence"))?;
    let data = match request.body() {
        tauri::ipc::InvokeBody::Raw(data) => data.as_slice(),
        tauri::ipc::InvokeBody::Json(_) => {
            return Err(AppCommandError::invalid_input(
                "Terminal input must use a raw IPC body",
            ));
        }
    };
    if data.len() > MAX_TERMINAL_INPUT_BYTES {
        return Err(AppCommandError::invalid_input(
            "Terminal input exceeds the 1 MiB limit",
        ));
    }
    let data = data.to_vec();
    let manager = manager.inner().clone();
    run_blocking(move || {
        manager
            .write_attached(&terminal_id, &client_id, input_sequence, &data)
            .map(|_| ())
            .map_err(AppCommandError::from)
    })
    .await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn terminal_resize_attached(
    terminal_id: String,
    client_id: String,
    input_sequence: u64,
    cols: u16,
    rows: u16,
    manager: State<'_, TerminalManager>,
) -> Result<TerminalSnapshot, AppCommandError> {
    let manager = manager.inner().clone();
    run_blocking(move || {
        resize_terminal_core(
            &manager,
            ResizeAttachedTerminalRequest {
                terminal_id,
                client_id,
                input_sequence,
                cols,
                rows,
            },
        )
    })
    .await
}

/// 终端 command 会同步等待 executor 回执和终端输入锁：放到阻塞线程池，
/// 既不占主线程，也不卡住 async runtime 的 worker。同一终端的顺序由前端
/// `operationTail` 串行 + 后端 `input_sequence` 栅栏保证，与执行线程无关。
#[cfg(feature = "tauri-runtime")]
async fn run_blocking<T: Send + 'static>(
    operation: impl FnOnce() -> Result<T, AppCommandError> + Send + 'static,
) -> Result<T, AppCommandError> {
    tokio::task::spawn_blocking(operation)
        .await
        .map_err(|error| AppCommandError::task_execution_failed(error.to_string()))?
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn terminal_terminate(
    terminal_id: String,
    manager: State<'_, TerminalManager>,
) -> Result<(), AppCommandError> {
    terminate_terminal_core(&manager, TerminalIdRequest { terminal_id }).await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn terminal_remove_record(
    terminal_id: String,
    manager: State<'_, TerminalManager>,
    db: State<'_, AppDatabase>,
    app_handle: tauri::AppHandle,
) -> Result<(), AppCommandError> {
    remove_terminal_record_core(
        &db.conn,
        &EventEmitter::Tauri(app_handle),
        &manager,
        TerminalIdRequest { terminal_id },
    )
    .await
}
