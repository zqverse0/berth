use std::collections::BTreeSet;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use clap::{Parser, Subcommand};
use berth_term_ipc::{resolve_endpoint, LocalEndpoint};
use berth_project_core::runtime::{classify_session, SessionOwnership};
use berth_project_core::service::catalog::CatalogEntry;
use berth_term_sdk::{DiscoveredPane, SessionName, Terminal, TerminalClientBuilder};

mod attach_client;
mod gui_client;
mod gui_launch;
mod guide;
mod init;
mod knowledge;
mod project;
mod provider_launch;
mod provider_proxy;
mod provider_run;
mod remote;
mod session;
mod group;
mod shim;
mod task;
mod tools;
mod workspace_terminal;
use attach_client::{attach_terminal_with_initial_bytes, connect, AttachTransition};

const EXIT_USER_ERROR: u8 = 2;
const EXIT_DAEMON_UNAVAILABLE: u8 = 3;
const EXIT_TARGET_NOT_FOUND: u8 = 4;
pub(crate) const EXIT_GUI_UNAVAILABLE: u8 = 5;
pub(crate) const EXIT_INCOMPATIBLE: u8 = 6;
pub(crate) const EXIT_REJECTED: u8 = 7;
/// 已连接后的操作/条件超时；操作可能已经开始，结果未知。
pub(crate) const EXIT_OPERATION_TIMEOUT: u8 = 8;
/// `open --timeout` 的默认值与上限（秒）。
const OPEN_TIMEOUT_DEFAULT_SECS: u64 = 30;
const OPEN_TIMEOUT_MAX_SECS: u64 = 600;

/// `berth --help`：命令按 GUI 功能分组，与 GUI 操作一一对应。
const LONG_ABOUT: &str = "\
Berth 命令行：与 GUI 同一套功能。

  项目      berth project ls | add | init | current-file
  文件      berth open <路径>:<行号>
  终端      berth terminal ls | create | capture | send | attach | current
  设置      berth provider …（模型服务商）、berth tools …（插件）
  其他      berth guide（Agent 说明）、berth doctor（诊断）

单个项目（<项目> 用 ID、名称、路径，`.` 是当前目录所在项目）：
  任务      berth project <项目> task create | list | show | start | assign | finish | reopen
  群组      berth project <项目> group who | read | post | spawn | join
  会话      berth project <项目> session ls | show | last
  记忆      berth project <项目> knowledge search | for | show | idea | lint | digest | root

常用：
  berth terminal ls --project codeg           列出终端
  berth terminal capture -t codeg:3           读终端输出
  berth terminal send -t codeg:3 --text ls    写入文字（再 --key Enter 回车）
  berth terminal create --project codeg       新开终端；加 --agent claude 启动 Agent
  berth terminal attach -s codeg              手机 / SSH 接入项目终端，C-b d 退出

项目可用 ID、名称（或唯一前缀）、路径指定；终端用 `项目:编号` 或 --json 输出里的 target_ref。
退出码：2 参数错误、3 终端服务不可用、4 目标不存在、5 GUI / 数据实例不可用、6 版本不兼容、
7 被拒绝、8 超时、9 工具执行失败。";

/// attach 里可用的按键；分屏、新建 / 重命名窗口已移除（由 GUI 的 Tab 组与 terminal create 负责）。
const ATTACH_KEYS: &str = "\
按键（前缀 C-b）：
  C-b d          退出 attach，终端继续运行
  C-b n / p      下一个 / 上一个终端；C-b 0-9 直接跳转
  C-b w          终端列表
  C-b [          回看历史（q 退出）；开鼠标后也可手指上滑
  鼠标           点状态栏切换终端
新开终端：在任一终端里运行 `berth terminal create --project <项目>`。";

#[derive(Debug, Parser)]
#[command(
    name = "berth",
    version,
    about = "Berth 命令行：项目 → 终端",
    long_about = LONG_ABOUT
)]
struct Cli {
    /// 选择具名 daemon socket。
    #[arg(short = 'L', global = true, conflicts_with = "socket_path")]
    socket_name: Option<OsString>,

    /// 指定 daemon socket 的完整路径。
    #[arg(short = 'S', global = true)]
    socket_path: Option<PathBuf>,

    /// 覆盖 GUI 控制 socket 地址（显式指定时不会自动启动 GUI）。
    #[arg(long, global = true)]
    gui: Option<OsString>,

    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// 远程项目：Agent 的 shell 命令在设备上执行（由 Agent 的 hook / 扩展调用）。
    #[command(hide = true)]
    Remote {
        #[command(subcommand)]
        command: RemoteCommand,
    },

    /// 查询本机 Berth GUI 控制服务。
    #[command(hide = true)]
    Gui {
        #[command(subcommand)]
        command: GuiCommand,
    },

    /// 项目：列出、添加、启用 Berth，读取 GUI 当前文件；berth project <项目> knowledge|task|group|session …
    /// 操作单个项目（项目用 ID、名称、路径，`.` 是当前目录所在项目）。
    #[command(display_order = 1)]
    Project {
        #[command(subcommand)]
        command: ProjectCommand,
    },

    /// 终端：列出、新建（含启动 Agent）、读写、远程接入（用 `项目:编号` 或 target_ref 指定）。
    #[command(display_order = 3)]
    Terminal {
        #[command(subcommand)]
        command: TerminalCommand,
    },

    /// 文件：在 Berth GUI 里打开文件并定位到行。
    #[command(display_order = 2)]
    Open {
        /// 文件路径（相对路径按当前目录解析），可带 `:行号`。
        target: String,

        /// 显式行号，优先于 `:行号` 简写。
        #[arg(long)]
        line: Option<u32>,

        /// 等主窗口加载并定位到文件后，再报告实际结果。
        #[arg(long)]
        wait: bool,

        /// 启动加等待的总秒数，仅配合 --wait；正整数，最大 600。
        #[arg(long)]
        timeout: Option<u64>,

        /// 输出一个机器可读的 JSON 对象。
        #[arg(long)]
        json: bool,
    },

    /// 列出有 live 终端的项目（可 attach 的对象）。
    #[command(hide = true, alias = "list", alias = "list-sessions")]
    Ls,

    /// 同 `berth terminal attach`（旧入口）。
    #[command(hide = true)]
    Attach {
        #[arg(short = 's')]
        session: String,
    },

    /// 会话：项目里 Agent 会话的列表与内容（与 GUI 会话视图一致），只读。写作 `berth project <项目> session`。
    #[command(hide = true)]
    Session {
        #[command(subcommand)]
        command: SessionCommand,
    },

    /// 模型服务商（设置 → 模型服务商）：列出、存 key、在 Berth 之外用它运行命令。
    #[command(display_order = 8)]
    Provider {
        #[command(subcommand)]
        command: ProviderCommand,
    },

    /// 插件（设置 → 插件）：列出、查看、启用 / 停用、安装 / 更新 / 删除。
    #[command(display_order = 9)]
    Tools {
        #[command(subcommand)]
        command: tools::ToolsCommand,
    },

    /// 持有 termd 命名锁（wait-for -L/-U，FIFO）执行命令，用于串行合并。
    #[command(hide = true)]
    Lock {
        /// 锁名（daemon 内全局）。
        name: String,
        /// 解除一把遗留的锁（持锁进程被强杀时锁不会自动释放）。
        #[arg(long, conflicts_with = "command")]
        release: bool,
        /// 要执行的命令：`berth lock <name> -- <cmd...>`。
        #[arg(last = true, required_unless_present = "release")]
        command: Vec<String>,
    },

    /// 把 `berth` 命令安装到用户 PATH。
    #[command(hide = true)]
    InstallShim,

    /// 移除 Berth 安装的 PATH shim。
    #[command(hide = true)]
    UninstallShim,

    /// 诊断 CLI、shim 与 daemon 的位置。
    #[command(display_order = 11)]
    Doctor,

    /// 同 `berth project init`（旧入口）。
    #[command(hide = true)]
    Init {
        path: Option<PathBuf>,
        #[arg(long)]
        json: bool,
    },

    /// 群组：成员、收发消息、派发 worker（与 GUI 群组视图一致）。需先启用 Berth。
    /// 写作 `berth project <项目> group`。
    #[command(name = "group", disable_help_flag = true, hide = true)]
    Group {
        /// 子命令与参数（`berth group --help` 列出全部子命令）。
        #[arg(trailing_var_arg = true, allow_hyphen_values = true, num_args = 0..)]
        args: Vec<OsString>,
    },

