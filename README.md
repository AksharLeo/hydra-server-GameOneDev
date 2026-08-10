# hydra-server

Self-hosted **Hydra Cloud storage** server for the [Hydra launcher](https://github.com/hydralauncher/hydra).

Hydra's subscription ("Hydra Cloud") pays for the storage behind cloud saves and
related sync features. This server lets you host that storage yourself — for you
and your friends — while **everything else keeps using the official Hydra
servers**: your account, login, friends, profiles, comments, the game catalogue
and download sources browsing all work exactly as before.

## What it provides

| Feature | Where it lives |
| --- | --- |
| Account, login, friends, profiles, catalogue | Official Hydra servers (unchanged) |
| Cloud save backups (Ludusavi tar bundles) | **this server** |
| Cloud Save V2 — per-file snapshot sync (launcher 4.1.0+) | **this server** |
| Emulation memory-card saves (PS1/PS2) | **this server** |
| Achievement sync across devices | **this server** |
| Download source list sync across devices | **this server** |
| Profile banner image hosting | **this server** (URL saved to the official profile) |
| Custom game images (covers, icons, logos, banners) | **this server** |
| Admin panel (users, storage, quotas) | **this server** at `/admin` |

## How authentication works

The launcher sends its **official Hydra access token** with every request. This
server validates the token by calling the official API's `/profile/me` and uses
the returned identity — it never stores passwords and issues no accounts of its
own. If someone isn't logged into Hydra, they can't use your server.

Optionally restrict who may use the server with `HYDRA_ALLOWED_USERS`, or block
users from the admin panel.

## Running

```bash
cargo build --release

HYDRA_ADMIN_PASSWORD=change-me \
HYDRA_SERVER_PUBLIC_URL=https://hydra-cloud.example.com \
./target/release/hydra-server
```

Or with Docker:

```bash
docker compose up -d
```

Then, in a launcher patched with self-hosted cloud support:
**Settings → Integrations → Self-hosted cloud storage** → enter your server URL
and save. Cloud save / achievement sync features unlock immediately; no
subscription needed.

### Configuration (environment variables)

| Variable | Default | Description |
| --- | --- | --- |
| `HYDRA_SERVER_BIND` | `0.0.0.0:8788` | Listen address |
| `HYDRA_SERVER_PUBLIC_URL` | `http://<bind>` | URL clients reach the server on — **must** be set when behind a reverse proxy, since upload/download URLs are built from it |
| `HYDRA_SERVER_DATA_DIR` | `./data` | SQLite database + stored save files |
| `HYDRA_OFFICIAL_API_URL` | `https://hydra-api-us-east-1.losbroxas.org` | Official API used to validate launcher tokens. If token validation fails with your launcher build, set this to the same API URL the launcher was built with (`MAIN_VITE_API_URL`) |
| `HYDRA_ADMIN_PASSWORD` | *(empty)* | Password for `/admin`. Panel is disabled while empty |
| `HYDRA_SERVER_SECRET` | auto-generated | Secret signing storage URLs and admin sessions; persisted to `<data dir>/.secret` when auto-generated |
| `HYDRA_MAX_BYTES_PER_USER` | `0` (unlimited) | Per-user storage quota in bytes — counts save backups, emulation saves and uploaded custom images |
| `HYDRA_BACKUPS_PER_GAME_LIMIT` | `100` | Max save backups per game per user |
| `HYDRA_ALLOWED_USERS` | *(empty = everyone)* | Comma-separated official user ids or usernames allowed to use this server |

The last three can also be edited live from the admin panel; values saved there
are stored in the database and override the environment until reset.

### Admin panel

Open `https://your-server/admin`, sign in with `HYDRA_ADMIN_PASSWORD`:

- overview of users, backups, shares, achievements and total storage
- server info: version, uptime, database size and effective configuration
- edit settings without a restart: per-user quota, backups-per-game limit and
  the allowed-users list, applied immediately and persisted across restarts
- per-user detail: profile info plus save backups, achievements and emulation
  saves — backups show the game's name and cover art (resolved from the Steam
  store and cached) instead of the raw shop id
