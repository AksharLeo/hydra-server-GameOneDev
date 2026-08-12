//! The user-facing portal at `/portal`.
//!
//! The admin panel answers the operator's questions; this answers the
//! player's — what have I got stored here, can I download that save, can I
//! delete the one I don't want. It runs against the same database, scoped
//! hard to the signed-in account.
//!
//! # Signing in
//!
//! Launchers authenticate with an official Hydra access token, but a person
//! opening a web page has no way to find one and should not have to. So the
//! portal offers the sign-in a person expects — email and password — and
//! forwards those credentials **once** to the official Hydra API, exactly as
//! the launcher's own sign-in does. What comes back is used to prove identity
//! against `/profile/me`, and then thrown away: the portal issues its own
//! cookie session and never stores the password or the official token.
//!
//! Two paths exist for the cases where that doesn't fit:
//!
//! * an **access token** field, for anyone who does have one to hand;
//! * **portal links** minted by an operator from the admin panel, which sign
//!   a specific user in for a short window — the escape hatch when a
//!   deployment's official API exposes no password endpoint at all.

mod api;
mod assets;
mod session;

pub use session::{issue_link_token, PortalSession};

use crate::state::AppState;
use axum::Router;

pub fn router() -> Router<AppState> {
    Router::new()
        .merge(assets::router())
        .merge(session::router())
        .merge(api::router())
}