    /// 专家：`ls` 列出全部专家与它们在项目群里的终端，`show <id>` 看一个专家的终端和规矩。写作 `berth project <项目> expert`。
    #[command(hide = true)]
    Expert {
        /// 子命令与参数（`ls` / `show <id>`）。
        #[arg(trailing_var_arg = true, allow_hyphen_values = true, num_args = 0..)]
        args: Vec<OsString>,
    },

    /// 打印 Agent 用的 Berth 说明（命令清单 + 规则 + 主题列表）。内置部分随 CLI 发布；
    /// `~/.berth/guides/<主题>.md` 是用户补充，附在内置之后。
    #[command(display_order = 10)]
    Guide {
        /// 只看某个主题，如 `knowledge`（项目知识库怎么维护）；`berth guide` 末尾列出全部主题。
        topic: Option<String>,
        /// 只打印命令清单：Agent 启动器把它注入系统提示词。
        #[arg(long, conflicts_with = "topic")]
        brief: bool,
        /// 检查用户补充里写的 berth 命令当前 CLI 能否解析；有问题退出码 1。
        #[arg(long, conflicts_with_all = ["topic", "brief"])]
        check: bool,
    },

    /// 记忆（项目知识库，worktree 共用主项目这一份）：检索、阅读、体检、想法、会话摘要。维护方法见 `berth guide knowledge`。
    /// 写作 `berth project <项目> knowledge`。
    #[command(hide = true)]
    Knowledge {
        #[command(subcommand)]
        command: KnowledgeCommand,
    },

    /// 任务：建任务写 prd、分配到群、开工、完成（与 GUI 任务页一致）。需先启用 Berth。写作 `berth project <项目> task`。
    #[command(hide = true)]
    Task(task::TaskArgs),
}

#[derive(Debug, Subcommand)]
enum KnowledgeCommand {
    /// 打印知识库的绝对路径（主项目的 `.berth/knowledge`）；写知识一律写到这里。
    Root,
    /// 检索笔记：标题、别名、标签、正文全文，空格分词全部命中。每条只给标题、类型、摘要和命中片段（文本输出 ≤ 2 KB）。
    Search {
        /// 检索词。
        #[arg(required = true)]
        query: Vec<String>,
        /// 只看这一类：地图 | 概念 | 模块 | 决策 | 经验 | 来源 | 未分类。
        #[arg(long = "type")]
        note_type: Option<String>,
        /// 最多几条。
        #[arg(long, default_value_t = 10)]
        limit: usize,
        /// 输出一个机器可读的 JSON 对象。
        #[arg(long)]
        json: bool,
    },
    /// 改文件前查它的设计缘由与踩过的坑：列出 `code` 关联这个文件或目录的笔记（文本输出 ≤ 2 KB）。
    For {
        /// 文件或目录：绝对路径，或相对当前目录。
        path: String,
        /// 输出一个机器可读的 JSON 对象。
        #[arg(long)]
        json: bool,
    },
    /// 读一篇笔记：按标题或别名，打印正文与链接到 / 被引用的笔记标题。
    Show {
        /// 标题或别名。
        #[arg(required = true)]
        name: Vec<String>,
        /// 只打印链接关系，不打印正文。
        #[arg(long)]
        links: bool,
        /// 输出一个机器可读的 JSON 对象。
        #[arg(long)]
        json: bool,
    },
    /// 体检：格式、重名、断链、孤立、code 路径、首页、可能过期。有 ERROR 时退出码 1。
    Lint {
        /// 输出一个机器可读的 JSON 对象。
        #[arg(long)]
        json: bool,
    },
    /// 想法：用户随手记的想法 / 问题，一条一个文件（`<vault>/想法/`）；Agent 讨论后把结论落到笔记。
    Idea {
        #[command(subcommand)]
        command: IdeaCommand,
    },
    /// 会话摘要：本项目（含 worktree）在游标之后的 Agent 会话，只含用户与助手文本。需要 Berth GUI 在运行。
    Digest {
        /// RFC 3339 游标；默认取 `.berth/knowledge/.curation.json` 的 `since`，都没有时读全部历史。
        #[arg(long)]
        since: Option<String>,
        /// 输出一个机器可读的 JSON 对象。
        #[arg(long)]
        json: bool,
    },
}

#[derive(Debug, Subcommand)]
enum IdeaCommand {
    /// 记一条想法；正文里的 `#标签` 收进 tags。
    Add {
        #[arg(required = true)]
        text: Vec<String>,
        /// 输出一个机器可读的 JSON 对象。
        #[arg(long)]
        json: bool,
    },
    /// 列出开放的想法（待讨论、讨论中），新的在前：id、状态、原话首行。
    Ls {
        /// 只看这一状态：待讨论 | 讨论中 | 已落地 | 已放下（后两种在归档里）。
        #[arg(long)]
        status: Option<String>,
        /// 输出一个机器可读的 JSON 对象。
        #[arg(long)]
        json: bool,
    },
    /// 打印一条想法的全文（原话 + 讨论 + 结论）。
    Show { id: String },
    /// 改状态：待讨论 | 讨论中 | 已落地 | 已放下。
    Status { id: String, status: String },
    /// 在「## 讨论」下追加一条 `- MM-DD 作者：一句话`；待讨论的改为讨论中。
    Discuss {
        id: String,
        #[arg(required = true)]
        text: Vec<String>,
        /// 谁说的：Agent（缺省）或 用户。
        #[arg(long, default_value = "Agent")]
        author: String,
    },
    /// 升级为任务：新建任务文件，原话与讨论进任务的「背景」，想法以 `→ 任务` 关闭归档。
    Promote {
        id: String,
        /// 任务标题；缺省取想法首行。
        #[arg(long)]
        title: Option<String>,
    },
    /// 写结论并关闭：落到笔记 / 任务 / 提交 → 已落地；放下 → 已放下（写理由）。
    #[command(group(clap::ArgGroup::new("conclusion").required(true).args(["note", "task", "commit", "drop"])))]
    Close {
        id: String,
        /// 结论写进的知识笔记标题。
        #[arg(long)]
        note: Option<String>,
        /// 转成的任务（`berth task create` 返回的 taskDirName）。
        #[arg(long)]
        task: Option<String>,
        /// 一次提交就做完了：提交的短 hash。
        #[arg(long)]
        commit: Option<String>,
        /// 不做了：理由。
        #[arg(long)]
        drop: Option<String>,
    },
}

#[derive(Debug, Subcommand)]
enum RemoteCommand {
    /// 在当前目录对应的设备目录里用 bash 执行命令；不在远程项目里就在本机执行。退出码即命令的退出码。
    Exec {
        /// 本机工作目录（缺省为当前目录）。
        #[arg(long)]
        cwd: Option<PathBuf>,
        /// 命令结束后把对应的本机目录（跟随设备上的 `cd`）写进这个文件；离开项目则写空。
        #[arg(long)]
        cwd_file: Option<PathBuf>,
        /// 要执行的命令（多个参数以空格连接后交给 bash）。
        #[arg(trailing_var_arg = true, allow_hyphen_values = true, required = true)]
        command: Vec<String>,
    },
    /// PreToolUse hook：stdin 是 hook JSON；远程项目里的 shell 命令改写为经 `exec` 执行。
    Hook,
}

#[derive(Debug, Subcommand)]
enum GuiCommand {
    /// 返回 GUI 控制服务状态。
    Status {
        /// 输出一个机器可读的 JSON 对象。
        #[arg(long)]
        json: bool,
    },
}

#[derive(Debug, Subcommand)]
enum ProjectCommand {
    /// 读取 GUI 当前可见文本编辑器最后提交的内容。
    CurrentFile {
        /// 行数预算（1..=4096，默认80）；不传 offset 时读取尾部。
        #[arg(long, value_parser = clap::value_parser!(u32).range(1..=4096))]
        lines: Option<u32>,

        /// 从指定的 1-based 行向前读取。
        #[arg(long, value_parser = clap::value_parser!(u64).range(1..))]
        offset: Option<u64>,

        /// 首读返回的快照引用；缓冲变化后明确拒绝续读。
        #[arg(long)]
        snapshot_ref: Option<String>,

        /// 输出一个机器可读的 JSON 对象。
        #[arg(long)]
        json: bool,
    },

    /// 列出本数据实例里全部已注册项目（无需 GUI；实例为空时先启动一次 Berth GUI）。
    Ls {
        /// 只列出当前打开的项目。
        #[arg(long, default_value = "all")]
        scope: String,

        /// 输出一个机器可读的 JSON 对象。
        #[arg(long)]
        json: bool,
    },

    /// 添加（或重新打开）一个项目目录：GUI 在跑时经 GUI（界面随之刷新），否则直接写库（SSH / 无 GUI 服务器）。
    Add {
        /// 目录的绝对路径。
        path: PathBuf,

        /// 输出一个机器可读的 JSON 对象。
        #[arg(long)]
        json: bool,
    },

