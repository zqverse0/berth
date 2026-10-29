use std::collections::HashMap;
#[cfg(target_os = "macos")]
use std::sync::atomic::AtomicU32;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering as AtomicOrdering};
use std::sync::Mutex;

use sea_orm::DatabaseConnection;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::app_error::AppCommandError;
use berth_project_core::service::app_metadata_service;
use crate::db::AppDatabase;

/// Base traffic-light position (logical px) at 100 % zoom, tuned for the
/// standard h-8 (32px) overlay title bar shared by the auxiliary windows
/// (commit / merge / push / stash / …).
#[cfg(target_os = "macos")]
const TRAFFIC_LIGHT_X: f64 = 12.0;
#[cfg(target_os = "macos")]
const TRAFFIC_LIGHT_Y: f64 = 17.0;
/// The workspace `main` window renders the taller
/// h-10 (40px) `FolderTitleBar` that hosts the relocated conversation + file
/// tab strips, so their traffic lights sit ~4px lower to stay vertically
/// centred within the taller bar.
#[cfg(target_os = "macos")]
const WORKSPACE_TRAFFIC_LIGHT_Y: f64 = 21.0;

#[cfg(target_os = "macos")]
static CURRENT_ZOOM: AtomicU32 = AtomicU32::new(100);

#[cfg(target_os = "macos")]
fn traffic_light_position_at(base_y: f64) -> tauri::LogicalPosition<f64> {
    let zoom = CURRENT_ZOOM.load(AtomicOrdering::Relaxed) as f64;
    // Only Y scales with zoom: overlay content shifts vertically with
    // font-size changes, but the horizontal inset remains constant.
    tauri::LogicalPosition::new(TRAFFIC_LIGHT_X, base_y * zoom / 100.0)
}

/// Traffic-light position for the shared/auxiliary windows (standard bar).
#[cfg(target_os = "macos")]
fn traffic_light_position() -> tauri::LogicalPosition<f64> {
    traffic_light_position_at(TRAFFIC_LIGHT_Y)
}

/// Traffic-light position for the workspace windows (taller bar): the local
/// `main` window, which loads the
/// `/workspace` route. macOS only; call sites are guarded with
/// `#[cfg(target_os = "macos")]`.
#[cfg(target_os = "macos")]
pub(crate) fn workspace_window_traffic_light_position() -> tauri::LogicalPosition<f64> {
    traffic_light_position_at(WORKSPACE_TRAFFIC_LIGHT_Y)
}

const ZOOM_LEVEL_DB_KEY: &str = "appearance_zoom_level";

