// @ts-check
/// <reference path="../berth-plugin.d.ts" />
// 按启动栏选择启动 Antigravity CLI。
//
// 隔离方式（agy 1.2.13 实测）：选不选专家都用会话专属自定义 agent（`--agent berth-<id>-<pid>`，退出即删）。
//
// - agent.md 设 `inheritCustomizations: false` + `inheritMcp: false`：不继承 ~/.gemini 的
//   GEMINI.md、config/skills、config/plugins、mcp_config.json。这个开关连项目级也一起关，
//   所以启动时按 agy 的发现规则（cwd 向上到仓库根）把项目 GEMINI.md / AGENTS.md /
//   `.agents/rules/*.md` 列进 `rules:`，把 `.agents/skills/*` 列进 `skills:`。
//   已知差异：子目录里的 GEMINI.md 不再随打开文件按需加载；项目 `.agents/` 下的 agents /
//   plugins / mcp_config.json / hooks.json 不转发，存在时在计划 `projectNotForwarded` 列出。
// - 专家 skills 与 MCP 打成会话插件（`plugins:` 指向临时目录，内含 skills/ 与 mcp_config.json）；
//   agy 没有原生插件格式，专家插件（Claude 格式）一律跳过（不导出 isNativePlugin）。
// - prompt 写在 agent.md 正文，追加在 agy 默认系统提示词之后。
// - 自定义 agent 必须显式列工具，否则没有写文件 / 执行命令能力；TOOLS 取默认 agent 的工具全集。

const { fs, process } = berth

/** @type {Record<string, string[]>} */
const MODES = {
  "accept-edits": ["--mode", "accept-edits"],
  plan: ["--mode", "plan"],
  bypass: ["--dangerously-skip-permissions"],
}

const AGY_AGENTS_HOME = "~/.gemini/config/agents"
const AGY_SETTINGS = "~/.gemini/antigravity-cli/settings.json"
const STATUSLINE = "berth tools run agy private/statusline.js"
const CUSTOMIZATION_ROOTS = [".agents", ".agent", "_agents", "_agent"]
const NOT_FORWARDED = [
  "agents",
  "plugins",
  "mcp_config.json",
  "hooks.json",
  "skills.json",
  "rules.json",
  "plugins.json",
  "agents.json",
]
const TOOLS = [
  "ask_question",
  "define_subagent",
  "invoke_subagent",
  "manage_subagents",
  "view_file",
  "write_to_file",
  "replace_file_content",
  "multi_replace_file_content",
  "run_command",
  "list_dir",
  "grep_search",
  "find_by_name",
  "read_url_content",
  "search_web",
  "send_message",
  "schedule",
  "manage_task",
  "generate_image",
]
const DOC_KEYS = new Set([
  "_comment",
  "_status",
  "_alternatives",
  "name",
  "description",
  "protocolVersion",
  "type",
])

const isFile = async (/** @type {string} */ path) =>
  (await fs.stat(path))?.kind === "file"
const isDir = async (/** @type {string} */ path) =>
  (await fs.stat(path))?.kind === "dir"
const listOrEmpty = async (/** @type {string} */ dir) =>
  (await isDir(dir)) ? await fs.list(dir) : []

/** cwd 向上到仓库根（含 .git 的目录），根在前；不在仓库里只看 cwd。 */
async function projectDirs(/** @type {string} */ cwd) {
  const chain = [cwd]
  for (let dir = cwd; dir !== "/"; )
    chain.push((dir = dir.slice(0, dir.lastIndexOf("/")) || "/"))
  for (let index = 0; index < chain.length; index += 1) {
    if (await fs.stat(`${chain[index] === "/" ? "" : chain[index]}/.git`))
      return chain.slice(0, index + 1).reverse()
  }
  return [cwd]
}

async function projectCustomizations(/** @type {string} */ cwd) {
  /** @type {string[]} */
  const rules = []
  /** @type {string[]} */
  const skills = []
  /** @type {string[]} */
  const skipped = []
  for (const directory of await projectDirs(cwd)) {
    const prefix = directory === "/" ? "" : directory
    for (const name of ["GEMINI.md", "AGENTS.md"])
      if (await isFile(`${prefix}/${name}`)) rules.push(`${prefix}/${name}`)
    for (const root of CUSTOMIZATION_ROOTS) {
      const base = `${prefix}/${root}`
      for (const name of (await listOrEmpty(`${base}/rules`))
        .filter((name) => name.endsWith(".md"))
        .sort()) {
        rules.push(`${base}/rules/${name}`)
      }
      for (const name of (await listOrEmpty(`${base}/skills`)).sort()) {
        if (await fs.stat(`${base}/skills/${name}/SKILL.md`))
          skills.push(`${base}/skills/${name}`)
      }
      for (const name of NOT_FORWARDED)
        if (await fs.stat(`${base}/${name}`)) skipped.push(`${base}/${name}`)
    }
  }
  return { rules, skills, skipped }
}

