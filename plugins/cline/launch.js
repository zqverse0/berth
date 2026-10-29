// @ts-check
/// <reference path="../berth-plugin.d.ts" />
// 按启动栏选择启动 Cline CLI。
//
// 隔离方式（Cline 3.0.62 实测）：选不选专家都把 `CLINE_DIR` 指向会话临时镜像——原目录除用户级资产
// （skills / rules / hooks / workflows / plugins / agents）外逐项软链，登录态与会话（data/）照常读写原处。
//
// - prompt：写成镜像里的 `rules/berth-expert.md`，追加在 Cline 默认系统提示词之后；
//   不用 `-s/--system`（它会整段替换默认提示词）。
// - skills：镜像里的 `skills/` 只放专家 skills（Cline 读 `$CLINE_DIR/skills`）。
// - mcp：`CLINE_MCP_SETTINGS_PATH` 指向会话文件，只含专家 MCP。
// - plugins：Cline 没有按目录加载的插件格式，专家 plugins 一律跳过（不导出 isNativePlugin）。
// - `CLINE_SESSION_BACKEND_MODE=local`：不经常驻 hub（见 launch 注释）。
// - 按 `$HOME` 定位的 `~/.agents/skills`、`~/.agents/AGENTS.md`、`~/Documents/Cline/*`、
//   `~/Cline/Rules` 没有开关可关：存在时在计划 `sharedNotIsolated` 里列出，不静默放过。

const { fs, process } = berth

// cline 没有 --act；不带 --plan 时沿用 global-settings.json 的 planActMode（用户上次停留的模式）。
// 所以 mode 用私有标记传给 launch()，由它写会话级设置副本（CLINE_GLOBAL_SETTINGS_PATH）
const MODE_FLAG = "--berth-mode"
const MODES = new Set(["act", "plan"])

const USER_LEVEL = new Set([
  "skills",
  "rules",
  "hooks",
  "workflows",
  "plugins",
  "agents",
])
const sharedUserPaths = (/** @type {string} */ home) => [
  `${home}/.agents/skills`,
  `${home}/.agents/AGENTS.md`,
  `${home}/Cline/Rules`,
  ...["Rules", "Workflows", "Hooks", "Plugins"].map(
    (kind) => `${home}/Documents/Cline/${kind}`
  ),
]

const TRANSPORTS = new Set(["stdio", "sse", "streamableHttp"])
// Berth 侧常见别名 → Cline 支持的三种 transport
/** @type {Record<string, string>} */
const TYPE_ALIASES = {
  http: "streamableHttp",
  streamablehttp: "streamableHttp",
  "streamable-http": "streamableHttp",
  sse: "sse",
  stdio: "stdio",
  local: "stdio",
}
// 声明里的说明性字段，不进 Cline transport
const DOC_KEYS = new Set([
  "_comment",
  "_status",
  "_alternatives",
  "name",
  "description",
  "protocolVersion",
])

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

/** 与 CLI 默认值一致；env 同名可覆盖。 */
const clineHome = (/** @type {string} */ home) =>
  (berth.env.vars.CLINE_DIR || `${home}/.cline`).replace(/^~(?=\/|$)/, home)

/**
 * Berth MCP 声明 → Cline transport 字段。Cline 只认 stdio / sse / streamableHttp；Berth 侧常见
 * `type: "http"` 别名，缺 type 时按 url / command 推断。其余字段（env / headers / timeout…）原样透传。
 */
function clineTransport(
  /** @type {string} */ serverId,
  /** @type {any} */ spec
) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec))
    throw new Error(`MCP ${serverId} must be an object`)
  let kind =
    TYPE_ALIASES[
      String(spec.type || "")
        .trim()
        .toLowerCase()
    ]
  if (!TRANSPORTS.has(kind)) {
    if (spec.url) kind = "streamableHttp"
    else if (spec.command) kind = "stdio"
  }
  if (!TRANSPORTS.has(kind))
    throw new Error(`MCP ${serverId} needs a url or command`)
  if (kind === "stdio" && !spec.command)
    throw new Error(`MCP ${serverId} type=stdio requires command`)
  if (kind !== "stdio" && !spec.url)
    throw new Error(`MCP ${serverId} type=${kind} requires url`)
  /** @type {Record<string, unknown>} */
  const transport = Object.fromEntries(
    Object.entries(spec).filter(([key]) => !DOC_KEYS.has(key))
  )
  transport.type = kind
  if (kind === "stdio" && !("args" in transport)) transport.args = []
  return transport
}

async function nonEmpty(/** @type {string} */ path) {
  const stat = await fs.stat(path)
  if (stat?.kind === "file") return true
  return stat?.kind === "dir" && (await fs.list(path)).length > 0
}

