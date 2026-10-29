use sea_orm::{ActiveModelTrait, DatabaseConnection, Set};

use crate::platform::keyring_store;
use berth_project_core::entities::model_provider;
use berth_project_core::error::DbError;
use berth_project_core::service::model_provider_launch::{merge_secrets, split_secrets, SecretMap};

/// 读取 API key：优先本地凭据文件，其次迁出 DB 明文列。
pub async fn load_api_key(
    conn: &DatabaseConnection,
    provider: &model_provider::Model,
) -> Result<String, DbError> {
    let id = provider.id;
    let key = keyring_store::run_blocking(move || keyring_store::get_model_provider_api_key(id))
        .await
        .and_then(|value| value)
        .map_err(|error| DbError::Io(std::io::Error::other(error)))?;
    if let Some(key) = key {
        if !key.trim().is_empty() {
            return Ok(key);
        }
    }
    let leftover = provider.api_key.trim();
    if leftover.is_empty() {
        return Ok(String::new());
    }
    let key = leftover.to_string();
    if keyring_store::run_blocking(move || keyring_store::set_model_provider_api_key(id, &key))
        .await
        .map_err(|error| DbError::Io(std::io::Error::other(error)))?
        .is_ok()
    {
        let mut active: model_provider::ActiveModel = provider.clone().into();
        active.api_key = Set(String::new());
        let _ = active.update(conn).await;
    }
    Ok(leftover.to_string())
}

/// 启动时把系统钥匙串里的旧服务商凭据导入本地文件（每个实例一次，见 keyring_store）。
#[cfg(feature = "tauri-runtime")]
pub async fn import_legacy_keyring(conn: DatabaseConnection) {
    let ids = match crate::db::service::model_provider_service::list_all(&conn).await {
        Ok(rows) => rows.into_iter().map(|row| row.id).collect(),
        Err(error) => {
            tracing::warn!("[provider-credentials] legacy keyring import skipped: {error}");
            return;
        }
    };
    match keyring_store::import_legacy_provider_credentials(ids).await {
        Ok(0) => {}
        Ok(count) => {
            tracing::info!(
                "[provider-credentials] imported {count} credentials from the system keyring"
            )
        }
        Err(error) => {
            tracing::warn!(
                "[provider-credentials] legacy keyring import failed, retrying next start: {error}"
            )
        }
    }
}

pub async fn store_api_key(provider_id: i32, api_key: &str) -> Result<(), String> {
    let api_key = api_key.to_string();
    keyring_store::run_blocking(move || {
        keyring_store::set_model_provider_api_key(provider_id, &api_key)
    })
    .await?
}

pub async fn delete_api_key(provider_id: i32) -> Result<(), String> {
    keyring_store::run_blocking(move || keyring_store::delete_model_provider_api_key(provider_id))
        .await?
}

pub async fn delete_discovery_secrets(provider_id: i32) -> Result<(), String> {
    keyring_store::run_blocking(move || keyring_store::delete_model_provider_secrets(provider_id))
        .await?
}

// ── discovery_json 内的分组 / 端点 Key ──
//
// 库里只存清洗后的 JSON（Key 字段为空串）；Key 整份存放在本地凭据文件里，
// 形如 `{"group:<id>": "...", "endpoint:<protocol>": "..."}`。DTO 形态不变：
// 读出时回填，所以设置页与启动注入都看不到差别。

/// 保存时的 Key 集合：只保留新 JSON 里还存在的槽位（移除分组 = 删 Key）；
/// 提交为空串的槽位沿用旧值（与主 Key「留空 = 不变」一致）。
fn next_secrets(slots: &[String], incoming: SecretMap, previous: &SecretMap) -> SecretMap {
    slots
        .iter()
        .filter_map(|slot| {
            incoming
                .get(slot)
                .or_else(|| previous.get(slot))
                .map(|key| (slot.clone(), key.clone()))
        })
        .collect()
}

fn read_secrets(provider_id: i32) -> Result<SecretMap, String> {
    keyring_store::get_model_provider_secrets(provider_id)?
        .map(|raw| {
            serde_json::from_str(&raw)
                .map_err(|_| "Invalid local provider discovery credentials".to_string())
        })
        .unwrap_or_else(|| Ok(SecretMap::new()))
}

fn write_secrets(provider_id: i32, secrets: &SecretMap) -> Result<(), String> {
    if secrets.is_empty() {
        return keyring_store::delete_model_provider_secrets(provider_id);
    }
    let raw = serde_json::to_string(secrets).map_err(|error| error.to_string())?;
    keyring_store::set_model_provider_secrets(provider_id, &raw)
}

/// 写路径：把入参里的 Key 存进本地凭据文件，返回应落库的清洗后 JSON。
/// 本地凭据文件写失败则整次保存报错，绝不降级为明文落库。
pub async fn store_discovery(
    provider_id: i32,
    incoming: Option<String>,
) -> Result<Option<String>, String> {
    let Some(raw) = incoming else {
        return Ok(None);
    };
    let Some((sanitized, secrets, slots)) = split_secrets(&raw) else {
        return Ok(Some(raw));
    };
    keyring_store::run_blocking(move || {
        let next = next_secrets(&slots, secrets, &read_secrets(provider_id)?);
        write_secrets(provider_id, &next)
    })
    .await??;
    Ok(Some(sanitized))
}

/// 读路径：返回回填了 Key 的 discovery_json。库里还有旧明文时先迁进本地凭据文件，
/// 写入成功才把清洗后的 JSON 写回库；失败则不动库、照常返回（绝不丢 Key）。
pub async fn load_discovery(
    conn: &DatabaseConnection,
    provider: &model_provider::Model,
) -> Result<Option<String>, DbError> {
    let Some(raw) = provider.discovery_json.as_deref() else {
        return Ok(None);
    };
    let Some((sanitized, legacy, _)) = split_secrets(raw) else {
        return Ok(Some(raw.to_string()));
    };
    let id = provider.id;
    let mut secrets = keyring_store::run_blocking(move || read_secrets(id))
        .await
        .and_then(|value| value)
        .map_err(|error| DbError::Io(std::io::Error::other(error)))?;
    if !legacy.is_empty() {
        secrets.extend(legacy);
        let stored = secrets.clone();
        if keyring_store::run_blocking(move || write_secrets(id, &stored))
            .await
            .map_err(|error| DbError::Io(std::io::Error::other(error)))?
            .is_ok()
        {
            let _ = crate::db::service::model_provider_service::update_meta(
                conn,
                provider.id,
                None,
                Some(Some(sanitized.clone())),
                None,
                None,
            )
            .await;
        }
    }
    Ok(Some(merge_secrets(&sanitized, &secrets)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn next_secrets_keeps_blank_slots_and_drops_removed_groups() {
        let previous = SecretMap::from([
            ("group:1".into(), "old-a".into()),
            ("group:2".into(), "old-b".into()),
        ]);
        // 分组 2 被移除，分组 1 提交为空串（未变更），新增分组 3。
        let slots = vec!["group:1".to_string(), "group:3".to_string()];
        let incoming = SecretMap::from([("group:3".into(), "new-c".into())]);
        assert_eq!(
            next_secrets(&slots, incoming, &previous),
            SecretMap::from([
                ("group:1".into(), "old-a".into()),
                ("group:3".into(), "new-c".into()),
            ])
        );
    }
}
