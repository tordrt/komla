//! Tells the desktop when its SSH host changed in a way only another Komla installation, or an
//! agent there, causes: a workspace manifest that installation wrote or removed, or one of its
//! managed tmux sessions starting or ending. The desktop syncs the host then, instead of asking it
//! on every focus. It is best-effort, like the rest of the companion: the desktop still syncs when
//! it connects.

use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsStr;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use komla::COMPANION_PROTOCOL_VERSION;
use serde::{Deserialize, Serialize};

use crate::transport::{OutboundRequest, OutboundTransport};

/// How often the manifest directory is listed. It is a few local stats, so changes reach the
/// desktop within seconds without relying on file system events, which some mounts lack.
const SCAN_INTERVAL_MS: u64 = 2_000;
/// The desktop reads no larger manifest, so its writer doesn't matter.
const MAX_MANIFEST_BYTES: u64 = 256 * 1024;
const INITIAL_RETRY_MS: u64 = 1_000;
const MAX_RETRY_MS: u64 = 60_000;

/// Where the workspace manifests are, and the id this installation writes in its own.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceManifestsConfig {
    pub(crate) directory: PathBuf,
    pub(crate) written_by: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostChangeNotice {
    protocol_version: u32,
    kind: &'static str,
}

impl HostChangeNotice {
    pub(crate) fn new() -> Self {
        Self {
            protocol_version: COMPANION_PROTOCOL_VERSION,
            kind: "ssh-host-changed",
        }
    }
}

/// A manifest file as last listed: its size and modification time.
type FileStamp = (u64, u128);

pub(crate) struct HostChanges {
    manifests: Option<WorkspaceManifestsConfig>,
    /// None until the first listing, which only sets what later ones compare with.
    listed: Option<BTreeMap<String, FileStamp>>,
    next_scan_at_ms: u64,
    /// Other installations' managed sessions, as the last check saw them.
    other_sessions: Option<BTreeSet<String>>,
    /// Counts changes, so a delivery only settles those made before it was sent.
    changes: u64,
    delivered: u64,
    in_flight: Option<u64>,
    retry_at_ms: u64,
    retry_delay_ms: u64,
}

impl HostChanges {
    pub(crate) fn new(manifests: Option<WorkspaceManifestsConfig>, now_ms: u64) -> Self {
        Self {
            manifests,
            listed: None,
            next_scan_at_ms: now_ms,
            other_sessions: None,
            changes: 0,
            delivered: 0,
            in_flight: None,
            retry_at_ms: now_ms,
            retry_delay_ms: INITIAL_RETRY_MS,
        }
    }

    /// The names of the managed tmux sessions other installations own, from a session check.
    /// The first only sets what later ones compare with: the desktop syncs as it connects.
    pub(crate) fn sessions_observed(&mut self, sessions: BTreeSet<String>) {
        if self
            .other_sessions
            .as_ref()
            .is_some_and(|previous| *previous != sessions)
        {
            self.changes += 1;
        }
        self.other_sessions = Some(sessions);
    }

    pub(crate) fn poll(&mut self, now_ms: u64, transport: &OutboundTransport) {
        if now_ms >= self.next_scan_at_ms {
            self.next_scan_at_ms = now_ms.saturating_add(SCAN_INTERVAL_MS);
            self.scan_manifests();
        }
        if self.in_flight.is_some() || self.delivered == self.changes || now_ms < self.retry_at_ms {
            return;
        }
        let changes = self.changes;
        if transport.submit(OutboundRequest::HostChanged {
            changes,
            notice: HostChangeNotice::new(),
        }) {
            self.in_flight = Some(changes);
        }
    }

    pub(crate) fn complete_delivery(&mut self, changes: u64, delivered: bool, now_ms: u64) {
        if self.in_flight != Some(changes) {
            return;
        }
        self.in_flight = None;
        if delivered {
            self.delivered = self.delivered.max(changes);
            self.retry_delay_ms = INITIAL_RETRY_MS;
        } else {
            self.retry_at_ms = now_ms.saturating_add(self.retry_delay_ms);
            self.retry_delay_ms = self.retry_delay_ms.saturating_mul(2).min(MAX_RETRY_MS);
        }
    }

    fn scan_manifests(&mut self) {
        let Some(config) = &self.manifests else {
            return;
        };
        let listing = list_manifests(&config.directory);
        let Some(previous) = self.listed.replace(listing) else {
            return;
        };
        let listing = self.listed.as_ref().expect("just listed");
        let removed = previous.keys().any(|name| !listing.contains_key(name));
        let written_elsewhere = listing.iter().any(|(name, stamp)| {
            previous.get(name) != Some(stamp)
                && !written_by(&config.directory.join(name), &config.written_by)
        });
        // Removed by whoever deleted the workspace, which may have been this installation.
        if removed || written_elsewhere {
            self.changes += 1;
        }
    }
}