    /// 启用 Berth（GUI「启用 Berth」）：在项目里创建 `.berth/` 骨架。幂等，不覆盖已有文件。
    Init {
        /// 项目目录，默认当前目录。
        path: Option<PathBuf>,
        /// 输出一个机器可读的 JSON 对象。
        #[arg(long)]
        json: bool,
    },
}

#[derive(Debug, Subcommand)]
enum ProviderCommand {
    /// 启动本地凭据代理（`run` 会按需自动启动，一般不用手动跑）：调用方用占位 token，以
    /// `http://127.0.0.1:<port>/p/<provider-id>/<protocol>` 为 base URL；
    /// 代理替换成真实 key，其余原样转发。
    #[command(hide = true)]
    Proxy {
        /// 监听的回环端口 [默认 15722，dev 实例 15723]。
        #[arg(long)]
        port: Option<u16>,
    },

    /// 打印调用方代替真实 key 使用的代理 token（首次使用时创建，存于钥匙串）。
    /// 它只是占位符，不是服务商 key；`--rotate` 会替换它，旧 token 立即失效。
    #[command(hide = true)]
    Token {
        /// 替换 token。
        #[arg(long)]
        rotate: bool,

        /// 输出一个机器可读的 JSON 对象。
        #[arg(long)]
        json: bool,
    },

    /// 把服务商主 API key 存入钥匙串（从 stdin 读取，不回显）。
    ///
    /// `printf %s "$KEY" | berth provider set-key 73`。
    SetKey {
        /// `berth provider list` 里的服务商 id 或名称（唯一，不区分大小写）。
        id: String,

        /// 输出一个机器可读的 JSON 对象。
        #[arg(long)]
        json: bool,
    },

    /// 用已存服务商运行命令（脚本、外部终端里的 Agent、任意工具），子进程拿不到真实 key。
    ///
    /// 子进程只拿到代理地址和占位 token。不带 `--agent` 时按端点设置 SDK 标准变量
    /// （OPENAI_BASE_URL / OPENAI_API_KEY、ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY、
    /// GOOGLE_GEMINI_BASE_URL / GEMINI_API_KEY）以及 BERTH_PROVIDER_<ENDPOINT>_URL、
    /// BERTH_PROVIDER_TOKEN、BERTH_PROVIDER_MODELS。没有代理在跑时临时启动一个。
    /// `berth provider run deepseek --agent claude`（不带命令）像启动栏一样在本终端经 launch.js
    /// 启动 Agent，服务商经代理。示例：`berth provider run deepseek -- python draw.py`。
    Run {
        /// `berth provider list` 里的服务商 id 或名称（唯一，不区分大小写）。
        id: String,

        /// 经 launch.js 启动的 Agent 工具 id（如 claude、codex）；不能再接 `-- <命令>`。
        #[arg(long)]
        agent: Option<String>,

        /// 选用的模型（Agent 默认模型，或 BERTH_PROVIDER_MODEL）。
        #[arg(long)]
        model: Option<String>,

        /// 给读其他变量名的工具补变量：NAME=<endpoint> 设为该端点的代理地址，NAME=token 设为 token
        /// （如 --env DEEPSEEK_API_KEY=token）。可重复。
        #[arg(long = "env", value_name = "NAME=TARGET")]
        mappings: Vec<String>,

        /// Agent launch.js 的启动输入 name=value，与启动栏一致（如 --input expert=dev-expert）。
        /// 可重复；仅在不带 `-- <命令>` 时可用。
        #[arg(long = "input", requires = "agent")]
        input: Vec<String>,

        /// `--` 之后要运行的命令。带 `--agent` 且不给命令时，Agent 经自身 launch.js 启动，与从 Berth 启动完全一致。
        #[arg(last = true)]
        command: Vec<String>,
    },

    /// 以 `export` 行打印 `run` 会设置的同一组变量（不含真实 key）。
    ///
    /// 供 `eval "$(berth provider env 12)"`、shell profile 或（--dotenv）.env 文件使用。
    /// 不启动代理：使用期间保持 Berth 打开。
    Env {
        /// `berth provider list` 里的服务商 id 或名称（唯一，不区分大小写）。
        id: String,

        /// 同时设置 BERTH_PROVIDER_MODEL。
        #[arg(long)]
        model: Option<String>,

        /// 额外变量：NAME=<endpoint> 或 NAME=token。可重复。
        #[arg(long = "env", value_name = "NAME=TARGET")]
        mappings: Vec<String>,

        /// 打印 NAME=value 行（.env 格式）而不是 `export` 行。
        #[arg(long)]
        dotenv: bool,
    },

    /// 把全部自定义服务商导出为不含 key 的 JSON，用于备份。
    ///
    /// `berth provider export > providers.json`。在 设置 → 模型服务商 导入，之后再设置 key。
    Export,

    /// 列出可经代理使用的服务商：id、协议、是否已存 key（不显示 key）以及给调用方的 base URL。
    List {
        /// 打印的 base URL 使用的代理端口 [默认同 `proxy`]。
        #[arg(long)]
        port: Option<u16>,

        /// 输出一个机器可读的 JSON 数组。
        #[arg(long)]
        json: bool,
    },
}

#[derive(Debug, Subcommand)]
enum SessionCommand {
    /// 该 Agent 在该目录最新会话的最后一条 assistant 纯文本。无 sessions.json 声明退出码 7
    /// （kind=unsupported），没有该目录的会话退出码 4。
    Last {
        /// tools/<id> 的工具 id。
        #[arg(long)]
        agent: String,
        /// 会话工作目录（canonicalize 后精确匹配）。
        #[arg(long)]
        cwd: PathBuf,
        /// 正文字节上限，超出截断并标 truncated。
        #[arg(long)]
        max_bytes: Option<usize>,
        #[arg(long)]
        json: bool,
    },
    /// 当前项目（各群目录与子目录）的会话，最近活动在前；列：最后活动、Agent、会话 id、所属群、来源（Berth / 外部 / 未知）
    /// 与是否在跑、首条用户发言。
    #[command(visible_alias = "ls")]
    List {
        /// 只看这个工具 id 的会话。
        #[arg(long)]
        agent: Option<String>,
        /// 只看这个群（群名或群目录名）的会话。
        #[arg(long)]
        group: Option<String>,
        /// 只看在跑的会话（当前在群的成员绑定的会话）。
        #[arg(long)]
        live: bool,
        #[arg(long, default_value_t = 20)]
        limit: usize,
        #[arg(long)]
        json: bool,
    },
    /// 按会话 id 输出用户与助手文本，工具调用折叠为「→ 工具名 目标」；超出字节上限时省略较早的轮次。
    /// 没有该会话退出码 4。
    Show {
        /// `session list` 里的会话 id。
        id: String,
        /// 只在这个工具 id 的会话里找。
        #[arg(long)]
        agent: Option<String>,
        /// 只输出最后 N 轮（在 --grep 之后取）。
        #[arg(long)]
        tail: Option<usize>,
        /// 只输出用户发言。
        #[arg(long)]
        user_only: bool,
        /// 只输出含这个词的轮次（不区分大小写）。
        #[arg(long)]
        grep: Option<String>,
        #[arg(long, default_value_t = 16 * 1024)]
        max_bytes: usize,
        /// 改为输出启动输入：Agent 开工前收到的系统提示、指令文件、技能 / MCP 目录等，各项估算 token
        /// 与首次请求报回的精确总量（`--json` 时含各项原文）。
        #[arg(long)]
        context: bool,
        #[arg(long)]
        json: bool,
    },
}

