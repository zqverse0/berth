//! 在已有项目群对应的目录启动 worker；任务仅作为消息上下文，不创建群或切换群组。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use berth_project_core::tasks::{self, group, TaskError, TaskResult};
use serde_json::{json, Value};

use crate::term::{self, CreateAgent, Terminals};
use crate::{deliver, identity, watch, Ctx};

pub struct SpawnRequest {
    pub group: String,
    pub lead: String,
    /// worker 的显示名；成员名是它的专家。
    pub worker: String,
    pub agent: Option<String>,
    /// worker 的专家（填进启动栏的「专家」项）；预设或 `--input` 里已选了专家时可省略。
    pub expert: Option<String>,
    pub preset: Option<String>,
    pub branch: Option<String>,
    pub task: Option<String>,
    pub inputs: Vec<String>,
    pub text: String,
}

fn invalid(message: impl Into<String>) -> TaskError {
    TaskError::new("invalid_input", message)
}

fn tool_file(agent: &str, file: &str) -> Option<Value> {
    let path = berth_tool_core::paths::tools_root().join(agent).join(file);
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

/// tool.json `extensions["org.berth.agent"].promptInput`：launch.js 接收初始任务的输入键。
fn prompt_input(agent: &str) -> Option<String> {
    tool_file(agent, "tool.json")?
        .pointer("/extensions/org.berth.agent/promptInput")?
        .as_str()
        .filter(|key| !key.is_empty())
        .map(str::to_owned)
}

/// `launchbar.json` 里 `optionsFrom: "providerModels"` 的项 id：GUI 把所选模型同时放进这个启动输入。
fn model_input(agent: &str) -> Option<String> {
    tool_file(agent, "launchbar.json")?["items"]
        .as_array()?
        .iter()
        .find(|item| item["optionsFrom"] == "providerModels")?["id"]
        .as_str()
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
}

#[derive(Debug, Clone)]
pub(crate) struct Preset {
    agent: String,
    inputs: BTreeMap<String, Value>,
    provider_id: Option<i32>,
    model_id: Option<String>,
}

fn presets_path(main: &Path) -> PathBuf {
    main.join(".berth/presets.json")
}

/// 项目级启动预设：只存 agent / 启动输入 / 服务商 id 与模型 id，凭据由 CLI 按 id 从 keyring 取。缺文件即无预设。
fn load_presets(main: &Path) -> TaskResult<BTreeMap<String, Preset>> {
    let path = presets_path(main);
    let raw: Value = match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|error| {
            TaskError::new("invalid_preset", format!("{}: {error}", path.display()))
        })?,
        Err(_) => return Ok(BTreeMap::new()),
    };
    let bad = |message: String| TaskError::new("invalid_preset", message);
    let Some(entries) = raw["presets"].as_object().filter(|_| raw["version"] == 1) else {
        return Err(bad(format!(
            "{} must be {{\"version\": 1, \"presets\": {{...}}}}",
            path.display()
        )));
    };
    let mut out = BTreeMap::new();
    for (name, preset) in entries {
        let agent = preset["agent"]
            .as_str()
            .filter(|agent| !agent.is_empty())
            .ok_or_else(|| bad(format!("preset {name:?} needs a non-empty agent")))?;
        let inputs = match &preset["inputs"] {
            Value::Null => BTreeMap::new(),
            Value::Object(map) => map.clone().into_iter().collect(),
            _ => return Err(bad(format!("preset {name:?}: inputs must be an object"))),
        };
        let provider_id = match &preset["providerId"] {
            Value::Null => None,
            value => Some(
                value
                    .as_i64()
                    .filter(|id| *id >= 1 && !value.is_boolean())
                    .and_then(|id| i32::try_from(id).ok())
                    .ok_or_else(|| {
                        bad(format!(
                            "preset {name:?}: providerId must be a positive integer or null"
                        ))
                    })?,
            ),
        };
        let model_id = match &preset["modelId"] {
            Value::Null => None,
            Value::String(model) if provider_id.is_some() => Some(model.clone()),
            _ => {
                return Err(bad(format!(
                    "preset {name:?}: modelId must be a string and needs providerId"
                )))
            }
        };
        out.insert(
            name.clone(),
            Preset {
                agent: agent.to_owned(),
                inputs,
                provider_id,
                model_id: model_id.filter(|model| !model.is_empty()),
            },
        );
    }
    Ok(out)
}

/// 只列摘要（输入键名、是否带服务商），不读凭据也不回显输入值。
pub(crate) fn list_presets(main: &Path) -> TaskResult<Value> {
    let presets: Vec<Value> = load_presets(main)?
        .into_iter()
        .map(|(name, preset)| {
            json!({
                "name": name, "agent": preset.agent,
                "inputs": preset.inputs.keys().collect::<Vec<_>>(),
                "provider": preset.provider_id.is_some(), "model": preset.model_id,
            })
        })
        .collect();
    Ok(json!({ "presets": presets }))
}

