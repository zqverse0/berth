//! 文件工具接入点（`docs/contribution-points.md`）：
//!
//! - `extensions["org.berth.preview"]`：`{ "extensions": [...], "argv": [...], "protocol": "watch/1", "script"?: "preview.js" }`
//!   `script` 是包内脚本，宿主注入预览 iframe（适配该渲染器自己的 HTML），宿主不认识任何渲染器的 DOM。
//! - `extensions["org.berth.extract"]`：`{ "extensions": [...], "argv": [...] }`
//! - `extensions["org.berth.install"]`：`{ "bin", "paths": { "unix": [...], "windows": [...] }, "version": [...],
//!   "update"?: [...], "latest"?: { "npm": "<包名>" } | { "github": "<owner>/<repo>" } }`
//!   安装行为是包内约定脚本 `install.sh` / `install.ps1`，不进 JSON。`update` 是程序自带的更新参数
//!   （它知道自己从哪个渠道装的）；省略时更新 = 重跑安装脚本。`latest` 是查最新版本的公开来源。
//!
//! 只读启用的插件（`list_tool_asset_ids`）：停用即查不到提供者。argv 不含程序名，
//! 程序由 `install.bin` 解析；`{name}` 占位符由调用方给值。

use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::repository::{list_tool_asset_ids, load_tool_asset, tool_package_dir};
use crate::sessions::safe_package_path;

pub const PREVIEW: &str = "org.berth.preview";
pub const EXTRACT: &str = "org.berth.extract";
pub const INSTALL: &str = "org.berth.install";

/// Berth 交给文件工具插件的文档格式（宿主的格式目录，插件只在其中提供实现）。
/// 前端 `src/lib/files/file-viewer-definition.ts` 的 `OFFICE_EXTENSIONS` 必须同步（前端测试比对）。
pub const DOCUMENT_FORMATS: &[&str] = &["docx", "xlsx", "pptx"];

/// 某插件对某接入点的声明，连同它的程序安装信息。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileTool {
    pub id: String,
    pub name: String,
    pub homepage: Option<String>,
    pub dir: PathBuf,
    pub extensions: Vec<String>,
    pub argv: Vec<String>,
    pub protocol: Option<String>,
    /// 包内脚本的绝对路径（已拒绝绝对路径与 `..`）。
    pub script: Option<PathBuf>,
    pub install: Install,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Install {
    pub bin: String,
    /// 本平台的已知安装位置（已展开），第一个是安装脚本的落点。
    pub paths: Vec<PathBuf>,
    pub version: Vec<String>,
    /// 程序自带的更新参数（如 `["update"]`）；空 = 重跑安装脚本。
    pub update: Vec<String>,
    pub latest: Option<Latest>,
}

/// 查最新版本的公开来源。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Latest {
    /// npm 包名，如 `@anthropic-ai/claude-code`。
    Npm(String),
    /// GitHub 仓库 `owner/repo`，取 releases/latest 的 tag。
    Github(String),
}

fn parse_latest(raw: &Value) -> Option<Latest> {
    let valid = |name: &str, extra: &[char]| {
        !name.is_empty()
            && name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c) || extra.contains(&c))
    };
    if let Some(name) = raw.get("npm").and_then(Value::as_str) {
        return valid(name, &['@', '/']).then(|| Latest::Npm(name.to_string()));
    }
    let repo = raw.get("github").and_then(Value::as_str)?;
    (repo.matches('/').count() == 1 && valid(repo, &['/']))
        .then(|| Latest::Github(repo.to_string()))
}

fn strings(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect()
}

/// `~/…` → 用户主目录；`%VAR%…` → 环境变量（Windows 风格）。展开失败的条目丢弃。
fn expand_path(raw: &str) -> Option<PathBuf> {
    if let Some(rest) = raw.strip_prefix("~/") {
        return dirs::home_dir().map(|home| home.join(rest));
    }
    if let Some(rest) = raw.strip_prefix('%') {
        let (var, tail) = rest.split_once('%')?;
        let base = std::env::var_os(var)?;
        return Some(PathBuf::from(base).join(tail.trim_start_matches(['/', '\\'])));
    }
    Some(PathBuf::from(raw))
}

fn parse_install(raw: &Value) -> Option<Install> {
    let install = raw.pointer("/extensions/org.berth.install")?;
    let bin = install.get("bin")?.as_str()?.trim();
    if bin.is_empty() {
        return None;
    }
    let platform = if cfg!(windows) { "windows" } else { "unix" };
    Some(Install {
        bin: bin.to_string(),
        paths: strings(install.pointer(&format!("/paths/{platform}")))
            .iter()
            .filter_map(|path| expand_path(path))
            .collect(),
        version: strings(install.get("version")),
        update: strings(install.get("update")),
        latest: install.get("latest").and_then(parse_latest),
    })
}

fn identity_str<'a>(raw: &'a Value, key: &str) -> Option<&'a str> {
    raw.get("identity")?.get(key)?.as_str()
}

/// 解析一个插件对 `kind` 的声明；缺 install 或 argv 视为未接入。
pub fn parse(id: &str, dir: &Path, raw: &Value, kind: &str) -> Option<FileTool> {
    let decl = raw.get("extensions")?.get(kind)?;
    let argv = strings(decl.get("argv"));
    if argv.is_empty() {
        return None;
    }
    Some(FileTool {
        id: id.to_string(),
        name: identity_str(raw, "name").unwrap_or(id).to_string(),
        homepage: identity_str(raw, "homepage").map(str::to_string),
        dir: dir.to_path_buf(),
        extensions: strings(decl.get("extensions"))
            .into_iter()
            .map(|ext| ext.trim_start_matches('.').to_ascii_lowercase())
            .collect(),
        argv,
        protocol: decl
            .get("protocol")
            .and_then(Value::as_str)
            .map(str::to_string),
        script: decl
            .get("script")
            .and_then(Value::as_str)
            .and_then(|rel| safe_package_path(dir, rel).ok()),
        install: parse_install(raw)?,
    })
}

