//! Database backups.
//!
//! The save files on disk are content-addressed and easy to copy with any
//! tool; the database is the irreplaceable part. Lose it and every blob
//! becomes an unreferenced file nobody can map back to a game — so this
//! writes consistent point-in-time copies of it, on a schedule and on demand.
//!
//! `VACUUM INTO` is the mechanism: SQLite produces a fully consistent copy of
//! a live database without blocking writers, which a file copy of a WAL-mode
//! database cannot promise.

use crate::events::Event;
use crate::state::AppState;
use chrono::Utc;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// One backup on disk.
pub struct Backup {
    pub name: String,
    pub bytes: u64,
    pub created_at: String,
}

pub fn backup_json(backup: &Backup) -> Value {
    json!({
        "name": backup.name,
        "bytes": backup.bytes,
        "createdAt": backup.created_at,
    })
}

/// Backups are plain files in one directory; the name is the only identifier,
/// so it has to be impossible to point at anything else with one.
pub fn is_valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name.ends_with(".db")
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains("..")
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

pub async fn list(state: &AppState) -> Vec<Backup> {
    let dir = state.config.backup_dir();
    let Ok(mut entries) = tokio::fs::read_dir(&dir).await else {
        return Vec::new();
    };

    let mut backups = Vec::new();
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name().to_string_lossy().to_string();
        if !is_valid_name(&name) {
            continue;
        }
        let Ok(meta) = entry.metadata().await else {
            continue;
        };
        let created_at = meta
            .modified()
            .ok()
            .map(|time| chrono::DateTime::<Utc>::from(time).to_rfc3339())
            .unwrap_or_default();

        backups.push(Backup {
            name,
            bytes: meta.len(),
            created_at,
        });
    }

    /* Newest first: the one an operator wants is almost always the last one. */
    backups.sort_by(|a, b| b.name.cmp(&a.name));
    backups
}

pub fn path_for(state: &AppState, name: &str) -> Option<PathBuf> {
    is_valid_name(name).then(|| state.config.backup_dir().join(name))
}

/// Writes a new backup and prunes the oldest beyond the keep limit.
pub async fn create(state: &AppState, reason: &str) -> Result<Backup, String> {
    let dir = state.config.backup_dir();
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|err| format!("cannot create the backup directory: {err}"))?;

    let name = format!("hydra-{}.db", Utc::now().format("%Y%m%d-%H%M%S"));
    let path = dir.join(&name);

    /* Refuse rather than fill the disk: a backup that leaves no room for the
       next upload has traded one failure for a worse one. */
    if let (Some(free), Ok(meta)) = (
        free_disk_bytes(&state.config.data_dir),
        tokio::fs::metadata(state.config.database_path()).await,
    ) {
        if free < meta.len().saturating_mul(2) {
            return Err(format!(
                "not enough free space — the database is {} and only {} is free",
                meta.len(),
                free
            ));
        }
    }

    sqlx::query("VACUUM INTO ?")
        .bind(path.to_string_lossy().as_ref())
        .execute(&state.pool)
        .await
        .map_err(|err| format!("backup failed: {err}"))?;

    let bytes = tokio::fs::metadata(&path)
        .await
        .map(|meta| meta.len())
        .unwrap_or(0);

    let pruned = prune(state).await;

    crate::events::record(
        state,
        Event::system("system.backup", format!("Database backed up to {name}"))
            .detail(json!({ "name": name, "bytes": bytes, "reason": reason, "pruned": pruned }))
            .size(bytes as i64),
    )
    .await;

    Ok(Backup {
        name,
        bytes,
        created_at: Utc::now().to_rfc3339(),
    })
}

