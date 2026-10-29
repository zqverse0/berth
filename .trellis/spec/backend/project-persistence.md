# Project Persistence Contract（`berth-project-core`）

## 1. Scope / Trigger

只要改动项目事实（SQLite）就适用：

- 新增/修改表、实体、迁移（迁移 owner 唯一）
- 新增项目读取或写入路径（GUI 命令、GUI control、CLI `berth project ...`）
- 改动数据根 / 库文件名解析、实例状态语义、只读开库行为
- 改动项目运行 UUID、DB 路径 namespace、版本化 session key 或项目归属分类

## 2. Signatures

```rust
// src-tauri/project/berth-project-core/src/open.rs
pub async fn open_or_upgrade(instance: &DataInstance)
    -> (Option<DatabaseConnection>, InstanceState);

// src-tauri/project/berth-project-core/src/instance.rs
pub enum InstanceAccess { CreateIfMissing, ExistingOnly }
pub enum BuildInstance { Dev, Release }
pub enum InstanceState {
    Ready,
    PendingRestore { marker: PathBuf },
    Migrating { detail: String },
    Incompatible { detail: String },
    Ambiguous { candidates: Vec<String> },
    Missing { db_path: PathBuf },
    UpgradeRequired { pending: usize },
}
pub fn resolve(build: BuildInstance, access: InstanceAccess,
               explicit_data_dir: Option<PathBuf>, explicit_db_file: Option<String>)
    -> Result<DataInstance, InstanceState>;
pub fn resolve_cli_from_env(build: BuildInstance) -> Result<DataInstance, InstanceState>;
impl DataInstance {
    pub fn namespace_key(&self) -> Result<String, InstanceState>;
}

// src-tauri/project/berth-project-core/src/service/catalog.rs
pub enum CatalogScope { Open, All }
pub struct CatalogEntry {
    pub id: i32,
    pub path: String,
    pub name: String,
    pub is_open: bool,
    pub project_runtime_id: String, // 内部归属事实，不新增 project ls 线上字段
}
pub async fn list_catalog(conn: &DatabaseConnection, scope: CatalogScope)
    -> Result<Vec<CatalogEntry>, DbError>;

// src-tauri/project/berth-project-core/src/runtime.rs
pub struct ProjectSessionKey {
    pub data_instance_key: String,
    pub project_runtime_id: String,
}
pub enum RuntimeIdentityError { InvalidNamespace, InvalidProjectRuntimeId }
pub enum SessionOwnership<'a> {
    Project(&'a CatalogEntry), Foreign, LegacyUnresolved, Independent,
}
pub fn project_session_key(data_instance_key: &str, project_runtime_id: &str)
    -> Result<String, RuntimeIdentityError>;
pub fn parse_project_session_key(name: &str) -> Option<ProjectSessionKey>;
pub fn classify_session<'a>(name: &str, data_instance_key: &str, catalog: &'a [CatalogEntry])
    -> SessionOwnership<'a>;
```

CLI 退出码（`terminal/cli/berth-cli/src/project.rs::exit_code_for`）：`Ambiguous` → 2；
`Missing` / `PendingRestore` / `Migrating` / `UpgradeRequired` → 5；`Incompatible` → 6。
JSON 错误对象固定 `{"error":{"kind","message"}}`，`kind` 取 `InstanceState::kind()`。

## 3. Contracts

- **迁移 owner 唯一**：只有 `berth-project-core::migration`。宿主侧不存在 `db/migration`、
  `db/entities`；迁移文件只允许整体搬家（移动文件 + 更新注册路径），内容不得改。
- **开库策略由调用方选**：GUI（`init_database`）= `CreateIfMissing`（建库 + `Migrator::up`）；
  CLI 读命令 = `ExistingOnly`（只读）。CLI 唯一的写路径是 GUI 未运行时的 `berth project add`
  （及 `berth group spawn` 登记新 worktree）：`resolve_from_env(CreateIfMissing)` + 与 GUI 共用的
  `folder_service::open_project`；GUI 在跑时仍走 GUI control（写库 + 刷新界面），不为写而拉起 GUI。
