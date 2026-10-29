# 检查与验证参考

> 本文是 `AGENTS.md` 的配套参考。**核心纪律写在 `AGENTS.md` 红线里**，
> 本文只提供命令细节与原理说明。
>
> 本文所有命令都是**按需执行**，不是每次任务的必跑清单。

---

## 核心判据：快 vs 慢

允许与禁止的分界不是「测试 vs 格式检查」，而是**单次执行的耗时与内存开销**。

| ✅ 允许（快、省内存） | ❌ 禁止（慢、易 OOM） |
|---|---|
| 单文件 / 单目录 Vitest | 全量 `pnpm test` |
| 目标文件 `eslint` / `prettier` | 全仓库 `pnpm lint` |
| `git diff --check`、只读探查 | `pnpm build`（静态导出） |
| 小 crate 的过滤测试（`-p berth-cli` 等） | 对 `berth-gui` / workspace 跑任何 `cargo check\|test\|build`（过滤名不减少编译量） |
| 读 dev 终端输出判断编译结果 | 与 dev 编译、或彼此**并行**跑 cargo / 全项目 `tsc` |
| — | `pnpm tauri build` |

**dev 进程归用户**：`pnpm tauri dev --features debug-bridge` 由用户常驻；Agent 复用它的编译结果与运行时，
不另起、不杀，也不用 `cargo build` 代替。

### 用 dev 终端验证 Rust 编译（首选，零额外内存）

`tauri dev` 监听 `src-tauri/`，保存后自动重编。改完 Rust 后：

```bash
berth terminal ls                          # 找到跑 tauri dev 的终端，如 berth-dev:1
berth terminal capture -t berth-dev:1 --lines 60   # 看最新输出：error[...] 还是 Finished / Running
stat -c %y ~/.cargo/target-shared/debug/berth-gui   # 二进制时间晚于改动 = 已重编成功
```

为什么不自己 `cargo test -p berth-gui --lib <filter>`：测试用 `cfg(test)` 与不同 feature 编译，
dev 的产物不能复用，会把最大的 `berth_lib` 重新编译并链接一个测试二进制；过滤名只决定运行哪些测试。

---

## 试合并：worktree 分支在 dev 实例里验证（`scripts/dev-trial`）

多个 Agent 各占一个 worktree 并行开发时，**只有主 checkout（用户跑 `pnpm tauri dev` 的那份）编译和运行**。
worktree 没有 `node_modules` / `target`，也不该有：cargo 用全局共享的 `~/.cargo/target-shared`，
worktree 里跑 cargo 会和 dev 抢构建锁、互相覆盖产物。

worktree 里允许：`git diff --check`、纯 Python 的 pytest，以及小 crate 检查
`scripts/dev-trial cargo check -p <crate>` / `scripts/dev-trial cargo test -p <crate> <过滤>`
（berth-cli、berth-project-core、berth-tool-core 等）。它全局串行（`berth lock build`），并用**独立 target 目录**
（`~/.cache/berth-worktree-target`）：直接 `cargo` 会和 tauri dev 共用 `target-shared`，两边环境变量不同，
build script 互相判过期，dev 实例被迫全量重编（2026-10-04 实测）。
禁止：对 berth-gui / workspace 的任何 cargo、pnpm install / build / vitest / tsc、`scripts/init-worktree.sh`。

验证流程（每个步骤 S<n> 一次，不攒到整个任务做完）：

```bash
git rebase $(scripts/dev-trial base)   # 只 rebase 到稳定基线；试合并进行中 dev 的 HEAD 是未确认的合并提交
scripts/dev-trial start <分支>          # 排队拿全局锁 → merge --no-ff 进 dev → 有 CLI 改动则构建 sidecar → 等 GUI 重编
#   在 dev 实例里验证：tauri-browser（见下文）、dev 版 CLI、主 checkout 里的单文件 vitest
scripts/dev-trial berth <参数...>       # 调 dev 实例的 CLI（自动清掉继承自正式版的 BERTH_* 环境）
scripts/dev-trial keep <分支>           # 通过：保留合并，释放锁，向用户汇报等验收
scripts/dev-trial rollback <分支>       # 失败：reset --keep 回到合并前（分支提交不丢），回 worktree 修
scripts/dev-trial status                # 当前试合并状态
```

