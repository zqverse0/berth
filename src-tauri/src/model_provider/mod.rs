//! 模型服务商领域(Rust)。
//!
//! 两块职责在同一域内:
//!
//! 1. **服务商档案与启动注入**: 按 tool.json Agent extension 的 `providerInjection`
//!    声明(声明 schema 由 tool 体系定义),把用户选中的服务商档案(url / key / 模型)
//!    展开成启动 env / argv(`injection`),以及 agent ↔ 档案绑定的读写(`binding`)。
//! 2. **账号用量与模型目录查询**(原 `account_usage` 模块): `declared` 是通用声明式
//!    查询底层(凭据解析、HTTPS/超时/上限、JSON Pointer 映射、失败分类);
//!    `usage` 承载用量语义(窗口映射、read_all/read_for_agent);`balance`
//!    承载站点余额(内置模板 + 用户 `provider-usage/<id>.json`);`commands`
//!    提供 3 个 Tauri 命令(状态栏轮询、档案余额点查、官方档案用量点查)。
//!
//! 依赖方向(单向):本模块 → `crate::tool`(读工具资产声明与 agent 身份)、
//! `crate::platform::paths`(数据根)、`crate::db`(绑定与档案存储)、`crate::app_error`。
//! `tool` 不反向依赖本模块——provider 是 tool 声明的消费方,不是 tool 核心的一部分。
//!
//! 档案 CRUD(`model_provider_service` / `commands/model_provider` 的 CRUD 命令)
//! 是设置页既有链路,维持原位;本目录收"启动注入与绑定"以及"账号用量/模型查询"
//! 两条链路,方便独立演化。
//!
//! 边界:契约解析不在本模块(见 `tool`);query 声明是用户资产,含 URL/指针,
//! 宿主不按品牌分支;命令挂在领域模块内(同 `skills` 先例),lib.rs 直接注册。

pub mod balance;
pub mod binding;
pub mod commands;
pub mod declared;
pub mod usage;
pub mod import;
pub mod injection;
pub mod login;
pub mod models;
pub mod proxy;
pub mod secrets;
pub mod systemone;

/// 契约与 wire 类型。声明是用户资产的一部分,类型保持可达以便其他模块与测试引用。
pub use declared::{AuthHeaderSpec, DeclaredJsonRequest, QueryValue, UsageCredentialSpec};
pub use usage::{
    UsageDeclaration, UsageDiagnostic, UsageState, UsageStatus, UsageWindow, UsageWindowSpec,
};

