//! The Hook Journal: what each Terminal's agents reported in their current turn, kept on the host
//! for the Komla installations that weren't connected to see it. Hooks are copied only to the
//! installations connected when they run, so one that connects reads the journal for the
//! Terminals it isn't attached to and takes in what it missed, as it would have taken the copies.
//!
//! It keeps each agent's prompt and the newest hooks since, which nothing consumes: a prompt starts
//! it over. Komla interprets them; the companion only stores them.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use komla::PendingTerminalHook;
use serde::Serialize;
use sha2::Digest;

use crate::clock::now_ms;

/// Beside `companion` in the host's `helpers` folder, shared by every installation's companion.
pub(crate) const JOURNAL_DIRECTORY: &str = "hook-journal";
/// A Terminal whose agents reported nothing for this long is forgotten.
const KEPT_FOR: Duration = Duration::from_secs(14 * 24 * 60 * 60);
/// The hooks kept of an agent's turn after its prompt, the newest: enough that hooks Komla ignores,
/// such as a subagent's or an idle reminder, don't take the place of how the turn ended.
const KEPT_HOOKS: usize = 8;
/// What Komla reads of a copy's input: its session and turn, its agent, what it asks and the work
/// that holds its turn, but not, say, the prompt or a tool's output.
const KEPT_INPUT: &[&str] = &[
    "hook_event_name",
    "session_id",
    "turn_id",
    "prompt_id",
    "agent_id",
    "notification_type",
    "background_tasks",
    "tool_name",
    "tool_input",
    "permissionID",
];
/// A larger text or input value is left out, so that reading every journal stays small.
const MAX_VALUE_BYTES: usize = 4 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JournalEntry<'a> {
    /// The installation the hook went to, by its companion's key: its own mailbox has it.
    owner: &'a str,
    /// The installations it was copied to, whose mailboxes have it too.
    copied_to: &'a [String],
    written_at_ms: u64,
    hook: PendingTerminalHook,
}

/// Records a hook that went to `inbox`, at `<base>/helpers/companion/<key>/inbox`, while another
/// installation's companion is on the host to read it. Best effort: the owner already has it, and
/// an installation without it shows what it did before.
pub(crate) fn record(inbox: &Path, hook: &PendingTerminalHook, copied_to: &[String]) {
    let _ = try_record(inbox, hook, copied_to, now_ms());
}

/// The folder holding a Terminal's journal, under the journal directory.
pub(crate) fn terminal_directory_name(terminal_id: &str) -> String {
    format!("{:x}", sha2::Sha256::digest(terminal_id.as_bytes()))[..32].to_owned()
}

fn try_record(
    inbox: &Path,
    hook: &PendingTerminalHook,
    copied_to: &[String],
    now_ms: u64,
) -> anyhow::Result<()> {
    let Some((journal, owner)) = locate(inbox) else {
        return Ok(());
    };
    if !has_other_companions(inbox) {
        return Ok(());
    }
    let directory = journal.join(terminal_directory_name(&hook.terminal_id));
    fs::create_dir_all(&directory)?;
    let source = &format!("{:x}", sha2::Sha256::digest(hook.source.as_bytes()))[..16];
    let entry = serde_json::to_vec(&JournalEntry {
        owner: &owner,
        copied_to,
        written_at_ms: now_ms,
        hook: trimmed(hook),
    })?;
    if hook.kind == "prompt-submit" {
        // The hooks there were the last turn's.
        for name in hook_names(&directory, source)? {
            match fs::remove_file(directory.join(name)) {
                Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error.into()),
                _ => {}
            }
        }
        write_atomically(&directory, &format!("{source}.prompt.json"), &entry)?;
        prune(&journal, &directory);
        return Ok(());
    }
    // Named so that they sort as they were written, as a reader lists them.
    let written = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let name = format!("{source}.{written:024}-{:010}.json", std::process::id());
    write_atomically(&directory, &name, &entry)?;
    let names = hook_names(&directory, source)?;
    for older in &names[..names.len().saturating_sub(KEPT_HOOKS)] {
        let _ = fs::remove_file(directory.join(older));
    }
    Ok(())
}

