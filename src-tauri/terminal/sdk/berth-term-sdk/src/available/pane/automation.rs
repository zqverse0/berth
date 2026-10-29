//! Available pane automation capabilities not currently exposed through Berth.

use super::*;

impl Pane {
    /// Waits until the pane emits the requested raw byte sequence.
    ///
    /// Dropping the returned future before it completes sends a best-effort
    /// daemon cancellation request. Drop cleanup only removes the wait record;
    /// it never closes panes, sessions, processes, or the daemon.
    pub async fn wait_for(&self, bytes: impl AsRef<[u8]>) -> Result<()> {
        crate::wait::wait_for_bytes(self, bytes.as_ref().to_vec()).await
    }

    /// Arms a daemon-backed wait for future raw pane output bytes.
    ///
    /// The returned [`ArmedWait`] is created only after the SDK has sent the
    /// daemon wait request with a live-tail cursor, so it cannot match retained
    /// history from before this call. Await the handle after triggering the
    /// output that should satisfy the wait.
    pub async fn wait_for_next(&self, bytes: impl AsRef<[u8]>) -> Result<ArmedWait> {
        crate::wait::wait_for_next_bytes(self, bytes.as_ref().to_vec()).await
    }

    /// Waits until the pane's rendered snapshot text contains non-empty `text`.
    ///
    /// This is a client-side text wait over fresh [`Self::snapshot`]
    /// captures. It observes the rendered grid text already present at the
    /// time of the first snapshot and keeps polling until the configured SDK
    /// operation timeout expires. Unlike [`Self::wait_for`], this method does
    /// not subscribe to raw pane output and does not send SDK byte-wait
    /// cancellation requests.
    pub async fn wait_for_text(&self, text: impl AsRef<str>) -> Result<()> {
        crate::wait::wait_for_text(self, text.as_ref().to_owned()).await
    }

    /// Arms a daemon-backed wait for future pane output containing `text`.
    ///
    /// This matches the UTF-8 bytes of `text` in raw output emitted after the
    /// wait is armed. It does not inspect existing snapshots or retained output
    /// history.
    pub async fn wait_for_text_next(&self, text: impl AsRef<str>) -> Result<ArmedWait> {
        crate::wait::wait_for_text_next(self, text.as_ref().to_owned()).await
    }

    /// Starts a visible-screen text expectation builder.
    ///
    /// Unlike raw output waits, visible waits poll rendered
    /// [`PaneSnapshot`] text. They observe the current screen after terminal
    /// control sequences, clears, wrapping, and redraws have been applied.
    pub fn expect_visible_text(&self) -> VisibleTextExpectation<'_> {
        VisibleTextExpectation::new(self)
    }

    /// Waits until the pane process exits or the pane slot becomes stale.
    ///
    /// The wait polls daemon sticky pane metadata through [`Self::info`].
    /// It does not subscribe to raw output and does not send SDK byte-wait
    /// cancellation requests. `Ok(None)` means the pane was already stale, or
    /// vanished before the daemon could retain exit details for this slot.
    pub async fn wait_exit(&self) -> Result<Option<PaneExitState>> {
        crate::wait::wait_exit(self).await
    }

    /// Alias for [`Self::wait_exit`].
    pub async fn wait_for_exit(&self) -> Result<Option<PaneExitState>> {
        self.wait_exit().await
    }

    /// Collects bounded raw pane output bytes until the pane process exits.
    ///
    /// Collection starts at the live output cursor, retains at most
    /// `max_bytes`, and keeps waiting for pane exit even after the cap is
    /// reached. Returned bytes are raw pane-output bytes; lag notices are
    /// reported on the returned [`CollectedPaneOutput`] and are not spliced
    /// into the byte buffer.
    pub async fn collect_output_until_exit(&self, max_bytes: usize) -> Result<CollectedPaneOutput> {
        crate::extract::collect_output_until_exit(self, max_bytes).await
    }

    /// Collects bounded raw pane output from the requested stream start until
    /// the pane process exits.
    ///
    /// See [`Self::collect_output_until_exit`] for cap, lag, and byte
    /// preservation semantics.
    pub async fn collect_output_until_exit_starting_at(
        &self,
        start: PaneOutputStart,
        max_bytes: usize,
    ) -> Result<CollectedPaneOutput> {
        crate::extract::collect_output_until_exit_starting_at(self, start, max_bytes).await
    }

    /// Subscribes to the live pane output rendered into UTF-8 lines.
    ///
    /// Setup is fallible (see [`Self::output_stream`]). Beyond the raw
    /// stream the line stream applies two well-isolated transformations:
    /// it splits on the LF byte `b'\n'` and runs each completed line
    /// through `String::from_utf8_lossy`, replacing every byte that is
    /// not valid UTF-8 with the Unicode replacement character `U+FFFD`.
    /// Bytes between LFs stay buffered until the next LF arrives, and a
    /// daemon-side lag drops the in-flight partial line; both
    /// transformations are documented in detail on the
    /// [`crate::events::streams`] module. Drop semantics match
    /// [`Self::output_stream`].
    pub async fn line_stream(&self) -> Result<PaneLineStream> {
        self.line_stream_starting_at(PaneOutputStart::Now).await
    }

    /// Subscribes to rendered output lines, anchoring the cursor at the
    /// requested start position.
    pub async fn line_stream_starting_at(&self, start: PaneOutputStart) -> Result<PaneLineStream> {
        let inner = self.output_stream_starting_at(start).await?;
        Ok(PaneLineStream::wrap(inner))
    }

    /// Opens a minimal render stream that emits snapshots after output.
    ///
    /// The implementation is output-driven with debounce and revision
    /// filtering. It avoids fixed-rate blind refresh loops but is not a
    /// daemon-native snapshot-diff stream.
    pub async fn render_stream(&self) -> Result<PaneRenderStream> {
        PaneRenderStream::open(self.clone()).await
    }

    /// Captures a fresh snapshot and searches its rendered visible text for
    /// the first literal match.
    ///
    /// This is a lossy rendered-text helper built from
    /// [`PaneSnapshot::visible_lines`]. It does not inspect raw output bytes
    /// and does not use any daemon/core regex search surface.
    pub async fn find_text(&self, text: impl AsRef<str>) -> Result<Option<PaneTextMatch>> {
        crate::extract::find_text(self, text.as_ref().to_owned()).await
    }

    /// Captures a fresh snapshot and returns every literal rendered-text
    /// match, including overlapping matches on the same visible line.
    ///
    /// See [`Self::find_text`] for rendered-text and coordinate semantics.
    pub async fn find_text_all(&self, text: impl AsRef<str>) -> Result<Vec<PaneTextMatch>> {
        crate::extract::find_text_all(self, text.as_ref().to_owned()).await
    }
}
