// @ts-check
/// <reference path="../berth-plugin.d.ts" />
// 按启动栏选择启动 Claude Code。
//
// 不读 ~/.claude/settings.json：用户级 settings、~/.claude.json 的 MCP、全局插件与 hooks 全部排除；
// 项目级 CLAUDE.md / skills / agents / .mcp.json / hooks 保留。专家资产只在本次会话的临时目录里组装。

const SETTING_SOURCES = "project,local"
// 未知模型必须声明 behavesAs，否则 Claude 每次都当首次运行并提示 catalog。
const SLOTS = ["fable", "haiku", "opus", "sonnet"]
// Claude Code hook 事件 → Berth hook 事件（matcher 为 null 表示不限）。中断（Esc）没有 hook，
// 靠 60 秒后的 idle_prompt 通知回到空闲。
/** @type {Array<[string, string | null, "session-start" | "turn-start" | "turn-end" | "attention" | "idle"]>} */
const HOOKS = [
  ["SessionStart", null, "session-start"],
  ["UserPromptSubmit", null, "turn-start"],
  ["Stop", null, "turn-end"],
  ["StopFailure", null, "idle"],
  ["PermissionRequest", null, "attention"],
  ["PreToolUse", "AskUserQuestion", "attention"],
  ["Notification", "idle_prompt", "idle"],
]

