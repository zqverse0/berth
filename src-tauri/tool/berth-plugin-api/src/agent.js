// 接入点 agent 的引导模块：宿主数据（__berth_launch）→ 插件钩子 args / isNativePlugin / launch。
// "__BERTH_PLUGIN__" 由宿主替换成插件 launch.js 的绝对路径。
import plugin from "__BERTH_PLUGIN__"

const data = JSON.parse(__berth_launch)
const hooks = plugin ?? {}
const candidates = data.expert ? data.expert.plugins : []
const native = []
for (const candidate of candidates) {
  if (
    typeof hooks.isNativePlugin === "function" &&
    (await hooks.isNativePlugin(candidate.path))
  )
    native.push(candidate)
}
const notes = Object.fromEntries(
  candidates.map((item) => [
    item.name,
    native.includes(item) ? "native" : "skipped",
  ])
)

if (data.mode === "plugins") {
  globalThis.__berth_result = JSON.stringify(notes)
} else {
  if (typeof hooks.launch !== "function")
    throw new Error("launch.js must `export default { launch(ctx) }`")
  const extra =
    typeof hooks.args === "function"
      ? await hooks.args(Object.freeze({ ...data.inputs }))
      : []
  const source = data.provider
  const provider =
    source &&
    Object.freeze({
      name: source.name,
      model: source.model,
      models: Object.freeze(source.models),
      endpoint(...protocols) {
        // 旧档案只有主地址时协议名为 any，最后兜底。
        for (const protocol of [...protocols, "any"]) {
          if (source.endpoints[protocol])
            return Object.freeze({ ...source.endpoints[protocol] })
        }
        const have = Object.keys(source.endpoints).sort().join(", ") || "无"
        throw Object.assign(
          new Error(
            `服务商「${source.name}」没有 ${protocols.join(" / ")} 端点（现有：${have}），请在 设置 → 模型服务商 补上对应端点`
          ),
          { reason: "invalid-params" }
        )
      },
    })
  const ctx = Object.freeze({
    args: [...extra, ...data.passthrough],
    inputs: Object.freeze({ ...data.inputs }),
    expert:
      data.expert &&
      Object.freeze({ ...data.expert, plugins: Object.freeze(native) }),
    provider,
    brief: data.brief,
    remote:
      data.remote &&
      Object.freeze({
        ...data.remote,
        execCommand: Object.freeze([...data.remote.execCommand]),
      }),
    unattended: data.unattended,
    paths: Object.freeze(data.paths),
    // 必须静默且不失败：SessionStart / UserPromptSubmit 的 stdout 会进 Agent 上下文，非零退出会拦住 Agent。
    hookCommand: (event) => `berth group hook ${event} >/dev/null 2>&1 || true`,
    plan: (details) =>
      console.error(
        `berth-${data.id}-plan: ` +
          JSON.stringify({ ...details, plugins: notes })
      ),
  })
  const code = await hooks.launch(ctx)
  globalThis.__berth_result = JSON.stringify(
    typeof code === "number" ? code : 0
  )
}
