use crate::error::{ApiError, ApiResult};
use crate::state::{AppState, RuntimeSettings};
use crate::{cloud_saves, games, settings, storage};
use axum::extract::{FromRequestParts, Path, Query, State};
use axum::http::{header, request::Parts};
use axum::response::{Html, IntoResponse, Redirect, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use chrono::Utc;
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::Row;

const SESSION_TTL_SECONDS: i64 = 60 * 60 * 12;
const COOKIE_NAME: &str = "hydra_admin";

#[derive(Serialize, Deserialize)]
struct AdminClaims {
    typ: String,
    exp: i64,
}

/// Extractor guarding every admin endpoint with the session cookie.
pub struct AdminSession;

impl FromRequestParts<AppState> for AdminSession {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        if state.config.admin_password.is_empty() {
            return Err(ApiError::forbidden(
                "admin panel disabled — set HYDRA_ADMIN_PASSWORD",
            ));
        }

        let token = parts
            .headers
            .get(header::COOKIE)
            .and_then(|value| value.to_str().ok())
            .and_then(|cookies| {
                cookies.split(';').find_map(|cookie| {
                    cookie
                        .trim()
                        .strip_prefix(&format!("{COOKIE_NAME}="))
                        .map(str::to_string)
                })
            })
            .ok_or_else(|| ApiError::unauthorized("admin login required"))?;

        let claims = decode::<AdminClaims>(
            &token,
            &DecodingKey::from_secret(state.config.secret.as_bytes()),
            &Validation::new(Algorithm::HS256),
        )
        .map_err(|_| ApiError::unauthorized("admin session expired"))?
        .claims;

        if claims.typ != "admin" {
            return Err(ApiError::unauthorized("invalid admin session"));
        }

        Ok(AdminSession)
    }
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/admin", get(index))
        .route("/admin/api/login", post(login))
        .route("/admin/api/logout", post(logout))
        .route("/admin/api/overview", get(overview))
        .route(
            "/admin/api/settings",
            get(get_settings).put(update_settings).delete(reset_settings),
        )
        .route("/admin/api/games/{shop}/{object_id}", get(game_info))
        .route("/admin/api/playtime", get(playtime_heatmap))
        .route("/admin/api/users", get(list_users))
        .route("/admin/api/users/{id}", get(user_details).delete(delete_user))
        .route("/admin/api/users/{id}/block", post(set_blocked))
        .route("/admin/api/artifacts/{id}", delete(delete_artifact))
        .route("/admin/api/artifacts/{id}/download", get(download_artifact))
        .route("/admin/api/cloud-saves/{id}", delete(delete_snapshot))
        .route("/admin/api/cloud-saves/{id}/files", get(snapshot_files))
        .route(
            "/admin/api/cloud-saves/{id}/files/{hash}/download",
            get(download_snapshot_file),
        )
        .route("/admin/api/emulation-saves/{id}", delete(delete_emulation_save))
}

async fn index() -> Html<&'static str> {
    Html(include_str!("../static/admin.html"))
}

#[derive(Deserialize)]
struct LoginRequest {
    password: String,
}

async fn login(
    State(state): State<AppState>,
    Json(payload): Json<LoginRequest>,
) -> ApiResult<Response> {
    if state.config.admin_password.is_empty() {
        return Err(ApiError::forbidden(
            "admin panel disabled — set HYDRA_ADMIN_PASSWORD",
        ));
    }

    /* constant-time-ish comparison to avoid trivially timing the password */
    let expected = state.config.admin_password.as_bytes();
    let given = payload.password.as_bytes();
    let matches = expected.len() == given.len()
        && expected
            .iter()
            .zip(given)
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            == 0;

    if !matches {
        return Err(ApiError::unauthorized("wrong password"));
    }

    let token = encode(
        &Header::default(),
        &AdminClaims {
            typ: "admin".to_string(),
            exp: Utc::now().timestamp() + SESSION_TTL_SECONDS,
        },
        &EncodingKey::from_secret(state.config.secret.as_bytes()),
    )
    .map_err(|_| ApiError::internal("failed to create session"))?;

    let cookie =
        format!("{COOKIE_NAME}={token}; HttpOnly; Path=/; Max-Age={SESSION_TTL_SECONDS}; SameSite=Strict");

    Ok(([(header::SET_COOKIE, cookie)], Json(json!({ "ok": true }))).into_response())
}

