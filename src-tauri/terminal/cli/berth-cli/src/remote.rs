//! `berth remote exec|hook`：远程项目里 Agent 的 shell 命令在设备上执行。
//!
//! 宿主给远程项目的终端注入 `BERTH_REMOTE_TARGET`（ssh 目标）、`BERTH_REMOTE_PATH`（设备上的
//! 项目目录）、`BERTH_REMOTE_MOUNT`（本机挂载点）。`exec` 把挂载点下的当前目录换算成设备目录，
//! 经 ssh 交给设备上的 `bash -c`（Agent 的命令按 bash 写，不随设备默认 shell 变），PATH 取设备
//! 登录 shell 的；退出码、stdout / stderr 原样返回。不在远程项目里就在本机 `bash -c`。
//!
//! 设备端脚本经 `bash -s` 的 stdin 送达，之后 stdin 保持打开作「存活通道」：本进程或其进程组
//! 被杀、ssh 断开时设备端读到 EOF，结束命令所在的整个进程组（不留孤儿进程）。命令结束时若当前
//! 目录仍在项目内，设备端在 stderr 末尾写一行 `\x1eBERTH_CWD:<相对路径>`，这里滤掉并按
//! `--cwd-file` 写回本机对应目录，供调用方跟随 `cd`。
//!
//! `hook` 读 Agent 的 PreToolUse hook JSON（与 `berth group hook` 同形：`cwd`、`tool_input.command`），
//! 远程项目里的 shell 命令改写为经 `exec` 执行并跟随 `cd`；其余原样放行（不输出）。

use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// 设备端写在 stderr 的标记行前缀：`\x1eBERTH_CWD:<相对路径>`、`\x1eBERTH_PATH:<登录 PATH>`。
const MARK: &[u8] = b"\x1eBERTH_";
/// 设备登录 PATH 的本机缓存时长，与 ssh 连接复用（`ControlPersist`）一致。
const PATH_CACHE_SECS: u64 = 600;

/// 当前终端所在的远程项目（来自宿主注入的环境）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Remote {
    target: String,
    root: String,
    mount: PathBuf,
}

impl Remote {
    fn from_env() -> Option<Self> {
        let var = |name: &str| std::env::var(name).ok().filter(|value| !value.is_empty());
        Some(Self {
            target: var("BERTH_REMOTE_TARGET")?,
            root: var("BERTH_REMOTE_PATH")?,
            mount: PathBuf::from(var("BERTH_REMOTE_MOUNT")?),
        })
    }

    /// 挂载点下的本机目录 → 相对项目根的路径（`""` 即根）；挂载点之外为 `None`。
    fn relative(&self, cwd: &Path) -> Option<String> {
        let rel = cwd.strip_prefix(&self.mount).ok()?;
        Some(rel.to_string_lossy().trim_matches('/').to_owned())
    }
}

/// `berth remote exec`：返回进程退出码。
pub(crate) fn exec(command: &[String], cwd: Option<PathBuf>, cwd_file: Option<PathBuf>) -> i32 {
    let command = command.join(" ");
    let cwd = match cwd.map_or_else(std::env::current_dir, Ok) {
        Ok(cwd) => cwd,
        Err(error) => {
            eprintln!("berth remote exec: {error}");
            return 1;
        }
    };
    let remote = Remote::from_env();
    let Some((remote, rel)) = remote.and_then(|remote| {
        let rel = remote.relative(&cwd)?;
        Some((remote, rel))
    }) else {
        return run_local(&command, &cwd);
    };
    match run_remote(&remote, &rel, &command) {
        Ok((code, final_rel)) => {
            if let Some(file) = cwd_file {
                let local = final_rel.map(|rel| {
                    let rel = rel.trim_start_matches('/');
                    if rel.is_empty() {
                        remote.mount.clone()
                    } else {
                        remote.mount.join(rel)
                    }
                });
                let content = local
                    .map(|path| path.to_string_lossy().into_owned())
                    .unwrap_or_default();
                if let Err(error) = std::fs::write(&file, content) {
                    eprintln!("berth remote exec: write {}: {error}", file.display());
                }
            }
            code
        }
        Err(error) => {
            eprintln!("berth remote exec: {error}");
            255
        }
    }
}

fn run_local(command: &str, cwd: &Path) -> i32 {
    match Command::new("bash")
        .arg("-c")
        .arg(command)
        .current_dir(cwd)
        .status()
    {
        Ok(status) => exit_code(status),
        Err(error) => {
            eprintln!("berth remote exec: bash: {error}");
            127
        }
    }
}

