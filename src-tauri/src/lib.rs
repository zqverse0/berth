pub use network::proxy::init_proxy_from_db;
pub mod tool;

/// Automation 计划变更时唤醒 deadline 驱动的调度器。
/// `Notify::notify_one` 在无等待者时会保留一个 permit,调度器 tick 期间的变更不会丢失。
pub(crate) static AUTOMATION_SCHEDULER_WAKE: std::sync::LazyLock<tokio::sync::Notify> =
    std::sync::LazyLock::new(tokio::sync::Notify::new);

mod app_error;
pub mod backgrounds;
pub mod commands;
#[cfg(feature = "tauri-runtime")]
mod control;
// 复用纯内存回执实现执行轻量回归，不为测试链接桌面运行时。
#[cfg(all(test, feature = "test-utils", not(feature = "tauri-runtime")))]
#[path = "control/pending.rs"]
mod control_pending;
pub mod db;
pub mod decision;
pub mod devices;
pub mod event_bridge;
pub mod git;
pub mod knowledge;
pub mod logging;
pub mod model_provider;
pub mod models;
pub mod platform;
#[cfg(feature = "tauri-runtime")]
mod remote;
mod network;
pub mod preview_watch;
pub mod sessions;
pub mod terminal;
pub mod berth_agents;
pub mod berth_tasks;
pub mod translate;
pub mod update;
pub mod versioned_file_responder;
pub mod workspace_state;

/// Sweep leftover ACP binary cache trash from the retired installer path.
/// Safe to call any time; intended to be invoked once at startup from a
/// detached OS thread. Does not block, does not panic, errors are silently dropped.
pub fn sweep_acp_binary_trash() {
    crate::berth_agents::binary_cache::sweep_trash();
}

#[cfg(feature = "tauri-runtime")]
mod tauri_app {
    use std::sync::atomic::{AtomicBool, Ordering};

    use crate::model_provider::commands as usage_commands;
    use crate::commands::{
        app_update as app_update_commands, automations as automation_commands,
        background as background_commands, backup, conversations,
        current_document as current_document_commands,
        editor_language_packs as editor_language_pack_commands, file_io, folder_commands, folders,
        git, launchbar as launchbar_commands, logging as logging_commands,
        model_provider as model_provider_commands, notification,
        pdf_preview as pdf_preview_commands, plugin_views as plugin_view_commands,
        preview_tools as preview_tools_commands, primary_tabs,
        quick_messages as quick_messages_commands, runtime_bridge as runtime_bridge_commands,
        system_settings, terminal as terminal_commands, tool_assets as tool_asset_commands,
        translate as translate_commands, version_control, windows, workspace_files,
        workspace_state as workspace_state_commands,
    };
    use crate::terminal::manager::TerminalManager;
    use crate::{
        control, db,
        git::credential,
        network,
        platform::{paths, process},
        workspace_state::current_document,
    };
    use tauri::Manager;

    static APP_QUITTING: AtomicBool = AtomicBool::new(false);

    /// On Windows, opt-out users can disable WebView2 hardware acceleration to
    /// work around AMD/Intel GPU driver bugs that produce a black-screen
    /// webview. The flag is stored in a tiny sidecar file at
    /// `$BERTH_HOME/preferences.json` so it can be read **before** the Tauri
    /// builder, plugins, or tokio runtime start — once a tokio worker is alive,
    /// `std::env::set_var` would race with concurrent `getenv` calls from
    /// libraries like reqwest/rustls that read `HTTP_PROXY` etc.
    #[cfg(target_os = "windows")]
    fn apply_webview2_rendering_override() {
        // Matches the dominant pattern across the Tauri 2 ecosystem (Dorion,
        // Seelen-UI, and most production Tauri 2 apps that ship a "disable
        // hardware acceleration" toggle all use `--disable-gpu`).
        const DISABLE_GPU_ARGS: [&str; 1] = ["--disable-gpu"];
        const ENV_KEY: &str = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS";

        let prefs = crate::platform::preferences::load();
        if !prefs.disable_hardware_acceleration {
            return;
        }

        let mut tokens: Vec<String> = match std::env::var(ENV_KEY) {
            Ok(prev) => prev.split_whitespace().map(str::to_string).collect(),
            Err(_) => Vec::new(),
        };
        for arg in DISABLE_GPU_ARGS {
            if !tokens.iter().any(|t| t == arg) {
                tokens.push(arg.to_string());
            }
        }
        // SAFETY: called before any tokio worker or plugin thread spawns, so
        // no concurrent `getenv` can race. `set_var` is `unsafe` since Rust 1.82.
        unsafe {
            std::env::set_var(ENV_KEY, tokens.join(" "));
        }
    }

