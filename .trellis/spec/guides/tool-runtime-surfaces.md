# Tool Runtime Surface Contract

## 1. Scope / Trigger

修改 `tool.json` 接入点、CLI tools 命令、启动栏表单、工具结果展示、
terminal SDK/daemon 或 CLI↔GUI control 前阅读。目标是让 shell、Agent 与 GUI 使用
同一能力语义，同时保持 GUI 是可选工作台而不是 CLI 的运行前提。

## 2. Public Seams

唯一持久化事实是 `$BERTH_HOME/tools/<id>/tool.json`（默认
`~/.berth/tools/<id>/tool.json`）。插件只经接入点（`docs/contribution-points.md`）被宿主读取；
Berth 不执行插件声明的命令（`actions` 已于 2026-10-03 退役）：Agent 直接调用程序本身，
Agent 启动只认 `launch.py`。

纯 Rust 核心拥有解析；CLI 与薄 Tauri adapter 只转换各自边界。Tauri command
的具体名字不是本规范预留项：出现真实 GUI 调用方时，须按项目 Command 红线证明并复用
现有 operation seam。终端统一经 `berth-term-sdk`；桌面专属动作统一经
`berth-control-proto`。

## 3. Contracts

| 层 | 拥有 | 不拥有 |
|---|---|---|
| Tool core / 领域 service | 资产投影、接入点解析、包检查 | Tauri、React、clap、桌面生命周期 |
| CLI | argv/stdin、JSON envelope、退出码、attach | GUI 表单、第二套 parser |
| Tauri adapter | frontend transport 到领域 service 的薄映射 | 通过 CLI 子进程复用业务逻辑 |
| GUI | 主线所需表单与结果投影 | 任意工具的通用操作台、终端流解析 |
| termd | session/window/pane、PTY、流状态 | Tool Asset 业务语义 |
| GUI control | 文件/项目/窗口等桌面专属 typed RPC | headless 工具发现、GUI 内部自调用 |

GUI control 返回有界正文时，帧预算按序列化后的完整 JSON 字节计算（包括转义、信封和请求 ID），不能只限制原文长度；高转义内容超限须返回带原请求 ID 的有界错误，而非断开连接。用含引号、反斜杠等内容覆盖该边界。

工作区文档读取来自单份 GUI 已提交缓冲，不回退磁盘。offset/snapshot_ref 通过现有方法的 range capability 协商；旧 provider 不支持时明确拒绝，不能忽略参数。快照作用域须区分重启，版本比较与片段读取处于同一次锁定状态；输入截断仍保留源行范围，不伪造可续读位置。打开/定位的完成回执使用实际 Viewer 路径/行，不能复制请求值或以清队列当成功；`send` 接受输入也不等于 shell 命令执行成功。

- 应用级 open listener 必须先完成事件订阅，再 claim 待处理请求。普通 scope 或动作引用变化不得触发 cleanup 取消自己的在途展示；跨项目 open 激活目标文件所属 scope，不用 global/pin 绕过真实可见性。
- CLI 在成功输出前独立核验回执：实际路径必须绝对、有界、无 NUL，且与请求原路径相同或 canonical 等价；带行请求还须核对实际行。不能只相信 provider 的 `opened` 状态，路径/行不符是明确的定位未确认，不自动重发。
- 新 session 与已有 session 的新 window 均须显式投影同一宿主实例环境；即使调用方未设置 `BERTH_DATA_FILE`，也传递实际解析的库名，不能沿用 daemon 旧值。保留非保留 caller 变量，仅将真实存在的 `berth` 命令目录前置 PATH，不以 `berth-cli` 侧车名冒充命令，不修改用户全局 shell。

