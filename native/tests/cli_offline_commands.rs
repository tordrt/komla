use std::fs;
use std::net::TcpListener;
use std::path::Path;
use std::process::{Command, Output, Stdio};

use serde_json::{json, Value};
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

/// Runs `komla <arguments>` in a Komla terminal on an SSH host whose desktop is away. With an
/// inbox, the terminal's companion receives on this host.
fn run_while_away(inbox: Option<&Path>, arguments: &[&str]) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_komla"));
    command
        .args(arguments)
        .env_clear()
        .envs(windows_essentials())
        .env("KOMLA_API_URL", "http://127.0.0.1:1/terminals/terminal-1")
        .env("KOMLA_TERMINAL_ID", "terminal-1")
        .env("KOMLA_WORKSPACE_ID", "workspace-1")
        .stdin(Stdio::null());
    if let Some(inbox) = inbox {
        command.env("KOMLA_COMPANION_INBOX", inbox);
    }
    command.output().unwrap()
}

fn queued(outbox: &Path) -> Vec<Value> {
    let mut paths: Vec<_> = fs::read_dir(outbox)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .collect()
        })
        .unwrap_or_default();
    paths.sort();
    paths
        .iter()
        .map(|path| serde_json::from_slice(&fs::read(path).unwrap()).unwrap())
        .collect()
}

#[test]
fn workspace_commands_wait_on_the_host_while_komla_is_away() {
    let temporary = TempDir::new().unwrap();
    let inbox = temporary.path().join("companion/inbox");

    let title = run_while_away(Some(&inbox), &["title", "Fix the cache"]);
    let tag = run_while_away(Some(&inbox), &["tag", "Ready for review"]);
    let snooze = run_while_away(
        Some(&inbox),
        &["snooze", "30m", "--until-notified", "--json"],
    );

    assert!(title.status.success(), "{title:?}");
    assert_eq!(
        String::from_utf8(title.stdout).unwrap(),
        "Komla couldn't be reached, so this waits on the host until it can.\n"
    );
    assert!(tag.status.success(), "{tag:?}");
    // The title waits already, so the tag queues behind it.
    assert_eq!(
        String::from_utf8(tag.stdout).unwrap(),
        "Komla hasn't received earlier commands from this host yet, so this waits behind them.\n"
    );
    assert!(snooze.status.success(), "{snooze:?}");
    assert_eq!(
        String::from_utf8(snooze.stdout).unwrap(),
        "{\"queued\":true}\n"
    );
    let commands = queued(&temporary.path().join("companion/outbox"));
    let operations: Vec<_> = commands
        .iter()
        .map(|command| command["operation"].clone())
        .collect();
    assert_eq!(
        operations,
        [
            json!({"type": "workspace.title", "title": "Fix the cache"}),
            json!({"type": "workspace.tag", "tag": "Ready for review"}),
            json!({"type": "workspace.snooze", "until": "30m", "untilNotified": true}),
        ]
    );
    assert_eq!(commands[0]["path"], "/api/v1/commands");
    assert_eq!(commands[0]["terminalId"], "terminal-1");
    assert_eq!(commands[0]["workspaceId"], "workspace-1");
    assert!(commands[0]["requestedAt"].as_u64().unwrap() > 0);
}

#[test]
fn workspace_commands_still_fail_without_a_companion_to_deliver_them() {
    let output = run_while_away(None, &["title", "Fix the cache"]);

    assert!(!output.status.success(), "{output:?}");
    assert!(String::from_utf8_lossy(&output.stderr).contains("Komla isn't connected"));
}

fn write_manifest(base: &Path, id: &str, name: &str, status: &str, updated_at: u64) {
    let directory = base.join("workspaces");
    fs::create_dir_all(directory.join("deleted")).unwrap();
    fs::write(
        directory.join(format!("{id}.json")),
        serde_json::to_vec(&json!({
            "schema": 1,
            "workspaceId": id,
            "name": "generated-name",
            "customName": name,
            "branchName": format!("{id}-branch"),
            "backend": {
                "remoteDirectory": base.join("worktrees").join(id),
                "remoteRepoPath": base.join("repos/web.git"),
                "remoteProjectRoot": base.join("repos"),
                "gitUrl": "git@example.com:web.git",
                "projectName": "web"
            },
            "terminals": [],
            "status": status,
            "createdAt": 1,
            "updatedAt": updated_at
        }))
        .unwrap(),
    )
    .unwrap();
}

