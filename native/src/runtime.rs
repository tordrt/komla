use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context};
use komla::{
    CompanionSnapshotPayload, FileListFingerprint, RepositoryEventClassifier,
    RepositoryEventFilter, RepositoryEventKind, RepositoryWatchPaths, RepositoryWatchSignal,
    RepositoryWatcher, SnapshotDebounce, MAX_CHANGED_PATHS,
};
use serde::Deserialize;

use crate::clock::now_ms;
use crate::lifecycle::ManagedSessionMonitor;
use crate::mailbox::HookMailbox;
use crate::outbox::CommandOutbox;
use crate::scanner::{SnapshotScan, SnapshotScanner};
use crate::transport::{KomlaClient, OutboundRequest, OutboundResult, OutboundTransport};

const WATCH_EVENT_QUEUE_CAPACITY: usize = 1_024;
// Reloads can add workspaces after the transport exists; leave room for their snapshots.
const MIN_OUTBOUND_QUEUE_CAPACITY: usize = 64;
static SYNC_DIAGNOSTICS: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompanionConfig {
    #[serde(default)]
    diagnostics: bool,
    endpoint: String,
    installation_id: String,
    #[serde(default = "default_tmux_socket")]
    managed_tmux_socket: String,
    #[serde(default = "default_idle_exit_seconds")]
    idle_exit_seconds: u64,
    #[serde(default = "default_startup_grace_seconds")]
    startup_grace_seconds: u64,
    hook_inbox: Option<PathBuf>,
    workspaces: Vec<WorkspaceConfig>,
}

fn default_tmux_socket() -> String {
    "komla-v1".to_owned()
}

fn default_idle_exit_seconds() -> u64 {
    30
}

fn default_startup_grace_seconds() -> u64 {
    180
}

#[derive(Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceConfig {
    workspace_id: String,
    working_tree: PathBuf,
    target_branch: String,
}

struct WatchEvent {
    workspace_key: usize,
    event: notify::Result<notify::Event>,
}

#[derive(Clone)]
struct WatchEventSink {
    sender: SyncSender<WatchEvent>,
    overflowed: Arc<AtomicBool>,
}

impl WatchEventSink {
    fn new(sender: SyncSender<WatchEvent>, overflowed: Arc<AtomicBool>) -> Self {
        Self { sender, overflowed }
    }

    fn send(&self, event: WatchEvent) {
        match self.sender.try_send(event) {
            Ok(()) | Err(TrySendError::Disconnected(_)) => {}
            Err(TrySendError::Full(_)) => self.overflowed.store(true, Ordering::Release),
        }
    }
}

struct WatcherRecovery {
    retry_at_ms: Option<u64>,
    retry_delay_ms: u64,
}

impl WatcherRecovery {
    const INITIAL_RETRY_MS: u64 = 10_000;
    const MAX_RETRY_MS: u64 = 300_000;

    fn new() -> Self {
        Self {
            retry_at_ms: None,
            retry_delay_ms: Self::INITIAL_RETRY_MS,
        }
    }

    fn record_failure(&mut self, now_ms: u64) {
        self.retry_at_ms = Some(now_ms.saturating_add(self.retry_delay_ms));
        self.retry_delay_ms = self
            .retry_delay_ms
            .saturating_mul(2)
            .min(Self::MAX_RETRY_MS);
    }

    fn record_success(&mut self) {
        self.retry_at_ms = None;
        self.retry_delay_ms = Self::INITIAL_RETRY_MS;
    }

    fn request_restart(&mut self, now_ms: u64) {
        self.retry_at_ms = Some(now_ms);
    }

    fn should_retry(&self, now_ms: u64) -> bool {
        self.retry_at_ms.is_some_and(|retry_at| now_ms >= retry_at)
    }
}

struct WorkspaceRuntime {
    // Routes watcher, scan, and delivery results; stable across workspace list reloads.
    key: usize,
    config: WorkspaceConfig,
    paths: Option<RepositoryWatchPaths>,
    filter: Option<RepositoryEventFilter>,
    debounce: SnapshotDebounce,
    sequence: u64,
    pending: Option<CompanionSnapshotPayload>,
    retry_at_ms: u64,
    retry_delay_ms: u64,
    watcher_recovery: WatcherRecovery,
    watcher: Option<RepositoryWatcher>,
    event_overflowed: Arc<AtomicBool>,
    working_tree_dirty: bool,
    scan_working_tree_changed: bool,
    // The working-tree paths changed since the last scan started, and those the running scan
    // covers. `None` when anything may have changed.
    changed_paths: Option<BTreeSet<String>>,
    scan_changed_paths: Option<BTreeSet<String>>,
    // The last file-list fingerprint, and whether files may have come or gone since it was
    // taken and since the running scan started.
    file_list_hash: Option<String>,
    file_list_dirty: bool,
    scan_file_list_dirty: bool,
    scan_in_flight: bool,
    delivery_in_flight: bool,
}

/// Joins two sets of changed paths; unknown when either is or when there are too many.
fn merge_changed_paths(
    first: Option<BTreeSet<String>>,
    second: Option<BTreeSet<String>>,
) -> Option<BTreeSet<String>> {
    let (mut first, second) = (first?, second?);
    first.extend(second);
    (first.len() <= MAX_CHANGED_PATHS).then_some(first)
}

impl WorkspaceRuntime {
    fn initialize(
        config: WorkspaceConfig,
        workspace_key: usize,
        sender: SyncSender<WatchEvent>,
        now_ms: u64,
    ) -> Self {
        let event_overflowed = Arc::new(AtomicBool::new(false));
        let mut runtime = Self {
            key: workspace_key,
            config,
            paths: None,
            filter: None,
            debounce: SnapshotDebounce::default(),
            // Komla drops a repeated sequence with an unchanged state hash as a duplicate.
            // Starting from the clock keeps a re-added workspace or a restarted companion from
            // repeating an earlier sequence and losing its file-change signal.
            sequence: now_ms,
            pending: None,
            retry_at_ms: 0,
            retry_delay_ms: 1_000,
            watcher_recovery: WatcherRecovery::new(),
            watcher: None,
            event_overflowed,
            working_tree_dirty: true,
            scan_working_tree_changed: true,
            changed_paths: None,
            scan_changed_paths: None,
            file_list_hash: None,
            file_list_dirty: true,
            scan_file_list_dirty: true,
            scan_in_flight: false,
            delivery_in_flight: false,
        };
        if let Err(error) = runtime.load_repository(workspace_key, sender, now_ms) {
            eprintln!(
                "workspace initialization failed for {}: {error:#}",
                runtime.config.workspace_id
            );
            runtime.watcher_recovery.record_failure(now_ms);
        }
        runtime
    }

