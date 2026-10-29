use super::super::remote::{readable_terminal_title, resolve_process_name};
use super::super::snapshot::{
    normalize_snapshot_line_endings_for_xterm, runtime_sequence_is_snapshot_covered,
    terminal_sequence_from_runtime,
};
use super::{CreateTerminalRequest, TerminalError, TerminalSessionManager};
#[cfg(unix)]
use crate::terminal::error::TerminalErrorCode;
#[cfg(unix)]
use crate::terminal::manager::lifecycle::SubscriberHandle;
use crate::terminal::manager::lifecycle::{
    cleanup_temp_files, sync_runtime_index, LiveTerminal, TerminalTarget,
};
#[cfg(unix)]
use crate::terminal::manager::TerminalOperationError;
#[cfg(unix)]
use crate::terminal::protocol::SubscriberControl;
use std::env;
#[cfg(unix)]
use std::sync::atomic::AtomicBool;
#[cfg(unix)]
use std::sync::Arc;
#[cfg(unix)]
use std::time::Duration;
#[cfg(unix)]
use berth_term_proto::{
    encode_frame, FrameDecoder, HandshakeRequest, PaneRespawnRequest, PaneTargetRef, Request,
    Response,
};
#[cfg(unix)]
use berth_term_sdk::berth::PaneProcessState;
use berth_term_sdk::berth::{default_endpoint_path, PaneId, RuntimeBinding, Terminal};
#[cfg(unix)]
use tokio::io::{AsyncReadExt, AsyncWriteExt};
#[cfg(unix)]
use tokio::net::UnixStream;

#[test]
fn readable_terminal_title_prefers_shell_and_cwd_over_uuid_window_name() {
    assert_eq!(
        readable_terminal_title(
            "123e4567-e89b-12d3-a456-426614174000",
            Some("123e4567-e89b-12d3-a456-426614174000"),
            None,
            "/bin/zsh",
            "/workspace/demo-app",
            Some("/bin/zsh"),
        ),
        "zsh · demo-app"
    );
    assert_eq!(
        readable_terminal_title(
            "123e4567-e89b-12d3-a456-426614174000",
            Some("logs"),
            None,
            "/bin/zsh",
            "/tmp",
            None,
        ),
        "logs"
    );
}

#[test]
fn resolve_process_name_detects_agent_launch_scripts() {
    let launch = |script: &str| {
        vec![
            "/opt/berth/berth-cli".to_string(),
            "tools".to_string(),
            "launch".to_string(),
            script.to_string(),
            "--berth-launch-inputs".to_string(),
            "{}".to_string(),
        ]
    };
    // 名字来自插件 tool.json 的 identity.name；这里没有安装该插件，回落工具 id。
    let demo_cmd = launch("/home/user/.berth/tools/berth-test-no-such-agent/launch.js");
    assert_eq!(
        resolve_process_name(Some(&demo_cmd), "/bin/bash"),
        "berth-test-no-such-agent"
    );

    let plain_py = vec![
        "python3".to_string(),
        "server.py".to_string(),
    ];
    assert_eq!(resolve_process_name(Some(&plain_py), "/bin/bash"), "server.py");

    let plain_sh = vec!["/bin/bash".to_string()];
    assert_eq!(resolve_process_name(Some(&plain_sh), "/bin/bash"), "bash");
}
use std::path::{Path, PathBuf};
use std::sync::Mutex;

static ENV_LOCK: Mutex<()> = Mutex::new(());
const GENERATION_GUARD: &str = "sdk.pane.generation_guard";

#[test]
fn terminal_owned_temp_paths_clean_files_and_directories() {
    let root = tempfile::tempdir().expect("temp root");
    let file = root.path().join("owned-file");
    let directory = root.path().join("owned-session");
    std::fs::write(&file, "temporary").expect("write temp file");
    std::fs::create_dir(&directory).expect("create temp directory");
    std::fs::write(directory.join("secret.json"), "temporary").expect("write nested file");

    let mut paths = vec![file.clone(), directory.clone()];
    cleanup_temp_files(&mut paths);

    assert!(paths.is_empty());
    assert!(!file.exists());
    assert!(!directory.exists());
}

#[test]
fn terminal_output_sequence_is_converted_to_berth_stream_sequence() {
    assert_eq!(terminal_sequence_from_runtime(0), 1);
    assert_eq!(terminal_sequence_from_runtime(41), 42);
}

#[test]
fn snapshot_watermark_keeps_the_first_post_snapshot_event() {
    let snapshot_watermark = 7;
    assert!(runtime_sequence_is_snapshot_covered(6, snapshot_watermark));
    assert!(!runtime_sequence_is_snapshot_covered(7, snapshot_watermark));
    assert_eq!(terminal_sequence_from_runtime(snapshot_watermark), 8);
}

#[test]
fn terminal_snapshot_rows_are_normalized_for_xterm() {
    let snapshot = b"first\nsecond\n\x1b[32mthird\x1b[0m\n".to_vec();

    assert_eq!(
        normalize_snapshot_line_endings_for_xterm(snapshot),
        b"first\r\nsecond\r\n\x1b[32mthird\x1b[0m\r\n"
    );
}

#[test]
fn terminal_snapshot_normalization_preserves_existing_crlf() {
    let snapshot = b"first\r\nsecond\nthird\r\n".to_vec();

    assert_eq!(
        normalize_snapshot_line_endings_for_xterm(snapshot),
        b"first\r\nsecond\r\nthird\r\n"
    );
}

struct EnvironmentGuard {
    tmpdir: Option<std::ffi::OsString>,
    terminald: Option<std::ffi::OsString>,
}

impl EnvironmentGuard {
    fn set(tmpdir: &std::path::Path, terminald: PathBuf) -> Self {
        let guard = Self {
            tmpdir: env::var_os("BERTH_TMPDIR"),
            terminald: env::var_os("BERTH_TERMINALD_PATH"),
        };
        env::set_var("BERTH_TMPDIR", tmpdir);
        env::set_var("BERTH_TERMINALD_PATH", terminald);
        guard
    }
}

impl Drop for EnvironmentGuard {
    fn drop(&mut self) {
        match self.tmpdir.take() {
            Some(value) => env::set_var("BERTH_TMPDIR", value),
            None => env::remove_var("BERTH_TMPDIR"),
        }
        match self.terminald.take() {
            Some(value) => env::set_var("BERTH_TERMINALD_PATH", value),
            None => env::remove_var("BERTH_TERMINALD_PATH"),
        }
    }
}

