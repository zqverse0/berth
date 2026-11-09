//! 设备：可通过 SSH 连接的其他机器（runtime bridge `device.*`）。
//!
//! Berth 只记「名称 → SSH 目标」。网络由 Tailscale / 局域网等负责，登录细节由 OpenSSH
//! （`~/.ssh/config`、密钥）负责；连得上与否以一次 `ssh … true` 为准。
//! 对方装了 berth 即为节点设备（见下）；没装的只能开 SSH 终端，装上后重新检测即成为节点设备。
//!
//! - `device.list` → `[{ id, name, target, localDir, node }]`；`localDir`（`remote/<id>`）是从设备打开的
//!   SSH 终端的起始目录，前端据此把终端归到设备下
//! - `device.check { target, deviceId? }` → `{ ok, message }`
//! - `device.add { name, target }` → 先测连接，连得上才保存
//! - `device.remove { id }`
//! - `device.candidates` → `~/.ssh/config` 里尚未添加的 Host 别名
//! - `device.ensureKey` → `{ publicKey }`：本机没有 SSH 密钥就生成一把（配置免密登录用）
//!
//! 节点设备：添加 / 检查设备时探测到对方装了 berth（路径记在 `<数据目录>/devices/<id>/node.json`），
//! 即经一条节点连接（`ssh <目标> berth node stdio`）操作对方，不挂载。这一条连接承载全部往来：
//! 概览等请求、到对方 GUI 的隧道（终端专线插队、命令线普通、大块只用空闲带宽）、文件传输（只用空闲
//! 带宽），由会话按优先级与时延统一调度；分成多条 SSH 反而互相抢链路（任务 11-01-device-window S3 实测）。
//! 连接按需建立、常驻到设备删除，心跳与重连在 `berth_node::client`。
//!
//! - `device.list` / `device.add` / `device.check` 每台设备带 `node: { berth, status } | null`；
//!   `status` 是这条连接的状态（未建立时为 `null`）
//! - `device.node { deviceId }` → `{ status, overview }`：`overview` 是磁盘缓存里的上次设备概览（没有为
//!   `null`），同时后台取最新的，取到后写缓存并发 `device://node { deviceId, overview | error }`
//! - `device.connect { deviceId }` → `{ port }`：到对方 GUI 的本机回环端口（[`workspace`]），对方项目的
//!   调用经它发出；对方 GUI 未运行报 `device.windowUnavailable`，版本过旧报 `device.berthOutdated`
//! - `device.request { deviceId, request }` → 节点请求的转发（`request` 即 `berth_node::api::Request` 的
//!   JSON，前端只用浏览目录、添加项目）：成功 `{ result }`，节点报错 `{ error: { kind, message, detail? } }`
//! - `device.transfer { deviceId, source, dest }` → `{ id }`：把本机文件 `source` 传到对方 `dest`（绝对路径），
//!   同一条节点连接、只用空闲带宽（分块、断点续传、传完对方校验哈希，见 `berth_node::transfer`）；
//!   进度与结果发 `device://transfer { id, deviceId, source, dest, sent, total, state, error? }`，
//!   `state` 为 `running` / `done` / `failed` / `cancelled`。同一文件再传一次即从断点续上
//! - `device.pull { deviceId, source }` → `{ id, dest }`：把对方文件 `source` 拉到本机缓存 `dest`（拖到系统
//!   文件管理器前用，见 `berth_node::transfer::download`）；进度同上，事件带 `pull: true`
//! - `device.cancelTransfer { id }` → 取消（已收到的部分保留，下次续传）
//! - 连接状态变化发 `device://node-status { deviceId, status }`

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use berth_node::api::{Push, Request};
use berth_node::cache::Cache;
use berth_node::client::{self, Client};
use berth_node::transfer;

use berth_project_core::entities::device;
use chrono::Utc;
use sea_orm::{
    ActiveModelTrait, ActiveValue::NotSet, ColumnTrait, EntityTrait, QueryFilter, QueryOrder, Set,
};
use serde_json::{json, Value};
use tokio::sync::mpsc::UnboundedReceiver;

