//! 设置 →「专家」：`<home>/experts/<id>.json` 的读写，以及它引用的资产候选
//! （`prompts/*.md`、`skills/<id>/`、`mcp/*.json`、`plugins/<id>/`）。
//!
//! 字段：`name`、`prompt`、`skills`、`mcp`、`plugins`，其余键是开放资产字段；校验（`issues`）与宿主启动共用；
//! 启动时由宿主解析后交给 launch.js，这里只负责让用户不手改 JSON 也能装配。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::paths::is_valid_manifest_id;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Expert {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub skills: Vec<String>,
    #[serde(default)]
    pub mcp: Vec<String>,
    #[serde(default)]
    pub plugins: Vec<String>,
    /// 开放字段：`"xxx": ["a"]` 对应 `$BERTH_HOME/xxx/a`，新资产类型只加目录，不改这里。
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

/// 开放字段不能占用的 `$BERTH_HOME` 目录：宿主自用，或已有固定字段。
const RESERVED_KEYS: [&str; 18] = [
    "agents", "backgrounds", "bin", "commands", "credentials", "decisions", "devices", "experts", "guides",
    "hooks", "logs", "pets", "prompts", "remote", "run", "runtime", "state", "tools",
];

/// 一项不合规的引用。`code` 给界面翻译，`Display` 给启动与保存的报错。
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct AssetIssue {
    pub kind: String,
    pub id: String,
    pub code: &'static str,
}

impl std::fmt::Display for AssetIssue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let reason = match self.code {
            "no-name" => "专家名不能为空",
            "invalid-id" => "不是安全 id（小写字母或数字开头，只含小写字母、数字、. _ -）",
            "missing" => "不存在",
            "escapes" => "逃出了资产目录",
            "reserved-key" => "是宿主保留目录，不能作资产字段",
            "invalid-key" => "字段名不是安全 id",
            "not-array" => "必须是 id 数组",
            "bad-mcp" => "不是合法的 MCP 定义（JSON 对象）",
            other => other,
        };
        match self.id.as_str() {
            "" => write!(f, "{}：{reason}", self.kind),
            id => write!(f, "{}/{id}：{reason}", self.kind),
        }
    }
}

impl Expert {
    /// 全部资产引用：固定字段加开放字段（开放字段的形状由 `issues` 校验）。
    pub fn asset_refs(&self) -> Vec<(&str, Vec<&str>)> {
        let fixed = [("skills", &self.skills), ("mcp", &self.mcp), ("plugins", &self.plugins)]
            .map(|(kind, items)| (kind, items.iter().map(String::as_str).collect()));
        let open = self.extra.iter().map(|(kind, items)| {
            let items = items.as_array().into_iter().flatten().filter_map(Value::as_str).collect();
            (kind.as_str(), items)
        });
        fixed.into_iter().chain(open).collect()
    }
}

/// 一份资产的磁盘路径：id 必须安全、文件必须存在且解析后仍在类型目录内。错误是 `AssetIssue::code`。
pub fn resolve_asset(home: &Path, kind: &str, id: &str) -> Result<PathBuf, &'static str> {
    if !is_valid_manifest_id(id) {
        return Err("invalid-id");
    }
    let (dir, file) = match kind {
        "prompt" => ("prompts", format!("{id}.md")),
        "mcp" | "experts" => (kind, format!("{id}.json")),
        _ => (kind, id.to_owned()),
    };
    let root = home.join(dir).canonicalize().map_err(|_| "missing")?;
    let path = home.join(dir).join(file).canonicalize().map_err(|_| "missing")?;
    path.starts_with(&root).then_some(path).ok_or("escapes")
}

