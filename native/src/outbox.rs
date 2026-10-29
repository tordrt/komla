//! Workspace commands an agent ran on an SSH host while no Komla installation answered (ADR
//! 0006). The CLI queues each beside the companion's hook inbox, and the companion delivers them
//! in order, as the CLI would have sent them, once its desktop answers.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use anyhow::Context;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::transport::{CommandDelivery, OutboundRequest, OutboundTransport};

const OUTBOX_DIRECTORY: &str = "outbox";
const SCAN_INTERVAL_MS: u64 = 1_000;
/// How often a command waiting for an older hook checks again.
const HELD_RECHECK_MS: u64 = 250;
/// How long a command waits for older hooks once it could go, so a hook Komla keeps failing on
/// can't hold it up for good.
const MAX_HOOK_WAIT_MS: u64 = 30_000;
/// A command Komla keeps failing on is dropped after this many tries, about five minutes apart
/// from the first, so it can't hold up the rest for good.
const MAX_FAILED_DELIVERIES: u32 = 10;
/// A command whose workspace Komla lacks is tried this often, `MISSING_RETRY_DELAY_MS` apart, a
/// minute in all: long enough for Komla's SSH Workspace Sync to add one created on the host, which
/// it checks for every 30 seconds, and short of holding up the rest for long.
const MAX_MISSING_DELIVERIES: u32 = 7;
const MISSING_RETRY_DELAY_MS: u64 = 10_000;
const MAX_RETRY_DELAY_MS: u64 = 60_000;
/// A CLI killed between writing a command and queuing it leaves this behind.
const ABANDONED_PARTIAL_AGE: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct QueuedCommand {
    /// Path and query under the desktop's API, as the CLI would have requested it.
    pub(crate) path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) terminal_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) workspace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) target_workspace_id: Option<String>,
    /// When the agent asked, in milliseconds since the epoch on this host's clock.
    pub(crate) requested_at: u64,
    pub(crate) operation: Value,
}

impl QueuedCommand {
    /// The CLI's context headers, and how long the command waited by this host's clock, from
    /// which the desktop counts a relative snooze on its own.
    pub(crate) fn headers(&self, now_ms: u64) -> Vec<(&'static str, String)> {
        let waited = now_ms.saturating_sub(self.requested_at);
        let mut headers = vec![("X-Komla-Queued-Ms", waited.to_string())];
        for (name, value) in [
            ("X-Komla-Terminal-Id", &self.terminal_id),
            ("X-Komla-Workspace-Id", &self.workspace_id),
            ("X-Komla-Target-Workspace-Id", &self.target_workspace_id),
        ] {
            if let Some(value) = value {
                headers.push((name, value.clone()));
            }
        }
        headers
    }
}

/// The outbox of the companion whose hook inbox is `inbox`.
pub(crate) fn directory_for(inbox: &Path) -> Option<PathBuf> {
    inbox
        .parent()
        .map(|companion| companion.join(OUTBOX_DIRECTORY))
}

/// What the desktop said the CLI answers for this operation, which the user turned off, as of
/// the companion config it last wrote beside `inbox`.
pub(crate) fn turned_off_message(inbox: &Path, operation_type: &str) -> Option<String> {
    let companion = inbox.parent()?;
    let pointer = fs::read_to_string(companion.join("current-config")).ok()?;
    let config = Path::new(pointer.trim());
    // The pointer names a config in the same directory; nothing else is the desktop's.
    if config.parent()? != companion {
        return None;
    }
    let config: Value = serde_json::from_slice(&fs::read(config).ok()?).ok()?;
    config
        .get("turnedOffCommands")?
        .get(operation_type)?
        .as_str()
        .map(str::to_owned)
}

/// Whether commands still wait in `outbox`, so a new one must queue behind them.
pub(crate) fn has_queued(outbox: &Path) -> bool {
    !queued(outbox).is_empty()
}

