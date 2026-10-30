//! 设备：可通过 SSH 连接的其他机器（runtime bridge `device.*`）。
//!
//! Berth 只记「名称 → SSH 目标」。网络由 Tailscale / 局域网等负责，登录细节由 OpenSSH
//! （`~/.ssh/config`、密钥）负责；连得上与否以一次 `ssh … true` 为准。
//!
//! 远程项目 = 普通项目 + `device_project` 一行：项目路径是本机的 sshfs 挂载点，文件、任务、
//! 知识库照常按路径工作；在项目里新建的 shell 终端改为 ssh 到设备上的对应目录（[`remote_shell`]）。
//!
//! - `device.list` → `[{ id, name, target, localDir, projects: [{ folderId, remotePath }] }]`；
//!   `localDir`（`remote/<id>`）是从设备打开的终端的起始目录，前端据此把终端归到设备下
//! - `device.check { target, deviceId? }` → `{ ok, message }`；带 `deviceId` 且连得上时顺带挂好它的项目
//! - `device.add { name, target }` → 先测连接，连得上才保存
//! - `device.remove { id }` → 还有项目时拒绝
//! - `device.candidates` → `~/.ssh/config` 里尚未添加的 Host 别名
//! - `device.ensureKey` → `{ publicKey }`：本机没有 SSH 密钥就生成一把（配置免密登录用）
//! - `device.addProject { deviceId, remotePath }` → 挂载并注册为项目，返回 `FolderDetail`
//! - `device.listDirs { deviceId, path }` → `{ path, dirs }`：设备上该目录的绝对路径与子目录名
//!   （不含隐藏目录），添加项目时浏览用；`path` 为空即登录目录

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use berth_project_core::entities::{device, device_project, folder};
use chrono::Utc;
use sea_orm::{
    ActiveModelTrait, ActiveValue::NotSet, ColumnTrait, DatabaseConnection, EntityTrait,
    QueryFilter, QueryOrder, Set,
};
use serde_json::{json, Value};

use crate::db::AppDatabase;
use crate::event_bridge::EventEmitter;

/// ssh 自身的连接超时；外层再留余量兜住卡在认证阶段的情况。
const CONNECT_TIMEOUT_SECS: u64 = 5;
const CHECK_DEADLINE: Duration = Duration::from_secs(10);
const MOUNT_DEADLINE: Duration = Duration::from_secs(20);

