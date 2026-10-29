//! Tool runtime — Tool Asset Protocol 的核心后端模块。
//!
//! `tools/<id>/tool.json`（`BERTH_HOME/tools`，不跟随 `BERTH_DATA_DIR`）
//! 是唯一资产入口：`asset` 开放投影、`asset_repository` 文件读写、
//! `agent_projection` agent 身份投影、`profile` 消费面投影、`capability_status`
//! 能力落点扫描。本模块是任意 CLI 的长期缝合点，绝不按品牌（claude/codex/pi…）分支。
//! Agent 启动只认 `tools/<id>/launch.js`；tool.json 的 actions 已退役（docs/REMOVED.md）。

pub mod agent_projection;
pub mod asset;
pub mod asset_repository;
pub mod path;
pub mod profile;
