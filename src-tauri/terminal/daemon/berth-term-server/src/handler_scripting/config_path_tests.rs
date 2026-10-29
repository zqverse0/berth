use super::source_files::{default_config_paths, default_tmux_fallback_paths};
use crate::test_env::EnvVarGuard;

#[cfg(windows)]
use super::source_files::{source_inputs_for_path, SourceReadPolicy};

#[cfg(unix)]
#[test]
fn default_config_paths_use_berth_locations() {
    let _lock = crate::test_env::lock_blocking();
    let _home = EnvVarGuard::set("HOME", Some("/tmp/berth-home"));
    let _xdg = EnvVarGuard::set("XDG_CONFIG_HOME", Some("/tmp/berth-xdg"));

    let paths = default_config_paths();

    assert_eq!(
        paths,
        vec![
            "/etc/berth.conf".to_owned(),
            "/tmp/berth-home/.berth.conf".to_owned(),
            "/tmp/berth-xdg/berth/berth.conf".to_owned(),
            "/tmp/berth-home/.config/berth/berth.conf".to_owned(),
        ]
    );
    assert!(
        paths.iter().all(|path| !path.contains("tmux")),
        "default config search path must not include tmux locations: {paths:?}"
    );
}

#[cfg(unix)]
#[test]
fn tmux_fallback_paths_use_tmux_locations() {
    let _lock = crate::test_env::lock_blocking();
    let _disable = EnvVarGuard::set("BERTH_DISABLE_TMUX_FALLBACK", None);
    let _home = EnvVarGuard::set("HOME", Some("/tmp/berth-home"));
    let _xdg = EnvVarGuard::set("XDG_CONFIG_HOME", Some("/tmp/berth-xdg"));

    let paths = default_tmux_fallback_paths();

    assert_eq!(
        paths,
        vec![
            "/etc/tmux.conf".to_owned(),
            "/tmp/berth-home/.tmux.conf".to_owned(),
            "/tmp/berth-xdg/tmux/tmux.conf".to_owned(),
            "/tmp/berth-home/.config/tmux/tmux.conf".to_owned(),
        ]
    );
    assert!(
        paths.iter().all(|path| !path.ends_with("berth.conf")),
        "tmux fallback paths must not include berth config files: {paths:?}"
    );
}

#[test]
fn tmux_fallback_paths_can_be_disabled_by_env() {
    let _lock = crate::test_env::lock_blocking();
    let _disable = EnvVarGuard::set("BERTH_DISABLE_TMUX_FALLBACK", Some("1"));

    assert!(default_tmux_fallback_paths().is_empty());
}

#[cfg(windows)]
#[test]
fn default_config_paths_use_documented_windows_locations() {
    let _lock = crate::test_env::lock_blocking();
    let _berth_config = EnvVarGuard::set("BERTH_CONFIG_FILE", Some(r"C:\berth\custom.conf"));
    let _appdata = EnvVarGuard::set("APPDATA", Some(r"C:\Users\tester\AppData\Roaming"));
    let _userprofile = EnvVarGuard::set("USERPROFILE", Some(r"C:\Users\tester"));
    let _xdg = EnvVarGuard::set("XDG_CONFIG_HOME", Some(r"C:\Users\tester\.config"));

    let paths = default_config_paths();

    assert_eq!(
        paths,
        vec![
            path_string(r"C:\Users\tester\.config\berth\berth.conf"),
            path_string(r"C:\Users\tester\.berth.conf"),
            path_string(r"C:\Users\tester\AppData\Roaming\berth\berth.conf"),
            path_string(r"C:\berth\custom.conf"),
        ]
    );
    assert_eq!(
        paths
            .iter()
            .filter(|path| path.contains("berth.conf"))
            .count(),
        3,
        "Windows search path must not add undocumented berth.conf locations: {paths:?}"
    );
    assert!(
        paths.iter().all(|path| !path.contains("tmux")),
        "Windows default config search path must not include tmux locations: {paths:?}"
    );
}

#[cfg(windows)]
#[test]
fn tmux_fallback_paths_use_documented_windows_tmux_locations() {
    let _lock = crate::test_env::lock_blocking();
    let _disable = EnvVarGuard::set("BERTH_DISABLE_TMUX_FALLBACK", None);
    let _appdata = EnvVarGuard::set("APPDATA", Some(r"C:\Users\tester\AppData\Roaming"));
    let _userprofile = EnvVarGuard::set("USERPROFILE", Some(r"C:\Users\tester"));
    let _xdg = EnvVarGuard::set("XDG_CONFIG_HOME", Some(r"C:\Users\tester\.config"));

    let paths = default_tmux_fallback_paths();

    assert_eq!(
        paths,
        vec![
            path_string(r"C:\Users\tester\.config\tmux\tmux.conf"),
            path_string(r"C:\Users\tester\.tmux.conf"),
            path_string(r"C:\Users\tester\AppData\Roaming\tmux\tmux.conf"),
        ]
    );
    assert!(
        paths.iter().all(|path| !path.ends_with("berth.conf")),
        "tmux fallback paths must not include berth config files: {paths:?}"
    );
}

#[cfg(windows)]
#[test]
fn windows_nul_config_path_is_empty() {
    let inputs = source_inputs_for_path("NUL", None, false, None, SourceReadPolicy::Strict)
        .expect("NUL should behave like an empty config file");
    assert_eq!(inputs.len(), 1);
    assert!(inputs[0].contents.is_empty());

    let inputs = source_inputs_for_path("nul", None, false, None, SourceReadPolicy::Strict)
        .expect("nul should be case-insensitive");
    assert_eq!(inputs.len(), 1);
    assert!(inputs[0].contents.is_empty());
}

#[cfg(windows)]
fn path_string(path: &str) -> String {
    std::path::PathBuf::from(path)
        .to_string_lossy()
        .into_owned()
}
