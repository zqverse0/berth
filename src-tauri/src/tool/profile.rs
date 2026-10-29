//! Agent 身份投影：`tools/<id>/tool.json` 的 `org.berth.agent` 扩展。
//!
//! `load_agent_profile` / `list_agent_profiles` 经 `agent_projection` 把
//! tool.json 投影为 `AgentProfile`（与旧 agent.json 时代同型），供启动栏
//! 列表、capability_status、专家包落点、provider 注入
//! 声明消费。目录名 = 工具 id，是资产目录协议的主键。
//! 旧 agent.json 读取已随硬切退役（docs/REMOVED.md）。

use std::path::{Component, Path};

use serde::{Deserialize, Serialize};

use crate::app_error::AppCommandError;
use crate::tool::path::is_valid_manifest_id;

// ─── 模型 ─────────────────────────────────────────────────────────────

/// 模型服务商声明（档案栏与模型档位）；投影与启动档案在 `berth-tool-core`，GUI 与 CLI 共用。
pub use berth_tool_core::provider_injection::ProviderInjection;

/// `tools/<id>/tool.json` Agent extension 的强类型投影。未知字段忽略。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentProfile {
    /// 显示名（如 "Claude Code"）。
    pub name: String,
    /// 图标标识（沿用 contract 的 icon 值，如 "claude"）。
    #[serde(default)]
    pub icon: Option<String>,
    /// 简述。
    #[serde(default)]
    pub description: Option<String>,
    /// 对应的 AgentType（如 "claude_code"）；启动栏选中态映射用。
    #[serde(default)]
    pub project_type: Option<String>,
    /// 模型服务商注入声明（无则该 agent 不参与 provider 选择/注入）。
    #[serde(default)]
    pub provider_injection: Option<ProviderInjection>,
    /// 能力落点声明（MCP 配置 / skills 目录 / 状态索引）。无则该
    /// agent 的能力状态页显示「未声明」空态——Berth 不猜路径。
    #[serde(default)]
    pub capability_stores: Option<CapabilityStores>,
    /// `org.berth.agent.interruptKey`：打断该 Agent 当前一轮的按键名（tmux send-keys 写法）。
    /// 未声明时由消费方取缺省 `Escape`。
    #[serde(default)]
    pub interrupt_key: Option<String>,
}

/// tool.json Agent extension 声明的能力落点：Berth 读取真实状态的唯一依据。所有
/// per-CLI 差异压缩在这份声明里，代码零硬编码（新接 CLI 只写声明）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityStores {
    /// MCP server 配置文件（如 `~/.claude.json` 的 `mcpServers`）。
    #[serde(default)]
    pub mcp: Option<McpStoreDeclaration>,
    /// skills 目录组。
    #[serde(default)]
    pub skills: Option<SkillStoreDeclaration>,
    /// skills 状态索引（启停/安装来源/使用统计）。CLI 没有索引机制
    /// （如 codex）就不声明——该 agent 只显示目录视角。
    #[serde(default)]
    pub skill_status: Option<SkillStatusDeclaration>,
}

/// MCP 配置文件声明。`format` 决定解析器；未识别 format 上报诊断。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpStoreDeclaration {
    /// 配置文件绝对路径（`~` 前缀展开为用户 home）。
    pub path: String,
    /// 解析格式标识（如 "claude-mcp-v1" / "codex-mcp-v1"）。
    pub format: String,
}

/// skills 目录组声明。判定顺序：BrokenLink → StoreLink/Shared/Project/
/// Foreign（详见 `tool::capability_status`）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillStoreDeclaration {
    /// 该 agent 私有的全局 skill 目录（绝对路径或 `~` 前缀）。
    #[serde(default)]
    pub search_paths: Vec<String>,
    /// 相对项目根的 skill 目录（如 `.claude/skills`）。
    #[serde(default)]
    pub project_search_paths: Vec<String>,
    /// 多 agent 共用目录（如 `~/.agents/skills`）；展示时标 shared，
    /// 将来写操作需提示影响面。
    #[serde(default)]
    pub shared: Vec<String>,
    /// 唯一安装仓库（软链源头，通常 `~/.berth/skills`）。
    #[serde(default = "default_skill_store")]
    pub store: String,
    /// 目录内结构声明：
    /// - `flat`（默认）：直接子项即 skill（`~/.claude/skills/<name>`）。
    /// - `recursive`：深搜所有含 `SKILL.md` 的目录（插件 cache 类：
    ///   `<root>/<marketplace>/<plugin>/<version>/skills/<name>`，最深
    ///   32 层，与 CLI 的搜索深度一致）。
    #[serde(default)]
    pub layout: Option<SkillStoreLayout>,
}