/// 专家表的全部不合规项。设置页保存、设置页标记、启动共用这一套，保存得下的启动时不会因校验被拒。
pub fn issues(home: &Path, expert: &Expert) -> Vec<AssetIssue> {
    let issue = |kind: &str, id: &str, code| AssetIssue { kind: kind.to_owned(), id: id.to_owned(), code };
    let mut found = Vec::new();
    if expert.name.trim().is_empty() {
        found.push(issue("name", "", "no-name"));
    }
    if !expert.prompt.is_empty() {
        if let Err(code) = resolve_asset(home, "prompt", &expert.prompt) {
            found.push(issue("prompt", &expert.prompt, code));
        }
    }
    for (key, value) in &expert.extra {
        if !is_valid_manifest_id(key) {
            found.push(issue(key, "", "invalid-key"));
        } else if RESERVED_KEYS.contains(&key.as_str()) {
            found.push(issue(key, "", "reserved-key"));
        } else if !value.as_array().is_some_and(|items| items.iter().all(Value::is_string)) {
            found.push(issue(key, "", "not-array"));
        }
    }
    for (kind, items) in expert.asset_refs() {
        // 字段本身不合规时已报过，不再把它的值当路径去解析。
        if found.iter().any(|item| item.kind == kind && item.id.is_empty()) {
            continue;
        }
        for item in items {
            match resolve_asset(home, kind, item) {
                Ok(path) if kind == "mcp" && !read_json_object(&path) => found.push(issue(kind, item, "bad-mcp")),
                Ok(_) => {}
                Err(code) => found.push(issue(kind, item, code)),
            }
        }
    }
    found
}

fn read_json_object(path: &Path) -> bool {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .is_some_and(|value| value.is_object())
}

/// 专家记忆的读写工具（普通 MCP 资产）。装了它，每个专家就都有记忆，不需要配置。
pub const MEMORY_MCP: &str = "expert-memory";

/// 启动时给专家带上自己的记忆：`memory/<id>/` 和读写工具。只读写自己的，不能指向别的专家。
pub fn with_memory(home: &Path, id: &str, expert: &mut Expert) -> Result<(), String> {
    if !home.join("mcp").join(format!("{MEMORY_MCP}.json")).is_file() {
        return Ok(());
    }
    std::fs::create_dir_all(home.join("memory").join(id)).map_err(|error| error.to_string())?;
    if !expert.mcp.iter().any(|item| item == MEMORY_MCP) {
        expert.mcp.push(MEMORY_MCP.to_owned());
    }
    expert.extra.insert("memory".to_owned(), json!([id]));
    Ok(())
}

/// 一个专家的全部记忆，就是 Agent 能读到的那些：`seed/`（预置，只读）和 `learned/`（同名优先）。
pub fn memory_list(home: &Path, id: &str) -> Result<Value, String> {
    check_id(id)?;
    let root = home.join("memory").join(id);
    let mut entries = BTreeMap::new();
    for source in ["seed", "learned"] {
        for path in sorted_entries(&root.join(source))? {
            let Some(name) = stem_with(&path, "md") else { continue };
            let text = std::fs::read_to_string(&path).map_err(|error| error.to_string())?;
            let (description, body) = memory_parts(&text);
            entries.insert(name.clone(), json!({ "name": name, "source": source, "description": description, "body": body }));
        }
    }
    Ok(Value::Array(entries.into_values().collect()))
}

/// frontmatter 的 description 和正文。格式与 `expert-memory` 工具写的一致。
fn memory_parts(text: &str) -> (String, String) {
    let Some(rest) = text.strip_prefix("---\n") else { return (String::new(), text.trim().to_owned()) };
    let Some((head, body)) = rest.split_once("\n---") else { return (String::new(), text.trim().to_owned()) };
    let description = head.lines().find_map(|line| line.strip_prefix("description:")).unwrap_or_default();
    (description.trim().to_owned(), body.trim().to_owned())
}

