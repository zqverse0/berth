/**
 * Berth 启动栏格式。前端只读 `tools/<id>/launchbar.json` 的 `items`。
 *
 * 声明什么显示什么。Agent 按这个名单填条目；没声明的协议不会出现服务商。
 * Berth 不按 Agent 名字分支。不要在 tool.json 再投影启动栏。
 */

export const LAUNCHBAR_OPTION_SOURCES = [
  "experts",
  "projectSessions",
  "providerVendor",
  "providerModels",
] as const

export type LaunchbarOptionSource = (typeof LAUNCHBAR_OPTION_SOURCES)[number]

/** Berth 提供的三种模型服务协议。服务商有对应 URL 才显示。 */
export const LAUNCHBAR_PROTOCOLS = ["claude", "chat", "gemini"] as const

export type LaunchbarProtocol = (typeof LAUNCHBAR_PROTOCOLS)[number]

export function isLaunchbarOptionSource(
  value: string
): value is LaunchbarOptionSource {
  return (LAUNCHBAR_OPTION_SOURCES as readonly string[]).includes(value)
}

export function isLaunchbarProtocol(value: string): value is LaunchbarProtocol {
  return (LAUNCHBAR_PROTOCOLS as readonly string[]).includes(value)
}

export function sanitizeLaunchbarProtocols(
  values: unknown
): LaunchbarProtocol[] {
  if (!Array.isArray(values)) return []
  const out: LaunchbarProtocol[] = []
  for (const item of values) {
    if (typeof item === "string" && isLaunchbarProtocol(item)) {
      if (!out.includes(item)) out.push(item)
    }
  }
  return out
}
