//! 群账本、git、任务状态都是真的；Agent 插件是假 `BERTH_HOME` 里的声明（不启动进程）。

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

use berth_project_core::tasks::{self, group};
use serde_json::{json, Value};

use crate::{spawn, watch, Ctx};

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

/// 主项目 `<tmp>/proj`（dev 分支、已登记空间、含任务 `10-01-demo`）。
struct Project {
    _tmp: tempfile::TempDir,
    main: PathBuf,
    data: PathBuf,
}

impl Project {
    fn new() -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let main = tmp.path().join("proj");
        fs::create_dir(&main).unwrap();
        sh(&main, &["git", "init", "-q", "-b", "dev"]);
        let data = berth_project_core::space::testing::register(&main);
        berth_project_core::berth_dir::ensure_space(&data).unwrap();
        let task = data.join("tasks/10-01-demo");
        fs::create_dir_all(&task).unwrap();
        fs::write(task.join("task.json"), r#"{"id":"demo","title":"Demo"}"#).unwrap();
        fs::write(task.join("prd.md"), "# Demo\n\n## 步骤\n\n- [ ] S1 做\n").unwrap();
        fs::write(main.join("README.md"), "# Demo\n").unwrap();
        sh(&main, &["git", "add", "-A"]);
        sh(&main, &["git", "commit", "-qm", "init"]);
        Self { _tmp: tmp, main, data }
    }

    fn ctx(&self) -> Ctx {
        Ctx {
            main: self.main.clone(),
            socket: None,
            gui: None,
            cli: PathBuf::from("berth"),
            caller: None,
        }
    }

    /// 真实路径（GUI「New worktree」同款）：建 worktree `../proj-demo` → 对账登记 checkout → 任务归入并开工。
    fn start(&self) -> PathBuf {
        let path = self.main.parent().unwrap().join("proj-demo");
        sh(
            &self.main,
            &["git", "worktree", "add", "-q", "-b", "demo", path.to_str().unwrap()],
        );
        let (group, _) = group::checkout_group(&path).unwrap();
        // worktree 只登记 checkout，不建账本（一个项目一个群）。
        assert!(!group::has_ledger(&self.main, &group));
        tasks::assign(&self.main, "demo", &group).unwrap();
        tasks::begin(&self.main, "demo").unwrap();
        path
    }

    /// 项目群（一个项目一个群）。
    fn group(&self) -> String {
        group::MAIN_GROUP.to_owned()
    }

    /// 任务所在 worktree 的 checkout 群键（spawn `--group` 选目录用）。
    fn checkout(&self) -> String {
        group::group_of_task(&self.main, "10-01-demo")
            .unwrap()
            .unwrap()
    }

    fn events(&self, name: &str) -> Vec<Value> {
        group::events(&self.main, name).unwrap()
    }

    fn messages(&self, name: &str) -> Vec<Value> {
        self.events(name)
            .into_iter()
            .filter(|event| event["kind"] == "message")
            .collect()
    }
}

/// ACP 成员直接写进账本（git 记录只看有没有成员在群）。
fn join(project: &Project, member: &str, cwd: &Path) {
    group::append(
        &project.main,
        &project.group(),
        json!({"kind": "joined", "author": member, "target_ref": format!("acp:{member}"), "agent": "fake", "cwd": cwd, "collect": true}),
    )
    .unwrap();
}

fn record(project: &Project, heads: &mut watch::Heads) {
    watch::record_commits(&project.ctx(), heads);
}

// ---------------------------------------------------------------- git

#[test]
fn commits_are_a_group_event_recorded_once() {
    let project = Project::new();
    let worktree = project.start();
    let mut heads = watch::Heads::new();
    // 没人在群：不记。
    record(&project, &mut heads);
    join(&project, "w", &worktree);
    record(&project, &mut heads); // 起点
    fs::write(worktree.join("a.txt"), "a").unwrap();
    sh(&worktree, &["git", "add", "-A"]);
    sh(&worktree, &["git", "commit", "-qm", "feat: a"]);
    record(&project, &mut heads);
    record(&project, &mut heads);
    let commits = |project: &Project| -> Vec<Value> {
        project.events(&project.group()).into_iter().filter(|event| event["event"] == "commits").collect()
    };
    let got = commits(&project);
    assert_eq!(got.len(), 1);
    assert!(got[0]["commits"][0].as_str().unwrap().ends_with("feat: a"));
    assert!(got[0].get("author").is_none());
    // 后台进程重启：从账本接着比，不重记。
    record(&project, &mut watch::Heads::new());
    assert_eq!(commits(&project).len(), 1);
}

