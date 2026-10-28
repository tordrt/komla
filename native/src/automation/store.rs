//! Automations and their runs on this host, under `<base>/automations/`.
//!
//! Each automation is `<id>.json`, written whole by the device that saved it.
//! Its runs are `runs/<id>.jsonl`, oldest first, capped at the newest
//! `MAX_RUNS` plus the newest scheduled one, which tells the next tick which
//! scheduled time it handled last.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{bail, Context};

use super::{AutomationRun, HostAutomation, RunTrigger};

const DIRECTORY: &str = "automations";
const RUNS_DIRECTORY: &str = "runs";
const MAX_AUTOMATION_BYTES: u64 = 256 * 1024;
const MAX_RUNS_BYTES: u64 = 4 * 1024 * 1024;
pub(crate) const MAX_RUNS: usize = 50;
/// Held while automations or runs change.
#[cfg(unix)]
const STORE_LOCK: &str = ".lock";
/// Held for a whole tick, so a slow one isn't overlapped by the next minute's.
#[cfg(unix)]
const TICK_LOCK: &str = ".tick.lock";

pub(crate) fn directory(base: &Path) -> PathBuf {
    base.join(DIRECTORY)
}

pub(crate) fn is_automation_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn automation_path(base: &Path, id: &str) -> PathBuf {
    directory(base).join(format!("{id}.json"))
}

fn runs_path(base: &Path, id: &str) -> PathBuf {
    directory(base)
        .join(RUNS_DIRECTORY)
        .join(format!("{id}.jsonl"))
}

fn read_file(path: &Path) -> Option<HostAutomation> {
    if path.extension()? != "json" || fs::metadata(path).ok()?.len() > MAX_AUTOMATION_BYTES {
        return None;
    }
    let automation: HostAutomation = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    let stem = path.file_stem()?.to_str()?;
    (automation.schema == 1 && is_automation_id(&automation.id) && automation.id == stem)
        .then_some(automation)
}

/// Every readable automation on this host, oldest first.
pub(crate) fn read_all(base: &Path) -> Vec<HostAutomation> {
    let mut automations: Vec<HostAutomation> = fs::read_dir(directory(base))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| read_file(&entry.path()))
        .collect();
    automations.sort_by(|a, b| a.created_at.cmp(&b.created_at).then(a.id.cmp(&b.id)));
    automations
}

pub(crate) fn read(base: &Path, id: &str) -> Option<HostAutomation> {
    is_automation_id(id)
        .then(|| read_file(&automation_path(base, id)))
        .flatten()
}

/// Writes `content` to `path` through a private temporary file, so readers never see half of it.
fn write_atomically(path: &Path, content: &[u8]) -> anyhow::Result<()> {
    let parent = path.parent().context("the file has no folder")?;
    fs::create_dir_all(parent).with_context(|| format!("could not create {}", parent.display()))?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .context("the file has no name")?;
    let temporary = parent.join(format!(".{name}.{}.tmp", std::process::id()));
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let written = options
        .open(&temporary)
        .and_then(|mut file| file.write_all(content).and_then(|()| file.sync_all()));
    if let Err(error) = written.and_then(|()| fs::rename(&temporary, path)) {
        let _ = fs::remove_file(&temporary);
        return Err(error).with_context(|| format!("could not write {}", path.display()));
    }
    Ok(())
}

pub(crate) fn write(base: &Path, automation: &HostAutomation) -> anyhow::Result<()> {
    if !is_automation_id(&automation.id) {
        bail!("The automation id {:?} isn't valid.", automation.id);
    }
    let mut content = serde_json::to_vec_pretty(automation)?;
    content.push(b'\n');
    if content.len() as u64 > MAX_AUTOMATION_BYTES {
        bail!("This automation is too large to save. Shorten its prompt.");
    }
    write_atomically(&automation_path(base, &automation.id), &content)
}

