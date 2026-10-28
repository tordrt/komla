//! Automations on an SSH host: agent tasks this host starts on a schedule,
//! with no Komla installation connected.
//!
//! A device saves each automation here (`komla automation save`) with the
//! repository and agent command its runs use, and adds one crontab line that
//! runs `komla automation tick` every minute. A tick starts each due
//! automation in a new workspace like an offline `komla launch` does, and the
//! next device that connects adds that workspace. Every device reads the same
//! automations and runs (`komla automation list`).

mod crontab;
mod schedule;
mod store;

use std::env;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use anyhow::{bail, Context};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::offline_workspace::{
    self, is_valid_branch, CreatedWorkspace, ManifestLaunch, OfflineCaller, OfflineLaunchRequest,
    SessionLauncher, TmuxSessionLauncher, WorkspaceSource,
};
use crontab::{Crontab, SystemCrontab};
use schedule::Due;
use store::Lock;

const USAGE: &str = "usage: komla automation <list|save|enable|disable|delete|run|tick> [arguments]\n\n\
commands:\n  list --json\n    Prints this host's automations, their recent runs, and whether cron can start them.\n  save\n    Saves the automation JSON on stdin and updates Komla's crontab line.\n  enable <id>, disable <id>\n    Turns an automation on or off, keeping the rest of it as this host has it.\n  delete <id>\n    Deletes an automation and its run history; its workspaces stay.\n  run <id> [--json]\n    Starts an automation now in a new workspace.\n  tick\n    Starts the automations that are due. cron runs this every minute.";
const STORE_LOCK_TIMEOUT: Duration = Duration::from_secs(60);
/// How long a manual run waits for a tick that is starting runs. The desktop's
/// timeout for `run` allows for it.
const TICK_WAIT_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_INPUT_BYTES: u64 = 256 * 1024;
const MAX_GRACE_MINUTES: i64 = 7 * 24 * 60;
const MISSED_MESSAGE: &str = "Missed: this host was off or busy past the grace period.";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AutomationSchedule {
    pub(crate) cron: String,
    pub(crate) time_zone: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AutomationProject {
    pub(crate) remote_repo_path: PathBuf,
    pub(crate) remote_project_root: PathBuf,
    pub(crate) git_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) project_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) base_branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) default_branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) branch_prefix: Option<String>,
}

/// An automation as `<base>/automations/<id>.json` holds it. Fields this
/// version doesn't know are kept, so saving here doesn't drop a newer device's.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostAutomation {
    pub(crate) schema: u32,
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) prompt: String,
    pub(crate) enabled: bool,
    pub(crate) schedule: AutomationSchedule,
    pub(crate) missed_run_grace_minutes: i64,
    pub(crate) project: AutomationProject,
    /// The branch runs start from instead of the project's, which stays their target.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) start_branch: Option<String>,
    pub(crate) launch: ManifestLaunch,
    pub(crate) created_at: i64,
    pub(crate) updated_at: i64,
    #[serde(flatten)]
    pub(crate) extra: Map<String, Value>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum RunTrigger {
    Schedule,
    Manual,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum RunStatus {
    Started,
    Failed,
    Skipped,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AutomationRun {
    pub(crate) id: String,
    pub(crate) automation_id: String,
    pub(crate) trigger: RunTrigger,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) scheduled_for: Option<i64>,
    pub(crate) started_at: i64,
    pub(crate) status: RunStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) workspace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) message: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SchedulerStatus {
    pub(crate) available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) message: Option<String>,
}

/// `path` is under `root`, compared as written and, when that fails, with
/// symlinks resolved: the desktop may name the data folder through a symlink
/// this process sees resolved.
pub(crate) fn inside(path: &Path, root: &Path) -> bool {
    let clean = |path: &Path| {
        path.is_absolute()
            && path
                .components()
                .all(|component| matches!(component, Component::RootDir | Component::Normal(_)))
    };
    if !clean(path) || !clean(root) {
        return false;
    }
    if path.starts_with(root) && path != root {
        return true;
    }
    let resolve = |path: &Path| {
        path.ancestors().find_map(|ancestor| {
            let resolved = std::fs::canonicalize(ancestor).ok()?;
            Some(resolved.join(path.strip_prefix(ancestor).ok()?))
        })
    };
    match (resolve(path), resolve(root)) {
        (Some(path), Some(root)) => path.starts_with(&root) && path != root,
        _ => false,
    }
}

/// Refuses an automation this host can't run. Messages are shown to the user as they are.
fn validate(
    base: &Path,
    automation: &HostAutomation,
    require_repository: bool,
) -> anyhow::Result<()> {
    if automation.schema != 1 {
        bail!("This automation was saved by a newer version of Komla. Update Komla to change it.");
    }
    if !store::is_automation_id(&automation.id) {
        bail!("The automation id {:?} isn't valid.", automation.id);
    }
    if automation.name.trim().is_empty() {
        bail!("Give the automation a name.");
    }
    if automation.prompt.trim().is_empty() {
        bail!("Give the automation a prompt.");
    }
    if !(0..=MAX_GRACE_MINUTES).contains(&automation.missed_run_grace_minutes) {
        bail!("The missed-run grace must be between 0 minutes and 7 days.");
    }
    schedule::compile(&automation.schedule)?;
    let launch = &automation.launch;
    if !launch.prompt_command.contains("{{prompt}}") || launch.open_command.trim().is_empty() {
        bail!("This automation's agent can't be started with a prompt.");
    }
    let project = &automation.project;
    if !inside(&project.remote_repo_path, &base.join("repos"))
        || !inside(&project.remote_project_root, &base.join("worktrees"))
    {
        bail!("This automation's project is outside Komla's folder on this host.");
    }
    for branch in [
        &project.base_branch,
        &project.default_branch,
        &automation.start_branch,
    ]
    .into_iter()
    .flatten()
    {
        if !is_valid_branch(branch) {
            bail!("{branch:?} isn't a valid base branch.");
        }
    }
    if require_repository && !project.remote_repo_path.is_dir() {
        bail!("Start one workspace for this project on this host first, so Komla can set up its repository here.");
    }
    Ok(())
}

