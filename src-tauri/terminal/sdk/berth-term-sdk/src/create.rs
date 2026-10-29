//! GUI 与 CLI 共用的终端创建组合；身份只来自本次创建的原子回执。

use std::io;

use berth_term_proto::{
    CAPABILITY_DAEMON_INSTANCE_PREFIX, CAPABILITY_SDK_PANE_BY_ID,
    CAPABILITY_SDK_PANE_GENERATION_GUARD, CAPABILITY_TERMINAL_CREATE_BINDING,
};

use crate::binding::RuntimeBinding;
use crate::{
    EnsureSession, Pane, ProcessSpec, Result, SessionName, Terminal, TerminalError,
    TerminalSizeSpec,
};

/// 在指定 session 中创建独立终端；没有 session 时连同初始窗口一起创建。
#[derive(Debug, Clone)]
pub struct CreateTerminal {
    /// 已由调用方解析的 session 身份。
    pub session: SessionName,
    /// 本次窗口的名称，供宿主投影自己的 terminal id。
    pub window_name: String,
    /// 初始进程的工作目录。
    pub cwd: String,
    /// 显式进程启动形式与已合并的环境。
    pub process: ProcessSpec,
    /// 初始窗口的 PTY 尺寸。
    pub size: TerminalSizeSpec,
    /// 已有 session 内创建时是否保留原活动窗口；首次 session 始终 detached。
    pub detached: bool,
    /// 异常退出（非 0 / 信号）时保留死 pane，宿主据此报告退出码与最后输出。
    pub keep_on_failed_exit: bool,
}

/// 本次创建的 pane 与出生时的运行绑定，不代表 shell 命令已经完成。
#[derive(Debug)]
pub struct CreatedTerminal {
    /// 按本次 PaneId 和出生代际寻址的守卫句柄。
    pub pane: Pane,
    /// 从同一 transport 的 epoch 和原子创建回执取得的身份。
    pub binding: RuntimeBinding,
}

impl Terminal {
    /// 创建独立终端并直接返回可操作身份，不后查活动 pane，也不重试未知创建结果。
    ///
    /// 旧 daemon 在任何创建副作用前返回 unsupported；创建已发送后的失败不触发
    /// 清理或重发，调用方不得将超时、断连或缺失回执当作「尚未创建」。
    pub async fn create_terminal(&self, request: CreateTerminal) -> Result<CreatedTerminal> {
        let endpoint = self.resolved_endpoint()?;
        let transport = self
            .connect_resolved_transport_for_operation(&endpoint, self.resolved_timeout(None))
            .await?;
        crate::capabilities::require(
            &transport,
            &[
                CAPABILITY_TERMINAL_CREATE_BINDING,
                CAPABILITY_SDK_PANE_BY_ID,
                CAPABILITY_SDK_PANE_GENERATION_GUARD,
            ],
        )
        .await?;
        // 实例身份是带运行时 token 的动态 capability，不能按静态字符串精确匹配。
        let daemon_instance = crate::capabilities::daemon_instance(&transport)
            .await?
            .ok_or_else(|| {
                TerminalError::unsupported(
                    CAPABILITY_DAEMON_INSTANCE_PREFIX,
                    "upgrade and restart the berth daemon before creating bound terminals",
                )
            })?;
        if request
            .process
            .process_command
            .as_ref()
            .is_some_and(|command| command.is_empty())
        {
            return Err(TerminalError::SpawnFailed {
                message: berth_term_proto::PROCESS_COMMAND_EMPTY_MESSAGE.to_owned(),
            });
        }

        // 即使原 facade 尚未连接，预检、ensure 和后续 window 都必须复用这一 transport。
        let connected = Terminal::from_connected_transport(
            endpoint,
            self.configured_default_timeout(),
            transport,
        );
        let session = connected
            .ensure_session(
                EnsureSession::named(request.session.clone())
                    .create_or_reuse()
                    .detached(true)
                    .window_name(request.window_name.clone())
                    .working_directory(request.cwd.clone())
                    .process(request.process.clone())
                    .size(request.size),
            )
            .await?;
        if session.name() != &request.session {
            return Err(unconfirmed_creation(
                "new-session returned a different session",
            ));
        }

        let created_pane = if session.was_created() {
            session.created_pane().copied().ok_or_else(|| {
                unconfirmed_creation("new-session did not return the created pane identity")
            })?
        } else {
            // duplicate→reuse 竞态也走这里，只返回自己的新 window，不能借用对方 pane。
            let window = session
                .new_window_with()
                .name(request.window_name)
                .cwd(request.cwd)
                .process(request.process)
                .detached(request.detached)
                .await?;
            let created = window.created_pane().copied().ok_or_else(|| {
                unconfirmed_creation("new-window did not return the created pane identity")
            })?;
            if window.target().session_name != request.session
                || window.target().window_index != created.window_index
            {
                return Err(unconfirmed_creation(
                    "new-window returned inconsistent pane identity",
                ));
            }
            created
        };
        if created_pane.generation == 0 {
            return Err(unconfirmed_creation("created pane generation is missing"));
        }
        let binding = RuntimeBinding::new(
            Some(daemon_instance),
            request.session,
            created_pane.pane_id,
            created_pane.generation,
        );
        let pane = session
            .pane_handle_by_id(
                created_pane.pane_id,
                created_pane.window_index,
                created_pane.pane_index,
            )
            .guard_generation_if_supported(created_pane.generation)
            .await?;
        // 同锁内核对出生身份并设定窗口尺寸；槽位换人或 respawn 都只能拒绝。
        pane.resize_guarded_window(request.size).await?;
        // ponytail: 创建后才设选项，进程若在这一次往返内就退出则不保留；launch.js 光启动引擎
        // 就远长于这次往返。要零窗口需 daemon 在 new-session/new-window 里带上该选项。
        if request.keep_on_failed_exit {
            pane.keep_on_failed_exit().await?;
        }
        Ok(CreatedTerminal { pane, binding })
    }
}

fn unconfirmed_creation(detail: &str) -> TerminalError {
    TerminalError::transport(
        "create-terminal",
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("terminal creation outcome is unknown: {detail}; do not retry automatically"),
        ),
    )
}

#[cfg(test)]
#[path = "create_tests.rs"]
mod tests;
