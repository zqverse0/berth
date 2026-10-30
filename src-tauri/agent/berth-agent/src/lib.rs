//! Berth 内置 Agent：一个最小的循环——模型回复里有工具调用就执行、把结果交回模型，
//! 直到模型只回文本。工具只有 read / bash / edit / write（[`tools`]）。
//!
//! 系统提示词只用调用方传入的文本，本 crate 不附加任何提示词；工具的名称、说明与参数
//! 结构随请求的 `tools` 发给模型。

pub mod context;
pub mod model;
pub mod record;
pub mod session;
pub mod tools;

use std::path::PathBuf;

use genai::chat::{ChatRequest, ChatRole, MessageContent, ToolResponse, Usage};

/// 一条对话消息；[`Agent::last_turn`] 给出、[`Agent::restore`] 接收，可序列化存盘。
pub use genai::chat::ChatMessage;

/// 一轮最多调用模型的次数：模型反复调工具停不下来时到此为止，免得无限烧钱。
const MAX_STEPS: usize = 50;

/// 一次模型调用的结果：整条助手消息（文本、工具调用、思考签名）与服务商报的用量。
pub struct Reply {
    pub content: MessageContent,
    pub usage: Option<Usage>,
}

/// 一次模型调用：流式文本逐段交给 `on_text`。
#[allow(async_fn_in_trait)]
pub trait Model {
    async fn reply(
        &self,
        request: ChatRequest,
        on_text: &mut dyn FnMut(&str),
    ) -> Result<Reply, String>;
}