/// Queues a command behind the ones already waiting. Names sort in the order they were queued.
pub(crate) fn queue(outbox: &Path, command: &QueuedCommand) -> anyhow::Result<()> {
    create_private_dir(outbox).with_context(|| format!("could not create {}", outbox.display()))?;
    // Nanoseconds keep two commands an agent runs back to back in order.
    let queued_at = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let name = format!(
        "{queued_at:020}-{}.json",
        crate::offline_workspace::random_uuid()?
    );
    // Written aside first, so the companion never reads half a command. Titles and tags are
    // the user's, so only they may read them, as with hooks.
    let partial = outbox.join(format!(".{name}.partial"));
    let content = serde_json::to_vec(command)?;
    let written = private_file(&partial)
        .and_then(|mut file| file.write_all(&content).and_then(|()| file.sync_all()))
        .and_then(|()| fs::rename(&partial, outbox.join(&name)));
    if let Err(error) = written {
        let _ = fs::remove_file(&partial);
        return Err(error).with_context(|| format!("could not queue {name}"));
    }
    // The rename lasts a crash only once the outbox's own entry list is on disk.
    #[cfg(unix)]
    fs::File::open(outbox)
        .and_then(|directory| directory.sync_all())
        .with_context(|| format!("could not queue {name}"))?;
    Ok(())
}

#[cfg(unix)]
fn create_private_dir(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)
}

#[cfg(not(unix))]
fn create_private_dir(path: &Path) -> std::io::Result<()> {
    fs::create_dir_all(path)
}

fn private_file(path: &Path) -> std::io::Result<fs::File> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options.open(path)
}

/// The commands waiting, oldest first.
fn queued(outbox: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(outbox) else {
        return Vec::new();
    };
    let mut paths: Vec<_> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("json"))
        .collect();
    paths.sort();
    paths
}

fn remove_abandoned_partials(outbox: &Path) {
    let Ok(entries) = fs::read_dir(outbox) else {
        return;
    };
    for path in entries.filter_map(Result::ok).map(|entry| entry.path()) {
        let abandoned = path.extension().and_then(|value| value.to_str()) == Some("partial")
            && fs::metadata(&path)
                .and_then(|metadata| metadata.modified())
                .is_ok_and(|written| {
                    written
                        .elapsed()
                        .is_ok_and(|age| age > ABANDONED_PARTIAL_AGE)
                });
        if abandoned {
            let _ = fs::remove_file(&path);
        }
    }
}

/// Delivers a companion's outbox, one command at a time.
pub(crate) struct CommandOutbox {
    directory: Option<PathBuf>,
    in_flight: Option<(u64, PathBuf)>,
    failed_deliveries: u32,
    missing_deliveries: u32,
    /// When the oldest command began waiting for older hooks while the desktop answered.
    held_since_ms: Option<u64>,
    next_attempt_at_ms: u64,
    next_request_id: u64,
}

impl CommandOutbox {
    pub(crate) fn open(inbox: Option<&Path>) -> Self {
        let directory = inbox.and_then(directory_for);
        if let Some(directory) = &directory {
            remove_abandoned_partials(directory);
        }
        Self {
            directory,
            in_flight: None,
            failed_deliveries: 0,
            missing_deliveries: 0,
            held_since_ms: None,
            next_attempt_at_ms: 0,
            next_request_id: 1,
        }
    }

    /// When the oldest waiting command was queued. A hook written at or after it waits for it,
    /// so the desktop sees them in the order the agent ran them.
    pub(crate) fn oldest_queued_at(&self) -> Option<SystemTime> {
        let directory = self.directory.as_deref()?;
        queued(directory).first().and_then(|path| {
            fs::metadata(path)
                .and_then(|metadata| metadata.modified())
                .ok()
        })
    }

    /// Delivers the oldest command, unless a hook written before it still waits, for up to
    /// `MAX_HOOK_WAIT_MS` of the desktop answering: `hooks_from` says when the oldest was
    /// written, and is asked only when there is a command to deliver.
    pub(crate) fn poll(
        &mut self,
        now_ms: u64,
        transport: &OutboundTransport,
        hooks_from: impl FnOnce() -> Option<SystemTime>,
        desktop_answers: bool,
    ) {
        if self.in_flight.is_some() || now_ms < self.next_attempt_at_ms {
            return;
        }
        let Some(path) = self
            .directory
            .as_deref()
            .and_then(|directory| queued(directory).into_iter().next())
        else {
            self.next_attempt_at_ms = now_ms.saturating_add(SCAN_INTERVAL_MS);
            return;
        };
        let queued_at = fs::metadata(&path).and_then(|metadata| metadata.modified());
        // On a tie the command goes first; the hook waits for it.
        let held = hooks_from()
            .is_some_and(|hooks_from| queued_at.is_ok_and(|queued_at| hooks_from < queued_at));
        if held && !desktop_answers {
            self.held_since_ms = None;
            self.next_attempt_at_ms = now_ms.saturating_add(SCAN_INTERVAL_MS);
            return;
        }
        let held_since_ms = *self.held_since_ms.get_or_insert(now_ms);
        if held && now_ms.saturating_sub(held_since_ms) < MAX_HOOK_WAIT_MS {
            self.next_attempt_at_ms = now_ms.saturating_add(HELD_RECHECK_MS);
            return;
        }
        self.held_since_ms = None;
        let command = match fs::read(&path)
            .map_err(anyhow::Error::from)
            .and_then(|body| Ok(serde_json::from_slice::<QueuedCommand>(&body)?))
        {
            Ok(command) => command,
            Err(error) => {
                eprintln!(
                    "dropping unreadable queued command {}: {error:#}",
                    path.display()
                );
                let _ = fs::remove_file(&path);
                return;
            }
        };
        let request_id = self.next_request_id;
        if transport.submit(OutboundRequest::Command {
            request_id,
            command: Box::new(command),
        }) {
            self.next_request_id = request_id.saturating_add(1);
            self.in_flight = Some((request_id, path));
        } else {
            self.next_attempt_at_ms = now_ms.saturating_add(100);
        }
    }

