//! Tool Asset Protocol 1 (`berth.tool/1`) 的开放投影。
//!
//! 原文 JSON 是事实源：本模块只从 `serde_json::Value` 投影出各消费方需要的
//! 视图，并给出身份 / 协议诊断；未知字段全部保留在原文中。接入点的形状由
//! 各消费模块解析（`docs/contribution-points.md`）。
//!
//! 边界：不产生写文件、进程或网络副作用。

use serde_json::Value;

/// 一次投影诊断：`location` 是块内定位（如 `identity.name`），`message` 是人类可读原因。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssetDiagnostic {
    pub location: String,
    pub message: String,
}

/// 协议标识。不认识 protocol 时资产仍可展示，只记诊断。
pub const TOOL_ASSET_PROTOCOL: &str = "berth.tool/1";

/// 一份 tool.json 的开放投影。持有原文，访问器按需切视图。
#[derive(Debug, Clone)]
pub struct ToolAsset {
    raw: Value,
    /// 装载来源的目录名（repository 路径才有）。V2 硬化④：目录名是
    /// 注册表主键，`id` 与它不一致意味着「请求 A 拿到 B」——记诊断。直接构造（测试/桌面投影）无目录上下文，
    /// 不施加该检查。
    directory_id: Option<String>,
}

impl ToolAsset {
    /// 从已解析的原文构建投影。不校验、不拒绝任何内容——坏块通过
    /// 访问器的诊断暴露，不整包拒载（protocol §10）。
    pub fn from_value(raw: Value) -> Self {
        Self {
            raw,
            directory_id: None,
        }
    }

    /// repository 装载入口专用：绑定目录主键做身份一致性检查
    /// （V2 硬化④）。检查失败只记诊断，原文仍完整可见。
    pub fn from_value_with_directory(raw: Value, directory_id: &str) -> Self {
        Self {
            raw,
            directory_id: Some(directory_id.to_string()),
        }
    }

    /// 资产身份诊断（V2 硬化④）：id 缺失/与目录名不符、identity.name
    /// 缺失/为空 → 诊断。评审要求限定在**加载时**：无目录上下文
    /// （直接构造）不做任何身份检查，合成投影行为不变。
    pub fn identity_problems(&self) -> Vec<AssetDiagnostic> {
        let mut problems = Vec::new();
        let Some(dir) = &self.directory_id else {
            return problems;
        };
        match self.id() {
            None => problems.push(AssetDiagnostic {
                location: "id".into(),
                message: "id 缺失；无法与目录主键对账".into(),
            }),
            Some(id) => {
                if id != dir {
                    problems.push(AssetDiagnostic {
                        location: "id".into(),
                        message: format!(
                            "声明 id {id:?} 不等于目录名 {dir:?}；拒绝按目录加载错误资产"
                        ),
                    });
                }
            }
        }
        if self
            .identity_name()
            .is_none_or(|name| name.trim().is_empty())
        {
            problems.push(AssetDiagnostic {
                location: "identity.name".into(),
                message: "identity.name 缺失或为空".into(),
            });
        }
        problems
    }

    /// 原文引用（未知字段保留的事实源）。
    pub fn raw(&self) -> &Value {
        &self.raw
    }

    pub fn protocol(&self) -> Option<&str> {
        self.raw.get("protocol").and_then(Value::as_str)
    }

    pub fn id(&self) -> Option<&str> {
        self.raw.get("id").and_then(Value::as_str)
    }

    pub fn identity_name(&self) -> Option<&str> {
        self.raw
            .get("identity")
            .and_then(|identity| identity.get("name"))
            .and_then(Value::as_str)
    }

    /// `extensions["org.berth.agent"]` 业务投影（原样 Value，形状归各
    /// 业务模块解析）。无扩展是有效的普通工具，返回 `None`。
    pub fn agent_extension(&self) -> Option<&Value> {
        self.raw
            .get("extensions")
            .and_then(|extensions| extensions.get("org.berth.agent"))
            .filter(|value| value.is_object())
    }

    /// 顶层结构诊断：protocol 缺失/不认识、身份校验
    /// （V2 硬化④）。只描述、不阻断投影。
    pub fn diagnostics(&self) -> Vec<AssetDiagnostic> {
        let mut diagnostics = self.identity_problems();
        match self.protocol() {
            None => diagnostics.push(AssetDiagnostic {
                location: "protocol".into(),
                message: "protocol 字段缺失；资产仅可展示".into(),
            }),
            Some(protocol) if protocol != TOOL_ASSET_PROTOCOL => {
                diagnostics.push(AssetDiagnostic {
                    location: "protocol".into(),
                    message: format!("未知 protocol {protocol}；按原文展示"),
                })
            }
            _ => {}
        }
        diagnostics
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn minimal_document_projects_with_protocol_diagnostic_only() {
        let asset = ToolAsset::from_value(json!({
            "protocol": TOOL_ASSET_PROTOCOL,
            "id": "minimal",
            "identity": { "name": "Minimal" },
            "futureInformation": { "preserved": ["unknown", false, 0] }
        }));
        assert_eq!(asset.protocol(), Some(TOOL_ASSET_PROTOCOL));
        assert_eq!(asset.id(), Some("minimal"));
        assert_eq!(asset.identity_name(), Some("Minimal"));
        assert!(asset.agent_extension().is_none());
        assert!(asset.diagnostics().is_empty());
        // 未知字段在原文中完整保留。
        assert_eq!(
            asset.raw().get("futureInformation"),
            Some(&json!({ "preserved": ["unknown", false, 0] }))
        );
    }

    #[test]
    fn unknown_protocol_is_displayable_but_flagged() {
        let asset = ToolAsset::from_value(json!({
            "protocol": "berth.tool/2",
            "id": "future",
            "identity": { "name": "Future" },
            "knowledge": { "usage": { "title": "Usage", "kind": "usage", "text": "说明" } }
        }));
        assert_eq!(asset.diagnostics().len(), 1);
        assert!(asset.diagnostics()[0].message.contains("berth.tool/2"));
        // 知识仍然可见（发现与执行分离）。
        assert!(asset.raw().get("knowledge").is_some());
    }

    #[test]
    fn agent_extension_projects_raw_value() {
        let asset = ToolAsset::from_value(json!({
            "protocol": TOOL_ASSET_PROTOCOL,
            "id": "claude",
            "identity": { "name": "Claude Code" },
            "extensions": {
                "org.berth.agent": {
                    "projectType": "claude_code",
                    "providerInjection": { "agentType": "claude_code", "env": { "A": "$api_key" } }
                }
            }
        }));
        let extension = asset.agent_extension().unwrap();
        assert_eq!(
            extension
                .get("providerInjection")
                .and_then(|v| v.get("agentType")),
            Some(&json!("claude_code"))
        );
    }
}
