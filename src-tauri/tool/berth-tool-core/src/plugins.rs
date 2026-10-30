//! 插件生命周期（10-03 plugin-lifecycle S2）：`$BERTH_HOME/plugins.json`
//! 启用状态，与 git 来源的安装 / 更新 / 移除。
//!
//! 状态文件只记 Berth 无法从包本身推出的事实：`enabled`、`source`、`rev`。
//! 缺条目即启用（手工拷进 `tools/` 的包零迁移）；未知字段原样保留。
//! 安装先在 `$BERTH_HOME/.plugin-staging/` 完成克隆与校验，再 rename 进
//! `tools/<id>/`，任一步失败都不动 `tools/` 与状态文件。

use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::{json, Map, Value};

use crate::error::ToolCoreError;
use crate::package::missing_package_resources;
use crate::paths::{berth_home_dir, is_valid_manifest_id, tools_root};
use crate::repository::{tool_asset_file_path, MAX_TOOL_JSON_BYTES};

const STATE_FILE: &str = "plugins.json";
const STAGING_DIR: &str = ".plugin-staging";

/// 官方插件仓库：根下每个子目录一个插件（由 `scripts/publish-plugins` 从 `plugins/` 同步）。
pub const OFFICIAL_REPO: &str = "https://github.com/zqverse0/berth-plugins";

fn state_path() -> PathBuf {
    berth_home_dir().join(STATE_FILE)
}

fn read_state() -> Result<Value, ToolCoreError> {
    match std::fs::read(state_path()) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|error| {
            ToolCoreError::invalid_input(format!("{STATE_FILE} is not valid JSON: {error}"))
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(json!({ "version": 1, "plugins": {} }))
        }
        Err(error) => Err(error.into()),
    }
}

fn write_state(state: &Value) -> Result<(), ToolCoreError> {
    let path = state_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(state)
        .map_err(|error| ToolCoreError::Io(error.to_string()))?;
    std::fs::write(&temp, text + "\n")?;
    std::fs::rename(&temp, &path)?;
    Ok(())
}

/// 读改写一个插件条目；`edit` 返回 false 表示删除该条目。
fn update_entry(
    id: &str,
    edit: impl FnOnce(&mut Map<String, Value>) -> bool,
) -> Result<(), ToolCoreError> {
    let mut state = read_state()?;
    let root = state.as_object_mut().ok_or_else(|| {
        ToolCoreError::invalid_input(format!("{STATE_FILE} must be a JSON object"))
    })?;
    let plugins = root
        .entry("plugins")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| {
            ToolCoreError::invalid_input(format!("{STATE_FILE} `plugins` must be an object"))
        })?;
    let mut entry = plugins
        .get(id)
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if edit(&mut entry) {
        plugins.insert(id.to_string(), Value::Object(entry));
    } else {
        plugins.remove(id);
    }
    write_state(&state)
}

/// 被停用的插件 id。状态文件损坏时按「全部启用」处理：枚举路径（会话、
/// 用量、启动栏）不能因一个坏文件整体失效；写操作会报出损坏。
pub fn disabled_ids() -> Vec<String> {
    let Ok(state) = read_state() else {
        return Vec::new();
    };
    state
        .get("plugins")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter(|(_, entry)| entry.get("enabled").and_then(Value::as_bool) == Some(false))
        .map(|(id, _)| id.clone())
        .collect()
}

pub fn is_enabled(id: &str) -> bool {
    !disabled_ids().iter().any(|disabled| disabled == id)
}

/// 插件声明的 `engines.berth` 本 Berth 不满足的原因（tool.json 缺失或损坏时不在这里报）。
pub fn incompatibility(id: &str) -> Option<String> {
    let asset = crate::repository::load_tool_asset(id).ok().flatten()?;
    crate::manifest::incompatibility(asset.raw())
}

/// 启动 / 执行入口的闸口：停用或与本 Berth 不兼容的插件给出可操作的错误。
pub fn ensure_enabled(id: &str) -> Result<(), ToolCoreError> {
    if !is_enabled(id) {
        return Err(ToolCoreError::invalid_input(format!(
            "plugin '{id}' is disabled; run `berth tools enable {id}` or enable it in Settings → Tools"
        )));
    }
    match incompatibility(id) {
        None => Ok(()),
        Some(reason) => Err(ToolCoreError::invalid_input(format!(
            "plugin '{id}' is not loaded: {reason}"
        ))),
    }
}

