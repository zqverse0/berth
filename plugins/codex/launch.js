// @ts-check
/// <reference path="../berth-plugin.d.ts" />
// 按启动栏选择启动 Codex CLI。
//
// 选不选专家、官方还是自定义服务商，都走同一个隔离的会话 CODEX_HOME（`~/.berth-codex-session-*`）：
// 用户目录里的运行状态（登录、历史、会话）软链进来；指令、skills、插件、MCP、hooks 只用 Berth 组装的。

const MARKETPLACE = "berth-expert"
const PROFILE = "berth-expert"
// 不软链进会话目录：这些由 Berth 按会话重新生成，或会把用户级指令 / 插件带进来。
const EXCLUDED = new Set([
  ".claude",
  "AGENTS.md",
  "app-server-control",
  "config.toml",
  "hooks.json",
  "models_cache.json",
  "plugins",
  "rules",
  "skills",
])
// Codex hook 事件 → Berth hook 事件。
/** @type {Record<string, "session-start" | "turn-start" | "turn-end" | "attention" | "idle">} */
const BERTH_HOOKS = {
  SessionStart: "session-start",
  UserPromptSubmit: "turn-start",
  Stop: "turn-end",
  PermissionRequest: "attention",
  Interrupt: "idle",
}
const TRUST_QUERY_TIMEOUT_MS = 10_000

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
const userCodexHome = (/** @type {import("berth").LaunchContext} */ ctx) =>
  berth.env.vars.CODEX_HOME || `${ctx.paths.home}/.codex`
const readJson = async (/** @type {string} */ path) =>
  JSON.parse(await fs.readText(path))

/** @returns {Promise<Record<string, any>>} */
async function readConfig(/** @type {string} */ home) {
  const path = `${home}/config.toml`
  return (await fs.stat(path)) ? data.parseToml(await fs.readText(path)) : {}
}

async function writeConfig(
  /** @type {string} */ home,
  /** @type {Record<string, any>} */ config
) {
  await fs.writeText(`${home}/config.toml`, await data.stringifyToml(config))
}

/** 插件清单里的 name；version 必须能当路径段（codex plugin add 用它建目录）。 */
async function pluginName(/** @type {import("berth").Asset} */ plugin) {
  const root = await fs.resolve(plugin.path)
  const manifestPath = await fs.resolve(
    `${plugin.path}/.codex-plugin/plugin.json`
  )
  if (!manifestPath.startsWith(`${root}/`))
    throw new Error(`Codex plugin manifest escapes ${plugin.name}`)
  const manifest = await readJson(manifestPath)
  const name = manifest?.name
  if (typeof name !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(name)) {
    throw new Error(`plugins.${plugin.name}.name must be a safe asset id`)
  }
  const version = manifest.version
  if (
    typeof version !== "string" ||
    !version ||
    version === "." ||
    version === ".." ||
    /[/\\]/.test(version)
  ) {
    throw new Error(
      `plugins.${plugin.name}.version must be a safe path component`
    )
  }
  return name
}

/** 选中的本地插件做成会话里的原生 Codex marketplace；返回 `<name>@berth-expert`。 */
async function prepareMarketplace(
  /** @type {string} */ home,
  /** @type {Record<string, any>} */ config,
  /** @type {readonly import("berth").Asset[]} */ plugins
) {
  if (!plugins.length) return []
  const root = `${home}/berth-plugin-marketplace`
  await fs.mkdir(`${root}/plugins`)
  const selected = []
  const entries = []
  const seen = new Set()
  for (const plugin of plugins) {
    const name = await pluginName(plugin)
    if (seen.has(name)) throw new Error(`duplicate Codex plugin name: ${name}`)
    seen.add(name)
    selected.push(`${name}@${MARKETPLACE}`)
    await fs.symlink(plugin.path, `${root}/plugins/${name}`)
    entries.push({
      name,
      source: { source: "local", path: `./plugins/${name}` },
      policy: { installation: "AVAILABLE", authentication: "ON_USE" },
      category: "Developer Tools",
    })
  }
  const catalog = {
    name: MARKETPLACE,
    interface: { displayName: "Berth Expert" },
    plugins: entries,
  }
  await fs.writeText(
    `${root}/.agents/plugins/marketplace.json`,
    JSON.stringify(catalog, null, 2) + "\n"
  )
  ;(config.marketplaces ??= {})[MARKETPLACE] = {
    source_type: "local",
    source: root,
  }
  return selected
}

