//! `komla __phone-serve <config>`: the localhost WebSocket server a phone reaches through
//! Tailscale Serve on this host, and `__phone-init <state-dir>`, which creates the host identity
//! and prints its fingerprint for the desktop.

use std::collections::HashMap;
use std::fs;
use std::io::{ErrorKind, Write};
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicU8, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use anyhow::{bail, Context};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tungstenite::http::StatusCode;
use tungstenite::protocol::frame::coding::CloseCode;
use tungstenite::protocol::{CloseFrame, WebSocketConfig};
use tungstenite::{Message, WebSocket};

use super::attention::{AttentionBoard, HookInbox};
use super::binary_frames::decode_terminal_input;
use super::ceremony::{Ceremony, CeremonyContext, CeremonyOutcome, AUTH_CEREMONY_TIMEOUT_MS};
use super::crypto::HostIdentity;
use super::outbox::{Outbox, Outcome};
use super::peer::{expect_object, Decoded, HostPeer, PeerClose, PeerEvent, MAX_FRAME_CHARS};
use super::resume::ResumeStore;
use super::session::{AppSession, SessionEnvironment};
use super::terminal::TerminalEvent;
use super::trust::{Trust, TrustFileCache};
use crate::clock::now_ms;

const CONFIG_VERSION: u32 = 1;
const IDENTITY_FILE: &str = "identity.json";
const TRUST_FILE: &str = "trust.json";
const LAUNCH_FILE: &str = "launch.json";
pub(crate) const SOCKET_PATH: &str = "/remote/ws";
const MAX_CONNECTIONS: usize = 8;
const HANDSHAKE_TIMEOUT_MS: u64 = 30_000;
/// Like the desktop: a silent phone is pinged every 15 s and dropped after three unanswered pings.
const HEARTBEAT_PING_MS: u64 = 15_000;
const HEARTBEAT_TIMEOUT_MS: u64 = 45_000;
const POLL_INTERVAL_MS: i32 = 1_000;
const LIST_REFRESH_MS: u64 = 2_000;
const RECEIVING_REFRESH_MS: u64 = 10_000;
/// Past this, the socket refuses frames and the outbox holds them; output is skipped meanwhile.
const MAX_WRITE_BUFFER_BYTES: usize = 1024 * 1024;
/// A phone this far behind is disconnected; it reconnects and starts from a fresh screen.
const MAX_HELD_BYTES: usize = 8 * 1024 * 1024;
const TERMINAL_EVENT_QUEUE: usize = 256;
/// How long a rejected phone gets to read why before the server closes.
const REJECTION_GRACE_MS: u64 = 1_000;
const RELAY_PING: &str = r#"{"type":"relay:ping"}"#;
const RELAY_PONG: &str = r#"{"type":"relay:pong"}"#;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PhoneServerConfig {
    version: u32,
    port: u16,
    base_path: PathBuf,
    tmux_socket: String,
    host_name: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdentityFile {
    version: u32,
    secret_key: String,
}

fn write_private(path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
    let temp = path.with_extension(format!("tmp-{}", std::process::id()));
    let mut file = fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .mode(0o600)
        .open(&temp)
        .with_context(|| format!("could not write {}", temp.display()))?;
    file.write_all(bytes)?;
    file.sync_all()?;
    fs::rename(&temp, path).with_context(|| format!("could not write {}", path.display()))?;
    Ok(())
}

/// Loads this host's identity, creating it the first time.
pub(crate) fn load_or_create_identity(state_dir: &Path) -> anyhow::Result<HostIdentity> {
    fs::create_dir_all(state_dir)
        .with_context(|| format!("could not create {}", state_dir.display()))?;
    fs::set_permissions(state_dir, fs::Permissions::from_mode(0o700))?;
    let path = state_dir.join(IDENTITY_FILE);
    match fs::read(&path) {
        Ok(bytes) => {
            let file: IdentityFile =
                serde_json::from_slice(&bytes).context("the host identity file is malformed")?;
            if file.version != 1 {
                bail!("host identity version {} is not supported", file.version);
            }
            let secret = STANDARD
                .decode(file.secret_key)
                .context("the host identity key is not base64")?;
            HostIdentity::from_secret_bytes(&secret)
        }
        Err(error) if error.kind() == ErrorKind::NotFound => {
            let identity = HostIdentity::generate();
            let file = IdentityFile {
                version: 1,
                secret_key: STANDARD.encode(identity.secret_bytes()),
            };
            write_private(&path, &serde_json::to_vec(&file)?)?;
            Ok(identity)
        }
        Err(error) => Err(error).context("could not read the host identity"),
    }
}

