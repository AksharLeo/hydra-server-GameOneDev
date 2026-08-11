//! Admin authentication: one shared password, one signed cookie.
//!
//! There are no admin accounts — the panel guards a single deployment, so the
//! password from the environment is the whole credential and the session is a
//! short-lived JWT in an HttpOnly cookie.

use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use axum::extract::{FromRequestParts, State};
use axum::http::{header, request::Parts};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::Utc;
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const SESSION_TTL_SECONDS: i64 = 60 * 60 * 12;
const COOKIE_NAME: &str = "hydra_admin";

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/admin/api/login", post(login))
        .route("/admin/api/logout", post(logout))
        .route("/admin/api/session", get(session))
}

#[derive(Serialize, Deserialize)]
struct AdminClaims {
    typ: String,
    exp: i64,
}

/// Extractor guarding every admin endpoint with the session cookie.
pub struct AdminSession {
    /// When the current session expires, so the panel can warn before it does.
    pub expires_at: i64,
}

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

        Ok(AdminSession {
            expires_at: claims.exp,
        })
    }
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

    let expires_at = Utc::now().timestamp() + SESSION_TTL_SECONDS;
    let token = encode(
        &Header::default(),
        &AdminClaims {
            typ: "admin".to_string(),
            exp: expires_at,
        },
        &EncodingKey::from_secret(state.config.secret.as_bytes()),
    )
    .map_err(|_| ApiError::internal("failed to create session"))?;

    let cookie = format!(
        "{COOKIE_NAME}={token}; HttpOnly; Path=/; Max-Age={SESSION_TTL_SECONDS}; SameSite=Strict"
    );

    Ok((
        [(header::SET_COOKIE, cookie)],
        Json(json!({ "ok": true, "expiresAt": expires_at })),
    )
        .into_response())
}

async fn logout() -> Response {
    let cookie = format!("{COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict");
    ([(header::SET_COOKIE, cookie)], Json(json!({ "ok": true }))).into_response()
}

/// GET /admin/api/session — the panel's boot probe: is this browser signed in,
/// and for how much longer.
async fn session(admin: AdminSession) -> ApiResult<Json<Value>> {
    Ok(Json(json!({
        "authenticated": true,
        "expiresAt": admin.expires_at,
        "version": env!("CARGO_PKG_VERSION"),
    })))
}