fn run_remote(remote: &Remote, rel: &str, command: &str) -> std::io::Result<(i32, Option<String>)> {
    let dir = runtime_dir()?;
    // ponytail: 登录 PATH 按设备缓存 10 分钟（省掉每条命令一次登录 shell，约 40ms）；
    // 期间设备上新装的程序要等缓存过期才进 PATH。
    let path_cache = dir.join(format!("{}.path", cache_key(&remote.target)));
    let cached_path = std::fs::metadata(&path_cache)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.elapsed().ok())
        .filter(|age| age.as_secs() < PATH_CACHE_SECS)
        .and_then(|_| std::fs::read_to_string(&path_cache).ok())
        .filter(|path| !path.is_empty());
    let mut child = Command::new("ssh")
        .args(ssh_options(&dir))
        .arg("--")
        .arg(&remote.target)
        .arg("bash -s")
        .stdin(Stdio::piped())
        .stdout(Stdio::inherit())
        .stderr(Stdio::piped())
        .spawn()?;
    // stdin 写完脚本后不关：它是设备端判断「调用方还在」的通道，随本进程退出才关闭。
    let mut stdin = child.stdin.take().expect("piped stdin");
    stdin
        .write_all(device_script(&remote.root, rel, command, cached_path.as_deref()).as_bytes())?;
    stdin.write_all(b"\n")?;
    stdin.flush()?;
    let mut stderr = child.stderr.take().expect("piped stderr");
    let mut filter = MarkFilter::default();
    let mut out = std::io::stderr();
    let mut buf = [0u8; 8192];
    loop {
        let n = match stderr.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        };
        let passed = filter.push(&buf[..n]);
        let _ = out.write_all(&passed);
        let _ = out.flush();
    }
    let _ = out.write_all(&filter.finish());
    let status = child.wait()?;
    drop(stdin);
    if let Some(path) = filter.path.filter(|path| !path.is_empty()) {
        let _ = std::fs::write(&path_cache, path);
    }
    Ok((exit_code(status), filter.cwd))
}

fn exit_code(status: std::process::ExitStatus) -> i32 {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(signal) = status.signal() {
            return 128 + signal;
        }
    }
    status.code().unwrap_or(1)
}