#[cfg(feature = "tauri-runtime")]
mod workspace;

use crate::db::AppDatabase;
use crate::event_bridge::{emit_event, EventEmitter};

/// ssh 自身的连接超时；外层再留余量兜住卡在认证阶段的情况。
const CONNECT_TIMEOUT_SECS: u64 = 5;
const CHECK_DEADLINE: Duration = Duration::from_secs(10);
/// 每台节点设备的磁盘缓存上限。
const CACHE_CAP: u64 = 64 * 1024 * 1024;
/// 设备概览请求的截止时间（最差链路下也够一次往返加几十 KB）。
const OVERVIEW_DEADLINE: Duration = Duration::from_secs(30);

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
            Ok(json!(devices
                .into_iter()
                .map(|row| {
                    let local_dir = device_dir(mount_root, row.id);
                    json!({
                        "id": row.id,
                        "name": row.name,
                        "target": row.ssh_target,
                        "localDir": local_dir,
                        "node": node_json(mount_root, row.id),
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
                let id = id as i32;
                // 对方可能刚装上 / 升级挪了位置：每次上线重新探测，记下的路径仍可用就沿用。
                let stored = stored_berth(mount_root, id);
                store_berth(mount_root, id, probe(target, stored.as_deref()).await.as_deref());
                let row = device::Entity::find_by_id(id)
                    .one(conn)
                    .await
                    .map_err(|error| error.to_string())?;
                if let Some(node) = row.and_then(|row| node(emitter, mount_root, &row)) {
                    node.data.retry();
                    return Ok(
                        json!({ "ok": true, "message": null, "node": node_json(mount_root, id) }),
                    );
                }
            }
            Ok(json!({ "ok": true, "message": null, "node": null }))
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
            store_berth(mount_root, row.id, probe(target, None).await.as_deref());
            Ok(json!({
                "id": row.id,
                "name": row.name,
                "target": row.ssh_target,
                "localDir": local_dir,
                "node": node_json(mount_root, row.id),
            }))
        }
        "device.remove" => {
            let id = params["id"].as_i64().ok_or("id is required")? as i32;
            device::Entity::delete_by_id(id)
                .exec(conn)
                .await
                .map_err(|error| error.to_string())?;
            NODES.lock().expect("nodes lock").remove(&id);
            let _ = std::fs::remove_dir_all(node_dir(mount_root, id));
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
        "device.node" => {
            let id = params["deviceId"].as_i64().ok_or("deviceId is required")? as i32;
            let row = device::Entity::find_by_id(id)
                .one(conn)
                .await
                .map_err(|error| error.to_string())?
                .ok_or("device not found")?;
            let node = node(emitter, mount_root, &row).ok_or("device.notNode")?;
            let overview = node
                .cache
                .get("device")
                .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
            let (emitter, fresh) = (emitter.clone(), node.clone());
            tokio::spawn(async move {
                let payload = match fresh
                    .data
                    .request(&Request::Device, &[], OVERVIEW_DEADLINE)
                    .await
                {
                    Ok((overview, _)) => {
                        if let Ok(bytes) = serde_json::to_vec(&overview) {
                            let _ = fresh.cache.put("device", &bytes);
                        }
                        json!({ "deviceId": id, "overview": overview })
                    }
                    Err(error) => json!({ "deviceId": id, "error": error }),
                };
                emit_event(&emitter, "device://node", payload);
            });
            Ok(json!({ "status": node_status(&node), "overview": overview }))
        }
        // 到对方 GUI 命令线的本机回环端口：对方项目的调用经它发出（前端 `transport/device.ts`）。
        // 对方 GUI 未运行报 `device.windowUnavailable`。
        #[cfg(feature = "tauri-runtime")]
        "device.connect" => {
            if !matches!(emitter, EventEmitter::Tauri(_)) {
                return Err("device.windowUnavailable".into());
            }
            let id = params["deviceId"].as_i64().ok_or("deviceId is required")? as i32;
            let row = device::Entity::find_by_id(id)
                .one(conn)
                .await
                .map_err(|error| error.to_string())?
                .ok_or("device not found")?;
            let node = node(emitter, mount_root, &row).ok_or("device.notNode")?;
            // 每次现取：设备 socket 只在对方 GUI 运行时才报。
            let (overview, _) = node
                .data
                .request(&Request::Device, &[], OVERVIEW_DEADLINE)
                .await
                .map_err(|error| error.to_string())?;
            if let Ok(bytes) = serde_json::to_vec(&overview) {
                let _ = node.cache.put("device", &bytes);
            }
            // 旧版对方不报 `window` 字段：要升级；报了但为空：对方 GUI 没在运行——除非对方能起
            // 无界面宿主（`hostable`，无显示器的设备），由隧道在首个连接时拉起。
            match overview.get("window") {
                None => return Err("device.berthOutdated".into()),
                Some(window) if window.is_null() && overview["hostable"] != true => {
                    return Err("device.windowUnavailable".into())
                }
                Some(_) => {}
            }
            let port = workspace::port(id, &node).await?;
            Ok(json!({ "port": port }))
        }
        "device.request" => {
            let node = connected(params)?;
            let request: Request = serde_json::from_value(params["request"].clone())
                .map_err(|error| format!("invalid request: {error}"))?;
            Ok(match node.data.request(&request, &[], OVERVIEW_DEADLINE).await {
                Ok((result, _)) => json!({ "result": result }),
                Err(error) => json!({ "error": error }),
            })
        }
        "device.transfer" => {
            let id = params["deviceId"].as_i64().ok_or("deviceId is required")? as i32;
            let source = params["source"]
                .as_str()
                .ok_or("source is required")?
                .to_owned();
            let dest = params["dest"]
                .as_str()
                .ok_or("dest is required")?
                .to_owned();
            let row = device::Entity::find_by_id(id)
                .one(conn)
                .await
                .map_err(|error| error.to_string())?
                .ok_or("device not found")?;
            let node = node(emitter, mount_root, &row).ok_or("device.notNode")?;
            Ok(json!({ "id": start_transfer(emitter.clone(), id, node, source, dest, false) }))
        }
        "device.pull" => {
            let id = params["deviceId"].as_i64().ok_or("deviceId is required")? as i32;
            let source = params["source"]
                .as_str()
                .ok_or("source is required")?
                .to_owned();
            let row = device::Entity::find_by_id(id)
                .one(conn)
                .await
                .map_err(|error| error.to_string())?
                .ok_or("device not found")?;
            let node = node(emitter, mount_root, &row).ok_or("device.notNode")?;
            let dest = pull_dest(mount_root, id, &source)?;
            let transfer = start_transfer(emitter.clone(), id, node, source, dest.clone(), true);
            Ok(json!({ "id": transfer, "dest": dest }))
        }
        "device.cancelTransfer" => {
            let id = params["id"].as_u64().ok_or("id is required")?;
            if let Some(task) = TRANSFERS.lock().expect("transfers lock").remove(&id) {
                task.abort();
            }
            Ok(Value::Null)
        }
        _ => Err(format!("unsupported device operation: {method}")),
    }
}

/// 进行中的传输（按传输 id），取消即 abort。
static TRANSFERS: LazyLock<Mutex<HashMap<u64, tokio::task::AbortHandle>>> =
    LazyLock::new(Default::default);
static NEXT_TRANSFER: AtomicU64 = AtomicU64::new(1);

/// 拉取的缓存路径 `<设备目录>/pull/<源路径哈希>/<文件名>`：文件名不变，拖到文件管理器里就是这个名字。
/// ponytail: 只在下一次拉取时清掉一天前的缓存；缓存占用成问题再加上限。
fn pull_dest(mount_root: &Path, device_id: i32, source: &str) -> Result<String, String> {
    use std::hash::{DefaultHasher, Hash, Hasher};
    let name = Path::new(source)
        .file_name()
        .ok_or("source has no file name")?;
    let root = node_dir(mount_root, device_id).join("pull");
    if let Ok(entries) = std::fs::read_dir(&root) {
        let expired = |entry: &std::fs::DirEntry| {
            let age = entry.metadata().and_then(|meta| meta.modified()).ok();
            age.and_then(|time| time.elapsed().ok())
                .is_some_and(|age| age > PULL_CACHE_MAX_AGE)
        };
        for entry in entries.flatten().filter(expired) {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
    let mut hasher = DefaultHasher::new();
    source.hash(&mut hasher);
    let dir = root.join(format!("{:016x}", hasher.finish()));
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir.join(name).display().to_string())
}

const PULL_CACHE_MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);

fn start_transfer(
    emitter: EventEmitter,
    device_id: i32,
    node: Arc<Node>,
    source: String,
    dest: String,
    pull: bool,
) -> u64 {
    let id = NEXT_TRANSFER.fetch_add(1, Ordering::Relaxed);
    let emit = {
        let (source, dest) = (source.clone(), dest.clone());
        move |state: &str, sent: u64, total: u64, error: Option<&str>| {
            let payload = json!({
                "id": id, "deviceId": device_id, "source": source, "dest": dest,
                "sent": sent, "total": total, "state": state, "error": error, "pull": pull,
            });
            emit_event(&emitter, "device://transfer", payload);
        }
    };
    // 持锁登记再放任务跑：任务立刻结束时也能从表里移除。
    let mut transfers = TRANSFERS.lock().expect("transfers lock");
    let task = tokio::spawn({
        let emit = emit.clone();
        async move {
            let client = &node.data;
            let mut last = (0, 0);
            let send = |request: Request, body: Vec<u8>| {
                client.request(&request, &body, transfer::CHUNK_DEADLINE)
            };
            let progress = |sent: u64, total: u64| {
                last = (sent, total);
                emit("running", sent, total, None);
            };
            let result = if pull {
                transfer::download(&source, Path::new(&dest), send, progress).await
            } else {
                transfer::upload(Path::new(&source), &dest, send, progress)
                    .await
                    .map(|_| ())
            };
            TRANSFERS.lock().expect("transfers lock").remove(&id);
            match result {
                Ok(_) => emit("done", last.1, last.1, None),
                Err(error) => emit("failed", last.0, last.1, Some(&error.message)),
            }
        }
    });
    transfers.insert(id, task.abort_handle());
    drop(transfers);
    // abort 掉的任务发不了事件：由这里补发 `cancelled`。
    tokio::spawn(async move {
        if task.await.is_err_and(|error| error.is_cancelled()) {
            emit("cancelled", 0, 0, None);
        }
    });
    id
}

/// 已建立连接的节点设备（`params.deviceId`）。
fn connected(params: &Value) -> Result<Arc<Node>, String> {
    let id = params["deviceId"].as_i64().ok_or("deviceId is required")? as i32;
    NODES
        .lock()
        .expect("nodes lock")
        .get(&id)
        .cloned()
        .ok_or_else(|| "device.notNode".to_owned())
}

/// 一台节点设备：唯一的节点连接与设备概览的磁盘缓存。
struct Node {
    berth: String,
    data: Client,
    /// 节点推送（隧道流的字节）：到对方 GUI 的隧道第一次建立时取走（[`workspace`]）。
    pushes: Mutex<Option<NodePushes>>,
    cache: Cache,
}

type NodePushes = UnboundedReceiver<(Push, Vec<u8>)>;

/// 已建立的节点连接，按设备 id。
static NODES: LazyLock<Mutex<HashMap<i32, Arc<Node>>>> = LazyLock::new(Default::default);

/// 设备的状态目录 `<数据目录>/devices/<id>/`：`node.json`（探测到的 berth 路径）与 `cache/`。
/// ponytail: 由 `mount_root`（`<数据目录>/remote`）推出数据目录；dispatch 改传数据目录时换掉。
fn node_dir(mount_root: &Path, id: i32) -> PathBuf {
    mount_root.with_file_name("devices").join(id.to_string())
}

fn stored_berth(mount_root: &Path, id: i32) -> Option<String> {
    let bytes = std::fs::read(node_dir(mount_root, id).join("node.json")).ok()?;
    let value: Value = serde_json::from_slice(&bytes).ok()?;
    value["berth"].as_str().map(str::to_owned)
}

/// 记下（或清除）探测结果；路径变了的已建连接随之丢弃，下次按新路径重建。
fn store_berth(mount_root: &Path, id: i32, berth: Option<&str>) {
    let file = node_dir(mount_root, id).join("node.json");
    match berth {
        Some(berth) => {
            let _ = std::fs::create_dir_all(node_dir(mount_root, id));
            let _ = std::fs::write(&file, json!({ "berth": berth }).to_string());
        }
        None => {
            let _ = std::fs::remove_file(&file);
        }
    }
    let mut nodes = NODES.lock().expect("nodes lock");
    if nodes
        .get(&id)
        .is_some_and(|node| Some(node.berth.as_str()) != berth)
    {
        nodes.remove(&id);
    }
}

/// 探测对方 berth 的路径（`stored` 是上次记下的）；连不上或没装都是 `None`。
async fn probe(target: &str, stored: Option<&str>) -> Option<String> {
    let mut command = tokio::process::Command::new("ssh");
    command.args([
        "-o",
        "BatchMode=yes",
        "-o",
        &format!("ConnectTimeout={CONNECT_TIMEOUT_SECS}"),
        "--",
        target,
        &client::probe_command(stored),
    ]);
    let stdout = output(command, CHECK_DEADLINE).await.ok()?;
    stdout
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_owned)
}

/// 节点设备的连接：已建立的直接用；探测过但还没连的现在建立。不是节点设备返回 `None`。
fn node(emitter: &EventEmitter, mount_root: &Path, row: &device::Model) -> Option<Arc<Node>> {
    let (id, target) = (row.id, row.ssh_target.as_str());
    let berth = stored_berth(mount_root, id)?;
    let mut nodes = NODES.lock().expect("nodes lock");
    if let Some(node) = nodes.get(&id) {
        return Some(node.clone());
    }
    let (data, pushes) = Client::start(client::ssh(target.to_owned(), client::node_command(&berth)));
    let mut status = data.status();
    let events = emitter.clone();
    tokio::spawn(async move {
        loop {
            let current = status.borrow_and_update().clone();
            emit_event(
                &events,
                "device://node-status",
                json!({ "deviceId": id, "status": current }),
            );
            if status.changed().await.is_err() {
                return;
            }
        }
    });
    let node = Arc::new(Node {
        berth,
        data,
        pushes: Mutex::new(Some(pushes)),
        cache: Cache::new(node_dir(mount_root, id).join("cache"), CACHE_CAP),
    });
    nodes.insert(id, node.clone());
    Some(node)
}

fn node_status(node: &Node) -> Value {
    json!(node.data.status().borrow().clone())
}

/// `device.*` 返回里的 `node` 字段。
fn node_json(mount_root: &Path, id: i32) -> Value {
    let Some(berth) = stored_berth(mount_root, id) else {
        return Value::Null;
    };
    let status = NODES
        .lock()
        .expect("nodes lock")
        .get(&id)
        .map_or(Value::Null, |node| node_status(node));
    json!({ "berth": berth, "status": status })
}

/// 设备在本机的目录 `remote/<id>`：从设备打开的 SSH 终端的起始目录（建好再返回）。
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
        .rfind(|line| !line.is_empty())
        .map_or_else(|| format!("{program} failed"), str::to_owned))
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
}