- **只读不改库**：`ExistingOnly` 不调用 `Migrator::up`，也不 `install` `seaql_migrations` 表；
  schema 落后本构建 → `UpgradeRequired`，提示先启动 GUI。连接从开始即使用 `mode=ro`，
  不执行持久化 PRAGMA（尤其 `journal_mode=WAL`），Ready 复用同一个只读连接；不得
  返回 GUI 的可写连接池。禁止 `immutable=1`：共享实例可能仍在写 WAL，必须遵守锁
  并读取已提交数据。SQLite 的共享锁/-shm 协调不等同业务写入，不承诺目录零 IO。
- **库文件名由调用方给**：crate 内不读 `cfg!`。GUI 用保留
  `cfg!(all(debug_assertions, feature = "tauri-runtime"))` 语义的 `db::database_file_name()`；
  CLI 用 `BuildInstance`；显式 `BERTH_DATA_DIR` 下两库并存必须给 `BERTH_DATA_FILE`。
- **单一目录投影**：`Regular` 过滤、`is_open` 判据与 scope 过滤只在 `service::catalog`；
  GUI control（`project.list`）与 CLI（`project ls`）只把 `CatalogEntry` 映射成各自的线上
  DTO。`CatalogEntry.project_runtime_id` 是同一投影的内部归属字段，不另建 runtime catalog
  或复制 SQL；`project ls` 仍只输出原有 `id/path/name/is_open`。`FolderDetail` 的同名字段
  使用 `serde(skip)`，不改变既有前端 DTO。
- **项目 UUID 只生成一次**：新增迁移 `m20260926_000001_folder_project_runtime_id`
  在同一事务内为全部存量 folder（含 chat、软删除行）回填 UUID v4，并添加 NOT NULL、
  唯一索引及空字符串写入守卫。常规/chat 新建 service 都显式生成 UUID；重开、软删除后
  恢复、更名或开关状态不重置它。UUID 随库复制，不能单独证明数据实例归属；不新增 owner
  表，不自动改名/接管存量 session。该迁移的 down 拒绝删除身份，回退须走前向迁移。
- **namespace 来自完整 DB 路径**：在 `open_or_upgrade` 返回 Ready 后调用
  `DataInstance::namespace_key()`；它只归一已存在文件并做摘要，不读取库正文、不建库。
  摘要固定为 SHA-256 的 64 字符小写十六进制，输入依次为 `berth-data-instance-v1\0`、平台
  标签及 canonical DB **完整路径（含文件名）**：Unix 标签 `unix\0` + 原始 OsStr 字节；
  Windows 标签 `windows-utf16le\0` + UTF-16 code units 的小端字节。不得改用
  `to_string_lossy`、进程随机 hash、仅数据目录、cwd、endpoint 或可复制的库内容。
  目录/文件软链和路径别名归一后相同；不同完整路径的克隆库不同，实例搬迁不继承旧 namespace。
- **session key 只有一个 owner**：`runtime` 纯函数生成/解析
  `berth-project-v1-<data-instance-key>-<project_runtime_id>`；namespace 必须规范小写
  SHA-256，UUID 必须为非 nil、小写连字符规范形式。名称固定 118 ASCII 字节，仅字母数字
  和连字符，不会被现有 `SessionName` 重写；未知版本、额外 target 后缀及非规范身份拒绝解析。
