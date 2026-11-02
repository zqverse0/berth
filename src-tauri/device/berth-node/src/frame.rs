//! 帧编解码（格式见 crate 文档）。

use std::io::Read;

/// 协议版本：两端不一致直接拒绝，不做兼容。
pub const PROTOCOL_VERSION: u16 = 1;
/// 单帧上限（kind + body）。
pub const MAX_FRAME_LEN: usize = 1 << 20;
/// 握手帧魔数。
pub const MAGIC: [u8; 4] = *b"BNOD";
/// 小于这个字节数的 payload 不压缩：压不出收益。
const COMPRESS_MIN: usize = 128;
/// zstd 轻量级别：旧设备上也不吃 CPU。
const COMPRESS_LEVEL: i32 = 1;

/// Data 帧 flags。
pub mod flags {
    /// 消息的最后一块。
    pub const FIN: u8 = 1;
    /// 回复（与请求同 id）。
    pub const REPLY: u8 = 2;
    /// payload 经 zstd 压缩。
    pub const ZSTD: u8 = 4;
    /// 撤销该 id 的消息。
    pub const CANCEL: u8 = 8;
}

const KIND_HELLO: u8 = 1;
const KIND_WELCOME: u8 = 2;
const KIND_REJECT: u8 = 3;
const KIND_DATA: u8 = 4;
const KIND_ACK: u8 = 5;
const KIND_PING: u8 = 6;
const KIND_PONG: u8 = 7;
const DATA_HEADER: usize = 2 + 8 * 3;

/// 协议错误。
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ProtoError {
    /// 帧不完整或字段越界。
    #[error("malformed frame: {0}")]
    Malformed(&'static str),
    /// 未知帧类型。
    #[error("unknown frame kind {0}")]
    UnknownKind(u8),
    /// 帧或消息超过上限。
    #[error("frame too large: {0} bytes")]
    TooLarge(usize),
    /// 两端协议版本不一致。
    #[error("protocol version mismatch: ours {ours}, theirs {theirs}")]
    Version {
        /// 本端版本。
        ours: u16,
        /// 对端版本。
        theirs: u16,
    },
    /// 对端拒绝握手。
    #[error("rejected by peer: {0}")]
    Rejected(String),
    /// 收到不该在当前状态出现的帧。
    #[error("unexpected frame: {0}")]
    Unexpected(&'static str),
    /// 解压失败。
    #[error("decompress failed")]
    Decompress,
}

/// 帧优先级：数字越小越先发。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Priority {
    /// 终端输入输出等交互：不受拥塞窗口限制，总是先发。
    Interactive = 0,
    /// 用户触发的请求与回复。
    Normal = 1,
    /// 传输、预取：只用空闲带宽，有交互时让路。
    Bulk = 2,
}

impl Priority {
    /// 全部优先级，按发送顺序。
    pub const ALL: [Priority; 3] = [Priority::Interactive, Priority::Normal, Priority::Bulk];

    fn from_u8(v: u8) -> Result<Self, ProtoError> {
        Self::ALL
            .get(v as usize)
            .copied()
            .ok_or(ProtoError::Malformed("priority"))
    }
}

/// 会话 id：客户端生成，断线重连时凭它续上。全 0 表示没有会话。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub struct SessionId(pub [u8; 16]);

/// Data 帧。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DataFrame {
    /// [`flags`] 组合。
    pub flags: u8,
    /// 优先级。
    pub priority: Priority,
    /// 本方向序号，从 1 开始。
    pub seq: u64,
    /// 捎带的累计确认。
    pub ack: u64,
    /// 消息 id。
    pub id: u64,
    /// 线上字节（ZSTD 时为压缩后）。
    pub payload: Vec<u8>,
}

/// 一帧。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Frame {
    /// 客户端握手。
    Hello {
        /// 协议版本。
        version: u16,
        /// 要续上的会话。
        session: SessionId,
        /// 客户端已连续收到的最大 seq。
        recv_seq: u64,
    },
    /// 服务端接受握手。
    Welcome {
        /// 协议版本。
        version: u16,
        /// 会话 id。
        session: SessionId,
        /// 服务端已连续收到的最大 seq。
        recv_seq: u64,
        /// 会话是否续上（否则双方从头开始）。
        resumed: bool,
    },
    /// 服务端拒绝握手。
    Reject {
        /// 服务端协议版本。
        version: u16,
        /// 原因。
        reason: String,
    },
    /// 数据。
    Data(DataFrame),
    /// 纯确认。
    Ack {
        /// 累计确认。
        ack: u64,
    },
    /// 心跳。
    Ping {
        /// 原样带回。
        token: u64,
    },
    /// 心跳回应。
    Pong {
        /// Ping 的 token。
        token: u64,
    },
}

