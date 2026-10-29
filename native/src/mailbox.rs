use std::ffi::OsStr;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, SystemTime};

use anyhow::Context;
use komla::PendingTerminalHook;
use notify::Watcher;
use sha2::Digest;

use crate::clock::now_ms;
use crate::transport::{HookDelivery, OutboundRequest, OutboundTransport};

const SCAN_INTERVAL_MS: u64 = 1_000;
/// A companion keeps this file fresh beside its inbox while its desktop is connected.
/// Alerts for terminals another device owns are copied to the inboxes of companions
/// that refreshed it recently.
const RECEIVING_FILE: &str = "receiving";
const RECEIVING_REFRESH_MS: u64 = 10_000;
const RECEIVING_FRESH_FOR: Duration = Duration::from_secs(30);

pub(crate) struct HookMailbox {
    inbox: Option<PathBuf>,
    _watcher: Option<notify::RecommendedWatcher>,
    receiver: Receiver<notify::Result<notify::Event>>,
    dirty: bool,
    next_delivery_at_ms: u64,
    next_scan_at_ms: u64,
    receiving: bool,
    next_receiving_at_ms: u64,
    next_request_id: u64,
    last_claimed_target: Option<PathBuf>,
    in_flight: Option<HookClaim>,
}

struct HookClaim {
    request_id: u64,
    claim: PathBuf,
    target: PathBuf,
}

impl HookMailbox {
    pub(crate) fn open(inbox: Option<PathBuf>, now_ms: u64) -> anyhow::Result<Self> {
        let (sender, receiver) = mpsc::channel();
        let watcher = if let Some(inbox) = &inbox {
            fs::create_dir_all(inbox)?;
            let watcher = notify::recommended_watcher(move |event| {
                let _ = sender.send(event);
            });
            match watcher {
                Ok(mut watcher) => {
                    match watcher.watch(inbox, notify::RecursiveMode::NonRecursive) {
                        Ok(()) => Some(watcher),
                        Err(error) => {
                            eprintln!("hook inbox watcher could not be started: {error:#}");
                            None
                        }
                    }
                }
                Err(error) => {
                    eprintln!("hook inbox watcher could not be created: {error:#}");
                    None
                }
            }
        } else {
            None
        };
        if let Some(inbox) = &inbox {
            if !recover_hook_claims(inbox) {
                eprintln!("pending hook claims could not be fully recovered");
            }
        }
        Ok(Self {
            dirty: inbox.is_some(),
            inbox,
            _watcher: watcher,
            receiver,
            next_delivery_at_ms: now_ms,
            next_scan_at_ms: now_ms,
            receiving: false,
            next_receiving_at_ms: now_ms,
            next_request_id: 1,
            last_claimed_target: None,
            in_flight: None,
        })
    }