/// skills 目录布局（见 `SkillStoreDeclaration.layout`）。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum SkillStoreLayout {
    /// 直接子项即 skill。
    #[default]
    Flat,
    /// 递归深搜含 SKILL.md 的目录（命中即停，不再下钻）。
    Recursive,
}

/// skills 状态索引声明：CLI 私有索引文件清单，`kind` 决定通用 reader。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillStatusDeclaration {
    pub sources: Vec<SkillStatusSource>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillStatusSource {
    /// 索引文件绝对路径（`~` 前缀展开）。
    pub path: String,
    /// reader 类型：enabled-flags / install-registry / usage-stats。
    pub kind: SkillStatusSourceKind,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SkillStatusSourceKind {
    /// 启停开关表（如 `~/.claude/settings.json` 的 `enabledPlugins`）。
    EnabledFlags,
    /// 安装注册表（如 `installed_plugins.json`：来源/版本/时间）。
    InstallRegistry,
    /// 使用统计（如 `~/.claude.json` 的 `skillUsage`）。
    UsageStats,
}

fn default_skill_store() -> String {
    "~/.berth/skills".into()
}

// ─── 扫描 ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProfileSummary {
    /// 目录名（= 命令名，主键）。
    pub id: String,
    pub name: String,
    pub icon: Option<String>,
    pub description: Option<String>,
    pub project_type: Option<String>,
    /// providerInjection.agent_type 的投影(启动栏模型下拉过滤用,
    /// 直接对应档案栏);`None` 表示该 agent 不参与 provider 选择。
    pub provider_agent_type: Option<String>,
    /// providerInjection.slots 的投影(设置页模型条目的 slot 选项)。
    pub provider_slots: Option<Vec<String>>,
    /// providerInjection.apis 的投影(启动栏只列该 CLI 会说其接口的模型)。
    pub provider_apis: Option<Vec<String>>,
    /// 能力落点声明投影；`None` 表示能力状态页显示「未声明」空态。
    pub capability_stores: Option<CapabilityStores>,
    /// `org.berth.agent.interruptKey` 投影；`None` 表示使用缺省 `Escape`。
    pub interrupt_key: Option<String>,
}

/// 列出启用的 agent 身份工具目录（tool.json 经 agent_projection 投影）。
/// 坏文件跳过——身份展示层不因坏文件崩溃。
pub fn list_agent_profiles() -> Vec<AgentProfileSummary> {
    let mut profiles = Vec::new();
    for id in crate::tool::asset_repository::list_tool_asset_ids() {
        let id = id.as_str();
        let profile = crate::tool::asset_repository::load_tool_asset(id)
            .ok()
            .flatten()
            .and_then(|asset| crate::tool::agent_projection::profile_from_asset(id, &asset));
        if let Some(profile) = profile {
            profiles.push(AgentProfileSummary {
                id: id.to_string(),
                name: profile.name,
                icon: profile.icon,
                description: profile.description,
                project_type: profile.project_type,
                provider_agent_type: profile
                    .provider_injection
                    .as_ref()
                    .map(|injection| injection.agent_type.clone()),
                provider_slots: profile
                    .provider_injection
                    .as_ref()
                    .and_then(|injection| injection.slots.clone()),
                provider_apis: profile
                    .provider_injection
                    .as_ref()
                    .and_then(|injection| injection.apis.clone()),
                capability_stores: profile.capability_stores,
                interrupt_key: profile.interrupt_key,
            });
        }
    }
    profiles.sort_by_key(|p| p.name.to_lowercase());
    profiles
}

/// 读单个 agent 的完整 profile（tool.json `org.berth.agent` 投影）。
/// 无 tool.json 或无 Agent extension 返回 `None`；坏 JSON 按缺失降级，
/// 不让坏文件拖垮身份展示层。
pub fn load_agent_profile(command: &str) -> Result<Option<AgentProfile>, AppCommandError> {
    if !is_valid_manifest_id(command) {
        return Err(AppCommandError::invalid_input(
            "agent directory must match [a-z0-9][a-z0-9._-]* (max 128 chars)",
        ));
    }
    // 坏 JSON/超大文件按缺失降级，不让坏文件拖垮身份展示层与启动链。
    let Some(asset) = crate::tool::asset_repository::load_tool_asset(command)
        .ok()
        .flatten()
    else {
        return Ok(None);
    };
    Ok(crate::tool::agent_projection::profile_from_asset(
        command, &asset,
    ))
}