/// `--agent` 与 `--preset` 二选一。`--input`（以及自动补的 prompt 键）只能补充预设没有的键。
fn resolve_preset(main: &Path, request: &SpawnRequest) -> TaskResult<Option<Preset>> {
    if request.agent.is_some() == request.preset.is_some() {
        return Err(invalid("give exactly one of --agent or --preset"));
    }
    let Some(name) = &request.preset else {
        return Ok(None);
    };
    let presets = load_presets(main)?;
    let mut preset = presets.get(name).cloned().ok_or_else(|| {
        TaskError::new(
            "not_found",
            format!(
                "Preset not found: {name}; available: {}",
                if presets.is_empty() {
                    "(none)".to_owned()
                } else {
                    presets.keys().cloned().collect::<Vec<_>>().join(", ")
                }
            ),
        )
    })?;
    if let (Some(model), Some(key)) = (preset.model_id.clone(), model_input(&preset.agent)) {
        // 与启动栏一致：模型同时作为启动输入；预设两处都写时必须一致。
        if preset
            .inputs
            .get(&key)
            .is_some_and(|value| *value != json!(model))
        {
            return Err(TaskError::new(
                "invalid_preset",
                format!("preset {name:?}: inputs.{key} differs from modelId"),
            ));
        }
        preset.inputs.insert(key, json!(model));
    }
    let prompt = prompt_input(&preset.agent);
    for key in request
        .inputs
        .iter()
        .map(|pair| pair.split_once('=').map_or(pair.as_str(), |(key, _)| key))
        .chain(prompt.as_deref())
    {
        if preset.inputs.contains_key(key) {
            return Err(invalid(format!(
                "preset {name:?} already sets input {key:?}; --input may only add new keys"
            )));
        }
    }
    Ok(Some(preset))
}

fn parse_inputs(pairs: &[String]) -> TaskResult<BTreeMap<String, Value>> {
    pairs
        .iter()
        .map(|pair| {
            let (key, value) = pair
                .split_once('=')
                .filter(|(key, _)| !key.is_empty())
                .ok_or_else(|| invalid(format!("--input expects KEY=VALUE, got {pair:?}")))?;
            Ok((key.to_owned(), json!(value)))
        })
        .collect()
}

