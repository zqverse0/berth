//! 插件包边界：`tools/<id>/` 内只允许约定文件与 tool.json 声明的
//! `base: package` 资源，其余文件不是插件内容（10-03 plugin-package S1）。
//!
//! 只读检查，不删不改；结果复用 `AssetDiagnostic`，`location` 是相对
//! tools 根或包根的路径。

use std::path::{Component, Path};

use serde_json::Value;

use crate::asset::AssetDiagnostic;

/// 宿主按文件名读取的约定文件（封闭列表）。`launch.js` 是 Agent 启动脚本
/// （[`crate::paths::LAUNCH_SCRIPT`]）；`private/` 是启动脚本的私有辅助；`README.md` / `LICENSE` /
/// `.gitignore` 是分发包（git 安装）的常规文件；`install.sh|ps1` 是 `org.berth.install`
/// 的安装脚本。
pub const CONVENTION_ENTRIES: &[&str] = &[
    "tool.json",
    "launch.js",
    "launchbar.json",
    "install.sh",
    "install.ps1",
    "usage.json",
    "usage.md",
    "icon.svg",
    "icon.png",
    "private",
    "README.md",
    "LICENSE",
    ".gitignore",
];

/// `extensions["org.berth.agent"]` 里宿主会读的键（封闭列表，与
/// `docs/contribution-points.md` 同步）：键 → 接入点名。
pub const AGENT_KEYS: &[(&str, &str)] = &[
    ("projectType", "agent"),
    ("sessions", "agent.sessions"),
    ("usage", "agent.usage"),
    ("providerInjection", "agent.providerInjection"),
    ("logins", "agent.logins"),
    ("capabilityStores", "agent.capabilityStores"),
    ("promptInput", "agent.promptInput"),
    ("interruptKey", "agent.interruptKey"),
];

/// 宿主认识的 `extensions` 命名空间。
const KNOWN_EXTENSIONS: &[&str] = &[
    "org.berth.agent",
    crate::file_tools::PREVIEW,
    crate::file_tools::EXTRACT,
    crate::file_tools::INSTALL,
    crate::views::VIEW,
];

/// 文件工具接入点：与宿主同一个判定（`file_tools::parse`：非空 `argv` + `install.bin`）。
const FILE_TOOL_POINTS: [(&str, &str); 2] = [
    (crate::file_tools::PREVIEW, "preview"),
    (crate::file_tools::EXTRACT, "extract"),
];

/// 插件接入了宿主的哪些位置（只读推导；文件工具按宿主的解析规则判定）。
pub fn contributions(dir: &Path, raw: &Value) -> Vec<String> {
    let mut points = Vec::new();
    let has_launch = dir.join(crate::paths::LAUNCH_SCRIPT).is_file();
    if has_launch && dir.join("launchbar.json").is_file() {
        points.push("launchbar".to_string());
    }
    if let Some(agent) = raw
        .pointer("/extensions/org.berth.agent")
        .and_then(Value::as_object)
    {
        points.extend(
            AGENT_KEYS
                .iter()
                .filter(|(key, _)| agent.contains_key(*key))
                .map(|(_, point)| point.to_string()),
        );
    }
    for (namespace, point) in FILE_TOOL_POINTS {
        if crate::file_tools::parse("", dir, raw, namespace).is_some() {
            points.push(point.to_string());
        }
    }
    if raw.pointer("/extensions/org.berth.install").is_some() {
        points.push("install".to_string());
    }
    if dir.join("usage.md").is_file() {
        points.push("guide".to_string());
    }
    if !crate::views::parse(raw).0.is_empty() {
        points.push("view".to_string());
    }
    points
}

/// 已退役、宿主不再读的顶层键（2026-10-03：Agent 直接调用程序本身，启动只认 launch.js）。
const RETIRED_KEYS: &[&str] = &["actions", "examples"];

/// 声称接入、但宿主不认识的声明：退役的顶层键、未知 extensions 命名空间与 agent 键。
fn unknown_contributions(raw: &Value) -> Vec<AssetDiagnostic> {
    let mut findings: Vec<AssetDiagnostic> = RETIRED_KEYS
        .iter()
        .filter(|key| raw.get(**key).is_some())
        .map(|key| AssetDiagnostic {
            location: format!("tool.json#/{key}"),
            message: "retired: Berth no longer runs actions; call the program directly, launch agents via launch.js".into(),
        })
        .collect();
    let Some(extensions) = raw.get("extensions").and_then(Value::as_object) else {
        return findings;
    };
    findings.extend(
        extensions
            .keys()
            .filter(|name| !KNOWN_EXTENSIONS.contains(&name.as_str()))
            .map(|name| AssetDiagnostic {
                location: format!("tool.json#/extensions/{name}"),
                message: "unknown extension namespace: Berth does not read it".into(),
            }),
    );
    if let Some(agent) = extensions.get("org.berth.agent").and_then(Value::as_object) {
        findings.extend(
            agent
                .keys()
                .filter(|key| !AGENT_KEYS.iter().any(|(known, _)| known == key))
                .map(|key| AssetDiagnostic {
                    location: format!("tool.json#/extensions/org.berth.agent/{key}"),
                    message: "not a contribution point: Berth does not read this key".into(),
                }),
        );
    }
    findings
}

