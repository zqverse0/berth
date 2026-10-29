//! 普通 CLI 进程的合成工作区回归；不连接用户 GUI、数据库或 daemon。

#![cfg(unix)]

use std::error::Error;
use std::path::Path;
use std::process::Command;
use std::sync::Barrier;
use std::time::{Duration, Instant};

use sea_orm::ConnectionTrait;
use serde_json::Value;
use berth_project_core::instance::DataInstance;
use berth_project_core::open::open_or_upgrade;
use berth_project_core::runtime::project_session_key;
use berth_project_core::service::{catalog, folder_service};
use berth_term_sdk::{EnsureSession, TerminalClientBuilder};

#[path = "../src/attach_client/test_support.rs"]
#[allow(dead_code)]
mod test_support;

fn cli(data: &Path, socket: &Path, args: &[&str], code: i32) -> (Value, Duration) {
    let started = Instant::now();
    let output = Command::new(env!("CARGO_BIN_EXE_berth"))
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("SHELL", "/bin/sh")
        .env("BERTH_SDK_DAEMON_BINARY", data.join("not-a-daemon"))
        .env("HOME", data)
        .env("BERTH_HOME", data)
        .env("BERTH_DATA_DIR", data)
        .env("BERTH_DATA_FILE", "berth.db")
        .env("BERTH_TMPDIR", data)
        .env("BERTH_GUI_ENDPOINT", data.join("absent-gui.sock"))
        .arg("-S")
        .arg(socket)
        .args(args)
        .output()
        .expect("synthetic CLI process");
    let elapsed = started.elapsed();
    assert_eq!(
        output.status.code(),
        Some(code),
        "stdout={}, stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    // 拒绝成功对象后再跟错误对象的双 JSON 输出。
    let value = serde_json::from_slice(&output.stdout).expect("one complete JSON object");
    (value, elapsed)
}

#[tokio::test]
async fn normal_cli_creates_project_terminals_without_gui_and_reuses_returned_refs(
) -> Result<(), Box<dyn Error>> {
    let data = tempfile::tempdir()?;
    let owner = DataInstance::create_if_missing(data.path(), "berth.db");
    let (connection, state) = open_or_upgrade(&owner).await;
    assert!(state.is_ready());
    let connection = connection.expect("synthetic database");
    for name in ["project-a", "project-b"] {
        let path = data.path().join(name);
        std::fs::create_dir(&path)?;
        folder_service::add_folder(&connection, path.to_str().unwrap()).await?;
    }
    let projects = catalog::list_catalog(&connection, catalog::CatalogScope::All).await?;
    connection
        .execute_unprepared("PRAGMA wal_checkpoint(TRUNCATE)")
        .await?;
    connection.close().await?;
    let before = std::fs::read(owner.db_path())?;
    let harness = test_support::TestHarness::new("cli-create");
    let mut server = test_support::start_server(&harness)?;
    let socket = harness.socket_path();
    let mut created = Vec::new();
    // 三个终端全部由产品 CLI 创建，SDK 只用于事后身份核对，不代建。
    for project in [&projects[0], &projects[1], &projects[1]] {
        let id = project.id.to_string();
        let (result, elapsed) = cli(
            data.path(),
            socket,
            &["terminal", "create", "--project", &id, "--json"],
            0,
        );
        let result = result["terminal"].clone();
        assert_eq!(result["project_id"], project.id);
        assert_eq!(result["cwd"], project.path);
        assert_eq!(result["status"], "created");
        assert!(result.get("content").is_none());
        let binding =
            berth_control_proto::TargetBindingRef::decode(result["target_ref"].as_str().unwrap())?;
        assert!(binding.daemon_instance.is_some());
        assert!(binding.generation > 0);
        assert_eq!(result["pane_id"], binding.pane_id);
        println!(
            "cli_create_ms={:.3} project_id={} pane_id={}",
            elapsed.as_secs_f64() * 1000.0,
            project.id,
            binding.pane_id
        );
        created.push(result);
    }
    assert_eq!(created[1]["session"], created[2]["session"]);
    assert_ne!(created[0]["session"], created[1]["session"]);
    assert_ne!(created[1]["pane_id"], created[2]["pane_id"]);
    assert_ne!(created[1]["terminal_id"], created[2]["terminal_id"]);
    assert_ne!(created[1]["target_ref"], created[2]["target_ref"]);

    // 不经 list/current，直接使用本次返回的 ref 输入和读取。
    let reference = created[2]["target_ref"].as_str().unwrap();
    cli(
        data.path(),
        socket,
        &[
            "terminal",
            "send",
            "--target-ref",
            reference,
            "--text",
            "printf 'D0_CLI_CREATED_%s\\n' READY",
            "--json",
        ],
        0,
    );
    cli(
        data.path(),
        socket,
        &[
            "terminal",
            "send",
            "--target-ref",
            reference,
            "--key",
            "Enter",
            "--json",
        ],
        0,
    );
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let (result, _) = cli(
            data.path(),
            socket,
            &["terminal", "capture", "--target-ref", reference, "--json"],
            0,
        );
        if result["content"]
            .as_str()
            .unwrap()
            .contains("D0_CLI_CREATED_READY")
        {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "created shell output was not observed"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    for other in &created[..2] {
        let (result, _) = cli(
            data.path(),
            socket,
            &[
                "terminal",
                "capture",
                "--target-ref",
                other["target_ref"].as_str().unwrap(),
                "--json",
            ],
            0,
        );
        assert!(!result["content"]
            .as_str()
            .unwrap()
            .contains("D0_CLI_CREATED_READY"));
    }

    // 普通新 shell 直接通过 PATH 和继承的实例环境调用 berth，不手工 export。
    for (index, terminal) in created[1..].iter().enumerate() {
        let projects_file = data.path().join(format!("nested-projects-{index}.json"));
        let terminals_file = data.path().join(format!("nested-terminals-{index}.json"));
        let command = format!(
            "berth project ls --json > '{}' && berth terminal list --json > '{}'",
            projects_file.display(),
            terminals_file.display()
        );
        let reference = terminal["target_ref"].as_str().unwrap();
        cli(
            data.path(),
            socket,
            &[
                "terminal",
                "send",
                "--target-ref",
                reference,
                "--text",
                &command,
                "--json",
            ],
            0,
        );
        cli(
            data.path(),
            socket,
            &[
                "terminal",
                "send",
                "--target-ref",
                reference,
                "--key",
                "Enter",
                "--json",
            ],
            0,
        );
        let deadline = Instant::now() + Duration::from_secs(3);
        let nested = loop {
            if let Ok(bytes) = std::fs::read(&terminals_file) {
                if let Ok(value) = serde_json::from_slice::<Value>(&bytes) {
                    break value;
                }
            }
            assert!(
                Instant::now() < deadline,
                "ordinary shell could not use same-instance CLI"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        };
        assert_eq!(nested["terminals"].as_array().unwrap().len(), 3);
        let nested: Value = serde_json::from_slice(&std::fs::read(projects_file)?)?;
        assert_eq!(nested.as_array().unwrap().len(), 2);
    }
    let terminal = TerminalClientBuilder::new()
        .unix_socket(socket.to_path_buf())
        .connect()
        .await?;
    for entry in &created {
        let session = terminal
            .session(test_support::session_name(
                entry["session"].as_str().unwrap(),
            ))
            .await?;
        let windows = session.windows().await?;
        assert!(windows
            .iter()
            .any(|window| window.name.as_deref() == entry["terminal_id"].as_str()));
    }
    assert!(!data.path().join("absent-gui.sock").exists());
    assert_eq!(
        std::fs::read(owner.db_path())?,
        before,
        "create must not modify catalog"
    );
    server.shutdown()?;
    Ok(())
}

#[tokio::test]
async fn normal_cli_concurrent_creates_keep_distinct_refs_in_new_and_existing_session(
) -> Result<(), Box<dyn Error>> {
    let data = tempfile::tempdir()?;
    let owner = DataInstance::create_if_missing(data.path(), "berth.db");
    let (connection, state) = open_or_upgrade(&owner).await;
    assert!(state.is_ready());
    let connection = connection.expect("synthetic database");
    let directory = data.path().join("concurrent-project");
    std::fs::create_dir(&directory)?;
    folder_service::add_folder(&connection, directory.to_str().unwrap()).await?;
    let projects = catalog::list_catalog(&connection, catalog::CatalogScope::All).await?;
    let project = &projects[0];
    let namespace = owner
        .namespace_key()
        .map_err(|state| std::io::Error::other(state.message()))?;
    let session = project_session_key(&namespace, &project.project_runtime_id)?;
    connection
        .execute_unprepared("PRAGMA wal_checkpoint(TRUNCATE)")
        .await?;
    connection.close().await?;
    let before = std::fs::read(owner.db_path())?;
    let harness = test_support::TestHarness::new("cli-concurrent-create");
    let mut server = test_support::start_server(&harness)?;
    let socket = harness.socket_path();
    let id = project.id.to_string();
    let mut created: Vec<Value> = Vec::new();

    // 首批竞争创建同一 session，第二批在已有 session 内并发创建；只建四个终端。
    for phase in ["new-session", "existing-session"] {
        let barrier = Barrier::new(3);
        let results = std::thread::scope(|scope| {
            let workers: Vec<_> = (0..2)
                .map(|_| {
                    scope.spawn(|| {
                        barrier.wait();
                        cli(
                            data.path(),
                            socket,
                            &["terminal", "create", "--project", &id, "--json"],
                            0,
                        )
                    })
                })
                .collect();
            barrier.wait();
            workers
                .into_iter()
                .map(|worker| worker.join().expect("concurrent CLI process"))
                .collect::<Vec<_>>()
        });
        for (result, elapsed) in results {
            let result = result["terminal"].clone();
            assert_eq!(result["project_id"], project.id);
            assert_eq!(result["cwd"], project.path);
            assert_eq!(result["status"], "created");
            assert_eq!(result["session"], session);
            assert!(!result["terminal_id"].as_str().unwrap().is_empty());
            let binding = berth_control_proto::TargetBindingRef::decode(
                result["target_ref"].as_str().unwrap(),
            )?;
            assert_eq!(binding.session, session);
            assert_eq!(result["pane_id"], binding.pane_id);
            assert!(binding.daemon_instance.is_some());
            assert!(binding.generation > 0);
            for previous in &created {
                for field in ["target_ref", "pane_id", "terminal_id"] {
                    assert_ne!(
                        result[field], previous[field],
                        "{phase} returned a previously created {field}"
                    );
                }
            }
            println!(
                "cli_concurrent_create phase={phase} elapsed_ms={:.3} project_id={} pane_id={}",
                elapsed.as_secs_f64() * 1000.0,
                project.id,
                binding.pane_id
            );
            created.push(result);
        }
    }
    assert_eq!(created.len(), 4);

    // 直接使用每次创建返回的 ref；拆开标记，避免把 shell 回显误当作执行结果。
    let markers: Vec<_> = (0..created.len())
        .map(|index| format!("D0_CLI_CONCURRENT_{index}_READY"))
        .collect();
    for (index, entry) in created.iter().enumerate() {
        let reference = entry["target_ref"].as_str().unwrap();
        let command = format!("printf 'D0_CLI_CONCURRENT_{index}_%s\\n' READY");
        for (option, input) in [("--text", command.as_str()), ("--key", "Enter")] {
            cli(
                data.path(),
                socket,
                &[
                    "terminal",
                    "send",
                    "--target-ref",
                    reference,
                    option,
                    input,
                    "--json",
                ],
                0,
            );
        }
    }
    let mut capture_calls = 0;
    for (index, entry) in created.iter().enumerate() {
        let reference = entry["target_ref"].as_str().unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let (result, _) = cli(
                data.path(),
                socket,
                &["terminal", "capture", "--target-ref", reference, "--json"],
                0,
            );
            capture_calls += 1;
            let content = result["content"].as_str().unwrap();
            for (other, marker) in markers.iter().enumerate() {
                if other != index {
                    assert!(
                        !content.contains(marker),
                        "terminal {index} received terminal {other}'s marker: {content}"
                    );
                }
            }
            if content.contains(&markers[index]) {
                assert!(result["output_sequence"].as_u64().unwrap() > 0);
                break;
            }
            assert!(
                Instant::now() < deadline,
                "terminal {index} did not produce its marker: {content}"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
    assert!(!data.path().join("absent-gui.sock").exists());
    assert_eq!(
        std::fs::read(owner.db_path())?,
        before,
        "concurrent create and ref operations must not modify catalog"
    );
    println!(
        "cli={} create_calls={} send_calls={} capture_calls={capture_calls}",
        env!("CARGO_BIN_EXE_berth"),
        created.len(),
        created.len() * 2
    );
    server.shutdown()?;
    Ok(())
}

#[tokio::test]
async fn normal_cli_create_rejects_invalid_project_directory_and_instance_before_startup(
) -> Result<(), Box<dyn Error>> {
    let data = tempfile::tempdir()?;
    let owner = DataInstance::create_if_missing(data.path(), "berth.db");
    let (connection, state) = open_or_upgrade(&owner).await;
    assert!(state.is_ready());
    let connection = connection.expect("synthetic database");
    let directory = data.path().join("removed-project");
    std::fs::create_dir(&directory)?;
    folder_service::add_folder(&connection, directory.to_str().unwrap()).await?;
    let projects = catalog::list_catalog(&connection, catalog::CatalogScope::All).await?;
    connection
        .execute_unprepared("PRAGMA wal_checkpoint(TRUNCATE)")
        .await?;
    connection.close().await?;
    std::fs::remove_dir(&directory)?;
    let before = std::fs::read(owner.db_path())?;
    let socket = data.path().join("unstarted/s.sock");
    let (missing, _) = cli(
        data.path(),
        &socket,
        &["terminal", "create", "--project", "99999", "--json"],
        4,
    );
    assert_eq!(missing["error"]["kind"], "not_found");
    let id = projects[0].id.to_string();
    let (removed, _) = cli(
        data.path(),
        &socket,
        &["terminal", "create", "--project", &id, "--json"],
        2,
    );
    assert_eq!(removed["error"]["kind"], "invalid_params");
    let missing_data = data.path().join("uncreated-data");
    let (missing, _) = cli(
        &missing_data,
        &socket,
        &["terminal", "create", "--project", &id, "--json"],
        5,
    );
    assert_eq!(missing["error"]["kind"], "instance_unavailable");
    assert!(!missing_data.exists());
    assert!(
        !socket.parent().unwrap().exists(),
        "preflight must not start daemon"
    );
    assert_eq!(std::fs::read(owner.db_path())?, before);
    Ok(())
}

fn report_latency(name: &str, samples: &[Duration]) -> Duration {
    let mut ranked = samples.to_vec();
    ranked.sort();
    let percentile = |percent: usize| ranked[(ranked.len() * percent).div_ceil(100) - 1];
    let p95 = percentile(95);
    println!(
        "{name}: samples={} errors=0 p50_ms={:.3} p95_ms={:.3} raw_ms={:?}",
        samples.len(),
        percentile(50).as_secs_f64() * 1000.0,
        p95.as_secs_f64() * 1000.0,
        samples
            .iter()
            .map(|value| value.as_secs_f64() * 1000.0)
            .collect::<Vec<_>>()
    );
    p95
}

#[tokio::test]
#[ignore = "显式运行的 64 终端合成 CLI 端到端成本门"]
async fn normal_cli_discovers_cross_project_targets_and_measures_warm_latency(
) -> Result<(), Box<dyn Error>> {
    let data = tempfile::tempdir()?;
    let owner = DataInstance::create_if_missing(data.path(), "berth.db");
    let (connection, state) = open_or_upgrade(&owner).await;
    assert!(state.is_ready());
    let connection = connection.expect("synthetic database");
    for name in ["project-a", "project-b"] {
        let path = data.path().join(name);
        std::fs::create_dir(&path)?;
        folder_service::add_folder(&connection, path.to_str().unwrap()).await?;
    }
    let projects = catalog::list_catalog(&connection, catalog::CatalogScope::All).await?;
    let namespace = owner
        .namespace_key()
        .map_err(|state| std::io::Error::other(state.message()))?;
    // 比较主库字节前先结算夹具写入；连接池 close 不保证 WAL 已落盘。
    connection
        .execute_unprepared("PRAGMA wal_checkpoint(TRUNCATE)")
        .await?;
    connection.close().await?;
    let before = std::fs::read(owner.db_path())?;
    let harness = test_support::TestHarness::new("workspace-e2e");
    let mut server = test_support::start_server(&harness)?;
    let terminal = TerminalClientBuilder::new()
        .unix_socket(harness.socket_path().to_path_buf())
        .connect()
        .await?;
    let program = [
        "/bin/sh",
        "-c",
        "printf 'READY\\n'; while IFS= read -r input; do printf 'D0_E2E_%s\\n' \"$input\"; done",
    ];
    for project in &projects {
        let session = EnsureSession::named(test_support::session_name(&project_session_key(
            &namespace,
            &project.project_runtime_id,
        )?))
        .create_only()
        .working_directory(project.path.clone())
        .window_name("duplicate-title")
        .argv(program)
        .ensure(&terminal)
        .await?;
        for _ in 1..32 {
            session
                .new_window_with()
                .name("duplicate-title")
                .spawn(program)
                .await?;
        }
    }
    let (listed, _) = cli(
        data.path(),
        harness.socket_path(),
        &["terminal", "list", "--json"],
        0,
    );
    let entries = listed["terminals"].as_array().expect("terminal metadata");
    assert_eq!(entries.len(), 64);
    assert!(entries
        .iter()
        .all(|entry| entry["ownership"] == "project" && entry.get("content").is_none()));
    let target = |project_id: i32| {
        entries
            .iter()
            .find(|entry| entry["project_id"] == project_id)
            .unwrap()["target_ref"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    let a = target(projects[0].id);
    let b = target(projects[1].id);
    cli(
        data.path(),
        harness.socket_path(),
        &[
            "terminal",
            "send",
            "--target-ref",
            &b,
            "--text",
            "B_ONLY",
            "--json",
        ],
        0,
    );
    cli(
        data.path(),
        harness.socket_path(),
        &[
            "terminal",
            "send",
            "--target-ref",
            &b,
            "--key",
            "Enter",
            "--json",
        ],
        0,
    );
    let capture = ["terminal", "capture", "--target-ref", &b, "--json"];
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let (result, _) = cli(data.path(), harness.socket_path(), &capture, 0);
        if result["content"]
            .as_str()
            .unwrap()
            .contains("D0_E2E_B_ONLY")
        {
            assert!(result["output_sequence"].as_u64().unwrap() > 0);
            break;
        }
        assert!(Instant::now() < deadline, "B output was not observed");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let (other, _) = cli(
        data.path(),
        harness.socket_path(),
        &["terminal", "capture", "--target-ref", &a, "--json"],
        0,
    );
    assert!(!other["content"].as_str().unwrap().contains("B_ONLY"));
    let (unavailable, _) = cli(
        data.path(),
        harness.socket_path(),
        &["project", "current-file", "--json"],
        5,
    );
    assert_eq!(unavailable["error"]["kind"], "gui_unavailable");
    let mut list_samples = Vec::new();
    let mut capture_samples = Vec::new();
    for index in 0..35 {
        let (result, elapsed) = cli(
            data.path(),
            harness.socket_path(),
            &["terminal", "list", "--json"],
            0,
        );
        assert_eq!(result["terminals"].as_array().unwrap().len(), 64);
        if index >= 5 {
            list_samples.push(elapsed);
        }
        let (result, elapsed) = cli(data.path(), harness.socket_path(), &capture, 0);
        assert!(result["content"]
            .as_str()
            .unwrap()
            .contains("D0_E2E_B_ONLY"));
        if index >= 5 {
            capture_samples.push(elapsed);
        }
    }
    println!(
        "cli={} terminals=64 warmup=5 percentile=nearest-rank",
        env!("CARGO_BIN_EXE_berth")
    );
    let list_p95 = report_latency("terminal_list", &list_samples);
    let capture_p95 = report_latency("terminal_capture", &capture_samples);
    assert!(
        std::fs::read(owner.db_path())? == before,
        "CLI must not write catalog"
    );
    server.shutdown()?;
    let (offline, _) = cli(
        data.path(),
        harness.socket_path(),
        &["terminal", "list", "--json"],
        3,
    );
    assert_eq!(offline["error"]["kind"], "daemon_unavailable");
    assert!(
        list_p95 <= Duration::from_millis(500),
        "list p95 exceeded budget"
    );
    assert!(
        capture_p95 <= Duration::from_millis(250),
        "capture p95 exceeded budget"
    );
    Ok(())
}
