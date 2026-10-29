//! Opaque Berth terminal SDK facade handle.

#[cfg(feature = "available")]
use std::ffi::{OsStr, OsString};
use std::fmt;
use std::io;
#[cfg(feature = "available")]
use std::process::Command as ProcessCommand;
use std::time::Duration;

use super::builder::TerminalClientBuilder;
#[cfg(feature = "available")]
use super::owned_session::OwnedSessionBuilder;
#[cfg(feature = "available")]
use crate::command::CommandRun;
use crate::diagnostics::FEATURE_PROTOCOL_CAPABILITIES;
use crate::transport::{DropGuard, TransportClient};
use crate::{
    bootstrap::discovery, ensure::EnsureSession, handles::Session, Pane, PaneId, PaneRef, Result,
    SessionName, TerminalEndpoint, TerminalError, Window, WindowRef,
};
#[cfg(feature = "available")]
use crate::{broadcast::BroadcastResult, Input};
use berth_term_proto::{
    HandshakeRequest, KillServerRequest, Request, Response, CAPABILITY_DAEMON_SHUTDOWN,
    CAPABILITY_HANDSHAKE, BERTH_TERM_WIRE_VERSION,
};

#[path = "terminal/connect.rs"]
mod connect;

use connect::connect_transport;
pub(crate) use connect::{connect_or_start_transport, connect_transport_to_endpoint};

/// Inert SDK facade for daemon-backed Berth terminal operations.
///
/// Constructing this handle only records endpoint configuration and does not
/// contact a daemon.
pub struct Terminal {
    endpoint: TerminalEndpoint,
    default_timeout: Option<Duration>,
    transport: Option<TransportClient>,
    drop_guard: DropGuard,
}

impl Terminal {
    /// Creates a facade configured to use default endpoint discovery.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Creates a builder configured to use default endpoint discovery.
    #[must_use]
    pub fn builder() -> TerminalClientBuilder {
        TerminalClientBuilder::new()
    }

    /// Connects to a running daemon at `endpoint`.
    ///
    /// Passing [`TerminalEndpoint::Default`] resolves the platform default through
    /// SDK discovery. This method never starts a daemon.
    pub async fn connect(endpoint: TerminalEndpoint) -> Result<Self> {
        TerminalClientBuilder::new()
            .endpoint(endpoint)
            .connect()
            .await
    }

    /// Connects to the default daemon, starting it if no daemon is reachable.
    ///
    /// The hidden daemon binary is resolved from
    /// [`crate::bootstrap::discovery::SDK_DAEMON_BINARY_ENV`] when set,
    /// otherwise `berth-termd` is resolved through the host `PATH`.
    /// Startup races are serialized by the platform bootstrap layer.
    pub async fn connect_or_start() -> Result<Self> {
        TerminalClientBuilder::new().connect_or_start().await
    }

    /// Connects to `endpoint`, starting a hidden daemon if no daemon is
    /// reachable there.
    ///
    /// This is the explicit-endpoint form of [`Self::connect_or_start`].
    pub async fn connect_or_start_at(endpoint: TerminalEndpoint) -> Result<Self> {
        TerminalClientBuilder::new()
            .endpoint(endpoint)
            .connect_or_start()
            .await
    }

    /// Returns the endpoint selection recorded by this facade.
    #[must_use]
    pub fn endpoint(&self) -> &TerminalEndpoint {
        &self.endpoint
    }

    /// Returns the operation timeout default recorded by this facade.
    #[must_use]
    pub const fn configured_default_timeout(&self) -> Option<Duration> {
        self.default_timeout
    }

    /// Sets the default timeout used by waits created after this call.
    ///
    /// Existing pane, session, or locator handles keep the timeout captured
    /// when those handles were built.
    pub fn set_default_timeout(&mut self, timeout: Duration) {
        self.default_timeout = Some(timeout);
    }

    /// Resolves the endpoint that would be used by runtime SDK operations.
    ///
    /// This consults SDK discovery only when the recorded endpoint is
    /// [`TerminalEndpoint::Default`].
    pub fn resolved_endpoint(&self) -> Result<TerminalEndpoint> {
        discovery::resolve_endpoint(&self.endpoint)
    }

