use std::env;
use std::ffi::OsStr;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
#[cfg(windows)]
use std::process::Command;

const SHIM_DIR: &str = ".local/bin";

pub(crate) fn install() -> io::Result<PathBuf> {
    let executable = env::current_exe()?;
    let destination = shim_path()?;
    let parent = destination
        .parent()
        .ok_or_else(|| io::Error::other("shim path has no parent directory"))?;
    fs::create_dir_all(parent)?;

    #[cfg(windows)]
    {
        fs::write(&destination, windows_cmd(&executable))?;
        update_windows_path(parent, true)?;
    }
    #[cfg(unix)]
    {
        remove_existing(&destination)?;
        if let Some(appimage) = env::var_os("APPIMAGE").filter(|value| !value.is_empty()) {
            use std::os::unix::fs::PermissionsExt;
            fs::write(&destination, appimage_shim(Path::new(&appimage)))?;
            let mut permissions = fs::metadata(&destination)?.permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(&destination, permissions)?;
        } else {
            std::os::unix::fs::symlink(&executable, &destination)?;
        }
    }
    Ok(destination)
}

pub(crate) fn uninstall() -> io::Result<PathBuf> {
    let destination = shim_path()?;
    remove_existing(&destination)?;
    #[cfg(windows)]
    if let Some(parent) = destination.parent() {
        update_windows_path(parent, false)?;
    }
    Ok(destination)
}

pub(crate) fn diagnose(gui_override: Option<&std::ffi::OsString>) -> io::Result<Vec<String>> {
    let executable = env::current_exe()?;
    let destination = shim_path()?;
    let shim_status = match fs::symlink_metadata(&destination) {
        Ok(_) => "ok",
        Err(error) if error.kind() == io::ErrorKind::NotFound => "missing",
        Err(error) => return Err(error),
    };
    let daemon = sibling_daemon(&executable);
    let shim_dir = destination
        .parent()
        .ok_or_else(|| io::Error::other("shim path has no parent directory"))?;
    Ok(vec![
        format!("cli: {}", executable.display()),
        format!("shim: {shim_status} ({})", destination.display()),
        format!(
            "daemon: {} ({})",
            if daemon.is_file() { "ok" } else { "missing" },
            daemon.display()
        ),
        crate::gui_launch::probe_gui_socket(gui_override),
        format!(
            "path: {} ({})",
            if dir_on_path(shim_dir) {
                "on"
            } else {
                "missing"
            },
            shim_dir.display()
        ),
    ])
}

fn shim_path() -> io::Result<PathBuf> {
    #[cfg(windows)]
    {
        let root = env::var_os("LOCALAPPDATA")
            .filter(|value| !value.is_empty())
            .ok_or_else(|| io::Error::other("LOCALAPPDATA is not set"))?;
        return Ok(PathBuf::from(root).join("berth/bin/berth.cmd"));
    }
    #[cfg(not(windows))]
    {
        let home = env::var_os("HOME")
            .filter(|value| !value.is_empty())
            .ok_or_else(|| io::Error::other("HOME is not set"))?;
        Ok(PathBuf::from(home).join(SHIM_DIR).join("berth"))
    }
}

fn dir_on_path(dir: &Path) -> bool {
    path_contains_dir(&env::var_os("PATH").unwrap_or_default(), dir)
}

fn path_contains_dir(path_value: &OsStr, dir: &Path) -> bool {
    let expected = fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    env::split_paths(path_value).any(|entry| {
        fs::canonicalize(&entry)
            .ok()
            .map(|canonical| canonical == expected)
            .unwrap_or_else(|| entry == dir)
    })
}

fn sibling_daemon(executable: &Path) -> PathBuf {
    let name = if cfg!(windows) {
        "berth-termd.exe"
    } else {
        "berth-termd"
    };
    executable.with_file_name(name)
}