#[test]
fn fallible_list_distinguishes_unavailable_runtime_from_empty_inventory() {
    let _lock = ENV_LOCK.lock().expect("env lock");
    let temp = tempfile::tempdir().expect("tempdir");
    let _env = EnvironmentGuard::set(temp.path(), temp.path().join("missing-terminald"));
    let manager = TerminalSessionManager::new();

    assert!(matches!(
        manager.try_list(),
        Err(TerminalError::RuntimeUnavailable(_))
    ));
    assert!(manager.list().is_empty());
}

#[test]
fn missing_session_is_a_stale_terminal_target() {
    let error = super::terminal_error_from_sdk(
        berth_term_sdk::berth::TerminalError::protocol(
            berth_term_sdk::berth::ProtocolError::SessionNotFound("synthetic-session".into()),
        ),
        Some("synthetic-terminal"),
    );
    assert!(matches!(error, TerminalError::NotFound(id) if id == "synthetic-terminal"));
}

#[cfg(unix)]
#[test]
fn current_binding_distinguishes_missing_daemon_from_missing_target() {
    let root = tempfile::tempdir().expect("isolated socket root");
    let manager = TerminalSessionManager::with_test_endpoint(root.path().join("absent.sock"));
    assert!(matches!(
        manager.current_binding("synthetic-terminal"),
        Err(TerminalError::RuntimeUnavailable(_))
    ));
}

fn terminal_request(cwd: &std::path::Path, terminal_id: &str) -> CreateTerminalRequest {
    CreateTerminalRequest {
        terminal_id: Some(terminal_id.to_string()),
        cwd: cwd.to_string_lossy().into_owned(),
        shell: Some("/bin/sh".to_string()),
        initial_command: None,
        executable: None,
        args: Vec::new(),
        folder_id: Some(1),
        rows: 24,
        cols: 80,
        client_id: Some("test-window".to_string()),
        extra_env: None,
        temp_files: Vec::new(),
        keep_on_failed_exit: false,
    }
}

async fn project_manager(root: &Path) -> TerminalSessionManager {
    use berth_project_core::instance::DataInstance;
    use berth_project_core::open::open_or_upgrade;
    use berth_project_core::service::folder_service;

    let instance = DataInstance::create_if_missing(root.join("catalog"), "berth.db");
    let (conn, state) = open_or_upgrade(&instance).await;
    assert!(state.is_ready(), "synthetic project database: {state:?}");
    let conn = conn.expect("ready database");
    let folder = folder_service::add_folder(&conn, &root.to_string_lossy())
        .await
        .expect("seed project");
    assert_eq!(folder.id, 1, "synthetic catalog has one project");
    let manager = TerminalSessionManager::new();
    manager
        .configure_project_database(&instance, conn, Ok(root.join("gui.sock")))
        .expect("bind project database");
    manager
}

#[cfg(unix)]
#[tokio::test(flavor = "current_thread")]
async fn launch_environment_invalid_gui_endpoint_rejects_create_without_starting_daemon() {
    use berth_project_core::instance::DataInstance;
    use berth_project_core::open::open_or_upgrade;

    let root = tempfile::tempdir().expect("synthetic instance root");
    let instance = DataInstance::create_if_missing(root.path().join("data"), "berth.db");
    let (conn, state) = open_or_upgrade(&instance).await;
    assert!(state.is_ready());
    let manager = TerminalSessionManager::with_test_endpoint(root.path().join("absent.sock"));
    manager
        .configure_project_database(
            &instance,
            conn.expect("isolated database"),
            Err("synthetic invalid GUI endpoint".to_owned()),
        )
        .expect("endpoint failure must not fail host initialization");
    let error = manager
        .create(terminal_request(root.path(), "invalid-environment"))
        .await
        .expect_err("invalid instance environment must reject creation");
    assert!(matches!(error, TerminalError::SpawnFailed(message) if message == "synthetic invalid GUI endpoint"));
    assert!(manager.inner.executor.get().is_none());
}