    fn load_repository(
        &mut self,
        workspace_key: usize,
        sender: SyncSender<WatchEvent>,
        now_ms: u64,
    ) -> anyhow::Result<()> {
        trace_sync(
            self,
            format_args!(
                "watcher-load existing={} recovery_delay_ms={}",
                self.paths.is_some(),
                self.watcher_recovery.retry_delay_ms
            ),
        );
        // Recovery after a failed watcher may have missed source changes. Ordinary
        // rebuilds (for example after an index change) retain their event kinds.
        if self.watcher_recovery.retry_delay_ms > WatcherRecovery::INITIAL_RETRY_MS {
            self.mark_working_tree_unknown();
        }
        let paths = RepositoryWatchPaths::discover(&self.config.working_tree)?;
        let filter = RepositoryEventFilter::load(&self.config.working_tree)?;
        let event_sink = WatchEventSink::new(sender, self.event_overflowed.clone());
        let watcher = RepositoryWatcher::start(&paths, &filter, move |event| {
            event_sink.send(WatchEvent {
                workspace_key,
                event,
            });
        });
        self.paths = Some(paths);
        self.filter = Some(filter);
        self.watcher = match watcher {
            Ok(watcher) => {
                self.watcher_recovery.record_success();
                Some(watcher)
            }
            Err(error) => {
                eprintln!(
                    "native watcher could not be started for {}: {error:#}",
                    self.config.workspace_id
                );
                self.watcher_recovery.record_failure(now_ms);
                None
            }
        };
        self.debounce.mark_integrity_lost(now_ms);
        Ok(())
    }

    fn record_snapshot_failure(&mut self, now_ms: u64) {
        self.working_tree_dirty |= self.scan_working_tree_changed;
        self.changed_paths =
            merge_changed_paths(self.scan_changed_paths.take(), self.changed_paths.take());
        self.file_list_dirty |= self.scan_file_list_dirty;
        self.debounce.mark_dirty(now_ms.saturating_add(1_000));
    }

    /// Records a working-tree change whose paths aren't known.
    fn mark_working_tree_unknown(&mut self) {
        self.working_tree_dirty = true;
        self.changed_paths = None;
        self.file_list_dirty = true;
    }
}

pub(crate) fn serve(config_path: &str) -> anyhow::Result<()> {
    let config = read_config(Path::new(config_path))?;
    run(config, ConfigReload::new(config_path))
}

fn read_config(config_path: &Path) -> anyhow::Result<CompanionConfig> {
    let contents = fs::read_to_string(config_path)
        .with_context(|| format!("could not read companion config {}", config_path.display()))?;
    serde_json::from_str(&contents).context("invalid companion config")
}

/// Komla points `current-config` beside the startup config at a replacement whose only
/// changes are the monitored workspaces or diagnostics. Applying it in place keeps every
/// unchanged workspace's watcher state, so other workspaces are not resent as changed.
struct ConfigReload {
    pointer: PathBuf,
    current: String,
    failed: Option<String>,
    next_check_at_ms: u64,
}

impl ConfigReload {
    const CHECK_INTERVAL_MS: u64 = 1_000;

    fn new(config_path: &str) -> Self {
        Self {
            pointer: Path::new(config_path).with_file_name("current-config"),
            current: config_path.to_owned(),
            failed: None,
            next_check_at_ms: 0,
        }
    }

    fn poll(&mut self, now_ms: u64) -> Option<CompanionConfig> {
        if now_ms < self.next_check_at_ms {
            return None;
        }
        self.next_check_at_ms = now_ms.saturating_add(Self::CHECK_INTERVAL_MS);
        let requested = fs::read_to_string(&self.pointer).ok()?;
        let requested = requested.trim();
        if requested.is_empty() || requested == self.current {
            return None;
        }
        // Komla already recorded this config as running, so keep retrying until it applies.
        match read_config(Path::new(requested)) {
            Ok(config) => {
                self.current = requested.to_owned();
                self.failed = None;
                Some(config)
            }
            Err(error) => {
                if self.failed.as_deref() != Some(requested) {
                    eprintln!("companion config reload failed: {error:#}");
                    self.failed = Some(requested.to_owned());
                }
                None
            }
        }
    }
}

fn reload_workspaces(
    workspaces: &mut Vec<WorkspaceRuntime>,
    configs: Vec<WorkspaceConfig>,
    next_workspace_key: &mut usize,
    sender: &SyncSender<WatchEvent>,
    now_ms: u64,
) -> Vec<usize> {
    let mut removed = Vec::new();
    workspaces.retain(|workspace| {
        let keep = configs.contains(&workspace.config);
        if !keep {
            removed.push(workspace.key);
        }
        keep
    });
    for config in configs {
        if workspaces
            .iter()
            .any(|workspace| workspace.config == config)
        {
            continue;
        }
        workspaces.push(WorkspaceRuntime::initialize(
            config,
            *next_workspace_key,
            sender.clone(),
            now_ms,
        ));
        *next_workspace_key += 1;
    }
    removed
}

