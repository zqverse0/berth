// @ts-check
/// <reference path="../../berth-plugin.d.ts" />
// 页面经 scripts.run("ui/api.js", { action, … }) 调用的后端：问题配置、会话列表、跑 sounding、存结果。
// 问题与结果存在插件数据目录（$BERTH_HOME/state/sounding/），跟着 Berth 安装走，不进项目、不进 git。
// 分析由 sounding 完成：整体问题用 inspect_scout 的扫描器（对话模型），逐条判断用 Jev。
// 两种模型都经 `berth provider run` 的本地凭据代理（需要时嵌套两层），密钥不出 Berth。

const CONFIG = "config"
const DEFAULT_PROVIDER = "Deepseek"
const DEFAULT_MODEL = "deepseek-flash"

/** @param {any} input */
export default async function (input) {
  switch (input?.action) {
    case "state":
      return await state()
    case "saveConfig":
      await berth.storage.set(CONFIG, input.config)
      return { ok: true }
    case "scan":
      return await scan(String(input.sessionId), String(input.agent))
    default:
      throw new Error(`unknown action: ${input?.action}`)
  }
}

async function state() {
  const project = await berth.env.project()
  const providers = await chatProviders()
  const config = (await berth.storage.get(CONFIG)) ?? defaultConfig(providers)
  return {
    project,
    installed: (await berth.process.which("sounding")) !== null,
    providers: providers.chat,
    jevProviders: providers.jev,
    config,
    sessions: project ? await sessions(project.root) : [],
    results: project
      ? ((await berth.storage.get(resultsKey(project.id))) ?? {})
      : {},
  }
}

/** 整体问题用 OpenAI 兼容接口（chat 协议）的服务商，逐条判断用决策接口（systemone 协议，如 TypeSafe Jev）。 */
async function chatProviders() {
  const listed = await json("berth", ["provider", "list", "--json"])
  const of = (/** @type {string} */ protocol) =>
    listed
      .filter((/** @type {any} */ p) => p.protocol === protocol)
      .map((/** @type {any} */ p) => ({
        id: p.id,
        name: p.name,
        hasKey: p.hasKey,
        models: p.models,
      }))
  return { chat: of("chat"), jev: of("systemone") }
}

/** @param {{ chat: any[], jev: any[] }} providers */
function defaultConfig(providers) {
  const preferred =
    providers.chat.find((p) => p.name === DEFAULT_PROVIDER && p.hasKey) ??
    providers.chat.find((p) => p.hasKey)
  return {
    provider: preferred?.id ?? null,
    model: preferred?.models.includes(DEFAULT_MODEL)
      ? DEFAULT_MODEL
      : (preferred?.models[0] ?? null),
    jevProvider:
      (providers.jev.find((p) => p.hasKey) ?? providers.jev[0])?.id ?? null,
    questions: [],
  }
}

/** @param {string} root */
async function sessions(root) {
  const listed = await json("berth", [
    "project",
    root,
    "session",
    "ls",
    "--json",
    "--limit",
    "50",
  ])
  return listed.sessions.map((/** @type {any} */ s) => ({
    id: s.session_id,
    agent: s.agent,
    title: s.title,
    updatedAt: s.updated_at,
    live: s.live,
  }))
}

/**
 * @param {string} sessionId
 * @param {string} agent
 */
