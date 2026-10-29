# 前端（`src/`）

## 硬约束

- **仅静态导出**（`next.config.ts` `output: "export"`）：禁止动态路由 `[param]`，用查询参数。
- 路径别名 `@/*` → `./src/*`。
- **用户可见文本必须双语**：`src/i18n/messages/en.json` + `zh-CN.json`。
- **调后端必须走 `src/lib/transport/`**（或 `src/lib/runtime-bridge.ts`），禁止直接 `fetch` / `invoke`。

## 布局

**左侧**（`src/components/layout/sidebar/`）：`ActivityBar` 放视图图标（项目 / 文件 /
Git / 任务 / 记忆 / 协作 / 会话详情），左下角是设置；
`Sidebar` 外壳 = 顶栏 + 视图正文。顶栏是各视图选项的唯一位置：正文用
`SidebarHeaderTabs`（tab，替换标题）与 `SidebarHeaderActions` + `SidebarHeaderButton`
（纯图标动作）声明，自己保有状态，不在正文里再放 tab 条或文字按钮。项目切换只在底部
状态栏项目段（`src/components/layout/project-switcher.tsx`）；列表类内容用文件列表行，不用卡片。样式用主题
token（`text-muted-foreground`、`hover:bg-accent`、`ws-surface-*`），状态栏项保持扁平。

**Workbench**：`src/lib/workbench/catalog.ts` 是 page/panel 事实表，只剩设置页；
git / 任务（含协作）/ 记忆是侧栏视图（`useSidebarViewStore`）。
设置是模式，不占中间 tab 条：齿轮进入后活动栏齿轮上方展开各设置页图标（`settings-nav.ts`），
侧栏切到「设置」视图（`settings-sidebar.tsx`）；设置页用 `SettingsSplit` 把列表渲染进侧栏、中间只放
详情，没有侧栏落点时列表留在页内；「通用」= 外观 + 高级，侧栏列分节。点首页、别的 tab / 视图或再点齿轮即退出。

**Tab 组**：辅助面板（pane `conversation`）、中间左栏（`files`）、中间右栏（`files-split`）
都是 tab 组，tab 的位置由 `workspace-layout-store` 的 placement 决定；内容由
`WorkspacePaneContent pane=…` 按「该组激活 tab」渲染，不按 tab 类型写死。右栏只在左栏
有 tab 时存在（`foldEmptySplit`）。拖放目标是 tab 条与 `WorkspacePaneDropArea` 内容区。
辅助面板 tab 条右端的「+」（`AgentLaunchMenu`）是启动 Agent / 新建终端的弹层，所有入口都经
`openLaunchShelf` 打开它。快捷指令（`TerminalCommandsMenu`，项目指令 + 全局指令）在右上角标题区，贴在「切换辅助面板」左侧。

## 常见落点

| 任务 | 落点 |
|---|---|
| 新增前端页面 | `src/app/{page}/` + `components/`（无动态路由） |
| 新增设置页 | `catalog.ts` 面板 + `settings-tab.ts` id + `SETTINGS_PAGE_LOADERS` + 双语 i18n 键（先确认不能并入现有 6 页） |
| 新增命令 / 快捷键 | `src/components/layout/commands/`：`commands.ts` 登记 id 与键位，`command-controller.tsx` 实现 `run`，再补双语 `WorkspaceCommands.<id>` |

## 按需细则（`.trellis/spec/frontend/`）

| 改动 | 读 |
|---|---|
| Agent / tool 契约的前端投影 | `agent-contract-core.md` |
| 首屏、常驻面板、性能 | `performance-and-footprint.md` |
| 文件查看器 | `file-viewers.md` |
| 分栏布局 | `split-layout.md` |
| 自动化执行结果 | `automation-results.md` |
