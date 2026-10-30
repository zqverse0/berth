//! 用 genai 调模型：接口、地址、Key、模型名全由 Berth 的服务商配置给定，不读 genai 的默认环境变量。

use std::time::Duration;

use futures::StreamExt;
use genai::adapter::AdapterKind;
use genai::chat::{ChatOptions, ChatRequest, ChatStreamEvent, MessageContent, Usage};
use genai::resolver::{AuthData, Endpoint, ServiceTargetResolver};
use genai::{Client, ModelIden, ServiceTarget};

use crate::{Model, Reply};

/// 限流、服务端错误、断网时最多重试几次（间隔 1s、2s、4s，服务商给了 retry-after 就按它）。
const RETRIES: u32 = 3;
/// 单次等待的上限：retry-after 给得太长时不让用户干等。
const MAX_DELAY: Duration = Duration::from_secs(60);

pub struct GenaiModel {
    client: Client,
    model: String,
    options: ChatOptions,
}

impl GenaiModel {
    /// `api` 是 Berth 的接口名：`anthropic` / `openai-chat` / `openai-responses` / `gemini`。
    /// `base_url` 是服务商端点的根地址（与 launch.js 里 `provider.endpoint()` 给的一致）。
    pub fn new(api: &str, base_url: &str, api_key: &str, model: &str) -> Result<Self, String> {
        let kind = adapter_kind(api)?;
        let endpoint = endpoint_url(kind, base_url);
        let key = api_key.to_string();
        let resolver = ServiceTargetResolver::from_resolver_fn(
            move |target: ServiceTarget| -> Result<ServiceTarget, genai::resolver::Error> {
                Ok(ServiceTarget {
                    endpoint: Endpoint::from_owned(endpoint.clone()),
                    auth: AuthData::from_single(key.clone()),
                    model: ModelIden::new(kind, target.model.model_name),
                })
            },
        );
        let client = Client::builder()
            .with_service_target_resolver(resolver)
            .build()
            .map_err(|error| error.to_string())?;
        Ok(Self {
            client,
            model: model.to_string(),
            options: ChatOptions::default()
                .with_capture_content(true)
                .with_capture_tool_calls(true)
                .with_capture_usage(true)
                // 带思考的模型续接工具调用时要原样回放思考块（含签名），否则 Anthropic 拒收。
                .with_capture_reasoning_content(true),
        })
    }
}

fn adapter_kind(api: &str) -> Result<AdapterKind, String> {
    match api {
        "anthropic" => Ok(AdapterKind::Anthropic),
        "openai-chat" => Ok(AdapterKind::OpenAI),
        "openai-responses" => Ok(AdapterKind::OpenAIResp),
        "gemini" => Ok(AdapterKind::Gemini),
        other => Err(format!(
            "unsupported api `{other}` (expected anthropic, openai-chat, openai-responses or gemini)"
        )),
    }
}

/// genai 的地址都以 `/` 结尾，并含版本段：Anthropic / OpenAI 补 `/v1`，Gemini 用给定地址。
fn endpoint_url(kind: AdapterKind, base_url: &str) -> String {
    let base = base_url.trim_end_matches('/');
    match kind {
        AdapterKind::Gemini => format!("{base}/"),
        _ if base.ends_with("/v1") => format!("{base}/"),
        _ => format!("{base}/v1/"),
    }
}

impl GenaiModel {
    async fn stream(
        &self,
        request: ChatRequest,
        on_text: &mut dyn FnMut(&str),
    ) -> Result<Reply, genai::Error> {
        let mut stream = self
            .client
            .exec_chat_stream(&self.model, request, Some(&self.options))
            .await?
            .stream;
        let (mut content, mut usage) = (None, None);
        while let Some(event) = stream.next().await {
            match event? {
                ChatStreamEvent::Chunk(chunk) => on_text(&chunk.content),
                ChatStreamEvent::End(end) => {
                    content = end.captured_content;
                    usage = end.captured_usage;
                }
                _ => {}
            }
        }
        Ok(Reply {
            content: content.unwrap_or_else(|| MessageContent::from_parts(Vec::new())),
            usage,
        })
    }
}

impl Model for GenaiModel {
    async fn reply(
        &self,
        request: ChatRequest,
        on_text: &mut dyn FnMut(&str),
    ) -> Result<Reply, String> {
        let mut attempt = 0;
        loop {
            // 已经吐出文本再重来会让界面看到重复的字：只在一个字都没出来时重试。
            let mut streamed = false;
            let result = self
                .stream(request.clone(), &mut |text| {
                    streamed = true;
                    on_text(text)
                })
                .await;
            let error = match result {
                Ok(reply) => return Ok(reply),
                Err(error) => error,
            };
            match retry_delay_for(&error, attempt) {
                Some(delay) if !streamed && attempt < RETRIES => {
                    attempt += 1;
                    tokio::time::sleep(delay).await;
                }
                _ => return Err(error.to_string()),
            }
        }
    }
}

