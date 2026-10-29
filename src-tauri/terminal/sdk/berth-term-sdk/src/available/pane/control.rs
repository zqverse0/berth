//! Available pane control capabilities not currently exposed through Berth.

use super::*;

impl Pane {
    /// Scrolls the pane's retained output through Berth terminal copy mode.
    ///
    /// This is a daemon-side viewport operation, not a raw mouse report sent
    /// to the foreground process. It therefore works for ordinary shells and
    /// does not inject escape sequences into programs that have not enabled
    /// mouse reporting.
    pub async fn scroll_history(&self, direction: crate::PaneScrollDirection) -> Result<()> {
        scroll_history(self, direction).await
    }

    /// Leaves Berth terminal copy mode without sending a key to the foreground process.
    pub async fn cancel_copy_mode(&self) -> Result<()> {
        cancel_copy_mode(self).await
    }

    /// Splits this pane and returns a handle for the freshly spawned pane.
    ///
    /// The direction names where the new pane lands relative to this one:
    /// `Right`/`Left` create a side-by-side arrangement (vertical divider),
    /// `Up`/`Down` create a stacked arrangement (horizontal divider).
    /// `Left` and `Up` map to tmux's `-b` flag — the new pane is inserted
    /// *before* this one on the chosen axis.
    ///
    /// For handles created by [`Session::pane_by_id`](crate::Session::pane_by_id),
    /// the SDK resolves the stable pane id to the daemon's current slot before
    /// issuing the split request. Unlike input, snapshot, waits, and streams,
    /// split is therefore not yet an atomic daemon-side by-id operation.
    pub async fn split(&self, direction: SplitDirection) -> Result<Self> {
        let target = self.current_target().await?;
        let new_target = split_pane(&self.transport, &target, direction).await?;
        Ok(Self::new(
            new_target,
            self.endpoint.clone(),
            self.default_timeout,
            self.transport.clone(),
        ))
    }

    /// Starts building an atomic split that may choose the new pane process.
    ///
    /// Unlike `self.split(direction).await?.spawn(command).await?`, this
    /// builder sends the process specification with the split request, so the
    /// daemon never creates the new pane with an intermediate default shell
    /// that is immediately replaced.
    ///
    /// On a stable-id pane handle, this builder has the same targeting
    /// limitation as [`Self::split`]: the id is resolved to the current slot
    /// before the split request is sent.
    pub fn split_with(&self, direction: SplitDirection) -> PaneSplitBuilder<'_> {
        PaneSplitBuilder::new(self, direction)
    }

    /// Respawns the process in this pane slot through the daemon.
    ///
    /// The addressed slot and stable `%N`/[`PaneId`] are preserved by the
    /// daemon. `options.kill` mirrors `respawn-pane -k`: a running process is
    /// rejected unless that flag is set, while a dead pane can be respawned
    /// without it. The daemon resets the pane transcript, parser state,
    /// scrollback, and retained output before exposing output from the fresh
    /// lifecycle generation.
    pub async fn respawn(&self, options: PaneRespawnOptions) -> Result<PaneRef> {
        respawn_pane(self, options).await
    }

    /// Starts a structured respawn builder for this pane.
    ///
    /// `spawn(argv)` is an argv-oriented wrapper around [`Self::respawn`]:
    /// it does not send text to an interactive shell and it does not append a
    /// newline. A running process is rejected by default; call
    /// [`PaneSpawnBuilder::kill_existing`] when replacement is intentional.
    pub fn spawn<I, S>(&self, command: I) -> PaneSpawnBuilder<'_>
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        PaneSpawnBuilder::argv(self, command.into_iter().map(Into::into).collect())
    }

    /// Starts an explicit shell-command respawn builder for this pane.
    ///
    /// This is the intentional `$SHELL -c` path. Use [`Self::spawn`] when the
    /// process should be represented as structured argv without shell
    /// interpretation.
    pub fn shell(&self, command: impl Into<String>) -> PaneSpawnBuilder<'_> {
        PaneSpawnBuilder::shell(self, command.into())
    }
}
