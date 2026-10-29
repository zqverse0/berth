//! 任务的派生视图：状态、步骤、提交、改动都从 git 和 prd 算出，不依赖手填。

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

use super::file;
use super::group;
use super::fsutil::{self, MAX_ARTIFACT_BYTES};
use super::git;
use super::state::Live;
use super::TaskResult;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ChecklistItem {
    pub text: String,
    pub checked: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Commit {
    pub hash: String,
    pub subject: String,
    pub step: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Step {
    pub text: String,
    pub checked: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub state: &'static str,
    pub commit: Option<Commit>,
    /// 单文件任务：改哪里、怎么验证。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub change: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verify: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Acceptance {
    pub done: usize,
    pub total: usize,
    pub items: Vec<ChecklistItem>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct HistoryEntry {
    pub hash: String,
    pub date: String,
    pub subject: String,
}

/// 与旧 `berth task show/views` 同一 JSON 形态（GUI `BerthTaskView`）。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskView {
    pub task_dir_name: String,
    pub title: String,
    /// 来源想法 id（单文件任务 frontmatter 的 `idea`）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub idea: Option<String>,
    pub state: &'static str,
    pub archived: bool,
    /// 未合并就放弃收尾的已完成任务。
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub abandoned: bool,
    /// 取消归档的任务：`Some("")` 表示没写原因；正常完成为空。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cancel_reason: Option<String>,
    pub prd: String,
    pub prd_text: String,
    pub branch: Option<String>,
    pub base_branch: Option<String>,
    pub worktree: Option<String>,
    /// 所属群组（缺省 `main`）；由 ops 按群组填充。
    pub group: String,
    pub dirty_files: usize,
    /// base 上有、分支还没有的提交数（该 rebase / 合并 base 了）。
    pub behind: usize,
    pub acceptance: Acceptance,
    pub steps: Vec<Step>,
    pub current_step: Option<String>,
    pub commits: Vec<Commit>,
    pub unlinked_commits: usize,
    pub diffstat: String,
    /// 动过任务目录的最近提交：没绑分支的任务也能看到做过什么。
    pub history: Vec<HistoryEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run: Option<String>,
}

/// prd 里的（步骤，验收）两组勾选项：按标题含「步骤 / Steps」「验收 / Acceptance」区分，任何标题都切换段落。
pub(crate) fn checklists(text: &str) -> (Vec<Step>, Vec<ChecklistItem>) {
    #[derive(PartialEq)]
    enum Section {
        Steps,
        Accept,
        Other,
    }
    let mut section = Section::Other;
    let mut steps = Vec::new();
    let mut accept = Vec::new();
    for line in text.lines() {
        if line.starts_with('#') {
            let heading = line.trim_start_matches('#').trim().to_lowercase();
            section = if heading.contains("步骤") || heading.contains("steps") {
                Section::Steps
            } else if heading.contains("验收") || heading.contains("acceptance") {
                Section::Accept
            } else {
                Section::Other
            };
            continue;
        }
        let Some((checked, text)) = checkbox(line) else {
            continue;
        };
        match section {
            Section::Steps => steps.push(Step {
                id: step_id(&text),
                text,
                checked,
                state: "todo",
                commit: None,
                change: None,
                verify: None,
            }),
            Section::Accept => accept.push(ChecklistItem { text, checked }),
            Section::Other => {}
        }
    }
    (steps, accept)
}

/// `- [ ] 文本` / `* [x] 文本`
pub(super) fn checkbox(line: &str) -> Option<(bool, String)> {
    let rest = line.trim_start().strip_prefix(['-', '*'])?;
    let rest = rest.strip_prefix(char::is_whitespace)?.trim_start();
    let rest = rest.strip_prefix('[')?;
    let mark = rest.chars().next()?;
    let checked = match mark {
        ' ' => false,
        'x' | 'X' => true,
        _ => return None,
    };
    let rest = rest[mark.len_utf8()..].strip_prefix(']')?;
    let rest = rest.strip_prefix(char::is_whitespace)?;
    let text = rest.trim();
    (!text.is_empty()).then(|| (checked, text.to_owned()))
}

/// 行首的 `S<数字>`（后面是边界）
pub(super) fn step_id(text: &str) -> Option<String> {
    let digits: String = text
        .strip_prefix('S')?
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    if digits.is_empty() {
        return None;
    }
    let after = text[1 + digits.len()..].chars().next();
    if after.is_some_and(|ch| ch.is_alphanumeric() || ch == '_') {
        return None;
    }
    Some(format!("S{digits}"))
}

/// 提交正文里的 `Task: <任务> S<n>` 尾注。
fn trailer_step(body: &str) -> Option<String> {
    body.lines().find_map(|line| {
        let rest = line.strip_prefix("Task:")?.trim_start();
        let mut words = rest.split_whitespace();
        words.next()?;
        step_id(words.next()?)
    })
}

pub(crate) fn commits(root: &Path, spec: &[&str]) -> Vec<Commit> {
    let mut args = vec!["log"];
    args.extend_from_slice(spec);
    args.push("--format=%h%x1f%s%x1f%b%x1e");
    let Some(output) = git::run(root, &args).filter(|output| output.status.success()) else {
        return Vec::new();
    };
    String::from_utf8_lossy(&output.stdout)
        .split('\x1e')
        .filter_map(|chunk| {
            let parts: Vec<&str> = chunk.trim_matches('\n').split('\x1f').collect();
            match parts.as_slice() {
                [hash, subject, body] if !hash.trim().is_empty() => Some(Commit {
                    hash: hash.trim().to_owned(),
                    subject: (*subject).to_owned(),
                    step: trailer_step(body),
                }),
                _ => None,
            }
        })
        .collect()
}

pub(crate) fn record_title(record: &Value, dir_name: &str) -> String {
    record
        .get("title")
        .and_then(Value::as_str)
        .filter(|title| !title.is_empty())
        .unwrap_or(dir_name)
        .to_owned()
}

/// `root`：任一 checkout（git 命令用）；`directory`：任务目录或单文件任务；`live`：实时状态。
pub(crate) fn build(
    root: &Path,
    directory: &Path,
    record: &Value,
    live: &Live,
    archived: bool,
) -> TaskResult<TaskView> {
    let single = file::is_file_task(directory);
    let dir_name = if single { directory.file_stem() } else { directory.file_name() }
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let prd = if single { directory.to_path_buf() } else { directory.join("prd.md") };
    let prd_text = if single {
        file::body(&file::read(directory)?).to_owned()
    } else if prd.is_file() {
        fsutil::read_text(&prd, MAX_ARTIFACT_BYTES)?
    } else {
        String::new()
    };
    let (mut steps, accept) = checklists(&prd_text);
    if single {
        // 单文件任务的步骤在 frontmatter；正文里的勾选项只算验收。
        steps = file::steps(record)?
            .into_iter()
            .map(|step| Step {
                checked: step.commit.is_some(),
                commit: step.commit.map(|hash| Commit {
                    hash,
                    subject: String::new(),
                    step: Some(step.id.clone()),
                }),
                id: Some(step.id),
                text: step.action,
                state: "todo",
                change: Some(step.change),
                verify: Some(step.verify),
            })
            .collect();
    }
    let branch = live.branch.clone();
    let base_branch = live.base_branch.clone();
    let mut ahead = Vec::new();
    let merged: Vec<Commit>;
    let mut diffstat = String::new();
    // 群登记的 worktree 为准；分支反查只兜底（detached HEAD、worktree 里换过分支时反查不到）。
    let mut worktree = live
        .worktree
        .as_deref()
        .map(PathBuf::from)
        .filter(|path| path.is_dir());
    let mut dirty_files = 0;
    let mut behind = 0;
    if let (Some(branch), Some(base)) = (branch.as_deref(), base_branch.as_deref()) {
        ahead = commits(root, &[&format!("{base}..{branch}")]);
        behind = git::stdout(root, &["rev-list", "--count", &format!("{branch}..{base}")])
            .and_then(|out| out.trim().parse().ok())
            .unwrap_or(0);
        let grep = format!("--grep=^Task: {dir_name} ");
        merged = commits(root, &[base, &grep])
            .into_iter()
            .filter(|commit| commit.step.is_some())
            .collect();
        diffstat = git::stdout(
            root,
            &["diff", "--shortstat", &format!("{base}...{branch}")],
        )
        .unwrap_or_default();
        worktree = worktree.or_else(|| {
            git::worktrees(root)
                .into_iter()
                .find(|candidate| candidate.branch.as_deref() == Some(branch))
                .map(|candidate| candidate.path)
                .filter(|path| path.is_dir())
        });
    } else {
        // 没绑分支（在主目录直接做）：当前分支上带尾注的提交就是已落地的步骤。
        let grep = format!("--grep=^Task: {dir_name} ");
        merged = commits(root, &["HEAD", &grep])
            .into_iter()
            .filter(|commit| commit.step.is_some())
            .collect();
    }
    if let Some(path) = &worktree {
        dirty_files = git::stdout(path, &["status", "--porcelain"])
            .map(|out| out.lines().filter(|line| !line.trim().is_empty()).count())
            .unwrap_or(0);
    }
    let history = git::stdout(
        root,
        &[
            "log",
            "-n",
            "15",
            "--format=%h%x1f%cs%x1f%s",
            "--",
            &directory.to_string_lossy(),
        ],
    )
    .map(|out| {
        out.lines()
            .filter_map(|line| {
                let parts: Vec<&str> = line.split('\x1f').collect();
                match parts.as_slice() {
                    [hash, date, subject] => Some(HistoryEntry {
                        hash: (*hash).to_owned(),
                        date: (*date).to_owned(),
                        subject: (*subject).to_owned(),
                    }),
                    _ => None,
                }
            })
            .collect()
    })
    .unwrap_or_default();

    let merged_hashes: Vec<&str> = merged.iter().map(|commit| commit.hash.as_str()).collect();
    for step in &mut steps {
        // 与旧脚本一致：未合并的提交优先（合并后又补了提交，步骤回到「已提交」），同组内取最早的。
        let commit = step.id.as_deref().and_then(|id| {
            ahead
                .iter()
                .rev()
                .chain(merged.iter().rev())
                .find(|commit| commit.step.as_deref() == Some(id))
        });
        step.state = match commit {
            Some(commit) if merged_hashes.contains(&commit.hash.as_str()) => "merged",
            Some(_) => "committed",
            None => "todo",
        };
        // 文件里记了提交但 git 里没找到（不在当前分支）：保留文件里的 hash。
        if commit.is_some() {
            step.commit = commit.cloned();
        }
    }
    // 任务状态不从 Git 或环境是否在线推导；归档即完成。
    let current_step = steps
        .iter()
        .find(|step| step.state == "todo" && !step.checked)
        .map(|step| step.id.clone().unwrap_or_else(|| step.text.clone()));
    let state = if archived || live.is_completed() {
        "completed"
    } else if live.status.as_deref() == Some("in_progress") {
        "running"
    } else {
        "planning"
    };
    let run = directory.join("run.md");
    let run = run
        .is_file()
        .then(|| fsutil::read_text(&run, MAX_ARTIFACT_BYTES).ok())
        .flatten()
        .map(|text| {
            let chars: Vec<char> = text.chars().collect();
            chars[chars.len().saturating_sub(4000)..].iter().collect()
        });
    let unlinked_commits = ahead.iter().filter(|commit| commit.step.is_none()).count();
    Ok(TaskView {
        title: record_title(record, &dir_name),
        idea: record.get("idea").and_then(Value::as_str).map(str::to_owned),
        task_dir_name: dir_name,
        state,
        archived,
        abandoned: live.is_completed() && live.abandoned,
        cancel_reason: live.cancel_reason.clone().filter(|_| live.is_completed()),
        prd: prd.to_string_lossy().into_owned(),
        // 单文件任务的正文在任务页编辑，不能截断；旧 prd.md 只读展示。
        prd_text: if single { prd_text } else { prd_text.chars().take(20_000).collect() },
        branch,
        base_branch,
        worktree: worktree.map(|path| path.to_string_lossy().into_owned()),
        group: group::MAIN_GROUP.to_owned(),
        dirty_files,
        behind,
        acceptance: Acceptance {
            done: accept.iter().filter(|item| item.checked).count(),
            total: accept.len(),
            items: accept,
        },
        steps,
        current_step,
        commits: ahead,
        unlinked_commits,
        diffstat,
        history,
        run,
    })
}
