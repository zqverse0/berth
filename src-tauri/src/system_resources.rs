//! 本机资源占用（runtime bridge `system.*`，状态栏「资源」段）。
//!
//! - `system.resources` → `{ machine, berth }`
//!   - `machine`：整机 CPU%、内存 / 交换区已用与总量、各磁盘已用与总量（字节）
//!   - `berth`：Berth 自己的进程，分四组 `ui`（本进程及其子进程：WebView、ssh、watch 等）、
//!     `termd`（终端守护进程）、`agents`（终端里跑的 Agent CLI 等，即 termd 的子孙）、
//!     `background`（不在上面两棵树里、命令行带本实例 termd socket 的常驻进程，如 GUI 重启后留下的
//!     `group watch`，连同子孙）；每组带合计与按内存降序的进程列表
//!
//! CPU% 都按整机口径（单进程 CPU% 已除以核数），各组之和可直接与整机比较。
//! CPU% 是两次采样之间的平均值，所以 `System` 常驻、每次调用增量刷新；首次调用补采一次。

use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, Mutex};

use serde::Serialize;
use serde_json::Value;
use sysinfo::{Disks, Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

static SYSTEM: LazyLock<Mutex<Option<System>>> = LazyLock::new(|| Mutex::new(None));

pub fn dispatch(method: &str, _params: &Value) -> Result<Value, String> {
    match method {
        "system.resources" => serde_json::to_value(snapshot()?).map_err(|error| error.to_string()),
        _ => Err(format!("unknown runtime bridge method: {method}")),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    machine: Machine,
    berth: Vec<Group>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Machine {
    cpu_percent: f32,
    cpu_count: usize,
    memory_used: u64,
    memory_total: u64,
    swap_used: u64,
    swap_total: u64,
    disks: Vec<Disk>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Disk {
    mount: String,
    used: u64,
    total: u64,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Group {
    kind: &'static str,
    cpu_percent: f32,
    memory: u64,
    processes: Vec<Proc>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Proc {
    pid: u32,
    #[serde(skip)]
    parent: Option<u32>,
    /// 命令行带本实例 termd 的 socket（termd 本身与 `berth-cli -S <socket> …`）
    #[serde(skip)]
    uses_endpoint: bool,
    #[serde(skip)]
    is_termd: bool,
    name: String,
    cpu_percent: f32,
    memory: u64,
}

fn snapshot() -> Result<Snapshot, String> {
    let mut guard = SYSTEM.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let first = guard.is_none();
    if first {
        *guard = Some(System::new().map_err(|error| error.to_string())?);
    }
    let system = guard.as_mut().expect("System 刚初始化");
    refresh(system);
    if first {
        // CPU% 要两次采样之差，第一次调用补一次，免得首屏全是 0
        std::thread::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL);
        refresh(system);
    }

    let cpu_count = system.cpus().len().max(1);
    let endpoint = berth_term_sdk::berth::default_endpoint_path()
        .map(|path| path.to_string_lossy().into_owned())
        .ok();
    let procs: Vec<Proc> = system
        .processes()
        .values()
        .map(|process| Proc {
            pid: process.pid().as_u32(),
            parent: process.parent().map(Pid::as_u32),
            uses_endpoint: endpoint.as_deref().is_some_and(|endpoint| {
                process.cmd().iter().any(|arg| arg.to_string_lossy() == endpoint)
            }),
            is_termd: process.cmd().iter().any(|arg| arg == "--__internal-daemon"),
            name: process.name().to_string_lossy().into_owned(),
            cpu_percent: process.cpu_usage() / cpu_count as f32,
            memory: process.memory(),
        })
        .collect();

    Ok(Snapshot {
        machine: Machine {
            cpu_percent: system.global_cpu_usage(),
            cpu_count,
            memory_used: system.used_memory(),
            memory_total: system.total_memory(),
            swap_used: system.used_swap(),
            swap_total: system.total_swap(),
            disks: disks()?,
        },
        berth: group(&procs, std::process::id()),
    })
}

fn refresh(system: &mut System) {
    system.refresh_cpu_usage();
    system.refresh_memory();
    // 命令行只用来认 termd 与后台进程，取一次就够。
    // `nothing()` 默认带 tasks：Linux 上会把每个线程当进程列出来、各报一份整进程的内存，必须关掉
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing()
            .without_tasks()
            .with_cpu()
            .with_memory()
            .with_cmd(UpdateKind::OnlyIfNotSet),
    );
}

/// 按进程树把 Berth 的进程分组；本进程与 termd 自身各归一组，termd 的子孙归 `agents`，
/// 其余带本实例 socket 的进程及其子孙归 `background`。
/// termd 认法：命令行带内部守护参数和本实例 endpoint（dev 与正式版各有一个）。
fn group(procs: &[Proc], self_pid: u32) -> Vec<Group> {
    let termd = procs
        .iter()
        .find(|proc| proc.is_termd && proc.uses_endpoint)
        .map(|proc| proc.pid);
    let mut children: HashMap<u32, Vec<&Proc>> = HashMap::new();
    for proc in procs {
        if let Some(parent) = proc.parent {
            children.entry(parent).or_default().push(proc);
        }
    }
    let by_pid: HashMap<u32, &Proc> = procs.iter().map(|proc| (proc.pid, proc)).collect();

    let mut ui = subtree(&children, self_pid);
    ui.extend(by_pid.get(&self_pid).copied().cloned());
    let mut groups = vec![("ui", ui)];
    if let Some(termd) = termd {
        groups.push(("termd", by_pid.get(&termd).copied().cloned().into_iter().collect()));
        groups.push(("agents", subtree(&children, termd)));
    }
    let mut seen: HashSet<u32> = groups
        .iter()
        .flat_map(|(_, processes)| processes.iter().map(|proc| proc.pid))
        .collect();
    let mut background = Vec::new();
    for root in procs.iter().filter(|proc| proc.uses_endpoint) {
        if !seen.insert(root.pid) {
            continue;
        }
        background.push(root.clone());
        for child in subtree(&children, root.pid) {
            if seen.insert(child.pid) {
                background.push(child);
            }
        }
    }
    groups.push(("background", background));
    groups
        .into_iter()
        .map(|(kind, mut processes)| {
            processes.sort_by(|a, b| b.memory.cmp(&a.memory));
            Group {
                kind,
                cpu_percent: processes.iter().map(|proc| proc.cpu_percent).sum(),
                memory: processes.iter().map(|proc| proc.memory).sum(),
                processes,
            }
        })
        .collect()
}

/// `root` 的所有子孙（不含 `root`）；`seen` 防进程表里出现环。
fn subtree(children: &HashMap<u32, Vec<&Proc>>, root: u32) -> Vec<Proc> {
    let mut out = Vec::new();
    let mut seen = HashSet::from([root]);
    let mut stack = vec![root];
    while let Some(pid) = stack.pop() {
        for child in children.get(&pid).into_iter().flatten() {
            if seen.insert(child.pid) {
                out.push((*child).clone());
                stack.push(child.pid);
            }
        }
    }
    out
}

/// 只读挂载（snap 的 squashfs 等）总是满的，不算；同一设备挂多处（btrfs 子卷）只留最短的挂载点。
fn disks() -> Result<Vec<Disk>, String> {
    let disks = Disks::new_with_refreshed_list().map_err(|error| error.to_string())?;
    Ok(dedupe_disks(
        disks
            .iter()
            .filter(|disk| !disk.is_read_only() && disk.total_space() > 0)
            .map(|disk| {
                (
                    disk.name().to_string_lossy().into_owned(),
                    Disk {
                        mount: disk.mount_point().to_string_lossy().into_owned(),
                        used: disk.total_space().saturating_sub(disk.available_space()),
                        total: disk.total_space(),
                    },
                )
            }),
    ))
}

fn dedupe_disks(disks: impl Iterator<Item = (String, Disk)>) -> Vec<Disk> {
    let mut by_device: Vec<(String, Disk)> = Vec::new();
    for (device, disk) in disks {
        match by_device.iter_mut().find(|(name, _)| *name == device) {
            Some((_, kept)) if disk.mount.len() < kept.mount.len() => *kept = disk,
            Some(_) => {}
            None => by_device.push((device, disk)),
        }
    }
    by_device.into_iter().map(|(_, disk)| disk).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proc(pid: u32, parent: Option<u32>, memory: u64) -> Proc {
        Proc {
            pid,
            parent,
            uses_endpoint: false,
            is_termd: false,
            name: format!("p{pid}"),
            cpu_percent: 1.0,
            memory,
        }
    }

    #[test]
    fn groups_gui_termd_and_agents_by_process_tree() {
        // 1 → 10(gui) → 11(webview) → 12；1 → 20(termd) → 21(agent) → 22；
        // 1 → 40(遗留的 watch，带 socket) → 41；1 → 50(别的实例的 termd，不带本实例 socket)；30 无关
        let termd = Proc {
            uses_endpoint: true,
            is_termd: true,
            ..proc(20, Some(1), 50)
        };
        let watch = Proc {
            uses_endpoint: true,
            ..proc(40, Some(1), 60)
        };
        let other_termd = Proc {
            is_termd: true,
            ..proc(50, Some(1), 70)
        };
        let procs = vec![
            proc(1, None, 0),
            proc(10, Some(1), 100),
            proc(11, Some(10), 300),
            proc(12, Some(11), 5),
            termd,
            proc(21, Some(20), 200),
            proc(22, Some(21), 10),
            proc(30, Some(1), 999),
            watch,
            proc(41, Some(40), 1),
            other_termd,
        ];
        let groups = group(&procs, 10);
        let pids = |kind: &str| -> Vec<u32> {
            let group = groups.iter().find(|group| group.kind == kind).unwrap();
            group.processes.iter().map(|proc| proc.pid).collect()
        };
        assert_eq!(pids("ui"), vec![11, 10, 12]);
        assert_eq!(pids("termd"), vec![20]);
        assert_eq!(pids("agents"), vec![21, 22]);
        assert_eq!(pids("background"), vec![40, 41]);
        let ui = &groups[0];
        assert_eq!(ui.memory, 405);
        assert_eq!(ui.cpu_percent, 3.0);
    }

    #[test]
    fn without_termd_no_termd_groups() {
        let groups = group(&[proc(10, None, 1)], 10);
        let kinds: Vec<_> = groups.iter().map(|group| group.kind).collect();
        assert_eq!(kinds, vec!["ui", "background"]);
    }

    #[test]
    fn same_device_keeps_shortest_mount() {
        let disk = |mount: &str| Disk {
            mount: mount.into(),
            used: 1,
            total: 2,
        };
        let kept = dedupe_disks(
            [
                ("/dev/a".to_string(), disk("/home")),
                ("/dev/a".to_string(), disk("/")),
                ("/dev/b".to_string(), disk("/data")),
            ]
            .into_iter(),
        );
        assert_eq!(kept, vec![disk("/"), disk("/data")]);
    }
}
