use std::io::{self, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use komla::CompanionSnapshotPayload;

use crate::outbox::QueuedCommand;

const MAX_HTTP_RESPONSE_BYTES: usize = 64 * 1024;

pub(crate) struct HttpResponse {
    pub(crate) status: u16,
    pub(crate) body: String,
}

#[derive(Debug)]
pub(crate) struct HttpError {
    message: String,
    unreachable: bool,
}

impl HttpError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            unreachable: false,
        }
    }

    fn unreachable(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            unreachable: true,
        }
    }

    /// True when the request cannot have reached Komla, so retrying it elsewhere is safe.
    pub(crate) fn is_unreachable(&self) -> bool {
        self.unreachable
    }
}

impl std::fmt::Display for HttpError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

#[derive(Clone)]
pub(crate) struct KomlaClient {
    snapshot_endpoint: String,
    notify_endpoint: Option<String>,
    api_base: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HookDelivery {
    Accepted,
    Pending,
    PermanentlyRejected(u16),
    Retry,
}

/// How the desktop answered a queued command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum CommandDelivery {
    Accepted,
    /// Komla refused it, e.g. the snooze ran out meanwhile; trying again would not change that.
    Rejected(String),
    /// Komla failed on it, or timed out; it may succeed later.
    Failed(String),
    /// Komla doesn't have its workspace, which it may add soon if the host created it.
    Missing(String),
    /// Komla couldn't be reached.
    Retry,
}

pub(crate) enum OutboundRequest {
    Snapshot {
        workspace_key: usize,
        payload: Box<CompanionSnapshotPayload>,
    },
    Hook {
        request_id: u64,
        body: Vec<u8>,
    },
    Command {
        request_id: u64,
        command: Box<QueuedCommand>,
    },
}

pub(crate) enum OutboundResult {
    Snapshot {
        workspace_key: usize,
        payload: Box<CompanionSnapshotPayload>,
        delivered: bool,
    },
    Hook {
        request_id: u64,
        delivery: HookDelivery,
    },
    Command {
        request_id: u64,
        delivery: CommandDelivery,
    },
}

pub(crate) struct OutboundTransport {
    sender: SyncSender<OutboundRequest>,
    receiver: Receiver<OutboundResult>,
}

impl OutboundTransport {
    pub(crate) fn new(client: KomlaClient, queue_capacity: usize) -> Self {
        Self::with_limits(client, 2, queue_capacity)
    }

    fn with_limits(client: KomlaClient, workers: usize, queue_capacity: usize) -> Self {
        let (request_sender, request_receiver) = mpsc::sync_channel(queue_capacity.max(1));
        let (result_sender, result_receiver) = mpsc::channel();
        let request_receiver = Arc::new(Mutex::new(request_receiver));
        let client = Arc::new(client);
        for _ in 0..workers.max(1) {
            let requests = Arc::clone(&request_receiver);
            let results = result_sender.clone();
            let client = Arc::clone(&client);
            std::thread::spawn(move || loop {
                let request = {
                    let Ok(receiver) = requests.lock() else {
                        return;
                    };
                    receiver.recv()
                };
                let Ok(request) = request else {
                    return;
                };
                let result = match request {
                    OutboundRequest::Snapshot {
                        workspace_key,
                        payload,
                    } => {
                        let delivered = client.deliver_snapshot(&payload);
                        OutboundResult::Snapshot {
                            workspace_key,
                            payload,
                            delivered,
                        }
                    }
                    OutboundRequest::Hook { request_id, body } => {
                        let delivery = client.deliver_hook(&body);
                        OutboundResult::Hook {
                            request_id,
                            delivery,
                        }
                    }
                    OutboundRequest::Command {
                        request_id,
                        command,
                    } => {
                        let delivery = client.deliver_command(&command);
                        OutboundResult::Command {
                            request_id,
                            delivery,
                        }
                    }
                };
                if results.send(result).is_err() {
                    return;
                }
            });
        }
        Self {
            sender: request_sender,
            receiver: result_receiver,
        }
    }

