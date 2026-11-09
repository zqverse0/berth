// @ts-check
/// <reference path="../berth-plugin.d.ts" />

/** Hermes 还不消费专家：每项资产如实报告跳过，不静默丢弃；旧宿主没有 report。 */
function reportAssets(/** @type {import("berth").LaunchContext} */ ctx) {
  /** @type {import("berth").ReportItem[]} */
  const items = Object.entries(ctx.assets ?? {}).flatMap(([kind, assets]) =>
    assets.map((asset) => ({
      kind,
      id: asset.name,
      status: /** @type {const} */ ("skipped"),
      reason: "Hermes 插件还没有接入专家资产",
    }))
  )
  if (ctx.expert)
    items.push({
      kind: "native-memory",
      id: "~/.hermes/memories",
      status: "kept",
      reason: "Hermes 插件还没有接入专家资产，原生记忆照常读写",
    })
  ctx.report?.(items)
}

/** @type {import("berth").AgentHooks} */
export default {
  args(inputs) {
    const args = []
    if (inputs.interface) args.push(`--${inputs.interface}`)
    if (inputs.reasoning) args.push("--reasoning", String(inputs.reasoning))
    if (inputs.session) args.push("--resume", String(inputs.session))
    if (inputs.approval === "yolo") args.push("--yolo")
    return args
  },
  async launch(ctx) {
    reportAssets(ctx)
    // 固定默认深色背景，避免终端查询响应落入输入框；保留用户显式配置。
    const env = berth.env.vars.COLORFGBG ? {} : { COLORFGBG: "0" }
    if (!ctx.provider)
      return await berth.process.run("hermes", ctx.args, { env })
    const model =
      ctx.inputs.model || ctx.provider.model || ctx.provider.models[0]?.id
    if (!model) throw new Error("所选服务商没有兼容 Chat Completions 的模型")
    const { baseUrl, apiKey } = ctx.provider.endpoint("chat")
    const version = await berth.process.exec("hermes", ["--version"])
    const install = version.stdout
      .match(/^Install directory:\s*(.+)$/m)?.[1]
      ?.trim()
    if (version.code !== 0 || !install)
      throw new Error("无法确定 Hermes 安装路径")
    const models = [
      ...new Set(
        ctx.provider.models
          .filter((item) => !item.api || item.api === "openai-chat")
          .map((item) => item.id)
          .concat([String(model)])
      ),
    ]
    return await berth.process.run(
      `${install}/venv/bin/python`,
      [`${ctx.paths.package}/private/launch.py`, ...ctx.args],
      {
        env: {
          ...env,
          BERTH_HERMES_URL: baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`,
          BERTH_HERMES_KEY: apiKey,
          BERTH_HERMES_MODEL: String(model),
          BERTH_HERMES_NAME: ctx.provider.name,
          BERTH_HERMES_MODELS: JSON.stringify(models),
        },
      }
    )
  },
}