/// 本机运行时目录（0700）：ssh 复用连接的控制 socket 与设备 PATH 缓存。
fn runtime_dir() -> std::io::Result<PathBuf> {
    let base = std::env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    #[cfg(unix)]
    let user = rustix::process::getuid().as_raw().to_string();
    #[cfg(not(unix))]
    let user = std::env::var("USERNAME").unwrap_or_default();
    let dir = base.join(format!("berth-ssh-{user}"));
    std::fs::create_dir_all(&dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(dir)
}

/// 目标做文件名：只留字母数字与 `@._-`。
fn cache_key(target: &str) -> String {
    target
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || "@._-".contains(c) {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// ssh 选项：不弹密码；同一目标复用一条连接（每条命令省掉一次握手，约 0.16s → 0.01s）。
fn ssh_options(dir: &Path) -> Vec<OsString> {
    let mut control_path = OsString::from("ControlPath=");
    control_path.push(dir.join("%C"));
    [
        "-o",
        "BatchMode=yes",
        "-o",
        "ControlMaster=auto",
        "-o",
        "ControlPersist=10m",
        "-o",
    ]
    .into_iter()
    .map(OsString::from)
    .chain([control_path])
    .collect()
}

/// POSIX 单引号转义。
fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

/// 设备端脚本（由设备上的 `bash -s` 执行）：整体包在 `{ }` 里，bash 读完整块才执行，
/// 之后 stdin 只剩存活通道。命令跑在独立进程组（`set -m`），stdin 为 /dev/null。
/// 目录标记由 `trap … EXIT` 写出：命令正常结束或中途 `exit` 都报告最终目录
/// （命令自己设了 EXIT trap 时不报告，调用方的目录保持不变）。
/// 前置代码与命令同在第 1 行：bash 报错里的行号与 Agent 写的命令一致。
/// `path`：本机缓存的设备登录 PATH；没有时现场读一次并以标记行报回供缓存。
fn device_script(root: &str, rel: &str, command: &str, path: Option<&str>) -> String {
    let inner = format!(
        "__berth_cwd() {{ __berth_s=$?; __d=$(pwd -P); case \"$__d\" in \"$__BERTH_ROOT\"|\"$__BERTH_ROOT\"/*) \
         printf '\\036BERTH_CWD:%s\\n' \"${{__d#\"$__BERTH_ROOT\"}}\" >&2;; esac; exit $__berth_s; }}; \
         trap __berth_cwd EXIT; {command}"
    );
    let dir = if rel.is_empty() {
        "\"$__BERTH_ROOT\"".to_owned()
    } else {
        format!("\"$__BERTH_ROOT\"{}", quote(&format!("/{rel}")))
    };
    [
        "{".to_owned(),
        format!("cd -- {} || exit 1", quote(root)),
        "export __BERTH_ROOT=$(pwd -P)".to_owned(),
        format!("cd -- {dir} || exit 1"),
        match path {
            Some(path) => format!("export PATH={}", quote(path)),
            None => concat!(
                r#"__berth_p=$("${SHELL:-/bin/sh}" -lc 'printf %s "$PATH"' </dev/null 2>/dev/null) && [ -n "$__berth_p" ] && "#,
                r#"export PATH="$__berth_p" && printf '\036BERTH_PATH:%s\n' "$PATH" >&2"#
            )
            .to_owned(),
        },
        "set -m".to_owned(),
        format!("bash -c {} </dev/null &", quote(&inner)),
        "__berth_pid=$!".to_owned(),
        "{ cat >/dev/null; kill -TERM -- -$__berth_pid 2>/dev/null; } <&0 &".to_owned(),
        "__berth_w=$!".to_owned(),
        "wait $__berth_pid; __berth_s=$?".to_owned(),
        "kill $__berth_w 2>/dev/null".to_owned(),
        "exit $__berth_s".to_owned(),
        "}".to_owned(),
    ]
    .join("\n")
}

/// 从 stderr 流里滤掉标记行（`CWD`、`PATH`）；其余字节原样、尽快放行
/// （只有从 `\x1e` 开始、可能是标记的那一段会暂存到行尾）。
#[derive(Default)]
struct MarkFilter {
    pending: Vec<u8>,
    cwd: Option<String>,
    path: Option<String>,
}

impl MarkFilter {
    fn push(&mut self, chunk: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(chunk.len());
        for &byte in chunk {
            if self.pending.is_empty() {
                if byte == MARK[0] {
                    self.pending.push(byte);
                } else {
                    out.push(byte);
                }
                continue;
            }
            self.pending.push(byte);
            let len = self.pending.len();
            if len <= MARK.len() {
                if self.pending[len - 1] != MARK[len - 1] {
                    out.append(&mut self.pending);
                }
            } else if byte == b'\n' {
                let line = String::from_utf8_lossy(&self.pending[MARK.len()..len - 1]).into_owned();
                if let Some(cwd) = line.strip_prefix("CWD:") {
                    self.cwd = Some(cwd.to_owned());
                } else if let Some(path) = line.strip_prefix("PATH:") {
                    self.path = Some(path.to_owned());
                } else {
                    out.extend_from_slice(&self.pending);
                }
                self.pending.clear();
            }
        }
        out
    }

    /// 流结束：没凑成完整标记行的暂存字节原样放行。
    fn finish(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.pending)
    }
}

/// `berth remote hook`：stdin 是 PreToolUse hook JSON。需要改写时向 stdout 打印
/// `hookSpecificOutput.updatedInput`；其余情况不输出，退出码恒为 0（不挡 Agent）。
pub(crate) fn hook() -> i32 {
    let mut input = String::new();
    if std::io::stdin().read_to_string(&mut input).is_err() {
        return 0;
    }
    let Ok(event) = serde_json::from_str::<serde_json::Value>(&input) else {
        return 0;
    };
    let exe = std::env::current_exe()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "berth".into());
    if let Some(output) = hook_output(&event, Remote::from_env().as_ref(), &exe) {
        println!("{output}");
    }
    0
}

fn hook_output(
    event: &serde_json::Value,
    remote: Option<&Remote>,
    exe: &str,
) -> Option<serde_json::Value> {
    let remote = remote?;
    let tool_input = event.get("tool_input")?.as_object()?;
    let command = tool_input.get("command")?.as_str()?;
    let cwd = event
        .get("cwd")
        .and_then(serde_json::Value::as_str)
        .map(PathBuf::from)
        .or_else(|| std::env::current_dir().ok())?;
    remote.relative(&cwd)?;
    // Berth 自己的命令要和本机 GUI / termd 通信，留在本机。
    let first = command
        .trim_start()
        .split_whitespace()
        .next()
        .unwrap_or_default();
    if first.is_empty() || first == "berth" || first.ends_with("/berth") {
        return None;
    }
    let mut updated = tool_input.clone();
    updated.insert("command".into(), rewrite(command, exe).into());
    Some(serde_json::json!({
        "hookSpecificOutput": { "hookEventName": "PreToolUse", "updatedInput": updated }
    }))
}

/// 改写后的命令：经 `exec` 在设备上执行，再让调用方的 shell 跟随设备上的 `cd`，退出码不变。
fn rewrite(command: &str, exe: &str) -> String {
    format!(
        "__berth_cwd=$(mktemp) && {exe} remote exec --cwd-file \"$__berth_cwd\" -- {cmd}; __berth_s=$?; \
         [ -s \"$__berth_cwd\" ] && cd -- \"$(cat \"$__berth_cwd\")\"; rm -f \"$__berth_cwd\"; (exit $__berth_s)",
        exe = quote(exe),
        cmd = quote(command),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn remote() -> Remote {
        Remote {
            target: "m@h".into(),
            root: "proj".into(),
            mount: PathBuf::from("/mnt/1/proj"),
        }
    }

    #[test]
    fn relative_maps_only_inside_the_mount() {
        let r = remote();
        assert_eq!(r.relative(Path::new("/mnt/1/proj")), Some(String::new()));
        assert_eq!(
            r.relative(Path::new("/mnt/1/proj/src/a")),
            Some("src/a".into())
        );
        assert_eq!(r.relative(Path::new("/mnt/1/projx")), None);
        assert_eq!(r.relative(Path::new("/home")), None);
    }

    #[test]
    fn quote_survives_single_quotes() {
        assert_eq!(quote("it's"), r"'it'\''s'");
    }

    #[test]
    fn device_script_runs_bash_in_own_group_with_liveness_watch() {
        let script = device_script("proj", "src", "echo 'x'", None);
        assert!(script.starts_with("{\n") && script.ends_with("\n}"));
        assert!(script.contains("cd -- 'proj' || exit 1"));
        assert!(script.contains("cd -- \"$__BERTH_ROOT\"'/src' || exit 1"));
        assert!(script.contains("set -m"));
        assert!(script.contains("trap __berth_cwd EXIT; echo '\\''x'\\'''"));
        assert!(script.contains("kill -TERM -- -$__berth_pid"));
        assert!(script.contains("BERTH_PATH:"));
        let cached = device_script("proj", "", "true", Some("/usr/local/bin:/bin"));
        assert!(cached.contains("cd -- \"$__BERTH_ROOT\" || exit 1"));
        assert!(cached.contains("export PATH='/usr/local/bin:/bin'") && !cached.contains("-lc"));
    }

    #[test]
    fn mark_filter_strips_marker_across_chunks() {
        let mut f = MarkFilter::default();
        let mut out = f.push(b"err1\n\x1eBERTH_");
        out.extend(f.push(b"CWD:/src/a\nerr2"));
        out.extend(f.finish());
        assert_eq!(out, b"err1\nerr2");
        assert_eq!(f.cwd.as_deref(), Some("/src/a"));
    }

    #[test]
    fn mark_filter_collects_path_and_passes_unknown_keys() {
        let mut f = MarkFilter::default();
        let mut out = f.push(b"\x1eBERTH_PATH:/a:/b\nx\x1eBERTH_OTHER:1\n");
        out.extend(f.finish());
        assert_eq!(out, b"x\x1eBERTH_OTHER:1\n");
        assert_eq!(f.path.as_deref(), Some("/a:/b"));
        assert_eq!(cache_key("m@100.0.0.3"), "m@100.0.0.3");
        assert_eq!(cache_key("a/b c"), "a_b_c");
    }

    #[test]
    fn mark_filter_passes_lookalikes_through() {
        let mut f = MarkFilter::default();
        let mut out = f.push(b"a\x1eBX\n\x1eBERTH");
        out.extend(f.finish());
        assert_eq!(out, b"a\x1eBX\n\x1eBERTH");
        assert_eq!(f.cwd, None);
    }

    #[test]
    fn hook_rewrites_shell_commands_inside_the_mount_only() {
        let r = remote();
        let event = serde_json::json!({
            "cwd": "/mnt/1/proj/src",
            "tool_name": "Bash",
            "tool_input": { "command": "pytest -q", "timeout": 5 }
        });
        let out = hook_output(&event, Some(&r), "/bin/berth").unwrap();
        let updated = &out["hookSpecificOutput"]["updatedInput"];
        assert_eq!(updated["timeout"], 5);
        let command = updated["command"].as_str().unwrap();
        assert!(command.contains("'/bin/berth' remote exec --cwd-file"));
        assert!(command.contains("-- 'pytest -q';"));
        assert!(command.ends_with("(exit $__berth_s)"));

        let outside = serde_json::json!({ "cwd": "/home/x", "tool_input": { "command": "ls" } });
        assert!(hook_output(&outside, Some(&r), "berth").is_none());
        let own = serde_json::json!({ "cwd": "/mnt/1/proj", "tool_input": { "command": "berth task list" } });
        assert!(hook_output(&own, Some(&r), "berth").is_none());
        let not_shell =
            serde_json::json!({ "cwd": "/mnt/1/proj", "tool_input": { "file_path": "a" } });
        assert!(hook_output(&not_shell, Some(&r), "berth").is_none());
        assert!(hook_output(&event, None, "berth").is_none());
    }
}