#[derive(Debug, Subcommand)]
enum TerminalCommand {
    /// 列出 live 终端：TERMINAL 列的 `项目:编号` 可直接给 capture/send 的 -t。
    #[command(visible_alias = "list")]
    Ls {
        /// 只看这个项目：ID、名称（或唯一前缀）、路径。
        #[arg(long)]
        project: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// 在已注册项目会话中创建 shell（或 `--agent` 启动 Agent），直接返回 target_ref，不切换 GUI。
    Create {
        /// 项目 ID、名称（或唯一前缀）、路径，必须明确提供。
        #[arg(long)]
        project: String,
        /// 执行 `tools/<id>/launch.js`，argv 与 GUI 启动栏一致。
        #[arg(long)]
        agent: Option<String>,
        /// 启动输入 name=value（字符串），可重复。
        #[arg(long = "input", requires = "agent")]
        input: Vec<String>,
        /// 启动输入 JSON 对象文件。
        #[arg(long, requires = "agent")]
        inputs_file: Option<PathBuf>,
        /// 模型服务商档案 ID（与 GUI 启动栏所选同一 id），写成启动档案交给 launch.js。
        #[arg(long, requires = "agent", value_parser = clap::value_parser!(i32).range(1..))]
        provider_id: Option<i32>,
        /// 启动模型 id（`$model`）；需同时给出 --provider-id。
        #[arg(long, requires = "provider_id")]
        model_id: Option<String>,
        /// 工作目录：项目根、其子目录或共享 git common dir 的 worktree。
        #[arg(long)]
        cwd: Option<PathBuf>,
        #[arg(long)]
        json: bool,
    },
    /// 在当前终端里接入一个项目的全部终端（手机 / SSH 远程用）；`C-b d` 退出，终端继续跑。
    #[command(after_long_help = ATTACH_KEYS)]
    Attach {
        /// 项目 ID、名称（或唯一前缀）、路径。
        #[arg(short = 's', long = "project")]
        session: String,
    },
    /// 查看 GUI 当前选中的可见终端。
    Current {
        #[arg(long)]
        json: bool,
    },
    /// 读取终端末尾的纯文本。
    Capture {
        /// 终端：编号（自己项目内）、`项目:编号`（见 terminal ls）或 target_ref。
        #[arg(short = 't', long = "target-ref", visible_alias = "target")]
        target_ref: String,
        #[arg(long)]
        lines: Option<u32>,
        #[arg(long)]
        json: bool,
    },
    /// 向终端发送文字或一个按键。
    Send {
        /// 终端：编号（自己项目内）、`项目:编号`（见 terminal ls）或 target_ref。
        #[arg(short = 't', long = "target-ref", visible_alias = "target")]
        target_ref: String,
        #[arg(long, allow_hyphen_values = true)]
        text: Option<String>,
        #[arg(long)]
        key: Option<String>,
        /// 以括号粘贴写入 --text（不含 Enter）；pane 未开启括号粘贴时拒绝（kind=paste_unsupported）。
        #[arg(long, requires = "text")]
        paste: bool,
        #[arg(long)]
        json: bool,
    },
    /// 关闭终端（结束其中的进程），与 GUI 关闭终端相同。
    Close {
        /// 终端：编号（自己项目内）、`项目:编号`（见 terminal ls）或 target_ref。
        #[arg(short = 't', long = "target-ref", visible_alias = "target")]
        target_ref: String,
        #[arg(long)]
        json: bool,
    },
}

#[derive(Debug)]
struct CliError {
    exit_code: u8,
    message: String,
    json_message: Option<String>,
}

impl CliError {
    fn user(message: impl Into<String>) -> Self {
        Self {
            exit_code: EXIT_USER_ERROR,
            message: message.into(),
            json_message: None,
        }
    }

    fn not_found(message: impl Into<String>) -> Self {
        Self {
            exit_code: EXIT_TARGET_NOT_FOUND,
            message: message.into(),
            json_message: None,
        }
    }

    fn rejected(message: impl Into<String>) -> Self {
        Self {
            exit_code: EXIT_REJECTED,
            message: message.into(),
            json_message: None,
        }
    }

    /// 用户输入错误 + 机器信封（信封码与退出码同为 2）。
    fn user_json(message: impl Into<String>, json_message: String) -> Self {
        Self {
            exit_code: EXIT_USER_ERROR,
            message: message.into(),
            json_message: Some(json_message),
        }
    }

    /// 只带退出码的失败：输出已经由业务路径打印。
    fn silent(exit_code: u8) -> Self {
        Self {
            exit_code,
            message: String::new(),
            json_message: None,
        }
    }

    fn from_runtime(error: impl ToString) -> Self {
        let message = error.to_string();
        let exit_code = if message.contains("not found")
            || message.contains("can't find")
            || message.contains("does not exist")
        {
            EXIT_TARGET_NOT_FOUND
        } else {
            EXIT_DAEMON_UNAVAILABLE
        };
        Self {
            exit_code,
            message,
            json_message: None,
        }
    }

    fn from_gui(error: gui_client::GuiClientError, json: bool) -> Self {
        Self {
            exit_code: error.exit_code,
            message: error.message.clone(),
            json_message: json.then(|| gui_client::error_json(&error)),
        }
    }
}

/// 作用于单个项目的命令：写成 berth project <项目> <命令> …
const PROJECT_SCOPED: [&str; 5] = ["knowledge", "task", "group", "session", "expert"];

/// berth [选项] project <项目> <项目级命令> … → (`<项目>`, 去掉 `project <项目>` 的 argv)。
/// 其他形式原样返回、项目为 `None`。项目级命令都按当前目录找项目，调用方切到项目目录后照常解析。
fn split_project_scope(mut args: Vec<OsString>) -> (Option<String>, Vec<OsString>) {
    // 跳过全局选项（`-L/-S/--gui` 带值），第一个位置参数是 `project` 才算。
    let mut index = 1;
    while let Some(arg) = args.get(index).and_then(|arg| arg.to_str()) {
        match arg {
            "-L" | "-S" | "--gui" => index += 2,
            _ if arg.starts_with('-') => index += 1,
            _ => break,
        }
    }
    let token = |offset: usize| args.get(index + offset).and_then(|arg| arg.to_str());
    match (token(0), token(1), token(2)) {
        (Some("project"), Some(project), Some(command)) if PROJECT_SCOPED.contains(&command) => {
            let project = project.to_owned();
            args.drain(index..index + 2);
            (Some(project), args)
        }
        _ => (None, args),
    }
}

fn main() -> ExitCode {
    let (project, args) = split_project_scope(std::env::args_os().collect());
    if let Some(project) = project {
        let entered = project::project_dir(&project).and_then(|dir| {
            std::env::set_current_dir(&dir)
                .map_err(|error| CliError::user(format!("{}: {error}", dir.display())))
        });
        if let Err(error) = entered {
            eprintln!("berth: {}", error.message);
            return ExitCode::from(error.exit_code);
        }
    }
    let cli = Cli::try_parse_from(args).unwrap_or_else(|error| {
        if error.use_stderr()
            && std::env::args_os().any(|arg| arg.as_os_str() == OsStr::new("--json"))
        {
            println!("{}", clap_error_json(&error));
            std::process::exit(i32::from(EXIT_USER_ERROR));
        }
        error.exit()
    });
    match run(cli) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            if let Some(json) = error.json_message {
                println!("{json}");
            } else if !error.message.is_empty() {
                eprintln!("berth: {}", error.message);
            }
            ExitCode::from(error.exit_code)
        }
    }
}

fn clap_error_json(error: &clap::Error) -> String {
    serde_json::json!({ "error": { "kind": "invalid_params", "message": error.to_string() } })
        .to_string()
}

fn terminal_runtime_error(error: std::io::Error, json: bool) -> CliError {
    let message = format!("failed to initialize terminal runtime: {error}");
    let json_message = json.then(|| {
        serde_json::json!({ "error": { "kind": "rejected", "message": message } }).to_string()
    });
    CliError {
        exit_code: EXIT_REJECTED,
        message,
        json_message,
    }
}

