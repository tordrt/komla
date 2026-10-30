//! What a phone can start on this host, as the desktop last copied it here: the projects it can
//! cut workspaces from and its agents' POSIX launch commands. The desktop rewrites `launch.json`
//! next to the trust file whenever it connects and something changed.

use std::fs;
use std::path::Path;

use anyhow::{bail, Context};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::automation::{inside, AutomationProject};
use crate::offline_workspace::{is_valid_branch, ManifestLaunch};

const LAUNCH_FILE_VERSION: u32 = 1;
const MAX_LAUNCH_FILE_BYTES: u64 = 512 * 1024;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostLaunch {
    version: u32,
    /// The desktop's id for this host, which the phone names as the environment.
    host_id: String,
    #[serde(default)]
    default_launch_mode_id: Option<String>,
    #[serde(default)]
    projects: Vec<LaunchProject>,
    #[serde(default)]
    presets: Vec<LaunchPreset>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LaunchProject {
    /// The `RemoteProjectSummary` the phone shows, as the desktop sends it.
    summary: Value,
    #[serde(flatten)]
    project: AutomationProject,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LaunchPreset {
    /// The `RemoteAgentPresetSummary` the phone shows, as the desktop sends it.
    summary: Value,
    launches: Vec<PresetLaunch>,
}

/// One launch mode's commands; no `launchModeId` is the preset without a mode.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PresetLaunch {
    #[serde(default)]
    launch_mode_id: Option<String>,
    prompt_command: String,
    open_command: String,
    #[serde(default)]
    continue_command: Option<String>,
}

fn summary_id(summary: &Value) -> &str {
    summary["id"].as_str().unwrap_or_default()
}

impl HostLaunch {
    /// A missing file offers nothing; a malformed one is an error the caller reports.
    pub(crate) fn load(path: &Path) -> anyhow::Result<Self> {
        let metadata = match fs::metadata(path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Self::default())
            }
            Err(error) => return Err(error).context("could not read the launch options"),
        };
        if metadata.len() > MAX_LAUNCH_FILE_BYTES {
            bail!("the launch options on this host are too large");
        }
        Self::parse(&fs::read(path).context("could not read the launch options")?)
    }

    pub(crate) fn parse(bytes: &[u8]) -> anyhow::Result<Self> {
        let launch: Self = serde_json::from_slice(bytes)
            .context("the launch options on this host are malformed")?;
        if launch.version != LAUNCH_FILE_VERSION {
            bail!(
                "launch options version {} is not supported; update Komla",
                launch.version
            );
        }
        Ok(launch)
    }

    pub(crate) fn host_id(&self) -> &str {
        &self.host_id
    }

    pub(crate) fn project(&self, base: &Path, id: &str) -> Option<&AutomationProject> {
        self.projects
            .iter()
            .find(|entry| summary_id(&entry.summary) == id && entry.usable(base))
            .map(|entry| &entry.project)
    }

    /// The preset with `id`, or the first one when the phone names none.
    pub(crate) fn preset(&self, id: Option<&str>) -> Option<&LaunchPreset> {
        let mut presets = self
            .presets
            .iter()
            .filter(|preset| !preset.launches.is_empty());
        match id {
            Some(id) => presets.find(|preset| summary_id(&preset.summary) == id),
            None => presets.next(),
        }
    }

    /// The `app:launch-options` reply: nothing to start until a project's repository is here.
    /// Projects keep the icons the desktop fitted in one frame only for a phone that takes them.
    pub(crate) fn options_frame(
        &self,
        request_id: &str,
        base: &Path,
        host_name: &str,
        project_icons: bool,
    ) -> Value {
        let projects: Vec<Value> = self
            .projects
            .iter()
            .filter(|entry| entry.usable(base))
            .map(|entry| {
                let mut summary = entry.summary.clone();
                if !project_icons {
                    if let Some(fields) = summary.as_object_mut() {
                        fields.remove("icon");
                    }
                }
                summary
            })
            .collect();
        let presets: Vec<Value> = if projects.is_empty() {
            Vec::new()
        } else {
            self.presets
                .iter()
                .filter(|preset| !preset.launches.is_empty())
                .map(|preset| preset.summary.clone())
                .collect()
        };
        let environments = if presets.is_empty() {
            json!([])
        } else {
            json!([{ "kind": "ssh", "id": self.host_id, "name": host_name }])
        };
        let mut frame = json!({
            "type": "app:launch-options",
            "requestId": request_id,
            "projects": if presets.is_empty() { Vec::new() } else { projects },
            "presets": presets,
            "environments": environments,
            "actions": [],
        });
        if let Some(mode) = &self.default_launch_mode_id {
            frame["defaultLaunchModeId"] = Value::String(mode.clone());
        }
        frame
    }
}

impl LaunchProject {
    /// Its repository is already set up on this host, inside Komla's data directory.
    fn usable(&self, base: &Path) -> bool {
        let project = &self.project;
        !summary_id(&self.summary).is_empty()
            && inside(&project.remote_repo_path, &base.join("repos"))
            && inside(&project.remote_project_root, &base.join("worktrees"))
            && [&project.base_branch, &project.default_branch]
                .into_iter()
                .flatten()
                .all(|branch| is_valid_branch(branch))
            && project.remote_repo_path.is_dir()
    }
}

impl LaunchPreset {
    pub(crate) fn name(&self) -> &str {
        self.summary["name"].as_str().unwrap_or("Agent")
    }

