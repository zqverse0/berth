//! 用真实 git 仓库与 worktree，不 mock。

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::{json, Value};

use super::*;

const PRD: &str = "# T\n\n## 目标\n\n做点事\n\n## 步骤\n\n- [ ] S1 先做 A\n- [ ] S2 再做 B\n\n## 验收\n\n- [x] A 通过\n- [ ] B 通过\n";

fn sh(cwd: &Path, args: &[&str]) -> String {
    let output = Command::new(args[0])
        .args(&args[1..])
        .current_dir(cwd)
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@t")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@t")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).into_owned()
}

/// 主项目：`<tmp>/proj`，分支 dev，已 `berth init`（带主项目标记），含任务 `10-01-demo`。
struct Repo {
    _tmp: tempfile::TempDir,
    main: PathBuf,
}

impl Repo {
    fn new() -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let main = tmp.path().join("proj");
        fs::create_dir(&main).unwrap();
        sh(&main, &["git", "init", "-q", "-b", "dev"]);
        crate::berth_dir::init(&main).unwrap();
        let task = main.join(".berth/tasks/10-01-demo");
        fs::create_dir_all(&task).unwrap();
        fs::write(task.join("task.json"), r#"{"title":"Demo"}"#).unwrap();
        fs::write(task.join("prd.md"), PRD).unwrap();
        sh(&main, &["git", "add", "-A"]);
        sh(&main, &["git", "commit", "-qm", "init"]);
        Self { _tmp: tmp, main }
    }

    fn worktree(&self, branch: &str) -> PathBuf {
        let path = self.main.parent().unwrap().join(format!("wt-{branch}"));
        sh(
            &self.main,
            &[
                "git",
                "worktree",
                "add",
                "-q",
                "-b",
                branch,
                path.to_str().unwrap(),
            ],
        );
        path
    }

    /// 真实路径（GUI「New worktree」同款）：建 worktree `../proj-demo`（分支 demo）→ 对账成群 → 任务归入并开工。
    fn start(&self) -> (String, PathBuf) {
        let path = self.main.parent().unwrap().join("proj-demo");
        sh(
            &self.main,
            &[
                "git",
                "worktree",
                "add",
                "-q",
                "-b",
                "demo",
                path.to_str().unwrap(),
            ],
        );
        let (group, _) = group::checkout_groups(&self.main)
            .unwrap()
            .into_iter()
            .find(|(_, env)| git::same_path(Path::new(&env.worktree), &path))
            .unwrap();
        assign(&self.main, "demo", &group).unwrap();
        begin(&self.main, "demo").unwrap();
        (group, path)
    }

    fn commit(&self, cwd: &Path, file: &str, message: &str) {
        fs::write(cwd.join(file), message).unwrap();
        sh(cwd, &["git", "add", "-A"]);
        sh(cwd, &["git", "commit", "-qm", message]);
    }

    fn status(&self, cwd: &Path) -> String {
        sh(cwd, &["git", "status", "--porcelain"])
    }

    fn groups(&self) -> Value {
        let path = self.main.join(".berth/local/groups/groups.json");
        fs::read_to_string(path)
            .map(|text| serde_json::from_str(&text).unwrap())
            .unwrap_or(Value::Null)
    }
}

#[test]
fn uninitialized_project_is_refused_without_creating_anything() {
    let tmp = tempfile::tempdir().unwrap();
    sh(tmp.path(), &["git", "init", "-q"]);
    let error = views(tmp.path()).unwrap_err();
    assert_eq!(error.code, "not_initialized");
    assert!(!tmp.path().join(".berth").exists());
}

#[test]
fn list_reports_unreadable_tasks_and_falls_back_to_legacy_trellis() {
    let repo = Repo::new();
    let broken = repo.main.join(".berth/tasks/10-02-broken");
    fs::create_dir_all(&broken).unwrap();
    fs::write(broken.join("task.json"), "{").unwrap();
    let listed = list(&repo.main, true, 50).unwrap();
    assert_eq!(listed["tasks"][0]["id"], "10-01-demo");
    assert_eq!(listed["diagnostics"][0]["entry"], "10-02-broken");

    // `.berth/tasks` 没有任务时，列表与视图一样读旧 `.trellis/tasks`（状态取 task.json）。
    fs::remove_dir_all(repo.main.join(".berth/tasks")).unwrap();
    fs::create_dir(repo.main.join(".berth/tasks")).unwrap();
    let old = repo.main.join(".trellis/tasks/09-01-old");
    fs::create_dir_all(&old).unwrap();
    fs::write(
        old.join("task.json"),
        r#"{"title":"Old","priority":"P1","status":"in_progress"}"#,
    )
    .unwrap();
    let listed = list(&repo.main, true, 50).unwrap();
    assert_eq!(listed["tasks"][0]["id"], "09-01-old");
    assert_eq!(listed["tasks"][0]["status"], "in_progress");
    assert_eq!(views(&repo.main).unwrap()[0].task_dir_name, "09-01-old");
}

#[test]
fn checklist_progress_does_not_start_a_task() {
    let repo = Repo::new();
    let view = show(&repo.main, Some("demo")).unwrap();
    assert_eq!(view.state, "planning");
    assert_eq!(view.acceptance.done, 1);
    assert_eq!(view.acceptance.total, 2);
    assert_eq!(view.steps.len(), 2);
    assert_eq!(view.steps[0].id.as_deref(), Some("S1"));
    assert_eq!(view.current_step.as_deref(), Some("S1"));

    fs::write(
        repo.main.join(".berth/tasks/10-01-demo/prd.md"),
        PRD.replace("[x]", "[ ]"),
    )
    .unwrap();
    assert_eq!(show(&repo.main, Some("demo")).unwrap().state, "planning");
}

#[test]
fn trailer_commits_mark_steps_and_survive_the_merge() {
    let repo = Repo::new();
    let wt = repo.worktree("feat");
    bind(&repo.main, Some("demo"), "feat", Some("dev"), None).unwrap();
    begin(&repo.main, "demo").unwrap();
    repo.commit(&wt, "a.txt", "feat: a\n\nTask: 10-01-demo S1");
    repo.commit(&wt, "b.txt", "chore: unlinked");
    let view = show(&wt, None).unwrap();
    assert_eq!(view.state, "running");
    assert_eq!(view.steps[0].state, "committed");
    assert_eq!(view.steps[1].state, "todo");
    assert_eq!(view.unlinked_commits, 1);
    assert!(git::same_path(&PathBuf::from(view.worktree.unwrap()), &wt));

    sh(
        &repo.main,
        &["git", "merge", "-q", "--no-ff", "-m", "merge", "feat"],
    );
    let view = show(&repo.main, Some("demo")).unwrap();
    assert_eq!(view.state, "running");
    assert_eq!(view.steps[0].state, "merged");
}

