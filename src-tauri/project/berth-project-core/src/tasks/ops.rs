//! `berth task` 子命令。内容（单文件任务 `<名>.md`，或旧的 prd.md + task.json）读写主项目；实时状态读写主项目的 `local/tasks.json`。

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::file::{self, FileStep};
use super::group;
use super::fsutil::{self, MAX_JSON_BYTES};
use super::git;
use super::hub::{self, berth_dir, Scope};
use super::state::{self, Live};
use super::view::{self, TaskView};
use super::{TaskError, TaskResult};

const TASK_REF_MAX: usize = 128;

struct Ctx {
    /// 发起命令的 checkout（内容在这里读写）。
    checkout: PathBuf,
    /// 主项目（实时状态、群在这里）。
    main: PathBuf,
}

fn context(workspace: &Path) -> TaskResult<Ctx> {
    let Scope { checkout, main } = hub::resolve(workspace)?;
    let base = berth_dir(&checkout);
    if fs::symlink_metadata(&base).is_ok_and(|meta| meta.file_type().is_symlink()) {
        return Err(TaskError::new(
            "unsafe_path",
            format!(
                "Symlinked workflow directory is not allowed: {}",
                base.display()
            ),
        ));
    }
    group::checkout_groups(&main)?;
    Ok(Ctx { checkout, main })
}

fn tasks_root(checkout: &Path) -> PathBuf {
    berth_dir(checkout).join("tasks")
}

fn sorted_dirs(root: &Path) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = fs::read_dir(root)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
                .map(|entry| entry.path())
                .collect()
        })
        .unwrap_or_default();
    dirs.sort();
    dirs.reverse();
    dirs
}

/// 任务：旧格式的目录，或单文件任务 `<名>.md`；按任务名新的在前。
fn sorted_tasks(root: &Path) -> Vec<PathBuf> {
    let mut tasks: Vec<PathBuf> = fs::read_dir(root)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .filter(|path| path.is_dir() || file::is_file_task(path))
                .collect()
        })
        .unwrap_or_default();
    tasks.sort_by_key(|path| dir_name(path));
    tasks.reverse();
    tasks
}

/// （任务路径，是否归档），新的在前。
fn task_dirs(checkout: &Path, include_archived: bool) -> Vec<(PathBuf, bool)> {
    let root = tasks_root(checkout);
    let mut out: Vec<(PathBuf, bool)> = sorted_tasks(&root)
        .into_iter()
        .filter(|path| path.file_name().is_some_and(|name| name != "archive"))
        .map(|path| (path, false))
        .collect();
    if include_archived {
        for month in sorted_dirs(&root.join("archive")) {
            out.extend(sorted_tasks(&month).into_iter().map(|path| (path, true)));
        }
    }
    out
}

