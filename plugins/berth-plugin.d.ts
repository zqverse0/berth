/**
 * Berth 插件接口（类型）。架构与兼容性规则见 `docs/plugin-architecture.md`。
 *
 * 草稿：命名空间的 schema（`plugins/api/*.schema.json`）落地后，本文件由它生成，不再手写。
 *
 * 每个 `berth.<命名空间>.<方法>` 都是一条 JSON-RPC 请求 `<命名空间>.<方法>` 的包装，
 * 脚本（QuickJS）与页面（iframe）同一份签名，全部返回 Promise；失败 reject {@link BerthError}。
 * 插件在 tool.json `requires` 声明用到的命名空间与主版本，`permissions` 声明权限。
 *
 * Agent 插件的 `launch.js`：
 *
 * ```js
 * // @ts-check
 * /// <reference path="../berth-plugin.d.ts" />
 * /** @type {import("berth").AgentHooks} *\/
 * export default {
 *   args: (inputs) => (inputs.mode ? ["--chat-mode", String(inputs.mode)] : []),
 *   launch: (ctx) => berth.process.run("aider", ctx.args),
 * }
 * ```
 */

declare module "berth" {
  // ───────────── 公共 ─────────────

  export type ErrorReason =
    | "invalid-params"
    | "denied"
    | "not-found"
    | "conflict"
    | "unsupported"
    | "cancelled"
    | "internal"

  export interface BerthError extends Error {
    readonly reason: ErrorReason
  }

  export type Unsubscribe = () => void

  // ───────────── 接入点钩子（宿主调插件）─────────────

  /** `contributes.agent` 的入口脚本默认导出。 */
  export interface AgentHooks {
    /** 启动栏输入 → 该 CLI 的参数。输入已按 launchbar 校验；省略时无参数。 */
    args?(inputs: LaunchInputs): string[] | Promise<string[]>
    /** 专家的原生插件目录本 Agent 能否加载；省略时一律跳过。 */
    isNativePlugin?(dir: string): boolean | Promise<boolean>
    /** 启动 Agent，返回退出码。 */
    launch(ctx: LaunchContext): number | Promise<number>
  }

  /** `contributes.command` 的脚本默认导出。 */
  export interface CommandHooks {
    run(params: Readonly<Record<string, string>>): void | Promise<void>
  }

  /** `contributes.view` 第 1 层 `script` 的默认导出：返回视图数据，宿主用原生组件渲染。 */
  export interface ViewHooks {
    render(req: ViewRequest): ViewResult | Promise<ViewResult>
  }

  export interface ViewRequest {
    readonly view: string
    /** `open-view` 动作带来的参数。 */
    readonly params: Readonly<Record<string, string>>
    /** 当前选中的筛选项 id；没选过（或视图没有 `filters`）为 null，按第一个渲染。 */
    readonly filter: string | null
    /** 当前选中的下拉项 id；没选过为 null，按第一个渲染。 */
    readonly dropdown: string | null
    /** 界面语言，如 `zh-CN`、`en`。 */
    readonly locale: string
    /** 用户点了刷新：插件应绕过自己的缓存。 */
    readonly refresh: boolean
  }

  export type ViewResult = ListView | DetailView

  export interface ListView {
    type: "list"
    /** 顶栏分段筛选；选中项 id 进下一次 `render` 的 `req.filter`。 */
    filters?: { id: string; title: string }[]
    /** 正文顶部的下拉选择；选中项 id 进 `req.dropdown`。 */
    dropdown?: { items: { id: string; title: string }[] }
    /** 下拉旁的一行小字（如更新时间）。 */
    note?: string
    /** 宿主按 title / subtitle 本地筛选。 */
    searchable?: boolean
    items: ListItem[]
    /** 没有条目时显示的文字。 */
    empty?: string
  }

  export interface ListItem {
    id: string
    title: string
    subtitle?: string
    /** https 地址或包内路径。 */
    icon?: string
    /** 行下方的短信息，如星标数、语言。 */
    accessories?: { text: string; icon?: ViewIcon; tooltip?: string }[]
    /** 点击行执行第一个；带 `inline` 的画成行尾按钮，其余进「…」菜单。 */
    actions?: ViewAction[]
  }