#[test]
fn a_branch_binds_to_one_task_only() {
    let repo = Repo::new();
    let other = repo.main.join(".berth/tasks/10-02-other");
    fs::create_dir_all(&other).unwrap();
    fs::write(other.join("task.json"), r#"{"id":"other","title":"Other"}"#).unwrap();
    bind(&repo.main, Some("demo"), "feat", None, None).unwrap();
    let error = bind(&repo.main, Some("other"), "feat", None, None).unwrap_err();
    assert_eq!(error.code, "invalid_state");
}

#[test]
fn worktree_completion_archives_in_main_without_changing_worktree() {
    let repo = Repo::new();
    let wt = repo.worktree("feat");
    bind(&wt, Some("demo"), "feat", None, Some(wt.to_str().unwrap())).unwrap();
    assert_eq!(show(&wt, None).unwrap().task_dir_name, "10-01-demo");
    assert_eq!(
        show(&repo.main, Some("demo")).unwrap().branch.as_deref(),
        Some("feat")
    );
    done(&wt, None).unwrap();
    assert_eq!(show(&repo.main, Some("demo")).unwrap().state, "completed");
    // 实时状态只在主项目的 local/（被忽略），worktree 不生成自己的 local/。
    assert!(!wt.join(".berth/local").exists());
    assert!(show(&repo.main, Some("demo")).unwrap().archived);
    assert!(repo.status(&repo.main).contains(".berth/tasks/archive/"));
    assert_eq!(repo.status(&wt), "");
}

#[test]
fn main_project_is_the_init_marked_checkout_not_the_git_main_worktree() {
    let tmp = tempfile::tempdir().unwrap();
    let first = tmp.path().join("first");
    fs::create_dir(&first).unwrap();
    sh(&first, &["git", "init", "-q", "-b", "main"]);
    fs::write(first.join("x"), "x").unwrap();
    sh(&first, &["git", "add", "-A"]);
    sh(&first, &["git", "commit", "-qm", "x"]);
    let hub = tmp.path().join("hub");
    sh(
        &first,
        &[
            "git",
            "worktree",
            "add",
            "-q",
            "-b",
            "dev",
            hub.to_str().unwrap(),
        ],
    );
    let wt = tmp.path().join("wt");
    sh(
        &first,
        &[
            "git",
            "worktree",
            "add",
            "-q",
            "-b",
            "feat",
            wt.to_str().unwrap(),
        ],
    );

    // 没有标记：各自是自己的主项目。
    assert!(git::same_path(&main_project(&wt).unwrap(), &wt));
    // 标记出现前启用的旧项目：git 主 worktree 有 `.berth/` 就是主项目。
    fs::create_dir(first.join(".berth")).unwrap();
    assert!(git::same_path(&main_project(&wt).unwrap(), &first));
    assert!(git::same_path(&main_project(&hub).unwrap(), &first));
    crate::berth_dir::init(&hub).unwrap();
    assert!(git::same_path(&main_project(&wt).unwrap(), &hub));
    assert!(git::same_path(&main_project(&first).unwrap(), &hub));
    // 主项目已在别处时，worktree 里 init 被拒绝。
    let error = crate::berth_dir::init(&wt).unwrap_err();
    assert!(error.to_string().contains("hub"), "{error}");
    assert!(!wt.join(HUB_MARKER).exists());

    fs::create_dir_all(wt.join(".berth/local")).unwrap();
    fs::write(wt.join(HUB_MARKER), "{}").unwrap();
    assert_eq!(main_project(&wt).unwrap_err().code, "ambiguous");
}

#[test]
fn migrate_imports_legacy_state_once_without_touching_task_json() {
    let repo = Repo::new();
    let legacy = r#"{"id":"demo","title":"Demo","status":"in_progress","branch":"old","base_branch":"dev","worktree_path":null}"#;
    let record = repo.main.join(".berth/tasks/10-01-demo/task.json");
    fs::write(&record, legacy).unwrap();
    assert_eq!(
        show(&repo.main, Some("demo")).unwrap().branch,
        None,
        "no inference before migrate"
    );
    let result = migrate(&repo.main).unwrap();
    assert_eq!(result["count"], 1);
    let view = show(&repo.main, Some("demo")).unwrap();
    assert_eq!(view.branch.as_deref(), Some("old"));
    assert_eq!(view.base_branch.as_deref(), Some("dev"));
    assert_eq!(fs::read_to_string(&record).unwrap(), legacy);
    bind(&repo.main, Some("demo"), "newer", None, None).unwrap();
    assert_eq!(migrate(&repo.main).unwrap()["count"], 0);
    assert_eq!(
        show(&repo.main, Some("demo")).unwrap().branch.as_deref(),
        Some("newer")
    );
}

#[test]
fn create_writes_a_single_task_file_and_done_then_archive() {
    let repo = Repo::new();
    let created = create(
        &repo.main,
        CreateOptions {
            title: "新任务: 带冒号".into(),
            slug: Some("fresh".into()),
            description: String::new(),
            branch: None,
            base: None,
            idea: Some("2026-10-17-101500".into()),
        },
    )
    .unwrap();
    let name = created["taskDirName"].as_str().unwrap().to_owned();
    assert!(name.ends_with("-fresh"));
    let path = repo.main.join(".berth/tasks").join(format!("{name}.md"));
    assert_eq!(created["prd"].as_str().unwrap(), path.to_str().unwrap());
    let text = fs::read_to_string(&path).unwrap();
    for heading in ["## 目标", "## 不做", "## 验收", "## 记录"] {
        assert_eq!(text.matches(heading).count(), 1, "{heading}");
    }
    assert!(!text.contains("## 步骤") && !text.contains("priority"), "{text}");
    assert_eq!(created["task"]["title"], "新任务: 带冒号");
    assert_eq!(created["task"]["status"], "规划中");
    let view = show(&repo.main, Some("fresh")).unwrap();
    assert_eq!(view.title, "新任务: 带冒号");
    assert_eq!(view.idea.as_deref(), Some("2026-10-17-101500"));
    assert!(!view.prd_text.contains("title:"), "正文不带 frontmatter");
    assert_eq!(view.steps[0].id.as_deref(), Some("S1"));

    // 带描述时描述就是正文。
    let described = create(
        &repo.main,
        CreateOptions {
            title: "带描述".into(),
            slug: Some("described".into()),
            description: "## 目标\n\n一句话结果。\n\n## 验收\n\n- [ ] 做完".into(),
            branch: None,
            base: None,
            idea: None,
        },
    )
    .unwrap();
    let text = fs::read_to_string(described["prd"].as_str().unwrap()).unwrap();
    assert!(text.ends_with("---\n\n## 目标\n\n一句话结果。\n\n## 验收\n\n- [ ] 做完\n"));
    let listed = list(&repo.main, false, 200).unwrap();
    let entry = listed["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|task| task["id"] == name.as_str())
        .unwrap();
    assert_eq!(entry["status"], "planning");
    assert_eq!(entry["title"], "新任务: 带冒号");

    // 旧任务（目录）与单文件任务并存。
    assert!(listed["tasks"].as_array().unwrap().iter().any(|task| task["id"] == "10-01-demo"));

    done(&repo.main, Some("fresh")).unwrap();
    let archived = archive(&repo.main, "fresh", None).unwrap();
    let archived_path = PathBuf::from(archived["path"].as_str().unwrap());
    assert!(archived_path.is_file());
    assert!(fs::read_to_string(&archived_path).unwrap().contains("status: 已完成"));
}

const PLAN: &str = "- id: S1\n  do: 写 a\n  change: a.txt\n  verify: cat a.txt\n- id: S2\n  do: 写 b\n  change: b.txt\n  verify: cat b.txt\n";

#[test]
fn single_file_task_steps_are_ticked_from_trailer_commits() {
    let repo = Repo::new();
    new_task(&repo, "flow");
    let name = show(&repo.main, Some("flow")).unwrap().task_dir_name;
    let path = repo.main.join(".berth/tasks").join(format!("{name}.md"));

    // 占位步骤没填完不能开工。
    let error = begin(&repo.main, "flow").unwrap_err();
    assert_eq!(error.code, "invalid_state");
    assert!(error.message.contains("S1.do"), "{}", error.message);

    // 任务页保存步骤与正文；正文以加载时为基准，磁盘已变就拒绝。
    let steps: Vec<FileStep> = serde_yaml::from_str(PLAN).unwrap();
    let body = show(&repo.main, Some("flow")).unwrap().prd_text;
    let edited = body.replace("## 记录", "## 记录\n\n- 用户补充");
    save(&repo.main, "flow", Some(steps), Some((body.clone(), edited.clone()))).unwrap();
    assert_eq!(
        save(&repo.main, "flow", None, Some((body, "x".into()))).unwrap_err().code,
        "conflict"
    );
    let text = fs::read_to_string(&path).unwrap();
    assert!(text.contains("title: flow") && text.contains("用户补充"), "{text}");

    let started = begin(&repo.main, "flow").unwrap();
    assert_eq!(started["next"]["id"], "S1");
    assert_eq!(started["file"], path.to_str().unwrap());
    assert!(fs::read_to_string(&path).unwrap().contains("status: 进行中"));
    assert_eq!(show(&repo.main, Some("flow")).unwrap().state, "running");

    // 没提交就不能勾。
    assert_eq!(step(&repo.main, "flow", "S1").unwrap_err().code, "not_committed");
    assert_eq!(step(&repo.main, "flow", "S9").unwrap_err().code, "not_found");

    repo.commit(&repo.main, "a.txt", &format!("feat: a\n\nTask: {name} S1"));
    let hash = sh(&repo.main, &["git", "rev-parse", "--short", "HEAD"]).trim().to_owned();
    let ticked = step(&repo.main, "flow", "S1").unwrap();
    assert_eq!(ticked["commit"], hash.as_str());
    assert_eq!(ticked["next"]["id"], "S2");
    assert_eq!(ticked["next"]["verify"], "cat b.txt");
    assert_eq!(ticked["steps"], json!(["[x] S1 写 a", "[ ] S2 写 b"]));
    assert_eq!(ticked["notes"], json!(["- 用户补充"]));
    assert!(ticked.get("acceptance").is_none());
    let text = fs::read_to_string(&path).unwrap();
    assert!(text.contains(&format!("commit: {hash}")), "{text}");
    // 再勾一次不改文件。
    step(&repo.main, "flow", "S1").unwrap();
    assert_eq!(fs::read_to_string(&path).unwrap(), text);

    let view = show(&repo.main, Some("flow")).unwrap();
    assert!(view.steps[0].checked);
    assert_eq!(view.steps[0].verify.as_deref(), Some("cat a.txt"));
    assert_eq!(view.steps[0].state, "merged", "主目录直接提交，当前分支上就算落地");
    assert_eq!(view.current_step.as_deref(), Some("S2"));

    repo.commit(&repo.main, "b.txt", &format!("feat: b\n\nTask: {name} S2"));
    let last = step(&repo.main, "flow", "S2").unwrap();
    assert!(last["next"].is_null());
    assert!(last["acceptance"][0].as_str().unwrap().starts_with("[ ] 待补充"));

    // 放弃 → 文件进归档、标已放弃；重开回到进行中。
    archive(&repo.main, "flow", Some("不做了")).unwrap();
    let view = show(&repo.main, Some("flow")).unwrap();
    assert!(view.archived && view.abandoned);
    reopen(&repo.main, "flow").unwrap();
    assert!(fs::read_to_string(&path).unwrap().contains("status: 进行中"));
    assert_eq!(step(&repo.main, "demo", "S1").unwrap_err().code, "invalid_state", "旧任务没有 step");
}

#[test]
fn promote_moves_the_idea_into_a_task_background_and_archives_it() {
    let repo = Repo::new();
    let idea = crate::knowledge::ideas::add(&repo.main, "# 任务页可编辑\n\n现在只能看").unwrap();
    crate::knowledge::ideas::discuss(&repo.main, &idea.id, "Agent", "用编辑器").unwrap();
    let created = promote(&repo.main, &idea.id, None).unwrap();
    let text = fs::read_to_string(created["prd"].as_str().unwrap()).unwrap();
    assert!(text.contains("title: 任务页可编辑"), "{text}");
    assert!(text.contains("## 背景") && text.contains("现在只能看") && text.contains("Agent：用编辑器"), "{text}");
    let closed = crate::knowledge::ideas::list(&repo.main)
        .unwrap()
        .into_iter()
        .find(|item| item.id == idea.id)
        .unwrap();
    assert_eq!(closed.status, "已落地");
    assert!(closed.path.contains("归档"), "{}", closed.path);
}

#[test]
fn history_lists_commits_that_touched_the_task_directory() {
    let repo = Repo::new();
    let view = show(&repo.main, Some("demo")).unwrap();
    assert_eq!(view.history.len(), 1);
    assert_eq!(view.history[0].subject, "init");
}

#[test]
fn checklist_parsing_matches_the_old_script() {
    let (steps, accept) = view::checklists(
        "## 步骤\n- [ ] S1 一\n* [x] S2: 二\n- [ ] S3先做\n- [ ] 无编号\n### 其他\n- [ ] 不算\n## Acceptance\n  - [X] ok\n- [] 坏的\n",
    );
    let ids: Vec<Option<&str>> = steps.iter().map(|step| step.id.as_deref()).collect();
    assert_eq!(ids, [Some("S1"), Some("S2"), None, None]);
    assert!(steps[1].checked);
    assert_eq!(accept.len(), 1);
    assert!(accept[0].checked);
}

#[test]
fn slugify_matches_the_old_script() {
    assert_eq!(fsutil::slugify("Task Group!"), "task-group");
    assert_eq!(fsutil::slugify("任务"), "task");
    assert_eq!(fsutil::slugify("--a__b--"), "a-b");
}

#[test]
fn channel_members_follow_the_latest_join_or_leave() {
    let repo = Repo::new();
    let main = &repo.main;
    group::create(main, "g").unwrap();
    let join = |name: &str, pane: &str| {
        group::append(
            main,
            "g",
            serde_json::json!({"kind": "joined", "author": name, "target_ref": pane, "agent": "claude", "collect": true}),
        )
        .unwrap();
    };
    join("claude-1", "p1");
    join("lead", "p0");
    group::append(
        main,
        "g",
        serde_json::json!({"kind": "left", "author": "claude-1"}),
    )
    .unwrap();
    join("claude-1", "p2");
    let events = group::events(main, "g").unwrap();
    let members = group::members(&events);
    assert_eq!(
        members.iter().map(|m| m.name.as_str()).collect::<Vec<_>>(),
        ["lead", "claude-1"],
        "rejoin moves to the end and is active again"
    );
    assert_eq!(members[1].bodies.len(), 1);
    assert_eq!(members[1].bodies[0].target_ref, "p2");
    assert!(members[1].bodies[0].collect);

    // 一个专家两个终端：仍是一个成员；走一个终端只去掉它，最后一个走了才离群。
    join("claude-1", "p3");
    let events = group::events(main, "g").unwrap();
    let member = group::member_of(&events, "p3").unwrap();
    assert_eq!(member.name, "claude-1");
    assert_eq!(member.bodies.iter().map(|b| b.target_ref.as_str()).collect::<Vec<_>>(), ["p2", "p3"]);
    let leave = |pane: &str| {
        group::append(main, "g", serde_json::json!({"kind": "left", "author": "claude-1", "target_ref": pane})).unwrap();
    };
    leave("p2");
    let events = group::events(main, "g").unwrap();
    assert_eq!(group::member_of(&events, "p2"), None);
    assert_eq!(group::member_of(&events, "p3").unwrap().joined_seq, member.joined_seq, "还在群，入群时间不变");
    leave("p3");
    let events = group::events(main, "g").unwrap();
    assert_eq!(group::members(&events).iter().map(|m| m.name.as_str()).collect::<Vec<_>>(), ["lead"]);
}

#[test]
fn channel_idempotent_append_and_addressed_read() {
    let repo = Repo::new();
    let main = &repo.main;
    group::create(main, "g").unwrap();
    assert_eq!(
        group::create(main, "g").unwrap_err().code,
        "already_exists"
    );
    let first = group::append_new(
        main,
        "g",
        serde_json::json!({"kind": "message", "author": "user", "to": "a", "text": "x", "idempotency_key": "k"}),
    )
    .unwrap();
    let again = group::append_new(
        main,
        "g",
        serde_json::json!({"kind": "message", "author": "user", "to": "a", "text": "y", "idempotency_key": "k"}),
    )
    .unwrap();
    assert!(first.1 && !again.1);
    assert_eq!(again.0["text"], "x");
    group::append(
        main,
        "g",
        serde_json::json!({"kind": "message", "author": "user", "to": "b", "text": "z"}),
    )
    .unwrap();
    group::append(
        main,
        "g",
        serde_json::json!({"kind": "message", "author": "user", "text": "all"}),
    )
    .unwrap();
    let events = group::events(main, "g").unwrap();
    let read = group::read(&events, 1, Some("a"));
    let texts: Vec<&str> = read["events"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|e| e["text"].as_str())
        .collect();
    assert_eq!(texts, ["x", "all"]);
    assert_eq!(read["nextAfter"], 4);
}

#[test]
fn unread_counts_messages_for_the_user_after_the_read_mark() {
    let repo = Repo::new();
    let main = &repo.main;
    group::create(main, "g").unwrap();
    let post = |event: Value| group::append(main, "g", event).unwrap();
    post(serde_json::json!({"kind": "message", "author": "a", "to": "user", "text": "旧"}));
    // 第一次读：历史不算未读。
    assert_eq!(group::unread(main, "g", None).unwrap(), 0);
    post(serde_json::json!({"kind": "message", "author": "a", "to": "user", "text": "给我"}));
    post(serde_json::json!({"kind": "message", "author": "a", "text": "全体"}));
    post(serde_json::json!({"kind": "message", "author": "a", "to": "b", "text": "给别人"}));
    post(serde_json::json!({"kind": "message", "author": "user", "to": "a", "text": "我发的"}));
    let last = post(serde_json::json!({"kind": "joined", "author": "c"}));
    assert_eq!(group::unread(main, "g", None).unwrap(), 2);
    assert_eq!(group::unread(main, "g", Some(group::seq(&last))).unwrap(), 0);
    // 已读位置不倒退。
    assert_eq!(group::unread(main, "g", Some(1)).unwrap(), 0);
}

#[test]
fn a_renamed_worktree_keeps_its_group_and_tasks() {
    let repo = Repo::new();
    let (group, old) = repo.start();
    let new = old.parent().unwrap().join("proj-renamed");
    sh(&repo.main, &["git", "-C", old.to_str().unwrap(), "branch", "-m", "demo", "renamed"]);
    sh(&repo.main, &["git", "worktree", "move", old.to_str().unwrap(), new.to_str().unwrap()]);
    group::move_checkout(&repo.main, &old, &new, Some(("demo", "renamed"))).unwrap();

    let env = group::env(&repo.main, &group).unwrap().unwrap();
    assert!(git::same_path(Path::new(&env.worktree), &new));
    assert_eq!(env.branch, "renamed");
    // 对账不新建群：改名后的目录仍是原来那个群。
    let (found, _) = group::checkout_group(&new).unwrap();
    assert_eq!(found, group);
    assert_eq!(
        group::group_of_task(&repo.main, "10-01-demo").unwrap(),
        Some(group)
    );
}

#[test]
fn view_counts_base_commits_the_branch_lacks() {
    let repo = Repo::new();
    repo.start();
    assert_eq!(show(&repo.main, Some("demo")).unwrap().behind, 0);
    repo.commit(&repo.main, "b.txt", "base moved");
    assert_eq!(show(&repo.main, Some("demo")).unwrap().behind, 1);
}

#[test]
fn delivery_states_follow_markers_and_membership() {
    let repo = Repo::new();
    let main = &repo.main;
    group::create(main, "g").unwrap();
    let post = |to: &str| {
        group::append(
            main,
            "g",
            serde_json::json!({"kind": "message", "author": "user", "to": to, "text": "x"}),
        )
        .map(|event| group::seq(&event))
        .unwrap()
    };
    let early = post("a"); // a 还没入群
    group::append(
        main,
        "g",
        serde_json::json!({"kind": "joined", "author": "a", "target_ref": "pane-a"}),
    )
    .unwrap();
    group::append(
        main,
        "g",
        serde_json::json!({"kind": "joined", "author": "b", "target_ref": "pane-b"}),
    )
    .unwrap();
    let sent = post("a");
    let waiting = post("a");
    let gone = post("b");
    group::append(main, "g", serde_json::json!({"kind": "message", "author": "a", "to": "user", "source": "transcript", "text": "r"})).unwrap();
    group::set_delivered(main, "g", "a", "pane-a", sent).unwrap();
    group::append(
        main,
        "g",
        serde_json::json!({"kind": "left", "author": "b"}),
    )
    .unwrap();

    let states = group::delivery_states(main, "g", &group::events(main, "g").unwrap());
    assert_eq!(states.get(&early), Some(&"undelivered"));
    assert_eq!(states.get(&sent), Some(&"delivered"));
    assert_eq!(states.get(&waiting), Some(&"queued"));
    assert_eq!(states.get(&gone), Some(&"undelivered"));
    assert_eq!(states.len(), 4, "汇报不算");
}

#[test]
fn group_cleanup_blocks_unmerged_dirty_and_open_tasks() {
    let repo = Repo::new();
    let (group, wt) = repo.start();
    let group = group.as_str();
    repo.commit(&wt, "a.txt", "feat: a");
    complete(&repo.main, Some("demo")).unwrap();
    let inspect = FinishOptions {
        dry_run: true,
        ..Default::default()
    };
    let plan = finish_group(&repo.main, group, inspect).unwrap();
    assert_eq!(plan["ready"], false);
    assert_eq!(plan["merged"], false);
    assert_eq!(
        finish_group(&repo.main, group, FinishOptions::default())
            .unwrap_err()
            .code,
        "invalid_state"
    );
    sh(
        &repo.main,
        &["git", "merge", "-q", "--no-ff", "-m", "merge", "demo"],
    );
    fs::write(wt.join("a.txt"), "edited").unwrap();
    fs::write(wt.join("new.txt"), "x").unwrap();
    let plan = finish_group(&repo.main, group, inspect).unwrap();
    assert_eq!(plan["dirty"], serde_json::json!(["a.txt", "new.txt"]));
    assert_eq!(plan["ready"], false);
    assert_eq!(
        finish_group(&repo.main, group, FinishOptions::default())
            .unwrap_err()
            .code,
        "dirty"
    );
    assert!(wt.is_dir());
    assert!(git::branch_exists(&repo.main, "demo"));
    sh(&wt, &["git", "checkout", "--", "a.txt"]);
    fs::remove_file(wt.join("new.txt")).unwrap();
    assert_eq!(
        finish_group(&repo.main, group, inspect).unwrap()["ready"],
        true
    );
    let result = finish_group(&repo.main, group, FinishOptions::default()).unwrap();
    assert_eq!(result["commit"].as_str().map(str::len), Some(40));
    assert!(!wt.exists());
    assert!(!git::branch_exists(&repo.main, "demo"));
    assert_eq!(git::worktrees(&repo.main).len(), 1);
    assert!(show(&repo.main, Some("demo")).unwrap().archived);
    // 群随目录一起删除：没有元数据、没有账本，只在 `retired` 留原目录（会话列表仍按它归组）。
    assert_eq!(group::info(&repo.main, group).unwrap(), None);
    assert!(group::events(&repo.main, group).unwrap().is_empty());
    assert_eq!(
        repo.groups()["retired"][group]["worktree"].as_str(),
        Some(wt.to_str().unwrap())
    );
    assert_eq!(
        finish_group(&repo.main, group, inspect).unwrap_err().code,
        "invalid_group"
    );
}

#[test]
fn cancellation_preserves_unmerged_code_regardless_of_legacy_branch_flag() {
    for keep_branch in [true, false] {
        let repo = Repo::new();
        let (_, wt) = repo.start();
        repo.commit(&wt, "a.txt", "feat: a");
        finish(
            &repo.main,
            "demo",
            FinishOptions {
                abandon: true,
                keep_branch,
                ..Default::default()
            },
        )
        .unwrap();
        let view = show(&repo.main, Some("demo")).unwrap();
        assert!(view.archived);
        assert_eq!(view.state, "completed");
        assert_eq!(view.cancel_reason.as_deref(), Some("Cancelled"));
        assert!(wt.join("a.txt").is_file());
        assert!(git::branch_exists(&repo.main, "demo"));
        assert!(group::env(
            &repo.main,
            &group::group_of_task(&repo.main, "10-01-demo")
                .unwrap()
                .unwrap()
        )
        .unwrap()
        .is_some());
    }
}

#[test]
fn rename_sets_a_unique_label_that_survives_rejoin() {
    let repo = Repo::new();
    let main = &repo.main;
    group::create(main, "g").unwrap();
    for (name, pane) in [("claude-1", "p1"), ("codex-1", "p2")] {
        group::append(
            main,
            "g",
            serde_json::json!({"kind": "joined", "author": name, "target_ref": pane}),
        )
        .unwrap();
    }
    group::rename(main, "g", "claude-1", Some(" 前端 ")).unwrap();
    for (label, code) in [
        ("claude-1", "already_exists"),
        ("前端", "already_exists"),
        ("user", "already_exists"),
        ("a b", "invalid_input"),
        ("@x", "invalid_input"),
    ] {
        assert_eq!(
            group::rename(main, "g", "codex-1", Some(label))
                .unwrap_err()
                .code,
            code,
            "{label}"
        );
    }
    assert_eq!(
        group::rename(main, "g", "nobody", Some("x"))
            .unwrap_err()
            .code,
        "not_found"
    );
    // 自己改回同名不算冲突；离群再入群仍保留显示名。
    group::rename(main, "g", "claude-1", Some("前端")).unwrap();
    group::append(
        main,
        "g",
        serde_json::json!({"kind": "left", "author": "claude-1"}),
    )
    .unwrap();
    group::append(
        main,
        "g",
        serde_json::json!({"kind": "joined", "author": "claude-1", "target_ref": "p3"}),
    )
    .unwrap();
    let label = |events: &[Value], name: &str| {
        group::roster(events)
            .into_iter()
            .find(|(m, _)| m.name == name)
            .unwrap()
            .0
            .label
    };
    let events = group::events(main, "g").unwrap();
    assert_eq!(label(&events, "claude-1").as_deref(), Some("前端"));
    assert_eq!(label(&events, "codex-1"), None);
    group::rename(main, "g", "claude-1", Some("")).unwrap();
    let events = group::events(main, "g").unwrap();
    assert_eq!(label(&events, "claude-1"), None);
    group::rename(main, "g", "codex-1", Some("codex-1")).unwrap();
    let events = group::events(main, "g").unwrap();
    assert_eq!(label(&events, "codex-1"), None);
}

#[test]
fn assign_moves_tasks_between_groups_and_finish_returns_open_ones_to_main() {
    let repo = Repo::new();
    let (group, _) = repo.start();
    // 归入的任务在新群组里
    assert_eq!(
        group::group_of_task(&repo.main, "10-01-demo").unwrap(),
        Some(group.clone())
    );
    // 分配到 main / 不存在的群组
    assert_eq!(
        assign(&repo.main, "demo", "main").unwrap_err().code,
        "migration_required"
    );
    assert_eq!(
        assign(&repo.main, "demo", "nope").unwrap_err().code,
        "invalid_group"
    );
    assign(&repo.main, "demo", &group).unwrap();
    assert_eq!(
        group::group_of_task(&repo.main, "10-01-demo").unwrap(),
        Some(group)
    );
}

#[test]
fn a_task_assigned_to_a_worktree_group_inherits_its_branch_and_worktree() {
    let repo = Repo::new();
    let (group, wt) = repo.start();
    create(
        &repo.main,
        CreateOptions {
            title: "Other".into(),
            slug: Some("other".into()),
            description: String::new(),
            branch: None,
            base: None,
            idea: None,
        },
    )
    .unwrap();
    assert_eq!(show(&repo.main, Some("other")).unwrap().worktree, None);
    assign(&repo.main, "other", &group).unwrap();
    let view = show(&repo.main, Some("other")).unwrap();
    assert_eq!(view.worktree.as_deref(), wt.to_str());
    assert_eq!(view.branch.as_deref(), Some("demo"));
}

#[test]
fn legacy_started_tasks_migrate_to_their_project_group() {
    let repo = Repo::new();
    let (_, wt) = repo.start();
    // 模拟旧数据：没有 group 字段，环境绑在任务自己身上（旧开工写的）
    state::update(&repo.main, |live| {
        let entry = live.tasks.get_mut("10-01-demo").unwrap();
        entry.group = None;
        entry.branch = Some("demo".into());
        entry.worktree = Some(wt.to_string_lossy().into_owned());
        live.version = 1;
        Ok(())
    })
    .unwrap();
    let view = show(&repo.main, Some("demo")).unwrap();
    assert_eq!(
        view.group,
        group::checkout_group(Path::new(view.worktree.as_deref().unwrap()))
            .unwrap()
            .0
    );
}

fn new_task(repo: &Repo, slug: &str) {
    create(
        &repo.main,
        CreateOptions {
            title: slug.into(),
            slug: Some(slug.into()),
            description: String::new(),
            branch: None,
            base: None,
            idea: None,
        },
    )
    .unwrap();
}

#[test]
fn a_new_worktree_group_takes_the_main_branch_as_base() {
    let repo = Repo::new();
    let (group, wt) = repo.start();
    let env = group::env(
        &repo.main,
        &group::group_of_task(&repo.main, "10-01-demo")
            .unwrap()
            .unwrap(),
    )
    .unwrap()
    .unwrap();
    assert_eq!(env.branch, "demo");
    assert_eq!(env.base_branch, "dev");
    assert_eq!(Some(env.worktree.as_str()), wt.to_str());
    let stored = &repo.groups()["groups"][&group]["env"];
    assert_eq!(stored["baseBranch"], "dev");
    // 旧对账记录的基线等于分支本身：下次对账改回主项目当前分支。
    let stale = group::GroupEnv {
        base_branch: "demo".into(),
        ..env.clone()
    };
    group::set_env(&repo.main, &group, Some(&stale)).unwrap();
    group::checkout_groups(&repo.main).unwrap();
    assert_eq!(
        group::env(&repo.main, &group)
            .unwrap()
            .unwrap()
            .base_branch,
        "dev"
    );
    // 修不了（主项目游离 HEAD）时收尾不把它当成已合并。
    sh(&repo.main, &["git", "checkout", "-q", "--detach"]);
    group::set_env(&repo.main, &group, Some(&stale)).unwrap();
    complete(&repo.main, Some("demo")).unwrap();
    let plan = finish_group(
        &repo.main,
        &group,
        FinishOptions {
            dry_run: true,
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(plan["merged"], false);
    assert_eq!(plan["ready"], false);
    sh(&repo.main, &["git", "checkout", "-q", "dev"]);
    // 主目录也是项目群组。
    group::ensure_group(&repo.main, "main").unwrap();
    assert_eq!(
        group::env(&repo.main, "main").unwrap().unwrap().worktree,
        repo.main.to_string_lossy()
    );
}

#[test]
fn group_environment_survives_all_tasks_archiving() {
    let repo = Repo::new();
    let (group, wt) = repo.start();
    new_task(&repo, "other");
    assign(&repo.main, "other", &group).unwrap();
    // 提供环境的任务归档后，剩余任务仍使用群环境。
    complete(&repo.main, Some("demo")).unwrap();
    let view = show(&repo.main, Some("other")).unwrap();
    assert_eq!(view.branch.as_deref(), Some("demo"));
    assert_eq!(view.worktree.as_deref(), wt.to_str());
    // 全部任务归档后，群环境仍然存在。
    complete(&repo.main, Some("other")).unwrap();
    assert!(group::env(&repo.main, &group).unwrap().is_some());
}

#[test]
fn a_group_without_env_never_borrows_from_tasks() {
    let repo = Repo::new();
    let (group, _) = repo.start();
    // 模拟旧群：没有 env 字段。
    group::set_env(&repo.main, &group, None).unwrap();
    new_task(&repo, "other");
    assert_eq!(
        assign(&repo.main, "other", &group).unwrap_err().code,
        "invalid_group"
    );
    let view = show(&repo.main, Some("other")).unwrap();
    assert_eq!(view.branch, None);
    assert_eq!(view.worktree, None);
}

#[test]
fn one_worktree_belongs_to_one_group() {
    let repo = Repo::new();
    let path = repo
        .main
        .parent()
        .unwrap()
        .join("proj-demo")
        .to_string_lossy()
        .into_owned();
    group::ensure_group(&repo.main, "other-group").unwrap();
    let taken = group::GroupEnv {
        branch: "x".into(),
        base_branch: "dev".into(),
        worktree: path,
    };
    group::set_env(&repo.main, "other-group", Some(&taken)).unwrap();
    assert_eq!(
        group::set_env(&repo.main, "ghost", Some(&taken))
            .unwrap_err()
            .code,
        "not_found"
    );
}

#[test]
fn finish_clears_the_group_environment() {
    let repo = Repo::new();
    let (group, wt) = repo.start();
    repo.commit(&wt, "a.txt", "feat: a\n\nTask: 10-01-demo S1");
    sh(
        &repo.main,
        &["git", "merge", "-q", "--no-ff", "-m", "merge", "demo"],
    );
    complete(&repo.main, Some("demo")).unwrap();
    finish_group(
        &repo.main,
        &group,
        FinishOptions {
            dry_run: false,
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(group::env(&repo.main, &group).unwrap(), None);
}

#[test]
fn complete_archives_in_one_step_and_reopen_returns_to_running() {
    let repo = Repo::new();
    new_task(&repo, "one");
    let done = complete(&repo.main, Some("one")).unwrap();
    assert_eq!(done["archived"], true);
    let view = show(&repo.main, Some("one")).unwrap();
    assert!(view.archived);
    assert_eq!(view.state, "completed");
    assert_eq!(view.cancel_reason, None);
    assert!(!repo
        .main
        .join(".berth/tasks")
        .join(format!("{}.md", view.task_dir_name))
        .exists());
    // 已归档的不能再完成
    assert_eq!(
        complete(&repo.main, Some("one")).unwrap_err().code,
        "invalid_state"
    );

    let reopened = reopen(&repo.main, "one").unwrap();
    assert_eq!(reopened["archived"], false);
    let view = show(&repo.main, Some("one")).unwrap();
    assert!(!view.archived);
    assert_eq!(view.state, "running");
    assert!(repo
        .main
        .join(".berth/tasks")
        .join(format!("{}.md", view.task_dir_name))
        .is_file());
    // 没归档的不能重开
    assert_eq!(reopen(&repo.main, "one").unwrap_err().code, "invalid_state");
}

#[test]
fn archiving_an_open_task_cancels_it_with_a_reason_and_keeps_the_worktree() {
    let repo = Repo::new();
    // 待开始：直接归档，原因可省
    new_task(&repo, "plan");
    archive(&repo.main, "plan", None).unwrap();
    let view = show(&repo.main, Some("plan")).unwrap();
    assert!(view.archived);
    assert_eq!(view.cancel_reason.as_deref(), Some(""));

    // 进行中：带原因取消，worktree 与分支不动
    let (_, wt) = repo.start();
    archive(&repo.main, "demo", Some("不做了")).unwrap();
    let view = show(&repo.main, Some("demo")).unwrap();
    assert!(view.archived);
    assert_eq!(view.cancel_reason.as_deref(), Some("不做了"));
    assert!(wt.is_dir());
    assert!(git::branch_exists(&repo.main, "demo"));

    // 重开清掉取消原因
    reopen(&repo.main, "demo").unwrap();
    assert_eq!(show(&repo.main, Some("demo")).unwrap().cancel_reason, None);
    // 已完成的任务照旧能直接归档（兼容旧流程）
    new_task(&repo, "old");
    done(&repo.main, Some("old")).unwrap();
    archive(&repo.main, "old", None).unwrap();
    assert_eq!(show(&repo.main, Some("old")).unwrap().cancel_reason, None);
}

#[test]
fn archiving_the_last_task_only_hints_and_keeps_the_group_environment() {
    let repo = Repo::new();
    let (group, wt) = repo.start();
    new_task(&repo, "other");
    assign(&repo.main, "other", &group).unwrap();

    let first = complete(&repo.main, Some("demo")).unwrap();
    assert_eq!(first["groupAllArchived"], false);
    let last = complete(&repo.main, Some("other")).unwrap();
    assert_eq!(last["groupAllArchived"], true);
    assert_eq!(last["group"], group.as_str());
    // 仅提示：worktree、分支、群环境都还在
    assert!(wt.is_dir());
    assert!(git::branch_exists(&repo.main, "demo"));
    assert!(group::env(&repo.main, &group).unwrap().is_some());
}

#[test]
fn group_cleanup_requires_all_tasks_archived_and_preserves_membership() {
    let repo = Repo::new();
    let (group, wt) = repo.start();
    let group = group.as_str();
    new_task(&repo, "other");
    assign(&repo.main, "other", group).unwrap();
    repo.commit(&wt, "a.txt", "feat: a");
    sh(
        &repo.main,
        &["git", "merge", "-q", "--no-ff", "-m", "merge", "demo"],
    );
    let inspect = FinishOptions {
        dry_run: true,
        ..Default::default()
    };
    assert_eq!(
        finish_group(&repo.main, group, inspect).unwrap()["openTasks"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    complete(&repo.main, Some("demo")).unwrap();
    let plan = finish_group(&repo.main, group, inspect).unwrap();
    assert_eq!(plan["openTasks"].as_array().unwrap().len(), 1);
    assert_eq!(plan["ready"], false);
    assert_eq!(
        finish_group(&repo.main, group, FinishOptions::default())
            .unwrap_err()
            .code,
        "invalid_state"
    );
    assert!(wt.is_dir());
    assert_eq!(show(&repo.main, Some("other")).unwrap().group, group);
    complete(&repo.main, Some("other")).unwrap();
    assert_eq!(
        finish_group(&repo.main, group, inspect).unwrap()["ready"],
        true
    );
    finish_group(&repo.main, group, FinishOptions::default()).unwrap();
    assert!(!wt.exists());
    assert_eq!(show(&repo.main, Some("other")).unwrap().group, group);
    assert!(show(&repo.main, Some("other")).unwrap().archived);
}

#[test]
fn worktree_task_creation_uses_its_group_and_main_content_root() {
    let repo = Repo::new();
    let (group, path) = repo.start();
    let created = create(
        &path,
        CreateOptions {
            title: "New shared task".into(),
            slug: Some("new-shared".into()),
            description: "".into(),
            branch: None,
            base: None,
            idea: None,
        },
    )
    .unwrap();
    let name = created["taskDirName"].as_str().unwrap();
    assert!(repo.main.join(".berth/tasks").join(format!("{name}.md")).is_file());
    assert!(!path.join(".berth/tasks").join(format!("{name}.md")).exists());
    assert_eq!(
        group::group_of_task(&repo.main, name)
            .unwrap()
            .as_deref(),
        Some(group.as_str())
    );
    let view = show(&path, Some(name)).unwrap();
    assert_eq!(view.state, "planning");
    assert_eq!(view.worktree.as_deref(), Some(path.to_str().unwrap()));
    assert!(created["task"].get("assignee").is_none());
}

#[test]
fn checkout_group_is_independent_of_tasks_and_preserves_history() {
    let repo = Repo::new();
    let worktree = repo.worktree("empty");
    group::ensure_group(&repo.main, group::MAIN_GROUP).unwrap();
    group::append(
        &repo.main,
        group::MAIN_GROUP,
        serde_json::json!({"kind": "joined", "author": "codex-1", "agent": "codex"}),
    )
    .unwrap();
    let (hub_name, hub_env) = group::checkout_group(&repo.main).unwrap();
    assert_eq!(hub_name, "main");
    assert!(git::same_path(Path::new(&hub_env.worktree), &repo.main));
    assert_eq!(
        group::members(&group::events(&repo.main, &hub_name).unwrap()).len(),
        1
    );
    let (name, env) = group::checkout_group(&worktree).unwrap();
    assert_ne!(name, hub_name);
    assert!(git::same_path(Path::new(&env.worktree), &worktree));
    assert_eq!(group::checkout_group(&worktree).unwrap().0, name);
    assert_eq!(group::checkout_groups(&repo.main).unwrap().len(), 2);
    let created = create(
        &worktree,
        CreateOptions {
            title: "Empty checkout task".into(),
            slug: Some("empty-task".into()),
            description: "".into(),
            branch: None,
            base: None,
            idea: None,
        },
    )
    .unwrap();
    assert_eq!(
        group::group_of_task(&repo.main, created["taskDirName"].as_str().unwrap()).unwrap(),
        Some(name)
    );
}

#[test]
fn bound_session_follows_the_hook_reported_state() {
    let repo = Repo::new();
    group::ensure_group(&repo.main, group::MAIN_GROUP).unwrap();
    group::append(
        &repo.main,
        group::MAIN_GROUP,
        serde_json::json!({"kind":"joined", "author":"worker", "target_ref":"pane"}),
    )
    .unwrap();
    let path = group::member_state_path(&repo.main, group::MAIN_GROUP, "worker", "pane");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, r#"{"sessionId":"native-1"}"#).unwrap();
    assert_eq!(
        group::bound_session_id(&repo.main, group::MAIN_GROUP, "pane"),
        Some("native-1".into())
    );
    group::append(
        &repo.main,
        group::MAIN_GROUP,
        serde_json::json!({"kind":"message", "author":"worker", "session_id":"native-1"}),
    )
    .unwrap();
    fs::write(&path, r#"{"sessionId":"native-2"}"#).unwrap();
    assert_eq!(
        group::bound_session_id(&repo.main, group::MAIN_GROUP, "pane"),
        Some("native-2".into())
    );
    assert_eq!(
        group::bound_session_id(&repo.main, group::MAIN_GROUP, "unknown"),
        None
    );
}

#[test]
fn resolve_gives_one_scope_for_every_directory_shape() {
    let same = |a: &Path, b: &Path| assert!(git::same_path(a, b), "{a:?} != {b:?}");
    // 仓库根与其子目录。
    let repo = Repo::new();
    let nested = repo.main.join("src/deep");
    fs::create_dir_all(&nested).unwrap();
    for dir in [&repo.main, &nested] {
        let scope = resolve(dir).unwrap();
        same(&scope.checkout, &repo.main);
        same(&scope.main, &repo.main);
    }
    // worktree：内容在自己的 checkout，主项目是带标记的那份。
    let wt = repo.worktree("feat");
    let scope = resolve(&wt).unwrap();
    same(&scope.checkout, &wt);
    same(&scope.main, &repo.main);

    // 仓库子目录里的项目；仓库根本身未启用。
    let tmp = tempfile::tempdir().unwrap();
    sh(tmp.path(), &["git", "init", "-q", "-b", "dev"]);
    assert_eq!(resolve(tmp.path()).unwrap_err().code, "not_initialized");
    let project = tmp.path().join("sub");
    fs::create_dir(&project).unwrap();
    assert!(!crate::berth_dir::enabled_at(&project));
    crate::berth_dir::init(&project).unwrap();
    assert!(crate::berth_dir::enabled_at(&project));
    let scope = resolve(&project).unwrap();
    same(&scope.checkout, &project);
    same(&scope.main, &project);
    let (group, env) = group::checkout_group(&project).unwrap();
    assert_eq!(group, "main");
    same(Path::new(&env.worktree), &project);

    // 非 git 目录。
    let plain = tempfile::tempdir().unwrap();
    assert_eq!(resolve(plain.path()).unwrap_err().code, "not_initialized");
    crate::berth_dir::init(plain.path()).unwrap();
    same(&resolve(plain.path()).unwrap().main, plain.path());
}

#[test]
fn legacy_channel_layout_moves_to_groups_and_retires_unused_ledgers() {
    let repo = Repo::new();
    let main = &repo.main;
    let local = main.join(".berth/local");
    let old = local.join("channel");
    fs::create_dir_all(&old).unwrap();
    let gone = repo._tmp.path().join("gone-worktree");
    fs::write(
        old.join("channels.json"),
        serde_json::json!({"version": 1, "channels": {
            "main": {"description": null, "task": null, "env": {"branch": "main", "baseBranch": "main", "worktree": main}},
            "checkout-gone": {"env": {"branch": "x", "baseBranch": "main", "worktree": gone}},
            "10-01-demo": {"task": "10-01-demo"},
            "empty-task": {"task": "empty-task"},
        }})
        .to_string(),
    )
    .unwrap();
    let line = |value: serde_json::Value| format!("{value}\n");
    fs::write(old.join("main.jsonl"), line(serde_json::json!({"seq": 1, "kind": "created", "channel": "main"}))).unwrap();
    fs::write(
        old.join("checkout-gone.jsonl"),
        line(serde_json::json!({"seq": 1, "kind": "joined", "author": "1", "target_ref": "t1", "timestamp_ms": 7})),
    )
    .unwrap();
    fs::write(
        old.join("10-01-demo.jsonl"),
        line(serde_json::json!({"seq": 1, "kind": "message", "author": "a", "session_id": "s1", "timestamp_ms": 5})),
    )
    .unwrap();
    let runtime = local.join("runtime");
    let doorbell = group::delivery_path(main, "checkout-gone", "1", "t1");
    fs::create_dir_all(doorbell.parent().unwrap()).unwrap();
    fs::write(doorbell.with_extension("seq"), "1").unwrap();
    fs::write(runtime.join("doorbell/stale.collector"), "").unwrap();
    fs::write(runtime.join("before-project-groups.json"), "{}").unwrap();

    let meta = group::meta(main).unwrap();
    assert_eq!(meta["groups"].as_object().unwrap().keys().collect::<Vec<_>>(), ["main"]);
    assert_eq!(meta["groups"]["main"].get("task"), None, "dead fields are dropped");
    // 有目录或有会话的旧群留一行；两样都没有的（empty-task）什么都不留。
    assert_eq!(
        meta["retired"],
        serde_json::json!({
            "10-01-demo": {"worktree": null, "sessions": ["s1"], "since": 5},
            "checkout-gone": {"worktree": gone, "sessions": [], "since": null},
        })
    );
    assert_eq!(group::events(main, "main").unwrap().len(), 1);
    assert!(!old.exists());
    assert!(fs::read_dir(&local)
        .unwrap()
        .flatten()
        .any(|entry| entry.file_name().to_string_lossy().starts_with("channel.bak-")));
    assert!(!local.join("groups/checkout-gone.jsonl").exists());
    assert!(!doorbell.with_extension("seq").exists());
    assert!(!runtime.join("doorbell/stale.collector").exists());
    assert!(!runtime.join("before-project-groups.json").exists());

    // 旧版 berth 迁移后又建出 `local/channel/`：不再迁移，`groups/` 原样，旧目录留给旧版自己用。
    group::append(main, "main", serde_json::json!({"kind": "message", "author": "user"})).unwrap();
    fs::create_dir_all(&old).unwrap();
    fs::write(
        old.join("channels.json"),
        serde_json::json!({"version": 1, "channels": {
            "main": {"env": {"branch": "dev", "baseBranch": "dev", "worktree": main}},
        }})
        .to_string(),
    )
    .unwrap();
    fs::write(old.join("main.jsonl"), line(serde_json::json!({"seq": 1, "kind": "created"}))).unwrap();
    assert_eq!(group::events(main, "main").unwrap().len(), 2);
    assert!(old.join("main.jsonl").is_file());
}

#[test]
fn a_new_project_writes_no_migration_backup() {
    let repo = Repo::new();
    group::checkout_groups(&repo.main).unwrap();
    assert!(!repo.main.join(".berth/local/runtime/before-project-groups.json").exists());
    assert_eq!(
        repo.groups()["groups"].as_object().unwrap().keys().collect::<Vec<_>>(),
        ["main"]
    );
}

#[test]
fn run_results_live_under_berth_runs_by_task_name_and_survive_archive() {
    let repo = Repo::new();
    let written = write_run_result(&repo.main, "demo", "2026-10-21-0800", "  论文 A\n").unwrap();
    let path = repo.main.join(".berth/runs/10-01-demo/2026-10-21-0800.md");
    assert_eq!(written["path"].as_str().unwrap(), path.to_str().unwrap());
    assert_eq!(fs::read_to_string(&path).unwrap(), "论文 A\n");
    assert!(write_run_result(&repo.main, "demo", "../x", "a").is_err(), "stamp 不能越界");
    assert!(write_run_result(&repo.main, "demo", "s", "  ").is_err(), "空结果");
    archive(&repo.main, "demo", None).unwrap();
    assert_eq!(run_result_path(&repo.main, "demo", "2026-10-21-0800").unwrap(), path);
}

#[test]
fn task_in_a_detached_worktree_group_knows_its_worktree() {
    let repo = Repo::new();
    let path = repo.main.parent().unwrap().join("proj-detached");
    let detached = [
        "git",
        "worktree",
        "add",
        "-q",
        "--detach",
        path.to_str().unwrap(),
    ];
    sh(&repo.main, &detached);
    let (group, _) = group::checkout_groups(&repo.main)
        .unwrap()
        .into_iter()
        .find(|(_, env)| git::same_path(Path::new(&env.worktree), &path))
        .unwrap();
    assign(&repo.main, "demo", &group).unwrap();
    let view = show(&repo.main, Some("demo")).unwrap();
    assert_eq!(view.group, group);
    assert!(
        view.worktree.as_deref().is_some_and(|w| git::same_path(Path::new(w), &path)),
        "worktree = {:?}",
        view.worktree
    );
}

#[test]
fn worktree_lists_only_tasks_assigned_to_its_group_from_main_records() {
    let repo = Repo::new();
    let (group, path) = repo.start();
    create(
        &repo.main,
        CreateOptions {
            title: "留在主项目".into(),
            slug: Some("stay".into()),
            description: String::new(),
            branch: None,
            base: None,
            idea: None,
        },
    )
    .unwrap();
    let ids = |listed: Value| -> Vec<(String, String)> {
        listed["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .map(|task| {
                (
                    task["id"].as_str().unwrap().to_owned(),
                    task["group"].as_str().unwrap().to_owned(),
                )
            })
            .collect()
    };
    let in_worktree = ids(list(&path, true, 100).unwrap());
    assert_eq!(in_worktree, vec![("10-01-demo".to_owned(), group.clone())]);
    let in_main = ids(list(&repo.main, true, 100).unwrap());
    assert_eq!(in_main.len(), 2, "{in_main:?}");
    // worktree 里换了分支也不影响：只看记录。
    sh(&path, &["git", "checkout", "-q", "-b", "renamed"]);
    assert_eq!(ids(list(&path, true, 100).unwrap()).len(), 1);
}