/// The branch runs target: the project's, else the repository's default.
pub(crate) fn target_branch(project: &AutomationProject) -> String {
    if let Some(branch) = project
        .base_branch
        .as_ref()
        .or(project.default_branch.as_ref())
    {
        return branch.clone();
    }
    offline_workspace::git(&project.remote_repo_path)
        .args(["symbolic-ref", "--quiet", "--short", "HEAD"])
        .stderr(Stdio::null())
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned())
        .filter(|branch| is_valid_branch(branch))
        .unwrap_or_else(|| "main".to_owned())
}

/// Creates the workspace for one run of `automation`, labelled with `at`.
fn create_run_workspace(
    base: &Path,
    automation: &HostAutomation,
    trigger: RunTrigger,
    at_ms: i64,
    caller: &OfflineCaller,
    launcher: &mut dyn SessionLauncher,
    now_ms: i64,
) -> anyhow::Result<CreatedWorkspace> {
    validate(base, automation, true)?;
    let zone = schedule::time_zone(&automation.schedule.time_zone)?;
    let wall = jiff::Timestamp::from_millisecond(at_ms)
        .context("time out of range")?
        .to_zoned(zone);
    let project = &automation.project;
    let mut slug = offline_workspace::slug(&automation.name);
    if slug.is_empty() {
        slug = "automation".to_owned();
    }
    let branch = format!(
        "{}{slug}-{}",
        project.branch_prefix.as_deref().unwrap_or(""),
        wall.strftime("%Y%m%d-%H%M")
    );
    let kind = match trigger {
        RunTrigger::Schedule => "Scheduled run",
        RunTrigger::Manual => "Manual run",
    };
    let request = OfflineLaunchRequest {
        prompt: Some(automation.prompt.clone()),
        name: Some(automation.name.clone()),
        description: Some(format!(
            "{kind} · {} {}",
            wall.strftime("%Y-%m-%d %H:%M"),
            automation.schedule.time_zone
        )),
        branch: Some(branch),
        from_current_branch: false,
        cwd: None,
    };
    // Without a project target, the branch runs start from is their target,
    // as for a workspace branched from it in Komla.
    let base_branch = project
        .base_branch
        .clone()
        .or_else(|| automation.start_branch.clone());
    let target_branch = base_branch
        .clone()
        .unwrap_or_else(|| target_branch(project));
    let source = WorkspaceSource {
        workspace_id: None,
        remote_directory: None,
        base_branch: base_branch.clone(),
        repo_name: project.project_name.clone(),
        remote_repo_path: project.remote_repo_path.clone(),
        remote_project_root: project.remote_project_root.clone(),
        git_url: project.git_url.clone(),
        project_name: project.project_name.clone(),
        backend_base_branch: base_branch,
        default_branch: project.default_branch.clone(),
        start_branch: automation
            .start_branch
            .clone()
            .unwrap_or_else(|| target_branch.clone()),
        target_branch,
        launch: automation.launch.clone(),
    };
    offline_workspace::create_workspace_from(
        caller,
        &source,
        &request,
        launcher,
        u64::try_from(now_ms).unwrap_or_default(),
    )
}

/// Starts one run and returns its record, failed or not.
fn start_run(
    base: &Path,
    automation: &HostAutomation,
    trigger: RunTrigger,
    scheduled_for: Option<i64>,
    caller: &OfflineCaller,
    launcher: &mut dyn SessionLauncher,
    now_ms: i64,
) -> AutomationRun {
    let mut run = AutomationRun {
        id: run_id(now_ms),
        automation_id: automation.id.clone(),
        trigger,
        scheduled_for,
        started_at: now_ms,
        status: RunStatus::Started,
        workspace_id: None,
        branch: None,
        message: None,
    };
    let at = scheduled_for.unwrap_or(now_ms);
    match create_run_workspace(base, automation, trigger, at, caller, launcher, now_ms) {
        Ok(created) => {
            run.workspace_id = Some(created.workspace_id);
            run.branch = Some(created.branch);
        }
        Err(error) => {
            run.status = RunStatus::Failed;
            run.message = Some(format!("{error:#}"));
        }
    }
    run
}

fn run_id(now_ms: i64) -> String {
    offline_workspace::random_uuid().unwrap_or_else(|_| format!("run-{now_ms}"))
}

fn record(base: &Path, run: &AutomationRun) -> anyhow::Result<()> {
    let _lock = Lock::store(base, STORE_LOCK_TIMEOUT)?;
    store::record_run(base, run)
}