  export interface DetailView {
    type: "detail"
    title?: string
    markdown: string
    actions?: ViewAction[]
  }

  /** 宿主的固定图标名（只增不改），由宿主画、随主题。 */
  export type ViewIcon =
    | "star"
    | "star-filled"
    | "fork"
    | "external-link"
    | "copy"
    | "book"
    | "download"
    | "folder-input"
    | "link"
    | "send"

  /** 每个动作的公共字段。 */
  interface ViewActionBase {
    title: string
    icon?: ViewIcon
    /** 画成行尾图标按钮：`hover` 悬停时出现，`always` 常驻。 */
    inline?: "hover" | "always"
  }

  export type ViewAction = ViewActionBase &
    (
      | { type: "open-url"; url: string }
      | {
          type: "open-view"
          view: string
          params?: Record<string, string>
        }
      | {
          type: "script"
          /** 包内脚本，默认导出函数收 `input`。 */
          script: string
          input?: unknown
          /** 完成后重新渲染当前视图。 */
          refresh?: boolean
        }
      | { type: "copy"; text: string }
      /** Berth 的 Git 账号 clone 到记住的目录（或先选），完成后作为项目打开。 */
      | { type: "clone"; url: string; pickDirectory?: boolean }
      /** 放进当前 Agent 的输入框（不提交）；菜单文字由宿主给。 */
      | { type: "send-to-agent"; text: string }
    )

  export type LaunchInputs = Readonly<Record<string, string | number | boolean>>

  export interface LaunchContext {
    /** `args(inputs)` 加用户手动追加的参数。 */
    readonly args: string[]
    readonly inputs: LaunchInputs
    readonly expert: Expert | null
    /** 选了自定义服务商才有；没有 = 用 Agent 自己的登录。 */
    readonly provider: Provider | null
    /** Berth 能力索引，追加进系统提示词；取不到为空串。 */
    readonly brief: string
    /** 无人值守（定时任务）：没人能点确认框。 */
    readonly unattended: boolean
    readonly paths: {
      /** 插件包目录（只读）。 */
      readonly package: string
      /** 本次启动的临时目录（0700，launch 结束后宿主删除）。 */
      readonly tmp: string
      readonly cwd: string
      readonly home: string
    }
    /**
     * 远程项目（命令要在设备上执行）时有值，本地项目为 null。插件只需二选一接线：
     * 把 `hookCommand` 挂到 Agent 的 shell 工具 PreToolUse 类 hook（stdin 为 hook JSON，按需输出
     * `hookSpecificOutput.updatedInput`），或用 `execCommand` + `--cwd <目录> -- <命令>` 自己执行。
     */
    readonly remote: {
      readonly target: string
      readonly hookCommand: string
      readonly execCommand: readonly string[]
    } | null
    /** Agent 原生 hook 应执行的命令：静默、永不失败。 */
    hookCommand(
      event: "session-start" | "turn-start" | "turn-end" | "attention" | "idle"
    ): string
    /** 记录本次启动用了哪些资产（stderr，供排查）。 */
    plan(details: Record<string, unknown>): void
  }

  export interface Expert {
    readonly id: string
    readonly name: string
    readonly prompt: string | null
    readonly skills: readonly Asset[]
    /** MCP 服务器定义，环境变量已展开。 */
    readonly mcp: Readonly<Record<string, unknown>>
    /** 已按 isNativePlugin 筛过。 */
    readonly plugins: readonly Asset[]
  }

  export interface Asset {
    readonly name: string
    readonly path: string
  }

  export interface Provider {
    readonly name: string
    readonly model: string | null
    /** 选中模型在最前；已滤掉和本 Agent 没有共同接口的模型。 */
    readonly models: readonly ProviderModel[]
    /** 按偏好取第一个可用端点；都没有时抛错，宿主转成启动前报错。 */
    endpoint(...protocols: string[]): {
      readonly baseUrl: string
      readonly apiKey: string
    }
  }

