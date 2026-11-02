//! 节点的终端：经本机 termd 列出、接入（可视区快照 + 增量输出）、输入、改尺寸、拉历史、新建。
//! 与 `berth terminal …` 同一套绑定与创建实现；接入快照与 GUI 同一份（`Pane::paint`）。

use std::collections::HashMap;

use berth_node::api::{ApiError, Paint, Push};
use berth_term_sdk::berth::{
    normalize_snapshot_line_endings_for_xterm, Pane, PaneOutputChunk, PaneOutputStart, Terminal,
    TerminalSizeSpec,
};
use serde_json::{json, Value};
use tokio::sync::mpsc::UnboundedSender;
use tokio::task::AbortHandle;

use super::{api_error, Cmd, Ctx};

/// 一个会话的终端状态：只由该会话的有序工作者持有（输入、尺寸、接入按发出顺序执行）。
pub(crate) struct Terminals {
    terminal: Option<Terminal>,
    panes: HashMap<String, Pane>,
    streams: HashMap<String, AbortHandle>,
    out: UnboundedSender<Cmd>,
}

impl Drop for Terminals {
    fn drop(&mut self) {
        for stream in self.streams.values() {
            stream.abort();
        }
    }
}

pub(crate) async fn list(ctx: &Ctx, project: Option<i64>) -> Result<Value, ApiError> {
    let instance = crate::project::resolve_instance(true).map_err(api_error)?;
    let project = project.map(|id| id as i32);
    let entries = crate::workspace_terminal::list_entries(&instance, &ctx.termd, project, true)
        .await
        .map_err(api_error)?;
    Ok(json!({ "terminals": entries }))
}

pub(crate) async fn create(
    ctx: &Ctx,
    project: i64,
    agent: Option<(String, std::collections::BTreeMap<String, Value>)>,
    provider: Option<i32>,
    model: Option<&str>,
) -> Result<Value, ApiError> {
    let created = crate::workspace_terminal::create_terminal(
        &ctx.termd,
        None,
        project as i32,
        agent,
        provider,
        model,
        None,
        true,
    )
    .await
    .map_err(api_error)?;
    Ok(json!({ "terminal": created }))
}

impl Terminals {
    pub(crate) fn new(out: UnboundedSender<Cmd>) -> Self {
        Self {
            terminal: None,
            panes: HashMap::new(),
            streams: HashMap::new(),
            out,
        }
    }

    async fn pane(&mut self, ctx: &Ctx, target: &str) -> Result<Pane, ApiError> {
        if let Some(pane) = self.panes.get(target) {
            return Ok(pane.clone());
        }
        let binding = crate::workspace_terminal::parse_binding(target, true).map_err(api_error)?;
        if self.terminal.is_none() {
            let terminal = crate::workspace_terminal::connect_existing(&ctx.termd, true)
                .await
                .map_err(api_error)?;
            self.terminal = Some(terminal);
        }
        let terminal = self.terminal.as_ref().expect("connected above");
        let pane = crate::workspace_terminal::bound_pane(terminal, binding, true)
            .await
            .map_err(api_error)?;
        self.panes.insert(target.to_owned(), pane.clone());
        Ok(pane)
    }

    /// 操作失败后丢掉缓存的句柄（终端可能已关、termd 可能重启），下次重新绑定。
    fn forget(&mut self, target: &str) {
        self.panes.remove(target);
        self.terminal = None;
    }

    pub(crate) async fn attach(&mut self, ctx: &Ctx, target: &str) -> Result<(Paint, Vec<u8>), ApiError> {
        let result = self.attach_inner(ctx, target).await;
        if result.is_err() {
            self.forget(target);
        }
        result
    }

