-- Cloud Save V2 (launcher 4.1.0+).
--
-- The legacy `artifacts` table stores one opaque tarball per backup. V2
-- instead models a save as a *snapshot*: a manifest of individual files, each
-- content-addressed by SHA-256, so an upload only transfers the blobs that
-- actually changed and the launcher can diff local against remote.
--
-- One committed snapshot is kept per user/game — it is the current state of
-- that save. Each commit bumps `version`, which the launcher sends back as
-- `baseVersion` on the next upload so a stale client can be rejected instead
-- of silently clobbering a newer save from another machine.
CREATE TABLE cloud_save_snapshots (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    shop TEXT NOT NULL,
    object_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    aggregate_hash TEXT NOT NULL,
    file_count INTEGER NOT NULL DEFAULT 0,
    total_size_in_bytes INTEGER NOT NULL DEFAULT 0,
    platform TEXT,
    hostname TEXT,
    -- JSON arrays, stored verbatim and echoed back in the restore manifest.
    custom_path_raw_paths TEXT NOT NULL DEFAULT '[]',
    variants TEXT NOT NULL DEFAULT '[]',
    -- 'pending' between prepare-snapshot and commit-snapshot, then 'committed'.
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX idx_cloud_save_snapshots_game
    ON cloud_save_snapshots (user_id, shop, object_id, status);

-- Only one committed snapshot may exist per game; pending ones are unconstrained
-- so an abandoned upload never blocks a retry.
CREATE UNIQUE INDEX idx_cloud_save_snapshots_committed
    ON cloud_save_snapshots (user_id, shop, object_id)
    WHERE status = 'committed';

-- The manifest rows. `raw_path` is the launcher's unresolved location token
-- (e.g. "<winPrefix>/..." or "<custom>/..."); `relative_path` is the path
-- beneath it. Together with `variant_id` they form a file's identity, which is
-- exactly the tuple the launcher keys its own diffing on.
CREATE TABLE cloud_save_snapshot_files (
    snapshot_id TEXT NOT NULL
        REFERENCES cloud_save_snapshots(id) ON DELETE CASCADE,
    variant_id TEXT NOT NULL,
    raw_path TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    hash TEXT NOT NULL,
    size_in_bytes INTEGER NOT NULL,
    last_modified_at TEXT NOT NULL,
    PRIMARY KEY (snapshot_id, variant_id, raw_path, relative_path)
);

CREATE INDEX idx_cloud_save_snapshot_files_hash
    ON cloud_save_snapshot_files (hash);

-- Content-addressed blob store, deduplicated per user: the same bytes
-- referenced by several files, several variants or several games are stored
-- once. Rows are only inserted once the bytes are verified on disk, and are
-- garbage collected when the last referencing manifest row disappears.
CREATE TABLE cloud_save_blobs (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    hash TEXT NOT NULL,
    size_in_bytes INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, hash)
);
