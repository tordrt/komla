use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::{mpsc, LazyLock};
use std::time::{Duration, Instant};

use anyhow::{bail, Context};
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[cfg(not(test))]
const GIT_COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
// Long enough for git on a machine still busy with other suites, short of the blocked-git tests' 5s.
#[cfg(test)]
const GIT_COMMAND_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_STATUS_BYTES: usize = 512 * 1024;
// Komla unpacks no more of an SSH listing, so a fingerprint of a larger one would go unused.
const MAX_FILE_LIST_BYTES: usize = 50 * 1024 * 1024;
// The desktop and companion use the same extensions, per-file cap, and estimate.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LineCountPolicy {
    binary_extensions: Vec<String>,
    file_byte_cap: usize,
    estimated_bytes_per_line: u64,
}

static LINE_COUNT_POLICY: LazyLock<LineCountPolicy> = LazyLock::new(|| {
    serde_json::from_str(include_str!(
        "../../../src/shared/git-line-count-policy.json"
    ))
    .expect("valid shared line-count policy")
});
const MAX_GIT_STDERR_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchObservation {
    pub current_branch: String,
    pub target_branch: String,
    pub default_branch: String,
    pub ahead_target_branch: u64,
    pub behind_target_branch: u64,
    pub has_remote: bool,
    pub has_origin_remote: bool,
    pub unpushed_commits: u64,
    pub behind_remote: u64,
    pub target_branch_has_remote: bool,
    pub target_branch_ahead_remote: u64,
    pub target_branch_behind_remote: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositorySnapshot {
    pub status_b64: String,
    pub numstat_b64: String,
    pub status_too_large: bool,
    pub file_list_hash: Option<String>,
    pub branch: BranchObservation,
}

/// Whether a snapshot fingerprints the file list again.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileListFingerprint {
    Compute,
    /// Keeps a fingerprint taken when the list was the same as now.
    Keep(Option<String>),
}

impl RepositorySnapshot {
    pub fn read(working_tree: &Path, target_branch: &str) -> anyhow::Result<Self> {
        Self::read_with_file_list(working_tree, target_branch, FileListFingerprint::Compute)
    }

    pub fn read_with_file_list(
        working_tree: &Path,
        target_branch: &str,
        file_list: FileListFingerprint,
    ) -> anyhow::Result<Self> {
        let (mut status, mut status_too_large) = match git_bytes_bounded(
            working_tree,
            &["status", "--porcelain=v1", "-z", "-uall"],
            MAX_STATUS_BYTES,
        )? {
            Some(status) => (status, false),
            None => (Vec::new(), true),
        };
        let mut numstat = if status_too_large {
            Vec::new()
        } else {
            match git_bytes_bounded(
                working_tree,
                &["diff", "HEAD", "--numstat", "-z"],
                MAX_STATUS_BYTES - status.len(),
            )? {
                Some(numstat) => numstat,
                None => {
                    status_too_large = true;
                    Vec::new()
                }
            }
        };
        if !status_too_large {
            status_too_large = append_untracked_numstat(working_tree, &status, &mut numstat);
        }
        if status_too_large {
            status.clear();
            numstat.clear();
        }

        let current_branch = git_text(working_tree, &["rev-parse", "--abbrev-ref", "HEAD"])?;
        let default_branch = git_text_if_success(
            working_tree,
            &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
        )
        .map(|branch| branch.strip_prefix("origin/").unwrap_or(&branch).to_owned())
        .unwrap_or_else(|| target_branch.to_owned());
        let target = compare_target(working_tree, target_branch);
        let (behind_target_branch, ahead_target_branch) =
            revision_counts(working_tree, &target.target_ref, &current_branch);

        let remote_branch = format!("origin/{current_branch}");
        let has_remote = git_succeeds(working_tree, &["rev-parse", "--verify", &remote_branch]);
        let (behind_remote, unpushed_commits) = if has_remote {
            revision_counts(working_tree, &remote_branch, &current_branch)
        } else {
            (0, 0)
        };
        let has_origin_remote = git_succeeds(working_tree, &["remote", "get-url", "origin"]);
        Ok(Self {
            status_b64: base64::engine::general_purpose::STANDARD.encode(status),
            numstat_b64: base64::engine::general_purpose::STANDARD.encode(numstat),
            status_too_large,
            file_list_hash: match file_list {
                FileListFingerprint::Compute => file_list_hash(working_tree),
                FileListFingerprint::Keep(hash) => hash,
            },
            branch: BranchObservation {
                current_branch,
                target_branch: target_branch.to_owned(),
                default_branch,
                ahead_target_branch,
                behind_target_branch,
                has_remote,
                has_origin_remote,
                unpushed_commits,
                behind_remote,
                target_branch_has_remote: target.has_remote,
                target_branch_ahead_remote: target.ahead_remote,
                target_branch_behind_remote: target.behind_remote,
            },
        })
    }

