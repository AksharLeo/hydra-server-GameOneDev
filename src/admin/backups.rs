//! Database backups, from the panel.

use super::AdminSession;
use crate::backup;
use crate::error::{ApiError, ApiResult};
use crate::events::Event;
use crate::state::AppState;
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{header, StatusCode};
use axum::response::Response;
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{json, Value};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/admin/api/backups", get(list).post(create))
        .route("/admin/api/backups/{name}", axum::routing::delete(remove))
        .route("/admin/api/backups/{name}/download", get(download))
}

/// GET /admin/api/backups — what exists, and whether the volume has room for
/// another one.
async fn list(State(state): State<AppState>, _admin: AdminSession) -> ApiResult<Json<Value>> {
    let backups = backup::list(&state).await;
    let data_dir = &state.config.data_dir;

    Ok(Json(json!({
        "backups": backups.iter().map(backup::backup_json).collect::<Vec<_>>(),
        "directory": state.config.backup_dir().display().to_string(),
        "schedule": {
            "intervalHours": state.config.backup_interval_hours,
            "keep": state.config.backup_keep,
        },
        "disk": {
            "freeBytes": backup::free_disk_bytes(data_dir),
            "totalBytes": backup::total_disk_bytes(data_dir),
        },
    })))
}

async fn create(State(state): State<AppState>, _admin: AdminSession) -> ApiResult<Json<Value>> {
    let backup = backup::create(&state, "manual")
        .await
        .map_err(ApiError::internal)?;

    Ok(Json(json!({ "ok": true, "backup": backup::backup_json(&backup) })))
}

/// Streams a backup file. Useful precisely when the server itself is in
/// trouble, so it must not need any other tool to work.
async fn download(
    State(state): State<AppState>,
    _admin: AdminSession,
    Path(name): Path<String>,
) -> ApiResult<Response> {
    let path = backup::path_for(&state, &name)
        .ok_or_else(|| ApiError::bad_request("invalid backup name"))?;

    let file = tokio::fs::File::open(&path)
        .await
        .map_err(|_| ApiError::not_found("backup not found"))?;
    let length = file.metadata().await?.len();

    crate::events::record(
        &state,
        Event::admin("admin.backup.downloaded", format!("Downloaded backup {name}"))
            .detail(json!({ "name": name }))
            .size(length as i64),
    )
    .await;

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(header::CONTENT_LENGTH, length)
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{name}\""),
        )
        .body(Body::from_stream(tokio_util::io::ReaderStream::new(file)))
        .map_err(|_| ApiError::internal("failed to build response"))
}

async fn remove(
    State(state): State<AppState>,
    _admin: AdminSession,
    Path(name): Path<String>,
) -> ApiResult<Json<Value>> {
    let path = backup::path_for(&state, &name)
        .ok_or_else(|| ApiError::bad_request("invalid backup name"))?;

    tokio::fs::remove_file(&path)
        .await
        .map_err(|_| ApiError::not_found("backup not found"))?;

    crate::events::record(
        &state,
        Event::admin("admin.backup.deleted", format!("Deleted backup {name}"))
            .detail(json!({ "name": name })),
    )
    .await;

    Ok(Json(json!({ "ok": true })))
}
