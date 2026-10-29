//! 清单骨架（docs/plugin-architecture.md §2.1）：`id` / `version` / `engines` / `requires` /
//! `permissions` / `contributes`，与旧写法（`revision` + `extensions["org.berth.<点>"]`）并存。
//!
//! 只在加载时归一一次（[`normalize`]）：新写法折成现有投影读的形状，下游不分两种写法。
//! 兼容性只看 `engines.berth`（[`incompatibility`]）；`requires` 由脚本宿主在运行前核对。

use serde_json::{Map, Value};

/// 本 Berth 的版本（workspace 版本即应用版本）。
pub const BERTH_VERSION: &str = env!("CARGO_PKG_VERSION");

/// `contributes.<点>` → `extensions["org.berth.<点>"]`、`contributes.identity` → `identity`、
/// `version` → `revision`（展示用）。两种写法都有时旧键优先，不覆盖用户已有的声明。
pub fn normalize(raw: &mut Value) {
    let Some(root) = raw.as_object_mut() else {
        return;
    };
    if let Some(version) = root.get("version").filter(|value| value.is_string()).cloned() {
        root.entry("revision").or_insert(version);
    }
    let Some(contributes) = root.get("contributes").and_then(Value::as_object).cloned() else {
        return;
    };
    for (point, declaration) in contributes {
        if point == "identity" {
            root.entry("identity").or_insert(declaration);
            continue;
        }
        let extensions = root
            .entry("extensions")
            .or_insert_with(|| Value::Object(Map::new()));
        if let Some(extensions) = extensions.as_object_mut() {
            extensions
                .entry(format!("org.berth.{point}"))
                .or_insert(declaration);
        }
    }
}

/// 插件声明的 `engines.berth` 本 Berth 不满足时的原因；没声明即兼容。
pub fn incompatibility(raw: &Value) -> Option<String> {
    let range = raw.pointer("/engines/berth")?;
    let Some(text) = range.as_str() else {
        return Some("engines.berth must be a version range string like \">=0.37\"".into());
    };
    let Ok(requirement) = semver::VersionReq::parse(text) else {
        return Some(format!("engines.berth {text:?} is not a valid version range"));
    };
    let current = semver::Version::parse(BERTH_VERSION).expect("workspace version is semver");
    (!requirement.matches(&current))
        .then(|| format!("requires Berth {text}, this is {BERTH_VERSION}; update Berth"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn contributes_folds_into_the_legacy_shape_without_overriding_it() {
        let mut raw = json!({
            "id": "x", "version": "1.2.0",
            "contributes": {
                "identity": {"name": "X"},
                "agent": {"projectType": "x"},
                "install": {"bin": "x"}
            },
            "extensions": {"org.berth.install": {"bin": "old"}}
        });
        normalize(&mut raw);
        assert_eq!(raw["revision"], "1.2.0");
        assert_eq!(raw["identity"]["name"], "X");
        assert_eq!(raw["extensions"]["org.berth.agent"]["projectType"], "x");
        assert_eq!(raw["extensions"]["org.berth.install"]["bin"], "old");
    }

    #[test]
    fn engines_berth_gates_compatibility() {
        assert_eq!(incompatibility(&json!({})), None);
        assert_eq!(incompatibility(&json!({"engines": {"berth": ">=0.1"}})), None);
        let newer = incompatibility(&json!({"engines": {"berth": ">=99.0"}})).unwrap();
        assert!(newer.contains(">=99.0") && newer.contains(BERTH_VERSION));
        assert!(incompatibility(&json!({"engines": {"berth": "soon"}})).is_some());
        assert!(incompatibility(&json!({"engines": {"berth": 1}})).is_some());
    }
}