/** optionsFrom 类输入（model / session）：非空字符串，去首尾空白。 */
function textInput(
  /** @type {import("berth").LaunchInputs} */ inputs,
  /** @type {string} */ key
) {
  const value = inputs[key]
  if (value === undefined) return null
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${key} must be a non-empty string`)
  return value.trim()
}

/** 服务商：claude 端点与 Key 只进 claude 子进程环境；档位走 ANTHROPIC_DEFAULT_*，显示名用模型 id。 */
function providerEnv(/** @type {import("berth").Provider | null} */ provider) {
  if (!provider) return {}
  const { baseUrl, apiKey } = provider.endpoint("claude")
  /** @type {Record<string, string>} */
  const env = { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: apiKey }
  for (const model of provider.models) {
    if (!SLOTS.includes(model.slot)) continue
    const slot = model.slot.toUpperCase()
    env[`ANTHROPIC_DEFAULT_${slot}_MODEL`] = model.id
    env[`ANTHROPIC_DEFAULT_${slot}_MODEL_NAME`] = model.id
  }
  return env
}

const variants = (/** @type {string} */ id) =>
  id.includes("[") ? [id] : [id, `${id}[1m]`, `${id}[1M]`]
const pickerRow = (/** @type {string} */ id, slot = "") => ({
  model: id,
  label: id,
  behavesAs: SLOTS.includes(slot) ? slot : "sonnet",
})

/** 用 --settings 叠加 modelPicker，不改 CLAUDE_CONFIG_DIR。 */
function pickerSettings(
  /** @type {import("berth").Provider | null} */ provider,
  /** @type {string | null} */ selected
) {
  const models = provider ? provider.models : []
  if (!models.length) return {}
  const options = []
  const available = []
  const seen = new Set()
  const add = (/** @type {string} */ id, slot = "") => {
    if (!seen.has(id)) {
      options.push(pickerRow(id, slot))
      seen.add(id)
    }
    available.push(...variants(id))
  }
  for (const slot of SLOTS) {
    const model = models.find((row) => row.slot === slot)
    if (model) add(model.id, slot)
  }
  for (const model of models)
    if (!model.slot && !seen.has(model.id)) add(model.id)
  if (selected && !seen.has(selected)) {
    options.unshift(pickerRow(selected))
    available.push(...variants(selected))
  }
  /** @type {Record<string, unknown>} */
  const settings = {
    modelPicker: { options, replaceBuiltInOptions: true },
    availableModels: [...new Set(available)],
  }
  if (selected) settings.model = selected
  return settings
}

function selectedModel(/** @type {string[]} */ args) {
  for (const [index, arg] of args.entries()) {
    if (arg === "--model" && index + 1 < args.length) return args[index + 1]
    if (arg.startsWith("--model=")) return arg.slice("--model=".length) || null
  }
  return null
}

const writePrivate = (
  /** @type {string} */ path,
  /** @type {unknown} */ value
) =>
  berth.fs
    .writeText(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 })
    .then(() => path)

/** 专家 skills 软链进一个会话级插件，单个 --plugin-dir 加载，命名为 berth:<skill>。 */
async function skillsPlugin(
  /** @type {string} */ root,
  /** @type {readonly import("berth").Asset[]} */ skills
) {
  await writePrivate(`${root}/.claude-plugin/plugin.json`, {
    name: "berth",
    version: "0.0.0",
  })
  await berth.fs.mkdir(`${root}/skills`)
  for (const skill of skills)
    await berth.fs.symlink(skill.path, `${root}/skills/${skill.name}`)
  return root
}

function berthHooks(/** @type {import("berth").LaunchContext} */ ctx) {
  /** @type {Record<string, unknown[]>} */
  const hooks = {}
  for (const [event, matcher, berthEvent] of HOOKS) {
    const group = {
      hooks: [{ type: "command", command: ctx.hookCommand(berthEvent) }],
      ...(matcher ? { matcher } : {}),
    }
    ;(hooks[event] ??= []).push(group)
  }
  // 远程项目：Bash 命令经 Berth 的 hook 改写为在设备上执行（逻辑全在 Berth）。
  if (ctx.remote) {
    ;(hooks.PreToolUse ??= []).push({
      matcher: "Bash",
      hooks: [{ type: "command", command: ctx.remote.hookCommand }],
    })
  }
  return hooks
}

/**
 * 定时运行无人值守：信任确认框没人点，交互模式又没有参数能跳过。用户为这个任务设定时即同意，
 * 在 Claude 配置里把当前目录记为已信任；只此一处写 Claude 全局配置。
 */
async function trustCwdForScheduledRun(
  /** @type {import("berth").LaunchContext} */ ctx
) {
  if (!ctx.unattended) return
  const dir = berth.env.vars.CLAUDE_CONFIG_DIR
  const path = dir ? `${dir}/.claude.json` : `${ctx.paths.home}/.claude.json`
  try {
    const data = (await berth.fs.stat(path))
      ? JSON.parse(await berth.fs.readText(path))
      : {}
    const project = ((data.projects ??= {})[ctx.paths.cwd] ??= {})
    if (project.hasTrustDialogAccepted) return
    project.hasTrustDialogAccepted = true
    // ponytail: 读改写有毫秒级窗口，可能盖掉同时运行的 Claude 刚写的改动；只在首次信任时发生一次。
    await writePrivate(path, data)
  } catch (error) {
    console.error(
      `berth: cannot mark ${ctx.paths.cwd} trusted for Claude: ${error instanceof Error ? error.message : error}`
    )
  }
}

/** @type {import("berth").AgentHooks} */
export default {
  args(inputs) {
    const args = []
    if (inputs["permission-mode"] !== undefined)
      args.push("--permission-mode", String(inputs["permission-mode"]))
    if (inputs.effort !== undefined)
      args.push("--effort", String(inputs.effort))
    const model = textInput(inputs, "model")
    if (model) args.push("--model", model)
    const session = textInput(inputs, "session")
    if (session) args.push("--resume", session)
    return args
  },

  async isNativePlugin(dir) {
    return (
      (await berth.fs.stat(`${dir}/.claude-plugin/plugin.json`))?.kind ===
      "file"
    )
  },

  async launch(ctx) {
    const env = providerEnv(ctx.provider)
    const root = ctx.paths.tmp
    const settings = JSON.parse(
      await berth.fs.readText(`${ctx.paths.package}/private/base-settings.json`)
    )
    Object.assign(
      settings,
      pickerSettings(ctx.provider, selectedModel(ctx.args))
    )
    settings.hooks = berthHooks(ctx)
    const args = [
      "--setting-sources",
      SETTING_SOURCES,
      "--settings",
      await writePrivate(`${root}/settings.json`, settings),
    ]
    const expert = ctx.expert
    if (expert) {
      if (expert.skills.length)
        args.push(
          "--plugin-dir",
          await skillsPlugin(`${root}/skills-plugin`, expert.skills)
        )
      for (const plugin of expert.plugins)
        args.push("--plugin-dir", plugin.path)
      if (Object.keys(expert.mcp).length) {
        args.push(
          `--mcp-config=${await writePrivate(`${root}/mcp.json`, { mcpServers: expert.mcp })}`
        )
      }
    }
    // 专家提示词 + Berth 能力索引合成一个文件：每个经 Berth 启动的会话都知道可用的 berth 命令。
    const prompt = [expert?.prompt, ctx.brief].filter(Boolean).join("\n\n")
    if (prompt) {
      const promptPath = `${root}/system-prompt.md`
      await berth.fs.writeText(promptPath, prompt + "\n", { mode: 0o600 })
      args.push("--append-system-prompt-file", promptPath)
    }
    args.push(...ctx.args)
    ctx.plan({
      expert: expert?.id ?? null,
      prompt: Boolean(expert?.prompt),
      skills: expert ? expert.skills.map((skill) => skill.name) : [],
      mcp: expert ? Object.keys(expert.mcp) : [],
      settingSources: SETTING_SOURCES,
      claudeConfigDir: berth.env.vars.CLAUDE_CONFIG_DIR ?? null,
    })
    await trustCwdForScheduledRun(ctx)
    return berth.process.run("claude", args, { env })
  },
}