/// tool.json `resources.*.locator` 中 `base: package` 的路径，加上预览脚本
/// （`org.berth.preview.script`）与视图的脚本、图标。
fn declared_package_paths(raw: &Value) -> Vec<&str> {
    raw.get("resources")
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|resources| resources.values())
        .filter_map(|resource| resource.get("locator"))
        .filter(|locator| locator.get("base").and_then(Value::as_str) == Some("package"))
        .filter_map(|locator| locator.get("path").and_then(Value::as_str))
        .chain(
            raw.pointer("/extensions/org.berth.preview/script")
                .and_then(Value::as_str),
        )
        .chain(crate::views::package_paths(raw))
        .collect()
}

fn first_component(path: &str) -> Option<&str> {
    Path::new(path)
        .components()
        .find_map(|component| match component {
            Component::Normal(name) => name.to_str(),
            _ => None,
        })
}

/// 声明但缺失的 `base: package` 资源（安装的拒收条件）。
pub fn missing_package_resources(dir: &Path, raw: &Value) -> Vec<AssetDiagnostic> {
    declared_package_paths(raw)
        .iter()
        .filter(|path| !dir.join(path).exists())
        .map(|path| AssetDiagnostic {
            location: (*path).to_string(),
            message: "declared as a package resource in tool.json but missing".into(),
        })
        .collect()
}

/// 检查一个包目录：声明但缺失的资源、宿主不认识的接入声明、既非约定文件
/// 也未声明的顶层条目。
pub fn check_package(dir: &Path, raw: &Value) -> Vec<AssetDiagnostic> {
    let declared = declared_package_paths(raw);
    let mut findings = missing_package_resources(dir, raw);
    // 不兼容的插件不加载（运行入口见 `repository::list_tool_asset_ids`），这里报出原因。
    findings.extend(crate::manifest::incompatibility(raw).map(|message| AssetDiagnostic {
        location: "tool.json#/engines/berth".into(),
        message: format!("not loaded: {message}"),
    }));
    findings.extend(unknown_contributions(raw));
    findings.extend(crate::views::parse(raw).1);
    findings.extend(
        FILE_TOOL_POINTS
            .iter()
            .filter(|(namespace, _)| {
                raw.get("extensions")
                    .and_then(|ext| ext.get(namespace))
                    .is_some()
                    && crate::file_tools::parse("", dir, raw, namespace).is_none()
            })
            .map(|(namespace, _)| AssetDiagnostic {
                location: format!("tool.json#/extensions/{namespace}"),
                message: "declared but not used: needs a non-empty argv and org.berth.install.bin"
                    .into(),
            }),
    );
    findings.extend(FILE_TOOL_POINTS.iter().flat_map(|(namespace, _)| {
        crate::file_tools::parse("", dir, raw, namespace)
            .map(|tool| tool.extensions)
            .unwrap_or_default()
            .into_iter()
            .filter(|ext| !crate::file_tools::DOCUMENT_FORMATS.contains(&ext.as_str()))
            .map(move |ext| AssetDiagnostic {
                location: format!("tool.json#/extensions/{namespace}/extensions"),
                message: format!(
                    "`{ext}` is not a Berth document format ({}); the host never routes it to plugins",
                    crate::file_tools::DOCUMENT_FORMATS.join(", ")
                ),
            })
    }));
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| entry.file_name().to_str().map(str::to_string))
        .collect();
    names.sort();
    for name in names {
        let known = CONVENTION_ENTRIES.contains(&name.as_str())
            || declared
                .iter()
                .any(|path| first_component(path) == Some(name.as_str()));
        if !known {
            findings.push(AssetDiagnostic {
                location: name,
                message: "not part of the plugin: neither a convention file nor a package resource declared in tool.json".into(),
            });
        }
    }
    findings
}

/// 插件脚本用 `/// <reference path="../berth-plugin.d.ts" />` 引用的类型声明，可放在 tools 根。
const ROOT_TYPES_FILE: &str = "berth-plugin.d.ts";