    pub(crate) fn submit(&self, request: OutboundRequest) -> bool {
        match self.sender.try_send(request) {
            Ok(()) => true,
            Err(TrySendError::Full(_) | TrySendError::Disconnected(_)) => false,
        }
    }

    pub(crate) fn try_recv(&self) -> Option<OutboundResult> {
        self.receiver.try_recv().ok()
    }
}

impl KomlaClient {
    pub(crate) fn new(snapshot_endpoint: String) -> Self {
        let base = snapshot_endpoint.strip_suffix("/api/v1/ssh-workspace-status");
        Self {
            notify_endpoint: base.map(|base| format!("{base}/api/v1/notify")),
            api_base: base.map(str::to_owned),
            snapshot_endpoint,
        }
    }

    pub(crate) fn deliver_snapshot(&self, payload: &CompanionSnapshotPayload) -> bool {
        let body = match serde_json::to_string(payload) {
            Ok(body) => body,
            Err(error) => {
                eprintln!("could not serialize repository snapshot: {error}");
                return false;
            }
        };
        match post_json(&self.snapshot_endpoint, body.as_bytes(), Vec::new()) {
            Ok(_) => true,
            Err(error) => {
                eprintln!("repository snapshot delivery failed: {error}");
                false
            }
        }
    }

    pub(crate) fn deliver_hook(&self, body: &[u8]) -> HookDelivery {
        let Some(endpoint) = &self.notify_endpoint else {
            return HookDelivery::Retry;
        };
        match post_json(
            endpoint,
            body,
            vec![("X-Komla-Hook-Pending", "retry".to_owned())],
        ) {
            Ok(response) if response.status == 202 => HookDelivery::Pending,
            Ok(_) => HookDelivery::Accepted,
            Err(PostError::Status(status))
                if (400..500).contains(&status) && status != 408 && status != 429 =>
            {
                HookDelivery::PermanentlyRejected(status)
            }
            Err(error) => {
                eprintln!("terminal hook delivery failed: {error}");
                HookDelivery::Retry
            }
        }
    }

    pub(crate) fn deliver_command(&self, command: &QueuedCommand) -> CommandDelivery {
        let Some(base) = &self.api_base else {
            return CommandDelivery::Retry;
        };
        let body = match serde_json::to_vec(&command.operation) {
            Ok(body) => body,
            Err(error) => return CommandDelivery::Rejected(error.to_string()),
        };
        let headers = command.headers(crate::clock::now_ms());
        match post_json(&format!("{base}{}", command.path), &body, headers) {
            Ok(_) => CommandDelivery::Accepted,
            // A workspace created on the host while Komla was away is missing until Komla adds it.
            Err(PostError::Status(404)) => CommandDelivery::Missing("HTTP 404".to_owned()),
            Err(PostError::Status(status)) if status >= 500 => {
                CommandDelivery::Failed(format!("HTTP {status}"))
            }
            Err(PostError::Status(status))
                if (400..500).contains(&status) && status != 408 && status != 429 =>
            {
                CommandDelivery::Rejected(format!("HTTP {status}"))
            }
            Err(PostError::Unreachable(_)) => CommandDelivery::Retry,
            // Komla answered too slowly, which may happen every time.
            Err(error) => CommandDelivery::Failed(error.to_string()),
        }
    }
}

enum PostError {
    Status(u16),
    /// Komla couldn't be reached at all, so it can't have received the request.
    Unreachable(String),
    Transport(String),
}

impl std::fmt::Display for PostError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Status(status) => write!(formatter, "HTTP {status}"),
            Self::Unreachable(message) | Self::Transport(message) => write!(formatter, "{message}"),
        }
    }
}

fn post_json(
    url: &str,
    body: &[u8],
    headers: Vec<(&'static str, String)>,
) -> Result<HttpResponse, PostError> {
    let url = url.to_owned();
    let body = body.to_vec();
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = sender.send(post_json_inner(&url, &body, &headers));
    });
    receiver
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| PostError::Transport("timed out posting to Komla".to_owned()))?
}

