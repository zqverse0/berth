use super::RequestHandler;
use berth_term_proto::{
    NewSessionExtRequest, NewSessionRequest, OptionName, Request, Response, ScopeSelector,
    SessionName, SetOptionMode, SetOptionRequest, TerminalSize,
};

fn session_name(value: &str) -> SessionName {
    SessionName::new(value).expect("valid session name")
}

async fn create_session(handler: &RequestHandler, name: &str) {
    let response = handler
        .handle(Request::NewSession(NewSessionRequest {
            session_name: session_name(name),
            detached: true,
            size: Some(TerminalSize { cols: 80, rows: 24 }),
            environment: None,
        }))
        .await;

    assert!(matches!(response, Response::NewSession(_)));
}

#[tokio::test]
async fn default_terminal_applies_to_initial_panes_and_yields_to_explicit_term() {
    let handler = RequestHandler::new();

    assert_eq!(
        handler
            .handle(Request::SetOption(SetOptionRequest {
                scope: ScopeSelector::Global,
                option: OptionName::DefaultTerminal,
                value: "tmux-256color".to_owned(),
                mode: SetOptionMode::Replace,
            }))
            .await,
        Response::SetOption(berth_term_proto::SetOptionResponse {
            scope: ScopeSelector::Global,
            option: OptionName::DefaultTerminal,
            mode: SetOptionMode::Replace,
        })
    );

    create_session(&handler, "alpha").await;

    {
        let state = handler.state.lock().await;
        let pane_zero = state
            .pane_profile(&session_name("alpha"), 0)
            .expect("pane 0 profile exists");
        assert_eq!(pane_zero.environment_value("TERM"), Some("tmux-256color"));
    }

    handler.state.lock().await.environment.set(
        ScopeSelector::Session(session_name("alpha")),
        "TERM".to_owned(),
        "screen-256color".to_owned(),
    );

    let split = handler
        .handle(Request::SplitWindow(berth_term_proto::SplitWindowRequest {
            target: berth_term_proto::SplitWindowTarget::Session(session_name("alpha")),
            direction: berth_term_proto::SplitDirection::Vertical,
            before: false,
            environment: None,
        }))
        .await;
    assert!(matches!(split, Response::SplitWindow(_)));

    let state = handler.state.lock().await;
    let pane_one = state
        .pane_profile(&session_name("alpha"), 1)
        .expect("pane 1 profile exists");
    assert_eq!(pane_one.environment_value("TERM"), Some("tmux-256color"));
    drop(state);

    let split = handler
        .handle(Request::SplitWindow(berth_term_proto::SplitWindowRequest {
            target: berth_term_proto::SplitWindowTarget::Session(session_name("alpha")),
            direction: berth_term_proto::SplitDirection::Vertical,
            before: false,
            environment: Some(vec!["TERM=screen-256color".to_owned()]),
        }))
        .await;
    assert!(matches!(split, Response::SplitWindow(_)));

    let state = handler.state.lock().await;
    let pane_two = state
        .pane_profile(&session_name("alpha"), 2)
        .expect("pane 2 profile exists");
    assert_eq!(pane_two.environment_value("TERM"), Some("screen-256color"));
}

#[tokio::test]
async fn spawned_pane_environment_contains_pane_id_with_percent_prefix() {
    let handler = RequestHandler::new();
    create_session(&handler, "alpha").await;

    let state = handler.state.lock().await;
    let pane_zero = state
        .pane_profile(&session_name("alpha"), 0)
        .expect("pane 0 profile exists");
    let berth_pane = pane_zero.environment_value("BERTH_PANE");
    assert!(
        berth_pane.is_some(),
        "BERTH_PANE must be set in spawned pane environment"
    );
    let berth_pane = berth_pane.expect("BERTH_PANE is set");
    assert_eq!(pane_zero.environment_value("TMUX_PANE"), Some(berth_pane));
    assert!(
        berth_pane.starts_with('%'),
        "BERTH_PANE must start with %: got {berth_pane}"
    );
    let id_part = &berth_pane[1..];
    assert!(
        id_part.parse::<u32>().is_ok(),
        "BERTH_PANE must be %<id>: got {berth_pane}"
    );
}

