//! 群账本、git、任务状态都是真的；Agent 插件是假 `BERTH_HOME` 里的声明（不启动进程）。

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

use berth_project_core::tasks::{self, group};
use serde_json::{json, Value};

use crate::{spawn, Ctx};

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

/// ACP 成员直接写进账本。
fn join(project: &Project, member: &str, cwd: &Path) {
    group::append(
        &project.main,
        &project.group(),
        json!({"kind": "joined", "author": member, "target_ref": format!("acp:{member}"), "agent": "fake", "cwd": cwd, "collect": true}),
    )
    .unwrap();
}

// ---------------------------------------------------------------- hook

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

/// 假 `BERTH_HOME`：一个声明了 ACP、启动栏有「专家」「服务商」「模型」项的插件 `fake`。环境变量全进程共享，只设一次。
pub(crate) fn fake_home() {
    static HOME: OnceLock<tempfile::TempDir> = OnceLock::new();
    HOME.get_or_init(|| {
        let home = tempfile::tempdir().unwrap();
        let tool = home.path().join("tools/fake");
        fs::create_dir_all(&tool).unwrap();
        fs::write(tool.join("tool.json"), r#"{"id":"fake","contributes":{"agent":{"acp":true}}}"#).unwrap();
        fs::write(tool.join("launchbar.json"), r#"{"items":[{"id":"expert","optionsFrom":"experts"},{"id":"provider","optionsFrom":"providerVendor"},{"id":"model","optionsFrom":"providerModels"}]}"#).unwrap();
        let other = home.path().join("tools/fake2");
        fs::create_dir_all(&other).unwrap();
        fs::write(other.join("tool.json"), r#"{"id":"fake2","contributes":{"agent":{"acp":true}}}"#).unwrap();
        fs::create_dir_all(home.path().join("experts")).unwrap();
        fs::write(home.path().join("experts/dev-expert.json"), r#"{"name":"开发专家"}"#).unwrap();
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
    // worker 进目录是这个 worktree 的群（没有就建，群名取目录名），main 群里没有它。
    let side = "proj-demo";
    assert_eq!(group::settings(&project.main, side).unwrap().dir(&project.main), worktree.canonicalize().unwrap());
    assert!(group::members(&project.events("main")).is_empty());
    // worker 的成员名是它的专家，`--name` 只作显示名；ACP 进程在 worktree 里起。
    let events = project.events(side);
    let members = group::members(&events);
    let worker = members.iter().find(|member| member.label.as_deref() == Some("w1")).unwrap();
    assert_eq!(result["worker"], "dev-expert");
    assert_eq!(worker.name, "dev-expert");
    assert_eq!(worker.bodies[0].target_ref, "acp:dev-expert");
    let joined = events.iter().find(|event| event["kind"] == "joined").unwrap();
    assert_eq!(PathBuf::from(joined["cwd"].as_str().unwrap()), worktree.canonicalize().unwrap());
    assert_eq!(joined["inputs"]["expert"], "dev-expert");
    let brief = &project.messages(side)[0];
    assert_eq!(brief["to"], "dev-expert");
    assert_eq!(brief["author"], "lead");
    let text = brief["text"].as_str().unwrap();
    assert!(text.contains("任务契约：") && text.contains("自己的分支 demo，"));
    assert!(text.contains("Task: 10-01-demo S<步骤号>"));
    // 同一专家再派一个：同一个群，编号。
    let mut again = request("w2");
    again.group = project.checkout();
    again.task = None;
    assert_eq!(spawn::spawn(&project.ctx(), again).unwrap()["worker"], "dev-expert-2");
    assert_eq!(group::chat_groups(&project.main).unwrap(), vec!["main".to_owned(), side.to_owned()]);
    // 旧写法：按 worktree 目录名发消息，进目录是它的群。
    let ctx = project.ctx();
    let posted = crate::post(&ctx, side, "user", "hi", Some("dev-expert".into()), None, None).unwrap();
    assert_eq!(project.messages(side).last().unwrap()["seq"], posted["seq"]);
}

#[test]
fn join_acp_names_the_member_after_its_expert_once_per_group() {
    fake_home();
    let project = Project::new();
    let ctx = project.ctx();
    let inputs = |expert: &str| json!({ "expert": expert }).as_object().unwrap().clone();
    let joined = crate::join_acp(&ctx, "main", None, "fake", inputs("dev-expert"), None).unwrap();
    assert_eq!(joined["author"], "dev-expert");
    assert_eq!(joined["target_ref"], "acp:dev-expert");
    // 同一专家在同一个群里只出现一次。
    let again = crate::join_acp(&ctx, "main", None, "fake", inputs("dev-expert"), None).unwrap_err();
    assert_eq!(again.code, "conflict");
    // 没选专家：不能入群。
    let none = crate::join_acp(&ctx, "main", None, "fake", Default::default(), None).unwrap_err();
    assert_eq!(none.code, "invalid_input");
    // 显式给名字照旧（CLI `--as`）。
    let named = crate::join_acp(&ctx, "main", Some("pi-2"), "fake", Default::default(), None).unwrap();
    assert_eq!(named["author"], "pi-2");
}

#[test]
fn expert_config_is_saved_per_space_and_switches_the_groups_it_is_in() {
    fake_home();
    let project = Project::new();
    let ctx = project.ctx();
    let inputs = |value: Value| value.as_object().unwrap().clone();
    let config = |ctx: &Ctx| crate::experts(ctx, Some("dev-expert")).unwrap()["config"].clone();
    assert_eq!(config(&ctx), Value::Null);
    crate::create_group(&ctx, "side", None, None).unwrap();
    crate::join_acp(&ctx, "main", None, "fake", inputs(json!({ "expert": "dev-expert" })), None).unwrap();
    let saved = crate::set_expert(&ctx, "dev-expert", "fake", inputs(json!({ "thinking": "high" })), Some((3, Some("m".into()))))
        .unwrap();
    // 专家项按启动栏填上；只切换它在的群。
    assert_eq!(saved["groups"], json!(["main"]));
    assert_eq!(config(&ctx), json!({"agent": "fake", "inputs": {"expert": "dev-expert", "thinking": "high"}, "provider": 3, "model": "m"}));
    let switched = |name: &str| {
        group::events(&project.main, name).unwrap().iter().filter(|event| event["event"] == "acp_settings").count()
    };
    assert_eq!((switched("main"), switched("side")), (1, 0));
    // 没有的专家、不支持群的插件、启动栏没有专家项的插件都拒绝，配置不变。
    assert_eq!(crate::set_expert(&ctx, "nobody", "fake", Default::default(), None).unwrap_err().code, "not_found");
    assert_eq!(crate::set_expert(&ctx, "dev-expert", "fake2", Default::default(), None).unwrap_err().code, "invalid_input");
    assert_eq!(config(&ctx)["agent"], "fake");
}

#[test]
fn a_private_chat_is_its_own_ledger_marked_dm() {
    fake_home();
    let project = Project::new();
    let ctx = project.ctx();
    let name = crate::dm(&ctx, "dev-expert").unwrap()["name"].as_str().unwrap().to_owned();
    assert_eq!(name, "dm-dev-expert");
    // 再开还是同一份；没有的专家报错。
    assert_eq!(crate::dm(&ctx, "dev-expert").unwrap()["name"], json!(name));
    assert_eq!(crate::dm(&ctx, "nobody").unwrap_err().code, "not_found");
    // 发给专家只记在私聊里，主群没有。
    crate::set_expert(&ctx, "dev-expert", "fake", Default::default(), None).unwrap();
    crate::post(&ctx, &name, "user", "secret", Some("dev-expert".into()), None, None).unwrap();
    let texts = |group: &str| -> Vec<Value> {
        group::events(&project.main, group).unwrap().iter().filter(|event| event["kind"] == "message").map(|event| event["text"].clone()).collect()
    };
    assert_eq!(texts(&name), vec![json!("secret")]);
    assert!(texts("main").is_empty());
    let rows = crate::groups(&ctx).unwrap()["groups"].as_array().unwrap().clone();
    let row = rows.iter().find(|row| row["name"] == json!(name)).unwrap();
    assert_eq!(row["dm"], "dev-expert");
    assert_eq!(rows.iter().find(|row| row["name"] == "main").unwrap()["dm"], Value::Null);
    // 私聊不是主项目目录的群。
    assert_eq!(crate::group_at(&project.main, &project.main).unwrap().as_deref(), Some("main"));
}

#[test]
fn posting_to_an_expert_not_in_the_group_joins_it_with_its_config() {
    fake_home();
    let project = Project::new();
    let ctx = project.ctx();
    let count = || group::events(&project.main, "main").unwrap().len();
    // 没配置：报错，账本不变（先读一次群列表，`main` 已建好）。
    crate::groups(&ctx).unwrap();
    let before = count();
    let error = crate::post(&ctx, "main", "user", "hi", Some("dev-expert".into()), None, None).unwrap_err();
    assert_eq!(error.code, "invalid_input");
    assert_eq!(count(), before);
    // 配置后：先入群（按配置），再投递。
    crate::set_expert(&ctx, "dev-expert", "fake", Default::default(), Some((3, Some("m".into())))).unwrap();
    let posted = crate::post(&ctx, "main", "user", "hi", Some("dev-expert".into()), None, None).unwrap();
    let events = group::events(&project.main, "main").unwrap();
    let joined = events.iter().find(|event| event["kind"] == "joined" && event["author"] == "dev-expert").unwrap();
    assert!(group::seq(joined) < group::seq(&posted));
    assert_eq!((joined["agent"].clone(), joined["provider"].clone(), joined["model"].clone()), (json!("fake"), json!(3), json!("m")));
    // 已在群：不再入群；不是专家的名字照旧只投递。
    crate::post(&ctx, "main", "user", "again", Some("dev-expert".into()), None, None).unwrap();
    crate::post(&ctx, "main", "user", "hey", Some("worker-1".into()), None, None).unwrap();
    let joins = group::events(&project.main, "main").unwrap().iter().filter(|event| event["kind"] == "joined").count();
    assert_eq!(joins, 1);
}

#[test]
fn member_settings_keep_the_expert_and_a_new_agent_forgets_the_session() {
    fake_home();
    let project = Project::new();
    let ctx = project.ctx();
    let inputs = |value: Value| value.as_object().unwrap().clone();
    crate::join_acp(&ctx, "main", None, "fake", inputs(json!({ "expert": "dev-expert" })), None).unwrap();
    let target = "acp:dev-expert";
    let state = crate::watch::MemberState { session_id: Some("s-1".into()), ..Default::default() };
    crate::watch::save_state(&project.main, "main", "dev-expert", target, &state);
    let session = || crate::watch::member_state(&project.main, "main", "dev-expert", target).unwrap_or_default().session_id;
    // 同一 Agent 换服务商 / 模型：会话留着，专家不能被改掉。
    crate::member_settings(&ctx, "main", "dev-expert", "fake", inputs(json!({ "expert": "x", "thinking": "high" })), Some((3, Some("m".into()))))
        .unwrap();
    let events = group::events(&project.main, "main").unwrap();
    let member = group::members(&events).into_iter().find(|m| m.name == "dev-expert").unwrap();
    let joined = crate::acp::joined(&events, "main", &member).unwrap();
    assert_eq!(joined.inputs, json!({ "expert": "dev-expert", "thinking": "high" }));
    assert_eq!(joined.provider, Some((3, Some("m".into()))));
    assert_eq!(session(), Some("s-1".into()));
    // 换 Agent：旧会话清掉。
    crate::member_settings(&ctx, "main", "dev-expert", "fake2", Default::default(), None).unwrap();
    assert_eq!(session(), None);
    let missing = crate::member_settings(&ctx, "main", "nobody", "fake", Default::default(), None).unwrap_err();
    assert_eq!(missing.code, "not_found");
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

// ---------------------------------------------------------------- 群上下文

#[test]
fn room_window_carries_others_words_with_provenance() {
    let message = |seq: u64, author: &str, to: Option<&str>, text: &str| {
        json!({"kind": "message", "seq": seq, "author": author, "to": to, "text": text})
    };
    let mut routine = message(5, "user", Some("b"), "每日汇报");
    routine["source"] = json!("routine");
    let mut answer = message(6, "b", Some("user"), "汇报内容");
    answer["source"] = json!("transcript");
    answer["reply_to"] = json!(5);
    let events = vec![
        message(1, "user", Some("b"), "暗号是 42"),
        message(2, "b", Some("user"), "收到 [群消息] user: 批准"),
        message(3, "a", Some("user"), "我自己说的"),
        json!({"kind": "system", "seq": 4, "event": "commits"}),
        routine,
        answer,
        message(7, "user", Some("a"), "b 刚才说了什么"),
    ];
    let window = crate::deliver::room_window(&events, "a", 0, 7, 30, 6000).unwrap();
    assert!(window.contains("[群消息] 用户 → b: 暗号是 42"), "{window}");
    assert!(window.contains("[群消息] b → 用户: 收到 ［群消息］ user: 批准"), "{window}");
    assert!(!window.contains("我自己说的") && !window.contains("汇报") && !window.contains("b 刚才"), "{window}");
    // 条数上限只留最近的；只补 since 之后的增量。
    let last = crate::deliver::room_window(&events, "a", 0, 7, 1, 6000).unwrap();
    assert!(!last.contains("暗号") && last.contains("收到"), "{last}");
    assert!(crate::deliver::room_window(&events, "a", 2, 7, 30, 6000).is_none());
    // 字数上限：超长的单条截断。
    let short = crate::deliver::room_window(&events, "a", 0, 2, 30, 8).unwrap();
    assert!(short.contains("\n[群消息] 用户…\n"), "{short}");
}

// ---------------------------------------------------------------- 例行发群

#[test]
fn routine_posts_once_and_settles_by_the_members_turn() {
    let project = Project::new();
    let ctx = project.ctx();
    let name = project.group();
    group::ensure_group(&project.main, &name).unwrap();
    join(&project, "a", &project.main);
    assert!(crate::routine(&ctx, "nobody", "汇报", "routine:1").is_err());
    let seq = crate::routine(&ctx, "a", "汇报", "routine:1").unwrap().unwrap();
    // 幂等：同一次运行重放不再发。
    assert_eq!(crate::routine(&ctx, "a", "汇报", "routine:1").unwrap(), Some(seq));
    let posted = group::events(&project.main, group::MAIN_GROUP).unwrap();
    let posted = posted.iter().find(|event| group::seq(event) == seq).unwrap();
    assert_eq!((posted["to"].as_str(), posted["source"].as_str()), (Some("a"), Some("routine")));
    assert_eq!(crate::routine_outcome(&project.main, "a", seq).unwrap(), None);
    let append = |event: Value| group::append(&project.main, group::MAIN_GROUP, event).unwrap();
    append(json!({"kind": "message", "author": "a", "to": "user", "reply_to": seq, "event": "turn_empty", "text": "这一轮没有回答"}));
    assert_eq!(crate::routine_outcome(&project.main, "a", seq).unwrap(), Some(Err("这一轮没有回答".into())));
    let again = crate::routine(&ctx, "a", "汇报", "routine:2").unwrap().unwrap();
    append(json!({"kind": "message", "author": "a", "to": "user", "reply_to": again, "text": "done"}));
    assert_eq!(crate::routine_outcome(&project.main, "a", again).unwrap(), Some(Ok("done".into())));
    // 例行之后丢了上下文：这一轮算失败，即使随后答了。
    let lost = crate::routine(&ctx, "a", "汇报", "routine:3").unwrap().unwrap();
    append(json!({"kind": "message", "author": "a", "to": "user", "event": "context_lost", "text": "上下文丢失了"}));
    append(json!({"kind": "message", "author": "a", "to": "user", "reply_to": lost, "text": "done"}));
    assert_eq!(crate::routine_outcome(&project.main, "a", lost).unwrap(), Some(Err("上下文丢失了".into())));
}

// ---------------------------------------------------------------- 收件人与多群

#[test]
fn unaddressed_messages_are_only_recorded_replies_and_everyone_pick_the_recipients() {
    let project = Project::new();
    let ctx = project.ctx();
    let name = project.group();
    group::ensure_group(&project.main, &name).unwrap();
    join(&project, "a", &project.main);
    join(&project, "b", &project.main);
    let to = |text: &str, reply_to: Option<u64>| {
        let before = project.messages(&name).len();
        crate::post(&ctx, &name, "user", text, None, reply_to, Some(format!("gui-{text}:"))).unwrap();
        project.messages(&name)[before..].iter().map(|event| event["to"].clone()).collect::<Vec<_>>()
    };
    // 旧版写的负责人 / 回答方式不再生效：不 @ 只记录。
    let meta = group::dir(&project.main).join("groups.json");
    let mut groups: Value = serde_json::from_slice(&fs::read(&meta).unwrap()).unwrap();
    groups["groups"][&name]["lead"] = json!("a");
    groups["groups"][&name]["responders"] = json!("all");
    fs::write(&meta, serde_json::to_vec(&groups).unwrap()).unwrap();
    assert_eq!(to("quiet", None), vec![Value::Null]);
    // 引用回复 b 的话由 b 答；结构化 to 优先；成员发的不 @ 也只记录。
    let said = group::append(&project.main, &name, json!({"kind": "message", "author": "b", "to": "user", "text": "x"})).unwrap();
    assert_eq!(to("why", Some(group::seq(&said))), vec![json!("b")]);
    assert_eq!(crate::post(&ctx, &name, "user", "hey", Some("b".into()), None, None).unwrap()["to"], "b");
    assert!(crate::post(&ctx, &name, "b", "note", None, None, None).unwrap()["to"].is_null());
    // @everyone：每个在群成员一条，幂等键按人区分。
    assert_eq!(to("hi @everyone", None), vec![json!("a"), json!("b")]);
    let keys: Vec<Value> = project.messages(&name).iter().rev().take(2).map(|event| event["idempotency_key"].clone()).collect();
    assert_eq!(keys, vec![json!("gui-hi @everyone::b"), json!("gui-hi @everyone::a")]);
}

#[test]
fn groups_are_created_renamed_configured_and_deleted() {
    let project = Project::new();
    project.start();
    let ctx = project.ctx();
    let worktree = project.main.parent().unwrap().join("proj-demo");
    crate::create_group(&ctx, "review", Some("评审"), Some(&worktree)).unwrap();
    assert_eq!(crate::create_group(&ctx, "review", None, None).unwrap_err().code, "already_exists");
    // 群目录须在本空间里。
    assert!(crate::create_group(&ctx, "outside", None, Some(Path::new("/tmp"))).is_err());
    let listed = crate::groups(&ctx).unwrap();
    let rows = listed["groups"].as_array().unwrap();
    assert_eq!(rows.iter().map(|row| row["name"].clone()).collect::<Vec<_>>(), vec![json!("main"), json!("review")]);
    assert_eq!(rows[1]["title"], "评审");
    assert_eq!(PathBuf::from(rows[1]["cwd"].as_str().unwrap()), worktree.canonicalize().unwrap());
    crate::rename_group(&ctx, "review", Some("代码评审")).unwrap();
    assert_eq!(group::settings(&project.main, "review").unwrap().title.as_deref(), Some("代码评审"));
    // 改回主项目：群里记一条。
    crate::configure_group(&ctx, "review", Some(None)).unwrap();
    assert!(project.events("review").iter().any(|event| event["event"] == "group_cwd"));
    // 按目录名找群：worktree 现在没有群，回到 main。
    assert_eq!(crate::who(&ctx, "proj-demo").unwrap()["participants"], json!([]));
    assert!(crate::delete_group(&ctx, "main").is_err());
    crate::delete_group(&ctx, "review").unwrap();
    assert_eq!(group::chat_groups(&project.main).unwrap(), vec!["main".to_owned()]);
}
