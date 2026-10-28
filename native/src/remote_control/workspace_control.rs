//! What a phone changes on this host without the desktop: new workspaces, cut like an automation's
//! runs, starting and stopping a workspace's agent, and opening or closing its tabs. Every change
//! lands in the workspace manifests, so the desktop takes it in the next time it syncs.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};

use anyhow::{bail, Context};
use serde_json::{json, Value};

use super::launch::HostLaunch;
use super::workspaces::read_manifest;
use crate::automation::{inside, target_branch};
use crate::offline_workspace::{
    self, random_uuid, shell_quote, slug, terminal_environment, write_manifest, ManifestLaunch,
    OfflineCaller, OfflineLaunchRequest, SessionLauncher, TerminalSession, WorkspaceSource,
    SHELL_COMMAND,
};

/// Who wrote a manifest this host changed; any name but the desktop's own makes it merge the change.
const WRITTEN_BY: &str = "remote-companion";

/// Phone connections run on their own threads; one manifest edit at a time keeps a tab one of them
/// opens from being written over by another.
static EDITS: Mutex<()> = Mutex::new(());

fn editing() -> MutexGuard<'static, ()> {
    EDITS.lock().unwrap_or_else(PoisonError::into_inner)
}

#[derive(Debug, Default)]
pub(crate) struct CreateRequest {
    pub(crate) project_id: String,
    pub(crate) preset_id: Option<String>,
    pub(crate) launch_mode_id: Option<String>,
    pub(crate) name: Option<String>,
    pub(crate) branch: Option<String>,
    pub(crate) prompt: Option<String>,
}

/// The tab a phone asked to open.
pub(crate) enum TerminalSource {
    Shell,
    Agent {
        preset_id: String,
        launch_mode_id: Option<String>,
        prompt: Option<String>,
    },
}

/// Creates a workspace from a project the desktop shared and starts its agent. Returns its id.
pub(crate) fn create(
    caller: &OfflineCaller,
    launch: &HostLaunch,
    request: &CreateRequest,
    launcher: &mut dyn SessionLauncher,
    now_ms: u64,
) -> anyhow::Result<String> {
    let project = launch.project(&caller.base, &request.project_id).context(
        "This project isn't set up on this host yet. Start one workspace for it from Komla on your computer first.",
    )?;
    let preset = launch
        .preset(request.preset_id.as_deref())
        .context("This agent can't start on this host. Choose another.")?;
    let agent = preset
        .launch(request.launch_mode_id.as_deref())
        .context("This agent can't start on this host. Choose another.")?;
    let prefix = project.branch_prefix.as_deref().unwrap_or_default();
    let branch = match &request.branch {
        Some(branch) => Some(with_prefix(branch, prefix)),
        None if prefix.is_empty() => None,
        None => {
            let named = [&request.name, &request.prompt]
                .into_iter()
                .flatten()
                .map(|text| slug(text))
                .find(|slug| !slug.is_empty());
            Some(match named {
                Some(named) => format!("{prefix}{named}"),
                None => format!("{prefix}workspace-{}", &random_uuid()?[..6]),
            })
        }
    };
    let target_branch = target_branch(project);
    let source = WorkspaceSource {
        workspace_id: None,
        remote_directory: None,
        base_branch: project.base_branch.clone(),
        repo_name: project.project_name.clone(),
        remote_repo_path: project.remote_repo_path.clone(),
        remote_project_root: project.remote_project_root.clone(),
        git_url: project.git_url.clone(),
        project_name: project.project_name.clone(),
        backend_base_branch: project.base_branch.clone(),
        default_branch: project.default_branch.clone(),
        start_branch: target_branch.clone(),
        target_branch,
        launch: agent,
    };
    let created = offline_workspace::create_workspace_from(
        caller,
        &source,
        &OfflineLaunchRequest {
            prompt: request.prompt.clone(),
            name: request.name.clone(),
            description: None,
            branch,
            from_current_branch: false,
            cwd: None,
        },
        launcher,
        now_ms,
    )?;
    Ok(created.workspace_id)
}

