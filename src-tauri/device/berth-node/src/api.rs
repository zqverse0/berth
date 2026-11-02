//! 消息内容：客户端请求、节点回复与节点推送（帧与会话见 [`crate::frame`] / [`crate::session`]）。
//!
//! 一条消息 = `u32 头长` + JSON 头 + 原始字节。终端输出、文件内容放在原始字节里，不进 JSON。
//!
//! - 请求：头是 [`Request`]；`Input`、`Write`、`PutChunk` 的内容在原始字节里。
//! - 回复：与请求同 id，头是 [`Reply`]；`Read` 的文件内容、`Attach` / `Resize` / `History` 的终端画面在原始字节里。
//! - 推送：节点发起的消息（不需要回复），头是 [`Push`]；`Output` 的终端字节在原始字节里。
//!   `Output` 可能先于 `Attach` 的回复到达：客户端按 `seq` 把 ≥ 快照水位的输出排在快照之后回放。
//!
//! 领域数据（项目、终端、会话、任务、知识库、服务商）的形状与对应 `berth … --json` 输出一致，
//! 这里只给节点自有的类型。

use std::collections::BTreeMap;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::frame::Priority;

/// 打开文件时先回这么多（首屏），其余由客户端按需续读。
pub const FIRST_SCREEN: u64 = 64 * 1024;
/// 单次 `Read` 的上限。
pub const MAX_READ: u64 = 1024 * 1024;
/// 单个 `PutChunk` 的上限。
pub const MAX_PUT_CHUNK: usize = 1024 * 1024;

