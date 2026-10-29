//! Builder for the opaque Berth terminal SDK facade.

use std::fmt;
use std::path::PathBuf;
use std::time::Duration;

use super::terminal::{connect_or_start_transport, connect_transport_to_endpoint, Terminal};
use crate::bootstrap::discovery;
use crate::{Result, TerminalEndpoint};

/// Builder for an inert [`Terminal`] facade handle.
///
/// The builder only stores configuration. It does not resolve default
/// endpoints, touch the filesystem, open IPC handles, or require a running
/// daemon.
pub struct TerminalClientBuilder {
    endpoint: TerminalEndpoint,
    default_timeout: Option<Duration>,
    daemon_binary: Option<PathBuf>,
}

impl TerminalClientBuilder {
    /// Creates a builder configured to use default endpoint discovery.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Sets the daemon endpoint selection explicitly.
    ///
    /// Passing [`TerminalEndpoint::Default`] restores deferred SDK endpoint
    /// discovery.
    #[must_use]
    pub fn endpoint(mut self, endpoint: TerminalEndpoint) -> Self {
        self.endpoint = endpoint;
        self
    }

    /// Sets an explicit Unix-domain socket path.
    ///
    /// This method is available on every compile target and only records the
    /// path; it does not require Unix at runtime.
    #[must_use]
    pub fn unix_socket(self, path: impl Into<PathBuf>) -> Self {
        self.endpoint(TerminalEndpoint::UnixSocket(path.into()))
    }

    /// Sets an explicit Windows named-pipe identifier.
    ///
    /// This method is available on every compile target and only records the
    /// pipe name; it does not require Windows at runtime.
    #[must_use]
    pub fn windows_pipe(self, pipe: impl Into<String>) -> Self {
        self.endpoint(TerminalEndpoint::WindowsPipe(pipe.into()))
    }

    /// Restores deferred SDK endpoint discovery.
    #[must_use]
    pub fn default_endpoint(self) -> Self {
        self.endpoint(TerminalEndpoint::Default)
    }

    /// Sets the default timeout used by SDK operations built from this handle.
    ///
    /// Passing `Duration::MAX` records an explicit no-timeout default.
    #[must_use]
    pub fn default_timeout(mut self, timeout: Duration) -> Self {
        self.default_timeout = Some(timeout);
        self
    }

    /// Returns the endpoint selection currently recorded by this builder.
    #[must_use]
    pub fn configured_endpoint(&self) -> &TerminalEndpoint {
        &self.endpoint
    }

    /// Uses an explicit `berth-termd` binary when auto-start is needed.
    #[must_use]
    pub fn daemon_binary(mut self, binary: impl Into<PathBuf>) -> Self {
        self.daemon_binary = Some(binary.into());
        self
    }

    /// Returns the operation timeout default currently recorded by this
    /// builder.
    #[must_use]
    pub const fn configured_default_timeout(&self) -> Option<Duration> {
        self.default_timeout
    }

    /// Resolves the endpoint that would be used by runtime SDK operations.
    ///
    /// This consults SDK discovery only when the configured endpoint is
    /// [`TerminalEndpoint::Default`].
    pub fn resolved_endpoint(&self) -> Result<TerminalEndpoint> {
        discovery::resolve_endpoint(&self.endpoint)
    }

    /// Resolves the timeout that would be used by one runtime SDK operation.
    ///
    /// `per_operation_timeout` has precedence over this builder's configured
    /// default and can use `Duration::MAX` to request no timeout.
    #[must_use]
    pub fn resolved_timeout(&self, per_operation_timeout: Option<Duration>) -> Option<Duration> {
        discovery::resolve_timeout(per_operation_timeout, self.default_timeout)
    }

    /// Builds an inert facade handle from the recorded configuration.
    ///
    /// Building does not contact the daemon or perform endpoint resolution.
    #[must_use]
    pub fn build(self) -> Terminal {
        Terminal::from_config(self.endpoint, self.default_timeout)
    }

    /// Connects to the configured daemon endpoint and returns a live facade.
    ///
    /// Unlike [`Self::build`], this resolves the endpoint immediately and
    /// opens the local IPC transport. It never starts a daemon.
    pub async fn connect(self) -> Result<Terminal> {
        let endpoint = discovery::resolve_endpoint(&self.endpoint)?;
        let timeout = discovery::resolve_timeout(None, self.default_timeout);
        let transport = connect_transport_to_endpoint(&endpoint, timeout).await?;
        Ok(Terminal::from_connected_transport(
            endpoint,
            self.default_timeout,
            transport,
        ))
    }

    /// Connects to a daemon, starting the platform hidden daemon if needed.
    ///
    /// Startup is serialized by the OS-specific bootstrap primitive. Dropping
    /// the returned facade never kills the daemon; callers use
    /// [`Terminal::shutdown`] for an explicit shutdown request.
    pub async fn connect_or_start(self) -> Result<Terminal> {
        let endpoint = discovery::resolve_endpoint(&self.endpoint)?;
        let transport = connect_or_start_transport(
            &endpoint,
            self.default_timeout,
            self.daemon_binary.as_deref(),
        )
        .await?;
        Ok(Terminal::from_connected_transport(
            endpoint,
            self.default_timeout,
            transport,
        ))
    }
}

impl Default for TerminalClientBuilder {
    fn default() -> Self {
        Self {
            endpoint: TerminalEndpoint::Default,
            default_timeout: None,
            daemon_binary: None,
        }
    }
}

impl fmt::Debug for TerminalClientBuilder {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TerminalClientBuilder")
            .finish_non_exhaustive()
    }
}
