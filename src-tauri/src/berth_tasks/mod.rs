pub mod collaboration;

use serde_json::{json, Value};

#[derive(Debug)]
pub struct BerthTaskError {
    pub kind: &'static str,
    pub code: &'static str,
    pub message: String,
}

impl BerthTaskError {
    fn new(kind: &'static str, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            kind,
            code,
            message: message.into(),
        }
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new("invalid_input", "invalid_input", message)
    }
    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new("not_found", "not_found", message)
    }
    pub fn already_exists(message: impl Into<String>) -> Self {
        Self::new("already_exists", "already_exists", message)
    }
    pub fn permission(message: impl Into<String>) -> Self {
        Self::new("permission_denied", "permission_denied", message)
    }
    pub fn internal(message: impl Into<String>) -> Self {
        Self::new("io", "io_error", message)
    }
    pub fn io(error: std::io::Error) -> Self {
        Self::io_at(error, None::<&std::path::Path>)
    }

    pub fn io_at(error: std::io::Error, path: Option<impl AsRef<std::path::Path>>) -> Self {
        let where_ = path
            .map(|p| format!(" ({})", p.as_ref().display()))
            .unwrap_or_default();
        match error.kind() {
            std::io::ErrorKind::NotFound => Self::not_found(format!("Resource not found{where_}")),
            std::io::ErrorKind::AlreadyExists => {
                Self::already_exists(format!("Resource already exists{where_}"))
            }
            std::io::ErrorKind::PermissionDenied => Self::permission(format!(
                "Permission denied{where_}. The project directory is not writable by the current user."
            )),
            _ => Self::internal(format!("I/O operation failed{where_}: {error}")),
        }
    }
    pub fn response(&self, method: &str) -> Value {
        json!({
            "ok": false,
            "error": {
                "kind": self.kind,
                "code": self.code,
                "message": self.message,
                "method": method,
            }
        })
    }
}
