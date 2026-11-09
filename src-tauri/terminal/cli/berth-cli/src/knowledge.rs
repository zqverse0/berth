//! `berth knowledge root|search|for|show|lint|digest|inbox`：知识库只有主项目一份，所有命令在 worktree 里也解析到它。
//! 体检在 `berth_project_core::knowledge`（与 GUI 记忆面板同一实现）；
//! 会话摘要经控制面请求 GUI 的项目会话浏览器生成（`knowledge.digest`）。

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use berth_control_proto::KnowledgeDigestParams;
use berth_project_core::knowledge::inbox;
use berth_project_core::knowledge::model::SearchHit;
use berth_project_core::{knowledge, tasks};

use crate::{gui_client, CliError};

/// 整理会话的游标文件（相对项目根）；Agent 全部写完后才推进。
const CURSOR_FILE: &str = ".berth/knowledge/.curation.json";

fn current_dir() -> Result<PathBuf, String> {
    std::env::current_dir().map_err(|error| error.to_string())
}

/// 当前目录所在项目：`checkout` 是代码所在，`main` 是知识库所在（worktree 共用主项目）。
fn scope(cwd: &Path) -> Result<tasks::Scope, String> {
    tasks::resolve(cwd).map_err(|error| error.message)
}

/// 知识库所在的主项目。
fn vault_project(cwd: &Path) -> Result<PathBuf, String> {
    Ok(scope(cwd)?.main)
}

/// `berth knowledge root`
pub(crate) fn root() -> Result<PathBuf, String> {
    Ok(vault_project(&current_dir()?)?.join(".berth/knowledge"))
}

/// 当前目录所在项目的主项目（`inbox` 子命令用）。
pub(crate) fn root_project() -> Result<PathBuf, String> {
    vault_project(&current_dir()?)
}

/// `berth knowledge inbox ls`
pub(crate) fn inbox_ls(root: &Path, json: bool) -> Result<(), String> {
    let items = inbox::list(root).map_err(|error| error.to_string())?;
    if json {
        return print_json(&serde_json::json!({ "count": items.len(), "items": items }));
    }
    println!("待入库 {} 条", items.len());
    for item in &items {
        println!(
            "{}  [{} · {} · {}] {}",
            item.source, item.kind, item.result, item.archived_at, item.title
        );
    }
    Ok(())
}

/// `berth knowledge inbox add`
pub(crate) fn inbox_add(
    root: &Path,
    kind: &str,
    source: &str,
    title: &str,
    result: &str,
    body: &str,
) -> Result<(), String> {
    let item = inbox::add(root, kind, source, title, result, body).map_err(|error| error.to_string())?;
    print_json(&item)
}

/// `berth knowledge inbox remove`
pub(crate) fn inbox_remove(root: &Path, source: &str) -> Result<(), String> {
    let removed = inbox::remove(root, source).map_err(|error| error.to_string())?;
    print_json(&serde_json::json!({ "removed": removed }))
}

/// `berth knowledge inbox done`
pub(crate) fn inbox_done(root: &Path, source: &str, outcome: &str) -> Result<(), String> {
    let path = inbox::done(root, source, outcome).map_err(|error| error.to_string())?;
    print_json(&serde_json::json!({ "path": path }))
}

/// 检索文本输出的上限：Agent 每次查询只花这么多上下文。
const SEARCH_BUDGET: usize = 2048;

fn print_json(value: &impl serde::Serialize) -> Result<(), String> {
    println!(
        "{}",
        serde_json::to_string(value).map_err(|error| error.to_string())?
    );
    Ok(())
}

/// `berth knowledge search`
pub(crate) fn search(
    query: &str,
    note_type: Option<&str>,
    limit: usize,
    json: bool,
) -> Result<(), String> {
    let root = vault_project(&current_dir()?)?;
    let hits =
        knowledge::find(&root, query, note_type, limit).map_err(|error| error.to_string())?;
    if json {
        return print_json(&serde_json::json!({ "hits": hits }));
    }
    let words = query.to_lowercase();
    let words = words.split_whitespace().collect::<Vec<_>>();
    print!("{}", format_hits(&hits, &words));
    Ok(())
}

