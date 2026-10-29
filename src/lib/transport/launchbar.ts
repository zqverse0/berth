import { getTransport } from "@/lib/transport"
import type { LaunchbarFile } from "@/components/launchbar/types"

/**
 * Frontend contract for the `launchbar` multiplex command.
 *
 * 启动栏控件读 `tools/<id>/launchbar.json`；Agent 身份仍来自
 * `tools/<id>/tool.json`。前端只校验宿主支持的控件并提交选择值。
 */

/** `tools/<id>/tool.json` 的 Agent 摘要（图标条数据源）。 */
export type AgentProfileSummary = {
  id: string
  name: string
  icon?: string | null
  description?: string | null
  projectType?: string | null
  /** providerInjection.agentType 投影(档案栏);null = 不参与模型选择。 */
  providerAgentType?: string | null
  /** providerInjection.slots 投影:该 CLI 声明的模型档位选项。 */
  providerSlots?: string[] | null
  /** providerInjection.apis 投影:该 CLI 会说的模型接口(偏好序);null = 不按接口筛选。 */
  providerApis?: string[] | null
  /** `org.berth.agent.interruptKey`；null = 使用缺省 `Escape`。 */
  interruptKey?: string | null
}

export type LaunchbarRequest =
  | { type: "load"; agent: string }
  | { type: "list_agents" }
  | { type: "load_icon"; agent: string }

export type LaunchbarResponse =
  | { type: "file"; file: LaunchbarFile }
  | { type: "agents"; agents: AgentProfileSummary[]; directory: string }
  | { type: "icon"; dataUrl: string | null }

/** The only frontend path into the launchbar file runtime. */
export function launchbar(
  request: LaunchbarRequest
): Promise<LaunchbarResponse> {
  return getTransport().call<LaunchbarResponse>("launchbar", { request })
}