fn require_installed(id: &str) -> Result<PathBuf, ToolCoreError> {
    let manifest = tool_asset_file_path(id)?;
    if !manifest.is_file() {
        return Err(ToolCoreError::invalid_input(format!(
            "no plugin '{id}' installed at {}",
            manifest.display()
        )));
    }
    Ok(manifest.parent().map(Path::to_path_buf).unwrap_or_default())
}

pub fn set_enabled(id: &str, enabled: bool) -> Result<(), ToolCoreError> {
    require_installed(id)?;
    update_entry(id, |entry| {
        entry.insert("enabled".into(), Value::Bool(enabled));
        true
    })
}

/// 一次成功的安装 / 更新。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Installed {
    pub id: String,
    pub source: String,
    pub rev: String,
}

/// 已存在的本地路径记成绝对路径，`update` 在任意 cwd 下都能重取。
/// 来源 = `<git 仓库>[#<子目录>]`：子目录用于一个仓库放多个插件（如 berth 仓库的 `plugins/claude`）。
fn split_source(source: &str) -> (&str, Option<&str>) {
    match source.rsplit_once('#') {
        Some((repo, subdir)) if !subdir.is_empty() => (repo, Some(subdir)),
        _ => (source, None),
    }
}

fn normalize_source(source: &str) -> String {
    let (repo, subdir) = split_source(source);
    let repo = std::fs::canonicalize(repo)
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_else(|_| repo.to_string());
    match subdir {
        Some(subdir) => format!("{repo}#{subdir}"),
        None => repo,
    }
}