- 同一时刻只有一个试合并；`start` 会排队，30 分钟（`DEV_TRIAL_TIMEOUT`）内不 keep 自动回退。
- 合并失败（与主 checkout 未提交改动重叠、或与刚合入的改动冲突）不改 dev，提示回 worktree rebase。
- CLI（`src-tauri/terminal/cli/`）改动由试合并在锁内跑 `pnpm tauri:prepare-sidecars`，构建失败自动回退。
- **keep 之后用户验收不通过：向前修复**（补提交再试合并），不回退——其他人可能已合并在其上。
- **数据库迁移、`.berth/local` 格式迁移回退不干净**：试合并前先备份 `~/.berth-dev/` 与主项目 `.berth/local/`，并告诉用户。
- 持锁进程被强杀时锁不会自动释放：`berth lock dev-trial --release`。

---

## 快速局部检查

### 前端

```bash
# 单目录 / 单文件测试 —— 改哪测哪
pnpm vitest run src/lib/perf/
pnpm vitest run src/lib/workbench/resolve.test.ts

# 目标文件 lint —— 只查改动的文件
pnpm exec eslint src/lib/transport/index.ts

# 改动语法自检
git diff --check
```

### Rust

`berth-gui`（`berth_lib`）的测试只在用户明确要求时跑，且不与 dev 编译同时进行。

```bash
# 小 crate：日常可跑
CARGO_BUILD_JOBS=4 cargo test -p berth-cli <filter>

# berth_lib 单个过滤测试（需用户同意；共享核心路径，不链接 Tauri）
CARGO_BUILD_JOBS=4 cargo test --no-default-features --features test-utils --lib <filter>

# 单个集成测试
CARGO_BUILD_JOBS=4 cargo test --no-default-features --features test-utils --lib sessions::declarative::tests
```

会话 reader 的过滤入口是 `sessions::declarative::tests`；项目会话分页、索引和
reconcile 测试位于 `sessions::project`。测试名必须先用 `rg` 从当前源码确认，
不得从旧任务或 `docs/REMOVED.md` 复制已删除的集成测试名。

终端生命周期测试会真实创建/终止 PTY。`TerminalManager::new()` 指向用户默认
endpoint；测试须使用独立临时 socket 并关闭自己启动的 daemon。运行旧测试前先检查
其 endpoint；若仅靠环境变量隔离，就只对该测试进程设置唯一 `BERTH_TMPDIR`，
不能在共享 endpoint 上跑会创建或终止终端的测试。

---

## Rust 编译资源约束（重要，唯一完整说明）

### 触发信号

无过滤的 `cargo test --features test-utils` 长时间停在 `berth_lib`、CPU 满载
且 swap 增长 —— **这不是死锁**，是 Tauri 大 crate 的 debug 编译与
测试二进制链接开销，极易 OOM。

### 正确做法

| 场景 | 命令 |
|------|------|
| 共享核心迭代 | `cargo test --no-default-features --features test-utils --lib <filter>` |
| 集成测试 | `cargo test --no-default-features --features test-utils --test <name>` |
| 桌面专属代码 | `cargo check` |
| 确需 Tauri 类型 / WebView 行为 | 默认 feature 的**单个过滤测试**，不可无过滤 |

### 禁止

- 把无过滤的 `cargo test --features test-utils` 或 `cargo test --lib` 当日常基线
- 并行运行多个 Cargo 命令（争抢 target lock），或与 dev 自动重编、全项目 `tsc` 并行
- 并行运行 Next production build 与 Cargo link

统一使用 `CARGO_BUILD_JOBS=4` 限制并发。

### 适用范围

本仓库 Linux 开发环境。CI 按其显式定义的命令执行，不受此约束。

---

## 运行时验证：`tauri-browser` debug bridge

项目集成了 `tauri-plugin-debug-bridge`（Cargo feature `debug-bridge`），
配合已安装的 `tauri-browser` CLI（`cargo install tauri-browser`），
agent 可以在用户启动 dev 实例后**远程检查运行时状态**——截图、查 DOM、
执行 JS、调用 Tauri command、看日志，无需用户手动反馈。