/// `branch` under the project's prefix, as the desktop names it, without doubling a typed prefix.
fn with_prefix(branch: &str, prefix: &str) -> String {
    let rest = branch
        .get(..prefix.len())
        .filter(|head| head.eq_ignore_ascii_case(prefix))
        .map_or(branch, |_| &branch[prefix.len()..]);
    format!("{prefix}{rest}")
}

/// A workspace manifest this host may change, with the directory its terminals start in.
struct Editable {
    /// An object, as `read_manifest` checked.
    manifest: Value,
    directory: PathBuf,
}

impl Editable {
    fn load(base: &Path, workspace_id: &str) -> anyhow::Result<Self> {
        let manifest = read_manifest(base, workspace_id)
            .filter(Value::is_object)
            .context("This workspace is not on this host.")?;
        let directory = manifest["backend"]["remoteDirectory"]
            .as_str()
            .map(PathBuf::from)
            .filter(|directory| inside(directory, &base.join("worktrees")) && directory.is_dir())
            .context("This workspace's folder is missing on this host.")?;
        Ok(Self {
            manifest,
            directory,
        })
    }

    fn terminal_ids(&self) -> Vec<String> {
        terminal_ids(&self.manifest)
    }

    fn launch(&self) -> Option<ManifestLaunch> {
        serde_json::from_value(self.manifest.get("launch")?.clone()).ok()
    }

    fn base_branch(&self) -> String {
        let backend = &self.manifest["backend"];
        [
            &backend["baseBranch"],
            &self.manifest["baseBranch"],
            &backend["defaultBranch"],
        ]
        .into_iter()
        .find_map(|value| value.as_str().map(str::to_owned))
        .unwrap_or_else(|| "main".to_owned())
    }

    fn session(
        &self,
        caller: &OfflineCaller,
        workspace_id: &str,
        terminal_id: &str,
        command: String,
    ) -> TerminalSession {
        TerminalSession {
            terminal_id: terminal_id.to_owned(),
            directory: self.directory.clone(),
            environment: terminal_environment(
                caller,
                workspace_id,
                terminal_id,
                &self.directory,
                &self.base_branch(),
            ),
            command,
            installation_key: caller.installation_key.clone(),
            login_shell: caller.login_shell.clone(),
        }
    }

    /// Publishes the change as this host's, so the desktop merges it instead of overwriting it.
    fn save(mut self, base: &Path, workspace_id: &str, now_ms: u64) -> anyhow::Result<()> {
        self.manifest["updatedAt"] = json!(now_ms);
        self.manifest["writtenBy"] = json!(WRITTEN_BY);
        self.manifest["syncs"] = json!(true);
        write_manifest(base, workspace_id, &self.manifest)
    }

    fn remove(&mut self, key: &str) {
        if let Some(manifest) = self.manifest.as_object_mut() {
            manifest.remove(key);
        }
    }

    fn has_terminal(&self, terminal_id: &str) -> bool {
        self.manifest["terminals"]
            .as_array()
            .is_some_and(|terminals| {
                terminals
                    .iter()
                    .any(|terminal| terminal["id"] == terminal_id)
            })
    }
}

fn terminal_ids(manifest: &Value) -> Vec<String> {
    manifest["terminals"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|terminal| terminal["id"].as_str().map(str::to_owned))
        .collect()
}