async function scan(sessionId, agent) {
  const project = await berth.env.project()
  if (!project) throw new Error("没有打开项目")
  /** @type {any} */
  const config = await berth.storage.get(CONFIG)
  const questions = (config?.questions ?? [])
    .map(toScoutQuestion)
    .filter(Boolean)
  if (!questions.length) throw new Error("先在「问题」里写至少一个问题")

  let argv = [
    "sounding",
    "scan",
    sessionId,
    "--project",
    project.root,
    "--agent",
    agent,
    "--config",
    "-",
  ]
  if (questions.some((/** @type {any} */ q) => q.type === "llm")) {
    if (config.provider == null || !config.model)
      throw new Error("先选服务商和模型")
    argv = [
      "berth",
      "provider",
      "run",
      String(config.provider),
      "--",
      ...argv,
      "--model",
      `openai-api/openai/${config.model}`,
    ]
  }
  if (questions.some((/** @type {any} */ q) => q.type === "jev")) {
    if (config.jevProvider == null)
      throw new Error("逐条判断要用 Jev：先在「模型」里选 Jev 服务商")
    // sounding 读 TypeSafe SDK 的变量名：把 Jev 端点的代理地址与令牌映射过去
    argv = [
      "berth",
      "provider",
      "run",
      String(config.jevProvider),
      "--env",
      "TYPESAFE_BASE_URL=systemone",
      "--env",
      "TYPESAFE_API_KEY=token",
      "--",
      ...argv,
    ]
  }
  const run = await berth.process.exec(argv[0], argv.slice(1), {
    stdin: JSON.stringify({ questions }),
  })
  if (run.code !== 0) throw new Error(failure(run.stderr || run.stdout))

  const output = JSON.parse(run.stdout)
  // 连同当时的问题一起存：之后改了问题，旧结果仍能对上原来的问法。
  const record = {
    at: new Date().toISOString(),
    questions: config.questions,
    output,
  }
  const key = resultsKey(project.id)
  const results = (await berth.storage.get(key)) ?? {}
  await berth.storage.set(key, { ...results, [sessionId]: record })
  return record
}

/**
 * 页面表单里的一个问题 → sounding 配置里的一个问题。
 * @param {any} q
 */
function toScoutQuestion(q) {
  const lines = (/** @type {string} */ text) =>
    String(text ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
  if (q.type === "grep") {
    const patterns = lines(q.patterns)
    return patterns.length
      ? { id: q.id, type: "grep", patterns, regex: !!q.regex }
      : null
  }
  if (!String(q.question ?? "").trim()) return null
  if (q.type === "judge") {
    // Jev 在标准没写清时给 ~0.5，没有区分度：两条标准都要写
    if (!String(q.trueWhen ?? "").trim() || !String(q.falseWhen ?? "").trim())
      return null
    return {
      id: q.id,
      type: "jev",
      unit: q.unit === "action" ? "action" : "user",
      question: q.question,
      criteria: { true: q.trueWhen, false: q.falseWhen },
    }
  }
  /** @type {any} */
  let answer = q.type
  if (q.type === "labels" || q.type === "multilabels") {
    answer = {
      labels: lines(q.labels),
      multiple: q.type === "multilabels",
      allowNone: !!q.allowNone,
    }
  } else if (q.type === "findings") {
    // 每行「字段名: 说明」；scout 要求每个字段都有说明（用来提示模型）。
    const fields = lines(q.fields).map((line) => {
      const [name, ...rest] = line.split(":")
      return {
        name: name.trim(),
        type: "string",
        description: rest.join(":").trim() || name.trim(),
      }
    })
    answer = { fields, multiple: true }
  }
  return {
    id: q.id,
    type: "llm",
    question: q.question,
    answer,
    exclude: { toolUsage: !!q.excludeTools },
    ...(q.focus ? { focus: q.focus } : {}),
  }
}

/** @param {number} projectId */
function resultsKey(projectId) {
  return `results/${projectId}`
}

/** @param {string} stderr */
function failure(stderr) {
  if (stderr.includes("--messages"))
    return "当前 Berth 太旧：需要支持 `session show --messages` 的版本"
  if (stderr.includes("sounding") && stderr.includes("not found"))
    return "没有安装 sounding：在 设置 → 工具 里安装 Sounding"
  return stderr.trim().split("\n").slice(-6).join("\n")
}

/**
 * @param {string} cmd
 * @param {string[]} args
 */
async function json(cmd, args) {
  const run = await berth.process.exec(cmd, args)
  if (run.code !== 0)
    throw new Error(
      `${cmd} ${args.join(" ")}: ${(run.stderr || run.stdout).trim()}`
    )
  return JSON.parse(run.stdout)
}