pub(crate) fn init(state_dir: &str) -> anyhow::Result<()> {
    let identity = load_or_create_identity(Path::new(state_dir))?;
    println!(
        "{}",
        serde_json::json!({ "fingerprint": identity.fingerprint(), "socketPath": SOCKET_PATH })
    );
    Ok(())
}

/// Why another thread asked a connection to close: `CLOSE_*`.
type CloseRequest = Arc<AtomicU8>;
const CLOSE_NONE: u8 = 0;
/// The desktop no longer trusts the phone.
const CLOSE_REMOVED: u8 = 1;
/// The same phone signed in again on a newer connection, so this one must not reconnect.
const CLOSE_REPLACED: u8 = 2;

struct SessionHandle {
    device_id: String,
    close: CloseRequest,
    wake: Arc<dyn Fn() + Send + Sync>,
}

struct Shared {
    identity: HostIdentity,
    config: PhoneServerConfig,
    trust_path: PathBuf,
    launch_path: PathBuf,
    trust: Mutex<TrustFileCache>,
    resume: Mutex<ResumeStore>,
    counters: Mutex<HashMap<String, u32>>,
    attention: Arc<Mutex<AttentionBoard>>,
    attention_version: AtomicU64,
    sessions: Mutex<HashMap<u64, SessionHandle>>,
    next_connection: AtomicU64,
    connections: AtomicUsize,
}

impl Shared {
    fn trust(&self) -> Trust {
        self.trust
            .lock()
            .expect("trust lock poisoned")
            .current(&self.trust_path)
    }

    /// Ends sessions, and drops resume grants, of phones the desktop no longer trusts.
    fn enforce_trust(&self) {
        let trust = self.trust();
        let now = now_ms();
        self.resume
            .lock()
            .expect("resume lock poisoned")
            .revoke_others(|device| trust.device(device, now).is_some());
        for handle in self
            .sessions
            .lock()
            .expect("sessions lock poisoned")
            .values()
        {
            if trust.device(&handle.device_id, now).is_none() {
                handle.close.store(CLOSE_REMOVED, Ordering::SeqCst);
                (handle.wake)();
            }
        }
    }

    fn wake_all(&self) {
        for handle in self
            .sessions
            .lock()
            .expect("sessions lock poisoned")
            .values()
        {
            (handle.wake)();
        }
    }
}

pub(crate) fn serve(config_path: &str) -> anyhow::Result<()> {
    let config_path = Path::new(config_path);
    let config: PhoneServerConfig = serde_json::from_slice(
        &fs::read(config_path).context("could not read the phone server configuration")?,
    )
    .context("the phone server configuration is malformed")?;
    if config.version != CONFIG_VERSION {
        bail!(
            "phone server configuration version {} is not supported",
            config.version
        );
    }
    let state_dir = config_path
        .parent()
        .context("the configuration must live in the server's folder")?
        .to_path_buf();
    let identity = load_or_create_identity(&state_dir)?;
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, config.port))
        .with_context(|| format!("could not listen on 127.0.0.1:{}", config.port))?;
    let shared = Arc::new(Shared {
        identity,
        trust_path: state_dir.join(TRUST_FILE),
        launch_path: state_dir.join(LAUNCH_FILE),
        trust: Mutex::new(TrustFileCache::default()),
        resume: Mutex::new(ResumeStore::default()),
        counters: Mutex::new(HashMap::new()),
        attention: Arc::new(Mutex::new(AttentionBoard::default())),
        attention_version: AtomicU64::new(0),
        sessions: Mutex::new(HashMap::new()),
        next_connection: AtomicU64::new(1),
        connections: AtomicUsize::new(0),
        config,
    });
    shared.trust();
    eprintln!(
        "phone server listening on 127.0.0.1:{} ({})",
        shared.config.port,
        shared.identity.fingerprint()
    );

    let inbox = HookInbox::new(&state_dir);
    let watcher = Arc::clone(&shared);
    thread::Builder::new()
        .name("phone-hooks".to_owned())
        .spawn(move || watch_hooks_and_trust(&watcher, &inbox))
        .context("could not start the hook watcher")?;

    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        if shared.connections.load(Ordering::SeqCst) >= MAX_CONNECTIONS {
            drop(stream);
            continue;
        }
        shared.connections.fetch_add(1, Ordering::SeqCst);
        let connection = Arc::clone(&shared);
        let spawned = thread::Builder::new()
            .name("phone-connection".to_owned())
            .spawn(move || {
                if let Err(error) = serve_connection(stream, &connection) {
                    eprintln!("phone connection ended: {error:#}");
                }
                connection.connections.fetch_sub(1, Ordering::SeqCst);
            });
        if spawned.is_err() {
            shared.connections.fetch_sub(1, Ordering::SeqCst);
        }
    }
    Ok(())
}