pub(crate) fn spawn(
    ctx: &Ctx,
    term: &dyn Terminals,
    request: SpawnRequest,
) -> TaskResult<Value> {
    let main = &ctx.main;
    // ---- 校验（不写任何东西）
    // `--group` 选在哪个目录（主目录或 worktree）启动；消息、成员都在项目群。
    let (checkout, env) = group::project_group(main, &request.group)?;
    let name = group::MAIN_GROUP.to_owned();
    let cwd = PathBuf::from(&env.worktree);
    if request
        .branch
        .as_deref()
        .is_some_and(|branch| branch != env.branch)
    {
        return Err(invalid(
            "Create and select the worktree project before spawning into another branch",
        ));
    }
    let label = request.worker.trim().to_owned();
    let text = request.text.trim().to_owned();
    if text.is_empty() {
        return Err(invalid("--text is required"));
    }
    let preset = resolve_preset(main, &request)?;
    let mut inputs = parse_inputs(&request.inputs)?;
    let agent = preset
        .as_ref()
        .map(|preset| preset.agent.clone())
        .or(request.agent.clone())
        .unwrap_or_default();
    let task = request
        .task
        .as_deref()
        .map(|task| tasks::show(main, Some(task)).map(|view| view.task_dir_name))
        .transpose()?;
    if let Some(task) = &task {
        if tasks::show(main, Some(task))?.group != checkout {
            return Err(invalid(
                "Assign the task to this worktree before spawning",
            ));
        }
    }
    if let Some(task) = &task {
        // 分支从提交分出去：prd 没提交，worktree 里就没有合同。
        let prd = main.join(".berth/tasks").join(task).join("prd.md");
        let tracked = std::process::Command::new("git")
            .arg("-C")
            .arg(main)
            .args(["status", "--porcelain", "--"])
            .arg(&prd)
            .output()
            .is_ok_and(|out| out.status.success() && out.stdout.is_empty());
        let known = std::process::Command::new("git")
            .arg("-C")
            .arg(main)
            .args(["ls-files", "--error-unmatch", "--"])
            .arg(&prd)
            .output()
            .is_ok_and(|out| out.status.success());
        if !prd.is_file() || !tracked || !known {
            return Err(TaskError::new(
                "prd_not_committed",
                format!(
                    "Commit {} before spawning: the worktree branches from a commit",
                    prd.display()
                ),
            ));
        }
    }

    // worker 始终启动在目标项目群对应的目录，任务只提供需求上下文。
    let branch = Some(env.branch);
    let events = group::events(main, &name)?;
    let lead = lead_identity(ctx, term, &name, &events, request.lead.trim())?;
    let mut brief = text.clone();
    if let Some(task) = &task {
        let prd = cwd.join(".berth/tasks").join(task).join("prd.md");
        let change = deliver::command(
            ctx,
            &[
                "change",
                &name,
                "--to",
                &lead,
                "--text",
                "<原因 + 新要求>",
            ],
        );
        brief = format!(
            "{brief}\n\n任务契约：{}（rev {}），以它为准，上面是你负责的切片。\
             如果用户或你发现要求与契约不一致，先执行 {change}，然后暂停，等主管回复「按 rev N 继续」，不要自行改方向。",
            prd.display(),
            group::spec_rev(&events)
        );
    }
    if let Some(branch) = &branch {
        brief =
            format!("{brief}\n\n完成后只在本地提交到自己的分支 {branch}，不要 push、不要合并。");
        if let Some(task) = &task {
            brief = format!("{brief}每个提交末尾加一行 `Task: {task} S<步骤号>`。");
        }
    }
    // 成员是专家：先确定 worker 是哪个专家，没有就不启动（没选专家的 Agent 不入群，结果收不回来）。
    let tool_dir = berth_tool_core::paths::tools_root().join(&agent);
    if let Some(expert) = request.expert.as_deref().map(str::trim).filter(|expert| !expert.is_empty()) {
        let key = berth_tool_core::paths::expert_input(&tool_dir)
            .ok_or_else(|| invalid(format!("{agent} has no expert option in its launch bar")))?;
        inputs.insert(key, json!(expert));
    }
    let mut chosen = inputs.clone();
    if let Some(preset) = &preset {
        chosen.extend(preset.inputs.clone());
    }
    let worker = berth_tool_core::paths::launch_expert(&tool_dir, &json!(chosen))
        .ok_or_else(|| invalid("--expert is required: group members are experts"))?;
    let prompt_key = prompt_input(&agent);
    if let Some(key) = &prompt_key {
        inputs.insert(key.clone(), json!(brief));
    }
    if let Some(preset) = &preset {
        for (key, value) in &preset.inputs {
            inputs.insert(key.clone(), value.clone());
        }
    }
    let project_id = term
        .ensure_project(&cwd)
        .map_err(|message| TaskError::new("cli_failed", message))?;
    let target_ref = term
        .create_agent(CreateAgent {
            project_id,
            cwd: &cwd,
            agent: &agent,
            inputs,
            provider_id: preset.as_ref().and_then(|preset| preset.provider_id),
            model_id: preset
                .as_ref()
                .and_then(|preset| preset.model_id.as_deref()),
        })
        .map_err(|message| {
            TaskError::new(
                "cli_failed",
                format!("berth terminal create failed: {message}"),
            )
        })?;
    group::append(
        main,
        &name,
        json!({
            "kind": "joined", "author": worker, "target_ref": target_ref,
            "agent": agent, "cwd": cwd, "collect": true,
        }),
    )?;
    if !label.is_empty() {
        identity::set_label(main, &name, &worker, &label);
    }
    // 群始终记下任务（事实源）；已作为启动输入交给 launch.js 时视为送达。
    let message = group::append(
        main,
        &name,
        // 指定给新终端：这个专家别的终端空着也不抢。
        json!({"kind": "message", "author": lead, "to": worker, "text": brief, "task": task, "target_ref": target_ref}),
    )?;
    let seq = group::seq(&message);
    let (delivery, bell) = if prompt_key.is_some() {
        group::set_delivered(main, &name, &worker, &target_ref, seq)?;
        (
            "launch-prompt",
            json!({"status": "skipped", "reason": "launch-prompt"}),
        )
    } else {
        // 新终端的 hook 报告会话开始之前不可投：门铃排队，会话开始时叫醒后台进程送达。
        let delivery = if deliver::body(&name, &[&message], &[]).is_some() {
            "paste"
        } else {
            "doorbell"
        };
        (delivery, deliver::doorbell(ctx, Some(term), &name, &worker))
    };
    watch::ensure_running(ctx);
    Ok(json!({
        "worker": worker,
        "agent": agent,
        "preset": request.preset,
        "task": task,
        "worktree": (cwd != *main).then(|| cwd.to_string_lossy().into_owned()),
        "branch": branch,
        "target_ref": target_ref,
        "seq": seq,
        "delivery": delivery,
        "doorbell": bell,
    }))
}

/// 派发者：在本群成员终端里就是它；在本项目选了专家的 Agent 终端里但还没入群（后台进程还没派生）就先登记，
/// worker 的汇报才送得回来；否则用 `--as`（缺省 lead），汇报只留在群里。派发者自己的回复不收集。
fn lead_identity(
    ctx: &Ctx,
    term: &dyn Terminals,
    name: &str,
    events: &[Value],
    as_name: &str,
) -> TaskResult<String> {
    let main = &ctx.main;
    if let Some(member) = identity::pane_member(events, ctx.caller.as_deref()) {
        return Ok(member);
    }
    let own = ctx.caller.clone();
    let probe = own.as_deref().and_then(|own| term.probe(own).ok()).filter(|probe| {
        term::agent_of(probe).is_some()
            && probe
                .session_project_path
                .as_deref()
                .is_some_and(|path| crate::in_project(main, Path::new(path)))
    });
    let (Some(own), Some(lead)) = (own, probe.as_ref().and_then(identity::member_name)) else {
        return Ok(Some(as_name).filter(|name| !name.is_empty()).unwrap_or("lead").to_owned());
    };
    group::append(
        main,
        name,
        json!({"kind": "joined", "author": lead, "target_ref": own}),
    )?;
    Ok(lead)
}