#[cfg(unix)]
#[tokio::test(flavor = "current_thread")]
async fn gui_project_owner_rejects_cloned_catalog_on_shared_daemon() {
    use sea_orm::ConnectionTrait;
    use berth_project_core::instance::DataInstance;
    use berth_project_core::open::open_or_upgrade;
    use berth_project_core::service::catalog::{list_catalog, CatalogScope};
    use berth_project_core::service::folder_service;

    let _env_lock = ENV_LOCK.lock().expect("environment lock");
    let root = tempfile::tempdir().expect("synthetic instance root");
    let daemon = super::super::runtime::resolve_terminald_binary()
        .expect("owner regression requires the test berth-termd binary");
    let _environment = EnvironmentGuard::set(root.path(), daemon);
    let instance = DataInstance::create_if_missing(root.path().join("owner"), "berth.db");
    let (conn, state) = open_or_upgrade(&instance).await;
    assert!(state.is_ready(), "owner database: {state:?}");
    let conn = conn.expect("owner database");
    let folder = folder_service::add_folder(&conn, &root.path().to_string_lossy())
        .await
        .expect("seed owner project");
    conn.execute_unprepared("PRAGMA wal_checkpoint(TRUNCATE)")
        .await
        .expect("checkpoint before cloning");
    conn.close()
        .await
        .expect("close owner database before cloning");

    // 真正克隆合成库：folder.id、运行 UUID 与 cwd 相同，仅 DB 完整路径不同。
    let cloned_instance = DataInstance::create_if_missing(root.path().join("clone"), "berth.db");
    std::fs::create_dir_all(cloned_instance.data_dir()).expect("clone directory");
    std::fs::copy(instance.db_path(), cloned_instance.db_path()).expect("clone synthetic DB");
    let (conn, state) = open_or_upgrade(&instance).await;
    assert!(state.is_ready());
    let conn = conn.expect("reopen owner database");
    let (cloned_conn, state) = open_or_upgrade(&cloned_instance).await;
    assert!(state.is_ready());
    let cloned_conn = cloned_conn.expect("cloned database");
    let owner_catalog = list_catalog(&conn, CatalogScope::All)
        .await
        .expect("owner catalog");
    let clone_catalog = list_catalog(&cloned_conn, CatalogScope::All)
        .await
        .expect("clone catalog");
    assert_eq!(owner_catalog[0].id, clone_catalog[0].id);
    assert_eq!(owner_catalog[0].path, clone_catalog[0].path);
    assert_eq!(
        owner_catalog[0].project_runtime_id,
        clone_catalog[0].project_runtime_id
    );

    let manager = TerminalSessionManager::new();
    manager
        .configure_project_database(&instance, conn.clone(), Ok(root.path().join("gui.sock")))
        .expect("owner manager");
    let clone_manager = TerminalSessionManager::new();
    clone_manager
        .configure_project_database(
            &cloned_instance,
            cloned_conn,
            Ok(root.path().join("clone-gui.sock")),
        )
        .expect("clone manager");
    let mut request = terminal_request(root.path(), "same-terminal-id");
    request.folder_id = Some(folder.id);
    manager.create(request).await.expect("owner terminal");
    let original = manager
        .current_binding("same-terminal-id")
        .expect("owner binding");
    assert!(clone_manager
        .try_list()
        .expect("clone inventory")
        .is_empty());
    assert!(matches!(
        clone_manager.current_binding("same-terminal-id"),
        Err(TerminalError::NotFound(_))
    ));

    // 路径别名使用同一个 namespace，不以调用方提供的目录拼写分叉。
    let alias = root.path().join("owner-alias");
    std::os::unix::fs::symlink(instance.data_dir(), &alias).expect("synthetic DB alias");
    let alias_manager = TerminalSessionManager::new();
    alias_manager
        .configure_project_database(
            &DataInstance::existing_only(&alias, "berth.db"),
            conn,
            Ok(root.path().join("gui.sock")),
        )
        .expect("alias manager");
    assert_eq!(
        alias_manager.current_binding("same-terminal-id").unwrap(),
        original
    );

    let mut request = terminal_request(root.path(), "same-terminal-id");
    request.folder_id = Some(folder.id);
    clone_manager
        .create(request)
        .await
        .expect("independent clone terminal");
    let cloned = clone_manager
        .current_binding("same-terminal-id")
        .expect("clone binding");
    assert_ne!(original.session, cloned.session);
    assert_eq!(
        manager.current_binding("same-terminal-id").unwrap(),
        original
    );
    clone_manager
        .terminate_and_remove_folder(folder.id)
        .await
        .expect("close clone project");
    assert_eq!(
        manager.current_binding("same-terminal-id").unwrap(),
        original
    );
    manager
        .terminate_and_remove_folder(folder.id)
        .await
        .expect("close owner project");
    kill_test_daemon().await;
}

#[cfg(unix)]
#[tokio::test(flavor = "current_thread")]
async fn gui_project_owner_keeps_legacy_unresolved_and_never_reuses_or_closes_it() {
    use super::super::model::TerminalOwnership;
    use berth_term_sdk::berth::{EnsureSession, SessionName};

    let _env_lock = ENV_LOCK.lock().expect("environment lock");
    let root = tempfile::tempdir().expect("synthetic instance root");
    let daemon = super::super::runtime::resolve_terminald_binary()
        .expect("owner regression requires the test berth-termd binary");
    let _environment = EnvironmentGuard::set(root.path(), daemon.clone());
    let manager = project_manager(root.path()).await;
    let terminal = Terminal::builder()
        .unix_socket(default_endpoint_path().expect("isolated endpoint"))
        .daemon_binary(daemon)
        .connect_or_start()
        .await
        .expect("isolated test daemon");
    let legacy_name = SessionName::new("1").expect("numeric legacy session");
    terminal
        .ensure_session(
            EnsureSession::named(legacy_name.clone())
                .create_or_reuse()
                .detached(true)
                .working_directory(root.path().to_string_lossy().into_owned())
                .window_name("legacy-terminal")
                .argv(vec!["/bin/sh".to_owned()]),
        )
        .await
        .expect("synthetic legacy terminal");
    let descriptor = manager
        .describe("legacy-terminal")
        .expect("legacy stays visible");
    assert_eq!(descriptor.folder_id, None);
    assert_eq!(descriptor.ownership, TerminalOwnership::LegacyUnresolved);
    assert!(manager.sessions_for_folder(1).is_empty());
    assert!(manager.sessions_started_under(root.path()).is_empty());
    let legacy_binding = manager
        .current_binding("legacy-terminal")
        .expect("explicit legacy binding");

    manager
        .create(terminal_request(root.path(), "new-project-terminal"))
        .await
        .expect("new owned project terminal");
    let project_binding = manager
        .current_binding("new-project-terminal")
        .expect("project binding");
    assert_ne!(project_binding.session, legacy_name);
    assert_eq!(manager.sessions_for_folder(1).len(), 1);
    assert_eq!(
        terminal
            .session(legacy_name.clone())
            .await
            .unwrap()
            .windows()
            .await
            .unwrap()
            .len(),
        1
    );

    manager
        .terminate_and_remove_folder(1)
        .await
        .expect("close owned project only");
    assert!(terminal.has_session(legacy_name.clone()).await.unwrap());
    assert_eq!(
        manager.current_binding("legacy-terminal").unwrap(),
        legacy_binding
    );
    assert_eq!(
        manager.describe("legacy-terminal").unwrap().ownership,
        TerminalOwnership::LegacyUnresolved
    );
    kill_test_daemon().await;
}

#[cfg(unix)]
#[tokio::test(flavor = "current_thread")]
async fn gui_duplicate_terminal_ids_are_ambiguous_without_rebinding() {
    use berth_term_sdk::berth::{EnsureSession, SessionName};

    let _env_lock = ENV_LOCK.lock().expect("environment lock");
    let root = tempfile::tempdir().expect("synthetic instance root");
    let daemon = super::super::runtime::resolve_terminald_binary()
        .expect("duplicate-id regression requires the test berth-termd binary");
    let _environment = EnvironmentGuard::set(root.path(), daemon);
    let manager = project_manager(root.path()).await;
    manager
        .create(terminal_request(root.path(), "duplicate-id"))
        .await
        .expect("project terminal");
    let original = manager
        .current_binding("duplicate-id")
        .expect("explicit captured binding");
    let terminal = Terminal::builder()
        .unix_socket(default_endpoint_path().expect("isolated endpoint"))
        .connect()
        .await
        .expect("isolated test daemon");
    terminal
        .ensure_session(
            EnsureSession::named(SessionName::new("berth-terminal-independent").unwrap())
                .create_or_reuse()
                .detached(true)
                .working_directory(root.path().to_string_lossy().into_owned())
                .window_name("duplicate-id")
                .argv(vec!["/bin/sh".to_owned()]),
        )
        .await
        .expect("same-named independent window");

    let cold_manager = project_manager(root.path()).await;
    assert!(cold_manager
        .try_list()
        .unwrap_err()
        .to_string()
        .contains("ambiguous"));
    assert!(cold_manager
        .describe("duplicate-id")
        .unwrap_err()
        .to_string()
        .contains("ambiguous"));
    assert!(cold_manager
        .current_binding("duplicate-id")
        .unwrap_err()
        .to_string()
        .contains("ambiguous"));
    assert!(cold_manager.inner.sessions.lock().unwrap().is_empty());
    assert!(manager
        .try_list()
        .unwrap_err()
        .to_string()
        .contains("ambiguous"));
    assert_eq!(manager.current_binding("duplicate-id").unwrap(), original);
    kill_test_daemon().await;
}

