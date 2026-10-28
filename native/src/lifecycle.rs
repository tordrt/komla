use std::process::{Command, Output, Stdio};
use std::sync::mpsc::{self, Receiver, Sender};
use std::time::Duration;

use crate::transport::request_http;

/// How long one answer from the desktop counts, so it isn't asked on every check.
const DESKTOP_CONNECTION_VALID_MS: u64 = 15_000;
const DESKTOP_PROBE_TIMEOUT: Duration = Duration::from_secs(2);

/// The companion runs while its desktop owns a managed session here or answers through
/// its tunnel, since it then receives other devices' alerts for this host.
pub(crate) struct ManagedSessionMonitor {
    socket: String,
    installation_id: String,
    health_url: Option<String>,
    idle_exit_ms: u64,
    startup_deadline_ms: u64,
    has_seen_session: bool,
    sender: Sender<SessionCheck>,
    receiver: Receiver<SessionCheck>,
    check_in_flight: bool,
    next_check_at_ms: u64,
    no_sessions_since_ms: Option<u64>,
    desktop_connected_until_ms: u64,
}

#[derive(Clone, Copy)]
pub(crate) struct SessionCheck {
    pub(crate) owned: Option<bool>,
    pub(crate) desktop_connected: bool,
}

impl ManagedSessionMonitor {
    pub(crate) fn new(
        socket: String,
        installation_id: String,
        endpoint: &str,
        idle_exit_seconds: u64,
        startup_grace_seconds: u64,
        now_ms: u64,
    ) -> Self {
        let (sender, receiver) = mpsc::channel();
        Self {
            socket,
            installation_id,
            health_url: endpoint
                .strip_suffix("/api/v1/ssh-workspace-status")
                .map(|base| format!("{base}/api/v1/health")),
            idle_exit_ms: idle_exit_seconds.saturating_mul(1_000),
            startup_deadline_ms: now_ms.saturating_add(startup_grace_seconds.saturating_mul(1_000)),
            has_seen_session: false,
            sender,
            receiver,
            check_in_flight: false,
            next_check_at_ms: now_ms,
            no_sessions_since_ms: None,
            desktop_connected_until_ms: 0,
        }
    }

    pub(crate) fn should_exit(&mut self, now_ms: u64) -> bool {
        if !self.check_in_flight && now_ms >= self.next_check_at_ms {
            let socket = self.socket.clone();
            let installation_id = self.installation_id.clone();
            let health_url = self
                .health_url
                .clone()
                .filter(|_| !self.desktop_connected(now_ms));
            let sender = self.sender.clone();
            self.check_in_flight = true;
            std::thread::spawn(move || {
                let owned = managed_tmux_session_state(&socket, &installation_id);
                let desktop_connected =
                    health_url.is_some_and(|url| desktop_answers(&url, DESKTOP_PROBE_TIMEOUT));
                let _ = sender.send(SessionCheck {
                    owned,
                    desktop_connected,
                });
            });
        }
        let Ok(check) = self.receiver.try_recv() else {
            return false;
        };
        self.check_in_flight = false;
        self.next_check_at_ms = now_ms.saturating_add(5_000);
        self.record_check(check, now_ms)
    }

    /// Whether the desktop answered through its tunnel recently.
    pub(crate) fn desktop_connected(&self, now_ms: u64) -> bool {
        now_ms < self.desktop_connected_until_ms
    }

    fn record_check(&mut self, check: SessionCheck, now_ms: u64) -> bool {
        if check.desktop_connected {
            self.desktop_connected_until_ms = now_ms.saturating_add(DESKTOP_CONNECTION_VALID_MS);
        }
        if self.desktop_connected(now_ms) {
            return self.record_session_state(Some(true), now_ms);
        }
        self.record_session_state(check.owned, now_ms)
    }

    fn record_session_state(&mut self, state: Option<bool>, now_ms: u64) -> bool {
        match state {
            Some(true) => {
                self.has_seen_session = true;
                self.no_sessions_since_ms = None;
            }
            Some(false) => {
                if !self.has_seen_session {
                    return now_ms >= self.startup_deadline_ms;
                }
                let since = *self.no_sessions_since_ms.get_or_insert(now_ms);
                return now_ms.saturating_sub(since) >= self.idle_exit_ms;
            }
            None => self.no_sessions_since_ms = None,
        }
        false
    }
}

fn managed_tmux_session_state(socket: &str, installation_id: &str) -> Option<bool> {
    let mut command = Command::new("tmux");
    command
        .args([
            "-L",
            socket,
            "list-sessions",
            "-F",
            "#{session_name}\t#{@komla_installation_key}",
        ])
        .env_remove("TMUX")
        .stdin(Stdio::null());
    let output = run_command_with_deadline(&mut command, Duration::from_secs(1))?;
    if !output.status.success() {
        return Some(false);
    }
    Some(has_managed_session(
        &String::from_utf8_lossy(&output.stdout),
        installation_id,
    ))
}