/// Starts every due automation once, and records the ones missed past their grace.
fn tick(
    base: &Path,
    caller: &OfflineCaller,
    launcher: &mut dyn SessionLauncher,
    now_ms: i64,
) -> anyhow::Result<Vec<AutomationRun>> {
    let Some(_tick) = Lock::tick(base)? else {
        return Ok(Vec::new());
    };
    let mut recorded = Vec::new();
    for automation in store::read_all(base) {
        if !automation.enabled {
            continue;
        }
        let last = store::last_scheduled_for(&store::runs(base, &automation.id));
        let due = schedule::due(
            true,
            &automation.schedule,
            automation.missed_run_grace_minutes,
            automation.updated_at,
            last,
            now_ms,
        );
        let run = match due {
            // Save refuses these, so only a host that lost its time zone data gets here.
            Err(error) => {
                eprintln!("automation {} can't be scheduled: {error:#}", automation.id);
                continue;
            }
            Ok(Due::None) => continue,
            Ok(Due::Missed(scheduled_for)) => AutomationRun {
                id: run_id(now_ms),
                automation_id: automation.id.clone(),
                trigger: RunTrigger::Schedule,
                scheduled_for: Some(scheduled_for),
                started_at: now_ms,
                status: RunStatus::Skipped,
                workspace_id: None,
                branch: None,
                message: Some(MISSED_MESSAGE.to_owned()),
            },
            Ok(Due::Run(scheduled_for)) => start_run(
                base,
                &automation,
                RunTrigger::Schedule,
                Some(scheduled_for),
                caller,
                launcher,
                now_ms,
            ),
        };
        // One automation's history failing to save mustn't stop the others due now.
        if let Err(error) = record(base, &run) {
            eprintln!("automation {} run not recorded: {error:#}", automation.id);
            continue;
        }
        recorded.push(run);
    }
    Ok(recorded)
}

fn any_enabled(base: &Path) -> bool {
    store::read_all(base)
        .iter()
        .any(|automation| automation.enabled)
}

fn list(base: &Path, crontab: &mut dyn Crontab) -> Value {
    let automations = store::read_all(base);
    let runs: Map<String, Value> = automations
        .iter()
        .map(|automation| {
            let mut runs = store::runs(base, &automation.id);
            runs.reverse();
            (automation.id.clone(), json!(runs))
        })
        .collect();
    let enabled = automations.iter().any(|automation| automation.enabled);
    json!({
        "automations": automations,
        "runs": runs,
        "scheduler": crontab::status(crontab, base, enabled),
    })
}

fn save(
    base: &Path,
    input: &[u8],
    crontab: &mut dyn Crontab,
    executable: &Path,
    now_ms: i64,
) -> anyhow::Result<SchedulerStatus> {
    let mut automation: HostAutomation = serde_json::from_slice(input)
        .map_err(|error| anyhow::anyhow!("That automation isn't valid: {error}"))?;
    validate(base, &automation, true)?;
    let _lock = Lock::store(base, STORE_LOCK_TIMEOUT)?;
    // The host's clock decides which scheduled times come after a change to
    // when it runs. Other changes, such as a new target branch, leave times
    // still due to run.
    automation.updated_at = match store::read(base, &automation.id) {
        Some(previous)
            if previous.schedule == automation.schedule
                && previous.enabled == automation.enabled
                && previous.missed_run_grace_minutes == automation.missed_run_grace_minutes =>
        {
            previous.updated_at
        }
        _ => now_ms,
    };
    store::write(base, &automation)?;
    Ok(crontab::apply(crontab, base, executable, any_enabled(base)))
}

/// Turns an automation on or off as this host has it, so a device's older copy
/// can't undo another's edits. It isn't checked again, so one that can no
/// longer run can still be turned off.
fn set_enabled(
    base: &Path,
    id: &str,
    enabled: bool,
    crontab: &mut dyn Crontab,
    executable: &Path,
    now_ms: i64,
) -> anyhow::Result<(HostAutomation, SchedulerStatus)> {
    let _lock = Lock::store(base, STORE_LOCK_TIMEOUT)?;
    let mut automation =
        store::read(base, id).context("That automation is no longer on this host.")?;
    automation.enabled = enabled;
    // Like a save: times before this change don't run when it's turned back on.
    automation.updated_at = now_ms;
    store::write(base, &automation)?;
    let status = crontab::apply(crontab, base, executable, any_enabled(base));
    Ok((automation, status))
}

fn delete(
    base: &Path,
    id: &str,
    crontab: &mut dyn Crontab,
    executable: &Path,
) -> anyhow::Result<SchedulerStatus> {
    let _lock = Lock::store(base, STORE_LOCK_TIMEOUT)?;
    store::remove(base, id)?;
    Ok(crontab::apply(crontab, base, executable, any_enabled(base)))
}

fn run_now(
    base: &Path,
    id: &str,
    caller: &OfflineCaller,
    launcher: &mut dyn SessionLauncher,
    now_ms: i64,
) -> anyhow::Result<AutomationRun> {
    let automation = store::read(base, id)
        .with_context(|| format!("There's no automation {id} on this host."))?;
    // A tick starting runs at the same minute would pick the same branch name.
    let _tick = Lock::tick_waiting(base, TICK_WAIT_TIMEOUT)?;
    let run = start_run(
        base,
        &automation,
        RunTrigger::Manual,
        None,
        caller,
        launcher,
        now_ms,
    );
    record(base, &run)?;
    Ok(run)
}

/// The shell the user logs in with, from the password database. cron runs
/// commands with `SHELL=/bin/sh`, which would skip the profile that puts agent
/// CLIs on PATH.
#[cfg(unix)]
fn login_shell() -> Option<PathBuf> {
    use std::ffi::CStr;
    use std::os::unix::fs::PermissionsExt;

    let mut buffer = vec![0_u8; 16 * 1024];
    let mut entry: libc::passwd = unsafe { std::mem::zeroed() };
    let mut result: *mut libc::passwd = std::ptr::null_mut();
    // SAFETY: the buffer outlives every pointer getpwuid_r writes into `entry`.
    let status = unsafe {
        libc::getpwuid_r(
            libc::getuid(),
            &mut entry,
            buffer.as_mut_ptr().cast(),
            buffer.len(),
            &mut result,
        )
    };
    if status != 0 || result.is_null() || entry.pw_shell.is_null() {
        return None;
    }
    // SAFETY: getpwuid_r succeeded, so pw_shell points at a C string in `buffer`.
    let shell = unsafe { CStr::from_ptr(entry.pw_shell) }
        .to_str()
        .ok()
        .map(PathBuf::from)?;
    let executable = std::fs::metadata(&shell)
        .is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0);
    executable.then_some(shell)
}