fn watch_hooks_and_trust(shared: &Shared, inbox: &HookInbox) {
    let mut last_receiving = 0;
    loop {
        let now = now_ms();
        if now.saturating_sub(last_receiving) >= RECEIVING_REFRESH_MS {
            inbox.mark_receiving();
            last_receiving = now;
        }
        let hooks = inbox.drain();
        if !hooks.is_empty() {
            let mut board = shared.attention.lock().expect("attention lock poisoned");
            let changed = hooks
                .iter()
                .fold(false, |changed, hook| board.apply(hook, now) || changed);
            drop(board);
            if changed {
                shared.attention_version.fetch_add(1, Ordering::SeqCst);
                shared.wake_all();
            }
        }
        shared.enforce_trust();
        thread::sleep(Duration::from_secs(1));
    }
}

/// A self-pipe: terminal readers write a byte so the connection's `poll` wakes.
fn wake_pipe() -> anyhow::Result<(OwnedFd, Arc<OwnedFd>)> {
    let mut fds = [0; 2];
    // SAFETY: pipe writes two new descriptors into the array.
    if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
        bail!(
            "could not create a pipe: {}",
            std::io::Error::last_os_error()
        );
    }
    for fd in fds {
        // SAFETY: flags on descriptors we just created.
        unsafe {
            libc::fcntl(
                fd,
                libc::F_SETFL,
                libc::fcntl(fd, libc::F_GETFL) | libc::O_NONBLOCK,
            );
            libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC);
        }
    }
    // SAFETY: both descriptors are open and owned only here.
    let (read, write) = unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) };
    Ok((read, Arc::new(write)))
}

fn drain_pipe(fd: &OwnedFd) {
    let mut buffer = [0u8; 64];
    // SAFETY: reading into a local buffer from a non-blocking descriptor we own.
    while unsafe { libc::read(fd.as_raw_fd(), buffer.as_mut_ptr().cast(), buffer.len()) } > 0 {}
}

fn check_upgrade(shared: &Shared, request: &Request) -> Result<(), &'static str> {
    if request.uri().path() != SOCKET_PATH {
        return Err("not found");
    }
    let origin = request
        .headers()
        .get("origin")
        .and_then(|value| value.to_str().ok())
        .ok_or("missing origin")?;
    if !shared.trust().allows_origin(origin, now_ms()) {
        return Err("origin not allowed");
    }
    Ok(())
}

struct Connection<'a> {
    shared: &'a Shared,
    id: u64,
    socket: WebSocket<TcpStream>,
    outbox: Outbox,
    peer: HostPeer,
    ceremony: Ceremony,
    session: Option<AppSession>,
    device_id: Option<String>,
    resume_token: Option<String>,
    events: Receiver<TerminalEvent>,
    events_tx: mpsc::SyncSender<TerminalEvent>,
    wake: Arc<dyn Fn() + Send + Sync>,
    close_requested: CloseRequest,
    opened_at: u64,
    last_inbound: u64,
    last_ping: u64,
    last_list_check: u64,
    attention_seen: u64,
    write_pending: bool,
    closing_at: Option<u64>,
}

enum Flow {
    Continue,
    Close(u16, String),
}

