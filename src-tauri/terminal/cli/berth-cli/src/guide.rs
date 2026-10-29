//! `berth guide`：给 Agent 的操作说明，两层拼在一起。
//!
//! - 内置：随 CLI 发布（`brief.md`、`guide.md`、`knowledge.md`），最直白的命令、格式与步骤，与 CLI 版本一致。
//! - 用户补充：`~/.berth/guides/<主题>.md`（可没有），原样附在内置之后，用来优化 Agent 行为、补充理解；
//!   与内置冲突时以内置为准。只有用户补充的文件也是一个主题。`brief.md` / `guide.md` 补充
//!   `berth guide --brief` / `berth guide`。

use std::path::PathBuf;

use clap::Parser;

use crate::{Cli, Command};

/// 内置主题（不含 brief / guide 本身）。
const BUILTIN: &[(&str, &str)] = &[("knowledge", include_str!("knowledge.md"))];
/// 补充默认输出、不作为主题列出的文件名。
const DEFAULT_PARTS: [&str; 2] = ["brief", "guide"];

fn user_dir() -> PathBuf {
    berth_tool_core::paths::berth_home_dir().join("guides")
}

/// 用户补充（空文件当作没有）。
fn supplement(topic: &str) -> Option<(PathBuf, String)> {
    let path = user_dir().join(format!("{topic}.md"));
    let text = std::fs::read_to_string(&path).ok()?;
    let text = text.trim();
    (!text.is_empty()).then(|| (path, text.to_owned()))
}

/// 内置文本后面附上 `topic` 的用户补充。
pub(crate) fn with_supplement(topic: &str, builtin: &str) -> String {
    match supplement(topic) {
        Some((path, text)) => format!(
            "{}\n\n## 用户补充（{}；与上文冲突时以上文为准）\n\n{text}\n",
            builtin.trim_end(),
            path.display()
        ),
        None => builtin.to_owned(),
    }
}

/// 全部主题：(名称, 来源)。
fn topics() -> Vec<(String, &'static str)> {
    let mut names = std::fs::read_dir(user_dir())
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            name.strip_suffix(".md").map(str::to_owned)
        })
        .filter(|name| !DEFAULT_PARTS.contains(&name.as_str()))
        .collect::<Vec<_>>();
    names.extend(BUILTIN.iter().map(|(name, _)| (*name).to_owned()));
    names.sort();
    names.dedup();
    names
        .into_iter()
        .map(|name| {
            let builtin = BUILTIN.iter().any(|(topic, _)| *topic == name);
            let source = match (builtin, supplement(&name).is_some()) {
                (true, true) => "内置 + 用户补充",
                (true, false) => "内置",
                (false, _) => "用户",
            };
            (name, source)
        })
        .collect()
}

/// 主题列表，附在 `berth guide` 末尾。
pub(crate) fn topic_index() -> String {
    let mut text = format!(
        "\n## 主题\n\n`berth guide <主题>` 阅读；用户补充放在 {}/<主题>.md。\n\n",
        user_dir().display()
    );
    for (name, source) in topics() {
        text.push_str(&format!("- {name}（{source}）\n"));
    }
    text
}

/// `berth guide <主题>`
pub(crate) fn topic(name: &str) -> Result<String, String> {
    let builtin = BUILTIN.iter().find(|(topic, _)| *topic == name).map(|(_, text)| *text);
    match (builtin, supplement(name)) {
        (Some(text), _) => Ok(with_supplement(name, text)),
        (None, Some((_, text))) => Ok(format!("{text}\n")),
        (None, None) => Err(format!(
            "没有主题「{name}」；可用：{}",
            topics().into_iter().map(|(name, _)| name).collect::<Vec<_>>().join("、")
        )),
    }
}

/// `berth guide --check`：用户补充里写的 `berth …` 命令当前 CLI 都能解析。返回问题行。
pub(crate) fn check() -> Vec<String> {
    let mut problems = Vec::new();
    let files = std::fs::read_dir(user_dir())
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "md"));
    for path in files {
        let Ok(text) = std::fs::read_to_string(&path) else { continue };
        for command in documented_commands(&text) {
            if let Err(error) = parse_documented(&command) {
                let reason = error.lines().next().unwrap_or_default().to_owned();
                problems.push(format!("{}: {command}\n    {reason}", path.display()));
            }
        }
    }
    problems
}