    /// Resolves the timeout that would be used by one runtime SDK operation.
    ///
    /// `per_operation_timeout` has precedence over this facade's configured
    /// default and can use `Duration::MAX` to request no timeout.
    #[must_use]
    pub fn resolved_timeout(&self, per_operation_timeout: Option<Duration>) -> Option<Duration> {
        discovery::resolve_timeout(per_operation_timeout, self.default_timeout)
    }

    /// Ensures a daemon session from a session builder.
    pub async fn ensure_session(&self, ensure: EnsureSession) -> Result<Session> {
        ensure.ensure(self).await
    }

    /// Returns a handle for an existing daemon session.
    pub async fn session(&self, session_name: SessionName) -> Result<Session> {
        self.ensure_session(EnsureSession::named(session_name).reuse_only())
            .await
    }

    /// Starts building an app-owned session guard.
    ///
    /// Explicit cleanup is strong, [`CleanupPolicy::KillOnDrop`](crate::CleanupPolicy)
    /// remains best-effort, and [`CleanupPolicy::KillOnOwnerExit`](crate::CleanupPolicy)
    /// uses the daemon-side lease path when selected.
    #[cfg(feature = "available")]
    pub fn owned_session(&self, session_name: SessionName) -> OwnedSessionBuilder<'_> {
        OwnedSessionBuilder::new(self, session_name)
    }

    /// Returns a daemon-backed handle for an exact window slot.
    ///
    /// Creating the handle connects to the configured daemon endpoint but
    /// does not require the window slot to exist yet. Operations on the
    /// returned handle observe the live daemon state for that session/index,
    /// including linked-window and grouped-session updates.
    pub async fn window(&self, target: WindowRef) -> Result<Window> {
        let endpoint = self.resolved_endpoint()?;
        let timeout = self.resolved_timeout(None);
        let transport = self
            .connect_resolved_transport_for_operation(&endpoint, timeout)
            .await?;
        Ok(Window::new(
            target,
            endpoint,
            self.configured_default_timeout(),
            transport,
        ))
    }

    /// Returns a daemon-backed handle for an exact pane slot.
    ///
    /// Creating the handle connects to the configured daemon endpoint but
    /// does not require the pane slot to exist yet. Operations on the
    /// returned handle resolve `(session, window, pane)` against live daemon
    /// state on every call, so linked windows and grouped sessions report
    /// the same stable pane identity through every sibling view.
    pub async fn pane(&self, target: PaneRef) -> Result<Pane> {
        let endpoint = self.resolved_endpoint()?;
        let timeout = self.resolved_timeout(None);
        let transport = self
            .connect_resolved_transport_for_operation(&endpoint, timeout)
            .await?;
        Ok(Pane::new(
            target,
            endpoint,
            self.configured_default_timeout(),
            transport,
        ))
    }

    /// Returns a daemon-backed handle for a pane addressed by stable pane id.
    ///
    /// The initial lookup validates that the id exists now. Later operations
    /// use pane-id-aware daemon requests for the critical pane operations, so
    /// pane index recompression cannot redirect the handle to a neighbor.
    pub async fn pane_by_id(&self, session_name: SessionName, pane_id: PaneId) -> Result<Pane> {
        let endpoint = self.resolved_endpoint()?;
        let timeout = self.resolved_timeout(None);
        let transport = self
            .connect_resolved_transport_for_operation(&endpoint, timeout)
            .await?;
        let target = super::pane::resolve_pane_ref_for_id(&transport, &session_name, pane_id)
            .await?
            .ok_or_else(|| pane_not_found(&session_name, pane_id))?;
        Ok(Pane::new_by_id(
            target,
            pane_id,
            endpoint,
            self.configured_default_timeout(),
            transport,
        ))
    }

    /// Alias for [`Self::pane_by_id`] using a string-like session name.
    pub async fn get_pane_by_id(
        &self,
        session_name: impl AsRef<str>,
        pane_id: PaneId,
    ) -> Result<Pane> {
        let session_name =
            SessionName::new(session_name.as_ref()).map_err(TerminalError::protocol)?;
        self.pane_by_id(session_name, pane_id).await
    }

    /// Starts a pane discovery query over terminal-managed sessions.
    #[cfg(feature = "available")]
    pub fn find_panes(&self) -> crate::PaneFinder<'_> {
        crate::PaneFinder::new(self)
    }

    /// Starts a session discovery query over terminal-managed sessions.
    #[cfg(feature = "available")]
    pub const fn find_sessions(&self) -> crate::SessionFinder<'_> {
        crate::SessionFinder::new(self)
    }

    /// Finds a single pane by exact title and returns its stable pane handle.
    #[cfg(feature = "available")]
    pub async fn get_pane_by_title(&self, title: impl AsRef<str>) -> Result<Pane> {
        self.find_panes().title(title.as_ref()).one().await
    }

    /// Starts building a minimal JSONL trace session.
    #[cfg(feature = "available")]
    #[must_use]
    pub const fn tracing(&self) -> crate::TerminalTraceBuilder<'_> {
        crate::TerminalTraceBuilder::new(self)
    }

    /// Broadcasts text or one key token to a set of panes.
    ///
    /// The implementation is client-side fan-out. It preserves caller
    /// order per pane when broadcast calls are awaited sequentially, but it
    /// does not promise simultaneous cross-pane delivery. If any pane fails,
    /// the returned error is [`TerminalError::PartialBroadcast`] with per-pane
    /// successes and failures.
    #[cfg(feature = "available")]
    pub async fn broadcast(&self, panes: &[Pane], input: Input<'_>) -> Result<BroadcastResult> {
        crate::broadcast::broadcast(panes, input).await
    }

    /// Checks the live daemon for an exact session name.
    pub async fn has_session(&self, session_name: SessionName) -> Result<bool> {
        let client = self
            .connect_transport_for_operation(self.resolved_timeout(None))
            .await?;
        super::session::has_session(&client, session_name).await
    }

    /// Lists exact session names currently reported by the daemon.
    pub async fn list_sessions(&self) -> Result<Vec<SessionName>> {
        let client = self
            .connect_transport_for_operation(self.resolved_timeout(None))
            .await?;
        super::session::list_session_names(&client).await
    }

    /// Returns the daemon capabilities negotiated through the SDK handshake.
    pub async fn capabilities(&self) -> Result<Vec<String>> {
        let client = self
            .connect_transport_for_operation(self.resolved_timeout(None))
            .await?;
        Ok(crate::capabilities::negotiated_capabilities(&client)
            .await?
            .as_ref()
            .to_vec())
    }

    /// Returns the daemon instance identity (epoch) negotiated through the SDK
    /// handshake.
    ///
    /// `None` means the connected daemon advertises no instance identity (an
    /// older daemon). Callers must then treat captured pane bindings as
    /// unverifiable instead of assuming the daemon is unchanged. GUI and CLI
    /// read the same epoch through this one path.
    pub async fn daemon_instance(&self) -> Result<Option<String>> {
        let client = self
            .connect_transport_for_operation(self.resolved_timeout(None))
            .await?;
        crate::capabilities::daemon_instance(&client).await
    }

    /// Returns `true` when this facade's persistent transport is known dead
    /// (the daemon closed it or the transport actor exited).
    ///
    /// This is a local state read with no round trip. Callers that cache a
    /// facade use it to reconnect *before* an operation, so a restarted daemon
    /// is re-handshaken (and its epoch re-read) instead of failing the first
    /// operation with a transport error. A facade without a persistent
    /// transport connects per operation and is never reported closed.
    pub fn is_transport_closed(&self) -> bool {
        self.transport
            .as_ref()
            .is_some_and(TransportClient::is_closed)
    }

    /// Checks whether the daemon advertises `capability`.
    pub async fn has_capability(&self, capability: &str) -> Result<bool> {
        Ok(self
            .capabilities()
            .await?
            .iter()
            .any(|advertised| advertised == capability))
    }

    /// Runs the `berth` binary against this facade's resolved endpoint.
    ///
    /// This is the official SDK escape hatch for commands that are not yet
    /// represented by typed Rust methods. The SDK injects `-S <endpoint>` before
    /// caller arguments, so the spawned binary talks to the same daemon the
    /// facade would use for normal operations. The command is executed directly
    /// without a shell. Non-zero exits are returned in [`CommandRun`] rather
    /// than converted into [`TerminalError`].
    #[cfg(feature = "available")]
    pub async fn cmd<I, S>(&self, args: I) -> Result<CommandRun>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let endpoint = self.resolved_endpoint()?;
        let args = args
            .into_iter()
            .map(|arg| arg.as_ref().to_owned())
            .collect::<Vec<OsString>>();
        tokio::task::spawn_blocking(move || run_binary_command(endpoint, args))
            .await
            .map_err(|error| {
                TerminalError::transport(
                    "join Berth command task",
                    io::Error::other(error.to_string()),
                )
            })?
    }

    /// Negotiates daemon capabilities, requests daemon shutdown, and waits for
    /// the SDK transport to close.
    ///
    /// This method contacts the configured daemon endpoint. Transport and
    /// protocol errors are returned to the caller; dropping an [`Terminal`] handle
    /// remains cleanup-only and never waits for daemon shutdown.
    pub async fn shutdown(mut self) -> Result<()> {
        self.drop_guard.disarm();
        let client = match self.transport.take() {
            Some(client) => client,
            None => self.connect_transport().await?,
        };

        negotiate_shutdown_capability(&client).await?;
        let response = client
            .request(Request::KillServer(KillServerRequest))
            .await?;
        match response {
            Response::KillServer(_) => {
                if let Err(error) = client.shutdown().await {
                    if !is_clean_shutdown_close(&error) {
                        return Err(error);
                    }
                }
                Ok(())
            }
            Response::Error(error) => Err(error.into()),
            response => Err(TerminalError::protocol(
                berth_term_proto::TerminalError::Server(format!(
                    "Berth daemon sent `{}` response for shutdown request",
                    response.command_name()
                )),
            )),
        }
    }

    pub(crate) fn from_config(
        endpoint: TerminalEndpoint,
        default_timeout: Option<Duration>,
    ) -> Self {
        Self {
            endpoint,
            default_timeout,
            transport: None,
            drop_guard: DropGuard::noop(),
        }
    }

    pub(crate) fn from_connected_transport(
        endpoint: TerminalEndpoint,
        default_timeout: Option<Duration>,
        transport: TransportClient,
    ) -> Self {
        Self {
            endpoint,
            default_timeout,
            transport: Some(transport),
            drop_guard: DropGuard::noop(),
        }
    }

    #[cfg(test)]
    pub(crate) fn from_transport_for_test(
        client: TransportClient,
        drop_request: Option<Request>,
    ) -> Self {
        let drop_guard = drop_request
            .map(|request| DropGuard::best_effort(client.clone(), request))
            .unwrap_or_else(DropGuard::noop);
        Self {
            endpoint: TerminalEndpoint::Default,
            default_timeout: None,
            transport: Some(client),
            drop_guard,
        }
    }

    async fn connect_transport(&self) -> Result<TransportClient> {
        let endpoint = self.resolved_endpoint()?;
        connect_transport(&endpoint, self.resolved_timeout(None)).await
    }

    pub(crate) async fn connect_transport_for_operation(
        &self,
        timeout: Option<Duration>,
    ) -> Result<TransportClient> {
        if let Some(client) = self.transport.as_ref() {
            return Ok(client.clone());
        }

        let endpoint = self.resolved_endpoint()?;
        connect_transport(&endpoint, timeout).await
    }

    pub(crate) async fn connect_resolved_transport_for_operation(
        &self,
        endpoint: &TerminalEndpoint,
        timeout: Option<Duration>,
    ) -> Result<TransportClient> {
        if let Some(client) = self.transport.as_ref() {
            return Ok(client.clone());
        }

        connect_transport(endpoint, timeout).await
    }
}