/// `mount_root`：远程项目挂载点的父目录（数据目录下的 `remote/`）。
pub async fn dispatch(
    db: &AppDatabase,
    emitter: &EventEmitter,
    mount_root: &Path,
    method: &str,
    params: &Value,
) -> Result<Value, String> {
    let conn = &db.conn;
    match method {
        "device.list" => {
            let devices = device::Entity::find()
                .order_by_asc(device::Column::Name)
                .all(conn)
                .await
                .map_err(|error| error.to_string())?;
            let projects = device_project::Entity::find()
                .all(conn)
                .await
                .map_err(|error| error.to_string())?;
            Ok(json!(devices
                .into_iter()
                .map(|row| {
                    let own: Vec<Value> = projects
                        .iter()
                        .filter(|p| p.device_id == row.id)
                        .map(|p| json!({ "folderId": p.folder_id, "remotePath": p.remote_path }))
                        .collect();
                    let local_dir = device_dir(mount_root, row.id);
                    json!({
                        "id": row.id,
                        "name": row.name,
                        "target": row.ssh_target,
                        "localDir": local_dir,
                        "projects": own,
                    })
                })
                .collect::<Vec<_>>()))
        }
        "device.check" => {
            let target = valid_target(params["target"].as_str().unwrap_or_default())?;
            if let Err(message) = check(target).await {
                return Ok(json!({ "ok": false, "message": message }));
            }
            if let Some(id) = params["deviceId"].as_i64() {
                // 挂载失败不影响「在线」：项目打开时会看到空目录，日志里有原因。
                if let Err(error) = mount_device_projects(conn, id as i32, target).await {
                    tracing::warn!("[devices] mount projects of device {id}: {error}");
                }
            }
            Ok(json!({ "ok": true, "message": null }))
        }
        "device.add" => {
            let name = params["name"].as_str().unwrap_or_default().trim();
            if name.is_empty() {
                return Err("device.nameRequired".into());
            }
            let target = valid_target(params["target"].as_str().unwrap_or_default())?;
            let taken = device::Entity::find()
                .filter(device::Column::Name.eq(name))
                .one(conn)
                .await
                .map_err(|error| error.to_string())?;
            if taken.is_some() {
                return Err("device.nameTaken".into());
            }
            check(target).await?;
            let now = Utc::now();
            let row = device::ActiveModel {
                id: NotSet,
                name: Set(name.to_owned()),
                ssh_target: Set(target.to_owned()),
                created_at: Set(now),
                updated_at: Set(now),
            }
            .insert(conn)
            .await
            .map_err(|error| error.to_string())?;
            let local_dir = device_dir(mount_root, row.id);
            Ok(json!({
                "id": row.id,
                "name": row.name,
                "target": row.ssh_target,
                "localDir": local_dir,
                "projects": [],
            }))
        }
        "device.remove" => {
            let id = params["id"].as_i64().ok_or("id is required")? as i32;
            let has_projects = device_project::Entity::find()
                .filter(device_project::Column::DeviceId.eq(id))
                .one(conn)
                .await
                .map_err(|error| error.to_string())?
                .is_some();
            if has_projects {
                return Err("device.hasProjects".into());
            }
            device::Entity::delete_by_id(id)
                .exec(conn)
                .await
                .map_err(|error| error.to_string())?;
            Ok(Value::Null)
        }
        "device.candidates" => {
            let added: Vec<String> = device::Entity::find()
                .all(conn)
                .await
                .map_err(|error| error.to_string())?
                .into_iter()
                .map(|row| row.ssh_target)
                .collect();
            let config = dirs::home_dir()
                .map(|home| home.join(".ssh/config"))
                .and_then(|path| std::fs::read_to_string(path).ok())
                .unwrap_or_default();
            let hosts: Vec<String> = ssh_config_hosts(&config)
                .into_iter()
                .filter(|host| !added.contains(host))
                .collect();
            Ok(json!(hosts))
        }
        "device.ensureKey" => {
            let key = ensure_key().await?;
            Ok(json!({ "publicKey": key }))
        }
        "device.addProject" => {
            let id = params["deviceId"].as_i64().ok_or("deviceId is required")? as i32;
            let remote = valid_remote_path(params["remotePath"].as_str().unwrap_or_default())?;
            let row = device::Entity::find_by_id(id)
                .one(conn)
                .await
                .map_err(|error| error.to_string())?
                .ok_or("device not found")?;
            // 同一目录加过（项目后来从列表移除）：挂回原挂载点、重新打开原项目。
            let existing = device_project::Entity::find()
                .filter(device_project::Column::DeviceId.eq(id))
                .filter(device_project::Column::RemotePath.eq(remote.as_str()))
                .one(conn)
                .await
                .map_err(|error| error.to_string())?;
            if let Some(link) = existing {
                let path = folder::Entity::find_by_id(link.folder_id)
                    .one(conn)
                    .await
                    .map_err(|error| error.to_string())?
                    .ok_or("project not found")?
                    .path;
                mount_device_projects(conn, id, &row.ssh_target).await?;
                let detail =
                    crate::commands::folders::open_folder_in_workspace_core(emitter, db, path)
                        .await
                        .map_err(|error| error.to_string())?;
                return serde_json::to_value(detail).map_err(|error| error.to_string());
            }
            let mountpoint = free_mountpoint(Path::new(&device_dir(mount_root, id)), &remote);
            std::fs::create_dir_all(&mountpoint).map_err(|error| error.to_string())?;
            if let Err(error) = mount(&row.ssh_target, &remote, &mountpoint).await {
                let _ = std::fs::remove_dir(&mountpoint);
                return Err(error);
            }
            let path = mountpoint.to_string_lossy().into_owned();
            let detail = crate::commands::folders::open_folder_in_workspace_core(emitter, db, path)
                .await
                .map_err(|error| error.to_string())?;
            device_project::ActiveModel {
                folder_id: Set(detail.id),
                device_id: Set(id),
                remote_path: Set(remote),
                created_at: Set(Utc::now()),
            }
            .insert(conn)
            .await
            .map_err(|error| error.to_string())?;
            serde_json::to_value(detail).map_err(|error| error.to_string())
        }
        "device.listDirs" => {
            let id = params["deviceId"].as_i64().ok_or("deviceId is required")? as i32;
            let raw = params["path"].as_str().unwrap_or_default();
            let remote = if raw.trim().is_empty() {
                ".".to_owned()
            } else {
                valid_remote_path(raw)?
            };
            let row = device::Entity::find_by_id(id)
                .one(conn)
                .await
                .map_err(|error| error.to_string())?
                .ok_or("device not found")?;
            let mut command = tokio::process::Command::new("ssh");
            command.args([
                "-o",
                "BatchMode=yes",
                "-o",
                &format!("ConnectTimeout={CONNECT_TIMEOUT_SECS}"),
                "--",
                &row.ssh_target,
                &list_dirs_command(&remote),
            ]);
            let stdout = output(command, CHECK_DEADLINE).await?;
            let mut lines = stdout.lines();
            let path = lines.next().unwrap_or("/").to_owned();
            let dirs: Vec<&str> = lines.filter(|line| !line.is_empty()).collect();
            Ok(json!({ "path": path, "dirs": dirs }))
        }
        _ => Err(format!("unsupported device operation: {method}")),
    }
}