async fn logout() -> Response {
    let cookie = format!("{COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict");
    ([(header::SET_COOKIE, cookie)], Json(json!({ "ok": true }))).into_response()
}

async fn overview(State(state): State<AppState>, _admin: AdminSession) -> ApiResult<Json<Value>> {
    let user_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
        .fetch_one(&state.pool)
        .await?;
    let blocked_user_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE is_blocked = 1")
            .fetch_one(&state.pool)
            .await?;
    let artifact_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM artifacts")
        .fetch_one(&state.pool)
        .await?;
    let artifact_bytes: i64 =
        sqlx::query_scalar("SELECT COALESCE(SUM(artifact_length_in_bytes), 0) FROM artifacts")
            .fetch_one(&state.pool)
            .await?;
    let save_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM emulation_saves")
        .fetch_one(&state.pool)
        .await?;
    let save_bytes: i64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(artifact_length_in_bytes), 0) FROM emulation_saves",
    )
    .fetch_one(&state.pool)
    .await?;
    /* Cloud Save V2. One committed snapshot exists per game, so counting them
       counts synced games; pending ones are uploads still in flight (or
       abandoned, until the sweep drops them) and are reported separately so a
       stuck upload is visible. Bytes come from the blob table rather than the
       snapshots' declared sizes: blobs are deduplicated per user, and that is
       what actually occupies disk and the quota. */
    let cloud_save_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM cloud_save_snapshots WHERE status = 'committed'")
            .fetch_one(&state.pool)
            .await?;
    let pending_cloud_save_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM cloud_save_snapshots WHERE status = 'pending'")
            .fetch_one(&state.pool)
            .await?;
    let cloud_save_file_count: i64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(file_count), 0) FROM cloud_save_snapshots WHERE status = 'committed'",
    )
    .fetch_one(&state.pool)
    .await?;
    let cloud_save_bytes: i64 =
        sqlx::query_scalar("SELECT COALESCE(SUM(size_in_bytes), 0) FROM cloud_save_blobs")
            .fetch_one(&state.pool)
            .await?;
    let achievement_game_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM game_achievements")
            .fetch_one(&state.pool)
            .await?;
    let shared_artifact_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM artifact_shares")
            .fetch_one(&state.pool)
            .await?;
    /* Only uploads occupy disk; SteamGridDB picks are recorded with a zero
       size and so drop out of both counts. */
    let artwork_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM game_artwork WHERE size_in_bytes > 0")
            .fetch_one(&state.pool)
            .await?;
    let artwork_bytes: i64 =
        sqlx::query_scalar("SELECT COALESCE(SUM(size_in_bytes), 0) FROM game_artwork")
            .fetch_one(&state.pool)
            .await?;

    /* WAL/SHM files hold data not yet checkpointed into the main file, so
       count them into the database size too. */
    let db_path = state.config.database_path();
    let mut database_bytes: u64 = 0;
    for suffix in ["", "-wal", "-shm"] {
        let path = std::path::PathBuf::from(format!("{}{suffix}", db_path.display()));
        if let Ok(meta) = tokio::fs::metadata(&path).await {
            database_bytes += meta.len();
        }
    }

    let current = state.settings.read().await.clone();
    let uptime_seconds = (Utc::now() - state.started_at).num_seconds();

    Ok(Json(json!({
        "userCount": user_count,
        "blockedUserCount": blocked_user_count,
        "artifactCount": artifact_count,
        "emulationSaveCount": save_count,
        "achievementGameCount": achievement_game_count,
        "sharedArtifactCount": shared_artifact_count,
        "customImageCount": artwork_count,
        "cloudSaveCount": cloud_save_count,
        "pendingCloudSaveCount": pending_cloud_save_count,
        "cloudSaveFileCount": cloud_save_file_count,
        "cloudSaveBytes": cloud_save_bytes,
        "totalBytes": artifact_bytes + save_bytes + artwork_bytes + cloud_save_bytes,
        "databaseBytes": database_bytes,
        "maxBytesPerUser": current.max_bytes_per_user,
        "backupsPerGameLimit": current.backups_per_game_limit,
        "allowedUsers": current.allowed_users,
        "officialApiUrl": state.config.official_api_url,
        "publicUrl": state.config.public_url,
        "version": env!("CARGO_PKG_VERSION"),
        "uptimeSeconds": uptime_seconds,
    })))
}