/// 客户端请求。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Request {
    /// 设备概览：主机信息、全部项目、全部终端（一次取齐）。
    Device,
    /// 项目概览：项目、根目录、终端、启动栏、会话、任务、知识库（一次取齐）。
    Project {
        /// 项目 id（对方库里的）。
        project: i64,
        /// 客户端缓存的根目录版本；未变时根目录只回 `unchanged`。
        #[serde(default)]
        root_version: Option<String>,
    },
    /// 在对方 Berth 注册项目（不挂载）。
    ProjectAdd {
        /// 对方机器上的绝对路径。
        path: String,
    },
    /// 浏览对方目录（添加项目用）：只列子目录名，限对方家目录之内；不给路径时为家目录。
    Dirs {
        /// 绝对路径。
        #[serde(default)]
        path: Option<String>,
    },
    /// 项目的会话列表。
    Sessions {
        /// 项目 id。
        project: i64,
        /// 最多几条。
        #[serde(default)]
        limit: Option<usize>,
    },
    /// 一个会话的正文。
    Session {
        /// 会话 id。
        id: String,
        /// 限定 Agent。
        #[serde(default)]
        agent: Option<String>,
        /// 只看最后几轮。
        #[serde(default)]
        tail: Option<usize>,
    },
    /// 项目的任务列表。
    Tasks {
        /// 项目 id。
        project: i64,
    },
    /// 一个任务。
    Task {
        /// 项目 id。
        project: i64,
        /// 任务引用。
        task: String,
    },
    /// 一篇知识库笔记。
    Note {
        /// 项目 id。
        project: i64,
        /// 标题或别名。
        name: String,
    },
    /// 文件或目录信息。
    Stat {
        /// 绝对路径（须在已注册项目根之内，下同）。
        path: String,
    },
    /// 列目录；`version` 与当前一致时只回 `unchanged`。
    List {
        /// 绝对路径。
        path: String,
        /// 客户端缓存的目录版本。
        #[serde(default)]
        version: Option<String>,
    },
    /// 读文件的一段（首屏用 [`FIRST_SCREEN`]，之后续读）。
    Read {
        /// 绝对路径。
        path: String,
        /// 起始偏移。
        offset: u64,
        /// 长度，上限 [`MAX_READ`]。
        len: u64,
    },
    /// 整体写入（内容在原始字节里）；`version` 与磁盘不一致时报冲突、不覆盖。
    Write {
        /// 绝对路径。
        path: String,
        /// 读到时的版本；`None` 表示新建（文件已存在则冲突）。
        #[serde(default)]
        version: Option<String>,
    },
    /// 文件内容的 sha256（传输校验）。
    Hash {
        /// 绝对路径。
        path: String,
    },
    /// 开始或续上一次上传：回已收到的字节数。
    PutBegin {
        /// 目标绝对路径。
        path: String,
        /// 总字节数。
        size: u64,
        /// 内容 sha256（十六进制）；同一内容的未完成上传从断点续上。
        sha256: String,
    },
    /// 上传一块（内容在原始字节里），`offset` 必须等于已收到的字节数。
    PutChunk {
        /// 目标绝对路径。
        path: String,
        /// 内容 sha256。
        sha256: String,
        /// 本块起点。
        offset: u64,
    },
    /// 收齐后校验哈希并落盘。
    PutFinish {
        /// 目标绝对路径。
        path: String,
        /// 内容 sha256。
        sha256: String,
    },
    /// 终端列表。
    Terminals {
        /// 只看某项目。
        #[serde(default)]
        project: Option<i64>,
    },
    /// 接入终端：回可视区快照（画面在原始字节里），之后推送 `Output`。
    Attach {
        /// 对方的 target_ref。
        target: String,
    },
    /// 停止推送该终端的输出（终端照常运行）。
    Detach {
        /// 对方的 target_ref。
        target: String,
    },
    /// 终端输入（原始字节）。
    Input {
        /// 对方的 target_ref。
        target: String,
    },
    /// 改终端尺寸：回改后的可视区画面（与 `Attach` 同形，不含模式与光标）。
    Resize {
        /// 对方的 target_ref。
        target: String,
        /// 行数。
        rows: u16,
        /// 列数。
        cols: u16,
    },
    /// 拉可视区之上的历史（按需）。
    History {
        /// 对方的 target_ref。
        target: String,
        /// 最多几行。
        lines: u32,
    },
    /// 关闭终端（结束其中的进程）。
    Close {
        /// 对方的 target_ref。
        target: String,
    },
    /// 对方的启动栏：可启动的工具与服务商（与项目概览里的 `launchbar` 同形）。
    Launchbar,
    /// 在对方项目里新建终端；给 `agent` 时用对方的启动栏与服务商启动 Agent。
    Create {
        /// 项目 id。
        project: i64,
        /// 工具 id。
        #[serde(default)]
        agent: Option<String>,
        /// 启动栏输入。
        #[serde(default)]
        inputs: BTreeMap<String, Value>,
        /// 对方的服务商 id。
        #[serde(default)]
        provider: Option<i32>,
        /// 模型。
        #[serde(default)]
        model: Option<String>,
    },
}

impl Request {
    /// 发送优先级：终端交互插队，传输只用空闲带宽，其余普通。
    pub fn priority(&self) -> Priority {
        match self {
            Request::Attach { .. }
            | Request::Detach { .. }
            | Request::Input { .. }
            | Request::Resize { .. }
            | Request::History { .. }
            | Request::Close { .. } => Priority::Interactive,
            Request::PutBegin { .. } | Request::PutChunk { .. } | Request::PutFinish { .. } => {
                Priority::Bulk
            }
            _ => Priority::Normal,
        }
    }

    /// 必须按发出顺序执行（终端输入、尺寸、接入）。
    pub fn ordered(&self) -> bool {
        self.priority() == Priority::Interactive
    }
}

/// 失败原因。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApiError {
    /// `not_found` / `conflict` / `forbidden` / `invalid` / `unavailable` / `internal`。
    pub kind: String,
    /// 给人看的说明。
    pub message: String,
    /// 冲突时磁盘上的当前版本等附加信息。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<Value>,
}

impl ApiError {
    /// 新错误。
    pub fn new(kind: &str, message: impl Into<String>) -> Self {
        Self {
            kind: kind.to_owned(),
            message: message.into(),
            detail: None,
        }
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.kind, self.message)
    }
}