/// 任务名：目录名，或单文件任务去掉 `.md`。
fn dir_name(path: &Path) -> String {
    if file::is_file_task(path) { path.file_stem() } else { path.file_name() }
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// 目录名精确匹配，或唯一的 `*-<reference>` 后缀匹配（slug）。
fn find_task(checkout: &Path, reference: &str) -> TaskResult<(PathBuf, bool)> {
    let reference = fsutil::safe_component(reference, "task reference", TASK_REF_MAX)?;
    let reference = reference.trim_end_matches(".md");
    let exact = tasks_root(checkout).join(reference);
    if exact.is_dir() {
        return Ok((exact, false));
    }
    let single = tasks_root(checkout).join(format!("{reference}.md"));
    if file::is_file_task(&single) {
        return Ok((single, false));
    }
    let suffix = format!("-{reference}");
    let matches: Vec<(PathBuf, bool)> = task_dirs(checkout, true)
        .into_iter()
        .filter(|(path, _)| {
            let name = dir_name(path);
            name == reference || name.ends_with(&suffix)
        })
        .collect();
    match matches.len() {
        1 => Ok(matches.into_iter().next().expect("one match")),
        0 => Err(TaskError::new(
            "not_found",
            format!("Task not found: {reference}"),
        )),
        _ => Err(TaskError::new(
            "ambiguous",
            format!("Task reference is ambiguous: {reference}"),
        )),
    }
}

fn record(directory: &Path) -> TaskResult<Value> {
    if file::is_file_task(directory) {
        return file::record(directory);
    }
    let path = directory.join("task.json");
    match fsutil::read_json(&path)? {
        Some(value @ Value::Object(_)) => Ok(value),
        Some(_) => Err(TaskError::new(
            "invalid_json",
            format!("Task record is not an object: {}", directory.display()),
        )),
        None => Err(TaskError::new(
            "not_found",
            format!("File not found: {}", path.display()),
        )),
    }
}

fn task_etag(directory: &Path) -> TaskResult<String> {
    let path = if file::is_file_task(directory) {
        directory.to_path_buf()
    } else {
        directory.join("task.json")
    };
    Ok(fsutil::etag(&fsutil::read_bounded(&path, MAX_JSON_BYTES)?))
}

/// 实时状态，单文件任务的 status 以文件为准。
fn live_with(record: &Value, entry: Option<&Live>) -> Live {
    let mut live = entry.cloned().unwrap_or_default();
    file::apply_status(record, &mut live);
    live
}

/// 任务目录（含已归档的）；会话分类往里写 `交接.md`。
pub fn task_dir(main: &Path, name: &str) -> Option<PathBuf> {
    find_task(main, name).ok().map(|(path, _)| path)
}

/// 定时运行结果的根目录 `.berth/runs/<任务名>/`（进 git）。不放进任务目录：单文件任务没有目录，
/// `tasks/` 下的目录又都会被当成任务；按任务名存，归档时不用搬。
pub const RUNS_DIR: &str = "runs";
/// 结果文件首行带它：Agent 没自己交结果，由续跑兜底用最后一段回答写成，需要人处理。
pub const INCOMPLETE_MARK: &str = "<!-- berth:incomplete -->";

/// 定时运行的 Agent 终端带这个环境变量：`<任务名>/<stamp>`，`berth task result` 与 hook 据此找结果文件。
pub const TASK_RUN_ENV: &str = "BERTH_TASK_RUN";

/// 运行的 stamp：本地时间，结果文件名按它排序。
pub fn run_stamp(at: chrono::DateTime<chrono::Utc>) -> String {
    at.with_timezone(&chrono::Local)
        .format("%Y-%m-%d-%H%M%S")
        .to_string()
}

/// 现在的 stamp：不在定时运行里交结果时用。
pub fn run_stamp_now() -> String {
    run_stamp(chrono::Utc::now())
}

/// 解析 [`TASK_RUN_ENV`] 的值。
pub fn parse_task_run(value: &str) -> Option<(&str, &str)> {
    value
        .split_once('/')
        .filter(|(task, stamp)| !task.is_empty() && !stamp.is_empty())
}

/// 一次定时运行的结果文件 `.berth/runs/<任务名>/<stamp>.md`（任务含已归档的）。
pub fn run_result_path(main: &Path, reference: &str, stamp: &str) -> TaskResult<PathBuf> {
    let stamp = fsutil::safe_component(stamp, "run stamp", 64)?;
    let (directory, _) = find_task(main, reference)?;
    Ok(berth_dir(main)
        .join(RUNS_DIR)
        .join(dir_name(&directory))
        .join(format!("{stamp}.md")))
}

/// 写一次定时运行的结果（`berth task result`）；写在主项目的任务目录。
pub fn write_run_result(
    workspace: &Path,
    reference: &str,
    stamp: &str,
    text: &str,
) -> TaskResult<Value> {
    let ctx = context(workspace)?;
    let text = text.trim();
    if text.is_empty() {
        return Err(TaskError::new("invalid_input", "Result is empty"));
    }
    let path = run_result_path(&ctx.main, reference, stamp)?;
    fsutil::atomic_write(&path, format!("{text}\n").as_bytes())?;
    Ok(json!({"path": path.to_string_lossy()}))
}

/// 找任务：主项目的任务为权威记录；仅主项目尚无此任务时读当前 checkout。
/// 不给 reference 时按当前分支在实时状态里找绑定的任务。
fn resolve(ctx: &Ctx, reference: Option<&str>) -> TaskResult<(PathBuf, bool)> {
    let bases: Vec<&Path> = if git::same_path(&ctx.checkout, &ctx.main) {
        vec![&ctx.checkout]
    } else {
        vec![&ctx.main, &ctx.checkout]
    };
    match reference {
        Some(reference) => {
            for base in &bases {
                match find_task(base, reference) {
                    Ok(found) => return Ok(found),
                    Err(error) if error.code == "not_found" => continue,
                    Err(error) => return Err(error),
                }
            }
            Err(TaskError::new(
                "not_found",
                format!("Task not found: {reference}"),
            ))
        }
        None => {
            let branch = git::current_branch(&ctx.checkout);
            let live = state::load(&ctx.main)?;
            let bound = branch.as_deref().and_then(|branch| {
                live.tasks
                    .iter()
                    .find(|(_, entry)| entry.branch.as_deref() == Some(branch))
                    .map(|(name, _)| name.clone())
            });
            let Some(name) = bound else {
                return Err(TaskError::new(
                    "not_found",
                    "No task is bound to the current branch; pass a task reference",
                ));
            };
            for base in &bases {
                if let Ok(found) = find_task(base, &name) {
                    return Ok(found);
                }
            }
            Err(TaskError::new(
                "not_found",
                format!("Task not found: {name}"),
            ))
        }
    }
}

fn live_of(main: &Path, name: &str) -> TaskResult<Live> {
    Ok(state::load(main)?
        .tasks
        .get(name)
        .cloned()
        .unwrap_or_default())
}

// ---------------------------------------------------------------- 只读

/// 任务摘要列表；读不了的任务进 `diagnostics`。与 [`views`] 同一退回规则（`.berth/tasks` 没有任务时读旧 `.trellis`）。
pub fn list(workspace: &Path, include_archived: bool, limit: usize) -> TaskResult<Value> {
    let ctx = context(workspace)?;
    let (dirs, legacy) = match legacy_task_dirs(&ctx) {
        Some(dirs) => (dirs, true),
        None => (task_dirs(&ctx.main, include_archived), false),
    };
    let live = state::load(&ctx.main)?;
    // worktree 只列分到它的任务：按主项目记录（任务 → 群、群 → 目录）过滤，不从 git 反推。
    // 同一目录可能登记了多个群键，都算。
    let own_groups: Option<Vec<String>> = (!legacy && !git::same_path(&ctx.checkout, &ctx.main))
        .then(|| {
            group::envs(&ctx.main)
                .unwrap_or_default()
                .into_iter()
                .filter(|(_, env)| git::same_path(Path::new(&env.worktree), &ctx.checkout))
                .map(|(name, _)| name)
                .collect()
        });
    let mut tasks = Vec::new();
    let mut diagnostics = Vec::new();
    for (directory, archived) in dirs {
        let name = dir_name(&directory);
        let task_group = live
            .tasks
            .get(&name)
            .and_then(|entry| entry.group.clone())
            .unwrap_or_else(|| group::MAIN_GROUP.to_owned());
        if own_groups
            .as_ref()
            .is_some_and(|own| !own.contains(&task_group))
        {
            continue;
        }
        let record = match record(&directory) {
            Ok(record) => record,
            Err(error) => {
                diagnostics.push(json!({"entry": name, "message": error.message}));
                continue;
            }
        };
        let entry = if legacy {
            legacy_live(&record)
        } else {
            live_with(&record, live.tasks.get(&name))
        };
        tasks.push(json!({
            "id": name,
            "title": view::record_title(&record, &name),
            "status": entry.status.unwrap_or_else(|| "planning".to_owned()),
            "etag": task_etag(&directory)?,
            "archived": archived,
            "group": task_group,
        }));
    }
    let limit = limit.clamp(1, 500);
    let truncated = tasks.len() > limit;
    tasks.truncate(limit);
    Ok(json!({"tasks": tasks, "diagnostics": diagnostics, "truncated": truncated}))
}

/// `.berth/tasks` 里没有目录式任务、但当前 checkout 有旧 `.trellis/tasks` 时，返回旧的活跃任务目录。
fn legacy_task_dirs(ctx: &Ctx) -> Option<Vec<(PathBuf, bool)>> {
    let has_tasks = task_dirs(&ctx.main, true)
        .iter()
        .any(|(directory, _)| directory.join("task.json").is_file() || file::is_file_task(directory));
    let legacy = ctx.checkout.join(".trellis/tasks");
    if has_tasks || !legacy.is_dir() {
        return None;
    }
    Some(
        sorted_dirs(&legacy)
            .into_iter()
            .filter(|path| path.file_name().is_some_and(|name| name != "archive"))
            .map(|path| (path, false))
            .collect(),
    )
}

/// 全部活跃任务的派生视图（GUI 任务页）。`.berth/tasks` 没有目录式任务时退回旧的 `.trellis`，
/// 那时状态取各自 task.json（旧格式本来就把状态写在里面）。
pub fn views(workspace: &Path) -> TaskResult<Vec<TaskView>> {
    let ctx = context(workspace)?;
    if let Some(dirs) = legacy_task_dirs(&ctx) {
        let mut out = Vec::new();
        for (directory, _) in dirs {
            if let Ok(record) = record(&directory) {
                out.push(view::build(
                    &ctx.checkout,
                    &directory,
                    &record,
                    &legacy_live(&record),
                    false,
                )?);
            }
        }
        return Ok(out);
    }
    let live = state::load(&ctx.main)?;
    let tasks: Vec<(PathBuf, Value)> = task_dirs(&ctx.main, false)
        .into_iter()
        .filter_map(|(directory, _)| record(&directory).ok().map(|record| (directory, record)))
        .collect();
    // 每个任务要跑几次扫全历史的 git log，串行时任务数 × 几十毫秒；各任务互不依赖，并行算。
    // ponytail: 一任务一线程，任务上百再改成按 CPU 数分批
    std::thread::scope(|scope| {
        let handles: Vec<_> = tasks
            .iter()
            .map(|(directory, record)| {
                let (main, live) = (&ctx.main, &live);
                scope.spawn(move || {
                    let entry = live_with(record, live.tasks.get(&dir_name(directory)));
                    let (effective, group) = grouped(main, &dir_name(directory), &entry);
                    let mut view = view::build(main, directory, record, &effective, false)?;
                    view.group = group;
                    Ok(view)
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|handle| handle.join().unwrap_or_else(|panic| std::panic::resume_unwind(panic)))
            .collect()
    })
}

pub fn show(workspace: &Path, reference: Option<&str>) -> TaskResult<TaskView> {
    let ctx = context(workspace)?;
    let (directory, archived) = resolve(&ctx, reference)?;
    let all = state::load(&ctx.main)?;
    let record = record(&directory)?;
    let entry = live_with(&record, all.tasks.get(&dir_name(&directory)));
    let (effective, group) = grouped(&ctx.main, &dir_name(&directory), &entry);
    let mut view = view::build(&ctx.main, &directory, &record, &effective, archived)?;
    view.group = group;
    Ok(view)
}

/// 旧 task.json 里的状态字段（迁移与 `.trellis` 退回用）。
fn legacy_live(record: &Value) -> Live {
    let text = |key: &str| {
        record
            .get(key)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty() && *value != "null")
            .map(str::to_owned)
    };
    let status = text("status").filter(|status| status == "in_progress" || status == "completed");
    let branch = text("branch");
    Live {
        status,
        base_branch: branch.as_ref().and(text("base_branch")),
        worktree: branch.as_ref().and(text("worktree_path")),
        branch,
        completed_at: text("completedAt"),
        abandoned: false,
        cancel_reason: None,
        updated_at: None,
        group: None,
    }
}

// ---------------------------------------------------------------- 写

pub struct CreateOptions {
    pub title: String,
    pub slug: Option<String>,
    pub description: String,
    pub branch: Option<String>,
    pub base: Option<String>,
    /// 来源想法 id。
    pub idea: Option<String>,
}

/// 新建单文件任务 `<MM-DD-slug>.md`：frontmatter（含占位步骤）+ 固定骨架（见 [`file::skeleton`]）。
pub fn create(workspace: &Path, options: CreateOptions) -> TaskResult<Value> {
    let ctx = context(workspace)?;
    let (group, _) = group::checkout_group(&ctx.checkout)?;
    let title = options.title.trim();
    if title.is_empty() || title.chars().count() > 200 {
        return Err(TaskError::new(
            "invalid_input",
            "Task title must contain 1 to 200 characters",
        ));
    }
    let slug = fsutil::slugify(options.slug.as_deref().unwrap_or(title));
    let stamp = chrono::Local::now().format("%m-%d").to_string();
    let root = tasks_root(&ctx.main);
    let mut candidate = format!("{stamp}-{slug}");
    let mut index = 2;
    while root.join(&candidate).exists() || root.join(format!("{candidate}.md")).exists() {
        candidate = format!("{stamp}-{slug}-{index}");
        index += 1;
    }
    let directory = root.join(format!("{candidate}.md"));
    fs::create_dir_all(&root)?;
    // 文件名就是任务引用；分支、worktree、群是本机实时状态，在主项目 local/tasks.json。
    let description = options.description.trim();
    let body = if description.is_empty() { file::skeleton(None) } else { description.to_owned() };
    let text = file::render(title, options.idea.as_deref(), &body)?;
    let result = (|| -> TaskResult<Value> {
        fsutil::atomic_write(&directory, text.as_bytes())?;
        let record = file::record(&directory)?;
        if let Some(branch) = options.branch.as_deref() {
            bind_dir(&ctx, &directory, branch, options.base.as_deref(), None)?;
        }
        state::update(&ctx.main, |live| {
            let entry = live.tasks.entry(candidate.clone()).or_default();
            entry.group = Some(group.clone());
            entry.updated_at = Some(state::now());
            Ok(())
        })?;
        Ok(json!({
            "taskDirName": candidate,
            "task": record,
            "etag": task_etag(&directory)?,
            "prd": directory.to_string_lossy(),
        }))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&directory);
    }
    result
}

fn bind_dir(
    ctx: &Ctx,
    directory: &Path,
    branch: &str,
    base: Option<&str>,
    worktree: Option<&str>,
) -> TaskResult<Value> {
    let name = dir_name(directory);
    let default_base = git::current_branch(&ctx.main);
    state::update(&ctx.main, |live| {
        if let Some((other, _)) = live
            .tasks
            .iter()
            .find(|(other, entry)| **other != name && entry.branch.as_deref() == Some(branch))
        {
            return Err(TaskError::new(
                "invalid_state",
                format!("Branch {branch} is already bound to task {other}"),
            ));
        }
        let entry = live.tasks.entry(name.clone()).or_default();
        entry.base_branch = base
            .map(str::to_owned)
            .or_else(|| entry.base_branch.clone())
            .or(default_base);
        entry.branch = Some(branch.to_owned());
        entry.worktree = worktree.map(str::to_owned);
        entry.updated_at = Some(state::now());
        Ok(json!({"taskDirName": name, "branch": entry.branch, "baseBranch": entry.base_branch}))
    })
}

pub fn bind(
    workspace: &Path,
    reference: Option<&str>,
    branch: &str,
    base: Option<&str>,
    worktree: Option<&str>,
) -> TaskResult<Value> {
    let ctx = context(workspace)?;
    let (directory, archived) = resolve(&ctx, reference)?;
    if archived {
        return Err(TaskError::new(
            "invalid_state",
            "Archived task cannot be bound",
        ));
    }
    bind_dir(&ctx, &directory, branch, base, worktree)
}

pub fn unbind(workspace: &Path, reference: Option<&str>) -> TaskResult<Value> {
    let ctx = context(workspace)?;
    let (directory, _) = resolve(&ctx, reference)?;
    let name = dir_name(&directory);
    state::update(&ctx.main, |live| {
        if let Some(entry) = live.tasks.get_mut(&name) {
            entry.branch = None;
            entry.base_branch = None;
            entry.worktree = None;
            entry.updated_at = Some(state::now());
        }
        Ok(json!({"taskDirName": name, "branch": null, "baseBranch": null}))
    })
}

/// 完成即归档；旧 done 入口与 GUI 使用相同的领域操作。
pub fn done(workspace: &Path, reference: Option<&str>) -> TaskResult<Value> {
    complete(workspace, reference)
}

/// 显式开始任务，仅改变任务状态，不创建或清理群环境。
/// 单文件任务先检查规划（每步 do / change / verify 都填了），返回任务文件与第一步。
pub fn begin(workspace: &Path, reference: &str) -> TaskResult<Value> {
    let ctx = context(workspace)?;
    let (directory, archived) = resolve(&ctx, Some(reference))?;
    if archived {
        return Err(TaskError::new(
            "invalid_state",
            "Archived task must be reopened first",
        ));
    }
    let name = dir_name(&directory);
    let mut result = json!({"taskDirName": name, "state": "running"});
    if file::is_file_task(&directory) {
        let steps = file::steps(&record(&directory)?)?;
        file::check_plan(&steps)?;
        file::set_status(&directory, file::RUNNING)?;
        result["file"] = json!(directory.to_string_lossy());
        result["next"] = json!(steps.iter().find(|step| step.commit.is_none()));
        result["read"] = json!("Read the whole task file once before S1");
    }
    state::update(&ctx.main, |live| {
        let entry = live.tasks.entry(name.clone()).or_default();
        entry.status = Some("in_progress".to_owned());
        entry.updated_at = Some(state::now());
        Ok(())
    })?;
    Ok(result)
}

/// 勾掉一步：要求已有带 `Task: <任务> S<n>` 尾注的提交，在主项目那份任务文件里记下提交；
/// 返回下一步、全部步骤一览与记录末几行，做完最后一步时返回验收项。
pub fn step(workspace: &Path, reference: &str, step: &str) -> TaskResult<Value> {
    let ctx = context(workspace)?;
    let (path, archived) = resolve(&ctx, Some(reference))?;
    if archived {
        return Err(TaskError::new("invalid_state", "Archived task must be reopened first"));
    }
    if !file::is_file_task(&path) {
        return Err(TaskError::new(
            "invalid_state",
            "Legacy task (directory with prd.md) has no step command; tick its checklist in prd.md",
        ));
    }
    let mut steps = file::steps(&record(&path)?)?;
    let Some(index) = steps.iter().position(|item| item.id == step) else {
        return Err(TaskError::new("not_found", format!("{step} is not in the task's steps")));
    };
    let name = dir_name(&path);
    if steps[index].commit.is_none() {
        let grep = format!("--grep=^Task: {name} ");
        let Some(commit) = view::commits(&ctx.main, &["--all", &grep])
            .into_iter()
            .find(|commit| commit.step.as_deref() == Some(step))
        else {
            return Err(TaskError::new(
                "not_committed",
                format!("No commit for {step} yet: commit it with `Task: {name} {step}` at the end of the message"),
            ));
        };
        steps[index].commit = Some(commit.hash);
        file::save(&path, Some(&steps), None)?;
    }
    let body = file::body(&file::read(&path)?).to_owned();
    let next = steps.iter().find(|item| item.commit.is_none());
    let overview: Vec<String> = steps
        .iter()
        .map(|item| {
            let mark = if item.commit.is_some() { "x" } else { " " };
            format!("[{mark}] {} {}", item.id, item.action)
        })
        .collect();
    let mut result = json!({
        "taskDirName": name,
        "step": step,
        "commit": steps[index].commit,
        "next": next,
        "steps": overview,
        "notes": file::section_tail(&body, "记录", 5),
    });
    if next.is_none() {
        let (_, acceptance) = view::checklists(&body);
        result["acceptance"] = json!(acceptance
            .iter()
            .map(|item| format!("[{}] {}", if item.checked { "x" } else { " " }, item.text))
            .collect::<Vec<_>>());
        result["then"] = json!("All steps done: check every acceptance item, then `berth task finish`");
    }
    Ok(result)
}

/// 任务页保存：改步骤和 / 或正文（`body` 带加载时的正文做冲突检查）。
pub fn save(
    workspace: &Path,
    reference: &str,
    steps: Option<Vec<FileStep>>,
    body: Option<(String, String)>,
) -> TaskResult<Value> {
    let ctx = context(workspace)?;
    let (path, _) = resolve(&ctx, Some(reference))?;
    if !file::is_file_task(&path) {
        return Err(TaskError::new("invalid_state", "Legacy task is edited in its prd.md"));
    }
    file::save(
        &path,
        steps.as_deref(),
        body.as_ref().map(|(base, next)| (base.as_str(), next.as_str())),
    )?;
    Ok(json!({"taskDirName": dir_name(&path), "etag": task_etag(&path)?}))
}

/// 想法升级为任务：原话与讨论带进任务的「背景」，想法以 `→ 任务 <名>` 关闭并归档。
pub fn promote(workspace: &Path, idea: &str, title: Option<&str>) -> TaskResult<Value> {
    let ctx = context(workspace)?;
    let io = |error: std::io::Error| TaskError::new("io_error", error.to_string());
    let (text, discussion) = crate::knowledge::ideas::background(&ctx.main, idea)
        .map_err(io)?
        .ok_or_else(|| TaskError::new("not_found", format!("Idea {idea} not found")))?;
    let title = title
        .map(str::to_owned)
        .unwrap_or_else(|| text.lines().next().unwrap_or_default().trim_start_matches("# ").chars().take(60).collect());
    let mut background = text;
    if !discussion.is_empty() {
        background.push_str("\n\n讨论：\n\n");
        background.push_str(&discussion);
    }
    let created = create(
        workspace,
        CreateOptions {
            title,
            slug: None,
            description: file::skeleton(Some(&background)),
            branch: None,
            base: None,
            idea: Some(idea.to_owned()),
        },
    )?;
    let name = created["taskDirName"].as_str().unwrap_or_default().to_owned();
    crate::knowledge::ideas::close(&ctx.main, idea, &crate::knowledge::ideas::Conclusion::Task(name))
        .map_err(io)?;
    Ok(created)
}

/// 本群里没做完的任务（目录名），不含 `except`。`main` 是主项目目录。
pub fn open_tasks_in_group(main: &Path, group: &str, except: Option<&str>) -> TaskResult<Vec<String>> {
    let all = state::load(main)?;
    let mut open = Vec::new();
    for (name, live) in &all.tasks {
        if !live.is_completed()
            && Some(name.as_str()) != except
            && group::group_of_task(main, name)?.as_deref() == Some(group)
        {
            open.push(name.clone());
        }
    }
    Ok(open)
}

/// 把任务目录移进它所在 tasks 根的 `archive/<年月>/`。
fn move_to_archive(directory: &Path, name: &str) -> TaskResult<PathBuf> {
    let root = directory
        .parent()
        .ok_or_else(|| TaskError::new("invalid_state", "Task directory has no parent"))?;
    let destination = root
        .join("archive")
        .join(chrono::Local::now().format("%Y-%m").to_string())
        .join(directory.file_name().unwrap_or(name.as_ref()));
    if destination.exists() {
        return Err(TaskError::new(
            "already_exists",
            "Archive destination already exists",
        ));
    }
    fs::create_dir_all(destination.parent().expect("archive month"))?;
    fs::rename(directory, &destination)?;
    Ok(destination)
}

/// 完成或取消并归档：先记状态，再移目录；移失败就恢复原状态。只提示群是否已全部归档，不动 worktree。
/// `cancel_reason` 为 `Some` 表示取消（`Some("")` 是没写原因）。
fn settle(ctx: &Ctx, directory: &Path, cancel_reason: Option<&str>) -> TaskResult<Value> {
    let name = dir_name(directory);
    let previous = live_of(&ctx.main, &name)?;
    state::update(&ctx.main, |live| {
        let entry = live.tasks.entry(name.clone()).or_default();
        entry.status = Some("completed".to_owned());
        entry.abandoned = false;
        entry.cancel_reason = cancel_reason.map(|reason| reason.trim().to_owned());
        if entry.completed_at.is_none() || cancel_reason.is_some() {
            entry.completed_at = Some(state::today());
        }
        entry.updated_at = Some(state::now());
        Ok(())
    })?;
    if file::is_file_task(directory) {
        let status = if cancel_reason.is_some() { file::ABANDONED } else { file::DONE };
        file::set_status(directory, status)?;
    }
    let destination = match move_to_archive(directory, &name) {
        Ok(destination) => destination,
        Err(error) => {
            let _ = state::update(&ctx.main, |live| {
                if previous == Live::default() {
                    live.tasks.remove(&name);
                } else {
                    live.tasks.insert(name.clone(), previous.clone());
                }
                Ok(())
            });
            return Err(error);
        }
    };
    let group = group::group_of_task(&ctx.main, &name)
        .ok()
        .flatten()
        .unwrap_or_else(|| group::MAIN_GROUP.to_owned());
    let all_archived = group != group::MAIN_GROUP
        && open_tasks_in_group(&ctx.main, &group, Some(&name))?.is_empty();
    Ok(json!({
        "taskDirName": name,
        "archived": true,
        "state": "completed",
        "cancelReason": cancel_reason.map(|reason| reason.trim().to_owned()),
        "path": destination.to_string_lossy(),
        "group": group,
        "groupAllArchived": all_archived,
    }))
}

/// 完成即归档（一次操作）。
pub fn complete(workspace: &Path, reference: Option<&str>) -> TaskResult<Value> {
    let ctx = context(workspace)?;
    let (directory, archived) = resolve(&ctx, reference)?;
    if archived {
        return Err(TaskError::new("invalid_state", "Task is already archived"));
    }
    settle(&ctx, &directory, None)
}

/// 归档。已完成的任务照旧直接归档；待开始或进行中的任务算取消：记原因（可省）后归档，不动 worktree。
pub fn archive(workspace: &Path, reference: &str, reason: Option<&str>) -> TaskResult<Value> {
    let ctx = context(workspace)?;
    let (directory, archived) = resolve(&ctx, Some(reference))?;
    if archived {
        return Ok(
            json!({"taskDirName": dir_name(&directory), "archived": true, "state": "completed", "path": directory.to_string_lossy()}),
        );
    }
    let completed = live_of(&ctx.main, &dir_name(&directory))?.is_completed();
    settle(&ctx, &directory, (!completed).then(|| reason.unwrap_or("")))
}

/// 重新打开已归档的任务：目录回到任务列表，状态回到进行中，清掉取消原因。
pub fn reopen(workspace: &Path, reference: &str) -> TaskResult<Value> {
    let ctx = context(workspace)?;
    let (directory, archived) = resolve(&ctx, Some(reference))?;
    if !archived {
        return Err(TaskError::new("invalid_state", "Task is not archived"));
    }
    let name = dir_name(&directory);
    let destination = tasks_root(&ctx.main).join(directory.file_name().unwrap_or(name.as_ref()));
    if destination.exists() {
        return Err(TaskError::new(
            "already_exists",
            format!("{} already exists", destination.display()),
        ));
    }
    fs::rename(&directory, &destination)?;
    let marked = state::update(&ctx.main, |live| {
        let entry = live.tasks.entry(name.clone()).or_default();
        entry.status = Some("in_progress".to_owned());
        entry.abandoned = false;
        entry.cancel_reason = None;
        entry.completed_at = None;
        entry.updated_at = Some(state::now());
        Ok(())
    });
    if let Err(error) = marked {
        let _ = fs::rename(&destination, &directory);
        return Err(error);
    }
    if file::is_file_task(&destination) {
        file::set_status(&destination, file::RUNNING)?;
    }
    Ok(json!({"taskDirName": name, "archived": false, "state": "running"}))
}

/// 把旧 task.json 里的状态**只导入**到 `local/tasks.json`（不改写受 git 跟踪的 task.json）。幂等：
/// 已有实时状态的任务不覆盖。
pub fn migrate(workspace: &Path) -> TaskResult<Value> {
    let ctx = context(workspace)?;
    let mut candidates = Vec::new();
    for (directory, _) in task_dirs(&ctx.main, true) {
        if let Ok(record) = record(&directory) {
            let legacy = legacy_live(&record);
            if legacy != Live::default() {
                candidates.push((dir_name(&directory), legacy));
            }
        }
    }
    state::update(&ctx.main, |live| {
        let mut imported = Vec::new();
        for (name, legacy) in candidates {
            if live.tasks.contains_key(&name) {
                continue;
            }
            live.tasks.insert(
                name.clone(),
                Live {
                    updated_at: Some(state::now()),
                    ..legacy
                },
            );
            imported.push(name);
        }
        Ok(json!({"imported": imported, "count": imported.len()}))
    })
}

/// 群组语义：（有效 live, 群组名）。群 `env` 是唯一真源；`main` 群与没有 `env` 的旧群用任务自身字段。
fn grouped(main: &Path, name: &str, live: &Live) -> (Live, String) {
    let group = group::group_of_task(main, name)
        .ok()
        .flatten()
        .unwrap_or_else(|| group::MAIN_GROUP.to_owned());
    let mut effective = live.clone();
    if group != group::MAIN_GROUP {
        if let Some(env) = group::env(main, &group).ok().flatten() {
            // detached HEAD 的 worktree 没有分支。
            effective.branch = Some(env.branch).filter(|branch| !branch.is_empty());
            effective.base_branch = Some(env.base_branch);
            effective.worktree = Some(env.worktree);
        }
    }
    (effective, group)
}

/// 把任务分配给群组（`main` 或已有群组）；一个群组可有多个任务。
pub fn assign(workspace: &Path, reference: &str, group: &str) -> TaskResult<Value> {
    let ctx = context(workspace)?;
    let (directory, _) = resolve(&ctx, Some(reference))?;
    let name = dir_name(&directory);
    let (group, _) = group::project_group(&ctx.main, group)?;
    let current = show(workspace, Some(reference))?;
    if current.group == group {
        return Ok(json!({"taskDirName": name, "group": group}));
    }
    if current.branch.is_some() || current.worktree.is_some() {
        return Err(TaskError::new(
            "migration_required",
            "Task has an execution environment; confirm its code migration before moving groups",
        ));
    }
    state::update(&ctx.main, |live| {
        let entry = live.tasks.entry(name.clone()).or_default();
        entry.group = Some(group.clone());
        entry.updated_at = Some(state::now());
        Ok(())
    })?;
    Ok(json!({"taskDirName": name, "group": group}))
}

// ---------------------------------------------------------------- 收尾

#[derive(Debug, Clone, Copy, Default)]
pub struct FinishOptions {
    /// 只检查、列出将执行的动作，不改任何东西（GUI 确认框用）。
    pub dry_run: bool,
    /// 放弃：未合并也收尾，任务记为完成并标「已放弃」。
    pub abandon: bool,
    /// 群组清理时保留已合并分支；任务归档不使用此选项。
    pub keep_branch: bool,
}

/// 旧 task finish 入口只结束该任务，不再删除共享执行环境。
pub fn finish(workspace: &Path, reference: &str, options: FinishOptions) -> TaskResult<Value> {
    if options.dry_run {
        let view = show(workspace, Some(reference))?;
        return Ok(
            json!({"taskDirName": view.task_dir_name, "ready": !view.archived,
            "dirty": [], "willArchive": true, "deleteBranch": false, "worktree": null}),
        );
    }
    if options.abandon {
        archive(workspace, reference, Some("Cancelled"))
    } else {
        complete(workspace, Some(reference))
    }
}

/// 群级收尾：只有全部任务结束、代码已合并且目录干净时才清理环境；不改任何任务归属。
pub fn finish_group(workspace: &Path, group: &str, options: FinishOptions) -> TaskResult<Value> {
    let ctx = context(workspace)?;
    let (group, env) = group::project_group(&ctx.main, group)?;
    if options.abandon {
        return Err(TaskError::new(
            "invalid_state",
            "Group cleanup requires merged code; cancel tasks separately",
        ));
    }
    let path = PathBuf::from(&env.worktree);
    if git::same_path(&path, &ctx.main) || !path.is_dir() {
        return Err(TaskError::new(
            "invalid_state",
            "Group worktree is unavailable or is the main checkout",
        ));
    }
    let listed = git::worktrees(&ctx.main);
    if !listed.iter().any(|entry| {
        git::same_path(&entry.path, &path) && entry.branch.as_deref() == Some(env.branch.as_str())
    }) {
        return Err(TaskError::new(
            "invalid_state",
            "Group environment does not match a registered worktree",
        ));
    }
    let open = open_tasks_in_group(&ctx.main, &group, None)?;
    let output = git::run(&path, &["status", "--porcelain=v1", "-uall"])
        .ok_or_else(|| TaskError::new("git_error", "Cannot inspect group worktree"))?;
    if !output.status.success() {
        return Err(TaskError::new(
            "git_error",
            String::from_utf8_lossy(&output.stderr),
        ));
    }
    let dirty: Vec<String> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.get(3..))
        .map(str::to_owned)
        .collect();
    // 基线等于分支本身时判不了是否合并（旧对账记录），按未合并处理，绝不强删。
    let merged = env.base_branch != env.branch
        && git::succeeds(
            &ctx.main,
            &["merge-base", "--is-ancestor", &env.branch, &env.base_branch],
        );
    let sha = git::stdout(&ctx.main, &["rev-parse", "--verify", &env.branch])
        .ok_or_else(|| TaskError::new("invalid_state", "Group branch is missing"))?;
    let ready = open.is_empty() && dirty.is_empty() && merged;
    let plan = json!({"group": group, "main": ctx.main.to_string_lossy(),
        "branch": env.branch, "baseBranch": env.base_branch, "worktree": env.worktree,
        "openTasks": open, "dirty": dirty, "merged": merged, "ready": ready,
        "deleteBranch": !options.keep_branch, "commit": sha});
    if options.dry_run {
        return Ok(plan);
    }
    if !ready {
        return Err(TaskError::new(
            if dirty.is_empty() {
                "invalid_state"
            } else {
                "dirty"
            },
            "Group cleanup blocked: unfinished tasks, uncommitted changes, or unmerged code",
        ));
    }
    // 确认与执行之间再次检查环境和任务，Git 的无 force 删除再挡一次并发文件改动。
    if group::env(&ctx.main, &group)?.as_ref() != Some(&env)
        || !open_tasks_in_group(&ctx.main, &group, None)?.is_empty()
        || git::stdout(&ctx.main, &["rev-parse", "--verify", &env.branch]).as_deref()
            != Some(sha.as_str())
    {
        return Err(TaskError::new(
            "conflict",
            "Group changed during cleanup; check again",
        ));
    }
    git::checked(&ctx.main, &["worktree", "remove", &env.worktree])?;
    let restore = || {
        if !git::branch_exists(&ctx.main, &env.branch) {
            let _ = git::run(&ctx.main, &["branch", &env.branch, &sha]);
        }
        let _ = git::run(&ctx.main, &["worktree", "add", &env.worktree, &env.branch]);
    };
    if !options.keep_branch {
        if let Err(error) = git::checked(&ctx.main, &["branch", "-D", &env.branch]) {
            restore();
            return Err(error);
        }
    }
    // 目录没了，群也没了入口：账本与运行态一并删除（分支最后的提交在返回值里，删除后据此找回）。
    if let Err(error) = group::remove(&ctx.main, &group) {
        restore();
        return Err(error);
    }
    Ok(
        json!({"group": group, "main": ctx.main.to_string_lossy(), "worktree": env.worktree,
        "branch": env.branch, "branchDeleted": !options.keep_branch, "commit": sha}),
    )
}