/** 软链运行状态、去掉用户级 MCP 的 config.toml、专家 skills、插件 marketplace；派发的 worker 预先信任目录。 */
async function prepareSessionHome(
  /** @type {import("berth").LaunchContext} */ ctx,
  /** @type {string} */ home
) {
  const source = userCodexHome(ctx)
  const names = (await fs.stat(source)) ? await fs.list(source) : []
  for (const name of names) {
    if (!EXCLUDED.has(name) && !name.startsWith("berth-expert-"))
      await fs.symlink(`${source}/${name}`, `${home}/${name}`)
  }
  const config = await readConfig(source)
  delete config.mcp_servers // 隔离：用户级 MCP 不进会话
  if (await fs.stat(`${source}/models_cache.json`))
    await fs.symlink(`${source}/models_cache.json`, `${home}/models_cache.json`)
  await fs.mkdir(`${home}/skills`)
  for (const skill of ctx.expert?.skills ?? [])
    await fs.symlink(skill.path, `${home}/skills/${skill.name}`)
  const selected = await prepareMarketplace(
    home,
    config,
    ctx.expert?.plugins ?? []
  )
  // 只有派发的 worker 带 prompt（`-- <prompt>`）：视为信任，跳过 trust 询问框；用户已对该目录做过决定就尊重它。
  if (ctx.args.includes("--")) {
    const projects = (config.projects ??= {})
    projects[ctx.paths.cwd] ??= { trust_level: "trusted" }
  }
  await writeConfig(home, config)
  return selected
}

