//! 只读子命令：`list` / `show` / `check`。
//!
//! 全部走文件与本地计算，不连接 daemon、不起进程、不写文件。

use std::io::Read;

use serde_json::{json, Value};

use crate::CliError;

/// knowledge.path 等包内文件的读取上限（展示用，超限截断说明）。
const MAX_KNOWLEDGE_BYTES: u64 = 256 * 1024;

/// 插件接入了哪些位置（`package::contributions`，读不到包目录时为空）。
fn contributions_of(id: &str, raw: &Value) -> Vec<String> {
    berth_tool_core::repository::tool_package_dir(id)
        .map(|dir| berth_tool_core::package::contributions(&dir, raw))
        .unwrap_or_default()
}

pub(crate) fn list(json: bool) -> Result<(), CliError> {
    let ids = berth_tool_core::repository::list_installed_tool_asset_ids();
    let disabled = berth_tool_core::plugins::disabled_ids();
    let mut entries = Vec::new();
    for id in &ids {
        let mut entry = match berth_tool_core::repository::load_tool_asset(id) {
            Ok(Some(asset)) => json!({
                "id": id,
                "name": asset.identity_name(),
                "protocol": asset.protocol(),
                "contributes": contributions_of(id, asset.raw()),
                "diagnostics": asset
                    .diagnostics()
                    .iter()
                    .map(|d| json!({ "location": d.location, "message": d.message }))
                    .collect::<Vec<_>>(),
            }),
            // 局部诊断：一个坏资产不影响其他条目。
            Ok(None) => {
                json!({ "id": id, "diagnostics": [ { "location": "tool.json", "message": "listed but unreadable" } ] })
            }
            Err(error) => json!({
                "id": id,
                "diagnostics": [ { "location": "tool.json", "message": error.to_string() } ],
            }),
        };
        entry["enabled"] = json!(!disabled.contains(id));
        entries.push(entry);
    }
    if json {
        println!(
            "{}",
            json!({ "operation": "tools.list", "status": "ok", "root": berth_tool_core::paths::tools_root().display().to_string(), "tools": entries })
        );
        return Ok(());
    }
    if entries.is_empty() {
        println!(
            "no tool.json registered under {}",
            berth_tool_core::paths::tools_root().display()
        );
        return Ok(());
    }
    println!("{:<16} {:<24} CONTRIBUTES", "ID", "NAME");
    for entry in &entries {
        let id = entry["id"].as_str().unwrap_or("?");
        let contributes: Vec<&str> = entry["contributes"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect();
        let diagnostics = entry["diagnostics"].as_array().map_or(0, Vec::len);
        let mut notes = String::new();
        if diagnostics > 0 {
            notes.push_str(&format!(
                " ({diagnostics} diagnostic(s); run `berth tools show {id}`)"
            ));
        }
        if entry["enabled"] == json!(false) {
            notes.push_str(" disabled");
        }
        println!(
            "{:<16} {:<24} {}{notes}",
            id,
            entry["name"].as_str().unwrap_or("-"),
            if contributes.is_empty() {
                "-".to_string()
            } else {
                contributes.join(", ")
            },
        );
    }
    Ok(())
}

/// `berth guide --brief` 的 `{tools}` 行：列出启用且带用法说明（`guide`）的非 Agent 插件，
/// Agent 由此知道有哪些工具、去哪看用法；停用的插件对 Agent 不可见。
pub(crate) fn brief(template: &str) -> String {
    let disabled = berth_tool_core::plugins::disabled_ids();
    let tools: Vec<String> = berth_tool_core::repository::list_installed_tool_asset_ids()
        .into_iter()
        .filter(|id| !disabled.contains(id))
        .filter_map(|id| {
            let asset = berth_tool_core::repository::load_tool_asset(&id).ok()??;
            // Agent 插件的 usage.md 写给用户（怎么配置它），不是给其他 Agent 调用的工具。
            let points = contributions_of(&id, asset.raw());
            if !points.iter().any(|point| point == "guide")
                || points.iter().any(|point| point == "agent")
            {
                return None;
            }
            Some(match asset.identity_name() {
                Some(name) if name != id => format!("`{id}`（{name}）"),
                _ => format!("`{id}`"),
            })
        })
        .collect();
    let line = if tools.is_empty() {
        String::new()
    } else {
        format!(
            "- 可用工具，用前先 `berth tools show <id>` 看用法 → {}\n",
            tools.join("、")
        )
    };
    template.replace("{tools}", &line)
}

/// `berth tools check`：插件接入了哪些位置 + 包边界检查，只读；发现问题不改退出码，看 `clean`。
pub(crate) fn check(tool: Option<&str>, json: bool) -> Result<(), CliError> {
    let root = berth_tool_core::paths::tools_root();
    let findings_json = |findings: &[berth_tool_core::asset::AssetDiagnostic]| -> Vec<Value> {
        findings
            .iter()
            .map(|d| json!({ "location": d.location, "message": d.message }))
            .collect()
    };
    let root_findings = if tool.is_none() {
        berth_tool_core::package::check_root(&root)
    } else {
        Vec::new()
    };
    let ids = match tool {
        Some(id) => vec![id.to_string()],
        None => berth_tool_core::repository::list_installed_tool_asset_ids(),
    };
    let mut tools = Vec::new();
    for id in &ids {
        let asset = super::load_asset(id, "tools.check", json)?;
        let dir = berth_tool_core::repository::tool_package_dir(id).map_err(|error| {
            super::tool_error(
                "tools.check",
                crate::EXIT_USER_ERROR,
                error.to_string(),
                json,
            )
        })?;
        tools.push((
            id,
            berth_tool_core::package::contributions(&dir, asset.raw()),
            berth_tool_core::package::check_package(&dir, asset.raw()),
        ));
    }
    let clean =
        root_findings.is_empty() && tools.iter().all(|(_, _, findings)| findings.is_empty());
    if json {
        let tools: Vec<Value> = tools
            .iter()
            .map(|(id, contributes, findings)| json!({ "id": id, "contributes": contributes, "findings": findings_json(findings) }))
            .collect();
        println!(
            "{}",
            json!({ "operation": "tools.check", "status": "ok", "root": root.display().to_string(), "clean": clean, "rootFindings": findings_json(&root_findings), "tools": tools })
        );
        return Ok(());
    }
    for finding in &root_findings {
        println!("{}: {}", finding.location, finding.message);
    }
    for (id, contributes, findings) in &tools {
        let contributes = if contributes.is_empty() {
            "(nothing)".to_string()
        } else {
            contributes.join(", ")
        };
        println!("{id}: contributes {contributes}");
        for finding in findings {
            println!("{id}/{}: {}", finding.location, finding.message);
        }
    }
    if clean {
        println!("clean: {} plugin(s) in {}", tools.len(), root.display());
    }
    Ok(())
}

pub(crate) fn show(tool: &str, json: bool) -> Result<(), CliError> {
    let asset = super::load_asset(tool, "tools.show", json)?;
    let path = berth_tool_core::repository::tool_asset_file_path(tool)
        .ok()
        .map(|path| path.display().to_string())
        .unwrap_or_default();
    if json {
        let mut envelope = asset.raw().clone();
        let object = envelope
            .as_object_mut()
            .expect("asset raw is the loaded value");
        object.insert(
            "_berth".into(),
            json!({
                "operation": "tools.show",
                "path": path,
                "contributes": contributions_of(tool, asset.raw()),
                "diagnostics": asset.diagnostics().iter().map(|d| json!({ "location": d.location, "message": d.message })).collect::<Vec<_>>(),
            }),
        );
        println!("{envelope}");
        return Ok(());
    }
    println!(
        "tool {tool}{} (protocol {}, revision {})",
        asset
            .identity_name()
            .map(|name| format!(" — {name}"))
            .unwrap_or_default(),
        asset.protocol().unwrap_or("<missing>"),
        asset
            .raw()
            .get("revision")
            .and_then(Value::as_str)
            .unwrap_or("-"),
    );
    println!("path: {path}");
    let contributes = contributions_of(tool, asset.raw());
    println!(
        "contributes: {}",
        if contributes.is_empty() {
            "-".to_string()
        } else {
            contributes.join(", ")
        }
    );
    for diagnostic in asset.diagnostics() {
        println!(
            "diagnostic [{}]: {}",
            diagnostic.location, diagnostic.message
        );
    }
    for (id, entry) in related_knowledge(&asset) {
        println!("\nknowledge {id}: {}", localized_title(&entry));
        if let Some(text) = entry.get("text").and_then(Value::as_str) {
            print_capped(text, MAX_KNOWLEDGE_BYTES as usize, "  ");
        } else if let Some(relative) = entry.get("path").and_then(Value::as_str) {
            match read_package_file(tool, relative) {
                Some(content) => print_capped(&content, MAX_KNOWLEDGE_BYTES as usize, "  "),
                None => println!("  ({relative} unreadable or outside the package)"),
            }
        }
    }
    Ok(())
}

fn localized_title(entry: &Value) -> String {
    super::localized(entry.get("title")).unwrap_or_default()
}

fn related_knowledge(asset: &berth_tool_core::asset::ToolAsset) -> Vec<(String, Value)> {
    asset
        .raw()
        .get("knowledge")
        .and_then(Value::as_object)
        .map(|entries| {
            entries
                .iter()
                .map(|(id, entry)| (id.clone(), entry.clone()))
                .collect()
        })
        .unwrap_or_default()
}

fn read_package_file(tool: &str, relative: &str) -> Option<String> {
    use std::path::Component;
    let base = berth_tool_core::repository::tool_asset_file_path(tool).ok()?;
    let package_dir = base.parent()?;
    // 评审修复（越界读取）：组件级校验拒绝绝对路径与 `..`/`.` 逃逸；
    // 根与目标各自 canonicalize 后重新确认前缀——软链指向包外同样被拒。
    let relative_path = std::path::Path::new(relative);
    if relative_path.is_absolute() {
        return None;
    }
    if relative_path
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return None;
    }
    let package_root = package_dir.canonicalize().ok()?;
    let candidate = package_dir.join(relative_path).canonicalize().ok()?;
    if !candidate.starts_with(&package_root) {
        return None;
    }
    let metadata = std::fs::metadata(&candidate).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_KNOWLEDGE_BYTES {
        return None;
    }
    let mut buffer = Vec::new();
    std::fs::File::open(&candidate)
        .ok()?
        .take(MAX_KNOWLEDGE_BYTES)
        .read_to_end(&mut buffer)
        .ok()?;
    Some(String::from_utf8_lossy(&buffer).into_owned())
}

