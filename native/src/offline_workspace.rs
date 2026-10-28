//! Creates SSH workspaces on the host while no Komla installation is connected.
//!
//! Every Komla installation publishes a manifest for each of its workspaces at
//! `<base>/workspaces/<id>.json`. A new workspace is cut from the same bare
//! repository as the workspace it was requested from, its agent starts in a
//! managed tmux session, and its manifest asks the next installation that
//! connects to add it.

use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use anyhow::{bail, Context};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const MANIFEST_DIRECTORY: &str = "workspaces";
const MAX_MANIFEST_BYTES: u64 = 256 * 1024;
const MAX_NAME_ATTEMPTS: u32 = 50;
const FETCH_TIMEOUT: Duration = Duration::from_secs(30);
pub(crate) const TMUX_SOCKET_NAME: &str = "komla-v1";
/// Installed by the desktop under `helpers/`; the single definition of the managed server's settings.
const SERVER_SETUP_SCRIPT: &str = "tmux-server.sh";

/// Environment a Komla terminal launches with that a sibling terminal shares unchanged.
const SHARED_TERMINAL_ENVIRONMENT: &[&str] = &[
    "KOMLA_NOTIFY_HOST",
    "KOMLA_NOTIFY_PORT",
    "KOMLA_MCP_PORT",
    "KOMLA_CLI",
    "KOMLA_NOTIFY_SCRIPT",
    "KOMLA_COMPANION_SESSION",
    "KOMLA_COMPANION_TMUX_SOCKET",
    "COLORTERM",
    "FORCE_HYPERLINK",
];

#[derive(Clone, Debug, Default)]
pub(crate) struct OfflineLaunchRequest {
    pub(crate) prompt: Option<String>,
    pub(crate) name: Option<String>,
    pub(crate) description: Option<String>,
    pub(crate) branch: Option<String>,
    /// Start from the branch checked out in the source workspace instead of its base branch.
    pub(crate) from_current_branch: bool,
    /// Directory to resolve the source workspace from, instead of the caller's.
    pub(crate) cwd: Option<PathBuf>,
}

/// The terminal asking for a workspace, and the routing its sibling inherits.
#[derive(Clone, Debug, Default)]
pub(crate) struct OfflineCaller {
    /// Komla's data directory on this host.
    pub(crate) base: PathBuf,
    pub(crate) workspace_id: Option<String>,
    pub(crate) cwd: PathBuf,
    pub(crate) api_url: Option<String>,
    pub(crate) companion_inbox: Option<String>,
    pub(crate) installation_key: Option<String>,
    pub(crate) target_branch: Option<String>,
    pub(crate) shared_environment: Vec<(String, String)>,
    /// The shell agents start in, when the caller's `SHELL` can't be trusted (cron sets `/bin/sh`).
    pub(crate) login_shell: Option<PathBuf>,
}

impl OfflineCaller {
    pub(crate) fn shared_environment_from_process() -> Vec<(String, String)> {
        SHARED_TERMINAL_ENVIRONMENT
            .iter()
            .filter_map(|name| {
                std::env::var(name)
                    .ok()
                    .filter(|value| !value.is_empty())
                    .map(|value| ((*name).to_owned(), value))
            })
            .collect()
    }
}

/// A managed terminal session to start for the new workspace's agent.
#[derive(Clone, Debug)]
pub(crate) struct TerminalSession {
    pub(crate) terminal_id: String,
    pub(crate) directory: PathBuf,
    pub(crate) environment: Vec<(String, String)>,
    pub(crate) command: String,
    pub(crate) installation_key: Option<String>,
    /// Replaces `SHELL` as the shell the agent starts in.
    pub(crate) login_shell: Option<PathBuf>,
}

pub(crate) trait SessionLauncher {
    fn start(&mut self, session: &TerminalSession) -> anyhow::Result<()>;
    fn stop(&mut self, terminal_id: &str);
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CreatedWorkspace {
    pub(crate) workspace_id: String,
    pub(crate) terminal_id: String,
    pub(crate) name: String,
    pub(crate) branch: String,
    pub(crate) path: PathBuf,
    pub(crate) agent_name: String,
    pub(crate) branched_from: Option<String>,
}

impl CreatedWorkspace {
    /// The shape Komla returns for an `agent.launch` into a new workspace.
    pub(crate) fn operation_result(&self) -> Value {
        let mut result = json!({
            "state": "started",
            "offline": true,
            "destination": {
                "kind": "workspace",
                "workspaceId": self.workspace_id,
                "path": self.path,
                "branch": self.branch,
            },
            "agent": {"preset": {"name": self.agent_name}},
        });
        if let Some(branched_from) = &self.branched_from {
            result["destination"]["branchedFrom"] = json!(branched_from);
        }
        result
    }

