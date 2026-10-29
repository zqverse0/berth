//! Berth's currently supported pane operations.

use super::*;
use crate::handles::session::unexpected_response;
use berth_term_proto::{PaneWindowOperation, PaneWindowRequest, Request, Response};

impl Pane {
    /// Subscribes to the live raw pane output as a typed byte stream.
    ///
    /// Setup performs one `subscribe-pane-output` round trip and is
    /// fallible: a stale pane slot, a transport failure, or a refused
    /// daemon capability propagates as [`crate::TerminalError`].
    ///
    /// The returned [`PaneOutputStream`] preserves arbitrary bytes,
    /// pairs every chunk with the daemon's monotonic per-pane sequence,
    /// and surfaces any retained-output gaps as
    /// [`PaneOutputChunk::Lag`](crate::PaneOutputChunk::Lag) without ever
    /// converting raw bytes through `String::from_utf8_lossy`. Dropping
    /// the stream emits exactly one best-effort
    /// `unsubscribe-pane-output` request; if the unsubscribe is refused,
    /// late, or the transport is already gone the drop never closes the
    /// pane, its window/session/process, or the daemon itself.
    pub async fn output_stream(&self) -> Result<PaneOutputStream> {
        self.output_stream_starting_at(PaneOutputStart::Now).await
    }

    /// Subscribes to the live raw pane output, anchoring the cursor at
    /// the requested start position.
    ///
    /// See [`Self::output_stream`] for setup, drop, and lag semantics.
    pub async fn output_stream_starting_at(
        &self,
        start: PaneOutputStart,
    ) -> Result<PaneOutputStream> {
        PaneOutputStream::open(self.transport.clone(), self.proto_target_ref(), start).await
    }

    /// Returns the live daemon pane identity for this slot, when it is
    /// currently listed.
    ///
    /// Returns `Ok(None)` (rather than an error) for a stale slot, mirroring
    /// the [`Window`](super::Window)-handle stale-slot semantics.
    /// 代际守卫句柄检测到失效时返回确定性错误，不把旧实体映射到新进程。
    pub async fn id(&self) -> Result<Option<PaneId>> {
        if self.is_generation_guarded() {
            return Ok(self.info().await?.panes.first().map(|pane| pane.id));
        }
        if let Some(pane_id) = self.stable_id {
            let current =
                current_pane_ref_for_id(&self.transport, &self.target.session_name, pane_id)
                    .await?;
            return Ok(current.map(|_| pane_id));
        }
        Ok(current_pane_entry(&self.transport, &self.target)
            .await?
            .map(|entry| entry.pane_id))
    }

    /// Checks whether this exact pane slot is currently listed by the
    /// daemon.
    pub async fn exists(&self) -> Result<bool> {
        Ok(self.id().await?.is_some())
    }

    /// Returns a sticky info snapshot scoped to this pane's session,
    /// window, and pane.
    ///
    /// The snapshot is assembled from live `list-sessions`,
    /// `list-windows`, `list-panes`, and `display-message -p` responses so
    /// pane process state — running pid, exit state, geometry — reflects
    /// the daemon's current view rather than any handle-cached value.
    /// Stale slots return what is still observable: a session-only
    /// snapshot when the window or pane is gone, or an empty snapshot
    /// when the session itself is gone. 代际守卫句柄的实体失效则返回错误。
    pub async fn info(&self) -> Result<InfoSnapshot> {
        let info = match self.stable_id {
            Some(pane_id) => {
                match current_pane_ref_for_id(&self.transport, &self.target.session_name, pane_id)
                    .await?
                {
                    Some(target) => {
                        pane_info_snapshot(&self.transport, &target, Some(pane_id)).await?
                    }
                    None => InfoSnapshot::default(),
                }
            }
            None => pane_info_snapshot(&self.transport, &self.target, None).await?,
        };
        // 元数据由多次查询组装，返回前核对实体与代际；不能把换代进程的信息交给旧句柄。
        self.verify_info_snapshot(&info)?;
        Ok(info)
    }

    /// Captures the live pane grid as a [`PaneSnapshot`].
    ///
    /// The captured grid is read directly from the daemon's live
    /// berth-term-engine screen — the same in-memory grid that the crate-private
    /// terminal parser feeds from PTY output — so dimensions, cursor
    /// state, and per-cell glyph/attribute/colour data round-trip without
    /// any `capture-pane -p` text reconstruction step. Wide-glyph padding
    /// is preserved as padding cells in the row-major layout, raw bytes
    /// that are not valid UTF-8 stay isolated to the cell text payload
    /// rather than reaching helper output, and the daemon-derived
    /// [`revision`](PaneSnapshot::revision) is non-zero for a live pane
    /// and changes whenever any observable pane field mutates — output,
    /// resize, clear, exit. Stale slot handles resolve to a default empty
    /// snapshot whose revision is `0`; generation-guarded handles instead
    /// report a deterministic expired binding when the pane changed.
    pub async fn snapshot(&self) -> Result<PaneSnapshot> {
        pane_snapshot(self).await
    }

