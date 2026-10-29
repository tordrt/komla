use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::json;
use tempfile::TempDir;

/// What a Windows process needs after `env_clear`: SystemRoot to open sockets and PATH to find
/// git. Unix needs neither.
fn windows_essentials() -> Vec<(&'static str, std::ffi::OsString)> {
    if !cfg!(windows) {
        return Vec::new();
    }
    ["SystemRoot", "PATH"]
        .into_iter()
        .filter_map(|name| std::env::var_os(name).map(|value| (name, value)))
        .collect()
}

fn git(directory: &std::path::Path, arguments: &[&str]) {
    let output = Command::new("git")
        .args(arguments)
        .current_dir(directory)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {arguments:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn read_http_request(stream: &mut TcpStream) -> Vec<u8> {
    let mut request = Vec::new();
    let mut buffer = [0_u8; 1024];
    let mut expected_length = None;
    loop {
        let bytes_read = stream.read(&mut buffer).unwrap();
        assert!(
            bytes_read > 0,
            "HTTP request ended before its body was complete"
        );
        request.extend_from_slice(&buffer[..bytes_read]);
        if expected_length.is_none() {
            let text = String::from_utf8_lossy(&request);
            if let Some(header_end) = text.find("\r\n\r\n") {
                let content_length = text[..header_end]
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().unwrap())
                    })
                    .unwrap_or(0);
                expected_length = Some(header_end + 4 + content_length);
            }
        }
        if expected_length.is_some_and(|length| request.len() >= length) {
            return request;
        }
    }
}

/// Writes a hook's input. A CLI that fails before reading it, such as when Komla isn't
/// running, may already have exited and closed the pipe.
fn write_hook_input(child: &mut Child, input: &[u8]) {
    if let Err(error) = child.stdin.take().unwrap().write_all(input) {
        assert_eq!(error.kind(), std::io::ErrorKind::BrokenPipe);
    }
}

fn spawn_mailbox_notify(inbox: &std::path::Path) -> (Child, ChildStdin) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_komla"))
        .args(["notify", "--source", "codex", "--event", "Stop"])
        .env_clear()
        .envs(windows_essentials())
        .env("KOMLA_API_URL", "http://127.0.0.1:1/terminals/terminal-1")
        .env("KOMLA_TERMINAL_ID", "terminal-1")
        .env("KOMLA_WORKSPACE_ID", "workspace-1")
        .env("KOMLA_COMPANION_INBOX", inbox)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let stdin = child.stdin.take().unwrap();
    (child, stdin)
}

fn wait_for_hook(child: &mut Child) -> ExitStatus {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            return status;
        }
        if Instant::now() >= deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("komla notify waited for hook stdin to close");
        }
        thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn notify_preserves_help_flags_used_as_body_values() {
    for body in ["--help", "-h"] {
        let temporary = TempDir::new().unwrap();
        let inbox = temporary.path().join("inbox");
        let output = Command::new(env!("CARGO_BIN_EXE_komla"))
            .args(["notify", "Test notification", "--body", body])
            .env_clear()
            .envs(windows_essentials())
            .env("KOMLA_API_URL", "http://127.0.0.1:1")
            .env("KOMLA_TERMINAL_ID", "terminal-1")
            .env("KOMLA_COMPANION_INBOX", &inbox)
            .output()
            .unwrap();
        assert!(output.status.success(), "{output:?}");
        assert_eq!(
            String::from_utf8(output.stdout).unwrap(),
            "{\"queued\":true}\n"
        );
        let path = fs::read_dir(&inbox)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let hook: serde_json::Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        assert_eq!(hook["title"], "Test notification");
        assert_eq!(hook["body"], body);
    }
}