/// 说明文本里的命令：代码块中以 berth 开头的行（去掉行尾注释），以及反引号包着的 berth 命令。
pub(crate) fn documented_commands(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut fenced = false;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("```") {
            fenced = !fenced;
            continue;
        }
        if fenced {
            if trimmed.starts_with("berth ") {
                let command = trimmed.split(" # ").next().unwrap_or(trimmed);
                out.push(command.trim().to_owned());
            }
            continue;
        }
        out.extend(
            line.split('`')
                .skip(1)
                .step_by(2)
                .filter(|span| span.starts_with("berth "))
                .map(str::to_owned),
        );
    }
    out
}

/// 按 shell 规则拆参数；`<占位>` 换成 `x`，管道 / 重定向之后的部分丢掉。
fn documented_argv(command: &str) -> Vec<String> {
    let mut text = String::new();
    let mut rest = command;
    while let Some(start) = rest.find('<') {
        let Some(end) = rest[start..].find('>') else { break };
        text.push_str(&rest[..start]);
        text.push('x');
        rest = &rest[start + end + 1..];
    }
    text.push_str(rest);
    for operator in [" | ", " > ", " && "] {
        if let Some(index) = text.find(operator) {
            text.truncate(index);
        }
    }
    let mut argv = Vec::new();
    let mut current = String::new();
    let mut quote = None;
    for ch in text.chars() {
        match (quote, ch) {
            (None, '"' | '\'') => quote = Some(ch),
            (Some(open), _) if ch == open => quote = None,
            (None, ch) if ch.is_whitespace() => {
                if !current.is_empty() {
                    argv.push(std::mem::take(&mut current));
                }
            }
            _ => current.push(ch),
        }
    }
    if !current.is_empty() {
        argv.push(current);
    }
    argv
}

/// 一条说明里的命令能否被当前 CLI 解析。
pub(crate) fn parse_documented(command: &str) -> Result<(), String> {
    use clap::error::ErrorKind;
    let argv = crate::split_project_scope(
        documented_argv(command).into_iter().map(Into::into).collect(),
    )
    .1
    .into_iter()
    .map(|arg| arg.to_string_lossy().into_owned())
    .collect::<Vec<_>>();
    // 正文里只提命令名（如 `berth task`、`berth terminal send`）时允许缺子命令 / 参数；带了参数就必须完整。
    let bare = argv.iter().all(|arg| {
        arg.chars().all(|ch| ch.is_ascii_lowercase() || ch == '-') && !arg.starts_with('-')
    });
    let accept = |error: clap::Error| match error.kind() {
        ErrorKind::DisplayHelp | ErrorKind::DisplayVersion => Ok(()),
        ErrorKind::MissingSubcommand
        | ErrorKind::MissingRequiredArgument
        | ErrorKind::DisplayHelpOnMissingArgumentOrSubcommand
            if bare =>
        {
            Ok(())
        }
        _ => Err(error.to_string()),
    };
    let cli = match Cli::try_parse_from(&argv) {
        Ok(cli) => cli,
        Err(error) => return accept(error),
    };
    if let Command::Group { args } = cli.command {
        let mut inner = vec![std::ffi::OsString::from("berth group")];
        inner.extend(args);
        if let Err(error) = crate::group::GroupArgs::try_parse_from(inner) {
            return accept(error);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_supplements_follow_builtin_and_add_topics() {
        let home = tempfile::tempdir().unwrap();
        let previous = std::env::var_os("BERTH_HOME");
        std::env::set_var("BERTH_HOME", home.path());
        let guides = home.path().join("guides");
        std::fs::create_dir_all(&guides).unwrap();
        std::fs::write(guides.join("knowledge.md"), "讨论想法时先给三个方案\n").unwrap();
        std::fs::write(guides.join("review.md"), "用 `berth project . knowledge nope`\n").unwrap();
        std::fs::write(guides.join("brief.md"), "").unwrap();

        let knowledge = topic("knowledge").unwrap();
        assert!(knowledge.starts_with("# 项目知识库"));
        assert!(knowledge.trim_end().ends_with("讨论想法时先给三个方案"));
        assert!(topic("review").unwrap().contains("knowledge nope"));
        assert!(topic("missing").is_err());
        let names = topics();
        assert_eq!(
            names,
            [("knowledge".to_owned(), "内置 + 用户补充"), ("review".to_owned(), "用户")]
        );
        // 空补充当作没有。
        assert_eq!(with_supplement("brief", "x"), "x");
        let problems = check();
        assert_eq!(problems.len(), 1, "{problems:?}");
        assert!(problems[0].contains("review.md"));

        match previous {
            Some(value) => std::env::set_var("BERTH_HOME", value),
            None => std::env::remove_var("BERTH_HOME"),
        }
    }
}
