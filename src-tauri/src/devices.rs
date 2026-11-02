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
//! 即经两条节点连接（终端通道、数据通道，各一个 `ssh <目标> berth node stdio`）操作对方，不挂载。
//! 连接按需建立、常驻到设备删除，心跳与重连在 `berth_node::client`。
//!
//! - `device.list` / `device.add` / `device.check` 每台设备带 `node: { berth, status } | null`；
//!   `status` 是 `{ data, terminal }` 两条连接的状态（未建立时为 `null`）
//! - `device.node { deviceId }` → `{ status, overview }`：`overview` 是磁盘缓存里的上次设备概览（没有为
//!   `null`），同时后台取最新的，取到后写缓存并发 `device://node { deviceId, overview | error }`
//! - `device.launchbar { deviceId }` → 对方的启动栏（工具原样的 tool.json / launchbar.json 与服务商）
//! - `device.createTerminal { deviceId, project, agent?, inputs?, provider?, model? }` → 在对方项目里新建终端
//!   （给 `agent` 即用对方启动栏启动 Agent），返回本机终端描述；远端终端见 [`terminals`]
//! - `device.request { deviceId, request, body?, cached? }` → 数据通道的通用转发（`request` 即
//!   `berth_node::api::Request` 的 JSON）：成功 `{ result, body }`（原始字节为 base64，没有为 `null`），
//!   节点报错 `{ error: { kind, message, detail? } }`。只读请求按请求写磁盘缓存；`cached: true` 只读缓存
//!   （0 次往返，没有为 `null`）。`List` / `Project` 自动带上缓存里的版本，未变时用缓存补齐，前端不管版本
//! - `device.transfer { deviceId, source, dest }` → `{ id }`：把本机文件 `source` 传到对方 `dest`（绝对路径），
//!   走按需建立的第三条节点连接（分块、断点续传、传完对方校验哈希，见 `berth_node::transfer`）；
//!   进度与结果发 `device://transfer { id, deviceId, source, dest, sent, total, state, error? }`，
//!   `state` 为 `running` / `done` / `failed` / `cancelled`。同一文件再传一次即从断点续上
//! - `device.cancelTransfer { id }` → 取消（对方保留已收到的部分，下次续传）
//! - 连接状态变化发 `device://node-status { deviceId, channel: "data" | "terminal", status }`

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, OnceLock};
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use berth_node::api::Request;
use berth_node::cache::Cache;
use berth_node::client::{self, Client};
use berth_node::transfer;

use berth_project_core::entities::device;
use chrono::Utc;
use sea_orm::{
    ActiveModelTrait, ActiveValue::NotSet, ColumnTrait, EntityTrait, QueryFilter, QueryOrder, Set,
};
use serde_json::{json, Value};

pub(crate) mod terminals;

use crate::db::AppDatabase;
use crate::event_bridge::{emit_event, EventEmitter};

