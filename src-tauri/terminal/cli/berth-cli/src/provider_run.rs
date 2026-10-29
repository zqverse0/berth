//! `berth provider run <id> [--agent <tool>] -- <命令>`：在 Berth 之外（脚本、外部终端里的
//! Agent、其他工具）使用已存档案。子进程只拿到本机代理地址与令牌，真 Key 只在代理内存里。
//!
//! - 不带 `--agent`：按端点协议给各家 SDK 的通用环境变量（`OPENAI_BASE_URL` 等，见
//!   [`generic_env`]），另给每个端点 `BERTH_PROVIDER_<名字>_URL`；
//! - 带 `--agent`：在当前终端跑该 Agent 的 `launch.js`（专家、MCP 等与启动栏一致），与
//!   `terminal create --agent` 同一份启动档案，强制经代理。档案只有 launch.js 认，所以
//!   `--agent` 不能再接 `-- <命令>`。
//!
//! 本实例端口上没有代理（GUI 未开、也没跑 `berth provider proxy`）时，在本进程里临时起一个，
//! 子进程退出即随之结束。

use std::collections::BTreeMap;
use std::process::Command;
use std::sync::Arc;

use berth_provider_proxy::{provider_base_url, serve, upstream_client};
use berth_tool_core::provider_injection::resolve_endpoint_override;

use crate::provider_launch::LoadedProvider;
use crate::provider_proxy::{model_ids, protocols, route, CliResolver};
use crate::CliError;

/// `run` 与 `env` 共用：档案、端点、令牌与本实例代理端口。
struct Prepared {
    instance: berth_project_core::instance::DataInstance,
    port: u16,
    runtime: tokio::runtime::Runtime,
    loaded: LoadedProvider,
    protocols: Vec<String>,
    token: String,
}

fn prepare(reference: &str) -> Result<Prepared, CliError> {
    let instance = crate::project::resolve_instance(false)?;
    let port = crate::provider_launch::proxy_port(&instance);
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(CliError::from_runtime)?;
    let id = runtime
        .block_on(crate::provider_launch::provider_id(&instance, reference))
        .map_err(CliError::user)?;
    let loaded = runtime
        .block_on(crate::provider_launch::load_with_secrets(&instance, id, ""))
        .map_err(CliError::user)?
        .ok_or_else(|| CliError::user(format!("provider {id} not found or official")))?;
    let protocols = protocols(&loaded);
    let routes: Vec<_> = protocols
        .iter()
        .filter_map(|protocol| route(&loaded, protocol, None).ok())
        .collect();
    if routes.is_empty() {
        return Err(CliError::user(format!("provider {id} has no endpoint")));
    }
    if routes.iter().all(|route| route.key.trim().is_empty()) {
        eprintln!(
            "berth: provider {id} has no key; forwarding without credentials \
             (set one with `printf %s \"$KEY\" | berth provider set-key {id}`)"
        );
    }
    let token = crate::provider_launch::ensure_proxy_token(&instance).map_err(CliError::user)?;
    Ok(Prepared {
        instance,
        port,
        runtime,
        loaded,
        protocols,
        token,
    })
}

impl Prepared {
    /// 不带 `--agent` 时的环境：通用变量 + `--env` 映射。
    fn env(
        &self,
        model: Option<&str>,
        mappings: &[String],
    ) -> Result<BTreeMap<String, String>, CliError> {
        let base = provider_base_url(self.port, self.loaded.launch.provider.id);
        let mut env = generic_env(&self.loaded, &self.protocols, &base, &self.token, model);
        apply_mappings(&mut env, mappings, &self.protocols, &base, &self.token)?;
        Ok(env)
    }
}