/// 远程项目里新建 shell 终端的 argv：`ssh -t <目标> 'cd <远程目录> && exec $SHELL -l'`。
/// `cwd` 是挂载点下的目录时换算成设备上的对应目录；本地项目返回 `None`。
pub async fn remote_shell(
    conn: &DatabaseConnection,
    folder_id: i32,
    cwd: &str,
) -> Option<Vec<String>> {
    let remote = RemoteProject::load(conn, folder_id).await?;
    let sub = Path::new(cwd).strip_prefix(&remote.mount).ok();
    let dir = remote_dir(&remote.path, sub);
    Some(vec![
        "ssh".into(),
        "-t".into(),
        "--".into(),
        remote.target,
        format!("cd {} && exec \"$SHELL\" -l", sh_quote(&dir)),
    ])
}

/// 远程项目里所有终端（含 Agent）的环境：`BERTH_REMOTE_TARGET`（ssh 目标）、
/// `BERTH_REMOTE_PATH`（设备上的项目目录）、`BERTH_REMOTE_MOUNT`（本机挂载点）。
/// Agent 插件据此把命令转到设备上执行（挂载点下的目录按同一相对路径换算）；本地项目返回 `None`。
pub async fn remote_env(
    conn: &DatabaseConnection,
    folder_id: i32,
) -> Option<Vec<(&'static str, String)>> {
    let remote = RemoteProject::load(conn, folder_id).await?;
    Some(vec![
        ("BERTH_REMOTE_TARGET", remote.target),
        ("BERTH_REMOTE_PATH", remote.path),
        ("BERTH_REMOTE_MOUNT", remote.mount),
    ])
}

struct RemoteProject {
    target: String,
    path: String,
    mount: String,
}

impl RemoteProject {
    async fn load(conn: &DatabaseConnection, folder_id: i32) -> Option<Self> {
        let link = device_project::Entity::find_by_id(folder_id)
            .one(conn)
            .await
            .ok()??;
        let target = device::Entity::find_by_id(link.device_id)
            .one(conn)
            .await
            .ok()??
            .ssh_target;
        let mount = folder::Entity::find_by_id(folder_id)
            .one(conn)
            .await
            .ok()??
            .path;
        Some(Self {
            target,
            path: link.remote_path,
            mount,
        })
    }
}

/// 设备在本机的目录 `remote/<id>`：项目挂载点的父目录，也是从设备打开的终端的起始目录（建好再返回）。
fn device_dir(mount_root: &Path, id: i32) -> String {
    let dir = mount_root.join(id.to_string());
    let _ = std::fs::create_dir_all(&dir);
    dir.to_string_lossy().into_owned()
}

/// 目标原样交给 ssh 作为参数（不经 shell）；仍拒绝以 `-` 开头（会被当成选项）和空白 / 控制字符。
fn valid_target(raw: &str) -> Result<&str, String> {
    let target = raw.trim();
    if target.is_empty()
        || target.starts_with('-')
        || target.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return Err("device.targetInvalid".into());
    }
    Ok(target)
}

/// 设备上的目录：去掉 `~/`（sftp 本就相对家目录）、末尾 `/`；`~` 本身即家目录（`.`）。
fn valid_remote_path(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.starts_with('-') || trimmed.chars().any(char::is_control) {
        return Err("device.remotePathInvalid".into());
    }
    let path = trimmed.strip_prefix("~/").unwrap_or(trimmed);
    let path = if path == "~" { "." } else { path };
    let path = path.trim_end_matches('/');
    Ok(if path.is_empty() {
        "/".into()
    } else {
        path.into()
    })
}

/// 挂载点：`<root>/<远程目录名>`，已被占用（非空目录、或已是挂载点）时加 `-2`、`-3`……
fn free_mountpoint(root: &Path, remote: &str) -> PathBuf {
    let base = Path::new(remote)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| name != "." && name != "..")
        .unwrap_or_else(|| "home".into());
    let free = |path: &Path| {
        !is_mountpoint(path)
            && std::fs::read_dir(path).map_or(true, |mut entries| entries.next().is_none())
    };
    let mut candidate = root.join(&base);
    let mut n = 2;
    while !free(&candidate) {
        candidate = root.join(format!("{base}-{n}"));
        n += 1;
    }
    candidate
}

