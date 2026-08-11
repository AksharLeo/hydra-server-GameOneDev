//! The admin panel's shell document. Everything else it pulls from
//! `/assets/…`, which [`crate::assets`] serves for both front ends.

use crate::state::AppState;
use axum::response::Html;
use axum::routing::get;
use axum::Router;

pub fn router() -> Router<AppState> {
    Router::new().route("/admin", get(index))
}

async fn index() -> Html<&'static str> {
    Html(include_str!("../../static/admin/index.html"))
}