/// 写一条用户记忆（同名覆盖，预置的同名记忆被它盖住），并刷新索引。
pub fn memory_save(home: &Path, id: &str, name: &str, description: &str, body: &str) -> Result<(), String> {
    check_id(id)?;
    if !is_valid_manifest_id(name) {
        return Err(format!("记忆名无效：{name}（小写字母、数字、. _ -）"));
    }
    let description = description.split_whitespace().collect::<Vec<_>>().join(" ");
    if description.is_empty() || body.trim().is_empty() {
        return Err("描述和正文都不能为空".to_owned());
    }
    let learned = home.join("memory").join(id).join("learned");
    std::fs::create_dir_all(&learned).map_err(|error| error.to_string())?;
    let text = format!("---\nname: {name}\ndescription: {description}\n---\n\n{}\n", body.trim());
    std::fs::write(learned.join(format!("{name}.md")), text).map_err(|error| error.to_string())?;
    write_memory_index(home, id)
}

/// 删除一条用户记忆并刷新索引；预置记忆不能删。
pub fn memory_delete(home: &Path, id: &str, name: &str) -> Result<(), String> {
    check_id(id)?;
    if !is_valid_manifest_id(name) {
        return Err(format!("记忆名无效：{name}"));
    }
    std::fs::remove_file(home.join("memory").join(id).join("learned").join(format!("{name}.md")))
        .map_err(|error| error.to_string())?;
    write_memory_index(home, id)
}

/// `MEMORY.md`：启动时注入的索引，格式与 `expert-memory` 工具生成的一致。
fn write_memory_index(home: &Path, id: &str) -> Result<(), String> {
    let mut text = "# 专家记忆\n\n优先级：用户当前指令 > 项目 AGENTS.md > 专家学到的记忆 > 种子记忆。记忆是线索，不是规则。\n\n".to_owned();
    for entry in memory_list(home, id)?.as_array().into_iter().flatten() {
        text.push_str(&format!(
            "- {}（{}）：{}\n",
            entry["name"].as_str().unwrap_or_default(),
            entry["source"].as_str().unwrap_or_default(),
            entry["description"].as_str().unwrap_or_default()
        ));
    }
    std::fs::write(home.join("memory").join(id).join("MEMORY.md"), text).map_err(|error| error.to_string())
}

/// 启动清单目录（写入方是 `berth-plugin-api`）。
pub fn launches_dir(home: &Path) -> PathBuf {
    home.join("run/launches")
}

/// 这个终端（`BERTH_TARGET_REF`）最近一次启动的清单；没有为 null。文件名以毫秒开头，倒序第一个匹配的就是最新。
pub fn latest_launch(home: &Path, target: &str) -> Result<Value, String> {
    let mut files = sorted_entries(&launches_dir(home))?;
    files.reverse();
    Ok(files
        .iter()
        .filter(|path| path.extension().is_some_and(|extension| extension == "json"))
        .filter_map(|path| serde_json::from_slice::<Value>(&std::fs::read(path).ok()?).ok())
        .find(|manifest| manifest["target"] == target)
        .unwrap_or(Value::Null))
}