/// Deletes the oldest backups beyond `backup_keep`. Returns how many went.
pub async fn prune(state: &AppState) -> usize {
    let keep = state.config.backup_keep.max(1);
    let backups = list(state).await;

    let mut pruned = 0;
    for backup in backups.into_iter().skip(keep) {
        if let Some(path) = path_for(state, &backup.name) {
            if tokio::fs::remove_file(&path).await.is_ok() {
                pruned += 1;
            }
        }
    }

    pruned
}

/// Free bytes on the volume holding `path`.
///
/// The panel reports what this server stores; without this it cannot report
/// what is left, which is the number that decides whether the next upload
/// succeeds.
#[cfg(unix)]
pub fn free_disk_bytes(path: &Path) -> Option<u64> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let c_path = CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };

    /* SAFETY: c_path is a valid NUL-terminated string and stat is a live,
       correctly sized statvfs the call only writes into. */
    let ok = unsafe { libc::statvfs(c_path.as_ptr(), &mut stat) } == 0;
    /* Field widths differ between libc targets; the casts keep this
       compiling on all of them. */
    #[allow(clippy::unnecessary_cast)]
    ok.then(|| stat.f_bavail as u64 * stat.f_frsize as u64)
}

#[cfg(not(unix))]
pub fn free_disk_bytes(_path: &Path) -> Option<u64> {
    None
}

/// Total bytes on the volume holding `path`.
#[cfg(unix)]
pub fn total_disk_bytes(path: &Path) -> Option<u64> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let c_path = CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };

    /* SAFETY: as above. */
    let ok = unsafe { libc::statvfs(c_path.as_ptr(), &mut stat) } == 0;
    #[allow(clippy::unnecessary_cast)]
    ok.then(|| stat.f_blocks as u64 * stat.f_frsize as u64)
}

#[cfg(not(unix))]
pub fn total_disk_bytes(_path: &Path) -> Option<u64> {
    None
}

/// Hourly housekeeping: back up when due, prune old events.
///
/// Runs in-process rather than asking the operator to wire up cron, because
/// the whole premise of this server is that it is one binary you start.
pub fn spawn_scheduler(state: AppState) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(3600));
        /* The first tick fires immediately; skip it so a restart loop can't
           turn into a backup loop. */
        ticker.tick().await;

        loop {
            ticker.tick().await;

            let interval = state.config.backup_interval_hours;
            if interval > 0 && backup_due(&state, interval).await {
                match create(&state, "scheduled").await {
                    Ok(backup) => tracing::info!("scheduled backup written: {}", backup.name),
                    Err(error) => {
                        tracing::warn!("scheduled backup failed: {error}");
                        crate::events::record(
                            &state,
                            Event::system("system.backup_failed", format!("Backup failed: {error}"))
                                .warning(),
                        )
                        .await;
                    }
                }
            }

            match crate::events::prune(&state, state.config.event_retention_days).await {
                Ok(0) => {}
                Ok(removed) => tracing::info!("pruned {removed} event(s) past retention"),
                Err(err) => tracing::warn!("event pruning failed: {err}"),
            }
        }
    });
}

async fn backup_due(state: &AppState, interval_hours: u64) -> bool {
    let Some(latest) = list(state).await.into_iter().next() else {
        return true;
    };

    let Ok(created) = chrono::DateTime::parse_from_rfc3339(&latest.created_at) else {
        return true;
    };

    Utc::now() - created.with_timezone(&Utc) >= chrono::Duration::hours(interval_hours as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A backup name reaches the filesystem, so the guard is the only thing
    /// standing between a path parameter and an arbitrary file.
    #[test]
    fn only_plain_backup_names_are_accepted() {
        assert!(is_valid_name("hydra-20260811-102030.db"));

        assert!(!is_valid_name("../../etc/passwd"));
        assert!(!is_valid_name("nested/path.db"));
        assert!(!is_valid_name("hydra..db"));
        assert!(!is_valid_name("hydra-20260811.sqlite"));
        assert!(!is_valid_name(""));
        assert!(!is_valid_name(&format!("{}.db", "a".repeat(80))));
    }
}
