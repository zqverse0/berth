//! 专家规矩：`.berth/knowledge/专家/<专家>.md`，用户对这个专家定的长期要求，一行一条。
//! 由 Agent 在用户要求整理时从 `记录/` 提炼（`berth guide knowledge`），Berth 不自动写；
//! 启动该专家时整份附进启动说明（[`brief`]，有上限）。不算知识笔记。

use std::fs;
use std::path::Path;

use super::service::VAULT_DIR;

pub const RULES_DIR: &str = "专家";
/// 启动说明里最多附这么多行，其余提示去文件里看。
const MAX_LINES: usize = 30;

/// 规矩文件（主项目相对路径）。
pub fn rules_file(expert: &str) -> String {
    format!("{VAULT_DIR}/{RULES_DIR}/{expert}.md")
}

/// 启动说明里这个专家的规矩：去掉标题和空行；没有文件、空文件、专家名不能当文件名时为 `None`。
pub fn brief(vault_project: &Path, expert: &str) -> Option<String> {
    if expert.is_empty() || expert.starts_with('.') || expert.contains(['/', '\\']) {
        return None;
    }
    let text = fs::read_to_string(vault_project.join(rules_file(expert))).ok()?;
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim_end)
        .filter(|line| !line.trim().is_empty() && !line.starts_with('#'))
        .collect();
    if lines.is_empty() {
        return None;
    }
    let mut brief = lines.iter().take(MAX_LINES).copied().collect::<Vec<_>>().join("\n");
    if lines.len() > MAX_LINES {
        brief.push_str(&format!("\n（还有 {} 行，见文件）", lines.len() - MAX_LINES));
    }
    Some(brief)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn brief_keeps_rule_lines_and_caps_them() {
        let main = tempfile::tempdir().unwrap();
        let main = main.path();
        assert_eq!(brief(main, "dev-expert"), None);
        let file = main.join(rules_file("dev-expert"));
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, "# dev-expert\n\n- 脚本放 scripts/\n- 只用 bash\n").unwrap();
        assert_eq!(brief(main, "dev-expert").as_deref(), Some("- 脚本放 scripts/\n- 只用 bash"));
        assert_eq!(brief(main, "../x"), None);

        let many: String = (1..=35).map(|n| format!("- 规矩 {n}\n")).collect();
        fs::write(&file, many).unwrap();
        let capped = brief(main, "dev-expert").unwrap();
        assert!(capped.contains("- 规矩 30") && !capped.contains("- 规矩 31"));
        assert!(capped.ends_with("（还有 5 行，见文件）"));
    }
}
