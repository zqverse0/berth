//! 视图接入点（docs/plugin-architecture.md §4.1）：`contributes.view`（归一后
//! `extensions["org.berth.view"]`）是视图声明数组。
//!
//! 第 1 层 `script`：宿主运行它的 `render(req)` 拿视图数据，用自己的组件渲染；第 2 层 `page`
//! （包内 html）宿主尚未实现，声明了只报诊断。坏声明逐条跳过，不拖累同包其他视图。

use std::path::Path;

use serde_json::Value;

use crate::asset::AssetDiagnostic;

pub const VIEW: &str = "org.berth.view";

/// 一条可用的视图声明（只含宿主能渲染的第 1 层）。
#[derive(Debug, Clone, PartialEq)]
pub struct View {
    pub id: String,
    /// 字符串，或 `{ "<语言>": "<标题>" }`（缺当前语言取 `en`，由展示方挑）。
    pub title: Value,
    /// 包内图标的相对路径。
    pub icon: Option<String>,
    pub location: Location,
    /// 包内脚本的相对路径。
    pub script: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Location {
    /// 侧栏活动栏一个入口。
    Sidebar,
    /// 只能被 `open-view` 动作打开。
    Tab,
}

impl Location {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Sidebar => "sidebar",
            Self::Tab => "tab",
        }
    }
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// 包内相对路径：拒绝绝对路径与 `..`。
fn package_path(value: Option<&Value>) -> Option<&str> {
    let text = value?.as_str()?;
    let path = Path::new(text);
    (!text.is_empty()
        && !path.is_absolute()
        && !path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir)))
    .then_some(text)
}

fn valid_title(title: &Value) -> bool {
    match title {
        Value::String(text) => !text.trim().is_empty(),
        Value::Object(map) => {
            !map.is_empty()
                && map
                    .values()
                    .all(|v| v.as_str().is_some_and(|t| !t.trim().is_empty()))
        }
        _ => false,
    }
}

/// 解析插件的视图声明：可用的视图与每条坏声明的诊断。
pub fn parse(raw: &Value) -> (Vec<View>, Vec<AssetDiagnostic>) {
    let mut views = Vec::new();
    let mut findings = Vec::new();
    let Some(declared) = raw.get("extensions").and_then(|ext| ext.get(VIEW)) else {
        return (views, findings);
    };
    let Some(items) = declared.as_array() else {
        findings.push(AssetDiagnostic {
            location: "tool.json#/contributes/view".into(),
            message: "view must be an array of view declarations".into(),
        });
        return (views, findings);
    };
    for (index, item) in items.iter().enumerate() {
        let location = format!("tool.json#/contributes/view/{index}");
        let mut fail = |message: &str| {
            findings.push(AssetDiagnostic {
                location: location.clone(),
                message: message.into(),
            })
        };
        let Some(id) = item
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| valid_id(id))
        else {
            fail("id must match [a-z0-9-]+");
            continue;
        };
        if views.iter().any(|view: &View| view.id == id) {
            fail("duplicate view id");
            continue;
        }
        let Some(title) = item.get("title").filter(|title| valid_title(title)) else {
            fail("title must be a non-empty string or a { language: title } object");
            continue;
        };
        let place = match item.get("location").and_then(Value::as_str) {
            Some("sidebar") => Location::Sidebar,
            Some("tab") => Location::Tab,
            _ => {
                fail("location must be \"sidebar\" or \"tab\"");
                continue;
            }
        };
        let script = package_path(item.get("script"));
        let page = item.get("page").is_some();
        let script = match (script, page) {
            (Some(script), false) => script,
            (None, true) => {
                fail("page views are not supported by this Berth yet; use script");
                continue;
            }
            _ => {
                fail("declare exactly one of script / page, as a path inside the package");
                continue;
            }
        };
        let icon = match item.get("icon") {
            None => None,
            icon => match package_path(icon) {
                Some(icon) => Some(icon.to_owned()),
                None => {
                    fail("icon must be a path inside the package");
                    continue;
                }
            },
        };
        views.push(View {
            id: id.to_owned(),
            title: title.clone(),
            icon,
            location: place,
            script: script.to_owned(),
        });
    }
    (views, findings)
}

/// 视图声明引用的包内文件（脚本与图标），供包边界检查放行。
pub fn package_paths(raw: &Value) -> Vec<&str> {
    raw.get("extensions")
        .and_then(|ext| ext.get(VIEW))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .flat_map(|item| [item.get("script"), item.get("icon")])
        .filter_map(|value| package_path(value))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn raw(views: Value) -> Value {
        json!({ "extensions": { VIEW: views } })
    }

    #[test]
    fn views_parse_and_bad_entries_are_skipped_with_a_finding() {
        let (views, findings) = parse(&raw(json!([
            { "id": "discover", "title": { "en": "Discover", "zh-CN": "发现" }, "icon": "icon.svg",
              "location": "sidebar", "script": "views/discover.js" },
            { "id": "readme", "title": "README", "location": "tab", "script": "views/readme.js" },
            { "id": "Bad", "title": "x", "location": "tab", "script": "a.js" },
            { "id": "escape", "title": "x", "location": "tab", "script": "../a.js" },
            { "id": "page", "title": "x", "location": "tab", "page": "a.html" },
            { "id": "where", "title": "x", "location": "statusbar", "script": "a.js" },
            { "id": "readme", "title": "dup", "location": "tab", "script": "a.js" },
        ])));
        assert_eq!(
            views.iter().map(|v| v.id.as_str()).collect::<Vec<_>>(),
            ["discover", "readme"]
        );
        assert_eq!(views[0].location, Location::Sidebar);
        assert_eq!(views[0].icon.as_deref(), Some("icon.svg"));
        assert_eq!(views[1].script, "views/readme.js");
        assert_eq!(findings.len(), 5);
        assert!(findings[2].message.contains("not supported"));
    }

    #[test]
    fn non_array_declaration_is_reported() {
        let (views, findings) = parse(&raw(json!({ "id": "x" })));
        assert!(views.is_empty());
        assert_eq!(findings.len(), 1);
    }

    #[test]
    fn package_paths_cover_scripts_and_icons_but_not_escapes() {
        let value = raw(json!([
            { "script": "views/a.js", "icon": "icons/a.svg" },
            { "script": "../x.js" },
        ]));
        assert_eq!(package_paths(&value), ["views/a.js", "icons/a.svg"]);
    }
}