#[test]
fn a_worktree_registered_under_several_keys_records_each_commit_once() {
    let project = Project::new();
    let worktree = project.start();
    // 旧版并发登记留下的重复键：同一目录再挂两个群键。
    let meta_path = project.data.join("local/groups/groups.json");
    let mut meta: Value = serde_json::from_str(&fs::read_to_string(&meta_path).unwrap()).unwrap();
    let entry = meta["groups"][project.checkout().as_str()].clone();
    meta["groups"]["checkout-dup-a"] = entry.clone();
    meta["groups"]["checkout-dup-b"] = entry;
    fs::write(&meta_path, serde_json::to_string(&meta).unwrap()).unwrap();

    join(&project, "w", &worktree);
    let mut heads = watch::Heads::new();
    record(&project, &mut heads);
    fs::write(worktree.join("a.txt"), "a").unwrap();
    sh(&worktree, &["git", "add", "-A"]);
    sh(&worktree, &["git", "commit", "-qm", "feat: a"]);
    record(&project, &mut heads);
    record(&project, &mut heads);
    let commits = project.events(&project.group()).iter().filter(|event| event["event"] == "commits").count();
    assert_eq!(commits, 1);
}

#[test]
fn merges_rewrites_and_resets_are_group_events() {
    let project = Project::new();
    let worktree = project.start();
    join(&project, "w", &worktree);
    let mut heads = watch::Heads::new();
    record(&project, &mut heads); // 起点
    let git_events = |group: &str| -> Vec<Value> {
        project
            .events(group)
            .into_iter()
            .filter(|event| event["kind"] == "system" && event["event"] != "started")
            .collect()
    };

    fs::write(worktree.join("b.txt"), "b").unwrap();
    sh(&worktree, &["git", "add", "-A"]);
    sh(&worktree, &["git", "commit", "-qm", "feat: b"]);
    record(&project, &mut heads);
    // 合并进主 checkout：各 checkout 的提交都记在项目群，带 `checkout`。
    sh(&project.main, &["git", "merge", "--no-ff", "-q", "-m", "merge demo", "demo"]);
    record(&project, &mut heads);
    let git = git_events(&project.group());
    assert_eq!(git.len(), 2);
    assert_eq!(git[0]["checkout"], project.checkout().as_str());
    assert_eq!(git[0]["branch"], "demo");
    assert_eq!(git[0]["merged"], Value::Null);
    assert_eq!(git[1]["checkout"], "main");
    assert_eq!(git[1]["merged"], "demo");
    assert_eq!(git[1]["branch"], "dev");

    // amend 改写历史；回退没有新提交。
    sh(&worktree, &["git", "commit", "-q", "--amend", "-m", "feat: b2"]);
    record(&project, &mut heads);
    sh(&worktree, &["git", "reset", "-q", "--hard", "HEAD~1"]);
    record(&project, &mut heads);
    let git = git_events(&project.group());
    assert_eq!(git[2]["rewritten"], true);
    assert_eq!(git[3]["event"], "head");
    assert_eq!(git[3]["from_branch"], Value::Null);
    // 重启后不重记。
    record(&project, &mut watch::Heads::new());
    assert_eq!(git_events(&project.group()).len(), 4);
}

#[test]
fn hooks_report_state_with_standard_terminal_sequences() {
    use super::{hook_signal, Hook};
    let none = json!({});
    assert_eq!(hook_signal(Hook::TurnStart, &none).unwrap(), "\x1b]9;4;3\x07");
    assert_eq!(hook_signal(Hook::TurnEnd, &none).unwrap(), "\x1b]9;4;0\x07");
    assert_eq!(hook_signal(Hook::Idle, &none).unwrap(), "\x1b]9;4;0\x07");
    assert_eq!(hook_signal(Hook::SessionStart, &json!({"source": "startup"})).unwrap(), "\x1b]9;4;0\x07");
    // 压缩上下文在一轮中间：不报空闲。
    assert_eq!(hook_signal(Hook::SessionStart, &json!({"source": "compact"})), None);
    assert_eq!(
        hook_signal(Hook::Attention, &json!({"tool_name": "Bash"})).unwrap(),
        "\x1b]9;需要授权：Bash\x07"
    );
    // 通知文本去掉控制字符，也不会被当成 `4;` 进度信号。
    assert_eq!(
        hook_signal(Hook::Attention, &json!({"message": "4;1\x07x"})).unwrap(),
        "\x1b]9; 4;1 x\x07"
    );
    assert_eq!(Hook::parse("turn-end"), Some(Hook::TurnEnd));
    assert_eq!(Hook::parse("Stop"), None);
}

// ---------------------------------------------------------------- spawn

