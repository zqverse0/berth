//! tool.json → `AgentProfile` 投影（阶段 C 消费面迁移）。
//!
//! 让既有 agent 身份消费面（launchbar 列表、官方登录档案种子、
//! capability_status 与 provider 注入声明）全部经
//! `profile::load_agent_profile` 的 tool.json 优先链路取数，无需各自接线。
//! 投影产出为通用 `AgentProfile`，sanitize 规则复用 profile.rs 的防守逻辑。
//!
//! 返回 `None` 的情形：protocol 不是 `berth.tool/1`；无
//! `org.berth.agent` 扩展（普通工具不是 Agent）；关键字段缺失。坏的资源引用只
//! 丢弃对应声明，不作废整个 Agent。

use serde_json::Value;

use super::asset::ToolAsset;
use super::profile::{
    AgentProfile, CapabilityStores, McpStoreDeclaration, SkillStatusDeclaration, SkillStatusSource,
    SkillStatusSourceKind, SkillStoreDeclaration,
};

/// 投影入口：`extensions["org.berth.agent"]` + 顶层 identity/resources
/// → 通用 `AgentProfile`。sanitize 在 `profile` 模块统一执行。
pub fn profile_from_asset(id: &str, asset: &ToolAsset) -> Option<AgentProfile> {
    let raw = asset.raw();
    let identity = raw.get("identity")?;
    let extension = asset.agent_extension()?;

    let name = identity
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| id.to_string());
    let icon = identity
        .get("icon")
        .and_then(Value::as_str)
        .map(str::to_string);
    let description = identity
        .get("description")
        .and_then(Value::as_str)
        .map(str::to_string);
    let project_type = extension
        .get("projectType")
        .and_then(Value::as_str)
        .map(str::to_string);
    let provider_injection = berth_tool_core::provider_injection::from_extension(extension);
    let capability_stores = capability_stores_from_extension(extension, raw);
    let interrupt_key = extension
        .get("interruptKey")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .map(str::to_string);

    let profile = AgentProfile {
        name,
        icon,
        description,
        project_type,
        provider_injection,
        capability_stores,
        interrupt_key,
    };
    // 所有投影共用同一防守（能力落点 sanitize、name 空值回落目录名）。
    Some(super::profile::sanitize_profile(profile, id))
}

// ─── org.berth.agent 扩展投影 ────────────────────────────────────────

/// capabilityStores：mcp/skills/skillStatus 的资源引用逐个解析回旧声明。
/// 无法解析的引用只丢弃对应条目。
fn capability_stores_from_extension(extension: &Value, raw: &Value) -> Option<CapabilityStores> {
    let stores = extension.get("capabilityStores")?;

    let mcp = stores.get("mcp").and_then(Value::as_str).and_then(|id| {
        let resource = resource_declaration(raw, id)?;
        let path = resource_home_path(raw, id)?;
        let format = resource.get("format").and_then(Value::as_str)?.to_string();
        Some(McpStoreDeclaration { path, format })
    });

    let skills = stores.get("skills").map(|skills| SkillStoreDeclaration {
        search_paths: resource_ids(skills.get("searchPaths"))
            .filter_map(|id| resource_home_path_with_layout(raw, id))
            .collect(),
        project_search_paths: resource_ids(skills.get("projectSearchPaths"))
            .filter_map(|id| resource_workspace_path(raw, id))
            .collect(),
        shared: resource_ids(skills.get("shared"))
            .filter_map(|id| resource_home_path(raw, id))
            .collect(),
        store: stores
            .get("skills")
            .and_then(|skills| skills.get("store"))
            .and_then(Value::as_str)
            .and_then(|id| resource_home_path(raw, id))
            .unwrap_or_else(default_store),
        layout: None,
    });

    let skill_status = stores
        .get("skillStatus")
        .and_then(Value::as_array)
        .map(|ids| SkillStatusDeclaration {
            sources: ids
                .iter()
                .filter_map(Value::as_str)
                .filter_map(|id| {
                    let resource = resource_declaration(raw, id)?;
                    let path = resource_home_path(raw, id)?;
                    let kind = resource
                        .get("purpose")
                        .and_then(Value::as_str)?
                        .strip_prefix("skill-status:")?;
                    let kind = match kind {
                        "enabled-flags" => SkillStatusSourceKind::EnabledFlags,
                        "install-registry" => SkillStatusSourceKind::InstallRegistry,
                        "usage-stats" => SkillStatusSourceKind::UsageStats,
                        _ => return None,
                    };
                    Some(SkillStatusSource { path, kind })
                })
                .collect(),
        });

    Some(CapabilityStores {
        mcp,
        skills,
        skill_status,
    })
}

