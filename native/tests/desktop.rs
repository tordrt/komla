#![cfg(unix)]

use std::os::unix::net::UnixListener;
use std::process::{Command, Output};

/// Runs `komla desktop` on a desktop: a Wayland socket that accepts connections.
fn desktop(arguments: &[&str]) -> Output {
    let runtime = tempfile::tempdir().unwrap();
    let _compositor = UnixListener::bind(runtime.path().join("wayland-7")).unwrap();
    Command::new(env!("CARGO_BIN_EXE_komla"))
        .arg("desktop")
        .args(arguments)
        .env_remove("DISPLAY")
        .env("WAYLAND_DISPLAY", "wayland-7")
        .env("XDG_RUNTIME_DIR", runtime.path())
        .env("KOMLA_TERMINAL_ID", "terminal-1")
        .output()
        .unwrap()
}

#[test]
fn run_starts_the_app_on_an_existing_display_without_komla_variables() {
    let output = desktop(&[
        "run",
        "--",
        "sh",
        "-c",
        "echo \"$WAYLAND_DISPLAY ${KOMLA_TERMINAL_ID-unset} $0\"",
        "--help",
    ]);

    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&output.stdout),
        "wayland-7 unset --help\n"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn run_starts_the_virtual_desktop_instead_of_a_forwarded_display() {
    let state = tempfile::tempdir().unwrap();
    let no_programs = tempfile::tempdir().unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_komla"))
        .args(["desktop", "run", "--", "/bin/sh", "-c", "echo started"])
        .env("DISPLAY", "localhost:10.0")
        .env_remove("WAYLAND_DISPLAY")
        .env("PATH", no_programs.path())
        .env("XDG_STATE_HOME", state.path())
        .output()
        .unwrap();

    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(String::from_utf8_lossy(&output.stderr).contains("Xvnc not found"));
    // Machines that share a home folder, as clusters often do, keep separate desktops.
    let host = std::fs::read_to_string("/proc/sys/kernel/hostname").unwrap();
    let desktops = state.path().join("komla/desktop").join(host.trim());
    assert!(desktops.is_dir());
    // The app's claim on a desktop goes with the desktop that didn't start.
    let files: Vec<_> = std::fs::read_dir(&desktops)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(files, ["lock"]);
}

#[cfg(target_os = "linux")]
#[test]
fn run_checks_the_app_before_starting_a_desktop_for_it() {
    let state = tempfile::tempdir().unwrap();
    let no_programs = tempfile::tempdir().unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_komla"))
        .args(["desktop", "run", "--", "komla-desktop-missing-app"])
        .env("DISPLAY", "localhost:10.0")
        .env_remove("WAYLAND_DISPLAY")
        .env("PATH", no_programs.path())
        .env("XDG_STATE_HOME", state.path())
        .output()
        .unwrap();

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("could not run komla-desktop-missing-app"),
        "{stderr}"
    );
    assert!(!state.path().join("komla").exists());
}

#[cfg(target_os = "linux")]
#[test]
fn a_desktop_that_fails_to_start_removes_the_apps_claim() {
    let state = tempfile::tempdir().unwrap();
    let no_programs = tempfile::tempdir().unwrap();
    let host = std::fs::read_to_string("/proc/sys/kernel/hostname").unwrap();
    let desktops = state.path().join("komla/desktop").join(host.trim());
    std::fs::create_dir_all(&desktops).unwrap();
    // `desktop run` claimed it, then went away, as after Ctrl+C.
    std::fs::write(desktops.join("app-1.lock"), "").unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_komla"))
        .args(["desktop", "__start", "app-1.lock", "/bin/true"])
        .env("PATH", no_programs.path())
        .env("XDG_STATE_HOME", state.path())
        .output()
        .unwrap();

    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("Xvnc not found"));
    assert!(!desktops.join("app-1.lock").exists());
}

#[cfg(target_os = "linux")]
#[test]
fn run_finishes_starting_the_desktop_after_ctrl_c() {
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::process::CommandExt;
    use std::process::Stdio;
    use std::thread::sleep;
    use std::time::{Duration, Instant};

    let state = tempfile::tempdir().unwrap();
    let programs = tempfile::tempdir().unwrap();
    let started = programs.path().join("started");
    // An X server that never gets ready, and says which process started it.
    let xvnc = programs.path().join("Xvnc");
    std::fs::write(
        &xvnc,
        format!(
            // Builtins only: dash blocks every signal while it starts a child such as grep.
            "#!/bin/sh\nwhile read -r key value; do [ \"$key\" = SigBlk: ] && blocked=$value; done \
< /proc/$$/status\necho \"$PPID $$ SigBlk: $blocked\" > {}.new\nmv {0}.new {0}\nexec sleep 30\n",
            started.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&xvnc, std::fs::Permissions::from_mode(0o755)).unwrap();
    let mut run = Command::new(env!("CARGO_BIN_EXE_komla"))
        .args(["desktop", "run", "--", "/bin/true"])
        .env("DISPLAY", "localhost:10.0")
        .env_remove("WAYLAND_DISPLAY")
        .env(
            "PATH",
            format!("{}:/usr/bin:/bin", programs.path().display()),
        )
        .env("XDG_STATE_HOME", state.path())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    let report = loop {
        if let Ok(report) = std::fs::read_to_string(&started) {
            break report;
        }
        assert!(Instant::now() < deadline, "Xvnc didn't start");
        sleep(Duration::from_millis(20));
    };
    let [helper, xvnc, _, blocked] = report.split_whitespace().collect::<Vec<_>>()[..] else {
        panic!("unexpected report {report:?}");
    };
    let (helper, xvnc): (i32, i32) = (helper.parse().unwrap(), xvnc.parse().unwrap());

    // Ctrl+C reaches every process in the terminal's foreground process group.
    unsafe { libc::kill(-(run.id() as i32), libc::SIGINT) };
    assert!(!run.wait().unwrap().success());
    sleep(Duration::from_millis(300));
    let helper_running = std::fs::read_to_string(format!("/proc/{helper}/stat"))
        .is_ok_and(|stat| !stat.contains(") Z "));
    unsafe {
        libc::kill(helper, libc::SIGKILL);
        libc::kill(xvnc, libc::SIGKILL);
    }

    // It finishes, so the desktop's watcher stops the desktop the app never got.
    assert!(helper_running, "the desktop's start stopped halfway");
    // The desktop's own processes take Ctrl+C as usual.
    assert_eq!(blocked, "0000000000000000");
}

#[test]
fn run_shows_its_help_after_browser() {
    let output = desktop(&["run", "--browser", "--help"]);

    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).starts_with("usage: komla desktop"));
}

#[test]
fn run_shows_its_help_after_app() {
    let output = desktop(&["run", "--app", "--help"]);

    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).starts_with("usage: komla desktop"));
}

#[test]
fn run_requires_a_command() {
    let output = desktop(&["run", "--"]);

    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("usage: komla desktop run"));
}

#[test]
fn run_reports_an_app_that_cannot_start() {
    let output = desktop(&["run", "/nonexistent/komla-desktop-app"]);

    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr)
        .contains("could not run /nonexistent/komla-desktop-app"));
}