/// Load saved zoom level from DB and initialize CURRENT_ZOOM.
/// Called once at startup before any window is created.
pub async fn load_saved_zoom(conn: &DatabaseConnection) {
    #[cfg(target_os = "macos")]
    {
        if let Ok(Some(raw)) = app_metadata_service::get_value(conn, ZOOM_LEVEL_DB_KEY).await {
            if let Ok(zoom) = raw.parse::<u32>() {
                let clamped = zoom.clamp(50, 300);
                CURRENT_ZOOM.store(clamped, AtomicOrdering::Relaxed);
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = conn;
    }
}

// ---------------------------------------------------------------------------
// Appearance mode persistence (dark / light / system)
// ---------------------------------------------------------------------------

const APPEARANCE_MODE_DB_KEY: &str = "appearance_mode";

/// Encoded appearance mode: 0 = system (default), 1 = dark, 2 = light.
static CACHED_APPEARANCE_MODE: AtomicU8 = AtomicU8::new(0);

const MODE_SYSTEM: u8 = 0;
const MODE_DARK: u8 = 1;
const MODE_LIGHT: u8 = 2;

fn mode_from_str(s: &str) -> u8 {
    match s {
        "dark" => MODE_DARK,
        "light" => MODE_LIGHT,
        _ => MODE_SYSTEM,
    }
}

/// Load saved appearance mode from DB. Called once at startup.
pub async fn load_saved_appearance_mode(conn: &DatabaseConnection) {
    if let Ok(Some(raw)) = app_metadata_service::get_value(conn, APPEARANCE_MODE_DB_KEY).await {
        CACHED_APPEARANCE_MODE.store(mode_from_str(&raw), AtomicOrdering::Relaxed);
    }
}

pub struct CommitWindowState {
    owner_by_commit_label: Mutex<HashMap<String, String>>,
}

/// Detect macOS system dark mode via `defaults read`.
/// Result is cached for the process lifetime via `OnceLock`.
#[cfg(target_os = "macos")]
fn is_system_dark_mode() -> bool {
    use std::sync::OnceLock;
    static CACHED: OnceLock<bool> = OnceLock::new();
    *CACHED.get_or_init(|| {
        crate::platform::process::std_command("defaults")
            .args(["read", "-g", "AppleInterfaceStyle"])
            .output()
            .map(|o| o.status.success()) // key exists only in dark mode
            .unwrap_or(false)
    })
}

/// Detect Windows system dark mode via registry query.
/// `AppsUseLightTheme`: 0 = dark, 1 = light.
/// Uses `crate::platform::process::std_command` to avoid flashing a console window.
/// On pre-1809 Windows where the key is absent, defaults to light mode.
#[cfg(target_os = "windows")]
fn is_system_dark_mode() -> bool {
    use std::sync::OnceLock;
    static CACHED: OnceLock<bool> = OnceLock::new();
    *CACHED.get_or_init(|| {
        crate::platform::process::std_command("reg")
            .args([
                "query",
                r"HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize",
                "/v",
                "AppsUseLightTheme",
            ])
            .output()
            .ok()
            .and_then(|o| {
                let stdout = String::from_utf8_lossy(&o.stdout);
                // Output: "    AppsUseLightTheme    REG_DWORD    0x0"
                // Extract the last token on the matching line to avoid
                // substring false-positives (e.g. "0x00000001" contains "0x0").
                stdout
                    .lines()
                    .find(|l| l.contains("AppsUseLightTheme"))
                    .map(|line| {
                        line.split_whitespace()
                            .last()
                            .map(|val| val == "0x0" || val == "0x00000000")
                            .unwrap_or(false)
                    })
            })
            .unwrap_or(false)
    })
}

/// Detect Linux system dark mode via desktop environment settings.
/// Covers GNOME (gsettings) and KDE Plasma (kreadconfig5/6).
/// Falls back to light mode on unsupported desktops (XFCE, etc.).
#[cfg(target_os = "linux")]
fn is_system_dark_mode() -> bool {
    use std::sync::OnceLock;
    static CACHED: OnceLock<bool> = OnceLock::new();
    *CACHED.get_or_init(|| {
        // GNOME 42+: color-scheme = 'prefer-dark'
        if let Ok(output) = crate::platform::process::std_command("gsettings")
            .args(["get", "org.gnome.desktop.interface", "color-scheme"])
            .output()
        {
            let s = String::from_utf8_lossy(&output.stdout);
            if s.contains("prefer-dark") {
                return true;
            }
        }
        // Older GNOME / GTK: theme name contains "dark"
        if let Ok(output) = crate::platform::process::std_command("gsettings")
            .args(["get", "org.gnome.desktop.interface", "gtk-theme"])
            .output()
        {
            let s = String::from_utf8_lossy(&output.stdout).to_lowercase();
            if s.contains("dark") {
                return true;
            }
        }
        // KDE Plasma 5/6: ColorScheme name contains "dark"
        for cmd in ["kreadconfig6", "kreadconfig5"] {
            if let Ok(output) = crate::platform::process::std_command(cmd)
                .args(["--group", "General", "--key", "ColorScheme"])
                .output()
            {
                let s = String::from_utf8_lossy(&output.stdout).to_lowercase();
                if s.contains("dark") {
                    return true;
                }
            }
        }
        false
    })
}

/// Determine whether the window should use a dark background, considering
/// both the user's explicit preference (from DB) and the OS appearance.
fn should_use_dark_background() -> bool {
    match CACHED_APPEARANCE_MODE.load(AtomicOrdering::Relaxed) {
        MODE_DARK => true,
        MODE_LIGHT => false,
        _ => is_system_dark_mode(), // "system" or unknown — follow OS
    }
}

pub(crate) fn apply_platform_window_style<'a, R, M>(
    builder: WebviewWindowBuilder<'a, R, M>,
) -> WebviewWindowBuilder<'a, R, M>
where
    R: tauri::Runtime,
    M: tauri::Manager<R>,
{
    #[cfg(target_os = "macos")]
    {
        let builder = if should_use_dark_background() {
            // oklch(0.145 0 0) ≈ rgb(9,9,11) — matches CSS --background in dark mode
            builder.background_color(tauri::window::Color(9, 9, 11, 255))
        } else {
            builder
        };
        builder
            .hidden_title(true)
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .traffic_light_position(traffic_light_position())
    }

    #[cfg(target_os = "windows")]
    {
        let builder = if should_use_dark_background() {
            builder.background_color(tauri::window::Color(9, 9, 11, 255))
        } else {
            builder
        };
        builder.decorations(false)
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        // Linux: drop the native GTK title bar so it doesn't stack on top of
        // the app's own toolbar (the "double title bar"). The frontend then
        // renders custom window controls + resize grips, mirroring Windows.
        let builder = if should_use_dark_background() {
            builder.background_color(tauri::window::Color(9, 9, 11, 255))
        } else {
            builder
        };
        builder.decorations(false)
    }
}

#[cfg(target_os = "windows")]
fn ensure_windows_undecorated(window: &tauri::WebviewWindow) {
    let _ = window.set_decorations(false);
}

#[cfg(not(target_os = "windows"))]
fn ensure_windows_undecorated(_window: &tauri::WebviewWindow) {}

/// Apply platform-specific post-creation setup.
pub(crate) fn post_window_setup(window: &tauri::WebviewWindow) {
    ensure_windows_undecorated(window);
}

impl CommitWindowState {
    pub fn new() -> Self {
        Self {
            owner_by_commit_label: Mutex::new(HashMap::new()),
        }
    }

    fn set_owner(&self, commit_label: String, owner_label: String) {
        if let Ok(mut owners) = self.owner_by_commit_label.lock() {
            owners.insert(commit_label, owner_label);
        }
    }

    fn take_owner(&self, commit_label: &str) -> Option<String> {
        self.owner_by_commit_label
            .lock()
            .ok()
            .and_then(|mut owners| owners.remove(commit_label))
    }
}

impl Default for CommitWindowState {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Window title localization
// ---------------------------------------------------------------------------
//
// Window titles are set at creation time and not refreshed on locale change,
// which mirrors the behavior of native OS dialogs across the app. Translations
// live in Rust (not the frontend i18n JSON) because the title is applied via
// Tauri's window builder before the webview boots.

struct WindowTitles {
    commit: &'static str,
    merge: &'static str,
    stash: &'static str,
    push: &'static str,
}

fn window_titles_for(locale: crate::models::system::AppLocale) -> WindowTitles {
    use crate::models::system::AppLocale;
    match locale {
        AppLocale::ZhCn => WindowTitles {
            commit: "提交代码",
            merge: "解决冲突",
            stash: "储藏",
            push: "推送",
        },
        AppLocale::ZhTw => WindowTitles {
            commit: "提交程式碼",
            merge: "解決衝突",
            stash: "暫存",
            push: "推送",
        },
        AppLocale::Ja => WindowTitles {
            commit: "コミット",
            merge: "コンフリクトの解決",
            stash: "スタッシュ",
            push: "プッシュ",
        },
        AppLocale::Ko => WindowTitles {
            commit: "커밋",
            merge: "충돌 해결",
            stash: "스태시",
            push: "푸시",
        },
        AppLocale::Es => WindowTitles {
            commit: "Confirmar",
            merge: "Resolver conflictos",
            stash: "Reserva",
            push: "Enviar",
        },
        AppLocale::De => WindowTitles {
            commit: "Commit",
            merge: "Konflikte lösen",
            stash: "Stash",
            push: "Push",
        },
        AppLocale::Fr => WindowTitles {
            commit: "Valider",
            merge: "Résoudre les conflits",
            stash: "Réserve",
            push: "Pousser",
        },
        AppLocale::Pt => WindowTitles {
            commit: "Confirmar",
            merge: "Resolver conflitos",
            stash: "Stash",
            push: "Enviar",
        },
        AppLocale::Ar => WindowTitles {
            commit: "الالتزام",
            merge: "حل التعارضات",
            stash: "إخفاء",
            push: "دفع",
        },
        AppLocale::En => WindowTitles {
            commit: "Commit",
            merge: "Resolve Conflicts",
            stash: "Stash",
            push: "Push",
        },
    }
}

// When the frontend passes an explicit `locale`, use it — that's the
// authoritative effective locale (see lib/i18n.ts::getCurrentEffectiveAppLocale).
// Falling back to the DB only matters for callers that bypass the JS wrappers
// (e.g. a future HTTP client, internal tests).
async fn resolve_window_titles(
    conn: &DatabaseConnection,
    explicit: Option<crate::models::system::AppLocale>,
) -> WindowTitles {
    if let Some(locale) = explicit {
        return window_titles_for(locale);
    }
    let locale = crate::commands::system_settings::load_system_language_settings(conn)
        .await
        .map(|settings| settings.language)
        .unwrap_or_default();
    window_titles_for(locale)
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn open_commit_window(
    app: AppHandle,
    window: tauri::WebviewWindow,
    db: tauri::State<'_, AppDatabase>,
    state: tauri::State<'_, CommitWindowState>,
    folder_id: i32,
    locale: Option<crate::models::system::AppLocale>,
) -> Result<(), AppCommandError> {
    let owner_label = window.label().to_string();
    let label = format!("commit-{folder_id}");

    if let Some(existing) = app.get_webview_window(&label) {
        state.set_owner(label.clone(), owner_label);
        let _ = existing.unminimize();
        existing
            .set_focus()
            .map_err(|e| AppCommandError::window("Failed to focus commit window", e.to_string()))?;
        return Ok(());
    }

    let titles = resolve_window_titles(&db.conn, locale).await;
    let folder = berth_project_core::service::folder_service::get_folder_by_id(&db.conn, folder_id)
        .await
        .map_err(AppCommandError::from)?
        .ok_or_else(|| {
            AppCommandError::not_found(format!("Folder {folder_id} not found"))
                .with_detail(format!("folder_id={folder_id}"))
        })?;
    let window_title = format!("{} - {}", titles.commit, folder.name);
    let url = WebviewUrl::App(format!("commit?folderId={folder_id}").into());
    let builder = WebviewWindowBuilder::new(&app, &label, url)
        .title(window_title)
        .inner_size(1220.0, 820.0)
        .min_inner_size(980.0, 620.0)
        .center();
    let builder = builder.parent(&window).map_err(|e| {
        AppCommandError::window("Failed to attach commit window to parent", e.to_string())
    })?;
    let commit_window = apply_platform_window_style(builder)
        .build()
        .map_err(|e| AppCommandError::window("Failed to open commit window", e.to_string()))?;
    post_window_setup(&commit_window);
    state.set_owner(label, owner_label);
    commit_window
        .set_focus()
        .map_err(|e| AppCommandError::window("Failed to focus commit window", e.to_string()))?;

    Ok(())
}

pub fn restore_window_after_commit(
    app: &AppHandle,
    state: &CommitWindowState,
    commit_window_label: &str,
) {
    if let Some(owner_label) = state.take_owner(commit_window_label) {
        if let Some(window) = app.get_webview_window(&owner_label) {
            let _ = window.set_focus();
        }
    }
}

pub struct MergeWindowState {
    owner_by_merge_label: Mutex<HashMap<String, String>>,
}

impl MergeWindowState {
    pub fn new() -> Self {
        Self {
            owner_by_merge_label: Mutex::new(HashMap::new()),
        }
    }

    fn set_owner(&self, merge_label: String, owner_label: String) {
        if let Ok(mut owners) = self.owner_by_merge_label.lock() {
            owners.insert(merge_label, owner_label);
        }
    }

    fn take_owner(&self, merge_label: &str) -> Option<String> {
        self.owner_by_merge_label
            .lock()
            .ok()
            .and_then(|mut owners| owners.remove(merge_label))
    }
}

impl Default for MergeWindowState {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn open_merge_window(
    app: AppHandle,
    window: tauri::WebviewWindow,
    db: tauri::State<'_, AppDatabase>,
    state: tauri::State<'_, MergeWindowState>,
    folder_id: i32,
    operation: String,
    upstream_commit: Option<String>,
    locale: Option<crate::models::system::AppLocale>,
) -> Result<(), AppCommandError> {
    let owner_label = window.label().to_string();
    let label = format!("merge-{folder_id}");

    if let Some(existing) = app.get_webview_window(&label) {
        state.set_owner(label.clone(), owner_label);
        let _ = existing.unminimize();
        existing
            .set_focus()
            .map_err(|e| AppCommandError::window("Failed to focus merge window", e.to_string()))?;
        return Ok(());
    }

    let titles = resolve_window_titles(&db.conn, locale).await;
    let folder = berth_project_core::service::folder_service::get_folder_by_id(&db.conn, folder_id)
        .await
        .map_err(AppCommandError::from)?
        .ok_or_else(|| {
            AppCommandError::not_found(format!("Folder {folder_id} not found"))
                .with_detail(format!("folder_id={folder_id}"))
        })?;
    let window_title = format!("{} - {}", titles.merge, folder.name);
    let mut url_str = format!("merge?folderId={folder_id}&operation={operation}");
    if let Some(ref commit) = upstream_commit {
        url_str.push_str(&format!("&upstreamCommit={commit}"));
    }
    let url = WebviewUrl::App(url_str.into());
    let builder = WebviewWindowBuilder::new(&app, &label, url)
        .title(window_title)
        .inner_size(1400.0, 900.0)
        .min_inner_size(1100.0, 650.0)
        .center();
    let builder = builder.parent(&window).map_err(|e| {
        AppCommandError::window("Failed to attach merge window to parent", e.to_string())
    })?;
    let merge_window = apply_platform_window_style(builder)
        .build()
        .map_err(|e| AppCommandError::window("Failed to open merge window", e.to_string()))?;
    post_window_setup(&merge_window);
    state.set_owner(label, owner_label);
    merge_window
        .set_focus()
        .map_err(|e| AppCommandError::window("Failed to focus merge window", e.to_string()))?;

    Ok(())
}

pub fn restore_window_after_merge(
    app: &AppHandle,
    state: &MergeWindowState,
    merge_window_label: &str,
) {
    if let Some(owner_label) = state.take_owner(merge_window_label) {
        if let Some(window) = app.get_webview_window(&owner_label) {
            let _ = window.set_focus();
        }
    }
}

/// Clean up dangling merge state when a merge window is closed without
/// completing or aborting. Checks if MERGE_HEAD exists, aborts the merge,
/// and notifies the parent window.
pub async fn cleanup_dangling_merge(app: &AppHandle, merge_window_label: &str) {
    let folder_id: i32 = match merge_window_label
        .strip_prefix("merge-")
        .and_then(|s| s.parse().ok())
    {
        Some(id) => id,
        None => return,
    };

    let db = match app.try_state::<AppDatabase>() {
        Some(db) => db,
        None => return,
    };

    let folder =
        match berth_project_core::service::folder_service::get_folder_by_id(&db.conn, folder_id).await {
            Ok(Some(f)) => f,
            _ => return,
        };

    // Check if MERGE_HEAD exists
    let check = crate::platform::process::tokio_command("git")
        .args(["rev-parse", "--verify", "MERGE_HEAD"])
        .current_dir(&folder.path)
        .output()
        .await;
    let has_merge_head = check.map(|o| o.status.success()).unwrap_or(false);

    if has_merge_head {
        let _ = crate::platform::process::tokio_command("git")
            .args(["merge", "--abort"])
            .current_dir(&folder.path)
            .output()
            .await;

        let emitter = crate::event_bridge::EventEmitter::Tauri(app.clone());
        crate::event_bridge::emit_event(
            &emitter,
            "folder://merge-aborted",
            serde_json::json!({ "folder_id": folder_id }),
        );
    }
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn open_stash_window(
    app: AppHandle,
    db: tauri::State<'_, AppDatabase>,
    folder_id: i32,
    locale: Option<crate::models::system::AppLocale>,
) -> Result<(), AppCommandError> {
    let label = format!("stash-{folder_id}");

    if let Some(existing) = app.get_webview_window(&label) {
        post_window_setup(&existing);
        let _ = existing.unminimize();
        existing
            .set_focus()
            .map_err(|e| AppCommandError::window("Failed to focus stash window", e.to_string()))?;
        return Ok(());
    }

    let titles = resolve_window_titles(&db.conn, locale).await;
    let folder = berth_project_core::service::folder_service::get_folder_by_id(&db.conn, folder_id)
        .await
        .map_err(AppCommandError::from)?
        .ok_or_else(|| {
            AppCommandError::not_found(format!("Folder {folder_id} not found"))
                .with_detail(format!("folder_id={folder_id}"))
        })?;
    let window_title = format!("{} - {}", titles.stash, folder.name);
    let url = WebviewUrl::App(format!("stash?folderId={folder_id}").into());
    let builder = WebviewWindowBuilder::new(&app, &label, url)
        .title(window_title)
        .inner_size(1100.0, 700.0)
        .min_inner_size(800.0, 500.0)
        .center();
    let stash_window = apply_platform_window_style(builder)
        .build()
        .map_err(|e| AppCommandError::window("Failed to open stash window", e.to_string()))?;
    post_window_setup(&stash_window);

    Ok(())
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn open_push_window(
    app: AppHandle,
    window: tauri::WebviewWindow,
    db: tauri::State<'_, AppDatabase>,
    folder_id: i32,
    locale: Option<crate::models::system::AppLocale>,
) -> Result<(), AppCommandError> {
    let label = format!("push-{folder_id}");

    if let Some(existing) = app.get_webview_window(&label) {
        post_window_setup(&existing);
        let _ = existing.unminimize();
        existing
            .set_focus()
            .map_err(|e| AppCommandError::window("Failed to focus push window", e.to_string()))?;
        return Ok(());
    }

    let titles = resolve_window_titles(&db.conn, locale).await;
    let folder = berth_project_core::service::folder_service::get_folder_by_id(&db.conn, folder_id)
        .await
        .map_err(AppCommandError::from)?
        .ok_or_else(|| {
            AppCommandError::not_found(format!("Folder {folder_id} not found"))
                .with_detail(format!("folder_id={folder_id}"))
        })?;
    let window_title = format!("{} - {}", titles.push, folder.name);
    let url = WebviewUrl::App(format!("push?folderId={folder_id}").into());
    let builder = WebviewWindowBuilder::new(&app, &label, url)
        .title(window_title)
        .inner_size(1100.0, 700.0)
        .min_inner_size(800.0, 500.0)
        .center();
    let builder = builder.parent(&window).map_err(|e| {
        AppCommandError::window("Failed to attach push window to parent", e.to_string())
    })?;
    let push_window = apply_platform_window_style(builder)
        .build()
        .map_err(|e| AppCommandError::window("Failed to open push window", e.to_string()))?;
    post_window_setup(&push_window);

    Ok(())
}

/// Store the current zoom level and persist it to DB so the next launch
/// creates windows with the correct traffic-light position.
/// Existing windows are NOT repositioned at runtime.
#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn update_traffic_light_position(
    app: AppHandle,
    db: tauri::State<'_, AppDatabase>,
    zoom: f64,
) -> Result<(), AppCommandError> {
    let clamped = zoom.clamp(50.0, 300.0) as u32;

    #[cfg(target_os = "macos")]
    CURRENT_ZOOM.store(clamped, AtomicOrdering::Relaxed);

    // Persist to DB so the next launch reads the correct value.
    let _ =
        app_metadata_service::upsert_value(&db.conn, ZOOM_LEVEL_DB_KEY, &clamped.to_string()).await;

    let _ = app;
    Ok(())
}

/// Persist the user's appearance mode ("dark" / "light" / "system") to DB
/// and update the in-memory cache so that subsequent window creations use the
/// correct native background color.
#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn update_appearance_mode(
    db: tauri::State<'_, AppDatabase>,
    mode: String,
) -> Result<(), AppCommandError> {
    CACHED_APPEARANCE_MODE.store(mode_from_str(&mode), AtomicOrdering::Relaxed);

    let _ = app_metadata_service::upsert_value(&db.conn, APPEARANCE_MODE_DB_KEY, &mode).await;

    Ok(())
}

// ─── System tray icon ──────────────────────────────────────────────────

/// Monochrome template image for the macOS menu bar. AppKit treats an
/// `NSImage` with `isTemplate = true` as a mask: only the alpha channel
/// matters and the system tints it to match the menu-bar appearance
/// (light, dark, accent). The colored window icon won't get this
/// treatment and looks out of place next to other system icons.
#[cfg(all(feature = "tauri-runtime", target_os = "macos"))]
const MACOS_TRAY_TEMPLATE_PNG: &[u8] = include_bytes!("../../icons/tray-icon-template.png");

#[cfg(all(feature = "tauri-runtime", target_os = "macos"))]
fn load_macos_tray_template_icon() -> Result<tauri::image::Image<'static>, String> {
    let decoded = image::load_from_memory(MACOS_TRAY_TEMPLATE_PNG)
        .map_err(|e| format!("decode tray template png: {e}"))?
        .to_rgba8();
    let (w, h) = (decoded.width(), decoded.height());
    Ok(tauri::image::Image::new_owned(decoded.into_raw(), w, h))
}

/// Stable id namespace for tray menu items. Routed through the app-wide
/// `on_menu_event` handler in `lib.rs`.
pub const TRAY_MENU_ID_PREFIX: &str = "tray:";
pub const TRAY_MENU_ID_SHOW: &str = "tray:show";
pub const TRAY_MENU_ID_QUIT: &str = "tray:quit";
pub const TRAY_ICON_ID: &str = "berth-tray";

/// True after `install_tray_icon` returns `Ok`. The hide-on-close path
/// in `lib.rs` consults this so we don't strand the user on systems
/// where the tray failed to install (Windows tray refused, etc.). On
/// Linux this is necessary-but-not-sufficient: the StatusNotifierWatcher
/// may be missing and the icon invisible even when build() returns Ok,
/// which is why `can_hide_to_tray()` reports false on Linux regardless.
#[cfg(feature = "tauri-runtime")]
static TRAY_AVAILABLE: AtomicBool = AtomicBool::new(false);

/// Whether hide-on-close is safe on this platform/session. When false,
/// the close handler in `lib.rs` forces a real app exit instead — both
/// `hide()` and `minimize()` would leave aux windows (pet, settings)
/// running without a recoverable workspace.
#[cfg(feature = "tauri-runtime")]
pub fn can_hide_to_tray() -> bool {
    // Linux: even with a successfully installed tray icon, modern GNOME
    // (45+) defaults ship without a StatusNotifierWatcher and the icon
    // is silently invisible. Refusing here forces the close to pass
    // through to a real exit on Linux — preferable to a phantom process
    // with no UI surface.
    if cfg!(target_os = "linux") {
        return false;
    }
    TRAY_AVAILABLE.load(AtomicOrdering::Relaxed)
}

/// Bring the hidden / minimized main workspace window back to the
/// foreground. Used by:
///   * single-instance plugin (second launch)
///   * tray icon left-click and "Show Workspace" menu item
///   * macOS dock-icon reopen
#[cfg(feature = "tauri-runtime")]
pub fn show_main_window(app: &AppHandle) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.unminimize();
        let _ = main.show();
        let _ = main.set_focus();
    }
}

/// 主窗口收到后检查未保存的编辑，确认后自行调用 process exit。
pub const QUIT_REQUESTED_EVENT: &str = "app://quit-requested";

#[cfg(feature = "tauri-runtime")]
static QUIT_REQUESTED_AT_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// 用户要求退出（托盘「退出」、无托盘平台的关闭按钮）：交给前端确认未保存的编辑。
/// 前端无响应（未加载、卡死）时，3 秒内再次请求直接退出，保证总能退出。
#[cfg(feature = "tauri-runtime")]
pub fn request_quit(app: &AppHandle) {
    use tauri::Emitter;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let previous = QUIT_REQUESTED_AT_MS.swap(now, AtomicOrdering::Relaxed);
    if now.saturating_sub(previous) < 3_000 || app.get_webview_window("main").is_none() {
        app.exit(0);
        return;
    }
    show_main_window(app);
    if app.emit_to("main", QUIT_REQUESTED_EVENT, ()).is_err() {
        app.exit(0);
    }
}

#[cfg(feature = "tauri-runtime")]
struct TrayLabels {
    show_workspace: &'static str,
    quit: &'static str,
}

#[cfg(feature = "tauri-runtime")]
fn tray_labels_for(locale: crate::models::system::AppLocale) -> TrayLabels {
    use crate::models::system::AppLocale;
    match locale {
        AppLocale::ZhCn => TrayLabels {
            show_workspace: "显示工作台",
            quit: "退出 Berth",
        },
        AppLocale::ZhTw => TrayLabels {
            show_workspace: "顯示工作臺",
            quit: "退出 Berth",
        },
        AppLocale::Ja => TrayLabels {
            show_workspace: "ワークスペースを表示",
            quit: "Berth を終了",
        },
        AppLocale::Ko => TrayLabels {
            show_workspace: "워크스페이스 표시",
            quit: "Berth 종료",
        },
        AppLocale::Es => TrayLabels {
            show_workspace: "Mostrar el área de trabajo",
            quit: "Salir de Berth",
        },
        AppLocale::De => TrayLabels {
            show_workspace: "Arbeitsbereich anzeigen",
            quit: "Berth beenden",
        },
        AppLocale::Fr => TrayLabels {
            show_workspace: "Afficher l'espace de travail",
            quit: "Quitter Berth",
        },
        AppLocale::Pt => TrayLabels {
            show_workspace: "Mostrar área de trabalho",
            quit: "Sair do Berth",
        },
        AppLocale::Ar => TrayLabels {
            show_workspace: "إظهار مساحة العمل",
            quit: "إنهاء Berth",
        },
        AppLocale::En => TrayLabels {
            show_workspace: "Show Workspace",
            quit: "Quit Berth",
        },
    }
}

/// Install the system tray icon and its right-click menu. Left-click
/// (Linux/Windows) and dock-style activation behaviors map to
/// `show_main_window`. Menu wiring lives in the app-wide
/// `on_menu_event` callback in `lib.rs` so the tray and pet menus share
/// one dispatcher.
#[cfg(feature = "tauri-runtime")]
pub fn install_tray_icon(
    app: &AppHandle,
    locale: crate::models::system::AppLocale,
) -> tauri::Result<()> {
    use tauri::menu::{MenuBuilder, MenuItem, PredefinedMenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let labels = tray_labels_for(locale);
    let show_item = MenuItem::with_id(
        app,
        TRAY_MENU_ID_SHOW,
        labels.show_workspace,
        true,
        None::<&str>,
    )?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, TRAY_MENU_ID_QUIT, labels.quit, true, None::<&str>)?;
    let menu = MenuBuilder::new(app)
        .items(&[&show_item, &separator, &quit_item])
        .build()?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ICON_ID)
        .tooltip("Berth")
        .menu(&menu)
        // `false` is required for `on_tray_icon_event::Click` to fire on
        // every platform we ship: the default `true` causes the OS to
        // consume left-click to pop the menu (notably on macOS — see
        // tauri-apps/tauri#11413). Right-click still shows the menu
        // because that's the OS's job, not ours.
        .show_menu_on_left_click(false);

    // macOS menu bar expects a monochrome template image that adapts to
    // light/dark mode and the user's accent settings. Other platforms
    // (Windows tray, Linux indicators) want the regular colored icon.
    #[cfg(target_os = "macos")]
    {
        match load_macos_tray_template_icon() {
            Ok(icon) => {
                builder = builder.icon(icon).icon_as_template(true);
            }
            Err(err) => {
                tracing::warn!("[Tray] failed to load template icon, falling back: {err}");
                if let Some(icon) = app.default_window_icon() {
                    builder = builder.icon(icon.clone());
                }
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        if let Some(icon) = app.default_window_icon() {
            builder = builder.icon(icon.clone());
        }
    }

    builder
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    TRAY_AVAILABLE.store(true, AtomicOrdering::Relaxed);
    Ok(())
}

/// Rebuild the tray menu in the supplied locale and swap it onto the
/// existing tray icon. No-op if the tray hasn't been installed yet
/// (e.g. the language change races setup, or the platform refused the
/// initial install).
#[cfg(feature = "tauri-runtime")]
pub fn refresh_tray_menu(
    app: &AppHandle,
    locale: crate::models::system::AppLocale,
) -> tauri::Result<()> {
    use tauri::menu::{MenuBuilder, MenuItem, PredefinedMenuItem};

    let Some(tray) = app.tray_by_id(TRAY_ICON_ID) else {
        return Ok(());
    };

    let labels = tray_labels_for(locale);
    let show_item = MenuItem::with_id(
        app,
        TRAY_MENU_ID_SHOW,
        labels.show_workspace,
        true,
        None::<&str>,
    )?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, TRAY_MENU_ID_QUIT, labels.quit, true, None::<&str>)?;
    let menu = MenuBuilder::new(app)
        .items(&[&show_item, &separator, &quit_item])
        .build()?;

    tray.set_menu(Some(menu))?;
    Ok(())
}

/// Push the current effective UI locale to the system tray. Called by
/// the i18n provider whenever the resolved app locale changes — covers
/// both manual selection and OS-driven changes in system mode.
#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn set_tray_locale(
    app: AppHandle,
    locale: crate::models::system::AppLocale,
) -> Result<(), AppCommandError> {
    refresh_tray_menu(&app, locale)
        .map_err(|e| AppCommandError::window("Failed to refresh tray menu", e.to_string()))
}