fn default_store() -> String {
    "~/.berth/skills".into()
}

// ─── 资源引用解析 ─────────────────────────────────────────────────────

fn resource_declaration<'a>(raw: &'a Value, id: &str) -> Option<&'a Value> {
    raw.get("resources")?.get(id)
}

/// home 基资源 → `~/<path>`；absolute → 原路径。其他基（workspace/
/// package/未知）不产生全局路径。
fn resource_home_path(raw: &Value, id: &str) -> Option<String> {
    let locator = resource_declaration(raw, id)?.get("locator")?;
    match locator.get("base").and_then(Value::as_str)? {
        "home" => Some(format!(
            "~/{}",
            locator.get("path").and_then(Value::as_str)?
        )),
        "absolute" => locator
            .get("path")
            .and_then(Value::as_str)
            .map(str::to_string),
        _ => None,
    }
}

/// 同 `resource_home_path`，但 `locator.layout == "recursive"` 时按旧约定
/// 加 `recursive:` 前缀（per-path 布局，如 claude 插件缓存目录）。
fn resource_home_path_with_layout(raw: &Value, id: &str) -> Option<String> {
    let path = resource_home_path(raw, id)?;
    let recursive = resource_declaration(raw, id)?
        .get("locator")
        .and_then(|locator| locator.get("layout"))
        .and_then(Value::as_str)
        == Some("recursive");
    Some(if recursive {
        format!("recursive:{path}")
    } else {
        path
    })
}

