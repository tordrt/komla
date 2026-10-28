//! The one crontab line that runs `komla automation tick` every minute.
//!
//! The line runs the versioned executable that saved it, so an older Komla on
//! another device re-pointing `helpers/komla` can't swap in a CLI without
//! automations. It is found by its trailing marker, which names this data
//! folder, and every other line is left byte for byte.

use std::io::{ErrorKind, Write};
use std::path::Path;
use std::process::{Command, Stdio};

use anyhow::{bail, Context};

use super::SchedulerStatus;
use crate::offline_workspace::shell_quote;

const MARKER: &str = "# komla-automations";

pub(crate) trait Crontab {
    /// The current crontab, empty when there is none, or None when `crontab` isn't installed.
    fn read(&mut self) -> anyhow::Result<Option<String>>;
    fn write(&mut self, contents: &str) -> anyhow::Result<()>;
    /// Whether a cron service is running, when that can be told.
    fn service_running(&self) -> Option<bool>;
}

pub(crate) struct SystemCrontab;

impl Crontab for SystemCrontab {
    fn read(&mut self) -> anyhow::Result<Option<String>> {
        let output = match Command::new("crontab")
            .arg("-l")
            .stdin(Stdio::null())
            .output()
        {
            Ok(output) => output,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error).context("could not run crontab"),
        };
        if output.status.success() {
            return Ok(Some(String::from_utf8_lossy(&output.stdout).into_owned()));
        }
        let stderr = String::from_utf8_lossy(&output.stderr);
        let lower = stderr.to_ascii_lowercase();
        // cron and cronie say "no crontab for <user>"; BusyBox can't open the missing file.
        if lower.contains("no crontab") || lower.contains("can't open") {
            return Ok(Some(String::new()));
        }
        bail!("Couldn't read this host's crontab: {}", stderr.trim())
    }

    fn write(&mut self, contents: &str) -> anyhow::Result<()> {
        let mut child = Command::new("crontab")
            .arg("-")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .context("could not run crontab")?;
        child
            .stdin
            .take()
            .context("could not write to crontab")?
            .write_all(contents.as_bytes())
            .context("could not write to crontab")?;
        let output = child.wait_with_output().context("could not run crontab")?;
        if !output.status.success() {
            bail!(
                "Couldn't update this host's crontab: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        Ok(())
    }

    fn service_running(&self) -> Option<bool> {
        cron_service_running()
    }
}

/// Looks for a cron daemon among the host's processes. Hosts that hide other
/// users' processes, and systems without /proc, can't tell.
#[cfg(target_os = "linux")]
fn cron_service_running() -> Option<bool> {
    // systemd-cron turns crontabs into timers, with no daemon to find.
    if [
        "/lib/systemd/system/cron.target",
        "/usr/lib/systemd/system/cron.target",
    ]
    .iter()
    .any(|path| Path::new(path).exists())
    {
        return Some(true);
    }
    std::fs::read_to_string("/proc/1/comm").ok()?;
    let found = std::fs::read_dir("/proc").ok()?.flatten().any(|entry| {
        std::fs::read_to_string(entry.path().join("comm")).is_ok_and(|comm| {
            matches!(
                comm.trim(),
                "cron" | "crond" | "cronie" | "fcron" | "dcron" | "busybox-crond"
            )
        })
    });
    Some(found)
}

#[cfg(not(target_os = "linux"))]
fn cron_service_running() -> Option<bool> {
    None
}

/// cron reads `%` as a newline.
fn escape_percent(text: &str) -> String {
    text.replace('%', "\\%")
}

fn marker(base: &Path) -> String {
    escape_percent(&format!("{MARKER} {}", base.display()))
}

pub(crate) fn schedule_line(base: &Path, executable: &Path) -> String {
    escape_percent(&format!(
        "* * * * * KOMLA_DATA_DIR={} {} automation tick >/dev/null 2>&1 {MARKER} {}",
        shell_quote(&base.to_string_lossy()),
        shell_quote(&executable.to_string_lossy()),
        base.display()
    ))
}

fn is_ours(line: &str, marker: &str) -> bool {
    line.trim_end()
        .strip_suffix(marker)
        .is_some_and(|rest| rest.ends_with(char::is_whitespace))
}

/// The crontab with this data folder's line replaced by `line`, or removed.
fn rewrite(contents: &str, base: &Path, line: Option<&str>) -> String {
    let marker = marker(base);
    let mut kept: String = contents
        .split_inclusive('\n')
        .filter(|existing| !is_ours(existing, &marker))
        .collect();
    if let Some(line) = line {
        if !kept.is_empty() && !kept.ends_with('\n') {
            kept.push('\n');
        }
        kept.push_str(line);
        kept.push('\n');
    }
    kept
}

fn unavailable(message: &str) -> SchedulerStatus {
    SchedulerStatus {
        available: false,
        message: Some(message.to_owned()),
    }
}

const NO_CRON: &str =
    "cron isn't installed on this host, so automations here can't start on schedule.";
const CRON_STOPPED: &str =
    "cron isn't running on this host, so automations here can't start on schedule. Start the cron service.";

fn service_status(crontab: &dyn Crontab) -> SchedulerStatus {
    match crontab.service_running() {
        Some(false) => unavailable(CRON_STOPPED),
        _ => SchedulerStatus {
            available: true,
            message: None,
        },
    }
}

/// Adds or refreshes this data folder's line when `wanted`, otherwise removes
/// it. A crontab this can't change is reported in the status rather than as an
/// error: the automation itself was already saved or deleted.
pub(crate) fn apply(
    crontab: &mut dyn Crontab,
    base: &Path,
    executable: &Path,
    wanted: bool,
) -> SchedulerStatus {
    let mut update = || -> anyhow::Result<SchedulerStatus> {
        if base.to_string_lossy().contains('\n') || executable.to_string_lossy().contains('\n') {
            bail!(
                "Komla's folder on this host has a line break in its path, which cron can't run."
            );
        }
        let Some(contents) = crontab.read()? else {
            return Ok(unavailable(NO_CRON));
        };
        let line = wanted.then(|| schedule_line(base, executable));
        let next = rewrite(&contents, base, line.as_deref());
        if next != contents {
            crontab.write(&next)?;
        }
        Ok(service_status(crontab))
    };
    update().unwrap_or_else(|error| unavailable(&format!("{error:#}")))
}

/// Whether automations here start on schedule, without changing anything.
pub(crate) fn status(crontab: &mut dyn Crontab, base: &Path, any_enabled: bool) -> SchedulerStatus {
    let contents = match crontab.read() {
        Ok(Some(contents)) => contents,
        Ok(None) => return unavailable(NO_CRON),
        Err(error) => return unavailable(&format!("{error:#}")),
    };
    let marker = marker(base);
    if any_enabled && !contents.lines().any(|line| is_ours(line, &marker)) {
        return unavailable(
            "Komla's cron entry on this host is missing, so automations here won't start. Save any automation here to add it back.",
        );
    }
    service_status(crontab)
}

#[cfg(test)]
pub(crate) mod tests {
    use std::path::PathBuf;

    use super::*;

    #[derive(Default)]
    pub(crate) struct FakeCrontab {
        pub(crate) contents: Option<String>,
        pub(crate) writes: usize,
        pub(crate) running: Option<bool>,
        /// What `crontab -l` fails with, e.g. for a user cron.allow leaves out.
        pub(crate) read_error: Option<String>,
    }

    impl FakeCrontab {
        pub(crate) fn with(contents: &str) -> Self {
            Self {
                contents: Some(contents.to_owned()),
                ..Self::default()
            }
        }
    }

    impl Crontab for FakeCrontab {
        fn read(&mut self) -> anyhow::Result<Option<String>> {
            if let Some(error) = &self.read_error {
                bail!("Couldn't read this host's crontab: {error}");
            }
            Ok(self.contents.clone())
        }

        fn write(&mut self, contents: &str) -> anyhow::Result<()> {
            self.contents = Some(contents.to_owned());
            self.writes += 1;
            Ok(())
        }

        fn service_running(&self) -> Option<bool> {
            self.running
        }
    }

    fn paths() -> (PathBuf, PathBuf) {
        (
            PathBuf::from("/home/u/.komla"),
            PathBuf::from("/home/u/.komla/helpers/bin/protocol-1/abc/komla"),
        )
    }

    #[test]
    fn adds_one_line_and_keeps_every_other_line() {
        let (base, executable) = paths();
        let original = "MAILTO=me\n0 3 * * * backup.sh # nightly\n";
        let mut crontab = FakeCrontab::with(original);

        let status = apply(&mut crontab, &base, &executable, true);

        assert!(status.available);
        assert_eq!(
            crontab.contents.as_deref().unwrap(),
            format!(
                "{original}* * * * * KOMLA_DATA_DIR='/home/u/.komla' '/home/u/.komla/helpers/bin/protocol-1/abc/komla' automation tick >/dev/null 2>&1 # komla-automations /home/u/.komla\n"
            )
        );
        apply(&mut crontab, &base, &executable, true);
        assert_eq!(crontab.writes, 1);
    }

    #[test]
    fn replaces_the_line_with_the_newest_executable() {
        let (base, executable) = paths();
        let mut crontab = FakeCrontab::with("0 3 * * * backup.sh");
        apply(&mut crontab, &base, Path::new("/old/komla"), true);

        apply(&mut crontab, &base, &executable, true);

        let contents = crontab.contents.unwrap();
        assert!(contents.starts_with("0 3 * * * backup.sh\n* * * * *"));
        assert!(!contents.contains("/old/"));
        assert_eq!(contents.matches(MARKER).count(), 1);
    }

    #[test]
    fn removes_only_this_data_folders_line() {
        let (base, executable) = paths();
        let other = schedule_line(Path::new("/srv/other/.komla"), &executable);
        let mut crontab = FakeCrontab::with(&format!("{other}\n"));
        apply(&mut crontab, &base, &executable, true);

        apply(&mut crontab, &base, &executable, false);

        assert_eq!(crontab.contents.unwrap(), format!("{other}\n"));
    }

    #[test]
    fn escapes_percent_signs_cron_would_read_as_newlines() {
        let line = schedule_line(Path::new("/home/100%/.komla"), Path::new("/x/komla"));
        assert!(line.contains("/home/100\\%/.komla"));
        assert!(!line.contains("100%/"));
    }

    #[test]
    fn reports_hosts_without_cron() {
        let (base, executable) = paths();
        let mut crontab = FakeCrontab::default();

        let status = apply(&mut crontab, &base, &executable, true);

        assert!(!status.available);
        assert!(status.message.unwrap().contains("isn't installed"));
        assert_eq!(crontab.writes, 0);
    }

    #[test]
    fn reports_a_crontab_it_cant_read_instead_of_failing() {
        let (base, executable) = paths();
        let mut crontab = FakeCrontab {
            read_error: Some("You (u) are not allowed to use this program (crontab)".to_owned()),
            ..FakeCrontab::default()
        };

        let status = apply(&mut crontab, &base, &executable, true);

        assert!(!status.available);
        assert!(status.message.unwrap().contains("not allowed"));
        assert_eq!(crontab.writes, 0);
    }

    #[test]
    fn reports_a_stopped_cron_service() {
        let (base, executable) = paths();
        let mut crontab = FakeCrontab {
            running: Some(false),
            ..FakeCrontab::with("")
        };

        let status = apply(&mut crontab, &base, &executable, true);

        assert!(!status.available);
        assert!(status.message.unwrap().contains("isn't running"));
    }

    #[test]
    fn reports_a_missing_line_while_automations_are_enabled() {
        let (base, executable) = paths();
        let mut crontab = FakeCrontab::with("");
        assert!(!status(&mut crontab, &base, true).available);
        assert!(status(&mut crontab, &base, false).available);
        apply(&mut crontab, &base, &executable, true);
        assert!(status(&mut crontab, &base, true).available);
    }
}
