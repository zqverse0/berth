//! `berth project ...` 的项目事实入口。
//!
//! `ls` 直连共享 crate `berth-project-core` 的同一投影：GUI 未运行时也能从同一
//! SQLite 实例列出全部已注册项目（含无 live Terminal 的项目），不启动 GUI、
//! termd 或 backup restore。`add`：GUI 运行时走 GUI control（界面随之刷新），否则直接写库。
//!
//! 只读语义：库 schema 落后本构建时不做就地升级，返回
//! `InstanceState::UpgradeRequired`（退出码 5）并提示先启动 GUI 完成升级。

use std::path::PathBuf;

use berth_control_proto::{ProjectEntry, ProjectScope};
use berth_project_core::instance::{self, BuildInstance, DataInstance, InstanceAccess, InstanceState};
use berth_project_core::open::open_or_upgrade;
use berth_project_core::service::catalog::{list_catalog, CatalogEntry, CatalogScope};
use berth_project_core::service::folder_service;

use crate::{
    CliError, EXIT_GUI_UNAVAILABLE, EXIT_INCOMPATIBLE, EXIT_TARGET_NOT_FOUND, EXIT_USER_ERROR,
};

/// 本二进制所属的数据实例（构建 profile）。共享 crate 不读 `cfg!`，由调用方给出。
fn build_instance() -> BuildInstance {
    if cfg!(debug_assertions) {
        BuildInstance::Dev
    } else {
        BuildInstance::Release
    }
}

fn catalog_scope(scope: ProjectScope) -> CatalogScope {
    match scope {
        ProjectScope::Open => CatalogScope::Open,
        ProjectScope::All => CatalogScope::All,
    }
}

/// 线上 DTO 映射；「哪些项目、是否已打开」由共享 crate 的目录投影决定。
fn entry_from_catalog(entry: CatalogEntry) -> ProjectEntry {
    ProjectEntry {
        id: i64::from(entry.id),
        path: entry.path,
        name: entry.name,
        is_open: entry.is_open,
    }
}

/// 两个只读发现入口共用实例解析，不复制环境或缺库判定。
pub(crate) fn resolve_instance(json: bool) -> Result<DataInstance, CliError> {
    instance::resolve_cli_from_env(build_instance())
        .map_err(|state| CliError::from_instance(state, json))
}

/// 从共享 crate 读取项目目录（GUI 不参与）。非 `Ready` 一律返回错误，不返回空列表。
pub(crate) async fn catalog_entries(
    instance: &DataInstance,
    scope: ProjectScope,
) -> Result<Vec<CatalogEntry>, InstanceState> {
    let (conn, state) = open_or_upgrade(instance).await;
    if !state.is_ready() {
        return Err(state);
    }
    let Some(conn) = conn else {
        return Err(InstanceState::Incompatible {
            detail: "open_or_upgrade returned no connection".to_owned(),
        });
    };

    let entries = list_catalog(&conn, catalog_scope(scope))
        .await
        .map_err(|error| InstanceState::Incompatible {
            detail: error.to_string(),
        })?;
    Ok(entries)
}

pub(crate) async fn list_entries(
    instance: &DataInstance,
    scope: ProjectScope,
) -> Result<Vec<ProjectEntry>, InstanceState> {
    Ok(catalog_entries(instance, scope)
        .await?
        .into_iter()
        .map(entry_from_catalog)
        .collect())
}

/// 按用户给的项目参数（ID、名称、路径或名称的唯一前缀）找项目；失败时给出退出码与说明。
/// `--project`、`attach -s` 与终端短名 `项目:编号` 共用这一条规则。
pub(crate) fn match_project<'a>(
    catalog: &'a [CatalogEntry],
    query: &str,
) -> Result<&'a CatalogEntry, (u8, String)> {
    let query = query.trim();
    let path = query.trim_end_matches(['/', '\\']);
    let pick = |matches: Vec<&'a CatalogEntry>| match matches.as_slice() {
        [only] => Some(Ok(*only)),
        [] => None,
        many => Some(Err((
            EXIT_USER_ERROR,
            format!(
                "project '{query}' is ambiguous: {}; use the ID",
                many.iter()
                    .map(|entry| format!("{} ({})", entry.name, entry.id))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        ))),
    };
    let by_id = query
        .parse::<i32>()
        .ok()
        .and_then(|id| catalog.iter().find(|entry| entry.id == id));
    if let Some(entry) = by_id {
        return Ok(entry);
    }
    let exact = catalog
        .iter()
        .filter(|entry| entry.name == query || (!path.is_empty() && entry.path == path))
        .collect();
    if let Some(result) = pick(exact) {
        return result;
    }
    let prefix = catalog
        .iter()
        .filter(|entry| !query.is_empty() && entry.name.starts_with(query))
        .collect();
    pick(prefix).unwrap_or_else(|| {
        Err((
            EXIT_TARGET_NOT_FOUND,
            format!("no project matches '{query}'; see `berth project ls`"),
        ))
    })
}