/// The workspace manifests in `directory`, by name. A directory that isn't there yet has none.
fn list_manifests(directory: &Path) -> BTreeMap<String, FileStamp> {
    let Ok(entries) = fs::read_dir(directory) else {
        return BTreeMap::new();
    };
    entries
        .filter_map(Result::ok)
        .filter(|entry| entry.path().extension().and_then(OsStr::to_str) == Some("json"))
        .filter_map(|entry| {
            let metadata = entry
                .metadata()
                .ok()
                .filter(|metadata| metadata.is_file())?;
            let modified = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map_or(0, |since| since.as_nanos());
            Some((
                entry.file_name().to_string_lossy().into_owned(),
                (metadata.len(), modified),
            ))
        })
        .collect()
}

/// Whether this installation wrote the manifest. One that can't be read may be anyone's.
fn written_by(path: &Path, installation: &str) -> bool {
    let Ok(file) = fs::File::open(path) else {
        return false;
    };
    let mut contents = Vec::new();
    if file
        .take(MAX_MANIFEST_BYTES + 1)
        .read_to_end(&mut contents)
        .is_err()
        || contents.len() as u64 > MAX_MANIFEST_BYTES
    {
        return false;
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Writer {
        written_by: Option<String>,
    }
    serde_json::from_slice::<Writer>(&contents)
        .is_ok_and(|manifest| manifest.written_by.as_deref() == Some(installation))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifests(directory: &Path) -> HostChanges {
        HostChanges::new(
            Some(WorkspaceManifestsConfig {
                directory: directory.to_path_buf(),
                written_by: "this-device".to_owned(),
            }),
            0,
        )
    }

    fn write(directory: &Path, name: &str, written_by: &str) {
        fs::write(
            directory.join(name),
            format!(r#"{{"schema":1,"workspaceId":"ws","writtenBy":"{written_by}"}}"#),
        )
        .unwrap();
    }

    #[test]
    fn notices_manifests_other_installations_write_or_remove() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path();
        write(directory, "a.json", "other-device");
        let mut changes = manifests(directory);

        changes.scan_manifests();
        assert_eq!(
            changes.changes, 0,
            "the first listing only sets the baseline"
        );

        write(directory, "b.json", "this-device");
        changes.scan_manifests();
        assert_eq!(changes.changes, 0, "this installation's own write");

        write(directory, "c.json", "another-device-entirely");
        changes.scan_manifests();
        assert_eq!(changes.changes, 1);

        fs::write(directory.join("d.json"), "{half written").unwrap();
        changes.scan_manifests();
        assert_eq!(changes.changes, 2, "one that can't be read may be anyone's");

        fs::remove_file(directory.join("b.json")).unwrap();
        changes.scan_manifests();
        assert_eq!(changes.changes, 3);

        fs::write(directory.join("notes.txt"), "not a manifest").unwrap();
        changes.scan_manifests();
        assert_eq!(changes.changes, 3);
    }

    #[test]
    fn notices_a_directory_created_after_it_started() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("workspaces");
        let mut changes = manifests(&directory);
        changes.scan_manifests();

        fs::create_dir(&directory).unwrap();
        write(&directory, "a.json", "other-device");
        changes.scan_manifests();

        assert_eq!(changes.changes, 1);
    }

    #[test]
    fn notices_other_installations_sessions_starting_and_ending() {
        let mut changes = HostChanges::new(None, 0);
        let sessions = |names: &[&str]| names.iter().map(|name| (*name).to_owned()).collect();

        changes.sessions_observed(sessions(&["komla-a"]));
        changes.sessions_observed(sessions(&["komla-a"]));
        assert_eq!(changes.changes, 0);

        changes.sessions_observed(sessions(&["komla-a", "komla-b"]));
        changes.sessions_observed(sessions(&["komla-b"]));
        assert_eq!(changes.changes, 2);
    }

    #[test]
    fn a_delivery_settles_only_the_changes_made_before_it_was_sent() {
        let mut changes = HostChanges::new(None, 0);
        changes.changes = 1;
        changes.in_flight = Some(1);
        changes.changes = 2;

        changes.complete_delivery(1, true, 10);
        assert_eq!(changes.delivered, 1);
        assert_ne!(changes.delivered, changes.changes);

        changes.in_flight = Some(2);
        changes.complete_delivery(2, false, 10);
        assert_eq!(changes.retry_at_ms, 10 + INITIAL_RETRY_MS);
        assert_eq!(changes.retry_delay_ms, INITIAL_RETRY_MS * 2);
        assert_eq!(changes.delivered, 1);
    }
}