/// A reverse tunnel can keep listening on the host after its desktop is gone, so the
/// desktop counts as connected only while Komla answers through it.
fn desktop_answers(health_url: &str, timeout: Duration) -> bool {
    request_http("GET", health_url, &[], &[], 1_024, Some(timeout))
        .is_ok_and(|response| response.status == 200)
}

fn has_managed_session(output: &str, installation_id: &str) -> bool {
    output.lines().any(|line| {
        let Some((name, owner)) = line.split_once('\t') else {
            return false;
        };
        name.starts_with("komla-")
            && !name.starts_with("komla-companion-")
            && owner == installation_id
    })
}

fn run_command_with_deadline(command: &mut Command, timeout: Duration) -> Option<Output> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn().ok()?;
    let deadline = std::time::Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return child.wait_with_output().ok(),
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(10));
            }
            Ok(None) | Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    use std::process::Command;
    use std::time::Duration;
    #[cfg(unix)]
    use std::time::Instant;

    #[cfg(unix)]
    use super::run_command_with_deadline;
    use super::{desktop_answers, has_managed_session, ManagedSessionMonitor, SessionCheck};

    #[test]
    fn startup_grace_keeps_the_companion_alive_until_the_first_session() {
        let mut monitor = ManagedSessionMonitor::new(
            "komla-v1".to_owned(),
            "install-a".to_owned(),
            "http://127.0.0.1:9/api/v1/ssh-workspace-status",
            30,
            180,
            1_000,
        );

        assert!(!monitor.record_session_state(Some(false), 31_000));
        assert!(!monitor.record_session_state(Some(false), 180_999));
        assert!(monitor.record_session_state(Some(false), 181_000));

        let mut observed = ManagedSessionMonitor::new(
            "komla-v1".to_owned(),
            "install-a".to_owned(),
            "http://127.0.0.1:9/api/v1/ssh-workspace-status",
            30,
            180,
            1_000,
        );
        assert!(!observed.record_session_state(Some(true), 10_000));
        assert!(!observed.record_session_state(Some(false), 20_000));
        assert!(observed.record_session_state(Some(false), 50_000));
    }

    #[test]
    fn a_connected_desktop_keeps_the_companion_alive_without_its_own_sessions() {
        let mut monitor = ManagedSessionMonitor::new(
            "komla-v1".to_owned(),
            "install-a".to_owned(),
            "http://127.0.0.1:9/api/v1/ssh-workspace-status",
            30,
            180,
            1_000,
        );
        let connected = SessionCheck {
            owned: Some(false),
            desktop_connected: true,
        };
        let disconnected = SessionCheck {
            owned: Some(false),
            desktop_connected: false,
        };

        assert!(!monitor.record_check(connected, 10_000));
        assert!(!monitor.record_check(connected, 500_000));
        assert!(monitor.desktop_connected(514_999));
        assert!(!monitor.desktop_connected(515_000));
        // The last connection counts for a while, then the usual idle exit applies.
        assert!(!monitor.record_check(disconnected, 510_000));
        assert!(!monitor.record_check(disconnected, 520_000));
        assert!(!monitor.record_check(disconnected, 549_999));
        assert!(monitor.record_check(disconnected, 550_000));
    }

    #[test]
    fn the_desktop_is_connected_only_while_it_answers_through_its_tunnel() {
        let answering = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let answering_url = format!("http://{}/api/v1/health", answering.local_addr().unwrap());
        std::thread::spawn(move || {
            let (mut stream, _) = answering.accept().unwrap();
            let mut request = [0_u8; 1024];
            let _ = std::io::Read::read(&mut stream, &mut request);
            let _ = std::io::Write::write_all(
                &mut stream,
                b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            );
        });
        // A tunnel whose desktop is gone can still accept connections on the host.
        let stale = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let stale_url = format!("http://{}/api/v1/health", stale.local_addr().unwrap());

        assert!(desktop_answers(&answering_url, Duration::from_secs(1)));
        assert!(!desktop_answers(&stale_url, Duration::from_millis(100)));
    }

    #[test]
    fn managed_sessions_are_scoped_to_the_companion_installation() {
        let sessions = "komla-terminal-a\tinstall-a\nkomla-terminal-b\tinstall-b\nkomla-companion-a\tinstall-a\n";

        assert!(has_managed_session(sessions, "install-a"));
        assert!(has_managed_session(sessions, "install-b"));
        assert!(!has_managed_session(sessions, "install-c"));
    }

    #[cfg(unix)]
    #[test]
    fn command_deadline_stops_a_blocked_tmux_probe_portably() {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "sleep 2"]);
        let started = Instant::now();

        assert!(run_command_with_deadline(&mut command, Duration::from_millis(50)).is_none());
        assert!(started.elapsed() < Duration::from_secs(1));
    }
}
