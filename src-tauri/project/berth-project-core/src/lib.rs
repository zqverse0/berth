//! Berth 项目持久化核心。
//!
//! 本 crate 是项目事实（SQLite）的唯一 owner：实体定义、全部历史迁移、
//! 数据实例解析、项目领域服务与唯一的迁移入口 [`open::open_or_upgrade`]；
//! 以及项目里 `.berth/` 工作流目录：唯一创建入口 [`berth_dir::init`] 与知识库扫描 / 体检 [`knowledge`]。
//! 桌面宿主（`berth-gui`）与 CLI（`berth-cli`）消费同一份投影，禁止任一侧
//! 复制 SQL、DTO 或迁移清单。
//!
//! 依赖方向：GUI/CLI → 本 crate；本 crate 不得反向依赖 Tauri、clap 或进程生命周期。

pub mod agent;
pub mod berth_dir;
pub mod credentials;
pub mod entities;
pub mod error;
pub mod instance;
pub mod knowledge;
pub mod migration;
pub mod open;
pub mod runtime;
pub mod service;
pub mod tasks;

pub use error::DbError;