fn run(cli: Cli) -> Result<(), CliError> {
    // tools 子命令只读写插件文件，不连接 daemon。
    if let Command::Tools { command } = cli.command {
        return tools::run(command);
    }
    // GUI 控制面命令不连接终端 daemon。
    let gui_endpoint = cli.gui.as_ref();
    match &cli.command {
        Command::Gui {
            command: GuiCommand::Status { json },
        } => {
            return gui_client::status(gui_endpoint, *json)
                .map_err(|error| CliError::from_gui(error, *json));
        }
        Command::Project {
            command:
                ProjectCommand::CurrentFile {
                    lines,
                    offset,
                    snapshot_ref,
                    json,
                },
        } => {
            return gui_client::current_file(
                gui_endpoint,
                berth_control_proto::WorkspaceDocumentParams {
                    lines: *lines,
                    offset: *offset,
                    snapshot_ref: snapshot_ref.clone(),
                },
                *json,
            )
            .map_err(|error| CliError::from_gui(error, *json));
        }
        Command::Terminal {
            command: TerminalCommand::Current { json },
        } => {
            return gui_client::current_terminal(gui_endpoint, *json)
                .map_err(|error| CliError::from_gui(error, *json));
        }
        Command::Provider {
            command: ProviderCommand::Proxy { port },
        } => return provider_proxy::run(*port),
        Command::Provider {
            command: ProviderCommand::List { port, json },
        } => return provider_proxy::list(*port, *json),
        Command::Provider {
            command: ProviderCommand::Token { rotate, json },
        } => return provider_proxy::token(*rotate, *json),
        Command::Provider {
            command: ProviderCommand::SetKey { id, json },
        } => return provider_proxy::set_key(id, *json),
        Command::Provider {
            command: ProviderCommand::Export,
        } => return provider_proxy::export(),
        Command::Provider {
            command:
                ProviderCommand::Run {
                    id,
                    agent,
                    model,
                    mappings,
                    input,
                    command,
                },
        } => {
            let inputs = match agent {
                Some(_) if !input.is_empty() => {
                    tools::inputs::collect(None, input, "provider.run", false)?
                }
                _ => Default::default(),
            };
            return provider_run::run(
                id,
                agent.as_deref(),
                model.as_deref(),
                mappings,
                &inputs,
                command,
            );
        }
        Command::Provider {
            command:
                ProviderCommand::Env {
                    id,
                    model,
                    mappings,
                    dotenv,
                },
        } => return provider_run::print_env(id, model.as_deref(), mappings, *dotenv),
        Command::Session {
            command:
                SessionCommand::Last {
                    agent,
                    cwd,
                    max_bytes,
                    json,
                },
        } => return session::last(agent, cwd, *max_bytes, *json),
        Command::Session {
            command:
                SessionCommand::List {
                    agent,
                    group,
                    live,
                    limit,
                    json,
                },
        } => {
            let options = session::ListOptions {
                agent: agent.clone(),
                group: group.clone(),
                live: *live,
                limit: *limit,
            };
            return session::list(&options, *json);
        }
        Command::Session {
            command:
                SessionCommand::Show {
                    id,
                    agent,
                    tail,
                    user_only,
                    grep,
                    max_bytes,
                    context,
                    json,
                },
        } => {
            let options = session::ShowOptions {
                tail: *tail,
                user_only: *user_only,
                grep: grep.clone(),
                max_bytes: *max_bytes,
                context: *context,
            };
            return session::show(id, agent.as_deref(), &options, *json);
        }
        Command::Project {
            command: ProjectCommand::Ls { scope, json },
        } => {
            let scope = parse_project_scope(scope)?;
            return project::list(scope, *json);
        }
        Command::Project {
            command: ProjectCommand::Add { path, json },
        } => {
            // GUI 在跑就交给它（写库 + 刷新界面）；不在（含无显示的 SSH / 服务器）直接写库，不为此拉起 GUI。
            let path = path.display().to_string();
            return match gui_client::project_add(gui_endpoint, path.clone(), *json) {
                Err(error) if error.exit_code == EXIT_GUI_UNAVAILABLE => project::add(&path, *json),
                result => result.map_err(|error| CliError::from_gui(error, *json)),
            };
        }
        Command::Open {
            target,
            line,
            wait,
            timeout,
            json,
        } => {
            if let Some(timeout) = timeout {
                if *timeout == 0 || *timeout > OPEN_TIMEOUT_MAX_SECS {
                    return Err(CliError::user(format!(
                        "--timeout must be between 1 and {OPEN_TIMEOUT_MAX_SECS} seconds"
                    )));
                }
            }
            return gui_client::open(
                gui_endpoint,
                target,
                *line,
                *wait,
                timeout.unwrap_or(crate::OPEN_TIMEOUT_DEFAULT_SECS),
                *json,
            )
            .map_err(|error| CliError::from_gui(error, *json));
        }
        _ => {}
    }

    match &cli.command {
        Command::Group { .. } | Command::Expert { .. } => {
            // `berth project . expert …` 是 `berth group expert …`（同一套群账本与终端探测）。
            let args: Vec<OsString> = match &cli.command {
                Command::Expert { args } => std::iter::once(OsString::from("expert")).chain(args.iter().cloned()).collect(),
                Command::Group { args } => args.clone(),
                _ => unreachable!(),
            };
            // 与 `berth terminal` 同一规则：显式指定（`-S` / `-L`）或在 Berth 终端里用它的端点，
            // 否则用默认端点（SSH 进来的外部 shell 也能当场送达）。默认端点与数据实例由同一套
            // 环境决定（dev 实例经 `bin/berth` 设 `BERTH_TMPDIR` / `BERTH_DATA_DIR`），终端引用
            // 带实例键，别的实例的成员由 `foreign` 跳过。默认端点不存在（无 termd 的服务器）
            // 时不连，消息排队。
            let explicit = cli.socket_path.is_some()
                || cli.socket_name.is_some()
                || std::env::var_os("BERTH").is_some();
            let socket = resolve_endpoint(cli.socket_name.as_deref(), cli.socket_path.as_deref())
                .ok()
                .map(LocalEndpoint::into_path)
                .filter(|path| explicit || path.exists());
            std::process::exit(group::run(&args, socket, gui_endpoint));
        }
        Command::Task(args) => {
            std::process::exit(task::run(args));
        }
        Command::Init { path, json }
        | Command::Project {
            command: ProjectCommand::Init { path, json },
        } => {
            return init::run(path.clone(), *json).map_err(CliError::from_runtime);
        }
        Command::Knowledge {
            command: KnowledgeCommand::Root,
        } => {
            let root = knowledge::root().map_err(CliError::from_runtime)?;
            println!("{}", root.display());
            return Ok(());
        }
        Command::Knowledge {
            command:
                KnowledgeCommand::Search {
                    query,
                    note_type,
                    limit,
                    json,
                },
        } => {
            return knowledge::search(&query.join(" "), note_type.as_deref(), *limit, *json)
                .map_err(CliError::from_runtime);
        }
        Command::Knowledge {
            command: KnowledgeCommand::For { path, json },
        } => {
            return knowledge::covering(path, *json).map_err(CliError::from_runtime);
        }
        Command::Knowledge {
            command: KnowledgeCommand::Show { name, links, json },
        } => {
            return knowledge::show(&name.join(" "), *links, *json)
                .map_err(CliError::from_runtime);
        }
        Command::Knowledge {
            command: KnowledgeCommand::Lint { json },
        } => {
            let code = knowledge::lint(*json).map_err(CliError::from_runtime)?;
            std::process::exit(code);
        }
        Command::Knowledge {
            command: KnowledgeCommand::Idea { command },
        } => {
            return match command {
                IdeaCommand::Add { text, json } => knowledge::idea_add(&text.join(" "), *json),
                IdeaCommand::Ls { status, json } => knowledge::idea_ls(status.as_deref(), *json),
                IdeaCommand::Show { id } => knowledge::idea_show(id),
                IdeaCommand::Status { id, status } => knowledge::idea_status(id, status),
                IdeaCommand::Discuss { id, text, author } => {
                    knowledge::idea_discuss(id, author, &text.join(" "))
                }
                IdeaCommand::Promote { id, title } => knowledge::idea_promote(id, title.as_deref()),
                IdeaCommand::Close { id, note, task, commit, drop } => {
                    use berth_project_core::knowledge::ideas::Conclusion;
                    let conclusion = match (note, task, commit, drop) {
                        (Some(title), ..) => Conclusion::Note(title.clone()),
                        (_, Some(slug), ..) => Conclusion::Task(slug.clone()),
                        (_, _, Some(sha), _) => Conclusion::Commit(sha.clone()),
                        (.., Some(reason)) => Conclusion::Drop(reason.clone()),
                        _ => unreachable!("clap requires one conclusion"),
                    };
                    knowledge::idea_close(id, &conclusion)
                }
            }
            .map_err(CliError::from_runtime);
        }
        Command::Knowledge {
            command: KnowledgeCommand::Digest { since, json },
        } => {
            return knowledge::digest(gui_endpoint, since.clone(), *json);
        }
        Command::Guide { check: true, .. } => {
            let problems = guide::check();
            for line in &problems {
                println!("{line}");
            }
            if problems.is_empty() {
                println!("用户补充里的命令都能解析");
                return Ok(());
            }
            std::process::exit(1);
        }
        Command::Guide {
            topic: Some(topic), ..
        } => {
            print!("{}", guide::topic(topic).map_err(CliError::user)?);
            return Ok(());
        }
        Command::Guide { brief, .. } => {
            // 在任务 worktree 里启动的 Agent 额外知道自己的任务，并自动入群。
            let socket = resolve_endpoint(cli.socket_name.as_deref(), cli.socket_path.as_deref())
                .ok()
                .map(LocalEndpoint::into_path);
            let cwd = std::env::current_dir().ok();
            let task = cwd
                .as_deref()
                .and_then(|cwd| group::brief_lines(cwd, socket))
                .unwrap_or_default();
            let expert = cwd.as_deref().and_then(expert_brief).unwrap_or_default();
            let text = include_str!("brief.md")
                .replace("{berth}", &format!("{}{task}{expert}", init::brief_line()));
            print!("{}", guide::with_supplement("brief", &tools::brief(&text)));
            if !brief {
                print!("\n{}", guide::with_supplement("guide", include_str!("guide.md")));
                print!("{}", guide::topic_index());
            }
            return Ok(());
        }
        Command::InstallShim => {
            let path = shim::install().map_err(CliError::from_runtime)?;
            println!("installed {}", path.display());
            return Ok(());
        }
        Command::UninstallShim => {
            let path = shim::uninstall().map_err(CliError::from_runtime)?;
            println!("removed {}", path.display());
            return Ok(());
        }
        Command::Remote { command } => {
            std::process::exit(match command {
                RemoteCommand::Exec { cwd, cwd_file, command } => {
                    remote::exec(command, cwd.clone(), cwd_file.clone())
                }
                RemoteCommand::Hook => remote::hook(),
            });
        }
        Command::Doctor => {
            for line in shim::diagnose(gui_endpoint).map_err(CliError::from_runtime)? {
                println!("{line}");
            }
            for line in guide::check() {
                println!("guide: {line}");
            }
            return Ok(());
        }
        _ => {}
    }

    let terminal_json = matches!(
        &cli.command,
        Command::Terminal {
            command: TerminalCommand::Ls { json: true, .. }
                | TerminalCommand::Create { json: true, .. }
                | TerminalCommand::Capture { json: true, .. }
                | TerminalCommand::Send { json: true, .. }
                | TerminalCommand::Close { json: true, .. }
        }
    );
    let socket = resolve_endpoint(cli.socket_name.as_deref(), cli.socket_path.as_deref())
        .map(LocalEndpoint::into_path)
        .map_err(|error| {
            if terminal_json {
                CliError::user_json(error.to_string(), serde_json::json!({ "error": { "kind": "invalid_params", "message": error.to_string() } }).to_string())
            } else {
                CliError::from_runtime(error)
            }
        })?;
    match cli.command {
        Command::Attach { session }
        | Command::Terminal {
            command: TerminalCommand::Attach { session },
        } => attach(&socket, &session),
        Command::Lock {
            name,
            release,
            command,
        } => lock(&socket, &name, release, &command),
        Command::Terminal { command } => {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|error| terminal_runtime_error(error, terminal_json))?;
            runtime.block_on(async {
                match command {
                    TerminalCommand::Ls { project, json } => {
                        let project = match project {
                            Some(query) => {
                                Some(workspace_terminal::resolve_project_id(&query, json).await?)
                            }
                            None => None,
                        };
                        workspace_terminal::list(&socket, project, json).await
                    }
                    TerminalCommand::Create {
                        project,
                        agent,
                        input,
                        inputs_file,
                        provider_id,
                        model_id,
                        cwd,
                        json,
                    } => {
                        let project =
                            workspace_terminal::resolve_project_id(&project, json).await?;
                        let agent = match agent {
                            Some(tool) => {
                                let inputs = tools::inputs::collect(
                                    inputs_file.as_deref(),
                                    &input,
                                    "terminal.create",
                                    json,
                                )?;
                                Some((tool, inputs))
                            }
                            None => None,
                        };
                        workspace_terminal::create(
                            &socket,
                            gui_endpoint,
                            project,
                            agent,
                            provider_id,
                            model_id.as_deref(),
                            cwd.as_deref(),
                            json,
                        )
                        .await
                    }
                    TerminalCommand::Capture {
                        target_ref,
                        lines,
                        json,
                    } => workspace_terminal::capture(&socket, &target_ref, lines, json).await,
                    TerminalCommand::Send {
                        target_ref,
                        text,
                        key,
                        paste,
                        json,
                    } => {
                        workspace_terminal::send(&socket, &target_ref, text, key, paste, json).await
                    }
                    TerminalCommand::Close { target_ref, json } => {
                        workspace_terminal::close(&socket, &target_ref, json).await
                    }
                    TerminalCommand::Current { .. } | TerminalCommand::Attach { .. } => {
                        unreachable!("GUI probe and attach are handled before the async runtime")
                    }
                }
            })
        }
        command => {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(CliError::from_runtime)?;
            runtime.block_on(run_control(command, socket))
        }
    }
}

