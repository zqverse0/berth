use sea_orm::{
    ActiveModelTrait, ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, Set,
};

use berth_project_core::entities::model_provider_overlay;
use berth_project_core::error::DbError;

pub async fn list_for_provider(
    conn: &DatabaseConnection,
    provider_id: i32,
) -> Result<Vec<model_provider_overlay::Model>, DbError> {
    Ok(model_provider_overlay::Entity::find()
        .filter(model_provider_overlay::Column::ProviderId.eq(provider_id))
        .all(conn)
        .await?)
}

pub async fn get(
    conn: &DatabaseConnection,
    provider_id: i32,
    agent_type: &str,
) -> Result<Option<model_provider_overlay::Model>, DbError> {
    Ok(model_provider_overlay::Entity::find()
        .filter(model_provider_overlay::Column::ProviderId.eq(provider_id))
        .filter(model_provider_overlay::Column::AgentType.eq(agent_type))
        .one(conn)
        .await?)
}

pub async fn upsert(
    conn: &DatabaseConnection,
    provider_id: i32,
    agent_type: String,
    models_json: String,
) -> Result<model_provider_overlay::Model, DbError> {
    if let Some(existing) = get(conn, provider_id, &agent_type).await? {
        let mut active: model_provider_overlay::ActiveModel = existing.into();
        active.models_json = Set(models_json);
        return Ok(active.update(conn).await?);
    }
    let active = model_provider_overlay::ActiveModel {
        provider_id: Set(provider_id),
        agent_type: Set(agent_type),
        models_json: Set(models_json),
    };
    Ok(active.insert(conn).await?)
}

pub async fn delete_for_provider(
    conn: &DatabaseConnection,
    provider_id: i32,
) -> Result<(), DbError> {
    model_provider_overlay::Entity::delete_many()
        .filter(model_provider_overlay::Column::ProviderId.eq(provider_id))
        .exec(conn)
        .await?;
    Ok(())
}
