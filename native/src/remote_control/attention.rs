//! Agent state for the phone, from copies of agent hooks. The server keeps a `receiving` marker
//! fresh beside its own inbox under `helpers/companion/`, so every hook written on this host is
//! copied there too (see `mailbox.rs`); the server reads and removes those copies.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use komla::PendingTerminalHook;
use serde_json::{json, Value};

const RECEIVING_FILE: &str = "receiving";
const MAX_HOOK_BYTES: u64 = 256 * 1024;
const MAX_MESSAGE_CHARS: usize = 4096;
const MAX_SOURCE_CHARS: usize = 128;

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct TerminalAttention {
    pub(crate) kind: &'static str,
    pub(crate) source: String,
    pub(crate) message: Option<String>,
    pub(crate) updated_at: u64,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct TerminalAgentState {
    pub(crate) agent_active: bool,
    pub(crate) attention: Option<TerminalAttention>,
}

impl TerminalAttention {
    pub(crate) fn to_json(&self, terminal_id: &str) -> Value {
        let mut value = json!({
            "kind": self.kind,
            "source": self.source,
            "updatedAt": self.updated_at,
            "terminalId": terminal_id,
        });
        if let Some(message) = &self.message {
            value["message"] = Value::String(message.clone());
        }
        value
    }
}

fn truncate(text: &str, max_chars: usize) -> String {
    text.chars().take(max_chars).collect()
}

#[derive(Default)]
pub(crate) struct AttentionBoard {
    terminals: HashMap<String, TerminalAgentState>,
}

impl AttentionBoard {
    pub(crate) fn get(&self, terminal_id: &str) -> TerminalAgentState {
        self.terminals.get(terminal_id).cloned().unwrap_or_default()
    }

    /// Applies one hook the way the desktop reads its kinds; returns whether anything changed.
    pub(crate) fn apply(&mut self, hook: &PendingTerminalHook, now: u64) -> bool {
        let before = self.get(&hook.terminal_id);
        let attention = |kind: &'static str| TerminalAttention {
            kind,
            source: truncate(&hook.source, MAX_SOURCE_CHARS),
            message: Some(hook.message.trim())
                .filter(|message| !message.is_empty())
                .map(|message| truncate(message, MAX_MESSAGE_CHARS)),
            updated_at: now,
        };
        let after = match hook.kind.as_str() {
            "prompt-submit" | "activity" => TerminalAgentState {
                agent_active: true,
                attention: None,
            },
            "turn-complete" => TerminalAgentState {
                agent_active: false,
                attention: Some(attention("turn-complete")),
            },
            "input-required" => TerminalAgentState {
                agent_active: false,
                attention: Some(attention("input-required")),
            },
            "error" => TerminalAgentState {
                agent_active: false,
                attention: Some(attention("error")),
            },
            "idle" => TerminalAgentState {
                agent_active: false,
                attention: Some(attention("idle")),
            },
            "interrupted" => TerminalAgentState::default(),
            _ => return false,
        };
        let changed = after != before;
        self.terminals.insert(hook.terminal_id.clone(), after);
        changed
    }

    /// The phone looked at the terminal, as viewing it on the desktop does.
    pub(crate) fn mark_viewed(&mut self, terminal_id: &str) -> bool {
        match self.terminals.get_mut(terminal_id) {
            Some(state) if state.attention.is_some() => {
                state.attention = None;
                true
            }
            _ => false,
        }
    }
}

/// The server's own folder beside the companions' (`helpers/companion/phone-<key>`).
pub(crate) struct HookInbox {
    dir: PathBuf,
}

impl HookInbox {
    pub(crate) fn new(dir: &Path) -> Self {
        Self {
            dir: dir.to_path_buf(),
        }
    }

    /// Keeps hook copies coming; the mailbox treats a marker under 30 s old as fresh.
    pub(crate) fn mark_receiving(&self) {
        let path = self.dir.join(RECEIVING_FILE);
        let marked = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(&path)
            .and_then(|file| file.set_modified(SystemTime::now()));
        if let Err(error) = marked {
            eprintln!("could not mark the phone server as receiving hooks: {error}");
        }
    }

    /// Reads and removes every pending copy, oldest first.
    pub(crate) fn drain(&self) -> Vec<PendingTerminalHook> {
        let inbox = self.dir.join("inbox");
        let Ok(entries) = fs::read_dir(&inbox) else {
            return Vec::new();
        };
        let mut files = entries
            .filter_map(Result::ok)
            .filter(|entry| {
                entry.path().extension().and_then(|value| value.to_str()) == Some("json")
            })
            .filter_map(|entry| {
                let metadata = entry.metadata().ok()?;
                Some((metadata.modified().ok()?, metadata.len(), entry.path()))
            })
            .collect::<Vec<_>>();
        files.sort();
        files
            .into_iter()
            .filter_map(|(_, length, path)| {
                let hook = (length <= MAX_HOOK_BYTES)
                    .then(|| fs::read(&path).ok())
                    .flatten()
                    .and_then(|bytes| serde_json::from_slice::<PendingTerminalHook>(&bytes).ok());
                let _ = fs::remove_file(&path);
                hook
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hook(terminal: &str, kind: &str, message: &str) -> PendingTerminalHook {
        PendingTerminalHook::new(
            terminal.to_owned(),
            "/w".to_owned(),
            kind.to_owned(),
            "claude-code".to_owned(),
            message.to_owned(),
            json!({}),
        )
    }

    #[test]
    fn hooks_drive_the_agent_state_the_phone_shows() {
        let mut board = AttentionBoard::default();

        assert!(board.apply(&hook("t", "prompt-submit", ""), 1));
        assert!(board.get("t").agent_active);
        assert!(board.apply(&hook("t", "input-required", " Allow npm test? "), 2));
        let state = board.get("t");
        assert!(!state.agent_active);
        let attention = state.attention.unwrap();
        assert_eq!(attention.kind, "input-required");
        assert_eq!(attention.message.as_deref(), Some("Allow npm test?"));
        assert_eq!(
            attention.to_json("t"),
            json!({
                "kind": "input-required",
                "source": "claude-code",
                "updatedAt": 2,
                "terminalId": "t",
                "message": "Allow npm test?",
            })
        );
        assert!(!board.apply(&hook("t", "unknown-kind", ""), 3));
        assert!(board.mark_viewed("t"));
        assert!(!board.mark_viewed("t"));
        board.apply(&hook("t", "turn-complete", ""), 4);
        assert!(board.apply(&hook("t", "interrupted", ""), 5));
        assert_eq!(board.get("t"), TerminalAgentState::default());
    }

    #[test]
    fn drains_copies_from_the_inbox_and_keeps_the_marker_fresh() {
        let dir = tempfile::tempdir().unwrap();
        let inbox = HookInbox::new(dir.path());
        fs::create_dir_all(dir.path().join("inbox")).unwrap();
        crate::mailbox::ingest_pending(
            &dir.path().join("inbox"),
            &hook("t", "turn-complete", "done"),
        )
        .unwrap();
        fs::write(dir.path().join("inbox").join("broken.json"), b"{").unwrap();

        let hooks = inbox.drain();
        inbox.mark_receiving();

        assert_eq!(hooks.len(), 1);
        assert_eq!(hooks[0].kind, "turn-complete");
        assert_eq!(fs::read_dir(dir.path().join("inbox")).unwrap().count(), 0);
        assert!(dir.path().join(RECEIVING_FILE).exists());
    }
}