fn is_test_daemon_binary(path: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() || metadata.len() == 0 {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

#[tokio::test(flavor = "current_thread")]
async fn folder_id_reuses_one_terminal_session_and_folder_close_kills_all_windows() {
    let _env_lock = ENV_LOCK.lock().expect("environment lock");
    let daemon = env::var_os("BERTH_TERMINALD_PATH")
        .map(PathBuf::from)
        .filter(|path| is_test_daemon_binary(path))
        .or_else(|| {
            let current = env::current_exe().ok()?;
            let debug_dir = current.parent()?.parent()?;
            let candidate = debug_dir.join("berth-termd");
            is_test_daemon_binary(&candidate).then_some(candidate)
        });
    let Some(daemon) = daemon else {
        eprintln!("skipping terminal integration test: berth-termd is not built");
        return;
    };
    let socket_root = tempfile::tempdir().expect("socket root");
    let _environment = EnvironmentGuard::set(socket_root.path(), daemon);
    let manager = project_manager(socket_root.path()).await;

    let first = manager
        .create(terminal_request(socket_root.path(), "terminal-one"))
        .await
        .expect("create first terminal");
    let second = manager
        .create(terminal_request(socket_root.path(), "terminal-two"))
        .await
        .expect("create second terminal");

    assert_eq!(first.folder_id, Some(1));
    assert_eq!(second.folder_id, Some(1));
    let listed = manager.sessions_for_folder(1);
    assert_eq!(listed.len(), 2);
    assert_eq!(listed[0].backend_instance_id, listed[1].backend_instance_id);

    manager
        .terminate("terminal-one")
        .await
        .expect("close one terminal window");
    assert_eq!(manager.sessions_for_folder(1).len(), 1);

    kill_test_daemon().await;
    assert!(matches!(
        manager.describe("terminal-two"),
        Err(TerminalError::NotFound(id)) if id == "terminal-two"
    ));

    let restarted = manager
        .create(terminal_request(socket_root.path(), "terminal-two"))
        .await
        .expect("recreate terminal after daemon loss");
    assert_eq!(restarted.folder_id, Some(1));

    manager
        .terminate_and_remove_folder(1)
        .await
        .expect("close the complete folder session");
    assert!(manager.sessions_for_folder(1).is_empty());

    kill_test_daemon().await;
}

#[tokio::test(flavor = "current_thread")]
async fn active_pane_inventory_refresh_keeps_snapshot_on_original_binding() {
    let _env_lock = ENV_LOCK.lock().expect("environment lock");
    let daemon = env::var_os("BERTH_TERMINALD_PATH")
        .map(PathBuf::from)
        .filter(|path| is_test_daemon_binary(path))
        .or_else(|| {
            let current = env::current_exe().ok()?;
            let debug_dir = current.parent()?.parent()?;
            let candidate = debug_dir.join("berth-termd");
            is_test_daemon_binary(&candidate).then_some(candidate)
        });
    let Some(daemon) = daemon else {
        eprintln!("skipping terminal integration test: berth-termd is not built");
        return;
    };
    let socket_root = tempfile::tempdir().expect("socket root");
    let _environment = EnvironmentGuard::set(socket_root.path(), daemon);
    let manager = project_manager(socket_root.path()).await;
    let terminal_id = "active-refresh";

    manager
        .create(terminal_request(socket_root.path(), terminal_id))
        .await
        .expect("create terminal");
    let (descriptor, target, original_binding, sequence) = {
        let sessions = manager.inner.sessions.lock().expect("index lock");
        let record = sessions.get(terminal_id).expect("created record");
        (
            record.descriptor.clone(),
            record.target.clone(),
            record.binding.clone(),
            record.sequence,
        )
    };

    // 模拟 daemon 报告另一个 active pane 后产生的 inventory 候选。候选 pane id 刻意不存在，
    // 生产 snapshot 仍必须使用已捕获的 pane id。
    let mut scanned_descriptor = descriptor;
    scanned_descriptor.title = "active candidate".to_owned();
    let scanned_target = TerminalTarget {
        pane_index: target.pane_index.saturating_add(1),
        ..target
    };
    let scanned_binding = RuntimeBinding::new(
        original_binding.daemon_instance.clone(),
        original_binding.session.clone(),
        PaneId::new(original_binding.pane_id.as_u32().saturating_add(1)),
        original_binding.generation,
    );
    sync_runtime_index(
        &manager.inner,
        &[LiveTerminal {
            session_id: None,
            descriptor: scanned_descriptor,
            target: scanned_target,
            binding: scanned_binding,
            sequence: sequence.saturating_add(1),
        }],
    );

    {
        let sessions = manager.inner.sessions.lock().expect("index lock");
        assert_eq!(
            sessions.get(terminal_id).expect("retained record").binding,
            original_binding
        );
    }

    // 中间版本已有 epoch、却没有原子代际守卫：旧绑定必须明确报不支持，
    // 不能为了让旧测试通过而退回不安全的 pane id 操作。
    let supports_guard = if original_binding.daemon_instance.is_some() {
        test_daemon_supports_generation_guard().await
    } else {
        false
    };
    if original_binding.daemon_instance.is_some() && !supports_guard {
        assert!(matches!(
            manager.snapshot(terminal_id),
            Err(TerminalError::SpawnFailed(message))
                if message.contains(GENERATION_GUARD)
                    && !message.contains("daemon.instance=")
        ));
    } else {
        let snapshot = manager.snapshot(terminal_id).expect(
            "snapshot must still address the captured pane after inventory sees another active pane",
        );
        assert_eq!(snapshot.terminal_id, terminal_id);
        manager
            .terminate(terminal_id)
            .await
            .expect("close terminal");
    }
    kill_test_daemon().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_folder_terminals_get_distinct_terminal_windows() {
    let _env_lock = ENV_LOCK.lock().expect("environment lock");
    let daemon = env::var_os("BERTH_TERMINALD_PATH")
        .map(PathBuf::from)
        .filter(|path| is_test_daemon_binary(path))
        .or_else(|| {
            let current = env::current_exe().ok()?;
            let debug_dir = current.parent()?.parent()?;
            let candidate = debug_dir.join("berth-termd");
            is_test_daemon_binary(&candidate).then_some(candidate)
        });
    let Some(daemon) = daemon else {
        eprintln!("skipping terminal integration test: berth-termd is not built");
        return;
    };
    let socket_root = tempfile::tempdir().expect("socket root");
    let _environment = EnvironmentGuard::set(socket_root.path(), daemon);
    let manager = project_manager(socket_root.path()).await;
    let first_cwd = socket_root.path().to_path_buf();
    let second_cwd = first_cwd.clone();

    let first_manager = manager.clone();
    let second_manager = manager.clone();
    let first = tokio::spawn(async move {
        first_manager
            .create(terminal_request(&first_cwd, "concurrent-one"))
            .await
    });
    let second = tokio::spawn(async move {
        second_manager
            .create(terminal_request(&second_cwd, "concurrent-two"))
            .await
    });
    let (first, second) = tokio::join!(first, second);
    first
        .expect("first concurrent terminal task")
        .expect("create first concurrent terminal");
    second
        .expect("second concurrent terminal task")
        .expect("create second concurrent terminal");

    assert_eq!(manager.sessions_for_folder(1).len(), 2);

    manager
        .terminate_and_remove_folder(1)
        .await
        .expect("close concurrent folder session");
    kill_test_daemon().await;
}

#[tokio::test(flavor = "current_thread")]
async fn closing_after_window_reindex_resolves_the_bound_pane_first() {
    let _env_lock = ENV_LOCK.lock().expect("environment lock");
    let daemon = env::var_os("BERTH_TERMINALD_PATH")
        .map(PathBuf::from)
        .filter(|path| is_test_daemon_binary(path))
        .or_else(|| {
            let current = env::current_exe().ok()?;
            let debug_dir = current.parent()?.parent()?;
            let candidate = debug_dir.join("berth-termd");
            is_test_daemon_binary(&candidate).then_some(candidate)
        });
    let Some(daemon) = daemon else {
        eprintln!("skipping terminal integration test: berth-termd is not built");
        return;
    };
    let socket_root = tempfile::tempdir().expect("socket root");
    let _environment = EnvironmentGuard::set(socket_root.path(), daemon);
    let manager = project_manager(socket_root.path()).await;

    manager
        .create(terminal_request(socket_root.path(), "reindex-first"))
        .await
        .expect("create first terminal");
    manager
        .create(terminal_request(socket_root.path(), "reindex-second"))
        .await
        .expect("create second terminal");

    // 关闭第一个窗口会让 daemon 重排第二个窗口。两次关闭之间不扫描 inventory：
    // 第二条记录仍保留原窗口 slot，因此 close 路径必须使用已捕获的 pane id，
    // 不能依赖这个过期 slot。
    manager
        .terminate("reindex-first")
        .await
        .expect("close first terminal");
    manager
        .terminate("reindex-second")
        .await
        .expect("close reindexed terminal");
    assert!(matches!(
        manager.describe("reindex-second"),
        Err(TerminalError::NotFound(id)) if id == "reindex-second"
    ));

    kill_test_daemon().await;
}

#[tokio::test(flavor = "current_thread")]
async fn restarted_daemon_epoch_rejects_captured_binding_without_rebinding() {
    let _env_lock = ENV_LOCK.lock().expect("environment lock");
    let daemon = env::var_os("BERTH_TERMINALD_PATH")
        .map(PathBuf::from)
        .filter(|path| is_test_daemon_binary(path))
        .or_else(|| {
            let current = env::current_exe().ok()?;
            let debug_dir = current.parent()?.parent()?;
            let candidate = debug_dir.join("berth-termd");
            is_test_daemon_binary(&candidate).then_some(candidate)
        });
    let Some(daemon) = daemon else {
        eprintln!("skipping terminal integration test: berth-termd is not built");
        return;
    };
    let socket_root = tempfile::tempdir().expect("socket root");
    let _environment = EnvironmentGuard::set(socket_root.path(), daemon);
    let terminal_id = "epoch-restart";

    // E1：捕获 binding 后关闭临时 daemon，期间不扫描 inventory，旧记录保留在索引中。
    let stale_manager = project_manager(socket_root.path()).await;
    stale_manager
        .create(terminal_request(socket_root.path(), terminal_id))
        .await
        .expect("create terminal on first daemon");
    let captured = stale_manager
        .inner
        .sessions
        .lock()
        .expect("index lock")
        .get(terminal_id)
        .expect("captured record")
        .binding
        .clone();
    assert!(captured.daemon_instance.is_some(), "new daemon must advertise an epoch");
    kill_test_daemon().await;

    // E2：同一 endpoint 上重建同名终端，可能复用相同 session/slot/pane id。
    let fresh_manager = project_manager(socket_root.path()).await;
    fresh_manager
        .create(terminal_request(socket_root.path(), terminal_id))
        .await
        .expect("create same-named terminal on restarted daemon");
    let fresh = fresh_manager
        .inner
        .sessions
        .lock()
        .expect("index lock")
        .get(terminal_id)
        .expect("fresh record")
        .binding
        .clone();
    assert_ne!(captured.daemon_instance, fresh.daemon_instance);
    eprintln!(
        "E1 pane={} E2 pane={} (same pane id: {})",
        captured.pane_id.as_u32(),
        fresh.pane_id.as_u32(),
        captured.pane_id == fresh.pane_id
    );

    // 旧 terminal id 必须确定性拒绝，不能接管 E2 的同名终端。执行器在复用前发现缓存连接
    // 已断并重连，因此首次操作就读到 E2 的 epoch，而不是报 RuntimeUnavailable。
    assert!(matches!(
        stale_manager.snapshot(terminal_id),
        Err(TerminalError::InstanceExpired(_))
    ));
    assert!(matches!(
        stale_manager.snapshot(terminal_id),
        Err(TerminalError::InstanceExpired(_))
    ));
    assert!(matches!(
        stale_manager.terminate(terminal_id).await,
        Err(TerminalError::InstanceExpired(_))
    ));
    // E2 不受旧 binding 影响；仅在测试 daemon 支持代际守卫时验证可操作性。
    // epoch-only 中间版本必须明确拒绝，而不是为旧测试静默降级。
    if test_daemon_supports_generation_guard().await {
        fresh_manager
            .snapshot(terminal_id)
            .expect("fresh terminal stays addressable");
        fresh_manager
            .terminate(terminal_id)
            .await
            .expect("close fresh terminal");
    } else {
        assert!(matches!(
            fresh_manager.snapshot(terminal_id),
            Err(TerminalError::SpawnFailed(message)) if message.contains(GENERATION_GUARD)
        ));
    }
    kill_test_daemon().await;
}

/// 切回 tab / 溢出后 resync 时，GUI 用同一个 client id 重新 attach。旧 attachment 的
/// 清理（旧 worker 退出、旧连接的 detach）不能删掉新 attachment 的订阅，否则新连接
/// 收不到输出，下一次 resize / 输入返回 transport_disconnected，终端停在旧画面。
#[cfg(unix)]
#[tokio::test(flavor = "current_thread")]
async fn reattaching_the_same_client_survives_cleanup_of_the_previous_attachment() {
    let _env_lock = ENV_LOCK.lock().expect("environment lock");
    let daemon = env::var_os("BERTH_TERMINALD_PATH")
        .map(PathBuf::from)
        .filter(|path| is_test_daemon_binary(path))
        .or_else(|| {
            let current = env::current_exe().ok()?;
            let debug_dir = current.parent()?.parent()?;
            let candidate = debug_dir.join("berth-termd");
            is_test_daemon_binary(&candidate).then_some(candidate)
        });
    let Some(daemon) = daemon else {
        eprintln!("skipping terminal integration test: berth-termd is not built");
        return;
    };
    let socket_root = tempfile::tempdir().expect("socket root");
    let _environment = EnvironmentGuard::set(socket_root.path(), daemon);
    let manager = project_manager(socket_root.path()).await;
    let terminal_id = "reattach-same-client";
    let mut request = terminal_request(socket_root.path(), terminal_id);
    request.executable = Some("/bin/sh".to_owned());
    // 持续输出，模拟正在工作的 Agent：旧 worker 很快会拿到下一块输出并退出。
    request.args = vec![
        "-c".to_owned(),
        "while :; do printf 'TICK\\n'; sleep 0.02; done".to_owned(),
    ];
    manager.create(request).await.expect("create terminal");

    let previous = manager.attach(terminal_id, "view").expect("first attach");
    let mut current = manager.attach(terminal_id, "view").expect("re-attach");
    // 旧连接的转发任务结束时只拆自己这一次 attach。
    manager.detach_attachment(terminal_id, "view", &previous);
    drop(previous);
    tokio::time::sleep(Duration::from_millis(300)).await;

    assert_eq!(
        manager
            .write_attached(terminal_id, "view", 1, b"x")
            .expect("new attachment still accepts input"),
        1
    );
    let resized = manager
        .resize_attached(terminal_id, "view", 2, 90, 30)
        .expect("new attachment still accepts resize");
    assert_eq!((resized.cols, resized.rows), (90, 30));
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            while current.data_rx.try_recv().is_ok() {}
            tokio::time::sleep(Duration::from_millis(100)).await;
            if let Some(crate::terminal::protocol::TerminalStreamEvent::Output { .. }) =
                current.data_rx.recv().await
            {
                break;
            }
        }
    })
    .await
    .expect("new attachment keeps receiving live output");

    manager
        .terminate(terminal_id)
        .await
        .expect("close test pane");
    kill_test_daemon().await;
}

