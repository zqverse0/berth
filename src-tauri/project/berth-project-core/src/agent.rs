use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::collections::HashSet;
use std::fmt;
use std::sync::{Mutex, OnceLock};

/// Agent 身份：插件 `contributes.agent.projectType` 声明的 id（如 `claude_code`、`codex`）。
///
/// 不维护品牌清单：任何合法 id 都是有效身份，展示名与图标来自插件 `tool.json`。
/// 序列化即 id 字符串，与库表 `agent_type` 列一致。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct AgentType(&'static str);

const MAX_ID_LEN: usize = 64;

impl AgentType {
    /// 字面量 id（调用方保证合法，测试与内置常量用）。
    pub const fn new(id: &'static str) -> Self {
        Self(id)
    }

    /// 校验并驻留：同一 id 只留一份。
    // ponytail: 驻留的字符串不释放，上限是出现过的不同合法 id 数（插件声明 + 库表里的值，量级几十）。
    pub fn parse(id: &str) -> Option<Self> {
        if !is_valid_id(id) {
            return None;
        }
        static INTERNED: OnceLock<Mutex<HashSet<&'static str>>> = OnceLock::new();
        let mut interned = INTERNED
            .get_or_init(Default::default)
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(existing) = interned.get(id) {
            return Some(Self(existing));
        }
        let leaked: &'static str = Box::leak(id.to_owned().into_boxed_str());
        interned.insert(leaked);
        Some(Self(leaked))
    }

    pub fn as_str(&self) -> &'static str {
        self.0
    }
}

/// 与插件 id 同一规则：`[a-z0-9][a-z0-9._-]*`，不超过 64 字符。
fn is_valid_id(id: &str) -> bool {
    let mut chars = id.chars();
    id.len() <= MAX_ID_LEN
        && chars
            .next()
            .is_some_and(|first| first.is_ascii_lowercase() || first.is_ascii_digit())
        && chars
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-'))
}

impl fmt::Display for AgentType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.0)
    }
}

impl Serialize for AgentType {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.0)
    }
}

impl<'de> Deserialize<'de> for AgentType {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let id = String::deserialize(deserializer)?;
        Self::parse(&id).ok_or_else(|| serde::de::Error::custom(format!("invalid agent id {id:?}")))
    }
}

/// 工具声明的 `projectType` → Agent 身份；只校验格式，不看品牌。
pub fn parse_known_agent_type(value: &str) -> Option<AgentType> {
    AgentType::parse(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn any_valid_id_round_trips_as_its_string() {
        let agent = AgentType::parse("demo_agent").unwrap();
        assert_eq!(agent.as_str(), "demo_agent");
        assert_eq!(serde_json::to_value(agent).unwrap(), "demo_agent");
        let back: AgentType = serde_json::from_str("\"claude_code\"").unwrap();
        assert_eq!(back, AgentType::new("claude_code"));
        assert_eq!(back.to_string(), "claude_code");
    }

    #[test]
    fn same_id_is_interned_once() {
        let first = AgentType::parse("interned.check").unwrap();
        let second = AgentType::parse("interned.check").unwrap();
        assert!(std::ptr::eq(first.as_str(), second.as_str()));
    }

    #[test]
    fn invalid_ids_are_rejected() {
        for bad in ["", "Codex", "-x", "a b", "a/b", &"x".repeat(65)] {
            assert!(AgentType::parse(bad).is_none(), "{bad:?}");
            assert!(serde_json::from_value::<AgentType>(bad.into()).is_err());
        }
    }
}