    /// When the oldest hook still waiting for the desktop was written. A command queued after it
    /// waits for it, so the desktop sees them in the order the agent ran them.
    pub(crate) fn oldest_pending_at(&self) -> Option<SystemTime> {
        let inbox = self.inbox.as_deref()?;
        fs::read_dir(inbox)
            .ok()?
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| {
                matches!(
                    path.extension().and_then(OsStr::to_str),
                    Some("json" | "claim")
                )
            })
            // It goes after its terminal's prompt, which counts in its place.
            .filter(|path| !path.with_extension("prompt.json").exists())
            .filter_map(|path| {
                fs::metadata(path)
                    .and_then(|metadata| metadata.modified())
                    .ok()
            })
            .min()
    }

    /// Delivers the next pending hook, but none written since `held_from`: the agent ran a
    /// command queued then, which the desktop must see first. It is asked only when a hook is
    /// due.
    pub(crate) fn poll(
        &mut self,
        now_ms: u64,
        transport: &OutboundTransport,
        held_from: impl FnOnce() -> Option<SystemTime>,
    ) {
        while self.receiver.try_recv().is_ok() {
            self.dirty = true;
            self.next_delivery_at_ms = now_ms;
        }
        if self.inbox.is_some() && now_ms >= self.next_scan_at_ms {
            self.dirty = true;
            self.next_scan_at_ms = now_ms.saturating_add(SCAN_INTERVAL_MS);
        }
        if self.in_flight.is_some() || !self.dirty || now_ms < self.next_delivery_at_ms {
            return;
        }
        let Some(inbox) = self.inbox.as_deref() else {
            self.dirty = false;
            return;
        };
        if !recover_hook_claims(inbox) {
            eprintln!("pending hook claims could not be fully recovered");
            self.next_delivery_at_ms = now_ms.saturating_add(1_000);
            return;
        }
        let held_from = held_from();
        let claim = match claim_pending_hook(
            inbox,
            self.next_request_id,
            self.last_claimed_target.as_deref(),
            held_from,
        ) {
            Ok(Some(claim)) => claim,
            // Held hooks wait for the command to be delivered; with none, nothing waits.
            Ok(None) if held_from.is_some() && self.oldest_pending_at().is_some() => {
                self.next_delivery_at_ms = now_ms.saturating_add(250);
                return;
            }
            Ok(None) => {
                self.dirty = false;
                return;
            }
            Err(error) => {
                eprintln!("pending terminal hook could not be claimed: {error:#}");
                self.next_delivery_at_ms = now_ms.saturating_add(1_000);
                return;
            }
        };
        self.last_claimed_target = Some(claim.target.clone());
        let body = match fs::read(&claim.claim) {
            Ok(body) => body,
            Err(error) => {
                eprintln!("pending terminal hook could not be read: {error:#}");
                let _ = restore_hook_claim(&claim.claim, &claim.target);
                self.next_delivery_at_ms = now_ms.saturating_add(1_000);
                return;
            }
        };
        if transport.submit(OutboundRequest::Hook {
            request_id: claim.request_id,
            body,
        }) {
            self.next_request_id = self.next_request_id.saturating_add(1);
            self.in_flight = Some(claim);
            self.dirty = false;
        } else {
            let _ = restore_hook_claim(&claim.claim, &claim.target);
            self.next_delivery_at_ms = now_ms.saturating_add(100);
        }
    }

    /// Marks this device as receiving other devices' alerts while its desktop is connected,
    /// so a device that is away doesn't collect alerts to replay when it returns.
    pub(crate) fn set_receiving(&mut self, receiving: bool, now_ms: u64) {
        let Some(companion) = self.inbox.as_deref().and_then(Path::parent) else {
            return;
        };
        if !receiving {
            if std::mem::take(&mut self.receiving) {
                let _ = fs::remove_file(companion.join(RECEIVING_FILE));
            }
            return;
        }
        if !self.receiving || now_ms >= self.next_receiving_at_ms {
            mark_receiving(companion);
            self.receiving = true;
            self.next_receiving_at_ms = now_ms.saturating_add(RECEIVING_REFRESH_MS);
        }
    }

    pub(crate) fn complete_delivery(
        &mut self,
        request_id: u64,
        delivery: HookDelivery,
        now_ms: u64,
    ) {
        let Some(claim) = self.in_flight.take() else {
            return;
        };
        if claim.request_id != request_id {
            self.in_flight = Some(claim);
            return;
        }
        let accepted = match delivery {
            HookDelivery::Accepted => true,
            HookDelivery::PermanentlyRejected(status) => {
                eprintln!("dropping permanently rejected terminal hook: HTTP {status}");
                true
            }
            HookDelivery::Pending | HookDelivery::Retry => false,
        };
        let completed = if accepted {
            fs::remove_file(&claim.claim).is_ok()
        } else {
            restore_hook_claim(&claim.claim, &claim.target)
        };
        if !completed && claim.claim.exists() {
            let _ = restore_hook_claim(&claim.claim, &claim.target);
        }
        self.dirty = true;
        self.next_delivery_at_ms = if accepted && completed {
            now_ms
        } else if delivery == HookDelivery::Pending && completed {
            // Keep the unacknowledged event, but let newer activity supersede it
            // while the desktop's completion timer is still running.
            now_ms.saturating_add(25)
        } else {
            now_ms.saturating_add(1_000)
        };
    }
}