fn run(mut config: CompanionConfig, mut reload: ConfigReload) -> anyhow::Result<()> {
    SYNC_DIAGNOSTICS.store(config.diagnostics, Ordering::Relaxed);
    if config.workspaces.is_empty() {
        bail!("companion requires at least one monitored workspace");
    }
    let client = KomlaClient::new(config.endpoint.clone());
    let (sender, receiver) = mpsc::sync_channel(WATCH_EVENT_QUEUE_CAPACITY);
    let mut workspaces = Vec::with_capacity(config.workspaces.len());

    let mut next_workspace_key = 0;
    reload_workspaces(
        &mut workspaces,
        std::mem::take(&mut config.workspaces),
        &mut next_workspace_key,
        &sender,
        now_ms(),
    );

    let transport = OutboundTransport::new(
        client,
        workspaces
            .len()
            .max(MIN_OUTBOUND_QUEUE_CAPACITY)
            .saturating_add(2),
    );

    let mut outbox = CommandOutbox::open(config.hook_inbox.as_deref());
    let mut mailbox = HookMailbox::open(config.hook_inbox, now_ms())?;
    let mut scanner = SnapshotScanner::new();
    let mut session_monitor = ManagedSessionMonitor::new(
        config.managed_tmux_socket,
        config.installation_id.clone(),
        &config.endpoint,
        config.idle_exit_seconds,
        config.startup_grace_seconds,
        now_ms(),
    );
    loop {
        receive_events(&receiver, &mut workspaces);
        receive_scan_results(&mut scanner, &mut workspaces);
        receive_outbound_results(&transport, &mut workspaces, &mut mailbox, &mut outbox);
        let now = now_ms();
        if let Some(reloaded) = reload.poll(now) {
            SYNC_DIAGNOSTICS.store(reloaded.diagnostics, Ordering::Relaxed);
            for removed in reload_workspaces(
                &mut workspaces,
                reloaded.workspaces,
                &mut next_workspace_key,
                &sender,
                now,
            ) {
                scanner.forget(removed);
            }
        }
        for workspace in workspaces.iter_mut() {
            let workspace_key = workspace.key;
            restart_watcher_if_due(workspace, workspace_key, &sender, now);
            start_scan_if_due(workspace, workspace_key, &mut scanner, now);
            submit_snapshot_if_due(workspace, workspace_key, &transport, now);
        }
        if session_monitor.should_exit(now) {
            return Ok(());
        }
        mailbox.set_receiving(session_monitor.desktop_connected(now), now);
        outbox.poll(
            now,
            &transport,
            || mailbox.oldest_pending_at(),
            session_monitor.desktop_connected(now),
        );
        mailbox.poll(now, &transport, || outbox.oldest_queued_at());
    }
}

fn restart_watcher_if_due(
    workspace: &mut WorkspaceRuntime,
    workspace_key: usize,
    sender: &SyncSender<WatchEvent>,
    now_ms: u64,
) {
    if !workspace.watcher_recovery.should_retry(now_ms) {
        return;
    }
    if let Err(error) = workspace.load_repository(workspace_key, sender.clone(), now_ms) {
        eprintln!(
            "workspace could not be reinitialized for {}: {error:#}",
            workspace.config.workspace_id
        );
        workspace.watcher_recovery.record_failure(now_ms);
    }
}

fn start_scan_if_due(
    workspace: &mut WorkspaceRuntime,
    workspace_key: usize,
    scanner: &mut SnapshotScanner,
    now_ms: u64,
) {
    if workspace.scan_in_flight {
        return;
    }
    if !workspace.debounce.take_if_due(now_ms) {
        return;
    }
    if workspace.paths.is_none() {
        return;
    }
    workspace.scan_working_tree_changed = std::mem::take(&mut workspace.working_tree_dirty);
    workspace.scan_changed_paths = workspace.changed_paths.replace(BTreeSet::new());
    workspace.scan_file_list_dirty = std::mem::take(&mut workspace.file_list_dirty);
    workspace.scan_in_flight = true;
    scanner.start(
        workspace_key,
        workspace.config.working_tree.clone(),
        workspace.config.target_branch.clone(),
        if workspace.scan_file_list_dirty {
            FileListFingerprint::Compute
        } else {
            FileListFingerprint::Keep(workspace.file_list_hash.clone())
        },
    );
}

fn receive_scan_results(scanner: &mut SnapshotScanner, workspaces: &mut [WorkspaceRuntime]) {
    while let Some(scan) = scanner.try_recv() {
        apply_scan_result(scan, workspaces);
    }
}

fn apply_scan_result(scan: SnapshotScan, workspaces: &mut [WorkspaceRuntime]) {
    let Some(workspace) = find_workspace(workspaces, scan.workspace_key) else {
        return;
    };
    workspace.scan_in_flight = false;
    match scan.result {
        Ok(snapshot) => {
            let Some(paths) = workspace.paths.as_ref() else {
                return;
            };
            workspace.file_list_hash = snapshot.file_list_hash.clone();
            let mut payload = match CompanionSnapshotPayload::new(
                workspace.config.workspace_id.clone(),
                paths.working_tree.to_string_lossy().into_owned(),
                workspace.sequence.saturating_add(1),
                scan.observed_at,
                snapshot,
            ) {
                Ok(payload) => payload,
                Err(error) => {
                    eprintln!(
                        "snapshot encoding failed for {}: {error:#}",
                        workspace.config.workspace_id
                    );
                    workspace.record_snapshot_failure(scan.observed_at);
                    return;
                }
            };
            // Keep a file-change signal until its snapshot has been delivered, even
            // when a later metadata-only scan replaces the pending snapshot.
            payload.working_tree_changed = workspace.scan_working_tree_changed
                || workspace
                    .pending
                    .as_ref()
                    .is_some_and(|pending| pending.working_tree_changed);
            // Likewise keep the paths of an undelivered snapshot. Changes during the scan may
            // already show in it too, so name them as well; the next scan names them again.
            let pending_paths = match workspace.pending.as_ref() {
                Some(pending) => pending
                    .changed_paths
                    .as_ref()
                    .map(|paths| paths.iter().cloned().collect()),
                None => Some(BTreeSet::new()),
            };
            payload.changed_paths = merge_changed_paths(
                merge_changed_paths(workspace.scan_changed_paths.take(), pending_paths),
                workspace.changed_paths.clone(),
            )
            .map(|paths| paths.into_iter().collect());
            trace_sync(
                workspace,
                format_args!(
                    "snapshot sequence={} working_tree_changed={} state_hash={}",
                    payload.sequence, payload.working_tree_changed, payload.state_hash
                ),
            );
            // A debounced watcher rescan can reflect changed file contents even when
            // Git status, line counts, and branch counts are unchanged. Publish a
            // new sequence so consumers can refresh their local copies in that case.
            workspace.sequence = payload.sequence;
            workspace.pending = Some(payload);
            workspace.retry_at_ms = scan.observed_at;
            workspace.retry_delay_ms = 1_000;
        }
        Err(error) => {
            eprintln!(
                "snapshot failed for {}: {error:#}",
                workspace.config.workspace_id
            );
            workspace.record_snapshot_failure(scan.observed_at);
        }
    }
}