async function writeSessionPlugin(
  /** @type {string} */ pluginDir,
  /** @type {import("berth").Expert} */ expert
) {
  await fs.mkdir(`${pluginDir}/skills`)
  await fs.writeText(`${pluginDir}/plugin.json`, '{"name": "berth"}\n')
  for (const skill of expert.skills)
    await fs.symlink(skill.path, `${pluginDir}/skills/${skill.name}`)
  /** @type {Record<string, unknown>} */
  const servers = {}
  for (const [id, spec] of Object.entries(expert.mcp)) {
    servers[id] = Object.fromEntries(
      Object.entries(/** @type {object} */ (spec)).filter(
        ([key]) => !DOC_KEYS.has(key)
      )
    )
  }
  if (Object.keys(servers).length) {
    await fs.writeText(
      `${pluginDir}/mcp_config.json`,
      JSON.stringify({ mcpServers: servers }, null, 2) + "\n",
      { mode: 0o600 }
    )
  }
}

// JSON 字符串即合法的 YAML 双引号标量，路径里的空格、冒号不必另行转义
const yamlList = (/** @type {string} */ key, /** @type {unknown[]} */ items) =>
  items.length
    ? [`${key}:`, ...items.map((item) => `  - ${JSON.stringify(String(item))}`)]
    : []

function buildAgentMd(
  /** @type {string} */ name,
  /** @type {string} */ title,
  /** @type {string | null} */ prompt,
  /** @type {string} */ brief,
  /** @type {{plugins: string[], rules: string[], skills: string[]}} */ lists
) {
  const lines = [
    "---",
    `name: ${name}`,
    `description: ${JSON.stringify(title)}`,
    "mainAgent: true",
    "inheritCustomizations: false",
    "inheritMcp: false",
    ...yamlList("tools", TOOLS),
    ...yamlList("plugins", lists.plugins),
    ...yamlList("rules", lists.rules),
    ...yamlList("skills", lists.skills),
    "---",
    "",
    `# ${title}`,
    "",
  ]
  if (prompt !== null) lines.push(prompt)
  if (brief) lines.push("", brief)
  return lines.join("\n")
}

/** 进程被强杀或终端关闭时 finally 不执行；按名字尾部 pid 清掉宿主已不在的会话 agent。 */
async function sweepStaleAgents() {
  for (const name of await listOrEmpty(AGY_AGENTS_HOME)) {
    if (!/^berth-.*-/.test(name)) continue
    const pid = name.slice(name.lastIndexOf("-") + 1)
    if (!/^\d+$/.test(pid)) continue
    if (!(await process.alive(Number(pid))))
      await fs.remove(`${AGY_AGENTS_HOME}/${name}`).catch(() => {})
  }
}

/** agy 没有会话级 settings：用户未自配 statusLine 时写入全局，用量快照靠它产出。旧版 python 状态栏换成新命令。 */
async function ensureStatusline() {
  const settings = (await fs.stat(AGY_SETTINGS))
    ? JSON.parse(await fs.readText(AGY_SETTINGS))
    : {}
  const command = settings.statusLine?.command
  if (command && !String(command).includes("tools/agy/private/statusline.py"))
    return
  settings.statusLine = { type: "command", command: STATUSLINE, enabled: true }
  await fs.writeText(AGY_SETTINGS, JSON.stringify(settings, null, 2) + "\n")
}

/** @type {import("berth").AgentHooks} */
export default {
  args(inputs) {
    const args = []
    const mode = inputs.mode
    if (mode !== undefined) args.push(...MODES[String(mode)])
    if ("effort" in inputs) args.push("--effort", String(inputs.effort))
    // 只有明确选择开启沙箱，且不是绕过权限模式时，才添加沙盒参数
    if (inputs.sandbox === "on" && mode !== "bypass") args.push("--sandbox")
    return args
  },

  async launch(ctx) {
    try {
      await ensureStatusline()
    } catch (error) {
      console.error(
        `agy statusLine skipped: ${error instanceof Error ? error.message : error}`
      )
    }
    const expert = ctx.expert
    await sweepStaleAgents()
    const { rules, skills, skipped } = await projectCustomizations(
      ctx.paths.cwd
    )
    // 每个会话独占一个 agent 名，并发启动同一专家时互不删除对方的 agent.md
    const agentName = `berth-${expert?.id ?? "default"}-${process.pid}`
    const agentDir = `${AGY_AGENTS_HOME}/${agentName}`
    const expertSkills = expert?.skills ?? []
    /** @type {string[]} */
    const plugins = []
    if (expert && (expertSkills.length || Object.keys(expert.mcp).length)) {
      plugins.push(`${ctx.paths.tmp}/berth`)
      await writeSessionPlugin(plugins[0], expert)
    }
    await fs.mkdir(agentDir)
    try {
      await fs.writeText(
        `${agentDir}/agent.md`,
        buildAgentMd(
          agentName,
          expert ? expert.name : "Berth",
          expert ? expert.prompt : null,
          ctx.brief,
          { plugins, rules, skills }
        )
      )
      ctx.plan({
        expert: expert?.id ?? null,
        agent: agentName,
        skills: expertSkills.map((skill) => skill.name),
        mcp: expert ? Object.keys(expert.mcp).sort() : [],
        projectRules: rules,
        projectSkills: skills.map((path) =>
          path.slice(path.lastIndexOf("/") + 1)
        ),
        projectNotForwarded: skipped,
      })
      return await process.run("agy", ["--agent", agentName, ...ctx.args])
    } finally {
      await fs.remove(agentDir).catch(() => {})
    }
  },
}
