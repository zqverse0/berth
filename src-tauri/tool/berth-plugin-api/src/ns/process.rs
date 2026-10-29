//! process@1（脚本 · 权限 `process`）：运行程序、与常驻子进程逐行对话（`open`）、`which`、进程存活、读 stdin。

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::io::{BufRead, Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::rpc::{
    env_param, opt_str_param, str_list_param, str_param, ApiError, ApiResult, Host, Reason,
};

pub fn call(host: &Host, name: &str, params: &Value) -> Option<ApiResult> {
    Some(match name {
        "run" => run(params),
        "exec" => exec(params),
        "open" => open(&host.sessions, params),
        "write" => session(&host.sessions, params, |session| {
            let text = str_param(params, "text")?;
            let stdin = session
                .stdin
                .as_mut()
                .ok_or_else(|| ApiError::invalid("stdin is closed"))?;
            stdin
                .write_all(text.as_bytes())
                .and_then(|_| stdin.flush())
                .map(|_| Value::Null)
                .map_err(|error| ApiError::io("write", error))
        }),
        "readLine" => session(&host.sessions, params, |session| {
            let timeout = Duration::from_millis(params["timeoutMs"].as_u64().unwrap_or(30_000));
            match session.lines.recv_timeout(timeout) {
                Ok(line) => Ok(json!(line)),
                Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => Ok(Value::Null),
            }
        }),
        "close" => {
            let handle = params["handle"].as_u64().unwrap_or_default();
            host.sessions.0.borrow_mut().remove(&handle);
            Ok(Value::Null)
        }
        "which" => str_param(params, "cmd").map(|cmd| {
            which::which(cmd)
                .ok()
                .map_or(Value::Null, |path| json!(path.to_string_lossy()))
        }),
        "alive" => alive(params),
        "stdin" => {
            let mut text = String::new();
            std::io::stdin()
                .read_to_string(&mut text)
                .map(|_| json!(text))
                .map_err(|error| ApiError::io("stdin", error))
        }
        _ => return None,
    })
}

fn command(params: &Value) -> Result<Command, ApiError> {
    let cmd = str_param(params, "cmd")?;
    let mut command = Command::new(crate::ns::fs::expand(cmd));
    command.args(str_list_param(params, "args")?);
    command.envs(env_param(params, "env")?);
    if let Some(cwd) = opt_str_param(params, "cwd")? {
        command.current_dir(crate::ns::fs::expand(cwd));
    }
    Ok(command)
}

fn spawn_error(params: &Value, error: std::io::Error) -> ApiError {
    let cmd = params["cmd"].as_str().unwrap_or_default();
    if error.kind() == std::io::ErrorKind::NotFound {
        return ApiError::new(Reason::NotFound, format!("{cmd}: not found on PATH"));
    }
    ApiError::io(cmd, error)
}

/// 交互运行：继承终端，等结束。等待期间宿主忽略 SIGINT / SIGQUIT（同 `system(3)`），
/// 让 Ctrl-C 只落在子进程上；子进程里恢复默认处理。
fn run(params: &Value) -> ApiResult {
    let mut command = command(params)?;
    #[cfg(unix)]
    unsafe {
        use std::os::unix::process::CommandExt;
        command.pre_exec(|| {
            libc::signal(libc::SIGINT, libc::SIG_DFL);
            libc::signal(libc::SIGQUIT, libc::SIG_DFL);
            Ok(())
        });
    }
    let _guard = IgnoreInterrupts::new();
    let status = command
        .status()
        .map_err(|error| spawn_error(params, error))?;
    Ok(json!(exit_code(status)))
}

/// `process.open` 的会话：stdin 保持打开（常驻服务读到 EOF 会直接退出），stdout 逐行进通道。
pub(crate) struct Session {
    child: Child,
    stdin: Option<ChildStdin>,
    lines: Receiver<String>,
}

impl Drop for Session {
    fn drop(&mut self) {
        self.stdin.take();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Default)]
pub(crate) struct Sessions(RefCell<BTreeMap<u64, Session>>);

fn open(sessions: &Sessions, params: &Value) -> ApiResult {
    let mut command = command(params)?;
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = command
        .spawn()
        .map_err(|error| spawn_error(params, error))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| ApiError::invalid("no stdout"))?;
    let (sender, lines) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        for line in std::io::BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if sender.send(line).is_err() {
                break;
            }
        }
    });
    let stdin = child.stdin.take();
    let mut map = sessions.0.borrow_mut();
    let handle = map.keys().next_back().map_or(1, |last| last + 1);
    map.insert(
        handle,
        Session {
            child,
            stdin,
            lines,
        },
    );
    Ok(json!(handle))
}