  export interface ProviderModel {
    readonly id: string
    readonly name: string
    /** 档位，小写；没有为空串。 */
    readonly slot: string
    /** `openai-chat` / `openai-responses` / `anthropic` / `gemini`。 */
    readonly api: string
    /** 该模型走的端点协议（`endpoint()` 的参数）；没有为空串。 */
    readonly endpoint: string
    /** token；0 = 未设。 */
    readonly contextWindow: number
    readonly maxOutput: number
  }

  // ───────────── 命名空间（插件调宿主）─────────────

  export interface RunOptions {
    env?: Record<string, string>
    cwd?: string
  }

  /** process@1 · 脚本 · 权限 `process` */
  export interface ProcessApi {
    /** 交互运行（继承终端），等结束，返回退出码。 */
    run(cmd: string, args: string[], options?: RunOptions): Promise<number>
    /** 捕获输出运行；超时结束进程，code 为 null。 */
    exec(
      cmd: string,
      args: string[],
      options?: RunOptions & { stdin?: string; timeoutMs?: number }
    ): Promise<{ code: number | null; stdout: string; stderr: string }>
    /**
     * 启动一个常驻程序并逐行对话（如 stdio JSON-RPC 服务）：stdin 一直开着，stdout 按行读。
     * 不读 stderr。脚本结束时宿主结束所有未关闭的会话。
     */
    open(
      cmd: string,
      args: string[],
      options?: RunOptions
    ): Promise<ProcessSession>
    which(cmd: string): Promise<string | null>
    readonly pid: number
    alive(pid: number): Promise<boolean>
    /** 读完整个 stdin（由 Agent 调起的包内脚本，如状态栏命令）。 */
    stdin(): Promise<string>
  }

  export interface ProcessSession {
    write(text: string): Promise<void>
    /** 下一行 stdout（不含换行）；超时（默认 30 秒）或程序已退出为 null。 */
    readLine(options?: { timeoutMs?: number }): Promise<string | null>
    /** 结束程序。 */
    close(): Promise<void>
  }

  /** fs@1 · 脚本 · 权限 `fs`。路径为绝对路径或 `~` 开头。 */
  export interface FsApi {
    /** `tailBytes`：只读末尾这么多字节（大日志），切断的字符按替换符解码。 */
    readText(path: string, options?: { tailBytes?: number }): Promise<string>
    /** 原子写；父目录不存在时创建；mode 默认 0o644。 */
    writeText(
      path: string,
      text: string,
      options?: { mode?: number }
    ): Promise<void>
    stat(
      path: string
    ): Promise<{ kind: "file" | "dir"; size: number; mtimeMs: number } | null>
    list(dir: string): Promise<string[]>
    /** 递归创建；`mode` 只作用于最后一级。 */
    mkdir(dir: string, options?: { mode?: number }): Promise<void>
    /** 删除文件或目录；不存在不报错。 */
    remove(path: string): Promise<void>
    symlink(target: string, link: string): Promise<void>
    copy(from: string, to: string): Promise<void>
    rename(from: string, to: string): Promise<void>
    /** 展开 `~`、解析符号链接。 */
    resolve(path: string): Promise<string>
  }

  /** files@1 · 两者 · 权限 `project.files`。路径相对项目根，不能越出项目。 */
  export interface FilesApi {
    readText(path: string): Promise<string>
    readBase64(path: string): Promise<string>
    writeText(path: string, text: string): Promise<void>
    list(dir: string): Promise<Array<{ name: string; dir: boolean }>>
    /** 外部修改、Agent 写入都会触发。 */
    watch(path: string, onChange: () => void): Unsubscribe
    /** 在工作区打开（交给对应的查看器 / 编辑器）。 */
    open(path: string): Promise<void>
  }

  export interface TaskSummary {
    readonly id: string
    readonly title: string
    readonly status: string
    readonly currentStep: string | null
  }

  export interface TaskDetail extends TaskSummary {
    readonly body: string
    readonly steps: ReadonlyArray<{
      readonly id: string
      readonly text: string
      readonly done: boolean
    }>
  }