fn git(args: &[&str]) -> Result<String, ToolCoreError> {
    let output = Command::new("git")
        .args(args)
        // 不弹凭证提示：私有仓库失败即报错，不挂住 CLI / GUI。
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|error| ToolCoreError::Io(format!("cannot run git: {error}")))?;
    if !output.status.success() {
        return Err(ToolCoreError::invalid_input(format!(
            "git {} failed: {}",
            args.first().copied().unwrap_or_default(),
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn read_staged_id(dir: &Path) -> Result<String, ToolCoreError> {
    let manifest = dir.join("tool.json");
    let metadata = std::fs::metadata(&manifest)
        .map_err(|_| ToolCoreError::invalid_input("source has no tool.json at its root"))?;
    if !metadata.is_file() || metadata.len() > MAX_TOOL_JSON_BYTES {
        return Err(ToolCoreError::invalid_input(
            "tool.json must be a regular file under 1 MiB",
        ));
    }
    let raw: Value = serde_json::from_slice(&std::fs::read(&manifest)?).map_err(|error| {
        ToolCoreError::invalid_input(format!("tool.json is not valid JSON: {error}"))
    })?;
    let id = raw
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| is_valid_manifest_id(id))
        .ok_or_else(|| {
            ToolCoreError::invalid_input("tool.json `id` must match [a-z0-9][a-z0-9._-]*")
        })?
        .to_string();
    if let Some(missing) = missing_package_resources(dir, &raw).first() {
        return Err(ToolCoreError::invalid_input(format!(
            "{}: {}",
            missing.location, missing.message
        )));
    }
    Ok(id)
}

/// staging 下一个不重名的新路径（尚未创建）。
fn staging_path(prefix: &str) -> Result<PathBuf, ToolCoreError> {
    let staging = berth_home_dir().join(STAGING_DIR);
    std::fs::create_dir_all(&staging)?;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or_default();
    Ok(staging.join(format!("{prefix}-{}-{nanos}", std::process::id())))
}

/// 克隆并校验到 staging；返回 (目录, id, rev)。失败时已清理目录。
fn stage(source: &str) -> Result<(PathBuf, String, String), ToolCoreError> {
    let dir = staging_path("clone")?;
    let checkout = dir.with_extension("checkout");
    let checkout_text = checkout.to_string_lossy().into_owned();
    let (repo, subdir) = split_source(source);
    let result = (|| {
        git(&["clone", "--depth", "1", "--quiet", "--", repo, &checkout_text])?;
        let rev = git(&["-C", &checkout_text, "rev-parse", "HEAD"])?;
        let package = match subdir {
            Some(subdir) => {
                let relative = Path::new(subdir);
                if !relative
                    .components()
                    .all(|part| matches!(part, std::path::Component::Normal(_)))
                {
                    return Err(ToolCoreError::invalid_input(format!(
                        "subdirectory '{subdir}' must be a plain relative path"
                    )));
                }
                checkout.join(relative)
            }
            None => checkout.clone(),
        };
        if !package.is_dir() {
            return Err(ToolCoreError::invalid_input(format!(
                "'{}' is not a directory in {repo}",
                subdir.unwrap_or(".")
            )));
        }
        std::fs::rename(&package, &dir)?;
        let _ = std::fs::remove_dir_all(dir.join(".git"));
        let id = read_staged_id(&dir)?;
        Ok((id, rev))
    })();
    let _ = std::fs::remove_dir_all(&checkout);
    match result {
        Ok((id, rev)) => Ok((dir, id, rev)),
        Err(error) => {
            let _ = std::fs::remove_dir_all(&dir);
            Err(error)
        }
    }
}

fn record_source(installed: &Installed) -> Result<(), ToolCoreError> {
    update_entry(&installed.id, |entry| {
        entry.insert("source".into(), Value::String(installed.source.clone()));
        entry.insert("rev".into(), Value::String(installed.rev.clone()));
        true
    })
}

/// 仓库里可安装的插件：对每个带 tool.json 的子目录调用 `inspect(子目录名, 目录, 归一后的
/// tool.json)`，按子目录名排序返回；克隆用完即删。只读清单，包内资源留给 [`install`] 校验。
pub fn catalog<T>(
    repo: &str,
    mut inspect: impl FnMut(&str, &Path, Value) -> T,
) -> Result<Vec<T>, ToolCoreError> {
    let checkout = staging_path("catalog")?;
    let checkout_text = checkout.to_string_lossy().into_owned();
    let result = (|| {
        git(&["clone", "--depth", "1", "--quiet", "--", repo, &checkout_text])?;
        let mut dirs: Vec<_> = std::fs::read_dir(&checkout)?.flatten().collect();
        dirs.sort_by_key(|entry| entry.file_name());
        let mut entries = Vec::new();
        for entry in dirs {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Ok(bytes) = std::fs::read(entry.path().join("tool.json")) else {
                continue;
            };
            let Ok(mut raw) = serde_json::from_slice::<Value>(&bytes) else {
                continue;
            };
            crate::manifest::normalize(&mut raw);
            entries.push(inspect(&name, &entry.path(), raw));
        }
        Ok(entries)
    })();
    let _ = std::fs::remove_dir_all(&checkout);
    result
}

/// 从 git 仓库（URL 或本地仓库路径，可带 `#<子目录>`）安装一个新插件；
/// 只给插件 id（且不是本地路径）时从 [`OFFICIAL_REPO`] 安装。
pub fn install(source: &str) -> Result<Installed, ToolCoreError> {
    let source = if is_valid_manifest_id(source) && !Path::new(source).exists() {
        format!("{OFFICIAL_REPO}#{source}")
    } else {
        normalize_source(source)
    };
    let (dir, id, rev) = stage(&source)?;
    let target = tools_root().join(&id);
    let placed = if target.exists() {
        Err(ToolCoreError::invalid_input(format!(
            "plugin '{id}' is already installed; use `berth tools update {id}`"
        )))
    } else {
        std::fs::create_dir_all(tools_root())
            .and_then(|()| std::fs::rename(&dir, &target))
            .map_err(ToolCoreError::from)
    };
    if let Err(error) = placed {
        let _ = std::fs::remove_dir_all(&dir);
        return Err(error);
    }
    let installed = Installed { id, source, rev };
    record_source(&installed)?;
    Ok(installed)
}

/// 按记录的来源重装；新包无效或就位失败时保留旧包。
pub fn update(id: &str) -> Result<Installed, ToolCoreError> {
    let target = require_installed(id)?;
    let source = read_state()?
        .pointer(&format!("/plugins/{id}/source"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| {
            ToolCoreError::invalid_input(format!(
                "plugin '{id}' has no recorded source (installed by hand); reinstall it with `berth tools install`"
            ))
        })?;
    let (dir, staged_id, rev) = stage(&source)?;
    if staged_id != id {
        let _ = std::fs::remove_dir_all(&dir);
        return Err(ToolCoreError::invalid_input(format!(
            "source now declares id '{staged_id}', not '{id}'"
        )));
    }
    let backup = dir.with_extension("previous");
    std::fs::rename(&target, &backup).inspect_err(|_| {
        let _ = std::fs::remove_dir_all(&dir);
    })?;
    if let Err(error) = std::fs::rename(&dir, &target) {
        let _ = std::fs::rename(&backup, &target);
        let _ = std::fs::remove_dir_all(&dir);
        return Err(error.into());
    }
    let _ = std::fs::remove_dir_all(&backup);
    let installed = Installed {
        id: id.to_string(),
        source,
        rev,
    };
    record_source(&installed)?;
    Ok(installed)
}

/// 删除插件目录与状态条目。
pub fn remove(id: &str) -> Result<(), ToolCoreError> {
    let dir = require_installed(id)?;
    std::fs::remove_dir_all(&dir)?;
    update_entry(id, |_| false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::TEST_ENV_LOCK;

    fn with_home(test: impl FnOnce(&Path)) {
        let lock = TEST_ENV_LOCK.get_or_init(|| std::sync::Mutex::new(()));
        let _guard = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let previous = std::env::var_os("BERTH_HOME");
        let home = std::env::temp_dir().join(format!("berth-plugins-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(home.join("tools")).unwrap();
        std::env::set_var("BERTH_HOME", &home);
        test(&home);
        match previous {
            Some(value) => std::env::set_var("BERTH_HOME", value),
            None => std::env::remove_var("BERTH_HOME"),
        }
        let _ = std::fs::remove_dir_all(&home);
    }

    /// 建一个本地 git 仓库作为安装来源。
    fn repo(home: &Path, name: &str, files: &[(&str, &str)]) -> String {
        let dir = home.join(name);
        std::fs::create_dir_all(&dir).unwrap();
        for (file, content) in files {
            std::fs::write(dir.join(file), content).unwrap();
        }
        commit(&dir);
        dir.to_string_lossy().into_owned()
    }

    fn commit(dir: &Path) {
        let dir = dir.to_string_lossy();
        git(&["-C", &dir, "init", "--quiet"]).unwrap();
        git(&["-C", &dir, "add", "-A"]).unwrap();
        git(&[
            "-C",
            &dir,
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "commit",
            "--quiet",
            "-m",
            "v",
        ])
        .unwrap();
    }

    fn staging_is_empty(home: &Path) -> bool {
        std::fs::read_dir(home.join(STAGING_DIR))
            .map(|mut entries| entries.next().is_none())
            .unwrap_or(true)
    }

    #[test]
    fn enable_state_defaults_to_enabled_and_round_trips() {
        with_home(|home| {
            std::fs::create_dir_all(home.join("tools/demo")).unwrap();
            std::fs::write(home.join("tools/demo/tool.json"), "{}").unwrap();
            assert!(is_enabled("demo"));
            set_enabled("demo", false).unwrap();
            assert_eq!(disabled_ids(), ["demo"]);
            assert!(ensure_enabled("demo").is_err());
            set_enabled("demo", true).unwrap();
            assert!(ensure_enabled("demo").is_ok());
            assert!(set_enabled("ghost", false).is_err());
        });
    }

    /// `engines.berth` 不满足：不进运行入口，启动闸口报出原因；管理视图仍列出它。
    #[test]
    fn incompatible_plugins_are_listed_but_not_loaded() {
        with_home(|home| {
            for (id, engines) in [("old", r#"{"berth":">=0.1"}"#), ("future", r#"{"berth":">=99.0"}"#)] {
                std::fs::create_dir_all(home.join("tools").join(id)).unwrap();
                std::fs::write(
                    home.join("tools").join(id).join("tool.json"),
                    format!(r#"{{"id":"{id}","engines":{engines}}}"#),
                )
                .unwrap();
            }
            assert_eq!(crate::repository::list_tool_asset_ids(), ["old"]);
            assert_eq!(crate::repository::list_installed_tool_asset_ids().len(), 2);
            assert!(ensure_enabled("old").is_ok());
            let error = ensure_enabled("future").unwrap_err().to_string();
            assert!(error.contains(">=99.0"), "{error}");
        });
    }

    #[test]
    fn install_places_package_and_records_source() {
        with_home(|home| {
            let source = repo(
                home,
                "src",
                &[("tool.json", r#"{"id":"demo"}"#), ("README.md", "x")],
            );
            let installed = install(&source).unwrap();
            assert_eq!(installed.id, "demo");
            assert!(home.join("tools/demo/tool.json").is_file());
            assert!(!home.join("tools/demo/.git").exists());
            let state = read_state().unwrap();
            assert_eq!(state["plugins"]["demo"]["rev"], installed.rev);
            assert!(staging_is_empty(home));
            // 重复安装被拒，原包不动。
            assert!(install(&source).is_err());
            assert!(home.join("tools/demo/tool.json").is_file());
        });
    }

    #[test]
    fn install_takes_a_plugin_from_a_repo_subdirectory() {
        with_home(|home| {
            let dir = home.join("mono/plugins/demo");
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("tool.json"), r#"{"id":"demo"}"#).unwrap();
            std::fs::write(home.join("mono/README.md"), "repo").unwrap();
            commit(&home.join("mono"));
            let repo = home.join("mono").to_string_lossy().into_owned();
            let installed = install(&format!("{repo}#plugins/demo")).unwrap();
            assert_eq!(installed.id, "demo");
            assert!(installed.source.ends_with("#plugins/demo"));
            assert!(home.join("tools/demo/tool.json").is_file());
            assert!(!home.join("tools/demo/README.md").exists(), "只取子目录");
            // update 沿用记录的子目录来源。
            std::fs::write(dir.join("usage.md"), "v2").unwrap();
            commit(&home.join("mono"));
            update("demo").unwrap();
            assert!(home.join("tools/demo/usage.md").is_file());
            for bad in ["#../mono", "#plugins/missing", "#/etc"] {
                assert!(install(&format!("{repo}{bad}")).is_err(), "{bad}");
            }
            assert!(staging_is_empty(home));
        });
    }

    #[test]
    fn catalog_lists_plugin_subdirectories_and_cleans_up() {
        with_home(|home| {
            for id in ["b", "a"] {
                let dir = home.join("market").join(id);
                std::fs::create_dir_all(&dir).unwrap();
                std::fs::write(
                    dir.join("tool.json"),
                    format!(r#"{{"id":"{id}","contributes":{{"identity":{{"name":"N{id}"}}}}}}"#),
                )
                .unwrap();
            }
            std::fs::write(home.join("market/README.md"), "x").unwrap();
            commit(&home.join("market"));
            let entries = catalog(&home.join("market").to_string_lossy(), |name, dir, raw| {
                assert!(dir.join("tool.json").is_file());
                (name.to_string(), raw)
            })
            .unwrap();
            let names: Vec<_> = entries.iter().map(|(name, _)| name.as_str()).collect();
            assert_eq!(names, ["a", "b"]);
            assert_eq!(entries[0].1.pointer("/identity/name"), Some(&json!("Na")));
            assert!(staging_is_empty(home));
        });
    }

    #[test]
    fn invalid_sources_leave_tools_and_state_untouched() {
        with_home(|home| {
            let no_manifest = repo(home, "a", &[("README.md", "x")]);
            let bad_id = repo(home, "b", &[("tool.json", r#"{"id":"Bad"}"#)]);
            let missing = repo(
                home,
                "c",
                &[(
                    "tool.json",
                    r#"{"id":"demo","resources":{"s":{"locator":{"base":"package","path":"sessions.json"}}}}"#,
                )],
            );
            for source in [
                no_manifest,
                bad_id,
                missing,
                "/nonexistent/repo".to_string(),
            ] {
                assert!(install(&source).is_err(), "{source}");
            }
            assert_eq!(std::fs::read_dir(home.join("tools")).unwrap().count(), 0);
            assert!(!home.join(STATE_FILE).exists());
            assert!(staging_is_empty(home));
        });
    }

    #[test]
    fn update_replaces_package_and_keeps_old_one_when_new_is_invalid() {
        with_home(|home| {
            let source = repo(home, "src", &[("tool.json", r#"{"id":"demo"}"#)]);
            let first = install(&source).unwrap();
            std::fs::write(home.join("src/usage.md"), "v2").unwrap();
            commit(&home.join("src"));
            let second = update("demo").unwrap();
            assert_ne!(first.rev, second.rev);
            assert!(home.join("tools/demo/usage.md").is_file());

            std::fs::write(home.join("src/tool.json"), r#"{"id":"other"}"#).unwrap();
            commit(&home.join("src"));
            assert!(update("demo").is_err());
            assert!(home.join("tools/demo/usage.md").is_file());
            assert_eq!(read_state().unwrap()["plugins"]["demo"]["rev"], second.rev);
            assert!(staging_is_empty(home));

            remove("demo").unwrap();
            assert!(!home.join("tools/demo").exists());
            assert!(read_state().unwrap()["plugins"].get("demo").is_none());
        });
    }
}