#[tokio::test]
async fn spawned_pane_environment_contains_decodable_target_ref() {
    let handler = RequestHandler::new();
    create_session(&handler, "alpha").await;

    let state = handler.state.lock().await;
    let pane_zero = state
        .pane_profile(&session_name("alpha"), 0)
        .expect("pane 0 profile exists");
    let encoded = pane_zero
        .environment_value("BERTH_TARGET_REF")
        .expect("BERTH_TARGET_REF is set");
    let decoded = berth_control_proto::TargetBindingRef::decode(encoded).expect("decodes");
    let pane_id = pane_zero
        .environment_value("BERTH_PANE")
        .expect("BERTH_PANE is set")[1..]
        .parse::<u32>()
        .expect("numeric pane id");
    let generation = state
        .pane_lifecycle(berth_term_engine::PaneId::new(pane_id))
        .expect("pane lifecycle recorded")
        .generation;

    // 注入值必须与创建返回的绑定同源：同一 epoch、session、稳定 pane id 与 spawn 后记录的 generation。
    assert_eq!(
        decoded,
        berth_control_proto::TargetBindingRef {
            version: 1,
            daemon_instance: Some(handler.daemon_instance().to_owned()),
            session: "alpha".to_owned(),
            pane_id,
            generation,
        }
    );
}

#[tokio::test]
async fn spawned_pane_environment_contains_mux_socket_pid_session_format() {
    let handler = RequestHandler::new();
    create_session(&handler, "alpha").await;

    let state = handler.state.lock().await;
    let pane_zero = state
        .pane_profile(&session_name("alpha"), 0)
        .expect("pane 0 profile exists");
    let berth_value = pane_zero.environment_value("BERTH").expect("BERTH is set");
    assert_eq!(pane_zero.environment_value("TMUX"), Some(berth_value));
    let parts: Vec<_> = berth_value.split(',').collect();
    assert_eq!(
        parts.len(),
        3,
        "BERTH must be <socket>,<pid>,<session_id>: got {berth_value}"
    );
    assert!(
        parts[1].parse::<u32>().is_ok(),
        "BERTH pid must be numeric: got {}",
        parts[1]
    );
    assert!(
        parts[2].parse::<u32>().is_ok(),
        "BERTH session_id must be numeric: got {}",
        parts[2]
    );
}

#[tokio::test]
async fn environment_override_layering_session_then_override_then_berth_pane() {
    let handler = RequestHandler::new();

    handler.state.lock().await.environment.set(
        ScopeSelector::Global,
        "MY_VAR".to_owned(),
        "global".to_owned(),
    );

    // Create session with -e overrides: MY_VAR should be overridden by -e.
    let response = handler
        .handle(Request::NewSession(NewSessionRequest {
            session_name: session_name("alpha"),
            detached: true,
            size: Some(TerminalSize { cols: 80, rows: 24 }),
            environment: Some(vec!["MY_VAR=override".to_owned()]),
        }))
        .await;
    assert!(matches!(response, Response::NewSession(_)));

    let state = handler.state.lock().await;
    let pane_zero = state
        .pane_profile(&session_name("alpha"), 0)
        .expect("pane 0 profile exists");

    // -e overrides must beat session/global environment.
    assert_eq!(pane_zero.environment_value("MY_VAR"), Some("override"));
    // BERTH_PANE must still be present despite -e.
    assert!(pane_zero.environment_value("BERTH_PANE").is_some());
    drop(state);

    let state = handler.state.lock().await;
    assert_eq!(
        state
            .environment
            .session_value(&session_name("alpha"), "MY_VAR"),
        Some("override")
    );
}