/** 会话 CLINE_DIR：原目录非用户级条目逐项软链，skills / rules 只放专家资产。 */
async function prepareConfigDir(
  /** @type {import("berth").LaunchContext} */ ctx,
  /** @type {string} */ configDir,
  /** @type {readonly import("berth").Asset[]} */ skills
) {
  const source = clineHome(ctx.paths.home)
  await fs.mkdir(`${source}/data`) // 不软链就会落进临时目录、退出即丢
  for (const name of await fs.list(source)) {
    if (!USER_LEVEL.has(name))
      await fs.symlink(`${source}/${name}`, `${configDir}/${name}`)
  }
  await fs.mkdir(`${configDir}/rules`)
  if (ctx.brief)
    await fs.writeText(`${configDir}/rules/berth.md`, ctx.brief + "\n")
  const expert = ctx.expert
  if (!expert) return
  if (skills.length) {
    await fs.mkdir(`${configDir}/skills`)
    for (const skill of skills)
      await fs.symlink(skill.path, `${configDir}/skills/${skill.name}`)
  }
  if (expert.prompt !== null)
    await fs.writeText(`${configDir}/rules/berth-expert.md`, expert.prompt)
}

/** 用户 global-settings.json 的会话副本，只改 planActMode；会话内切模式也不写回用户文件。 */
async function writeModeSettings(
  /** @type {string} */ home,
  /** @type {string} */ session,
  /** @type {string} */ mode
) {
  const source =
    berth.env.vars.CLINE_GLOBAL_SETTINGS_PATH ||
    `${clineHome(home)}/data/settings/global-settings.json`
  const settings =
    (await fs.stat(source))?.kind === "file"
      ? JSON.parse(await fs.readText(source))
      : {}
  settings.planActMode = mode
  const path = `${session}/global-settings.json`
  await fs.writeText(path, JSON.stringify(settings, null, 2) + "\n")
  return path
}

/** @type {import("berth").AgentHooks} */
export default {
  args(inputs) {
    /** @type {string[]} */
    const args = []
    const prompt = textInput(inputs, "prompt")
    // 派发的 worker（带 prompt）未指定模式时用 act，否则会沿用用户上次的 plan 只出计划
    const mode = MODES.has(String(inputs.mode))
      ? String(inputs.mode)
      : prompt
        ? "act"
        : null
    if (mode) args.push(MODE_FLAG, mode)
    if ("thinking" in inputs) args.push("--thinking", String(inputs.thinking))
    const autoApprove = inputs["auto-approve"]
    if (autoApprove !== undefined)
      args.push("--auto-approve", String(autoApprove).toLowerCase())
    // 带 prompt 不开 TUI 时 cline 跑完一轮就退出；派发的任务要进交互会话，所以强制 --tui
    if (inputs.tui || prompt) args.push("--tui")
    // promptInput：派发的任务作为交互会话的初始 prompt（`cline --tui [prompt]`）
    if (prompt) args.push("--", prompt)
    return args
  },

  async launch(ctx) {
    let clineArgs = [...ctx.args]
    let mode = null
    const index = clineArgs.indexOf(MODE_FLAG)
    if (index >= 0) {
      mode = clineArgs[index + 1]
      clineArgs = [...clineArgs.slice(0, index), ...clineArgs.slice(index + 2)]
    }
    const expert = ctx.expert
    /** @type {Record<string, unknown>} */
    const servers = {}
    for (const [serverId, spec] of Object.entries(expert?.mcp ?? {}))
      servers[serverId] = clineTransport(serverId, spec)
    const skills = expert?.skills ?? []
    const session = ctx.paths.tmp
    const configDir = `${session}/config`
    await fs.mkdir(configDir)
    await prepareConfigDir(ctx, configDir, skills)
    const mcpPath = `${session}/mcp.json`
    await fs.writeText(
      mcpPath,
      JSON.stringify({ mcpServers: servers }, null, 2) + "\n",
      { mode: 0o600 }
    )
    const shared = []
    for (const path of sharedUserPaths(ctx.paths.home))
      if (await nonEmpty(path)) shared.push(path)
    ctx.plan({
      expert: expert?.id ?? null,
      skills: skills.map((skill) => skill.name),
      mcp: Object.keys(servers).sort(),
      sharedNotIsolated: shared,
    })
    // local：会话在本进程跑。默认 auto 会经 data/locks 找到或拉起常驻 hub，hub 用的是
    // 它自己启动时的 CLINE_DIR——既会绕过本会话镜像，也会让本会话拉起的 hub 污染之后的普通会话
    /** @type {Record<string, string>} */
    const env = {
      CLINE_DIR: configDir,
      CLINE_MCP_SETTINGS_PATH: mcpPath,
      CLINE_SESSION_BACKEND_MODE: "local",
    }
    if (mode !== null)
      env.CLINE_GLOBAL_SETTINGS_PATH = await writeModeSettings(
        ctx.paths.home,
        session,
        mode
      )
    return await process.run("cline", clineArgs, { env })
  },
}