/// ssh 自身的连接超时；外层再留余量兜住卡在认证阶段的情况。
const CONNECT_TIMEOUT_SECS: u64 = 5;
const CHECK_DEADLINE: Duration = Duration::from_secs(10);
/// 每台节点设备的磁盘缓存上限。
const CACHE_CAP: u64 = 64 * 1024 * 1024;
/// 设备概览请求的截止时间（最差链路下也够一次往返加几十 KB）。
const OVERVIEW_DEADLINE: Duration = Duration::from_secs(30);
/// 终端每次输入后传输连接让路的时长。
const TRANSFER_YIELD: Duration = Duration::from_secs(3);

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
                // 对方可能刚装上 / 升级挪了位置：每次上线重新探测。
                store_berth(mount_root, id, probe(target).await.as_deref());
                let row = device::Entity::find_by_id(id)
                    .one(conn)
                    .await
                    .map_err(|error| error.to_string())?;
                if let Some(node) = row.and_then(|row| node(emitter, mount_root, &row)) {
                    node.data.retry();
                    node.terminal.retry();
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
            store_berth(mount_root, row.id, probe(target).await.as_deref());
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
        "device.launchbar" => {
            let node = connected(params)?;
            let (launchbar, _) = node
                .data
                .request(&Request::Launchbar, &[], OVERVIEW_DEADLINE)
                .await
                .map_err(|error| error.message)?;
            Ok(launchbar)
        }
        "device.createTerminal" => {
            let id = params["deviceId"].as_i64().ok_or("deviceId is required")? as i32;
            let node = connected(params)?;
            let request = Request::Create {
                project: params["project"].as_i64().ok_or("project is required")?,
                agent: params["agent"].as_str().map(str::to_owned),
                inputs: serde_json::from_value(params["inputs"].clone()).unwrap_or_default(),
                provider: params["provider"].as_i64().map(|id| id as i32),
                model: params["model"].as_str().map(str::to_owned),
            };
            let (created, _) = node
                .terminal
                .request(&request, &[], OVERVIEW_DEADLINE)
                .await
                .map_err(|error| error.message)?;
            let descriptor = terminals::add_created(id, &created["terminal"])
                .ok_or("node returned no terminal")?;
            serde_json::to_value(descriptor).map_err(|error| error.to_string())
        }
        "device.request" => {
            let id = params["deviceId"].as_i64().ok_or("deviceId is required")? as i32;
            let row = device::Entity::find_by_id(id)
                .one(conn)
                .await
                .map_err(|error| error.to_string())?
                .ok_or("device not found")?;
            let node = node(emitter, mount_root, &row).ok_or("device.notNode")?;
            let mut request: Request = serde_json::from_value(params["request"].clone())
                .map_err(|error| format!("invalid request: {error}"))?;
            let key = cache_key(&request);
            let cached = key
                .as_deref()
                .and_then(|key| node.cache.get(key))
                .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
            if params["cached"].as_bool() == Some(true) {
                return Ok(cached.unwrap_or(Value::Null));
            }
            with_cached_version(&mut request, cached.as_ref());
            let body = match params["body"].as_str() {
                Some(body) => BASE64.decode(body).map_err(|error| error.to_string())?,
                None => Vec::new(),
            };
            // 最差 30KB/s：按要上传的字节放宽截止时间。
            let deadline = OVERVIEW_DEADLINE + Duration::from_secs(body.len() as u64 / 10_000);
            let (mut result, bytes) = match node.data.request(&request, &body, deadline).await {
                Ok(reply) => reply,
                Err(error) => return Ok(json!({ "error": error })),
            };
            merge_unchanged(&request, &mut result, cached.as_ref());
            let reply = json!({
                "result": result,
                "body": (!bytes.is_empty()).then(|| BASE64.encode(&bytes)),
            });
            if let Some(key) = key {
                if let Ok(bytes) = serde_json::to_vec(&reply) {
                    let _ = node.cache.put(&key, &bytes);
                }
            }
            if let Request::Write { path, .. } = &request {
                node.cache.remove(&read_key(path));
            }
            Ok(reply)
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
            Ok(json!({ "id": start_transfer(emitter.clone(), id, node, source, dest) }))
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

fn start_transfer(
    emitter: EventEmitter,
    device_id: i32,
    node: Arc<Node>,
    source: String,
    dest: String,
) -> u64 {
    let id = NEXT_TRANSFER.fetch_add(1, Ordering::Relaxed);
    let emit = {
        let (source, dest) = (source.clone(), dest.clone());
        move |state: &str, sent: u64, total: u64, error: Option<&str>| {
            let payload = json!({
                "id": id, "deviceId": device_id, "source": source, "dest": dest,
                "sent": sent, "total": total, "state": state, "error": error,
            });
            emit_event(&emitter, "device://transfer", payload);
        }
    };
    // 持锁登记再放任务跑：任务立刻结束时也能从表里移除。
    let mut transfers = TRANSFERS.lock().expect("transfers lock");
    let task = tokio::spawn({
        let emit = emit.clone();
        async move {
            let client = node.transfer();
            let mut last = (0, 0);
            let result = transfer::upload(
                Path::new(&source),
                &dest,
                |request, body| client.request(&request, &body, transfer::CHUNK_DEADLINE),
                |sent, total| {
                    last = (sent, total);
                    emit("running", sent, total, None);
                },
            )
            .await;
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

/// 远端终端有输入：所有传输连接让路一会儿（它们与终端共用本机上行）。
pub(crate) fn yield_transfers() {
    let until = std::time::Instant::now() + TRANSFER_YIELD;
    for node in NODES.lock().expect("nodes lock").values() {
        if let Some(client) = node.transfer.get() {
            client.yield_until(until);
        }
    }
}

/// 只读请求的缓存键（去掉版本，`Read` 只缓存首屏）；会改动对方或按需拉取的请求不缓存。
fn cache_key(request: &Request) -> Option<String> {
    let request = match request {
        Request::Project { project, .. } => Request::Project {
            project: *project,
            root_version: None,
        },
        Request::List { path, .. } => Request::List {
            path: path.clone(),
            version: None,
        },
        Request::Read {
            path, offset: 0, ..
        } => return Some(read_key(path)),
        Request::Device
        | Request::Dirs { .. }
        | Request::Sessions { .. }
        | Request::Session { .. }
        | Request::Tasks { .. }
        | Request::Task { .. }
        | Request::Note { .. }
        | Request::Stat { .. }
        | Request::Launchbar => request.clone(),
        _ => return None,
    };
    serde_json::to_string(&request).ok()
}

fn read_key(path: &str) -> String {
    format!("read/{path}")
}

/// 缓存里有目录 / 项目根目录的版本时带上，对方未变只回 `unchanged`。
fn with_cached_version(request: &mut Request, cached: Option<&Value>) {
    let version = |listing: &Value| listing["version"].as_str().map(str::to_owned);
    match request {
        Request::List { version: slot, .. } => {
            *slot = cached.and_then(|reply| version(&reply["result"]));
        }
        Request::Project { root_version, .. } => {
            *root_version = cached.and_then(|reply| version(&reply["result"]["root"]));
        }
        _ => {}
    }
}

/// `unchanged` 的目录列表换成缓存里的完整列表。
fn merge_unchanged(request: &Request, result: &mut Value, cached: Option<&Value>) {
    let (fresh, old) = match request {
        Request::List { .. } => (result, cached.map(|reply| &reply["result"])),
        Request::Project { .. } => (
            &mut result["root"],
            cached.map(|reply| &reply["result"]["root"]),
        ),
        _ => return,
    };
    if fresh["unchanged"].as_bool() == Some(true) {
        if let Some(old) = old.filter(|old| old["entries"].is_array()) {
            *fresh = old.clone();
        }
    }
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

/// 一台节点设备的连接（终端、数据两条常驻，传输一条按需）、磁盘缓存与终端状态。
struct Node {
    berth: String,
    name: String,
    target: String,
    data: Client,
    terminal: Client,
    transfer: OnceLock<Client>,
    cache: Cache,
    terminals: Arc<terminals::Terminals>,
}

impl Node {
    /// 传输连接：第一次传文件时建立，之后常驻到设备删除。
    fn transfer(&self) -> &Client {
        self.transfer.get_or_init(|| {
            Client::start(client::ssh(
                self.target.clone(),
                client::node_command(&self.berth),
            ))
            .0
        })
    }
}

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

/// 探测对方 berth 的路径；连不上或没装都是 `None`。
async fn probe(target: &str) -> Option<String> {
    let mut command = tokio::process::Command::new("ssh");
    command.args([
        "-o",
        "BatchMode=yes",
        "-o",
        &format!("ConnectTimeout={CONNECT_TIMEOUT_SECS}"),
        "--",
        target,
        &client::probe_command(),
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
    let command = client::node_command(&berth);
    let channel = |name: &'static str| {
        let (client, pushes) = Client::start(client::ssh(target.to_owned(), command.clone()));
        let mut status = client.status();
        let emitter = emitter.clone();
        tokio::spawn(async move {
            loop {
                let current = status.borrow_and_update().clone();
                emit_event(
                    &emitter,
                    "device://node-status",
                    json!({ "deviceId": id, "channel": name, "status": current }),
                );
                if status.changed().await.is_err() {
                    return;
                }
            }
        });
        (client, pushes)
    };
    // 推送只来自终端通道（接入的终端输出）。
    let (data, _) = channel("data");
    let (terminal, pushes) = channel("terminal");
    let terminals = Arc::new(terminals::Terminals::default());
    tokio::spawn(terminals::route(
        terminals.clone(),
        pushes,
        terminal.status(),
    ));
    let node = Arc::new(Node {
        berth,
        name: row.name.clone(),
        target: target.to_owned(),
        data,
        terminal,
        transfer: OnceLock::new(),
        cache: Cache::new(node_dir(mount_root, id).join("cache"), CACHE_CAP),
        terminals,
    });
    nodes.insert(id, node.clone());
    Some(node)
}

fn node_status(node: &Node) -> Value {
    json!({
        "data": node.data.status().borrow().clone(),
        "terminal": node.terminal.status().borrow().clone(),
    })
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
