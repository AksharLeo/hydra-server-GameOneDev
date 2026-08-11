//! The panel's own front end, embedded in the binary.
//!
//! The panel is a small ES-module app rather than one giant HTML file, so the
//! sources stay readable and a new screen is a new file. Embedding them keeps
//! the deployment story unchanged: one binary, no asset directory to ship
//! alongside it, nothing to misconfigure in a reverse proxy.
//!
//! To add a file: drop it under `static/admin/` and add one row to [`ASSETS`].

use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use axum::extract::Path;
use axum::http::header;
use axum::response::{Html, IntoResponse, Response};
use axum::routing::get;
use axum::Router;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/admin", get(index))
        .route("/admin/assets/{*path}", get(asset))
}

/// Every file the panel loads, in load order for readability.
macro_rules! assets {
    ($($path:literal),* $(,)?) => {
        &[$(($path, include_str!(concat!("../../static/admin/", $path)))),*]
    };
}

const ASSETS: &[(&str, &str)] = assets![
    "app.css",
    "js/main.js",
    "js/api.js",
    "js/store.js",
    "js/router.js",
    "js/format.js",
    "js/dom.js",
    "js/components/shell.js",
    "js/components/table.js",
    "js/components/charts.js",
    "js/components/ui.js",
    "js/components/palette.js",
    "js/views/login.js",
    "js/views/overview.js",
    "js/views/users.js",
    "js/views/user.js",
    "js/views/saves.js",
    "js/views/games.js",
    "js/views/storage.js",
    "js/views/maintenance.js",
    "js/views/settings.js",
];

/// The shell document. Everything else it pulls from `/admin/assets/…`.
async fn index() -> Html<&'static str> {
    Html(include_str!("../../static/admin/index.html"))
}

async fn asset(Path(path): Path<String>) -> ApiResult<Response> {
    let (_, body) = ASSETS
        .iter()
        .find(|(name, _)| *name == path)
        .ok_or_else(|| ApiError::not_found("asset not found"))?;

    let content_type = match path.rsplit_once('.').map(|(_, ext)| ext) {
        Some("css") => "text/css; charset=utf-8",
        Some("js") => "text/javascript; charset=utf-8",
        Some("svg") => "image/svg+xml",
        _ => "text/plain; charset=utf-8",
    };

    Ok((
        [
            (header::CONTENT_TYPE, content_type),
            /* Revalidate every load: the panel ships inside the binary, so a
               server upgrade must never be shadowed by a cached module. */
            (header::CACHE_CONTROL, "no-cache"),
        ],
        *body,
    )
        .into_response())
}