/// 启用插件里声明了 `kind` 的全部提供者（按 id 排序）。
pub fn providers(kind: &str) -> Vec<FileTool> {
    list_tool_asset_ids()
        .into_iter()
        .filter_map(|id| {
            let asset = load_tool_asset(&id).ok().flatten()?;
            let dir = tool_package_dir(&id).ok()?;
            parse(&id, &dir, asset.raw(), kind)
        })
        .collect()
}

/// 按插件 id 取它声明的程序（含停用插件，供设置页查看安装状态与安装）；
/// 只看 `org.berth.install`，不要求接入预览 / 提取，所以 argv 与后缀为空。
pub fn installable(id: &str) -> Option<FileTool> {
    let asset = load_tool_asset(id).ok().flatten()?;
    let raw = asset.raw();
    Some(FileTool {
        id: id.to_string(),
        name: identity_str(raw, "name").unwrap_or(id).to_string(),
        homepage: identity_str(raw, "homepage").map(str::to_string),
        dir: tool_package_dir(id).ok()?,
        extensions: Vec::new(),
        argv: Vec::new(),
        protocol: None,
        script: None,
        install: parse_install(raw)?,
    })
}

/// 按文件后缀找第一个启用的提供者。
pub fn provider_for(kind: &str, path: &Path) -> Option<FileTool> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    providers(kind)
        .into_iter()
        .find(|tool| tool.extensions.contains(&ext))
}

/// 替换 argv 里整段的 `{name}` 占位符；未知占位符原样保留。
pub fn expand_argv(argv: &[String], vars: &[(&str, &str)]) -> Vec<String> {
    argv.iter()
        .map(|arg| {
            arg.strip_prefix('{')
                .and_then(|rest| rest.strip_suffix('}'))
                .and_then(|name| vars.iter().find(|(key, _)| *key == name))
                .map_or_else(|| arg.clone(), |(_, value)| (*value).to_string())
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn officecli() -> Value {
        json!({
            "identity": { "name": "OfficeCLI", "homepage": "https://officecli.ai" },
            "extensions": {
                "org.berth.preview": {
                    "extensions": ["docx", ".PPTX"],
                    "argv": ["watch", "{file}", "--port", "{port}"],
                    "protocol": "watch/1",
                    "script": "preview.js"
                },
                "org.berth.extract": { "extensions": ["docx"], "argv": [] },
                "org.berth.install": {
                    "bin": "officecli",
                    "paths": { "unix": ["~/.local/bin/officecli"], "windows": ["%LOCALAPPDATA%/OfficeCLI/officecli.exe"] },
                    "version": ["--version"]
                }
            }
        })
    }

    #[test]
    fn parses_preview_and_normalizes_extensions() {
        let tool = parse("officecli", Path::new("/p"), &officecli(), PREVIEW).unwrap();
        assert_eq!(tool.extensions, ["docx", "pptx"]);
        assert_eq!(tool.protocol.as_deref(), Some("watch/1"));
        assert_eq!(tool.script, Some(PathBuf::from("/p/preview.js")));
        assert_eq!(tool.install.bin, "officecli");
        assert_eq!(tool.install.version, ["--version"]);
        #[cfg(not(windows))]
        assert!(tool.install.paths[0].ends_with(".local/bin/officecli"));
    }

    #[test]
    fn empty_argv_or_missing_install_is_not_a_provider() {
        let raw = officecli();
        assert!(parse("officecli", Path::new("/p"), &raw, EXTRACT).is_none());
        let mut raw = raw;
        raw["extensions"]
            .as_object_mut()
            .unwrap()
            .remove("org.berth.install");
        assert!(parse("officecli", Path::new("/p"), &raw, PREVIEW).is_none());
    }

    #[test]
    fn parses_update_and_latest_and_rejects_odd_names() {
        let mut raw = officecli();
        raw["extensions"]["org.berth.install"]["update"] = json!(["update"]);
        raw["extensions"]["org.berth.install"]["latest"] = json!({ "npm": "@scope/pkg" });
        let install = parse("officecli", Path::new("/p"), &raw, PREVIEW)
            .unwrap()
            .install;
        assert_eq!(install.update, ["update"]);
        assert_eq!(install.latest, Some(Latest::Npm("@scope/pkg".into())));
        for bad in [
            json!({ "github": "a/b/c" }),
            json!({ "github": "a/b?x=1" }),
            json!({ "npm": "x y" }),
        ] {
            raw["extensions"]["org.berth.install"]["latest"] = bad;
            let tool = parse("officecli", Path::new("/p"), &raw, PREVIEW).unwrap();
            assert_eq!(tool.install.latest, None);
        }
    }

    #[test]
    fn script_cannot_escape_the_package() {
        let mut raw = officecli();
        raw["extensions"]["org.berth.preview"]["script"] = json!("../x.js");
        let tool = parse("officecli", Path::new("/p"), &raw, PREVIEW).unwrap();
        assert_eq!(tool.script, None);
    }

    #[test]
    fn expands_whole_placeholders_only() {
        let argv: Vec<String> = ["watch", "{file}", "--port", "{port}", "{other}", "x{file}"]
            .map(str::to_string)
            .to_vec();
        assert_eq!(
            expand_argv(&argv, &[("file", "/a.docx"), ("port", "9")]),
            ["watch", "/a.docx", "--port", "9", "{other}", "x{file}"]
        );
    }
}