fn submit_snapshot_if_due(
    workspace: &mut WorkspaceRuntime,
    workspace_key: usize,
    transport: &OutboundTransport,
    now_ms: u64,
) {
    if workspace.delivery_in_flight || workspace.pending.is_none() || now_ms < workspace.retry_at_ms
    {
        return;
    }
    let request = OutboundRequest::Snapshot {
        workspace_key,
        payload: Box::new(
            workspace
                .pending
                .as_ref()
                .expect("pending payload exists")
                .clone(),
        ),
    };
    if transport.submit(request) {
        workspace.delivery_in_flight = true;
    }
}

fn receive_outbound_results(
    transport: &OutboundTransport,
    workspaces: &mut [WorkspaceRuntime],
    mailbox: &mut HookMailbox,
    outbox: &mut CommandOutbox,
) {
    while let Some(result) = transport.try_recv() {
        match result {
            OutboundResult::Snapshot {
                workspace_key,
                payload,
                delivered,
            } => {
                let Some(workspace) = find_workspace(workspaces, workspace_key) else {
                    continue;
                };
                workspace.delivery_in_flight = false;
                let matches_pending = workspace.pending.as_ref().is_some_and(|pending| {
                    pending.sequence == payload.sequence && pending.state_hash == payload.state_hash
                });
                if !matches_pending {
                    continue;
                }
                if delivered {
                    workspace.pending = None;
                    workspace.retry_delay_ms = 1_000;
                } else {
                    let now_ms = now_ms();
                    workspace.retry_at_ms = now_ms.saturating_add(workspace.retry_delay_ms);
                    workspace.retry_delay_ms = (workspace.retry_delay_ms * 2).min(60_000);
                }
            }
            OutboundResult::Hook {
                request_id,
                delivery,
            } => mailbox.complete_delivery(request_id, delivery, now_ms()),
            OutboundResult::Command {
                request_id,
                delivery,
            } => outbox.complete_delivery(request_id, delivery, now_ms()),
        }
    }
}

fn receive_events(receiver: &Receiver<WatchEvent>, workspaces: &mut [WorkspaceRuntime]) {
    let deadline = std::time::Instant::now() + Duration::from_millis(50);
    if let Ok(event) = receiver.recv_timeout(Duration::from_millis(50)) {
        apply_event(event, workspaces);
    }
    let mut drained = 0;
    while drained < 256 && std::time::Instant::now() < deadline {
        match receiver.try_recv() {
            Ok(event) => {
                apply_event(event, workspaces);
                drained += 1;
            }
            Err(_) => break,
        }
    }
    let observed_at = now_ms();
    for workspace in workspaces {
        if workspace.event_overflowed.swap(false, Ordering::AcqRel) {
            trace_sync(workspace, format_args!("watch-event-queue-overflow"));
            workspace.mark_working_tree_unknown();
            workspace.debounce.mark_integrity_lost(observed_at);
        }
    }
}

fn apply_event(event: WatchEvent, workspaces: &mut [WorkspaceRuntime]) {
    let Some(workspace) = find_workspace(workspaces, event.workspace_key) else {
        return;
    };
    let (Some(paths), Some(filter)) = (workspace.paths.as_ref(), workspace.filter.as_ref()) else {
        return;
    };
    let description = SYNC_DIAGNOSTICS
        .load(Ordering::Relaxed)
        .then(|| format!("{:?}", event.event));
    let signal = RepositoryEventClassifier::analyze(paths, filter, event.event);
    if let (Some(description), Some(signal)) = (&description, &signal) {
        trace_sync(
            workspace,
            format_args!("watch-event={description} classified={signal:?}"),
        );
    }
    match signal {
        Some(RepositoryWatchSignal::Changed {
            reload_ignore_rules,
            rebuild_watcher,
            kinds,
            paths,
            file_list_may_change,
        }) => {
            workspace.working_tree_dirty |= kinds.contains(&RepositoryEventKind::WorkingTree);
            workspace.file_list_dirty |= file_list_may_change;
            workspace.changed_paths = merge_changed_paths(
                workspace.changed_paths.take(),
                paths.map(|paths| paths.into_iter().collect()),
            );
            if reload_ignore_rules {
                match RepositoryEventFilter::load(&workspace.config.working_tree) {
                    Ok(filter) => workspace.filter = Some(filter),
                    Err(error) => {
                        eprintln!(
                            "ignore rules could not be reloaded for {}: {error:#}",
                            workspace.config.workspace_id
                        );
                        workspace.mark_working_tree_unknown();
                        workspace.debounce.mark_integrity_lost(now_ms());
                        return;
                    }
                }
            }
            if rebuild_watcher {
                // Keep watching until the replacement is ready.
                workspace.watcher_recovery.request_restart(now_ms());
            }
            workspace.debounce.mark_dirty(now_ms());
        }
        Some(RepositoryWatchSignal::IntegrityLost) => {
            workspace.mark_working_tree_unknown();
            workspace.debounce.mark_integrity_lost(now_ms());
            workspace.watcher = None;
            workspace.watcher_recovery.request_restart(now_ms());
        }
        None => {}
    }
}

fn find_workspace(
    workspaces: &mut [WorkspaceRuntime],
    workspace_key: usize,
) -> Option<&mut WorkspaceRuntime> {
    workspaces
        .iter_mut()
        .find(|workspace| workspace.key == workspace_key)
}