fn post_json_inner(
    url: &str,
    body: &[u8],
    extra_headers: &[(&'static str, String)],
) -> Result<HttpResponse, PostError> {
    let mut headers = vec![("Content-Type", "application/json")];
    headers.extend(
        extra_headers
            .iter()
            .map(|(name, value)| (*name, value.as_str())),
    );
    let response = request_http_inner(
        "POST",
        url,
        &headers,
        body,
        MAX_HTTP_RESPONSE_BYTES,
        Some(Duration::from_secs(5)),
    )
    .map_err(|error| {
        if error.is_unreachable() {
            PostError::Unreachable(error.to_string())
        } else {
            PostError::Transport(error.to_string())
        }
    })?;
    if !(200..300).contains(&response.status) {
        return Err(PostError::Status(response.status));
    }
    Ok(response)
}

pub(crate) fn request_http(
    method: &str,
    url: &str,
    headers: &[(&str, &str)],
    body: &[u8],
    max_response_bytes: usize,
    read_timeout: Option<Duration>,
) -> Result<HttpResponse, HttpError> {
    request_http_inner(method, url, headers, body, max_response_bytes, read_timeout)
}

fn request_http_inner(
    method: &str,
    url: &str,
    headers: &[(&str, &str)],
    body: &[u8],
    max_response_bytes: usize,
    read_timeout: Option<Duration>,
) -> Result<HttpResponse, HttpError> {
    let (host, port, path) = parse_http_url(url)?;
    let address = format!("{host}:{port}")
        .to_socket_addrs()
        .map_err(|error| HttpError::new(error.to_string()))?
        .next()
        .ok_or_else(|| HttpError::new(format!("could not resolve {host}:{port}")))?;
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(2))
        .map_err(|error| HttpError::unreachable(error.to_string()))?;
    stream
        .set_read_timeout(read_timeout)
        .map_err(|error| HttpError::new(error.to_string()))?;
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .map_err(|error| HttpError::new(error.to_string()))?;
    let mut request = format!("{method} {path} HTTP/1.1\r\nHost: {host}:{port}\r\n");
    for (name, value) in headers {
        request.push_str(name);
        request.push_str(": ");
        request.push_str(value);
        request.push_str("\r\n");
    }
    request.push_str(&format!(
        "Content-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    ));
    stream
        .write_all(request.as_bytes())
        .and_then(|_| stream.write_all(body))
        .and_then(|_| stream.flush())
        // Komla only acts on a complete request, so a failed send never reached it.
        .map_err(|error| HttpError::unreachable(error.to_string()))?;
    let (status, body) = read_http_response(&mut stream, max_response_bytes, read_timeout)?;
    Ok(HttpResponse { status, body })
}

fn read_http_response(
    stream: &mut TcpStream,
    max_response_bytes: usize,
    read_timeout: Option<Duration>,
) -> Result<(u16, String), HttpError> {
    let deadline = read_timeout.map(|timeout| std::time::Instant::now() + timeout);
    let mut response = Vec::new();
    let mut buffer = [0_u8; 4096];
    loop {
        if deadline.is_some_and(|deadline| std::time::Instant::now() >= deadline) {
            return Err(HttpError::new("timed out reading HTTP response".to_owned()));
        }
        match stream.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => {
                if response.len().saturating_add(read) > max_response_bytes {
                    return Err(HttpError::new(format!(
                        "HTTP response exceeded {max_response_bytes} bytes"
                    )));
                }
                response.extend_from_slice(&buffer[..read]);
                if let Some((status, payload)) = parse_complete_http_response(&response, false) {
                    return Ok((status, payload));
                }
            }
            Err(error)
                if error.kind() == io::ErrorKind::WouldBlock
                    || error.kind() == io::ErrorKind::TimedOut =>
            {
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(error) => return Err(HttpError::new(error.to_string())),
        }
    }
    let (status, payload) = parse_complete_http_response(&response, true)
        .ok_or_else(|| HttpError::new("HTTP response was incomplete".to_owned()))?;
    Ok((status, payload))
}

fn parse_complete_http_response(bytes: &[u8], eof: bool) -> Option<(u16, String)> {
    let header_end = bytes.windows(4).position(|window| window == b"\r\n\r\n")?;
    let headers = std::str::from_utf8(&bytes[..header_end]).ok()?;
    let status = headers
        .lines()
        .next()?
        .split_whitespace()
        .nth(1)?
        .parse()
        .ok()?;
    let body = &bytes[header_end + 4..];
    let is_chunked = headers.lines().any(|line| {
        line.split_once(':').is_some_and(|(name, value)| {
            name.eq_ignore_ascii_case("transfer-encoding")
                && value
                    .split(',')
                    .any(|encoding| encoding.trim().eq_ignore_ascii_case("chunked"))
        })
    });
    if is_chunked {
        return decode_chunked_body(body).map(|payload| (status, payload));
    }
    if let Some(length) = headers.lines().find_map(|line| {
        line.split_once(':').and_then(|(name, value)| {
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().ok())
                .flatten()
        })
    }) {
        if body.len() < length {
            return None;
        }
        return Some((
            status,
            String::from_utf8_lossy(&body[..length]).into_owned(),
        ));
    }
    eof.then(|| (status, String::from_utf8_lossy(body).into_owned()))
}

fn decode_chunked_body(bytes: &[u8]) -> Option<String> {
    let mut cursor = 0;
    let mut decoded = Vec::new();
    loop {
        let line_end = bytes[cursor..]
            .windows(2)
            .position(|window| window == b"\r\n")?
            + cursor;
        let size_text = std::str::from_utf8(&bytes[cursor..line_end]).ok()?;
        let size = usize::from_str_radix(size_text.split(';').next()?.trim(), 16).ok()?;
        cursor = line_end.checked_add(2)?;
        if size == 0 {
            if bytes.get(cursor..cursor.checked_add(2)?)? == b"\r\n" {
                return String::from_utf8(decoded).ok();
            }
            bytes[cursor..]
                .windows(4)
                .position(|window| window == b"\r\n\r\n")?;
            return String::from_utf8(decoded).ok();
        }
        let data_end = cursor.checked_add(size)?;
        let terminator_end = data_end.checked_add(2)?;
        if bytes.get(data_end..terminator_end)? != b"\r\n" {
            return None;
        }
        decoded.extend_from_slice(bytes.get(cursor..data_end)?);
        cursor = terminator_end;
    }
}

fn parse_http_url(url: &str) -> Result<(String, u16, String), HttpError> {
    let rest = url
        .strip_prefix("http://")
        .ok_or_else(|| HttpError::new(format!("unsupported Komla endpoint {url}")))?;
    let (authority, path) = rest
        .split_once('/')
        .map(|(authority, path)| (authority, format!("/{path}")))
        .unwrap_or((rest, "/".to_owned()));
    let (host, port) = match authority.rsplit_once(':') {
        Some((host, port)) => (
            host.to_owned(),
            port.parse::<u16>()
                .map_err(|error| HttpError::new(error.to_string()))?,
        ),
        None => (authority.to_owned(), 80),
    };
    Ok((host, port, path))
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;

    use komla::{BranchObservation, CompanionSnapshotPayload, RepositorySnapshot};

    use super::{request_http, KomlaClient, OutboundRequest, OutboundTransport};

    fn unreachable_after(accept: impl FnOnce(TcpStream) + Send + 'static) -> bool {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/api", listener.local_addr().unwrap());
        thread::spawn(move || accept(listener.accept().unwrap().0));
        request_http("POST", &url, &[], b"{}", 1024, Some(Duration::from_secs(2)))
            .err()
            .is_some_and(|error| error.is_unreachable())
    }

    #[test]
    fn reports_komla_unreachable_only_when_the_request_cannot_have_arrived() {
        // A port only ever connected from: on macOS, a listener that just closed
        // can still accept a connection before resetting it.
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let refused = format!(
            "http://127.0.0.1:{}/api",
            client.local_addr().unwrap().port()
        );
        assert!(request_http("POST", &refused, &[], b"{}", 1024, None)
            .err()
            .is_some_and(|error| error.is_unreachable()));

        // Once the request is sent, Komla may have acted on it even without replying.
        assert!(!unreachable_after(|mut stream| {
            let mut buffer = [0_u8; 1024];
            let _ = stream.read(&mut buffer);
        }));
        assert!(!unreachable_after(|mut stream| {
            let mut buffer = [0_u8; 1024];
            let _ = stream.read(&mut buffer);
            let _ = stream.write_all(b"HTTP/1.1 500 Internal");
        }));
    }

    fn read_framed_request(stream: &mut TcpStream) -> Vec<u8> {
        stream
            .set_read_timeout(Some(Duration::from_secs(1)))
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

    fn serve_once_rejecting_half_closed_request(status: u16, body: &str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let response_body = body.to_owned();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let _request = read_framed_request(&mut stream);

            stream
                .set_read_timeout(Some(Duration::from_millis(50)))
                .unwrap();
            match stream.read(&mut [0_u8; 1]) {
                Err(error)
                    if error.kind() == std::io::ErrorKind::WouldBlock
                        || error.kind() == std::io::ErrorKind::TimedOut => {}
                _ => return,
            }
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

    fn serve_once_capturing_request(status: u16, body: &str) -> (String, mpsc::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let response_body = body.to_owned();
        let (sender, receiver) = mpsc::channel();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let request = read_framed_request(&mut stream);
            let _ = sender.send(String::from_utf8_lossy(&request).into_owned());
            write!(
                stream,
                "HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                response_body.len(),
                response_body
            )
            .unwrap();
        });
        (format!("http://{address}"), receiver)
    }

    fn serve_slow_responses(body: String, requests: usize) -> (String, mpsc::Receiver<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (accepted_sender, accepted_receiver) = mpsc::channel();
        thread::spawn(move || {
            for _ in 0..requests {
                let Ok((mut stream, _)) = listener.accept() else {
                    return;
                };
                let _request = read_framed_request(&mut stream);
                let _ = accepted_sender.send(());
                thread::sleep(Duration::from_millis(300));
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
            }
        });
        (format!("http://{address}"), accepted_receiver)
    }

    fn snapshot() -> CompanionSnapshotPayload {
        CompanionSnapshotPayload::new(
            "workspace-1".to_owned(),
            "/repo".to_owned(),
            7,
            1_700_000_000_000,
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
            },
        )
        .unwrap()
    }

    fn client(endpoint: String) -> KomlaClient {
        KomlaClient::new(endpoint)
    }

    #[test]
    fn snapshot_delivery_accepts_any_success_response() {
        let payload = snapshot();
        let endpoint = serve_once(204, "");

        assert!(client(endpoint).deliver_snapshot(&payload));
    }

    #[test]
    fn snapshot_delivery_keeps_the_request_stream_open_until_the_response() {
        let payload = snapshot();
        let endpoint = serve_once_rejecting_half_closed_request(204, "");

        assert!(client(endpoint).deliver_snapshot(&payload));
    }

    #[test]
    fn snapshot_delivery_retains_the_latest_value_after_a_failure() {
        let payload = snapshot();
        let endpoint = serve_once(503, "retry later");

        assert!(!client(endpoint).deliver_snapshot(&payload));
    }

    #[test]
    fn companion_requests_do_not_send_tunnel_credentials() {
        let payload = snapshot();
        let (endpoint, request) = serve_once_capturing_request(204, "");

        assert!(client(endpoint).deliver_snapshot(&payload));
        assert!(!request.recv().unwrap().contains("Authorization:"));
    }

    #[test]
    fn outbound_delivery_is_non_blocking_and_bounded() {
        let payload = snapshot();
        let (endpoint, accepted) = serve_slow_responses(String::new(), 2);
        let transport = OutboundTransport::with_limits(client(endpoint), 1, 1);

        let started = std::time::Instant::now();
        assert!(transport.submit(OutboundRequest::Snapshot {
            workspace_key: 0,
            payload: Box::new(payload.clone()),
        }));
        accepted.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(transport.submit(OutboundRequest::Snapshot {
            workspace_key: 1,
            payload: Box::new(payload.clone()),
        }));
        assert!(!transport.submit(OutboundRequest::Snapshot {
            workspace_key: 2,
            payload: Box::new(payload),
        }));

        assert!(started.elapsed() < Duration::from_millis(100));
    }
}
