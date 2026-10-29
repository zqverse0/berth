//! 插件（`tools/<id>/tool.json`）的宿主无关核心：资产投影（`asset`）、目录与 id 规则
//! （`paths`/`repository`）、包边界与接入点（`package`）、文件工具（`file_tools`）、
//! 启用状态与安装（`plugins`）、会话与服务商注入声明。
//!
//! CLI（berth-cli）与桌面（berth-gui）是同一实现的两个消费者，不维护第二份 parser。
//! 本 crate 不依赖 Tauri、`app_error` 与终端 SDK。

#![forbid(unsafe_code)]

pub mod asset;
pub mod error;
pub mod experts;
pub mod file_tools;
pub mod manifest;
pub mod package;
pub mod paths;
pub mod plugins;
pub mod provider_injection;
pub mod repository;
pub mod session_files;
pub mod sessions;