fn settings_json(current: &RuntimeSettings, defaults: &RuntimeSettings, overridden: bool) -> Value {
    json!({
        "maxBytesPerUser": current.max_bytes_per_user,
        "backupsPerGameLimit": current.backups_per_game_limit,
        "allowedUsers": current.allowed_users,
        "overridden": overridden,
        "defaults": {
            "maxBytesPerUser": defaults.max_bytes_per_user,
            "backupsPerGameLimit": defaults.backups_per_game_limit,
            "allowedUsers": defaults.allowed_users,
        },
    })
}

async fn settings_payload(state: &AppState) -> ApiResult<Json<Value>> {
    let current = state.settings.read().await.clone();
    let defaults = RuntimeSettings::from_config(&state.config);
    let override_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM server_settings")
        .fetch_one(&state.pool)
        .await?;

    Ok(Json(settings_json(&current, &defaults, override_count > 0)))
}

async fn get_settings(
    State(state): State<AppState>,
    _admin: AdminSession,
) -> ApiResult<Json<Value>> {
    settings_payload(&state).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateSettingsRequest {
    max_bytes_per_user: Option<u64>,
    backups_per_game_limit: Option<u32>,
    allowed_users: Option<Vec<String>>,
}

/// PUT /admin/api/settings — persists the provided fields as overrides of
/// the environment defaults and applies them immediately.
async fn update_settings(
    State(state): State<AppState>,
    _admin: AdminSession,
    Json(payload): Json<UpdateSettingsRequest>,
) -> ApiResult<Json<Value>> {
    if let Some(max_bytes) = payload.max_bytes_per_user {
        settings::set(&state.pool, settings::MAX_BYTES_PER_USER, &max_bytes.to_string()).await?;
    }

    if let Some(limit) = payload.backups_per_game_limit {
        if limit == 0 {
            return Err(ApiError::bad_request("backups per game must be at least 1"));
        }
        settings::set(&state.pool, settings::BACKUPS_PER_GAME_LIMIT, &limit.to_string()).await?;
    }

    if let Some(users) = payload.allowed_users {
        let normalized = settings::parse_allowed_users(&users.join(","));
        settings::set(&state.pool, settings::ALLOWED_USERS, &normalized.join(",")).await?;
    }

    let reloaded = settings::load(&state.pool, &state.config).await;
    *state.settings.write().await = reloaded;

    settings_payload(&state).await
}

/// DELETE /admin/api/settings — clears every override, back to env values.
async fn reset_settings(
    State(state): State<AppState>,
    _admin: AdminSession,
) -> ApiResult<Json<Value>> {
    settings::clear(&state.pool).await?;

    let reloaded = settings::load(&state.pool, &state.config).await;
    *state.settings.write().await = reloaded;

    settings_payload(&state).await
}

/// GET /admin/api/games/{shop}/{object_id} — cached game name/cover so the
/// panel can show real games instead of raw shop ids.
async fn game_info(
    State(state): State<AppState>,
    _admin: AdminSession,
    Path((shop, object_id)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    let metadata = games::resolve(&state, &shop, &object_id).await;

    Ok(Json(json!({
        "shop": shop,
        "objectId": object_id,
        "name": metadata.name,
        "coverUrl": metadata.cover_url,
    })))
}

/// Public URL of a banner stored on this server (banner_key), if any.
fn banner_url(state: &AppState, banner_key: Option<String>) -> Option<String> {
    banner_key.map(|key| {
        format!(
            "{}/{}",
            state.config.public_url,
            key.trim_start_matches('/')
        )
    })
}

/// Per-user counts and storage, shared by the user list and the detail view so
/// the two can't disagree.
///
/// `total_bytes` mirrors [`storage::used_bytes`] — the same four sources the
/// quota is measured against, Cloud Save V2 blobs included. V2 bytes come from
/// the blob table rather than the snapshots' declared sizes: blobs are
/// deduplicated per user, so a file shared across variants or games occupies
/// disk (and quota) exactly once.
const USER_AGGREGATES: &str = "
    (SELECT COUNT(*) FROM artifacts a WHERE a.user_id = u.id) AS artifact_count,
    (SELECT COALESCE(SUM(artifact_length_in_bytes), 0) FROM artifacts a WHERE a.user_id = u.id)
      + (SELECT COALESCE(SUM(artifact_length_in_bytes), 0) FROM emulation_saves e WHERE e.user_id = u.id)
      + (SELECT COALESCE(SUM(size_in_bytes), 0) FROM game_artwork w WHERE w.user_id = u.id)
      + (SELECT COALESCE(SUM(size_in_bytes), 0) FROM cloud_save_blobs b WHERE b.user_id = u.id)
      AS total_bytes,
    (SELECT COUNT(*) FROM emulation_saves e WHERE e.user_id = u.id) AS save_count,
    (SELECT COUNT(*) FROM game_artwork w WHERE w.user_id = u.id AND w.size_in_bytes > 0)
      AS custom_image_count,
    (SELECT COUNT(*) FROM game_achievements g WHERE g.user_id = u.id) AS achievement_games,
    (SELECT COUNT(*) FROM cloud_save_snapshots s
       WHERE s.user_id = u.id AND s.status = 'committed') AS cloud_save_count,
    (SELECT COALESCE(SUM(size_in_bytes), 0) FROM cloud_save_blobs b WHERE b.user_id = u.id)
      AS cloud_save_bytes";

/// The shared shape of a user row, as both endpoints return it.
fn user_json(state: &AppState, row: &sqlx::sqlite::SqliteRow) -> Value {
    json!({
        "id": row.get::<String, _>("id"),
        "username": row.get::<Option<String>, _>("username"),
        "displayName": row.get::<String, _>("display_name"),
        "profileImageUrl": row.get::<Option<String>, _>("profile_image_url"),
        "bannerUrl": banner_url(state, row.get("banner_key")),
        "isBlocked": row.get::<i64, _>("is_blocked") != 0,
        "lastSeenAt": row.get::<String, _>("last_seen_at"),
        "createdAt": row.get::<String, _>("created_at"),
        "artifactCount": row.get::<i64, _>("artifact_count"),
        "emulationSaveCount": row.get::<i64, _>("save_count"),
        "customImageCount": row.get::<i64, _>("custom_image_count"),
        "achievementGameCount": row.get::<i64, _>("achievement_games"),
        "cloudSaveCount": row.get::<i64, _>("cloud_save_count"),
        "cloudSaveBytes": row.get::<i64, _>("cloud_save_bytes"),
        "totalBytes": row.get::<i64, _>("total_bytes"),
    })
}

async fn list_users(State(state): State<AppState>, _admin: AdminSession) -> ApiResult<Json<Value>> {
    let rows = sqlx::query(&format!(
        "SELECT u.*, {USER_AGGREGATES} FROM users u ORDER BY u.last_seen_at DESC"
    ))
    .fetch_all(&state.pool)
    .await?;

    let users: Vec<Value> = rows.iter().map(|row| user_json(&state, row)).collect();

    Ok(Json(json!(users)))
}

async fn user_details(
    State(state): State<AppState>,
    _admin: AdminSession,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let user = sqlx::query(&format!(
        "SELECT u.*, {USER_AGGREGATES} FROM users u WHERE u.id = ?"
    ))
    .bind(&id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| ApiError::not_found("user not found"))?;

    let artifacts = sqlx::query(
        "SELECT a.*, g.name AS game_name, g.cover_url AS game_cover_url,
            (SELECT COUNT(*) FROM artifact_shares s WHERE s.artifact_id = a.id) AS share_count
         FROM artifacts a
         LEFT JOIN game_metadata g ON g.shop = a.shop AND g.object_id = a.object_id
         WHERE a.user_id = ? ORDER BY a.created_at DESC",
    )
    .bind(&id)
    .fetch_all(&state.pool)
    .await?;

    let achievements = sqlx::query(
        "SELECT ga.remote_game_id, ga.shop, ga.object_id, ga.updated_at,
            json_array_length(ga.achievements) AS achievement_count,
            g.name AS game_name, g.cover_url AS game_cover_url
         FROM game_achievements ga
         LEFT JOIN game_metadata g ON g.shop = ga.shop AND g.object_id = ga.object_id
         WHERE ga.user_id = ? ORDER BY ga.updated_at DESC",
    )
    .bind(&id)
    .fetch_all(&state.pool)
    .await?;

    let saves = sqlx::query(
        "SELECT * FROM emulation_saves WHERE user_id = ? ORDER BY updated_at DESC",
    )
    .bind(&id)
    .fetch_all(&state.pool)
    .await?;

    /* Cloud Save V2 snapshots, pending ones included: an upload that never
       committed is exactly what an admin needs to see when a user reports a
       sync that didn't stick. */
    let snapshots = sqlx::query(
        "SELECT s.*, g.name AS game_name, g.cover_url AS game_cover_url
         FROM cloud_save_snapshots s
         LEFT JOIN game_metadata g ON g.shop = s.shop AND g.object_id = s.object_id
         WHERE s.user_id = ? ORDER BY s.updated_at DESC",
    )
    .bind(&id)
    .fetch_all(&state.pool)
    .await?;

    Ok(Json(json!({
        "user": user_json(&state, &user),
        "artifacts": artifacts.iter().map(|row| json!({
            "id": row.get::<String, _>("id"),
            "shop": row.get::<String, _>("shop"),
            "objectId": row.get::<String, _>("object_id"),
            "gameName": row.get::<Option<String>, _>("game_name"),
            "gameCoverUrl": row.get::<Option<String>, _>("game_cover_url"),
            "label": row.get::<Option<String>, _>("label"),
            "sizeBytes": row.get::<i64, _>("artifact_length_in_bytes"),
            "hostname": row.get::<String, _>("hostname"),
            "platform": row.get::<Option<String>, _>("platform"),
            "isFrozen": row.get::<i64, _>("is_frozen") != 0,
            "isUploaded": row.get::<i64, _>("is_uploaded") != 0,
            "downloadCount": row.get::<i64, _>("download_count"),
            "shareCount": row.get::<i64, _>("share_count"),
            "createdAt": row.get::<String, _>("created_at"),
        })).collect::<Vec<_>>(),
        "achievements": achievements.iter().map(|row| json!({
            "remoteGameId": row.get::<String, _>("remote_game_id"),
            "shop": row.get::<Option<String>, _>("shop"),
            "objectId": row.get::<Option<String>, _>("object_id"),
            "gameName": row.get::<Option<String>, _>("game_name"),
            "gameCoverUrl": row.get::<Option<String>, _>("game_cover_url"),
            "achievementCount": row.get::<i64, _>("achievement_count"),
            "updatedAt": row.get::<String, _>("updated_at"),
        })).collect::<Vec<_>>(),
        "emulationSaves": saves.iter().map(|row| json!({
            "id": row.get::<String, _>("id"),
            "platform": row.get::<String, _>("platform"),
            "emulator": row.get::<String, _>("emulator"),
            "fileName": row.get::<Option<String>, _>("file_name"),
            "label": row.get::<Option<String>, _>("label"),
            "sizeBytes": row.get::<i64, _>("artifact_length_in_bytes"),
            "isUploaded": row.get::<i64, _>("is_uploaded") != 0,
            "updatedAt": row.get::<String, _>("updated_at"),
        })).collect::<Vec<_>>(),
        "cloudSaves": snapshots.iter().map(|row| json!({
            "id": row.get::<String, _>("id"),
            "shop": row.get::<String, _>("shop"),
            "objectId": row.get::<String, _>("object_id"),
            "gameName": row.get::<Option<String>, _>("game_name"),
            "gameCoverUrl": row.get::<Option<String>, _>("game_cover_url"),
            "version": row.get::<i64, _>("version"),
            "fileCount": row.get::<i64, _>("file_count"),
            /* The manifest's own total, so it counts a file duplicated across
               variants once per copy — what the launcher restores, not what
               the deduplicated blobs occupy here. */
            "sizeBytes": row.get::<i64, _>("total_size_in_bytes"),
            "platform": row.get::<Option<String>, _>("platform"),
            "hostname": row.get::<Option<String>, _>("hostname"),
            "status": row.get::<String, _>("status"),
            "aggregateHash": row.get::<String, _>("aggregate_hash"),
            "createdAt": row.get::<String, _>("created_at"),
            "updatedAt": row.get::<String, _>("updated_at"),
        })).collect::<Vec<_>>(),
    })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlaytimeQuery {
    #[serde(default)]
    days: Option<i64>,
    #[serde(default)]
    user_id: Option<String>,
}

/// Days with playtime keep only their biggest games in the payload; the
/// tooltip never shows more than the top one anyway.
const HEATMAP_GAMES_PER_DAY: usize = 5;

/// GET /admin/api/playtime?days=364[&userId=…] — daily playtime buckets,
/// aggregated across every user unless a userId is given. Game names come
/// from the metadata cache and stay null until something resolves them.
async fn playtime_heatmap(
    State(state): State<AppState>,
    _admin: AdminSession,
    Query(query): Query<PlaytimeQuery>,
) -> ApiResult<Json<Value>> {
    let days = query.days.unwrap_or(364).clamp(1, 366);
    let since = (Utc::now().date_naive() - chrono::Duration::days(days - 1)).to_string();

    let mut sql = String::from(
        "SELECT p.day, p.shop, p.object_id, SUM(p.seconds) AS seconds,
            COUNT(DISTINCT p.user_id) AS player_count, g.name AS game_name
         FROM playtime_daily p
         LEFT JOIN game_metadata g ON g.shop = p.shop AND g.object_id = p.object_id
         WHERE p.day >= ?",
    );
    if query.user_id.is_some() {
        sql.push_str(" AND p.user_id = ?");
    }
    sql.push_str(" GROUP BY p.day, p.shop, p.object_id ORDER BY p.day ASC, seconds DESC");

    let mut db_query = sqlx::query(&sql).bind(&since);
    if let Some(user_id) = &query.user_id {
        db_query = db_query.bind(user_id);
    }
    let rows = db_query.fetch_all(&state.pool).await?;

    /* Distinct players per day can't be derived from the per-game grouping
       above (one player may appear under several games). */
    let mut players_by_day: std::collections::BTreeMap<String, i64> = Default::default();
    if query.user_id.is_none() {
        let player_rows = sqlx::query(
            "SELECT day, COUNT(DISTINCT user_id) AS player_count
             FROM playtime_daily WHERE day >= ? GROUP BY day",
        )
        .bind(&since)
        .fetch_all(&state.pool)
        .await?;

        for row in player_rows {
            players_by_day.insert(row.get("day"), row.get("player_count"));
        }
    }

    /* Totals count every game; the games list keeps only the biggest ones
       (rows arrive seconds DESC within each day). */
    let mut by_day: std::collections::BTreeMap<String, (i64, Vec<Value>)> = Default::default();
    for row in rows {
        let day: String = row.get("day");
        let seconds: i64 = row.get("seconds");
        let (total, games) = by_day.entry(day).or_default();
        *total += seconds;
        if games.len() < HEATMAP_GAMES_PER_DAY {
            games.push(json!({
                "shop": row.get::<String, _>("shop"),
                "objectId": row.get::<String, _>("object_id"),
                "name": row.get::<Option<String>, _>("game_name"),
                "seconds": seconds,
            }));
        }
    }

    Ok(Json(json!(by_day
        .into_iter()
        .map(|(day, (total, games))| {
            json!({
                "day": day.clone(),
                "totalSeconds": total,
                "playerCount": players_by_day.get(&day).copied().unwrap_or(1),
                "games": games,
            })
        })
        .collect::<Vec<_>>())))
}

#[derive(Deserialize)]
struct BlockRequest {
    blocked: bool,
}

async fn set_blocked(
    State(state): State<AppState>,
    _admin: AdminSession,
    Path(id): Path<String>,
    Json(payload): Json<BlockRequest>,
) -> ApiResult<Json<Value>> {
    sqlx::query("UPDATE users SET is_blocked = ? WHERE id = ?")
        .bind(payload.blocked as i64)
        .bind(&id)
        .execute(&state.pool)
        .await?;

    /* Blocked users may still have a cached token — drop the cache so the
       block applies within seconds, not minutes. */
    state.token_cache.write().await.clear();

    Ok(Json(json!({ "ok": true })))
}

async fn delete_user(
    State(state): State<AppState>,
    _admin: AdminSession,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let artifact_ids: Vec<String> =
        sqlx::query_scalar("SELECT id FROM artifacts WHERE user_id = ?")
            .bind(&id)
            .fetch_all(&state.pool)
            .await?;
    let save_ids: Vec<String> =
        sqlx::query_scalar("SELECT id FROM emulation_saves WHERE user_id = ?")
            .bind(&id)
            .fetch_all(&state.pool)
            .await?;

    /* Cloud Save V2 blobs cascade out of the database with the user, so their
       hashes have to be read before the delete or the bytes are stranded on
       disk with nothing left pointing at them. */
    let blob_hashes: Vec<String> =
        sqlx::query_scalar("SELECT hash FROM cloud_save_blobs WHERE user_id = ?")
            .bind(&id)
            .fetch_all(&state.pool)
            .await?;

    let artwork_keys = crate::artwork::storage_keys_for_user(&state, &id).await;

    sqlx::query("DELETE FROM users WHERE id = ?")
        .bind(&id)
        .execute(&state.pool)
        .await?;

    for key in artwork_keys {
        storage::delete_object(&state, &key).await;
    }
    for artifact_id in artifact_ids {
        storage::delete_object(&state, &format!("artifacts/{artifact_id}.tar")).await;
    }
    for save_id in save_ids {
        storage::delete_object(&state, &format!("emulation-saves/{save_id}.bin")).await;
    }
    if !blob_hashes.is_empty() {
        for hash in &blob_hashes {
            storage::delete_object(&state, &storage::cloud_save_blob_key(&id, hash)).await;
        }
        /* Succeeds only once the user's blob directory is empty, which is
           exactly when it should go. */
        let _ = tokio::fs::remove_dir(storage::storage_path(
            &state,
            &format!("cloud-saves/{id}"),
        ))
        .await;
    }

    state.token_cache.write().await.clear();

    Ok(Json(json!({ "ok": true })))
}

async fn delete_artifact(
    State(state): State<AppState>,
    _admin: AdminSession,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let result = sqlx::query("DELETE FROM artifacts WHERE id = ?")
        .bind(&id)
        .execute(&state.pool)
        .await?;

    if result.rows_affected() == 0 {
        return Err(ApiError::not_found("artifact not found"));
    }

    storage::delete_object(&state, &format!("artifacts/{id}.tar")).await;

    Ok(Json(json!({ "ok": true })))
}

async fn download_artifact(
    State(state): State<AppState>,
    _admin: AdminSession,
    Path(id): Path<String>,
) -> ApiResult<Redirect> {
    let exists: Option<(String,)> = sqlx::query_as("SELECT id FROM artifacts WHERE id = ?")
        .bind(&id)
        .fetch_optional(&state.pool)
        .await?;

    if exists.is_none() {
        return Err(ApiError::not_found("artifact not found"));
    }

    let url = storage::sign_download_url(&state, &format!("artifacts/{id}.tar"));
    Ok(Redirect::temporary(&url))
}

/// GET /admin/api/cloud-saves/{id}/files — the snapshot's manifest.
///
/// `stored` reports whether the blob is actually on disk: for a pending
/// snapshot it shows how far an in-flight upload got, and for a committed one
/// it would expose bytes lost underneath the database.
async fn snapshot_files(
    State(state): State<AppState>,
    _admin: AdminSession,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let owner: Option<String> =
        sqlx::query_scalar("SELECT user_id FROM cloud_save_snapshots WHERE id = ?")
            .bind(&id)
            .fetch_optional(&state.pool)
            .await?;
    let owner = owner.ok_or_else(|| ApiError::not_found("snapshot not found"))?;

    let rows = sqlx::query(
        "SELECT f.*, b.hash IS NOT NULL AS stored
         FROM cloud_save_snapshot_files f
         LEFT JOIN cloud_save_blobs b ON b.user_id = ? AND b.hash = f.hash
         WHERE f.snapshot_id = ?
         ORDER BY f.raw_path, f.relative_path",
    )
    .bind(&owner)
    .bind(&id)
    .fetch_all(&state.pool)
    .await?;

    Ok(Json(json!(rows
        .iter()
        .map(|row| json!({
            "variantId": row.get::<String, _>("variant_id"),
            "rawPath": row.get::<String, _>("raw_path"),
            "relativePath": row.get::<String, _>("relative_path"),
            "hash": row.get::<String, _>("hash"),
            "sizeBytes": row.get::<i64, _>("size_in_bytes"),
            "lastModifiedAt": row.get::<String, _>("last_modified_at"),
            "stored": row.get::<i64, _>("stored") != 0,
        }))
        .collect::<Vec<_>>())))
}

/// GET /admin/api/cloud-saves/{id}/files/{hash}/download — one file out of a
/// snapshot. The hash has to belong to the snapshot, so this can't be used to
/// read arbitrary blobs of an arbitrary user.
async fn download_snapshot_file(
    State(state): State<AppState>,
    _admin: AdminSession,
    Path((id, hash)): Path<(String, String)>,
) -> ApiResult<Redirect> {
    let owner: Option<String> = sqlx::query_scalar(
        "SELECT s.user_id FROM cloud_save_snapshots s
         JOIN cloud_save_snapshot_files f ON f.snapshot_id = s.id
         WHERE s.id = ? AND f.hash = ? LIMIT 1",
    )
    .bind(&id)
    .bind(&hash)
    .fetch_optional(&state.pool)
    .await?;
    let owner = owner.ok_or_else(|| ApiError::not_found("snapshot file not found"))?;

    let url = storage::sign_download_url(&state, &storage::cloud_save_blob_key(&owner, &hash));
    Ok(Redirect::temporary(&url))
}

/// DELETE /admin/api/cloud-saves/{id} — drops one snapshot and frees every
/// blob it alone was keeping alive.
async fn delete_snapshot(
    State(state): State<AppState>,
    _admin: AdminSession,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let owner: Option<String> =
        sqlx::query_scalar("SELECT user_id FROM cloud_save_snapshots WHERE id = ?")
            .bind(&id)
            .fetch_optional(&state.pool)
            .await?;
    let owner = owner.ok_or_else(|| ApiError::not_found("snapshot not found"))?;

    sqlx::query("DELETE FROM cloud_save_snapshot_files WHERE snapshot_id = ?")
        .bind(&id)
        .execute(&state.pool)
        .await?;
    sqlx::query("DELETE FROM cloud_save_snapshots WHERE id = ?")
        .bind(&id)
        .execute(&state.pool)
        .await?;

    cloud_saves::collect_orphan_blobs(&state, &owner).await?;

    Ok(Json(json!({ "ok": true })))
}

async fn delete_emulation_save(
    State(state): State<AppState>,
    _admin: AdminSession,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let result = sqlx::query("DELETE FROM emulation_saves WHERE id = ?")
        .bind(&id)
        .execute(&state.pool)
        .await?;

    if result.rows_affected() == 0 {
        return Err(ApiError::not_found("emulation save not found"));
    }

    storage::delete_object(&state, &format!("emulation-saves/{id}.bin")).await;

    Ok(Json(json!({ "ok": true })))
}