- **分类不猜归属**：`classify_session(name, data_instance_key, catalog)` 的前两个参数
  分别是 session 名和当前实例摘要，catalog 必须是该实例的完整 `CatalogScope::All`。
  只有当前 namespace + 唯一 UUID 命中才返回 `Project`；规范 key 的异 namespace 返回
  `Foreign`；当前 namespace 无匹配/重复匹配、裸数字、空名、畸形或未知版本的保留
  `berth-project` 前缀返回 `LegacyUnresolved`；其余返回 `Independent`。不得用标题、
  folder.id、cwd 或首项匹配补猜 owner，不为非 Project 分类签发冒称项目归属的操作条目，
  也不自动改名、终止或接管它们。项目 owner 与 SDK epoch/PaneId/generation 运行绑定是
  两件事；GUI 明确选中得到的兼容 ref 不构成项目 owner 证明。
- **项目两态，worktree 跟随 git**：常规项目只有「已注册（`is_open = 1`）/ 墓碑
  （`forget_folder`）」两态；迁移 `m20260930_000001_folder_retire_closed` 把旧版「关闭」
  留下的 `is_open = 0` 行及 root 已不在的孤儿 worktree 转为墓碑（行保留作会话外键锚点）。
  worktree 子 folder 只是 git 事实的元数据投影：`git worktree list`（跳过 `prunable`）
  里没有的成员由对账移除；移除 root 连带移除整个家族；worktree 不提供「仅从列表移除」。
  对账触发：项目视图可见时对全部 root 一次，以及活动项目 HEAD 轮询中
  `GitHeadInfo.worktrees_fingerprint` 变化时。
- **GUI 的 pending restore 先于共享切口**：`commands::backup` 完成恢复后才调用
  `open_or_upgrade`；CLI 只报 `PendingRestore`，不代做恢复。
- **依赖方向**：GUI / CLI → `berth-project-core`；该 crate 不依赖 Tauri、clap 或进程生命周期
  （`control-proto` 等传输 DTO 也不进 crate）。

## 4. Validation & Error Matrix

| 条件 | 结果 |
|---|---|
| `ExistingOnly` 且库文件不存在 | `Missing`，CLI 退出 5，**不建库** |
| `ExistingOnly` 且 schema 落后本构建 | `UpgradeRequired { pending }`，退出 5，**不写库**（含不建迁移表） |
| `CreateIfMissing` 且 schema 落后 | 单连接顺序迁移成功后 `Ready` |
| 库内记录了本构建不认识的迁移 | `Incompatible`，退出 6，不按自己的清单继续升级 |
| 迁移/开库遇 SQLite 写锁 | `Migrating`，退出 5，提示重试 |
| 数据目录内两个候选库并存且未设 `BERTH_DATA_FILE` | `Ambiguous`，退出 2，不猜 |
| 数据根存在 `.berth-restore-pending.json` | `PendingRestore`，退出 5，需 GUI 完成 |
| 有效 sqlite 文件但没有迁移记录表 | 只读 → `UpgradeRequired`（引导经 GUI 建库），**不**当作空项目列表 |
| 库文件不是 sqlite（损坏/非本应用） | `Incompatible`，退出 6，单一 JSON 错误对象 |
| CLI 读取尚未执行项目身份迁移的库 | `UpgradeRequired`，库字节不变；namespace 解析不能代替 Ready 检查 |
| 相同完整 DB 路径的目录/文件软链别名 | namespace 相同 |
| 相同 folder.id/UUID/cwd 的克隆库位于不同完整路径 | namespace 不同；对方规范 session key 分类为 `Foreign` |
| 当前 namespace 下 UUID 未命中/重复命中，或存量数字/未知项目格式 key | `LegacyUnresolved`，不猜 owner、不接管 |

任何非 `Ready` 状态都禁止投影成空列表。

## 5. Good / Base / Bad Cases

- **Good**：CLI `project ls` → `existing_only` 实例 → `open_or_upgrade` → `list_catalog`；
  非 Ready 直接以状态报错并给下一步。
- **Base**：GUI 启动 → backup restore（若有标记）→ `open_or_upgrade(CreateIfMissing)` →
  `Ready` → 前端走既有 `folder://changed` 重载路径。
- **Bad**：CLI 自己 `Database::connect` / 复制 SQL / 复制迁移清单；读命令改用户库；
  用 `Migrator::get_pending_migrations` 做只读探测（它会 install 迁移表）。