    pub fn status_bytes(&self) -> anyhow::Result<Vec<u8>> {
        base64::engine::general_purpose::STANDARD
            .decode(&self.status_b64)
            .context("snapshot status is not valid base64")
    }
}

/// Fingerprints the files Komla's file tree lists: tracked and unignored untracked files, then
/// the deleted ones it leaves out. Komla hashes its own listing the same way, so a matching
/// fingerprint tells it the list it has is current.
fn file_list_hash(working_tree: &Path) -> Option<String> {
    let listed = git_bytes_bounded(
        working_tree,
        &[
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
        ],
        MAX_FILE_LIST_BYTES,
    )
    .ok()??;
    let deleted = git_bytes_bounded(
        working_tree,
        &["ls-files", "--deleted", "-z"],
        MAX_FILE_LIST_BYTES,
    )
    .ok()??;
    Some(file_list_fingerprint(&listed, &deleted))
}

/// No path is empty, so the extra NUL between the two NUL-terminated lists marks where the
/// first ends.
pub(crate) fn file_list_fingerprint(listed: &[u8], deleted: &[u8]) -> String {
    let mut hash = Sha256::new();
    hash.update(listed);
    hash.update([0]);
    hash.update(deleted);
    format!("{:x}", hash.finalize())
}

#[derive(Debug)]
pub(super) struct CommandOutput {
    pub(super) status: ExitStatus,
    pub(super) stdout: Vec<u8>,
    pub(super) stderr: Vec<u8>,
    pub(super) stdout_exceeded: bool,
}

struct BoundedRead {
    bytes: Vec<u8>,
    exceeded: bool,
}

pub(super) struct TargetComparison {
    pub(super) target_ref: String,
    pub(super) has_remote: bool,
    pub(super) ahead_remote: u64,
    pub(super) behind_remote: u64,
}

// The ref a workspace is compared against and updated from: origin's target when the local
// one is missing or strictly behind it, otherwise the local target.
pub(super) fn compare_target(working_tree: &Path, target_branch: &str) -> TargetComparison {
    let local_target_exists = git_succeeds(working_tree, &["rev-parse", "--verify", target_branch]);
    let remote_target = format!("origin/{target_branch}");
    let has_remote = git_succeeds(working_tree, &["rev-parse", "--verify", &remote_target]);
    let mut target_ref = if local_target_exists {
        target_branch.to_owned()
    } else if has_remote {
        remote_target.clone()
    } else {
        target_branch.to_owned()
    };
    let (behind_remote, ahead_remote) = if has_remote && target_ref != remote_target {
        revision_counts(working_tree, &remote_target, &target_ref)
    } else {
        (0, 0)
    };
    if ahead_remote == 0 && behind_remote > 0 {
        target_ref = remote_target;
    }
    TargetComparison {
        target_ref,
        has_remote,
        ahead_remote,
        behind_remote,
    }
}

fn read_bounded(mut reader: impl Read, limit: usize) -> std::io::Result<BoundedRead> {
    let mut bytes = Vec::with_capacity(limit.min(8 * 1024));
    let mut exceeded = false;
    let mut buffer = [0_u8; 8 * 1024];
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        let retained = count.min(limit.saturating_sub(bytes.len()));
        bytes.extend_from_slice(&buffer[..retained]);
        exceeded |= retained < count;
    }
    Ok(BoundedRead { bytes, exceeded })
}

fn git_output(working_tree: &Path, args: &[&str]) -> anyhow::Result<CommandOutput> {
    git_output_bounded(working_tree, args, MAX_STATUS_BYTES)
}