/// 假 `BERTH_HOME`：一个声明了 ACP、启动栏有「专家」项的插件 `fake`。环境变量全进程共享，只设一次。
fn fake_home() {
    static HOME: OnceLock<tempfile::TempDir> = OnceLock::new();
    HOME.get_or_init(|| {
        let home = tempfile::tempdir().unwrap();
        let tool = home.path().join("tools/fake");
        fs::create_dir_all(&tool).unwrap();
        fs::write(tool.join("tool.json"), r#"{"id":"fake","contributes":{"agent":{"acp":true}}}"#).unwrap();
        fs::write(tool.join("launchbar.json"), r#"{"items":[{"id":"expert","optionsFrom":"experts"}]}"#).unwrap();
        std::env::set_var("BERTH_HOME", home.path());
        home
    });
}

fn request(worker: &str) -> spawn::SpawnRequest {
    fake_home();
    spawn::SpawnRequest {
        group: "main".into(),
        lead: "lead".into(),
        worker: worker.into(),
        agent: Some("fake".into()),
        expert: Some("dev-expert".into()),
        preset: None,
        branch: None,
        task: Some("demo".into()),
        inputs: Vec::new(),
        text: "做 S1".into(),
    }
}

#[test]
fn spawn_joins_the_worker_as_an_acp_member_in_the_worktree() {
    let project = Project::new();
    project.start();
    let mut input = request("w1");
    input.group = project.checkout();
    let result = spawn::spawn(&project.ctx(), input).unwrap();
    let worktree = PathBuf::from(result["worktree"].as_str().unwrap());
    assert_eq!(worktree, project.main.parent().unwrap().join("proj-demo"));
    assert_eq!(result["branch"], "demo");
    // worker 的成员名是它的专家，`--name` 只作显示名；ACP 进程在 worktree 里起。
    let events = project.events(&project.group());
    let members = group::members(&events);
    let worker = members.iter().find(|member| member.label.as_deref() == Some("w1")).unwrap();
    assert_eq!(result["worker"], "dev-expert");
    assert_eq!(worker.name, "dev-expert");
    assert_eq!(worker.bodies[0].target_ref, "acp:dev-expert");
    let joined = events.iter().find(|event| event["kind"] == "joined").unwrap();
    assert_eq!(PathBuf::from(joined["cwd"].as_str().unwrap()), worktree.canonicalize().unwrap());
    assert_eq!(joined["inputs"]["expert"], "dev-expert");
    let brief = &project.messages(&project.group())[0];
    assert_eq!(brief["to"], "dev-expert");
    assert_eq!(brief["author"], "lead");
    let text = brief["text"].as_str().unwrap();
    assert!(text.contains("任务契约：") && text.contains("自己的分支 demo，"));
    assert!(text.contains("Task: 10-01-demo S<步骤号>"));
    // 同一专家再派一个：编号。
    let mut again = request("w2");
    again.group = project.checkout();
    again.task = None;
    assert_eq!(spawn::spawn(&project.ctx(), again).unwrap()["worker"], "dev-expert-2");
}

#[test]
fn spawn_validation_failures_write_nothing() {
    let project = Project::new();
    let ctx = project.ctx();
    let untouched = |project: &Project| {
        assert_eq!(group::checkout_groups(&project.main).unwrap().len(), 1);
        assert!(project.messages("main").is_empty());
        assert_eq!(sh(&project.main, &["git", "worktree", "list"]).lines().count(), 1);
        assert!(group::members(&project.events("main")).is_empty());
    };
    let mut empty = request("w");
    empty.text = " ".into();
    assert_eq!(spawn::spawn(&ctx, empty).unwrap_err().code, "invalid_input");
    let mut both = request("w");
    both.preset = Some("p".into());
    assert_eq!(spawn::spawn(&ctx, both).unwrap_err().code, "invalid_input");
    let mut missing = request("w");
    missing.agent = None;
    missing.preset = Some("nope".into());
    assert_eq!(spawn::spawn(&ctx, missing).unwrap_err().code, "not_found");
    let mut no_expert = request("w");
    no_expert.expert = None;
    no_expert.task = None;
    assert_eq!(spawn::spawn(&ctx, no_expert).unwrap_err().code, "invalid_input");
    untouched(&project);
}

#[test]
fn spawn_refuses_a_second_group_for_the_same_task() {
    let project = Project::new();
    project.start();
    let mut other = request("w");
    other.group = "elsewhere".into();
    let error = spawn::spawn(&project.ctx(), other).unwrap_err();
    assert_eq!(error.code, "invalid_group");
    assert!(group::info(&project.main, "elsewhere").unwrap().is_none());
}

#[test]
fn presets_validate_and_summarise_without_values() {
    let project = Project::new();
    let path = project.data.join("presets.json");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(
        &path,
        r#"{"version": 1, "presets": {"fast": {"agent": "claude", "inputs": {"model": "x", "yolo": true}, "providerId": 3, "modelId": "m"}}}"#,
    )
    .unwrap();
    let listed = spawn::list_presets(&project.main).unwrap();
    assert_eq!(
        listed,
        json!({"presets": [{"name": "fast", "agent": "claude", "inputs": ["model", "yolo"], "provider": true, "model": "m"}]})
    );
    fs::write(
        &path,
        r#"{"version": 1, "presets": {"bad": {"agent": "claude", "providerId": true}}}"#,
    )
    .unwrap();
    assert_eq!(
        spawn::list_presets(&project.main).unwrap_err().code,
        "invalid_preset"
    );
    fs::write(
        &path,
        r#"{"version": 1, "presets": {"bad": {"agent": "claude", "modelId": "m"}}}"#,
    )
    .unwrap();
    assert_eq!(
        spawn::list_presets(&project.main).unwrap_err().code,
        "invalid_preset"
    );
}