fn serve_connection(stream: TcpStream, shared: &Shared) -> anyhow::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    let config = WebSocketConfig {
        max_message_size: Some(MAX_FRAME_CHARS),
        max_frame_size: Some(MAX_FRAME_CHARS),
        max_write_buffer_size: MAX_WRITE_BUFFER_BYTES,
        ..WebSocketConfig::default()
    };
    let socket = tungstenite::accept_hdr_with_config(
        stream,
        |request: &Request, response: Response| match check_upgrade(shared, request) {
            Ok(()) => Ok(response),
            Err(reason) => {
                let mut rejection = ErrorResponse::new(Some(reason.to_owned()));
                *rejection.status_mut() = if reason == "not found" {
                    StatusCode::NOT_FOUND
                } else {
                    StatusCode::FORBIDDEN
                };
                Err(rejection)
            }
        },
        Some(config),
    )
    .map_err(|error| anyhow::anyhow!("WebSocket upgrade refused: {error}"))?;
    socket.get_ref().set_nonblocking(true)?;
    socket.get_ref().set_nodelay(true)?;

    let (wake_read, wake_write) = wake_pipe()?;
    let wake: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
        // SAFETY: writing one byte to a non-blocking pipe we own; a full pipe already wakes.
        unsafe {
            libc::write(wake_write.as_raw_fd(), [1u8].as_ptr().cast(), 1);
        }
    });
    let (events_tx, events) = mpsc::sync_channel(TERMINAL_EVENT_QUEUE);
    let now = now_ms();
    let mut connection = Connection {
        shared,
        id: shared.next_connection.fetch_add(1, Ordering::SeqCst),
        socket,
        outbox: Outbox::default(),
        peer: HostPeer::new(),
        ceremony: Ceremony::awaiting_hello_until(
            now + HANDSHAKE_TIMEOUT_MS + AUTH_CEREMONY_TIMEOUT_MS,
        ),
        session: None,
        device_id: None,
        resume_token: None,
        events,
        events_tx,
        wake,
        close_requested: Arc::new(AtomicU8::new(CLOSE_NONE)),
        opened_at: now,
        last_inbound: now,
        last_ping: 0,
        last_list_check: now,
        attention_seen: shared.attention_version.load(Ordering::SeqCst),
        write_pending: false,
        closing_at: None,
    };
    let result = connection.run(&wake_read);
    connection.finish();
    result
}