#[cfg(unix)]
#[tokio::test(flavor = "current_thread")]
async fn attach_snapshot_restores_a_full_screen_app_and_its_modes() {
    let _env_lock = ENV_LOCK.lock().expect("environment lock");
    let daemon = env::var_os("BERTH_TERMINALD_PATH")
        .map(PathBuf::from)
        .filter(|path| is_test_daemon_binary(path))
        .or_else(|| {
            let current = env::current_exe().ok()?;
            let debug_dir = current.parent()?.parent()?;
            let candidate = debug_dir.join("berth-termd");
            is_test_daemon_binary(&candidate).then_some(candidate)
        });
    let Some(daemon) = daemon else {
        eprintln!("skipping terminal integration test: berth-termd is not built");
        return;
    };
    let socket_root = tempfile::tempdir().expect("socket root");
    let _environment = EnvironmentGuard::set(socket_root.path(), daemon);
    let manager = project_manager(socket_root.path()).await;
    let terminal_id = "full-screen-app";
    let mut request = terminal_request(socket_root.path(), terminal_id);
    request.executable = Some("/bin/sh".to_owned());
    // 像 Cline：先在普通屏留一行，再进入全屏并打开任意鼠标 / SGR / 粘贴包裹 / DECCKM。
    request.args = vec![
        "-c".to_owned(),
        "printf 'NORMAL-LINE\\n'; \
         printf '\\033[?1049h\\033[?1003h\\033[?1006h\\033[?2004h\\033[?1h\\033[5;3HALT-SCREEN'; \
         sleep 30"
            .to_owned(),
    ];
    manager.create(request).await.expect("create terminal");
    tokio::time::sleep(Duration::from_millis(500)).await;

    let attachment = manager.attach(terminal_id, "view").expect("attach");
    let ansi = String::from_utf8_lossy(&attachment.snapshot.ansi).into_owned();
    let enter = ansi
        .find("\x1b[?1049h")
        .expect("snapshot enters the alternate screen");
    let normal = ansi.find("NORMAL-LINE").expect("normal screen is kept");
    let alt = ansi
        .find("\x1b[5;1H")
        .expect("alternate rows are placed by row");
    assert!(normal < enter && enter < alt, "{ansi:?}");
    assert!(ansi[alt..].starts_with("\x1b[5;1H  ALT-SCREEN"), "{ansi:?}");
    for mode in ["\x1b[?1003h", "\x1b[?1006h", "\x1b[?2004h", "\x1b[?1h"] {
        assert!(ansi[alt..].contains(mode), "missing {mode:?} in {ansi:?}");
    }

    manager.detach_attachment(terminal_id, "view", &attachment);
    manager
        .terminate(terminal_id)
        .await
        .expect("close test pane");
    kill_test_daemon().await;
}