pub(crate) fn run(
    reference: &str,
    agent: Option<&str>,
    model: Option<&str>,
    mappings: &[String],
    inputs: &BTreeMap<String, serde_json::Value>,
    command: &[String],
) -> Result<(), CliError> {
    if command.is_empty() && agent.is_none() {
        return Err(CliError::user(
            "nothing to run: give `-- <command>` or `--agent <tool-id>`",
        ));
    }
    if agent.is_some() && !command.is_empty() {
        return Err(CliError::user(
            "--agent starts the agent's launch.js; drop `-- <command>`, or drop --agent and map \
             the variables the command reads with --env",
        ));
    }
    if !command.is_empty() && !inputs.is_empty() {
        return Err(CliError::user(
            "--input only applies when the agent starts itself (no `-- <command>`)",
        ));
    }
    let prepared = prepare(reference)?;
    let id = prepared.loaded.launch.provider.id;
    if !berth_provider_proxy::is_listening(prepared.port) {
        start_temporary_proxy(prepared.instance.clone(), prepared.port)?;
        eprintln!(
            "berth: started a temporary provider proxy on 127.0.0.1:{}",
            prepared.port
        );
    }

    // `--agent`：与启动栏 / `terminal create --agent` 同一个 launch.js。
    let launch = agent
        .map(|agent| {
            crate::workspace_terminal::agent_argv(
                &berth_tool_core::paths::tools_root(),
                agent,
                inputs,
            )
            .map_err(CliError::user)
        })
        .transpose()?;
    let argv = launch.as_ref().map_or(command, |(argv, _)| argv.as_slice());
    let (program, args) = argv
        .split_first()
        .ok_or_else(|| CliError::user("empty command"))?;
    let mut child = Command::new(program);
    child.args(args);
    match (agent, &launch) {
        (Some(agent), Some((_, payload))) => {
            let provider_args = prepared
                .runtime
                .block_on(crate::provider_launch::resolve(
                    &prepared.instance,
                    agent,
                    Some(id),
                    model,
                    true,
                ))
                .map_err(CliError::user)?;
            if provider_args.is_empty() {
                return Err(CliError::user(format!(
                    "no agent tool '{agent}' with a providerInjection (tools/<id>/tool.json); see `berth tools list` for ids"
                )));
            }
            let mut env = BTreeMap::from([("BERTH_LAUNCH_INPUTS".to_owned(), payload.clone())]);
            let base = provider_base_url(prepared.port, id);
            apply_mappings(
                &mut env,
                mappings,
                &prepared.protocols,
                &base,
                &prepared.token,
            )?;
            child.envs(env).args(provider_args);
        }
        _ => {
            child.envs(prepared.env(model, mappings)?);
        }
    }
    let status = child
        .status()
        .map_err(|error| CliError::user(format!("cannot run {program}: {error}")))?;
    std::process::exit(status.code().unwrap_or(1));
}

/// `berth provider env`：打印与 `run` 相同的变量，供 `eval "$(…)"`、shell 配置或 `.env`
/// 文件使用。不起代理：用到这些变量时代理须在跑（GUI 或 `berth provider proxy`）。
pub(crate) fn print_env(
    reference: &str,
    model: Option<&str>,
    mappings: &[String],
    dotenv: bool,
) -> Result<(), CliError> {
    let prepared = prepare(reference)?;
    if !berth_provider_proxy::is_listening(prepared.port) {
        eprintln!(
            "berth: nothing listens on 127.0.0.1:{} yet; open Berth or run `berth provider proxy` \
             before using these variables",
            prepared.port
        );
    }
    for (name, value) in prepared.env(model, mappings)? {
        if dotenv {
            println!("{name}={value}");
        } else {
            println!("export {name}='{}'", value.replace('\'', r"'\''"));
        }
    }
    Ok(())
}

/// 档案的端点名（旧档案的 `any` 记作 `chat`）。
fn endpoint_names(protocols: &[String]) -> Vec<&str> {
    protocols
        .iter()
        .map(|protocol| if protocol == "any" { "chat" } else { protocol })
        .collect()
}

/// `--env NAME=<端点名>|token`：把工具要求的任意变量名指向某端点的代理地址（与填写的
/// URL 等价）或令牌，覆盖同名通用变量。
fn apply_mappings(
    env: &mut BTreeMap<String, String>,
    mappings: &[String],
    protocols: &[String],
    base: &str,
    token: &str,
) -> Result<(), CliError> {
    let endpoints = endpoint_names(protocols);
    for mapping in mappings {
        let Some((name, target)) = mapping.split_once('=') else {
            return Err(CliError::user(format!(
                "--env expects NAME=<endpoint>|token, got '{mapping}'"
            )));
        };
        let valid_name = name
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
            && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
        if !valid_name {
            return Err(CliError::user(format!(
                "--env: '{name}' is not a variable name"
            )));
        }
        let value = if target == "token" {
            token.to_owned()
        } else if endpoints.contains(&target) {
            format!("{base}/{target}")
        } else {
            return Err(CliError::user(format!(
                "--env {name}: '{target}' is neither `token` nor an endpoint of this provider ({})",
                endpoints.join(", ")
            )));
        };
        env.insert(name.to_owned(), value);
    }
    Ok(())
}