fn clip(text: &str, max: usize) -> String {
    let mut chars = text.chars();
    let head = chars.by_ref().take(max).collect::<String>();
    if chars.next().is_some() {
        format!("{head}…")
    } else {
        head
    }
}

const FOOTER: &str = "（读全文：berth project . knowledge show <标题>）\n";

/// 每条两三行（摘要里已看得到检索词时不再给片段）；超过 `SEARCH_BUDGET` 就停，提示还剩几条。
fn format_hits(hits: &[SearchHit], words: &[&str]) -> String {
    if hits.is_empty() {
        return "没有命中；换个词或去掉 --type。\n".to_owned();
    }
    let mut out = String::new();
    for (index, hit) in hits.iter().enumerate() {
        let status = if hit.status == "已确认" {
            String::new()
        } else {
            format!(" · {}", hit.status)
        };
        let excerpt = clip(&hit.excerpt, 60);
        let mut entry = format!("{}  [{}{status}]\n  {excerpt}\n", hit.title, hit.note_type);
        let shown = excerpt.to_lowercase();
        if let Some(snippet) = hit
            .snippet
            .as_ref()
            .filter(|_| !words.iter().any(|word| shown.contains(word)))
        {
            entry.push_str(&format!("  > {snippet}\n"));
        }
        let rest = format!("…还有 {} 条，加词或 --type 缩小范围\n", hits.len() - index);
        if out.len() + entry.len() + rest.len() + FOOTER.len() > SEARCH_BUDGET {
            out.push_str(&rest);
            break;
        }
        out.push_str(&entry);
    }
    out.push_str(FOOTER);
    out
}

/// `berth knowledge for`：`path` 可以是绝对路径或相对当前目录，换算成仓库相对路径再查。
pub(crate) fn covering(path: &str, json: bool) -> Result<(), String> {
    let cwd = current_dir()?;
    let tasks::Scope { checkout, main } = scope(&cwd)?;
    let absolute = cwd.join(path);
    let relative = absolute
        .strip_prefix(&checkout)
        .map_err(|_| format!("{path} 不在本项目内"))?
        .to_string_lossy()
        .replace('\\', "/");
    let hits = knowledge::covering(&main, &relative).map_err(|error| error.to_string())?;
    if json {
        return print_json(&serde_json::json!({ "path": relative, "hits": hits }));
    }
    if hits.is_empty() {
        println!("没有笔记关联 {relative}；可以用 berth project . knowledge search 按模块名再查。");
        return Ok(());
    }
    print!("{}", format_hits(&hits, &[]));
    Ok(())
}

/// `berth knowledge show`
pub(crate) fn show(name: &str, links: bool, json: bool) -> Result<(), String> {
    let root = vault_project(&current_dir()?)?;
    let view = knowledge::show(&root, name)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| {
            format!("没有标题或别名为「{name}」的笔记；先用 berth project . knowledge search 找")
        })?;
    if json {
        return print_json(&view);
    }
    if !links {
        let verified = view
            .verified_at
            .as_deref()
            .map(|sha| format!(" · verified_at {sha}"))
            .unwrap_or_default();
        println!(
            "<!-- {} · {} · {}{verified} -->",
            view.path, view.note_type, view.status
        );
        if !view.code.is_empty() {
            println!("<!-- code: {} -->", view.code.join(", "));
        }
        println!("{}", view.body.trim_end());
        println!();
    }
    for (label, titles) in [
        ("链接到", &view.outgoing),
        ("被引用", &view.backlinks),
        ("断链", &view.broken),
    ] {
        if !titles.is_empty() {
            println!("{label}：{}", titles.join("、"));
        }
    }
    Ok(())
}