fn git_output_bounded(
    working_tree: &Path,
    args: &[&str],
    stdout_limit: usize,
) -> anyhow::Result<CommandOutput> {
    let mut command = Command::new("git");
    command
        .arg("--no-optional-locks")
        .args(args)
        .current_dir(working_tree);
    command_output_with_deadline(&mut command, GIT_COMMAND_TIMEOUT, stdout_limit)
        .with_context(|| format!("could not run git {}", args.join(" ")))
}

pub(super) fn command_output_with_deadline(
    command: &mut Command,
    timeout: Duration,
    stdout_limit: usize,
) -> anyhow::Result<CommandOutput> {
    command_output_cancellable(command, timeout, stdout_limit, || false)
}

pub(super) fn command_output_cancellable(
    command: &mut Command,
    timeout: Duration,
    stdout_limit: usize,
    cancelled: impl Fn() -> bool,
) -> anyhow::Result<CommandOutput> {
    if cancelled() {
        bail!("command interrupted");
    }
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    configure_process_tree(command);
    let mut child = command.spawn().context("could not start command")?;
    let mut stdout = child
        .stdout
        .take()
        .context("command stdout was unavailable")?;
    let mut stderr = child
        .stderr
        .take()
        .context("command stderr was unavailable")?;
    let (stdout_sender, stdout_receiver) = mpsc::sync_channel(1);
    let (stderr_sender, stderr_receiver) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let _ = stdout_sender.send(read_bounded(&mut stdout, stdout_limit));
    });
    std::thread::spawn(move || {
        let _ = stderr_sender.send(read_bounded(&mut stderr, MAX_GIT_STDERR_BYTES));
    });
    let deadline = Instant::now() + timeout;
    let mut status = None;
    let mut stdout_result = None;
    let mut stderr_result = None;
    loop {
        if cancelled() {
            terminate_process_tree(&mut child);
            bail!("command interrupted");
        }
        if status.is_none() {
            match child.try_wait() {
                Ok(result) => status = result,
                Err(error) => {
                    terminate_process_tree(&mut child);
                    return Err(error).context("could not wait for command");
                }
            }
        }
        if stdout_result.is_none() {
            stdout_result = stdout_receiver.try_recv().ok();
        }
        if stderr_result.is_none() {
            stderr_result = stderr_receiver.try_recv().ok();
        }
        if let Some(status) = status {
            if stdout_result.is_some() && stderr_result.is_some() {
                let stdout = stdout_result.take().expect("stdout result exists")?;
                let stderr = stderr_result.take().expect("stderr result exists")?;
                return Ok(CommandOutput {
                    status,
                    stdout: stdout.bytes,
                    stderr: stderr.bytes,
                    stdout_exceeded: stdout.exceeded,
                });
            }
        }
        if Instant::now() >= deadline {
            terminate_process_tree(&mut child);
            anyhow::bail!("command exceeded {} ms deadline", timeout.as_millis());
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(unix)]
fn configure_process_tree(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
}

#[cfg(windows)]
fn configure_process_tree(_command: &mut Command) {}

fn terminate_process_tree(child: &mut Child) {
    #[cfg(unix)]
    unsafe {
        // The child is placed in its own process group before spawn, so a
        // negative PID terminates Git and helpers such as core.fsmonitor.
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    #[cfg(windows)]
    {
        // taskkill /T is the native process-tree primitive. child.kill below
        // remains the fallback if taskkill itself is unavailable.
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn git_bytes(working_tree: &Path, args: &[&str]) -> anyhow::Result<Vec<u8>> {
    git_bytes_bounded(working_tree, args, MAX_STATUS_BYTES)?.with_context(|| {
        format!(
            "git {} output exceeded {} bytes",
            args.join(" "),
            MAX_STATUS_BYTES
        )
    })
}

fn git_bytes_bounded(
    working_tree: &Path,
    args: &[&str],
    stdout_limit: usize,
) -> anyhow::Result<Option<Vec<u8>>> {
    let output = git_output_bounded(working_tree, args, stdout_limit)?;
    if !output.status.success() {
        bail!(
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    if output.stdout_exceeded {
        return Ok(None);
    }
    Ok(Some(output.stdout))
}

fn git_text(working_tree: &Path, args: &[&str]) -> anyhow::Result<String> {
    Ok(String::from_utf8(git_bytes(working_tree, args)?)
        .context("git returned non-UTF-8 text")?
        .trim()
        .to_owned())
}

fn git_text_if_success(working_tree: &Path, args: &[&str]) -> Option<String> {
    let output = git_output(working_tree, args).ok()?;
    if !output.status.success() || output.stdout_exceeded {
        return None;
    }
    String::from_utf8(output.stdout)
        .ok()
        .map(|value| value.trim().to_owned())
}

fn git_succeeds(working_tree: &Path, args: &[&str]) -> bool {
    git_output(working_tree, args)
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn revision_counts(working_tree: &Path, left: &str, right: &str) -> (u64, u64) {
    let range = format!("{left}...{right}");
    let Ok(value) = git_text(
        working_tree,
        &["rev-list", "--left-right", "--count", &range],
    ) else {
        return (0, 0);
    };
    let mut values = value.split_whitespace();
    let left_count = values
        .next()
        .and_then(|item| item.parse().ok())
        .unwrap_or(0);
    let right_count = values
        .next()
        .and_then(|item| item.parse().ok())
        .unwrap_or(0);
    (left_count, right_count)
}

fn append_untracked_numstat(working_tree: &Path, status: &[u8], numstat: &mut Vec<u8>) -> bool {
    for entry in status.split(|byte| *byte == 0) {
        let Some(path) = entry.strip_prefix(b"?? ") else {
            continue;
        };
        let relative = PathBuf::from(String::from_utf8_lossy(path).as_ref());
        let full_path = working_tree.join(&relative);
        let Ok(metadata) = std::fs::symlink_metadata(&full_path) else {
            continue;
        };
        if metadata.file_type().is_symlink() {
            numstat.extend_from_slice(b"1\t0\t");
            numstat.extend_from_slice(path);
            numstat.push(0);
            if status.len().saturating_add(numstat.len()) > MAX_STATUS_BYTES {
                return true;
            }
            continue;
        }
        if !metadata.file_type().is_file() {
            continue;
        }
        let lower = relative.to_string_lossy().to_lowercase();
        if LINE_COUNT_POLICY
            .binary_extensions
            .iter()
            .any(|ext| lower.ends_with(ext))
        {
            // An explicit binary entry avoids marking this as a missing count.
            numstat.extend_from_slice(b"-\t-\t");
        } else {
            let cap = LINE_COUNT_POLICY.file_byte_cap;
            let additions = if metadata.len() > cap as u64 {
                metadata
                    .len()
                    .div_ceil(LINE_COUNT_POLICY.estimated_bytes_per_line)
            } else {
                let Ok(file) = std::fs::File::open(full_path) else {
                    continue;
                };
                let mut contents = Vec::new();
                if file
                    .take(cap.saturating_add(1) as u64)
                    .read_to_end(&mut contents)
                    .is_err()
                {
                    continue;
                }
                // A file may grow after stat; keep the read bounded in that case too.
                if contents.len() > cap {
                    let size = std::fs::metadata(working_tree.join(&relative))
                        .map(|value| value.len())
                        .unwrap_or(contents.len() as u64);
                    size.div_ceil(LINE_COUNT_POLICY.estimated_bytes_per_line)
                } else {
                    contents.iter().filter(|byte| **byte == b'\n').count() as u64
                        + u64::from(!contents.is_empty() && !contents.ends_with(b"\n"))
                }
            };
            numstat.extend_from_slice(additions.to_string().as_bytes());
            numstat.extend_from_slice(b"\t0\t");
        }
        numstat.extend_from_slice(path);
        numstat.push(0);
        if status.len().saturating_add(numstat.len()) > MAX_STATUS_BYTES {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    #[test]
    fn fingerprints_a_file_list_as_komla_does() {
        // Komla's tests check its own listing against this value.
        assert_eq!(
            super::file_list_fingerprint(b"src/app.ts\0notes.txt\0", b"src/app.ts\0"),
            "5e9250789ab8a815b3dcecd74f1f91dc7c84bda1d8ad05780909a8e60c779343"
        );
    }

    #[test]
    fn untracked_counts_follow_local_file_rules() {
        let directory = tempfile::tempdir().unwrap();
        let cap = 10 * 1024 * 1024;
        // Each file fits the local cap; their combined size must not affect counts.
        std::fs::write(directory.path().join("first.txt"), vec![b'\n'; cap]).unwrap();
        std::fs::write(directory.path().join("second.txt"), b"a\nb").unwrap();
        std::fs::write(directory.path().join("empty.txt"), b"").unwrap();
        // Known binary extensions are skipped even when their bytes look like text.
        std::fs::write(directory.path().join("image.PNG"), b"text\n").unwrap();
        let huge = std::fs::File::create(directory.path().join("huge.txt")).unwrap();
        huge.set_len((cap + 1) as u64).unwrap();
        let status = b"?? first.txt\0?? second.txt\0?? empty.txt\0?? image.PNG\0?? huge.txt\0";
        let mut numstat = Vec::new();
        assert!(!super::append_untracked_numstat(
            directory.path(),
            status,
            &mut numstat
        ));
        let output = String::from_utf8(numstat).unwrap();
        assert!(output.contains(&format!("{cap}\t0\tfirst.txt\0")));
        assert!(output.contains("2\t0\tsecond.txt\0"));
        assert!(output.contains("0\t0\tempty.txt\0"));
        assert!(output.contains("-\t-\timage.PNG\0"));
        assert!(output.contains(&format!("{}\t0\thuge.txt\0", (cap + 1).div_ceil(80))));
    }

    #[cfg(unix)]
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    #[cfg(unix)]
    use std::process::Command;
    #[cfg(unix)]
    use std::time::{Duration, Instant};

    #[cfg(unix)]
    use tempfile::tempdir;

    #[cfg(unix)]
    use super::{command_output_with_deadline, RepositorySnapshot};

    #[cfg(unix)]
    #[test]
    fn command_output_discards_bytes_beyond_its_capture_limit() {
        let mut command = Command::new("sh");
        command.args(["-c", "head -c 4096 /dev/zero"]);

        let output = command_output_with_deadline(&mut command, Duration::from_secs(1), 32)
            .expect("bounded command should complete");

        assert!(output.status.success());
        assert_eq!(output.stdout.len(), 32);
        assert!(output.stdout_exceeded);
    }

    #[cfg(unix)]
    #[test]
    fn command_timeout_terminates_descendants_that_hold_output_pipes() {
        let temp = tempdir().unwrap();
        let pid_file = temp.path().join("descendant.pid");
        let mut command = Command::new("sh");
        command.args([
            "-c",
            &format!(
                "sleep 30 & descendant=$!; printf '%s' \"$descendant\" > '{}'; wait",
                pid_file.display()
            ),
        ]);

        let started = Instant::now();
        // Long enough for a busy machine to start sh and write the pid file first.
        let error =
            command_output_with_deadline(&mut command, Duration::from_secs(1), 32).unwrap_err();
        let descendant_pid = fs::read_to_string(pid_file)
            .unwrap()
            .trim()
            .parse::<i32>()
            .unwrap();
        let mut still_running = true;
        for _ in 0..100 {
            still_running = unsafe { libc::kill(descendant_pid, 0) == 0 };
            if !still_running {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }

        assert!(error.to_string().contains("deadline"));
        assert!(!still_running, "timed-out descendant was left running");
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[cfg(unix)]
    #[test]
    fn command_deadline_still_applies_after_the_direct_child_exits() {
        let mut command = Command::new("sh");
        command.args(["-c", "sleep 2 &"]);

        let started = Instant::now();
        let error =
            command_output_with_deadline(&mut command, Duration::from_millis(100), 32).unwrap_err();

        assert!(error.to_string().contains("deadline"));
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "output draining escaped the command deadline"
        );
    }

    #[cfg(unix)]
    #[test]
    fn repository_snapshot_fails_within_a_deadline_when_git_blocks() {
        let temp = tempdir().unwrap();
        let repository = temp.path().join("repository");
        fs::create_dir(&repository).unwrap();
        assert!(Command::new("git")
            .arg("init")
            .current_dir(&repository)
            .status()
            .unwrap()
            .success());
        let hook = temp.path().join("fsmonitor.sh");
        fs::write(&hook, "#!/bin/sh\nsleep 10\nprintf '2\\n'\n").unwrap();
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o700)).unwrap();
        assert!(Command::new("git")
            .args(["config", "core.fsmonitor", hook.to_str().unwrap()])
            .current_dir(&repository)
            .status()
            .unwrap()
            .success());

        let started = Instant::now();
        let result = RepositorySnapshot::read(&repository, "main");

        assert!(result.is_err());
        assert!(started.elapsed() < Duration::from_secs(5));
    }
}