fn trace_sync(workspace: &WorkspaceRuntime, details: std::fmt::Arguments<'_>) {
    if SYNC_DIAGNOSTICS.load(Ordering::Relaxed) {
        eprintln!(
            "[komla-sync {} {:?}] {}",
            now_ms(),
            workspace.config.workspace_id,
            details
        );
    }
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    use std::process::Command;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    #[cfg(unix)]
    use std::time::{Duration, Instant};

    #[cfg(unix)]
    use komla::FileListFingerprint;
    use komla::{
        BranchObservation, CompanionSnapshotPayload, RepositoryEventFilter, RepositorySnapshot,
        RepositoryWatchPaths, SnapshotDebounce, MAX_CHANGED_PATHS, NAMES_CHANGED_PATHS,
    };
    use tempfile::tempdir;

    use super::{
        apply_scan_result, reload_workspaces, ConfigReload, WatchEvent, WatchEventSink,
        WatcherRecovery, WorkspaceConfig, WorkspaceRuntime,
    };
    use crate::scanner::{SnapshotScan, SnapshotScanner};

    fn repository_snapshot() -> RepositorySnapshot {
        RepositorySnapshot {
            status_b64: String::new(),
            numstat_b64: String::new(),
            status_too_large: false,
            file_list_hash: None,
            branch: BranchObservation {
                current_branch: "feature".to_owned(),
                target_branch: "main".to_owned(),
                default_branch: "main".to_owned(),
                ahead_target_branch: 0,
                behind_target_branch: 0,
                has_remote: false,
                has_origin_remote: false,
                unpushed_commits: 0,
                behind_remote: 0,
                target_branch_has_remote: false,
                target_branch_ahead_remote: 0,
                target_branch_behind_remote: 0,
            },
        }
    }

    fn snapshot() -> CompanionSnapshotPayload {
        CompanionSnapshotPayload::new(
            "workspace-1".to_owned(),
            "/repo".to_owned(),
            7,
            1_700_000_000_000,
            repository_snapshot(),
        )
        .unwrap()
    }

    #[test]
    fn invalid_workspace_initialization_does_not_reject_valid_workspaces() {
        let temp = tempdir().unwrap();
        let repository = temp.path().join("repository");
        std::fs::create_dir(&repository).unwrap();
        let initialized = Command::new("git")
            .arg("init")
            .current_dir(&repository)
            .output()
            .unwrap();
        assert!(initialized.status.success());
        let (sender, _receiver) = std::sync::mpsc::sync_channel(4);

        let invalid = WorkspaceRuntime::initialize(
            WorkspaceConfig {
                workspace_id: "missing".to_owned(),
                working_tree: temp.path().join("missing"),
                target_branch: "main".to_owned(),
            },
            0,
            sender.clone(),
            1_000,
        );
        let valid = WorkspaceRuntime::initialize(
            WorkspaceConfig {
                workspace_id: "valid".to_owned(),
                working_tree: repository,
                target_branch: "main".to_owned(),
            },
            1,
            sender,
            1_000,
        );

        assert!(invalid.paths.is_none());
        assert!(valid.paths.is_some());
    }

    #[test]
    fn workspace_reload_keeps_unchanged_workspace_state() {
        let temp = tempdir().unwrap();
        let config = |workspace_id: &str| WorkspaceConfig {
            workspace_id: workspace_id.to_owned(),
            working_tree: temp.path().join(workspace_id),
            target_branch: "main".to_owned(),
        };
        let (sender, _receiver) = std::sync::mpsc::sync_channel(4);
        let mut workspaces = Vec::new();
        let mut next_key = 0;
        reload_workspaces(
            &mut workspaces,
            vec![config("kept"), config("removed")],
            &mut next_key,
            &sender,
            1_000,
        );
        // The kept workspace has delivered its initial snapshot.
        workspaces[0].working_tree_dirty = false;

        let removed = reload_workspaces(
            &mut workspaces,
            vec![config("kept"), config("added")],
            &mut next_key,
            &sender,
            2_000,
        );

        assert_eq!(removed, [1]);
        let summary: Vec<_> = workspaces
            .iter()
            .map(|workspace| {
                (
                    workspace.config.workspace_id.as_str(),
                    workspace.key,
                    workspace.working_tree_dirty,
                )
            })
            .collect();
        assert_eq!(summary, [("kept", 0, false), ("added", 2, true)]);

        // Re-adding a removed workspace does not repeat its earlier sequences.
        let earlier = workspaces[0].sequence;
        reload_workspaces(
            &mut workspaces,
            vec![config("added")],
            &mut next_key,
            &sender,
            3_000,
        );
        reload_workspaces(
            &mut workspaces,
            vec![config("added"), config("kept")],
            &mut next_key,
            &sender,
            4_000,
        );
        assert_eq!(earlier, 1_000);
        assert_eq!(workspaces[1].sequence, 4_000);
    }

    #[test]
    fn config_reload_follows_the_current_config_pointer() {
        let temp = tempdir().unwrap();
        let startup = temp.path().join("startup.json");
        let replacement = temp.path().join("replacement.json");
        let pointer = temp.path().join("current-config");
        std::fs::write(
            &replacement,
            r#"{"endpoint":"http://127.0.0.1:1/","installationId":"i","diagnostics":true,
                "workspaces":[{"workspaceId":"w","workingTree":"/repo","targetBranch":"main"}]}"#,
        )
        .unwrap();
        let mut reload = ConfigReload::new(startup.to_str().unwrap());

        assert!(reload.poll(0).is_none());
        std::fs::write(&pointer, format!("{}\n", startup.display())).unwrap();
        assert!(reload.poll(1_000).is_none());
        std::fs::write(&pointer, format!("{}\n", replacement.display())).unwrap();
        assert!(reload.poll(1_500).is_none(), "checks are rate limited");
        let config = reload
            .poll(2_000)
            .expect("pointer change reloads the config");
        assert_eq!(config.workspaces[0].workspace_id, "w");

        // A config that cannot be read yet is retried rather than treated as applied.
        let later = temp.path().join("later.json");
        std::fs::write(&pointer, format!("{}\n", later.display())).unwrap();
        assert!(reload.poll(2_500).is_none());
        assert!(reload.poll(3_500).is_none());
        std::fs::copy(&replacement, &later).unwrap();
        let config = reload
            .poll(4_500)
            .expect("a readable config applies on retry");
        assert!(config.diagnostics);
        assert_eq!(config.workspaces[0].workspace_id, "w");
        assert!(
            reload.poll(5_500).is_none(),
            "an applied config is not reloaded again"
        );
    }

    #[test]
    fn watcher_rebuilds_back_off_after_failures() {
        let mut recovery = WatcherRecovery::new();

        recovery.record_failure(1_000);
        assert!(!recovery.should_retry(10_999));
        assert!(recovery.should_retry(11_000));

        recovery.record_failure(11_000);
        assert!(!recovery.should_retry(30_999));
        assert!(recovery.should_retry(31_000));
    }

    #[test]
    fn watcher_event_handoff_is_bounded_and_reports_overflow() {
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        let overflowed = Arc::new(AtomicBool::new(false));
        let sink = WatchEventSink::new(sender, overflowed.clone());
        let event = || WatchEvent {
            workspace_key: 0,
            event: Ok(notify::Event::new(notify::EventKind::Any)),
        };

        sink.send(event());
        sink.send(event());

        assert!(overflowed.load(Ordering::Acquire));
        assert!(receiver.try_recv().is_ok());
        assert!(receiver.try_recv().is_err());
    }

    #[test]
    fn failed_snapshot_scan_retains_the_last_pending_value() {
        let temp = tempdir().unwrap();
        let repository = temp.path().join("repository");
        std::fs::create_dir(&repository).unwrap();
        let initialized = Command::new("git")
            .arg("init")
            .current_dir(&repository)
            .output()
            .unwrap();
        assert!(initialized.status.success());
        let paths = RepositoryWatchPaths::discover(&repository).unwrap();
        let filter = RepositoryEventFilter::load(&repository).unwrap();
        let payload = snapshot();
        let mut workspace = WorkspaceRuntime {
            key: 0,
            config: WorkspaceConfig {
                workspace_id: "workspace-1".to_owned(),
                working_tree: repository,
                target_branch: "main".to_owned(),
            },
            paths: Some(paths),
            filter: Some(filter),
            debounce: SnapshotDebounce::default(),
            sequence: payload.sequence,
            pending: Some(payload.clone()),
            retry_at_ms: 0,
            retry_delay_ms: 1_000,
            watcher_recovery: WatcherRecovery::new(),
            watcher: None,
            event_overflowed: Arc::new(AtomicBool::new(false)),
            working_tree_dirty: true,
            scan_working_tree_changed: true,
            changed_paths: None,
            scan_changed_paths: None,
            file_list_hash: None,
            file_list_dirty: true,
            scan_file_list_dirty: true,
            scan_in_flight: false,
            delivery_in_flight: false,
        };

        workspace.record_snapshot_failure(2_000);

        assert_eq!(workspace.pending, Some(payload));
    }

    #[test]
    fn watcher_rescan_publishes_even_when_git_summary_is_unchanged() {
        let temp = tempdir().unwrap();
        let repository = temp.path().join("repository");
        std::fs::create_dir(&repository).unwrap();
        let initialized = Command::new("git")
            .arg("init")
            .current_dir(&repository)
            .output()
            .unwrap();
        assert!(initialized.status.success());
        let paths = RepositoryWatchPaths::discover(&repository).unwrap();
        let filter = RepositoryEventFilter::load(&repository).unwrap();
        let payload = snapshot();
        let mut workspaces = [WorkspaceRuntime {
            key: 0,
            config: WorkspaceConfig {
                workspace_id: "workspace-1".to_owned(),
                working_tree: repository,
                target_branch: "main".to_owned(),
            },
            paths: Some(paths),
            filter: Some(filter),
            debounce: SnapshotDebounce::default(),
            sequence: payload.sequence,
            pending: None,
            retry_at_ms: 0,
            retry_delay_ms: 1_000,
            watcher_recovery: WatcherRecovery::new(),
            watcher: None,
            event_overflowed: Arc::new(AtomicBool::new(false)),
            working_tree_dirty: true,
            scan_working_tree_changed: true,
            changed_paths: None,
            scan_changed_paths: None,
            file_list_hash: None,
            file_list_dirty: true,
            scan_file_list_dirty: true,
            scan_in_flight: true,
            delivery_in_flight: false,
        }];

        apply_scan_result(
            SnapshotScan {
                workspace_key: 0,
                observed_at: 2_000,
                result: Ok(repository_snapshot()),
            },
            &mut workspaces,
        );

        let next = workspaces[0]
            .pending
            .as_ref()
            .expect("watcher rescan must be delivered");
        assert_eq!(next.state_hash, payload.state_hash);
        assert_eq!(next.sequence, payload.sequence + 1);
        assert_eq!(next.observed_at, 2_000);
        assert_eq!(workspaces[0].sequence, next.sequence);
    }

    #[test]
    fn file_signals_survive_metadata_scans_and_watcher_recovery() {
        let temp = tempdir().unwrap();
        assert!(Command::new("git")
            .arg("init")
            .current_dir(temp.path())
            .output()
            .unwrap()
            .status
            .success());
        let (sender, _receiver) = std::sync::mpsc::sync_channel(1024);
        let mut workspaces = [WorkspaceRuntime::initialize(
            WorkspaceConfig {
                workspace_id: "workspace-1".to_owned(),
                working_tree: temp.path().to_path_buf(),
                target_branch: "main".to_owned(),
            },
            0,
            sender.clone(),
            1_000,
        )];
        let mut scanner = SnapshotScanner::new();

        // Initial synchronization is explicit, even with a clean repository.
        super::start_scan_if_due(&mut workspaces[0], 0, &mut scanner, u64::MAX);
        let complete = |workspaces: &mut [WorkspaceRuntime]| {
            apply_scan_result(
                SnapshotScan {
                    workspace_key: 0,
                    observed_at: 2_000,
                    result: Ok(repository_snapshot()),
                },
                workspaces,
            );
        };
        complete(&mut workspaces);
        assert!(workspaces[0].pending.take().unwrap().working_tree_changed);

        let git_dir = workspaces[0].paths.as_ref().unwrap().git_dir.clone();
        let send_event = |path, workspaces: &mut [WorkspaceRuntime]| {
            super::apply_event(
                WatchEvent {
                    workspace_key: 0,
                    event: Ok(notify::Event::new(notify::EventKind::Modify(
                        notify::event::ModifyKind::Any,
                    ))
                    .add_path(path)),
                },
                workspaces,
            );
        };
        // A main ref update and an index-triggered watcher rebuild are metadata only.
        send_event(git_dir.join("refs/heads/main"), &mut workspaces);
        send_event(git_dir.join("index"), &mut workspaces);
        workspaces[0]
            .load_repository(0, sender.clone(), 2_000)
            .unwrap();
        super::start_scan_if_due(&mut workspaces[0], 0, &mut scanner, u64::MAX);
        // Files written during an in-flight scan belong to the next scan.
        // Watch paths are canonical (macOS temp dirs live under the /private symlink).
        send_event(
            temp.path().canonicalize().unwrap().join("source.txt"),
            &mut workspaces,
        );
        complete(&mut workspaces);
        assert!(!workspaces[0].pending.take().unwrap().working_tree_changed);
        super::start_scan_if_due(&mut workspaces[0], 0, &mut scanner, u64::MAX);
        complete(&mut workspaces);
        assert!(workspaces[0].pending.as_ref().unwrap().working_tree_changed);

        // Replacing an undelivered file snapshot must retain its sync request.
        send_event(git_dir.join("refs/heads/main"), &mut workspaces);
        super::start_scan_if_due(&mut workspaces[0], 0, &mut scanner, u64::MAX);
        complete(&mut workspaces);
        assert!(workspaces[0].pending.take().unwrap().working_tree_changed);
        send_event(git_dir.join("refs/heads/main"), &mut workspaces);
        super::start_scan_if_due(&mut workspaces[0], 0, &mut scanner, u64::MAX);
        complete(&mut workspaces);
        assert!(!workspaces[0].pending.take().unwrap().working_tree_changed);

        // Overflow and failed scans cannot lose the need to reconcile files.
        workspaces[0]
            .event_overflowed
            .store(true, Ordering::Release);
        super::receive_events(&std::sync::mpsc::channel().1, &mut workspaces);
        super::start_scan_if_due(&mut workspaces[0], 0, &mut scanner, u64::MAX);
        apply_scan_result(
            SnapshotScan {
                workspace_key: 0,
                observed_at: 3_000,
                result: Err(anyhow::anyhow!("scan failed")),
            },
            &mut workspaces,
        );
        super::start_scan_if_due(&mut workspaces[0], 0, &mut scanner, u64::MAX);
        complete(&mut workspaces);
        assert!(workspaces[0].pending.take().unwrap().working_tree_changed);
    }

    #[test]
    fn snapshots_name_every_path_changed_since_the_last_delivered_one() {
        let temp = tempdir().unwrap();
        assert!(Command::new("git")
            .arg("init")
            .current_dir(temp.path())
            .output()
            .unwrap()
            .status
            .success());
        let (sender, _receiver) = std::sync::mpsc::sync_channel(1024);
        let mut workspaces = [WorkspaceRuntime::initialize(
            WorkspaceConfig {
                workspace_id: "workspace-1".to_owned(),
                working_tree: temp.path().to_path_buf(),
                target_branch: "main".to_owned(),
            },
            0,
            sender,
            1_000,
        )];
        let mut scanner = SnapshotScanner::new();
        let working_tree = temp.path().canonicalize().unwrap();
        let git_dir = workspaces[0].paths.as_ref().unwrap().git_dir.clone();
        let send_event = |path: std::path::PathBuf, workspaces: &mut [WorkspaceRuntime]| {
            super::apply_event(
                WatchEvent {
                    workspace_key: 0,
                    event: Ok(notify::Event::new(notify::EventKind::Modify(
                        notify::event::ModifyKind::Any,
                    ))
                    .add_path(path)),
                },
                workspaces,
            );
        };
        let scan = |result: anyhow::Result<RepositorySnapshot>,
                    workspaces: &mut [WorkspaceRuntime],
                    scanner: &mut SnapshotScanner| {
            super::start_scan_if_due(&mut workspaces[0], 0, scanner, u64::MAX);
            apply_scan_result(
                SnapshotScan {
                    workspace_key: 0,
                    observed_at: 2_000,
                    result,
                },
                workspaces,
            );
            workspaces[0]
                .pending
                .as_ref()
                .map(|pending| pending.changed_paths.clone())
        };
        let names = |paths: &[&str]| {
            Some(NAMES_CHANGED_PATHS.then(|| paths.iter().map(|p| p.to_string()).collect()))
        };

        // Nothing is known about changes before the first snapshot.
        assert_eq!(
            scan(Ok(repository_snapshot()), &mut workspaces, &mut scanner),
            Some(None)
        );
        workspaces[0].pending = None;

        send_event(working_tree.join("src/app.ts"), &mut workspaces);
        assert_eq!(
            scan(Ok(repository_snapshot()), &mut workspaces, &mut scanner),
            names(&["src/app.ts"])
        );
        // An undelivered snapshot's paths carry into its replacement.
        send_event(working_tree.join("README.md"), &mut workspaces);
        assert_eq!(
            scan(Ok(repository_snapshot()), &mut workspaces, &mut scanner),
            names(&["README.md", "src/app.ts"])
        );
        workspaces[0].pending = None;

        // So do the paths of a failed scan.
        send_event(working_tree.join("failed.ts"), &mut workspaces);
        assert_eq!(
            scan(
                Err(anyhow::anyhow!("scan failed")),
                &mut workspaces,
                &mut scanner
            ),
            None
        );
        assert_eq!(
            scan(Ok(repository_snapshot()), &mut workspaces, &mut scanner),
            names(&["failed.ts"])
        );
        workspaces[0].pending = None;

        // A change during a scan may already show in it, so the scan names it too.
        send_event(working_tree.join("src/app.ts"), &mut workspaces);
        super::start_scan_if_due(&mut workspaces[0], 0, &mut scanner, u64::MAX);
        send_event(working_tree.join("README.md"), &mut workspaces);
        assert_eq!(
            scan(Ok(repository_snapshot()), &mut workspaces, &mut scanner),
            names(&["README.md", "src/app.ts"])
        );
        workspaces[0].pending = None;
        assert_eq!(
            scan(Ok(repository_snapshot()), &mut workspaces, &mut scanner),
            names(&["README.md"])
        );
        workspaces[0].pending = None;
        // Even a checkout, which the scan's branch may show without its files.
        send_event(working_tree.join("src/app.ts"), &mut workspaces);
        super::start_scan_if_due(&mut workspaces[0], 0, &mut scanner, u64::MAX);
        send_event(git_dir.join("HEAD"), &mut workspaces);
        assert_eq!(
            scan(Ok(repository_snapshot()), &mut workspaces, &mut scanner),
            Some(None)
        );
        workspaces[0].pending = None;

        // Git's own changes, lost events, and too many paths leave the paths unknown.
        send_event(working_tree.join("src/app.ts"), &mut workspaces);
        send_event(git_dir.join("refs/heads/main"), &mut workspaces);
        assert_eq!(
            scan(Ok(repository_snapshot()), &mut workspaces, &mut scanner),
            Some(None)
        );
        workspaces[0].pending = None;
        workspaces[0]
            .event_overflowed
            .store(true, Ordering::Release);
        super::receive_events(&std::sync::mpsc::channel().1, &mut workspaces);
        assert_eq!(
            scan(Ok(repository_snapshot()), &mut workspaces, &mut scanner),
            Some(None)
        );
        workspaces[0].pending = None;
        for index in 0..=MAX_CHANGED_PATHS {
            send_event(
                working_tree.join(format!("file-{index}.ts")),
                &mut workspaces,
            );
        }
        assert_eq!(
            scan(Ok(repository_snapshot()), &mut workspaces, &mut scanner),
            Some(None)
        );
    }

    #[test]
    fn keeps_the_file_list_fingerprint_until_files_may_come_or_go() {
        let temp = tempdir().unwrap();
        let git = |args: &[&str]| {
            let output = Command::new("git")
                .args(args)
                .current_dir(temp.path())
                .output()
                .unwrap();
            assert!(output.status.success());
        };
        git(&["init"]);
        std::fs::write(temp.path().join("a.txt"), "a\n").unwrap();
        git(&["add", "a.txt"]);
        git(&[
            "-c",
            "user.name=Komla",
            "-c",
            "user.email=komla@example.com",
            "commit",
            "-m",
            "initial",
        ]);
        let (sender, _receiver) = std::sync::mpsc::sync_channel(1024);
        let mut workspaces = [WorkspaceRuntime::initialize(
            WorkspaceConfig {
                workspace_id: "workspace-1".to_owned(),
                working_tree: temp.path().to_path_buf(),
                target_branch: "main".to_owned(),
            },
            0,
            sender,
            1_000,
        )];
        let mut scanner = SnapshotScanner::new();
        let working_tree = temp.path().canonicalize().unwrap();
        let send_event =
            |kind: notify::EventKind, path: &str, workspaces: &mut [WorkspaceRuntime]| {
                super::apply_event(
                    WatchEvent {
                        workspace_key: 0,
                        event: Ok(notify::Event::new(kind).add_path(working_tree.join(path))),
                    },
                    workspaces,
                );
            };
        let scan = |workspaces: &mut [WorkspaceRuntime], scanner: &mut SnapshotScanner| {
            super::start_scan_if_due(&mut workspaces[0], 0, scanner, u64::MAX);
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
            let scan = loop {
                if let Some(scan) = scanner.try_recv() {
                    break scan;
                }
                assert!(std::time::Instant::now() < deadline, "scan did not finish");
                std::thread::sleep(std::time::Duration::from_millis(5));
            };
            apply_scan_result(scan, workspaces);
            workspaces[0]
                .pending
                .take()
                .unwrap()
                .file_list_hash
                .unwrap()
        };
        let edit = notify::EventKind::Modify(notify::event::ModifyKind::Data(
            notify::event::DataChange::Content,
        ));

        let first = scan(&mut workspaces, &mut scanner);
        // Edits keep the fingerprint without listing the files again, so a file that came
        // without an event goes unnoticed...
        std::fs::write(temp.path().join("b.txt"), "b\n").unwrap();
        send_event(edit, "a.txt", &mut workspaces);
        assert_eq!(scan(&mut workspaces, &mut scanner), first);
        // ...until a change that may add or remove one.
        send_event(
            notify::EventKind::Create(notify::event::CreateKind::File),
            "b.txt",
            &mut workspaces,
        );
        let second = scan(&mut workspaces, &mut scanner);
        assert_ne!(second, first);
        std::fs::write(temp.path().join("c.txt"), "c\n").unwrap();
        workspaces[0]
            .event_overflowed
            .store(true, Ordering::Release);
        super::receive_events(&std::sync::mpsc::channel().1, &mut workspaces);
        assert_ne!(scan(&mut workspaces, &mut scanner), second);
    }

    #[cfg(unix)]
    #[test]
    fn snapshot_scans_do_not_block_the_host_runtime() {
        let temp = tempdir().unwrap();
        let repository = temp.path().join("repository");
        fs::create_dir(&repository).unwrap();
        let initialized = Command::new("git")
            .arg("init")
            .current_dir(&repository)
            .output()
            .unwrap();
        assert!(initialized.status.success());
        let hook = temp.path().join("fsmonitor.sh");
        fs::write(&hook, "#!/bin/sh\nsleep 2\nprintf '2\\n'\n").unwrap();
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o700)).unwrap();
        let configured = Command::new("git")
            .args(["config", "core.fsmonitor", hook.to_str().unwrap()])
            .current_dir(&repository)
            .output()
            .unwrap();
        assert!(configured.status.success());

        let mut scanner = SnapshotScanner::new();
        let started = Instant::now();
        scanner.start(
            0,
            repository,
            "main".to_owned(),
            FileListFingerprint::Compute,
        );

        assert!(started.elapsed() < Duration::from_millis(100));
        assert!(scanner.try_recv().is_none());
    }
}