    /// The commands for `launch_mode_id`, else the preset's without a mode.
    pub(crate) fn launch(&self, launch_mode_id: Option<&str>) -> Option<ManifestLaunch> {
        let found = launch_mode_id
            .and_then(|mode| {
                self.launches
                    .iter()
                    .find(|launch| launch.launch_mode_id.as_deref() == Some(mode))
            })
            .or_else(|| {
                self.launches
                    .iter()
                    .find(|launch| launch.launch_mode_id.is_none())
            })?;
        if !found.prompt_command.contains("{{prompt}}") || found.open_command.trim().is_empty() {
            return None;
        }
        Some(ManifestLaunch {
            agent_name: self.name().to_owned(),
            prompt_command: found.prompt_command.clone(),
            open_command: found.open_command.clone(),
            continue_command: found
                .continue_command
                .clone()
                .filter(|command| !command.trim().is_empty()),
        })
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn launch_json(base: &Path) -> Value {
        json!({
            "version": 1,
            "hostId": "host-1",
            "defaultLaunchModeId": "yolo",
            "projects": [
                {
                    "summary": { "id": "p-app", "name": "app", "repositoryPath": "/Users/me/app" },
                    "remoteRepoPath": base.join("repos/app/repo.git"),
                    "remoteProjectRoot": base.join("worktrees/app"),
                    "gitUrl": "git@example.com:app.git",
                    "projectName": "app",
                    "baseBranch": "main",
                    "branchPrefix": "tord/",
                },
                {
                    "summary": { "id": "p-other", "name": "other", "repositoryPath": "/Users/me/other" },
                    "remoteRepoPath": base.join("repos/other/repo.git"),
                    "remoteProjectRoot": base.join("worktrees/other"),
                    "gitUrl": "git@example.com:other.git",
                },
                {
                    "summary": { "id": "p-outside", "name": "outside", "repositoryPath": "/x" },
                    "remoteRepoPath": "/etc",
                    "remoteProjectRoot": base.join("worktrees/outside"),
                    "gitUrl": "git@example.com:x.git",
                },
            ],
            "presets": [
                {
                    "summary": {
                        "id": "claude",
                        "name": "Claude Code",
                        "launchModes": [{ "id": "yolo", "name": "YOLO" }],
                    },
                    "launches": [
                        {
                            "promptCommand": "claude {{prompt}}",
                            "openCommand": "claude",
                            "continueCommand": "claude --resume",
                        },
                        {
                            "launchModeId": "yolo",
                            "promptCommand": "claude --yolo {{prompt}}",
                            "openCommand": "claude --yolo",
                            "continueCommand": "claude --resume --yolo",
                        },
                    ],
                },
                {
                    "summary": { "id": "shell-only", "name": "Shell only", "launchModes": [] },
                    "launches": [],
                },
            ],
        })
    }

    #[test]
    fn offers_projects_set_up_on_this_host_and_agents_that_start_here() {
        let base = tempfile::tempdir().unwrap();
        fs::create_dir_all(base.path().join("repos/app/repo.git")).unwrap();
        let launch = HostLaunch::parse(launch_json(base.path()).to_string().as_bytes()).unwrap();

        let frame = launch.options_frame("r1", base.path(), "devbox", false);

        assert_eq!(frame["projects"][0]["id"], "p-app");
        assert_eq!(frame["projects"].as_array().unwrap().len(), 1);
        assert_eq!(frame["presets"][0]["id"], "claude");
        assert_eq!(frame["presets"].as_array().unwrap().len(), 1);
        assert_eq!(
            frame["environments"],
            json!([{ "kind": "ssh", "id": "host-1", "name": "devbox" }])
        );
        assert_eq!(frame["defaultLaunchModeId"], "yolo");
        assert!(launch.project(base.path(), "p-other").is_none());
        assert!(launch.project(base.path(), "p-outside").is_none());
    }

    #[test]
    fn sends_projects_icons_only_to_a_phone_that_agreed_to_them() {
        let base = tempfile::tempdir().unwrap();
        fs::create_dir_all(base.path().join("repos/app/repo.git")).unwrap();
        let mut file = launch_json(base.path());
        file["projects"][0]["summary"]["icon"] = json!("data:image/png;base64,iVBORw0KGgo=");
        let launch = HostLaunch::parse(file.to_string().as_bytes()).unwrap();

        let agreed = launch.options_frame("r1", base.path(), "devbox", true);
        let older = launch.options_frame("r1", base.path(), "devbox", false);

        assert_eq!(
            agreed["projects"][0]["icon"],
            "data:image/png;base64,iVBORw0KGgo="
        );
        assert!(older["projects"][0].get("icon").is_none());
    }

    #[test]
    fn offers_nothing_without_a_project_here_or_a_file() {
        let base = tempfile::tempdir().unwrap();
        let launch = HostLaunch::parse(launch_json(base.path()).to_string().as_bytes()).unwrap();
        let missing = HostLaunch::load(&base.path().join("launch.json")).unwrap();

        for launch in [launch, missing] {
            let frame = launch.options_frame("r1", base.path(), "devbox", false);
            assert_eq!(frame["projects"], json!([]));
            assert_eq!(frame["presets"], json!([]));
            assert_eq!(frame["environments"], json!([]));
        }
        assert!(HostLaunch::parse(br#"{"version":2,"hostId":"h"}"#).is_err());
    }

    #[test]
    fn picks_the_launch_mode_the_phone_asked_for() {
        let base = tempfile::tempdir().unwrap();
        let launch = HostLaunch::parse(launch_json(base.path()).to_string().as_bytes()).unwrap();
        let preset = launch.preset(None).unwrap();

        assert_eq!(preset.name(), "Claude Code");
        assert_eq!(
            preset.launch(Some("yolo")).unwrap().open_command,
            "claude --yolo"
        );
        assert_eq!(preset.launch(Some("gone")).unwrap().open_command, "claude");
        assert_eq!(
            preset.launch(None).unwrap().continue_command.as_deref(),
            Some("claude --resume")
        );
        assert!(launch.preset(Some("shell-only")).is_none());
    }
}
