//! 用 `examples/fake_acp_agent.rs`（官方 crate 的 Agent 端）驱动运行时；群账本是真的。

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use berth_project_core::tasks::group;
use serde_json::{json, Value};

use super::{Acp, Spec, PREFIX};
use crate::watch::{save_state, MemberState};
use crate::Ctx;

const MEMBER: &str = "fake";

struct Fixture {
    _tmp: tempfile::TempDir,
    main: PathBuf,
    state: PathBuf,
    acp: Acp,
}

fn agent_binary() -> PathBuf {
    // target/<profile>/deps/<测试> → target/<profile>/examples/fake_acp_agent
    let exe = std::env::current_exe().unwrap();
    exe.parent().unwrap().parent().unwrap().join("examples/fake_acp_agent")
}

impl Fixture {
    fn new(env: &[(&str, &str)]) -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let main = tmp.path().join("proj");
        std::fs::create_dir(&main).unwrap();
        let data = berth_project_core::space::testing::register(&main);
        berth_project_core::berth_dir::ensure_space(&data).unwrap();
        group::prepare(&main).unwrap();
        group::create(&main, group::MAIN_GROUP).unwrap();
        let state = tmp.path().join("agent");
        std::fs::create_dir(&state).unwrap();
        let mut spec_env: Vec<(String, String)> = vec![("FAKE_DIR".into(), state.display().to_string())];
        spec_env.extend(env.iter().map(|(key, value)| (key.to_string(), value.to_string())));
        let launcher: super::Launcher = Box::new(move |_, _| {
            Ok(Spec {
                argv: vec![agent_binary().display().to_string()],
                env: spec_env.iter().cloned().collect(),
                session_meta: Some(json!({"berth": 1}).as_object().unwrap().clone()),
                tmp: None,
            })
        });
        group::append(
            &main,
            group::MAIN_GROUP,
            json!({"kind": "joined", "author": MEMBER, "target_ref": format!("{PREFIX}{MEMBER}"),
                   "agent": "fake", "cwd": main, "collect": true}),
        )
        .unwrap();
        Self { _tmp: tmp, main, state, acp: Acp::new(launcher) }
    }

    fn ctx(&self) -> Ctx {
        Ctx { main: self.main.clone(), socket: None, gui: None, cli: PathBuf::from("berth"), caller: None }
    }

    fn events(&self) -> Vec<Value> {
        group::events(&self.main, group::MAIN_GROUP).unwrap()
    }

    fn tick(&mut self) {
        let events = self.events();
        let ctx = self.ctx();
        self.acp.tick(&ctx, &events);
    }

    /// 用户发一条消息并让运行时转交；返回消息 seq。
    fn post(&mut self, text: &str) -> u64 {
        let written = group::append(
            &self.main,
            group::MAIN_GROUP,
            json!({"kind": "message", "author": group::USER, "to": MEMBER, "text": text}),
        )
        .unwrap();
        self.tick();
        group::seq(&written)
    }

    /// 等账本里出现满足条件的事件（最多 20 秒）。
    fn wait(&mut self, what: &str, pred: impl Fn(&Value) -> bool) -> Value {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            if let Some(found) = self.events().into_iter().find(|event| pred(event)) {
                return found;
            }
            assert!(Instant::now() < deadline, "timed out waiting for {what}: {:#?}\nlog:\n{}", self.events(), self.log());
            self.tick();
            std::thread::sleep(Duration::from_millis(30));
        }
    }

    fn answer(&mut self, seq: u64) -> Value {
        self.wait("answer", |event| {
            event["kind"] == "message" && event["author"] == MEMBER && event["reply_to"] == json!(seq)
        })
    }

    fn system(&mut self, name: &str) -> Value {
        self.wait(name, |event| event["event"] == name)
    }

    fn log(&self) -> String {
        std::fs::read_to_string(self.state.join("log")).unwrap_or_default()
    }

    fn member_messages(&self) -> usize {
        self.events().iter().filter(|event| event["kind"] == "message" && event["author"] == MEMBER && event["event"].is_null()).count()
    }
}

fn alive(pid: &str) -> bool {
    Path::new("/proc").join(pid).exists()
}