/// The installation whose companion ran here last, as `(key, folder)`. Hooks
/// from a run queue in its inbox until that device's companion delivers them.
fn latest_companion(base: &Path) -> Option<(String, PathBuf)> {
    std::fs::read_dir(base.join("helpers").join("companion"))
        .ok()?
        .flatten()
        .filter_map(|entry| {
            let key = entry.file_name().to_str()?.to_owned();
            let valid =
                !key.is_empty() && key.len() <= 64 && key.bytes().all(|b| b.is_ascii_hexdigit());
            let modified = std::fs::metadata(entry.path().join("current-config"))
                .and_then(|meta| meta.modified())
                .ok()?;
            valid.then(|| (modified, key, entry.path()))
        })
        .max_by_key(|(modified, _, _)| *modified)
        .map(|(_, key, path)| (key, path))
}

/// The routing a run's terminal starts with: what a Komla terminal on this
/// host has, minus what only a connected device knows.
pub(crate) fn host_caller(base: &Path) -> OfflineCaller {
    let helpers = base.join("helpers");
    let path = |path: PathBuf| path.to_string_lossy().into_owned();
    let mut shared_environment = vec![
        ("KOMLA_CLI".to_owned(), path(helpers.join("komla"))),
        (
            "KOMLA_NOTIFY_SCRIPT".to_owned(),
            path(helpers.join("notify.sh")),
        ),
        ("COLORTERM".to_owned(), "truecolor".to_owned()),
        ("FORCE_HYPERLINK".to_owned(), "1".to_owned()),
    ];
    let companion = latest_companion(base);
    if let Some((key, _)) = &companion {
        for name in ["KOMLA_COMPANION_SESSION", "KOMLA_COMPANION_TMUX_SOCKET"] {
            shared_environment.push((name.to_owned(), format!("komla-companion-{key}")));
        }
    }
    OfflineCaller {
        base: base.to_owned(),
        workspace_id: None,
        cwd: base.to_owned(),
        api_url: None,
        companion_inbox: companion
            .as_ref()
            .map(|(_, folder)| path(folder.join("inbox"))),
        installation_key: companion.map(|(key, _)| key),
        target_branch: None,
        shared_environment,
        #[cfg(unix)]
        login_shell: login_shell(),
        #[cfg(not(unix))]
        login_shell: None,
    }
}

/// cron's PATH is `/usr/bin:/bin`, which misses tmux and git where package
/// managers put them.
fn extend_path() {
    let current = env::var_os("PATH").unwrap_or_default();
    let mut paths: Vec<PathBuf> = env::split_paths(&current).collect();
    for extra in ["/usr/local/bin", "/opt/homebrew/bin"] {
        let extra = PathBuf::from(extra);
        if extra.is_dir() && !paths.contains(&extra) {
            paths.push(extra);
        }
    }
    if let Ok(joined) = env::join_paths(paths) {
        env::set_var("PATH", joined);
    }
}

fn now_ms() -> i64 {
    i64::try_from(crate::clock::now_ms()).unwrap_or(i64::MAX)
}

fn read_input(input: &mut dyn Read) -> anyhow::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    input
        .take(MAX_INPUT_BYTES + 1)
        .read_to_end(&mut bytes)
        .context("could not read the automation")?;
    if bytes.len() as u64 > MAX_INPUT_BYTES {
        bail!("This automation is too large to save. Shorten its prompt.");
    }
    Ok(bytes)
}

