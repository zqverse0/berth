<!--
  TODO：在简介下方和「快速开始」里放当前界面的截图 / GIF；定稿后出英文版并把这份改名为 README.zh-CN.md
-->

<div align="center">

# Berth

**你已经在用的 Agent CLI，原样跑在真实终端里。Berth 把项目、会话、多 Agent 协作和产出都收拢到一个桌面窗口。**

[![Release](https://img.shields.io/github/v/release/zqverse0/berth?include_prereleases)](https://github.com/zqverse0/berth/releases)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
![Platforms](https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows-lightgrey)

[下载](https://github.com/zqverse0/berth/releases) · [快速开始](#快速开始) · [功能](#功能一览) · [接入新的 Agent](#接入新的-agent)

</div>

---

Claude Code、Codex、Pi 这些编码 Agent 越来越强，但用多了会遇到同样的麻烦：终端开了一堆，分不清哪个 Agent 在哪个项目里；上周那次好用的会话找不回来；想让两个 Agent 分工，只能自己来回复制粘贴；Agent 生成的报告、PDF、diff，要切到别的窗口才能看。

**Berth 不做又一个 Agent，也不把 Agent 重新包装成聊天界面。** 它让原生 CLI 照常运行，只负责它们周围的事：在哪个项目里启动、带什么配置启动、跑过哪些会话、彼此怎么协作，以及产出落回项目的哪里。

## 为什么用 Berth

**🖥️ 原生 CLI，零适配延迟**
Agent 跑在真实的 PTY 终端里，你看到的就是 CLI 本来的样子。Agent 今天发布新功能，在 Berth 里今天就能用，不用等任何客户端适配。

**🤝 一个项目群，指挥多个 Agent**
带着「专家」身份启动的 Agent 会自动进入项目群。你在群里点名一个或几个 Agent 发任务，消息在它空闲时送达，回复自动贴回群里，每一轮改了哪些文件、增删多少行一目了然。让 Claude 写、Codex 审，只需要「转给」一下。

**🧠 记忆跟着项目，不跟着 Agent**
所有 Agent 的历史会话按项目归类，随时恢复。知识库和任务存在项目自己的 `.berth/` 目录里，是普通的 Markdown 文件，可以进 Git、随仓库走，换 Agent、换电脑都不丢。

**🔁 Agent 能反过来操作工作台**
在 Berth 打开的终端里，Agent 可以用 `berth` 命令在你面前打开它写好的报告、读另一个终端的输出、给群里的另一个 Agent 发消息、查项目知识库。协作不再靠你当传话筒。

**💪 关掉窗口，Agent 照样在跑**
终端由独立的守护进程管理，关闭 Berth 窗口不会中断正在工作的 Agent，重新打开就接上。出门在外，手机通过 Tailscale 打开同一个工作台，或者用 SSH 直接接入项目终端。

**🔌 任何 Agent，一个插件包接入**
Berth 的代码里没有一行按 Agent 品牌写的分支。每个 Agent 是一个插件包（`tool.json` + `launch.js`），官方已经提供 Claude Code、Codex CLI、Pi、Grok、Cline CLI、Antigravity CLI。

**🪶 轻量原生**
Tauri + Rust 构建，不是 Electron。Linux 安装包约 48MB。

## 功能一览

| | |
|---|---|
| **启动** | 选 Agent、模型服务商、专家包，一键在项目目录启动；模型服务商配置一次，各 Agent 通用，密钥存系统 keyring |
| **会话** | 读取各 Agent 本地的历史会话，按项目归类、可恢复；部分 Agent 显示账户用量和额度重置时间 |
| **终端** | 独立守护进程、分栏、标签组；右键「复制终端 ID」交给 Agent 精准定位 |
| **项目群** | 点名发送、空闲送达、回复回贴、转给另一个 Agent、每轮改动文件；手机上也能对话 |
| **审阅** | Markdown、HTML（沙箱）、PDF（选中、高亮、批注）、图片、Office 文档、代码编辑；Git 改动、提交、分支、贮藏、提交记录 |
| **沉淀** | 双链 Markdown 知识库（搜索、反向链接、待维护提示）；任务带步骤、可绑定分支 / worktree、可定时运行 |
| **远程** | 手机浏览器经 Tailscale 访问，可添加到主屏幕全屏使用；`berth terminal attach` 经 SSH 接入 |
| **其他** | GitHub 星标 / 趋势仓库浏览与一键克隆、划词翻译、中英文界面、深浅色主题 |

## 快速开始

1. **安装 Berth**：从 [Releases](https://github.com/zqverse0/berth/releases) 下载对应平台的安装包。
2. **安装 Agent 插件**（Berth 不自带插件，按需装你在用的）：
   ```bash
   berth tools install https://github.com/zqverse0/berth#plugins/claude
   berth tools install https://github.com/zqverse0/berth#plugins/codex
   ```
   也可以把 [`plugins/`](plugins/) 下的目录直接拷进 `~/.berth/tools/`，再到「设置 → 插件」里刷新。
3. **打开项目**：选一个本地文件夹，或者从 GitHub 星标里克隆。
4. **启动 Agent**：点辅助面板 tab 条右端的「+」，选 Agent 启动，它会在项目目录的终端里运行。
5. **让 Agent 协作**：带专家启动的 Agent 会出现在项目群里，在群里点名它们发任务。

前提：你已经自己安装并登录了要用的 Agent CLI（例如 `claude`、`codex`、`pi`）。Berth 本身不需要另装 Node 或 Python，插件脚本由内嵌的 JS 引擎执行。

## `berth` 命令

在 Berth 打开的终端里，Agent 和你都可以用：

```bash
berth open docs/report.html:12              # 在 Berth 里打开文件，跳到第 12 行
berth project current-file                  # 读取你正在看的文件
berth terminal ls                           # 列出终端
berth terminal capture -t myproj:3          # 读另一个终端的输出
berth project . group post main --to <成员> --text "…"   # 给群里的某个 Agent 发消息
berth project . task create "标题"          # 建任务
berth project . knowledge search <关键词>   # 查项目知识库
berth guide                                 # 给 Agent 看的完整说明
```

`berth --help` 列出全部命令。

## 适合谁

- 同时用两个以上 Agent CLI，想在一个地方管理的人
- 想让几个 Agent 在同一个项目里分工、互相审阅的人
- 项目多，想按项目找回以前的 Agent 会话的人
- 想在 Agent 旁边直接审阅产出，不来回切窗口的人

如果你只用一个 Agent、习惯在 IDE 插件里对话，或者主要想**同时开很多 worktree 并行开发**，专门的工具可能更合适；Berth 的重点是**在一个项目里长期和多个 Agent 协作，并把产出留在项目里**。

## 安装说明

| 平台 | 安装包 | 测试情况 |
|---|---|---|
| Linux x64 / arm64 | `.deb` / `.rpm` | x64 `.deb` 作者日常使用 |
| macOS Apple Silicon / Intel | `.dmg` | 测试较少 |
| Windows x64 / arm64 | `.exe` | 测试较少 |

安装包暂时没有经过 Apple / Microsoft 的签名认证，首次打开时需要手动放行一次：

- **macOS**：打开时提示无法验证开发者，到「系统设置 → 隐私与安全性」点「仍要打开」；或者在终端执行 `xattr -dr com.apple.quarantine /Applications/berth.app`
- **Windows**：SmartScreen 拦截时点「更多信息 → 仍要运行」

## 在手机上使用

电脑和手机都装上 [Tailscale](https://tailscale.com/) 并登录同一个账号。Berth 启动时检测到 Tailscale，会在电脑的 tailscale 地址上提供远程访问，手机浏览器打开就是同一个工作台，添加到主屏幕后全屏显示。环境变量 `BERTH_REMOTE_ADDR=ip:port` 可以指定地址，设为空串关闭。

> ⚠️ 远程访问目前**没有登录鉴权**，只靠 Tailscale 网络隔离：同一个 tailnet 里的任何设备都能打开它并操作你的终端。只在只有你自己设备的 tailnet 上使用；tailnet 里有别人时，请设置 `BERTH_REMOTE_ADDR=` 关闭。

## 接入新的 Agent

每个 Agent 是 `~/.berth/tools/<id>/` 下的一个插件包：

```text
~/.berth/tools/<id>/
├── tool.json         # 身份、能力、资源位置
├── launchbar.json    # 启动时的选项
├── launch.js         # 怎么启动（内嵌 JS 引擎执行，改了下次启动就生效）
└── sessions.json     # 可选：去哪里读历史会话
```

格式说明见 [`docs/agent-contracts.md`](docs/agent-contracts.md)，开发指南见 [`docs/plugin-development.md`](docs/plugin-development.md)。

## 数据与隐私

- `~/.berth/`：插件、专家包、提示词、skills，可以手动编辑
- `~/.local/share/app.berth/`（Linux）：数据库、日志、缓存
- 项目里的 `.berth/`：知识库、任务；其中 `.berth/local/` 是本机运行状态，不进 Git
- 密钥：系统 keyring

**Berth 没有遥测，不上传你的代码或会话。** 会主动联网的只有：打开「设置 → 高级」时检查新版本；浏览 GitHub 星标 / 趋势仓库；插件查询 Agent 账户用量；划词翻译调用公开翻译服务（Google、DeepL、火山翻译）；以及你配置的模型服务商，由 Agent 自己调用。

## 项目状态

早期版本（0.x），作者每天用它开发 Berth 本身。界面、配置格式（`tool.json` 等）和 `berth` CLI 还可能有不兼容的变更；主要在 Linux 上开发，其他平台测试不足；开发文档目前主要是中文。欢迎提 issue。

## 从源码构建

需要 Node.js 22+、pnpm、Rust stable，以及 [Tauri 2 的平台依赖](https://tauri.app/start/prerequisites/)。

```bash
pnpm install
pnpm tauri dev          # 开发模式
pnpm release:deb        # Linux：打 .deb 包
```

架构说明见 [`docs/architecture.md`](docs/architecture.md)。仓库里的 `AGENTS.md` / `CLAUDE.md` 是写给编码 Agent 的开发规则，人类贡献者也建议读一遍。

## 致谢与许可

Berth 在 Apache-2.0 许可下发布，见 [LICENSE](LICENSE)。部分代码来自以下项目，详见 [NOTICE](NOTICE)：

- [Codeg](https://github.com/xintaofei/codeg)（Apache-2.0）：应用框架
- [RMUX](https://github.com/helvesec/rmux)（MIT / Apache-2.0）：终端运行时

Berth 是独立维护的项目，与上述项目的作者没有隶属关系。