async fn run_control(command: Command, socket: PathBuf) -> Result<(), CliError> {
    let terminal = connect_sdk(&socket).await?;
    match command {
        Command::Ls => list_sessions(&terminal).await,
        Command::Attach { .. } | Command::Lock { .. } | Command::Group { .. } | Command::Expert { .. } | Command::Task(..) => {
            unreachable!("attach and lock are handled before creating the async runtime")
        }
        Command::InstallShim
        | Command::UninstallShim
        | Command::Doctor
        | Command::Remote { .. }
        | Command::Guide { .. }
        | Command::Init { .. }
        | Command::Knowledge { .. } => {
            unreachable!("shim commands are handled before connecting to the daemon")
        }
        Command::Gui { .. }
        | Command::Project { .. }
        | Command::Terminal { .. }
        | Command::Session { .. }
        | Command::Provider { .. }
        | Command::Open { .. } => {
            unreachable!("GUI commands are handled before connecting to the daemon")
        }
        Command::Tools { .. } => {
            unreachable!("tools commands are handled before connecting to the daemon")
        }
    }
}

fn parse_project_scope(value: &str) -> Result<berth_control_proto::ProjectScope, CliError> {
    match value {
        "all" => Ok(berth_control_proto::ProjectScope::All),
        "open" => Ok(berth_control_proto::ProjectScope::Open),
        other => Err(CliError::user(format!(
            "invalid scope '{other}'; expected 'all' or 'open'"
        ))),
    }
}

async fn connect_sdk(socket: &Path) -> Result<Terminal, CliError> {
    TerminalClientBuilder::new()
        .unix_socket(socket.to_path_buf())
        .connect_or_start()
        .await
        .map_err(CliError::from_runtime)
}

/// 数据实例的项目目录与命名空间；实例不可用时为 `None`，ls / attach 退回按 cwd 展示与匹配。
async fn project_catalog() -> Option<(String, Vec<CatalogEntry>)> {
    let instance = project::resolve_instance(false).ok()?;
    let catalog = project::catalog_entries(&instance, berth_control_proto::ProjectScope::All)
        .await
        .ok()?;
    Some((instance.namespace_key().ok()?, catalog))
}

/// 会话所属的已注册项目。
fn session_project<'a>(
    session: &str,
    catalog: &'a Option<(String, Vec<CatalogEntry>)>,
) -> Option<&'a CatalogEntry> {
    let (namespace, entries) = catalog.as_ref()?;
    match classify_session(session, namespace, entries) {
        SessionOwnership::Project(entry) => Some(entry),
        _ => None,
    }
}

/// 属于其他数据实例（正式版 / dev）的项目会话，与 `terminal ls` 一样不列出。
fn is_foreign_session(session: &str, catalog: &Option<(String, Vec<CatalogEntry>)>) -> bool {
    catalog.as_ref().is_some_and(|(namespace, entries)| {
        matches!(
            classify_session(session, namespace, entries),
            SessionOwnership::Foreign
        )
    })
}

async fn list_sessions(terminal: &Terminal) -> Result<(), CliError> {
    let sessions = terminal
        .list_sessions()
        .await
        .map_err(CliError::from_runtime)?;
    if sessions.is_empty() {
        println!("no live terminals");
        return Ok(());
    }

    let panes = terminal
        .find_panes()
        .all()
        .await
        .map_err(CliError::from_runtime)?;
    let catalog = project_catalog().await;
    println!("{:<20} {:<5} {:<9} PATH", "PROJECT", "ID", "TERMINALS");
    for session in sessions
        .into_iter()
        .filter(|session| !is_foreign_session(session.as_str(), &catalog))
    {
        let session_panes = panes
            .iter()
            .filter(|pane| pane.session_name == session)
            .collect::<Vec<_>>();
        let windows = session_panes
            .iter()
            .map(|pane| pane.window_index)
            .collect::<BTreeSet<_>>();
        // 项目会话名是哈希键，只显示项目名；未注册的会话（独立 / 外部）原样显示会话名。
        let (name, id, path) = match session_project(session.as_str(), &catalog) {
            Some(entry) => (entry.name.clone(), entry.id.to_string(), entry.path.clone()),
            None => {
                let cwd = session_panes
                    .iter()
                    .find_map(|pane| pane.working_directory.clone())
                    .filter(|cwd| !cwd.is_empty())
                    .unwrap_or_else(|| "-".to_owned());
                (session.to_string(), "-".to_owned(), cwd)
            }
        };
        println!("{name:<20} {id:<5} {:<9} {path}", windows.len());
    }
    Ok(())
}