    async fn attach_inner(&mut self, ctx: &Ctx, target: &str) -> Result<(Paint, Vec<u8>), ApiError> {
        let pane = self.pane(ctx, target).await?;
        let size = pane
            .info()
            .await
            .map_err(sdk_error)?
            .panes
            .first()
            .map(|info| info.size)
            .unwrap_or_else(|| TerminalSizeSpec::new(80, 24));
        // 先订阅再拍快照：快照水位之后的输出一个不漏。
        let mut stream = pane
            .output_stream_starting_at(PaneOutputStart::Now)
            .await
            .map_err(sdk_error)?;
        let paint = pane.paint(size, false).await.map_err(sdk_error)?;
        let cutoff = paint.output_sequence;
        let out = self.out.clone();
        let owned = target.to_owned();
        let forward = tokio::spawn(async move {
            let push = |event: Push, body: Vec<u8>| out.send(Cmd::Push(event, body)).is_ok();
            loop {
                let event = match stream.next().await {
                    Ok(Some(PaneOutputChunk::Bytes { sequence, bytes })) => {
                        // 空块是 pane EOF 标记；水位之前的已在快照里。
                        if bytes.is_empty() || sequence < cutoff {
                            continue;
                        }
                        if !push(
                            Push::Output {
                                target: owned.clone(),
                                seq: sequence,
                            },
                            bytes,
                        ) {
                            return;
                        }
                        continue;
                    }
                    Ok(None) => Push::Exited { target: owned },
                    _ => Push::Resync { target: owned },
                };
                push(event, Vec::new());
                return;
            }
        });
        if let Some(previous) = self.streams.insert(target.to_owned(), forward.abort_handle()) {
            previous.abort();
        }
        Ok((
            Paint {
                seq: cutoff,
                rows: paint.size.rows.max(1),
                cols: paint.size.cols.max(1),
            },
            paint.ansi,
        ))
    }

    pub(crate) fn detach(&mut self, target: &str) {
        if let Some(stream) = self.streams.remove(target) {
            stream.abort();
        }
    }

    pub(crate) async fn input(&mut self, ctx: &Ctx, target: &str, bytes: &[u8]) -> Result<(), ApiError> {
        let pane = self.pane(ctx, target).await?;
        let result = pane
            .send_text(String::from_utf8_lossy(bytes))
            .await
            .map_err(sdk_error);
        if result.is_err() {
            self.forget(target);
        }
        result
    }

    /// 改尺寸并回改后的可视区画面（客户端据此重画，不必等输出）。
    pub(crate) async fn resize(
        &mut self,
        ctx: &Ctx,
        target: &str,
        rows: u16,
        cols: u16,
    ) -> Result<(Paint, Vec<u8>), ApiError> {
        let pane = self.pane(ctx, target).await?;
        let size = TerminalSizeSpec::new(cols.max(1), rows.max(1));
        let result = async {
            pane.resize_guarded_window(size).await?;
            pane.paint_rows(size).await
        }
        .await
        .map_err(sdk_error);
        match result {
            Ok(paint) => Ok((
                Paint {
                    seq: paint.output_sequence,
                    rows: paint.size.rows.max(1),
                    cols: paint.size.cols.max(1),
                },
                paint.ansi,
            )),
            Err(error) => {
                self.forget(target);
                Err(error)
            }
        }
    }

    /// 关闭终端：与 `berth terminal close` 同一实现。
    pub(crate) async fn close(&mut self, ctx: &Ctx, target: &str) -> Result<(), ApiError> {
        self.detach(target);
        self.panes.remove(target);
        crate::workspace_terminal::close(&ctx.termd, target, true)
            .await
            .map_err(api_error)
    }

    /// 可视区之上的最近 `lines` 行（带颜色）。
    pub(crate) async fn history(&mut self, ctx: &Ctx, target: &str, lines: u32) -> Result<Vec<u8>, ApiError> {
        let pane = self.pane(ctx, target).await?;
        let lines = i64::from(lines.clamp(1, 10_000));
        let capture = pane
            .capture_pane()
            .escape_ansi(true)
            .start(-lines)
            .end(-1)
            .await
            .map_err(sdk_error)?;
        Ok(normalize_snapshot_line_endings_for_xterm(capture.stdout))
    }
}

fn sdk_error(error: berth_term_sdk::berth::TerminalError) -> ApiError {
    ApiError::new("unavailable", error.to_string())
}