    #[cfg_attr(mobile, tauri::mobile_entry_point)]
    pub fn run() {
        // Install the logging subscriber first so it captures everything from
        // here on. The file appender's logs dir is resolved from env (no DB
        // needed); hold the guard for the whole process so buffered file lines
        // flush on a graceful exit.
        let _log_guard = crate::logging::init::init_desktop();

        // Apply the WebView2 rendering override before *any* tokio worker
        // exists or any plugin reads the env. See doc comment above.
        #[cfg(target_os = "windows")]
        apply_webview2_rendering_override();

        if let Err(err) = fix_path_env::fix() {
            tracing::error!("[PATH] fix_path_env failed: {err}");
        }
        process::ensure_node_in_path();
        process::ensure_user_npm_prefix_in_path();

        let workspace_resources =
            std::sync::Arc::new(crate::workspace_state::resource::WorkspaceResourceLeaseStore::new());
        let workspace_transfer = std::sync::Arc::new(
            crate::workspace_state::transfer::WorkspaceTransferManager::new_with_resources_from_env(
                workspace_resources.clone(),
            ),
        );
        let builder = tauri::Builder::default();

        // Must be the first plugin: it short-circuits second launches by
        // signalling the running instance and exiting before any other
        // initialization. The callback runs in the *original* process.
        //
        // Skipped in debug builds so a locally-built `cargo run` instance
        // can run alongside an installed release build of codeg during
        // development. Debug desktop builds use an isolated SQLite file, but
        // they still share other `app.berth` data-dir artifacts with release.
        #[cfg(not(debug_assertions))]
        let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            windows::show_main_window(app);
        }));

        let builder = builder
            // Persist every window flag EXCEPT decorations. Decorations are a
            // per-platform decision made by `apply_platform_window_style`
            // (undecorated on Windows/Linux so the app draws its own chrome),
            // not a user preference. Restoring a stale `decorated: true` saved
            // by an older build would call `set_decorations(true)` after the
            // window is built and re-add the native title bar on top of the
            // app's own toolbar — the Linux "double title bar".
            .plugin(
                tauri_plugin_window_state::Builder::new()
                    .with_state_flags(
                        tauri_plugin_window_state::StateFlags::all()
                            & !tauri_plugin_window_state::StateFlags::DECORATIONS,
                    )
                    .build(),
            )
            .plugin(tauri_plugin_opener::init())
            .plugin(tauri_plugin_dialog::init())
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_process::init())
            .plugin(tauri_plugin_notification::init());

        // Dev-only: debug bridge for `tauri-browser` JS eval / screenshots /
        // console streaming during performance measurement (Phase A8).
        // Binds to 127.0.0.1 with a random auth token; never enable in release.
        #[cfg(feature = "debug-bridge")]
        let builder = builder.plugin(tauri_plugin_debug_bridge::init());

        builder
            .manage(TerminalManager::new())
            .manage(control::CurrentTerminalSelection::default())
            .manage(windows::CommitWindowState::new())
            .manage(windows::MergeWindowState::new())
            .manage(workspace_resources)
            .manage(workspace_transfer)
            // Source of truth for an in-flight app self-update so the upgrade
            // UI can survive navigation while download progress continues.
            .manage(crate::update::new_update_state_handle())
            .setup(|app| {
                let setup_started = std::time::Instant::now();
                let app_data_dir = app.path().app_data_dir()?;

                // Unify the data root across every consumer:
                //   * SQLite database (initialised below)
                //   * `paths::berth_uploads_root`
                //   * `AppState.data_dir` and every desktop command
                //     that injects a git credential helper / askpass
                //     into a subprocess (terminal, ACP, folder ops)
                //
                // The contract is "one effective root, end of story."
                // `paths::resolve_effective_data_dir` is the single
                // source of truth; every desktop call site that
                // historically read `app.path().app_data_dir()` and
                // passed it to a credential helper has been migrated
                // to the same helper so a pre-set `BERTH_DATA_DIR` is
                // honored end-to-end.
                //
                // We also write the absolutized value back to the env,
                // even when the operator pre-set it, so:
                //   * subprocesses inherit an absolute path (a relative
                //     `BERTH_DATA_DIR` would otherwise re-resolve
                //     against the subprocess CWD, which may differ
                //     from ours), and
                //   * any future caller that reaches for the env
                //     directly sees the same value the in-process
                //     resolver returns.
                //
                // `set_var` is `unsafe` in edition 2024. We are still
                // single-threaded at this point: `setup` runs on the
                // main thread before any window or async runtime task
                // reads the var, the Tauri plugins registered above
                // (window state, opener, dialog, updater, process,
                // notification) do not read `BERTH_DATA_DIR`, and the
                // value is never mutated again for the lifetime of the
                // process.
                // Operator env hard-cut: CODEG_* alone is no longer accepted.
                if let Err(err) = paths::reject_known_legacy_operator_envs() {
                    tracing::error!("[paths][FATAL] {err}");
                    // Surface to stderr as well for desktop launches without a
                    // log viewer yet.
                    eprintln!("[BERTH][FATAL] {err}");
                    std::process::exit(2);
                }

                let effective_data_dir = paths::resolve_effective_data_dir(&app_data_dir);
                // SAFETY: see the rationale block above — still
                // single-threaded at setup; edition 2024 will require
                // the `unsafe` block, mirroring the WebView2 rendering
                // override.
                unsafe {
                    std::env::set_var("BERTH_DATA_DIR", &effective_data_dir);
                }

                // 内置资产（群组成员 Berth 的提示词）缺什么补什么，已存在不动。
                match berth_tool_core::builtin::ensure() {
                    Ok(written) if !written.is_empty() => {
                        tracing::info!("[builtin] installed {}", written.join(", "))
                    }
                    Ok(_) => {}
                    Err(error) => tracing::warn!("[builtin] cannot install built-in assets: {error}"),
                }

                // HOME 是用户资产（tools/experts/skills），DATA 是应用数据
                // （db/uploads/logs）。两者可以不同：dev 默认 HOME=~/.berth、
                // DATA=~/.berth-dev。uploads/logs 跟随 DATA_DIR。
                if let Some(home) = std::env::var_os("BERTH_HOME").filter(|s| !s.is_empty()) {
                    let home_path = credential::absolutize(std::path::Path::new(&home));
                    if home_path != effective_data_dir {
                        tracing::info!(
                            "[paths] BERTH_HOME ({}) holds user assets; BERTH_DATA_DIR ({}) holds app data.",
                            home_path.display(),
                            effective_data_dir.display()
                        );
                    }
                }

                let app_version = env!("CARGO_PKG_VERSION");
                let database = tauri::async_runtime::block_on(db::init_database(
                    &effective_data_dir,
                    app_version,
                ))
                .map_err(|e| e.to_string())?;
                tracing::info!(
                    "[Startup] database ready +{}ms",
                    setup_started.elapsed().as_millis()
                );
                // 复用宿主实际打开的实例与连接，不从终端 cwd 或 daemon endpoint 猜 owner。
                app.state::<TerminalManager>()
                    .configure_project_database(
                        &berth_project_core::instance::DataInstance::create_if_missing(
                            &effective_data_dir,
                            db::database_file_name(),
                        ),
                        database.conn.clone(),
                        crate::control::resolve_gui_endpoint()
                            .map(berth_term_ipc::LocalEndpoint::into_path)
                            .map_err(|error| error.to_string()),
                    )
                    .map_err(|error| error.to_string())?;
                app.manage(database);
                // control socket 是尽力启动的本机控制面；复用 folder 核心
                // 实现响应 CLI 的 project/open 请求。
                crate::control::spawn(
                    db::AppDatabase {
                        conn: app.state::<db::AppDatabase>().conn.clone(),
                    },
                    crate::event_bridge::EventEmitter::Tauri(app.handle().clone()),
                    app.handle().clone(),
                );
                {
                    use std::fs::OpenOptions;
                    let lock_path = effective_data_dir.join(format!(
                        "{}.automations.lock",
                        db::database_file_name()
                    ));
                    let scheduler_lock = OpenOptions::new()
                        .create(true)
                        .truncate(true)
                        .read(true)
                        .write(true)
                        .open(&lock_path)
                        .ok()
                        .and_then(|file| file.try_lock().ok().map(|_| file));
                    let scheduler_db = db::AppDatabase {
                        conn: app.state::<db::AppDatabase>().conn.clone(),
                    };
                    let scheduler_terminal = app.state::<TerminalManager>().inner().clone_ref();
                    let scheduler_emitter = crate::event_bridge::EventEmitter::Tauri(app.handle().clone());
                    if let Some(scheduler_lock) = scheduler_lock {
                        tauri::async_runtime::spawn(async move {
                            let _scheduler_lock = scheduler_lock;
                            let mut scheduler_state = automation_commands::SchedulerState::default();
                            loop {
                                automation_commands::scheduler_tick(
                                    &scheduler_db,
                                    &scheduler_terminal,
                                    scheduler_emitter.clone(),
                                    &mut scheduler_state,
                                )
                                .await;
                                // deadline 驱动:休眠到最近的 next_run_at,计划变更即时唤醒
                                let delay =
                                    automation_commands::scheduler_sleep(&scheduler_db).await;
                                tokio::select! {
                                    _ = tokio::time::sleep(delay) => {}
                                    _ = crate::AUTOMATION_SCHEDULER_WAKE.notified() => {}
                                }
                            }
                        });
                    } else {
                        tracing::info!("[automation] scheduler lock unavailable; scheduler disabled in this process");
                    }
                }

                // Restore and apply saved system proxy settings before any network operation.
                let db = app.state::<db::AppDatabase>();
                tauri::async_runtime::block_on(network::proxy::init_proxy_from_db(&db.conn));
                tauri::async_runtime::spawn(crate::model_provider::secrets::import_legacy_keyring(
                    db.conn.clone(),
                ));
                // 服务商凭据代理：读上面刚写好的系统代理变量出站；端口被占（CLI 代理在跑）则跳过。
                tauri::async_runtime::spawn(crate::model_provider::proxy::host(db.conn.clone()));
                // 远程访问页（tailnet 浏览器用群组与文件）；没有 tailscale 地址就不启动。
                tauri::async_runtime::spawn(crate::remote::host(app.handle().clone()));
                // 会话分类：`~/.berth/classifier.json` 打开后，专家每轮结束把重要段落写成候选。
                tauri::async_runtime::spawn(crate::knowledge::classify::run(
                    db.conn.clone(),
                    app.state::<TerminalManager>().clone_ref(),
                ));

                // Logging phase 2/3: override the default level from the
                // persisted `logging.level` now that the DB is open, then wire
                // the emitter so the Logs viewer's live tail (`logs://appended`)
                // starts flowing.
                tauri::async_runtime::block_on(crate::logging::init::apply_persisted_level(
                    &db.conn,
                ));
                if let Some(hub) = crate::logging::hub::log_hub() {
                    hub.set_emitter(crate::event_bridge::EventEmitter::Tauri(
                        app.handle().clone(),
                    ));
                }

                // Load saved appearance settings before any window is created.
                tauri::async_runtime::block_on(windows::load_saved_zoom(&db.conn));
                tauri::async_runtime::block_on(windows::load_saved_appearance_mode(&db.conn));

                // System tray: required for the WeChat-style hide-on-close
                // flow on Windows/Linux (no built-in dock to bring the
                // workspace back). Locale comes from the persisted language
                // settings; system mode falls back to English here, which
                // the user can fix by switching to manual mode.
                let tray_locale = tauri::async_runtime::block_on(
                    crate::commands::system_settings::load_system_language_settings(&db.conn),
                )
                .map(|settings| settings.language)
                .unwrap_or_default();
                if let Err(err) = windows::install_tray_icon(app.handle(), tray_locale) {
                    tracing::error!("[Tray] failed to install tray icon: {err}");
                }

                tracing::info!(
                    "[Startup] settings + tray ready +{}ms",
                    setup_started.elapsed().as_millis()
                );

                // 旧 ACP 垃圾位于正式版共享缓存；开发实例不可清扫正式版目录。
                if !cfg!(debug_assertions) {
                    std::thread::spawn(|| {
                        let _ = std::panic::catch_unwind(|| {
                            crate::sweep_acp_binary_trash();
                        });
                    });
                }

                // Reclaim orphaned chat scratch dirs (pre-send drafts that never
                // bound to a conversation, plus dirs left behind by deleted chat
                // conversations). Background, non-blocking; failures are logged
                // but non-fatal — anything still in use is left for next startup.
                {
                    let gc_conn = app.state::<db::AppDatabase>().conn.clone();
                    let gc_data_dir = effective_data_dir.clone();
                    tauri::async_runtime::spawn(async move {
                        match crate::commands::conversations::gc_orphan_chat_dirs_core(
                            &gc_conn,
                            &gc_data_dir,
                        )
                        .await
                        {
                            Ok(n) if n > 0 => tracing::info!(
                                "[conversations] chat-dir GC: reclaimed {n} orphan scratch dir(s)"
                            ),
                            Ok(_) => {}
                            Err(err) => {
                                tracing::error!("[conversations] chat-dir GC failed: {err}")
                            }
                        }
                    });
                }

                app.manage(std::sync::Arc::new(
                    crate::workspace_state::current_document::CurrentDocumentContextStore::new(),
                ));

                // Plugin preview servers: reap dead children + ref0
                // stragglers (live previews are never swept). Override via
                // `BERTH_PREVIEW_WATCH_IDLE_TIMEOUT_SECS` (`0` disables).
                if let Some(idle_timeout) = crate::preview_watch::idle_timeout_from_env() {
                    tauri::async_runtime::spawn(crate::preview_watch::preview_idle_sweep_task(
                        idle_timeout,
                        std::time::Duration::from_secs(crate::preview_watch::SWEEP_INTERVAL_SECS),
                    ));
                }

                // Single-window workspace: ensure the main window exists.
                // Workspace state (open folders, opened tabs, active tab) is
                // restored by the frontend via `list_open_folder_details` /
                // `list_opened_tabs` inside the main window.
                tracing::info!(
                    "[Startup] creating main window +{}ms",
                    setup_started.elapsed().as_millis()
                );
                if app.get_webview_window("main").is_none() {
                    let url = tauri::WebviewUrl::App("workspace".into());
                    let builder = tauri::WebviewWindowBuilder::new(app, "main", url)
                        .title("Berth")
                        .inner_size(1260.0, 860.0)
                        .min_inner_size(400.0, 600.0);
                    let builder = windows::apply_platform_window_style(builder);
                    // The workspace title bar is taller than the shared default
                    // (it hosts the tab strips), so nudge the native macOS
                    // traffic lights down to stay vertically centred.
                    #[cfg(target_os = "macos")]
                    let builder = builder.traffic_light_position(
                        windows::workspace_window_traffic_light_position(),
                    );
                    if let Ok(w) = builder.build() {
                        windows::post_window_setup(&w);
                    }
                }

                Ok(())
            })
            .on_menu_event(|app, event| {
                let id = event.id().as_ref().to_string();

                // Tray menu items act in Rust directly: showing the
                // workspace and quitting are both pure runtime concerns
                // with no UI state to coordinate.
                if id.starts_with(windows::TRAY_MENU_ID_PREFIX) {
                    match id.as_str() {
                        windows::TRAY_MENU_ID_SHOW => windows::show_main_window(app),
                        windows::TRAY_MENU_ID_QUIT => windows::request_quit(app),
                        _ => {}
                    }
                }
            })
            .on_window_event(|window, event| {
                let label = window.label().to_string();

                if label.starts_with("commit-")
                    && matches!(
                        event,
                        tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed
                    )
                {
                    let app = window.app_handle();
                    if let Some(state) = app.try_state::<windows::CommitWindowState>() {
                        windows::restore_window_after_commit(app, &state, &label);
                    }
                }

                if label.starts_with("merge-")
                    && matches!(
                        event,
                        tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed
                    )
                {
                    let app = window.app_handle();
                    if let Some(state) = app.try_state::<windows::MergeWindowState>() {
                        windows::restore_window_after_merge(app, &state, &label);
                    }
                    let app_clone = window.app_handle().clone();
                    let label_clone = label.clone();
                    tauri::async_runtime::spawn(async move {
                        windows::cleanup_dangling_merge(&app_clone, &label_clone).await;
                    });
                }

                if label == "main" {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        // The close button does one of two things, depending
                        // on whether the platform can keep the workspace
                        // recoverable while it's hidden:
                        //
                        //   * tray usable (macOS, Windows + tray): WeChat-style
                        //     hide. App keeps running, tray brings it back.
                        //   * tray not usable (Linux, tray install failed):
                        //     a real app exit, after the webview confirms
                        //     unsaved edits (`request_quit`). Letting only `main`
                        //     close would orphan auxiliary windows in a
                        //     process with no workspace and no way to bring
                        //     it back.
                        //
                        // ExitRequested itself reaches this branch with
                        // APP_QUITTING already set — that's the only path
                        // that should fall through to the cleanup below.
                        if !APP_QUITTING.load(Ordering::Relaxed) {
                            api.prevent_close();
                            if windows::can_hide_to_tray() {
                                let _ = window.hide();
                                if let Some(selection) = window.app_handle().try_state::<control::CurrentTerminalSelection>() {
                                    selection.clear();
                                }
                                if let Some(store) = window.app_handle().try_state::<std::sync::Arc<current_document::CurrentDocumentContextStore>>() {
                                    store.clear_workspace();
                                }
                            } else {
                                windows::request_quit(window.app_handle());
                            }
                            return;
                        }
                        let app = window.app_handle();
                        if let Some(tm) = app.try_state::<TerminalManager>() {
                            let released = tm.detach_by_owner_window(&label);
                            tracing::info!(
                                "[TERM] main window closing released_terminal_clients={}",
                                released
                            );
                        }
                    }
                }
            })
            .invoke_handler(tauri::generate_handler![
                conversations::list_project_agent_sessions,
                conversations::list_project_session_overview,
                conversations::get_conversation,
                conversations::list_all_conversations,
                conversations::list_child_conversations,
                conversations::list_opened_tabs,
                conversations::save_opened_tabs,
                primary_tabs::list_primary_tabs,
                primary_tabs::list_legacy_resource_archive,
                primary_tabs::save_primary_tabs,
                conversations::resolve_project_agent_session,
                conversations::scan_importable_sessions,
                conversations::import_selected_sessions,
                conversations::get_folder_conversation,
                conversations::get_conversation_source_revision,
                conversations::list_folders,
                conversations::get_stats,
                conversations::get_sidebar_data,
                conversations::create_conversation,
                conversations::create_chat_conversation,
                conversations::create_chat_dir,
                conversations::update_conversation_title,
                conversations::update_conversation_pinned,
                conversations::delete_conversation,
                folders::load_folder_history,
                folders::get_folder,
                folders::list_open_folder_details,
                folders::list_all_folder_details,
                folders::open_folder,
                folders::open_worktree_folder,
                folders::resolve_worktree_folder,
                folders::open_folder_in_workspace,
                folders::open_folder_by_id,
                folders::remove_folder_from_workspace,
                folders::reconcile_worktree_family,
                folders::reorder_folders,
                folders::update_folder_alias,
                folders::rename_worktree,
                folders::update_folder_default_agent,
                folders::remove_folder_from_history,
                folders::create_folder_directory,
                git::clone_repository,
                current_document_commands::set_current_document_context,
                control::set_current_workspace_terminal,
                git::get_git_branch,
                git::get_git_head,
                git::git_init,
                git::git_pull,
                git::git_start_pull_merge,
                git::git_has_merge_head,
                git::git_fetch,
                git::git_push_info,
                git::git_push,
                git::git_new_branch,
                git::git_worktree_add,
                git::git_checkout,
                git::git_reset,
                git::git_list_branches,
                git::git_stash_push,
                git::git_stash_pop,
                git::git_stash_list,
                git::git_stash_apply,
                git::git_stash_drop,
                git::git_stash_clear,
                git::git_stash_show,
                git::git_status,
                git::git_is_tracked,
                git::git_diff,
                git::git_diff_with_branch,
                git::git_show_diff,
                git::git_show_file,
                git::git_commit,
                git::git_rollback_file,
                git::git_add_files,
                git::git_list_all_branches,
                git::git_list_remotes,
                git::git_fetch_remote,
                git::git_add_remote,
                git::git_remove_remote,
                git::git_set_remote_url,
                git::git_merge,
                git::git_rebase,
                git::git_delete_branch,
                git::git_delete_remote_branch,
                git::git_list_conflicts,
                git::git_conflict_file_versions,
                git::git_resolve_conflict,
                git::git_abort_operation,
                git::git_continue_operation,
                workspace_state_commands::start_workspace_state_stream,
                workspace_state_commands::stop_workspace_state_stream,
                workspace_state_commands::get_workspace_snapshot,
                workspace_files::get_home_directory,
                workspace_files::list_directory_entries,
                workspace_files::list_directory_with_files,
                workspace_files::get_file_tree,
                workspace_files::list_workspace_files,
                workspace_files::resolve_workspace_reference,
                workspace_files::read_file_base64,
                workspace_files::read_workspace_file_base64,
                workspace_files::read_file_preview,
                workspace_files::read_file_for_edit,
                workspace_files::save_file_content,
                workspace_files::save_file_copy,
                workspace_files::rename_file_tree_entry,
                workspace_files::move_file_tree_entry,
                workspace_files::delete_file_tree_entry,
                workspace_files::create_file_tree_entry,
                git::git_log,
                git::git_current_user,
                git::git_commit_files,
                git::git_search_authors,
                git::git_commit_branches,
                windows::open_commit_window,
                windows::open_merge_window,
                windows::open_stash_window,
                windows::open_push_window,
                pdf_preview_commands::open_local_pdf_source,
                pdf_preview_commands::read_local_pdf_range,
                pdf_preview_commands::close_local_pdf_source,
                windows::update_traffic_light_position,
                windows::update_appearance_mode,
                windows::set_tray_locale,
                background_commands::background_read,
                background_commands::background_set,
                background_commands::background_clear,
                app_update_commands::app_update_state,
                app_update_commands::perform_app_update,
                app_update_commands::restart_app,
                system_settings::get_system_proxy_settings,
                system_settings::update_system_proxy_settings,
                system_settings::get_system_language_settings,
                system_settings::update_system_language_settings,
                system_settings::get_system_terminal_settings,
                system_settings::update_system_terminal_settings,
                system_settings::get_available_terminal_shells,
                system_settings::probe_terminal_shell_path,
                system_settings::get_system_rendering_settings,
                system_settings::update_system_rendering_settings,
                logging_commands::get_log_settings,
                logging_commands::set_log_settings,
                logging_commands::get_recent_logs,
                logging_commands::list_log_files,
                logging_commands::open_logs_dir,
                logging_commands::read_log_file,
                runtime_bridge_commands::runtime_bridge_operation,
                editor_language_pack_commands::editor_language_pack_operation,
                version_control::detect_git,
                version_control::test_git_path,
                version_control::get_git_settings,
                version_control::update_git_settings,
                version_control::get_github_accounts,
                version_control::validate_github_token,
                version_control::update_github_accounts,
                version_control::save_account_token,
                version_control::get_account_token,
                version_control::delete_account_token,
                launchbar_commands::launchbar,
                tool_asset_commands::tool_assets,
                plugin_view_commands::plugin_views,
                automation_commands::automations,
                preview_tools_commands::install_preview_tool,
                preview_tools_commands::preview_tool_status,
                preview_tools_commands::tool_update_check,
                preview_tools_commands::start_preview_watch,
                preview_tools_commands::stop_preview_watch,
                preview_tools_commands::preview_watch_refresh_html,
                folder_commands::list_folder_commands,
                folder_commands::create_folder_command,
                folder_commands::update_folder_command,
                folder_commands::delete_folder_command,
                folder_commands::reorder_folder_commands,
                folder_commands::bootstrap_folder_commands_from_package_json,
                quick_messages_commands::quick_messages_list,
                quick_messages_commands::quick_messages_create,
                quick_messages_commands::quick_messages_update,
                quick_messages_commands::quick_messages_delete,
                quick_messages_commands::quick_messages_reorder,
                terminal_commands::terminal_create,
                terminal_commands::terminal_list_sessions,
                terminal_commands::terminal_get_session,
                terminal_commands::terminal_attach_channel,
                terminal_commands::terminal_detach,
                terminal_commands::terminal_write_attached_raw,
                terminal_commands::terminal_resize_attached,
                terminal_commands::terminal_send_key,
                terminal_commands::terminal_send_line,
                terminal_commands::terminal_terminate,
                terminal_commands::terminal_remove_record,
                notification::send_notification,
                translate_commands::translate_text,
                translate_commands::get_translate_settings,
                translate_commands::update_translate_settings,
                file_io::save_binary_file,
                file_io::save_text_file,
                backup::backup_create,
                backup::backup_inspect,
                backup::backup_scan_external_conflicts,
                backup::backup_restore_stage,
                backup::backup_cancel,
                model_provider_commands::list_model_providers,
                model_provider_commands::create_model_provider,
                model_provider_commands::update_model_provider,
                model_provider_commands::delete_model_provider,
                model_provider_commands::get_agent_provider_binding,
                model_provider_commands::set_agent_provider_binding,
                model_provider_commands::import_cc_switch_providers,
                model_provider_commands::fetch_provider_models,
                model_provider_commands::model_provider_systemone,
                model_provider_commands::model_provider_transfer,
                model_provider_commands::model_provider_proxy_access,
                usage_commands::read_account_usage,
                usage_commands::fetch_provider_balance,
                usage_commands::fetch_official_account_usage,
                usage_commands::list_login_cards,
                usage_commands::fetch_login_models,
                usage_commands::save_login_presets,
                // CLI file.open 请求在主窗口的领取/回执交接面（control 长期缝合点）。
                crate::control::workspace_open_file_handoff,
            ])
            .build(tauri::generate_context!())
            .expect("error while building tauri application")
            .run(|app, event| match event {
                tauri::RunEvent::ExitRequested { .. } => {
                    APP_QUITTING.store(true, Ordering::Relaxed);
                    if let Some(tm) = app.try_state::<TerminalManager>() {
                        tm.detach_all();
                    }
                    crate::preview_watch::stop_all_preview_watches();
                }
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Reopen { .. } => {
                    // Dock-icon click: bring the workspace forward
                    // unconditionally. `has_visible_windows` is true
                    // whenever any auxiliary window (commit, merge, stash…)
                    // is alive, so gating on it would suppress recovery
                    // even though `main` itself is hidden.
                    // `show_main_window` is idempotent — already-visible
                    // windows just get re-focused, which is what dock
                    // activation should do anyway.
                    windows::show_main_window(app);
                }
                _ => {}
            });
    }
}

#[cfg(feature = "tauri-runtime")]
pub use tauri_app::run;