fn session(
    sessions: &Sessions,
    params: &Value,
    f: impl FnOnce(&mut Session) -> ApiResult,
) -> ApiResult {
    let handle = params["handle"]
        .as_u64()
        .ok_or_else(|| ApiError::invalid("handle must be a number"))?;
    let mut map = sessions.0.borrow_mut();
    let session = map.get_mut(&handle).ok_or_else(|| {
        ApiError::new(
            Reason::NotFound,
            format!("process session {handle} is closed"),
        )
    })?;
    f(session)
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

/// 捕获输出运行；超时结束进程，`code` 为 null。
fn exec(params: &Value) -> ApiResult {
    let mut command = command(params)?;
    let stdin = opt_str_param(params, "stdin")?.map(str::to_owned);
    let timeout = match &params["timeoutMs"] {
        Value::Null => None,
        value => Some(Duration::from_millis(value.as_u64().ok_or_else(|| {
            ApiError::invalid("timeoutMs must be a positive integer")
        })?)),
    };
    command
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| spawn_error(params, error))?;
    if let (Some(text), Some(mut pipe)) = (stdin, child.stdin.take()) {
        std::thread::spawn(move || {
            let _ = pipe.write_all(text.as_bytes());
        });
    }
    // 两路输出各一个线程读，避免管道写满互相卡住。
    let reader = |pipe: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            if let Some(mut pipe) = pipe {
                let _ = pipe.read_to_end(&mut bytes);
            }
            String::from_utf8_lossy(&bytes).into_owned()
        })
    };
    let stdout = reader(
        child
            .stdout
            .take()
            .map(|pipe| Box::new(pipe) as Box<dyn Read + Send>),
    );
    let stderr = reader(
        child
            .stderr
            .take()
            .map(|pipe| Box::new(pipe) as Box<dyn Read + Send>),
    );
    let started = Instant::now();
    let code = loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| ApiError::io("wait", error))?
        {
            break Some(exit_code(status));
        }
        if timeout.is_some_and(|limit| started.elapsed() >= limit) {
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    Ok(json!({
        "code": code,
        "stdout": stdout.join().unwrap_or_default(),
        "stderr": stderr.join().unwrap_or_default(),
    }))
}

fn alive(params: &Value) -> ApiResult {
    let pid = params["pid"]
        .as_i64()
        .filter(|pid| *pid > 0 && *pid <= i64::from(i32::MAX))
        .ok_or_else(|| ApiError::invalid("pid must be a positive integer"))?;
    #[cfg(unix)]
    {
        // 信号 0 只做存在性检查；EPERM 说明进程在、只是不属于我们。
        let ok = unsafe { libc::kill(pid as libc::pid_t, 0) } == 0;
        let exists = ok || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM);
        Ok(json!(exists))
    }
    #[cfg(not(unix))]
    {
        // ponytail: Windows 暂不支持；有插件需要时用 OpenProcess 实现。
        let _ = pid;
        Err(ApiError::new(
            Reason::Unsupported,
            "process.alive is not available on this platform",
        ))
    }
}

struct IgnoreInterrupts {
    #[cfg(unix)]
    previous: [libc::sighandler_t; 2],
}

impl IgnoreInterrupts {
    fn new() -> Self {
        #[cfg(unix)]
        unsafe {
            Self {
                previous: [
                    libc::signal(libc::SIGINT, libc::SIG_IGN),
                    libc::signal(libc::SIGQUIT, libc::SIG_IGN),
                ],
            }
        }
        #[cfg(not(unix))]
        Self {}
    }
}

impl Drop for IgnoreInterrupts {
    fn drop(&mut self) {
        #[cfg(unix)]
        unsafe {
            libc::signal(libc::SIGINT, self.previous[0]);
            libc::signal(libc::SIGQUIT, self.previous[1]);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(name: &str, params: &Value) -> Option<ApiResult> {
        let host = Host {
            plugin_id: "t".into(),
            package: std::env::temp_dir(),
            permissions: Default::default(),
            state_dir: std::env::temp_dir(),
            project: Box::new(|| Value::Null),
            sessions: Default::default(),
        };
        super::call(&host, name, params)
    }

    #[test]
    fn open_session_talks_line_by_line_and_closes() {
        let host = Host {
            plugin_id: "t".into(),
            package: std::env::temp_dir(),
            permissions: Default::default(),
            state_dir: std::env::temp_dir(),
            project: Box::new(|| Value::Null),
            sessions: Default::default(),
        };
        // 读一行回一行、stdin 不关就一直活着（同 codex app-server）。
        let handle = super::call(
            &host,
            "open",
            &json!({"cmd": "sh", "args": ["-c", "while read l; do echo \"got $l\"; done"]}),
        )
        .unwrap()
        .unwrap();
        super::call(&host, "write", &json!({"handle": handle, "text": "a\n"}))
            .unwrap()
            .unwrap();
        let line = super::call(
            &host,
            "readLine",
            &json!({"handle": handle, "timeoutMs": 2000}),
        )
        .unwrap()
        .unwrap();
        assert_eq!(line, json!("got a"));
        let quiet = super::call(
            &host,
            "readLine",
            &json!({"handle": handle, "timeoutMs": 50}),
        )
        .unwrap()
        .unwrap();
        assert_eq!(quiet, Value::Null, "超时返回 null");
        super::call(&host, "close", &json!({"handle": handle}))
            .unwrap()
            .unwrap();
        let closed = super::call(&host, "write", &json!({"handle": handle, "text": "b\n"}))
            .unwrap()
            .unwrap_err();
        assert_eq!(closed.reason, Reason::NotFound);
    }

    #[test]
    fn exec_captures_output_and_exit_code() {
        let out = call(
            "exec",
            &json!({"cmd": "sh", "args": ["-c", "cat; echo err >&2; exit 3"], "stdin": "hi"}),
        )
        .unwrap()
        .unwrap();
        assert_eq!(out, json!({"code": 3, "stdout": "hi", "stderr": "err\n"}));
    }

    #[test]
    fn exec_timeout_kills_and_reports_null() {
        let out = call(
            "exec",
            &json!({"cmd": "sleep", "args": ["5"], "timeoutMs": 50}),
        )
        .unwrap()
        .unwrap();
        assert_eq!(out["code"], Value::Null);
    }

    #[test]
    fn missing_program_is_not_found() {
        let error = call("run", &json!({"cmd": "berth-no-such-program", "args": []}))
            .unwrap()
            .unwrap_err();
        assert_eq!(error.reason, Reason::NotFound);
    }

    #[test]
    fn own_pid_is_alive() {
        assert_eq!(
            call("alive", &json!({"pid": std::process::id()}))
                .unwrap()
                .unwrap(),
            json!(true)
        );
    }
}