/// 本进程内的临时代理：先同步绑定（端口被占等错误在起子进程前报出），再交给后台线程。
fn start_temporary_proxy(
    instance: berth_project_core::instance::DataInstance,
    port: u16,
) -> Result<(), CliError> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", port))
        .and_then(|listener| listener.set_nonblocking(true).map(|()| listener))
        .map_err(|error| CliError::user(format!("cannot listen on 127.0.0.1:{port}: {error}")))?;
    let client = upstream_client().map_err(|error| CliError::user(error.to_string()))?;
    std::thread::spawn(move || {
        let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        else {
            return;
        };
        runtime.block_on(async move {
            if let Ok(listener) = tokio::net::TcpListener::from_std(listener) {
                let _ = serve(listener, client, Arc::new(CliResolver { instance })).await;
            }
        });
    });
    Ok(())
}

/// `chat` 等协议对应的上游地址是否已以版本段（`/v1`、`/v1beta`）结尾。
fn has_version(url: &str) -> bool {
    let tail = url.trim_end_matches('/').rsplit('/').next().unwrap_or("");
    tail.len() >= 2 && tail.starts_with('v') && tail[1..].starts_with(|c: char| c.is_ascii_digit())
}

/// 不带 `--agent` 时给子进程的环境。变量名取各家官方 SDK / CLI 读取的名字：
/// OpenAI SDK `OPENAI_BASE_URL` / `OPENAI_API_KEY`（base 含 `/v1`，另给旧名 `OPENAI_API_BASE`）；Anthropic SDK
/// `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY`；Gemini CLI 与 JS SDK `GOOGLE_GEMINI_BASE_URL`
/// / `GEMINI_API_KEY`。值全是代理地址与令牌。
fn generic_env(
    loaded: &LoadedProvider,
    protocols: &[String],
    base: &str,
    token: &str,
    model: Option<&str>,
) -> BTreeMap<String, String> {
    let provider = &loaded.launch.provider;
    let mut env = BTreeMap::from([
        ("BERTH_PROVIDER_ID".to_owned(), provider.id.to_string()),
        ("BERTH_PROVIDER_TOKEN".to_owned(), token.to_owned()),
        (
            "BERTH_PROVIDER_MODELS".to_owned(),
            serde_json::to_string(&model_ids(provider.model.as_deref())).unwrap_or_default(),
        ),
    ]);
    if let Some(model) = model {
        env.insert("BERTH_PROVIDER_MODEL".to_owned(), model.to_owned());
    }
    for protocol in protocols {
        // 旧档案只有 api_url（`any`），代理把任何协议名解析到它，按 OpenAI 兼容给。
        let name = if protocol == "any" { "chat" } else { protocol };
        let address = format!("{base}/{name}");
        let upstream =
            resolve_endpoint_override(loaded.discovery.as_deref(), protocol, &provider.api_url, "")
                .0;
        env.insert(
            format!(
                "BERTH_PROVIDER_{}_URL",
                name.to_ascii_uppercase().replace('-', "_")
            ),
            address.clone(),
        );
        match name {
            "chat" => {
                let suffix = if has_version(&upstream) { "" } else { "/v1" };
                env.insert("OPENAI_BASE_URL".into(), format!("{address}{suffix}"));
                // 旧版 openai SDK（<1.0）与 LangChain 读的名字。
                env.insert("OPENAI_API_BASE".into(), format!("{address}{suffix}"));
                env.insert("OPENAI_API_KEY".into(), token.to_owned());
            }
            "claude" => {
                env.insert("ANTHROPIC_BASE_URL".into(), address);
                env.insert("ANTHROPIC_API_KEY".into(), token.to_owned());
            }
            "gemini" => {
                env.insert("GOOGLE_GEMINI_BASE_URL".into(), address);
                env.insert("GEMINI_API_KEY".into(), token.to_owned());
            }
            _ => {}
        }
    }
    env
}

#[cfg(test)]
mod tests {
    use super::*;

