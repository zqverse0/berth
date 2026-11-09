//! 消息内容：客户端请求、节点回复与节点推送（帧与会话见 [`crate::frame`] / [`crate::session`]）。
//!
//! 一条消息 = `u32 头长` + JSON 头 + 原始字节。隧道字节、文件内容放在原始字节里，不进 JSON。
//!
//! - 请求：头是 [`Request`]；`Send`、`PutChunk` 的内容在原始字节里。
//! - 回复：与请求同 id，头是 [`Reply`]。
//! - 推送：节点发起的消息（不需要回复），头是 [`Push`]；`Data` 的字节在原始字节里。
//!
//! 对方项目的内容（文件、终端、会话……）不走这里的专用请求：经隧道（`Connect` / `Send` / `Shut`）
//! 直接用对方 GUI 的命令，界面与数据形状与本机一致。这里只剩 GUI 不运行时也要用的：设备概览、
//! 添加项目、浏览目录、启动栏、文件传输。

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::frame::Priority;

/// 单个 `PutChunk` 的上限。
pub const MAX_PUT_CHUNK: usize = 1024 * 1024;

/// 客户端请求。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Request {
    /// 设备概览：主机信息、打开的项目、对方 GUI 的设备 socket（一次取齐）。
    Device,
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
    /// 开始一次下载：回 `{ size, sha256 }`。
    GetBegin {
        /// 对方项目之内的绝对路径。
        path: String,
    },
    /// 下载一块：内容在回复的原始字节里，不超过 `len`（上限 [`MAX_PUT_CHUNK`]）；到文件尾为空。
    GetChunk {
        /// 对方项目之内的绝对路径。
        path: String,
        /// 本块起点。
        offset: u64,
        /// 要的字节数。
        len: u64,
    },
    /// 设备窗口的连接隧道：打开一条到对方 GUI 设备 socket 的字节流（编号由客户端给）。
    Connect {
        /// 流编号。
        stream: u64,
        /// 这条流的发送优先级。
        lane: Lane,
    },
    /// 往流里写（字节在原始字节里）；`offset` 是这条流已写的累计字节数，接收端按它排序。
    Send {
        /// 流编号。
        stream: u64,
        /// 发送优先级（同 `Connect`）。
        lane: Lane,
        /// 本块起始的累计偏移。
        offset: u64,
    },
    /// 关闭流。
    Shut {
        /// 流编号。
        stream: u64,
    },
}

/// 隧道流的优先级（线上形式）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Lane {
    /// 终端专线。
    Interactive,
    /// 命令线。
    Normal,
    /// 静态资源等大块。
    Bulk,
}

impl From<Lane> for Priority {
    fn from(lane: Lane) -> Self {
        match lane {
            Lane::Interactive => Priority::Interactive,
            Lane::Normal => Priority::Normal,
            Lane::Bulk => Priority::Bulk,
        }
    }
}

impl Request {
    /// 发送优先级：隧道按流的道（终端专线插队），传输只用空闲带宽，其余普通。
    pub fn priority(&self) -> Priority {
        match self {
            Request::Connect { lane, .. } | Request::Send { lane, .. } => (*lane).into(),
            Request::PutBegin { .. }
            | Request::PutChunk { .. }
            | Request::PutFinish { .. }
            | Request::GetBegin { .. }
            | Request::GetChunk { .. } => Priority::Bulk,
            _ => Priority::Normal,
        }
    }

    /// 隧道请求：节点就地处理。
    pub fn tunnel(&self) -> bool {
        matches!(
            self,
            Request::Connect { .. } | Request::Send { .. } | Request::Shut { .. }
        )
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
    /// 隧道流读到的字节（在原始字节里）；`offset` 同 [`Request::Send`]。
    Data {
        /// 流编号。
        stream: u64,
        /// 本块起始的累计偏移。
        offset: u64,
    },
    /// 隧道流在节点一侧结束（对方 GUI 关了连接或连不上）。
    Closed {
        /// 流编号。
        stream: u64,
        /// 这条流推过的总字节数：客户端交付到这里再关。
        offset: u64,
    },
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
        let request = Request::Send {
            stream: 7,
            lane: Lane::Interactive,
            offset: 0,
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
        let json = serde_json::to_value(Request::ProjectAdd {
            path: "/srv/app".into(),
        })
        .unwrap();
        assert_eq!(json["op"], "project_add");
        let parsed: Request = serde_json::from_str(r#"{"op":"device"}"#).unwrap();
        assert_eq!(parsed, Request::Device);
    }
}
