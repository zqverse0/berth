//! Adapter-side tests for deterministic pane-binding failures.
//!
//! The verdict logic itself is covered by the SDK's `binding` tests. These
//! tests pin the adapter half of the chain: a rejected binding becomes the
//! stable protocol error, and that protocol error becomes
//! [`TerminalError::InstanceExpired`](crate::terminal::error::TerminalError::InstanceExpired)
//! at the Tauri boundary (the frontend already renders that code as an expired
//! terminal instance).

use berth_term_sdk::berth::{
    verify, BindingFacts, BindingVerdict, PaneBindingFailure, PaneId, ProtocolError,
    RuntimeBinding, SessionName, TerminalError,
};

use super::{binding_failure_error, refused_failure};
use crate::terminal::error::{TerminalError as AdapterError, TerminalErrorCode};
use crate::terminal::manager::terminal_manager::{
    operation_error_for_terminal, terminal_error_from_sdk,
};
use crate::terminal::manager::TerminalOperationError;

fn binding() -> RuntimeBinding {
    RuntimeBinding::new(
        Some("0123456789abcdef0123456789abcdef".to_owned()),
        SessionName::new("42").expect("valid session name"),
        PaneId::new(3),
        7,
    )
}

#[test]
fn rejected_binding_becomes_the_stable_protocol_error() {
    for failure in [
        PaneBindingFailure::StaleDaemon,
        PaneBindingFailure::StalePane,
        PaneBindingFailure::StaleGeneration,
        PaneBindingFailure::Unverifiable,
    ] {
        let error = binding_failure_error(&binding(), failure);
        assert!(
            matches!(
                error,
                TerminalError::Protocol {
                    source: ProtocolError::PaneBindingInvalid { reason },
                    ..
                } if reason == failure
            ),
            "expected a deterministic pane-binding failure, got {error:?}"
        );
    }
}

#[test]
fn rejected_binding_surfaces_as_an_expired_terminal_instance() {
    for failure in [
        PaneBindingFailure::StaleDaemon,
        PaneBindingFailure::StalePane,
        PaneBindingFailure::StaleGeneration,
        PaneBindingFailure::Unverifiable,
    ] {
        let adapter_error =
            terminal_error_from_sdk(binding_failure_error(&binding(), failure), None);
        assert!(
            matches!(adapter_error, AdapterError::InstanceExpired(_)),
            "expected InstanceExpired, got {adapter_error:?}"
        );
        assert!(matches!(
            operation_error_for_terminal(adapter_error),
            TerminalOperationError::Protocol(TerminalErrorCode::TerminalInstanceExpired)
        ));
    }
}

#[test]
fn an_epochless_binding_is_refused_when_the_live_daemon_has_an_epoch() {
    let mut captured = binding();
    captured.daemon_instance = None;
    let verdict = verify(
        &captured,
        BindingFacts::DaemonObserved {
            daemon_instance: "0123456789abcdef0123456789abcdef",
        },
    );
    assert_eq!(
        refused_failure(verdict),
        Some(PaneBindingFailure::StaleDaemon)
    );
    assert!(matches!(
        terminal_error_from_sdk(
            binding_failure_error(&captured, verdict.failure().unwrap()),
            None
        ),
        AdapterError::InstanceExpired(_)
    ));
}

#[test]
fn stale_bindings_are_refused() {
    // SDK 统一拒绝 epoch 缺失/冲突、pane 不存在与进程重生。
    assert_eq!(
        refused_failure(BindingVerdict::StaleDaemon),
        Some(PaneBindingFailure::StaleDaemon)
    );
    assert_eq!(
        refused_failure(BindingVerdict::StalePane),
        Some(PaneBindingFailure::StalePane)
    );
    assert_eq!(
        refused_failure(BindingVerdict::StaleGeneration),
        Some(PaneBindingFailure::StaleGeneration)
    );
}

#[test]
fn an_unverifiable_binding_stays_usable_against_an_older_daemon() {
    // 旧 daemon 不携带实例身份：身份「无法确认」不等于「已失效」。拒绝它会让
    // 新版客户端 + 旧 daemon 的组合下所有终端直接不可用（2026-09-22 真实事故）。
    // 此时仍按捕获的 pane id 寻址，存在性由 daemon 在操作上判定。
    assert_eq!(refused_failure(BindingVerdict::Unverifiable), None);
    assert!(BindingVerdict::Unverifiable.allows_pane_address());
    assert!(!BindingVerdict::Unverifiable.is_valid());
    assert_eq!(refused_failure(BindingVerdict::Valid), None);
}
