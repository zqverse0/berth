// @ts-check
/// <reference path="../berth-plugin.d.ts" />
// 按启动栏选择启动 Pi。
//
// 选不选专家都走同一隔离 agent 目录（隔离原则 4）；不用 --no-skills / --no-context-files，
// 它们会连项目级 AGENTS.md 与 skills 一起关（原则 2）。

const { fs, process } = berth

const GLOBAL_KEYS = new Set([
  "keepNativePackages",
  "nativePackages",
  "extensions",
  "skills",
  "mcp",
])
// Berth 选中服务商时写进会话 models.json 的 provider 名前缀（`berth-<端点>`）。
const BERTH_PROVIDER = "berth"

// 镜像 agent 目录时不带进会话的用户级资产（隔离原则 2）；其余（auth、models、sessions、
// trust、npm…）软链回原处，登录与会话存储不动。settings.json 另行重写。
// mcp.json 里的 imports（如 claude-code）会把其他 Agent 的 MCP 导入，同样排除。
const USER_LEVEL = new Set([
  "AGENTS.md",
  "agents",
  "extensions",
  "mcp.json",
  "prompts",
  "settings.json",
  "skills",
])
// settings.json 里指向用户级资源的键
const USER_RESOURCE_KEYS = ["skills", "extensions", "prompts"]

// Berth 接口名 → Pi models.json 的 `api`（docs/models.md）。tool.json 只声明这三种。
/** @type {Record<string, string>} */
const PI_APIS = {
  "openai-chat": "openai-completions",
  "openai-responses": "openai-responses",
  anthropic: "anthropic-messages",
}

/** optionsFrom 类输入：非空字符串，去首尾空白。 */
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

const isObject = (/** @type {unknown} */ value) =>
  !!value && typeof value === "object" && !Array.isArray(value)

const piSourceDir = (/** @type {string} */ home) =>
  (berth.env.vars.PI_CODING_AGENT_DIR || `${home}/.pi/agent`).replace(
    /^~(?=\/|$)/,
    home
  )

async function readJson(
  /** @type {string} */ path,
  /** @type {any} */ fallback
) {
  return (await fs.stat(path))?.kind === "file"
    ? JSON.parse(await fs.readText(path))
    : fallback
}

/** Pi 配置的默认 provider（不碰凭证）。 */
async function defaultPiProvider(/** @type {string} */ home) {
  const settings = await readJson(`${piSourceDir(home)}/settings.json`, null)
  if (!isObject(settings)) return null
  const provider = settings.defaultProvider
  return typeof provider === "string" && provider.trim()
    ? provider.trim()
    : null
}

function stringValues(
  /** @type {unknown} */ value,
  /** @type {string} */ field
) {
  if (value === undefined || value === null) return []
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string" && item.trim())
  ) {
    throw new Error(`${field} must be an array of strings`)
  }
  return value.map((item) => item.trim())
}

/** 资产 id：单段名字，不能越出所在目录（原 safe_id）。 */
function safeIds(/** @type {unknown} */ value, /** @type {string} */ field) {
  const ids = stringValues(value, field)
  for (const id of ids)
    if (id.includes("/") || id === "." || id === "..")
      throw new Error(`${field} has invalid id: ${id}`)
  return ids
}

/** Agent 级全局表（private/global.json）：所有专家共用的配置，启动时不按专家重复挂载。 */
async function loadGlobal(/** @type {string} */ pkg) {
  const table = await readJson(`${pkg}/private/global.json`, null)
  if (table === null)
    return {
      keepNativePackages: true,
      nativePackages: [],
      extensions: [],
      skills: [],
      mcp: [],
    }
  if (
    !isObject(table) ||
    Object.keys(table).some((key) => !GLOBAL_KEYS.has(key))
  ) {
    throw new Error("pi global.json has unsupported fields")
  }
  const keep = table.keepNativePackages ?? true
  if (typeof keep !== "boolean")
    throw new Error("keepNativePackages must be boolean")
  const global = {
    keepNativePackages: keep,
    nativePackages: stringValues(table.nativePackages, "nativePackages"),
    extensions: safeIds(table.extensions, "extensions"),
    skills: safeIds(table.skills, "skills"),
    mcp: safeIds(table.mcp, "mcp"),
  }
  // ponytail: 全局 skills / mcp 一直为空，宿主只给专家资产；要用时放进专家，或给宿主加 ctx 字段。
  if (global.skills.length || global.mcp.length)
    throw new Error(
      "pi global.json skills / mcp are no longer supported; put them in an expert"
    )
  return global
}

const packageSource = (/** @type {any} */ entry) => {
  const source = isObject(entry) ? entry.source : entry
  return typeof source === "string" ? source : ""
}