#[tokio::test]
async fn new_session_ext_client_environment_respects_tmux_precedence() {
    let handler = RequestHandler::new();
    let session = session_name("client-env");

    for name in ["RMUX_GLOBAL_ENV_SENTINEL", "RMUX_OVERRIDE_ENV_SENTINEL"] {
        handler.state.lock().await.environment.set(
            ScopeSelector::Global,
            name.to_owned(),
            "from-server".to_owned(),
        );
    }

    let response = handler
        .handle(Request::NewSessionExt(Box::new(NewSessionExtRequest {
            session_name: Some(session.clone()),
            working_directory: None,
            detached: true,
            size: Some(TerminalSize { cols: 80, rows: 24 }),
            environment: Some(vec![
                "RMUX_OVERRIDE_ENV_SENTINEL=from-explicit".to_owned(),
                "RMUX_CLIENT_ENV_SENTINEL=from-explicit".to_owned(),
            ]),
            group_target: None,
            attach_if_exists: false,
            detach_other_clients: false,
            kill_other_clients: false,
            flags: None,
            window_name: None,
            print_session_info: false,
            print_format: None,
            command: None,
            process_command: None,
            client_environment: Some(vec![
                "PATH=/tmp/berth-cli-bin:/usr/bin".to_owned(),
                "SSH_AUTH_SOCK=/tmp/berth-cli-agent.sock".to_owned(),
                "RMUX_GLOBAL_ENV_SENTINEL=from-client".to_owned(),
                "RMUX_OVERRIDE_ENV_SENTINEL=from-client".to_owned(),
                "RMUX_CLIENT_ENV_SENTINEL=from-client".to_owned(),
                "RMUX_CLIENT_ONLY_ENV_SENTINEL=from-client".to_owned(),
            ]),
            skip_environment_update: false,
        })))
        .await;

    assert!(matches!(response, Response::NewSession(_)));

    let state = handler.state.lock().await;
    let pane_zero = state
        .pane_profile(&session, 0)
        .expect("pane 0 profile exists");
    assert_eq!(
        pane_zero.environment_value("PATH"),
        Some("/tmp/berth-cli-bin:/usr/bin")
    );
    assert_eq!(
        pane_zero.environment_value("SSH_AUTH_SOCK"),
        Some("/tmp/berth-cli-agent.sock")
    );
    assert_eq!(
        pane_zero.environment_value("RMUX_GLOBAL_ENV_SENTINEL"),
        Some("from-server")
    );
    assert_eq!(
        pane_zero.environment_value("RMUX_OVERRIDE_ENV_SENTINEL"),
        Some("from-explicit")
    );
    assert_eq!(
        pane_zero.environment_value("RMUX_CLIENT_ENV_SENTINEL"),
        Some("from-explicit")
    );
    assert_eq!(
        pane_zero.environment_value("RMUX_CLIENT_ONLY_ENV_SENTINEL"),
        Some("from-client")
    );
    drop(state);

    // 客户端环境只用于启动进程，不写进会话环境
    let state = handler.state.lock().await;
    assert_eq!(
        state
            .environment
            .session_value(&session, "RMUX_CLIENT_ONLY_ENV_SENTINEL"),
        None
    );
}

#[tokio::test]
async fn new_session_ext_skip_environment_update_keeps_client_spawn_environment() {
    let handler = RequestHandler::new();
    let session = session_name("skip-client-env");

    let response = handler
        .handle(Request::NewSessionExt(Box::new(NewSessionExtRequest {
            session_name: Some(session.clone()),
            working_directory: None,
            detached: true,
            size: Some(TerminalSize { cols: 80, rows: 24 }),
            environment: None,
            group_target: None,
            attach_if_exists: false,
            detach_other_clients: false,
            kill_other_clients: false,
            flags: None,
            window_name: None,
            print_session_info: false,
            print_format: None,
            command: None,
            process_command: None,
            client_environment: Some(vec![
                "PATH=/tmp/berth-cli-bin:/usr/bin".to_owned(),
                "RMUX_CLIENT_ONLY_ENV_SENTINEL=from-client".to_owned(),
            ]),
            skip_environment_update: true,
        })))
        .await;

    assert!(matches!(response, Response::NewSession(_)));

    let state = handler.state.lock().await;
    let pane_zero = state
        .pane_profile(&session, 0)
        .expect("pane 0 profile exists");
    assert_eq!(
        pane_zero.environment_value("RMUX_CLIENT_ONLY_ENV_SENTINEL"),
        Some("from-client")
    );
    drop(state);

    // 客户端环境只用于启动进程，不写进会话环境
    let state = handler.state.lock().await;
    assert_eq!(state.environment.session_value(&session, "PATH"), None);
}