fn pane_not_found(session_name: &SessionName, pane_id: PaneId) -> TerminalError {
    TerminalError::protocol(berth_term_proto::TerminalError::pane_not_found(
        session_name.clone(),
        pane_id,
    ))
}

#[cfg(feature = "available")]
fn run_binary_command(endpoint: TerminalEndpoint, args: Vec<OsString>) -> Result<CommandRun> {
    let mut command = ProcessCommand::new(connect::cli_binary());
    append_endpoint_args(&mut command, endpoint);
    command.args(args);
    let output = command
        .output()
        .map_err(|error| TerminalError::transport("run berth command", error))?;

    Ok(CommandRun {
        stdout: output.stdout,
        stderr: output.stderr,
        exit: output.status.code(),
    })
}

#[cfg(feature = "available")]
fn append_endpoint_args(command: &mut ProcessCommand, endpoint: TerminalEndpoint) {
    command.args(endpoint_args(endpoint));
}

#[cfg(feature = "available")]
fn endpoint_args(endpoint: TerminalEndpoint) -> Vec<OsString> {
    match endpoint {
        TerminalEndpoint::Default => Vec::new(),
        TerminalEndpoint::UnixSocket(path) => vec![OsString::from("-S"), path.into_os_string()],
        TerminalEndpoint::WindowsPipe(pipe) => vec![OsString::from("-S"), pipe.into()],
    }
}

