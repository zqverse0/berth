//! 项目 session 的版本化命名与归属分类，不读取 DB、cwd 或 daemon。

use uuid::Uuid;

use crate::service::catalog::CatalogEntry;

const PROJECT_SESSION_PREFIX: &str = "berth-project-v1-";
const RESERVED_PROJECT_PREFIX: &str = "berth-project";
const NAMESPACE_LENGTH: usize = 64;
const UUID_LENGTH: usize = 36;

/// 已校验的 session key 内容；实例摘要和项目 UUID 缺一不可。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectSessionKey {
    pub data_instance_key: String,
    pub project_runtime_id: String,
}

/// 不能生成可证明归属的项目 session key。
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum RuntimeIdentityError {
    #[error("data instance key must be a lowercase SHA-256 digest")]
    InvalidNamespace,
    #[error("project runtime id must be a non-nil canonical UUID")]
    InvalidProjectRuntimeId,
}

/// 只有唯一命中当前实例 catalog 的版本化 key 才证明项目归属。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionOwnership<'a> {
    Project(&'a CatalogEntry),
    Foreign,
    LegacyUnresolved,
    Independent,
}

fn valid_namespace(value: &str) -> bool {
    value.len() == NAMESPACE_LENGTH
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_project_id(value: &str) -> bool {
    value.len() == UUID_LENGTH
        && Uuid::parse_str(value)
            .is_ok_and(|id| !id.is_nil() && id.hyphenated().to_string() == value)
}

/// 生成仅含 ASCII 字母数字和连字符的 118 字节名称，SessionName 不会重写它。
pub fn project_session_key(
    data_instance_key: &str,
    project_runtime_id: &str,
) -> Result<String, RuntimeIdentityError> {
    if !valid_namespace(data_instance_key) {
        return Err(RuntimeIdentityError::InvalidNamespace);
    }
    if !valid_project_id(project_runtime_id) {
        return Err(RuntimeIdentityError::InvalidProjectRuntimeId);
    }
    Ok(format!(
        "{PROJECT_SESSION_PREFIX}{data_instance_key}-{project_runtime_id}"
    ))
}

/// 严格解析当前格式，不接受未知版本、非规范 UUID 或额外 target 后缀。
pub fn parse_project_session_key(name: &str) -> Option<ProjectSessionKey> {
    let suffix = name.strip_prefix(PROJECT_SESSION_PREFIX)?;
    if suffix.len() != NAMESPACE_LENGTH + 1 + UUID_LENGTH {
        return None;
    }
    let (data_instance_key, project_runtime_id) = suffix.split_once('-')?;
    if !valid_namespace(data_instance_key) || !valid_project_id(project_runtime_id) {
        return None;
    }
    Some(ProjectSessionKey {
        data_instance_key: data_instance_key.to_owned(),
        project_runtime_id: project_runtime_id.to_owned(),
    })
}

/// 按持久身份分类；裸数字和未知/畸形项目 key 只标记 unresolved，绝不猜 owner。
///
/// 调用方传入同实例完整 catalog；这里不根据标题、folder.id 或 cwd 选第一项。
pub fn classify_session<'a>(
    name: &str,
    data_instance_key: &str,
    catalog: &'a [CatalogEntry],
) -> SessionOwnership<'a> {
    if let Some(key) = parse_project_session_key(name) {
        if key.data_instance_key != data_instance_key {
            return SessionOwnership::Foreign;
        }
        let mut matches = catalog
            .iter()
            .filter(|entry| entry.project_runtime_id == key.project_runtime_id);
        return match (matches.next(), matches.next()) {
            (Some(project), None) => SessionOwnership::Project(project),
            _ => SessionOwnership::LegacyUnresolved,
        };
    }
    if name.starts_with(RESERVED_PROJECT_PREFIX) || name.bytes().all(|byte| byte.is_ascii_digit()) {
        SessionOwnership::LegacyUnresolved
    } else {
        SessionOwnership::Independent
    }
}