- download or delete any backup
- block/unblock users, delete all of a user's data

## API surface

Implements the endpoints the launcher routes to a self-hosted cloud server:

- `GET|POST /profile/games/artifacts`, `POST /profile/games/artifacts/{id}/download`,
  `DELETE|PATCH /profile/games/artifacts/{id}`, `PUT …/{id}/freeze|unfreeze`
- `PUT /profile/games/achievements` (union merge by achievement name, earliest
  unlock wins), `DELETE /profile/games/achievements/{remoteGameId}`
- `GET /profile/achievements/{userId}` — recently unlocked achievements for a
  profile, so members show recent activity the official API only compares for
  subscribers. Names and unlock times only; the launcher joins the public
  catalogue for icons and titles. Deliberately not under
  `/profile/games/achievements`, which the launcher mirrors to both servers
- `POST /profile/games/{shop}/{objectId}/artwork/{grids|heroes|logos|icons}/upload-url`,
  `PUT|DELETE /profile/games/{shop}/{objectId}/artwork/{kind}` — custom game
  images, uploaded here or picked from SteamGridDB
- `GET /profile/games/artwork`, `GET /profile/games/artwork/{userId}` — the
  launcher reads these back to repaint its library and to show other members'
  custom images on their profiles
- `GET|POST|DELETE /profile/download-sources`
- `GET /profile/emulation-saves`, `POST /profile/emulation-saves/upload-url`,
  `POST …/{id}/commit`, `POST …/{id}/download-url`, `PUT|DELETE …/{id}`
- `POST /presigned-urls/{background-image|profile-image}` — profile image
  uploads; images are served publicly from `GET /images/…`
- `PUT|GET /storage/{token}` — S3-style presigned upload/download URLs
  (signed, short-lived, streamed to/from disk)
- `GET /health`
- `GET /capabilities` — version and feature list (see below)

### Cloud Save V2

Launcher 4.1.0 replaced the tarball-per-backup flow with per-file snapshots for
Steam games. A save is a manifest of files, each content-addressed by SHA-256:

- `POST /profile/cloud-saves/prepare-snapshot` — registers the manifest and
  returns a presigned PUT for each blob the server doesn't already hold
  (everything else comes back as `skip`, so only changed files upload)
- `POST /profile/cloud-saves/commit-snapshot` — verifies the bytes landed and
  promotes the snapshot to the game's current save
- `GET|DELETE /profile/cloud-saves/snapshots?shop=&objectId=`
- `GET /profile/cloud-saves/snapshot-restore-manifest?snapshotId=`
- `GET /profile/cloud-saves/snapshot-download-urls?snapshotId=`

Notable behaviour:

- **Conflict detection.** Every commit bumps the snapshot `version`. The
  launcher sends the version it started from as `baseVersion`; if another
  machine has committed since, the upload is refused with `409` instead of
  overwriting the newer save.
- **Deduplication.** Blobs are stored once per user per hash, so a file shared
  across variants or games costs one copy — and re-syncing an unchanged save
  transfers nothing.
- **Integrity.** Blob uploads are hashed as they stream and rejected if they
  don't match the hash the URL was signed for, so a content-addressed object
  can never hold the wrong bytes.
- **Garbage collection.** Blobs are deleted once no manifest references them;
  abandoned uploads are swept after 24 hours.

The legacy artifact endpoints stay in place — the launcher still uses them for
non-Steam games and for older clients.

### Capabilities

`GET /capabilities` (unauthenticated) reports what this build supports:

```json
{ "name": "hydra-server", "version": "4.1.0", "features": ["cloud-saves-v2", "..."] }
```

The launcher checks this before enabling a feature whose endpoints might not
exist here yet — upstream keeps adding subscription-gated features that get
routed to whichever cloud server is configured, and without this the only
symptom would be a 404 in the middle of a sync. `features` is the contract to
match on; `version` tracks the launcher release this server targets and is for
display and support.

## Notes

- Put the server behind HTTPS (Caddy, nginx, Traefik) before exposing it to the
  internet — save bundles and tokens travel over this connection.
- Back up the data dir; it contains everything.
