//! 编辑器接入点（docs/plugin-architecture.md §4.2）：`contributes.editor`（归一后
//! `extensions["org.berth.editor"]`）是编辑器声明数组。插件给出包内页面，宿主按后缀把文件交给它，
//! 读写、保存、脏标记、外部修改都归宿主。坏声明逐条跳过，不拖累同包其他编辑器。

use serde_json::Value;

use crate::asset::AssetDiagnostic;
use crate::views::{package_path, valid_id, valid_title};

pub const EDITOR: &str = "org.berth.editor";

/// 一条可用的编辑器声明。
#[derive(Debug, Clone, PartialEq)]
pub struct Editor {
    pub id: String,
    /// 字符串，或 `{ "<语言>": "<标题>" }`。
    pub title: Value,
    /// 小写、以 `.` 开头的文件名后缀（可多段，如 `.excalidraw.md`）。
    pub suffixes: Vec<String>,
    /// 包内 html 页面的相对路径。
    pub page: String,
    /// 「新建文件」菜单项。
    pub new: Vec<NewFile>,
    /// 页面能把文件渲染成图片（Markdown 嵌入 `![[x]]`）。
    pub embed: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct NewFile {
    pub title: Value,
    /// 新文件的默认文件名（重名时宿主加序号）；内容为空。
    pub name: String,
}

fn valid_suffix(suffix: &str) -> bool {
    suffix.len() > 1
        && suffix.starts_with('.')
        && !suffix.contains(['/', '\\'])
        && !suffix.ends_with('.')
}

fn valid_file_name(name: &str) -> bool {
    !name.trim().is_empty() && !name.contains(['/', '\\']) && name != "." && name != ".."
}

/// 解析插件的编辑器声明：可用的编辑器与每条坏声明的诊断。
pub fn parse(raw: &Value) -> (Vec<Editor>, Vec<AssetDiagnostic>) {
    let mut editors = Vec::new();
    let mut findings = Vec::new();
    let Some(declared) = raw.get("extensions").and_then(|ext| ext.get(EDITOR)) else {
        return (editors, findings);
    };
    let Some(items) = declared.as_array() else {
        findings.push(AssetDiagnostic {
            location: "tool.json#/contributes/editor".into(),
            message: "editor must be an array of editor declarations".into(),
        });
        return (editors, findings);
    };
    for (index, item) in items.iter().enumerate() {
        let location = format!("tool.json#/contributes/editor/{index}");
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
        if editors.iter().any(|editor: &Editor| editor.id == id) {
            fail("duplicate editor id");
            continue;
        }
        let Some(title) = item.get("title").filter(|title| valid_title(title)) else {
            fail("title must be a non-empty string or a { language: title } object");
            continue;
        };
        let suffixes: Option<Vec<String>> = item
            .get("suffixes")
            .and_then(Value::as_array)
            .filter(|items| !items.is_empty())
            .and_then(|items| {
                items
                    .iter()
                    .map(|suffix| {
                        suffix
                            .as_str()
                            .filter(|suffix| valid_suffix(suffix))
                            .map(str::to_lowercase)
                    })
                    .collect()
            });
        let Some(suffixes) = suffixes else {
            fail("suffixes must be a non-empty array like [\".excalidraw\"]");
            continue;
        };
        let Some(page) = package_path(item.get("page")) else {
            fail("page must be an html file inside the package");
            continue;
        };
        let new: Option<Vec<NewFile>> = match item.get("new") {
            None => Some(Vec::new()),
            Some(Value::Array(entries)) => entries
                .iter()
                .map(|entry| {
                    let title = entry.get("title").filter(|title| valid_title(title))?;
                    let name = entry
                        .get("name")
                        .and_then(Value::as_str)
                        .filter(|name| valid_file_name(name))?;
                    Some(NewFile {
                        title: title.clone(),
                        name: name.to_owned(),
                    })
                })
                .collect(),
            Some(_) => None,
        };
        let Some(new) = new else {
            fail("new must be an array of { title, name }");
            continue;
        };
        editors.push(Editor {
            id: id.to_owned(),
            title: title.clone(),
            suffixes,
            page: page.to_owned(),
            new,
            embed: item.get("embed").and_then(Value::as_bool).unwrap_or(false),
        });
    }
    (editors, findings)
}

/// 编辑器声明引用的包内页面，供包边界检查放行。
pub fn package_paths(raw: &Value) -> Vec<&str> {
    raw.get("extensions")
        .and_then(|ext| ext.get(EDITOR))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| package_path(item.get("page")))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn raw(editors: Value) -> Value {
        json!({ "extensions": { EDITOR: editors } })
    }

    #[test]
    fn editors_parse_and_bad_entries_are_skipped_with_a_finding() {
        let (editors, findings) = parse(&raw(json!([
            { "id": "drawing", "title": { "en": "Excalidraw" }, "suffixes": [".Excalidraw", ".excalidraw.md"],
              "page": "page/index.html", "embed": true,
              "new": [{ "title": "Drawing", "name": "drawing.excalidraw" }] },
            { "id": "bare", "title": "x", "suffixes": [".x"], "page": "x.html" },
            { "id": "nosuffix", "title": "x", "suffixes": [], "page": "x.html" },
            { "id": "dot", "title": "x", "suffixes": ["x"], "page": "x.html" },
            { "id": "escape", "title": "x", "suffixes": [".x"], "page": "../x.html" },
            { "id": "badnew", "title": "x", "suffixes": [".x"], "page": "x.html", "new": [{ "title": "x", "name": "a/b" }] },
            { "id": "drawing", "title": "dup", "suffixes": [".y"], "page": "y.html" },
        ])));
        assert_eq!(
            editors.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(),
            ["drawing", "bare"]
        );
        assert_eq!(editors[0].suffixes, [".excalidraw", ".excalidraw.md"]);
        assert!(editors[0].embed);
        assert_eq!(editors[0].new[0].name, "drawing.excalidraw");
        assert!(!editors[1].embed);
        assert!(editors[1].new.is_empty());
        assert_eq!(findings.len(), 5);
    }

    #[test]
    fn package_paths_cover_pages_but_not_escapes() {
        let value = raw(json!([{ "page": "page/index.html" }, { "page": "../x.html" }]));
        assert_eq!(package_paths(&value), ["page/index.html"]);
    }
}
