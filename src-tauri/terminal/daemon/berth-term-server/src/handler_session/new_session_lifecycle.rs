use berth_term_engine::LifecycleEvent;
use berth_term_proto::{HookName, ScopeSelector, SessionName};

use crate::hook_runtime::PendingInlineHookFormat;

use super::super::{active_session_target, RequestHandler};

impl RequestHandler {
    pub(in crate::handler) async fn finish_new_session_lifecycle(
        &self,
        session_name: &SessionName,
    ) {
        self.sync_session_silence_timers(session_name).await;
        let current_target = {
            let state = self.state.lock().await;
            active_session_target(&state.sessions, session_name)
        };
        self.queue_inline_hook(
            HookName::AfterNewSession,
            ScopeSelector::Session(session_name.clone()),
            current_target,
            PendingInlineHookFormat::AfterCommand,
        );
        self.emit(LifecycleEvent::SessionCreated {
            session_name: session_name.clone(),
        })
        .await;
    }
}