/// Runs `komla automation <args>`. Needs no Komla installation to be running.
pub(crate) fn command(
    args: &[String],
    base: Option<PathBuf>,
    input: &mut dyn Read,
    output: &mut dyn Write,
) -> anyhow::Result<()> {
    if !cfg!(unix) {
        bail!("Automations run on Linux and macOS hosts.");
    }
    let mut args = args.to_vec();
    let json_output = match args.iter().position(|arg| arg == "--json") {
        Some(index) => {
            args.remove(index);
            true
        }
        None => false,
    };
    let base = base.context("Komla's folder on this host could not be found")?;
    let executable = || -> anyhow::Result<PathBuf> {
        let path = env::current_exe().context("could not find this executable")?;
        Ok(std::fs::canonicalize(&path).unwrap_or(path))
    };
    match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        ["list"] => {
            writeln!(output, "{}", list(&base, &mut SystemCrontab))?;
        }
        ["save"] => {
            let input = read_input(input)?;
            let status = save(&base, &input, &mut SystemCrontab, &executable()?, now_ms())?;
            writeln!(output, "{}", json!({ "scheduler": status }))?;
        }
        [command @ ("enable" | "disable"), id] => {
            let (automation, status) = set_enabled(
                &base,
                id,
                *command == "enable",
                &mut SystemCrontab,
                &executable()?,
                now_ms(),
            )?;
            writeln!(
                output,
                "{}",
                json!({ "automation": automation, "scheduler": status })
            )?;
        }
        ["delete", id] => {
            let status = delete(&base, id, &mut SystemCrontab, &executable()?)?;
            writeln!(output, "{}", json!({ "scheduler": status }))?;
        }
        ["run", id] => {
            extend_path();
            let mut launcher = TmuxSessionLauncher::new(&base);
            let run = run_now(&base, id, &host_caller(&base), &mut launcher, now_ms())?;
            if json_output {
                writeln!(output, "{}", serde_json::to_string(&run)?)?;
            } else if run.status == RunStatus::Started {
                writeln!(
                    output,
                    "Started in a new workspace on branch {}.",
                    run.branch.as_deref().unwrap_or_default()
                )?;
            } else {
                bail!("{}", run.message.unwrap_or_default());
            }
        }
        ["tick"] => {
            extend_path();
            let mut launcher = TmuxSessionLauncher::new(&base);
            tick(&base, &host_caller(&base), &mut launcher, now_ms())?;
        }
        _ => bail!(USAGE),
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use std::fs;
    use std::process::Command;

    use super::crontab::tests::FakeCrontab;
    use super::*;
    use crate::offline_workspace::TerminalSession;

    pub(crate) fn automation(base: &Path) -> HostAutomation {
        HostAutomation {
            schema: 1,
            id: "auto-1".to_owned(),
            name: "Nightly deps".to_owned(),
            prompt: "Update the dependencies, it's Tuesday".to_owned(),
            enabled: true,
            schedule: AutomationSchedule {
                cron: "0 9 * * *".to_owned(),
                time_zone: "Europe/Oslo".to_owned(),
            },
            missed_run_grace_minutes: 720,
            project: AutomationProject {
                remote_repo_path: base.join("repos/app/repo.git"),
                remote_project_root: base.join("worktrees/app"),
                git_url: "git@example.com:app.git".to_owned(),
                project_name: Some("app".to_owned()),
                base_branch: None,
                default_branch: None,
                branch_prefix: Some("devuser/".to_owned()),
            },
            start_branch: None,
            launch: ManifestLaunch {
                agent_name: "Claude Code".to_owned(),
                prompt_command: "claude {{prompt}}".to_owned(),
                open_command: "claude".to_owned(),
                continue_command: None,
            },
            created_at: 1,
            updated_at: 1,
            extra: Map::new(),
        }
    }

    struct RecordingLauncher {
        started: Vec<TerminalSession>,
    }

    impl SessionLauncher for RecordingLauncher {
        fn start(&mut self, session: &TerminalSession) -> anyhow::Result<()> {
            self.started.push(session.clone());
            Ok(())
        }

        fn stop(&mut self, _terminal_id: &str) {}
    }

    fn git(directory: &Path, args: &[&str]) {
        let status = Command::new("git")
            .arg("-C")
            .arg(directory)
            .args(args)
            .env("GIT_AUTHOR_NAME", "Komla")
            .env("GIT_AUTHOR_EMAIL", "komla@example.com")
            .env("GIT_COMMITTER_NAME", "Komla")
            .env("GIT_COMMITTER_EMAIL", "komla@example.com")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?} failed");
    }

    /// A host with a bare clone whose default branch is `trunk`, and a saved automation.
    fn host() -> (tempfile::TempDir, PathBuf, OfflineCaller) {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path().join(".komla");
        let origin = temp.path().join("origin");
        fs::create_dir_all(&origin).unwrap();
        git(&origin, &["init", "--quiet", "--initial-branch", "trunk"]);
        fs::write(origin.join("README.md"), "hello\n").unwrap();
        git(&origin, &["add", "README.md"]);
        git(&origin, &["commit", "--quiet", "-m", "init"]);
        let repo = base.join("repos/app/repo.git");
        fs::create_dir_all(repo.parent().unwrap()).unwrap();
        git(
            temp.path(),
            &[
                "clone",
                "--quiet",
                "--bare",
                origin.to_str().unwrap(),
                repo.to_str().unwrap(),
            ],
        );
        git(
            &repo,
            &[
                "config",
                "remote.origin.fetch",
                "+refs/heads/*:refs/remotes/origin/*",
            ],
        );
        git(&repo, &["fetch", "--quiet", "origin"]);
        store::write(&base, &automation(&base)).unwrap();
        let caller = OfflineCaller {
            base: base.clone(),
            cwd: base.clone(),
            companion_inbox: Some("/inbox".to_owned()),
            installation_key: Some("abc123".to_owned()),
            login_shell: Some(PathBuf::from("/bin/bash")),
            ..OfflineCaller::default()
        };
        (temp, base, caller)
    }

    fn at(iso: &str) -> i64 {
        iso.parse::<jiff::Timestamp>().unwrap().as_millisecond()
    }

    #[test]
    fn a_tick_starts_a_due_automation_once_in_a_new_workspace() {
        let (_temp, base, caller) = host();
        let mut launcher = RecordingLauncher {
            started: Vec::new(),
        };
        let now = at("2026-10-15T07:00:20Z");

        let runs = tick(&base, &caller, &mut launcher, now).unwrap();

        assert_eq!(runs.len(), 1);
        let run = &runs[0];
        assert_eq!(run.status, RunStatus::Started, "{:?}", run.message);
        assert_eq!(run.scheduled_for, Some(at("2026-10-15T07:00:00Z")));
        assert_eq!(
            run.branch.as_deref(),
            Some("devuser/nightly-deps-20261015-0900")
        );
        let session = &launcher.started[0];
        assert_eq!(
            session.command,
            "claude 'Update the dependencies, it'\\''s Tuesday'"
        );
        assert_eq!(session.login_shell.as_deref(), Some(Path::new("/bin/bash")));
        let environment: std::collections::HashMap<_, _> =
            session.environment.iter().cloned().collect();
        assert_eq!(environment["KOMLA_COMPANION_INBOX"], "/inbox");
        assert_eq!(environment["KOMLA_TARGET_BRANCH"], "trunk");
        assert!(!environment.contains_key("KOMLA_API_URL"));

        let workspace_id = run.workspace_id.as_deref().unwrap();
        let manifest: Value = serde_json::from_slice(
            &fs::read(base.join(format!("workspaces/{workspace_id}.json"))).unwrap(),
        )
        .unwrap();
        assert_eq!(manifest["adoptOnConnect"], true);
        assert_eq!(manifest["customName"], "Nightly deps");
        assert_eq!(
            manifest["customDescription"],
            "Scheduled run · 2026-10-15 09:00 Europe/Oslo"
        );
        assert_eq!(manifest["backend"]["startPoint"], "trunk");
        assert!(manifest.get("sourceWorkspaceId").is_none());
        assert!(base
            .join("worktrees/app/devuser-nightly-deps-20261015-0900/README.md")
            .exists());
        assert_eq!(store::runs(&base, "auto-1"), runs);

        let again = tick(&base, &caller, &mut launcher, now + 30_000).unwrap();
        assert!(again.is_empty());
        assert_eq!(launcher.started.len(), 1);
    }

    #[test]
    fn a_tick_records_a_time_missed_past_its_grace() {
        let (_temp, base, caller) = host();
        let mut launcher = RecordingLauncher {
            started: Vec::new(),
        };

        let runs = tick(&base, &caller, &mut launcher, at("2026-10-15T20:00:00Z")).unwrap();

        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].status, RunStatus::Skipped);
        assert!(launcher.started.is_empty());
        assert!(
            tick(&base, &caller, &mut launcher, at("2026-10-15T20:01:00Z"))
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn a_tick_skips_disabled_automations() {
        let (_temp, base, caller) = host();
        let mut disabled = automation(&base);
        disabled.enabled = false;
        store::write(&base, &disabled).unwrap();
        let mut launcher = RecordingLauncher {
            started: Vec::new(),
        };

        let runs = tick(&base, &caller, &mut launcher, at("2026-10-15T07:00:20Z")).unwrap();

        assert!(runs.is_empty());
        assert!(launcher.started.is_empty());
    }

    #[test]
    fn a_run_that_cant_be_recorded_doesnt_stop_the_others() {
        let (_temp, base, caller) = host();
        let mut second = automation(&base);
        second.id = "auto-2".to_owned();
        second.name = "Morning triage".to_owned();
        store::write(&base, &second).unwrap();
        // A folder where auto-1's run history goes makes recording its run fail.
        fs::create_dir_all(store::directory(&base).join("runs/auto-1.jsonl")).unwrap();
        let mut launcher = RecordingLauncher {
            started: Vec::new(),
        };

        let runs = tick(&base, &caller, &mut launcher, at("2026-10-15T07:00:20Z")).unwrap();

        assert_eq!(launcher.started.len(), 2);
        let recorded: Vec<_> = runs.iter().map(|run| run.automation_id.as_str()).collect();
        assert_eq!(recorded, ["auto-2"]);
        assert_eq!(store::runs(&base, "auto-2"), runs);
    }

    #[test]
    fn a_manual_run_waits_for_a_tick_in_progress() {
        let (_temp, base, caller) = host();
        let (locked, wait_for_lock) = std::sync::mpsc::channel();
        let ticking = {
            let base = base.clone();
            std::thread::spawn(move || {
                let _tick = Lock::tick(&base).unwrap().unwrap();
                locked.send(()).unwrap();
                std::thread::sleep(Duration::from_millis(300));
            })
        };
        wait_for_lock.recv().unwrap();
        let mut launcher = RecordingLauncher {
            started: Vec::new(),
        };

        let waited = std::time::Instant::now();
        let run = run_now(
            &base,
            "auto-1",
            &caller,
            &mut launcher,
            at("2026-10-15T07:00:10Z"),
        )
        .unwrap();

        assert!(waited.elapsed() >= Duration::from_millis(250));
        assert_eq!(run.status, RunStatus::Started, "{:?}", run.message);
        ticking.join().unwrap();
    }

    #[test]
    fn a_failed_run_is_recorded_with_its_reason() {
        let (_temp, base, caller) = host();
        fs::remove_dir_all(base.join("repos/app/repo.git")).unwrap();
        let mut launcher = RecordingLauncher {
            started: Vec::new(),
        };

        let run = run_now(
            &base,
            "auto-1",
            &caller,
            &mut launcher,
            at("2026-10-15T10:00:00Z"),
        )
        .unwrap();

        assert_eq!(run.status, RunStatus::Failed);
        assert!(run.message.unwrap().contains("Start one workspace"));
        assert_eq!(store::runs(&base, "auto-1").len(), 1);
    }

    #[test]
    fn a_manual_run_starts_from_the_projects_base_branch() {
        let (_temp, base, caller) = host();
        let mut pinned = automation(&base);
        pinned.project.base_branch = Some("trunk".to_owned());
        pinned.project.branch_prefix = None;
        store::write(&base, &pinned).unwrap();
        let mut launcher = RecordingLauncher {
            started: Vec::new(),
        };

        let run = run_now(
            &base,
            "auto-1",
            &caller,
            &mut launcher,
            at("2026-10-15T10:30:00Z"),
        )
        .unwrap();

        assert_eq!(run.status, RunStatus::Started, "{:?}", run.message);
        assert_eq!(run.trigger, RunTrigger::Manual);
        assert_eq!(run.branch.as_deref(), Some("nightly-deps-20261015-1230"));
        // A manual run doesn't stand in for the next scheduled one.
        assert_eq!(
            store::last_scheduled_for(&store::runs(&base, "auto-1")),
            None
        );
    }

    #[test]
    fn a_run_starts_from_its_own_branch_and_targets_the_projects() {
        let (temp, base, caller) = host();
        let origin = temp.path().join("origin");
        git(&origin, &["checkout", "--quiet", "-b", "release"]);
        fs::write(origin.join("RELEASE.md"), "1.x\n").unwrap();
        git(&origin, &["add", "RELEASE.md"]);
        git(&origin, &["commit", "--quiet", "-m", "release"]);
        let mut pinned = automation(&base);
        pinned.project.base_branch = Some("trunk".to_owned());
        pinned.project.branch_prefix = None;
        pinned.start_branch = Some("release".to_owned());
        store::write(&base, &pinned).unwrap();
        let mut launcher = RecordingLauncher {
            started: Vec::new(),
        };

        let run = run_now(
            &base,
            "auto-1",
            &caller,
            &mut launcher,
            at("2026-10-15T10:30:00Z"),
        )
        .unwrap();

        assert_eq!(run.status, RunStatus::Started, "{:?}", run.message);
        // Fetched from origin when the run starts, so it has what was pushed since the clone.
        assert!(base
            .join("worktrees/app/nightly-deps-20261015-1230/RELEASE.md")
            .exists());
        let manifest: Value = serde_json::from_slice(
            &fs::read(base.join(format!(
                "workspaces/{}.json",
                run.workspace_id.as_deref().unwrap()
            )))
            .unwrap(),
        )
        .unwrap();
        assert_eq!(manifest["backend"]["startPoint"], "release");
        assert_eq!(manifest["backend"]["baseBranch"], "trunk");
        let environment: std::collections::HashMap<_, _> =
            launcher.started[0].environment.iter().cloned().collect();
        assert_eq!(environment["KOMLA_TARGET_BRANCH"], "trunk");
    }

    #[test]
    fn a_run_targets_its_own_branch_when_the_project_has_none() {
        let (temp, base, caller) = host();
        let origin = temp.path().join("origin");
        git(&origin, &["branch", "release"]);
        let mut pinned = automation(&base);
        pinned.start_branch = Some("release".to_owned());
        store::write(&base, &pinned).unwrap();
        let mut launcher = RecordingLauncher {
            started: Vec::new(),
        };

        let run = run_now(
            &base,
            "auto-1",
            &caller,
            &mut launcher,
            at("2026-10-15T10:30:00Z"),
        )
        .unwrap();

        // As for a workspace branched from it in Komla, so diffs and PRs go to it.
        assert_eq!(run.status, RunStatus::Started, "{:?}", run.message);
        let manifest: Value = serde_json::from_slice(
            &fs::read(base.join(format!(
                "workspaces/{}.json",
                run.workspace_id.as_deref().unwrap()
            )))
            .unwrap(),
        )
        .unwrap();
        assert_eq!(manifest["backend"]["baseBranch"], "release");
        let environment: std::collections::HashMap<_, _> =
            launcher.started[0].environment.iter().cloned().collect();
        assert_eq!(environment["KOMLA_TARGET_BRANCH"], "release");
    }

    #[test]
    fn a_save_that_leaves_when_it_runs_doesnt_skip_a_time_still_due() {
        let (_temp, base, caller) = host();
        let mut retargeted = automation(&base);
        retargeted.project.base_branch = Some("trunk".to_owned());
        let mut rescheduled = automation(&base);
        rescheduled.schedule.cron = "0 9 * * 1-5".to_owned();
        let mut launcher = RecordingLauncher {
            started: Vec::new(),
        };
        let save_at = |automation: &HostAutomation, now_ms: i64| {
            save(
                &base,
                &serde_json::to_vec(automation).unwrap(),
                &mut FakeCrontab::with(""),
                Path::new("/x"),
                now_ms,
            )
            .unwrap();
        };

        // A device saves its new target branch just after 09:00, before this host's tick.
        save_at(&retargeted, at("2026-10-15T07:00:05Z"));
        let runs = tick(&base, &caller, &mut launcher, at("2026-10-15T07:00:20Z")).unwrap();
        assert_eq!(runs.len(), 1, "{runs:?}");
        assert_eq!(store::read(&base, "auto-1").unwrap().updated_at, 1);

        // A new schedule still starts from the edit.
        save_at(&rescheduled, at("2026-10-16T07:00:05Z"));
        let runs = tick(&base, &caller, &mut launcher, at("2026-10-16T07:00:20Z")).unwrap();
        assert!(runs.is_empty(), "{runs:?}");
    }

    #[test]
    fn save_writes_the_automation_and_the_crontab_line() {
        let (_temp, base, _caller) = host();
        let mut crontab = FakeCrontab::with("");
        let mut saved = automation(&base);
        saved.id = "auto-2".to_owned();
        saved
            .extra
            .insert("desktop".to_owned(), json!({"presetId": "claude-code"}));
        let input = serde_json::to_vec(&saved).unwrap();

        let status = save(&base, &input, &mut crontab, Path::new("/x/komla"), 42).unwrap();

        assert!(status.available);
        let stored = store::read(&base, "auto-2").unwrap();
        assert_eq!(stored.updated_at, 42);
        assert_eq!(stored.extra["desktop"]["presetId"], "claude-code");
        assert!(crontab
            .contents
            .as_deref()
            .unwrap()
            .contains("'/x/komla' automation tick"));

        delete(&base, "auto-1", &mut crontab, Path::new("/x/komla")).unwrap();
        delete(&base, "auto-2", &mut crontab, Path::new("/x/komla")).unwrap();
        assert_eq!(crontab.contents.as_deref(), Some(""));
    }

    #[test]
    fn turns_off_an_automation_as_the_host_has_it_even_when_it_cant_run() {
        let (_temp, base, _caller) = host();
        let mut stored = automation(&base);
        stored.prompt = "Edited on another device".to_owned();
        stored
            .extra
            .insert("desktop".to_owned(), json!({"presetId": "claude-code"}));
        store::write(&base, &stored).unwrap();
        fs::remove_dir_all(base.join("repos/app/repo.git")).unwrap();
        let executable = Path::new("/x/komla");
        let mut crontab = FakeCrontab::with("");
        crontab::apply(&mut crontab, &base, executable, true);

        let (turned_off, status) =
            set_enabled(&base, "auto-1", false, &mut crontab, executable, 42).unwrap();

        assert!(!turned_off.enabled);
        assert_eq!(turned_off.updated_at, 42);
        assert_eq!(turned_off.prompt, "Edited on another device");
        assert_eq!(store::read(&base, "auto-1").unwrap(), turned_off);
        assert_eq!(turned_off.extra["desktop"]["presetId"], "claude-code");
        assert!(status.available);
        assert_eq!(crontab.contents.as_deref(), Some(""));

        let error = set_enabled(&base, "gone", true, &mut crontab, executable, 43)
            .unwrap_err()
            .to_string();
        assert!(error.contains("no longer on this host"), "{error}");
    }

    #[test]
    fn saves_and_deletes_when_cron_refuses_this_user() {
        let (_temp, base, _caller) = host();
        let mut crontab = FakeCrontab {
            read_error: Some("You (u) are not allowed to use this program (crontab)".to_owned()),
            ..FakeCrontab::default()
        };
        let mut saved = automation(&base);
        saved.id = "auto-2".to_owned();

        let status = save(
            &base,
            &serde_json::to_vec(&saved).unwrap(),
            &mut crontab,
            Path::new("/x"),
            42,
        )
        .unwrap();

        assert!(!status.available);
        assert!(status.message.unwrap().contains("not allowed"));
        assert!(store::read(&base, "auto-2").is_some());
        let status = delete(&base, "auto-2", &mut crontab, Path::new("/x")).unwrap();
        assert!(!status.available);
        assert!(store::read(&base, "auto-2").is_none());
    }

    #[test]
    fn save_refuses_what_this_host_cant_run() {
        let (temp, base, _caller) = host();
        let mut crontab = FakeCrontab::with("");
        let refuse = |change: &dyn Fn(&mut HostAutomation), expected: &str| {
            let mut candidate = automation(&base);
            change(&mut candidate);
            let input = serde_json::to_vec(&candidate).unwrap();
            let error = save(
                &base,
                &input,
                &mut FakeCrontab::with(""),
                Path::new("/x"),
                1,
            )
            .unwrap_err()
            .to_string();
            assert!(error.contains(expected), "{error}");
        };
        refuse(&|a| a.schedule.cron = "61 * * * *".to_owned(), "minute");
        refuse(
            &|a| a.schedule.time_zone = "Mars/Olympus".to_owned(),
            "time zone",
        );
        refuse(&|a| a.launch.prompt_command = "claude".to_owned(), "prompt");
        refuse(
            &|a| a.project.remote_repo_path = PathBuf::from("/etc/../tmp/repo.git"),
            "outside",
        );
        refuse(
            &|a| a.project.remote_repo_path = base.join("repos/missing/repo.git"),
            "Start one workspace",
        );
        refuse(
            &|a| a.project.base_branch = Some("--upload-pack=x".to_owned()),
            "base branch",
        );
        refuse(
            &|a| a.start_branch = Some("--upload-pack=x".to_owned()),
            "base branch",
        );
        let error = save(&base, b"{}", &mut crontab, Path::new("/x"), 1)
            .unwrap_err()
            .to_string();
        assert!(error.contains("isn't valid"), "{error}");
        drop(temp);
    }

    #[test]
    fn list_shows_runs_newest_first() {
        let (_temp, base, caller) = host();
        let mut launcher = RecordingLauncher {
            started: Vec::new(),
        };
        run_now(
            &base,
            "auto-1",
            &caller,
            &mut launcher,
            at("2026-10-15T10:00:00Z"),
        )
        .unwrap();
        run_now(
            &base,
            "auto-1",
            &caller,
            &mut launcher,
            at("2026-10-15T11:00:00Z"),
        )
        .unwrap();

        let listed = list(&base, &mut FakeCrontab::with(""));

        assert_eq!(listed["automations"][0]["id"], "auto-1");
        let runs = listed["runs"]["auto-1"].as_array().unwrap();
        assert_eq!(runs.len(), 2);
        assert!(runs[0]["startedAt"].as_i64() > runs[1]["startedAt"].as_i64());
        assert_eq!(listed["scheduler"]["available"], false);
    }

    #[test]
    fn picks_the_companion_that_connected_last() {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path();
        for key in ["aaaa", "bbbb"] {
            let folder = base.join("helpers/companion").join(key);
            fs::create_dir_all(&folder).unwrap();
            fs::write(folder.join("current-config"), "x").unwrap();
            std::thread::sleep(Duration::from_millis(20));
        }
        fs::create_dir_all(base.join("helpers/companion/not-hex")).unwrap();

        let caller = host_caller(base);

        assert_eq!(caller.installation_key.as_deref(), Some("bbbb"));
        assert!(caller
            .companion_inbox
            .unwrap()
            .ends_with("companion/bbbb/inbox"));
    }

    #[test]
    fn compares_paths_inside_the_data_folder_through_symlinks() {
        let temp = tempfile::tempdir().unwrap();
        let real = temp.path().join("real");
        fs::create_dir_all(real.join("repos/app")).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&real, temp.path().join("link")).unwrap();
        let canonical = fs::canonicalize(&real).unwrap();
        assert!(inside(
            &temp.path().join("link/repos/app/repo.git"),
            &canonical.join("repos")
        ));
        assert!(!inside(
            &temp.path().join("link/other"),
            &canonical.join("repos")
        ));
        assert!(!inside(Path::new("/etc/../x"), Path::new("/etc")));
    }
}