/// The files of an agent's hooks after its prompt, oldest first.
fn hook_names(directory: &Path, source: &str) -> io::Result<Vec<String>> {
    let prefix = format!("{source}.");
    let mut names: Vec<String> = fs::read_dir(directory)?
        .filter_map(Result::ok)
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| {
            name.starts_with(&prefix) && name.ends_with(".json") && !name.ends_with(".prompt.json")
        })
        .collect();
    names.sort();
    Ok(names)
}

/// The hook as Komla reads a copy of it.
fn trimmed(hook: &PendingTerminalHook) -> PendingTerminalHook {
    let mut hook = hook.clone();
    if let Some(input) = hook.hook_input.as_object_mut() {
        input.retain(|key, value| {
            KEPT_INPUT.contains(&key.as_str())
                && serde_json::to_string(value).is_ok_and(|text| text.len() <= MAX_VALUE_BYTES)
        });
    }
    truncate(&mut hook.message);
    for text in [&mut hook.title, &mut hook.body].into_iter().flatten() {
        truncate(text);
    }
    if hook
        .icon
        .as_ref()
        .is_some_and(|icon| icon.len() > MAX_VALUE_BYTES)
    {
        hook.icon = None;
    }
    hook
}

fn truncate(text: &mut String) {
    if text.len() > MAX_VALUE_BYTES {
        let end = (0..=MAX_VALUE_BYTES)
            .rev()
            .find(|&end| text.is_char_boundary(end))
            .unwrap_or(0);
        text.truncate(end);
    }
}

/// Whether another installation's companion keeps its folder beside the owner's.
fn has_other_companions(inbox: &Path) -> bool {
    let Some(owner) = inbox.parent() else {
        return false;
    };
    let Some(Ok(companions)) = owner.parent().map(fs::read_dir) else {
        return false;
    };
    companions
        .filter_map(Result::ok)
        .any(|entry| Some(entry.file_name().as_os_str()) != owner.file_name())
}

/// The journal directory and the owner's key, for an inbox where companions keep theirs.
fn locate(inbox: &Path) -> Option<(PathBuf, String)> {
    let owner = inbox.parent()?;
    let companions = owner
        .parent()
        .filter(|root| root.file_name().is_some_and(|name| name == "companion"))?;
    let key = owner.file_name()?.to_str()?.to_owned();
    Some((companions.parent()?.join(JOURNAL_DIRECTORY), key))
}

fn write_atomically(directory: &Path, name: &str, contents: &[u8]) -> anyhow::Result<()> {
    // A reader lists `*.json`, which a dotfile isn't.
    let temp = directory.join(format!(".{name}.{}.{}.tmp", std::process::id(), now_ms()));
    let mut file = fs::OpenOptions::new();
    file.write(true).create_new(true);
    // Readable by no one else from the start: it holds the user's prompt.
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut file, 0o600);
    file.open(&temp)?.write_all(contents)?;
    if let Err(error) = fs::rename(&temp, directory.join(name)) {
        let _ = fs::remove_file(&temp);
        return Err(error.into());
    }
    Ok(())
}