/// 专家列表 + 可选资产 + 目录路径，一次给全（资产几百个，前端本地过滤）。
pub fn catalog(home: &Path) -> Result<Value, String> {
    let mut experts = Vec::new();
    for path in sorted_entries(&home.join("experts"))? {
        let Some(id) = stem_with(&path, "json") else { continue };
        let (expert, error) = match read_expert(&path) {
            Ok(expert) => (expert, None),
            Err(error) => (Expert::default(), Some(error)),
        };
        // 提示词正文随列表给出（每个专家一份，文件很小），页面里直接编辑。
        let prompt = (!expert.prompt.is_empty() && safe_name(&expert.prompt))
            .then(|| std::fs::read_to_string(home.join("prompts").join(format!("{}.md", expert.prompt))).ok())
            .flatten();
        let issues = if error.is_none() { issues(home, &expert) } else { Vec::new() };
        experts.push(json!({ "id": id, "expert": expert, "promptText": prompt, "modified": modified(&path), "error": error, "issues": issues }));
    }
    let skills = sorted_entries(&home.join("skills"))?
        .into_iter()
        .filter(|path| path.is_dir())
        .filter_map(|path| {
            let id = path.file_name()?.to_str()?.to_owned();
            let description = std::fs::read_to_string(path.join("SKILL.md")).ok().and_then(|text| description(&text));
            Some(json!({ "id": id, "description": description }))
        })
        .collect::<Vec<_>>();
    // 记忆工具是每个专家自带的，不是一个可选项。
    let mcp: Vec<String> = stems(&home.join("mcp"), "json")?.into_iter().filter(|id| id != MEMORY_MCP).collect();
    let plugins = sorted_entries(&home.join("plugins"))?
        .into_iter()
        .filter(|path| path.is_dir())
        .filter_map(|path| path.file_name()?.to_str().map(str::to_owned))
        .collect::<Vec<_>>();
    // 目录里有、但 id 不合规的资产：页面直接标出，不让勾选。
    let invalid = |ids: Vec<&str>| ids.into_iter().filter(|id| !is_valid_manifest_id(id)).map(str::to_owned).collect::<Vec<_>>();
    let invalid = json!({
        "skills": invalid(skills.iter().filter_map(|skill| skill["id"].as_str()).collect()),
        "mcp": invalid(mcp.iter().map(String::as_str).collect()),
        "plugins": invalid(plugins.iter().map(String::as_str).collect()),
    });
    Ok(json!({
        "home": home,
        "experts": experts,
        "prompts": stems(&home.join("prompts"), "md")?,
        "skills": skills,
        "mcp": mcp,
        "plugins": plugins,
        "invalid": invalid,
    }))
}

/// 保存一个专家。引用的资产必须存在；`expected_modified` 与磁盘不符说明文件在别处被改过，拒绝覆盖。
/// `prompt_text` 给出时写入 `prompts/<prompt>.md`；专家还没有提示词就用 `<id>.md`。
pub fn save(
    home: &Path,
    id: &str,
    expert: &Expert,
    prompt_text: Option<&str>,
    expected_modified: Option<u64>,
) -> Result<(), String> {
    check_id(id)?;
    let path = home.join("experts").join(format!("{id}.json"));
    if expected_modified.is_some() && modified(&path) != expected_modified {
        return Err(format!("{id}.json 已在别处修改，请刷新后再改"));
    }
    let mut expert = expert.clone();
    if prompt_text.is_some() && expert.prompt.is_empty() {
        expert.prompt = id.to_owned();
    }
    // 校验通过才落盘；这次要写的提示词文件还不存在不算问题。
    let problem = issues(home, &expert)
        .into_iter()
        .find(|issue| !(prompt_text.is_some() && issue.kind == "prompt" && issue.code == "missing"));
    if let Some(problem) = problem {
        return Err(problem.to_string());
    }
    if let Some(text) = prompt_text {
        std::fs::create_dir_all(home.join("prompts")).map_err(|error| error.to_string())?;
        std::fs::write(home.join("prompts").join(format!("{}.md", expert.prompt)), text)
            .map_err(|error| error.to_string())?;
    }
    // 空字段不写，和手写的专家文件保持同样形状。
    let mut document = serde_json::Map::new();
    document.insert("name".into(), json!(expert.name.trim()));
    if !expert.prompt.is_empty() {
        document.insert("prompt".into(), json!(expert.prompt));
    }
    for (key, items) in [("skills", &expert.skills), ("mcp", &expert.mcp), ("plugins", &expert.plugins)] {
        if !items.is_empty() {
            document.insert(key.into(), json!(items));
        }
    }
    document.extend(expert.extra.clone());
    std::fs::create_dir_all(home.join("experts")).map_err(|error| error.to_string())?;
    let text = serde_json::to_string_pretty(&document).map_err(|error| error.to_string())? + "\n";
    std::fs::write(&path, text).map_err(|error| error.to_string())
}

