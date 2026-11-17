//! 派发 worker：在项目群对应的目录（主目录或 worktree）以 ACP 成员入群，任务作为发给它的第一条消息。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use berth_project_core::tasks::{self, group, TaskError, TaskResult};
use serde_json::{json, Value};

use crate::{deliver, identity, Ctx};

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

/// `--agent` 与 `--preset` 二选一。`--input` 只能补充预设没有的键。
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
    for key in request.inputs.iter().map(|pair| pair.split_once('=').map_or(pair.as_str(), |(key, _)| key)) {
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

pub(crate) fn spawn(ctx: &Ctx, request: SpawnRequest) -> TaskResult<Value> {
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
    // 派发者：`--as`（缺省 lead）；worker 的回答发给它，留在群里。
    let lead = Some(request.lead.trim()).filter(|lead| !lead.is_empty()).unwrap_or("lead").to_owned();
    let mut brief = text.clone();
    if let Some(task) = &task {
        let prd = cwd.join(".berth/tasks").join(task).join("prd.md");
        let change = format!(
            "{} group --workspace {} change {name} --as <你的名字> --to {lead} --text '<原因 + 新要求>'",
            ctx.cli.display(),
            main.display()
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
    // 派发要求选专家：worker 按专家命名（重名编号），没选就不启动。
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
    let expert = berth_tool_core::paths::launch_expert(&tool_dir, &json!(chosen))
        .ok_or_else(|| invalid("--expert is required: group members are experts"))?;
    // 成员名是专家，重名编号。
    let taken: std::collections::HashSet<String> =
        group::members(&group::events(main, &name)?).into_iter().map(|member| member.name).collect();
    let worker = std::iter::once(expert.clone())
        .chain((2..).map(|n| format!("{expert}-{n}")))
        .find(|candidate| !taken.contains(candidate))
        .unwrap_or_default();
    if let Some(preset) = &preset {
        for (key, value) in &preset.inputs {
            inputs.insert(key.clone(), value.clone());
        }
    }
    let provider = preset
        .as_ref()
        .and_then(|preset| preset.provider_id.map(|id| (i64::from(id), preset.model_id.clone())));
    crate::join_acp(ctx, &name, &worker, &agent, inputs.into_iter().collect(), provider, Some(cwd.clone()))?;
    if !label.is_empty() {
        identity::set_label(main, &name, &worker, &label);
    }
    // 群始终记下任务（事实源），运行时把它作为第一条消息发给 worker。
    let message = group::append(
        main,
        &name,
        json!({"kind": "message", "author": lead, "to": worker, "text": brief, "task": task}),
    )?;
    let seq = group::seq(&message);
    let bell = deliver::doorbell(ctx, &name, &worker);
    Ok(json!({
        "worker": worker,
        "agent": agent,
        "preset": request.preset,
        "task": task,
        "worktree": (cwd != *main).then(|| cwd.to_string_lossy().into_owned()),
        "branch": branch,
        "seq": seq,
        "doorbell": bell,
    }))
}
