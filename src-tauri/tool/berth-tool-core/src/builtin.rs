//! 随 Berth 内置的资产：群组内置成员 Berth 用的「工具专家」提示词（`$BERTH_HOME` 下的专家表与提示词）。
//!
//! 文件编进程序，GUI 启动时按「单元」补齐：单元不存在才写入，已存在一律不动——用户改过的保留。

use std::path::Path;

use crate::error::ToolCoreError;
use crate::paths::berth_home_dir;

/// 一个内置单元：`root` 下的 `unit`（目录或文件）缺失时写入 `files`（路径相对 `root`）。
struct Unit {
    unit: &'static str,
    files: &'static [(&'static str, &'static str)],
}

/// 专家表与提示词各是一个单元（`$BERTH_HOME` 下的文件）。
const HOME_FILES: &[Unit] = &[
    Unit {
        unit: "experts/tool-expert.json",
        files: &[("experts/tool-expert.json", include_str!("../builtin/experts/tool-expert.json"))],
    },
    Unit {
        unit: "prompts/tool-expert.md",
        files: &[("prompts/tool-expert.md", include_str!("../builtin/prompts/tool-expert.md"))],
    },
];

/// 补齐缺失的内置资产；返回本次写入的单元。
// ponytail: 已存在就不升级；内置提示词改版时再定是否替换（会覆盖用户改动）。
pub fn ensure() -> Result<Vec<&'static str>, ToolCoreError> {
    let mut written = Vec::new();
    for unit in HOME_FILES {
        if write_unit(&berth_home_dir(), unit)? {
            written.push(unit.unit);
        }
    }
    Ok(written)
}

fn write_unit(root: &Path, unit: &Unit) -> Result<bool, ToolCoreError> {
    if root.join(unit.unit).symlink_metadata().is_ok() {
        return Ok(false);
    }
    for (relative, content) in unit.files {
        let path = root.join(relative);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&path, content)?;
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::TEST_ENV_LOCK;

    #[test]
    fn builtin_units_are_written_once_and_never_overwritten() {
        let lock = TEST_ENV_LOCK.get_or_init(|| std::sync::Mutex::new(()));
        let _guard = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let home = tempfile_dir();
        std::env::set_var("BERTH_HOME", &home);

        assert_eq!(
            ensure().unwrap(),
            ["experts/tool-expert.json", "prompts/tool-expert.md"]
        );
        let expert: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(home.join("experts/tool-expert.json")).unwrap(),
        )
        .unwrap();
        let prompt = expert["prompt"].as_str().unwrap();
        assert!(home.join(format!("prompts/{prompt}.md")).is_file());

        // 用户改过提示词：不覆盖。
        std::fs::write(home.join("prompts/tool-expert.md"), "mine").unwrap();
        assert!(ensure().unwrap().is_empty());
        assert_eq!(std::fs::read_to_string(home.join("prompts/tool-expert.md")).unwrap(), "mine");

        std::env::remove_var("BERTH_HOME");
        let _ = std::fs::remove_dir_all(&home);
    }

    fn tempfile_dir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("berth-builtin-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
}