/// Runs `komla <arguments>` on an SSH host whose Komla data is `base`, with Komla away.
fn run_on_host(base: &Path, arguments: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_komla"))
        .args(arguments)
        .env_clear()
        .envs(windows_essentials())
        .env("KOMLA_API_URL", "http://127.0.0.1:1")
        .env("KOMLA_CLI", base.join("helpers/komla"))
        .stdin(Stdio::null())
        .output()
        .unwrap()
}

#[test]
fn workspace_list_reads_the_hosts_manifests_while_komla_is_away() {
    let temporary = TempDir::new().unwrap();
    let base = temporary.path();
    write_manifest(base, "ws-old", "Fix the cache", "active", 1_000);
    write_manifest(base, "ws-new", "Add search", "active", 2_000);
    write_manifest(base, "ws-gone", "Old idea", "trashed", 3_000);

    let listed = run_on_host(base, &["workspace", "list", "--json"]);
    let all = run_on_host(base, &["workspace", "list", "--all"]);

    assert!(listed.status.success(), "{listed:?}");
    assert!(String::from_utf8_lossy(&listed.stderr).contains("without their tags"));
    let result: Value = serde_json::from_slice(&listed.stdout).unwrap();
    assert_eq!(
        result["workspaces"],
        json!([
            {
                "id": "ws-new",
                "name": "Add search",
                "path": base.join("worktrees").join("ws-new"),
                "project": {"name": "web"},
                "branch": "ws-new-branch"
            },
            {
                "id": "ws-old",
                "name": "Fix the cache",
                "path": base.join("worktrees").join("ws-old"),
                "project": {"name": "web"},
                "branch": "ws-old-branch"
            }
        ])
    );
    assert!(all.status.success(), "{all:?}");
    assert_eq!(
        String::from_utf8(all.stdout).unwrap(),
        "ws-gone  Old idea  [ws-gone-branch]\nws-new  Add search  [ws-new-branch]\n\
ws-old  Fix the cache  [ws-old-branch]\n"
    );
}

#[test]
fn workspace_list_still_fails_off_an_ssh_host() {
    let temporary = TempDir::new().unwrap();

    let output = run_on_host(temporary.path(), &["workspace", "list"]);

    assert!(!output.status.success(), "{output:?}");
    assert!(String::from_utf8_lossy(&output.stderr).contains("Komla isn't connected"));
}

#[test]
fn commands_the_user_turned_off_are_refused_rather_than_queued() {
    let temporary = TempDir::new().unwrap();
    let companion = temporary.path().join("companion");
    fs::create_dir_all(&companion).unwrap();
    let config = companion.join("0123abcd.json");
    let turned_off =
        "`komla tag` is turned off in Komla. Ask the user to turn it on in Settings → \
Integrations & MCP → MCP and CLI access.";
    fs::write(
        &config,
        serde_json::to_vec(&json!({"turnedOffCommands": {"workspace.tag": turned_off}})).unwrap(),
    )
    .unwrap();
    fs::write(
        companion.join("current-config"),
        format!("{}\n", config.display()),
    )
    .unwrap();
    let inbox = companion.join("inbox");

    let tag = run_while_away(Some(&inbox), &["tag", "Blocked", "--json"]);
    let title = run_while_away(Some(&inbox), &["title", "Fix the cache"]);

    assert!(!tag.status.success(), "{tag:?}");
    let error: Value = serde_json::from_slice(&tag.stdout).unwrap();
    assert_eq!(error["error"]["code"], "CAPABILITY_DISABLED");
    assert_eq!(error["error"]["message"], turned_off);
    assert!(title.status.success(), "{title:?}");
    let operations: Vec<_> = queued(&companion.join("outbox"))
        .into_iter()
        .map(|command| command["operation"]["type"].clone())
        .collect();
    assert_eq!(operations, [json!("workspace.title")]);
}

/// Runs `komla wake` in the host's Komla terminal while Komla answers at `komla`.
fn wake_with_komla_at(komla: &TcpListener, inbox: &Path) -> Output {
    Command::new(env!("CARGO_BIN_EXE_komla"))
        .args(["wake"])
        .env_clear()
        .envs(windows_essentials())
        .env(
            "KOMLA_API_URL",
            format!(
                "http://{}/terminals/terminal-1",
                komla.local_addr().unwrap()
            ),
        )
        .env("KOMLA_TERMINAL_ID", "terminal-1")
        .env("KOMLA_COMPANION_INBOX", inbox)
        .stdin(Stdio::null())
        .output()
        .unwrap()
}