#[cfg(unix)]
#[tokio::test(flavor = "current_thread")]
async fn gui_attach_round_trip_and_detach_preserve_bound_pane() {
    let _env_lock = ENV_LOCK.lock().expect("environment lock");
    let daemon = env::var_os("BERTH_TERMINALD_PATH")
        .map(PathBuf::from)
        .filter(|path| is_test_daemon_binary(path))
        .or_else(|| {
            let current = env::current_exe().ok()?;
            let debug_dir = current.parent()?.parent()?;
            let candidate = debug_dir.join("berth-termd");
            is_test_daemon_binary(&candidate).then_some(candidate)
        });
    let Some(daemon) = daemon else {
        eprintln!("skipping terminal integration test: berth-termd is not built");
        return;
    };
    let socket_root = tempfile::tempdir().expect("socket root");
    let _environment = EnvironmentGuard::set(socket_root.path(), daemon);
    let endpoint = default_endpoint_path().expect("isolated endpoint");
    eprintln!("isolated round-trip endpoint: {}", endpoint.display());
    let manager = project_manager(socket_root.path()).await;
    let terminal_id = "attach-round-trip";
    let mut request = terminal_request(socket_root.path(), terminal_id);
    request.executable = Some("/bin/sh".to_owned());
    request.args = vec![
        "-c".to_owned(),
        "printf 'T4_READY\\n'; while IFS= read -r input; do printf 'T4_REPLY_%s\\n' \"$input\"; done"
            .to_owned(),
    ];
    manager.create(request).await.expect("create terminal");
    let binding = manager
        .inner
        .sessions
        .lock()
        .expect("index lock")
        .get(terminal_id)
        .expect("created record")
        .binding
        .clone();
    let terminal = Terminal::builder()
        .unix_socket(endpoint)
        .connect()
        .await
        .expect("connect independent client");
    assert_eq!(
        terminal.daemon_instance().await.expect("read daemon epoch"),
        binding.daemon_instance
    );
    eprintln!(
        "round-trip daemon: epoch={}, generation_guard={}",
        binding.daemon_instance.is_some(),
        test_daemon_supports_generation_guard().await
    );
    let pane = terminal
        .pane_by_id(binding.session.clone(), binding.pane_id)
        .await
        .expect("resolve same pane from independent client");

    // 等到测试进程已经输出，再验证首次 snapshot，不依赖 shell 启动时序。
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if pane
                .snapshot()
                .await
                .expect("initial pane snapshot")
                .visible_text()
                .contains("T4_READY")
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("test process becomes ready");

    for (client_id, input) in [("first-view", "FIRST"), ("reopened-view", "SECOND")] {
        let mut attachment = manager.attach(terminal_id, client_id).expect("attach view");
        assert!(String::from_utf8_lossy(&attachment.snapshot.ansi).contains("T4_READY"));
        if input == "SECOND" {
            assert!(String::from_utf8_lossy(&attachment.snapshot.ansi)
                .contains("T4_REPLY_DETACHED_FIRST"));
        }
        assert_eq!(
            manager
                .write_attached(terminal_id, client_id, 1, format!("{input}\n").as_bytes())
                .expect("write attached input"),
            1
        );
        let expected = format!("T4_REPLY_{input}");
        let mut output = Vec::new();
        let mut sequence = attachment.snapshot.sequence;
        tokio::time::timeout(Duration::from_secs(3), async {
            while !String::from_utf8_lossy(&output).contains(&expected) {
                let event = attachment.data_rx.recv().await.expect("live output event");
                if let crate::terminal::protocol::TerminalStreamEvent::Output {
                    sequence: next,
                    data,
                    ..
                } = event
                {
                    assert!(next > sequence, "output follows the snapshot boundary");
                    sequence = next;
                    output.extend(data);
                }
            }
        })
        .await
        .expect("attached input produces live process output");
        let resized = manager
            .resize_attached(terminal_id, client_id, 2, 96, 30)
            .expect("resize attached pane");
        assert_eq!((resized.cols, resized.rows), (96, 30));
        manager.detach(terminal_id, client_id).expect("detach view");
        drop(attachment);

        // GUI 释放订阅后，独立客户端仍能操作原 pane，重连也能读到这段输出。
        pane.send_text(format!("DETACHED_{input}\n"))
            .await
            .expect("independent client writes after GUI detach");
        let expected = format!("T4_REPLY_DETACHED_{input}");
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if pane
                    .snapshot()
                    .await
                    .expect("snapshot after detach")
                    .visible_text()
                    .contains(&expected)
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("detached pane still executes input");
        let info = pane
            .info()
            .await
            .expect("pane survives detach")
            .panes
            .remove(0);
        assert_eq!(info.id, binding.pane_id);
        assert_eq!(info.generation, binding.generation);
        assert!(matches!(info.process, PaneProcessState::Running { .. }));
    }
    assert_eq!(
        manager
            .inner
            .sessions
            .lock()
            .expect("index lock")
            .get(terminal_id)
            .expect("record survives detach")
            .binding,
        binding
    );
    manager
        .terminate(terminal_id)
        .await
        .expect("close test pane");
    kill_test_daemon().await;
}

