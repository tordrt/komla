use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use tempfile::{tempdir, TempDir};

fn git(cwd: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .current_dir(cwd)
        .args(args)
        .env("GIT_AUTHOR_NAME", "Komla Test")
        .env("GIT_AUTHOR_EMAIL", "komla@example.com")
        .env("GIT_COMMITTER_NAME", "Komla Test")
        .env("GIT_COMMITTER_EMAIL", "komla@example.com")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}
struct Repo {
    _temp: TempDir,
    seed: PathBuf,
    bare: PathBuf,
    feature: PathBuf,
}
impl Repo {
    fn new() -> Self {
        let temp = tempdir().unwrap();
        let root = temp.path();
        let seed = root.join("seed");
        let origin = root.join("origin.git");
        let bare = root.join("repo.git");
        let feature = root.join("feature with ' quotes");
        git(root, &["init", "-b", "main", seed.to_str().unwrap()]);
        fs::write(seed.join("shared.txt"), "initial\n").unwrap();
        git(&seed, &["add", "."]);
        git(&seed, &["commit", "-m", "initial"]);
        git(
            root,
            &[
                "clone",
                "--bare",
                seed.to_str().unwrap(),
                origin.to_str().unwrap(),
            ],
        );
        git(
            &seed,
            &["remote", "add", "origin", origin.to_str().unwrap()],
        );
        git(
            root,
            &[
                "clone",
                "--bare",
                origin.to_str().unwrap(),
                bare.to_str().unwrap(),
            ],
        );
        git(&bare, &["config", "user.name", "Komla Test"]);
        git(&bare, &["config", "user.email", "komla@example.com"]);
        git(
            &bare,
            &[
                "config",
                "remote.origin.fetch",
                "+refs/heads/*:refs/remotes/origin/*",
            ],
        );
        git(&bare, &["fetch", "origin"]);
        git(
            &bare,
            &[
                "worktree",
                "add",
                "-b",
                "feature",
                feature.to_str().unwrap(),
                "main",
            ],
        );
        fs::write(feature.join("feature.txt"), "feature\n").unwrap();
        git(&feature, &["add", "."]);
        git(&feature, &["commit", "-m", "feature"]);
        Self {
            _temp: temp,
            seed,
            bare,
            feature,
        }
    }
    fn run(&self, action: &str) -> Value {
        let output = Command::new(env!("CARGO_BIN_EXE_komla"))
            .args([
                "git",
                "target",
                action,
                "-C",
                self.feature.to_str().unwrap(),
                "--target",
                "main",
            ])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice(&output.stdout).unwrap()
    }
    fn helper(&self) -> PathBuf {
        self.bare.join("komla-target-helper")
    }
    // Target operations only create the helper to merge on Git without `merge-tree --write-tree`.
    fn assert_clean_helper(&self) {
        if self.helper().exists() {
            assert_eq!(
                git(&self.helper(), &["rev-parse", "--abbrev-ref", "HEAD"]),
                "HEAD"
            );
            assert_eq!(git(&self.helper(), &["status", "--porcelain"]), "");
        }
        assert!(!self.bare.join("komla-target-operation.lock").exists());
    }
    #[cfg(unix)]
    fn run_with_path(&self, action: &str, path: &str) -> Value {
        let output = Command::new(env!("CARGO_BIN_EXE_komla"))
            .args([
                "git",
                "target",
                action,
                "-C",
                self.feature.to_str().unwrap(),
                "--target",
                "main",
            ])
            .env("PATH", path)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice(&output.stdout).unwrap()
    }
    // Gives the local target and origin's a commit each, touching different files.
    #[cfg(unix)]
    fn diverge_cleanly(&self) -> (String, String) {
        let target = self.seed.parent().unwrap().join("local main");
        git(
            &self.bare,
            &["worktree", "add", target.to_str().unwrap(), "main"],
        );
        for (path, name) in [(&target, "local.txt"), (&self.seed, "remote.txt")] {
            fs::write(path.join(name), "change\n").unwrap();
            git(path, &["add", "."]);
            git(path, &["commit", "-m", name]);
        }
        git(&self.seed, &["push", "origin", "main"]);
        git(
            &self.bare,
            &["worktree", "remove", target.to_str().unwrap()],
        );
        git(&self.bare, &["fetch", "origin"]);
        (self.rev("main"), self.rev("origin/main"))
    }
    fn diverge(&self, active: bool) -> PathBuf {
        let target = self.seed.parent().unwrap().join("active main");
        git(
            &self.bare,
            &["worktree", "add", target.to_str().unwrap(), "main"],
        );
        for (path, text) in [(&target, "local\n"), (&self.seed, "remote\n")] {
            fs::write(path.join("shared.txt"), text).unwrap();
            git(path, &["add", "."]);
            git(path, &["commit", "-m", "diverge"]);
        }
        git(&self.seed, &["push", "origin", "main"]);
        if !active {
            git(
                &self.bare,
                &["worktree", "remove", target.to_str().unwrap()],
            );
        }
        target
    }
    fn sync(&self, target: &str) -> String {
        let output = Command::new(env!("CARGO_BIN_EXE_komla"))
            .args([
                "git",
                "target",
                "sync",
                "-C",
                self.feature.to_str().unwrap(),
                "--target",
                target,
            ])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    }
    fn advance_origin_main(&self) {
        for name in ["remote-one", "remote-two"] {
            fs::write(self.seed.join(format!("{name}.txt")), "remote\n").unwrap();
            git(&self.seed, &["add", "."]);
            git(&self.seed, &["commit", "-m", name]);
        }
        git(&self.seed, &["push", "origin", "main"]);
        git(&self.bare, &["fetch", "origin"]);
    }
    fn rev(&self, name: &str) -> String {
        git(&self.bare, &["rev-parse", name])
    }
    fn reservation(&self) -> PathBuf {
        self.bare.join("komla-target-reservation")
    }
    fn leave_reservation(&self) {
        git(
            &self.bare,
            &[
                "worktree",
                "add",
                "--no-checkout",
                self.reservation().to_str().unwrap(),
                "main",
            ],
        );
    }
    #[cfg(unix)]
    fn git_shim(&self, body: &str) -> String {
        use std::os::unix::fs::PermissionsExt;
        let bin = self.seed.parent().unwrap().join("bin");
        fs::create_dir_all(&bin).unwrap();
        let real_git = Command::new("sh")
            .args(["-c", "command -v git"])
            .output()
            .unwrap();
        let real_git = String::from_utf8(real_git.stdout).unwrap();
        let shim = bin.join("git");
        fs::write(
            &shim,
            format!(
                "#!/bin/sh\nreal_git='{}'\n{body}\nexec \"$real_git\" \"$@\"\n",
                real_git.trim()
            ),
        )
        .unwrap();
        fs::set_permissions(&shim, fs::Permissions::from_mode(0o755)).unwrap();
        format!(
            "{}:{}",
            bin.display(),
            std::env::var("PATH").unwrap_or_default()
        )
    }
    #[cfg(unix)]
    fn sync_command(&self, path: &str) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_komla"));
        command
            .args([
                "git",
                "target",
                "sync",
                "-C",
                self.feature.to_str().unwrap(),
                "--target",
                "main",
            ])
            .env("PATH", path);
        command
    }
    fn assert_released(&self) {
        assert!(!self.reservation().exists());
        assert!(!git(&self.bare, &["worktree", "list", "--porcelain"])
            .contains("komla-target-reservation"));
        assert!(!self.bare.join("komla-target-operation.lock").exists());
    }
}
// `komla git target` runs on Linux and macOS SSH hosts; on Windows its reservation worktree fails.
#[cfg(unix)]
#[test]
fn merges_once_and_leaves_helper_detached() {
    let repo = Repo::new();
    let merged = repo.run("merge-source");
    assert_eq!(merged["success"], true);
    assert_eq!(merged["message"], "Fast-forwarded main to feature");
    assert_eq!(
        git(&repo.feature, &["rev-list", "--count", "main..HEAD"]),
        "0"
    );
    assert!(repo.run("merge-source")["message"]
        .as_str()
        .unwrap()
        .contains("already up to date"));
    repo.assert_clean_helper();
    assert_eq!(repo.run("push")["success"], true);
    assert_eq!(repo.run("pull")["success"], true);
    repo.assert_clean_helper();
}
#[test]
fn cleans_failed_private_merge_but_preserves_active_worktree_conflicts() {
    for active in [false, true] {
        let repo = Repo::new();
        let target = repo.diverge(active);
        let local = repo.rev("main");
        let result = repo.run("merge-remote");
        assert_eq!(result["success"], false);
        assert!(!repo.bare.join("komla-target-operation.lock").exists());
        if active {
            assert!(result["message"].as_str().unwrap().contains("CONFLICT"));
            assert_eq!(git(&target, &["branch", "--show-current"]), "main");
            assert!(git(&target, &["status", "--porcelain"]).contains("UU shared.txt"));
        } else {
            assert!(result["message"]
                .as_str()
                .unwrap()
                .contains("would conflict in shared.txt"));
            assert_eq!(repo.rev("main"), local);
            repo.assert_clean_helper();
        }
    }
}
// `komla git target` runs on Linux and macOS SSH hosts; on Windows its reservation worktree fails.
#[cfg(unix)]
#[test]
fn moves_the_target_without_a_helper_checkout() {
    let repo = Repo::new();
    assert_eq!(repo.run("merge-source")["success"], true);
    assert_eq!(repo.rev("main"), repo.rev("feature"));
    assert_eq!(repo.run("push")["success"], true);
    assert_eq!(repo.rev("origin/main"), repo.rev("feature"));
    assert!(!repo.helper().exists());
    repo.assert_released();
}
// `komla git target` runs on Linux and macOS SSH hosts; on Windows its reservation worktree fails.
#[cfg(unix)]
#[test]
fn merges_origin_into_a_diverged_target_without_a_checkout() {
    let repo = Repo::new();
    let (local, remote) = repo.diverge_cleanly();
    let result = repo.run("merge-remote");
    assert_eq!(result["success"], true, "{result}");
    assert_eq!(result["message"], "Merged origin/main into main");
    assert_eq!(
        git(&repo.bare, &["rev-list", "--parents", "-n", "1", "main"]),
        format!("{} {local} {remote}", repo.rev("main"))
    );
    assert!(!repo.helper().exists());
    repo.assert_released();
}
#[cfg(unix)]
#[test]
fn merges_in_a_detached_helper_on_git_without_merge_tree_write_tree() {
    let repo = Repo::new();
    let (local, remote) = repo.diverge_cleanly();
    let path = repo.git_shim(
        "if [ \"$1\" = merge-tree ] && [ \"$2\" = --write-tree ]; then echo 'usage: git merge-tree <base-tree> <branch1> <branch2>' >&2; exit 129; fi",
    );
    let result = repo.run_with_path("merge-remote", &path);
    assert_eq!(result["success"], true, "{result}");
    assert_eq!(
        git(&repo.bare, &["rev-list", "--parents", "-n", "1", "main"]),
        format!("{} {local} {remote}", repo.rev("main"))
    );
    assert!(repo.helper().exists());
    repo.assert_clean_helper();
    repo.assert_released();
}
#[cfg(unix)]
#[test]
fn does_not_drop_target_commits_made_while_comparing_it_with_the_source() {
    let repo = Repo::new();
    let marker = repo.seed.parent().unwrap().join("raced");
    let path = repo.git_shim(&format!(
        "if [ \"$1\" = rev-list ] && [ \"$2\" = --left-right ] && [ ! -e '{marker}' ]; then touch '{marker}'; \
         out=$(\"$real_git\" \"$@\"); \
         c=$(\"$real_git\" commit-tree -p refs/heads/main -m race 'refs/heads/main^{{tree}}'); \
         \"$real_git\" update-ref refs/heads/main \"$c\"; printf '%s\\n' \"$out\"; exit 0; fi",
        marker = marker.display()
    ));
    let result = repo.run_with_path("merge-source", &path);
    assert!(marker.exists());
    assert_eq!(result["success"], false, "{result}");
    assert_eq!(
        git(&repo.bare, &["log", "-1", "--format=%s", "main"]),
        "race"
    );
    repo.assert_released();
}
#[test]
fn preserves_dirty_active_target() {
    let repo = Repo::new();
    let target = repo.seed.parent().unwrap().join("active");
    git(
        &repo.bare,
        &["worktree", "add", target.to_str().unwrap(), "main"],
    );
    fs::write(target.join("untracked"), "keep me").unwrap();
    let result = repo.run("merge-source");
    assert_eq!(result["success"], false);
    assert!(result["message"]
        .as_str()
        .unwrap()
        .contains("uncommitted changes"));
    assert_eq!(
        fs::read_to_string(target.join("untracked")).unwrap(),
        "keep me"
    );
}
#[cfg(unix)]
#[test]
fn recovers_dead_lock_without_stealing_live_lock() {
    let repo = Repo::new();
    let lock = repo.bare.join("komla-target-operation.lock");
    fs::create_dir(&lock).unwrap();
    fs::write(lock.join("pid"), "99999999\n").unwrap();
    assert_eq!(repo.run("merge-source")["success"], true);
    repo.assert_clean_helper();
    fs::create_dir(&lock).unwrap();
    fs::write(lock.join("pid"), std::process::id().to_string()).unwrap();
    let result = repo.run("merge-source");
    assert_eq!(result["success"], false);
    assert!(result["message"]
        .as_str()
        .unwrap()
        .contains("Another target branch operation"));
    assert_eq!(
        fs::read_to_string(lock.join("pid")).unwrap(),
        std::process::id().to_string()
    );
}
#[test]
fn rejects_invalid_target_and_action_before_git_changes() {
    let repo = Repo::new();
    for args in [
        vec!["git", "target", "destroy", "--target", "main"],
        vec!["git", "target", "push", "--target", "--all"],
        vec!["git", "target", "sync", "--target", "--all"],
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_komla"))
            .current_dir(&repo.feature)
            .args(args)
            .output()
            .unwrap();
        assert!(!output.status.success());
    }
    assert!(!repo.helper().exists());
}