/// Forgets the Terminals nothing was written for in a long time, such as those since closed.
fn prune(journal: &Path, current: &Path) {
    let Ok(entries) = fs::read_dir(journal) else {
        return;
    };
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        let stale = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .is_ok_and(|modified| modified.elapsed().is_ok_and(|age| age > KEPT_FOR));
        if stale && path != current && entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            let _ = fs::remove_dir_all(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::time::{Duration, SystemTime};

    use tempfile::tempdir;

    fn hook(kind: &str, source: &str) -> komla::PendingTerminalHook {
        komla::PendingTerminalHook::new(
            "terminal".into(),
            "/repo".into(),
            kind.into(),
            source.into(),
            String::new(),
            serde_json::json!({}),
        )
    }

    /// The owner's inbox, beside another installation's companion that reads the journal.
    fn owner_inbox(helpers: &Path) -> std::path::PathBuf {
        std::fs::create_dir_all(helpers.join("companion").join("other")).unwrap();
        helpers.join("companion").join("owner").join("inbox")
    }

    /// The Terminal's journal, by file name.
    fn journal(helpers: &Path) -> Vec<(String, serde_json::Value)> {
        let directory = helpers
            .join(super::JOURNAL_DIRECTORY)
            .join(super::terminal_directory_name("terminal"));
        let Ok(entries) = std::fs::read_dir(directory) else {
            return Vec::new();
        };
        let mut files: Vec<_> = entries
            .filter_map(Result::ok)
            .map(|entry| {
                let name = entry.file_name().to_string_lossy().into_owned();
                let contents = std::fs::read(entry.path()).unwrap();
                (name, serde_json::from_slice(&contents).unwrap())
            })
            .collect();
        files.sort_by(|a, b| a.0.cmp(&b.0));
        files
    }

    fn kinds(helpers: &Path) -> Vec<String> {
        let mut kinds: Vec<_> = journal(helpers)
            .into_iter()
            .map(|(_, entry)| entry["hook"]["kind"].as_str().unwrap().to_owned())
            .collect();
        kinds.sort();
        kinds
    }

    #[test]
    fn keeps_each_agents_prompt_and_hooks_since_with_who_took_them_and_when() {
        let temp = tempdir().unwrap();
        let helpers = temp.path().join("helpers");
        let inbox = owner_inbox(&helpers);

        super::try_record(&inbox, &hook("prompt-submit", "claude-code"), &[], 1_000).unwrap();
        super::try_record(&inbox, &hook("activity", "claude-code"), &[], 2_000).unwrap();
        let stop = hook("turn-complete", "claude-code");
        super::try_record(&inbox, &stop, &[], 3_000).unwrap();
        super::try_record(&inbox, &hook("activity", "codex"), &[], 4_000).unwrap();

        let files = journal(&helpers);
        assert_eq!(files.len(), 4, "{files:?}");
        assert!(files.iter().all(|(name, _)| name.ends_with(".json")));
        let newest = files
            .iter()
            .map(|(_, entry)| entry)
            .find(|entry| entry["hook"]["kind"] == "turn-complete")
            .unwrap();
        assert_eq!(newest["owner"], "owner");
        assert_eq!(newest["writtenAtMs"], 3_000);
        assert_eq!(newest["hook"]["deliveryId"], stop.delivery_id.unwrap());
        assert_eq!(newest["hook"]["terminalId"], "terminal");
        assert_eq!(
            kinds(&helpers),
            ["activity", "activity", "prompt-submit", "turn-complete"]
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let directory = helpers
                .join(super::JOURNAL_DIRECTORY)
                .join(super::terminal_directory_name("terminal"));
            for entry in std::fs::read_dir(directory).unwrap() {
                let mode = entry.unwrap().metadata().unwrap().permissions().mode();
                assert_eq!(mode & 0o777, 0o600);
            }
        }
    }

    #[test]
    fn keeps_the_newest_hooks_of_a_turn() {
        let temp = tempdir().unwrap();
        let helpers = temp.path().join("helpers");
        let inbox = owner_inbox(&helpers);

        super::try_record(&inbox, &hook("prompt-submit", "claude-code"), &[], 1).unwrap();
        for at in 2..=11 {
            super::try_record(&inbox, &hook("activity", "claude-code"), &[], at).unwrap();
        }

        let mut written: Vec<u64> = journal(&helpers)
            .iter()
            .map(|(_, entry)| entry["writtenAtMs"].as_u64().unwrap())
            .collect();
        written.sort_unstable();
        assert_eq!(written, [1, 4, 5, 6, 7, 8, 9, 10, 11]);
    }

    #[test]
    fn a_prompt_starts_its_agents_journal_over() {
        let temp = tempdir().unwrap();
        let helpers = temp.path().join("helpers");
        let inbox = owner_inbox(&helpers);

        super::try_record(&inbox, &hook("prompt-submit", "claude-code"), &[], 1_000).unwrap();
        super::try_record(&inbox, &hook("turn-complete", "claude-code"), &[], 2_000).unwrap();
        super::try_record(&inbox, &hook("turn-complete", "codex"), &[], 2_500).unwrap();
        super::try_record(&inbox, &hook("prompt-submit", "claude-code"), &[], 3_000).unwrap();

        let files = journal(&helpers);
        assert_eq!(kinds(&helpers), ["prompt-submit", "turn-complete"]);
        let prompt = files
            .iter()
            .find(|(name, _)| name.ends_with(".prompt.json"))
            .unwrap();
        assert_eq!(prompt.1["writtenAtMs"], 3_000);
        let other = files
            .iter()
            .find(|(name, _)| !name.ends_with(".prompt.json"))
            .unwrap();
        assert_eq!(other.1["hook"]["source"], "codex");
    }

    #[test]
    fn writes_nothing_while_no_other_installation_could_read_it() {
        let temp = tempdir().unwrap();
        let helpers = temp.path().join("helpers");
        let inbox = helpers.join("companion").join("owner").join("inbox");
        std::fs::create_dir_all(&inbox).unwrap();

        super::try_record(&inbox, &hook("prompt-submit", "claude-code"), &[], 1).unwrap();

        assert!(!helpers.join(super::JOURNAL_DIRECTORY).exists());
    }

    #[test]
    fn keeps_only_what_komla_reads_of_a_copy() {
        let temp = tempdir().unwrap();
        let helpers = temp.path().join("helpers");
        let mut stop = hook("turn-complete", "claude-code");
        stop.message = "é".repeat(3_000);
        stop.hook_input = serde_json::json!({
            "hook_event_name": "Stop",
            "session_id": "s1",
            "background_tasks": [{ "type": "shell", "status": "running", "command": "npm test" }],
            "last_assistant_message": "a long reply",
            "tool_input": { "content": "x".repeat(5_000) },
        });

        super::try_record(&owner_inbox(&helpers), &stop, &[], 1).unwrap();

        let (_, entry) = journal(&helpers).pop().unwrap();
        let input = entry["hook"]["hookInput"].as_object().unwrap();
        let mut kept: Vec<&str> = input.keys().map(String::as_str).collect();
        kept.sort_unstable();
        assert_eq!(kept, ["background_tasks", "hook_event_name", "session_id"]);
        // Cut on a character's boundary.
        assert_eq!(entry["hook"]["message"].as_str().unwrap().len(), 4_096);
    }

    #[test]
    fn writes_nothing_for_an_inbox_outside_the_companions_folder() {
        let temp = tempdir().unwrap();
        let inbox = temp.path().join("somewhere").join("key").join("inbox");

        super::try_record(&inbox, &hook("prompt-submit", "claude-code"), &[], 1_000).unwrap();

        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 0);
    }

    #[test]
    fn a_prompt_forgets_terminals_nothing_was_written_for_in_two_weeks() {
        let temp = tempdir().unwrap();
        let helpers = temp.path().join("helpers");
        let inbox = owner_inbox(&helpers);
        let journal = helpers.join(super::JOURNAL_DIRECTORY);
        let old = journal.join("old");
        let recent = journal.join("recent");
        std::fs::create_dir_all(&old).unwrap();
        std::fs::create_dir_all(&recent).unwrap();
        std::fs::File::open(&old)
            .unwrap()
            .set_modified(SystemTime::now() - Duration::from_secs(15 * 24 * 60 * 60))
            .unwrap();

        super::try_record(&inbox, &hook("prompt-submit", "claude-code"), &[], 1_000).unwrap();

        assert!(!old.exists());
        assert!(recent.exists());
        assert_eq!(kinds(&helpers), ["prompt-submit"]);
    }
}
