//! 设置 →「专家」：`<home>/experts/<id>.json` 的读写，以及它引用的资产候选
//! （`prompts/*.md`、`skills/<id>/`、`mcp/*.json`、`plugins/<id>/`）。
//!
//! 字段与宿主读专家的 `berth-plugin-api::agent` 一致：`name`、`prompt`、`skills`、`mcp`、`plugins`；
//! 启动时由宿主解析后交给 launch.js，这里只负责让用户不手改 JSON 也能装配。

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
        experts.push(json!({ "id": id, "expert": expert, "promptText": prompt, "modified": modified(&path), "error": error }));
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
    Ok(json!({
        "home": home,
        "experts": experts,
        "prompts": stems(&home.join("prompts"), "md")?,
        "skills": skills,
        "mcp": stems(&home.join("mcp"), "json")?,
        "plugins": sorted_entries(&home.join("plugins"))?
            .into_iter()
            .filter(|path| path.is_dir())
            .filter_map(|path| path.file_name()?.to_str().map(str::to_owned))
            .collect::<Vec<_>>(),
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
    if let Some(text) = prompt_text {
        if expert.prompt.is_empty() {
            expert.prompt = id.to_owned();
        }
        if !safe_name(&expert.prompt) {
            return Err(format!("提示词名无效：{}", expert.prompt));
        }
        std::fs::create_dir_all(home.join("prompts")).map_err(|error| error.to_string())?;
        std::fs::write(home.join("prompts").join(format!("{}.md", expert.prompt)), text)
            .map_err(|error| error.to_string())?;
    }
    if !expert.prompt.is_empty() && !home.join("prompts").join(format!("{}.md", expert.prompt)).is_file() {
        return Err(format!("提示词 {} 不存在", expert.prompt));
    }
    for (dir, items, suffix) in
        [("skills", &expert.skills, ""), ("mcp", &expert.mcp, ".json"), ("plugins", &expert.plugins, "")]
    {
        if let Some(missing) = items.iter().find(|item| !safe_name(item) || !home.join(dir).join(format!("{item}{suffix}")).exists()) {
            return Err(format!("{dir}/{missing} 不存在"));
        }
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

/// 资产名只能是单层文件名，不能借 `..` 或 `/` 逃出目录。
fn safe_name(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && !name.contains(['/', '\\'])
}

fn read_expert(path: &Path) -> Result<Expert, String> {
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
}