/// 未注册目录的会话按 pane cwd 的末段名匹配 attach 参数。
fn project_label(cwd: &str) -> &str {
    let trimmed = cwd.trim().trim_end_matches(['/', '\\']);
    if trimmed.is_empty() {
        return "-";
    }
    trimmed
        .rsplit(['/', '\\'])
        .find(|part| !part.is_empty())
        .unwrap_or(trimmed)
}

fn pane_matches_project(pane: &DiscoveredPane, query: &str) -> bool {
    let query = query.trim();
    if query.is_empty() {
        return false;
    }
    let cwd = pane.working_directory.as_deref().unwrap_or_default();
    let normalized_query = query.trim_end_matches(['/', '\\']);
    cwd == query
        || cwd == normalized_query
        || project_label(cwd) == query
        || project_label(cwd).starts_with(query)
}

async fn resolve_attach_target(terminal: &Terminal, query: &str) -> Result<SessionName, CliError> {
    let query = query.trim();
    if query.is_empty() {
        return Err(CliError::user("session or project name cannot be empty"));
    }

    let sessions = terminal
        .list_sessions()
        .await
        .map_err(CliError::from_runtime)?;
    if let Some(exact) = sessions.iter().find(|session| session.as_str() == query) {
        return Ok(exact.clone());
    }
    // 已注册项目按 ID / 名称 / 路径匹配；未注册目录再退回按 pane cwd 匹配。
    let catalog = project_catalog().await;
    if let Some((_, entries)) = &catalog {
        match project::match_project(entries, query) {
            Ok(entry) => {
                return sessions
                    .iter()
                    .find(|session| {
                        session_project(session.as_str(), &catalog)
                            .is_some_and(|owner| owner.id == entry.id)
                    })
                    .cloned()
                    .ok_or_else(|| {
                        CliError::not_found(format!(
                            "project '{}' has no live terminals; open one in Berth or run `berth terminal create --project {}`",
                            entry.name, entry.id
                        ))
                    });
            }
            Err((EXIT_TARGET_NOT_FOUND, _)) => {}
            Err((code, message)) => {
                return Err(CliError {
                    exit_code: code,
                    message,
                    json_message: None,
                })
            }
        }
    }

    let panes = terminal
        .find_panes()
        .all()
        .await
        .map_err(CliError::from_runtime)?;
    let mut matches = BTreeSet::new();
    for pane in panes
        .iter()
        .filter(|pane| pane_matches_project(pane, query))
    {
        matches.insert(pane.session_name.to_string());
    }

    match matches.len() {
        1 => Ok(matches
            .into_iter()
            .next()
            .map(|session| parse_session(&session))
            .expect("one match is present")?),
        0 => Err(CliError {
            exit_code: EXIT_TARGET_NOT_FOUND,
            message: format!("no session or project matches '{query}'"),
            json_message: None,
        }),
        _ => {
            let choices = matches
                .into_iter()
                .map(|session| session.to_string())
                .collect::<Vec<_>>()
                .join(", ");
            Err(CliError::user(format!(
                "project '{query}' is ambiguous; matching sessions: {choices}"
            )))
        }
    }
}

/// 在 termd 的 server-local FIFO 锁内执行命令；命令的退出码原样传播。
fn lock(socket: &Path, name: &str, release: bool, command: &[String]) -> Result<(), CliError> {
    use berth_term_proto::{Request, Response, WaitForMode, WaitForRequest};
    let mut connection = connect(socket).map_err(CliError::from_runtime)?;
    // 排队可能很久：取消读超时。
    connection
        .wait_without_timeout()
        .map_err(CliError::from_runtime)?;
    let mut call = |mode| {
        let request = Request::WaitFor(WaitForRequest {
            channel: name.to_owned(),
            mode,
        });
        match connection.roundtrip(&request) {
            Ok(Response::WaitFor(_)) => Ok(()),
            Ok(Response::Error(error)) => Err(CliError::rejected(error.error.to_string())),
            Ok(other) => Err(CliError::rejected(format!(
                "unexpected response: {other:?}"
            ))),
            Err(error) => Err(CliError::from_runtime(error)),
        }
    };
    if release {
        return call(WaitForMode::Unlock);
    }
    call(WaitForMode::Lock)?;
    // 持锁期间 Ctrl-C / SIGTERM 交给子进程处理，自己留下来解锁；
    // 处理函数（非 SIG_IGN）在 exec 时复位，子进程仍按默认方式响应。
    #[cfg(unix)]
    for signal in [signal_hook::consts::SIGINT, signal_hook::consts::SIGTERM] {
        let _ = signal_hook::flag::register(signal, Default::default());
    }
    let status = std::process::Command::new(&command[0])
        .args(&command[1..])
        .status();
    call(WaitForMode::Unlock)?;
    let status = status.map_err(|error| CliError::user(format!("{}: {error}", command[0])))?;
    match status.code() {
        Some(0) => Ok(()),
        code => Err(CliError::silent(code.map_or(1, |code| code as u8))),
    }
}

fn attach(socket: &Path, session: &str) -> Result<(), CliError> {
    let target = {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(CliError::from_runtime)?;
        runtime.block_on(async {
            let terminal = connect_sdk(socket).await?;
            resolve_attach_target(&terminal, session).await
        })?
    };
    ensure_daemon_running(socket)?;
    let connection = connect(socket).map_err(CliError::from_runtime)?;
    match connection
        .begin_attach(target)
        .map_err(CliError::from_runtime)?
    {
        AttachTransition::Upgraded(upgrade) => {
            let (stream, initial_bytes) = upgrade.into_parts();
            attach_terminal_with_initial_bytes(stream, initial_bytes)
                .map_err(CliError::from_runtime)
        }
        AttachTransition::Rejected(response) => Err(CliError::from_runtime(format!(
            "attach rejected: {response:?}"
        ))),
    }
}

/// Ensures the daemon is reachable at `socket`, auto-starting it through the
/// shared SDK launch path when absent. This is the same auto-start logic the
/// GUI uses, so both frontends resolve the daemon identically.
fn ensure_daemon_running(socket: &Path) -> Result<(), CliError> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(CliError::from_runtime)?;
    runtime
        .block_on(async {
            Terminal::builder()
                .unix_socket(socket.to_path_buf())
                .connect_or_start()
                .await
        })
        .map(|_| ())
        .map_err(CliError::from_runtime)
}

fn parse_session(value: &str) -> Result<SessionName, CliError> {
    SessionName::new(value).map_err(|error| CliError::user(error.to_string()))
}

/// 启动栏选了专家时（pane 环境里的 `BERTH_LAUNCH_INPUTS`）：交接确切路径，以及用户给它定的规矩。
fn expert_brief(cwd: &std::path::Path) -> Option<String> {
    let inputs: serde_json::Value = serde_json::from_str(&std::env::var("BERTH_LAUNCH_INPUTS").ok()?).ok()?;
    let expert = berth_tool_core::paths::launch_expert_any(&berth_tool_core::paths::tools_root(), &inputs)?;
    let vault = berth_project_core::knowledge::vault_project(cwd);
    let mut lines = format!(
        "- 你是专家 `{expert}`：之前的交接在 `.berth/knowledge/交接/{expert}/索引.md`（接手或用户问起时读）\n"
    );
    if let Some(rules) = berth_project_core::knowledge::rules::brief(&vault, &expert) {
        let file = berth_project_core::knowledge::rules::rules_file(&expert);
        lines.push_str(&format!("- 用户给你定的规矩（`{file}`），照做，不用用户再说：\n"));
        for rule in rules.lines() {
            lines.push_str(&format!("  {rule}\n"));
        }
    }
    Some(lines)
}

#[cfg(test)]
mod tests {
    use super::guide::{documented_commands, parse_documented};
    use super::{project_label, Cli, Command, ProjectCommand, TerminalCommand};
    use clap::Parser;

    #[test]
    fn project_scope_is_split_only_for_project_commands() {
        let split = |line: &str| {
            let (project, args) =
                super::split_project_scope(line.split(' ').map(Into::into).collect());
            let args = args.iter().map(|arg| arg.to_string_lossy().into_owned()).collect::<Vec<_>>();
            (project, args.join(" "))
        };
        assert_eq!(
            split("berth -L s project codeg knowledge search x"),
            (Some("codeg".into()), "berth -L s knowledge search x".into())
        );
        assert_eq!(split("berth project . task list"), (Some(".".into()), "berth task list".into()));
        // 项目自己的子命令、非项目级命令、出现在参数里的 project 都不改写。
        for line in ["berth project ls", "berth project codeg terminal ls", "berth knowledge search project x task"] {
            assert_eq!(split(line), (None, line.into()));
        }
    }

