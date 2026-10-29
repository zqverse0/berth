// @ts-check
/// <reference path="../berth-plugin.d.ts" />
// 按启动栏选择启动 Grok CLI。
//
// 选不选专家都走同一隔离会话目录（隔离原则 4）：用户级运行状态软链进会话 GROK_HOME，
// 用户级 MCP / 插件 / 外部厂商 skills 在会话 config.toml 里去掉，专家资产由 Berth 重新写入。

// 兼容层会读其他厂商的用户级配置（grok inspect 实测：~/.claude.json 的 6 个 MCP、
// ~/.claude/settings.json hooks、~/.cursor 的 mcp/hooks/skills）。会话级关闭这些单元；
// 各单元作用域见 ~/.grok/docs/user-guide/05-configuration.md#harness-compatibility。
// claude/cursor 的 skills/rules/agents 同时覆盖项目级目录，保持开启。
const COMPAT_OFF = {
  GROK_CLAUDE_MCPS_ENABLED: "false",
  GROK_CLAUDE_HOOKS_ENABLED: "false",
  GROK_CURSOR_MCPS_ENABLED: "false",
  GROK_CURSOR_HOOKS_ENABLED: "false",
  // [skills] ignore 对 ~/.cursor 实测无效（1.0.41），只能关单元；代价是项目 .cursor/skills 也不加载。
  GROK_CURSOR_SKILLS_ENABLED: "false",
}
// 用户级 Claude skills（如 ~/.claude/plugins/cache 里的插件 skills）按路径前缀隐藏；
// claude skills 单元同时管项目 .claude/skills，所以不关单元。
const FOREIGN_SKILL_ROOTS = ["~/.claude"]

// 09-plugins.md：插件目录含任一组件即可，plugin.json 可选，也认 .claude-plugin/。
const GROK_PLUGIN_PARTS = [
  ".grok-plugin",
  ".claude-plugin",
  "plugin.json",
  "skills",
  "commands",
  "agents",
  "hooks/hooks.json",
  ".mcp.json",
]

const { fs, data, process } = berth

/** optionsFrom 类输入（model / session / prompt）：非空字符串，去首尾空白。 */
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

const withV1 = (/** @type {string} */ url) =>
  url.endsWith("/v1") ? url : `${url}/v1`

/** 专家提示词正文；原实现是读 prompt 文件，宿主已把正文放进 ctx.expert.prompt。 */
const buildInstructions = (/** @type {string | null} */ prompt) => prompt ?? ""

/** 会话目录的来源：用户级 GROK_HOME（未设置则 ~/.grok）。 */
const grokSourceHome = (/** @type {import("berth").LaunchContext} */ ctx) =>
  berth.env.vars.GROK_HOME || `${ctx.paths.home}/.grok`

/** 选中的本地插件装进一次性 GROK_HOME。 */
async function installGrokPlugins(
  /** @type {readonly import("berth").Asset[]} */ plugins,
  /** @type {Record<string, string>} */ env
) {
  for (const plugin of plugins) {
    const result = await process.exec(
      "grok",
      ["plugin", "install", plugin.path, "--trust"],
      { env }
    )
    if (result.code !== 0)
      throw new Error(
        `failed to prepare Grok plugin ${plugin.name}: ${(result.stderr || result.stdout).trim()}`
      )
  }
}

