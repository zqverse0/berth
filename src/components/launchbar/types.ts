/**
 * launchbar.json 的前端契约类型。
 *
 * Berth 只读这一份文件的 `items`。格式由宿主定，Agent 往里填：
 * 静态 select 写 options；动态来源只允许 format.ts 里的 optionsFrom。
 * 服务商条目用 `protocols` 声明支持 claude / chat / gemini 哪几种。
 * 选中值作为 `--berth-launch-inputs` JSON 交给 `launch.js`。
 * 宿主不拼目标 CLI，也不从 tool.json 再投影启动栏。
 */

/** select 组件的一个选项：显示文本 + 提交给启动脚本的值。 */
export interface LaunchbarOption {
  value: string
  label: string
  /** 遗留字段，启动路径不再读取。 */
  argv?: string[]
}

/** launchbar.json 中一个可渲染项。
 *
 *  - select：静态 `options`，或 `optionsFrom` 由运行时注入。
 *  - input / switch：提交字符串或布尔值。
 */
export interface LaunchbarItem {
  id: string
  component: "select" | "input" | "switch"
  label: string
  /** select 专用：选项列表（静态声明或运行时注入）。 */
  options?: LaunchbarOption[]
  /**
   * select 专用：动态选项来源（Berth 运行时注入 options，文件里不写）。
   * 冻结名单见 format.ts。条目顺序即栏上顺序。
   */
  optionsFrom?:
    | "providerVendor"
    | "providerModels"
    | "experts"
    | "projectSessions"
  /**
   * `providerVendor` 专用：该 Agent 支持的模型服务协议。
   * 没写就不显示服务商。取值与设置页协议栏同一套（`resolveProviderProtocolUrls`）：
   * `discovery_json.endpoints` 优先，缺失时主地址按 `chat`。
   */
  protocols?: Array<"claude" | "chat" | "gemini">
  /** 初始选中/输入值；缺省时 select 保持未选。 */
  defaultValue?: string
  /** 占位提示。 */
  placeholder?: string
  /** 遗留字段，启动路径不再读取。 */
  argvTemplate?: string[]
  /** 遗留字段，启动路径不再读取。 */
  argvOn?: string[]
}

export interface LaunchbarConfig {
  version: number
  items: LaunchbarItem[]
}

/** Rust 读取命令返回的结构；config 为 null 时 diagnostics 说明原因。 */
export interface LaunchbarDiagnostic {
  severity: "error" | "warning"
  message: string
}

export interface LaunchbarFile {
  agent: string
  config: LaunchbarConfig | null
  diagnostics: LaunchbarDiagnostic[]
}