// The managed companion route is a Remote Companion install on a Linux or macOS SSH host.
#[cfg(unix)]
#[test]
fn notify_discovers_the_matching_managed_companion_route() {
    let temporary = TempDir::new().unwrap();
    let workspace = temporary.path().join("worktree");
    fs::create_dir_all(&workspace).unwrap();
    // The CLI matches its canonical cwd (macOS temp dirs live under /private).
    let workspace = workspace.canonicalize().unwrap();
    let komla_data = temporary.path().join("custom-komla-data");
    let installed_binary = komla_data
        .join("helpers/bin/protocol-1/build-digest")
        .join("komla");
    fs::create_dir_all(installed_binary.parent().unwrap()).unwrap();
    fs::copy(env!("CARGO_BIN_EXE_komla"), &installed_binary).unwrap();

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!(
        "http://{}/api/v1/ssh-workspace-status",
        listener.local_addr().unwrap()
    );
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let request = read_http_request(&mut stream);
        stream
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Length: 16\r\nConnection: close\r\n\r\n{\"success\":true}",
            )
            .unwrap();
        request
    });

    let config_directory = komla_data.join("helpers/companion/installation");
    fs::create_dir_all(&config_directory).unwrap();
    fs::write(
        config_directory.join("config.json"),
        serde_json::to_vec(&json!({
            "endpoint": endpoint,
            "installationId": "installation",
            "hookInbox": temporary.path().join("inbox"),
            "workspaces": [{
                "workspaceId": "workspace-1",
                "workingTree": workspace,
                "targetBranch": "main"
            }]
        }))
        .unwrap(),
    )
    .unwrap();

    let unrelated_home = temporary.path().join("home");
    fs::create_dir_all(&unrelated_home).unwrap();
    let mut command = Command::new(installed_binary);
    command
        .args(["notify", "--source", "codex", "--event", "Stop"])
        .current_dir(&workspace)
        .env_clear()
        .env("HOME", unrelated_home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Until a child another test thread forks execs, it holds the copy open for writing,
    // and running it fails with "Text file busy".
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut child = loop {
        match command.spawn() {
            Err(error)
                if error.kind() == std::io::ErrorKind::ExecutableFileBusy
                    && Instant::now() < deadline =>
            {
                thread::sleep(Duration::from_millis(10));
            }
            result => break result.unwrap(),
        }
    };
    child
        .stdin
        .take()
        .unwrap()
        .write_all(br#"{"hook_event_name":"Stop"}"#)
        .unwrap();
    let output = child.wait_with_output().unwrap();

    assert!(
        output.status.success(),
        "komla notify failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(String::from_utf8(output.stdout).unwrap(), "");
    let request = String::from_utf8(server.join().unwrap()).unwrap();
    assert!(request.starts_with("POST /api/v1/notify HTTP/1.1\r\n"));
    assert!(request.contains("\"cwd\":"));
    assert!(request.contains("X-Komla-Workspace-Id: workspace-1\r\n"));
}

/// A desktop's route on this SSH host, written `age` ago, as its companion writes it.
fn write_companion_route(
    data: &std::path::Path,
    installation: &str,
    address: std::net::SocketAddr,
    age: Duration,
) {
    let directory = data.join("helpers/companion").join(installation);
    fs::create_dir_all(&directory).unwrap();
    let path = directory.join("config.json");
    fs::write(
        &path,
        serde_json::to_vec(&json!({
            "endpoint": format!("http://{address}/api/v1/ssh-workspace-status"),
            "installationId": installation,
            "hookInbox": data.join("inbox"),
            "workspaces": [{
                "workspaceId": format!("{installation}-workspace"),
                "workingTree": data.join("worktree"),
                "targetBranch": "main"
            }]
        }))
        .unwrap(),
    )
    .unwrap();
    fs::File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_modified(std::time::SystemTime::now() - age)
        .unwrap();
}

/// A port nothing listens on, as a desktop that quit leaves its route's. A port freed by
/// another listener could be bound again by a parallel test.
fn closed_port() -> std::net::SocketAddr {
    "127.0.0.1:1".parse().unwrap()
}

/// Answers one request as a launch, past connections that only check the port is open.
fn serve_launch(listener: TcpListener) -> thread::JoinHandle<String> {
    thread::spawn(move || loop {
        let (mut stream, _) = listener.accept().unwrap();
        if stream.peek(&mut [0_u8; 1]).unwrap() == 0 {
            continue;
        }
        let request = read_http_request(&mut stream);
        let body = br#"{"ok":true,"result":{"state":"started","destination":{"kind":"workspace","workspaceId":"workspace-new"}}}"#;
        let head = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        stream.write_all(head.as_bytes()).unwrap();
        stream.write_all(body).unwrap();
        return String::from_utf8(request).unwrap();
    })
}

/// Runs `komla <arguments>` from outside every workspace on a host whose data is `data`.
fn run_outside_workspaces(data: &std::path::Path, arguments: &[&str]) -> std::process::Output {
    let home = data.join("home");
    fs::create_dir_all(&home).unwrap();
    Command::new(env!("CARGO_BIN_EXE_komla"))
        .args(arguments)
        .current_dir(&home)
        .env_clear()
        .envs(windows_essentials())
        .env("KOMLA_DATA_DIR", data)
        .stdin(Stdio::null())
        .output()
        .unwrap()
}

const LAUNCH_PROJECT: [&str; 6] = [
    "agent",
    "launch",
    "Investigate the cache",
    "--new-workspace",
    "--project",
    "Project A",
];

// Outside every workspace, as in `ssh host komla agent launch --project ...`, the desktop that
// last connected to the host takes the request, skipping one that has since quit.
#[test]
fn launch_outside_a_workspace_reaches_the_hosts_connected_desktop() {
    let temporary = TempDir::new().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    write_companion_route(
        temporary.path(),
        "connected",
        listener.local_addr().unwrap(),
        Duration::from_secs(60),
    );
    write_companion_route(temporary.path(), "quit", closed_port(), Duration::ZERO);
    let server = serve_launch(listener);

    let output = run_outside_workspaces(temporary.path(), &LAUNCH_PROJECT);

    // A CLI that never reaches Komla leaves the server waiting, so check it first.
    assert!(output.status.success(), "{output:?}");
    let request = server.join().unwrap();
    assert!(request.starts_with("POST /api/v1/commands?"), "{request}");
    assert!(!request.contains("X-Komla-Workspace-Id"), "{request}");
    assert!(request.contains(r#""project":"Project A""#), "{request}");
}

#[test]
fn launch_outside_a_workspace_prefers_komla_running_on_the_host() {
    let temporary = TempDir::new().unwrap();
    let remote = TcpListener::bind("127.0.0.1:0").unwrap();
    write_companion_route(
        temporary.path(),
        "remote",
        remote.local_addr().unwrap(),
        Duration::ZERO,
    );
    let local = TcpListener::bind("127.0.0.1:0").unwrap();
    fs::write(
        temporary.path().join("port"),
        local.local_addr().unwrap().port().to_string(),
    )
    .unwrap();
    let server = serve_launch(local);

    let output = run_outside_workspaces(temporary.path(), &LAUNCH_PROJECT);

    assert!(output.status.success(), "{output:?}");
    assert!(server.join().unwrap().contains(r#""project":"Project A""#));
}

// Komla that crashed leaves its port file behind.
#[test]
fn launch_outside_a_workspace_passes_a_port_file_komla_left_behind() {
    let temporary = TempDir::new().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    write_companion_route(
        temporary.path(),
        "connected",
        listener.local_addr().unwrap(),
        Duration::ZERO,
    );
    fs::write(
        temporary.path().join("port"),
        closed_port().port().to_string(),
    )
    .unwrap();
    let server = serve_launch(listener);

    let output = run_outside_workspaces(temporary.path(), &LAUNCH_PROJECT);

    assert!(output.status.success(), "{output:?}");
    assert!(server.join().unwrap().contains(r#""project":"Project A""#));
}

// With no desktop connected either, the launch is left to the host's own Komla.
#[test]
fn launch_outside_a_workspace_leaves_a_crashed_komla_to_start_offline() {
    let temporary = TempDir::new().unwrap();
    write_companion_route(temporary.path(), "quit", closed_port(), Duration::ZERO);
    fs::write(
        temporary.path().join("port"),
        closed_port().port().to_string(),
    )
    .unwrap();

    let output = run_outside_workspaces(temporary.path(), &LAUNCH_PROJECT);

    assert!(!output.status.success(), "{output:?}");
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains("--preset, --mode, and --project are unavailable"),
        "{output:?}"
    );
}

#[test]
fn launch_outside_a_workspace_says_to_open_komla_when_no_desktop_is_connected() {
    let temporary = TempDir::new().unwrap();
    write_companion_route(temporary.path(), "quit", closed_port(), Duration::ZERO);

    let output = run_outside_workspaces(temporary.path(), &LAUNCH_PROJECT);

    assert!(!output.status.success(), "{output:?}");
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains("Komla isn't connected. Open Komla on a device that uses this host"),
        "{output:?}"
    );
}

#[test]
fn workspace_list_outside_a_workspace_reaches_the_hosts_desktop() {
    let temporary = TempDir::new().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    write_companion_route(
        temporary.path(),
        "connected",
        listener.local_addr().unwrap(),
        Duration::ZERO,
    );
    let server = serve_launch(listener);

    run_outside_workspaces(temporary.path(), &["workspace", "list", "--json"]);

    let request = server.join().unwrap();
    assert!(request.contains(r#""type":"workspace.list""#), "{request}");
}

// An agent's hooks in a plain SSH session stay off the desktops that use the host.
#[test]
fn hooks_outside_a_workspace_leave_the_hosts_desktops_alone() {
    let temporary = TempDir::new().unwrap();
    let remote = TcpListener::bind("127.0.0.1:0").unwrap();
    remote.set_nonblocking(true).unwrap();
    write_companion_route(
        temporary.path(),
        "remote",
        remote.local_addr().unwrap(),
        Duration::ZERO,
    );

    let output = run_outside_workspaces(
        temporary.path(),
        &["notify", "--source", "codex", "--event", "Stop"],
    );

    assert!(String::from_utf8_lossy(&output.stderr).contains("Komla is not running"));
    assert_eq!(
        remote.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
}

#[test]
fn notify_hooks_exit_cleanly_when_komla_is_not_running() {
    let temporary = TempDir::new().unwrap();
    let notify = |arguments: &[&str]| {
        let mut child = Command::new(env!("CARGO_BIN_EXE_komla"))
            .args(arguments)
            .current_dir(temporary.path())
            .env_clear()
            .envs(windows_essentials())
            .env("KOMLA_DATA_DIR", temporary.path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        write_hook_input(&mut child, b"{}");
        child.wait_with_output().unwrap()
    };

    let hook = notify(&["notify", "--source", "codex", "--event", "Stop"]);
    assert!(hook.status.success(), "{hook:?}");
    assert_eq!(String::from_utf8(hook.stdout).unwrap(), "");
    assert!(String::from_utf8(hook.stderr)
        .unwrap()
        .contains("Komla is not running"));

    let direct = notify(&["notify", "Review ready"]);
    assert!(!direct.status.success(), "{direct:?}");
}

#[test]
fn antigravity_hooks_reply_even_when_komla_is_not_running() {
    let temporary = TempDir::new().unwrap();
    for (event, reply) in [
        ("PreInvocation", "{}\n"),
        ("PostToolUse", "{}\n"),
        ("Stop", "{\"decision\":\"stop\"}\n"),
    ] {
        let mut child = Command::new(env!("CARGO_BIN_EXE_komla"))
            .args(["notify", "--source", "antigravity", "--event", event])
            .current_dir(temporary.path())
            .env_clear()
            .envs(windows_essentials())
            .env("KOMLA_DATA_DIR", temporary.path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        write_hook_input(&mut child, b"{}");
        let output = child.wait_with_output().unwrap();

        assert!(output.status.success(), "{output:?}");
        assert_eq!(String::from_utf8(output.stdout).unwrap(), reply, "{event}");
    }
}

#[test]
fn notify_hooks_exit_cleanly_when_komla_rejects_the_notification() {
    let temporary = TempDir::new().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let api_url = format!("http://{}", listener.local_addr().unwrap());
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        read_http_request(&mut stream);
        stream
            .write_all(
                b"HTTP/1.1 404 Not Found\r\nContent-Length: 39\r\nConnection: close\r\n\r\n{\"error\":\"No matching workspace found\"}",
            )
            .unwrap();
    });

    let mut child = Command::new(env!("CARGO_BIN_EXE_komla"))
        .args(["notify", "--source", "codex", "--event", "UserPromptSubmit"])
        .current_dir(temporary.path())
        .env_clear()
        .envs(windows_essentials())
        .env("KOMLA_API_URL", api_url)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(br#"{"prompt":"hello"}"#)
        .unwrap();
    let output = child.wait_with_output().unwrap();
    server.join().unwrap();

    assert!(output.status.success(), "{output:?}");
    assert_eq!(String::from_utf8(output.stdout).unwrap(), "");
    assert!(String::from_utf8(output.stderr)
        .unwrap()
        .contains("No matching workspace found"));
}

#[test]
fn notify_does_not_wait_for_hook_stdin_to_close() {
    let temporary = TempDir::new().unwrap();
    let inbox = temporary.path().join("inbox");
    let (mut child, mut stdin) = spawn_mailbox_notify(&inbox);
    stdin
        .write_all(br#"{"hook_event_name":"Stop","last_assistant_message":"Review ready"}"#)
        .unwrap();

    let status = wait_for_hook(&mut child);
    drop(stdin);

    assert!(status.success());
    let path = fs::read_dir(&inbox)
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let hook: serde_json::Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    assert_eq!(hook["hookInput"]["last_assistant_message"], "Review ready");
}

#[test]
fn notify_treats_trailing_non_json_input_as_empty_hook_metadata() {
    let temporary = TempDir::new().unwrap();
    let inbox = temporary.path().join("inbox");
    let (mut child, mut stdin) = spawn_mailbox_notify(&inbox);
    stdin
        .write_all(br#"{"last_assistant_message":"untrusted"} trailing"#)
        .unwrap();
    drop(stdin);

    let status = wait_for_hook(&mut child);

    assert!(status.success());
    let path = fs::read_dir(&inbox)
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let hook: serde_json::Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    assert_eq!(hook["hookInput"], json!({"hook_event_name": "Stop"}));
}

#[test]
fn notify_rejects_oversized_hook_input_before_queueing() {
    let temporary = TempDir::new().unwrap();
    let inbox = temporary.path().join("inbox");
    let (mut child, mut stdin) = spawn_mailbox_notify(&inbox);
    let input = json!({"payload": "x".repeat(1024 * 1024)}).to_string();
    if let Err(error) = stdin.write_all(input.as_bytes()) {
        assert_eq!(error.kind(), std::io::ErrorKind::BrokenPipe);
    }
    drop(stdin);

    // With stdin closed nothing can keep the hook waiting, so give it as long as a busy
    // computer takes to read and reject the input.
    let status = child.wait().unwrap();
    let mut stderr = String::new();
    child
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut stderr)
        .unwrap();

    assert!(status.success());
    assert!(stderr.contains("hook input exceeded 1048576 bytes"));
    assert!(!inbox.exists());
}

#[test]
fn notify_has_a_safety_timeout_when_hook_stdin_stays_empty() {
    let temporary = TempDir::new().unwrap();
    let inbox = temporary.path().join("inbox");
    let (mut child, stdin) = spawn_mailbox_notify(&inbox);

    let status = wait_for_hook(&mut child);
    drop(stdin);

    assert!(status.success());
    assert_eq!(fs::read_dir(inbox).unwrap().count(), 1);
}

#[test]
fn git_snapshot_reads_the_repository_without_a_desktop_connection() {
    let temporary = TempDir::new().unwrap();
    let repository = temporary.path().join("worktree");
    fs::create_dir_all(&repository).unwrap();
    git(&repository, &["init", "-b", "main"]);
    git(&repository, &["config", "user.email", "komla@example.com"]);
    git(&repository, &["config", "user.name", "Komla Test"]);
    fs::write(repository.join("tracked.txt"), "initial\n").unwrap();
    git(&repository, &["add", "tracked.txt"]);
    git(&repository, &["commit", "-m", "initial"]);
    git(&repository, &["switch", "-c", "feature"]);
    fs::write(repository.join("tracked.txt"), "changed\n").unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_komla"))
        .args([
            "git",
            "snapshot",
            "-C",
            repository.to_str().unwrap(),
            "--target",
            "main",
        ])
        .env_clear()
        .envs(windows_essentials())
        .output()
        .unwrap();

    assert!(
        output.status.success(),
        "komla git snapshot failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let snapshot: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(snapshot["observedAt"].as_u64().unwrap() > 0);
    assert_eq!(snapshot["branch"]["currentBranch"], "feature");
    assert_eq!(snapshot["branch"]["targetBranch"], "main");
    assert_eq!(snapshot["branch"]["defaultBranch"], "main");
    assert_eq!(snapshot["branch"]["aheadTargetBranch"], 0);
    assert_eq!(snapshot["statusTooLarge"], false);
    assert!(snapshot["statusB64"]
        .as_str()
        .is_some_and(|value| !value.is_empty()));
}

#[test]
fn tags_reaches_komla_from_the_installed_cli() {
    let temporary = TempDir::new().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let api_url = format!("http://{}", listener.local_addr().unwrap());
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let request = read_http_request(&mut stream);
        let body = br#"{"ok":true,"result":{"tags":[{"name":"Blocked","tone":"error"}]}}"#;
        let head = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        stream.write_all(head.as_bytes()).unwrap();
        stream.write_all(body).unwrap();
        request
    });

    let output = Command::new(env!("CARGO_BIN_EXE_komla"))
        .arg("tags")
        .current_dir(temporary.path())
        .env_clear()
        .envs(windows_essentials())
        .env("KOMLA_API_URL", api_url)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    // A CLI that never reaches Komla leaves the server waiting, so check it first.
    assert!(output.status.success(), "{output:?}");
    assert_eq!(
        String::from_utf8(output.stdout).unwrap(),
        "Blocked  (error)\n"
    );
    let request = String::from_utf8(server.join().unwrap()).unwrap();
    assert!(request.ends_with(r#"{"type":"tag.list"}"#), "{request}");
}
