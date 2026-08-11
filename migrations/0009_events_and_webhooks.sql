-- The server's own history: one row per thing that happened.
--
-- Until now the admin panel reconstructed "recent activity" from the
-- timestamps on live rows, which can only ever show what still exists — a
-- deleted save leaves no trace, an admin action leaves none at all, and a
-- rejected upload is invisible. This table is the real log: sync traffic,
-- operator actions, authentication attempts and background jobs, kept
-- independently of the rows they refer to.
--
-- `user_id` deliberately has NO foreign key. An audit trail that disappears
-- when the account it describes is deleted is not an audit trail.
CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    -- Dotted identifier, e.g. 'cloud_save.committed', 'admin.user.deleted'.
    kind TEXT NOT NULL,
    -- 'sync' | 'admin' | 'auth' | 'system'
    category TEXT NOT NULL,
    -- 'info' | 'warning' | 'critical'
    severity TEXT NOT NULL DEFAULT 'info',
    -- Who caused it: 'user:<id>', 'admin', 'system'.
    actor TEXT,
    -- Who it is about, when that differs from the actor.
    user_id TEXT,
    shop TEXT,
    object_id TEXT,
    summary TEXT NOT NULL,
    -- JSON object with whatever the specific event wants to keep.
    detail TEXT,
    ip TEXT,
    size_bytes INTEGER
);

CREATE INDEX idx_events_at ON events (at DESC);
CREATE INDEX idx_events_kind_at ON events (kind, at DESC);
CREATE INDEX idx_events_category_at ON events (category, at DESC);
CREATE INDEX idx_events_user_at ON events (user_id, at DESC);

-- Seed the log from what the database already knows, so a server that
-- upgrades into this migration has history from day one instead of an empty
-- screen. These are the same derivations the old activity feed made on the
-- fly; from here on the rows are written as things happen.
INSERT INTO events (at, kind, category, severity, actor, user_id, shop, object_id, summary, size_bytes)
SELECT created_at, 'user.first_seen', 'auth', 'info', 'user:' || id, id, NULL, NULL,
       'First signed in', NULL
  FROM users;

INSERT INTO events (at, kind, category, severity, actor, user_id, shop, object_id, summary, size_bytes)
SELECT updated_at, 'cloud_save.committed', 'sync', 'info', 'user:' || user_id, user_id,
       shop, object_id,
       'Synced a cloud save (v' || version || ', ' || file_count || ' files)',
       total_size_in_bytes
  FROM cloud_save_snapshots WHERE status = 'committed';

INSERT INTO events (at, kind, category, severity, actor, user_id, shop, object_id, summary, size_bytes)
SELECT created_at, 'backup.created', 'sync', 'info', 'user:' || user_id, user_id,
       shop, object_id,
       'Uploaded a save backup' || COALESCE(' — ' || label, ''),
       artifact_length_in_bytes
  FROM artifacts;

INSERT INTO events (at, kind, category, severity, actor, user_id, shop, object_id, summary, size_bytes)
SELECT updated_at, 'emulation_save.synced', 'sync', 'info', 'user:' || user_id, user_id,
       shop, object_id,
       'Synced an emulation save (' || emulator || ' · ' || platform || ')',
       artifact_length_in_bytes
  FROM emulation_saves;

INSERT INTO events (at, kind, category, severity, actor, user_id, shop, object_id, summary, size_bytes)
SELECT updated_at, 'achievements.synced', 'sync', 'info', 'user:' || user_id, user_id,
       shop, object_id,
       'Synced ' || json_array_length(achievements) || ' achievements', NULL
  FROM game_achievements;

INSERT INTO events (at, kind, category, severity, actor, user_id, shop, object_id, summary, size_bytes)
SELECT updated_at, 'artwork.updated', 'sync', 'info', 'user:' || user_id, user_id,
       shop, object_id,
       'Set custom ' || kind || ' art (' || source || ')', size_in_bytes
  FROM game_artwork;

INSERT INTO events (at, kind, category, severity, actor, user_id, shop, object_id, summary, size_bytes)
SELECT created_at, 'backup.shared', 'sync', 'info', 'user:' || owner_user_id, owner_user_id,
       NULL, NULL,
       'Shared a backup with ' || recipient_user_id, NULL
  FROM artifact_shares;

-- Outbound webhooks. Every recorded event is offered to each enabled hook
-- whose filters match, so an operator can wire the server into Discord, a
-- homelab notifier, or anything that accepts a POST.
CREATE TABLE webhooks (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL,
    -- 'json' (full event), 'discord' or 'slack' (a rendered message).
    format TEXT NOT NULL DEFAULT 'json',
    -- Optional HMAC-SHA256 key; when set, deliveries carry X-Hydra-Signature.
    secret TEXT,
    -- JSON array of kind prefixes ('cloud_save.', 'admin.'); empty = everything.
    kinds TEXT NOT NULL DEFAULT '[]',
    min_severity TEXT NOT NULL DEFAULT 'info',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    -- Delivery bookkeeping, so a silently broken hook is visible in the panel.
    last_delivery_at TEXT,
    last_status TEXT,
    last_error TEXT,
    delivered_count INTEGER NOT NULL DEFAULT 0,
    failure_count INTEGER NOT NULL DEFAULT 0
);