impl Drop for HookMailbox {
    fn drop(&mut self) {
        if let Some(companion) = self.inbox.as_deref().and_then(Path::parent) {
            let _ = fs::remove_file(companion.join(RECEIVING_FILE));
        }
    }
}

fn mark_receiving(companion: &Path) {
    let marked = fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .open(companion.join(RECEIVING_FILE))
        .and_then(|file| file.set_modified(SystemTime::now()));
    if let Err(error) = marked {
        eprintln!("could not mark this companion as receiving hooks: {error}");
    }
}

/// Whether hooks still wait in `inbox` for the desktop.
pub(crate) fn has_pending(inbox: &Path) -> bool {
    fs::read_dir(inbox).is_ok_and(|entries| {
        entries.filter_map(Result::ok).any(|entry| {
            matches!(
                entry.path().extension().and_then(OsStr::to_str),
                Some("json" | "claim")
            )
        })
    })
}

pub(crate) fn is_receiving(companion: &Path) -> bool {
    fs::metadata(companion.join(RECEIVING_FILE))
        .and_then(|metadata| metadata.modified())
        .is_ok_and(|modified| match modified.elapsed() {
            Ok(age) => age < RECEIVING_FRESH_FOR,
            // After the clock steps back, a marker is briefly in the future.
            Err(error) => error.duration() < RECEIVING_FRESH_FOR,
        })
}

fn claim_pending_hook(
    inbox: &Path,
    request_id: u64,
    after: Option<&Path>,
    held_from: Option<SystemTime>,
) -> anyhow::Result<Option<HookClaim>> {
    let mut paths = fs::read_dir(inbox)?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("json"))
        .collect::<Vec<_>>();
    paths.sort();
    let start = after
        .and_then(|previous| paths.iter().position(|path| path.as_path() > previous))
        .unwrap_or(0);
    let path_count = paths.len();
    for target in paths.into_iter().cycle().skip(start).take(path_count) {
        // A start event establishes identity before any coalesced event for the
        // same terminal/source, including after reconnect or round-robin wrap.
        if target.with_extension("prompt.json").exists() {
            continue;
        }
        if held_from.is_some_and(|held_from| {
            fs::metadata(&target)
                .and_then(|metadata| metadata.modified())
                .is_ok_and(|written| written >= held_from)
        }) {
            continue;
        }
        let claim = target.with_extension("claim");
        if fs::rename(&target, &claim).is_ok() {
            return Ok(Some(HookClaim {
                request_id,
                claim,
                target,
            }));
        }
    }
    Ok(None)
}

pub(crate) fn ingest(args: &[String]) -> anyhow::Result<()> {
    let inbox = PathBuf::from(
        args.get(2)
            .context("usage: komla notify <inbox> <source> <event> <terminal-id>")?,
    );
    let source = args.get(3).context("notify source is required")?.clone();
    let event = args.get(4).context("notify event is required")?.clone();
    let terminal_id = args
        .get(5)
        .context("notify terminal id is required")?
        .clone();
    if terminal_id.is_empty() {
        return Ok(());
    }
    let mut input = Vec::new();
    io::stdin()
        .take(65_537)
        .read_to_end(&mut input)
        .context("could not read hook input")?;
    if input.len() > 65_536 {
        input.clear();
    }
    let hook = PendingTerminalHook::from_hook(
        terminal_id.clone(),
        std::env::current_dir()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        source,
        event,
        &input,
    );
    deliver(&inbox, &hook)
}

/// Queues a hook for the device that owns the terminal, and copies it for every other
/// device whose companion receives on this host.
pub(crate) fn deliver(inbox: &Path, hook: &PendingTerminalHook) -> anyhow::Result<()> {
    ingest_pending(inbox, hook)?;
    copy_to_other_devices(inbox, hook);
    Ok(())
}