/** 软链运行状态、去掉用户级 skills/plugins/MCP 配置，专家 skills 装进会话 skills 目录。 */
async function prepareSessionHome(
  /** @type {import("berth").LaunchContext} */ ctx,
  /** @type {string} */ sessionHome,
  /** @type {readonly import("berth").Asset[]} */ skills,
  /** @type {boolean} */ trust
) {
  const sourceHome = grokSourceHome(ctx)
  const excluded = new Set([
    "AGENTS.md",
    "agents",
    "commands",
    "config.toml",
    "disabled-hooks",
    "hooks",
    "installed-plugins",
    "plugins",
    "rules",
    "skills",
  ])
  if (trust) {
    for (const name of ["trusted_folders.toml", "trusted_folders.toml.lock"])
      excluded.add(name)
  }
  for (const name of await fs.list(sourceHome)) {
    if (!excluded.has(name) && !name.startsWith("berth-grok-")) {
      await fs.symlink(`${sourceHome}/${name}`, `${sessionHome}/${name}`)
    }
  }
  // 派发时复制而不软链：--trust 写入的授权只留在本会话；手动启动软链，用户答 y 照常记住
  const trustedFolders = `${sourceHome}/trusted_folders.toml`
  if (trust && (await fs.stat(trustedFolders))) {
    await fs.copy(trustedFolders, `${sessionHome}/trusted_folders.toml`)
  }
  const skillsHome = `${sessionHome}/skills`
  await fs.mkdir(skillsHome)
  for (const skill of skills)
    await fs.symlink(skill.path, `${skillsHome}/${skill.name}`)
}

/** Grok 把 ~/.claude/plugins/ 当作用户级插件目录（09-plugins.md），读 Claude 的安装清单拿名字。 */
async function claudePluginNames(
  /** @type {import("berth").LaunchContext} */ ctx
) {
  /** @type {Set<string>} */
  const names = new Set()
  /** @type {any} */
  let registry
  try {
    registry = JSON.parse(
      await fs.readText(
        `${ctx.paths.home}/.claude/plugins/installed_plugins.json`
      )
    )
  } catch {
    return names // 清单缺失或不是 JSON：当没有外部插件，不挡启动
  }
  const plugins =
    registry && typeof registry === "object" && !Array.isArray(registry)
      ? (registry.plugins ?? {})
      : {}
  for (const key of Object.keys(plugins)) names.add(key.split("@", 1)[0])
  return names
}

/**
 * 会话 config.toml = 用户配置 − 用户级 MCP/插件 + 专家 MCP + 屏蔽外部厂商用户级 skills + 服务商模型。
 * Berth 要改写的表先整张去掉再合并重写，保证合法 TOML（不重复声明表）。
 */
async function writeSessionConfig(
  /** @type {import("berth").LaunchContext} */ ctx,
  /** @type {string} */ sessionHome,
  /** @type {Readonly<Record<string, any>>} */ servers,
  /** @type {string[]} */ expertPlugins
) {
  const source = `${grokSourceHome(ctx)}/config.toml`
  /** @type {Record<string, any>} */
  const config =
    (await fs.stat(source))?.kind === "file"
      ? await data.parseToml(await fs.readText(source))
      : {}
  // 用户级 [plugins]（如 enabled = ["ponytail"]）会让兼容层发现的 Claude 插件以用户插件身份加载；
  // 专家插件由 installGrokPlugins 装进会话目录后自行登记。
  const models = ctx.provider ? ctx.provider.models : []
  const userSkills = { ...config.skills }
  const userModels = { ...config.models }
  delete config.mcp_servers
  delete config.skills
  delete config.plugins
  if (models.length) {
    delete config.models
    delete config.model
  }
  // skills.ignore：原有的 + 外部厂商根目录，去重保序
  config.skills = {
    ...userSkills,
    ignore: [
      ...new Set([...(userSkills.ignore ?? []), ...FOREIGN_SKILL_ROOTS]),
    ],
  }
  // 专家同名插件装在会话目录，优先级更高，不受 disabled 影响之外的名字才屏蔽
  const native = new Set(expertPlugins)
  const foreignPlugins = [...(await claudePluginNames(ctx))]
    .filter((name) => !native.has(name))
    .sort()
  if (foreignPlugins.length) config.plugins = { disabled: foreignPlugins }
  const serverNames = Object.keys(servers)
  if (serverNames.length) {
    /** @type {Record<string, unknown>} */
    const mcpServers = {}
    for (const name of serverNames) {
      /** @type {Record<string, any>} */
      const spec = servers[name] ?? {}
      /** @type {Record<string, unknown>} */
      const entry = {}
      for (const key of ["command", "args", "url", "env", "headers"])
        if (key in spec) entry[key] = spec[key]
      mcpServers[name] = entry
    }
    config.mcp_servers = mcpServers
  }
  if (models.length) {
    config.models = { ...userModels, default: models[0].id }
    config.model = Object.fromEntries(
      models.map((model) => [model.id, { name: model.id }])
    )
  }
  // 回合结束 / 待审批发 OSC 9（termd 记 attention）；auto 在 Berth 下回落 BEL、unfocused 不触发。
  // 用户已写 [ui.notifications] 时尊重用户（再追加同名表会成非法 TOML）
  const ui = config.ui ?? {}
  if (!("notifications" in ui))
    config.ui = {
      ...ui,
      notifications: { method: "osc9", condition: "always" },
    }
  await fs.writeText(
    `${sessionHome}/config.toml`,
    await data.stringifyToml(config)
  )
}