fn print_capped(text: &str, cap: usize, indent: &str) {
    for line in text.lines().take(cap / 80 + 20) {
        println!("{indent}{line}");
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    #[test]
    fn show_reads_from_isolated_home() {
        let lock = berth_tool_core::paths::TEST_ENV_LOCK.get_or_init(|| std::sync::Mutex::new(()));
        let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
        let previous = std::env::var_os("BERTH_HOME");
        let root = std::env::temp_dir().join(format!("berth-cli-describe-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let dir = root.join("tools/sample");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("tool.json"),
            json!({ "protocol": "berth.tool/1", "id": "sample", "identity": { "name": "Sample" } })
                .to_string(),
        )
        .unwrap();
        std::fs::write(dir.join("usage.md"), "# Usage").unwrap();
        std::env::set_var("BERTH_HOME", &root);

        let asset = super::super::load_asset("sample", "tools.show", true).expect("asset loads");
        assert_eq!(asset.identity_name(), Some("Sample"));
        assert_eq!(super::contributions_of("sample", asset.raw()), ["guide"]);
        assert!(super::brief("{tools}").contains("`sample`（Sample）"));
        std::fs::write(
            root.join("plugins.json"),
            r#"{"plugins":{"sample":{"enabled":false}}}"#,
        )
        .unwrap();
        assert_eq!(super::brief("a\n{tools}b"), "a\nb");

        match previous {
            Some(value) => std::env::set_var("BERTH_HOME", value),
            None => std::env::remove_var("BERTH_HOME"),
        }
        let _ = std::fs::remove_dir_all(root);
    }
}