#[cfg(unix)]
#[test]
fn interrupted_target_operation_cleans_its_helper_and_lock() {
    use std::os::unix::fs::PermissionsExt;
    let repo = Repo::new();
    let root = repo.seed.parent().unwrap();
    let bin = root.join("bin");
    fs::create_dir(&bin).unwrap();
    let real_git = Command::new("sh")
        .args(["-c", "command -v git"])
        .output()
        .unwrap();
    let real_git = String::from_utf8(real_git.stdout).unwrap();
    let marker = root.join("merging");
    let shim = bin.join("git");
    fs::write(&shim, format!("#!/bin/sh\nif [ \"$1\" = fetch ] && [ \"$2\" = origin ]; then touch '{}'; sleep 30; fi\nexec {} \"$@\"\n", marker.display(), real_git.trim())).unwrap();
    fs::set_permissions(&shim, fs::Permissions::from_mode(0o755)).unwrap();
    let child = Command::new(env!("CARGO_BIN_EXE_komla"))
        .args([
            "git",
            "target",
            "merge-source",
            "-C",
            repo.feature.to_str().unwrap(),
        ])
        .env(
            "PATH",
            format!(
                "{}:{}",
                bin.display(),
                std::env::var("PATH").unwrap_or_default()
            ),
        )
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while !marker.exists() && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert!(marker.exists());
    unsafe {
        libc::kill(child.id() as i32, libc::SIGTERM);
    }
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "interruption should report a structured failure"
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["success"], false);
    repo.assert_clean_helper();
}