/// 一轮对话里依次发生的事，供界面显示。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event<'a> {
    Text(&'a str),
    ToolStart {
        name: &'a str,
        args: String,
    },
    ToolEnd {
        name: &'a str,
        output: &'a str,
        failed: bool,
    },
    /// 每次模型调用结束，服务商报了用量时。
    Usage(&'a Usage),
}

pub struct Agent<M> {
    model: M,
    request: ChatRequest,
    cwd: PathBuf,
    env: Vec<(String, String)>,
}

impl<M: Model> Agent<M> {
    /// `system` 为空时不发系统提示词。
    pub fn new(model: M, system: Option<String>, cwd: PathBuf) -> Self {
        let mut request = ChatRequest::default().with_tools(tools::definitions());
        if let Some(system) = system.filter(|text| !text.trim().is_empty()) {
            request = request.with_system(system);
        }
        Self {
            model,
            request,
            cwd,
            env: Vec::new(),
        }
    }

    /// bash 工具额外带的环境变量（如 Berth 终端的 PATH，让模型能调用 `berth`）。
    pub fn set_env(&mut self, env: Vec<(String, String)>) {
        self.env = env;
    }

    /// 补入之前的对话：`from_user` 为真是用户说的，否则是助手的回答。
    pub fn remember(&mut self, from_user: bool, text: &str) {
        self.request.messages.push(if from_user {
            ChatMessage::user(text)
        } else {
            ChatMessage::assistant(text)
        });
    }

    /// 补入之前一轮的完整记录（含工具调用与结果，见 [`Agent::last_turn`]）。
    pub fn restore(&mut self, messages: Vec<ChatMessage>) {
        self.request.messages.extend(messages);
    }

    /// 最近一轮的完整记录：从最后一条用户消息到结尾，已去掉思考块（[`context::for_history`]），
    /// 可原样交给下一次的 [`Agent::restore`]。
    pub fn last_turn(&self) -> Vec<ChatMessage> {
        let messages = &self.request.messages;
        let start = messages
            .iter()
            .rposition(|message| message.role == ChatRole::User)
            .unwrap_or(0);
        context::for_history(&messages[start..])
    }

    pub fn system(&self) -> Option<&str> {
        self.request.system.as_deref()
    }

    /// 发一条用户消息并跑完这一轮；返回最后一条助手回复的文本。
    /// 模型调用失败时这条用户消息仍留在历史里，用户可以直接再发一次。
    pub async fn prompt(
        &mut self,
        input: &str,
        on_event: &mut dyn FnMut(Event),
    ) -> Result<String, String> {
        self.request.messages.push(ChatMessage::user(input));
        for _ in 0..MAX_STEPS {
            context::fit(&mut self.request.messages, context::BUDGET);
            // ponytail: 每次调用克隆整段历史；会话很长、调用很频繁时再改成按引用构建请求。
            let Reply { content, usage } = self
                .model
                .reply(self.request.clone(), &mut |text| {
                    on_event(Event::Text(text))
                })
                .await?;
            if let Some(usage) = &usage {
                on_event(Event::Usage(usage));
            }
            let calls: Vec<_> = content.tool_calls().into_iter().cloned().collect();
            let text = content.texts().concat();
            if !content.is_empty() {
                self.request.messages.push(ChatMessage::assistant(content));
            }
            if calls.is_empty() {
                return Ok(text);
            }
            // 同一次回复里的工具结果合成一条消息：Anthropic 要求它们都在紧随其后的那一条里。
            let mut responses = Vec::with_capacity(calls.len());
            for call in calls {
                on_event(Event::ToolStart {
                    name: &call.fn_name,
                    args: call.fn_arguments.to_string(),
                });
                let (output, failed) =
                    match tools::run(&call.fn_name, &call.fn_arguments, &self.cwd, &self.env).await
                    {
                        Ok(output) => (output, false),
                        Err(error) => (format!("Error: {error}"), true),
                    };
                on_event(Event::ToolEnd {
                    name: &call.fn_name,
                    output: &output,
                    failed,
                });
                responses.push(ToolResponse::new(call.call_id, output).with_fn_name(call.fn_name));
            }
            self.request.messages.push(responses.into());
        }
        Err(format!(
            "stopped after {MAX_STEPS} model calls without a final answer"
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use genai::chat::{ContentPart, ToolCall};
    use serde_json::json;
    use std::cell::RefCell;
    use std::collections::VecDeque;

    /// 按顺序吐出预设回复，并记下每次收到的请求。
    struct Scripted {
        replies: RefCell<VecDeque<MessageContent>>,
        requests: RefCell<Vec<ChatRequest>>,
    }

    impl Scripted {
        fn new(replies: Vec<MessageContent>) -> Self {
            Self {
                replies: RefCell::new(replies.into()),
                requests: RefCell::new(Vec::new()),
            }
        }
    }

    impl Model for &Scripted {
        async fn reply(
            &self,
            request: ChatRequest,
            on_text: &mut dyn FnMut(&str),
        ) -> Result<Reply, String> {
            self.requests.borrow_mut().push(request);
            let content = self.replies.borrow_mut().pop_front().ok_or("no reply")?;
            for text in content.texts() {
                on_text(text);
            }
            let usage = Some(Usage {
                prompt_tokens: Some(1),
                ..Default::default()
            });
            Ok(Reply { content, usage })
        }
    }

    fn call(id: &str, name: &str, args: serde_json::Value) -> ContentPart {
        ContentPart::ToolCall(ToolCall {
            call_id: id.into(),
            fn_name: name.into(),
            fn_arguments: args,
            thought_signatures: None,
        })
    }

    #[tokio::test]
    async fn runs_tool_calls_until_the_model_answers_with_text() {
        let dir = tempfile::tempdir().unwrap();
        let model = Scripted::new(vec![
            MessageContent::from_parts(vec![
                ContentPart::Text("writing".into()),
                call("c1", "write", json!({"path": "a.txt", "content": "hi"})),
            ]),
            MessageContent::from_text("done"),
        ]);
        let mut agent = Agent::new(&model, Some("SYSTEM".into()), dir.path().into());
        let mut events = Vec::new();
        let reply = agent
            .prompt("go", &mut |event| events.push(format!("{event:?}")))
            .await
            .unwrap();

        assert_eq!(reply, "done");
        assert_eq!(
            std::fs::read_to_string(dir.path().join("a.txt")).unwrap(),
            "hi"
        );
        let requests = model.requests.borrow();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0].system.as_deref(), Some("SYSTEM"));
        // 第二次请求带着：用户消息、助手的工具调用、工具结果。
        assert_eq!(requests[1].messages.len(), 3);
        assert!(events[0].starts_with("Text(\"writing\")"));
        assert!(events
            .iter()
            .any(|event| event.contains("ToolEnd") && event.contains("failed: false")));
        assert_eq!(
            events
                .iter()
                .filter(|event| event.starts_with("Usage"))
                .count(),
            2
        );
    }

    #[tokio::test]
    async fn parallel_tool_results_go_back_in_one_message() {
        let dir = tempfile::tempdir().unwrap();
        let model = Scripted::new(vec![
            MessageContent::from_parts(vec![
                call("c1", "read", json!({"path": "a"})),
                call("c2", "read", json!({"path": "b"})),
            ]),
            MessageContent::from_text("done"),
        ]);
        let mut agent = Agent::new(&model, None, dir.path().into());
        agent.prompt("both", &mut |_| {}).await.unwrap();

        let requests = model.requests.borrow();
        // 用户消息、助手的两个工具调用、一条带两个结果的工具消息。
        assert_eq!(requests[1].messages.len(), 3);
        assert_eq!(requests[1].messages[2].content.parts().len(), 2);
    }

    #[tokio::test]
    async fn the_last_turn_carries_tool_work_into_the_next_agent() {
        let dir = tempfile::tempdir().unwrap();
        let first = Scripted::new(vec![
            MessageContent::from_parts(vec![call("c1", "read", json!({"path": "missing"}))]),
            MessageContent::from_text("not there"),
        ]);
        let mut agent = Agent::new(&first, None, dir.path().into());
        agent.remember(true, "earlier");
        agent.prompt("look", &mut |_| {}).await.unwrap();
        let turn = agent.last_turn();
        // 提问、工具调用、工具结果、回答；不含更早的 "earlier"。
        assert_eq!(turn.len(), 4);

        let second = Scripted::new(vec![MessageContent::from_text("ok")]);
        let mut next = Agent::new(&second, None, dir.path().into());
        next.restore(turn);
        next.prompt("again", &mut |_| {}).await.unwrap();
        let requests = second.requests.borrow();
        assert_eq!(requests[0].messages.len(), 5);
        assert_eq!(requests[0].messages[2].content.tool_responses().len(), 1);
    }

    #[tokio::test]
    async fn a_turn_stops_after_max_steps() {
        let dir = tempfile::tempdir().unwrap();
        let replies = (0..=MAX_STEPS)
            .map(|i| {
                MessageContent::from_parts(vec![call(
                    &format!("c{i}"),
                    "read",
                    json!({"path": "x"}),
                )])
            })
            .collect();
        let model = Scripted::new(replies);
        let mut agent = Agent::new(&model, None, dir.path().into());
        let error = agent.prompt("loop", &mut |_| {}).await.unwrap_err();

        assert!(error.contains("stopped after"));
        assert_eq!(model.requests.borrow().len(), MAX_STEPS);
    }

    #[tokio::test]
    async fn tool_errors_go_back_to_the_model_instead_of_ending_the_turn() {
        let dir = tempfile::tempdir().unwrap();
        let model = Scripted::new(vec![
            MessageContent::from_parts(vec![call("c1", "read", json!({"path": "missing"}))]),
            MessageContent::from_text("not found"),
        ]);
        let mut agent = Agent::new(&model, None, dir.path().into());
        let reply = agent.prompt("read it", &mut |_| {}).await.unwrap();

        assert_eq!(reply, "not found");
        assert_eq!(agent.system(), None);
        let requests = model.requests.borrow();
        let last = requests[1].messages.last().unwrap();
        let response = last.content.parts().iter().find_map(|part| match part {
            ContentPart::ToolResponse(response) => Some(response.content.clone()),
            _ => None,
        });
        assert!(response.unwrap().starts_with("Error:"));
    }
}