/// Starts the workspace's agent afresh in one new tab, resuming its last session, as the desktop's
/// Start and Restart do. Tabs still running are stopped first. Returns the new tab's id.
pub(crate) fn start(
    caller: &OfflineCaller,
    workspace_id: &str,
    launcher: &mut dyn SessionLauncher,
    now_ms: u64,
) -> anyhow::Result<String> {
    let _editing = editing();
    let mut workspace = Editable::load(&caller.base, workspace_id)?;
    let launch = workspace.launch().context(
        "This workspace has no saved agent settings yet. Open it in Komla on your computer once.",
    )?;
    for terminal_id in workspace.terminal_ids() {
        launcher.stop(&terminal_id);
    }
    let terminal_id = random_uuid()?;
    let command = launch
        .continue_command
        .clone()
        .unwrap_or_else(|| launch.open_command.clone());
    launcher.start(&workspace.session(caller, workspace_id, &terminal_id, command))?;
    workspace.manifest["terminals"] =
        json!([{ "id": terminal_id, "name": launch.agent_name, "createdAt": now_ms }]);
    workspace.manifest["primaryTerminalId"] = json!(terminal_id);
    workspace.manifest["status"] = json!("active");
    workspace.remove("terminalLayout");
    workspace
        .save(&caller.base, workspace_id, now_ms)
        .inspect_err(|_| launcher.stop(&terminal_id))?;
    Ok(terminal_id)
}

/// Ends every tab's session; the tabs stay, stopped, as on the desktop. Only the manifest is needed,
/// so a workspace whose folder is gone can still be stopped.
pub(crate) fn stop(
    base: &Path,
    workspace_id: &str,
    launcher: &mut dyn SessionLauncher,
) -> anyhow::Result<()> {
    let _editing = editing();
    let manifest =
        read_manifest(base, workspace_id).context("This workspace is not on this host.")?;
    for terminal_id in terminal_ids(&manifest) {
        launcher.stop(&terminal_id);
    }
    Ok(())
}

/// Opens a tab with a shell or an agent the desktop shared. Returns its id.
pub(crate) fn add_terminal(
    caller: &OfflineCaller,
    launch: &HostLaunch,
    workspace_id: &str,
    source: &TerminalSource,
    launcher: &mut dyn SessionLauncher,
    now_ms: u64,
) -> anyhow::Result<String> {
    let _editing = editing();
    let mut workspace = Editable::load(&caller.base, workspace_id)?;
    let (name, command) = match source {
        TerminalSource::Shell => ("Terminal".to_owned(), SHELL_COMMAND.to_owned()),
        TerminalSource::Agent {
            preset_id,
            launch_mode_id,
            prompt,
        } => {
            let preset = launch
                .preset(Some(preset_id))
                .context("This agent can't start on this host. Choose another.")?;
            let agent = preset
                .launch(launch_mode_id.as_deref())
                .context("This agent can't start on this host. Choose another.")?;
            let command = match prompt {
                Some(prompt) => agent
                    .prompt_command
                    .replace("{{prompt}}", &shell_quote(prompt)),
                None => agent.open_command,
            };
            (agent.agent_name, command)
        }
    };
    let terminal_id = random_uuid()?;
    launcher.start(&workspace.session(caller, workspace_id, &terminal_id, command))?;
    let primary_listed = workspace.manifest["primaryTerminalId"]
        .as_str()
        .is_some_and(|primary| workspace.has_terminal(primary));
    if !workspace.manifest["terminals"].is_array() {
        workspace.manifest["terminals"] = json!([]);
    }
    if let Some(terminals) = workspace.manifest["terminals"].as_array_mut() {
        terminals.push(json!({ "id": terminal_id, "name": name, "createdAt": now_ms }));
    }
    if !primary_listed {
        workspace.manifest["primaryTerminalId"] = json!(terminal_id);
    }
    workspace
        .save(&caller.base, workspace_id, now_ms)
        .inspect_err(|_| launcher.stop(&terminal_id))?;
    Ok(terminal_id)
}