/// Removes an automation and its runs; the workspaces its runs started stay.
pub(crate) fn remove(base: &Path, id: &str) -> anyhow::Result<()> {
    if !is_automation_id(id) {
        bail!("The automation id {id:?} isn't valid.");
    }
    for path in [automation_path(base, id), runs_path(base, id)] {
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(error).with_context(|| format!("could not remove {}", path.display()))
            }
        }
    }
    Ok(())
}

/// An automation's runs, oldest first.
pub(crate) fn runs(base: &Path, id: &str) -> Vec<AutomationRun> {
    let path = runs_path(base, id);
    if !is_automation_id(id) || fs::metadata(&path).map_or(true, |meta| meta.len() > MAX_RUNS_BYTES)
    {
        return Vec::new();
    }
    fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .filter_map(|line| serde_json::from_str::<AutomationRun>(line).ok())
        .filter(|run| run.automation_id == id)
        .collect()
}

/// The scheduled time the last scheduled run was for.
pub(crate) fn last_scheduled_for(runs: &[AutomationRun]) -> Option<i64> {
    runs.iter()
        .filter(|run| run.trigger == RunTrigger::Schedule)
        .filter_map(|run| run.scheduled_for)
        .max()
}

/// Appends a run, dropping the oldest beyond `MAX_RUNS` but never the newest
/// scheduled one. A run for an automation deleted meanwhile is dropped.
/// Callers hold the store lock.
pub(crate) fn record_run(base: &Path, run: &AutomationRun) -> anyhow::Result<()> {
    if read(base, &run.automation_id).is_none() {
        return Ok(());
    }
    let mut runs = runs(base, &run.automation_id);
    runs.push(run.clone());
    let newest_scheduled = runs
        .iter()
        .rposition(|run| run.trigger == RunTrigger::Schedule && run.scheduled_for.is_some());
    let excess = runs.len().saturating_sub(MAX_RUNS);
    let kept = runs
        .iter()
        .enumerate()
        .filter(|(index, _)| *index >= excess || Some(*index) == newest_scheduled)
        .map(|(_, run)| serde_json::to_string(run))
        .collect::<Result<Vec<_>, _>>()?;
    let mut content = kept.join("\n");
    content.push('\n');
    write_atomically(&runs_path(base, &run.automation_id), content.as_bytes())
}

/// An exclusive lock on a file under the automations folder, released when dropped.
pub(crate) struct Lock {
    _file: fs::File,
}

#[cfg(unix)]
impl Lock {
    fn open(base: &Path, name: &str) -> anyhow::Result<fs::File> {
        let directory = directory(base);
        fs::create_dir_all(&directory)
            .with_context(|| format!("could not create {}", directory.display()))?;
        let mut options = fs::OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        options
            .open(directory.join(name))
            .context("could not open the automations lock")
    }