// `komla git target` runs on Linux and macOS SSH hosts; on Windows its reservation worktree fails.
#[cfg(unix)]
#[test]
fn merges_source_even_when_target_has_not_been_published() {
    let repo = Repo::new();
    git(&repo.feature, &["branch", "unpublished", "main"]);
    let output = Command::new(env!("CARGO_BIN_EXE_komla"))
        .args([
            "git",
            "target",
            "merge-source",
            "-C",
            repo.feature.to_str().unwrap(),
            "--target",
            "unpublished",
        ])
        .output()
        .unwrap();
    assert!(output.status.success());
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["success"], true);
    assert_eq!(
        git(&repo.feature, &["rev-list", "--count", "unpublished..HEAD"]),
        "0"
    );
    repo.assert_clean_helper();
}

#[test]
fn returns_a_structured_push_rejection_without_leaving_the_helper_checked_out() {
    let repo = Repo::new();
    repo.diverge(false);
    let result = repo.run("push");
    assert_eq!(result["success"], false);
    assert_eq!(result["errorCode"], "rejected");
    repo.assert_clean_helper();
}

// `komla git target` runs on Linux and macOS SSH hosts; on Windows its reservation worktree fails.
#[cfg(unix)]
#[test]
fn sync_fast_forwards_a_behind_target_and_names_it() {
    let repo = Repo::new();
    repo.advance_origin_main();
    assert_eq!(repo.sync("main"), "main");
    assert_eq!(repo.rev("main"), repo.rev("origin/main"));
    repo.assert_released();
}