fn is_clean_shutdown_close(error: &TerminalError) -> bool {
    matches!(
        error,
        TerminalError::Transport { source, .. }
            if matches!(
                source.kind(),
                io::ErrorKind::UnexpectedEof
                    | io::ErrorKind::ConnectionReset
                    | io::ErrorKind::BrokenPipe
                    | io::ErrorKind::NotConnected
            )
    )
}

impl Default for Terminal {
    fn default() -> Self {
        TerminalClientBuilder::default().build()
    }
}

impl fmt::Debug for Terminal {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_struct("Terminal").finish_non_exhaustive()
    }
}

async fn negotiate_shutdown_capability(client: &TransportClient) -> Result<()> {
    let response = client
        .request(Request::Handshake(HandshakeRequest::requiring([
            CAPABILITY_HANDSHAKE,
            CAPABILITY_DAEMON_SHUTDOWN,
        ])))
        .await
        .map_err(normalize_handshake_error)?;

    match response {
        Response::Handshake(response) => {
            ensure_selected_wire_version(response.wire_version)?;
            ensure_capability(&response.capabilities, CAPABILITY_HANDSHAKE)?;
            ensure_capability(&response.capabilities, CAPABILITY_DAEMON_SHUTDOWN)
        }
        Response::Error(error) => Err(error.into()),
        response => Err(TerminalError::protocol(
            berth_term_proto::TerminalError::Server(format!(
                "Berth daemon sent `{}` response for capability handshake",
                response.command_name()
            )),
        )),
    }
}