    fn try_lock(file: &fs::File) -> bool {
        use std::os::fd::AsRawFd;
        // SAFETY: flock only reads the descriptor, which `file` keeps open.
        unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) == 0 }
    }

    fn wait(file: fs::File, timeout: Duration, busy: &str) -> anyhow::Result<Self> {
        let deadline = std::time::Instant::now() + timeout;
        while !Self::try_lock(&file) {
            if std::time::Instant::now() >= deadline {
                bail!("{busy}");
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        Ok(Self { _file: file })
    }

    /// Waits up to `timeout` for the store lock.
    pub(crate) fn store(base: &Path, timeout: Duration) -> anyhow::Result<Self> {
        Self::wait(
            Self::open(base, STORE_LOCK)?,
            timeout,
            "Another Komla command is changing this host's automations. Try again in a minute.",
        )
    }

    /// The tick lock, or None while another tick holds it.
    pub(crate) fn tick(base: &Path) -> anyhow::Result<Option<Self>> {
        let file = Self::open(base, TICK_LOCK)?;
        Ok(Self::try_lock(&file).then_some(Self { _file: file }))
    }

    /// Waits up to `timeout` for the tick lock, for a run that mustn't start alongside a tick.
    pub(crate) fn tick_waiting(base: &Path, timeout: Duration) -> anyhow::Result<Self> {
        Self::wait(
            Self::open(base, TICK_LOCK)?,
            timeout,
            "This host is busy starting scheduled automations. Try again in a minute.",
        )
    }
}

#[cfg(not(unix))]
impl Lock {
    pub(crate) fn store(_base: &Path, _timeout: Duration) -> anyhow::Result<Self> {
        bail!("Automations run on Linux and macOS hosts.")
    }

    pub(crate) fn tick(_base: &Path) -> anyhow::Result<Option<Self>> {
        bail!("Automations run on Linux and macOS hosts.")
    }

    pub(crate) fn tick_waiting(_base: &Path, _timeout: Duration) -> anyhow::Result<Self> {
        bail!("Automations run on Linux and macOS hosts.")
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::automation;
    use super::super::RunStatus;
    use super::*;

    fn run(
        id: &str,
        trigger: RunTrigger,
        scheduled_for: Option<i64>,
        started_at: i64,
    ) -> AutomationRun {
        AutomationRun {
            id: id.to_owned(),
            automation_id: "auto-1".to_owned(),
            trigger,
            scheduled_for,
            started_at,
            status: RunStatus::Started,
            workspace_id: None,
            branch: None,
            message: None,
        }
    }

    #[test]
    fn writes_reads_and_removes_an_automation_with_its_runs() {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path();
        let saved = automation(base);
        write(base, &saved).unwrap();
        assert_eq!(read(base, "auto-1").unwrap().name, saved.name);
        assert_eq!(read_all(base).len(), 1);

        record_run(base, &run("r1", RunTrigger::Manual, None, 1)).unwrap();
        assert_eq!(runs(base, "auto-1").len(), 1);

        remove(base, "auto-1").unwrap();
        assert!(read(base, "auto-1").is_none());
        assert!(runs(base, "auto-1").is_empty());
        remove(base, "auto-1").unwrap();
    }

    #[test]
    fn ignores_files_whose_id_does_not_match_their_name() {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path();
        write(base, &automation(base)).unwrap();
        fs::rename(
            directory(base).join("auto-1.json"),
            directory(base).join("other.json"),
        )
        .unwrap();
        assert!(read_all(base).is_empty());
    }

    #[test]
    fn keeps_the_newest_runs_and_the_last_scheduled_one() {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path();
        write(base, &automation(base)).unwrap();
        record_run(base, &run("scheduled", RunTrigger::Schedule, Some(5), 5)).unwrap();
        for index in 0..MAX_RUNS + 5 {
            record_run(
                base,
                &run(
                    &format!("manual-{index}"),
                    RunTrigger::Manual,
                    None,
                    10 + index as i64,
                ),
            )
            .unwrap();
        }

        let kept = runs(base, "auto-1");
        assert_eq!(kept.len(), MAX_RUNS + 1);
        assert_eq!(kept[0].id, "scheduled");
        assert_eq!(kept.last().unwrap().id, format!("manual-{}", MAX_RUNS + 4));
        assert_eq!(last_scheduled_for(&kept), Some(5));
    }

    #[test]
    fn drops_runs_of_an_automation_deleted_meanwhile() {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path();
        record_run(base, &run("r1", RunTrigger::Manual, None, 1)).unwrap();
        assert!(!runs_path(base, "auto-1").exists());
    }

    // Automations run on Linux and macOS hosts; store.rs refuses them elsewhere.

    #[cfg(unix)]
    #[test]
    fn lets_one_tick_run_at_a_time() {
        let temp = tempfile::tempdir().unwrap();
        let first = Lock::tick(temp.path()).unwrap();
        assert!(first.is_some());
        assert!(Lock::tick(temp.path()).unwrap().is_none());
        drop(first);
        // A child another test thread forks keeps the lock until it execs.
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while Lock::tick(temp.path()).unwrap().is_none() {
            assert!(
                std::time::Instant::now() < deadline,
                "the tick lock stayed held"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}