## 6. Tests Required

`berth-project-core`：

- `tests/instance_resolution.rs` — 数据根 / 库名解析矩阵（dev、release ×
  `BERTH_DATA_DIR` / `BERTH_DATA_FILE` 有无），断言解析结果与 `InstanceState`。
- `tests/open_or_upgrade.rs` — 缺库（不建库）、坏库、旧 schema（owner 升级成功 +
  只读拒绝）、跨版本 `Incompatible`、pending restore、两个 DATA_DIR 隔离；只读拒绝用例必须
  断言**库文件字节不变**与「再次打开仍报同一 pending」。补充非 WAL/无迁移表与未知
  schema 的字节不变用例，避免先建 WAL 库掩盖改库；Ready 连接在可写文件上也必须
  拒绝 SQL 写入；只读文件可读；live WAL 已提交数据可见且读者不 checkpoint 主库/WAL。
  测试夹具的写动作走显式 owner 策略，不借用 `ExistingOnly`。
- `tests/project_catalog.rs` — `scope=all` 含未打开的已注册项目且隐藏 chat folder；
  `scope=open` 只返回打开项目且 `is_open=true`。
- `tests/runtime_identity.rs` — `runtime_identity_` 过滤入口，夹具只能用临时目录与合成库：
  - 版本化 key 往返、118 字节安全字符、非规范/未知格式拒绝及唯一 owner/legacy 分类；
  - canonical 完整路径、不同文件名、目录/文件软链别名与 Unix 非 UTF-8 路径无损；
  - 身份迁移前只读拒绝且反复读取库字节不变，owner 升级回填 UUID v4、非空/唯一约束；
  - 常规/chat 新建 UUID 各异、软删除后重开保留、FolderDetail JSON 不泄露内部字段；
  - 完整克隆 catalog 的 ID/UUID/cwd 相同，但 namespace 不同并分类为 Foreign。
  克隆夹具须先由测试 writer 显式 checkpoint WAL，不能假定连接池关闭即已落入主库；
  生产只读连接不得为此 checkpoint。先枚举真实名称，再串行执行同一过滤器：

  ```bash
  CARGO_BUILD_JOBS=4 cargo test -p berth-project-core --test runtime_identity runtime_identity_ -- --list
  CARGO_BUILD_JOBS=4 cargo test -p berth-project-core --test runtime_identity runtime_identity_
  ```

CLI：`cargo test -p berth-cli --bin berth project::`（过滤器取自 `cargo test ... -- --list`
的真实输出），断言 JSON 字段名保持 `id/path/name/is_open` 与退出码。

## 7. Wrong vs Correct

```rust
// Wrong：只跳过迁移，但用 mode=rwc + PRAGMA journal_mode=WAL 开库；
// 或绕过共享投影自己写 SQL
let (conn, _state) = open_or_upgrade(&instance).await;
let rows = sqlx::query("SELECT * FROM folder").fetch_all(&conn).await?;

// Correct：策略决定是否迁移；非 Ready 报状态；投影只来自共享 crate
let (conn, state) = open_or_upgrade(&instance).await;
if !state.is_ready() {
    return Err(state); // Missing / UpgradeRequired / Incompatible / Ambiguous / PendingRestore
}
let Some(conn) = conn else { unreachable!("ready implies connection") };
let entries = list_catalog(&conn, CatalogScope::All).await?;
```

## Design Decision: 只读开库不迁移（2026-09-22）

**Context**：抽取共享 crate 后 CLI `project ls` 也走唯一迁移入口 `open_or_upgrade`；检查实测
发现它会就地升级落后 schema 的用户库，与「只读查询不修改用户 DB」冲突。

**Options**：1) 承认就地迁移并改措辞；2) 只读路径拒绝迁移并报 `UpgradeRequired`。