终端 pane 寻址按**实体身份**而非槽位：`window_index` / `pane_index` 只是首次解析线索，
运行期操作必须按 `RuntimeBinding`（daemon instance epoch + session + `PaneId` + generation）
经 SDK `verify` 判定后寻址（`src-tauri/src/terminal/binding.rs` 是 adapter 唯一入口）。
失效绑定（当前 daemon 提供 epoch 而捕获 epoch 缺失/不一致、pane 已消失或进程重生）必须确定性报
`terminal_instance_expired`，**不得**回落槽位重解析；而「无法确认」（对端 daemon 不携带
epoch，即旧 daemon）是**降级寻址**而非失效：仍按捕获的 pane id 操作，存在性由 daemon 判定，
否则新版客户端 + 旧 daemon 的组合会让所有终端直接不可用。策略只表述一次
（SDK `BindingVerdict::allows_pane_address()`），GUI 与 CLI 共用，不在 Rust 或 React 侧另写
第二套身份。

库存发现可在单次调用内复用 session/window 父元数据，不得把它变成长寿命缓存或第二库存。已知 PaneId 时可以消除重复列表查询，但详情响应仍须匹配该实体，generation 从同次详情捕获；槽位被替换/身份缺失要明确拒绝。用合成协议统计请求数、验证下次调用重新查询和实体替换，再以真实 CLI 端到端样本验证提速，不把少一次 RPC 等同于性能达标。

窗口级操作（resize）按**窗口**寻址，且窗口槽位必须由 pane id 实时解析
（`binding.rs::bound_pane`），不得复用扫描时的旧槽位。pane 尺寸 ≠ 窗口尺寸：单 pane 窗口的
绝对 pane 尺寸只写入主 pane 布局偏好，窗口尺寸才是 PTY 几何（`berth-term-engine`
`explicit_main_width_set_on_a_single_pane_is_used_after_a_future_split`）——按 pane 尺寸
resize 会让 GUI 网格与 PTY 几何静默不一致。

桌面 Agent 启动是另一条冻结缝：GUI 读 `tools/<id>/launchbar.json`，提交 typed
inputs，终端 exec `launch.py --berth-launch-inputs`。不走 tool.json emit，不按
Agent 品牌拼 argv。新增静态启动栏项只改资产目录。

人类 stdout、ANSI 和 TUI 屏幕不是结构化 GUI API。

## 4. Validation / Error Matrix

| 场景 | 必须行为 |
|---|---|
| GUI 未运行，tools list/show/check | 正常完成，不启动 GUI |
| tool.json 带退役键或未知接入声明 | `tools check` / 设置页诊断报出，宿主不读 |
| control 超时 | 返回 outcome-unknown 或协议错误，不盲目重复桌面副作用 |
| GUI 内收到 control 请求 | 直接调用内部 service，不再启动 CLI |

## 5. Good / Base / Bad Cases

- Good：Agent 直接调用 `gh`、`officecli` 等程序，用法看 `berth tools show <id>`（包内
  usage.md）；GUI 启动栏提交 launchbar 选择值，桌面启动 exec `launch.py`，会话落在同一 termd。
- Base：一次性 `rg`/`git status` 直接用原生命令；插件只在接入宿主某个位置时才有价值。
- Bad：把 CLI 子命令转写成 tool.json 声明，从 stdout 正则提取树/表，或 GUI 启动 `berth`
  子进程后 CLI 再回调 GUI。

## 6. Tests Required

- core/CLI/Tauri：同一 tool.json 的接入点投影（`package::contributions`）在 CLI 与设置页一致。
- CLI：机器 JSON 与退出码、headless 不拉 GUI、desktop unavailable。
- terminal：CLI 与 GUI 创建/发现同一 sessionRef，关闭调用端不杀 daemon 会话。
- frontend：typed input 提交、unsupported 控件禁用与诊断、terminal/artifact/fallback
  分流；不测试不存在的通用工具面板。
- 资产：未知字段保留；退役键与未知接入声明由 `tools check` 报出。

只运行受改动影响的过滤测试与 `git diff --check`，遵守项目资源限制。

## 7. Wrong vs Correct

Wrong：

```ts
spawn("berth", ["tools", "show", toolId, "--json"])
```

Correct：

```text
frontend transport → thin Tauri adapter → shared Rust service
```

Wrong：GUI 解析 `rg`/`tree` 的彩色 stdout 生成组件树。

Correct：输出进入 Terminal/纯文本；需要专门视图时先定义并复用稳定 typed capability
结果，再增加一个通用 renderer。