    /// Agent 与用户能看到的说明里每条命令都必须能被当前 CLI 解析：改了命令没改说明，这里失败。
    #[test]
    fn documented_commands_parse() {
        const SOURCES: &[(&str, &str)] = &[
            ("brief.md", include_str!("brief.md")),
            ("guide.md", include_str!("guide.md")),
            ("knowledge.md", include_str!("knowledge.md")),
            ("main.rs", include_str!("main.rs")),
            ("task.rs", include_str!("task.rs")),
            ("init.rs", include_str!("init.rs")),
            ("group/mod.rs", include_str!("group/mod.rs")),
            ("berth-group/watch.rs", include_str!("../../../../project/berth-group/src/watch.rs")),
            ("tools/describe.rs", include_str!("tools/describe.rs")),
        ];
        let mut checked = 0;
        let mut invalid = Vec::new();
        for (file, text) in SOURCES {
            for command in documented_commands(text) {
                checked += 1;
                if let Err(error) = parse_documented(&command) {
                    let reason = error.lines().next().unwrap_or_default().to_owned();
                    invalid.push(format!("{file}: {command}\n    {reason}"));
                }
            }
        }
        let long_about = super::LONG_ABOUT
            .lines()
            .map(str::trim)
            .filter(|line| line.starts_with("berth "))
            .map(|line| line.split("  ").next().unwrap_or(line).to_owned());
        for command in long_about {
            checked += 1;
            if let Err(error) = parse_documented(&command) {
                invalid.push(format!("LONG_ABOUT: {command}\n    {error}"));
            }
        }
        assert!(checked > 20, "only {checked} documented commands found");
        assert!(
            invalid.is_empty(),
            "{} documented commands no longer parse:\n{}",
            invalid.len(),
            invalid.join("\n")
        );
    }

    #[test]
    fn project_label_uses_the_last_non_empty_path_component() {
        assert_eq!(project_label("/home/user/projects/berth/"), "berth");
        assert_eq!(project_label("C:\\work\\berth"), "berth");
        assert_eq!(project_label(""), "-");
    }

    #[test]
    fn invalid_json_mode_arguments_have_one_machine_error() {
        for args in [
            &[
                "berth",
                "project",
                "current-file",
                "--lines",
                "invalid",
                "--json",
            ][..],
            &[
                "berth",
                "terminal",
                "capture",
                "--target-ref",
                "v1.ref",
                "--lines",
                "invalid",
                "--json",
            ][..],
        ] {
            let error = Cli::try_parse_from(args).expect_err("invalid CLI input");
            let value: serde_json::Value =
                serde_json::from_str(&super::clap_error_json(&error)).unwrap();
            assert_eq!(value["error"]["kind"], "invalid_params");
            assert!(value["error"]["message"].as_str().is_some());
        }
    }

    #[test]
    fn terminal_runtime_failure_preserves_the_json_error_contract() {
        let error = super::terminal_runtime_error(std::io::Error::other("synthetic failure"), true);
        assert_eq!(error.exit_code, super::EXIT_REJECTED);
        let value: serde_json::Value =
            serde_json::from_str(error.json_message.as_deref().unwrap()).unwrap();
        assert_eq!(value["error"]["kind"], "rejected");
        assert!(value["error"]["message"]
            .as_str()
            .unwrap()
            .contains("synthetic failure"));

        let plain =
            super::terminal_runtime_error(std::io::Error::other("synthetic failure"), false);
        assert_eq!(plain.exit_code, super::EXIT_REJECTED);
        assert!(plain.json_message.is_none());
    }

    #[test]
    fn terminal_send_parses_hyphenated_text_as_literal_input() {
        for literal in ["-n", "--json", "第一行\n第二行🌍"] {
            for json in [false, true] {
                let mut args = vec![
                    "berth",
                    "terminal",
                    "send",
                    "--target-ref",
                    "v1.ref",
                    "--text",
                    literal,
                ];
                if json {
                    args.push("--json");
                }
                let cli = Cli::try_parse_from(args).expect("literal text must parse");
                match cli.command {
                    Command::Terminal {
                        command:
                            TerminalCommand::Send {
                                text,
                                key,
                                json: parsed_json,
                                ..
                            },
                    } => {
                        assert_eq!(text.as_deref(), Some(literal));
                        assert!(key.is_none());
                        assert_eq!(parsed_json, json);
                    }
                    _ => panic!("expected terminal send"),
                }
            }
        }
    }

    #[test]
    fn terminal_ls_accepts_project_by_id_or_name_and_keeps_list_alias() {
        for command in ["ls", "list"] {
            assert!(Cli::try_parse_from(["berth", "terminal", command, "--json"]).is_ok());
            for project in ["2", "codeg"] {
                let args = ["berth", "terminal", command, "--project", project, "--json"];
                assert!(Cli::try_parse_from(args).is_ok());
            }
        }
    }

    #[test]
    fn capture_and_send_take_short_or_long_target() {
        for args in [
            vec!["berth", "terminal", "capture", "-t", "codeg:3"],
            vec!["berth", "terminal", "capture", "--target", "codeg:3"],
            vec!["berth", "terminal", "capture", "--target-ref", "v1.abc"],
            vec!["berth", "terminal", "send", "-t", "5:3", "--text", "hi"],
        ] {
            assert!(Cli::try_parse_from(args).is_ok());
        }
    }

    #[test]
    fn terminal_create_requires_explicit_project() {
        assert!(
            Cli::try_parse_from(["berth", "terminal", "create", "--project", "2", "--json",])
                .is_ok()
        );
        for args in [
            vec!["berth", "terminal", "create", "--json"],
            vec!["berth", "terminal", "new", "--project", "2"],
        ] {
            assert!(Cli::try_parse_from(args).is_err());
        }
        // shell 也可带 --cwd（项目内校验在 create 执行时做，不在解析层）。
        assert!(Cli::try_parse_from([
            "berth", "terminal", "create", "--project", "2", "--cwd", "/tmp",
        ])
        .is_ok());
        assert!(Cli::try_parse_from(["berth", "terminal", "create", "--project", "codeg"]).is_ok());
        // 不建项目之外的裸会话：tmux 风格的 new-session / kill-session 已移除。
        assert!(Cli::try_parse_from(["berth", "new-session", "-s", "legacy", "-d"]).is_err());
    }

    #[test]
    fn terminal_create_provider_flags_require_agent_and_provider() {
        let base = ["berth", "terminal", "create", "--project", "2"];
        let parse = |extra: &[&str]| {
            Cli::try_parse_from(base.iter().chain(extra).copied().collect::<Vec<_>>())
        };
        assert!(parse(&["--agent", "demo", "--provider-id", "3", "--model-id", "m"]).is_ok());
        assert!(parse(&["--agent", "demo", "--provider-id", "3"]).is_ok());
        assert!(parse(&["--provider-id", "3"]).is_err());
        assert!(parse(&["--agent", "demo", "--model-id", "m"]).is_err());
        assert!(parse(&["--agent", "demo", "--provider-id", "0"]).is_err());
    }

    #[test]
    fn current_file_accepts_bounded_range_and_snapshot_flags_only_for_documents() {
        assert!(Cli::try_parse_from([
            "berth",
            "project",
            "current-file",
            "--offset",
            "1",
            "--lines",
            "2",
            "--snapshot-ref",
            "v1.snapshot",
            "--json",
        ])
        .is_ok());
        for offset in ["0", "-1", "18446744073709551616"] {
            assert!(
                Cli::try_parse_from(["berth", "project", "current-file", "--offset", offset,])
                    .is_err()
            );
        }
        assert!(Cli::try_parse_from([
            "berth",
            "terminal",
            "capture",
            "--target-ref",
            "v1.ref",
            "--offset",
            "1",
        ])
        .is_err());
    }

    #[test]
    fn current_workspace_commands_replace_legacy_pane_commands() {
        assert!(matches!(
            Cli::try_parse_from(["berth", "project", "current-file", "--json"])
                .unwrap()
                .command,
            Command::Project {
                command: ProjectCommand::CurrentFile { json: true, .. }
            }
        ));
        assert!(matches!(
            Cli::try_parse_from([
                "berth",
                "terminal",
                "send",
                "--target-ref",
                "v1.ref",
                "--text",
                "Enter"
            ])
            .unwrap()
            .command,
            Command::Terminal {
                command: TerminalCommand::Send { text: Some(_), .. }
            }
        ));
        assert!(Cli::try_parse_from(["berth", "send-keys", "-t", "work", "Enter"]).is_err());
        assert!(Cli::try_parse_from(["berth", "capture-pane", "-t", "work"]).is_err());
    }
}
