use berth_term_engine::events::SubscriptionLimits;

use crate::signals::SignalWatcher;
#[cfg(unix)]
use crate::unix_socket::SocketFileIdentity;

pub(crate) struct ServeOptions {
    pub(crate) server_signals: Option<SignalWatcher>,
    pub(crate) subscription_limits: SubscriptionLimits,
    pub(crate) owner_uid: u32,
    #[cfg(unix)]
    pub(crate) socket_identity: Option<SocketFileIdentity>,
}

impl ServeOptions {
    pub(crate) fn new(subscription_limits: SubscriptionLimits, owner_uid: u32) -> Self {
        Self {
            server_signals: None,
            subscription_limits,
            owner_uid,
            #[cfg(unix)]
            socket_identity: None,
        }
    }

    #[cfg(unix)]
    pub(crate) fn with_socket_identity(
        mut self,
        socket_identity: Option<SocketFileIdentity>,
    ) -> Self {
        self.socket_identity = socket_identity;
        self
    }

    #[cfg(unix)]
    pub(crate) fn with_server_signals(mut self, server_signals: SignalWatcher) -> Self {
        self.server_signals = Some(server_signals);
        self
    }
}
