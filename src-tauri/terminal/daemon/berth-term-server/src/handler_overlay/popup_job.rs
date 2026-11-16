use std::io;
use std::sync::{Arc, Mutex as StdMutex};

use berth_term_engine::input::InputParser;
use berth_term_engine::{GridRenderOptions, Screen, ScreenCaptureRange};
use berth_term_proto::{TerminalError, TerminalSize};
use berth_term_pty::{PtyChild, PtyIo, Signal, TerminalSize as PtyTerminalSize};

use crate::terminal::{parse_environment_assignments, TerminalProfile};

use super::super::RequestHandler;

pub(in super::super) struct PopupSurface {
    parser: InputParser,
    screen: Screen,
}

impl std::fmt::Debug for PopupSurface {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PopupSurface").finish_non_exhaustive()
    }
}

impl PopupSurface {
    pub(super) fn new(size: TerminalSize) -> Self {
        Self {
            parser: InputParser::new(),
            screen: Screen::new(size, 0),
        }
    }

    pub(super) fn append(&mut self, bytes: &[u8]) {
        self.parser.parse(bytes, &mut self.screen);
    }

    pub(super) fn resize(&mut self, size: TerminalSize) {
        self.screen.resize(size);
    }

    pub(super) fn mode(&self) -> u32 {
        self.screen.mode()
    }

    pub(super) fn lines(&self) -> Vec<String> {
        let bytes = self
            .screen
            .capture_transcript(ScreenCaptureRange::default(), GridRenderOptions::default());
        let rendered = String::from_utf8_lossy(&bytes);
        let mut lines = rendered
            .split('\n')
            .map(ToOwned::to_owned)
            .collect::<Vec<_>>();
        while lines.last().is_some_and(String::is_empty) {
            let _ = lines.pop();
        }
        lines
    }
}

#[derive(Debug, Clone)]
pub(in super::super) struct PopupJob {
    writer: Arc<StdMutex<PtyIo>>,
    child: Arc<StdMutex<Option<PtyChild>>>,
}

impl PopupJob {
    pub(super) fn write(&self, bytes: &[u8]) -> io::Result<()> {
        let writer = self.writer.lock().expect("popup writer");
        writer.write_all(bytes)
    }

    pub(super) fn resize(&self, size: TerminalSize) -> io::Result<()> {
        let writer = self.writer.lock().expect("popup writer");
        writer
            .resize(PtyTerminalSize::new(size.cols.max(1), size.rows.max(1)))
            .map_err(io::Error::other)
    }

    pub(in super::super) fn terminate(&self) {
        if let Some(child) = self.child.lock().expect("popup child").as_ref() {
            let _ = child.kill(Signal::HUP);
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in super::super) enum PopupDragMode {
    Off,
    Move { dx: u16, dy: u16 },
    Resize,
}

pub(super) fn spawn_popup_job(
    size: TerminalSize,
    profile: &TerminalProfile,
    shell_command: Option<&str>,
    environment: &[String],
) -> Result<(PopupJob, Vec<u8>), TerminalError> {
    let env = parse_environment_assignments(environment)?;
    let mut command = shell_command
        .map(|command| profile.shell_child_command(command))
        .unwrap_or_else(|| profile.interactive_child_command())
        .size(PtyTerminalSize::new(size.cols.max(1), size.rows.max(1)))
        .clear_env()
        .current_dir(profile.cwd());
    for (name, value) in profile.environment() {
        command = command.env(name, value);
    }
    for (name, value) in env {
        command = command.env(name, value);
    }
    let spawned = command.spawn().map_err(|error| {
        TerminalError::Server(format!("failed to spawn popup process: {error}"))
    })?;
    let (master, child) = spawned.into_parts();
    let writer_fd = master.into_io();
    #[cfg(unix)]
    writer_fd
        .set_nonblocking()
        .map_err(|error| TerminalError::Server(format!("failed to prepare popup pty: {error}")))?;
    Ok((
        PopupJob {
            writer: Arc::new(StdMutex::new(writer_fd)),
            child: Arc::new(StdMutex::new(Some(child))),
        },
        Vec::new(),
    ))
}

impl RequestHandler {}
