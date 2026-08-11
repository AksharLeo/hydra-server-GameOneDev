//! The portal's shell document. Everything else it pulls from `/assets/…`.

use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use axum::extract::State;
use axum::response::Html;
use axum::routing::get;
use axum::Router;

pub fn router() -> Router<AppState> {
    Router::new().route("/portal", get(index))
}

async fn index(State(state): State<AppState>) -> ApiResult<Html<&'static str>> {
    if !state.config.portal_enabled {
        return Err(ApiError::not_found("the portal is disabled on this server"));
    }

    Ok(Html(include_str!("../../static/portal/index.html")))
}