#[cfg(unix)]
#[tokio::test(flavor = "current_thread")]
async fn respawned_pane_rejects_stale_gui_operations_without_touching_new_process() {
    let _env_lock = ENV_LOCK.lock().expect("environment lock");
    let daemon = env::var_os("BERTH_TERMINALD_PATH")
        .map(PathBuf::from)
        .filter(|path| is_test_daemon_binary(path))
        .or_else(|| {
            let current = env::current_exe().ok()?;
            let debug_dir = current.parent()?.parent()?;
            let candidate = debug_dir.join("berth-termd");
            is_test_daemon_binary(&candidate).then_some(candidate)
        });
    let Some(daemon) = daemon else {
        eprintln!("skipping terminal integration test: berth-termd is not built");
        return;
    };
    let socket_root = tempfile::tempdir().expect("socket root");
    let _environment = EnvironmentGuard::set(socket_root.path(), daemon);
    let manager = project_manager(socket_root.path()).await;
    let terminal_id = "respawned-pane";
    let client_id = "resize-client";
    manager
        .create(terminal_request(socket_root.path(), terminal_id))
        .await
        .expect("create terminal");
    assert!(test_daemon_supports_generation_guard().await);
    let binding = manager
        .inner
        .sessions
        .lock()
        .expect("index lock")
        .get(terminal_id)
        .expect("created record")
        .binding
        .clone();
    assert!(binding.daemon_instance.is_some());
    let mut attachment = manager
        .attach(terminal_id, "stream-client")
        .expect("attach before respawn");

    // 单独注册 resize 客户端，避免真实输出 worker 退出时与 resize 的代际断言竞争。
    let (control_tx, _) = tokio::sync::watch::channel(SubscriberControl::Attached { sequence: 0 });
    manager
        .inner
        .sessions
        .lock()
        .expect("index lock")
        .get_mut(terminal_id)
        .expect("created record")
        .subscribers
        .insert(
            client_id.to_owned(),
            SubscriberHandle {
                stop: Arc::new(AtomicBool::new(false)),
                control_tx,
            },
        );

    // 独立协议连接模拟 CLI 在同一个 daemon 内 respawn 已被 GUI 捕获的 PaneId。
    let mut stream = UnixStream::connect(default_endpoint_path().expect("isolated endpoint"))
        .await
        .expect("connect to isolated daemon");
    let mut decoder = FrameDecoder::new();
    assert!(matches!(
        test_protocol_request(
            &mut stream,
            &mut decoder,
            Request::Handshake(HandshakeRequest::current())
        )
        .await,
        Response::Handshake(_)
    ));
    assert!(matches!(
        test_protocol_request(
            &mut stream,
            &mut decoder,
            Request::PaneRespawn(Box::new(PaneRespawnRequest {
                target: PaneTargetRef::by_id(binding.session.clone(), binding.pane_id),
                kill: true,
                start_directory: None,
                environment: None,
                command: Some(vec![
                    "printf 'T4_NEW_GENERATION_MARKER\\n'; exec cat".to_owned()
                ]),
                process_command: None,
                keep_alive_on_exit: None,
            })),
        )
        .await,
        Response::RespawnPane(_)
    ));

    let terminal = Terminal::builder()
        .unix_socket(default_endpoint_path().expect("isolated endpoint"))
        .connect()
        .await
        .expect("connect to new process");
    let pane = terminal
        .pane_by_id(binding.session.clone(), binding.pane_id)
        .await
        .expect("same pane id survives respawn");
    let after_respawn = pane.info().await.expect("new pane info").panes.remove(0);
    assert_eq!(after_respawn.id, binding.pane_id);
    assert!(after_respawn.generation > binding.generation);
    assert!(matches!(
        after_respawn.process,
        PaneProcessState::Running { .. }
    ));

    assert!(matches!(
        manager.snapshot(terminal_id),
        Err(TerminalError::InstanceExpired(_))
    ));
    assert!(matches!(
        manager.send_text_then_key(terminal_id, "T4_OLD_INPUT_MARKER", "Enter"),
        Err(TerminalOperationError::Protocol(
            TerminalErrorCode::TerminalInstanceExpired
        ))
    ));
    assert!(matches!(
        manager.resize_attached(terminal_id, client_id, 1, 120, 40),
        Err(TerminalOperationError::Protocol(
            TerminalErrorCode::TerminalInstanceExpired
        ))
    ));
    assert!(matches!(
        manager.terminate(terminal_id).await,
        Err(TerminalError::InstanceExpired(_))
    ));
    assert!(matches!(
        manager.attach(terminal_id, "late-client"),
        Err(TerminalError::InstanceExpired(_))
    ));

    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if matches!(
                &*attachment.control_rx.borrow_and_update(),
                SubscriberControl::ResyncRequired { .. }
            ) {
                break;
            }
            attachment
                .control_rx
                .changed()
                .await
                .expect("stream worker reports stale binding");
        }
    })
    .await
    .expect("old output stream requests resync");
    while let Ok(event) = attachment.data_rx.try_recv() {
        if let crate::terminal::protocol::TerminalStreamEvent::Output { data, .. } = event {
            assert!(!String::from_utf8_lossy(&data).contains("T4_NEW_GENERATION_MARKER"));
        }
    }

    let snapshot = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let snapshot = pane.snapshot().await.expect("new process snapshot");
            if snapshot.visible_text().contains("T4_NEW_GENERATION_MARKER") {
                break snapshot;
            }
            tokio::time::sleep(Duration::from_millis(40)).await;
        }
    })
    .await
    .expect("new process output appears");
    assert!(!snapshot.visible_text().contains("T4_OLD_INPUT_MARKER"));
    let after_rejections = pane
        .info()
        .await
        .expect("new pane remains alive")
        .panes
        .remove(0);
    assert_eq!(after_rejections.id, binding.pane_id);
    assert_eq!(after_rejections.generation, after_respawn.generation);
    assert_eq!(after_rejections.size, after_respawn.size);
    assert!(matches!(
        after_rejections.process,
        PaneProcessState::Running { .. }
    ));
    kill_test_daemon().await;
}

