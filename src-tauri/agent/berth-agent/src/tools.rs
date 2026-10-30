//! 四个工具：read / bash / edit / write。相对路径按会话工作目录解析，`~/` 展开为家目录。
//! 输出超过上限时截断并注明，避免一次工具结果撑爆上下文。

use std::path::{Path, PathBuf};
use std::time::Duration;

use genai::chat::Tool;
use serde_json::{json, Value};

const MAX_LINES: usize = 2000;
const MAX_BYTES: usize = 50 * 1024;
const DEFAULT_TIMEOUT_SECS: u64 = 120;

pub fn definitions() -> Vec<Tool> {
    vec![
        Tool::new("read")
            .with_description(format!(
                "Read a text file. Each line is prefixed with its 1-based line number and a tab (like `cat -n`); the prefix is not part of the file, so leave it out of edit's old_text. Output is capped at {MAX_LINES} lines or {}KB; use offset/limit to page through larger files.",
                MAX_BYTES / 1024
            ))
            .with_schema(json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "File path, relative to the working directory or absolute" },
                    "offset": { "type": "integer", "description": "First line to read, 1-based" },
                    "limit": { "type": "integer", "description": "Maximum number of lines to read" }
                },
                "required": ["path"]
            })),
        Tool::new("bash")
            .with_description(format!(
                "Run a shell command in the working directory. Returns stdout and stderr; long output keeps the last {}KB. Default timeout {DEFAULT_TIMEOUT_SECS}s.",
                MAX_BYTES / 1024
            ))
            .with_schema(json!({
                "type": "object",
                "properties": {
                    "command": { "type": "string", "description": "Command to run" },
                    "timeout": { "type": "integer", "description": "Timeout in seconds" }
                },
                "required": ["command"]
            })),
        Tool::new("edit")
            .with_description(
                "Replace one exact occurrence of old_text with new_text in a file. old_text must match exactly once, including whitespace.",
            )
            .with_schema(json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "File path" },
                    "old_text": { "type": "string", "description": "Exact text to replace" },
                    "new_text": { "type": "string", "description": "Replacement text" }
                },
                "required": ["path", "old_text", "new_text"]
            })),
        Tool::new("write")
            .with_description("Create or overwrite a file with the given content. Creates parent directories.")
            .with_schema(json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "File path" },
                    "content": { "type": "string", "description": "Full file content" }
                },
                "required": ["path", "content"]
            })),
    ]
}

/// 执行一次工具调用；`Err` 的文本原样交回模型。
pub async fn run(
    name: &str,
    args: &Value,
    cwd: &Path,
    env: &[(String, String)],
) -> Result<String, String> {
    match name {
        "read" => read(&resolve(cwd, text(args, "path")?), args),
        "bash" => bash(text(args, "command")?, args, cwd, env).await,
        "edit" => edit(
            &resolve(cwd, text(args, "path")?),
            text(args, "old_text")?,
            text(args, "new_text")?,
        ),
        "write" => write(&resolve(cwd, text(args, "path")?), text(args, "content")?),
        _ => Err(format!("unknown tool: {name}")),
    }
}

fn text<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    args.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("missing string argument `{key}`"))
}

fn number(args: &Value, key: &str) -> Option<usize> {
    args.get(key)
        .and_then(Value::as_u64)
        .map(|value| value as usize)
}

fn resolve(cwd: &Path, path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
            return PathBuf::from(home).join(rest);
        }
    }
    cwd.join(path)
}

fn read(path: &Path, args: &Value) -> Result<String, String> {
    let content =
        std::fs::read_to_string(path).map_err(|error| format!("{}: {error}", path.display()))?;
    let lines: Vec<&str> = content.lines().collect();
    let start = number(args, "offset").unwrap_or(1).max(1) - 1;
    if start >= lines.len() && !lines.is_empty() {
        return Err(format!(
            "offset {} is past the end ({} lines)",
            start + 1,
            lines.len()
        ));
    }
    let limit = number(args, "limit").unwrap_or(MAX_LINES).min(MAX_LINES);
    let mut out = String::new();
    let mut end = start;
    for line in lines.iter().skip(start).take(limit) {
        // 带行号：模型引用「第 N 行」不用自己数、也不用再读一遍。
        let numbered = format!("{:>6}\t{line}\n", end + 1);
        if out.len() + numbered.len() > MAX_BYTES {
            break;
        }
        out.push_str(&numbered);
        end += 1;
    }
    if end < lines.len() {
        out.push_str(&format!(
            "\n[{} more lines; continue with offset={}]",
            lines.len() - end,
            end + 1
        ));
    }
    Ok(out)
}

