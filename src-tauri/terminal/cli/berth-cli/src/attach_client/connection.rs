//! Blocking attach-mode transport for the Berth terminal daemon.
//!
//! Attach 是命令行专属的同步特殊路径：先走普通 RPC 通道发出
//! `AttachSession` 请求，成功后把连接升级为原始 attach 流。
//! 通用（async）客户端能力由 `berth-term-sdk`（SDK）提供，这里
//! 只保留 attach 所需的最小 blocking 子集。

use std::io::{self, Read, Write};
use std::path::Path;
use std::time::Duration;

use berth_term_ipc::{connect_blocking, BlockingLocalStream, LocalEndpoint};
use berth_term_proto::{
    encode_frame, AttachSessionRequest, AttachSessionResponse, FrameDecoder, Request, Response,
    SessionName, TerminalError,
};

use super::AttachError;

/// Default timeout for establishing detached RPC connections.
const SOCKET_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// Default timeout for writing detached RPC requests.
const SOCKET_WRITE_TIMEOUT: Duration = Duration::from_secs(5);
/// Default timeout for ordinary detached RPC response reads.
const SOCKET_RESPONSE_TIMEOUT: Duration = Duration::from_secs(15);
/// Read buffer size for blocking socket reads.
const READ_BUFFER_SIZE: usize = 8192;

/// Client-side errors for transport and protocol failures.
#[derive(Debug)]
pub enum ClientError {
    /// An I/O error occurred on the local client stream.
    Io(std::io::Error),
    /// A protocol framing or encoding error occurred.
    Protocol(TerminalError),
    /// Entering or restoring raw terminal mode failed.
    Attach(AttachError),
    /// The server closed the connection before sending a complete response frame.
    UnexpectedEof,
}

impl std::fmt::Display for ClientError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "i/o error: {error}"),
            Self::Protocol(error) => write!(formatter, "protocol error: {error}"),
            Self::Attach(error) => write!(formatter, "attach error: {error}"),
            Self::UnexpectedEof => formatter
                .write_str("server closed connection before a complete response frame arrived"),
        }
    }
}

impl std::error::Error for ClientError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Protocol(error) => Some(error),
            Self::Attach(error) => Some(error),
            Self::UnexpectedEof => None,
        }
    }
}

impl From<std::io::Error> for ClientError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<TerminalError> for ClientError {
    fn from(error: TerminalError) -> Self {
        Self::Protocol(error)
    }
}

impl From<AttachError> for ClientError {
    fn from(error: AttachError) -> Self {
        Self::Attach(error)
    }
}

/// The explicit result of requesting an attach-stream upgrade.
#[derive(Debug)]
pub enum AttachTransition {
    /// The server accepted the attach request and switched protocols.
    Upgraded(AttachSessionUpgrade),
    /// The server responded without switching protocols.
    Rejected(Response),
}

/// A detached connection that has transitioned into attach-stream mode.
#[derive(Debug)]
pub struct AttachSessionUpgrade {
    stream: BlockingLocalStream,
    initial_bytes: Vec<u8>,
}

impl AttachSessionUpgrade {
    /// Consumes the upgrade and returns the raw attach-stream socket.
    #[must_use]
    // 仅由 attach 回归测试使用。
    #[allow(dead_code)]
    pub fn into_stream(self) -> BlockingLocalStream {
        self.into_parts().0
    }

    /// Consumes the upgrade and returns the raw attach-stream socket plus any
    /// bytes already read beyond the detached response frame.
    #[must_use]
    pub fn into_parts(self) -> (BlockingLocalStream, Vec<u8>) {
        (self.stream, self.initial_bytes)
    }
}

/// Connects to the Berth terminal daemon over a blocking local stream.
pub fn connect(socket_path: &Path) -> Result<Connection, ClientError> {
    let stream = connect_blocking(
        &LocalEndpoint::from_path(socket_path.to_path_buf()),
        SOCKET_CONNECT_TIMEOUT,
    )
    .map_err(ClientError::Io)?;
    Connection::new(stream)
}

/// A blocking connection to the Berth terminal daemon that exchanges typed frames.
#[derive(Debug)]
pub struct Connection {
    stream: BlockingLocalStream,
    decoder: FrameDecoder,
}

impl Connection {
    fn new(stream: BlockingLocalStream) -> Result<Self, ClientError> {
        stream
            .set_read_timeout(Some(SOCKET_RESPONSE_TIMEOUT))
            .map_err(ClientError::Io)?;
        stream
            .set_write_timeout(Some(SOCKET_WRITE_TIMEOUT))
            .map_err(ClientError::Io)?;

        Ok(Self {
            stream,
            decoder: FrameDecoder::new(),
        })
    }

    /// Sends a request and reads the server's response.
    ///
    /// Server-side `Response::Error` payloads are returned as-is in the `Ok`
    /// variant so callers can pattern-match on them. Only transport and framing
    /// failures produce `Err`.
    pub fn roundtrip(&mut self, request: &Request) -> Result<Response, ClientError> {
        self.write_request(request)?;
        self.read_response()
    }

    /// 取消响应读超时，用于可能长时间排队的请求（`wait-for -L`）。
    pub fn wait_without_timeout(&self) -> Result<(), ClientError> {
        self.stream.set_read_timeout(None).map_err(ClientError::Io)
    }

    /// Requests an attach upgrade and, on success, yields the raw local stream.
    ///
    /// Once this method returns [`AttachTransition::Upgraded`], the detached
    /// framing codec is no longer in the data path for the connection.
    pub fn begin_attach(mut self, target: SessionName) -> Result<AttachTransition, ClientError> {
        self.write_request(&Request::AttachSession(AttachSessionRequest { target }))?;
        let response = self.read_response()?;

        match response {
            Response::AttachSession(response) => Ok(AttachTransition::Upgraded(
                self.into_attach_upgrade(response)?,
            )),
            other => Ok(AttachTransition::Rejected(other)),
        }
    }

    fn write_request(&mut self, request: &Request) -> Result<(), ClientError> {
        let frame = encode_frame(request).map_err(ClientError::Protocol)?;
        self.stream.write_all(&frame).map_err(ClientError::Io)
    }

    fn read_response(&mut self) -> Result<Response, ClientError> {
        let mut buffer = [0u8; READ_BUFFER_SIZE];

        loop {
            match self.decoder.next_frame::<Response>() {
                Ok(Some(response)) => return Ok(response),
                Ok(None) => {}
                Err(error) => return Err(ClientError::Protocol(error)),
            }

            let bytes_read = match self.stream.read(&mut buffer) {
                Ok(bytes_read) => bytes_read,
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(ClientError::Io(error)),
            };

            if bytes_read == 0 {
                return Err(ClientError::UnexpectedEof);
            }

            self.decoder.push_bytes(&buffer[..bytes_read]);
        }
    }

    fn into_attach_upgrade(
        self,
        _response: AttachSessionResponse,
    ) -> Result<AttachSessionUpgrade, ClientError> {
        self.stream
            .set_read_timeout(None)
            .map_err(ClientError::Io)?;
        self.stream
            .set_write_timeout(None)
            .map_err(ClientError::Io)?;
        let initial_bytes = self.decoder.remaining_bytes().to_vec();

        Ok(AttachSessionUpgrade {
            stream: self.stream,
            initial_bytes,
        })
    }
}
