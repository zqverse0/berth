pub mod agent;
pub mod background;
pub mod conversation;
pub mod delegation;
pub mod folder;
pub mod message;
pub mod model_provider;
pub mod pet;
pub mod quick_message;
pub mod system;

pub use agent::AgentType;
pub use conversation::{
    AgentConversationCount, AgentStats, ContextSource, ConversationDetail, ConversationSummary,
    DbConversationDetail, DbConversationSummary, FolderInfo, ImportFolderOutcome, ImportResult,
    ImportSelectedResult, ProjectAgentSessionPage, ProjectAgentSessionPageRequest,
    ProjectAgentSessionSource, ProjectAgentSessionSummary, ResolveProjectAgentSessionResult,
    ScanFolder, ScanResult, ScanSession, ScanSessionStatus, SelectedSessionKey, SessionGroupLink,
    SessionStats, SidebarData,
};
pub use folder::{
    ConversationTab, FolderCommandInfo, FolderDetail, FolderHistoryEntry, OpenedTab,
    OpenedTabsSnapshot, PrimaryTab, PrimaryTabsSnapshot, SavePrimaryTabsOutcome,
    SavePrimaryTabsRejection, SaveTabsOutcome, TerminalTab,
};
pub use message::{
    AgentExecutionStats, AgentToolCall, ContentBlock, ImageData, MessageRole, MessageTurn,
    TurnRole, TurnUsage, UnifiedMessage,
};
pub use quick_message::QuickMessageInfo;
#[cfg(feature = "tauri-runtime")]
pub use system::SystemRenderingSettings;
pub use system::{
    AvailableTerminalShells, GitCredentials, GitDetectResult, GitHubAccountsSettings,
    GitHubTokenValidation, GitSettings, HealthResponse, SystemLanguageSettings,
    SystemProxySettings, SystemTerminalSettings, TerminalShellOption,
};