// `komla git target` runs on Linux and macOS SSH hosts; on Windows its reservation worktree fails.
#[cfg(unix)]
#[test]
fn sync_fast_forwards_a_behind_branch_from_the_bare_repository() {
    let repo = Repo::new();
    repo.advance_origin_main();
    let output = Command::new(env!("CARGO_BIN_EXE_komla"))
        .args([
            "git",
            "target",
            "sync",
            "-C",
            repo.bare.to_str().unwrap(),
            "--target",
            "main",
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(String::from_utf8(output.stdout).unwrap().trim(), "main");
    assert_eq!(repo.rev("main"), repo.rev("origin/main"));
    repo.assert_released();
}

#[test]
fn sync_names_a_target_that_matches_origin() {
    let repo = Repo::new();
    assert_eq!(repo.sync("main"), "main");
    repo.assert_released();
}

#[test]
fn sync_keeps_a_target_with_its_own_commits() {
    let repo = Repo::new();
    repo.diverge(false);
    git(&repo.bare, &["fetch", "origin"]);
    let local = repo.rev("main");
    assert_eq!(repo.sync("main"), "main");
    assert_eq!(repo.rev("main"), local);
}

#[test]
fn sync_names_origin_for_a_target_only_origin_has() {
    let repo = Repo::new();
    git(&repo.seed, &["push", "origin", "main:develop"]);
    git(&repo.bare, &["fetch", "origin"]);
    assert_eq!(repo.sync("develop"), "origin/develop");
    assert!(git(&repo.bare, &["branch", "--list", "develop"]).is_empty());
}

#[test]
fn sync_names_origin_without_moving_a_target_another_worktree_has_checked_out() {
    let repo = Repo::new();
    let target = repo.seed.parent().unwrap().join("active main");
    git(
        &repo.bare,
        &["worktree", "add", target.to_str().unwrap(), "main"],
    );
    let local = repo.rev("main");
    repo.advance_origin_main();
    assert_eq!(repo.sync("main"), "origin/main");
    assert_eq!(repo.rev("main"), local);
    assert_eq!(git(&target, &["status", "--porcelain"]), "");
    repo.assert_released();
}

#[test]
fn sync_names_origin_without_moving_a_target_another_worktree_is_rebasing() {
    let repo = Repo::new();
    let root = repo.seed.parent().unwrap();
    fs::write(repo.seed.join("shared.txt"), "main change\n").unwrap();
    git(&repo.seed, &["commit", "-am", "main change"]);
    git(&repo.seed, &["push", "origin", "main"]);
    git(&repo.bare, &["fetch", "origin"]);
    git(
        &repo.bare,
        &["update-ref", "refs/heads/main", "origin/main"],
    );
    let other = root.join("other");
    git(
        &repo.bare,
        &[
            "worktree",
            "add",
            "-b",
            "other",
            other.to_str().unwrap(),
            "main~1",
        ],
    );
    fs::write(other.join("shared.txt"), "other change\n").unwrap();
    git(&other, &["commit", "-am", "other change"]);
    let target = root.join("active main");
    git(
        &repo.bare,
        &["worktree", "add", target.to_str().unwrap(), "main"],
    );
    let rebase = Command::new("git")
        .current_dir(&target)
        .args(["rebase", "other"])
        .output()
        .unwrap();
    assert!(!rebase.status.success());
    let local = repo.rev("main");
    repo.advance_origin_main();
    assert_eq!(repo.sync("main"), "origin/main");
    assert_eq!(repo.rev("main"), local);
    repo.assert_released();
    git(&target, &["rebase", "--abort"]);
    assert_eq!(git(&target, &["rev-parse", "HEAD"]), local);
}

// `komla git target` runs on Linux and macOS SSH hosts; on Windows its reservation worktree fails.
#[cfg(unix)]
#[test]
fn sync_replaces_a_reservation_a_killed_sync_left_behind() {
    let repo = Repo::new();
    repo.leave_reservation();
    repo.advance_origin_main();
    assert_eq!(repo.sync("main"), "main");
    assert_eq!(repo.rev("main"), repo.rev("origin/main"));
    repo.assert_released();
}

// `komla git target` runs on Linux and macOS SSH hosts; on Windows its reservation worktree fails.
#[cfg(unix)]
#[test]
fn target_operations_remove_a_reservation_a_killed_sync_left_behind() {
    let repo = Repo::new();
    repo.leave_reservation();
    repo.advance_origin_main();
    let result = repo.run("pull");
    assert_eq!(result["success"], true, "{result}");
    assert_eq!(repo.rev("main"), repo.rev("origin/main"));
    repo.assert_released();
    repo.assert_clean_helper();
}

#[cfg(unix)]
#[test]
fn interrupted_sync_finishes_moving_the_target_and_releases_it() {
    let repo = Repo::new();
    repo.advance_origin_main();
    let marker = repo.seed.parent().unwrap().join("updating");
    let path = repo.git_shim(&format!(
        "if [ \"$1\" = update-ref ]; then touch '{}'; sleep 1; fi",
        marker.display()
    ));
    let child = repo
        .sync_command(&path)
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while !marker.exists() && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert!(marker.exists());
    unsafe {
        libc::kill(child.id() as i32, libc::SIGTERM);
    }
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    assert_eq!(String::from_utf8(output.stdout).unwrap().trim(), "main");
    assert_eq!(repo.rev("main"), repo.rev("origin/main"));
    assert!(!repo.bare.join("refs/heads/main.lock").exists());
    repo.assert_released();
}

// `komla git target` runs on Linux and macOS SSH hosts; on Windows its reservation worktree fails.
#[cfg(unix)]
#[test]
fn sync_replaces_a_locked_reservation_a_killed_worktree_add_left_behind() {
    for remove_directory in [false, true] {
        let repo = Repo::new();
        repo.leave_reservation();
        git(
            &repo.bare,
            &["worktree", "lock", repo.reservation().to_str().unwrap()],
        );
        if remove_directory {
            fs::remove_dir_all(repo.reservation()).unwrap();
        }
        repo.advance_origin_main();
        assert_eq!(repo.sync("main"), "main");
        assert_eq!(repo.rev("main"), repo.rev("origin/main"));
        repo.assert_released();
    }
}

#[test]
fn sync_removes_a_leftover_reservation_when_the_target_is_current() {
    let repo = Repo::new();
    repo.leave_reservation();
    assert_eq!(repo.sync("main"), "main");
    repo.assert_released();
}

#[cfg(unix)]
#[test]
fn sync_names_a_target_that_gained_its_own_commits_before_the_lock() {
    let repo = Repo::new();
    repo.advance_origin_main();
    let marker = repo.seed.parent().unwrap().join("diverged");
    let path = repo.git_shim(&format!(
        "if [ \"$1\" = rev-parse ] && [ \"$3\" = 'refs/heads/main^{{commit}}' ] && [ ! -e '{marker}' ]; then\n  touch '{marker}'\n  commit=$(\"$real_git\" commit-tree -p refs/heads/main -m local 'refs/heads/main^{{tree}}')\n  \"$real_git\" update-ref refs/heads/main \"$commit\"\nfi",
        marker = marker.display()
    ));
    let output = repo.sync_command(&path).output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(marker.exists());
    assert_eq!(String::from_utf8(output.stdout).unwrap().trim(), "main");
    assert_eq!(
        git(&repo.bare, &["rev-list", "--count", "origin/main..main"]),
        "1"
    );
    repo.assert_released();
}