    pub(crate) fn summary(&self) -> String {
        let mut summary = format!(
            "Komla isn't connected, so {} started in a new workspace on this host. \
It will appear in Komla the next time a device connects.\nBranch: {}\nPath: {}",
            self.agent_name,
            self.branch,
            self.path.display()
        );
        if let Some(branched_from) = &self.branched_from {
            summary.push_str(&format!(
                "\nBranched from: {branched_from} (committed work only)"
            ));
        }
        summary
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ManifestLaunch {
    pub(crate) agent_name: String,
    pub(crate) prompt_command: String,
    pub(crate) open_command: String,
    /// Resumes the agent's last session when the workspace starts again.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) continue_command: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestBackend {
    remote_directory: PathBuf,
    remote_repo_path: PathBuf,
    remote_project_root: PathBuf,
    git_url: String,
    project_name: Option<String>,
    base_branch: Option<String>,
    default_branch: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourceManifest {
    schema: u32,
    workspace_id: String,
    base_branch: Option<String>,
    repo_name: Option<String>,
    backend: ManifestBackend,
    launch: Option<ManifestLaunch>,
}

/// What a new workspace is cut from: a repository, where its worktree goes,
/// and how to start its agent.
#[derive(Clone, Debug)]
pub(crate) struct WorkspaceSource {
    /// The workspace an agent asked from, if any.
    pub(crate) workspace_id: Option<String>,
    /// That workspace's directory, to branch from what it has checked out.
    pub(crate) remote_directory: Option<PathBuf>,
    /// Copied to the new manifest as is.
    pub(crate) base_branch: Option<String>,
    pub(crate) repo_name: Option<String>,
    pub(crate) remote_repo_path: PathBuf,
    pub(crate) remote_project_root: PathBuf,
    pub(crate) git_url: String,
    pub(crate) project_name: Option<String>,
    pub(crate) backend_base_branch: Option<String>,
    pub(crate) default_branch: Option<String>,
    /// The branch new work starts from, already checked with `is_valid_branch`.
    pub(crate) start_branch: String,
    /// The branch the new workspace's agent is told it targets.
    pub(crate) target_branch: String,
    pub(crate) launch: ManifestLaunch,
}

pub(crate) fn create_workspace(
    caller: &OfflineCaller,
    request: &OfflineLaunchRequest,
    launcher: &mut dyn SessionLauncher,
    now_ms: u64,
) -> anyhow::Result<CreatedWorkspace> {
    let source = match &request.cwd {
        Some(cwd) => find_source_manifest(&OfflineCaller {
            cwd: cwd.clone(),
            ..caller.clone()
        })?,
        None => find_source_manifest(caller)?,
    };
    let launch = source.launch.clone().context(
        "Komla isn't connected, and this workspace has no saved agent settings yet. \
Open Komla on any device once so it can save them, then try again.",
    )?;
    let backend = source.backend;
    let base_branch = backend
        .base_branch
        .clone()
        .or_else(|| source.base_branch.clone())
        .or_else(|| backend.default_branch.clone())
        .or_else(|| caller.target_branch.clone())
        .unwrap_or_else(|| "main".to_owned());
    if !is_valid_branch(&base_branch) {
        bail!("this workspace's base branch {base_branch:?} is not a valid branch name");
    }
    let source = WorkspaceSource {
        workspace_id: Some(source.workspace_id),
        remote_directory: Some(backend.remote_directory),
        base_branch: source.base_branch,
        repo_name: source.repo_name,
        remote_repo_path: backend.remote_repo_path,
        remote_project_root: backend.remote_project_root,
        git_url: backend.git_url,
        project_name: backend.project_name,
        backend_base_branch: backend.base_branch,
        default_branch: backend.default_branch,
        target_branch: base_branch.clone(),
        start_branch: base_branch,
        launch,
    };
    create_workspace_from(caller, &source, request, launcher, now_ms)
}

/// Creates a workspace from a resolved source, with its agent started in a
/// managed session and a manifest asking the next installation to add it.
pub(crate) fn create_workspace_from(
    caller: &OfflineCaller,
    source: &WorkspaceSource,
    request: &OfflineLaunchRequest,
    launcher: &mut dyn SessionLauncher,
    now_ms: u64,
) -> anyhow::Result<CreatedWorkspace> {
    let launch = &source.launch;
    let base_branch = &source.start_branch;
    let repo = &source.remote_repo_path;

    let branched_from = if request.from_current_branch {
        let directory = source
            .remote_directory
            .as_deref()
            .context("this workspace has no branch checked out to start from")?;
        Some(checked_out_branch(repo, directory)?)
    } else {
        None
    };
    let start_ref = match &branched_from {
        // Worktrees share the repository, so the branch has every local commit.
        Some(branch) => format!("refs/heads/{branch}"),
        None => {
            fetch_best_effort(repo, base_branch);
            [
                format!("refs/remotes/origin/{base_branch}"),
                format!("refs/heads/{base_branch}"),
            ]
            .into_iter()
            .find(|candidate| ref_exists(repo, &format!("{candidate}^{{commit}}")))
            .with_context(|| {
                format!("the base branch {base_branch} is not available on this host")
            })?
        }
    };

    let requested = branch_request(request)?;
    let (branch, directory) = (1..=MAX_NAME_ATTEMPTS)
        .map(|attempt| {
            let branch = if attempt == 1 {
                requested.clone()
            } else {
                format!("{requested}-{attempt}")
            };
            let directory = source.remote_project_root.join(branch.replace('/', "-"));
            (branch, directory)
        })
        .find(|(branch, directory)| {
            !directory.exists() && !ref_exists(repo, &format!("refs/heads/{branch}"))
        })
        .with_context(|| format!("could not find a free branch name based on {requested}"))?;

    let added = git(repo)
        .args(["worktree", "add", "--no-track", "-b", &branch])
        .arg(&directory)
        .arg(&start_ref)
        .output()
        .context("could not run git")?;
    if !added.status.success() {
        bail!(
            "could not create the worktree: {}",
            String::from_utf8_lossy(&added.stderr).trim()
        );
    }

    let workspace_id = random_uuid()?;
    let terminal_id = random_uuid()?;
    let name = request
        .name
        .clone()
        .unwrap_or_else(|| title_from_branch(&branch));
    let created = CreatedWorkspace {
        workspace_id: workspace_id.clone(),
        terminal_id: terminal_id.clone(),
        name: name.clone(),
        branch: branch.clone(),
        path: directory.clone(),
        agent_name: launch.agent_name.clone(),
        branched_from: branched_from.clone(),
    };
    let session = TerminalSession {
        terminal_id: terminal_id.clone(),
        directory: directory.clone(),
        environment: terminal_environment(
            caller,
            &workspace_id,
            &terminal_id,
            &directory,
            &source.target_branch,
        ),
        command: match &request.prompt {
            Some(prompt) => launch
                .prompt_command
                .replace("{{prompt}}", &shell_quote(prompt)),
            None => launch.open_command.clone(),
        },
        installation_key: caller.installation_key.clone(),
        login_shell: caller.login_shell.clone(),
    };
    let manifest = json!({
        "schema": 1,
        "workspaceId": workspace_id,
        "name": name,
        "customName": request.name,
        "customDescription": request.description,
        "branchName": branch,
        "baseBranch": source.base_branch,
        "repoName": source.repo_name,
        "backend": {
            "remoteDirectory": directory,
            "remoteRepoPath": source.remote_repo_path,
            "remoteProjectRoot": source.remote_project_root,
            "gitUrl": source.git_url,
            "projectName": source.project_name,
            "branchName": branch,
            "baseBranch": source.backend_base_branch,
            "defaultBranch": source.default_branch,
            "startPoint": branched_from.as_ref().unwrap_or(base_branch),
        },
        "terminals": [{"id": terminal_id, "name": launch.agent_name, "createdAt": now_ms}],
        "primaryTerminalId": terminal_id,
        "createdAt": now_ms,
        "updatedAt": now_ms,
        "launch": launch,
        "sourceWorkspaceId": source.workspace_id,
        "adoptOnConnect": true,
    });

    let started = launcher.start(&session).and_then(|()| {
        write_manifest(&caller.base, &workspace_id, &manifest).inspect_err(|_| {
            launcher.stop(&terminal_id);
        })
    });
    if let Err(error) = started {
        remove_worktree(repo, &directory, &branch);
        return Err(error);
    }
    Ok(created)
}

fn find_source_manifest(caller: &OfflineCaller) -> anyhow::Result<SourceManifest> {
    let directory = caller.base.join(MANIFEST_DIRECTORY);
    if let Some(manifest) = caller
        .workspace_id
        .as_deref()
        .filter(|id| is_manifest_id(id))
        .and_then(|id| read_manifest(&directory.join(format!("{id}.json"))))
    {
        return validate_source(caller, manifest);
    }
    // A shell outside a Komla terminal still resolves its workspace from its directory.
    let mut best: Option<SourceManifest> = None;
    for entry in fs::read_dir(&directory).into_iter().flatten().flatten() {
        let Some(manifest) = read_manifest(&entry.path()) else {
            continue;
        };
        if !caller.cwd.starts_with(&manifest.backend.remote_directory) {
            continue;
        }
        let depth = manifest.backend.remote_directory.components().count();
        if best
            .as_ref()
            .is_some_and(|current| current.backend.remote_directory.components().count() >= depth)
        {
            continue;
        }
        best = Some(manifest);
    }
    validate_source(
        caller,
        best.context(
            "Komla isn't connected, and this directory isn't part of a Komla workspace on this host",
        )?,
    )
}

fn read_manifest(path: &Path) -> Option<SourceManifest> {
    if path.extension()? != "json" || fs::metadata(path).ok()?.len() > MAX_MANIFEST_BYTES {
        return None;
    }
    let manifest: SourceManifest = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    (manifest.schema == 1 && is_manifest_id(&manifest.workspace_id)).then_some(manifest)
}

/// Manifests are written by other installations, so keep their paths inside this host's data.
fn validate_source(
    caller: &OfflineCaller,
    manifest: SourceManifest,
) -> anyhow::Result<SourceManifest> {
    let backend = &manifest.backend;
    let inside = |path: &Path, root: &Path| {
        path.components()
            .all(|component| matches!(component, Component::RootDir | Component::Normal(_)))
            && path.starts_with(root)
            && path != root
    };
    if !inside(&backend.remote_project_root, &caller.base.join("worktrees"))
        || !inside(&backend.remote_repo_path, &caller.base.join("repos"))
    {
        bail!("this workspace's files are outside Komla's data directory on this host");
    }
    Ok(manifest)
}

fn is_manifest_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

/// Branch names come from untrusted manifests and reach git as arguments.
pub(crate) fn is_valid_branch(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('-')
        && Command::new("git")
            .args(["check-ref-format", "--branch", name])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
}

fn branch_request(request: &OfflineLaunchRequest) -> anyhow::Result<String> {
    if let Some(branch) = &request.branch {
        let sanitized = sanitize_branch(branch);
        if !is_valid_branch(&sanitized) {
            bail!("{branch} is not a valid branch name");
        }
        return Ok(sanitized);
    }
    let from_text = [&request.name, &request.prompt]
        .into_iter()
        .flatten()
        .map(|text| slug(text))
        .find(|slug| !slug.is_empty());
    match from_text {
        Some(slug) => Ok(slug),
        None => Ok(format!("workspace-{}", &random_uuid()?[..6])),
    }
}

/// Keeps a requested branch name's readable parts and drops what git or a path would reject.
fn sanitize_branch(raw: &str) -> String {
    let replaced: String = raw
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-' | '/') {
                character
            } else {
                '-'
            }
        })
        .collect();
    replaced
        .split('/')
        .map(|part| {
            let mut part = part.trim_matches(|c| c == '.' || c == '-').to_owned();
            while part.contains("--") {
                part = part.replace("--", "-");
            }
            while part.contains("..") {
                part = part.replace("..", ".");
            }
            part.strip_suffix(".lock").unwrap_or(&part).to_owned()
        })
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("/")
}

/// A short branch name from free text: the first few words, lowercase and hyphenated.
pub(crate) fn slug(text: &str) -> String {
    let words: Vec<String> = text
        .split(|character: char| !character.is_ascii_alphanumeric())
        .filter(|word| !word.is_empty())
        .take(5)
        .map(str::to_ascii_lowercase)
        .collect();
    let mut slug = words.join("-");
    if slug.len() > 40 {
        slug.truncate(40);
        slug = slug.trim_end_matches('-').to_owned();
    }
    slug
}

fn title_from_branch(branch: &str) -> String {
    branch
        .rsplit('/')
        .next()
        .unwrap_or(branch)
        .split('-')
        .filter(|word| !word.is_empty())
        .map(|word| {
            let mut characters = word.chars();
            characters
                .next()
                .map(|first| first.to_uppercase().chain(characters).collect::<String>())
                .unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

pub(crate) fn terminal_environment(
    caller: &OfflineCaller,
    workspace_id: &str,
    terminal_id: &str,
    directory: &Path,
    target_branch: &str,
) -> Vec<(String, String)> {
    let mut environment = caller.shared_environment.clone();
    if let Some(api_url) = &caller.api_url {
        let origin = api_url
            .split_once("/terminals/")
            .map_or(api_url.as_str(), |(origin, _)| origin)
            .trim_end_matches('/');
        environment.push((
            "KOMLA_API_URL".to_owned(),
            format!("{origin}/terminals/{terminal_id}"),
        ));
    }
    let values = [
        ("KOMLA_COMPANION_INBOX", caller.companion_inbox.clone()),
        ("KOMLA_INSTALLATION_KEY", caller.installation_key.clone()),
        ("KOMLA_TERMINAL_ID", Some(terminal_id.to_owned())),
        ("KOMLA_WORKSPACE_ID", Some(workspace_id.to_owned())),
        (
            "KOMLA_REMOTE_WORKSPACE_DIR",
            Some(directory.to_string_lossy().into_owned()),
        ),
        ("KOMLA_TARGET_BRANCH", Some(target_branch.to_owned())),
    ];
    for (name, value) in values {
        if let Some(value) = value {
            environment.push((name.to_owned(), value));
        }
    }
    environment
}

pub(crate) fn git(repo: &Path) -> Command {
    let mut command = Command::new("git");
    command.arg("-C").arg(repo).stdin(Stdio::null());
    command
}

/// The branch checked out in a worktree, read from the repository it shares
/// rather than from the manifest's directory.
fn checked_out_branch(repo: &Path, directory: &Path) -> anyhow::Result<String> {
    let listed = git(repo)
        .args(["worktree", "list", "--porcelain"])
        .output()
        .context("could not run git")?;
    if !listed.status.success() {
        bail!(
            "could not read this workspace's branch: {}",
            String::from_utf8_lossy(&listed.stderr).trim()
        );
    }
    let canonical = |path: &Path| fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let directory = canonical(directory);
    let stdout = String::from_utf8_lossy(&listed.stdout);
    let branch = stdout
        .split("\n\n")
        .find(|entry| {
            entry
                .lines()
                .find_map(|line| line.strip_prefix("worktree "))
                .is_some_and(|path| canonical(Path::new(path)) == directory)
        })
        .and_then(|entry| {
            entry
                .lines()
                .find_map(|line| line.strip_prefix("branch refs/heads/"))
        })
        .filter(|branch| is_valid_branch(branch))
        .context("this workspace has no branch checked out to start from")?;
    Ok(branch.to_owned())
}

fn ref_exists(repo: &Path, reference: &str) -> bool {
    git(repo)
        .args(["rev-parse", "--verify", "--quiet", reference])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

/// Refreshes the base branch when the host can reach origin without prompting.
/// Credentials forwarded by Komla are gone while it is disconnected.
fn fetch_best_effort(repo: &Path, base_branch: &str) {
    let mut command = git(repo);
    command
        .args(["fetch", "--quiet", "--", "origin", base_branch])
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if std::env::var_os("GIT_SSH_COMMAND").is_none() && std::env::var_os("GIT_SSH").is_none() {
        command.env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes");
    }
    let Ok(mut child) = command.spawn() else {
        return;
    };
    let deadline = Instant::now() + FETCH_TIMEOUT;
    while Instant::now() < deadline {
        if !matches!(child.try_wait(), Ok(None)) {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn remove_worktree(repo: &Path, directory: &Path, branch: &str) {
    let _ = git(repo)
        .args(["worktree", "remove", "--force"])
        .arg(directory)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    let _ = git(repo)
        .args(["branch", "-D", branch])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

/// Komla reads absent manifest fields as missing, but rejects nulls.
fn without_nulls(value: &Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.iter()
                .filter(|(_, value)| !value.is_null())
                .map(|(key, value)| (key.clone(), without_nulls(value)))
                .collect(),
        ),
        Value::Array(values) => Value::Array(values.iter().map(without_nulls).collect()),
        value => value.clone(),
    }
}

pub(crate) fn write_manifest(
    base: &Path,
    workspace_id: &str,
    manifest: &Value,
) -> anyhow::Result<()> {
    let directory = base.join(MANIFEST_DIRECTORY);
    fs::create_dir_all(&directory)
        .with_context(|| format!("could not create {}", directory.display()))?;
    let temporary = directory.join(format!(".{workspace_id}.json.tmp"));
    let mut content = serde_json::to_vec_pretty(&without_nulls(manifest))?;
    content.push(b'\n');
    fs::write(&temporary, content)
        .with_context(|| format!("could not write {}", temporary.display()))?;
    fs::rename(&temporary, directory.join(format!("{workspace_id}.json")))
        .context("could not publish the workspace manifest")
}

pub(crate) fn random_uuid() -> anyhow::Result<String> {
    let mut bytes = [0_u8; 16];
    fs::File::open("/dev/urandom")
        .and_then(|mut source| source.read_exact(&mut bytes))
        .context("could not read random bytes")?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    ))
}

pub(crate) fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// What a plain shell tab runs inside the login flow: the user's interactive shell.
pub(crate) const SHELL_COMMAND: &str =
    r#"if [ -x "${SHELL:-/bin/bash}" ]; then exec "${SHELL:-/bin/bash}" -i; fi; exec /bin/sh -i"#;

/// The script a managed session runs: the same login flow Komla uses for SSH terminals.
/// `pty_proxy`, the companion's own executable, runs the shell to carry its OSC 7501 statuses
/// past tmux.
pub(crate) fn session_command(session: &TerminalSession, pty_proxy: Option<&Path>) -> String {
    let mut login: Vec<String> = session
        .environment
        .iter()
        .map(|(name, value)| format!("export {name}={}", shell_quote(value)))
        .collect();
    let open_shell = [
        r#"if [ -x "${SHELL:-/bin/bash}" ]; then exec "${SHELL:-/bin/bash}" -i; fi"#,
        "exec /bin/sh -i",
    ];
    login.push(
        r#"if [ -n "${KOMLA_CLI-}" ]; then PATH="${KOMLA_CLI%/*}:${PATH-}"; export PATH; fi"#
            .to_owned(),
    );
    login.push(session.command.clone());
    login.push("command_status=$?".to_owned());
    login.push(r#"if [ "$command_status" -ne 0 ]; then"#.to_owned());
    login.push(
        r#"  printf "\033[31m[komla] Agent command failed with exit code %s.\033[0m\n" "$command_status" >&2"#
            .to_owned(),
    );
    login.push(
        r#"  printf "\033[33m[komla] Starting a remote shell so you can fix the problem.\033[0m\n" >&2"#
            .to_owned(),
    );
    login.extend(open_shell.iter().map(|line| format!("  {line}")));
    login.push("fi".to_owned());
    let login = login.join("\n");
    // A companion whose binary was replaced since it started can't run it anymore.
    let run_shell = match pty_proxy {
        Some(path) => {
            let path = shell_quote(&path.to_string_lossy());
            format!(
                "if [ -x {path} ] && {path} __pty-proxy --check >/dev/null 2>&1; then\n  \
                 run_shell() {{ exec {path} __pty-proxy \"$@\"; }}\nelse\n  \
                 run_shell() {{ exec \"$@\"; }}\nfi"
            )
        }
        None => r#"run_shell() { exec "$@"; }"#.to_owned(),
    };
    [
        format!(
            "cd {} || exit 1",
            shell_quote(&session.directory.to_string_lossy())
        ),
        match &session.login_shell {
            Some(shell) => {
                let shell = shell_quote(&shell.to_string_lossy());
                format!("remote_shell={shell}\nSHELL={shell}\nexport SHELL")
            }
            None => "remote_shell=${SHELL:-/bin/bash}".to_owned(),
        },
        run_shell,
        format!(
            r#"if [ -x "$remote_shell" ]; then run_shell "$remote_shell" -lic {}; fi"#,
            shell_quote(&login)
        ),
        format!("run_shell /bin/sh -lc {}", shell_quote(&login)),
    ]
    .join("\n")
}

/// Starts sessions on Komla's managed tmux server, where devices reattach to them.
pub(crate) struct TmuxSessionLauncher {
    /// Script the desktop installs to start and configure the managed server.
    pub(crate) server_setup: PathBuf,
    socket: String,
}

impl TmuxSessionLauncher {
    pub(crate) fn new(base: &Path) -> Self {
        Self::on_socket(base, TMUX_SOCKET_NAME)
    }

    pub(crate) fn on_socket(base: &Path, socket: &str) -> Self {
        Self {
            server_setup: base.join("helpers").join(SERVER_SETUP_SCRIPT),
            socket: socket.to_owned(),
        }
    }

    /// Applies Komla's server settings, starting the server without the user's
    /// tmux configuration when it isn't running.
    fn prepare_server(&self) -> anyhow::Result<()> {
        if !self.server_setup.is_file() {
            let running = self
                .tmux()
                .arg("has-session")
                .stderr(Stdio::null())
                .status()
                .is_ok_and(|status| status.success());
            if running {
                return Ok(());
            }
            bail!(
                "Komla's terminal server isn't running on this host and its settings haven't been \
saved here yet. Open Komla on any device once, then try again."
            );
        }
        let prepared = Command::new("/bin/sh")
            .arg(&self.server_setup)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .output()
            .context("could not run Komla's terminal server setup")?;
        if !prepared.status.success() {
            bail!(
                "could not prepare Komla's terminal server: {}",
                String::from_utf8_lossy(&prepared.stderr).trim()
            );
        }
        Ok(())
    }

    fn tmux(&self) -> Command {
        let mut command = Command::new("tmux");
        command
            .args(["-L", &self.socket])
            .env_remove("TMUX")
            .stdin(Stdio::null())
            .stdout(Stdio::null());
        command
    }
}

impl SessionLauncher for TmuxSessionLauncher {
    fn start(&mut self, session: &TerminalSession) -> anyhow::Result<()> {
        self.prepare_server()?;
        let name = format!("komla-{}", session.terminal_id);
        let pty_proxy = std::env::current_exe().ok().filter(|_| cfg!(unix));
        let started = self
            .tmux()
            .args([
                "new-session",
                "-d",
                "-s",
                &name,
                &session_command(session, pty_proxy.as_deref()),
            ])
            .stderr(Stdio::piped())
            .output()
            .context("could not run tmux")?;
        if !started.status.success() {
            bail!(
                "could not start the agent's terminal session: {}",
                String::from_utf8_lossy(&started.stderr).trim()
            );
        }
        let target = format!("={name}");
        for variable in [
            "KOMLA_API_URL",
            "KOMLA_TERMINAL_ID",
            "KOMLA_WORKSPACE_ID",
            "KOMLA_COMPANION_INBOX",
        ] {
            let value = session
                .environment
                .iter()
                .find(|(candidate, _)| candidate == variable)
                .map_or("", |(_, value)| value.as_str());
            let _ = self
                .tmux()
                .args(["set-environment", "-t", &target, variable, value])
                .stderr(Stdio::null())
                .status();
        }
        // tmux resolves set-option targets as panes, which reject the exact-match prefix.
        let _ = self
            .tmux()
            .args([
                "set-option",
                "-t",
                &name,
                "@komla_installation_key",
                session.installation_key.as_deref().unwrap_or(""),
            ])
            .stderr(Stdio::null())
            .status();
        Ok(())
    }

    fn stop(&mut self, terminal_id: &str) {
        let _ = self
            .tmux()
            .args(["kill-session", "-t", &format!("=komla-{terminal_id}")])
            .stderr(Stdio::null())
            .status();
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) struct RecordingLauncher {
        pub(crate) started: Vec<TerminalSession>,
        pub(crate) stopped: Vec<String>,
        pub(crate) fail: bool,
    }

    impl RecordingLauncher {
        pub(crate) fn new() -> Self {
            Self {
                started: Vec::new(),
                stopped: Vec::new(),
                fail: false,
            }
        }
    }

    impl SessionLauncher for RecordingLauncher {
        fn start(&mut self, session: &TerminalSession) -> anyhow::Result<()> {
            if self.fail {
                bail!("tmux is gone");
            }
            self.started.push(session.clone());
            Ok(())
        }

        fn stop(&mut self, terminal_id: &str) {
            self.stopped.push(terminal_id.to_owned());
        }
    }

    pub(crate) fn run(directory: &Path, args: &[&str]) {
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

    /// A host laid out like Komla's: a bare repo, one workspace, and its manifest.
    pub(crate) fn host() -> (tempfile::TempDir, OfflineCaller) {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path().join(".komla");
        let origin = temp.path().join("origin");
        fs::create_dir_all(&origin).unwrap();
        run(&origin, &["init", "--quiet", "--initial-branch", "main"]);
        fs::write(origin.join("README.md"), "hello\n").unwrap();
        run(&origin, &["add", "README.md"]);
        run(&origin, &["commit", "--quiet", "-m", "init"]);
        let repo = base.join("repos/app/repo.git");
        fs::create_dir_all(repo.parent().unwrap()).unwrap();
        run(
            temp.path(),
            &[
                "clone",
                "--quiet",
                "--bare",
                origin.to_str().unwrap(),
                repo.to_str().unwrap(),
            ],
        );
        run(
            &repo,
            &[
                "config",
                "remote.origin.fetch",
                "+refs/heads/*:refs/remotes/origin/*",
            ],
        );
        run(&repo, &["fetch", "--quiet", "origin"]);
        let root = base.join("worktrees/app");
        let existing = root.join("first-task");
        run(
            &repo,
            &[
                "worktree",
                "add",
                "--quiet",
                "-b",
                "first-task",
                existing.to_str().unwrap(),
                "origin/main",
            ],
        );
        fs::create_dir_all(base.join(MANIFEST_DIRECTORY)).unwrap();
        fs::write(
            base.join("workspaces/ws-1.json"),
            serde_json::to_vec(&json!({
                "schema": 1,
                "workspaceId": "ws-1",
                "name": "First task",
                "branchName": "first-task",
                "baseBranch": "main",
                "repoName": "app",
                "backend": {
                    "remoteDirectory": existing,
                    "remoteRepoPath": repo,
                    "remoteProjectRoot": root,
                    "gitUrl": origin,
                    "projectName": "app",
                    "branchName": "first-task",
                    "baseBranch": "main",
                },
                "terminals": [],
                "createdAt": 1,
                "updatedAt": 1,
                "launch": {
                    "agentName": "Claude Code",
                    "promptCommand": "claude --model opus {{prompt}}",
                    "openCommand": "claude --model opus",
                },
            }))
            .unwrap(),
        )
        .unwrap();
        let caller = OfflineCaller {
            base,
            workspace_id: Some("ws-1".to_owned()),
            cwd: existing,
            api_url: Some("http://127.0.0.1:41234/terminals/old-terminal".to_owned()),
            companion_inbox: Some("/inbox".to_owned()),
            installation_key: Some("device-a".to_owned()),
            target_branch: None,
            shared_environment: vec![("KOMLA_CLI".to_owned(), "/b/helpers/komla".to_owned())],
            login_shell: None,
        };
        (temp, caller)
    }

    fn request(prompt: &str) -> OfflineLaunchRequest {
        OfflineLaunchRequest {
            prompt: Some(prompt.to_owned()),
            ..OfflineLaunchRequest::default()
        }
    }

    // Offline workspaces live on Linux and macOS hosts, so a source must be a POSIX path.

    #[cfg(unix)]
    #[test]
    fn creates_a_sibling_workspace_and_asks_the_next_device_to_add_it() {
        let (_temp, caller) = host();
        let mut launcher = RecordingLauncher::new();

        let created = create_workspace(
            &caller,
            &request("Fix the login redirect, it's broken"),
            &mut launcher,
            42,
        )
        .unwrap();

        assert_eq!(created.branch, "fix-the-login-redirect-it");
        assert_eq!(created.name, "Fix The Login Redirect It");
        assert!(created.path.join("README.md").exists());
        let session = &launcher.started[0];
        assert_eq!(session.terminal_id, created.terminal_id);
        assert_eq!(
            session.command,
            "claude --model opus 'Fix the login redirect, it'\\''s broken'"
        );
        let environment: std::collections::HashMap<_, _> =
            session.environment.iter().cloned().collect();
        assert_eq!(
            environment["KOMLA_API_URL"],
            format!("http://127.0.0.1:41234/terminals/{}", created.terminal_id)
        );
        assert_eq!(environment["KOMLA_WORKSPACE_ID"], created.workspace_id);
        assert_eq!(environment["KOMLA_INSTALLATION_KEY"], "device-a");
        assert_eq!(environment["KOMLA_CLI"], "/b/helpers/komla");
        assert_eq!(session.installation_key.as_deref(), Some("device-a"));

        let manifest: Value = serde_json::from_slice(
            &fs::read(
                caller
                    .base
                    .join(format!("workspaces/{}.json", created.workspace_id)),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(manifest["adoptOnConnect"], true);
        assert_eq!(manifest["sourceWorkspaceId"], "ws-1");
        assert_eq!(manifest["backend"]["remoteDirectory"], json!(created.path));
        assert_eq!(manifest["terminals"][0]["id"], json!(created.terminal_id));
        assert_eq!(manifest["launch"]["agentName"], "Claude Code");
        assert!(manifest.get("customName").is_none());
        assert!(manifest["backend"].get("defaultBranch").is_none());
    }

    // Offline workspaces live on Linux and macOS hosts, so a source must be a POSIX path.

    #[cfg(unix)]
    #[test]
    fn picks_a_free_branch_when_the_requested_one_is_taken() {
        let (_temp, caller) = host();
        let mut launcher = RecordingLauncher::new();
        let request = OfflineLaunchRequest {
            branch: Some("first task".to_owned()),
            name: Some("Second look".to_owned()),
            ..OfflineLaunchRequest::default()
        };

        let created = create_workspace(&caller, &request, &mut launcher, 1).unwrap();

        assert_eq!(created.branch, "first-task-2");
        assert_eq!(created.name, "Second look");
        assert_eq!(launcher.started[0].command, "claude --model opus");
    }

    // Offline workspaces live on Linux and macOS hosts, so a source must be a POSIX path.

    #[cfg(unix)]
    #[test]
    fn starts_from_the_branch_checked_out_in_the_source_workspace() {
        let (_temp, caller) = host();
        // The agent switched to a new branch and committed work that isn't on origin.
        run(&caller.cwd, &["switch", "--quiet", "-c", "search-v2"]);
        fs::write(caller.cwd.join("search.txt"), "draft\n").unwrap();
        run(&caller.cwd, &["add", "search.txt"]);
        run(&caller.cwd, &["commit", "--quiet", "-m", "search draft"]);
        let mut launcher = RecordingLauncher::new();
        let request = OfflineLaunchRequest {
            from_current_branch: true,
            ..request("Polish search")
        };

        let created = create_workspace(&caller, &request, &mut launcher, 1).unwrap();

        assert_eq!(created.branched_from.as_deref(), Some("search-v2"));
        assert!(created.path.join("search.txt").exists());
        let manifest: Value = serde_json::from_slice(
            &fs::read(
                caller
                    .base
                    .join(format!("workspaces/{}.json", created.workspace_id)),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(manifest["backend"]["startPoint"], "search-v2");
        assert_eq!(manifest["backend"]["baseBranch"], "main");
    }

    // Offline workspaces live on Linux and macOS hosts, so a source must be a POSIX path.

    #[cfg(unix)]
    #[test]
    fn refuses_to_start_from_a_detached_head() {
        let (_temp, caller) = host();
        run(&caller.cwd, &["switch", "--quiet", "--detach"]);
        let mut launcher = RecordingLauncher::new();
        let request = OfflineLaunchRequest {
            from_current_branch: true,
            ..request("Polish search")
        };

        let error = create_workspace(&caller, &request, &mut launcher, 1)
            .unwrap_err()
            .to_string();

        assert!(error.contains("no branch checked out"), "{error}");
        assert!(launcher.started.is_empty());
    }

    // Offline workspaces live on Linux and macOS hosts, so a source must be a POSIX path.

    #[cfg(unix)]
    #[test]
    fn resolves_the_workspace_from_the_directory_outside_a_komla_terminal() {
        let (_temp, mut caller) = host();
        caller.workspace_id = None;
        caller.cwd = caller.cwd.join("src");
        let mut launcher = RecordingLauncher::new();

        let created = create_workspace(&caller, &request("Add search"), &mut launcher, 1).unwrap();

        assert_eq!(created.branch, "add-search");
    }

    // Offline workspaces live on Linux and macOS hosts, so a source must be a POSIX path.
    #[cfg(unix)]
    #[test]
    fn removes_the_worktree_when_the_agent_cannot_start() {
        let (_temp, caller) = host();
        let mut launcher = RecordingLauncher::new();
        launcher.fail = true;

        let error = create_workspace(&caller, &request("Add search"), &mut launcher, 1)
            .unwrap_err()
            .to_string();

        assert!(error.contains("tmux is gone"));
        let root = caller.base.join("worktrees/app");
        assert!(!root.join("add-search").exists());
        assert!(!ref_exists(
            &caller.base.join("repos/app/repo.git"),
            "refs/heads/add-search"
        ));
        let manifests = fs::read_dir(caller.base.join(MANIFEST_DIRECTORY))
            .unwrap()
            .count();
        assert_eq!(manifests, 1);
    }

    #[test]
    fn refuses_manifests_that_point_outside_the_data_directory() {
        let (_temp, caller) = host();
        let path = caller.base.join("workspaces/ws-1.json");
        let mut manifest: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        manifest["backend"]["remoteRepoPath"] = json!("/etc/../tmp/repo.git");
        fs::write(&path, serde_json::to_vec(&manifest).unwrap()).unwrap();

        let error = create_workspace(&caller, &request("x"), &mut RecordingLauncher::new(), 1)
            .unwrap_err()
            .to_string();

        assert!(error.contains("outside Komla's data directory"), "{error}");
    }

    // Offline workspaces live on Linux and macOS hosts, so a source must be a POSIX path.

    #[cfg(unix)]
    #[test]
    fn refuses_a_base_branch_that_git_would_read_as_an_option() {
        let (temp, caller) = host();
        let path = caller.base.join("workspaces/ws-1.json");
        let marker = temp.path().join("pwned");
        let mut manifest: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        manifest["backend"]["baseBranch"] =
            json!(format!("--upload-pack=touch {}", marker.display()));
        fs::write(&path, serde_json::to_vec(&manifest).unwrap()).unwrap();

        let error = create_workspace(&caller, &request("x"), &mut RecordingLauncher::new(), 1)
            .unwrap_err()
            .to_string();

        assert!(error.contains("not a valid branch name"), "{error}");
        assert!(!marker.exists());
    }

    // Offline workspaces live on Linux and macOS hosts, so a source must be a POSIX path.

    #[cfg(unix)]
    #[test]
    fn explains_when_no_device_has_saved_agent_settings_yet() {
        let (_temp, caller) = host();
        let path = caller.base.join("workspaces/ws-1.json");
        let mut manifest: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        manifest.as_object_mut().unwrap().remove("launch");
        fs::write(&path, serde_json::to_vec(&manifest).unwrap()).unwrap();

        let error = create_workspace(&caller, &request("x"), &mut RecordingLauncher::new(), 1)
            .unwrap_err()
            .to_string();

        assert!(error.contains("no saved agent settings"), "{error}");
    }

    #[test]
    fn sanitizes_requested_branch_names() {
        assert_eq!(sanitize_branch("feat/Add search!!"), "feat/Add-search");
        assert_eq!(sanitize_branch("../evil..name.lock"), "evil.name");
        assert_eq!(
            slug("  Fix: the *login* redirect now please "),
            "fix-the-login-redirect-now"
        );
    }

    #[test]
    fn session_command_runs_the_agent_in_the_workspace_with_its_environment() {
        let script = session_command(
            &TerminalSession {
                terminal_id: "t".to_owned(),
                directory: PathBuf::from("/w/it's"),
                environment: vec![("KOMLA_TERMINAL_ID".to_owned(), "t".to_owned())],
                command: "claude 'hi'".to_owned(),
                installation_key: None,
                login_shell: None,
            },
            None,
        );

        assert!(script.starts_with("cd '/w/it'\\''s' || exit 1\n"));
        let output = Command::new("sh")
            .args(["-n", "-c", &script])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn session_command_starts_the_given_login_shell() {
        let script = session_command(
            &TerminalSession {
                terminal_id: "t".to_owned(),
                directory: PathBuf::from("/w"),
                environment: Vec::new(),
                command: "claude".to_owned(),
                installation_key: None,
                login_shell: Some(PathBuf::from("/usr/bin/zsh")),
            },
            None,
        );

        assert!(
            script.contains("remote_shell='/usr/bin/zsh'\nSHELL='/usr/bin/zsh'\nexport SHELL\n")
        );
        assert!(!script.contains("remote_shell=${SHELL:-/bin/bash}"));
        let output = Command::new("sh")
            .args(["-n", "-c", &script])
            .output()
            .unwrap();
        assert!(output.status.success());
    }

    #[test]
    #[cfg(unix)]
    fn session_command_starts_the_shell_through_the_pty_proxy_it_can_run() {
        use std::os::unix::fs::PermissionsExt;

        let temporary = tempfile::tempdir().unwrap();
        let log = temporary.path().join("log");
        let proxy = temporary.path().join("komla remote");
        fs::write(
            &proxy,
            format!(
                "#!/bin/sh\n[ \"$2\" = --check ] && exit 0\nprintf 'proxied\\n' >> '{}'\nshift\nexec \"$@\"\n",
                log.display()
            ),
        )
        .unwrap();
        fs::set_permissions(&proxy, fs::Permissions::from_mode(0o755)).unwrap();
        // The binary a long-running companion started from may be gone.
        let deleted = temporary.path().join("komla (deleted)");
        for (pty_proxy, expected) in [
            (Some(proxy.as_path()), "proxied\nran\n"),
            (Some(deleted.as_path()), "ran\n"),
            (None, "ran\n"),
        ] {
            fs::write(&log, "").unwrap();
            let script = session_command(
                &TerminalSession {
                    terminal_id: "t".to_owned(),
                    directory: temporary.path().to_owned(),
                    environment: Vec::new(),
                    command: format!("printf 'ran\\n' >> '{}'", log.display()),
                    installation_key: None,
                    login_shell: Some(PathBuf::from("/bin/sh")),
                },
                pty_proxy,
            );
            let output = Command::new("/bin/sh")
                .args(["-c", &script])
                .env("HOME", temporary.path())
                .env("ENV", "/dev/null")
                .stdin(Stdio::null())
                .output()
                .unwrap();

            assert!(output.status.success(), "{output:?}");
            assert_eq!(fs::read_to_string(&log).unwrap(), expected, "{pty_proxy:?}");
        }
    }
}