/// Tells the other devices showing a terminal that its agent was interrupted on the device
/// that owns `inbox`. An interrupt is a keystroke there, so no agent hook reports it. Each
/// source's interrupt replaces whatever hook that source still has waiting for a device, so
/// undelivered activity can't turn the spinner back on.
pub(crate) fn relay_interrupt(inbox: &Path, terminal_id: &str, sources: &[String]) {
    // Copies are matched by terminal, but Komla rejects a hook without a folder.
    let cwd = std::env::current_dir()
        .map(|dir| dir.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "/".to_owned());
    for source in sources {
        let hook = PendingTerminalHook::new(
            terminal_id.to_owned(),
            cwd.clone(),
            "interrupted".to_owned(),
            source.clone(),
            String::new(),
            serde_json::json!({}),
        );
        copy_to_other_devices(inbox, &hook);
    }
}

fn copy_to_other_devices(inbox: &Path, hook: &PendingTerminalHook) {
    let Some(owner) = inbox.parent() else {
        return;
    };
    // Companions live in `helpers/companion/<key>/inbox` under the host's Komla data folder.
    let Some(Ok(companions)) = owner
        .parent()
        .filter(|root| root.file_name() == Some(OsStr::new("companion")))
        .map(fs::read_dir)
    else {
        return;
    };
    let copy = PendingTerminalHook {
        copy: true,
        ..hook.clone()
    };
    for companion in companions.filter_map(Result::ok) {
        if Some(companion.file_name().as_os_str()) == owner.file_name()
            || !is_receiving(&companion.path())
        {
            continue;
        }
        // Best effort: the owner already has the hook.
        let _ = ingest_pending(&companion.path().join("inbox"), &copy);
    }
}

pub(crate) fn ingest_pending(inbox: &Path, hook: &PendingTerminalHook) -> anyhow::Result<()> {
    fs::create_dir_all(inbox)
        .with_context(|| format!("could not create hook inbox {}", inbox.display()))?;
    let mut key = sha2::Sha256::new();
    key.update(hook.terminal_id.as_bytes());
    key.update(b"\0");
    key.update(hook.source.as_bytes());
    let suffix = if hook.kind == "prompt-submit" {
        "prompt.json"
    } else {
        "json"
    };
    let name = format!("{:x}.{suffix}", key.finalize());
    let target = inbox.join(name);
    let temp = inbox.join(format!(".hook-{}-{}.tmp", std::process::id(), now_ms()));
    fs::write(&temp, serde_json::to_vec(&hook)?).context("could not write pending hook")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&temp, fs::Permissions::from_mode(0o600))?;
    }
    fs::rename(&temp, &target).context("could not publish pending hook")?;
    Ok(())
}

fn recover_hook_claims(inbox: &Path) -> bool {
    let Ok(entries) = fs::read_dir(inbox) else {
        return false;
    };
    let mut recovered = true;
    for entry in entries.filter_map(Result::ok) {
        let claim = entry.path();
        if claim.extension().and_then(|value| value.to_str()) != Some("claim") {
            continue;
        }
        let target = claim.with_extension("json");
        if !restore_hook_claim(&claim, &target) {
            recovered = false;
        }
    }
    recovered
}