/// Tool Asset 投影共用的防守与归一：能力落点 sanitize，name 空值回落目录名。
pub(super) fn sanitize_profile(mut profile: AgentProfile, id: &str) -> AgentProfile {
    if let Some(stores) = profile.capability_stores.take() {
        profile.capability_stores = sanitize_capability_stores(stores);
    }
    profile.name = if profile.name.trim().is_empty() {
        id.to_string()
    } else {
        profile.name
    };
    profile
}

/// 能力落点声明防守：全局路径必须绝对或 `~` 前缀，项目路径必须安全
/// 相对——声明本身不能成为路径穿越源。非法条目剔除而非整体作废
///（一个坏声明不应让整个能力页失明）。
fn sanitize_capability_stores(stores: CapabilityStores) -> Option<CapabilityStores> {
    let mcp = stores
        .mcp
        .and_then(|declaration| is_declared_global_path(&declaration.path).then_some(declaration));
    let skills = stores.skills.map(|mut declaration| {
        declaration
            .search_paths
            .retain(|p| is_declared_global_path(p));
        declaration
            .project_search_paths
            .retain(|p| is_safe_relative_dir(p));
        declaration.shared.retain(|p| is_declared_global_path(p));
        if !is_declared_global_path(&declaration.store) {
            declaration.store = default_skill_store();
        }
        declaration
    });
    let skill_status = stores.skill_status.map(|mut declaration| {
        declaration
            .sources
            .retain(|source| is_declared_global_path(&source.path));
        declaration
    });
    let sanitized = CapabilityStores {
        mcp,
        skills,
        skill_status,
    };
    let empty = CapabilityStores {
        mcp: None,
        skills: None,
        skill_status: None,
    };
    (sanitized != empty).then_some(sanitized)
}

/// 声明里的全局路径只允许 `~` 前缀或绝对路径，且不含 `..` 段。
/// 允许布局前缀（`recursive:` / `flat:`）——先剥离再校验。
pub(super) fn is_declared_global_path(value: &str) -> bool {
    let trimmed = value.trim();
    let trimmed = trimmed
        .strip_prefix("recursive:")
        .or_else(|| trimmed.strip_prefix("flat:"))
        .unwrap_or(trimmed);
    if trimmed.is_empty() {
        return false;
    }
    if trimmed == "~" {
        return true;
    }
    let rest = if let Some(tail) = trimmed.strip_prefix("~/") {
        tail
    } else if trimmed.starts_with('/') {
        trimmed
    } else {
        return false;
    };
    !Path::new(rest)
        .components()
        .any(|c| matches!(c, Component::ParentDir))
}

