//! SDK capability negotiation helpers.

use std::sync::Arc;

use crate::diagnostics::FEATURE_PROTOCOL_CAPABILITIES;
use crate::transport::TransportClient;
use crate::{Result, TerminalError};
use berth_term_proto::{
    HandshakeRequest, ProcessCommand, Request, Response, CAPABILITY_HANDSHAKE,
    CAPABILITY_SDK_PROCESS_COMMAND, BERTH_TERM_WIRE_VERSION,
};

pub(crate) async fn require(client: &TransportClient, capabilities: &[&str]) -> Result<()> {
    let supported = negotiated_capabilities(client).await?;
    for capability in capabilities {
        ensure_capability(&supported, capability)?;
    }
    Ok(())
}

pub(crate) async fn require_process_command_if_present(
    client: &TransportClient,
    process_command: Option<&ProcessCommand>,
) -> Result<()> {
    if process_command.is_some() {
        require(client, &[CAPABILITY_SDK_PROCESS_COMMAND]).await?;
    }
    Ok(())
}

/// Returns the daemon instance identity (epoch) negotiated with the live daemon.
///
/// The capability handshake result is already cached per transport, so GUI and
/// CLI observe the same epoch through the same path. `None` means the connected
/// daemon advertises no instance identity (an older daemon); captured pane
/// bindings must then be reported as unverifiable instead of guessed.
pub(crate) async fn daemon_instance(client: &TransportClient) -> Result<Option<String>> {
    let supported = negotiated_capabilities(client).await?;
    Ok(berth_term_proto::daemon_instance_from_capabilities(&supported).map(str::to_owned))
}

pub(crate) async fn negotiated_capabilities(client: &TransportClient) -> Result<Arc<[String]>> {
    if let Some(capabilities) = client.cached_capabilities().await {
        return Ok(capabilities);
    }

    let response = client
        .request(Request::Handshake(HandshakeRequest::requiring([
            CAPABILITY_HANDSHAKE,
        ])))
        .await
        .map_err(normalize_handshake_error)?;

    match response {
        Response::Handshake(response) => {
            ensure_selected_wire_version(response.wire_version)?;
            ensure_capability(&response.capabilities, CAPABILITY_HANDSHAKE)?;
            Ok(client.cache_capabilities(response.capabilities).await)
        }
        Response::Error(error) => Err(error.into()),
        response => Err(TerminalError::protocol(
            berth_term_proto::TerminalError::Server(format!(
                "rmux daemon sent `{}` response for capability handshake",
                response.command_name()
            )),
        )),
    }
}

#[cfg(feature = "available")]
pub(crate) fn is_unavailable(error: &TerminalError, capability: &str) -> bool {
    matches!(
        error,
        TerminalError::Unsupported { feature, .. }
            if feature == capability || feature == FEATURE_PROTOCOL_CAPABILITIES
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

fn ensure_capability(supported: &[String], capability: &str) -> Result<()> {
    if supported.iter().any(|supported| supported == capability) {
        return Ok(());
    }

    Err(TerminalError::protocol(
        berth_term_proto::TerminalError::UnsupportedCapability {
            feature: capability.to_owned(),
            supported: supported.to_vec(),
        },
    ))
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
            "upgrade the rmux daemon to one that advertises `{CAPABILITY_HANDSHAKE}` before using SDK capability negotiation; {detail}"
        ),
    )
}