// Komla came back, but the companion hasn't delivered what was queued while it was away.
#[test]
fn a_new_command_waits_behind_earlier_ones_the_companion_is_delivering() {
    let temporary = TempDir::new().unwrap();
    let inbox = temporary.path().join("companion/inbox");
    assert!(
        run_while_away(Some(&inbox), &["snooze", "30m", "--until-notified"])
            .status
            .success()
    );
    // The companion marks itself receiving while its desktop answers.
    fs::write(temporary.path().join("companion/receiving"), b"").unwrap();
    let komla = TcpListener::bind("127.0.0.1:0").unwrap();
    komla.set_nonblocking(true).unwrap();

    let wake = wake_with_komla_at(&komla, &inbox);

    assert!(wake.status.success(), "{wake:?}");
    assert_eq!(
        String::from_utf8(wake.stdout).unwrap(),
        "Komla hasn't received earlier commands from this host yet, so this waits behind them.\n"
    );
    assert_eq!(
        komla.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
    let operations: Vec<_> = queued(&temporary.path().join("companion/outbox"))
        .into_iter()
        .map(|command| command["operation"]["type"].clone())
        .collect();
    assert_eq!(
        operations,
        [json!("workspace.snooze"), json!("workspace.wake")]
    );
}

// Komla answers again but the companion hasn't seen it yet, or isn't running: the new command
// still waits behind the earlier ones rather than overtake them.
#[test]
fn a_new_command_never_overtakes_earlier_ones() {
    let temporary = TempDir::new().unwrap();
    let inbox = temporary.path().join("companion/inbox");
    assert!(run_while_away(Some(&inbox), &["title", "Fix the cache"])
        .status
        .success());
    let komla = TcpListener::bind("127.0.0.1:0").unwrap();
    komla.set_nonblocking(true).unwrap();

    let started = std::time::Instant::now();
    let wake = wake_with_komla_at(&komla, &inbox);

    assert!(wake.status.success(), "{wake:?}");
    assert!(
        started.elapsed() < std::time::Duration::from_secs(2),
        "nothing delivers them, so it doesn't wait"
    );
    assert_eq!(
        komla.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
    assert_eq!(queued(&temporary.path().join("companion/outbox")).len(), 2);
}

// Once the companion delivers them, the command goes to Komla itself, which reports its errors.
#[test]
fn a_new_command_goes_to_komla_once_the_companion_delivers_earlier_ones() {
    let temporary = TempDir::new().unwrap();
    let inbox = temporary.path().join("companion/inbox");
    assert!(run_while_away(Some(&inbox), &["title", "Fix the cache"])
        .status
        .success());
    fs::write(temporary.path().join("companion/receiving"), b"").unwrap();
    let outbox = temporary.path().join("companion/outbox");
    let companion = {
        let outbox = outbox.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(300));
            for entry in fs::read_dir(&outbox).unwrap() {
                fs::remove_file(entry.unwrap().path()).unwrap();
            }
        })
    };
    let komla = TcpListener::bind("127.0.0.1:0").unwrap();
    let server = {
        let komla = komla.try_clone().unwrap();
        std::thread::spawn(move || {
            use std::io::{Read, Write};
            let (mut stream, _) = komla.accept().unwrap();
            let mut request = [0_u8; 4096];
            let _ = stream.read(&mut request).unwrap();
            let body = br#"{"ok":true,"result":{"snooze":{"workspaceId":"ws-1","woke":true}}}"#;
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\
Connection: close\r\n\r\n",
                body.len()
            )
            .unwrap();
            stream.write_all(body).unwrap();
            String::from_utf8_lossy(&request).into_owned()
        })
    };

    let wake = wake_with_komla_at(&komla, &inbox);

    companion.join().unwrap();
    assert!(wake.status.success(), "{wake:?}");
    assert_eq!(
        String::from_utf8(wake.stdout).unwrap(),
        "Workspace woken.\n"
    );
    // A CLI that never connected would leave the server waiting.
    let _ = std::net::TcpStream::connect(komla.local_addr().unwrap());
    server.join().unwrap();
    assert!(queued(&outbox).is_empty());
}