/// 新建专家：同时建一份空提示词 `prompts/<id>.md`（已存在则沿用），保证点「编辑提示词」有文件可开。
pub fn create(home: &Path, id: &str, name: &str) -> Result<(), String> {
    check_id(id)?;
    if home.join("experts").join(format!("{id}.json")).exists() {
        return Err(format!("专家 {id} 已存在"));
    }
    let prompt = home.join("prompts").join(format!("{id}.md"));
    if !prompt.exists() {
        std::fs::create_dir_all(home.join("prompts")).map_err(|error| error.to_string())?;
        std::fs::write(&prompt, format!("# {}\n", name.trim())).map_err(|error| error.to_string())?;
    }
    save(home, id, &Expert { name: name.to_owned(), prompt: id.to_owned(), ..Expert::default() }, None, None)
}

/// 资产详情给页面右侧展示：skill 是 `SKILL.md` 全文，MCP 是它的 JSON；插件包没有统一的说明文件，返回 None。
pub fn asset(home: &Path, kind: &str, id: &str) -> Result<Option<String>, String> {
    if !safe_name(id) {
        return Err(format!("资产名无效：{id}"));
    }
    let path = match kind {
        "skills" => home.join("skills").join(id).join("SKILL.md"),
        "mcp" => home.join("mcp").join(format!("{id}.json")),
        "plugins" => return Ok(None),
        _ => return Err(format!("未知资产类型：{kind}")),
    };
    Ok(std::fs::read_to_string(path).ok())
}

/// 删除专家文件；提示词可能被别的专家共用，不跟着删。
pub fn delete(home: &Path, id: &str) -> Result<(), String> {
    check_id(id)?;
    std::fs::remove_file(home.join("experts").join(format!("{id}.json"))).map_err(|error| error.to_string())
}

fn check_id(id: &str) -> Result<(), String> {
    is_valid_manifest_id(id).then_some(()).ok_or_else(|| format!("专家 id 无效：{id}（小写字母、数字、. _ -）"))
}

/// 只读展示用：单层文件名，不能借 `..` 或 `/` 逃出目录（不合规的资产也要能看，才知道该怎么改）。
fn safe_name(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && !name.contains(['/', '\\'])
}

pub fn read_expert(path: &Path) -> Result<Expert, String> {
    let text = std::fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&text).map_err(|error| error.to_string())
}

fn modified(path: &Path) -> Option<u64> {
    let time = path.metadata().ok()?.modified().ok()?;
    Some(time.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64)
}

/// 目录里不以 `.` 开头的条目，按名字排序；目录不存在时为空。
fn sorted_entries(dir: &Path) -> Result<Vec<PathBuf>, String> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Ok(Vec::new()) };
    let mut paths = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.file_name().and_then(|name| name.to_str()).is_some_and(|name| !name.starts_with('.')))
        .collect::<Vec<_>>();
    paths.sort();
    Ok(paths)
}

fn stem_with(path: &Path, extension: &str) -> Option<String> {
    (path.is_file() && path.extension()?.to_str()? == extension).then(|| path.file_stem()?.to_str().map(str::to_owned))?
}

fn stems(dir: &Path, extension: &str) -> Result<Vec<String>, String> {
    Ok(sorted_entries(dir)?.iter().filter_map(|path| stem_with(path, extension)).collect())
}