fn normalize_handshake_error(error: TerminalError) -> TerminalError {
    match error {
        TerminalError::Protocol {
            source: berth_term_proto::TerminalError::Decode(message),
        } => unsupported_handshake_error(&message),
        TerminalError::Unsupported { feature, .. }
            if feature == crate::diagnostics::command_feature_id("handshake") =>
        {
            unsupported_handshake_error("daemon did not recognize the handshake request")
        }
        error => error,
    }
}

fn unsupported_handshake_error(detail: &str) -> TerminalError {
    TerminalError::unsupported(
        FEATURE_PROTOCOL_CAPABILITIES,
        format!(
            "upgrade the rmux daemon to one that advertises `{CAPABILITY_HANDSHAKE}` before using SDK daemon shutdown; {detail}"
        ),
    )
}

fn ensure_selected_wire_version(wire_version: u32) -> Result<()> {
    if wire_version == BERTH_TERM_WIRE_VERSION {
        return Ok(());
    }

    Err(TerminalError::protocol(
        berth_term_proto::TerminalError::UnsupportedWireVersion {
            got: wire_version,
            minimum: BERTH_TERM_WIRE_VERSION,
            maximum: BERTH_TERM_WIRE_VERSION,
        },
    ))
}

fn ensure_capability(capabilities: &[String], feature: &str) -> Result<()> {
    if capabilities
        .iter()
        .any(|capability| capability.as_str() == feature)
    {
        return Ok(());
    }

    Err(TerminalError::protocol(
        berth_term_proto::TerminalError::UnsupportedCapability {
            feature: feature.to_owned(),
            supported: capabilities.to_vec(),
        },
    ))
}

#[cfg(test)]
#[path = "terminal/tests.rs"]
mod tests;