fn restore_hook_claim(claim: &Path, target: &Path) -> bool {
    match fs::hard_link(claim, target) {
        Ok(()) => fs::remove_file(claim).is_ok(),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            fs::remove_file(claim).is_ok()
        }
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::thread;

    use tempfile::tempdir;

    use super::HookMailbox;
    use crate::transport::{KomlaClient, OutboundResult, OutboundTransport};

    fn read_framed_request(stream: &mut TcpStream) -> Vec<u8> {
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(1)))
            .unwrap();
        let mut request = Vec::new();
        let mut buffer = [0_u8; 4096];
        loop {
            let read = stream.read(&mut buffer).unwrap();
            request.extend_from_slice(&buffer[..read]);
            let Some(header_end) = request.windows(4).position(|window| window == b"\r\n\r\n")
            else {
                continue;
            };
            let headers = std::str::from_utf8(&request[..header_end]).unwrap();
            let content_length = headers
                .lines()
                .find_map(|line| {
                    line.split_once(':').and_then(|(name, value)| {
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().unwrap())
                    })
                })
                .unwrap_or(0);
            if request.len() >= header_end + 4 + content_length {
                return request;
            }
        }
    }

    fn serve_once(status: u16, body: &str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let response_body = body.to_owned();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let _request = read_framed_request(&mut stream);
            write!(
                stream,
                "HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                response_body.len(),
                response_body
            )
            .unwrap();
        });
        format!("http://{address}")
    }

    fn client(endpoint: String) -> KomlaClient {
        KomlaClient::new(format!("{endpoint}/api/v1/ssh-workspace-status"))
    }

    fn complete_hook_delivery(mailbox: &mut HookMailbox, transport: &OutboundTransport, now: u64) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
        loop {
            if let Some(OutboundResult::Hook {
                request_id,
                delivery,
            }) = transport.try_recv()
            {
                mailbox.complete_delivery(request_id, delivery, now);
                return;
            }
            assert!(std::time::Instant::now() < deadline);
            thread::yield_now();
        }
    }

    fn hook(kind: &str) -> komla::PendingTerminalHook {
        komla::PendingTerminalHook::new(
            "terminal".into(),
            "/repo".into(),
            kind.into(),
            "claude-code".into(),
            String::new(),
            serde_json::json!({}),
        )
    }

    fn pending_hooks(inbox: &std::path::Path) -> Vec<serde_json::Value> {
        let Ok(entries) = std::fs::read_dir(inbox) else {
            return Vec::new();
        };
        entries
            .filter_map(Result::ok)
            .map(|entry| serde_json::from_slice(&std::fs::read(entry.path()).unwrap()).unwrap())
            .collect()
    }

    #[test]
    fn hooks_are_copied_to_every_other_device_receiving_on_the_host() {
        let temp = tempdir().unwrap();
        let root = temp.path().join("helpers").join("companion");
        let owner = root.join("owner");
        let other = root.join("other");
        let gone = root.join("gone");
        for companion in [&owner, &other, &gone] {
            std::fs::create_dir_all(companion.join("inbox")).unwrap();
        }
        super::mark_receiving(&owner);
        super::mark_receiving(&other);
        std::fs::File::create(gone.join(super::RECEIVING_FILE))
            .unwrap()
            .set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(60))
            .unwrap();

        super::deliver(&owner.join("inbox"), &hook("turn-complete")).unwrap();

        let owned = pending_hooks(&owner.join("inbox"));
        assert_eq!(owned.len(), 1);
        assert!(owned[0].get("copy").is_none());
        let copied = pending_hooks(&other.join("inbox"));
        assert_eq!(copied.len(), 1);
        assert_eq!(copied[0]["copy"], true);
        assert_eq!(copied[0]["deliveryId"], owned[0]["deliveryId"]);
        assert!(
            pending_hooks(&gone.join("inbox")).is_empty(),
            "a device whose companion stopped must not collect hooks"
        );
    }

    #[test]
    fn a_mailbox_marks_its_device_as_receiving_only_while_its_desktop_is_connected() {
        let temp = tempdir().unwrap();
        let companion = temp.path().join("key");
        let mut mailbox = HookMailbox::open(Some(companion.join("inbox")), 0).unwrap();

        mailbox.set_receiving(true, 0);
        assert!(super::is_receiving(&companion));
        mailbox.set_receiving(false, 1_000);
        assert!(!super::is_receiving(&companion));

        mailbox.set_receiving(true, 2_000);
        drop(mailbox);
        assert!(!super::is_receiving(&companion));
    }

    #[test]
    fn prompt_and_tool_activity_are_copied_so_other_devices_show_the_agent_working() {
        let temp = tempdir().unwrap();
        let root = temp.path().join("helpers").join("companion");
        let (owner, other) = (root.join("owner"), root.join("other"));
        std::fs::create_dir_all(owner.join("inbox")).unwrap();
        std::fs::create_dir_all(other.join("inbox")).unwrap();
        super::mark_receiving(&other);

        for kind in ["prompt-submit", "activity"] {
            super::deliver(&owner.join("inbox"), &hook(kind)).unwrap();
        }

        assert_eq!(pending_hooks(&owner.join("inbox")).len(), 2);
        let copied = pending_hooks(&other.join("inbox"));
        assert_eq!(copied.len(), 2);
        assert!(copied.iter().all(|hook| hook["copy"] == true));
    }

    #[test]
    fn an_interrupt_reaches_only_the_other_devices_and_replaces_their_pending_activity() {
        let temp = tempdir().unwrap();
        let root = temp.path().join("helpers").join("companion");
        let (owner, other, gone) = (root.join("owner"), root.join("other"), root.join("gone"));
        for companion in [&owner, &other, &gone] {
            std::fs::create_dir_all(companion.join("inbox")).unwrap();
        }
        super::mark_receiving(&owner);
        super::mark_receiving(&other);
        super::deliver(&owner.join("inbox"), &hook("activity")).unwrap();

        super::relay_interrupt(
            &owner.join("inbox"),
            "terminal",
            &["claude-code".to_owned()],
        );

        let owned = pending_hooks(&owner.join("inbox"));
        assert_eq!(owned.len(), 1);
        assert_eq!(owned[0]["kind"], "activity");
        let copied = pending_hooks(&other.join("inbox"));
        assert_eq!(
            copied.len(),
            1,
            "the interrupt must supersede the stale activity"
        );
        assert_eq!(copied[0]["kind"], "interrupted");
        assert_eq!(copied[0]["terminalId"], "terminal");
        assert_eq!(copied[0]["source"], "claude-code");
        assert_eq!(copied[0]["copy"], true);
        assert!(pending_hooks(&gone.join("inbox")).is_empty());
    }

    #[test]
    fn hooks_are_copied_only_between_companions_in_the_host_data_folder() {
        let temp = tempdir().unwrap();
        let (owner, other) = (temp.path().join("owner"), temp.path().join("other"));
        std::fs::create_dir_all(owner.join("inbox")).unwrap();
        std::fs::create_dir_all(other.join("inbox")).unwrap();
        super::mark_receiving(&other);

        super::deliver(&owner.join("inbox"), &hook("turn-complete")).unwrap();

        assert!(pending_hooks(&other.join("inbox")).is_empty());
    }

    #[test]
    fn a_marker_from_the_future_counts_only_briefly() {
        let temp = tempdir().unwrap();
        std::fs::File::create(temp.path().join(super::RECEIVING_FILE))
            .unwrap()
            .set_modified(std::time::SystemTime::now() + std::time::Duration::from_secs(60))
            .unwrap();

        assert!(!super::is_receiving(temp.path()));
    }

    #[test]
    fn prompt_start_survives_coalesced_activity_and_is_delivered_first() {
        let temp = tempdir().unwrap();
        let inbox = temp.path();
        for kind in ["prompt-submit", "activity", "activity"] {
            let hook = komla::PendingTerminalHook::new(
                "terminal".into(),
                "/repo".into(),
                kind.into(),
                "codex".into(),
                String::new(),
                serde_json::json!({"session_id": "root", "turn_id": "turn-2"}),
            );
            super::ingest_pending(inbox, &hook).unwrap();
        }
        // Even if round-robin previously visited this terminal, its prompt goes first.
        let previous = inbox.join("0.json");
        let first = super::claim_pending_hook(inbox, 1, Some(&previous), None)
            .unwrap()
            .unwrap();
        let payload: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&first.claim).unwrap()).unwrap();
        assert_eq!(payload["kind"], "prompt-submit");
        std::fs::remove_file(&first.claim).unwrap();
        let second = super::claim_pending_hook(inbox, 2, Some(&first.target), None)
            .unwrap()
            .unwrap();
        let payload: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&second.claim).unwrap()).unwrap();
        assert_eq!(payload["kind"], "activity");
        assert_eq!(payload["hookInput"]["turn_id"], "turn-2");
    }

    #[test]
    fn pending_completion_yields_to_newer_activity_without_acknowledging_it() {
        let temp = tempdir().unwrap();
        let inbox = temp.path().join("inbox");
        std::fs::create_dir(&inbox).unwrap();
        let hook = inbox.join("terminal.json");
        std::fs::write(&hook, br#"{"kind":"turn-complete"}"#).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            for (kind, status) in [("turn-complete", 202), ("activity", 200)] {
                let (mut stream, _) = listener.accept().unwrap();
                let request = String::from_utf8(read_framed_request(&mut stream)).unwrap();
                assert!(request.contains("X-Komla-Hook-Pending: retry"));
                assert!(request.contains(kind));
                write!(
                    stream,
                    "HTTP/1.1 {status} Test\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                )
                .unwrap();
            }
        });
        let transport = OutboundTransport::new(client(format!("http://{address}")), 2);
        let mut mailbox = HookMailbox::open(Some(inbox), 0).unwrap();
        mailbox.poll(0, &transport, || None);
        complete_hook_delivery(&mut mailbox, &transport, 10);
        assert!(hook.exists(), "202 is not a durable acknowledgement");
        std::fs::write(&hook, br#"{"kind":"activity"}"#).unwrap();
        mailbox.poll(100, &transport, || None);
        assert!(
            !hook.exists(),
            "new activity must be delivered within the completion grace period"
        );
        complete_hook_delivery(&mut mailbox, &transport, 110);
        server.join().unwrap();
        assert!(!hook.with_extension("claim").exists());
    }

    #[test]
    fn holds_hooks_written_after_a_queued_command() {
        let temp = tempdir().unwrap();
        let inbox = temp.path().join("inbox");
        std::fs::create_dir(&inbox).unwrap();
        let hook = inbox.join("terminal.json");
        std::fs::write(&hook, br#"{"kind":"turn-complete"}"#).unwrap();
        let written = std::fs::metadata(&hook).unwrap().modified().unwrap();
        let second = std::time::Duration::from_secs(1);

        let queued_before = super::claim_pending_hook(&inbox, 1, None, Some(written - second));
        assert!(
            queued_before.unwrap().is_none(),
            "a hook written after the command waits for it"
        );
        let queued_after = super::claim_pending_hook(&inbox, 2, None, Some(written + second));
        assert!(
            queued_after.unwrap().is_some(),
            "a hook written before the command goes first"
        );
    }

    // The older hook can't go before its prompt, so counting it would hold a command queued
    // between them, and the command would hold the prompt: neither would ever be delivered.
    #[test]
    fn a_hook_waiting_behind_its_prompt_does_not_hold_commands() {
        let temp = tempdir().unwrap();
        let inbox = temp.path().join("inbox");
        std::fs::create_dir(&inbox).unwrap();
        let activity = inbox.join("terminal.json");
        std::fs::write(&activity, br#"{"kind":"activity"}"#).unwrap();
        let prompt = inbox.join("terminal.prompt.json");
        std::fs::write(&prompt, br#"{"kind":"prompt"}"#).unwrap();
        let second = std::time::Duration::from_secs(1);
        let now = std::time::SystemTime::now();
        std::fs::File::options()
            .write(true)
            .open(&activity)
            .unwrap()
            .set_modified(now - second)
            .unwrap();

        let mailbox = HookMailbox::open(Some(inbox), 0).unwrap();

        assert_eq!(
            mailbox.oldest_pending_at(),
            std::fs::metadata(&prompt).unwrap().modified().ok()
        );
    }

    #[test]
    fn rests_while_commands_wait_but_no_hook_does() {
        let temp = tempdir().unwrap();
        let inbox = temp.path().join("inbox");
        std::fs::create_dir(&inbox).unwrap();
        let transport = OutboundTransport::new(client("http://127.0.0.1:1".to_owned()), 2);
        let mut mailbox = HookMailbox::open(Some(inbox), 0).unwrap();

        mailbox.poll(0, &transport, || Some(std::time::SystemTime::now()));

        assert!(
            !mailbox.dirty,
            "nothing is held, so nothing to check again soon"
        );
    }

    #[test]
    fn transient_hook_failure_retains_the_mailbox() {
        let temp = tempdir().unwrap();
        let inbox = temp.path().join("inbox");
        std::fs::create_dir(&inbox).unwrap();
        let hook = inbox.join("terminal.json");
        std::fs::write(&hook, br#"{"cwd":"/repo"}"#).unwrap();

        let transport = OutboundTransport::new(client(serve_once(503, "retry")), 2);
        let mut mailbox = HookMailbox::open(Some(inbox), 0).unwrap();

        mailbox.poll(0, &transport, || None);
        complete_hook_delivery(&mut mailbox, &transport, 1_000);

        assert!(hook.exists());
    }

    #[test]
    fn a_retrying_terminal_does_not_starve_other_pending_hooks() {
        let temp = tempdir().unwrap();
        let inbox = temp.path().join("inbox");
        std::fs::create_dir(&inbox).unwrap();
        let first = inbox.join("a.json");
        let second = inbox.join("b.json");
        std::fs::write(&first, br#"{"terminal":"a"}"#).unwrap();
        std::fs::write(&second, br#"{"terminal":"b"}"#).unwrap();

        let transport = OutboundTransport::new(client(serve_once(503, "retry")), 2);
        let mut mailbox = HookMailbox::open(Some(inbox), 0).unwrap();
        mailbox.poll(0, &transport, || None);
        complete_hook_delivery(&mut mailbox, &transport, 1_000);

        // Poll after the retry backoff rather than relying on watcher events to bypass it.
        mailbox.poll(2_000, &transport, || None);

        assert!(first.exists(), "the failed hook should remain pending");
        assert!(
            !second.exists(),
            "the next terminal should receive the delivery turn"
        );
    }

    #[test]
    fn hook_delivery_claims_the_acknowledged_generation_before_posting() {
        let temp = tempdir().unwrap();
        let inbox = temp.path().join("inbox");
        std::fs::create_dir(&inbox).unwrap();
        let hook = inbox.join("terminal.json");
        std::fs::write(&hook, br#"{"generation":"old"}"#).unwrap();

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (request_seen_sender, request_seen_receiver) = std::sync::mpsc::channel();
        let (respond_sender, respond_receiver) = std::sync::mpsc::channel();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let _request = read_framed_request(&mut stream);
            request_seen_sender.send(()).unwrap();
            let _ = respond_receiver.recv();
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            )
            .unwrap();
        });
        let transport = OutboundTransport::new(
            KomlaClient::new(format!("http://{address}/api/v1/ssh-workspace-status")),
            2,
        );
        let mut mailbox = HookMailbox::open(Some(inbox.clone()), 0).unwrap();
        mailbox.poll(0, &transport, || None);

        request_seen_receiver.recv().unwrap();
        let claimed_before_acceptance = !hook.exists();
        std::fs::write(&hook, br#"{"generation":"new"}"#).unwrap();
        respond_sender.send(()).unwrap();
        complete_hook_delivery(&mut mailbox, &transport, 1_000);

        assert!(
            claimed_before_acceptance,
            "the posted mailbox generation must be claimed atomically"
        );
        assert_eq!(std::fs::read(&hook).unwrap(), br#"{"generation":"new"}"#);
    }

    #[test]
    fn mailbox_poll_does_not_wait_for_hook_delivery() {
        let temp = tempdir().unwrap();
        let inbox = temp.path().join("inbox");
        std::fs::create_dir(&inbox).unwrap();
        std::fs::write(inbox.join("terminal.json"), br#"{"cwd":"/repo"}"#).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (accepted_sender, accepted_receiver) = std::sync::mpsc::channel();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let _request = read_framed_request(&mut stream);
            accepted_sender.send(()).unwrap();
            thread::sleep(std::time::Duration::from_millis(300));
            let _ = write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            );
        });
        let transport = OutboundTransport::new(
            KomlaClient::new(format!("http://{address}/api/v1/ssh-workspace-status")),
            2,
        );
        let mut mailbox = super::HookMailbox::open(Some(inbox), 0).unwrap();

        let started = std::time::Instant::now();
        mailbox.poll(0, &transport, || None);

        accepted_receiver
            .recv_timeout(std::time::Duration::from_secs(1))
            .unwrap();
        assert!(started.elapsed() < std::time::Duration::from_millis(100));
    }
}