fn remote_dir(remote: &str, sub: Option<&Path>) -> String {
    match sub
        .map(|sub| sub.to_string_lossy().into_owned())
        .filter(|sub| !sub.is_empty())
    {
        Some(sub) => format!("{}/{sub}", remote.trim_end_matches('/')),
        None => remote.to_owned(),
    }
}

/// POSIX shell 单引号转义：远端 shell 收到的是这一整条命令文本。
fn sh_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

/// 远端命令：首行 `pwd`，其后每行一个子目录名。包一层 `sh -c`，登录 shell 是 fish / zsh 也照样跑；
/// 相对路径相对登录目录（ssh 落在那里）。
fn list_dirs_command(remote: &str) -> String {
    let script = format!(
        "cd -- {} || exit 1; pwd; for d in */; do [ -d \"$d\" ] && printf '%s\\n' \"${{d%/}}\"; done; exit 0",
        sh_quote(remote)
    );
    format!("sh -c {}", sh_quote(&script))
}

/// `ssh -o BatchMode=yes <target> true`：不弹密码，连不上返回 ssh 的最后一行错误。
async fn check(target: &str) -> Result<(), String> {
    let mut command = tokio::process::Command::new("ssh");
    command.args([
        "-o",
        "BatchMode=yes",
        "-o",
        &format!("ConnectTimeout={CONNECT_TIMEOUT_SECS}"),
        "--",
        target,
        "true",
    ]);
    run(command, CHECK_DEADLINE).await
}

/// 把该设备上已登记、但当前没挂上的项目挂好（开机后、设备重新上线时）。
async fn mount_device_projects(
    conn: &DatabaseConnection,
    device_id: i32,
    target: &str,
) -> Result<(), String> {
    let links = device_project::Entity::find()
        .filter(device_project::Column::DeviceId.eq(device_id))
        .all(conn)
        .await
        .map_err(|error| error.to_string())?;
    for link in links {
        let Some(row) = folder::Entity::find_by_id(link.folder_id)
            .one(conn)
            .await
            .map_err(|error| error.to_string())?
        else {
            continue;
        };
        let mountpoint = PathBuf::from(&row.path);
        if is_mountpoint(&mountpoint) {
            continue;
        }
        std::fs::create_dir_all(&mountpoint).map_err(|error| error.to_string())?;
        mount(target, &link.remote_path, &mountpoint).await?;
    }
    Ok(())
}

/// sshfs：`idmap=user` 让远端文件显示为本机用户（否则 git 报 dubious ownership）；
/// `reconnect` + 心跳让短暂断网后自动恢复。
async fn mount(target: &str, remote: &str, mountpoint: &Path) -> Result<(), String> {
    if which::which("sshfs").is_err() {
        return Err("device.sshfsMissing".into());
    }
    let mut command = tokio::process::Command::new("sshfs");
    command
        .arg("-o")
        .arg("idmap=user,reconnect,ServerAliveInterval=15,ServerAliveCountMax=3,BatchMode=yes")
        .arg(format!("{target}:{remote}"))
        .arg(mountpoint);
    run(command, MOUNT_DEADLINE).await
}

/// 本机已有的公钥；都没有就生成 `~/.ssh/id_ed25519`（无口令，与 `ssh-keygen` 默认位置一致）。
async fn ensure_key() -> Result<String, String> {
    let ssh_dir = dirs::home_dir()
        .ok_or("home directory is unavailable")?
        .join(".ssh");
    for name in ["id_ed25519", "id_ecdsa", "id_rsa"] {
        let public = ssh_dir.join(format!("{name}.pub"));
        if public.is_file() {
            return Ok(public.to_string_lossy().into_owned());
        }
    }
    std::fs::create_dir_all(&ssh_dir).map_err(|error| error.to_string())?;
    let private = ssh_dir.join("id_ed25519");
    let mut command = tokio::process::Command::new("ssh-keygen");
    command
        .args(["-q", "-t", "ed25519", "-N", "", "-C", "berth", "-f"])
        .arg(&private);
    run(command, CHECK_DEADLINE).await?;
    Ok(format!("{}.pub", private.to_string_lossy()))
}

/// 跑一个不需要输入的命令；失败时返回 stderr 最后一行。
async fn run(command: tokio::process::Command, deadline: Duration) -> Result<(), String> {
    output(command, deadline).await.map(drop)
}