impl Frame {
    /// 编码成带长度前缀的线上字节。
    pub fn encode(&self) -> Vec<u8> {
        let mut out = vec![0; 4];
        match self {
            Frame::Hello {
                version,
                session,
                recv_seq,
            } => {
                out.push(KIND_HELLO);
                out.extend_from_slice(&MAGIC);
                out.extend_from_slice(&version.to_le_bytes());
                out.extend_from_slice(&session.0);
                out.extend_from_slice(&recv_seq.to_le_bytes());
            }
            Frame::Welcome {
                version,
                session,
                recv_seq,
                resumed,
            } => {
                out.push(KIND_WELCOME);
                out.extend_from_slice(&MAGIC);
                out.extend_from_slice(&version.to_le_bytes());
                out.extend_from_slice(&session.0);
                out.extend_from_slice(&recv_seq.to_le_bytes());
                out.push(*resumed as u8);
            }
            Frame::Reject { version, reason } => {
                out.push(KIND_REJECT);
                out.extend_from_slice(&MAGIC);
                out.extend_from_slice(&version.to_le_bytes());
                out.extend_from_slice(reason.as_bytes());
            }
            Frame::Data(d) => {
                out.push(KIND_DATA);
                out.push(d.flags);
                out.push(d.priority as u8);
                out.extend_from_slice(&d.seq.to_le_bytes());
                out.extend_from_slice(&d.ack.to_le_bytes());
                out.extend_from_slice(&d.id.to_le_bytes());
                out.extend_from_slice(&d.payload);
            }
            Frame::Ack { ack } => {
                out.push(KIND_ACK);
                out.extend_from_slice(&ack.to_le_bytes());
            }
            Frame::Ping { token } => {
                out.push(KIND_PING);
                out.extend_from_slice(&token.to_le_bytes());
            }
            Frame::Pong { token } => {
                out.push(KIND_PONG);
                out.extend_from_slice(&token.to_le_bytes());
            }
        }
        let len = (out.len() - 4) as u32;
        out[..4].copy_from_slice(&len.to_le_bytes());
        out
    }

    /// 解码一帧（不含长度前缀）。
    pub fn decode(buf: &[u8]) -> Result<Frame, ProtoError> {
        let (&kind, body) = buf.split_first().ok_or(ProtoError::Malformed("empty"))?;
        let mut r = Reader(body);
        let frame = match kind {
            KIND_HELLO | KIND_WELCOME | KIND_REJECT => {
                if r.take(4)? != MAGIC {
                    return Err(ProtoError::Malformed("magic"));
                }
                let version = r.u16()?;
                match kind {
                    KIND_REJECT => Frame::Reject {
                        version,
                        reason: String::from_utf8_lossy(r.0).into_owned(),
                    },
                    _ => {
                        let session = SessionId(r.take(16)?.try_into().expect("16 bytes"));
                        let recv_seq = r.u64()?;
                        if kind == KIND_HELLO {
                            Frame::Hello {
                                version,
                                session,
                                recv_seq,
                            }
                        } else {
                            Frame::Welcome {
                                version,
                                session,
                                recv_seq,
                                resumed: r.take(1)?[0] != 0,
                            }
                        }
                    }
                }
            }
            KIND_DATA => {
                if body.len() < DATA_HEADER {
                    return Err(ProtoError::Malformed("data header"));
                }
                let flags = r.take(1)?[0];
                let priority = Priority::from_u8(r.take(1)?[0])?;
                Frame::Data(DataFrame {
                    flags,
                    priority,
                    seq: r.u64()?,
                    ack: r.u64()?,
                    id: r.u64()?,
                    payload: r.0.to_vec(),
                })
            }
            KIND_ACK => Frame::Ack { ack: r.u64()? },
            KIND_PING => Frame::Ping { token: r.u64()? },
            KIND_PONG => Frame::Pong { token: r.u64()? },
            other => return Err(ProtoError::UnknownKind(other)),
        };
        Ok(frame)
    }
}

struct Reader<'a>(&'a [u8]);

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], ProtoError> {
        if self.0.len() < n {
            return Err(ProtoError::Malformed("truncated"));
        }
        let (head, tail) = self.0.split_at(n);
        self.0 = tail;
        Ok(head)
    }
    fn u16(&mut self) -> Result<u16, ProtoError> {
        Ok(u16::from_le_bytes(
            self.take(2)?.try_into().expect("2 bytes"),
        ))
    }
    fn u64(&mut self) -> Result<u64, ProtoError> {
        Ok(u64::from_le_bytes(
            self.take(8)?.try_into().expect("8 bytes"),
        ))
    }
}

/// 压缩有收益时返回压缩后的字节。
pub(crate) fn compress(payload: &[u8]) -> Option<Vec<u8>> {
    if payload.len() < COMPRESS_MIN {
        return None;
    }
    let packed = zstd::encode_all(payload, COMPRESS_LEVEL).ok()?;
    (packed.len() < payload.len()).then_some(packed)
}