    pub(crate) fn complete_delivery(
        &mut self,
        request_id: u64,
        delivery: CommandDelivery,
        now_ms: u64,
    ) {
        let Some((in_flight, path)) = self.in_flight.take() else {
            return;
        };
        if in_flight != request_id {
            self.in_flight = Some((in_flight, path));
            return;
        }
        let retry_in_ms = match delivery {
            CommandDelivery::Accepted => None,
            CommandDelivery::Rejected(reason) => {
                eprintln!("dropping a queued command Komla rejected: {reason}");
                None
            }
            CommandDelivery::Failed(reason) => {
                self.failed_deliveries += 1;
                (self.failed_deliveries < MAX_FAILED_DELIVERIES)
                    .then(|| (1_000_u64 << self.failed_deliveries.min(16)).min(MAX_RETRY_DELAY_MS))
                    .or_else(|| {
                        eprintln!("dropping a queued command Komla keeps failing on: {reason}");
                        None
                    })
            }
            CommandDelivery::Missing(reason) => {
                self.missing_deliveries += 1;
                (self.missing_deliveries < MAX_MISSING_DELIVERIES)
                    .then_some(MISSING_RETRY_DELAY_MS)
                    .or_else(|| {
                        eprintln!(
                            "dropping a queued command for a workspace Komla lacks: {reason}"
                        );
                        None
                    })
            }
            // Komla is away: wait for it as long as it takes, counting tries afresh after.
            CommandDelivery::Retry => {
                self.failed_deliveries = 0;
                self.missing_deliveries = 0;
                Some(SCAN_INTERVAL_MS)
            }
        };
        match retry_in_ms {
            Some(delay) => self.next_attempt_at_ms = now_ms.saturating_add(delay),
            None => {
                let _ = fs::remove_file(&path);
                self.failed_deliveries = 0;
                self.missing_deliveries = 0;
                self.next_attempt_at_ms = now_ms;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    use serde_json::json;
    use tempfile::TempDir;

    use super::*;
    use crate::transport::{KomlaClient, OutboundResult};

    /// Answers one request with `status` and hands back what it received.
    fn serve_once(status: u16) -> (String, thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_millis(200)))
                .unwrap();
            let mut request = Vec::new();
            let mut buffer = [0_u8; 4096];
            while let Ok(read) = stream.read(&mut buffer) {
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..read]);
                let text = String::from_utf8_lossy(&request);
                if text.contains("\r\n\r\n") && text.ends_with('}') {
                    break;
                }
            }
            write!(
                stream,
                "HTTP/1.1 {status} Test\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            )
            .unwrap();
            String::from_utf8(request).unwrap()
        });
        (endpoint, server)
    }

    fn transport(endpoint: &str) -> OutboundTransport {
        OutboundTransport::new(
            KomlaClient::new(format!("{endpoint}/api/v1/ssh-workspace-status")),
            2,
        )
    }

    fn deliver(outbox: &mut CommandOutbox, transport: &OutboundTransport, now_ms: u64) {
        outbox.poll(now_ms, transport, || None, true);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            if let Some(OutboundResult::Command {
                request_id,
                delivery,
            }) = transport.try_recv()
            {
                outbox.complete_delivery(request_id, delivery, now_ms);
                return;
            }
            assert!(std::time::Instant::now() < deadline, "no delivery result");
            thread::yield_now();
        }
    }

    fn queued_outbox() -> (TempDir, PathBuf, CommandOutbox) {
        let temporary = TempDir::new().unwrap();
        let inbox = temporary.path().join("inbox");
        let directory = directory_for(&inbox).unwrap();
        queue(&directory, &command(1_000, "first")).unwrap();
        queue(&directory, &command(2_000, "second")).unwrap();
        (temporary, directory, CommandOutbox::open(Some(&inbox)))
    }

    #[test]
    fn delivers_the_oldest_command_as_the_cli_would_have_sent_it() {
        let (_temporary, directory, mut outbox) = queued_outbox();
        let (endpoint, server) = serve_once(200);
        let transport = transport(&endpoint);

        deliver(&mut outbox, &transport, 0);

        let request = server.join().unwrap();
        assert!(
            request.starts_with("POST /api/v1/commands HTTP/1.1\r\n"),
            "{request}"
        );
        assert!(
            request.contains("X-Komla-Terminal-Id: terminal-1\r\n"),
            "{request}"
        );
        assert!(request.contains("X-Komla-Queued-Ms: "), "{request}");
        assert!(
            request.ends_with(r#"{"title":"first","type":"workspace.title"}"#),
            "{request}"
        );
        assert_eq!(queued(&directory).len(), 1);
    }

    #[test]
    fn keeps_a_command_until_komla_answers() {
        let (_temporary, directory, mut outbox) = queued_outbox();
        let transport = transport("http://127.0.0.1:1");

        deliver(&mut outbox, &transport, 0);

        assert_eq!(queued(&directory).len(), 2);
        assert_eq!(
            outbox.oldest_queued_at(),
            fs::metadata(&queued(&directory)[0])
                .unwrap()
                .modified()
                .ok()
        );
    }

    #[test]
    fn waits_for_a_hook_written_before_it_but_not_one_written_with_it() {
        let (_temporary, directory, mut outbox) = queued_outbox();
        let queued_at = fs::metadata(&queued(&directory)[0])
            .unwrap()
            .modified()
            .unwrap();
        let transport = transport("http://127.0.0.1:1");

        outbox.poll(
            0,
            &transport,
            || Some(queued_at - std::time::Duration::from_secs(1)),
            true,
        );
        assert!(outbox.in_flight.is_none(), "an older hook goes first");
        outbox.poll(HELD_RECHECK_MS, &transport, || Some(queued_at), true);
        assert!(
            outbox.in_flight.is_some(),
            "on a tie the command goes first"
        );
    }

    #[test]
    fn stops_waiting_for_a_hook_komla_keeps_failing_on() {
        let (_temporary, directory, mut outbox) = queued_outbox();
        let queued_at = fs::metadata(&queued(&directory)[0])
            .unwrap()
            .modified()
            .unwrap();
        let older_hook = || Some(queued_at - Duration::from_secs(1));
        let transport = transport("http://127.0.0.1:1");

        outbox.poll(0, &transport, older_hook, true);
        assert!(outbox.in_flight.is_none());
        outbox.poll(MAX_HOOK_WAIT_MS, &transport, older_hook, true);
        assert!(outbox.in_flight.is_some(), "it waited long enough");
    }

    // Komla can deliver neither while it is away, so the wait begins once it answers.
    #[test]
    fn waits_for_older_hooks_only_while_komla_answers() {
        let (_temporary, directory, mut outbox) = queued_outbox();
        let queued_at = fs::metadata(&queued(&directory)[0])
            .unwrap()
            .modified()
            .unwrap();
        let older_hook = || Some(queued_at - Duration::from_secs(1));
        let transport = transport("http://127.0.0.1:1");

        outbox.poll(0, &transport, older_hook, false);
        outbox.poll(MAX_HOOK_WAIT_MS, &transport, older_hook, false);
        outbox.poll(2 * MAX_HOOK_WAIT_MS, &transport, older_hook, true);
        assert!(outbox.in_flight.is_none(), "the wait only began now");
        outbox.poll(3 * MAX_HOOK_WAIT_MS, &transport, older_hook, true);
        assert!(outbox.in_flight.is_some());
    }

    #[test]
    fn gives_up_soon_on_a_workspace_komla_never_adds() {
        let (_temporary, directory, mut outbox) = queued_outbox();
        let path = queued(&directory)[0].clone();
        outbox.in_flight = Some((1, path.clone()));
        for attempt in 1..MAX_MISSING_DELIVERIES {
            outbox.complete_delivery(1, CommandDelivery::Missing("HTTP 404".to_owned()), 0);
            assert!(path.exists(), "try {attempt} keeps it");
            outbox.in_flight = Some((1, path.clone()));
        }
        outbox.complete_delivery(1, CommandDelivery::Missing("HTTP 404".to_owned()), 0);
        assert!(!path.exists());
    }

    #[test]
    fn server_errors_leave_the_tries_for_a_missing_workspace() {
        let (_temporary, directory, mut outbox) = queued_outbox();
        let path = queued(&directory)[0].clone();
        outbox.failed_deliveries = MAX_FAILED_DELIVERIES - 1;
        outbox.in_flight = Some((1, path.clone()));
        outbox.complete_delivery(1, CommandDelivery::Missing("HTTP 404".to_owned()), 0);

        assert!(path.exists());
    }

    #[test]
    fn counts_failures_afresh_after_komla_was_away() {
        let (_temporary, directory, mut outbox) = queued_outbox();
        let path = queued(&directory)[0].clone();
        outbox.failed_deliveries = MAX_FAILED_DELIVERIES - 1;
        outbox.in_flight = Some((1, path.clone()));
        outbox.complete_delivery(1, CommandDelivery::Retry, 0);
        outbox.in_flight = Some((1, path.clone()));
        outbox.complete_delivery(1, CommandDelivery::Failed("HTTP 500".to_owned()), 0);

        assert!(path.exists());
    }

    #[test]
    fn tries_again_later_when_komla_lacks_the_workspace_so_far() {
        let (_temporary, directory, mut outbox) = queued_outbox();
        let (endpoint, server) = serve_once(404);
        let transport = transport(&endpoint);

        deliver(&mut outbox, &transport, 0);

        server.join().unwrap();
        assert_eq!(queued(&directory).len(), 2);
        assert_eq!(outbox.next_attempt_at_ms, MISSING_RETRY_DELAY_MS);
    }

    #[cfg(unix)]
    #[test]
    fn only_the_user_may_read_queued_commands() {
        use std::os::unix::fs::PermissionsExt;
        let (temporary, directory, _outbox) = queued_outbox();
        let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;

        assert_eq!(mode(&directory), 0o700);
        assert_eq!(mode(&queued(&directory)[0]), 0o600);
        drop(temporary);
    }

    #[test]
    fn removes_what_a_killed_cli_left_half_written() {
        let (_temporary, directory, _outbox) = queued_outbox();
        let abandoned = directory.join(".abandoned.json.partial");
        let writing = directory.join(".writing.json.partial");
        fs::write(&abandoned, b"{").unwrap();
        fs::write(&writing, b"{").unwrap();
        fs::File::options()
            .write(true)
            .open(&abandoned)
            .unwrap()
            .set_modified(SystemTime::now() - Duration::from_secs(120))
            .unwrap();

        CommandOutbox::open(
            directory
                .parent()
                .map(|companion| companion.join("inbox"))
                .as_deref(),
        );

        assert!(!abandoned.exists());
        assert!(writing.exists(), "a CLI may still be writing it");
    }

    #[test]
    fn drops_a_command_komla_rejects() {
        let (_temporary, directory, mut outbox) = queued_outbox();
        let (endpoint, server) = serve_once(400);
        let transport = transport(&endpoint);

        deliver(&mut outbox, &transport, 0);

        server.join().unwrap();
        assert_eq!(queued(&directory).len(), 1);
    }

    fn command(requested_at: u64, title: &str) -> QueuedCommand {
        QueuedCommand {
            path: "/api/v1/commands".to_owned(),
            terminal_id: Some("terminal-1".to_owned()),
            workspace_id: None,
            target_workspace_id: None,
            requested_at,
            operation: json!({"type": "workspace.title", "title": title}),
        }
    }

    #[test]
    fn keeps_commands_in_the_order_they_were_queued() {
        let temporary = TempDir::new().unwrap();
        let outbox = directory_for(&temporary.path().join("inbox")).unwrap();
        queue(&outbox, &command(2_000, "first")).unwrap();
        queue(&outbox, &command(1_000, "second")).unwrap();

        let titles: Vec<_> = queued(&outbox)
            .iter()
            .map(|path| {
                let command: QueuedCommand =
                    serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
                command.operation["title"].as_str().unwrap().to_owned()
            })
            .collect();
        assert_eq!(titles, ["first", "second"]);
    }

    #[test]
    fn sends_the_context_the_cli_would_have_and_how_long_it_waited() {
        let headers = command(1_730_000_000_000, "Done").headers(1_730_000_090_000);
        assert_eq!(
            headers,
            [
                ("X-Komla-Queued-Ms", "90000".to_owned()),
                ("X-Komla-Terminal-Id", "terminal-1".to_owned()),
            ]
        );
    }
}
