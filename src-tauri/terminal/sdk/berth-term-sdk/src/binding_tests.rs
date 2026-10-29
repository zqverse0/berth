//! 定向单测：`RuntimeBinding` 的确定性判定（无 IO、无时间、无随机）。

use super::{verify, BindingFacts, BindingVerdict, RuntimeBinding};
use crate::types::{PaneId, SessionName};
use berth_term_proto::PaneBindingFailure;

fn session_name(value: &str) -> SessionName {
    SessionName::new(value).expect("valid session name")
}

const EPOCH: &str = "0123456789abcdef0123456789abcdef";
const OTHER_EPOCH: &str = "fedcba9876543210fedcba9876543210";

fn binding() -> RuntimeBinding {
    RuntimeBinding::new(
        Some(EPOCH.to_owned()),
        session_name("alpha"),
        PaneId::new(3),
        7,
    )
}

fn observed<'a>(
    daemon_instance: &'a str,
    pane_present: bool,
    generation: Option<u64>,
) -> BindingFacts<'a> {
    BindingFacts::Observed {
        daemon_instance,
        pane_present,
        generation,
    }
}

#[test]
fn binding_stays_valid_while_daemon_pane_and_generation_match() {
    let binding = binding();

    assert_eq!(
        verify(&binding, observed(EPOCH, true, Some(7))),
        BindingVerdict::Valid
    );
    // 判定是纯函数：同一输入重复求值结果不变。
    assert_eq!(
        verify(&binding, observed(EPOCH, true, Some(7))),
        BindingVerdict::Valid
    );
    assert!(BindingVerdict::Valid.is_valid());
    assert_eq!(BindingVerdict::Valid.failure(), None);
}

#[test]
fn binding_is_stale_daemon_after_a_restart_with_identical_pane_values() {
    let binding = binding();

    // daemon 重启后 session/pane id/generation 可与旧值完全相同。
    let verdict = verify(&binding, observed(OTHER_EPOCH, true, Some(7)));

    assert_eq!(verdict, BindingVerdict::StaleDaemon);
    assert!(!verdict.is_valid());
    assert_eq!(verdict.failure(), Some(PaneBindingFailure::StaleDaemon));
}

#[test]
fn binding_is_stale_pane_when_the_bound_pane_slot_was_reused() {
    let binding = binding();

    // 槽位复用：pane id 已经不存在（新进程在旧槽位另有 id）。
    let verdict = verify(&binding, observed(EPOCH, false, Some(7)));

    assert_eq!(verdict, BindingVerdict::StalePane);
    assert_eq!(verdict.failure(), Some(PaneBindingFailure::StalePane));
}

#[test]
fn binding_is_stale_generation_when_the_pane_process_was_respawned() {
    let binding = binding();

    let verdict = verify(&binding, observed(EPOCH, true, Some(8)));

    assert_eq!(verdict, BindingVerdict::StaleGeneration);
    assert_eq!(verdict.failure(), Some(PaneBindingFailure::StaleGeneration));
}

#[test]
fn binding_is_unverifiable_without_a_daemon_instance_epoch() {
    let binding = binding();

    let verdict = verify(&binding, BindingFacts::DaemonUnverifiable);

    assert_eq!(verdict, BindingVerdict::Unverifiable);
    assert_eq!(verdict.failure(), Some(PaneBindingFailure::Unverifiable));
}

#[test]
fn binding_captured_without_an_epoch_cannot_address_a_modern_daemon() {
    // 旧绑定不能借用现代 daemon 的同值 pane；热路径和完整观测遵守同一拒绝规则。
    let binding = RuntimeBinding::new(None, session_name("alpha"), PaneId::new(3), 7);

    for facts in [
        observed(EPOCH, true, Some(7)),
        BindingFacts::DaemonObserved {
            daemon_instance: EPOCH,
        },
    ] {
        let verdict = verify(&binding, facts);
        assert!(!verdict.allows_pane_address(), "{facts:?}");
        assert_eq!(verdict, BindingVerdict::StaleDaemon);
        assert_eq!(verdict.failure(), Some(PaneBindingFailure::StaleDaemon));
    }
}

#[test]
fn binding_skips_the_generation_check_when_it_was_not_observed() {
    // 热路径只确认了 pane id（未付 pane info 往返）时，不得伪造 generation 值；
    // 该场景跳过 generation 比较，但仍受 epoch 与 pane 存在性约束。
    let binding = binding();

    assert_eq!(
        verify(&binding, observed(EPOCH, true, None)),
        BindingVerdict::Valid
    );
    assert_eq!(
        verify(&binding, observed(OTHER_EPOCH, true, None)),
        BindingVerdict::StaleDaemon
    );
    assert_eq!(
        verify(&binding, observed(EPOCH, false, None)),
        BindingVerdict::StalePane
    );
}

#[test]
fn binding_prefers_the_daemon_instance_over_pane_level_observations() {
    let binding = binding();

    // 重启后槽位复用且 generation 归位：必须是 StaleDaemon，不得回落槽位猜测。
    assert_eq!(
        verify(&binding, observed(OTHER_EPOCH, false, Some(8))),
        BindingVerdict::StaleDaemon
    );
    // epoch 不可确认时同样不得用 pane 观测“猜测”有效。
    assert_eq!(
        verify(&binding, BindingFacts::DaemonUnverifiable),
        BindingVerdict::Unverifiable
    );
}

#[test]
fn binding_verdict_failure_codes_are_distinct_per_verdict() {
    let codes = [
        BindingVerdict::Valid.failure(),
        BindingVerdict::StaleDaemon.failure(),
        BindingVerdict::StalePane.failure(),
        BindingVerdict::StaleGeneration.failure(),
        BindingVerdict::Unverifiable.failure(),
    ];

    for (index, code) in codes.iter().enumerate().skip(1) {
        assert!(
            code.is_some(),
            "verdict {index} must carry a deterministic failure code"
        );
        assert!(
            !codes[index + 1..].contains(code),
            "failure code {code:?} must be unique to one verdict"
        );
    }
}

#[test]
fn unverifiable_bindings_may_still_be_addressed_by_pane_id() {
    // 「无法确认」不等于「已失效」：与不携带实例身份的旧 daemon 通信时，
    // 捕获的 pane id 仍是该 daemon 生命周期内的稳定实体，继续按 id 寻址、
    // 由 daemon 判定存在性；否则新版客户端 + 旧 daemon 的组合会让终端全部不可用。
    let older_daemon = RuntimeBinding::new(None, session_name("alpha"), PaneId::new(3), 7);

    let verdict = verify(&older_daemon, BindingFacts::DaemonUnverifiable);

    assert_eq!(verdict, BindingVerdict::Unverifiable);
    assert!(verdict.allows_pane_address());
    assert!(!verdict.is_valid());
}

#[test]
fn disproved_bindings_are_never_addressable() {
    for verdict in [
        BindingVerdict::StaleDaemon,
        BindingVerdict::StalePane,
        BindingVerdict::StaleGeneration,
    ] {
        assert!(
            !verdict.allows_pane_address(),
            "{verdict:?} must be refused"
        );
        assert!(verdict.failure().is_some(), "{verdict:?}");
    }
    assert!(BindingVerdict::Valid.allows_pane_address());
}