fn is_safe_relative_dir(value: &str) -> bool {
    if value.is_empty() {
        return true;
    }
    let path = Path::new(value);
    !path.is_absolute()
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

// ─── 启动解析 ─────────────────────────────────────────────────────────

/// 把调用方额外 argv 接到启动参数末尾（原 contract 通用逻辑，搬入
/// tool 后由 agent 启动链复用）。
pub fn append_extra_args(
    args: &mut Vec<String>,
    extra_args: &[String],
) -> Result<(), AppCommandError> {
    if extra_args.iter().any(|arg| arg.contains('\0')) {
        return Err(AppCommandError::invalid_input(
            "Temporary agent arguments must not contain NUL characters",
        ));
    }
    args.extend(extra_args.iter().cloned());
    Ok(())
}

// ─── Tests ────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tool::asset::TOOL_ASSET_PROTOCOL;
    use crate::tool::path::TEST_ENV_LOCK;
    use std::path::PathBuf;

    /// 同 repository 测试模式：锁覆盖整个测试体。
    fn with_temp_berth_home(test: impl FnOnce(PathBuf)) {
        let lock = TEST_ENV_LOCK.get_or_init(|| std::sync::Mutex::new(()));
        let _guard = lock.lock().unwrap();
        let previous = std::env::var_os("BERTH_HOME");
        let dir = std::env::temp_dir().join(format!("tool-profile-test-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("tools")).unwrap();
        std::env::set_var("BERTH_HOME", &dir);
        test(dir.clone());
        match previous {
            Some(value) => std::env::set_var("BERTH_HOME", value),
            None => std::env::remove_var("BERTH_HOME"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 写一份最小 agent tool.json：launch action（program/argv）+
    /// `org.berth.agent` 扩展原样嵌入。
    fn write_tool(home: &std::path::Path, dir: &str, extension: &str) {
        let target = home.join("tools").join(dir);
        std::fs::create_dir_all(&target).unwrap();
        let body = format!(
            r#"{{
                "protocol": "{TOOL_ASSET_PROTOCOL}",
                "id": "{dir}",
                "identity": {{ "name": "{dir}" }},
                "extensions": {{ "org.berth.agent": {extension} }}
            }}"#
        );
        std::fs::write(target.join("tool.json"), body).unwrap();
    }

    #[test]
    fn list_and_load_round_trip() {
        with_temp_berth_home(|home| {
            write_tool(&home, "claude", r#"{ "projectType": "claude_code" }"#);
            write_tool(&home, "codex", r#"{ "projectType": "codex" }"#);
            // 无 tool.json 的目录被忽略；无 agent 扩展的不是 agent。
            std::fs::create_dir_all(home.join("tools/plain")).unwrap();
            let plain = home.join("tools/plain/tool.json");
            std::fs::write(
                &plain,
                format!(r#"{{ "protocol": "{TOOL_ASSET_PROTOCOL}", "id": "plain", "identity": {{ "name": "P" }} }}"#),
            )
            .unwrap();

            let profiles = list_agent_profiles();
            assert_eq!(profiles.len(), 2, "只有带 agent 扩展的 tool.json 入列");
            let claude = profiles.iter().find(|p| p.id == "claude").unwrap();
            assert_eq!(claude.name, "claude");
            assert_eq!(claude.project_type.as_deref(), Some("claude_code"));

            let codex = load_agent_profile("codex").unwrap().unwrap();
            assert_eq!(codex.project_type.as_deref(), Some("codex"));
        });
    }

    #[test]
    fn missing_file_is_none_not_error() {
        with_temp_berth_home(|home| {
            std::fs::create_dir_all(home.join("tools/claude")).unwrap();
            assert!(load_agent_profile("claude").unwrap().is_none());
        });
    }

    #[test]
    fn bad_file_degrades_to_none() {
        with_temp_berth_home(|home| {
            let target = home.join("tools/broken");
            std::fs::create_dir_all(&target).unwrap();
            std::fs::write(target.join("tool.json"), b"not json").unwrap();
            // 坏 JSON 按缺失降级（宽容语义，与旧 agent.json 读取一致）。
            assert!(load_agent_profile("broken").unwrap().is_none());
            let profiles = list_agent_profiles();
            assert!(profiles.iter().all(|p| p.id != "broken"));
        });
    }

    #[test]
    fn invalid_directory_name_is_rejected() {
        assert!(load_agent_profile("Bad").is_err());
        assert!(load_agent_profile("../escape").is_err());
    }

    #[test]
    fn provider_injection_round_trips_into_summary() {
        with_temp_berth_home(|home| {
            write_tool(
                &home,
                "claude",
                r#"{ "projectType": "claude_code", "providerInjection": {
                    "agentType": "claude_code", "slots": ["opus"] } }"#,
            );
            let profiles = list_agent_profiles();
            let claude = profiles.iter().find(|p| p.id == "claude").unwrap();
            assert_eq!(claude.provider_agent_type.as_deref(), Some("claude_code"));
            let loaded = load_agent_profile("claude").unwrap().unwrap();
            let injection = loaded.provider_injection.unwrap();
            assert_eq!(injection.slots.unwrap(), ["opus"]);
        });
    }

    #[test]
    fn unknown_extension_fields_are_ignored_not_fatal() {
        with_temp_berth_home(|home| {
            // protocol §10：未知字段保留原文、不拒载（旧 agent.json 的
            // deny_unknown_fields 整文件丢弃语义已随硬切退役）。
            write_tool(
                &home,
                "future",
                r#"{ "projectType": "codex", "futureField": { "a": 1 } }"#,
            );
            let loaded = load_agent_profile("future").unwrap().unwrap();
            assert_eq!(loaded.project_type.as_deref(), Some("codex"));
        });
    }
}