/// genai 错误 → 该不该重试、等多久。流式请求的 HTTP 错误装在 `WebStream` 里，先拆出来。
fn retry_delay_for(error: &genai::Error, attempt: u32) -> Option<Duration> {
    let inner = match error {
        genai::Error::WebStream { error, .. } => error.downcast_ref::<genai::Error>(),
        _ => None,
    };
    let source = inner.unwrap_or(error);
    let headers = source.headers();
    let network = matches!(
        source,
        genai::Error::WebStream { .. } | genai::Error::WebModelCall { .. }
    );
    retry_delay(
        source.status().map(|status| status.as_u16()),
        |name| headers?.get(name)?.to_str().ok(),
        network,
        attempt,
    )
}

/// 408 / 409 / 429 / 5xx（含 529 过载）重试；其他 4xx 是请求本身的问题，重试也没用。
/// 没有 HTTP 状态时，只有网络层错误（断连、超时）重试。服务商说 `x-should-retry: false` 就不重试。
fn retry_delay<'a>(
    status: Option<u16>,
    header: impl Fn(&str) -> Option<&'a str>,
    network: bool,
    attempt: u32,
) -> Option<Duration> {
    if header("x-should-retry") == Some("false") {
        return None;
    }
    let backoff = Duration::from_secs(1 << attempt.min(5));
    let Some(status) = status else {
        return network.then_some(backoff);
    };
    if !matches!(status, 408 | 409 | 429 | 500..) {
        return None;
    }
    let hinted = header("retry-after-ms")
        .and_then(|value| value.parse().ok())
        .map(Duration::from_millis)
        .or_else(|| {
            header("retry-after")
                .and_then(|value| value.parse().ok())
                .map(Duration::from_secs)
        });
    Some(hinted.unwrap_or(backoff).min(MAX_DELAY))
}

/// 一轮里各次调用的用量累计；`context` 是最后一次调用的输入 token 数（当前上下文有多大）。
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Tally {
    pub calls: u32,
    pub input: i64,
    pub output: i64,
    pub cached: i64,
    pub context: i64,
}

impl Tally {
    pub fn add(&mut self, usage: &Usage) {
        let input = i64::from(usage.prompt_tokens.unwrap_or(0));
        self.calls += 1;
        self.input += input;
        self.output += i64::from(usage.completion_tokens.unwrap_or(0));
        self.cached += i64::from(
            usage
                .prompt_tokens_details
                .as_ref()
                .and_then(|details| details.cached_tokens)
                .unwrap_or(0),
        );
        self.context = input;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_adds_the_version_segment_once() {
        assert_eq!(
            endpoint_url(AdapterKind::Anthropic, "https://api.anthropic.com"),
            "https://api.anthropic.com/v1/"
        );
        assert_eq!(
            endpoint_url(AdapterKind::OpenAI, "https://relay.example/v1/"),
            "https://relay.example/v1/"
        );
        assert_eq!(
            endpoint_url(AdapterKind::Gemini, "https://g.example/v1beta"),
            "https://g.example/v1beta/"
        );
        assert!(adapter_kind("bogus").is_err());
    }

    #[test]
    fn retry_only_transient_failures() {
        let none = |_: &str| None;
        assert_eq!(
            retry_delay(Some(429), none, false, 0),
            Some(Duration::from_secs(1))
        );
        assert_eq!(
            retry_delay(Some(529), none, false, 2),
            Some(Duration::from_secs(4))
        );
        assert_eq!(retry_delay(Some(400), none, false, 0), None);
        assert_eq!(retry_delay(Some(401), none, false, 0), None);
        assert_eq!(
            retry_delay(None, none, true, 1),
            Some(Duration::from_secs(2))
        );
        assert_eq!(retry_delay(None, none, false, 0), None);
    }

    #[test]
    fn retry_honors_provider_headers() {
        let after = |name: &str| (name == "retry-after").then_some("7");
        assert_eq!(
            retry_delay(Some(429), after, false, 0),
            Some(Duration::from_secs(7))
        );
        let after_ms = |name: &str| (name == "retry-after-ms").then_some("250");
        assert_eq!(
            retry_delay(Some(503), after_ms, false, 0),
            Some(Duration::from_millis(250))
        );
        let long = |name: &str| (name == "retry-after").then_some("3600");
        assert_eq!(retry_delay(Some(429), long, false, 0), Some(MAX_DELAY));
        let refuse = |name: &str| (name == "x-should-retry").then_some("false");
        assert_eq!(retry_delay(Some(500), refuse, false, 0), None);
    }

    #[test]
    fn tally_sums_calls_and_keeps_last_context() {
        let mut tally = Tally::default();
        let usage = |input, output, cached| Usage {
            prompt_tokens: Some(input),
            completion_tokens: Some(output),
            prompt_tokens_details: Some(genai::chat::PromptTokensDetails {
                cached_tokens: Some(cached),
                ..Default::default()
            }),
            ..Default::default()
        };
        tally.add(&usage(100, 10, 0));
        tally.add(&usage(150, 20, 100));
        assert_eq!(
            tally,
            Tally {
                calls: 2,
                input: 250,
                output: 30,
                cached: 100,
                context: 150
            }
        );
    }
}
