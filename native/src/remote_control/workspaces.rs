//! The phone's workspace list on this host: the workspace manifests every Komla installation
//! publishes under `<base>/workspaces`, with each terminal running while its managed tmux session
//! `komla-<terminalId>` exists.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;
use std::process::Command;

use serde::Deserialize;
use serde_json::{json, Value};

use super::attention::AttentionBoard;

const MAX_MANIFEST_BYTES: u64 = 256 * 1024;
const MAX_NAME_CHARS: usize = 256;
const MAX_SEARCH_TEXT_CHARS: usize = 512;
const MAX_PATH_CHARS: usize = 4096;
const MAX_TAG_CHARS: usize = 40;
const TAG_TONES: &[&str] = &[
    "neutral",
    "info",
    "attention",
    "success",
    "warning",
    "error",
];
pub(crate) const MANAGED_SESSION_PREFIX: &str = "komla-";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    workspace_id: String,
    name: String,
    #[serde(default)]
    custom_name: Option<String>,
    #[serde(default)]
    custom_description: Option<String>,
    /// The agent's last title, which the desktop writes only while there is no custom name.
    #[serde(default)]
    agent_title: Option<String>,
    /// The tag as the desktop shows it. Read loosely: a bad one drops the tag, not the workspace.
    #[serde(default)]
    tag: Option<Value>,
    #[serde(default)]
    branch_name: Option<String>,
    #[serde(default)]
    repo_name: Option<String>,
    backend: ManifestBackend,
    #[serde(default)]
    terminals: Vec<ManifestTerminal>,
    #[serde(default)]
    primary_terminal_id: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    created_at: Option<u64>,
    #[serde(default)]
    updated_at: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestBackend {
    remote_directory: String,
    #[serde(default)]
    project_name: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestTerminal {
    id: String,
    name: String,
}

#[derive(Debug, Clone)]
pub(crate) struct HostTerminal {
    pub(crate) id: String,
    pub(crate) name: String,
}

#[derive(Debug, Clone)]
pub(crate) struct HostWorkspace {
    pub(crate) id: String,
    name: String,
    description: Option<String>,
    working_directory: String,
    project_name: Option<String>,
    branch_name: Option<String>,
    tag: Option<Value>,
    status: &'static str,
    created_at: Option<u64>,
    updated_at: Option<u64>,
    primary_terminal_id: Option<String>,
    pub(crate) terminals: Vec<HostTerminal>,
}

fn is_id(value: &str) -> bool {
    (1..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn clip(text: &str, max_chars: usize) -> String {
    text.chars().take(max_chars).collect()
}

/// A manifest's tag as the phone's schema takes it: a short name, a known tone and maybe a spinner.
fn tag_summary(tag: &Value) -> Option<Value> {
    let name = tag["name"].as_str()?.trim();
    let tone = tag["tone"].as_str()?;
    if name.is_empty() || name.chars().count() > MAX_TAG_CHARS || !TAG_TONES.contains(&tone) {
        return None;
    }
    let mut summary = json!({ "name": name, "tone": tone });
    if tag["spinner"] == Value::Bool(true) {
        summary["spinner"] = Value::Bool(true);
    }
    Some(summary)
}

fn non_empty(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

/// Reads every manifest, skipping deleted workspaces and files that don't parse.
pub(crate) fn read_workspaces(base: &Path) -> Vec<HostWorkspace> {
    let directory = base.join("workspaces");
    let Ok(entries) = fs::read_dir(&directory) else {
        return Vec::new();
    };
    let deleted: HashSet<String> = fs::read_dir(directory.join("deleted"))
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .filter_map(|entry| entry.file_name().into_string().ok())
                .collect()
        })
        .unwrap_or_default();
    let mut workspaces = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("json"))
        .filter_map(|path| {
            let metadata = fs::metadata(&path).ok()?;
            if !metadata.is_file() || metadata.len() > MAX_MANIFEST_BYTES {
                return None;
            }
            let manifest: Manifest = serde_json::from_slice(&fs::read(&path).ok()?).ok()?;
            let stem = path.file_stem()?.to_str()?;
            (stem == manifest.workspace_id
                && is_id(&manifest.workspace_id)
                && !deleted.contains(&manifest.workspace_id))
            .then(|| HostWorkspace::from_manifest(manifest))
        })
        .collect::<Vec<_>>();
    workspaces.sort_by(|left, right| left.id.cmp(&right.id));
    workspaces
}

/// One workspace's manifest as written, for this host to change, under the checks the list makes.
pub(crate) fn read_manifest(base: &Path, workspace_id: &str) -> Option<Value> {
    if !is_id(workspace_id) {
        return None;
    }
    let directory = base.join("workspaces");
    if directory.join("deleted").join(workspace_id).exists() {
        return None;
    }
    let path = directory.join(format!("{workspace_id}.json"));
    let metadata = fs::metadata(&path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_MANIFEST_BYTES {
        return None;
    }
    let manifest: Value = serde_json::from_slice(&fs::read(&path).ok()?).ok()?;
    (manifest["workspaceId"] == workspace_id).then_some(manifest)
}

impl HostWorkspace {
    fn from_manifest(manifest: Manifest) -> Self {
        let terminals = manifest
            .terminals
            .into_iter()
            .filter(|terminal| is_id(&terminal.id))
            .map(|terminal| HostTerminal {
                name: non_empty(Some(clip(&terminal.name, MAX_NAME_CHARS)))
                    .unwrap_or_else(|| "Terminal".to_owned()),
                id: terminal.id,
            })
            .collect::<Vec<_>>();
        let primary_terminal_id = manifest
            .primary_terminal_id
            .filter(|id| terminals.iter().any(|terminal| &terminal.id == id));
        // The title the desktop's sidebar shows, as far as the manifest has it.
        let name = non_empty(manifest.custom_name)
            .or_else(|| non_empty(manifest.agent_title))
            .or_else(|| non_empty(Some(manifest.name)))
            .unwrap_or_else(|| manifest.workspace_id.clone());
        Self {
            id: manifest.workspace_id,
            name: clip(&name, MAX_NAME_CHARS),
            // On one line, as the desktop sends it.
            description: non_empty(manifest.custom_description).map(|description| {
                clip(
                    &description.split_whitespace().collect::<Vec<_>>().join(" "),
                    MAX_SEARCH_TEXT_CHARS,
                )
            }),
            working_directory: clip(&manifest.backend.remote_directory, MAX_PATH_CHARS),
            project_name: non_empty(manifest.backend.project_name)
                .or_else(|| non_empty(manifest.repo_name))
                .map(|name| clip(&name, MAX_NAME_CHARS)),
            branch_name: non_empty(manifest.branch_name).map(|name| clip(&name, MAX_NAME_CHARS)),
            tag: manifest.tag.as_ref().and_then(tag_summary),
            status: match manifest.status.as_deref() {
                Some("stashed") => "stashed",
                Some("archived") => "archived",
                Some("trashed") => "trashed",
                _ => "active",
            },
            created_at: manifest.created_at,
            updated_at: manifest.updated_at,
            primary_terminal_id,
            terminals,
        }
    }

    /// The `RemoteWorkspaceSummary` the phone renders.
    pub(crate) fn summary(
        &self,
        sessions: &HashMap<String, u64>,
        attention: &AttentionBoard,
        host_name: &str,
    ) -> Value {
        let mut last_activity = self.updated_at.unwrap_or(0);
        let mut workspace_active = false;
        let mut workspace_attention: Option<(u64, Value)> = None;
        let terminals = self
            .terminals
            .iter()
            .map(|terminal| {
                let live = sessions.get(&terminal.id);
                if let Some(activity) = live {
                    last_activity = last_activity.max(*activity);
                }
                let state = attention.get(&terminal.id);
                let mut summary = json!({
                    "id": terminal.id,
                    "name": terminal.name,
                    "status": if live.is_some() { "running" } else { "stopped" },
                    "environment": { "kind": "ssh", "name": host_name },
                });
                if state.agent_active && live.is_some() {
                    workspace_active = true;
                    summary["agentActive"] = Value::Bool(true);
                }
                if let Some(raised) = state.attention {
                    let raised_json = raised.to_json(&terminal.id);
                    summary["attention"] = raised_json.clone();
                    if workspace_attention
                        .as_ref()
                        .is_none_or(|(updated_at, _)| raised.updated_at > *updated_at)
                    {
                        workspace_attention = Some((raised.updated_at, raised_json));
                    }
                }
                summary
            })
            .collect::<Vec<_>>();

        let mut summary = json!({
            "id": self.id,
            "name": self.name,
            "workingDirectory": self.working_directory,
            "status": self.status,
            "provisioning": false,
            "terminals": terminals,
        });
        if let Some(description) = &self.description {
            summary["description"] = Value::String(description.clone());
        }
        if let Some(project) = &self.project_name {
            summary["projectName"] = Value::String(project.clone());
        }
        if let Some(branch) = &self.branch_name {
            summary["branchName"] = Value::String(branch.clone());
        }
        if let Some(tag) = &self.tag {
            summary["tag"] = tag.clone();
        }
        if let Some(created) = self.created_at {
            summary["createdAt"] = json!(created);
        }
        if last_activity > 0 {
            summary["lastActivityAt"] = json!(last_activity);
        }
        if let Some(primary) = &self.primary_terminal_id {
            summary["primaryTerminalId"] = Value::String(primary.clone());
        }
        if workspace_active {
            summary["agentActive"] = Value::Bool(true);
        }
        if let Some((_, raised)) = workspace_attention {
            summary["needsAttention"] = Value::Bool(true);
            summary["attention"] = raised;
        }
        summary
    }
}

/// Live managed sessions on `socket`, by terminal id, with their last activity in milliseconds.
pub(crate) fn live_sessions(socket: &str) -> HashMap<String, u64> {
    let Ok(output) = Command::new("tmux")
        .args([
            "-L",
            socket,
            "list-sessions",
            "-F",
            "#{session_name}\t#{session_activity}",
        ])
        .env_remove("TMUX")
        .output()
    else {
        return HashMap::new();
    };
    if !output.status.success() {
        return HashMap::new();
    }
    parse_sessions(&String::from_utf8_lossy(&output.stdout))
}

fn parse_sessions(listing: &str) -> HashMap<String, u64> {
    listing
        .lines()
        .filter_map(|line| {
            let (name, activity) = line.split_once('\t')?;
            let terminal_id = name.strip_prefix(MANAGED_SESSION_PREFIX)?;
            if !is_id(terminal_id) || terminal_id.starts_with("companion-") {
                return None;
            }
            Some((
                terminal_id.to_owned(),
                activity.trim().parse::<u64>().unwrap_or(0) * 1000,
            ))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use komla::PendingTerminalHook;

    fn write_manifest(base: &Path, id: &str, extra: Value) {
        let mut manifest = json!({
            "schema": 1,
            "workspaceId": id,
            "name": "fix-ssh",
            "branchName": "ssh-passphrase",
            "repoName": "komla",
            "backend": {
                "remoteDirectory": "/home/u/.komla/worktrees/komla/ssh-passphrase",
                "remoteRepoPath": "/home/u/.komla/repos/komla/repo.git",
                "remoteProjectRoot": "/home/u/.komla/worktrees/komla",
                "gitUrl": "git@github.com:x/komla.git",
            },
            "terminals": [
                { "id": "term-a", "name": "Claude Code", "createdAt": 1 },
                { "id": "term-b", "name": "Shell", "createdAt": 2 },
            ],
            "primaryTerminalId": "term-a",
            "createdAt": 1_000,
            "updatedAt": 2_000,
            "writtenBy": "device",
        });
        for (key, value) in extra.as_object().unwrap() {
            manifest[key] = value.clone();
        }
        fs::create_dir_all(base.join("workspaces")).unwrap();
        fs::write(
            base.join("workspaces").join(format!("{id}.json")),
            manifest.to_string(),
        )
        .unwrap();
    }

    #[test]
    fn lists_manifests_with_live_sessions_and_agent_state() {
        let base = tempfile::tempdir().unwrap();
        write_manifest(
            base.path(),
            "ws-1",
            json!({
                "customName": "Fix SSH prompt",
                "customDescription": "  Ask once\n per host ",
            }),
        );
        let mut attention = AttentionBoard::default();
        attention.apply(
            &PendingTerminalHook::new(
                "term-a".to_owned(),
                "/w".to_owned(),
                "input-required".to_owned(),
                "claude-code".to_owned(),
                "Allow?".to_owned(),
                json!({}),
            ),
            5_000,
        );
        let sessions = HashMap::from([("term-a".to_owned(), 9_000)]);

        let [workspace] = read_workspaces(base.path()).try_into().unwrap();
        let summary = workspace.summary(&sessions, &attention, "devbox");

        assert_eq!(summary["name"], "Fix SSH prompt");
        assert_eq!(summary["description"], "Ask once per host");
        assert_eq!(summary["projectName"], "komla");
        assert_eq!(summary["branchName"], "ssh-passphrase");
        assert_eq!(summary["lastActivityAt"], 9_000);
        assert_eq!(summary["needsAttention"], true);
        assert_eq!(summary["attention"]["kind"], "input-required");
        assert_eq!(summary["terminals"][0]["status"], "running");
        assert_eq!(summary["terminals"][0]["environment"]["name"], "devbox");
        assert_eq!(summary["terminals"][1]["status"], "stopped");
        assert!(summary.get("agentActive").is_none());
    }

    #[test]
    fn names_a_workspace_by_its_agent_title_only_without_a_custom_name() {
        let base = tempfile::tempdir().unwrap();
        write_manifest(
            base.path(),
            "ws-1",
            json!({ "agentTitle": "Stripe webhook retries" }),
        );
        write_manifest(
            base.path(),
            "ws-2",
            json!({ "customName": "Fix SSH prompt", "agentTitle": "Stripe webhook retries" }),
        );

        let names = read_workspaces(base.path())
            .iter()
            .map(|workspace| {
                workspace.summary(&HashMap::new(), &AttentionBoard::default(), "devbox")["name"]
                    .clone()
            })
            .collect::<Vec<_>>();

        assert_eq!(names, ["Stripe webhook retries", "Fix SSH prompt"]);
    }

    #[test]
    fn shows_a_valid_tag_and_keeps_a_workspace_whose_tag_is_not() {
        let base = tempfile::tempdir().unwrap();
        write_manifest(
            base.path(),
            "ws-1",
            json!({ "tag": { "name": " CI running ", "tone": "warning", "spinner": true } }),
        );
        write_manifest(
            base.path(),
            "ws-2",
            json!({ "tag": { "name": "In review", "tone": "purple" } }),
        );
        write_manifest(base.path(), "ws-3", json!({ "tag": "In review" }));

        let tags = read_workspaces(base.path())
            .iter()
            .map(|workspace| {
                workspace
                    .summary(&HashMap::new(), &AttentionBoard::default(), "devbox")
                    .get("tag")
                    .cloned()
            })
            .collect::<Vec<_>>();

        assert_eq!(
            tags,
            [
                Some(json!({ "name": "CI running", "tone": "warning", "spinner": true })),
                None,
                None
            ]
        );
    }

    #[test]
    fn reports_a_workspace_in_the_trash() {
        let base = tempfile::tempdir().unwrap();
        write_manifest(base.path(), "ws-1", json!({ "status": "trashed" }));

        let [workspace] = read_workspaces(base.path()).try_into().unwrap();
        let summary = workspace.summary(&HashMap::new(), &AttentionBoard::default(), "devbox");

        assert_eq!(summary["status"], "trashed");
    }

    #[test]
    fn skips_deleted_mismatched_and_malformed_manifests() {
        let base = tempfile::tempdir().unwrap();
        write_manifest(base.path(), "ws-1", json!({}));
        write_manifest(base.path(), "ws-2", json!({}));
        write_manifest(base.path(), "ws-3", json!({ "workspaceId": "other" }));
        fs::write(base.path().join("workspaces/ws-4.json"), "{").unwrap();
        fs::create_dir_all(base.path().join("workspaces/deleted")).unwrap();
        fs::write(base.path().join("workspaces/deleted/ws-2"), "").unwrap();

        let ids = read_workspaces(base.path())
            .into_iter()
            .map(|workspace| workspace.id)
            .collect::<Vec<_>>();

        assert_eq!(ids, ["ws-1"]);
    }

    #[test]
    fn parses_only_managed_terminal_sessions() {
        let sessions = parse_sessions(
            "komla-term-a\t1700000000\nkomla_launch_guard\t1\nkomla-companion-x\t1\nother\t1\n",
        );

        assert_eq!(
            sessions,
            HashMap::from([("term-a".to_owned(), 1_700_000_000_000)])
        );
    }
}