/// 回复头。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Reply {
    /// 成功：结果（类型随请求）。
    Ok(Value),
    /// 失败。
    Err(ApiError),
}

/// 节点推送。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum Push {
    /// 终端输出（字节在原始字节里）。
    Output {
        /// 对方的 target_ref。
        target: String,
        /// 输出序号：与 [`Paint::seq`] 同一计数。
        seq: u64,
    },
    /// 输出积压或流断开：客户端应重新 `Attach` 取快照。
    Resync {
        /// 对方的 target_ref。
        target: String,
    },
    /// 终端进程退出。
    Exited {
        /// 对方的 target_ref。
        target: String,
    },
}

/// 文件或目录信息。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Stat {
    /// 是否目录。
    pub dir: bool,
    /// 字节数（目录为 0）。
    pub size: u64,
    /// 版本：内容变了它就变（文件按修改时间与大小，目录按条目）。
    pub version: String,
}

/// 目录条目。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entry {
    /// 名字。
    pub name: String,
    /// 是否目录。
    pub dir: bool,
    /// 字节数。
    pub size: u64,
}

/// 目录列表。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Listing {
    /// 目录版本。
    pub version: String,
    /// 与客户端缓存一致：`entries` 为空，沿用缓存。
    pub unchanged: bool,
    /// 条目（目录在前，按名字排序）。
    pub entries: Vec<Entry>,
}

/// `Read` 的回复头（内容在原始字节里）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReadHead {
    /// 文件总字节数。
    pub size: u64,
    /// 文件版本（写回时带上）。
    pub version: String,
    /// 疑似二进制（开头有 NUL）：客户端不自动预览。
    pub binary: bool,
}

/// `Attach` / `Resize` 的回复头（画面在原始字节里）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Paint {
    /// 快照水位：`seq` ≥ 它的 `Output` 在快照之后回放。
    pub seq: u64,
    /// 行数。
    pub rows: u16,
    /// 列数。
    pub cols: u16,
}

/// 消息编码。
pub fn encode<T: Serialize>(head: &T, body: &[u8]) -> Vec<u8> {
    let json = serde_json::to_vec(head).expect("api heads serialize");
    let mut out = Vec::with_capacity(4 + json.len() + body.len());
    out.extend_from_slice(&(json.len() as u32).to_le_bytes());
    out.extend_from_slice(&json);
    out.extend_from_slice(body);
    out
}

/// 消息解码：头与原始字节。
pub fn decode<T: DeserializeOwned>(payload: &[u8]) -> Result<(T, &[u8]), ApiError> {
    let invalid = |message: String| ApiError::new("invalid", message);
    let len = payload
        .get(..4)
        .map(|b| u32::from_le_bytes(b.try_into().expect("4 bytes")) as usize)
        .ok_or_else(|| invalid("message too short".into()))?;
    let json = payload
        .get(4..4 + len)
        .ok_or_else(|| invalid("message head truncated".into()))?;
    let head = serde_json::from_slice(json).map_err(|error| invalid(error.to_string()))?;
    Ok((head, &payload[4 + len..]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messages_roundtrip_with_raw_body() {
        let request = Request::Input {
            target: "v1.abc".into(),
        };
        let bytes = encode(&request, b"\x1b[A");
        let (head, body) = decode::<Request>(&bytes).unwrap();
        assert_eq!(head, request);
        assert_eq!(body, b"\x1b[A");
        assert_eq!(head.priority(), Priority::Interactive);

        let reply = Reply::Err(ApiError::new("conflict", "changed on disk"));
        let bytes = encode(&reply, b"");
        let (head, body) = decode::<Reply>(&bytes).unwrap();
        assert_eq!(head, reply);
        assert!(body.is_empty());
    }

    #[test]
    fn requests_use_snake_case_ops() {
        let json = serde_json::to_value(Request::Project {
            project: 3,
            root_version: None,
        })
        .unwrap();
        assert_eq!(json["op"], "project");
        let parsed: Request = serde_json::from_str(r#"{"op":"device"}"#).unwrap();
        assert_eq!(parsed, Request::Device);
    }
}
