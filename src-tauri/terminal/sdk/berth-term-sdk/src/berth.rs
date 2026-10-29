//! Berth's supported terminal-client surface.
//!
//! Application code imports terminal primitives through this module instead
//! of depending on the full general-purpose SDK surface. The implementation
//! remains the original, tested SDK implementation; this module only fixes the
//! capability boundary Berth currently relies on.

pub use crate::binding::{verify, BindingFacts, BindingVerdict, RuntimeBinding};
pub use crate::create::{CreateTerminal, CreatedTerminal};
pub use crate::ensure::{EnsureSession, EnsureSessionPolicy};
pub use crate::error::TerminalError;
pub use crate::events::{PaneOutputChunk, PaneOutputStart, PaneOutputStream};
pub use crate::handles::{
    NewWindowBuilder, Pane, PaneCapture, PaneCaptureBuilder, PaneCloseOutcome, Session, Terminal,
    TerminalClientBuilder, Window, WindowCloseOutcome, WindowPane,
};
pub use crate::info::{PaneAgentSignal, PaneProcessState};
pub use crate::launch_environment::{
    prepend_dir_to_path, resolve_shell, TerminalLaunchEnvironment,
};
pub use crate::snapshot::{PaneCursor, PaneSnapshot};
pub use crate::spec::ProcessSpec;
pub use crate::types::{PaneId, SessionName, TerminalSizeSpec, WindowRef};
pub use berth_term_proto::{PaneBindingFailure, TerminalError as ProtocolError};

/// Returns the default per-user `berth-termd` endpoint path.
pub fn default_endpoint_path() -> std::io::Result<std::path::PathBuf> {
    berth_term_ipc::default_endpoint().map(berth_term_ipc::LocalEndpoint::into_path)
}

#[cfg(test)]
mod boundary_tests {
    use std::fs;
    use std::path::Path;

    #[test]
    fn active_sources_do_not_import_available() {
        let src_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut violations = Vec::new();
        walk_rust_files(&src_root, &src_root, &mut violations);
        assert!(
            violations.is_empty(),
            "active sources must not import available 模块:\n{}",
            violations.join("\n")
        );
    }

    #[test]
    fn berth_gui_keeps_default_features_disabled() {
        let cargo_toml = fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("..")
                .join("..")
                .join("Cargo.toml"),
        )
        .expect("read src-tauri/Cargo.toml");
        assert!(
            cargo_toml.contains(
                "berth-term-sdk = { path = \"terminal/sdk/berth-term-sdk\", version = \"0.29.9\", default-features = false }"
            ),
            "berth-gui must depend on berth-term-sdk with default-features = false"
        );
    }

    fn walk_rust_files(src_root: &Path, dir: &Path, violations: &mut Vec<String>) {
        for entry in fs::read_dir(dir).expect("read src dir") {
            let entry = entry.expect("dir entry");
            let path = entry.path();
            if path.is_dir() {
                if path.file_name().is_some_and(|name| name == "available") {
                    continue;
                }
                walk_rust_files(src_root, &path, violations);
                continue;
            }
            if path.extension().and_then(|ext| ext.to_str()) != Some("rs") {
                continue;
            }
            let source = fs::read_to_string(&path).expect("read rust source");
            if source.contains("cfg(feature = \"available\")") {
                continue;
            }
            let forbidden = [
                concat!("crate::", "available"),
                concat!("path = \"../", "available"),
                concat!("path = \"", "available/"),
            ];
            for (index, line) in source.lines().enumerate() {
                let trimmed = line.trim();
                if trimmed.starts_with("//") {
                    continue;
                }
                if forbidden.iter().any(|needle| trimmed.contains(needle)) {
                    violations.push(format!(
                        "{}:{}: {trimmed}",
                        path.strip_prefix(src_root).unwrap_or(&path).display(),
                        index + 1
                    ));
                }
            }
        }
    }
}
