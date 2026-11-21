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
    /** 附加数据，如 `knowledge.addSource` 的 `conflict` 带 `{ path }`。 */
    readonly data?: unknown
  }

  export type Unsubscribe = () => void

  // ───────────── 接入点钩子（宿主调插件）─────────────

  /** `contributes.agent` 的入口脚本默认导出。 */
  export interface AgentHooks {
    /** 启动栏输入 → 该 CLI 的参数。输入已按 launchbar 校验；省略时无参数。 */
    args?(inputs: LaunchInputs): string[] | Promise<string[]>
    /**
     * 只读核对声明与实际（如声明了却没加载的 MCP），用户打开启动清单时按需运行；省略时显示「未验证」。
     * 只能看名字和路径，拿不到密钥；不能启动真实会话或产生费用。
     */
    inspect?(ctx: InspectContext): ReportItem[] | Promise<ReportItem[]>
    /** 专家的原生插件目录本 Agent 能否加载；省略时一律跳过。 */
    isNativePlugin?(dir: string): boolean | Promise<boolean>
    /** 启动 Agent，返回退出码。 */
    launch(ctx: LaunchContext): number | Promise<number>
    /**
     * 群组 ACP 模式（`tool.json` 声明 `contributes.agent.acp: true`）：返回适配器怎么起，进程由群组运行时启动。
     * `ctx.paths.tmp` 活到适配器进程退出。见 docs/agent-contracts.md「群组 ACP 模式」。
     */
    acp?(ctx: LaunchContext): AcpSpec | Promise<AcpSpec>
  }

  export interface AcpSpec {
    /** 适配器命令（不经 shell）。 */
    argv: string[]
    /** 追加给适配器进程的环境。 */
    env?: Record<string, string>
    /** 每次 session/new、load、resume 原样放进 `_meta`。 */
    sessionMeta?: Record<string, unknown>
    /** 能否接收委托（运行时挂 Berth 的 MCP）；缺省 false。 */
    delegation?: boolean
    /** 每个工具调用都先经 session/request_permission；缺省 false。 */
    approvesAllTools?: boolean
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

  /** launch.js 的 `ctx.project`。 */
  export interface ProjectView {
    readonly name: string
    /** 主成员目录（放 `.berth/` 的 checkout）。 */
    readonly home: string
    /** main 与各 worktree，主成员在前。stale：目录不在或已不在 git 列表里；temporary：自动化运行或已结束的群。 */
    readonly checkouts: readonly {
      readonly path: string
      readonly branch: string | null
      readonly main: boolean
      readonly stale: boolean
      readonly temporary: boolean
      /** 在这个检出里跑的 Agent（插件 id 与终端短名）。 */
      readonly agents: readonly {
        readonly agent: string
        readonly terminal: string
      }[]
    }[]
  }

  export interface LaunchContext {
    /** `args(inputs)` 加用户手动追加的参数。 */
    readonly args: string[]
    readonly inputs: LaunchInputs
    readonly expert: Expert | null
    /**
     * 专家的全部资产，按类型分组（没选专家时为空）。skills / mcp / plugins 与 `expert` 同源，
     * 但 plugins 未筛；prompt 是提示词文件（正文在 `expert.prompt`，至多一项）；
     * 其余类型来自专家表开放字段。旧宿主没有这个字段。
     */
    readonly assets: Readonly<Record<string, readonly ExpertAsset[]>>
    /** 选了自定义服务商才有；没有 = 用 Agent 自己的登录。 */
    readonly provider: Provider | null
    /**
     * 启动目录所在项目的成员（同 `berth project . member ls --json`）；不在项目里为 null。
     * 要不要交给 `--add-dir`、参考是否只读、有 Agent 在跑的检出给不给写，由插件决定。
     */
    readonly project: ProjectView | null
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
    /** Agent 原生 hook 应执行的命令：静默、永不失败。 */
    hookCommand(
      event: "session-start" | "turn-start" | "turn-end" | "attention" | "idle"
    ): string
    /** 记录本次启动的计划（进启动清单「计划」一栏）；资产结果用 `report`。 */
    plan(details: Record<string, unknown>): void
    /**
     * 报告每项资产的实际结果，可多次调用；`kind` / `id` 对上 `assets` 的类型和 `name`，没报告的显示为未处理。
     * 也可报告资产之外的项（如隔离的原生目录）。`reason` / `source` 进清单，不要写密钥。旧宿主没有：`ctx.report?.(...)`。
     */
    report(items: readonly ReportItem[]): void
  }

  export interface InspectContext {
    readonly expert: { readonly id: string; readonly name: string } | null
    /** 清单声明的资产，不含 MCP 定义（spec）。 */
    readonly assets: Readonly<Record<string, readonly ExpertAsset[]>>
    readonly paths: {
      readonly package: string
      /** 那次启动的临时目录；会话结束后已不存在。 */
      readonly tmp: string
      readonly cwd: string
      readonly home: string
    }
  }

  export interface ReportItem {
    kind: string
    id: string
    status:
      | "applied"
      | "converted"
      | "skipped"
      | "isolated"
      | "kept"
      | "unknown"
    reason?: string
    source?: string
  }

  export interface ExpertAsset {
    readonly name: string
    readonly path: string
    /** 只有 mcp 有：环境变量已展开的定义。 */
    readonly spec?: unknown
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
    /** 二进制文件（如图片）读成 base64，上限 16 MiB。 */
    readBase64(path: string): Promise<string>
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

  /**
   * files@1 · 两者 · 权限 `project.files`。路径相对项目根，不能越出项目（编辑器页面的根见 `EditorContext.path`）。
   * 页面里目前只有 `readText`、`readBase64`、`open`（`open` 也收绝对路径），其余 reject `unsupported`。
   */
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
    /**
     * 仅脚本：按 url 查知识库「来源」笔记（末尾 `/` 不计），返回绝对路径。不在项目里 reject `not-found`。
     */
    findSource(url: string): Promise<{ path: string } | null>
    /**
     * 仅脚本：写 `.berth/knowledge/来源/<标题>.md`（`type: 来源`、`kind: other`、url、title、added_at、
     * `digested: false`，`meta` 并入，正文是 `markdown`）。同 url 已有时 reject `conflict`，`data.path` 指向它。
     */
    addSource(source: {
      url: string
      title: string
      markdown: string
      meta?: Record<string, unknown>
    }): Promise<{ path: string }>
  }

  /** agent@1 · 两者 · 权限 `agent`。放进当前 Agent 的输入框，用户确认后才发送。 */
  export interface AgentApi {
    attach(item: { label: string; text: string; path?: string }): Promise<void>
  }

  /** 一台设备（可经 SSH 连接的其他机器）。 */
  export interface DeviceInfo {
    id: number
    name: string
    /** 传给 ssh 的目标：`user@host`、域名或 `~/.ssh/config` 的 Host 别名。 */
    target: string
    /** 对方装了 Berth（节点设备）；否则只能开 SSH 终端。 */
    node: boolean
    /** 显示在侧栏的对方项目（主成员在对方的路径）。 */
    shown: string[]
    status: "checking" | "online" | "offline"
    /** 连不上时 ssh 的错误或 `device.*` 错误码。 */
    message: string | null
    /** 因为要密码而连不上：配置免密登录可解决。 */
    keyMissing: boolean
    /** 本机（id 0）：没有 SSH 目标、检查清单与显示开关，不能移除。 */
    local?: true
  }

  /** 检查清单一项（插件自用，`devices/ui/checklist.js`）；`reason.key` 是原因码，文字按语言给出。 */
  export interface DeviceCheckItem {
    id: "ssh" | "key" | "berth" | "version" | "host"
    state: "ok" | "fail" | "pending" | "skipped"
    reason?: { key: string; values?: Record<string, string> }
    /** 原文（ssh 错误、路径、版本号）。 */
    raw?: string | null
  }

  /**
   * devices@1 · 仅页面 · 权限 `devices`。设备管理：增删、检测、挑选显示在侧栏的对方项目、在对方建项目、
   * 开 SSH 终端、配置免密。连接与对方项目 / 终端并入本机由宿主负责。本机是列表里 id 0 的设备。
   */
  export interface DevicesApi {
    /** 全部设备；`selected` 是宿主要求选中的设备（从侧栏设备分组打开面板时）。 */
    list(): Promise<{ devices: DeviceInfo[]; selected: number | null }>
    /** `~/.ssh/config` 里尚未添加的 Host 别名。 */
    candidates(): Promise<string[]>
    /** 先测连接，连得上才保存；失败 reject（`device.*` 错误码或 ssh 原文）。 */
    add(name: string, target: string): Promise<{ id: number }>
    remove(id: number): Promise<void>
    /**
     * 重新检测，返回原始结果：ssh 检测、对方 berth 路径、概览（离线时为缓存）、本机版本、到对方 GUI 的
     * 连线（连上为 open；没连上带原因）。检查清单由插件自己得出。
     */
    inspect(id: number): Promise<{
      check: { ok: boolean; message: string | null }
      berth: string | null
      localVersion: string | null
      line: { open: boolean; error: string | null } | null
      overview: {
        host: string
        os: string
        arch?: string
        version?: string
        /** 对方 GUI 的设备 socket；GUI 没在运行为 null，旧版不报（字段缺失） */
        window?: string | null
        /** GUI 没在运行但能起无界面宿主 */
        hostable?: boolean
        projects: {
          id: number
          name: string
          path: string
          project?: { name: string; main_folder_id: number } | null
        }[]
      } | null
    }>
    /** 「显示在侧栏」开关；返回新的选择。 */
    show(id: number, path: string, shown: boolean): Promise<string[]>
    /** 浏览对方目录（限对方家目录之内）；`path` 省略为家目录。 */
    dirs(
      id: number,
      path?: string | null
    ): Promise<{ path: string; dirs: string[] }>
    /** 在对方 Berth 里登记项目（不挂载）；本机（id 0）不传 `path`，弹目录选择框，取消为 null。 */
    addProject(
      id: number,
      path?: string
    ): Promise<{ id?: number; name: string } | null>
    openTerminal(id: number): Promise<void>
    /** 开终端跑 ssh-copy-id：已添加的传 id，添加前传 SSH 目标。 */
    setupKey(device: number | string): Promise<void>
    onChange(listener: () => void): () => void
    onSelect(listener: (id: number) => void): () => void
  }

  /** storage@1 · 两者 · 无需权限。插件自己的键值数据。 */
  export interface StorageApi {
    get<T = unknown>(key: string): Promise<T | undefined>
    set(key: string, value: unknown): Promise<void>
    remove(key: string): Promise<void>
    /** 插件数据目录（`$BERTH_HOME/state/<id>/`，第一次写入时创建）；仅脚本环境有值。 */
    readonly dir: string | null
  }

  export interface HttpRequestOptions {
    method?: string
    headers?: Record<string, string>
    body?: string
    /** 单次尝试的超时，默认 30000。 */
    timeoutMs?: number
    /**
     * 连接错误 / 超时 / 429 / 5xx 时由宿主退避重试（500 ms 起翻倍，遵守 Retry-After，单次等待不超过
     * `maxWaitMs`，默认 10000）。`attempts` 含首次，默认 1（不重试）。次数用完仍是 429 / 5xx 就返回该响应。
     */
    retry?: { attempts: number; maxWaitMs?: number }
  }

  export interface HttpResponse {
    status: number
    headers: Record<string, string>
    text: string
  }

  /** http@1 · 脚本 · 权限 `network`。运行被取消时进行中的请求 reject `cancelled`。 */
  export interface HttpApi {
    fetch(url: string, options?: HttpRequestOptions): Promise<HttpResponse>
    /** 并发发出、按原顺序返回；单项失败只体现在该项，不整体 reject（取消除外）。 */
    fetchAll(
      requests: Array<HttpRequestOptions & { url: string }>
    ): Promise<
      Array<HttpResponse | { error: { reason: ErrorReason; message: string } }>
    >
  }

  /**
   * editor@1 · 两者 · 无需权限（`render` 写文件，要 `fs`）。本插件编辑器在 Berth 窗口里的能力：
   * `render` 请窗口用本插件 `embed` 编辑器的页面（`onRender`）把文件渲染成图片写到 `out`。
   * 只在 `berth tools run|call` 里可用，要求 Berth 开着；路径为绝对路径或 `~` 开头。
   */
  export interface EditorApi {
    /** 仅页面：同插件、同项目当前可编辑文件；未打开则 null，path 相对项目根。 */
    active(): Promise<{ path: string } | null>
    /** 仅侧栏页面：调用当前编辑器的 onRequest；切换文件、只读或关闭后 reject。 */
    request<T = unknown>(
      path: string,
      method: string,
      input?: unknown
    ): Promise<T>
    /** 仅页面：当前文件或其插件状态变化；重新 active / request 取数据。 */
    onChange(listener: () => void): Unsubscribe
    render(
      path: string,
      options: { out: string; format?: string }
    ): Promise<{ out: string; mime: string; bytes: number }>
  }

  /** scripts@1 · 页面 · 无需权限。运行本包脚本，返回它默认导出函数的返回值。 */
  export interface ScriptsApi {
    /** `signal` abort 时立即 reject `cancelled`，宿主中断脚本与进行中的 http 请求。 */
    run<T = unknown>(
      script: string,
      input?: unknown,
      options?: { signal?: AbortSignal }
    ): Promise<T>
  }

  /**
   * ui@1 · 页面 · 无需权限。颜色用 `var(--berth-*)` CSS 变量即与宿主主题一致（`--berth-background`、
   * `--berth-foreground`、`--berth-primary`、`--berth-border`、`--berth-font-sans` …）；暗色时 `<html>` 带 `dark` 类。
   */
  export interface UiApi {
    /** 侧栏页面把页签交给宿主顶栏渲染；value 必须属于 tabs。 */
    setHeaderTabs(
      tabs: { id: string; label: string }[],
      value: string
    ): Promise<void>
    onHeaderTab(listener: (id: string) => void): Unsubscribe
    theme(): Promise<"light" | "dark">
    onTheme(listener: (theme: "light" | "dark") => void): Unsubscribe
    notify(message: string, kind?: "info" | "error"): Promise<void>
    /** 用系统浏览器打开 http(s) / mailto 链接。 */
    openUrl(url: string): Promise<void>
    /** 界面语言（`zh-CN`、`en`）。 */
    readonly locale: string
    /** 本页面是哪个入口打开的；`berth.ready` 之后才有值。 */
    readonly context: ViewContext | EditorContext
  }

  export interface ViewContext {
    readonly kind: "view"
    readonly id: string
    readonly params: Readonly<Record<string, string>>
    /** 侧栏页面：从文件树拖进来，`path` 相对当前项目根（根外是绝对路径）。 */
    onDrop?(
      listener: (item: {
        name: string
        kind: "file" | "dir"
        path: string
        x: number
        y: number
      }) => void
    ): Unsubscribe
  }

  /**
   * 编辑器（§4.2）：宿主负责读写、保存、脏标记、自动保存、Ctrl/⌘+S、外部修改；插件只管内容。
   * `load()` 取内容 → 编辑时 `change(新内容)` → 宿主保存；外部改写时触发 `onExternalChange`。
   * 防抖攒着的改动在 `onFlush` 里交出（宿主转发快捷键、失焦、隐藏前调用）。
   * `mode: "embed"` 是 `embed: true` 的编辑器为 Markdown 嵌入开的隐藏页面：不画界面，只在 `onRender` 里出图。
   */
  export interface EditorContext {
    readonly kind: "editor"
    readonly id: string
    readonly mode: "edit" | "embed"
    /** 文件相对 `files.*` 根的路径（根是所在项目，不在项目里时是文件所在目录）。 */
    readonly path: string
    readonly readOnly: boolean
    /** 打开时的内容；之后以 `load()` / `onExternalChange` 为准。 */
    readonly content: string
    load(): Promise<string>
    change(content: string): void
    onExternalChange(listener: (content: string) => void): Unsubscribe
    onFlush(flush: () => void): Unsubscribe
    /** 响应本插件侧栏的语义请求；方法和数据由插件自己定义。 */
    onRequest(
      handler: (method: string, input: unknown) => unknown | Promise<unknown>
    ): Unsubscribe
    /** 通知本插件侧栏重读状态（例如选区、版本变化）。 */
    notify(): void
    /** 从文件树拖进来：`path` 相对根（根外是绝对路径），`x` / `y` 是页面视口坐标。 */
    onDrop(
      listener: (item: {
        name: string
        kind: "file" | "dir"
        path: string
        x: number
        y: number
      }) => void
    ): Unsubscribe
    /**
     * `embed` 模式：把文件渲染成图片 data URL（null = 空）。`format` 来自脚本的
     * `berth.editor.render`（如 `"png"`），这时要返回 base64 data URL；Markdown 嵌入不带它。
     */
    onRender(
      render: (input: {
        path: string
        content: string
        theme: "light" | "dark"
        format?: string
      }) => Promise<string | null> | string | null
    ): Unsubscribe
  }

  /** env@1 · 两者 · 无需权限 */
  export interface EnvApi {
    readonly platform: "linux" | "darwin" | "windows"
    readonly berthVersion: string
    /** 进程环境变量（只读快照）；仅脚本环境有内容。 */
    readonly vars: Readonly<Record<string, string>>
    project(): Promise<{ id: string; name: string; root: string } | null>
    /**
     * 调用方 Agent：脚本由 Berth 启动的 Agent 经 `berth tools run|call` 调用时为 `{ id, expert? }`；
     * 页面、用户自己在终端跑时为 null。
     */
    agent(): Promise<{ id: string; expert?: string } | null>
  }

  /** data@1 · 脚本 · 无需权限 */
  export interface DataApi {
    parseToml(text: string): Promise<Record<string, unknown>>
    stringifyToml(value: Record<string, unknown>): Promise<string>
  }

  export interface Berth {
    /** 仅页面：宿主送来上下文、主题之后 resolve；读 `ui.context` / `ui.locale` 前先 await。 */
    readonly ready?: Promise<void>
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
    readonly editor: EditorApi
    readonly devices: DevicesApi
  }
}

/** 脚本里是全局 `berth`，页面里是 `window.berth`。不可用的命名空间调用时 reject `unsupported`。 */
declare const berth: import("berth").Berth
