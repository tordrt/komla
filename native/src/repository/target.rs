use super::snapshot::{command_output_cancellable, compare_target};
use anyhow::{bail, Context};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
static INTERRUPTED: AtomicBool = AtomicBool::new(false);

#[cfg(unix)]
extern "C" fn interrupt(_signal: libc::c_int) {
    INTERRUPTED.store(true, Ordering::SeqCst);
}

#[cfg(unix)]
struct TargetSignals(Vec<(libc::c_int, libc::sighandler_t)>);
#[cfg(unix)]
impl TargetSignals {
    fn install() -> anyhow::Result<Self> {
        INTERRUPTED.store(false, Ordering::SeqCst);
        let mut signals = Self(Vec::new());
        for signal in [libc::SIGHUP, libc::SIGINT, libc::SIGTERM] {
            let previous =
                unsafe { libc::signal(signal, interrupt as *const () as libc::sighandler_t) };
            if previous == libc::SIG_ERR {
                return Err(std::io::Error::last_os_error().into());
            }
            signals.0.push((signal, previous));
        }
        Ok(signals)
    }
}
#[cfg(unix)]
impl Drop for TargetSignals {
    fn drop(&mut self) {
        for (signal, previous) in &self.0 {
            unsafe {
                libc::signal(*signal, *previous);
            }
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum TargetAction {
    Push,
    Pull,
    MergeRemote,
    MergeSource,
}
impl TargetAction {
    pub fn parse(value: &str) -> anyhow::Result<Self> {
        match value {
            "push" => Ok(Self::Push),
            "pull" => Ok(Self::Pull),
            "merge-remote" => Ok(Self::MergeRemote),
            "merge-source" => Ok(Self::MergeSource),
            _ => bail!("unknown target operation: {value}"),
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetResult {
    pub success: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<&'static str>,
}
impl TargetResult {
    fn success(message: String) -> Self {
        Self {
            success: true,
            message,
            error_code: None,
        }
    }
}
fn git(cwd: &Path, args: &[&str]) -> anyhow::Result<String> {
    run_git(cwd, args, || INTERRUPTED.load(Ordering::SeqCst))
}
// Git killed while it adds a worktree or updates a ref leaves a lock behind that keeps blocking
// the target, so these commands finish even when the operation is interrupted.
fn git_to_completion(cwd: &Path, args: &[&str]) -> anyhow::Result<String> {
    run_git(cwd, args, || false)
}
fn run_git(cwd: &Path, args: &[&str], cancelled: impl Fn() -> bool) -> anyhow::Result<String> {
    let output = command_output_cancellable(
        Command::new("git").current_dir(cwd).args(args),
        Duration::from_secs(120),
        1024 * 1024,
        cancelled,
    )?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !output.status.success() {
        bail!("{}{}", stdout, stderr);
    }
    if output.stdout_exceeded {
        bail!("Git output exceeded the limit");
    }
    Ok(stdout.trim().to_owned())
}
fn path_text(path: &Path) -> anyhow::Result<&str> {
    path.to_str().context("Git path is not UTF-8")
}
fn check_target(cwd: &Path, target: &str) -> anyhow::Result<()> {
    if target.starts_with('-')
        || git(cwd, &["check-ref-format", &format!("refs/heads/{target}")]).is_err()
    {
        bail!("Invalid target branch: {target}");
    }
    Ok(())
}
fn common_dir(cwd: &Path) -> anyhow::Result<PathBuf> {
    let common = PathBuf::from(git(cwd, &["rev-parse", "--git-common-dir"])?);
    Ok(if common.is_absolute() {
        common
    } else {
        cwd.join(common)
    }
    .canonicalize()?)
}
// The worktree without files `sync_target_branch` holds the target with while it moves it.
const RESERVATION: &str = "komla-target-reservation";
fn has_reservation(common: &Path) -> bool {
    common.join(RESERVATION).exists() || common.join("worktrees").join(RESERVATION).exists()
}
// Every target operation removes a reservation a killed sync left behind, which would otherwise
// keep the target checked out. Git may have left it locked, and its directory may be gone.
fn remove_reservation(common: &Path) -> bool {
    if !has_reservation(common) {
        return true;
    }
    let reservation = common.join(RESERVATION);
    let Ok(path) = path_text(&reservation) else {
        return false;
    };
    if git(common, &["worktree", "remove", "-f", "-f", path]).is_ok() {
        return true;
    }
    let _ = git(common, &["worktree", "unlock", path]);
    (!reservation.exists() || fs::remove_dir_all(&reservation).is_ok())
        && git(common, &["worktree", "prune"]).is_ok()
}

// Compatible with older desktop versions using the directory/PID lock. Drop releases
// it on ordinary errors; a killed process is recovered by the next operation.
struct TargetOperation {
    lock: PathBuf,
    private_helper: Option<PathBuf>,
    cleaned: bool,
}
impl TargetOperation {
    fn acquire(common: &Path) -> anyhow::Result<Self> {
        let lock = common.join("komla-target-operation.lock");
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut missing_owner = false;
        loop {
            if INTERRUPTED.load(Ordering::SeqCst) {
                bail!("Target operation interrupted");
            }
            match fs::create_dir(&lock) {
                Ok(()) => {
                    let operation = Self {
                        lock,
                        private_helper: None,
                        cleaned: false,
                    };
                    fs::write(operation.lock.join("pid"), std::process::id().to_string())
                        .context("Could not initialize the target branch operation lock")?;
                    remove_reservation(common);
                    return Ok(operation);
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => {
                    return Err(error).context("Could not acquire target branch operation lock")
                }
            }
            let owner = fs::read_to_string(lock.join("pid")).unwrap_or_default();
            if owner.trim().is_empty() {
                if missing_owner && fs::remove_dir(&lock).is_ok() {
                    continue;
                }
                missing_owner = true;
            } else {
                missing_owner = false;
                if owner
                    .trim()
                    .parse::<u32>()
                    .ok()
                    .is_some_and(process_is_dead)
                    && fs::read_to_string(lock.join("pid")).ok().as_deref() == Some(&owner)
                {
                    let _ = fs::remove_file(lock.join("pid"));
                    if fs::remove_dir(&lock).is_ok() {
                        continue;
                    }
                }
            }
            if Instant::now() >= deadline {
                bail!("Another target branch operation is already running. Wait for it to finish, then try again.");
            }
            std::thread::sleep(Duration::from_secs(1));
        }
    }
    fn cleanup(&mut self) -> bool {
        if self.cleaned {
            return true;
        }
        self.cleaned = true;
        INTERRUPTED.store(false, Ordering::SeqCst);
        let mut ok = true;
        if let Some(helper) = &self.private_helper {
            if helper.join(".git").exists() {
                ok &= detach_helper(helper).is_ok();
            }
        }
        if let Some(common) = self.lock.parent() {
            ok &= remove_reservation(common);
        }
        let owner = fs::read_to_string(self.lock.join("pid")).unwrap_or_default();
        if owner.trim().is_empty() || owner.trim() == std::process::id().to_string() {
            let _ = fs::remove_file(self.lock.join("pid"));
            ok &= fs::remove_dir(&self.lock).is_ok();
        } else {
            ok = false;
        }
        ok
    }
}
impl Drop for TargetOperation {
    fn drop(&mut self) {
        self.cleanup();
    }
}
// Returns the private helper, which only ever has detached HEAD, to a clean state.
// Every step runs even when an earlier one fails.
fn detach_helper(helper: &Path) -> anyhow::Result<()> {
    let _ = git(helper, &["merge", "--abort"]);
    let _ = git(helper, &["rebase", "--abort"]);
    let mut result = Ok(());
    for args in [
        &["reset", "--hard"][..],
        &["clean", "-fd"],
        &["switch", "--detach", "HEAD"],
    ] {
        if let Err(error) = git(helper, args) {
            result = result.and(Err(error));
        }
    }
    result
}
#[cfg(unix)]
fn process_is_dead(pid: u32) -> bool {
    // Invalid/overflowed PIDs must not turn into process-group signals.
    pid > 0
        && pid <= i32::MAX as u32
        && unsafe { libc::kill(pid as i32, 0) } == -1
        && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
}
#[cfg(not(unix))]
fn process_is_dead(_pid: u32) -> bool {
    false
}

pub fn run_target_operation(
    cwd: &Path,
    target: &str,
    action: TargetAction,
) -> anyhow::Result<TargetResult> {
    check_target(cwd, target)?;
    #[cfg(unix)]
    let _signals = TargetSignals::install()?;
    let result = run_locked(cwd, target, action);
    Ok(result.unwrap_or_else(|error| TargetResult {
        success: false,
        message: format!("{error:#}"),
        error_code: None,
    }))
}
// The ref a workspace rebases onto or merges from to get the commits its snapshot
// counts: the target's own name, or origin's when the local target is missing or strictly
// behind it. A behind target is fast-forwarded first when nothing else is using it.
pub fn sync_target_branch(cwd: &Path, target: &str) -> anyhow::Result<String> {
    check_target(cwd, target)?;
    let comparison = compare_target(cwd, target);
    if comparison.ahead_remote > 0 || comparison.behind_remote == 0 {
        let common = common_dir(cwd)?;
        if has_reservation(&common) {
            // Taking the lock removes the reservation a killed sync left behind.
            let _ = TargetOperation::acquire(&common);
        }
        return Ok(comparison.target_ref);
    }
    #[cfg(unix)]
    let _signals = TargetSignals::install()?;
    Ok(match fast_forward_target(cwd, target) {
        Ok(true) => target.to_owned(),
        _ => comparison.target_ref,
    })
}
// Whether the workspace can use the local target: it is up to date with origin's or has
// commits of its own. Holding the target as a worktree without files makes Git refuse while
// another worktree has it checked out, rebasing or bisecting, and blocks new checkouts until the
// compare-and-swap update is done.
fn fast_forward_target(cwd: &Path, target: &str) -> anyhow::Result<bool> {
    let common = common_dir(cwd)?;
    let _operation = TargetOperation::acquire(&common)?;
    let target_ref = format!("refs/heads/{target}");
    let local = git(
        cwd,
        &["rev-parse", "--verify", &format!("{target_ref}^{{commit}}")],
    )?;
    let remote = git(
        cwd,
        &[
            "rev-parse",
            "--verify",
            &format!("refs/remotes/origin/{target}^{{commit}}"),
        ],
    )?;
    // The local target may have gained commits of its own since the unlocked comparison.
    if local == remote || git(cwd, &["rev-list", "--count", &format!("{remote}..{local}")])? != "0"
    {
        return Ok(true);
    }
    move_reserved_target(cwd, &common, target, &local, &remote)
}
// Moves the target from `old` to `new` while the reservation holds it, under the target lock.
// Git refuses the reservation while another worktree has the target checked out, rebasing or
// bisecting, and the compare-and-swap update fails if the target moved meanwhile.
fn move_reserved_target(
    cwd: &Path,
    common: &Path,
    target: &str,
    old: &str,
    new: &str,
) -> anyhow::Result<bool> {
    let reservation = common.join(RESERVATION);
    let reservation = path_text(&reservation)?;
    if git_to_completion(
        cwd,
        &["worktree", "add", "--no-checkout", reservation, target],
    )
    .is_err()
    {
        return Ok(false);
    }
    let target_ref = format!("refs/heads/{target}");
    Ok(git_to_completion(cwd, &["update-ref", &target_ref, new, old]).is_ok())
}
fn commit(cwd: &Path, rev: &str) -> anyhow::Result<String> {
    git(
        cwd,
        &["rev-parse", "--verify", &format!("{rev}^{{commit}}")],
    )
}
fn is_ancestor(cwd: &Path, ancestor: &str, descendant: &str) -> bool {
    git(cwd, &["merge-base", "--is-ancestor", ancestor, descendant]).is_ok()
}
// Merges `other_ref` into a target no worktree has checked out, without checking it out:
// `merge-tree` builds the merge commit. Git before 2.38 has no `merge-tree --write-tree`, so
// there the merge runs in the private helper, which stays on a detached HEAD.
fn merge_unchecked_out(
    cwd: &Path,
    common: &Path,
    target: &str,
    other_ref: &str,
    label: &str,
    operation: &mut TargetOperation,
) -> anyhow::Result<TargetResult> {
    let ours = commit(cwd, &format!("refs/heads/{target}"))?;
    let theirs = commit(cwd, other_ref)?;
    if is_ancestor(cwd, &theirs, &ours) {
        return Ok(TargetResult::success("Already up to date".to_owned()));
    }
    let merged = if is_ancestor(cwd, &ours, &theirs) {
        theirs
    } else {
        let message = format!("Merge remote-tracking branch '{label}'");
        let merged = match git(
            cwd,
            &[
                "merge-tree",
                "--write-tree",
                "--name-only",
                "--no-messages",
                &ours,
                &theirs,
            ],
        ) {
            Ok(tree) => Ok(git(
                cwd,
                &[
                    "commit-tree",
                    &tree,
                    "-p",
                    &ours,
                    "-p",
                    &theirs,
                    "-m",
                    &message,
                ],
            )?),
            Err(error) => {
                // A conflicted merge exits 1 printing the tree, then the conflicted paths.
                let output = format!("{error:#}");
                let mut lines = output.lines();
                if lines.next().is_some_and(|line| {
                    line.len() >= 40 && line.bytes().all(|b| b.is_ascii_hexdigit())
                }) {
                    Err(lines
                        .filter(|line| !line.is_empty())
                        .map(str::to_owned)
                        .collect())
                } else {
                    merge_in_helper(
                        cwd,
                        &common.join("komla-target-helper"),
                        &ours,
                        &theirs,
                        &message,
                        operation,
                    )?
                }
            }
        };
        match merged {
            Ok(merged) => merged,
            Err(files) => {
                return Ok(TargetResult {
                    success: false,
                    message: format!(
                        "Merging {label} into {target} would conflict in {}. {target} was left unchanged; check it out to merge and resolve the conflicts.",
                        files.join(", ")
                    ),
                    error_code: None,
                })
            }
        }
    };
    if !move_reserved_target(cwd, common, target, &ours, &merged)? {
        bail!("Could not update {target}: another worktree started using it");
    }
    Ok(TargetResult::success(format!(
        "Merged {label} into {target}"
    )))
}
// The merge commit, or the conflicted paths.
fn merge_in_helper(
    cwd: &Path,
    helper: &Path,
    ours: &str,
    theirs: &str,
    message: &str,
    operation: &mut TargetOperation,
) -> anyhow::Result<Result<String, Vec<String>>> {
    operation.private_helper = Some(helper.to_path_buf());
    if helper.join(".git").exists() {
        detach_helper(helper)?;
        git(helper, &["switch", "--detach", ours])?;
    } else {
        git(
            cwd,
            &["worktree", "add", "--detach", path_text(helper)?, ours],
        )?;
    }
    if let Err(error) = git(helper, &["merge", "--no-edit", "-m", message, theirs]) {
        let files = git(helper, &["diff", "--name-only", "--diff-filter=U"]).unwrap_or_default();
        if files.is_empty() {
            return Err(error);
        }
        return Ok(Err(files.lines().map(str::to_owned).collect()));
    }
    Ok(Ok(git(helper, &["rev-parse", "HEAD"])?))
}
fn run_locked(cwd: &Path, target: &str, action: TargetAction) -> anyhow::Result<TargetResult> {
    let source = git(cwd, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    if source.is_empty() || source == "HEAD" {
        bail!("No current branch");
    }
    if action == TargetAction::MergeSource && source == target {
        bail!("Already on the target branch");
    }
    let common = common_dir(cwd)?;
    let mut operation = TargetOperation::acquire(&common)?;
    let mut result =
        execute(cwd, target, &source, action, &common, &mut operation).unwrap_or_else(|error| {
            TargetResult {
                success: false,
                message: format!("{error:#}"),
                error_code: None,
            }
        });
    if !operation.cleanup() {
        result
            .message
            .push_str("; warning: Komla could not fully clean up its remote target helper");
    }
    Ok(result)
}
fn execute(
    cwd: &Path,
    target: &str,
    source: &str,
    action: TargetAction,
    common: &Path,
    operation: &mut TargetOperation,
) -> anyhow::Result<TargetResult> {
    let listing = git(cwd, &["worktree", "list", "--porcelain", "-z"])?;
    let mut current = None;
    let mut active = None;
    for field in listing.split('\0') {
        if let Some(path) = field.strip_prefix("worktree ") {
            current = Some(PathBuf::from(path));
        }
        if field == format!("branch refs/heads/{target}") {
            active = current.clone();
        }
    }
    if source == target && action != TargetAction::MergeSource {
        active = Some(cwd.to_path_buf());
    }
    if action != TargetAction::Push {
        git(cwd, &["fetch", "origin", "--prune"])?;
    }
    let target_ref = format!("refs/heads/{target}");
    let remote_ref = format!("refs/remotes/origin/{target}");
    let has_remote = git(cwd, &["rev-parse", "--verify", &remote_ref]).is_ok();
    if git(cwd, &["rev-parse", "--verify", &target_ref]).is_err() {
        if !has_remote {
            bail!("Could not find {target}");
        }
        git(
            cwd,
            &["branch", "--track", target, &format!("origin/{target}")],
        )?;
    }
    if let Some(active) = &active {
        if action != TargetAction::Push
            && !git(active, &["status", "--porcelain", "-uall"])?.is_empty()
        {
            bail!("Cannot sync {target}: uncommitted changes in active workspace");
        }
    }
    if action == TargetAction::Push {
        let ahead = if has_remote {
            git(
                cwd,
                &[
                    "rev-list",
                    "--count",
                    &format!("{remote_ref}..{target_ref}"),
                ],
            )?
        } else {
            "0".to_owned()
        };
        // Pushing the branch by name needs no checkout of it.
        if let Err(error) = git(cwd, &["push", "-u", "origin", target]) {
            let message = format!("{error:#}");
            return Ok(
                if ["non-fast-forward", "fetch first", "[rejected]"]
                    .iter()
                    .any(|text| message.contains(text))
                {
                    TargetResult {
                        success: false,
                        message: "Remote has new commits".to_owned(),
                        error_code: Some("rejected"),
                    }
                } else {
                    TargetResult {
                        success: false,
                        message,
                        error_code: None,
                    }
                },
            );
        }
        return Ok(TargetResult::success(if !has_remote {
            format!("Published {target} to origin")
        } else if ahead == "0" {
            "Already up to date".to_owned()
        } else {
            format!("Pushed {ahead} commit(s) to origin")
        }));
    }
    if action == TargetAction::Pull || action == TargetAction::MergeRemote {
        if !has_remote {
            return Ok(TargetResult::success(format!(
                "{target} has no origin/{target} branch"
            )));
        }
        let Some(active) = &active else {
            return merge_unchecked_out(
                cwd,
                common,
                target,
                &remote_ref,
                &format!("origin/{target}"),
                operation,
            );
        };
        let output = git(active, &["merge", &remote_ref])?;
        return Ok(TargetResult::success(
            if output.contains("Already up to date") {
                "Already up to date".to_owned()
            } else {
                format!("Merged origin/{target} into {target}")
            },
        ));
    }
    // Compare and move the same commits, so the move fails if either branch changes in between.
    let old = commit(cwd, &target_ref)?;
    let new = commit(cwd, &format!("refs/heads/{source}"))?;
    let counts = git(
        cwd,
        &[
            "rev-list",
            "--left-right",
            "--count",
            &format!("{old}...{new}"),
        ],
    )?;
    let values: Vec<&str> = counts.split_whitespace().collect();
    if values.len() != 2 {
        bail!("Could not compare source and target branches");
    }
    if values[0] != "0" {
        bail!(
            "Branch is {} commit(s) behind {target} - update your branch from {target} first",
            values[0]
        );
    }
    if values[1] == "0" {
        return Ok(TargetResult::success(format!(
            "{target} is already up to date"
        )));
    }
    if let Some(active) = &active {
        git(active, &["merge", "--ff-only", &new])?;
    } else if !move_reserved_target(cwd, common, target, &old, &new)? {
        bail!("Could not fast-forward {target}: it changed, or another worktree started using it");
    }
    Ok(TargetResult::success(format!(
        "Fast-forwarded {target} to {source}"
    )))
}
