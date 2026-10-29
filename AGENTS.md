# Berth Agent 指令（根）

只放任何目录都适用的规则。细则在子目录 `AGENTS.md`，进入该目录工作时再读。

## 主线：项目 × Agent

项目是容器，Agent 在项目里干活。新工作先对准下面哪一步，对不上的不做：

- **读**：按项目归位各 Agent 本地会话 → `src-tauri/src/sessions/`
- **配**：给项目挑 Agent / 服务商 / 启动资产 → `~/.berth/tools/<id>/`
- **跑**：在项目目录启动 Agent CLI → `src-tauri/terminal/`（termd）
- **收**：产出落回项目 → 知识库、任务、Git

落点：有 UI 且服务主线 → 进代码库；无 UI 只供 agent 调用 → 做 MCP，不进代码库；
都不是 → 不做。删掉后主线仍走得通的是卫星，必须挂在主线上。

最小需求先行：先写一句话结果，只做走完这句话的最小切口；不做「以防万一」的
抽象、字段、命令、页面；能扩展现有入口就不开新入口。

取舍顺序：使用流畅 > 逻辑顺畅 > 资源占用低 > 体积小
（细则 `.trellis/spec/guides/performance-and-footprint.md`）。

## 红线

0. **Agent 启动失败不改 Berth**：先查 `~/.berth/tools/<id>/launch.js`、
   `launchbar.json`、`experts/`。
1. **验证不 OOM**：用户常驻 `pnpm tauri dev`，改动自动重编——Rust 编译结果读 dev 终端
   （`berth terminal capture -t <终端>`），不对 `berth-gui` / workspace 跑 cargo；单独只跑小 crate
   测试、pytest、单文件 vitest / eslint，一次一个。细则 `docs/verification.md`。
   **worktree 里不装依赖、不编译 GUI**：只允许 pytest、`git diff --check`，以及小 crate 检查
   `scripts/dev-trial cargo check|test -p <crate>`（全局串行 + 独立 target，不碰 dev 的产物）；运行时验证一律用
   `scripts/dev-trial` 试合并进 dev，在 dev 实例里测，失败回退。
2. **不按 Agent id / 品牌名在 Rust 或 React 里分支**，扩展契约字段。
3. **删除模块必须登记 `docs/REMOVED.md`**。该文件只在删除 / 恢复模块时打开，
   不要搜索或通读它。
4. **密钥不得硬编码**。
5. **路径必须可完成**：用户能点到的操作必须走得完，不留空操作和死入口。
6. **一件事只有一个主人**：新增依赖或自写某项能力前，先查现有依赖、平台、后端是否已覆盖；
   已覆盖就用它，只补它做不到的空缺，并薄薄挂在接缝上，不另起一套。

## 目录索引

| 改动位置 | 先读 |
|---|---|
| `src/` 前端 | `src/AGENTS.md` |
| `src-tauri/` Rust 宿主 | `src-tauri/AGENTS.md` |
| `src-tauri/terminal/` | `src-tauri/terminal/AGENTS.md` |
| `src-tauri/tool/`、tool.json 契约 | `src-tauri/tool/AGENTS.md` |
| 实体 / 迁移 | `src-tauri/project/berth-project-core/AGENTS.md` |
| 项目内 `.berth/`（内容、写入方、`local/` 不进 git） | `.berth/tasks/10-04-berth-project-dir/prd.md` §4 |
| 设计缘由、踩过的坑 | `.berth/knowledge/`（维护方法 `berth guide knowledge`） |
| 全局模块图与数据流（需要时才读） | `docs/architecture.md` |

## 通用

- 代码注释用简体中文；格式交给 Prettier / ESLint / rustfmt。

