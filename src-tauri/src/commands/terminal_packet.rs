//! Tauri-local terminal output packet encoding.

#[cfg(feature = "tauri-runtime")]
pub(crate) const LOCAL_OUTPUT_PACKET: u8 = 1;
#[cfg(feature = "tauri-runtime")]
pub(crate) const LOCAL_RESYNC_PACKET: u8 = 2;
#[cfg(feature = "tauri-runtime")]
pub(crate) const LOCAL_PACKET_HEADER: [u8; 3] = [b'T', b'V', 2];
#[cfg(feature = "tauri-runtime")]
pub(crate) const LOCAL_PACKET_HEADER_BYTES: usize = 20;
#[cfg(feature = "tauri-runtime")]
pub(crate) const LOCAL_OUTPUT_BATCH_MAX_BYTES: usize = 64 * 1024;
#[cfg(feature = "tauri-runtime")]
pub(crate) const LOCAL_OUTPUT_BATCH_MAX_EVENTS: usize = 32;
/// 可见终端两个输出包之间的最短间隔（约 15 包 / 秒）：每包让页面重画一次，WebKitGTK 下
/// 每帧都占宿主主线程；节拍内到达的输出并成一包。
#[cfg(feature = "tauri-runtime")]
pub(crate) const LOCAL_OUTPUT_MIN_INTERVAL: std::time::Duration =
    std::time::Duration::from_millis(67);
/// 页面没在显示的终端：约 1 包 / 秒，只为让页面缓冲跟上，切回来时立即补发。
#[cfg(feature = "tauri-runtime")]
pub(crate) const LOCAL_HIDDEN_OUTPUT_MIN_INTERVAL: std::time::Duration =
    std::time::Duration::from_millis(1000);
/// 用户输入后这段时间内的输出（回显）不等节拍。
#[cfg(feature = "tauri-runtime")]
pub(crate) const LOCAL_INPUT_ECHO_WINDOW: std::time::Duration =
    std::time::Duration::from_millis(100);

#[cfg(feature = "tauri-runtime")]
pub(crate) fn encode_local_terminal_packet(
    kind: u8,
    sequence_start: u64,
    sequence_end: u64,
    data: &[u8],
) -> Vec<u8> {
    let mut packet = Vec::with_capacity(LOCAL_PACKET_HEADER_BYTES + data.len());
    packet.extend_from_slice(&LOCAL_PACKET_HEADER);
    packet.push(kind);
    packet.extend_from_slice(&sequence_start.to_be_bytes());
    packet.extend_from_slice(&sequence_end.to_be_bytes());
    packet.extend_from_slice(data);
    packet
}

#[cfg(all(test, feature = "tauri-runtime"))]
mod tests {
    use super::*;

    #[test]
    fn packet_encoding_has_magic_version_kind_sequence_range_and_raw_payload() {
        assert_eq!(
            encode_local_terminal_packet(LOCAL_OUTPUT_PACKET, 40, 42, &[0xe4, 0xb8, 0xad]),
            [
                b'T',
                b'V',
                2,
                LOCAL_OUTPUT_PACKET,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                40,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                42,
                0xe4,
                0xb8,
                0xad,
            ]
        );
    }
}
