//! Canonical product and protocol identities emitted by current Berth builds.

use serde_json::Value;

pub const PRODUCT_NAME: &str = "berth";
pub const MCP_SERVER_NAME: &str = "berth-mcp";
pub const DELEGATION_META_KEY: &str = "berth.delegation";

pub fn delegation_meta(value: &Value) -> Option<&Value> {
    value.get(DELEGATION_META_KEY)
}