/// SKILL.md frontmatter 的 `description`：单行（可带引号）或 `>` / `|` 折行块。
fn description(text: &str) -> Option<String> {
    let mut lines = text.strip_prefix("---")?.lines().skip(1).take_while(|line| line.trim_end() != "---");
    let first = lines.by_ref().find_map(|line| line.strip_prefix("description:"))?.trim();
    let value = if first.is_empty() || first.starts_with(['>', '|']) {
        lines
            .take_while(|line| line.starts_with([' ', '\t']) || line.trim().is_empty())
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .collect::<Vec<_>>()
            .join(" ")
    } else {
        first.trim_matches(['"', '\'']).to_owned()
    };
    (!value.is_empty()).then_some(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn description_reads_inline_and_folded_values() {
        assert_eq!(description("---\nname: a\ndescription: \"Hi there\"\n---\n").as_deref(), Some("Hi there"));
        assert_eq!(
            description("---\ndescription: >-\n  one\n  two\nother: x\n---\n").as_deref(),
            Some("one two")
        );
        assert_eq!(description("no frontmatter"), None);
    }

    #[test]
    fn save_rejects_missing_assets_and_stale_writes_then_round_trips() {
        let home = tempfile::tempdir().unwrap();
        let home = home.path();
        std::fs::create_dir_all(home.join("skills/tdd")).unwrap();
        std::fs::create_dir_all(home.join("mcp")).unwrap();
        std::fs::write(home.join("mcp/context7.json"), "{}").unwrap();

        create(home, "dev", "开发").unwrap();
        assert!(create(home, "dev", "x").is_err());
        assert!(create(home, "../x", "x").is_err());

        let mut expert = Expert { name: "开发".into(), prompt: "dev".into(), skills: vec!["tdd".into()], ..Expert::default() };
        expert.mcp = vec!["nope".into()];
        assert!(save(home, "dev", &expert, None, None).is_err());
        expert.skills.push("../mcp".into());
        expert.mcp = vec!["context7".into()];
        assert!(save(home, "dev", &expert, None, None).is_err());
        expert.skills.pop();
        assert!(save(home, "dev", &expert, None, Some(1)).is_err());

        let catalog = catalog(home).unwrap();
        let stamp = catalog["experts"][0]["modified"].as_u64();
        save(home, "dev", &expert, Some("# 新提示词\n"), stamp).unwrap();
        assert_eq!(std::fs::read_to_string(home.join("prompts/dev.md")).unwrap(), "# 新提示词\n");
        assert_eq!(asset(home, "mcp", "context7").unwrap().as_deref(), Some("{}"));
        assert!(asset(home, "skills", "..").is_err());
        let text = std::fs::read_to_string(home.join("experts/dev.json")).unwrap();
        assert!(!text.contains("plugins"));
        assert_eq!(read_expert(&home.join("experts/dev.json")).unwrap(), expert);
        assert_eq!(catalog["prompts"], json!(["dev"]));
        assert_eq!(catalog["skills"][0]["id"], "tdd");

        delete(home, "dev").unwrap();
        assert!(home.join("prompts/dev.md").exists());
    }

    #[test]
    fn memory_is_per_expert_and_seed_is_overridden_not_changed() {
        let home = tempfile::tempdir().unwrap();
        let home = home.path();
        std::fs::create_dir_all(home.join("memory/dev/seed")).unwrap();
        std::fs::write(home.join("memory/dev/seed/a.md"), "---\nname: a\ndescription: 预置\n---\n\n旧\n").unwrap();
        assert_eq!(memory_list(home, "dev").unwrap()[0]["source"], "seed");

        memory_save(home, "dev", "a", "我的", "新").unwrap();
        memory_save(home, "dev", "b", "多行\n描述", "正文").unwrap();
        let list = memory_list(home, "dev").unwrap();
        assert_eq!(list[0], json!({ "name": "a", "source": "learned", "description": "我的", "body": "新" }));
        assert_eq!(list[1]["description"], "多行 描述");
        assert!(std::fs::read_to_string(home.join("memory/dev/seed/a.md")).unwrap().ends_with("旧\n"));
        let index = std::fs::read_to_string(home.join("memory/dev/MEMORY.md")).unwrap();
        assert!(index.contains("- a（learned）：我的") && index.contains("记忆是线索"));
        assert_eq!(memory_list(home, "other").unwrap(), json!([]));

        memory_delete(home, "dev", "a").unwrap();
        assert_eq!(memory_list(home, "dev").unwrap()[0]["source"], "seed", "删掉后预置的重新生效");
        assert!(memory_delete(home, "dev", "a").is_err(), "预置不能删");
        assert!(memory_save(home, "dev", "../x", "d", "b").is_err());
        assert!(memory_save(home, "../x", "a", "d", "b").is_err());
        assert!(memory_save(home, "dev", "c", " ", "b").is_err());
    }

    #[test]
    fn every_expert_gets_only_its_own_memory_once_the_tool_is_installed() {
        let home = tempfile::tempdir().unwrap();
        let home = home.path();
        let mut expert = Expert { name: "x".into(), ..Expert::default() };
        with_memory(home, "dev", &mut expert).unwrap();
        assert!(expert.mcp.is_empty() && expert.extra.is_empty(), "没装工具就不加");

        std::fs::create_dir_all(home.join("mcp")).unwrap();
        std::fs::write(home.join("mcp/expert-memory.json"), "{}").unwrap();
        assert!(catalog(home).unwrap()["mcp"].as_array().unwrap().is_empty());
        expert.extra.insert("memory".into(), json!(["other"]));
        with_memory(home, "dev", &mut expert).unwrap();
        with_memory(home, "dev", &mut expert).unwrap();
        assert_eq!(expert.mcp, ["expert-memory"]);
        assert_eq!(expert.extra["memory"], json!(["dev"]));
        assert!(issues(home, &expert).is_empty());
    }

    #[test]
    fn latest_launch_is_the_newest_for_that_terminal() {
        let home = tempfile::tempdir().unwrap();
        let dir = launches_dir(home.path());
        std::fs::create_dir_all(&dir).unwrap();
        for (name, target) in [("100-1", "a"), ("200-2", "a"), ("300-3", "b")] {
            std::fs::write(dir.join(format!("{name}.json")), json!({ "id": name, "target": target }).to_string()).unwrap();
        }
        std::fs::write(dir.join("400-4.tmp"), "not json").unwrap();
        assert_eq!(latest_launch(home.path(), "a").unwrap()["id"], "200-2");
        assert_eq!(latest_launch(home.path(), "nope").unwrap(), Value::Null);
    }

    #[test]
    fn open_fields_survive_save_and_bad_references_are_reported() {
        let home = tempfile::tempdir().unwrap();
        let home = home.path();
        for dir in ["demo/a", "skills/暴食者-skill", "tools/x"] {
            std::fs::create_dir_all(home.join(dir)).unwrap();
        }
        create(home, "dev", "开发").unwrap();
        let open: Expert = serde_json::from_str(r#"{"name":"开发","prompt":"dev","demo":["a"]}"#).unwrap();
        save(home, "dev", &open, None, None).unwrap();
        let text = std::fs::read_to_string(home.join("experts/dev.json")).unwrap();
        assert!(text.contains(r#""demo""#));
        assert_eq!(read_expert(&home.join("experts/dev.json")).unwrap(), open);

        // 不存在的开放资产拒绝保存，并报出键名（拼错字段名时靠这个发现）。
        let typo: Expert = serde_json::from_str(r#"{"name":"开发","dmeo":["a"]}"#).unwrap();
        assert!(save(home, "dev", &typo, None, None).unwrap_err().contains("dmeo/a"));

        let codes = |raw: &str| {
            let expert: Expert = serde_json::from_str(raw).unwrap();
            issues(home, &expert).into_iter().map(|issue| issue.code).collect::<Vec<_>>()
        };
        assert_eq!(codes(r#"{"name":" "}"#), ["no-name"]);
        assert_eq!(codes(r#"{"name":"x","tools":["x"]}"#), ["reserved-key"]);
        assert_eq!(codes(r#"{"name":"x","demo":"a"}"#), ["not-array"]);
        assert_eq!(codes(r#"{"name":"x","../demo":["a"]}"#), ["invalid-key"]);
        // 旧校验放过、启动却拒绝的资产，现在两边一致。
        assert_eq!(codes(r#"{"name":"x","skills":["暴食者-skill"]}"#), ["invalid-id"]);
        assert_eq!(catalog(home).unwrap()["invalid"]["skills"], json!(["暴食者-skill"]));
    }
}
