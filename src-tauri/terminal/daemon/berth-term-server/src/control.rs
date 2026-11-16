/// 命令队列执行一组已解析命令的结果。
#[derive(Debug, Clone)]
pub(crate) struct ControlCommandResult {
    pub(crate) stdout: Vec<u8>,
    pub(crate) error: Option<berth_term_proto::TerminalError>,
}