/** 问 Codex 自己（app-server `hooks/list`）这些 hook 的信任键与哈希；失败返回空，hook 不生效但不挡启动。 */
async function trustedHooks(
  /** @type {string} */ hooksPath,
  /** @type {Record<string, string>} */ env,
  /** @type {string} */ cwd
) {
  let session
  try {
    session = await process.open("codex", ["app-server"], { env })
  } catch {
    return []
  }
  try {
    const messages = [
      {
        id: 1,
        method: "initialize",
        params: { clientInfo: { name: "berth", version: "0" } },
      },
      { method: "initialized" },
      { id: 2, method: "hooks/list", params: { cwds: [cwd] } },
    ]
    // app-server 读到 EOF 就退出、不答：stdin 保持打开，等到答复或超时。
    await session.write(
      messages
        .map((message) => JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n")
        .join("")
    )
    const deadline = Date.now() + TRUST_QUERY_TIMEOUT_MS
    while (Date.now() < deadline) {
      const line = await session.readLine({
        timeoutMs: Math.max(1, deadline - Date.now()),
      })
      if (line === null) return []
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      if (message?.id !== 2) continue
      return (message.result?.data ?? [])
        .flatMap((/** @type {any} */ entry) => entry.hooks ?? [])
        .filter((/** @type {any} */ hook) => hook.sourcePath === hooksPath)
        .map((/** @type {any} */ hook) => [hook.key, hook.currentHash])
    }
    return []
  } catch {
    return []
  } finally {
    await session.close()
  }
}

/** Berth hook 写进会话 hooks.json，只信任这几条。不用 --dangerously-bypass-hook-trust：它连项目层 hook 一起放行。 */
async function writeBerthHooks(
  /** @type {import("berth").LaunchContext} */ ctx,
  /** @type {string} */ home,
  /** @type {Record<string, string>} */ env
) {
  const hooksPath = `${home}/hooks.json`
  const hooks = Object.fromEntries(
    Object.entries(BERTH_HOOKS).map(([event, name]) => [
      event,
      [{ hooks: [{ type: "command", command: ctx.hookCommand(name) }] }],
    ])
  )
  await fs.writeText(hooksPath, JSON.stringify({ hooks }, null, 2) + "\n")
  const trusted = await trustedHooks(hooksPath, env, ctx.paths.cwd)
  if (!trusted.length) {
    console.error(
      "launch: codex hook trust query failed; this terminal will not join the Berth group"
    )
    return
  }
  const config = await readConfig(home)
  const state = ((config.hooks ??= {}).state ??= {})
  for (const [key, digest] of trusted)
    state[key] = { ...state[key], trusted_hash: digest }
  await writeConfig(home, config)
}

/** 选中的本地插件装进一次性 CODEX_HOME。 */
async function installPlugins(
  /** @type {string[]} */ selected,
  /** @type {Record<string, string>} */ env
) {
  for (const id of selected) {
    const result = await process.exec(
      "codex",
      ["plugin", "add", id, "--json"],
      { env }
    )
    if (result.code !== 0)
      throw new Error(
        `failed to prepare Codex plugin ${id}: ${(result.stderr || result.stdout).trim()}`
      )
  }
}

/**
 * 会话专属的指令与 profile。未选专家时也写：用户级插件同样按 profile 关闭；没有专家提示词时
 * 不写 model_instructions_file，保留 Codex 默认指令。
 */
async function writeProfile(
  /** @type {import("berth").LaunchContext} */ ctx,
  /** @type {string} */ home,
  /** @type {string[]} */ selected
) {
  /** @type {Record<string, any>} */
  const profile = {}
  const prompt = ctx.expert?.prompt
  if (prompt && prompt.trim()) {
    const path = `${home}/berth-expert-instructions.md`
    await fs.writeText(path, prompt, { mode: 0o600 })
    profile.model_instructions_file = path
  }
  // Berth 能力索引：developer_instructions 追加，不替换 Codex 默认指令。
  if (ctx.brief) profile.developer_instructions = ctx.brief
  const configured = Object.keys((await readConfig(home)).plugins ?? {})
  const plugins = [...new Set([...configured, ...selected])].sort()
  if (plugins.length)
    profile.plugins = Object.fromEntries(
      plugins.map((id) => [id, { enabled: selected.includes(id) }])
    )
  const servers = Object.entries(ctx.expert?.mcp ?? {})
  if (servers.length) {
    profile.mcp_servers = Object.fromEntries(
      servers.map(([name, /** @type {any} */ spec]) => {
        /** @type {Record<string, unknown>} */
        const server = {}
        for (const key of ["command", "args", "url"])
          if (key in spec) server[key] = spec[key]
        if (spec.env && Object.keys(spec.env).length) server.env = spec.env
        if (spec.headers && Object.keys(spec.headers).length)
          server.http_headers = spec.headers
        return [name, server]
      })
    )
  }
  await fs.writeText(
    `${home}/${PROFILE}.config.toml`,
    await data.stringifyToml(profile),
    { mode: 0o600 }
  )
  return PROFILE
}

function firstListed(/** @type {any} */ models) {
  const list = Array.isArray(models) ? models : models?.models
  if (!Array.isArray(list)) return null
  const item =
    list.find(
      (entry) =>
        entry && typeof entry === "object" && entry.visibility === "list"
    ) ?? list[0]
  return item && typeof item === "object" ? structuredCloneJson(item) : null
}

const structuredCloneJson = (/** @type {unknown} */ value) =>
  JSON.parse(JSON.stringify(value))

/**
 * 复制一份真实的 Codex ModelInfo 当模板。先读用户缓存（codex 运行时自动刷新）；新设备没有缓存时
 * 用 `codex debug models`（离线可用、字段与已安装版本一致，但约 5 秒，只作兜底）。
 */
async function catalogTemplate(
  /** @type {import("berth").LaunchContext} */ ctx
) {
  const home = userCodexHome(ctx)
  for (const path of [
    `${home}/cc-switch-model-catalog.json`,
    `${home}/models_cache.json`,
  ]) {
    if ((await fs.stat(path))?.kind !== "file") continue
    const template = firstListed(await readJson(path))
    if (template) return template
  }
  const result = await process.exec("codex", ["debug", "models"], {})
  const template =
    result.code === 0 ? firstListed(JSON.parse(result.stdout)) : null
  if (!template)
    throw new Error(
      "cannot build Codex model catalog: no cache and `codex debug models` failed"
    )
  return template
}

/**
 * 服务商模型替换 TUI 的模型列表：config 的 model_catalog_json + 会话里的 models_cache.json。
 * Codex `/model` 读的是 `$CODEX_HOME/models_cache.json`，会话目录若一直软链用户那份官方缓存，选单就只有官方模型。
 */
async function writeProviderCatalog(
  /** @type {import("berth").LaunchContext} */ ctx,
  /** @type {string} */ home
) {
  const models = ctx.provider?.models ?? []
  if (!models.length) return null
  const template = await catalogTemplate(ctx)
  const entries = models.map((model, index) => ({
    ...structuredCloneJson(template),
    slug: model.id,
    display_name: model.id,
    description: model.id,
    name: model.id,
    model: model.id,
    visibility: "list",
    supported_in_api: true,
    priority: index,
    upgrade: null,
  }))
  const catalogPath = `${home}/berth-model-catalog.json`
  await fs.writeText(
    catalogPath,
    JSON.stringify({ models: entries }, null, 2) + "\n",
    { mode: 0o600 }
  )
  /** @type {Record<string, unknown>} */
  let cache = {}
  const source = `${ctx.paths.home}/.codex/models_cache.json`
  if ((await fs.stat(source))?.kind === "file") {
    try {
      const parsed = await readJson(source)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        cache = parsed
    } catch {}
  }
  cache.models = entries
  // 会话里的 models_cache.json 先是指向用户缓存的软链；writeText 原子改名替换的是链接本身，不会写回用户缓存。
  await fs.writeText(
    `${home}/models_cache.json`,
    JSON.stringify(cache) + "\n",
    { mode: 0o600 }
  )
  return catalogPath
}

const hasModelArg = (/** @type {string[]} */ args) =>
  args.some(
    (arg) => arg === "-m" || arg === "--model" || arg.startsWith("model=")
  )

/** 服务商：`-c` 定义 `berth` provider，Key 只进 codex 子进程环境（env_key）。 */
function providerOverrides(
  /** @type {import("berth").Provider | null} */ provider
) {
  if (!provider) return { args: [], env: {} }
  const { baseUrl, apiKey } = provider.endpoint("chat")
  const args = [
    "-c",
    "model_provider=berth",
    "-c",
    "model_providers.berth.name=berth",
    "-c",
    `model_providers.berth.base_url=${withV1(baseUrl)}`,
    "-c",
    "model_providers.berth.env_key=BERTH_CODEX_API_KEY",
  ]
  // 中转站的模型名 Codex 不认识，上下文长度靠设置页填写（自动压缩据此判断）；Codex 没有最长输出项。
  const model =
    provider.models.find((row) => row.id === provider.model) ??
    provider.models[0]
  if (model?.contextWindow)
    args.push("-c", `model_context_window=${model.contextWindow}`)
  return { args, env: { BERTH_CODEX_API_KEY: apiKey } }
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
    const session = textInput(inputs, "session")
    if (session) args.push("resume", session)
    const sandbox = inputs.sandbox
    if (sandbox === "bypass-all")
      args.push("--dangerously-bypass-approvals-and-sandbox")
    else if (sandbox !== undefined) args.push("--sandbox", String(sandbox))
    const model = textInput(inputs, "model")
    if (model) args.push("-m", model)
    // promptInput：派发的任务作为初始 prompt，进入交互会话后立即执行（`codex [PROMPT]` / `codex resume <id> [PROMPT]`）。
    const prompt = textInput(inputs, "prompt")
    if (prompt) args.push("--", prompt)
    return args
  },

  async isNativePlugin(dir) {
    return (await fs.stat(`${dir}/.codex-plugin/plugin.json`))?.kind === "file"
  },

  async launch(ctx) {
    const provider = providerOverrides(ctx.provider)
    const expert = ctx.expert
    ctx.plan({
      expert: expert?.id ?? null,
      skills: expert ? expert.skills.map((skill) => skill.name) : [],
      mcp: expert ? Object.keys(expert.mcp) : [],
    })
    await sweepStaleSessions(ctx.paths.home, ".berth-codex-session-")
    const home = `${ctx.paths.home}/.berth-codex-session-${process.pid}-${Date.now()}`
    await fs.mkdir(home, { mode: 0o700 })
    try {
      const selected = await prepareSessionHome(ctx, home)
      const catalogPath = await writeProviderCatalog(ctx, home)
      const env = { ...provider.env, CODEX_HOME: home }
      await installPlugins(selected, env)
      await writeBerthHooks(ctx, home, env)
      const profile = await writeProfile(ctx, home, selected)
      const args = [
        "--profile",
        profile,
        // 回合结束 / 待审批时发 OSC 9，termd 记为 attention；默认 unfocused 在 termd 里不触发。
        "-c",
        "tui.notifications=true",
        "-c",
        'tui.notification_condition="always"',
        // 启动阻塞框：Update 框的 Enter = npm install -g；只关本会话。不涉及信任，手动启动也关。
        "-c",
        "check_for_update_on_startup=false",
        ...provider.args,
      ]
      if (catalogPath) {
        args.push("-c", `model_catalog_json=${catalogPath}`)
        const fallback = ctx.provider?.models[0]?.id
        if (!hasModelArg(ctx.args) && fallback) args.push("-m", fallback)
      }
      return await process.run("codex", [...args, ...ctx.args], { env })
    } finally {
      await fs.remove(home)
    }
  },
}