/** Berth 选中的服务商：chat 端点与 Key 只进 grok 子进程环境。 */
function providerEnv(/** @type {import("berth").Provider | null} */ provider) {
  if (!provider) return {}
  const { baseUrl, apiKey } = provider.endpoint("chat")
  return { GROK_MODELS_BASE_URL: withV1(baseUrl), XAI_API_KEY: apiKey }
}

/** 终端被关闭时宿主直接结束进程，finally 不执行：按目录名里的 pid 清掉进程已不在的旧会话目录。 */
async function sweepStaleSessions(
  /** @type {string} */ home,
  /** @type {string} */ prefix
) {
  for (const name of await fs.list(home)) {
    const pid = name.startsWith(prefix)
      ? /^(\d+)-\d+$/.exec(name.slice(prefix.length))?.[1]
      : undefined
    if (pid && !(await process.alive(Number(pid))))
      await fs.remove(`${home}/${name}`).catch(() => {})
  }
}

/** @type {import("berth").AgentHooks} */
export default {
  args(inputs) {
    const args = []
    if ("permission-mode" in inputs)
      args.push("--permission-mode", String(inputs["permission-mode"]))
    const model = textInput(inputs, "model")
    if (model) args.push("-m", model)
    const session = textInput(inputs, "session")
    if (session) args.push("--resume", session)
    // promptInput：派发的任务作为交互会话的初始 prompt（`grok [PROMPT]`）
    const prompt = textInput(inputs, "prompt")
    if (prompt) args.push("--", prompt)
    return args
  },

  async isNativePlugin(dir) {
    for (const part of GROK_PLUGIN_PARTS)
      if (await fs.stat(`${dir}/${part}`)) return true
    return false
  },

  async launch(ctx) {
    const expert = ctx.expert
    const prompt = expert ? expert.prompt : null
    // ctx.expert.plugins 宿主已按 isNativePlugin 筛过（route_plugins 的 native 那半）
    const plugins = expert?.plugins ?? []
    const skills = expert?.skills ?? []
    const servers = expert?.mcp ?? {}
    await sweepStaleSessions(ctx.paths.home, ".berth-grok-expert-")
    const sessionHome = `${ctx.paths.home}/.berth-grok-expert-${process.pid}-${Date.now()}`
    await fs.mkdir(sessionHome, { mode: 0o700 })
    try {
      const trust = ctx.args.includes("--") // 只有派发的 worker 带 prompt
      await prepareSessionHome(ctx, sessionHome, skills, trust)
      await writeSessionConfig(
        ctx,
        sessionHome,
        servers,
        plugins.map((plugin) => plugin.name)
      )
      const env = {
        ...providerEnv(ctx.provider),
        ...COMPAT_OFF,
        GROK_HOME: sessionHome,
      }
      await installGrokPlugins(plugins, env)
      const args = [...(trust ? ["--trust"] : [])]
      if (prompt !== null)
        args.push("--system-prompt-override", buildInstructions(prompt))
      if (ctx.brief) args.push("--rules", ctx.brief)
      ctx.plan({
        expert: expert?.id ?? null,
        skills: skills.map((skill) => skill.name),
        mcp: Object.keys(servers).sort(),
        compatOff: Object.keys(COMPAT_OFF).sort(),
      })
      return await process.run("grok", [...args, ...ctx.args], { env })
    } finally {
      await fs.remove(sessionHome)
    }
  },
}