/// 同 [`run`]，成功时返回 stdout。
async fn output(
    mut command: tokio::process::Command,
    deadline: Duration,
) -> Result<String, String> {
    let program = command
        .as_std()
        .get_program()
        .to_string_lossy()
        .into_owned();
    let child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| format!("{program}: {error}"))?;
    let output = tokio::time::timeout(deadline, child.wait_with_output())
        .await
        .map_err(|_| "device.timeout".to_owned())?
        .map_err(|error| format!("{program}: {error}"))?;
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).into_owned());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    Err(stderr
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .last()
        .map_or_else(|| format!("{program} failed"), str::to_owned))
}

/// 路径当前是否是挂载点（`/proc/self/mounts`，挂载点里的空格等写成 `\040` 八进制转义）。
fn is_mountpoint(path: &Path) -> bool {
    let Ok(mounts) = std::fs::read_to_string("/proc/self/mounts") else {
        return false;
    };
    let wanted = path.to_string_lossy();
    mounts
        .lines()
        .filter_map(|line| line.split(' ').nth(1))
        .any(|field| unescape_mount_field(field) == wanted)
}

fn unescape_mount_field(field: &str) -> String {
    let bytes = field.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\\' && i + 3 < bytes.len() {
            if let Some(code) = std::str::from_utf8(&bytes[i + 1..i + 4])
                .ok()
                .and_then(|digits| u8::from_str_radix(digits, 8).ok())
            {
                out.push(code);
                i += 4;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// `~/.ssh/config` 顶层 `Host` 行里的具体别名（跳过通配符与否定模式；不跟随 Include）。
fn ssh_config_hosts(config: &str) -> Vec<String> {
    let mut hosts = Vec::new();
    for line in config.lines() {
        let mut words = line.split_whitespace();
        let Some(keyword) = words.next() else {
            continue;
        };
        if !keyword.eq_ignore_ascii_case("host") {
            continue;
        }
        for host in words {
            if host.starts_with('#') {
                break;
            }
            if host.contains(['*', '?']) || host.starts_with('!') || hosts.iter().any(|h| h == host)
            {
                continue;
            }
            hosts.push(host.to_owned());
        }
    }
    hosts
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ssh_config_hosts_skips_patterns_and_comments() {
        let config = "Host *\n  User x\n  Host mac  server # comment\nhost !bad dev?\nHost mac\nHostName 1.2.3.4\n";
        assert_eq!(ssh_config_hosts(config), ["mac", "server"]);
    }

    #[test]
    fn valid_target_rejects_options_and_whitespace() {
        assert_eq!(valid_target(" m@100.0.0.3 "), Ok("m@100.0.0.3"));
        assert!(valid_target("-oProxyCommand=x").is_err());
        assert!(valid_target("a b").is_err());
        assert!(valid_target("").is_err());
    }

    #[test]
    fn remote_paths_normalize_home_and_join_subdirs() {
        assert_eq!(valid_remote_path("~/proj/").unwrap(), "proj");
        assert_eq!(valid_remote_path("~").unwrap(), ".");
        assert_eq!(valid_remote_path("/srv/app").unwrap(), "/srv/app");
        assert!(valid_remote_path("-x").is_err());
        assert_eq!(remote_dir("proj", Some(Path::new("src/a"))), "proj/src/a");
        assert_eq!(remote_dir("/srv/app", None), "/srv/app");
        assert_eq!(sh_quote("it's"), r"'it'\''s'");
        assert_eq!(unescape_mount_field(r"/a\040b"), "/a b");
    }

    #[test]
    fn list_dirs_command_prints_pwd_then_visible_subdirs() {
        let root = std::env::temp_dir().join(format!("berth-list-dirs-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        for dir in ["it's b", "a", ".hidden"] {
            std::fs::create_dir_all(root.join(dir)).unwrap();
        }
        std::fs::write(root.join("file"), "").unwrap();
        let run = |path: &Path| {
            std::process::Command::new("sh")
                .arg("-c")
                .arg(list_dirs_command(&path.to_string_lossy()))
                .output()
                .unwrap()
        };
        // macOS 的临时目录在符号链接 /var 下，用规范路径执行，pwd 才与期望一致。
        let canonical = root.canonicalize().unwrap();
        let out = run(&canonical);
        assert!(out.status.success());
        let expected = format!("{}\na\nit's b\n", canonical.display());
        assert_eq!(String::from_utf8_lossy(&out.stdout), expected);
        assert!(!run(&root.join("missing")).status.success());
        std::fs::remove_dir_all(&root).unwrap();
    }
}
