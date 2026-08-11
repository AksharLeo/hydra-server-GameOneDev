//! The settings the panel may change at runtime.
//!
//! Each one exists in three layers — the environment default, an optional
//! saved override, and the value in force — and the screen shows all three,
//! because "why is the quota 5 GB when the compose file says 20" is otherwise
//! an unanswerable question.

use super::AdminSession;
use crate::error::{ApiError, ApiResult};
use crate::events::Event;
use crate::settings as store;
use crate::state::{AppState, RuntimeSettings};
use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

pub fn router() -> Router<AppState> {
    Router::new().route(
        "/admin/api/settings",
        get(get_settings).put(update_settings).delete(reset_settings),
    )
}

async fn payload(state: &AppState) -> ApiResult<Json<Value>> {
    let current = state.settings.read().await.clone();
    let defaults = RuntimeSettings::from_config(&state.config);

    let overrides: Vec<(String, String, String)> =
        sqlx::query_as("SELECT key, value, updated_at FROM server_settings")
            .fetch_all(&state.pool)
            .await?;

    Ok(Json(json!({
        "current": {
            "maxBytesPerUser": current.max_bytes_per_user,
            "backupsPerGameLimit": current.backups_per_game_limit,
            "allowedUsers": current.allowed_users,
        },
        "defaults": {
            "maxBytesPerUser": defaults.max_bytes_per_user,
            "backupsPerGameLimit": defaults.backups_per_game_limit,
            "allowedUsers": defaults.allowed_users,
        },
        "overrides": overrides.iter().map(|(key, value, updated_at)| json!({
            "key": key,
            "value": value,
            "updatedAt": updated_at,
        })).collect::<Vec<_>>(),
        "environment": {
            "publicUrl": state.config.public_url,
            "officialApiUrl": state.config.official_api_url,
            "dataDir": state.config.data_dir.display().to_string(),
            "bind": state.config.bind,
        },
    })))
}

async fn get_settings(State(state): State<AppState>, _admin: AdminSession) -> ApiResult<Json<Value>> {
    payload(&state).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateRequest {
    max_bytes_per_user: Option<u64>,
    backups_per_game_limit: Option<u32>,
    allowed_users: Option<Vec<String>>,
}

/// PUT /admin/api/settings — persists the provided fields as overrides of the
/// environment defaults and applies them immediately.
async fn update_settings(
    State(state): State<AppState>,
    _admin: AdminSession,
    Json(request): Json<UpdateRequest>,
) -> ApiResult<Json<Value>> {
    if let Some(max_bytes) = request.max_bytes_per_user {
        store::set(&state.pool, store::MAX_BYTES_PER_USER, &max_bytes.to_string()).await?;
    }

    if let Some(limit) = request.backups_per_game_limit {
        if limit == 0 {
            return Err(ApiError::bad_request("backups per game must be at least 1"));
        }
        store::set(
            &state.pool,
            store::BACKUPS_PER_GAME_LIMIT,
            &limit.to_string(),
        )
        .await?;
    }

    if let Some(users) = request.allowed_users {
        let normalized = store::parse_allowed_users(&users.join(","));
        store::set(&state.pool, store::ALLOWED_USERS, &normalized.join(",")).await?;
    }

    reload(&state).await;

    let current = state.settings.read().await.clone();
    crate::events::record(
        &state,
        Event::admin("admin.settings.updated", "Settings changed")
            .detail(json!({
                "maxBytesPerUser": current.max_bytes_per_user,
                "backupsPerGameLimit": current.backups_per_game_limit,
                "allowedUsers": current.allowed_users,
            })),
    )
    .await;

    payload(&state).await
}

/// DELETE /admin/api/settings — clears every override, back to env values.
async fn reset_settings(
    State(state): State<AppState>,
    _admin: AdminSession,
) -> ApiResult<Json<Value>> {
    store::clear(&state.pool).await?;
    reload(&state).await;

    crate::events::record(
        &state,
        Event::admin("admin.settings.reset", "Settings reset to the environment values"),
    )
    .await;

    payload(&state).await
}

async fn reload(state: &AppState) {
    let reloaded = store::load(&state.pool, &state.config).await;
    *state.settings.write().await = reloaded;
}