/// 检查 tools 根：只应有带 tool.json 的包目录（与类型声明文件）。
pub fn check_root(root: &Path) -> Vec<AssetDiagnostic> {
    let mut findings = Vec::new();
    let Ok(entries) = std::fs::read_dir(root) else {
        return findings;
    };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        let path = entry.path();
        let message = if name == ROOT_TYPES_FILE && path.is_file() {
            continue;
        } else if !path.is_dir() {
            "stray file in tools root: plugins are directories with a tool.json"
        } else if !path.join("tool.json").is_file() {
            "directory has no tool.json, so it is not a plugin"
        } else {
            continue;
        };
        findings.push(AssetDiagnostic {
            location: name,
            message: message.into(),
        });
    }
    findings
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("berth-package-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn locations(findings: &[AssetDiagnostic]) -> Vec<&str> {
        findings
            .iter()
            .map(|finding| finding.location.as_str())
            .collect()
    }

    #[test]
    fn package_reports_unknown_entries_and_missing_resources() {
        let dir = temp_dir("pkg");
        for file in [
            "tool.json",
            "launch.js",
            "usage.md",
            "sessions.json",
            "research.md",
            "preview.js",
        ] {
            std::fs::write(dir.join(file), "").unwrap();
        }
        std::fs::create_dir_all(dir.join("private")).unwrap();
        std::fs::create_dir_all(dir.join("data")).unwrap();
        std::fs::write(dir.join("data/spec.json"), "").unwrap();
        let raw = json!({ "resources": {
            "sessions": { "locator": { "base": "package", "path": "sessions.json" } },
            "nested": { "locator": { "base": "package", "path": "./data/spec.json" } },
            "gone": { "locator": { "base": "package", "path": "usage.json" } },
            "home": { "locator": { "base": "home", "path": ".claude.json" } }
        }, "extensions": { "org.berth.preview": { "script": "preview.js" } } });
        let findings = check_package(&dir, &raw);
        assert_eq!(
            locations(&findings),
            [
                "usage.json",
                "tool.json#/extensions/org.berth.preview",
                "research.md"
            ]
        );
        std::fs::remove_file(dir.join("preview.js")).unwrap();
        assert_eq!(
            locations(&missing_package_resources(&dir, &raw)),
            ["usage.json", "preview.js"]
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn contributions_and_unknown_agent_keys() {
        let dir = temp_dir("contrib");
        for file in ["tool.json", "launch.js", "launchbar.json", "usage.md"] {
            std::fs::write(dir.join(file), "").unwrap();
        }
        let raw = json!({
            "actions": { "launch": {}, "get": {}, "set": {} },
            "extensions": {
                "org.berth.agent": { "projectType": "x", "sessions": "s", "expertRuntime": {} },
                "com.other": {}
            }
        });
        assert_eq!(
            contributions(&dir, &raw),
            ["launchbar", "agent", "agent.sessions", "guide"]
        );
        assert_eq!(
            locations(&check_package(&dir, &raw)),
            [
                "tool.json#/actions",
                "tool.json#/extensions/com.other",
                "tool.json#/extensions/org.berth.agent/expertRuntime"
            ]
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn file_tool_without_install_is_reported_not_contributed() {
        let dir = temp_dir("filetool");
        let mut raw = json!({ "extensions": {
            "org.berth.extract": { "extensions": ["docx"], "argv": ["{file}"] }
        } });
        assert!(contributions(&dir, &raw).is_empty());
        assert_eq!(
            locations(&check_package(&dir, &raw)),
            ["tool.json#/extensions/org.berth.extract"]
        );
        raw["extensions"]["org.berth.install"] = json!({ "bin": "pandoc" });
        assert_eq!(contributions(&dir, &raw), ["extract", "install"]);
        assert!(check_package(&dir, &raw).is_empty());
        raw["extensions"]["org.berth.extract"]["extensions"] = json!(["docx", "odt"]);
        assert_eq!(
            locations(&check_package(&dir, &raw)),
            ["tool.json#/extensions/org.berth.extract/extensions"]
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn root_reports_stray_files_and_directories_without_tool_json() {
        let dir = temp_dir("root");
        std::fs::create_dir_all(dir.join("ok")).unwrap();
        std::fs::write(dir.join("ok/tool.json"), "{}").unwrap();
        std::fs::create_dir_all(dir.join("empty")).unwrap();
        std::fs::write(dir.join("index.json"), "{}").unwrap();
        std::fs::write(dir.join("berth-plugin.d.ts"), "").unwrap();
        assert_eq!(locations(&check_root(&dir)), ["empty", "index.json"]);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