**启动（用户执行一次）**：

```bash
pnpm tauri dev --features debug-bridge
```

**agent 常用命令**（在另一个终端执行）：

```bash
# 检查连接
tauri-browser connect

# 截图（验证 UI 布局）
# ⚠ Linux 上不可用：插件 0.5.1 只实现了 macOS，会报 "not yet implemented on this platform"。
#   Linux 改用系统截图后 Read 图片：flameshot full -p /tmp/shot.png
tauri-browser screenshot

# 查 DOM 无障碍树（验证组件渲染）
tauri-browser snapshot

# 在 webview 执行 JS
tauri-browser run-js "document.title"

# 调用 Tauri command
tauri-browser invoke <command_name> '{"arg": "value"}'

# 列出所有已注册 commands
tauri-browser commands

# 查看 Rust 侧日志
tauri-browser logs

# 查看 JS 控制台输出 / 错误
tauri-browser console
tauri-browser errors

# 列出打开的窗口
tauri-browser windows
```

所有命令支持 `--format json` 输出结构化数据，方便 agent 解析。

**注意**：`debug-bridge` feature 仅在 dev 构建生效，release 不会携带。
用户未加 `--features debug-bridge` 启动时，`tauri-browser` 无法连接。

## 指令文件与主线的核对测试

根 `AGENTS.md` 每次会话注入，子目录 `AGENTS.md`（同目录 `CLAUDE.md` 为软链接）在进入该目录时加载；
主线图、路由表里的每个名词必须与代码互相对得上。文档漂移（写了不存在的东西、漏了正在做的事）会直接误导 agent，
以下三个测试在**修改主线 / 路由 / 红线后**执行，也可定期抽查：

### 1. 任务归位测试

拿 active tasks 对照主线循环（`读 / 配 / 跑 / 收`），每条任务必须能说出归属步骤。
说不出归属的只有两种处理：主线图缺词（补图）或该任务不在计划内（立淘汰计划）。
二者都不选则说明任务与主线之一有错。

### 2. 名词 grep 测试

主线图、落点表、契约图里的每个技术名词，验证 agent 拿着它能 grep 到代码实体：

```bash
# 主线循环逐段验证
rg -c normalized_project_path \
  src-tauri/project/berth-project-core/src/entities/project_agent_session_index.rs   # 读
ls ~/.berth/tools/*/tool.json 2>/dev/null                     # 配（用户目录，允许为空）
ls -d src-tauri/terminal/sdk/berth-term-sdk                   # 跑
ls -d src/knowledge src-tauri/src/knowledge                   # 收

# workbench 事实表与侧栏视图
rg -n 'WORKBENCH_(PAGES|PANELS)' src/lib/workbench/catalog.ts
rg -n 'SidebarView' src/components/layout/sidebar/views.ts

# 契约与依赖方向
rg -n 'expertRuntime|expert_(bind|preview|assets|packages)' src-tauri/src src
ls -d src-tauri/tool/berth-tool-core src-tauri/control/berth-control-proto
```

grep 不到实体的名词就是坏词：要么改词（指向存在的模块），要么补实现，
要么删句子。历史名词（已删除的模块）不得出现在主线、落点表、契约图中，
只允许红线区一行事实禁令（如「ACP 已删除，禁止重建」）。

### 3. 行为测试

开新会话，各丢一个任务给 agent：

- **主线内**任务（如「调研 X CLI 工具并接入 tools 目录」或「让项目页签多一个视图」）
  ——agent 应直接按契约原则执行，不质疑主线归属
- **主线外**任务（如「给会话列表加入场动画」）——agent 应引用主线闸门
  提示「对不上读 / 配 / 跑 / 收循环，默认不做」或要求澄清

两个都对，主线记录有效；第一个错 = 图缺词，第二个错 = 闸门句被淹没。

## 运行时性能埋点

代码位于 `src/lib/perf/`，开发环境通过 `window.__perf` 暴露控制台接口。
自动统计经统一 Transport 发出的 IPC command：count、failures、p50、p95、max
和有界 timeline。**不记录参数、返回值或用户内容；生产环境恒定关闭。**

在 Tauri dev WebView 控制台中使用：

