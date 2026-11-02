#![deny(missing_docs)]
#![forbid(unsafe_code)]

//! Berth 节点协议：两台设备上的 Berth 之间经一条字节流（第一版是 ssh 的 stdin/stdout）通信。
//!
//! 这一层与连接方式无关：[`Session`] 是不做 IO 的状态机，调用方把收到的帧喂进去、把要发的帧取出来；
//! 断线后换一条新字节流重新握手即可续上。GUI（客户端）与 `berth node stdio`（服务端）共用这一份实现。
//!
//! # 帧格式（协议版本 [`PROTOCOL_VERSION`]）
//!
//! 所有整数小端。每帧：
//!
//! ```text
//! u32 len        之后的字节数（kind + body），上限 MAX_FRAME_LEN
//! u8  kind
//! ..  body
//! ```
//!
//! | kind | 名称 | body |
//! |---|---|---|
//! | 1 | Hello   | `"BNOD"` u16 version, [u8;16] session, u64 recv_seq |
//! | 2 | Welcome | `"BNOD"` u16 version, [u8;16] session, u64 recv_seq, u8 resumed |
//! | 3 | Reject  | `"BNOD"` u16 version, utf8 reason（版本不一致等，发完即关） |
//! | 4 | Data    | u8 flags, u8 priority, u64 seq, u64 ack, u64 id, payload |
//! | 5 | Ack     | u64 ack |
//! | 6 | Ping    | u64 token |
//! | 7 | Pong    | u64 token |
//!
//! - 握手：客户端每条新字节流先发 Hello（带上次的会话 id 与已收到的连续序号），服务端回 Welcome
//!   （`resumed=1` 表示会话还在）。版本号不一致服务端回 Reject 后断开，不做兼容。
//!   握手帧带魔数 `BNOD`，客户端读服务端输出时跳过魔数之前的杂字节（远端 shell 启动脚本可能打印内容）。
//! - Data：`seq` 每个方向从 1 递增，只给 Data 编号；`ack` 是捎带的累计确认（已连续收到的最大 seq）。
//!   `id` 是消息 id：大消息切成多块同 id 发送，最后一块带 FIN；回复与请求同 id、带 REPLY。
//!   flags：`FIN=1`、`REPLY=2`、`ZSTD=4`（payload 经 zstd 压缩）、`CANCEL=8`（撤销该 id 的消息，payload 为空）。
//!   priority：`0` 交互、`1` 普通、`2` 后台。
//! - 续传：断线后已确认（seq ≤ 对方 recv_seq）的帧不重发，其余按原 seq 重发；收方按 seq 去重，
//!   因此每条消息恰好交付一次。
//! - Ack / Ping / Pong 不编号、不重发。

pub mod api;
pub mod cache;
pub mod client;
pub mod frame;
mod sched;
pub mod session;
pub mod sim;
pub mod transfer;

pub use frame::{
    DataFrame, Decoder, Frame, Priority, ProtoError, SessionId, MAX_FRAME_LEN, PROTOCOL_VERSION,
};
pub use session::{Event, Message, Outgoing, Role, Session, Stats};