/// 解压，结果不超过 `limit` 字节。
pub(crate) fn decompress(packed: &[u8], limit: usize) -> Result<Vec<u8>, ProtoError> {
    let mut out = Vec::new();
    zstd::Decoder::new(packed)
        .map_err(|_| ProtoError::Decompress)?
        .take(limit as u64 + 1)
        .read_to_end(&mut out)
        .map_err(|_| ProtoError::Decompress)?;
    if out.len() > limit {
        return Err(ProtoError::TooLarge(out.len()));
    }
    Ok(out)
}

/// 从字节流切帧。
#[derive(Debug, Default)]
pub struct Decoder {
    buf: Vec<u8>,
    synced: bool,
}

impl Decoder {
    /// 对端输出的开头可能有杂字节（远端 shell 启动脚本打印的内容）：先跳到第一个握手帧。
    pub fn awaiting_handshake() -> Self {
        Self::default()
    }

    /// 已对齐的字节流（服务端读客户端输入）。
    pub fn synced() -> Self {
        Self {
            buf: Vec::new(),
            synced: true,
        }
    }

    /// 喂入读到的字节。
    pub fn push(&mut self, bytes: &[u8]) {
        self.buf.extend_from_slice(bytes);
    }

    /// 取下一帧；字节不够时返回 `Ok(None)`。
    pub fn next_frame(&mut self) -> Result<Option<Frame>, ProtoError> {
        if !self.synced {
            // 握手帧形如 len(4) kind(1) MAGIC：找到魔数且前面像帧头，回退 5 字节即帧起点。
            let looks_like_header = |at: usize| {
                let len = u32::from_le_bytes(self.buf[at..at + 4].try_into().expect("4 bytes"));
                matches!(self.buf[at + 4], KIND_HELLO | KIND_WELCOME | KIND_REJECT) && len < 4096
            };
            let Some(at) = (0..self.buf.len().saturating_sub(5 + MAGIC.len() - 1)).find(|&at| {
                self.buf[at + 5..at + 5 + MAGIC.len()] == MAGIC && looks_like_header(at)
            }) else {
                let keep = self.buf.len().min(5 + MAGIC.len() - 1);
                self.buf.drain(..self.buf.len() - keep);
                return Ok(None);
            };
            self.buf.drain(..at);
            self.synced = true;
        }
        if self.buf.len() < 4 {
            return Ok(None);
        }
        let len = u32::from_le_bytes(self.buf[..4].try_into().expect("4 bytes")) as usize;
        if len > MAX_FRAME_LEN {
            return Err(ProtoError::TooLarge(len));
        }
        if self.buf.len() < 4 + len {
            return Ok(None);
        }
        let frame = Frame::decode(&self.buf[4..4 + len]);
        self.buf.drain(..4 + len);
        frame.map(Some)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roundtrip(frame: Frame) {
        let bytes = frame.encode();
        assert_eq!(Frame::decode(&bytes[4..]).unwrap(), frame);
    }

    #[test]
    fn frames_roundtrip() {
        let session = SessionId([7; 16]);
        roundtrip(Frame::Hello {
            version: PROTOCOL_VERSION,
            session,
            recv_seq: 42,
        });
        roundtrip(Frame::Welcome {
            version: PROTOCOL_VERSION,
            session,
            recv_seq: 9,
            resumed: true,
        });
        roundtrip(Frame::Reject {
            version: 3,
            reason: "版本不一致".into(),
        });
        roundtrip(Frame::Data(DataFrame {
            flags: flags::FIN | flags::REPLY,
            priority: Priority::Bulk,
            seq: 1,
            ack: 2,
            id: 3,
            payload: b"hello".to_vec(),
        }));
        roundtrip(Frame::Ack { ack: 5 });
        roundtrip(Frame::Ping { token: 6 });
        roundtrip(Frame::Pong { token: 6 });
    }

    #[test]
    fn decoder_skips_shell_noise_and_splits_stream() {
        let welcome = Frame::Welcome {
            version: PROTOCOL_VERSION,
            session: SessionId([1; 16]),
            recv_seq: 0,
            resumed: false,
        };
        let ack = Frame::Ack { ack: 1 };
        let mut stream = b"Last login: yesterday\nBNOD?\n".to_vec();
        stream.extend(welcome.encode());
        stream.extend(ack.encode());
        let mut dec = Decoder::awaiting_handshake();
        let mut got = Vec::new();
        for byte in stream.chunks(3) {
            dec.push(byte);
            while let Some(frame) = dec.next_frame().unwrap() {
                got.push(frame);
            }
        }
        assert_eq!(got, vec![welcome, ack]);
    }

    #[test]
    fn compression_only_when_it_pays() {
        assert!(compress(b"short").is_none());
        let text = "berth ".repeat(200).into_bytes();
        let packed = compress(&text).unwrap();
        assert!(packed.len() < text.len() / 10);
        assert_eq!(decompress(&packed, text.len()).unwrap(), text);
        assert_eq!(decompress(&packed, 10), Err(ProtoError::TooLarge(11)));
    }
}