    /// Starts a daemon `capture-pane` request builder.
    pub fn capture_pane(&self) -> PaneCaptureBuilder<'_> {
        PaneCaptureBuilder::new(self)
    }

    /// Sends literal UTF-8 text bytes to this pane through the daemon.
    ///
    /// The payload is not interpreted as key names, does not expand tmux
    /// formats, and does not receive an implicit trailing newline. Use
    /// [`send_key`](Self::send_key) when a tmux key token such as `Enter`
    /// should be interpreted as a key press.
    pub async fn send_text(&self, text: impl AsRef<str>) -> Result<()> {
        send_text(self, text.as_ref()).await
    }

    /// Sends one tmux-compatible key token through the daemon.
    pub async fn send_key(&self, key: impl Into<String>) -> Result<()> {
        send_key(self, key.into()).await
    }

    /// Requests an absolute pane size through the daemon.
    ///
    /// Only dimensions that differ from the daemon's current pane details are
    /// sent. The daemon still applies normal `resize-pane` layout rules, so
    /// linked panes, borders, and neighboring panes can constrain the final
    /// geometry. No pane identity is cached by this handle.
    pub async fn resize(&self, size: TerminalSizeSpec) -> Result<()> {
        resize_to_size(self, size).await
    }

    /// 在 daemon 的同一把 state 锁内验证代际并修改该 pane 所在窗口的 PTY 尺寸。
    /// 仅适用于经守卫能力协商的稳定 pane handle。
    pub async fn resize_guarded_window(&self, size: TerminalSizeSpec) -> Result<()> {
        match self
            .request_guarded_window(PaneWindowOperation::Resize {
                width: size.cols,
                height: size.rows,
            })
            .await?
        {
            Response::ResizeWindow(_) => Ok(()),
            response => Err(unexpected_response("resize-window", response)),
        }
    }

    /// 进程以非 0 码或信号退出时保留死 pane（`remain-on-exit failed`），退出码与最后输出
    /// 留给宿主读；正常退出照常回收。
    pub async fn keep_on_failed_exit(&self) -> Result<()> {
        match self
            .transport
            .request(Request::SetOption(berth_term_proto::SetOptionRequest {
                scope: berth_term_proto::ScopeSelector::Pane(self.target().to_proto()),
                option: berth_term_proto::OptionName::RemainOnExit,
                value: "failed".to_owned(),
                mode: berth_term_proto::SetOptionMode::Replace,
            }))
            .await?
        {
            Response::SetOption(_) => Ok(()),
            response => Err(unexpected_response("set-option", response)),
        }
    }

    /// 在 daemon 的同一把 state 锁内验证代际并关闭该 pane 所在窗口或最后的 session。
    /// 仅适用于经守卫能力协商的稳定 pane handle。
    pub async fn close_guarded_window(&self) -> Result<()> {
        match self
            .request_guarded_window(PaneWindowOperation::Close)
            .await?
        {
            Response::KillWindow(_) | Response::KillSession(_) => Ok(()),
            response => Err(unexpected_response("kill-window", response)),
        }
    }

    async fn request_guarded_window(&self, operation: PaneWindowOperation) -> Result<Response> {
        if !self.is_generation_guarded() {
            return Err(TerminalError::unsupported(
                berth_term_proto::CAPABILITY_SDK_PANE_GENERATION_GUARD,
                "guard the pane generation with a capable daemon before a window operation",
            ));
        }
        self.transport()
            .request(Request::PaneWindow(PaneWindowRequest {
                target: self.proto_target_ref(),
                operation,
            }))
            .await
    }

    /// Sets this pane's UX title label.
    ///
    /// Titles are labels for humans and UI surfaces. They are not technical
    /// identity; use [`Self::id`] and [`Session::pane_by_id`](super::Session::pane_by_id)
    /// for stable addressing.
    pub async fn set_title(&self, title: impl Into<String>) -> Result<()> {
        set_title(self, title.into()).await
    }

    /// Returns this pane's current UX title label when the pane still exists.
    pub async fn title(&self) -> Result<Option<String>> {
        get_title(self).await
    }

    /// Expands a tmux format string (`display-message -p`) against this pane;
    /// `None` when the pane no longer exists. Unknown variables expand to "".
    pub async fn display(&self, format: &str) -> Result<Option<String>> {
        display_format(self, format).await
    }

    /// Consumes this handle and kills the addressed pane through the daemon.
    ///
    /// A stale handle is treated as an idempotent no-op and returns
    /// [`PaneCloseOutcome::AlreadyClosed`]. Dropping a [`Pane`] handle remains
    /// inert; this consuming method is the SDK operation that explicitly
    /// closes the pane slot and its process.
    pub async fn close(self) -> Result<PaneCloseOutcome> {
        close_pane(self).await
    }

    /// Consumes this handle without sending any daemon request.
    ///
    /// Detaching an SDK handle is equivalent to dropping it: the addressed
    /// pane slot, process, subscriptions owned elsewhere, and daemon state are
    /// left untouched. Use [`Self::close`] when the pane itself should be
    /// killed.
    pub fn detach(self) {}
}
