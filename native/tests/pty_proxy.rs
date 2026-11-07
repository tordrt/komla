#![cfg(unix)]

use std::path::Path;
use std::process::Command;
use std::time::{Duration, Instant};

/// A tmux server of the test's own, away from any the user runs.
struct Tmux {
    directory: tempfile::TempDir,
}

impl Tmux {
    fn command(&self) -> Command {
        let mut command = Command::new("tmux");
        command
            .args(["-L", "komla-proxy-test"])
            .env("TMUX_TMPDIR", self.directory.path())
            .env_remove("TMUX")
            .env_remove("TMUX_PANE");
        command
    }

    fn status(&self, session: &str) -> String {
        let output = self
            .command()
            .args(["show-options", "-qv", "-t", &format!("={session}:")])
            .arg("@komla_status")
            .output()
            .unwrap();
        String::from_utf8_lossy(&output.stdout)
            .trim_end()
            .to_owned()
    }

    fn wait_for_status(&self, session: &str, expected: &str) {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let status = self.status(session);
            if status == expected {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "the session's status stayed {status:?}, not {expected:?}"
            );
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

impl Drop for Tmux {
    fn drop(&mut self) {
        let _ = self.command().arg("kill-server").output();
    }
}

fn touch(path: &Path) {
    std::fs::write(path, "").unwrap();
}

#[test]
fn keeps_the_session_status_at_the_program_report_without_a_client() {
    if Command::new("tmux").arg("-V").output().is_err() {
        eprintln!("skipped: no tmux");
        return;
    }
    let tmux = Tmux {
        directory: tempfile::tempdir().unwrap(),
    };
    let steps = tmux.directory.path();
    let program = format!(
        r"printf '\033]7501;state=working:app=x\033\\'
until [ -e {go} ]; do sleep 0.05; done
printf '\033]7501;state=idle:app=x\007'
until [ -e {stop} ]; do sleep 0.05; done
printf '\033]7501;state=clear\007'
exec sleep 60",
        go = steps.join("go").display(),
        stop = steps.join("stop").display(),
    );
    let started = tmux
        .command()
        .args(["new-session", "-d", "-s", "komla-t1", "--"])
        .arg(env!("CARGO_BIN_EXE_komla"))
        .args(["__pty-proxy", "sh", "-c", &program])
        .status()
        .unwrap();
    assert!(started.success());

    // No client is attached: the passthrough reaches no one, but the session holds the status.
    tmux.wait_for_status("komla-t1", "state=working:app=x");
    touch(&steps.join("go"));
    tmux.wait_for_status("komla-t1", "state=idle:app=x");
    touch(&steps.join("stop"));
    tmux.wait_for_status("komla-t1", "");
}
