//! 随 Berth 内置的资产：群组内置成员 Berth 用的专家「Berth 助手」（`$BERTH_HOME` 下的专家表与提示词）。
//!
//! 它是普通专家，用户可以在 设置 → 专家 里改。GUI 启动时逐个文件对齐内置版本：
//! 缺失就写入；用户没改过（内容还是上次写入的那版）就换成新版；用户改过的不动。
//! 上次写入的版本记在 `$BERTH_HOME/state/builtin.json`（文件 → 内容指纹）。

use std::collections::BTreeMap;
use std::path::Path;

use crate::error::ToolCoreError;
use crate::paths::berth_home_dir;

/// 群组内置成员 Berth 用的专家 id（`experts/<id>.json`）。
pub const EXPERT: &str = "berth-assistant";

/// 内置文件（路径相对 `$BERTH_HOME`）。
const FILES: &[(&str, &str)] = &[
    ("experts/berth-assistant.json", include_str!("../builtin/experts/berth-assistant.json")),
    ("prompts/berth-assistant.md", include_str!("../builtin/prompts/berth-assistant.md")),
];

/// 内置的提示词正文：专家表或提示词文件读不到时 Berth 用它。
pub const PROMPT: &str = include_str!("../builtin/prompts/berth-assistant.md");

/// 对齐内置文件；返回本次写入的文件。
pub fn ensure() -> Result<Vec<&'static str>, ToolCoreError> {
    ensure_in(&berth_home_dir(), FILES)
}

fn ensure_in(home: &Path, files: &[(&'static str, &str)]) -> Result<Vec<&'static str>, ToolCoreError> {
    let record_path = home.join("state").join("builtin.json");
    let mut record: BTreeMap<String, String> = std::fs::read(&record_path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    let before = record.clone();
    let mut written = Vec::new();
    for (relative, content) in files {
        let path = home.join(relative);
        let shipped = fingerprint(content);
        match std::fs::read_to_string(&path) {
            Ok(current) if current == *content => {}
            // 用户改过（或记录丢了，无从判断）：保留用户的
            Ok(current) if record.get(*relative) != Some(&fingerprint(&current)) => continue,
            Ok(_) | Err(_) => {
                if let Some(parent) = path.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                std::fs::write(&path, content)?;
                written.push(*relative);
            }
        }
        record.insert((*relative).to_owned(), shipped);
    }
    if record != before {
        std::fs::create_dir_all(home.join("state"))?;
        let text = serde_json::to_string_pretty(&record).map_err(|error| ToolCoreError::Io(error.to_string()))?;
        std::fs::write(&record_path, text + "\n")?;
    }
    Ok(written)
}

/// 内容指纹（FNV-1a 64）：只用来认出「还是上次写入的那版」，跨版本稳定。
fn fingerprint(text: &str) -> String {
    let hash = text.bytes().fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(0x0000_0100_0000_01b3)
    });
    format!("{hash:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_missing_upgrades_untouched_and_keeps_user_edits() {
        let home = tempfile_dir();
        let v1: &[(&str, &str)] = &[("prompts/a.md", "v1"), ("prompts/b.md", "v1")];
        assert_eq!(ensure_in(&home, v1).unwrap(), ["prompts/a.md", "prompts/b.md"]);
        assert!(ensure_in(&home, v1).unwrap().is_empty());

        // 用户改了 b；新版本发布：a 换新，b 保留用户的
        std::fs::write(home.join("prompts/b.md"), "mine").unwrap();
        let v2: &[(&str, &str)] = &[("prompts/a.md", "v2"), ("prompts/b.md", "v2")];
        assert_eq!(ensure_in(&home, v2).unwrap(), ["prompts/a.md"]);
        assert_eq!(std::fs::read_to_string(home.join("prompts/a.md")).unwrap(), "v2");
        assert_eq!(std::fs::read_to_string(home.join("prompts/b.md")).unwrap(), "mine");

        // 删掉的补回来
        std::fs::remove_file(home.join("prompts/a.md")).unwrap();
        assert_eq!(ensure_in(&home, v2).unwrap(), ["prompts/a.md"]);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn builtin_expert_points_at_its_prompt() {
        let expert: serde_json::Value = serde_json::from_str(FILES[0].1).unwrap();
        assert_eq!(FILES[0].0, format!("experts/{EXPERT}.json"));
        assert_eq!(FILES[1].0, format!("prompts/{}.md", expert["prompt"].as_str().unwrap()));
    }

    fn tempfile_dir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("berth-builtin-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
}