/** 用户 settings.json 保留个人偏好；packages 只留 global.json 声明的，去掉用户级资源路径。 */
async function sessionSettings(
  /** @type {string} */ home,
  /** @type {Awaited<ReturnType<typeof loadGlobal>>} */ global
) {
  const path = `${piSourceDir(home)}/settings.json`
  const settings = await readJson(path, {})
  if (!isObject(settings)) throw new Error(`${path} must be an object`)
  if (!global.keepNativePackages) {
    const keep = new Set(global.nativePackages)
    settings.packages = (settings.packages ?? []).filter(
      (/** @type {any} */ entry) => keep.has(packageSource(entry))
    )
  }
  for (const key of USER_RESOURCE_KEYS) delete settings[key]
  return settings
}

async function prepareAgentDir(
  /** @type {string} */ home,
  /** @type {string} */ agentDir,
  /** @type {any} */ global
) {
  const source = piSourceDir(home)
  if ((await fs.stat(source))?.kind === "dir") {
    for (const name of await fs.list(source)) {
      if (!USER_LEVEL.has(name))
        await fs.symlink(`${source}/${name}`, `${agentDir}/${name}`)
    }
  }
  const settings = await sessionSettings(home, global)
  await fs.writeText(
    `${agentDir}/settings.json`,
    JSON.stringify(settings, null, 2) + "\n"
  )
  return settings
}

/**
 * Berth 服务商 → Pi providers：每个用到的端点一个 `berth-<端点>`（各端点 Key 可能不同），
 * 模型带 Berth 为它选定的接口与地址（anthropic 用根地址，OpenAI 两种接口用 /v1）。
 * Key 走 `$BERTH_PI_KEY_<端点>` 插值，只进 pi 子进程环境，不落盘。
 */
function berthProviders(/** @type {import("berth").Provider} */ provider) {
  /** @type {Record<string, any>} */
  const providers = {}
  /** @type {Record<string, string>} */
  const env = {}
  for (const item of provider.models) {
    const api = PI_APIS[item.api]
    if (api === undefined) continue
    const endpoint = item.endpoint
    const { baseUrl, apiKey } = provider.endpoint(endpoint)
    const url = api === "anthropic-messages" ? baseUrl : withV1(baseUrl)
    const variable = `BERTH_PI_KEY_${endpoint.toUpperCase()}`
    env[variable] = apiKey
    const name = `${BERTH_PROVIDER}-${endpoint}`
    providers[name] ??= {
      baseUrl: url,
      api,
      apiKey: `$${variable}`,
      models: [],
    }
    /** @type {Record<string, unknown>} */
    const model = { id: item.id, name: item.name, api, baseUrl: url }
    // 中转站的模型名 Pi 不认识：上下文长度决定自动压缩时机，最长输出即请求的 max_tokens。
    if (item.contextWindow) model.contextWindow = item.contextWindow
    if (item.maxOutput) model.maxTokens = item.maxOutput
    providers[name].models.push(model)
  }
  return { providers, env }
}

/** 启动的模型（未选则第一个可用模型）→ [Pi provider 名, 模型 id]。 */
function selectedBerthModel(
  /** @type {import("berth").Provider} */ provider,
  /** @type {string | null} */ model
) {
  const usable = provider.models.filter((item) => item.api in PI_APIS)
  const item = usable.find((row) => row.id === model) ?? usable[0]
  return item ? [`${BERTH_PROVIDER}-${item.endpoint}`, item.id] : null
}

/** 会话 models.json = 用户 models.json + Berth providers（替换镜像来的软链）。 */
async function writeSessionModels(
  /** @type {string} */ home,
  /** @type {string} */ agentDir,
  /** @type {Record<string, any>} */ providers
) {
  const source = `${piSourceDir(home)}/models.json`
  const data = await readJson(source, {})
  if (!isObject(data)) throw new Error(`${source} must be an object`)
  data.providers = { ...data.providers, ...providers }
  // 原子改名替换的是软链本身，不会写穿到用户 models.json
  await fs.writeText(
    `${agentDir}/models.json`,
    JSON.stringify(data, null, 2) + "\n",
    { mode: 0o600 }
  )
}