#[test]
fn streams_one_answer_with_meta_and_ignores_updates_outside_a_turn() {
    let mut fx = Fixture::new(&[]);
    let seq = fx.post("say hello big world");
    let answer = fx.answer(seq);
    assert_eq!(answer["text"], "hello big world");
    assert_eq!(answer["to"], group::USER);
    // session/new 前推的 banner 不属于任何一轮
    assert!(!answer["text"].as_str().unwrap().contains("banner"));
    assert!(fx.log().contains(r#"new {"berth":1}"#), "{}", fx.log());
}

#[test]
fn tool_calls_become_steps() {
    let mut fx = Fixture::new(&[]);
    let seq = fx.post("tool");
    let answer = fx.answer(seq);
    assert_eq!(answer["text"], "done");
    assert_eq!(answer["steps"], json!([{"text": "Run echo"}]));
}

#[test]
fn permission_waits_for_the_users_option() {
    let mut fx = Fixture::new(&[]);
    let seq = fx.post("ask");
    let ask = fx.system("permission");
    assert_eq!(ask["reply_to"], json!(seq));
    let ids: Vec<&str> = ask["options"].as_array().unwrap().iter().map(|option| option["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["a1", "a2", "r1", "r2"]);
    assert_eq!(ask["options"][1]["kind"], "allow_always");
    group::append(
        &fx.main,
        group::MAIN_GROUP,
        json!({"kind": "system", "event": "permission_reply", "author": group::USER, "reply_to": group::seq(&ask), "option": "a2"}),
    )
    .unwrap();
    assert_eq!(fx.answer(seq)["text"], "chose a2");
}

#[test]
fn cancel_ends_the_turn() {
    let mut fx = Fixture::new(&[]);
    let seq = fx.post("wait");
    let deadline = Instant::now() + Duration::from_secs(20);
    while !fx.acp.busy() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    std::thread::sleep(Duration::from_millis(300));
    // 进行中的一轮：群页读到的过程里已有流式片段
    assert_eq!(super::live(&fx.main, MEMBER), Some(json!({"ask": seq, "lines": [{"text": "waiting"}]})));
    fx.acp.cancel(MEMBER);
    let answer = fx.answer(seq);
    assert_eq!(answer["text"], "waiting\n\n（已取消）");
    assert_eq!(super::live(&fx.main, MEMBER), None);
}

#[test]
fn crash_marks_the_turn_kills_the_group_and_restores_by_load() {
    let mut fx = Fixture::new(&[]);
    let first = fx.post("say one");
    fx.answer(first);
    let crashed = fx.post("crash");
    assert_eq!(fx.system("turn_interrupted")["reply_to"], json!(crashed));
    let pid = std::fs::read_to_string(fx.state.join("child.pid")).unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while alive(&pid) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(!alive(&pid), "child {pid} of the crashed agent survived");
    let recall = fx.post("recall");
    assert_eq!(fx.answer(recall)["text"], "say one");
    let log = fx.log();
    assert!(log.contains(r#"load s-"#) && log.contains(r#" {"berth":1}"#), "{log}");
    assert!(!log.contains("resume"), "{log}");
    // load 重放的旧对话没进账本：只有两条回答
    assert_eq!(fx.member_messages(), 2);
}

#[test]
fn resume_is_preferred_when_declared() {
    let mut fx = Fixture::new(&[("FAKE_RESUME", "1")]);
    let first = fx.post("say one");
    fx.answer(first);
    fx.post("crash");
    fx.system("turn_interrupted");
    let recall = fx.post("recall");
    assert_eq!(fx.answer(recall)["text"], "say one");
    let log = fx.log();
    assert!(log.contains("resume s-") && !log.contains("load "), "{log}");
}

#[test]
fn missing_session_starts_over_and_says_so() {
    let mut fx = Fixture::new(&[]);
    let state = MemberState { session_id: Some("s-gone".into()) };
    save_state(&fx.main, group::MAIN_GROUP, MEMBER, &format!("{PREFIX}{MEMBER}"), &state);
    let seq = fx.post("say again");
    fx.system("context_lost");
    assert_eq!(fx.answer(seq)["text"], "again");
}

#[test]
fn other_restore_errors_are_reported_not_hidden() {
    let mut fx = Fixture::new(&[("FAKE_LOAD_FAIL", "1")]);
    let state = MemberState { session_id: Some("s-any".into()) };
    save_state(&fx.main, group::MAIN_GROUP, MEMBER, &format!("{PREFIX}{MEMBER}"), &state);
    let seq = fx.post("say x");
    let failed = fx.system("turn_failed");
    assert_eq!(failed["reply_to"], json!(seq));
    assert!(!fx.events().iter().any(|event| event["event"] == "context_lost"));
}

#[test]
fn stop_cancels_the_running_turn() {
    let mut fx = Fixture::new(&[]);
    let seq = fx.post("wait");
    let main = fx.main.clone();
    fx.wait("streaming", |_| super::live(&main, MEMBER).is_some_and(|live| live["lines"] != json!([])));
    crate::control(&fx.ctx(), group::MAIN_GROUP, MEMBER, "stop", None).unwrap();
    assert_eq!(fx.answer(seq)["text"], "waiting\n\n（已取消）");
}

#[test]
fn new_session_forgets_the_context() {
    let mut fx = Fixture::new(&[]);
    let first = fx.post("say one");
    fx.answer(first);
    crate::control(&fx.ctx(), group::MAIN_GROUP, MEMBER, "new", None).unwrap();
    fx.tick();
    let recall = fx.post("recall");
    assert_eq!(fx.answer(recall)["text"], "");
    assert_eq!(fx.log().matches("new ").count(), 2, "{}", fx.log());
}

#[test]
fn leave_stops_the_process_and_rejoining_resumes_the_session() {
    let mut fx = Fixture::new(&[]);
    let first = fx.post("say one");
    fx.answer(first);
    crate::control(&fx.ctx(), group::MAIN_GROUP, MEMBER, "leave", None).unwrap();
    fx.tick();
    assert!(fx.acp.workers.is_empty());
    assert!(crate::control(&fx.ctx(), group::MAIN_GROUP, MEMBER, "stop", None).is_err());
    group::append(
        &fx.main,
        group::MAIN_GROUP,
        json!({"kind": "joined", "author": MEMBER, "target_ref": format!("{PREFIX}{MEMBER}"),
               "agent": "fake", "cwd": fx.main, "collect": true}),
    )
    .unwrap();
    let recall = fx.post("recall");
    assert_eq!(fx.answer(recall)["text"], "say one");
}

#[test]
fn a_new_runtime_closes_turns_left_open_by_a_killed_one() {
    let mut fx = Fixture::new(&[]);
    let seq = fx.post("wait");
    let main = fx.main.clone();
    fx.wait("streaming", |_| super::live(&main, MEMBER).is_some());
    // 上一个运行时被杀：线程不收尾，live 文件留着（这里只模拟文件还在）
    std::mem::forget(std::mem::replace(&mut fx.acp, Acp::new(Box::new(|_, _| Err("no".into())))));
    fx.tick();
    assert_eq!(fx.system("turn_interrupted")["reply_to"], json!(seq));
    assert_eq!(super::live(&fx.main, MEMBER), None);
}

#[test]
fn joined_records_inputs_and_provider_and_old_records_keep_their_expert() {
    let at = |mut event: Value| {
        event["seq"] = json!(1);
        let events = [event];
        super::joined(&events, &group::members(&events)[0]).unwrap()
    };
    let base = json!({"kind": "joined", "author": MEMBER, "target_ref": format!("{PREFIX}{MEMBER}"), "agent": "pi", "cwd": "/p"});
    let mut new = base.clone();
    new["inputs"] = json!({"expert": "e", "thinking": "high"});
    new["provider"] = json!(7);
    new["model"] = json!("m");
    let args = super::launch_args(&at(new));
    assert_eq!(
        args,
        ["--acp", "--berth-launch-inputs", r#"{"expert":"e","thinking":"high"}"#, "--berth-provider-id", "7", "--berth-provider-model", "m"]
    );
    let mut old = base.clone();
    old["expert"] = json!("e");
    assert_eq!(super::launch_args(&at(old)), ["--acp", "--berth-launch-inputs", r#"{"expert":"e"}"#]);
    assert_eq!(super::launch_args(&at(base)), ["--acp", "--berth-launch-inputs", "{}"]);
}

#[test]
fn handoff_parks_the_member_until_it_is_returned_then_resumes_the_session() {
    let mut fx = Fixture::new(&[]);
    let ctx = fx.ctx();
    // 还没有会话：没有可交给终端的。
    assert!(crate::control(&ctx, group::MAIN_GROUP, MEMBER, "handoff", None).is_err());
    let first = fx.post("say one");
    fx.answer(first);
    let handed = crate::control(&ctx, group::MAIN_GROUP, MEMBER, "handoff", None).unwrap();
    assert!(handed["session"].as_str().is_some_and(|id| id.starts_with("s-")), "{handed}");
    assert_eq!(handed["agent"], "fake");
    fx.tick();
    assert!(fx.acp.workers.is_empty());
    // 开好终端后带上它；在终端期间停止 / 新会话被拒，消息留着不投。
    crate::control(&ctx, group::MAIN_GROUP, MEMBER, "handoff", Some("term-1".into())).unwrap();
    assert_eq!(super::handed(&fx.events(), MEMBER).unwrap()["terminal"], "term-1");
    assert!(crate::control(&ctx, group::MAIN_GROUP, MEMBER, "new", None).is_err());
    let recall = fx.post("recall");
    fx.tick();
    assert!(fx.acp.workers.is_empty());
    crate::control(&ctx, group::MAIN_GROUP, MEMBER, "return", None).unwrap();
    assert!(crate::control(&ctx, group::MAIN_GROUP, MEMBER, "return", None).is_err());
    assert_eq!(fx.answer(recall)["text"], "say one");
    assert!(fx.log().contains("load "), "{}", fx.log());
}