**Decision**：选 2。读命令不得有升级用户库的副作用；改造前 CLI 也必须经 GUI control 才能读
项目（GUI 在跑即已升级），因此该选择不让任何既有场景变差，反而多出明确的下一步。

**Extensibility**：将来若需要显式升级入口，另开独立命令（如 `berth doctor --upgrade`），
不要复用只读命令或让读路径重新获得写权限。

## Design Decision: CLI 在无 GUI 时直接添加项目（2026-10-10）

**Context**：远程 SSH 既有带 GUI 的机器，也有无 GUI 的服务器；`project add` 只能经 GUI control
（必要时拉起 GUI），无显示时根本走不通。

**Decision**：GUI 可达 → control RPC；不可达 → CLI 以 `CreateIfMissing` 直接写同一个库，实现与
GUI「添加项目」同一个 `folder_service::open_project`（worktree 家族登记）。读命令仍只读，上一条决定不变；
写路径不复用读命令。

### 归档后回归：不迁移不等于只读（2026-09-22）

原实现先统一 `mode=rwc` / WAL 设置，再分支跳过迁移，导致 DELETE 模式库被修改，
Ready 连接仍可写。已有测试先用 owner 建 WAL 库，未覆盖这个反例。
修复在同一 `open_or_upgrade` 内按策略选择连接权限；GUI 初始化顺序不变，不增新入口。
证据：任务 `archive/2026-09/09-22-headless-project-catalog/research/acceptance-recheck.md`。

## Scenario: 忘记已移除的项目

### 1. Scope / Trigger
- 从工作区移除普通项目时，项目应退出所有活动目录投影；同路径后续添加必须取得新注册身份。

### 2. Signatures
- 复用 `remove_folder_from_workspace` → `remove_folder_from_workspace_core`。
- Core：`folder_service::forget_folder(conn, folder_id) -> Result<String, DbError>`。
- GUI adapter：`project_agent_session_index_service::forget_project_path(conn, normalized_path)`。

### 3. Contracts
- 先完成现有终端 / 标签收尾，再在同一 DB 事务中精确清除项目会话索引与路径哈希扫描状态，并忘记项目注册。
- 保留软删除 folder 行作为外键锚点，替换其真实路径为随机内部标识；不物理删除以免级联删除关联数据。
- 不访问或修改项目目录；前端仅在 command 成功后从 `folders`、`allFolders` 与 folder-keyed 临时状态移除该项目。
- 相同路径重加插入新 folder 行，获得新 `id` 与 `project_runtime_id`。

### 4. Validation & Error Matrix
- folder 不存在 / 已忘记 → 返回 not-found 错误，不报告成功。
- 终端收尾失败 → 不改注册或索引。
- 索引或注册更新失败 → 事务回滚，错误返回前端。

### 5. Good / Base / Bad Cases
- Good：忘记 `/repo` 后，精确删除 `/repo` 的索引；`/repo/sub` 不变；重加 `/repo` 得到新身份。
- Base：关闭 Berth 重启后，已忘记路径不再由目录 catalog 返回。
- Bad：只执行 `set_folder_open(false)`，或物理删除 folder 造成外键级联删除。

### 6. Tests Required
- `project_catalog::forgetting_a_project_removes_its_path_and_readd_creates_new_identity`：旧路径离开 catalog，重加获得新 ID/UUID。
- `project_agent_session_index_service::forget_project_path_does_not_match_nested_projects`：断言仅精确路径删除。
- `commands::folders::forget_project_preserves_disk_files_and_readd_identity`：断言磁盘文件字节不变且重加身份变化。

### 7. Wrong vs Correct
```rust
// Wrong：关闭后旧行仍参与 CatalogScope::All 和路径归属。
folder_service::set_folder_open(conn, folder_id, false).await?;

// Correct：在复用的移除 command 中，以事务忘记注册并精确清索引状态。
sessions::forget_project_index(&txn, &project_path).await?;
folder_service::forget_folder(&txn, folder_id).await?;
```