/// GUI 未运行时的 `berth project add`：直接经共享 crate 写同一个库（与 GUI「添加项目」同一实现），
/// 无库（无 GUI 的服务器首次使用）即建库。GUI 运行时由调用方走 control RPC，界面随之刷新。
pub(crate) fn add(path: &str, json: bool) -> Result<(), CliError> {
    let entry = add_entry(path, json)?;
    if json {
        match serde_json::to_string(&entry) {
            Ok(encoded) => println!("{encoded}"),
            Err(error) => eprintln!("berth: failed to encode project JSON: {error}"),
        }
    } else {
        println!("{} {} ({})", entry.id, entry.name, entry.path);
    }
    Ok(())
}

/// [`add`] 的写库部分；群派生成员时登记新 worktree 也用它。
pub(crate) fn add_entry(path: &str, json: bool) -> Result<ProjectEntry, CliError> {
    let dir = std::path::Path::new(path);
    if !dir.is_absolute() {
        return Err(CliError::user("project path must be absolute"));
    }
    if !dir.is_dir() {
        return Err(CliError::not_found(format!(
            "project path '{path}' is not an existing directory"
        )));
    }
    let instance = instance::resolve_from_env(build_instance(), InstanceAccess::CreateIfMissing)
        .map_err(|state| CliError::from_instance(state, json))?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(CliError::from_runtime)?;
    let detail = runtime.block_on(async {
        let (conn, state) = open_or_upgrade(&instance).await;
        let conn = conn.ok_or_else(|| CliError::from_instance(state, json))?;
        folder_service::open_project(&conn, path)
            .await
            .map_err(CliError::from_runtime)
    })?;
    Ok(ProjectEntry {
        id: i64::from(detail.id),
        path: detail.path,
        name: detail.name,
        is_open: true,
    })
}

/// `berth project <项目> …` 的项目参数解析为项目目录：ID、名称（或唯一前缀）、路径；`.` 是当前目录。
pub(crate) fn project_dir(query: &str) -> Result<PathBuf, CliError> {
    if query == "." {
        return std::env::current_dir().map_err(CliError::from_runtime);
    }
    let instance = resolve_instance(false)?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(CliError::from_runtime)?;
    let catalog = runtime
        .block_on(catalog_entries(&instance, ProjectScope::All))
        .map_err(|state| CliError::from_instance(state, false))?;
    match_project(&catalog, query)
        .map(|entry| PathBuf::from(&entry.path))
        .map_err(|(exit_code, message)| CliError {
            exit_code,
            message,
            json_message: None,
        })
}

/// `berth project ls [--scope all|open] [--json]`
pub(crate) fn list(scope: ProjectScope, json: bool) -> Result<(), CliError> {
    let instance = resolve_instance(json)?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(CliError::from_runtime)?;
    let entries = runtime
        .block_on(list_entries(&instance, scope))
        .map_err(|state| CliError::from_instance(state, json))?;
    print_entries(&entries, json);
    Ok(())
}

fn print_entries(entries: &[ProjectEntry], json: bool) {
    if json {
        // 与 GUI control 时代相同的单一 JSON 数组。
        match serde_json::to_string(entries) {
            Ok(encoded) => println!("{encoded}"),
            Err(error) => eprintln!("berth: failed to encode project list JSON: {error}"),
        }
        return;
    }
    if entries.is_empty() {
        println!("no projects");
        return;
    }
    println!("{:<5} {:<5} {:<20} PATH", "ID", "OPEN", "NAME");
    for entry in entries {
        println!(
            "{:<5} {:<5} {:<20} {}",
            entry.id,
            if entry.is_open { "*" } else { "-" },
            entry.name,
            entry.path
        );
    }
}

/// 实例不可用时的退出码映射：沿用既有码位，不新增码。
///
/// - 歧义（需用户指定 `BERTH_DATA_FILE`）→ 2（用户输入错误）；
/// - 缺库 / pending restore / 迁移中 → 5（实例不可用，与 GUI 不可达同类）；
/// - schema 不可读（含损坏）→ 6（不兼容）。
fn exit_code_for(state: &InstanceState) -> u8 {
    match state {
        InstanceState::Ready => 0,
        InstanceState::Ambiguous { .. } => EXIT_USER_ERROR,
        InstanceState::Incompatible { .. } => EXIT_INCOMPATIBLE,
        InstanceState::Missing { .. }
        | InstanceState::PendingRestore { .. }
        | InstanceState::Migrating { .. }
        | InstanceState::UpgradeRequired { .. } => EXIT_GUI_UNAVAILABLE,
    }
}