```js
__perf.on()             // 写入启用标记；需重载 WebView 才生效
__perf.status()         // 应为 { configured: true, active: true }
__perf.reset()          // 清空上一轮数据
__perf.begin("scene")   // 开始命名测量区间
// 执行一次待观察操作
__perf.end()            // 结束区间
__perf.dump()           // 返回结构化测量对象
await __perf.copy()     // 返回 JSON，并在可用时复制到剪贴板
__perf.off()            // 写入关闭标记；重载 WebView 后恢复原 Transport
```

**使用要点**：

- 开关变更后需由用户重载 WebView
- 一次只观察一个操作，测量前先 `reset()`
- `dump()` 中 scene wall-clock 表示用户等待区间；
  **并发 command 的 duration 不得相加后冒充 wall-clock**

实现与契约测试：

| 文件 | 职责 |
|------|------|
| `src/lib/perf/enabled.ts` | 开关及当前 Transport active 状态 |
| `src/lib/perf/collector.ts` | 聚合、timeline 和 scene 数据 |
| `src/lib/perf/transport-proxy.ts` | Transport IPC 自动测量装饰器 |
| `src/lib/perf/window-bridge.ts` | `window.__perf` 控制台接口 |
| `src/lib/perf/*.test.ts` | identity、resolve/reject、百分位、容量、bridge 契约测试 |

修改上述代码时的窄范围验证：

```bash
pnpm vitest run src/lib/perf/
pnpm exec eslint src/lib/perf/ src/lib/transport/index.ts
```

---

## 发布门禁（仅用户明确要求时执行）

以下命令耗时长、内存占用高，**日常迭代不跑**。仅在用户要求发布、提交完整
门禁，或局部检查确实无法覆盖风险时执行，且必须串行。

### 前端

```bash
pnpm lint              # 全仓库 eslint
pnpm test              # vitest 全跑（CI 同命令）
pnpm test:coverage     # 覆盖率 → coverage/index.html
pnpm build             # 静态导出（先同步 pdfjs 资产）
```

### Rust（在 `src-tauri/` 下）

```bash
CARGO_BUILD_JOBS=4 cargo check
CARGO_BUILD_JOBS=4 cargo clippy --all-targets --features test-utils -- -D warnings
CARGO_BUILD_JOBS=4 cargo test --no-default-features --features test-utils --lib
```

### 解析器快照

输出变化时评审：

```bash
cargo insta review
INSTA_UPDATE=auto CARGO_BUILD_JOBS=4 cargo test --no-default-features --features test-utils --lib
```

> MCP companion 维护在 `../berth-mcp` 并在该仓库验证。
> GUI workspace 只检查 host 侧协议适配器。

---

## 提交前自检清单

按改动类型取用，不必全跑。

**前端改动**

- [ ] 目标文件 eslint 通过
- [ ] 相关目录 Vitest 通过
- [ ] 用户可见文本已双语（`en.json` + `zh-CN.json`）
- [ ] 未引入动态路由（静态导出限制）
- [ ] API 调用走 `lib/transport/`，无裸 `fetch` / `invoke`

**Rust 改动**

- [ ] 相关过滤测试通过
- [ ] 条件编译标记正确（`tauri-runtime` feature）
- [ ] 解析器快照已评审（如有变化）

**数据库改动**

- [ ] 迁移命名 `m{YYYYMMDD}_{NNN}_{description}.rs`
- [ ] Entity / Service 已在对应 `mod.rs` 注册
- [ ] 未修改已执行的迁移

**删除代码**

- [ ] `docs/REMOVED.md` 已登记（文件、原因、commit、恢复命令、恢复注意）

---

## 结果判定纪律

- 只有命令**实际退出 0** 才可声称通过；不得以「应该可以」「看起来没问题」代替证据
- 必须分别列出：已通过、未运行、失败、被环境阻断的检查
- `cargo check` ≠ `cargo build`；编译成功 ≠ 打包成功 ≠ 真实桌面体验验证
- 测试失败时先保留红灯证据再最小修复；
  **不得删除、跳过、放宽断言或更新快照来「消除」失败**
- 共享工作区中已有的修改属于用户。用 `git status` / `git diff` 区分来源，
  不回滚、不覆盖、不批量格式化无关文件