    fn loaded(api_url: &str, discovery: Option<&str>) -> LoadedProvider {
        LoadedProvider {
            launch: berth_project_core::service::model_provider_launch::LaunchProvider {
                provider: berth_project_core::entities::model_provider::Model {
                    id: 7,
                    name: "p".into(),
                    api_url: api_url.into(),
                    api_key: String::new(),
                    agent_types_json: "[]".into(),
                    agent_type: String::new(),
                    model: Some(r#"[{"id":"m1"}]"#.into()),
                    website: None,
                    kind: "custom".into(),
                    flavor: "openai".into(),
                    discovery_json: None,
                    agent_allowlist: "[]".into(),
                    created_at: Default::default(),
                    updated_at: Default::default(),
                },
                overlay_models: None,
            },
            api_key: "sk-real".into(),
            discovery: discovery.map(str::to_owned),
        }
    }

    #[test]
    fn generic_env_carries_only_proxy_addresses_and_the_token() {
        let discovery = r#"{"endpoints":{
            "chat":{"apiUrl":"https://relay.example"},
            "claude":{"apiUrl":"https://relay.example/claude"},
            "search":{"apiUrl":"https://search.example"}}}"#;
        let provider = loaded("https://relay.example", Some(discovery));
        let protocols = protocols(&provider);
        let env = generic_env(
            &provider,
            &protocols,
            "http://127.0.0.1:15722/p/7",
            "berth-tk-x",
            Some("m1"),
        );

        assert_eq!(env["OPENAI_BASE_URL"], "http://127.0.0.1:15722/p/7/chat/v1");
        assert_eq!(env["OPENAI_API_BASE"], env["OPENAI_BASE_URL"]);
        assert_eq!(env["OPENAI_API_KEY"], "berth-tk-x");
        assert_eq!(
            env["ANTHROPIC_BASE_URL"],
            "http://127.0.0.1:15722/p/7/claude"
        );
        assert_eq!(
            env["BERTH_PROVIDER_SEARCH_URL"],
            "http://127.0.0.1:15722/p/7/search"
        );
        assert_eq!(env["BERTH_PROVIDER_MODELS"], r#"["m1"]"#);
        assert_eq!(env["BERTH_PROVIDER_MODEL"], "m1");
        assert!(!env.contains_key("GEMINI_API_KEY"));
        assert!(env.values().all(|value| !value.contains("sk-real")));
    }

    #[test]
    fn legacy_profile_is_offered_as_openai_compatible() {
        let provider = loaded("https://legacy.example/v1", None);
        let protocols = protocols(&provider);
        let env = generic_env(
            &provider,
            &protocols,
            "http://127.0.0.1:15722/p/7",
            "t",
            None,
        );
        assert_eq!(env["OPENAI_BASE_URL"], "http://127.0.0.1:15722/p/7/chat");
        assert!(!env.contains_key("BERTH_PROVIDER_MODEL"));
    }

    #[test]
    fn env_mappings_point_any_name_at_an_endpoint_or_the_token() {
        let protocols = vec!["chat".to_owned(), "search".to_owned()];
        let mut env = BTreeMap::new();
        apply_mappings(
            &mut env,
            &["DEEPSEEK_API_KEY=token".into(), "TAVILY_BASE=search".into()],
            &protocols,
            "http://127.0.0.1:15722/p/7",
            "berth-tk-x",
        )
        .unwrap();
        assert_eq!(env["DEEPSEEK_API_KEY"], "berth-tk-x");
        assert_eq!(env["TAVILY_BASE"], "http://127.0.0.1:15722/p/7/search");

        for bad in ["NOEQUALS", "1BAD=token", "X=claude"] {
            assert!(
                apply_mappings(&mut env, &[bad.into()], &protocols, "b", "t").is_err(),
                "{bad} must be rejected"
            );
        }
        // 旧档案（只有 api_url）按 chat 映射。
        apply_mappings(&mut env, &["U=chat".into()], &["any".into()], "b", "t").unwrap();
        assert_eq!(env["U"], "b/chat");
    }

    #[test]
    fn version_detection() {
        assert!(has_version("https://x/v1"));
        assert!(has_version("https://x/v1beta/"));
        assert!(!has_version("https://x"));
        assert!(!has_version("https://x/video"));
    }
}