#[cfg(unix)]
async fn test_protocol_request(
    stream: &mut UnixStream,
    decoder: &mut FrameDecoder,
    request: Request,
) -> Response {
    stream
        .write_all(&encode_frame(&request).expect("encode protocol request"))
        .await
        .expect("send protocol request");
    let mut buffer = [0_u8; 8192];
    loop {
        if let Some(response) = decoder.next_frame::<Response>().expect("decode response") {
            return response;
        }
        let read = stream
            .read(&mut buffer)
            .await
            .expect("read protocol response");
        assert_ne!(read, 0, "daemon closed connection before response");
        decoder.push_bytes(&buffer[..read]);
    }
}

async fn test_daemon_supports_generation_guard() -> bool {
    Terminal::builder()
        .unix_socket(default_endpoint_path().expect("isolated test endpoint"))
        .connect()
        .await
        .expect("connect to test daemon")
        .capabilities()
        .await
        .expect("read test daemon capabilities")
        .iter()
        .any(|capability| capability == GENERATION_GUARD)
}

async fn kill_test_daemon() {
    let Ok(endpoint) = default_endpoint_path() else {
        return;
    };
    if let Ok(client) = Terminal::builder().unix_socket(endpoint).connect().await {
        let _ = client.shutdown().await;
    }
}
