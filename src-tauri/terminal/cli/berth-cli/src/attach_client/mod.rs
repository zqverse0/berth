//! Attach-mode client plumbing for the Berth CLI.
//!
//! attach 是命令行专属能力：raw TTY 接管、阻塞式 attach 流升级与
//! 平台各自的 resize 监听都在这里，不进入 SDK（SDK 不知道 TTY 存在）。

#[cfg(unix)]
mod attach;
#[cfg(windows)]
#[path = "attach_windows.rs"]
mod attach;
mod connection;
mod terminal_sequences;

pub(crate) use connection::{connect, AttachTransition, ClientError};

#[cfg(any(unix, windows))]
pub(crate) use attach::{attach_terminal_with_initial_bytes, AttachError};

#[cfg(all(test, unix))]
pub(crate) use attach::{attach_with_terminal, drive_attach_stream, RawTerminal};

#[cfg(all(test, unix))]
mod attach_session_tests {
    include!("attach_session_tests.rs");
}

#[cfg(all(test, unix))]
mod raw_terminal_tests {
    include!("raw_terminal_tests.rs");
}

#[cfg(all(test, unix))]
pub(crate) mod test_support;