fn remove_existing(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() => Err(io::Error::other(format!(
            "refusing to replace directory {}",
            path.display()
        ))),
        Ok(_) => fs::remove_file(path),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

#[cfg(windows)]
fn windows_cmd(executable: &Path) -> String {
    format!("@echo off\r\n\"{}\" %*\r\n", executable.display())
}

#[cfg(windows)]
fn update_windows_path(bin_dir: &Path, install: bool) -> io::Result<()> {
    let escaped = bin_dir.display().to_string().replace('\'', "''");
    let operation = if install {
        // format! 的格式串必须是字面量：长串用 concat! 拼，宏展开的格式串不能隐式捕获变量
        format!(
            concat!(
                "$p=[Environment]::GetEnvironmentVariable('Path','User');$d='{escaped}';",
                "if(-not (($p -split ';') -contains $d)){{$n=if($p){{$p.TrimEnd(';')+';'+$d}}else{{$d}};[Environment]::SetEnvironmentVariable('Path',$n,'User')}}"
            ),
            escaped = escaped
        )
    } else {
        format!(
            concat!(
                "$p=[Environment]::GetEnvironmentVariable('Path','User');$d='{escaped}';",
                "$n=(($p -split ';')|?{{$_ -and $_ -ne $d}})-join ';';[Environment]::SetEnvironmentVariable('Path',$n,'User')"
            ),
            escaped = escaped
        )
    };
    let status = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &operation])
        .status()?;
    if status.success() {
        Ok(())
    } else {
        Err(io::Error::other("failed to update the user PATH"))
    }
}

#[cfg(unix)]
fn appimage_shim(appimage: &Path) -> String {
    let quoted = shell_quote(&appimage.display().to_string());
    format!(
        "#!/bin/sh\nset -eu\nAPPIMAGE={quoted}\nTMP=${{TMPDIR:-/tmp}}/berth-appimage-mount-$$\nOUT=$TMP.out\nmkdir -p \"$TMP\"\ncleanup() {{ [ -n \"${{PID:-}}\" ] && kill \"$PID\" 2>/dev/null || true; rm -rf \"$TMP\"; }}\ntrap cleanup EXIT INT TERM\n\"$APPIMAGE\" --appimage-mount >\"$OUT\" 2>/dev/null &\nPID=$!\nMOUNT=\nfor _ in 1 2 3 4 5 6 7 8 9 10; do\n  [ -s \"$OUT\" ] && MOUNT=$(head -n 1 \"$OUT\") && break\n  sleep 0.1\ndone\n[ -n \"$MOUNT\" ] || {{ echo 'berth: failed to mount AppImage' >&2; exit 3; }}\nCLI=$(find \"$MOUNT\" -type f -name 'berth-cli' -perm -111 -print -quit)\n[ -n \"$CLI\" ] || {{ echo 'berth: bundled CLI not found in AppImage' >&2; exit 3; }}\n\"$CLI\" \"$@\"\n"
    )
}

#[cfg(unix)]
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    #[test]
    fn appimage_shim_uses_stable_image_path_and_runtime_mount() {
        let script = super::appimage_shim(std::path::Path::new("/opt/Berth App.AppImage"));
        assert!(script.contains("APPIMAGE='/opt/Berth App.AppImage'"));
        assert!(script.contains("--appimage-mount"));
        assert!(script.contains("-name 'berth-cli'"));
    }

    #[cfg(unix)]
    #[test]
    fn shell_quote_handles_apostrophes() {
        assert_eq!(super::shell_quote("a'b"), "'a'\\''b'");
    }

    #[test]
    fn sibling_daemon_matches_platform_name() {
        let cli = std::path::Path::new("/opt/berth-cli");
        let daemon = super::sibling_daemon(cli);
        assert_eq!(
            daemon.file_name().and_then(|name| name.to_str()),
            Some(if cfg!(windows) {
                "berth-termd.exe"
            } else {
                "berth-termd"
            })
        );
    }

    #[test]
    fn path_contains_dir_matches_joined_entries() {
        let dir = std::env::temp_dir();
        let path_value = std::env::join_paths(std::iter::once(dir.as_os_str())).expect("join PATH");
        assert!(super::path_contains_dir(&path_value, &dir));
    }
}