/** 启动栏输入 → pi 参数。要看选中的服务商，所以在 launch 里算，args 钩子不用。 */
async function inputArgs(/** @type {import("berth").LaunchContext} */ ctx) {
  const inputs = ctx.inputs
  const args = []
  const session = textInput(inputs, "session")
  if (session) args.push("--session", session)
  if ("thinking" in inputs) args.push("--thinking", String(inputs.thinking))
  let provider = textInput(inputs, "provider")
  let model = textInput(inputs, "model")
  if (ctx.provider) {
    // Berth 选中的服务商就是本次唯一来源：不回落 Pi 自己的 defaultProvider。
    const chosen = selectedBerthModel(ctx.provider, model)
    if (chosen === null)
      throw new Error(`服务商「${ctx.provider.name}」没有 Pi 能用的模型`)
    ;[provider, model] = chosen
  }
  // 启动栏的 provider 可不选。Pi 0.85.1 在多个已登录 provider 有同名模型时把裸 --model 当歧义，
  // 即使 settings.json 有 defaultProvider；这种情况显式带上 Pi 的默认 provider。provider/model 写法无歧义。
  if (model !== null && provider === null && !model.includes("/"))
    provider = await defaultPiProvider(ctx.paths.home)
  if (provider !== null) args.push("--provider", provider)
  if (model !== null) args.push("--model", model)
  const trust = inputs["project-trust"]
  if (trust !== undefined)
    args.push(trust === "approve" ? "--approve" : "--no-approve")
  // promptInput：派发的任务作为交互会话的首条消息（`pi [--] [messages...]`，无 -p 即交互）
  const prompt = textInput(inputs, "prompt")
  if (prompt) args.push("--", prompt)
  return args
}

/** @type {import("berth").AgentHooks} */
export default {
  /** Pi 原生包：package.json 有 `pi` 清单，或有约定的 extensions/ 目录（docs/packages.md）。 */
  async isNativePlugin(dir) {
    const manifest = `${dir}/package.json`
    if ((await fs.stat(manifest))?.kind === "file") {
      const table = JSON.parse(await fs.readText(manifest))
      if (isObject(table) && "pi" in table) return true
    }
    return (await fs.stat(`${dir}/extensions`))?.kind === "dir"
  },

  async launch(ctx) {
    const { home, package: pkg } = ctx.paths
    const global = await loadGlobal(pkg)
    const expert = ctx.expert
    const skills = expert?.skills ?? []
    const servers = expert?.mcp ?? {}
    // 专家插件：Pi 原生包整目录 --extension（Pi 自己读 package.json#pi，连带其 skills）；否则跳过。
    const packages = (expert?.plugins ?? []).map((plugin) => plugin.path)
    // Agent 级扩展（如 berth-agent-status.ts）是 Berth 跑 Pi 的一部分，随 Pi 工具包放在 private/extensions/。
    const extensions = []
    for (const id of global.extensions) {
      const path = `${pkg}/private/extensions/${id}`
      if (!(await fs.stat(path)))
        throw new Error(`pi extension not found: ${path}`)
      extensions.push(path)
    }
    // 远程项目：bash 工具与 `!` 命令经 Berth 在设备上执行（private/extensions/berth-remote.ts）。
    if (ctx.remote) extensions.push(`${pkg}/private/extensions/berth-remote.ts`)

    const args = []
    if (expert?.prompt) args.push("--append-system-prompt", expert.prompt)
    if (ctx.brief) args.push("--append-system-prompt", ctx.brief)
    for (const skill of skills) args.push("--skill", skill.path)
    for (const extension of [...extensions, ...packages])
      args.push("--extension", extension)

    // ~/.agents/skills 按 $HOME 定位，Pi 没有单独关闭它的开关：非空时在计划里标出，不静默放过。
    const sharedSkills = `${home}/.agents/skills`
    const agentDir = `${ctx.paths.tmp}/agent`
    await fs.mkdir(agentDir, { mode: 0o700 })
    const settings = await prepareAgentDir(home, agentDir, global)
    /** @type {Record<string, string>} */
    let providerEnv = {}
    if (ctx.provider) {
      const { providers, env } = berthProviders(ctx.provider)
      providerEnv = env
      await writeSessionModels(home, agentDir, providers)
    }
    if (Object.keys(servers).length) {
      const configPath = `${agentDir}/berth-mcp.json`
      await fs.writeText(
        configPath,
        JSON.stringify({ mcpServers: servers }, null, 2) + "\n",
        { mode: 0o600 }
      )
      args.push("--mcp-config", configPath)
    }
    ctx.plan({
      expert: expert?.id ?? null,
      skills: skills.map((skill) => skill.name),
      extensions: global.extensions,
      mcp: Object.keys(servers).sort(),
      packages: (settings.packages ?? []).map(packageSource),
      sharedSkillsNotIsolated:
        (await fs.stat(sharedSkills))?.kind === "dir"
          ? (await fs.list(sharedSkills)).sort()
          : [],
    })
    const env = { ...providerEnv, PI_CODING_AGENT_DIR: agentDir }
    return await process.run(
      "pi",
      [...args, ...(await inputArgs(ctx)), ...ctx.args],
      { env }
    )
  },
}