/// Ends a tab's session and removes it from the workspace.
pub(crate) fn close_terminal(
    base: &Path,
    workspace_id: &str,
    terminal_id: &str,
    launcher: &mut dyn SessionLauncher,
    now_ms: u64,
) -> anyhow::Result<()> {
    let _editing = editing();
    let mut workspace = Editable::load(base, workspace_id)?;
    if !workspace.has_terminal(terminal_id) {
        bail!("This tab is not in this workspace.");
    }
    launcher.stop(terminal_id);
    if let Some(terminals) = workspace.manifest["terminals"].as_array_mut() {
        terminals.retain(|terminal| terminal["id"] != terminal_id);
    }
    if workspace.manifest["primaryTerminalId"] == terminal_id {
        let next = workspace.manifest["terminals"][0]["id"].clone();
        if next.is_string() {
            workspace.manifest["primaryTerminalId"] = next;
        } else {
            workspace.remove("primaryTerminalId");
        }
    }
    workspace.save(base, workspace_id, now_ms)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::super::launch::tests::launch_json;
    use super::*;
    use crate::offline_workspace::tests::{host, RecordingLauncher};

    fn manifest(caller: &OfflineCaller, id: &str) -> Value {
        serde_json::from_slice(
            &fs::read(caller.base.join(format!("workspaces/{id}.json"))).unwrap(),
        )
        .unwrap()
    }

    fn host_launch(caller: &OfflineCaller) -> HostLaunch {
        HostLaunch::parse(launch_json(&caller.base).to_string().as_bytes()).unwrap()
    }

    #[test]
    fn creates_a_workspace_on_the_project_prefix_with_the_chosen_agent() {
        let (_temp, caller) = host();
        let mut launcher = RecordingLauncher::new();

        let workspace_id = create(
            &caller,
            &host_launch(&caller),
            &CreateRequest {
                project_id: "p-app".to_owned(),
                preset_id: Some("claude".to_owned()),
                launch_mode_id: Some("yolo".to_owned()),
                prompt: Some("Fix the login page".to_owned()),
                ..CreateRequest::default()
            },
            &mut launcher,
            5_000,
        )
        .unwrap();

        let written = manifest(&caller, &workspace_id);
        assert_eq!(written["branchName"], "tord/fix-the-login-page");
        assert_eq!(written["adoptOnConnect"], true);
        assert_eq!(
            written["launch"]["continueCommand"],
            "claude --resume --yolo"
        );
        assert_eq!(
            launcher.started[0].command,
            "claude --yolo 'Fix the login page'"
        );
        assert!(caller
            .base
            .join("worktrees/app/tord-fix-the-login-page")
            .is_dir());
    }

    #[test]
    fn puts_a_chosen_branch_under_the_project_prefix_once() {
        assert_eq!(with_prefix("fix-login", "tord/"), "tord/fix-login");
        assert_eq!(with_prefix("Tord/fix-login", "tord/"), "tord/fix-login");
        assert_eq!(with_prefix("fix-login", ""), "fix-login");
        assert_eq!(with_prefix("tø", "tord/"), "tord/tø");
    }

    #[test]
    fn refuses_a_project_not_set_up_here() {
        let (_temp, caller) = host();
        let mut launcher = RecordingLauncher::new();

        let error = create(
            &caller,
            &host_launch(&caller),
            &CreateRequest {
                project_id: "p-other".to_owned(),
                ..CreateRequest::default()
            },
            &mut launcher,
            5_000,
        )
        .unwrap_err();

        assert!(error.to_string().contains("isn't set up on this host"));
        assert!(launcher.started.is_empty());
    }

    #[test]
    fn starts_a_workspace_again_in_one_resumed_tab() {
        let (_temp, caller) = host();
        let mut written = manifest(&caller, "ws-1");
        written["terminals"] = json!([{ "id": "old", "name": "Claude Code", "createdAt": 1 }]);
        written["launch"]["continueCommand"] = json!("claude --resume");
        written["terminalLayout"] = json!({ "tabs": ["old"], "layouts": {} });
        written["status"] = json!("stashed");
        written["writtenBy"] = json!("desktop-a");
        write_manifest(&caller.base, "ws-1", &written).unwrap();
        let mut launcher = RecordingLauncher::new();

        let terminal_id = start(&caller, "ws-1", &mut launcher, 9_000).unwrap();

        assert_eq!(launcher.stopped, ["old"]);
        assert_eq!(launcher.started[0].command, "claude --resume");
        assert!(launcher.started[0]
            .environment
            .contains(&("KOMLA_WORKSPACE_ID".to_owned(), "ws-1".to_owned())));
        let after = manifest(&caller, "ws-1");
        assert_eq!(after["terminals"][0]["id"], terminal_id.as_str());
        assert_eq!(after["primaryTerminalId"], terminal_id.as_str());
        assert_eq!(after["status"], "active");
        assert_eq!(after["writtenBy"], WRITTEN_BY);
        assert_eq!(after["syncs"], true);
        assert_eq!(after["updatedAt"], 9_000);
        assert!(after.get("terminalLayout").is_none());
        assert_eq!(after["name"], "First task");
    }

    #[test]
    fn opens_and_closes_tabs() {
        let (_temp, caller) = host();
        let launch = host_launch(&caller);
        let mut launcher = RecordingLauncher::new();

        let agent = add_terminal(
            &caller,
            &launch,
            "ws-1",
            &TerminalSource::Agent {
                preset_id: "claude".to_owned(),
                launch_mode_id: None,
                prompt: Some("it's late".to_owned()),
            },
            &mut launcher,
            2,
        )
        .unwrap();
        let shell = add_terminal(
            &caller,
            &launch,
            "ws-1",
            &TerminalSource::Shell,
            &mut launcher,
            3,
        )
        .unwrap();

        assert_eq!(launcher.started[0].command, r"claude 'it'\''s late'");
        assert_eq!(launcher.started[1].command, SHELL_COMMAND);
        let opened = manifest(&caller, "ws-1");
        assert_eq!(opened["terminals"][0]["name"], "Claude Code");
        assert_eq!(opened["terminals"][1]["name"], "Terminal");
        assert_eq!(opened["primaryTerminalId"], agent.as_str());

        close_terminal(&caller.base, "ws-1", &agent, &mut launcher, 4).unwrap();

        assert_eq!(launcher.stopped, [agent.clone()]);
        let closed = manifest(&caller, "ws-1");
        assert_eq!(closed["terminals"].as_array().unwrap().len(), 1);
        assert_eq!(closed["primaryTerminalId"], shell.as_str());
        assert!(close_terminal(&caller.base, "ws-1", &agent, &mut launcher, 5).is_err());
    }

    #[test]
    fn leaves_the_manifest_alone_when_the_session_does_not_start() {
        let (_temp, caller) = host();
        let before = manifest(&caller, "ws-1");
        let mut launcher = RecordingLauncher::new();
        launcher.fail = true;

        assert!(add_terminal(
            &caller,
            &host_launch(&caller),
            "ws-1",
            &TerminalSource::Shell,
            &mut launcher,
            2,
        )
        .is_err());
        assert!(start(&caller, "ws-1", &mut launcher, 2).is_err());

        assert_eq!(manifest(&caller, "ws-1"), before);
    }

    #[test]
    fn refuses_workspaces_outside_this_hosts_data() {
        let (_temp, caller) = host();
        let mut written = manifest(&caller, "ws-1");
        written["backend"]["remoteDirectory"] = json!("/tmp");
        write_manifest(&caller.base, "ws-1", &written).unwrap();
        let mut launcher = RecordingLauncher::new();

        assert!(start(&caller, "ws-1", &mut launcher, 2).is_err());
        assert!(stop(&caller.base, "ws-missing", &mut launcher).is_err());
        assert!(launcher.started.is_empty());
    }

    #[test]
    fn stops_a_workspace_whose_folder_is_gone() {
        let (_temp, caller) = host();
        let mut written = manifest(&caller, "ws-1");
        written["terminals"] = json!([{ "id": "old", "name": "Claude Code", "createdAt": 1 }]);
        write_manifest(&caller.base, "ws-1", &written).unwrap();
        let directory = written["backend"]["remoteDirectory"].as_str().unwrap();
        fs::remove_dir_all(directory).unwrap();
        let mut launcher = RecordingLauncher::new();

        stop(&caller.base, "ws-1", &mut launcher).unwrap();

        assert_eq!(launcher.stopped, ["old"]);
    }
}