/// workspace 基资源 → 项目内相对路径（旧 project 落点形态）。
fn resource_workspace_path(raw: &Value, id: &str) -> Option<String> {
    let locator = resource_declaration(raw, id)?.get("locator")?;
    if locator.get("base").and_then(Value::as_str) != Some("workspace") {
        return None;
    }
    locator
        .get("path")
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn resource_ids(value: Option<&Value>) -> impl Iterator<Item = &str> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tool::asset::{ToolAsset, TOOL_ASSET_PROTOCOL};
    use serde_json::json;

    fn agent_asset(extension: Value) -> ToolAsset {
        let mut raw = json!({
            "protocol": TOOL_ASSET_PROTOCOL,
            "id": "demo",
            "identity": { "name": "Demo", "icon": "demo", "description": "demo agent" },
            "resources": {
                "mcp-file": {
                    "kind": "file", "locator": { "base": "home", "path": ".demo/mcp.json" },
                    "format": "demo-mcp-v1"
                },
                "skills-global": {
                    "kind": "directory", "locator": { "base": "home", "path": ".demo/skills" }
                },
                "skills-cache": {
                    "kind": "directory",
                    "locator": { "base": "home", "path": ".demo/cache", "layout": "recursive" }
                },
                "skills-project": {
                    "kind": "directory", "locator": { "base": "workspace", "path": ".demo/skills" }
                },
                "status-flags": {
                    "kind": "file", "locator": { "base": "home", "path": ".demo/settings.json" },
                    "purpose": "skill-status:enabled-flags"
                },
                "expert-dir": {
                    "kind": "directory", "locator": { "base": "workspace", "path": ".demo" }
                }
            }
        });
        raw["extensions"] = json!({ "org.berth.agent": extension });
        ToolAsset::from_value(raw)
    }

    #[test]
    fn full_extension_projects_all_fields() {
        let asset = agent_asset(json!({
            "projectType": "demo_agent",
            "providerInjection": {
                "agentType": "demo_agent",
                "slots": ["a", "b"]
            },
            "capabilityStores": {
                "mcp": "mcp-file",
                "skills": {
                    "searchPaths": ["skills-global", "skills-cache"],
                    "projectSearchPaths": ["skills-project"],
                    "shared": ["skills-global"],
                    "store": "skills-global"
                },
                "skillStatus": ["status-flags"]
            },
            "interruptKey": " C-c "
        }));
        let profile = profile_from_asset("demo", &asset).unwrap();
        assert_eq!(profile.name, "Demo");
        assert_eq!(profile.icon.as_deref(), Some("demo"));
        assert_eq!(profile.description.as_deref(), Some("demo agent"));
        assert_eq!(profile.project_type.as_deref(), Some("demo_agent"));
        assert_eq!(profile.interrupt_key.as_deref(), Some("C-c"));

        let injection = profile.provider_injection.unwrap();
        assert_eq!(injection.agent_type, "demo_agent");
        assert_eq!(injection.slots.unwrap(), ["a", "b"]);

        let stores = profile.capability_stores.unwrap();
        let mcp = stores.mcp.unwrap();
        assert_eq!(mcp.path, "~/.demo/mcp.json");
        assert_eq!(mcp.format, "demo-mcp-v1");
        let skills = stores.skills.unwrap();
        assert_eq!(
            skills.search_paths,
            ["~/.demo/skills", "recursive:~/.demo/cache"]
        );
        assert_eq!(skills.project_search_paths, [".demo/skills"]);
        assert_eq!(skills.shared, ["~/.demo/skills"]);
        assert_eq!(skills.store, "~/.demo/skills");
        let status = stores.skill_status.unwrap();
        assert_eq!(status.sources.len(), 1);
        assert_eq!(status.sources[0].path, "~/.demo/settings.json");
        assert_eq!(status.sources[0].kind, SkillStatusSourceKind::EnabledFlags);
    }

    #[test]
    fn plain_tool_without_extension_is_not_an_agent() {
        let raw = json!({
            "protocol": TOOL_ASSET_PROTOCOL,
            "id": "jq",
            "identity": { "name": "jq" }
        });
        assert!(profile_from_asset("jq", &ToolAsset::from_value(raw)).is_none());
    }

    #[test]
    fn broken_references_drop_only_their_declaration() {
        let asset = agent_asset(json!({
            "projectType": "demo_agent",
            "capabilityStores": {
                "mcp": "ghost-resource",
                "skills": { "searchPaths": ["skills-global", "ghost-resource"] }
            }
        }));
        let profile = profile_from_asset("demo", &asset).unwrap();
        // mcp 引用不存在 → 无 mcp 声明；skills 只剩可解析条目。
        let stores = profile.capability_stores.unwrap();
        assert!(stores.mcp.is_none());
        assert_eq!(stores.skills.unwrap().search_paths, ["~/.demo/skills"]);
        // 未声明打断键：投影为空，由消费方取缺省 Escape。
        assert!(profile.interrupt_key.is_none());
    }

    #[test]
    fn unknown_protocol_does_not_project() {
        let raw = json!({ "protocol": "berth.tool/9", "id": "x", "identity": { "name": "X" } });
        assert!(profile_from_asset("x", &ToolAsset::from_value(raw)).is_none());
    }

    /// 阶段 A 金标准的等价断言：候选 tool.json 的投影必须与脱敏 fixture
    /// agent.json 的解析**逐字段相等**（含 sanitize 后）。
    #[test]
    fn stage_a_candidate_projection_matches_agent_json_fixture() {
        let base =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/tool/fixtures/stage-a");
        for id in ["claude", "codex"] {
            let agent_bytes = std::fs::read(base.join(format!("{id}.agent.json")))
                .unwrap_or_else(|error| panic!("fixture agent.json 必须存在: {error}"));
            // E3 已退役 expertDeployment 投影：等价比较按现行字段集进行，
            // 旧 fixture 中的该字段在解析前剥除。
            let mut fixture: serde_json::Value = serde_json::from_slice(&agent_bytes)
                .unwrap_or_else(|error| panic!("fixture agent.json 必须可解析: {error}"));
            fixture.as_object_mut().unwrap().remove("expertDeployment");
            // 启动只认 launch.js 后，命令名与固定参数不再投影（actions 退役）。
            fixture.as_object_mut().unwrap().remove("command");
            fixture.as_object_mut().unwrap().remove("baseArgs");
            // 官方登录已改由 `logins` 声明（model_provider::login），旧字段同样剥除。
            if let Some(injection) = fixture
                .get_mut("providerInjection")
                .and_then(serde_json::Value::as_object_mut)
            {
                injection.remove("official");
            }
            let old: AgentProfile = serde_json::from_value(fixture).expect("fixture 可转换");
            let old = super::super::profile::sanitize_profile(old, id);

            let tool_bytes = std::fs::read(base.join(format!("{id}.tool.json")))
                .unwrap_or_else(|error| panic!("候选 tool.json 必须存在: {error}"));
            let asset =
                ToolAsset::from_value(serde_json::from_slice(&tool_bytes).expect("候选可解析"));
            let projected = profile_from_asset(id, &asset)
                .unwrap_or_else(|| panic!("{id} 候选必须能投影为 agent"));

            assert_eq!(projected, old, "{id}: tool.json 投影与 agent.json 不等价");
        }
    }
}
