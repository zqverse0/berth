/// Persisted link from a child conversation to the parent tool call that
/// created it. Historical transcript reconstruction still uses this metadata
/// after the live delegation runtime was removed.
#[derive(Debug, Clone)]
pub struct DelegationLink {
    pub parent_conversation_id: i32,
    pub parent_tool_use_id: String,
    pub delegation_call_id: String,
}
