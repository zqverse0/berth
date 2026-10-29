use chrono::Utc;
use sea_orm::{
    ActiveModelTrait, ActiveValue::NotSet, DatabaseConnection, EntityTrait, IntoActiveModel,
    QueryOrder, Set,
};

use berth_project_core::entities::model_provider::{self, KIND_CUSTOM, KIND_OFFICIAL};
use berth_project_core::error::DbError;

pub async fn create(
    conn: &DatabaseConnection,
    name: String,
    api_url: String,
    api_key: String,
    agent_type: String,
    model: Option<String>,
    website: Option<String>,
) -> Result<model_provider::Model, DbError> {
    create_with_kind(
        conn,
        name,
        api_url,
        api_key,
        agent_type,
        model,
        website,
        KIND_CUSTOM.to_string(),
    )
    .await
}

pub async fn create_with_kind(
    conn: &DatabaseConnection,
    name: String,
    api_url: String,
    api_key: String,
    agent_type: String,
    model: Option<String>,
    website: Option<String>,
    kind: String,
) -> Result<model_provider::Model, DbError> {
    let now = Utc::now();
    let agent_types_json =
        serde_json::to_string(&vec![agent_type.clone()]).unwrap_or_else(|_| "[]".to_string());
    let allowlist = if kind == KIND_CUSTOM {
        "[]".to_string()
    } else {
        serde_json::to_string(&vec![agent_type.clone()]).unwrap_or_else(|_| "[]".to_string())
    };
    let flavor = if agent_type == "claude_code" {
        "anthropic"
    } else {
        "openai"
    };
    let active = model_provider::ActiveModel {
        id: NotSet,
        name: Set(name),
        api_url: Set(api_url),
        api_key: Set(api_key),
        agent_types_json: Set(agent_types_json),
        agent_type: Set(agent_type),
        model: Set(model),
        website: Set(website),
        kind: Set(kind),
        flavor: Set(flavor.to_string()),
        discovery_json: Set(None),
        agent_allowlist: Set(allowlist),
        created_at: Set(now),
        updated_at: Set(now),
    };
    Ok(active.insert(conn).await?)
}

pub async fn update(
    conn: &DatabaseConnection,
    id: i32,
    name: Option<String>,
    api_url: Option<String>,
    api_key: Option<String>,
    agent_type: Option<String>,
    model: Option<Option<String>>,
    website: Option<String>,
) -> Result<model_provider::Model, DbError> {
    let model_row = model_provider::Entity::find_by_id(id)
        .one(conn)
        .await?
        .ok_or_else(|| DbError::Migration(format!("model provider not found: {id}")))?;

    let mut active = model_row.into_active_model();
    if let Some(v) = name {
        active.name = Set(v);
    }
    if let Some(v) = api_url {
        active.api_url = Set(v);
    }
    if let Some(v) = api_key {
        active.api_key = Set(v);
    }
    if let Some(v) = agent_type {
        let agent_types_json =
            serde_json::to_string(&vec![v.clone()]).unwrap_or_else(|_| "[]".to_string());
        active.agent_types_json = Set(agent_types_json);
        active.agent_type = Set(v);
    }
    if let Some(v) = model {
        active.model = Set(v);
    }
    if let Some(v) = website {
        active.website = Set(Some(v));
    }
    active.updated_at = Set(Utc::now());
    Ok(active.update(conn).await?)
}

pub async fn update_meta(
    conn: &DatabaseConnection,
    id: i32,
    flavor: Option<String>,
    discovery_json: Option<Option<String>>,
    agent_allowlist: Option<String>,
    kind: Option<String>,
) -> Result<model_provider::Model, DbError> {
    let model_row = model_provider::Entity::find_by_id(id)
        .one(conn)
        .await?
        .ok_or_else(|| DbError::Migration(format!("model provider not found: {id}")))?;
    let mut active = model_row.into_active_model();
    if let Some(v) = flavor {
        active.flavor = Set(v);
    }
    if let Some(v) = discovery_json {
        active.discovery_json = Set(v);
    }
    if let Some(v) = agent_allowlist {
        active.agent_allowlist = Set(v);
    }
    if let Some(v) = kind {
        active.kind = Set(v);
    }
    active.updated_at = Set(Utc::now());
    Ok(active.update(conn).await?)
}

pub async fn delete(conn: &DatabaseConnection, id: i32) -> Result<(), DbError> {
    model_provider::Entity::delete_by_id(id).exec(conn).await?;
    Ok(())
}

pub async fn get_by_id(
    conn: &DatabaseConnection,
    id: i32,
) -> Result<Option<model_provider::Model>, DbError> {
    Ok(model_provider::Entity::find_by_id(id).one(conn).await?)
}

pub async fn list_all(conn: &DatabaseConnection) -> Result<Vec<model_provider::Model>, DbError> {
    let mut rows = model_provider::Entity::find()
        .order_by_asc(model_provider::Column::Id)
        .all(conn)
        .await?;
    // 官方登录排在中转站前面,启动栏与设置页共用这一顺序。
    rows.sort_by(|left, right| {
        match (
            left.kind.as_str() == KIND_OFFICIAL,
            right.kind.as_str() == KIND_OFFICIAL,
        ) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => left.id.cmp(&right.id),
        }
    });
    Ok(rows)
}
