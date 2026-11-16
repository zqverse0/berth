use super::RequestHandler;
use berth_term_engine::PaneGeometry;
use berth_term_proto::{
    LayoutName, NewSessionRequest, PaneTarget, Request, Response, SelectLayoutRequest,
    SelectLayoutTarget, SessionName, SplitWindowRequest, SplitWindowTarget, TerminalSize,
    WindowTarget,
};

fn session_name(value: &str) -> SessionName {
    SessionName::new(value).expect("valid session name")
}

async fn create_session(handler: &RequestHandler, session_name: &SessionName, size: TerminalSize) {
    let created = handler
        .handle(Request::NewSession(NewSessionRequest {
            session_name: session_name.clone(),
            detached: true,
            size: Some(size),

            environment: None,
        }))
        .await;
    assert!(matches!(created, Response::NewSession(_)));
}

async fn split_pane_zero(handler: &RequestHandler, session_name: &SessionName, expected_pane: u32) {
    let split = handler
        .handle(Request::SplitWindow(SplitWindowRequest {
            target: SplitWindowTarget::Pane(PaneTarget::new(session_name.clone(), 0)),
            direction: berth_term_proto::SplitDirection::Vertical,
            before: false,
            environment: None,
        }))
        .await;
    assert_eq!(
        split,
        Response::SplitWindow(berth_term_proto::SplitWindowResponse {
            pane: PaneTarget::new(session_name.clone(), expected_pane),
        })
    );
}

#[tokio::test]
async fn select_layout_even_layouts_apply_tmux_geometry_through_the_handler() {
    let handler = RequestHandler::new();
    let alpha = session_name("alpha");

    create_session(
        &handler,
        &alpha,
        TerminalSize {
            cols: 100,
            rows: 40,
        },
    )
    .await;

    for expected_pane in [1, 1] {
        split_pane_zero(&handler, &alpha, expected_pane).await;
    }

    let even_horizontal = handler
        .handle(Request::SelectLayout(SelectLayoutRequest {
            target: SelectLayoutTarget::Window(WindowTarget::new(alpha.clone())),
            layout: LayoutName::EvenHorizontal,
        }))
        .await;
    assert_eq!(
        even_horizontal,
        Response::SelectLayout(berth_term_proto::SelectLayoutResponse {
            layout: LayoutName::EvenHorizontal,
        })
    );

    {
        let state = handler.state.lock().await;
        let session = state.sessions.session(&alpha).expect("session exists");
        let window = session.window();
        assert_eq!(window.layout(), LayoutName::EvenHorizontal);
        assert_eq!(
            window.pane(0).expect("pane 0 exists").geometry(),
            PaneGeometry::new(0, 0, 32, 40)
        );
        assert_eq!(
            window.pane(1).expect("pane 1 exists").geometry(),
            PaneGeometry::new(33, 0, 32, 40)
        );
        assert_eq!(
            window.pane(2).expect("pane 2 exists").geometry(),
            PaneGeometry::new(66, 0, 34, 40)
        );
    }

    let even_vertical = handler
        .handle(Request::SelectLayout(SelectLayoutRequest {
            target: SelectLayoutTarget::Window(WindowTarget::new(alpha.clone())),
            layout: LayoutName::EvenVertical,
        }))
        .await;
    assert_eq!(
        even_vertical,
        Response::SelectLayout(berth_term_proto::SelectLayoutResponse {
            layout: LayoutName::EvenVertical,
        })
    );

    let state = handler.state.lock().await;
    let session = state.sessions.session(&alpha).expect("session exists");
    let window = session.window();
    assert_eq!(window.layout(), LayoutName::EvenVertical);
    assert_eq!(
        window.pane(0).expect("pane 0 exists").geometry(),
        PaneGeometry::new(0, 0, 100, 12)
    );
    assert_eq!(
        window.pane(1).expect("pane 1 exists").geometry(),
        PaneGeometry::new(0, 13, 100, 12)
    );
    assert_eq!(
        window.pane(2).expect("pane 2 exists").geometry(),
        PaneGeometry::new(0, 26, 100, 14)
    );
}