impl Connection<'_> {
    fn run(&mut self, wake_read: &OwnedFd) -> anyhow::Result<()> {
        loop {
            let mut fds = [
                libc::pollfd {
                    fd: self.socket.get_ref().as_raw_fd(),
                    events: libc::POLLIN | if self.write_pending { libc::POLLOUT } else { 0 },
                    revents: 0,
                },
                libc::pollfd {
                    fd: wake_read.as_raw_fd(),
                    events: libc::POLLIN,
                    revents: 0,
                },
            ];
            // SAFETY: polling two descriptors we own for the duration of the call.
            let ready = unsafe {
                libc::poll(
                    fds.as_mut_ptr(),
                    fds.len() as libc::nfds_t,
                    POLL_INTERVAL_MS,
                )
            };
            if ready < 0 && std::io::Error::last_os_error().kind() != ErrorKind::Interrupted {
                bail!("poll failed: {}", std::io::Error::last_os_error());
            }
            if fds[1].revents != 0 {
                drain_pipe(wake_read);
            }
            let flow = self.step()?;
            if let Flow::Close(code, reason) = flow {
                self.close(code, &reason);
                return Ok(());
            }
        }
    }

    fn step(&mut self) -> anyhow::Result<Flow> {
        loop {
            match self.socket.read() {
                Ok(Message::Text(text)) => {
                    self.last_inbound = now_ms();
                    if let Flow::Close(code, reason) = self.handle_text(&text)? {
                        return Ok(Flow::Close(code, reason));
                    }
                }
                Ok(Message::Close(_)) => return Ok(Flow::Close(1000, "closed".to_owned())),
                Ok(Message::Binary(bytes)) => {
                    self.last_inbound = now_ms();
                    if let Flow::Close(code, reason) = self.handle_binary(&bytes)? {
                        return Ok(Flow::Close(code, reason));
                    }
                }
                Ok(_) => self.last_inbound = now_ms(),
                Err(tungstenite::Error::Io(error)) if error.kind() == ErrorKind::WouldBlock => {
                    break
                }
                Err(tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed) => {
                    return Ok(Flow::Close(1000, "closed".to_owned()))
                }
                Err(error) => return Err(error.into()),
            }
        }

        let now = now_ms();
        if self.closing_at.is_some_and(|at| now >= at) {
            return Ok(Flow::Close(1000, "ceremony-complete".to_owned()));
        }
        match self.close_requested.load(Ordering::SeqCst) {
            CLOSE_REMOVED => return Ok(Flow::Close(4401, "device-removed".to_owned())),
            CLOSE_REPLACED => return Ok(Flow::Close(4409, "replaced".to_owned())),
            _ => {}
        }
        if !self.peer.is_established() && now.saturating_sub(self.opened_at) >= HANDSHAKE_TIMEOUT_MS
        {
            return Ok(Flow::Close(
                PeerClose::Timeout.code(),
                PeerClose::Timeout.reason().to_owned(),
            ));
        }
        if self.session.is_none() && self.ceremony.timed_out(now) {
            return Ok(Flow::Close(
                PeerClose::Timeout.code(),
                "ceremony-timeout".to_owned(),
            ));
        }
        if self.outbox.held_bytes() > MAX_HELD_BYTES {
            return Ok(Flow::Close(1013, "phone-too-far-behind".to_owned()));
        }
        if now.saturating_sub(self.last_inbound) >= HEARTBEAT_TIMEOUT_MS {
            return Ok(Flow::Close(4408, "heartbeat-timeout".to_owned()));
        }
        if now.saturating_sub(self.last_inbound) >= HEARTBEAT_PING_MS
            && now.saturating_sub(self.last_ping) >= HEARTBEAT_PING_MS
        {
            self.last_ping = now;
            self.queue_raw(RELAY_PING.to_owned());
        }

        self.drain_outbox();
        if let Some(mut session) = self.session.take() {
            let mut outbound = Vec::new();
            while let Ok(event) = self.events.try_recv() {
                outbound.extend(session.on_event(event, now));
            }
            let attention_version = self.shared.attention_version.load(Ordering::SeqCst);
            if attention_version != self.attention_seen
                || now.saturating_sub(self.last_list_check) >= LIST_REFRESH_MS
            {
                self.attention_seen = attention_version;
                self.last_list_check = now;
                outbound.extend(session.list_if_changed());
            }
            if !self.write_pending && self.outbox.held_bytes() == 0 {
                outbound.extend(session.recover_overflow());
            }
            let overflowed = outbound.into_iter().fold(false, |overflowed, frame| {
                !self.queue_encrypted(&frame) || overflowed
            });
            if overflowed {
                session.mark_overflowed();
            }
            self.session = Some(session);
        }
        self.flush()?;
        self.drain_outbox();
        Ok(Flow::Continue)
    }

    fn handle_text(&mut self, text: &str) -> anyhow::Result<Flow> {
        if self.closing_at.is_some() {
            return Ok(Flow::Continue);
        }
        if text == RELAY_PING {
            self.queue_raw(RELAY_PONG.to_owned());
            return Ok(Flow::Continue);
        }
        if text == RELAY_PONG {
            return Ok(Flow::Continue);
        }
        let event = match self.peer.handle_frame(text, &self.shared.identity) {
            Ok(event) => event,
            Err(error) => {
                eprintln!("phone session ended: {error}");
                return Ok(Flow::Close(error.close.code(), error.reason.to_owned()));
            }
        };
        match event {
            PeerEvent::Send(answer) => {
                self.queue_raw(answer);
                Ok(Flow::Continue)
            }
            PeerEvent::Message(decoded) => self.handle_decoded(decoded),
        }
    }

    /// A binary envelope, once binary frames are agreed; the phone may send either kind.
    fn handle_binary(&mut self, bytes: &[u8]) -> anyhow::Result<Flow> {
        if self.closing_at.is_some() {
            return Ok(Flow::Continue);
        }
        match self.peer.handle_binary(bytes) {
            Ok(decoded) => self.handle_decoded(decoded),
            Err(error) => {
                eprintln!("phone session ended: {error}");
                Ok(Flow::Close(error.close.code(), error.reason.to_owned()))
            }
        }
    }

    fn handle_decoded(&mut self, decoded: Decoded) -> anyhow::Result<Flow> {
        // The only binary payload a phone sends is terminal input, and only once signed in.
        let frame = match decoded {
            Decoded::Binary(payload) if self.session.is_some() => decode_terminal_input(&payload),
            decoded => expect_object(decoded).ok(),
        };
        let Some(frame) = frame else {
            return Ok(Flow::Close(
                PeerClose::BadRequest.code(),
                "bad-request".to_owned(),
            ));
        };
        if let Some(mut session) = self.session.take() {
            for reply in session.handle(&frame) {
                if !self.queue_encrypted(&reply) {
                    session.mark_overflowed();
                }
            }
            self.session = Some(session);
            return Ok(Flow::Continue);
        }
        self.handle_ceremony(&frame)
    }

    fn handle_ceremony(&mut self, frame: &Value) -> anyhow::Result<Flow> {
        let trust = self.shared.trust();
        let channel_binding = self
            .peer
            .channel_binding()
            .context("ceremony before the handshake")?;
        let outcome = {
            let mut resume = self.shared.resume.lock().expect("resume lock poisoned");
            let mut counters = self.shared.counters.lock().expect("counters lock poisoned");
            self.ceremony.handle(
                frame,
                CeremonyContext {
                    trust: &trust,
                    resume: &mut resume,
                    counters: &mut counters,
                    channel_binding,
                    now: now_ms(),
                },
            )
        };
        match outcome {
            CeremonyOutcome::Reply(reply) => {
                self.queue_encrypted(&reply);
                Ok(Flow::Continue)
            }
            // The phone closes once it has read the reason; the server closes soon after if not.
            CeremonyOutcome::Rejected(reply) => {
                self.queue_encrypted(&reply);
                self.closing_at = Some(now_ms() + REJECTION_GRACE_MS);
                Ok(Flow::Continue)
            }
            CeremonyOutcome::Authenticated {
                device,
                reply,
                resume_token,
                binary_frames,
                project_icons,
                workspace_tags,
            } => {
                self.register_device(&device.device_id);
                self.device_id = Some(device.device_id);
                self.resume_token = Some(resume_token);
                self.queue_encrypted(&reply);
                // The phone switches when it reads the reply, which went as text.
                if binary_frames {
                    self.peer.enable_binary_frames();
                }
                self.session = Some(AppSession::new(
                    SessionEnvironment {
                        base: self.shared.config.base_path.clone(),
                        tmux_socket: self.shared.config.tmux_socket.clone(),
                        host_name: self.shared.config.host_name.clone(),
                        attention: Arc::clone(&self.shared.attention),
                        launch_path: self.shared.launch_path.clone(),
                        project_icons,
                        workspace_tags,
                    },
                    self.events_tx.clone(),
                    Arc::clone(&self.wake),
                ));
                Ok(Flow::Continue)
            }
        }
    }

    /// One session per phone: a newer sign-in of the same phone replaces the older one.
    fn register_device(&self, device_id: &str) {
        let mut sessions = self.shared.sessions.lock().expect("sessions lock poisoned");
        for handle in sessions.values() {
            if handle.device_id == device_id {
                handle.close.store(CLOSE_REPLACED, Ordering::SeqCst);
                (handle.wake)();
            }
        }
        sessions.insert(
            self.id,
            SessionHandle {
                device_id: device_id.to_owned(),
                close: Arc::clone(&self.close_requested),
                wake: Arc::clone(&self.wake),
            },
        );
    }

    fn queue_raw(&mut self, text: String) {
        match self.socket.write(Message::Text(text)) {
            Ok(()) => {}
            Err(tungstenite::Error::Io(error)) if error.kind() == ErrorKind::WouldBlock => {
                self.write_pending = true;
            }
            Err(error) => eprintln!("phone frame not sent: {error}"),
        }
    }

    /// Returns false when the frame was not sent: output the phone is too far behind to take.
    fn queue_encrypted(&mut self, frame: &Value) -> bool {
        match self.outbox.send(&mut self.peer, &mut self.socket, frame) {
            Outcome::Sent => true,
            Outcome::Blocked | Outcome::Held => {
                self.write_pending = true;
                true
            }
            Outcome::Skipped => false,
        }
    }

    /// Hands frames held for a full socket to it as it drains.
    fn drain_outbox(&mut self) {
        if self.outbox.drain(&mut self.socket) {
            self.write_pending = true;
        }
    }

    fn flush(&mut self) -> anyhow::Result<()> {
        match self.socket.flush() {
            Ok(()) => {
                self.write_pending = false;
                Ok(())
            }
            Err(tungstenite::Error::Io(error)) if error.kind() == ErrorKind::WouldBlock => {
                self.write_pending = true;
                Ok(())
            }
            Err(tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed) => Ok(()),
            Err(error) => Err(error.into()),
        }
    }

    fn close(&mut self, code: u16, reason: &str) {
        let _ = self.socket.close(Some(CloseFrame {
            code: CloseCode::from(code),
            reason: reason.to_owned().into(),
        }));
        let _ = self.socket.get_ref().set_nonblocking(false);
        let _ = self
            .socket
            .get_ref()
            .set_write_timeout(Some(Duration::from_secs(2)));
        let _ = self.socket.flush();
    }

    fn finish(&mut self) {
        self.session = None;
        self.shared
            .sessions
            .lock()
            .expect("sessions lock poisoned")
            .remove(&self.id);
        if let Some(token) = &self.resume_token {
            self.shared
                .resume
                .lock()
                .expect("resume lock poisoned")
                .release(token, now_ms());
        }
    }
}
