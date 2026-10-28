use anyhow::Context;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::repository::{BranchObservation, RepositorySnapshot};

pub const COMPANION_PROTOCOL_VERSION: u32 = 1;
/// Past this many changed paths a snapshot reports them as unknown. Komla accepts no more.
pub const MAX_CHANGED_PATHS: usize = 500;
/// A changed path longer than this is reported as unknown. Komla accepts no longer.
pub const MAX_CHANGED_PATH_BYTES: usize = 4096;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionSnapshotPayload {
    pub protocol_version: u32,
    pub kind: String,
    pub workspace_id: String,
    pub cwd: String,
    pub sequence: u64,
    pub observed_at: u64,
    pub state_hash: String,
    pub status_b64: String,
    pub numstat_b64: String,
    pub status_too_large: bool,
    #[serde(default = "default_working_tree_changed")]
    pub working_tree_changed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_list_hash: Option<String>,
    /// The working-tree paths changed since the last delivered snapshot. `None` when anything
    /// may have changed, including Git's own state.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub changed_paths: Option<Vec<String>>,
    #[serde(flatten)]
    pub branch: BranchObservation,
}

fn default_working_tree_changed() -> bool {
    true
}

impl CompanionSnapshotPayload {
    pub fn new(
        workspace_id: String,
        cwd: String,
        sequence: u64,
        observed_at: u64,
        snapshot: RepositorySnapshot,
    ) -> anyhow::Result<Self> {
        let mut hash = Sha256::new();
        hash.update(snapshot.status_b64.as_bytes());
        hash.update([0]);
        hash.update(snapshot.numstat_b64.as_bytes());
        hash.update([0]);
        hash.update([u8::from(snapshot.status_too_large)]);
        hash.update([0]);
        hash.update(
            snapshot
                .file_list_hash
                .as_deref()
                .unwrap_or_default()
                .as_bytes(),
        );
        hash.update([0]);
        hash.update(serde_json::to_vec(&snapshot.branch).context("could not hash branch state")?);
        let state_hash = format!("{:x}", hash.finalize());
        Ok(Self {
            protocol_version: COMPANION_PROTOCOL_VERSION,
            kind: "repository-snapshot".to_owned(),
            workspace_id,
            cwd,
            sequence,
            observed_at,
            state_hash,
            status_b64: snapshot.status_b64,
            numstat_b64: snapshot.numstat_b64,
            status_too_large: snapshot.status_too_large,
            working_tree_changed: true,
            file_list_hash: snapshot.file_list_hash,
            changed_paths: None,
            branch: snapshot.branch,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingTerminalHook {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivery_id: Option<String>,
    pub terminal_id: String,
    pub cwd: String,
    pub kind: String,
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub badge: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon_color: Option<String>,
    pub message: String,
    pub hook_input: serde_json::Value,
    /// A copy for a device that isn't attached to the terminal. It shows the agent's
    /// state there, while only the terminal's owner acts on the hook.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub copy: bool,
}

/// How `komla notify` shows a notification: its title and body, the pill's color and text,
/// and an icon in place of the kind's glyph.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NotificationPresentation {
    pub title: Option<String>,
    pub body: Option<String>,
    pub color: Option<String>,
    pub badge: Option<String>,
    pub icon: Option<String>,
    pub icon_color: Option<String>,
}

impl PendingTerminalHook {
    pub fn new(
        terminal_id: String,
        cwd: String,
        kind: String,
        source: String,
        message: String,
        hook_input: serde_json::Value,
    ) -> Self {
        Self {
            delivery_id: Some(new_hook_delivery_id(&terminal_id)),
            terminal_id,
            cwd,
            kind,
            source,
            title: None,
            body: None,
            color: None,
            badge: None,
            icon: None,
            icon_color: None,
            message,
            hook_input,
            copy: false,
        }
    }

    pub fn with_presentation(mut self, presentation: NotificationPresentation) -> Self {
        let NotificationPresentation {
            title,
            body,
            color,
            badge,
            icon,
            icon_color,
        } = presentation;
        self.title = title;
        self.body = body;
        self.color = color;
        self.badge = badge;
        self.icon = icon;
        self.icon_color = icon_color;
        self
    }

    pub fn from_hook(
        terminal_id: String,
        cwd: String,
        source: String,
        event: String,
        input: &[u8],
    ) -> Self {
        let kind = match event.as_str() {
            "Stop" | "AfterAgent" => "turn-complete",
            "UserPromptSubmit" | "BeforeAgent" => "prompt-submit",
            "PermissionRequest" => "input-required",
            "PreToolUse" | "BeforeTool" => "activity",
            _ => "generic",
        };
        let mut hook_input: serde_json::Value =
            serde_json::from_slice(input).unwrap_or_else(|_| serde_json::json!({}));
        if !hook_input.is_object() {
            hook_input = serde_json::json!({});
        }
        if hook_input.get("hook_event_name").is_none() {
            hook_input["hook_event_name"] = serde_json::json!(event);
        }
        Self::new(terminal_id, cwd, kind.to_owned(), source, event, hook_input)
    }
}

fn new_hook_delivery_id(terminal_id: &str) -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!(
        "{:x}",
        Sha256::digest(
            format!(
                "{}:{timestamp}:{sequence}:{terminal_id}",
                std::process::id()
            )
            .as_bytes()
        )
    )
}
