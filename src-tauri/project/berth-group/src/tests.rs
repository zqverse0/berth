//! termd 与会话用假实现，git、群账本、任务状态都是真的；Agent 的 hook 直接调 [`super::hook`]。

use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use berth_project_core::tasks::{self, group};
use serde_json::{json, Value};

use crate::term::{CreateAgent, Fail, Sessions, Terminals};
use crate::{deliver, spawn, watch, Ctx, Hook};
use crate::term::{Input, PaneProbe};

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

/// 主项目 `<tmp>/proj`（dev 分支、已 init、含已提交的任务 `10-01-demo`）。
struct Project {
    _tmp: tempfile::TempDir,
    main: PathBuf,
}

impl Project {
    fn new() -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let main = tmp.path().join("proj");
        fs::create_dir(&main).unwrap();
        sh(&main, &["git", "init", "-q", "-b", "dev"]);
        berth_project_core::berth_dir::init(&main).unwrap();
        let task = main.join(".berth/tasks/10-01-demo");
        fs::create_dir_all(&task).unwrap();
        fs::write(task.join("task.json"), r#"{"id":"demo","title":"Demo"}"#).unwrap();
        fs::write(task.join("prd.md"), "# Demo\n\n## 步骤\n\n- [ ] S1 做\n").unwrap();
        sh(&main, &["git", "add", "-A"]);
        sh(&main, &["git", "commit", "-qm", "init"]);
        Self { _tmp: tmp, main }
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

#[derive(Default)]
struct FakeTerm {
    panes: RefCell<BTreeMap<String, PaneProbe>>,
    sent: RefCell<Vec<(String, String)>>,
    paste_fails: bool,
    projects: RefCell<Vec<PathBuf>>,
    /// 属于另一个 Berth 实例的引用。
    foreign: RefCell<HashSet<String>>,
}

impl FakeTerm {
    /// Agent pane 默认选了以终端编号命名的专家（`p1` → 专家 `1`），各终端各是一个成员；
    /// 同一专家多个终端用 [`Self::add_expert`]。`working` 即一轮中（hook 报了进度）。
    fn add(&self, target_ref: &str, agent: Option<&str>, cwd: &Path, state: &'static str) {
        // 假引用末尾的数字当终端编号（`p1` → 1，`pane-3` → 3）。
        let pane_id = target_ref
            .trim_start_matches(|ch: char| !ch.is_ascii_digit())
            .parse()
            .unwrap_or(0);
        self.panes.borrow_mut().insert(
            target_ref.to_owned(),
            PaneProbe {
                pane_id,
                expert: agent.map(|_| pane_id.to_string()),
                agent_state: Some(state),
                busy: state == "working",
                launch_agent: agent.map(str::to_owned),
                cwd: Some(cwd.to_string_lossy().into_owned()),
                session_project_path: Some(cwd.to_string_lossy().into_owned()),
                ..PaneProbe::default()
            },
        );
    }

    fn add_expert(&self, target_ref: &str, expert: Option<&str>, cwd: &Path, state: &'static str) {
        self.add(target_ref, Some("claude"), cwd, state);
        self.panes.borrow_mut().get_mut(target_ref).unwrap().expert = expert.map(str::to_owned);
    }

    fn set_state(&self, target_ref: &str, state: &'static str) {
        let mut panes = self.panes.borrow_mut();
        let pane = panes.get_mut(target_ref).unwrap();
        pane.agent_state = Some(state);
        pane.busy = state == "working";
    }

    /// 一轮中等授权：需要关注，但还在这一轮里。
    fn awaiting_approval(&self, target_ref: &str) {
        let mut panes = self.panes.borrow_mut();
        let pane = panes.get_mut(target_ref).unwrap();
        pane.agent_state = Some("attention");
        pane.busy = true;
    }

    fn close(&self, target_ref: &str) {
        self.panes.borrow_mut().remove(target_ref);
    }

    fn sent_to(&self, target_ref: &str) -> Vec<String> {
        self.sent
            .borrow()
            .iter()
            .filter(|(to, _)| to == target_ref)
            .map(|(_, what)| what.clone())
            .collect()
    }
}

impl Terminals for FakeTerm {
    fn probe(&self, target_ref: &str) -> Result<PaneProbe, Fail> {
        self.panes
            .borrow()
            .get(target_ref)
            .cloned()
            .ok_or(Fail::Stale)
    }

    fn foreign(&self, target_ref: &str) -> bool {
        self.foreign.borrow().contains(target_ref)
    }

    fn send(&self, target_ref: &str, input: Input, paste: bool) -> Result<(), Fail> {
        if !self.panes.borrow().contains_key(target_ref) {
            return Err(Fail::Stale);
        }
        if paste && self.paste_fails {
            return Err(Fail::Unavailable("paste_unsupported".into()));
        }
        let what = match input {
            Input::Text(text) if paste => format!("paste:{text}"),
            Input::Text(text) => format!("text:{text}"),
            Input::Key(key) => format!("key:{key}"),
        };
        self.sent.borrow_mut().push((target_ref.to_owned(), what));
        Ok(())
    }

    fn panes_under(&self, _roots: &[PathBuf]) -> Result<Vec<(String, PaneProbe)>, Fail> {
        Ok(self.panes.borrow().clone().into_iter().collect())
    }

    fn ensure_project(&self, path: &Path) -> Result<i32, String> {
        let mut projects = self.projects.borrow_mut();
        if let Some(index) = projects.iter().position(|known| known == path) {
            return Ok(index as i32 + 1);
        }
        projects.push(path.to_path_buf());
        Ok(projects.len() as i32)
    }

    fn create_agent(&self, request: CreateAgent<'_>) -> Result<String, String> {
        let target_ref = format!("pane-{}", self.panes.borrow().len() + 1);
        self.add(&target_ref, Some(request.agent), request.cwd, "working");
        let tool = berth_tool_core::paths::tools_root().join(request.agent);
        self.panes.borrow_mut().get_mut(&target_ref).unwrap().expert =
            berth_tool_core::paths::launch_expert(&tool, &json!(request.inputs));
        Ok(target_ref)
    }
}

/// hook 没带回答时补读的会话文件：路径 → 这一轮的最终回答。
#[derive(Default)]
struct FakeSessions {
    replies: RefCell<HashMap<PathBuf, String>>,
}

impl Sessions for FakeSessions {
    fn turn_reply(&self, _agent: &str, path: &Path) -> Option<String> {
        self.replies.borrow().get(path).cloned()
    }
}

fn tick(project: &Project, term: &FakeTerm, state: &mut watch::WatchState) -> bool {
    watch::tick(&project.ctx(), term, state)
}

/// 终端 `pane` 里的 Agent 触发一个 hook。
fn hook(project: &Project, term: &FakeTerm, sessions: &FakeSessions, pane: &str, event: Hook, payload: Value) {
    let ctx = Ctx {
        caller: Some(pane.to_owned()),
        ..project.ctx()
    };
    super::hook(&ctx, Some(term), sessions, event, &payload);
}

/// 会话开始（启动 / `/clear`）：hook 报告会话 id 与会话文件。
fn started(project: &Project, term: &FakeTerm, pane: &str, session: &str) {
    hook(
        project,
        term,
        &FakeSessions::default(),
        pane,
        Hook::SessionStart,
        json!({"session_id": session, "transcript_path": format!("/sessions/{session}.jsonl"), "source": "startup"}),
    );
}

/// 一轮结束：pane 回到空闲，hook 带最终回答。
fn ended(project: &Project, term: &FakeTerm, pane: &str, reply: &str) {
    term.set_state(pane, "idle");
    hook(
        project,
        term,
        &FakeSessions::default(),
        pane,
        Hook::TurnEnd,
        json!({"last_assistant_message": reply}),
    );
}

/// 手写入群的成员（`join` 同款）：给它的终端补一条 hook 会话记录。
fn joined_with_hook(project: &Project, member: &str, pane: &str) {
    group::append(
        &project.main,
        &project.group(),
        json!({"kind": "joined", "author": member, "target_ref": pane, "agent": "claude"}),
    )
    .unwrap();
    watch::save_state(
        &project.main,
        &project.group(),
        member,
        pane,
        &watch::MemberState {
            session_id: Some(format!("s-{pane}")),
            ..watch::MemberState::default()
        },
    );
}

fn reports(project: &Project) -> Vec<Value> {
    project
        .messages(&project.group())
        .into_iter()
        .filter(|m| m["source"] == "transcript")
        .collect()
}

fn post(project: &Project, term: Option<&dyn Terminals>, to: &str, text: &str) -> Value {
    super::post(
        &project.ctx(),
        term,
        &project.group(),
        "user",
        text,
        Some(to.to_owned()),
        None,
        None,
    )
    .unwrap()
}

// ---------------------------------------------------------------- 送达

#[test]
fn post_pastes_into_an_idle_agent_and_queues_for_a_busy_one() {
    let project = Project::new();
    let worktree = project.start();
    let term = FakeTerm::default();
    term.add("p1", Some("claude"), &worktree, "idle");
    joined_with_hook(&project, "claude-1", "p1");

    let written = post(&project, Some(&term), "claude-1", "看一下 S1");
    assert_eq!(written["doorbell"]["status"], "rung");
    assert_eq!(written["doorbell"]["delivered"], "body");
    let sent = term.sent_to("p1");
    assert!(sent[0].starts_with(&format!(
        "paste:[berth 群 {} · 来自 user]\n看一下 S1",
        project.group()
    )));
    assert_eq!(sent[1], "key:Enter");
    assert_eq!(
        group::delivered_seq(&project.main, &project.group(), "claude-1", "p1"),
        group::seq(&written)
    );

    term.set_state("p1", "working");
    let queued = post(&project, Some(&term), "claude-1", "再看 S2");
    assert_eq!(queued["doorbell"]["status"], "deferred");
    assert_eq!(term.sent_to("p1").len(), 2, "busy target gets nothing yet");

    // GUI（不在 Berth 终端里）发的消息只排队，由后台进程送达。
    let from_gui = post(&project, None, "claude-1", "第三条");
    assert_eq!(from_gui["doorbell"]["status"], "queued");
    term.set_state("p1", "idle");
    tick(&project, &term, &mut watch::WatchState::default());
    let sent = term.sent_to("p1");
    assert_eq!(sent.len(), 4, "both queued messages arrive in one paste");
    assert!(sent[2].contains("再看 S2") && sent[2].contains("第三条"));
    assert_eq!(
        group::delivered_seq(&project.main, &project.group(), "claude-1", "p1"),
        group::seq(&from_gui)
    );
}

#[test]
fn unpasteable_panes_wait_and_long_bodies_get_a_pointer() {
    let project = Project::new();
    project.start();
    let term = FakeTerm {
        paste_fails: true,
        ..FakeTerm::default()
    };
    term.add("agent", Some("claude"), &project.main, "idle");
    joined_with_hook(&project, "ag", "agent");
    // 终端没开括号粘贴时不键入任何东西（对话框会把字符当快捷键），稍后再试。
    let written = post(&project, Some(&term), "ag", "x");
    assert_eq!(written["doorbell"]["status"], "waiting");
    assert!(term.sent_to("agent").is_empty());
    assert_eq!(group::delivered_seq(&project.main, &project.group(), "ag", "agent"), 0);

    assert!(deliver::body("c", &[&json!({"author": "u", "text": "a".repeat(5000)})], &[]).is_none());
    assert!(deliver::body("c", &[&json!({"author": "u", "text": "bell\u{7}"})], &[]).is_none());
    assert!(deliver::body("c", &[&json!({"author": "u", "text": "多行\n\t正文"})], &[]).is_some());
    // 引用回复带上被引消息的摘录。
    let quoted = [json!({"seq": 22, "author": "59", "text": "c411a5e test\n5cc8419 init"})];
    let reply = json!({"author": "user", "text": "第一行的哈希？", "reply_to": 22});
    assert_eq!(
        deliver::body("c", &[&reply], &quoted).unwrap(),
        "[berth 群 c · 来自 user]\n> 引用 #22 59：\n> c411a5e test\n> 5cc8419 init\n第一行的哈希？"
    );
}

#[test]
fn an_agent_waiting_for_approval_mid_turn_gets_nothing() {
    let project = Project::new();
    let worktree = project.start();
    let term = FakeTerm::default();
    term.add("p1", Some("claude"), &worktree, "idle");
    joined_with_hook(&project, "a", "p1");
    term.awaiting_approval("p1");
    let written = post(&project, Some(&term), "a", "做 S1");
    assert_eq!(written["doorbell"]["status"], "deferred");
    let mut state = watch::WatchState::default();
    tick(&project, &term, &mut state);
    assert!(term.sent_to("p1").is_empty(), "授权框里不粘贴、不回车");

    // 这一轮结束后的提醒（需要关注、不在一轮里）照投。
    term.set_state("p1", "attention");
    tick(&project, &term, &mut state);
    assert!(term.sent_to("p1")[0].contains("做 S1"));
    assert_eq!(term.sent_to("p1").last().unwrap(), "key:Enter");

    // 超长正文改为粘贴指针行。
    post(&project, Some(&term), "a", &"长".repeat(2000));
    assert!(term.sent_to("p1")[2].starts_with(&format!(
        "paste:[berth] 群 {} 有给你的新消息：",
        project.group()
    )));
}

#[test]
fn a_terminal_without_a_hook_session_is_never_pasted_into() {
    let project = Project::new();
    project.start();
    let term = FakeTerm::default();
    term.add("p1", Some("claude"), &project.main, "idle");
    group::append(
        &project.main,
        &project.group(),
        json!({"kind": "joined", "author": "a", "target_ref": "p1"}),
    )
    .unwrap();
    // 不知道它何时一轮结束：只排队。
    assert_eq!(post(&project, Some(&term), "a", "x")["doorbell"]["status"], "deferred");
    assert!(term.sent_to("p1").is_empty());
}

#[test]
fn idempotent_replay_does_not_deliver_again() {
    let project = Project::new();
    project.start();
    let term = FakeTerm::default();
    term.add("p1", Some("claude"), &project.main, "idle");
    joined_with_hook(&project, "a", "p1");
    let send = || {
        super::post(
            &project.ctx(),
            Some(&term),
            &project.group(),
            "user",
            "x",
            Some("a".into()),
            None,
            Some("k".into()),
        )
        .unwrap()
    };
    let first = send();
    let again = send();
    assert_eq!(group::seq(&first), group::seq(&again));
    assert!(again.get("doorbell").is_none());
    assert_eq!(term.sent_to("p1").len(), 2);
}

// ---------------------------------------------------------------- hook 写回 pane 的状态

#[test]
fn hooks_report_state_with_standard_terminal_sequences() {
    use super::hook_signal;
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

// ---------------------------------------------------------------- 成员派生

#[test]
fn agents_in_every_checkout_join_the_one_project_group() {
    let project = Project::new();
    let worktree = project.start();
    let term = FakeTerm::default();
    let mut state = watch::WatchState::default();
    term.add("p1", Some("claude"), &worktree.join("src"), "working");
    term.panes
        .borrow_mut()
        .get_mut("p1")
        .unwrap()
        .session_project_path = Some(worktree.to_string_lossy().into_owned());
    term.add("p2", Some("claude"), &worktree, "working");
    term.add("shell", None, &worktree, "idle");
    term.add("elsewhere", Some("claude"), &project.main, "working");
    // hook 还没报告会话的 Agent 不入群。
    term.add("p5", Some("claude"), &worktree, "working");
    for pane in ["p1", "p2", "elsewhere"] {
        started(&project, &term, pane, &format!("s-{pane}"));
    }
    assert!(tick(&project, &term, &mut state));
    let members = group::members(&project.events(&project.group()));
    assert_eq!(
        members
            .iter()
            .map(|m| (m.name.as_str(), m.bodies[0].target_ref.as_str()))
            .collect::<Vec<_>>(),
        [("0", "elsewhere"), ("1", "p1"), ("2", "p2")]
    );
    assert!(members.iter().all(|m| m.bodies[0].derived && m.bodies[0].collect));
    let joined = project.events(&project.group());
    assert!(joined.iter().any(|e| e["kind"] == "joined" && e["session_id"] == "s-p1"));

    // 再跑一轮不重复入群。
    assert!(tick(&project, &term, &mut state));
    assert_eq!(group::members(&project.events(&project.group())).len(), 3);

    // pane 关闭后退出当前名单但保留历史；改变 cwd 不离群。
    term.close("p1");
    term.panes.borrow_mut().get_mut("p2").unwrap().cwd =
        Some(project.main.to_string_lossy().into_owned());
    tick(&project, &term, &mut state);
    let reasons: Vec<String> = project
        .events(&project.group())
        .iter()
        .filter(|e| e["kind"] == "left")
        .map(|e| {
            format!(
                "{}:{}",
                e["author"].as_str().unwrap(),
                e["reason"].as_str().unwrap()
            )
        })
        .collect();
    assert_eq!(reasons, ["1:agent_exited"]);
    // 另一个实例（正式版 / dev 同开）的成员：本实例看不到它的 pane，不判离群。
    term.foreign.borrow_mut().insert("p2".into());
    term.close("p2");
    tick(&project, &term, &mut state);
    assert_eq!(
        project
            .events(&project.group())
            .iter()
            .filter(|e| e["kind"] == "left")
            .count(),
        1
    );
    assert!(group::roster(&project.events(&project.group()))
        .iter()
        .any(|(m, left)| m.name == "1" && left.is_some()));
    // 在 shell 里手动启动的 Agent 没选专家：不入群（hook 也不记）。
    term.add("p4", None, &worktree, "idle");
    term.panes
        .borrow_mut()
        .get_mut("p4")
        .unwrap()
        .foreground_command = Some("claude".into());
    started(&project, &term, "p4", "s-p4");
    term.add("p3", Some("claude"), &worktree, "working");
    started(&project, &term, "p3", "s-p3");
    tick(&project, &term, &mut state);
    let names: Vec<String> = group::members(&project.events(&project.group()))
        .into_iter()
        .map(|m| m.name)
        .collect();
    assert_eq!(names, ["0", "2", "3"]);
    // Agent 退出、pane 回到 shell → 这个终端离群。
    term.panes.borrow_mut().get_mut("p3").unwrap().launch_agent = None;
    term.panes.borrow_mut().get_mut("p3").unwrap().foreground_command = Some("bash".into());
    tick(&project, &term, &mut state);
    let last = project.events(&project.group()).pop().unwrap();
    assert_eq!(
        (last["author"].as_str(), last["target_ref"].as_str(), last["reason"].as_str()),
        (Some("3"), Some("p3"), Some("agent_exited"))
    );
}

#[test]
fn an_expert_is_one_member_whatever_terminals_it_runs_in() {
    let project = Project::new();
    let worktree = project.start();
    let term = FakeTerm::default();
    let mut state = watch::WatchState::default();
    term.add_expert("p1", Some("dev"), &worktree, "working");
    term.add_expert("p2", Some("dev"), &worktree, "working");
    term.add_expert("p3", None, &worktree, "working");
    for (pane, session) in [("p1", "s-1"), ("p2", "s-2"), ("p3", "s-3")] {
        started(&project, &term, pane, session);
    }
    tick(&project, &term, &mut state);
    let members = group::members(&project.events(&project.group()));
    assert_eq!(members.len(), 1, "没选专家的 p3 不入群");
    assert_eq!(members[0].name, "dev");
    assert_eq!(members[0].bodies.iter().map(|b| b.target_ref.as_str()).collect::<Vec<_>>(), ["p1", "p2"]);
    let who = super::who_rows(&project.ctx(), Some(&term), &project.group(), &project.events(&project.group()));
    assert_eq!(who["participants"][0]["bodies"].as_array().unwrap().len(), 2);
    assert_eq!(who["participants"][0]["bodies"][1]["session_id"], "s-2");
    assert_eq!(who["participants"][0]["bodies"][1]["hooked"], true);
    assert_eq!(who["terminals"][0]["target_ref"], "p3", "不是成员的 Agent 列在 terminals");

    // 发给专家：p1 忙、p2 空闲 → 投给 p2。
    term.set_state("p2", "idle");
    let ask = post(&project, Some(&term), "dev", "q1");
    assert_eq!(ask["doorbell"]["target_ref"], "p2");
    assert!(term.sent_to("p1").is_empty());
    // p2 答完：结果标明出自 p2。
    term.set_state("p2", "working");
    ended(&project, &term, "p2", "二号的回答");
    let report = reports(&project).pop().unwrap();
    assert_eq!((report["author"].as_str(), report["target_ref"].as_str()), (Some("dev"), Some("p2")));
    assert_eq!(report["session_id"], "s-2");

    // 回复这条结果：p1 空闲、p2 忙也等 p2（同一条委托链回到原终端），后面的消息排在它后面。
    term.set_state("p1", "idle");
    term.set_state("p2", "working");
    let follow = super::post(&project.ctx(), Some(&term), &project.group(), "user", "接着改", Some("dev".into()), report["seq"].as_u64(), None).unwrap();
    assert_eq!(follow["doorbell"]["status"], "deferred");
    post(&project, Some(&term), "dev", "另一件事");
    assert!(term.sent_to("p1").is_empty(), "不乱序：排在指定给 p2 的消息后面");
    term.set_state("p2", "idle");
    // 投递锁可能被并行测试 fork 出的 git 子进程短暂继承：多跑一轮（后台进程本来就是每轮重试）。
    tick(&project, &term, &mut state);
    tick(&project, &term, &mut state);
    assert!(term.sent_to("p2").iter().any(|sent| sent.contains("接着改") && sent.contains("另一件事")));

    // p2 关掉：只走这个终端，专家还在群。
    term.close("p2");
    tick(&project, &term, &mut state);
    let members = group::members(&project.events(&project.group()));
    assert_eq!(members[0].bodies.iter().map(|b| b.target_ref.as_str()).collect::<Vec<_>>(), ["p1"]);

    // 全部关掉 → 离线：发给它的只存群里；再开一个终端入群后照投，离线前已投的不重投。
    term.close("p1");
    tick(&project, &term, &mut state);
    assert!(group::members(&project.events(&project.group())).iter().all(|m| m.name != "dev"));
    let offline = post(&project, Some(&term), "dev", "离线时发的");
    assert_eq!(offline["doorbell"]["status"], "skipped");
    term.add_expert("p4", Some("dev"), &worktree, "idle");
    started(&project, &term, "p4", "s-4");
    tick(&project, &term, &mut state);
    let sent = term.sent_to("p4");
    assert!(sent.iter().any(|sent| sent.contains("离线时发的")));
    assert!(!sent.iter().any(|sent| sent.contains("接着改")));
    let states = group::delivery_states(&project.main, &project.group(), &project.events(&project.group()));
    assert_eq!(states[&offline["seq"].as_u64().unwrap()], "delivered");
}

#[test]
fn a_historical_group_cannot_claim_a_project_agent() {
    let project = Project::new();
    let worktree = project.start();
    group::create(&project.main, "other").unwrap();
    group::append(
        &project.main,
        "other",
        json!({"kind": "joined", "author": "w", "target_ref": "p1", "collect": true}),
    )
    .unwrap();
    let term = FakeTerm::default();
    term.add("p1", Some("claude"), &worktree, "working");
    started(&project, &term, "p1", "s-1");
    tick(&project, &term, &mut watch::WatchState::default());
    assert_eq!(group::members(&project.events(&project.group())).len(), 1);
}

// ---------------------------------------------------------------- 汇报

#[test]
fn a_member_reports_once_per_message_and_commits_are_a_group_event() {
    let project = Project::new();
    let worktree = project.start();
    let term = FakeTerm::default();
    let mut state = watch::WatchState::default();
    term.add("p1", Some("claude"), &worktree, "idle");
    started(&project, &term, "p1", "s-1");
    tick(&project, &term, &mut state);

    // 用户发消息（GUI）→ 后台送达 → 一轮结束 → hook 贴回结果。
    let ask = post(&project, None, "1", "做 S1");
    tick(&project, &term, &mut state); // 送达
    assert!(term.sent_to("p1")[0].contains("做 S1"));
    term.set_state("p1", "working");
    ended(&project, &term, "p1", "S1 做完了");
    let got = reports(&project);
    assert_eq!(got.len(), 1);
    assert_eq!(got[0]["author"], "1");
    assert_eq!(got[0]["to"], "user");
    assert_eq!(got[0]["text"], "S1 做完了");
    assert_eq!(got[0]["reply_to"], ask["seq"]);
    assert_eq!(got[0]["session_id"], "s-1");

    // 用户直接在终端里聊（没有新委托）→ 不汇报。
    term.set_state("p1", "working");
    ended(&project, &term, "p1", "闲聊的回复");
    assert_eq!(reports(&project).len(), 1);

    // 有新提交：不算成员汇报，记一条群级提交事件（只记一次）。
    fs::write(worktree.join("a.txt"), "a").unwrap();
    sh(&worktree, &["git", "add", "-A"]);
    sh(&worktree, &["git", "commit", "-qm", "feat: a"]);
    tick(&project, &term, &mut state);
    tick(&project, &term, &mut state);
    let events = project.events(&project.group());
    let commits: Vec<&Value> = events
        .iter()
        .filter(|event| event["event"] == "commits")
        .collect();
    assert_eq!(commits.len(), 1);
    assert!(commits[0]["commits"][0]
        .as_str()
        .unwrap()
        .ends_with("feat: a"));
    assert!(commits[0].get("author").is_none());
    // 后台进程重启：从账本接着比，不重记。
    tick(&project, &term, &mut watch::WatchState::default());
    assert_eq!(
        project
            .events(&project.group())
            .iter()
            .filter(|event| event["event"] == "commits")
            .count(),
        1
    );
}

#[test]
fn merges_rewrites_and_resets_are_group_events() {
    let project = Project::new();
    let worktree = project.start();
    let term = FakeTerm::default();
    let mut state = watch::WatchState::default();
    term.add("p1", Some("claude"), &worktree, "working");
    term.add("p2", Some("claude"), &project.main, "working");
    started(&project, &term, "p1", "s-1");
    started(&project, &term, "p2", "s-2");
    tick(&project, &term, &mut state); // 起点
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
    tick(&project, &term, &mut state);
    // 合并进主 checkout：各 checkout 的提交都记在项目群，带 `checkout`。
    sh(&project.main, &["git", "merge", "--no-ff", "-q", "-m", "merge demo", "demo"]);
    tick(&project, &term, &mut state);
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
    tick(&project, &term, &mut state);
    sh(&worktree, &["git", "reset", "-q", "--hard", "HEAD~1"]);
    tick(&project, &term, &mut state);
    let git = git_events(&project.group());
    assert_eq!(git[2]["rewritten"], true);
    assert_eq!(git[3]["event"], "head");
    assert_eq!(git[3]["from_branch"], Value::Null);
    // 重启后不重记。
    tick(&project, &term, &mut watch::WatchState::default());
    assert_eq!(git_events(&project.group()).len(), 4);
}

#[test]
fn a_turn_end_without_an_answer_reads_the_session_file() {
    let project = Project::new();
    let worktree = project.start();
    let term = FakeTerm::default();
    let mut state = watch::WatchState::default();
    term.add("p1", Some("claude"), &worktree, "idle");
    started(&project, &term, "p1", "s-1");
    tick(&project, &term, &mut state);
    post(&project, None, "1", "整理 PRD");
    tick(&project, &term, &mut state); // 送达

    // hook 没带回答，会话文件里这一轮也还没有最终回答：不贴。
    let sessions = FakeSessions::default();
    term.set_state("p1", "idle");
    hook(&project, &term, &sessions, "p1", Hook::TurnEnd, json!({}));
    assert!(reports(&project).is_empty());

    // 会话文件里有这一轮的最终回答：贴它。
    sessions
        .replies
        .borrow_mut()
        .insert(PathBuf::from("/sessions/s-1.jsonl"), "最终结论".into());
    hook(&project, &term, &sessions, "p1", Hook::TurnEnd, json!({}));
    let got = reports(&project);
    assert_eq!(got.len(), 1);
    assert_eq!(got[0]["text"], "最终结论");
}

#[test]
fn a_queued_message_is_delivered_right_after_the_turn_is_reported() {
    let project = Project::new();
    let worktree = project.start();
    let term = FakeTerm::default();
    let mut state = watch::WatchState::default();
    term.add("p1", Some("claude"), &worktree, "idle");
    started(&project, &term, "p1", "s-1");
    tick(&project, &term, &mut state);
    let first = post(&project, None, "1", "第一件事");
    tick(&project, &term, &mut state); // 送达第一件事
    term.set_state("p1", "working");

    // 它在忙时又来一条，排队。
    post(&project, None, "1", "第二件事");
    tick(&project, &term, &mut state);
    let second_sent = |term: &FakeTerm| {
        term.sent_to("p1")
            .iter()
            .any(|sent| sent.contains("第二件事"))
    };
    assert!(!second_sent(&term));

    // 一轮结束：hook 先贴结果，后台进程再投第二件事。
    ended(&project, &term, "p1", "第一件事的结果");
    let got = reports(&project);
    assert_eq!(got.len(), 1);
    assert_eq!(got[0]["text"], "第一件事的结果");
    assert_eq!(got[0]["reply_to"], first["seq"]);
    tick(&project, &term, &mut state);
    assert!(second_sent(&term));
}

#[test]
fn two_agents_in_one_worktree_report_from_their_own_sessions() {
    let project = Project::new();
    let worktree = project.start();
    let term = FakeTerm::default();
    let mut state = watch::WatchState::default();
    term.add("p1", Some("claude"), &worktree, "idle");
    term.add("p2", Some("claude"), &worktree, "idle");
    started(&project, &term, "p1", "s-1");
    started(&project, &term, "p2", "s-2");
    tick(&project, &term, &mut state);

    post(&project, None, "1", "q1");
    post(&project, None, "2", "q2");
    tick(&project, &term, &mut state); // 送达
    for pane in ["p1", "p2"] {
        term.set_state(pane, "working");
    }
    ended(&project, &term, "p2", "二号的回答");
    ended(&project, &term, "p1", "一号的回答");
    let got: BTreeMap<String, (String, String)> = reports(&project)
        .into_iter()
        .map(|m| {
            (
                m["author"].as_str().unwrap().to_owned(),
                (
                    m["text"].as_str().unwrap().to_owned(),
                    m["session_id"].as_str().unwrap().to_owned(),
                ),
            )
        })
        .collect();
    assert_eq!(got["1"], ("一号的回答".into(), "s-1".into()));
    assert_eq!(got["2"], ("二号的回答".into(), "s-2".into()));
}

#[test]
fn a_member_follows_its_new_session_after_clear() {
    let project = Project::new();
    let worktree = project.start();
    let term = FakeTerm::default();
    term.add("p1", Some("claude"), &worktree, "idle");
    started(&project, &term, "p1", "s-1");
    tick(&project, &term, &mut watch::WatchState::default());
    started(&project, &term, "p1", "s-2");
    let state = watch::member_state(&project.main, &project.group(), "1", "p1").unwrap();
    assert_eq!(state.session_id.as_deref(), Some("s-2"));
    assert_eq!(group::bound_session_id(&project.main, &project.group(), "p1").as_deref(), Some("s-2"));
}

// ---------------------------------------------------------------- spawn

fn request(worker: &str) -> spawn::SpawnRequest {
    spawn::SpawnRequest {
        group: "main".into(),
        lead: "lead".into(),
        worker: worker.into(),
        agent: Some("claude".into()),
        expert: Some("dev-expert".into()),
        preset: None,
        branch: None,
        task: Some("demo".into()),
        inputs: Vec::new(),
        text: "做 S1".into(),
    }
}

#[test]
fn spawn_launches_the_worker_in_an_existing_project_group() {
    let project = Project::new();
    let term = FakeTerm::default();
    // 启动入口继承当前 pane 时，假终端也必须提供这个仍在运行的派发者。
    if let Ok(target) = std::env::var("BERTH_TARGET_REF") {
        term.add(&target, None, &project.main, "idle");
    }
    project.start();
    let mut input = request("w1");
    input.group = project.checkout();
    let result = spawn::spawn(&project.ctx(), &term, input).unwrap();
    let worktree = PathBuf::from(result["worktree"].as_str().unwrap());
    assert_eq!(worktree, project.main.parent().unwrap().join("proj-demo"));
    assert_eq!(result["branch"], "demo");
    // pane 建在 worktree 项目下。
    assert_eq!(*term.projects.borrow(), std::slice::from_ref(&worktree));
    // worker 的成员名是它的专家，`--name` 只作显示名。
    let members = group::members(&project.events(&project.group()));
    let worker = members
        .iter()
        .find(|member| member.label.as_deref() == Some("w1"))
        .unwrap();
    assert_eq!(result["worker"], "dev-expert");
    assert_eq!(worker.name, "dev-expert");
    assert!(worker.bodies[0].collect && !worker.bodies[0].derived);
    let brief = &project.messages(&project.group())[0];
    assert_eq!(brief["to"], "dev-expert");
    assert_eq!(brief["target_ref"], result["target_ref"], "任务指定给新终端");
    let text = brief["text"].as_str().unwrap();
    assert!(text.contains("任务契约：") && text.contains("自己的分支 demo，"));
    assert!(text.contains("Task: 10-01-demo S<步骤号>"));
    // 后台进程不会把 spawn 的 worker 再派生一遍。
    let before = group::members(&project.events(&project.group())).len();
    tick(&project, &term, &mut watch::WatchState::default());
    assert_eq!(
        group::members(&project.events(&project.group())).len(),
        before
    );
}

#[test]
fn spawn_validation_failures_write_nothing() {
    let project = Project::new();
    let term = FakeTerm::default();
    let ctx = project.ctx();
    let untouched = |project: &Project| {
        assert_eq!(group::checkout_groups(&project.main).unwrap().len(), 1);
        assert!(project.messages("main").is_empty());
        assert_eq!(
            sh(&project.main, &["git", "worktree", "list"])
                .lines()
                .count(),
            1
        );
        assert!(term.panes.borrow().is_empty());
    };
    let mut empty = request("w");
    empty.text = " ".into();
    assert_eq!(
        spawn::spawn(&ctx, &term, empty).unwrap_err().code,
        "invalid_input"
    );
    let mut both = request("w");
    both.preset = Some("p".into());
    assert_eq!(
        spawn::spawn(&ctx, &term, both).unwrap_err().code,
        "invalid_input"
    );
    let mut missing = request("w");
    missing.agent = None;
    missing.preset = Some("nope".into());
    assert_eq!(
        spawn::spawn(&ctx, &term, missing)
            .unwrap_err()
            .code,
        "not_found"
    );
    fs::write(
        project.main.join(".berth/tasks/10-01-demo/prd.md"),
        "改了没提交",
    )
    .unwrap();
    assert_eq!(
        spawn::spawn(&ctx, &term, request("w"))
            .unwrap_err()
            .code,
        "prd_not_committed"
    );
    untouched(&project);
}

#[test]
fn spawn_refuses_a_second_group_for_the_same_task() {
    let project = Project::new();
    project.start();
    let mut other = request("w");
    other.group = "elsewhere".into();
    let error = spawn::spawn(&project.ctx(), &FakeTerm::default(), other).unwrap_err();
    assert_eq!(error.code, "invalid_group");
    assert!(group::info(&project.main, "elsewhere").unwrap().is_none());
}

#[test]
fn presets_validate_and_summarise_without_values() {
    let project = Project::new();
    let path = project.main.join(".berth/presets.json");
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

#[test]
fn an_old_worktree_group_hands_its_members_to_the_project_group() {
    let project = Project::new();
    let worktree = project.start();
    tasks::complete(&project.main, Some("demo")).unwrap();
    let term = FakeTerm::default();
    term.add("p1", Some("claude"), &worktree, "working");
    // 旧版每个 worktree 一个群：p1 还登记在 worktree 群里。
    group::append(
        &project.main,
        &project.checkout(),
        json!({"kind": "joined", "author": "1", "target_ref": "p1", "agent": "claude"}),
    )
    .unwrap();
    term.panes.borrow_mut().get_mut("p1").unwrap().cwd =
        Some(project.main.to_string_lossy().into_owned());
    started(&project, &term, "p1", "s-1");
    let mut state = watch::WatchState::default();
    assert!(tick(&project, &term, &mut state));
    let members = group::members(&project.events(&project.group()));
    assert_eq!(members.len(), 1);
    assert_eq!(members[0].bodies[0].target_ref, "p1");
    // 旧群只留账本：成员离群一次，之后不再写。
    let old = project.events(&project.checkout());
    assert!(group::members(&old).is_empty());
    tick(&project, &term, &mut state);
    assert_eq!(project.events(&project.checkout()).len(), old.len());
}

#[test]
fn a_member_pane_posts_as_itself_whatever_as_says() {
    let project = Project::new();
    project.start();
    let group = project.group();
    for (name, pane) in [("pi-1", "p1"), ("pi-2", "p2")] {
        group::append(
            &project.main,
            &group,
            json!({"kind": "joined", "author": name, "target_ref": pane, "agent": "pi"}),
        )
        .unwrap();
    }
    let events = project.events(&group);
    assert_eq!(
        super::identity::pane_member(&events, Some("p2")).as_deref(),
        Some("pi-2")
    );
    // 不是本群成员的终端（用户的 shell、GUI）照旧用 `--as`。
    assert_eq!(super::identity::pane_member(&events, Some("shell")), None);
    assert_eq!(super::identity::pane_member(&events, None), None);
}

// ---------------------------------------------------------------- 一轮改了的文件

#[test]
fn turn_files_lists_what_changed_since_the_delivery_snapshot() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path();
    let git = |args: &[&str]| {
        assert!(std::process::Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(args)
            .output()
            .unwrap()
            .status
            .success());
    };
    git(&["init", "-q"]);
    for (name, body) in [("keep.txt", "a"), ("gone.txt", "b"), ("dirty.txt", "c"), ("touched.txt", "d")] {
        std::fs::write(repo.join(name), body).unwrap();
    }
    git(&["add", "."]);
    git(&["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
    // 投递前已有的改动：dirty 之后不再动，touched 之后又写一次。
    std::fs::write(repo.join("dirty.txt"), "c2").unwrap();
    std::fs::write(repo.join("touched.txt"), "d2").unwrap();
    let mut before = crate::watch::snapshot(repo);
    before.at_ms += 1; // 让「之前写的」确定早于快照
    std::thread::sleep(std::time::Duration::from_millis(20));
    std::fs::write(repo.join("touched.txt"), "d3").unwrap();
    std::fs::remove_file(repo.join("gone.txt")).unwrap();
    std::fs::create_dir(repo.join("new dir")).unwrap();
    std::fs::write(repo.join("new dir/new.txt"), "e").unwrap();

    let (root, mut files) = crate::watch::turn_files(&before, &[]);
    assert_eq!(root, before.root.clone().unwrap());
    files.sort_by(|a, b| a["path"].as_str().cmp(&b["path"].as_str()));
    assert_eq!(
        files,
        vec![
            json!({"path": "gone.txt", "status": "deleted", "added": 0, "removed": 1}),
            json!({"path": "new dir/new.txt", "status": "added", "added": 1, "removed": 0}),
            json!({"path": "touched.txt", "status": "modified", "added": 1, "removed": 1}),
        ]
    );
}

#[test]
fn turn_files_outside_git_come_from_the_turns_tool_targets() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    std::fs::write(dir.join("old.md"), "a\n").unwrap();
    std::fs::write(dir.join("read.md"), "r\n").unwrap();
    let mut before = crate::watch::snapshot(dir);
    assert!(before.root.is_none());
    before.at_ms += 1;
    std::thread::sleep(std::time::Duration::from_millis(20));
    std::fs::write(dir.join("old.md"), "a\nb\n").unwrap();
    std::fs::write(dir.join("new.md"), "1\n2\n3\n").unwrap();
    let targets: Vec<String> = ["read.md", "old.md", "new.md", "old.md", "ls -la"]
        .map(str::to_owned)
        .to_vec();

    let (root, files) = crate::watch::turn_files(&before, &targets);
    assert_eq!(root, dir);
    assert_eq!(files[0], json!({"path": "old.md", "status": "modified"}));
    // 文件系统不记创建时间时新文件只能算「修改」。
    if std::fs::metadata(dir.join("new.md")).unwrap().created().is_ok() {
        assert_eq!(files[1], json!({"path": "new.md", "status": "added", "added": 3, "removed": 0}));
    }
    assert_eq!(files.len(), 2);
}

#[test]
fn an_expert_started_before_the_group_joins_on_its_next_turn() {
    let project = Project::new();
    let worktree = project.start();
    let term = FakeTerm::default();
    let mut state = watch::WatchState::default();
    // 启动时的 session-start 没记下（那时项目还没启用 Berth）：不入群。
    term.add_expert("p1", Some("dev"), &worktree, "working");
    tick(&project, &term, &mut state);
    assert!(group::members(&project.events(&project.group())).is_empty());
    // 下一轮开始的 hook 补记会话，随后入群。
    hook(
        &project,
        &term,
        &FakeSessions::default(),
        "p1",
        Hook::TurnStart,
        json!({"session_id": "s-1", "cwd": worktree.to_string_lossy()}),
    );
    tick(&project, &term, &mut state);
    let members = group::members(&project.events(&project.group()));
    assert_eq!(members.len(), 1);
    assert_eq!(members[0].name, "dev");
}
