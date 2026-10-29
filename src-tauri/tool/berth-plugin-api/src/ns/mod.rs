//! 命名空间实现：每个文件一个命名空间，只做「消息 ↔ 宿主能力」转换（docs/plugin-architecture.md §6）。

pub mod data;
pub mod env;
pub mod fs;
pub mod process;
pub mod storage;