impl CliError {
    /// 非 `Ready` 数据实例：非零退出 + 单一 JSON 错误对象，绝不返回空列表。
    pub(crate) fn from_instance(state: InstanceState, json: bool) -> Self {
        let message = state.message();
        Self {
            exit_code: exit_code_for(&state),
            json_message: json.then(|| {
                serde_json::json!({
                    "error": {
                        "kind": state.kind(),
                        "message": message,
                    }
                })
                .to_string()
            }),
            message,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn catalog_entry(id: i32, name: &str) -> CatalogEntry {
        CatalogEntry {
            id,
            path: format!("/work/{name}"),
            name: name.to_owned(),
            is_open: true,
            project_runtime_id: String::new(),
        }
    }

    #[test]
    fn match_project_accepts_id_name_path_and_unique_prefix() {
        let catalog = [
            catalog_entry(5, "codeg"),
            catalog_entry(7, "berth"),
            catalog_entry(8, "berth-dev"),
        ];
        let id = |query| match_project(&catalog, query).map(|entry| entry.id);
        assert_eq!(id("5"), Ok(5));
        assert_eq!(id("codeg"), Ok(5));
        assert_eq!(id("cod"), Ok(5));
        assert_eq!(id("/work/codeg/"), Ok(5));
        // 名称完全相同优先于前缀，不因 berth-dev 而歧义。
        assert_eq!(id("berth"), Ok(7));
        assert_eq!(id("berth-"), Ok(8));
        assert_eq!(id("be").unwrap_err().0, EXIT_USER_ERROR);
        assert_eq!(id("nope").unwrap_err().0, EXIT_TARGET_NOT_FOUND);
        assert_eq!(id("").unwrap_err().0, EXIT_TARGET_NOT_FOUND);
    }
    use berth_project_core::service::folder_service;

    /// 建库 + 建项目，模拟「GUI 未运行」的既有数据实例。
    /// `add_folder` 按持久列把新项目标为 open（与 GUI 打开项目同语义）。
    async fn fixture(projects: &[&str]) -> DataInstance {
        let dir = tempfile::tempdir().expect("fixture dir");
        // 目录需活过整个用例：keep() 交出所有权，不再自动删除。
        let path = dir.keep();
        let instance = DataInstance::create_if_missing(&path, "berth.db");
        let (conn, state) = open_or_upgrade(&instance).await;
        assert_eq!(state, InstanceState::Ready);
        let conn = conn.expect("connection");
        for project in projects {
            folder_service::add_folder(&conn, &format!("/tmp/{project}"))
                .await
                .expect("seed project");
        }
        conn.close().await.expect("close fixture db");
        DataInstance::existing_only(&path, "berth.db")
    }

    /// 关闭指定项目的持久 `is_open`（模拟 GUI 里关掉项目、但没有 live Terminal）。
    async fn close_projects(instance: &DataInstance, names: &[&str]) {
        // 准备夹具的写动作走 owner 策略；只读查询返回的连接不能用于写入。
        let owner = DataInstance::create_if_missing(instance.data_dir(), instance.db_file_name());
        let (conn, state) = open_or_upgrade(&owner).await;
        assert_eq!(state, InstanceState::Ready);
        let conn = conn.expect("connection");
        let details = folder_service::list_all_folder_details(&conn)
            .await
            .expect("list");
        for name in names {
            let id = details
                .iter()
                .find(|detail| &detail.name == name)
                .unwrap_or_else(|| panic!("fixture project {name}"))
                .id;
            folder_service::set_folder_open(&conn, id, false)
                .await
                .expect("close project");
        }
        conn.close().await.expect("close");
    }

    #[tokio::test]
    async fn lists_all_registered_projects_without_a_gui() {
        let instance = fixture(&["alpha", "beta", "gamma"]).await;
        close_projects(&instance, &["beta", "gamma"]).await;
        let entries = list_entries(&instance, ProjectScope::All)
            .await
            .expect("headless listing");
        let mut names: Vec<&str> = entries.iter().map(|entry| entry.name.as_str()).collect();
        names.sort();
        // 无 live Terminal、已关闭的项目仍然出现在 list 里（数量不变）。
        assert_eq!(names, vec!["alpha", "beta", "gamma"]);
        assert_eq!(entries.iter().filter(|entry| entry.is_open).count(), 1);
    }

    #[tokio::test]
    async fn scope_open_follows_the_persisted_is_open_column() {
        let instance = fixture(&["alpha", "beta", "gamma"]).await;
        // add_folder 把三个项目都标为 open；显式关掉两个后 Open 只剩一个。
        let all_open = list_entries(&instance, ProjectScope::Open)
            .await
            .expect("open scope");
        assert_eq!(all_open.len(), 3);

        close_projects(&instance, &["beta", "gamma"]).await;

        let open = list_entries(&instance, ProjectScope::Open)
            .await
            .expect("open scope");
        assert_eq!(open.len(), 1);
        assert_eq!(open[0].name, "alpha");
        assert!(open[0].is_open);

        let all = list_entries(&instance, ProjectScope::All)
            .await
            .expect("all scope");
        assert_eq!(all.len(), 3);
        assert_eq!(
            all.iter().filter(|entry| entry.is_open).count(),
            1,
            "只有持久列标记为 open 的项目是 *"
        );
    }

    #[tokio::test]
    async fn json_fields_stay_the_published_control_shape() {
        let instance = fixture(&["alpha"]).await;
        let entries = list_entries(&instance, ProjectScope::All)
            .await
            .expect("listing");
        let value = serde_json::to_value(&entries).expect("json");
        assert_eq!(
            value,
            serde_json::json!([{ "id": 1, "path": "/tmp/alpha", "name": "alpha", "is_open": true }])
        );
    }

    #[tokio::test]
    async fn missing_instance_reports_unavailable_instead_of_an_empty_list() {
        let dir = tempfile::tempdir().expect("dir");
        let instance = DataInstance::existing_only(dir.path(), "berth.db");
        let state = list_entries(&instance, ProjectScope::All)
            .await
            .expect_err("must not pretend to be empty");
        assert!(matches!(state, InstanceState::Missing { .. }));
        let error = CliError::from_instance(state, true);
        assert_eq!(error.exit_code, crate::EXIT_GUI_UNAVAILABLE);
        let json: serde_json::Value =
            serde_json::from_str(error.json_message.as_deref().expect("json envelope"))
                .expect("valid json");
        assert_eq!(json["error"]["kind"], "instance_unavailable");
    }

    #[tokio::test]
    async fn pending_restore_reports_that_the_gui_must_finish() {
        let instance = fixture(&["alpha"]).await;
        std::fs::write(instance.restore_marker_path(), b"{}").expect("marker");
        let state = list_entries(&instance, ProjectScope::All)
            .await
            .expect_err("pending restore blocks listing");
        assert!(matches!(state, InstanceState::PendingRestore { .. }));
        let error = CliError::from_instance(state, false);
        assert_eq!(error.exit_code, crate::EXIT_GUI_UNAVAILABLE);
        assert!(error.message.contains("GUI"));
    }

    #[test]
    fn ambiguous_instance_maps_to_the_user_error_exit_code() {
        let error = CliError::from_instance(
            InstanceState::Ambiguous {
                candidates: vec!["berth.db".to_owned(), "berth-dev.db".to_owned()],
            },
            true,
        );
        assert_eq!(error.exit_code, crate::EXIT_USER_ERROR);
        let json: serde_json::Value =
            serde_json::from_str(error.json_message.as_deref().expect("json envelope"))
                .expect("valid json");
        assert_eq!(json["error"]["kind"], "instance_ambiguous");
    }

    #[test]
    fn incompatible_instance_maps_to_the_incompatible_exit_code() {
        let error = CliError::from_instance(
            InstanceState::Incompatible {
                detail: "file is not a database".to_owned(),
            },
            false,
        );
        assert_eq!(error.exit_code, crate::EXIT_INCOMPATIBLE);
        assert!(!error.message.is_empty());
    }

    /// 两个 DATA_DIR fixture 互不读取对方库（AC-HC-003）。
    #[tokio::test]
    async fn two_data_dirs_stay_isolated() {
        let first = fixture(&["alpha", "beta", "gamma"]).await;
        let second = fixture(&["delta"]).await;
        let first_names: Vec<String> = list_entries(&first, ProjectScope::All)
            .await
            .expect("first")
            .into_iter()
            .map(|entry| entry.name)
            .collect();
        let second_names: Vec<String> = list_entries(&second, ProjectScope::All)
            .await
            .expect("second")
            .into_iter()
            .map(|entry| entry.name)
            .collect();
        assert_eq!(first_names.len(), 3);
        assert_eq!(second_names, vec!["delta".to_owned()]);
    }

    /// 落后 schema：只读入口报 `instance_upgrade_required` + 退出码 5，并给出「先启动 GUI」。
    #[test]
    fn upgrade_required_points_at_the_gui_with_exit_five() {
        let state = InstanceState::UpgradeRequired { pending: 3 };
        assert_eq!(state.kind(), "instance_upgrade_required");
        assert!(!state.is_ready());
        let error = CliError::from_instance(state, true);
        assert_eq!(error.exit_code, crate::EXIT_GUI_UNAVAILABLE);
        assert!(error.message.contains("start the Berth GUI"));
        let json: serde_json::Value =
            serde_json::from_str(error.json_message.as_deref().expect("json envelope"))
                .expect("valid json");
        assert_eq!(json["error"]["kind"], "instance_upgrade_required");
    }
}
