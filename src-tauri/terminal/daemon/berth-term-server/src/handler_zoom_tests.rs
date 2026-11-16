use super::RequestHandler;
use berth_term_proto::{
    NewSessionRequest, PaneTarget, Request, ResizePaneAdjustment, ResizePaneRequest, Response,
    SessionName, SplitDirection, SplitWindowRequest, SplitWindowTarget, TerminalSize,
};

fn session_name(value: &str) -> SessionName {
    SessionName::new(value).expect("valid session name")
}

#[tokio::test]
async fn resize_pane_zoom_toggles_the_target_window() {
    let handler = RequestHandler::new();
    let alpha = session_name("alpha");

    assert!(matches!(
        handler
            .handle(Request::NewSession(NewSessionRequest {
                session_name: alpha.clone(),
                detached: true,
                size: Some(TerminalSize { cols: 80, rows: 24 }),
                environment: None,
            }))
            .await,
        Response::NewSession(_)
    ));
    assert!(matches!(
        handler
            .handle(Request::SplitWindow(SplitWindowRequest {
                target: SplitWindowTarget::Session(alpha.clone()),
                direction: SplitDirection::Horizontal,
                before: false,
                environment: None,
            }))
            .await,
        Response::SplitWindow(_)
    ));

    let response = handler
        .handle(Request::ResizePane(ResizePaneRequest {
            target: PaneTarget::new(alpha.clone(), 1),
            adjustment: ResizePaneAdjustment::Zoom,
        }))
        .await;

    assert_eq!(
        response,
        Response::ResizePane(berth_term_proto::ResizePaneResponse {
            target: PaneTarget::new(alpha.clone(), 1),
            adjustment: ResizePaneAdjustment::Zoom,
        })
    );

    let state = handler.state.lock().await;
    assert!(state
        .sessions
        .session(&alpha)
        .expect("session exists")
        .window()
        .is_zoomed());
}