/// `berth knowledge lint`：返回退出码，有 ERROR 为 1。
pub(crate) fn lint(json: bool) -> Result<i32, String> {
    let cwd = current_dir()?;
    let tasks::Scope {
        checkout,
        main: root,
    } = scope(&cwd)?;
    let mut report = knowledge::lint(&root).map_err(|error| error.to_string())?;
    report.warnings.extend(
        knowledge::worktree_changes(&checkout, &root)
            .into_iter()
            .map(|path| {
                format!(
                    "{path}: worktree 分支改了知识库，改写到 `berth project . knowledge root` 并在本分支撤销"
                )
            }),
    );
    if json {
        println!(
            "{}",
            serde_json::to_string(&report).map_err(|error| error.to_string())?
        );
    } else {
        for line in &report.errors {
            println!("ERROR  {line}");
        }
        for line in &report.warnings {
            println!("WARN   {line}");
        }
        println!(
            "---\nnotes: {}  errors: {}  warnings: {}  drafts: {}",
            report.notes,
            report.errors.len(),
            report.warnings.len(),
            report.drafts
        );
    }
    Ok(i32::from(!report.errors.is_empty()))
}

/// `berth knowledge digest`：游标之后的会话摘要，默认游标取 `.berth/knowledge/.curation.json` 的 `since`。
pub(crate) fn digest(
    gui: Option<&OsString>,
    since: Option<String>,
    json: bool,
) -> Result<(), CliError> {
    let cwd = current_dir().map_err(CliError::from_runtime)?;
    let root = vault_project(&cwd).map_err(CliError::from_runtime)?;
    let since = since.or_else(|| {
        let text = std::fs::read_to_string(root.join(CURSOR_FILE)).ok()?;
        let value: serde_json::Value = serde_json::from_str(&text).ok()?;
        value.get("since")?.as_str().map(str::to_owned)
    });
    let result = gui_client::knowledge_digest(
        gui,
        &KnowledgeDigestParams {
            path: root.display().to_string(),
            since,
        },
    )
    .map_err(|error| CliError::from_gui(error, json))?;
    if json {
        let encoded = serde_json::to_string(&result).map_err(CliError::from_runtime)?;
        println!("{encoded}");
        return Ok(());
    }
    for session in &result.sessions {
        println!(
            "## {}:{}  ({}, {})\n",
            session.agent, session.id, session.started_at, session.cwd
        );
        if let Some(title) = &session.title {
            println!("标题：{title}\n");
        }
        for message in &session.messages {
            let role = if message.role == "user" { "U" } else { "A" };
            println!("{role}: {}", message.text);
        }
        println!();
    }
    println!(
        "---\nsessions: {}\nnext_since: {}",
        result.sessions.len(),
        result.next_since
    );
    if result.truncated {
        println!(
            "truncated: true（超出单次预算；处理完后用 --since {} 继续）",
            result.next_since
        );
    }
    for item in &result.skipped {
        println!("skipped: {item}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_output_stays_within_budget() {
        let long = "很长的摘要".repeat(40);
        let hits = (0..30)
            .map(|index| SearchHit {
                title: format!("笔记{index}"),
                note_type: "概念".into(),
                status: if index == 0 { "草稿" } else { "已确认" }.into(),
                excerpt: long.clone(),
                snippet: Some(format!("…{}…", "命中".repeat(24))),
            })
            .collect::<Vec<_>>();
        let out = format_hits(&hits, &["命中"]);
        assert!(out.len() <= SEARCH_BUDGET, "{}", out.len());
        assert!(out.starts_with("笔记0  [概念 · 草稿]\n"));
        assert!(out.contains("…还有 "));
        assert!(out.contains("  > …命中"));
        // 摘要里已出现检索词就不再给片段。
        let one = format_hits(&hits[..1], &["摘要"]);
        assert!(!one.contains("  > ") && one.ends_with("show <标题>）\n"));
    }
}