  /** tasks@1 · 两者 · 权限 `tasks`。与任务页、`berth task` 同一份数据。 */
  export interface TasksApi {
    list(): Promise<TaskSummary[]>
    get(id: string): Promise<TaskDetail>
    create(input: {
      title: string
      slug?: string
      description?: string
    }): Promise<TaskSummary>
    open(id: string): Promise<void>
  }

  /** knowledge@1 · 两者 · 权限 `knowledge` */
  export interface KnowledgeApi {
    search(
      query: string
    ): Promise<Array<{ title: string; path: string; excerpt: string }>>
    addIdea(text: string): Promise<{ id: string }>
  }

  /** agent@1 · 两者 · 权限 `agent`。放进当前 Agent 的输入框，用户确认后才发送。 */
  export interface AgentApi {
    attach(item: { label: string; text: string; path?: string }): Promise<void>
  }

  /** storage@1 · 两者 · 无需权限。插件自己的键值数据。 */
  export interface StorageApi {
    get<T = unknown>(key: string): Promise<T | undefined>
    set(key: string, value: unknown): Promise<void>
    remove(key: string): Promise<void>
    /** 插件数据目录（`$BERTH_HOME/state/<id>/`，第一次写入时创建）；仅脚本环境有值。 */
    readonly dir: string | null
  }

  /** http@1 · 脚本 · 权限 `network` */
  export interface HttpApi {
    fetch(
      url: string,
      options?: {
        method?: string
        headers?: Record<string, string>
        body?: string
        timeoutMs?: number
      }
    ): Promise<{
      status: number
      headers: Record<string, string>
      text: string
    }>
  }

  /** scripts@1 · 页面 · 无需权限。运行本包脚本，返回它默认导出函数的返回值。 */
  export interface ScriptsApi {
    run<T = unknown>(script: string, input?: unknown): Promise<T>
  }

  /** ui@1 · 页面 · 无需权限。颜色用 `var(--berth-*)` CSS 变量即与宿主主题一致。 */
  export interface UiApi {
    theme(): Promise<"light" | "dark">
    onTheme(listener: (theme: "light" | "dark") => void): Unsubscribe
    notify(message: string, kind?: "info" | "error"): Promise<void>
    setTitle(title: string): Promise<void>
    /** 打开本插件的另一个 view。 */
    openView(id: string, params?: Record<string, string>): Promise<void>
    /** 本页面是哪个入口打开的。 */
    readonly context: ViewContext | EditorContext
  }

  export interface ViewContext {
    readonly kind: "view"
    readonly id: string
    readonly params: Readonly<Record<string, string>>
  }

  /**
   * 编辑器：宿主负责读写、保存、脏标记、外部修改冲突；插件只管内容。
   * `load()` 取内容 → 编辑时 `change(新内容)` → 宿主保存；外部改写时触发 `onExternalChange`。
   */
  export interface EditorContext {
    readonly kind: "editor"
    readonly id: string
    readonly path: string
    readonly readOnly: boolean
    load(): Promise<string>
    change(content: string): void
    onExternalChange(listener: (content: string) => void): Unsubscribe
  }

  /** env@1 · 两者 · 无需权限 */
  export interface EnvApi {
    readonly platform: "linux" | "darwin" | "windows"
    readonly berthVersion: string
    /** 进程环境变量（只读快照）；仅脚本环境有内容。 */
    readonly vars: Readonly<Record<string, string>>
    project(): Promise<{ id: string; name: string; root: string } | null>
  }

  /** data@1 · 脚本 · 无需权限 */
  export interface DataApi {
    parseToml(text: string): Promise<Record<string, unknown>>
    stringifyToml(value: Record<string, unknown>): Promise<string>
  }

  export interface Berth {
    readonly process: ProcessApi
    readonly fs: FsApi
    readonly files: FilesApi
    readonly tasks: TasksApi
    readonly knowledge: KnowledgeApi
    readonly agent: AgentApi
    readonly storage: StorageApi
    readonly scripts: ScriptsApi
    readonly ui: UiApi
    readonly env: EnvApi
    readonly data: DataApi
    readonly http: HttpApi
  }
}

/** 脚本里是全局 `berth`，页面里是 `window.berth`。不可用的命名空间调用时 reject `unsupported`。 */
declare const berth: import("berth").Berth