async fn bash(
    command: &str,
    args: &Value,
    cwd: &Path,
    env: &[(String, String)],
) -> Result<String, String> {
    let timeout = number(args, "timeout").map_or(DEFAULT_TIMEOUT_SECS, |secs| secs as u64);
    let mut process = if cfg!(windows) {
        let mut process = tokio::process::Command::new("cmd");
        process.arg("/C").arg(command);
        process
    } else {
        let mut process = tokio::process::Command::new("sh");
        process.arg("-c").arg(command);
        process
    };
    process
        .current_dir(cwd)
        .envs(env.iter().map(|(key, value)| (key, value)))
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(timeout), process.output())
        .await
        .map_err(|_| format!("command timed out after {timeout}s"))?
        .map_err(|error| format!("cannot run command: {error}"))?;
    let mut out = String::from_utf8_lossy(&output.stdout).into_owned();
    out.push_str(&String::from_utf8_lossy(&output.stderr));
    let mut out = tail(out);
    if !output.status.success() {
        out.push_str(&format!("\n[exit status: {}]", output.status));
    }
    Ok(out)
}

/// 只留末尾 MAX_BYTES：命令输出的结论通常在最后。
fn tail(text: String) -> String {
    if text.len() <= MAX_BYTES {
        return text;
    }
    let mut start = text.len() - MAX_BYTES;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    format!("[{} bytes truncated]\n{}", start, &text[start..])
}

fn edit(path: &Path, old_text: &str, new_text: &str) -> Result<String, String> {
    if old_text.is_empty() {
        return Err("old_text must not be empty".into());
    }
    let content =
        std::fs::read_to_string(path).map_err(|error| format!("{}: {error}", path.display()))?;
    match content.matches(old_text).count() {
        0 => Err(format!("old_text not found in {}", path.display())),
        1 => {
            std::fs::write(path, content.replacen(old_text, new_text, 1))
                .map_err(|error| format!("{}: {error}", path.display()))?;
            Ok(format!("edited {}", path.display()))
        }
        count => Err(format!(
            "old_text matches {count} times in {}; include more surrounding text",
            path.display()
        )),
    }
}

fn write(path: &Path, content: &str) -> Result<String, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("{}: {error}", parent.display()))?;
    }
    std::fs::write(path, content).map_err(|error| format!("{}: {error}", path.display()))?;
    Ok(format!(
        "wrote {} bytes to {}",
        content.len(),
        path.display()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn edit_requires_exactly_one_match() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("f"), "a b a").unwrap();
        let args = |old: &str| json!({"path": "f", "old_text": old, "new_text": "x"});
        assert!(run("edit", &args("a"), dir.path(), &[])
            .await
            .unwrap_err()
            .contains("2 times"));
        assert!(run("edit", &args("z"), dir.path(), &[]).await.is_err());
        run("edit", &args("b"), dir.path(), &[]).await.unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join("f")).unwrap(),
            "a x a"
        );
    }

    #[tokio::test]
    async fn read_pages_with_offset_and_limit() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("f"), "1\n2\n3\n4\n").unwrap();
        let out = run(
            "read",
            &json!({"path": "f", "offset": 2, "limit": 2}),
            dir.path(),
            &[],
        )
        .await
        .unwrap();
        assert_eq!(
            out,
            "     2\t2\n     3\t3\n\n[1 more lines; continue with offset=4]"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn bash_gets_the_extra_environment() {
        let dir = tempfile::tempdir().unwrap();
        let env = [("BERTH_AGENT_TEST".to_owned(), "yes".to_owned())];
        let out = run(
            "bash",
            &json!({"command": "echo $BERTH_AGENT_TEST"}),
            dir.path(),
            &env,
        )
        .await
        .unwrap();
        assert_eq!(out, "yes\n");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn bash_reports_output_exit_status_and_timeout() {
        let dir = tempfile::tempdir().unwrap();
        let out = run(
            "bash",
            &json!({"command": "echo out; echo err >&2; exit 3"}),
            dir.path(),
            &[],
        )
        .await
        .unwrap();
        assert!(out.starts_with("out\nerr\n"), "{out}");
        assert!(out.contains("exit status: 3"), "{out}");
        let timed_out = run(
            "bash",
            &json!({"command": "sleep 5", "timeout": 1}),
            dir.path(),
            &[],
        )
        .await;
        assert!(timed_out.unwrap_err().contains("timed out"));
    }

    #[tokio::test]
    async fn write_creates_parent_directories() {
        let dir = tempfile::tempdir().unwrap();
        run(
            "write",
            &json!({"path": "a/b/c.txt", "content": "x"}),
            dir.path(),
            &[],
        )
        .await
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join("a/b/c.txt")).unwrap(),
            "x"
        );
    }
}
