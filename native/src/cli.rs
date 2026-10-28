use std::env;
use std::fmt;
use std::fs;
use std::io::{BufRead, BufReader, IsTerminal, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;
use std::time::Instant;
use std::time::SystemTime;

use anyhow::{bail, Context};
use komla::{NotificationPresentation, PendingTerminalHook, RepositorySnapshot};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::desktop::{DesktopView, NowhereToShow, Shown, Viewer};
use crate::mailbox;
use crate::offline_workspace::{
    self, CreatedWorkspace, OfflineCaller, OfflineLaunchRequest, TmuxSessionLauncher,
};
use crate::transport::{request_http, HttpResponse};

const MAX_CLI_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
const MAX_HOOK_INPUT_BYTES: usize = 1024 * 1024;
const MAX_FORWARDED_HOOK_INPUT_BYTES: usize = 64 * 1024;
// As notify.js caps hook messages; a Bash command can be a whole heredoc.
const MAX_PERMISSION_MESSAGE_UTF16_UNITS: usize = 8192;
const MAX_NOTIFICATION_TITLE_UTF16_UNITS: usize = 256;
const MAX_NOTIFICATION_BODY_UTF16_UNITS: usize = 64 * 1024;
const MAX_NOTIFICATION_COLOR_UTF16_UNITS: usize = 256;
const MAX_NOTIFICATION_BADGE_UTF16_UNITS: usize = 64;
const HOOK_STDIN_TIMEOUT: Duration = Duration::from_secs(1);
// However steadily a runner trickles its input, the hook doesn't wait longer than this.
const HOOK_STDIN_DEADLINE: Duration = Duration::from_secs(10);
const MCP_PROTOCOL_VERSION: &str = "2025-03-26";

#[derive(Debug)]
struct OperationFailure {
    code: String,
    message: String,
    details: Option<Value>,
}

impl fmt::Display for OperationFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for OperationFailure {}

#[derive(Debug)]
pub(crate) struct ReportedCliError;

impl fmt::Display for ReportedCliError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Komla CLI command failed")
    }
}

impl std::error::Error for ReportedCliError {}

/// No Komla installation answered, so the request cannot have reached one.
#[derive(Debug)]
struct KomlaUnreachable(String);

impl fmt::Display for KomlaUnreachable {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "Komla isn't connected: {}", self.0)
    }
}

impl std::error::Error for KomlaUnreachable {}

fn is_unreachable(error: &anyhow::Error) -> bool {
    error.downcast_ref::<KomlaUnreachable>().is_some()
}

/// Agent sandboxes often block loopback connections, and launch prompts leave
/// that to the CLI. The second half stops an agent from retrying forever.
fn with_network_hint(error: anyhow::Error) -> anyhow::Error {
    if !is_unreachable(&error) {
        return error;
    }
    anyhow::anyhow!(
        "{error:#}. If a sandbox blocked it, rerun this command once with network access approved; \
         if that fails too, report that Komla is unavailable."
    )
}

const USAGE: &str = "usage: komla <command> [arguments]\n\n\
commands:\n  launch [prompt] [--here] [--preset <name-or-id>] [--mode <id>]\n    [--project <name-or-id>] [--name <name>] [--description <text>] [--branch <name>]\n    [--from-current-branch] [--prompt-file <path|->] [--json]\n    Starts an agent in a new workspace by default; --here opens a tab in the current workspace.\n    --from-current-branch branches from this workspace's branch instead of the base branch.\n  preview [url] [--json]\n    Opens a running dev server in Komla's browser preview.\n  desktop run [--browser | --app] [--] <command> [arguments]\n    Runs a GUI app. On Linux without a display, such as on an SSH host, it runs on a virtual\n    desktop of its own, listed under Komla's globe button to open in a VNC app such as Screen\n    Sharing or in Komla's browser preview; --app or --browser opens it there right away.\n    desktop start|status|stop manage virtual desktops.\n  title <title> [--description <text>] [--json]\n    Updates the current workspace's sidebar title and description.\n\
  open [folder] [--json]\n    Opens a folder on this computer, the current one by default, in Komla as Open Folder does:\n    a workspace of its own, or the one already open there.\n\
  snooze <30m|2h|1d|17:30|YYYY-MM-DD HH:MM> [--until-notified] [--json]\n    Hides the current workspace on the sidebar's Snoozed shelf until then, in Komla's time\n    zone. It comes back marked Woke, or sooner when an agent there needs input or fails.\n    --until-notified also wakes it at its next notification, such as an agent's turn ending\n    there, komla notify or a background Quick Command; with it, the time is optional.\n\
  wake [--json]\n    Ends the current workspace's snooze now, marked Woke, such as when a job it waits on ends.\n\
  tag <tag> [--tooltip <text>] [--tone <tone>] [--icon <file|svg>] [--spinner] [--if <tag>]\n    [--json]\n    Tags the current workspace to say what it waits on, such as \"Waiting for review\" after\n    opening a pull request, or what a script sees, such as \"CI running\". The tag shows on its\n    card while no agent is busy there, until it's taken off or replaced; a workspace has one.\n    A tag Komla doesn't have yet joins the user's list, colored by --tone (neutral, info,\n    attention, success, warning or error), with --icon (as for status set, its shape in the\n    tag's color) or --spinner in place of the tag glyph; a tag it has keeps the user's look.\n    --tooltip says more on hover, until the tag changes. --if changes only a workspace that\n    has that tag.\n\
  untag [<tag>] [--json]\n    Takes the current workspace's tag off, or only that tag, so a script leaves alone a tag\n    put on since.\n\
  tags [--json]\n    Lists the user's tags, which komla tag gives a workspace with the look the user gave them.\n\
  trash [--json]\n    Moves the current workspace to the Trash once the agent's turn finishes, stopping its\n    terminals; the user can restore it for 7 days. It stays when the turn is interrupted or\n    fails, or when another tab's agent works, waits for input or failed. Run it last: when\n    Komla can't follow the agent's turns, it moves a second later.\n  status set <id> <text> [--icon <file|svg>] [--icon-color <color>]\n    [--tone <success|warning|error|info>] [--color <color>] [--tooltip <text>] [--link <url>]\n    [--popover <markdown> | --popover-file <path|->] [--json]\n    Shows a short status, such as test results or a pull request, in Komla's status bar while\n    the current workspace is open. Setting an id again replaces it; --link opens on click, or\n    with --popover shows as a button below the popover's Markdown. --color is success, warning,\n    error, info, muted, foreground or a hex color; the text can carry Nerd Font icons and\n    terminal colors for parts of it, such as \"$(printf '\\033[32m✓\\033[0m CI')\".\n    --icon puts an image file (SVG, PNG, WebP, GIF or JPEG, up to 32 KB) or SVG markup\n    before the text; --icon-color shows its shape in a color, such as foreground for a\n    one-color logo that follows the theme. --segments (or --segments-file) replaces the\n    text with a JSON array of parts, to put icons anywhere, such as\n    [{\"icon\":\"logo.svg\"},{\"text\":\" CI\",\"color\":\"success\"}].\n  status clear [id] [--json]\n    Clears one status item, or all of the current workspace's.\n  status refresh <id> [--json]\n    Runs a status-items.json item's command again now, as from a hook when what it shows\n    changed, and waits for it.\n  notify <title> [--body <text>] [--kind <kind>] [--color <color>] [--badge <text>]\n    [--icon <file|svg>] [--icon-color <color>]\n    Shows a notification for the current workspace. Its title shows on the sidebar card, or\n    --badge's shorter text with the title on hover. --color is success, warning, error, info,\n    attention, muted or a CSS color; --icon (as for status set) replaces the kind's glyph.\n  notify [<title>] -- <command> [arguments]\n    Runs a command, showing its tab as working, and notifies when it finishes or fails.\n  settings <get|apply> <actions|workspace-setup|automations|appearance|status-items|hooks|shortcuts|terminal|agents> [--scope <scope>] [--file <path>]\n    Reads or replaces Quick Commands (actions, with --scope global|current-project), Workspace\n    Setup, the project's automations, the theme, status bar items, hooks, keyboard shortcuts,\n    terminal settings, or agent presets' arguments and level pickers.\n    apply takes JSON on stdin or from --file and waits for the user to confirm in Komla.\n  skill <customize|status-items|automations|project-setup|appearance|onboarding-demo|self-integration>\n    Prints Komla's current guide for changing Komla's settings, making status bar items or\n    automations, setting up a project, changing the theme, running a demo, or connecting an agent\n    CLI Komla doesn't support out of the box.\n  context [--json]\n    Shows the project, workspace, and terminal that commands target.\n  agent presets [--all] [--json]\n    Lists agent presets and modes for --preset and --mode. Presets marked inactive (shown with\n    --all) or unavailable can't be launched, nor can modes marked unavailable; --json says why.\n    Modes marked isolated SSH host only start only on an SSH host the user marked isolated.\n  agent launch [prompt] [--new-workspace] ... (legacy: defaults to a tab)\n  workspace list [--all] [--json]\n    Lists the workspaces (--all adds those in the Trash) with their ids, for --workspace.\n  workspace <title|snooze|wake|tag|untag|trash> ...\n  --workspace <id>\n    Acts on the workspace with that id in place of the current one, as from a script that\n    runs outside any workspace. Works with every command that acts on a workspace but trash\n    and notify -- <command>.\n  preview open ...\n  git snapshot [-C <path>] [--target <branch>]\n  git target <push|pull|merge-remote|merge-source|sync> [-C <path>] [--target <branch>]\n  mcp\n    Serves Komla's MCP tools over stdio for clients that require an MCP server.\n  automation <list|save|delete|run|tick> ...\n    Manages the agent tasks this SSH host starts on a schedule; Komla's Automations settings use it.\n  version";

const NOTIFY_USAGE: &str =
    "usage: komla notify <title> [--body <text>] [--kind <kind>] [--color <color>] [--badge <text>] \
[--icon <file|svg>] [--icon-color <color>]\n       komla notify [<title>] -- <command> [arguments]";
const SETTINGS_USAGE: &str = "usage: komla settings <get|apply> \
<actions|workspace-setup|automations|appearance|status-items|hooks|shortcuts|terminal|agents> \
[--scope <scope>] [--file <path>]";
const STATUS_USAGE: &str =
    "usage: komla status set <id> <text> [--icon <file|svg>] [--icon-color <color>] [--tone <success|warning|error|info>] \
[--color <color>] [--tooltip <text>] [--link <url>] [--popover <markdown> | --popover-file <path|->] \
[--json]\n       komla status set <id> --segments <json> | --segments-file <path|-> [options]\n       \
komla status clear [id] [--json]\n       komla status refresh <id> [--json]";
const STATUS_TONES: [&str; 4] = ["success", "warning", "error", "info"];
const STATUS_THEME_COLORS: [&str; 6] =
    ["success", "warning", "error", "info", "muted", "foreground"];
const MAX_STATUS_TEXT: usize = 60;
// Terminal colors in status text don't count toward MAX_STATUS_TEXT; this bounds the rest.
const MAX_STATUS_RAW_TEXT: usize = 1_000;
const MAX_STATUS_SEGMENTS: usize = 30;
const MAX_STATUS_ICONS: usize = 4;
const MAX_STATUS_ICON: usize = 32 * 1024;
// Percent-encoded SVG can take three characters a byte.
const MAX_STATUS_ICON_INPUT: usize = MAX_STATUS_ICON * 3;
const MAX_STATUS_TOOLTIP: usize = 500;
const MAX_STATUS_POPOVER: usize = 20_000;
const MAX_SNOOZE_UNTIL: usize = 40;
// As MAX_WORKSPACE_TAG_LENGTH in Komla's shared/lib/workspace-tags.ts.
const MAX_TAG: usize = 40;
const MAX_TAG_TOOLTIP: usize = 500;
const TAG_TONES: [&str; 6] = [
    "neutral",
    "info",
    "attention",
    "success",
    "warning",
    "error",
];
const SKILL_USAGE: &str = "usage: komla skill \
     <customize|status-items|automations|project-setup|appearance|onboarding-demo|self-integration>";

/// Guides that `komla skill <name>` prints, keyed by name.
const SKILL_GUIDES: [(&str, &str); 7] = [
    ("customize", "komla-customize-instructions.md"),
    ("status-items", "komla-status-items-instructions.md"),
    ("automations", "komla-automations-instructions.md"),
    ("project-setup", "komla-project-setup-instructions.md"),
    ("appearance", "komla-appearance-instructions.md"),
    ("onboarding-demo", "komla-onboarding-demo-instructions.md"),
    ("self-integration", "komla-self-integration-instructions.md"),
];

#[derive(Clone, Debug)]
struct CliEnvironment {
    api_url: String,
    cwd: String,
    /// Set when `--cwd` or `-C` chose `cwd` instead of the process directory.
    explicit_cwd: bool,
    terminal_id: Option<String>,
    workspace_id: Option<String>,
    /// The workspace `--workspace` named, which commands act on in place of the calling one.
    target_workspace_id: Option<String>,
    companion_inbox: Option<PathBuf>,
    scoped_url: bool,
    stdin_is_terminal: bool,
    stdout_is_terminal: bool,
    /// Grok Build started this as a hook. It also runs the hooks Claude Code, Codex and Cursor
    /// read, Komla's among them, which then report Grok's turns as theirs.
    run_by_grok: bool,
    /// Cursor started this as a hook. It also runs the hooks Claude Code reads.
    run_by_cursor: bool,
    /// Devin started this as a hook. It also runs the hooks Claude Code reads.
    run_by_devin: bool,
    /// Claude Code runs this outside an interactive session: a background session's daemon
    /// (`claude --bg`), which kept the environment of the Terminal that started it, or print
    /// and SDK mode, such as a `claude -p` another agent runs in its Terminal.
    run_by_detached_claude: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct KomlaEnvironmentValues {
    api_url: Option<String>,
    terminal_id: Option<String>,
    workspace_id: Option<String>,
    companion_inbox: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManagedCompanionRoute {
    endpoint: String,
    workspaces: Vec<ManagedCompanionWorkspace>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManagedCompanionWorkspace {
    workspace_id: String,
    working_tree: PathBuf,
}

impl KomlaEnvironmentValues {
    fn current_process() -> Self {
        Self {
            api_url: non_empty_env("KOMLA_API_URL"),
            terminal_id: non_empty_env("KOMLA_TERMINAL_ID"),
            workspace_id: non_empty_env("KOMLA_WORKSPACE_ID"),
            companion_inbox: non_empty_env("KOMLA_COMPANION_INBOX"),
        }
    }

    fn has_missing_value(&self) -> bool {
        self.api_url.is_none()
            || self.terminal_id.is_none()
            || self.workspace_id.is_none()
            || self.companion_inbox.is_none()
    }

    fn with_missing_from(self, fallback: Self) -> Self {
        Self {
            api_url: self.api_url.or(fallback.api_url),
            terminal_id: self.terminal_id.or(fallback.terminal_id),
            workspace_id: self.workspace_id.or(fallback.workspace_id),
            companion_inbox: self.companion_inbox.or(fallback.companion_inbox),
        }
    }
}

impl CliEnvironment {
    fn current() -> anyhow::Result<Self> {
        let cwd = env::current_dir()
            .context("could not determine the current directory")?
            .to_string_lossy()
            .into_owned();
        let process_values = KomlaEnvironmentValues::current_process();
        let managed_session = in_managed_tmux_session();
        let tmux_values = if managed_session
            || (process_values.has_missing_value() && non_empty_env("TMUX").is_some())
        {
            discover_tmux_environment()
        } else {
            KomlaEnvironmentValues::default()
        };
        let mut values = resolve_route_values(process_values, tmux_values, managed_session);
        if values.api_url.is_none() {
            if let Some(data_dir) = komla_data_dir() {
                values = values.with_missing_from(discover_managed_companion_route(
                    &data_dir,
                    Path::new(&cwd),
                ));
            }
        }
        let api_url = match values.api_url {
            Some(url) => url.trim_end_matches('/').to_owned(),
            None => discover_local_api_url()?,
        };
        Ok(Self {
            scoped_url: api_url.contains("/terminals/"),
            api_url,
            cwd,
            explicit_cwd: false,
            terminal_id: values.terminal_id,
            workspace_id: values.workspace_id,
            target_workspace_id: None,
            companion_inbox: values.companion_inbox.map(PathBuf::from),
            stdin_is_terminal: std::io::stdin().is_terminal(),
            stdout_is_terminal: std::io::stdout().is_terminal(),
            run_by_grok: non_empty_env("GROK_HOOK_EVENT").is_some(),
            run_by_cursor: non_empty_env("CURSOR_VERSION").is_some()
                && non_empty_env("CURSOR_PROJECT_DIR").is_some(),
            run_by_devin: non_empty_env("DEVIN_PROJECT_DIR").is_some(),
            run_by_detached_claude: non_empty_env("CLAUDE_JOB_DIR").is_some()
                || non_empty_env("CLAUDE_CODE_ENTRYPOINT")
                    .is_some_and(|entrypoint| entrypoint.starts_with("sdk")),
        })
    }
}

/// A managed session's environment names the desktop that currently owns the
/// terminal. Another device rewrites it when it takes the session over, so it
/// wins over the values the agent process inherited at launch.
fn resolve_route_values(
    process_values: KomlaEnvironmentValues,
    tmux_values: KomlaEnvironmentValues,
    managed_session: bool,
) -> KomlaEnvironmentValues {
    if managed_session {
        tmux_values.with_missing_from(process_values)
    } else {
        process_values.with_missing_from(tmux_values)
    }
}

const MANAGED_TMUX_SOCKET_NAME: &str = offline_workspace::TMUX_SOCKET_NAME;

fn in_managed_tmux_session() -> bool {
    non_empty_env("TMUX").is_some_and(|value| is_managed_tmux_socket(&value))
}

fn is_managed_tmux_socket(tmux: &str) -> bool {
    tmux.split(',')
        .next()
        .and_then(|socket| Path::new(socket).file_name())
        .and_then(|name| name.to_str())
        == Some(MANAGED_TMUX_SOCKET_NAME)
}

impl CliEnvironment {
    /// Whether a hook for `source` reports work other than its agent's in this Terminal: another
    /// agent's turn under its name, or a Claude session the user doesn't follow here.
    fn runs_hook_for_other_work(&self, source: &str) -> bool {
        (self.run_by_grok && !source.starts_with("grok"))
            || (self.run_by_cursor && !source.starts_with("cursor"))
            || (self.run_by_devin && !source.starts_with("devin"))
            || (self.run_by_detached_claude && source == "claude-code")
    }
}

fn non_empty_env(name: &str) -> Option<String> {
    env::var(name).ok().filter(|value| !value.trim().is_empty())
}

fn discover_tmux_environment() -> KomlaEnvironmentValues {
    let Ok(output) = Command::new("tmux").arg("show-environment").output() else {
        return KomlaEnvironmentValues::default();
    };
    if !output.status.success() {
        return KomlaEnvironmentValues::default();
    }
    parse_tmux_environment(&output.stdout)
}

fn parse_tmux_environment(output: &[u8]) -> KomlaEnvironmentValues {
    let mut values = KomlaEnvironmentValues::default();
    for line in String::from_utf8_lossy(output).lines() {
        let Some((name, value)) = line.split_once('=') else {
            continue;
        };
        if value.trim().is_empty() {
            continue;
        }
        let destination = match name {
            "KOMLA_API_URL" => &mut values.api_url,
            "KOMLA_TERMINAL_ID" => &mut values.terminal_id,
            "KOMLA_WORKSPACE_ID" => &mut values.workspace_id,
            "KOMLA_COMPANION_INBOX" => &mut values.companion_inbox,
            _ => continue,
        };
        *destination = Some(value.to_owned());
    }
    values
}

fn discover_local_api_url() -> anyhow::Result<String> {
    let komla_dir = komla_data_dir()
        .context("KOMLA_API_URL is not set and the Komla data directory could not be found")?;
    let port_text = fs::read_to_string(komla_dir.join("port"))
        .context("Komla is not running (its port file is unavailable)")?;
    let port = port_text
        .trim()
        .parse::<u16>()
        .context("Komla's port file is invalid")?;
    Ok(format!("http://127.0.0.1:{port}"))
}

fn komla_data_dir() -> Option<PathBuf> {
    non_empty_env("KOMLA_DATA_DIR")
        .map(PathBuf::from)
        .or_else(|| installed_komla_data_dir(env::current_exe().ok().as_deref()))
        .or_else(|| {
            default_komla_data_dir(
                non_empty_env("HOME").as_deref(),
                non_empty_env("USERPROFILE").as_deref(),
            )
        })
}

fn discover_managed_companion_route(data_dir: &Path, cwd: &Path) -> KomlaEnvironmentValues {
    let companion_root = data_dir.join("helpers").join("companion");
    let Ok(installations) = fs::read_dir(companion_root) else {
        return KomlaEnvironmentValues::default();
    };
    let mut best: Option<(usize, SystemTime, String, String)> = None;
    for installation in installations.filter_map(Result::ok) {
        let Ok(configs) = fs::read_dir(installation.path()) else {
            continue;
        };
        for config in configs.filter_map(Result::ok) {
            if config.path().extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            let Ok(contents) = fs::read(config.path()) else {
                continue;
            };
            let Ok(route) = serde_json::from_slice::<ManagedCompanionRoute>(&contents) else {
                continue;
            };
            let Some(api_url) = route.endpoint.strip_suffix("/api/v1/ssh-workspace-status") else {
                continue;
            };
            let modified = config
                .metadata()
                .and_then(|metadata| metadata.modified())
                .unwrap_or(SystemTime::UNIX_EPOCH);
            for workspace in route.workspaces {
                if workspace.workspace_id.trim().is_empty()
                    || !cwd.starts_with(&workspace.working_tree)
                {
                    continue;
                }
                let specificity = workspace.working_tree.components().count();
                if best
                    .as_ref()
                    .is_some_and(|(best_specificity, best_modified, _, _)| {
                        (*best_specificity, *best_modified) >= (specificity, modified)
                    })
                {
                    continue;
                }
                best = Some((
                    specificity,
                    modified,
                    api_url.to_owned(),
                    workspace.workspace_id,
                ));
            }
        }
    }
    let Some((_, _, api_url, workspace_id)) = best else {
        return KomlaEnvironmentValues::default();
    };
    KomlaEnvironmentValues {
        api_url: Some(api_url),
        workspace_id: Some(workspace_id),
        ..KomlaEnvironmentValues::default()
    }
}

fn installed_komla_data_dir(executable: Option<&Path>) -> Option<PathBuf> {
    for bin in executable?.parent()?.ancestors() {
        if bin.file_name()?.to_str()? != "bin" {
            continue;
        }
        let parent = bin.parent()?;
        if parent.file_name()?.to_str()?.starts_with(".komla") {
            return Some(parent.to_owned());
        }
        if parent.file_name()?.to_str()? == "helpers" {
            return parent.parent().map(Path::to_owned);
        }
    }
    None
}

fn default_komla_data_dir(home: Option<&str>, user_profile: Option<&str>) -> Option<PathBuf> {
    home.or(user_profile)
        .map(|value| Path::new(value).join(".komla"))
}

trait KomlaApi {
    /// Re-reads the route before a request from a long-lived adapter.
    fn refresh_route(&mut self) {}

    /// Sends the next requests for the workspace `--workspace` named, not the calling one.
    fn target_workspace(&mut self, _workspace_id: &str) {}

    fn request(
        &mut self,
        method: &str,
        path: &str,
        body: &[u8],
        allow_long_running: bool,
    ) -> anyhow::Result<HttpResponse>;

    /// Creates a workspace on this host itself, for when Komla is unreachable.
    fn create_workspace_offline(
        &mut self,
        _request: &OfflineLaunchRequest,
    ) -> anyhow::Result<CreatedWorkspace> {
        bail!("Komla isn't connected")
    }

    /// Reads a guide installed with Komla on this host, for when Komla is unreachable.
    fn installed_guide(&self, _filename: &str) -> Option<String> {
        None
    }
}

struct HttpKomlaApi {
    environment: CliEnvironment,
}

impl KomlaApi for HttpKomlaApi {
    fn target_workspace(&mut self, workspace_id: &str) {
        self.environment.target_workspace_id = Some(workspace_id.to_owned());
        self.environment.workspace_id = Some(workspace_id.to_owned());
        self.environment.terminal_id = None;
    }

    fn refresh_route(&mut self) {
        if !in_managed_tmux_session() {
            return;
        }
        if let Some(api_url) = discover_tmux_environment().api_url {
            self.environment.api_url = api_url.trim_end_matches('/').to_owned();
        }
    }

    fn request(
        &mut self,
        method: &str,
        path: &str,
        body: &[u8],
        allow_long_running: bool,
    ) -> anyhow::Result<HttpResponse> {
        let url = format!("{}{}", self.environment.api_url, path);
        let mut headers = vec![("Accept", "application/json, text/event-stream")];
        if path == "/api/v1/cli/mcp" {
            headers.push(("MCP-Protocol-Version", MCP_PROTOCOL_VERSION));
        }
        if !body.is_empty() {
            headers.push(("Content-Type", "application/json"));
        }
        let terminal_id = self.environment.terminal_id.as_deref();
        let workspace_id = self.environment.workspace_id.as_deref();
        if let Some(terminal_id) = terminal_id {
            headers.push(("X-Komla-Terminal-Id", terminal_id));
        }
        if let Some(workspace_id) = workspace_id {
            headers.push(("X-Komla-Workspace-Id", workspace_id));
        }
        if let Some(target) = self.environment.target_workspace_id.as_deref() {
            headers.push(("X-Komla-Target-Workspace-Id", target));
        }
        request_http(
            method,
            &url,
            &headers,
            body,
            MAX_CLI_RESPONSE_BYTES,
            (!allow_long_running).then_some(Duration::from_secs(10)),
        )
        .map_err(|error| {
            if error.is_unreachable() {
                KomlaUnreachable(error.to_string()).into()
            } else {
                anyhow::anyhow!(error.to_string())
            }
        })
    }

    fn installed_guide(&self, filename: &str) -> Option<String> {
        fs::read_to_string(komla_data_dir()?.join("skills").join(filename)).ok()
    }

    fn create_workspace_offline(
        &mut self,
        request: &OfflineLaunchRequest,
    ) -> anyhow::Result<CreatedWorkspace> {
        let base = host_data_dir().context(
            "Komla isn't connected, and Komla's data directory on this host could not be found",
        )?;
        let installation_key = self
            .environment
            .terminal_id
            .as_deref()
            .and_then(session_installation_key)
            .or_else(|| non_empty_env("KOMLA_INSTALLATION_KEY"));
        let caller = OfflineCaller {
            base,
            workspace_id: self.environment.workspace_id.clone(),
            cwd: PathBuf::from(&self.environment.cwd),
            api_url: Some(self.environment.api_url.clone()),
            companion_inbox: self
                .environment
                .companion_inbox
                .as_ref()
                .map(|inbox| inbox.to_string_lossy().into_owned()),
            installation_key,
            target_branch: non_empty_env("KOMLA_TARGET_BRANCH"),
            shared_environment: OfflineCaller::shared_environment_from_process(),
            login_shell: None,
        };
        let mut launcher = TmuxSessionLauncher::new(&caller.base);
        offline_workspace::create_workspace(&caller, request, &mut launcher, crate::clock::now_ms())
    }
}

/// Komla's data directory on an SSH host. `helpers/komla` links to a versioned
/// executable under `helpers/bin`, which is the path the process sees.
fn host_data_dir() -> Option<PathBuf> {
    host_data_dir_from(
        env::current_exe().ok().as_deref(),
        non_empty_env("KOMLA_CLI").as_deref().map(Path::new),
    )
}

fn host_data_dir_from(executable: Option<&Path>, komla_cli: Option<&Path>) -> Option<PathBuf> {
    installed_komla_data_dir(executable).or_else(|| {
        let helpers = komla_cli?.parent()?;
        (helpers.file_name()? == "helpers").then(|| helpers.parent().map(Path::to_owned))?
    })
}

/// The installation that last attached to a managed terminal session.
fn session_installation_key(terminal_id: &str) -> Option<String> {
    let output = Command::new("tmux")
        .args([
            "-L",
            MANAGED_TMUX_SOCKET_NAME,
            "show-options",
            "-qv",
            "-t",
            &format!("komla-{terminal_id}"),
            "@komla_installation_key",
        ])
        .output()
        .ok()?;
    let key = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    (output.status.success() && !key.is_empty()).then_some(key)
}

pub(crate) fn run(args: &[String]) -> anyhow::Result<()> {
    // Antigravity needs this reply even when the notification can't be sent,
    // so answer before finding Komla or reading the hook input.
    if let Some(reply) = hook_reply(args) {
        let _ = writeln!(std::io::stdout(), "{reply}");
    }
    let result = run_cli(args);
    if let Err(error) = &result {
        // Agents report any non-zero hook exit as a failed hook, so a missed
        // notification must not surface in the agent's session.
        if is_notify_hook(args) {
            eprintln!("{error:#}");
            return Ok(());
        }
    }
    result.map_err(with_network_hint)
}

fn is_notify_hook(args: &[String]) -> bool {
    args.first().map(String::as_str) == Some("notify")
        && notify_run_arguments(args).is_none()
        && args.iter().any(|argument| argument == "--event")
}

/// Antigravity hooks must answer with a JSON object, and Stop with a decision;
/// any decision but "continue" lets the agent stop.
fn hook_reply(args: &[String]) -> Option<&'static str> {
    if !is_notify_hook(args) {
        return None;
    }
    let value = |name| Some(args.get(option_index(args, name).ok()?? + 1)?.as_str());
    if value("--source")? != "antigravity" {
        return None;
    }
    Some(if value("--event")? == "Stop" {
        r#"{"decision":"stop"}"#
    } else {
        "{}"
    })
}

fn run_cli(args: &[String]) -> anyhow::Result<()> {
    // Arguments after `desktop run` belong to the app, so its --help isn't Komla's.
    if args.first().map(String::as_str) == Some("desktop") {
        return crate::desktop::run(&args[1..], &mut show_desktop);
    }
    // The same goes for the command `notify --` runs, which also keeps the terminal's stdin.
    if let Some((title, command)) = notify_run_arguments(args) {
        return notify_when_done(title, command);
    }
    if help_requested(args) {
        print_help();
        return Ok(());
    }
    if args.first().map(String::as_str) == Some("git") {
        let stdout = std::io::stdout();
        return git_command(&args[1..], &mut stdout.lock());
    }
    // Run by cron and by devices over SSH, so it never needs a running Komla.
    if args.first().map(String::as_str) == Some("automation") {
        let stdin = std::io::stdin();
        let stdout = std::io::stdout();
        return crate::automation::command(
            &args[1..],
            komla_data_dir(),
            &mut stdin.lock(),
            &mut stdout.lock(),
        );
    }
    if !matches!(
        args.first().map(String::as_str),
        Some(
            "settings"
                | "skill"
                | "context"
                | "workspace"
                | "agent"
                | "launch"
                | "title"
                | "snooze"
                | "wake"
                | "tag"
                | "untag"
                | "tags"
                | "trash"
                | "open"
                | "status"
                | "preview"
                | "notify"
                | "mcp"
        )
    ) {
        bail!(USAGE);
    }
    let environment = CliEnvironment::current()?;
    let mut api = HttpKomlaApi {
        environment: environment.clone(),
    };
    let stdout = std::io::stdout();
    let mut output = stdout.lock();
    let stderr = std::io::stderr();
    let mut errors = stderr.lock();
    let hook_input = (args.first().map(String::as_str) == Some("notify")
        && !environment.stdin_is_terminal)
        .then(|| read_process_hook_input(HOOK_STDIN_TIMEOUT, HOOK_STDIN_DEADLINE))
        .transpose()?;
    let result = if let Some(hook_input) = hook_input {
        let mut input = std::io::Cursor::new(Vec::<u8>::new());
        run_command_with_hook_input(
            args,
            &environment,
            &mut api,
            &mut input,
            &mut output,
            &mut errors,
            Some(hook_input),
        )
    } else {
        let stdin = std::io::stdin();
        let mut input = stdin.lock();
        run_command(
            args,
            &environment,
            &mut api,
            &mut input,
            &mut output,
            &mut errors,
        )
    };
    if let Err(error) = result {
        if args.iter().any(|argument| argument == "--json") {
            if let Some(failure) = error.downcast_ref::<OperationFailure>() {
                write_operation_error(failure, &mut output)?;
                return Err(ReportedCliError.into());
            }
        }
        return Err(error);
    }
    Ok(())
}

fn show_desktop(view: &DesktopView) -> anyhow::Result<Shown> {
    let environment = CliEnvironment::current()?;
    let mut api = HttpKomlaApi {
        environment: environment.clone(),
    };
    show_desktop_with(&mut api, &environment, view)
}

/// Lists the virtual desktop in the calling workspace's Komla, which opens it right away where
/// `--app` or `--browser` asks: in the VNC app on the user's computer or its browser preview.
fn show_desktop_with(
    api: &mut dyn KomlaApi,
    environment: &CliEnvironment,
    view: &DesktopView,
) -> anyhow::Result<Shown> {
    let mut operation = json!({
        "type": "desktop.open",
        "vncPort": view.vnc_port,
        "vncPassword": view.vnc_password,
        "vncPorts": view.vnc_ports,
    });
    insert_json_optional(&mut operation, "url", view.viewer_url.map(str::to_owned));
    insert_json_optional(&mut operation, "app", view.app.map(str::to_owned));
    insert_json_optional(
        &mut operation,
        "viewer",
        view.viewer.map(|viewer| {
            match viewer {
                Viewer::Preview => "preview",
                Viewer::VncApp => "vnc-app",
            }
            .to_owned()
        }),
    );
    let result = execute_operation(api, environment, operation).map_err(|error| {
        match error.downcast::<OperationFailure>() {
            Ok(failure) if failure.code == "DESKTOP_VIEWER_UNAVAILABLE" => {
                NowhereToShow(failure.message).into()
            }
            Ok(failure) => failure.into(),
            Err(error) => error,
        }
    })?;
    let desktop = &result["desktop"];
    let shown = match (desktop["viewer"].as_str(), desktop["vncApp"].as_str()) {
        (Some("vnc-app"), Some(name)) => Shown::VncApp {
            name: name.to_owned(),
        },
        (Some("preview"), _) => Shown::Preview,
        _ => Shown::Listed,
    };
    Ok(shown)
}

fn git_command(args: &[String], output: &mut dyn Write) -> anyhow::Result<()> {
    if args.first().map(String::as_str) == Some("target") {
        let operation = args.get(1).context("target operation is required")?;
        let mut options = args[2..].to_vec();
        let cwd = take_option(&mut options, "-C")?
            .map(std::path::PathBuf::from)
            .unwrap_or(env::current_dir()?);
        let target = take_option(&mut options, "--target")?
            .or_else(|| non_empty_env("KOMLA_TARGET_BRANCH"))
            .unwrap_or_else(|| "main".to_owned());
        ensure_no_arguments(&options)?;
        if operation == "sync" {
            writeln!(output, "{}", komla::sync_target_branch(&cwd, &target)?)?;
            return Ok(());
        }
        let action = komla::TargetAction::parse(operation)?;
        let result = komla::run_target_operation(&cwd, &target, action)?;
        serde_json::to_writer(&mut *output, &result)?;
        writeln!(output)?;
        return Ok(());
    }
    let Some("snapshot") = args.first().map(String::as_str) else {
        bail!("usage: komla git snapshot [-C <path>] [--target <branch>]");
    };
    let mut options = args[1..].to_vec();
    let cwd = take_option(&mut options, "--cwd")?;
    let short_cwd = take_option(&mut options, "-C")?;
    if cwd.is_some() && short_cwd.is_some() {
        bail!("use only one of --cwd or -C");
    }
    let target = take_option(&mut options, "--target")?
        .or_else(|| non_empty_env("KOMLA_TARGET_BRANCH"))
        .unwrap_or_else(|| "main".to_owned());
    ensure_no_arguments(&options)?;
    let working_tree = match cwd.or(short_cwd) {
        Some(path) => PathBuf::from(path),
        None => env::current_dir().context("could not determine the current directory")?,
    };
    let observed_at = crate::clock::now_ms();
    let snapshot = RepositorySnapshot::read(&working_tree, &target)?;
    let mut value = serde_json::to_value(snapshot)?;
    value["observedAt"] = observed_at.into();
    serde_json::to_writer(&mut *output, &value).context("could not encode repository snapshot")?;
    writeln!(output)?;
    Ok(())
}

// Yield arguments with their original indices, excluding values consumed by options.
fn option_arguments(args: &[String]) -> impl Iterator<Item = (usize, &str)> {
    let mut skip_value = false;
    args.iter()
        .enumerate()
        .filter_map(move |(index, argument)| {
            if skip_value {
                skip_value = false;
                return None;
            }
            skip_value = matches!(
                argument.as_str(),
                "--cwd"
                    | "-C"
                    | "--target"
                    | "--scope"
                    | "--file"
                    | "--description"
                    | "--prompt"
                    | "--prompt-file"
                    | "--preset"
                    | "--mode"
                    | "--name"
                    | "--branch"
                    | "--project"
                    | "--source"
                    | "--event"
                    | "--message"
                    | "--body"
                    | "--color"
                    | "--badge"
                    | "--kind"
                    | "--tone"
                    | "--tooltip"
                    | "--link"
                    | "--popover"
                    | "--popover-file"
                    | "--icon"
                    | "--icon-color"
                    | "--segments"
                    | "--segments-file"
                    | "--workspace"
                    | "--if"
            );
            Some((index, argument.as_str()))
        })
}

fn help_requested(args: &[String]) -> bool {
    option_arguments(args).any(|(_, argument)| matches!(argument, "--help" | "-h"))
}

pub(crate) fn print_help() {
    println!("{USAGE}");
}

fn run_command(
    args: &[String],
    environment: &CliEnvironment,
    api: &mut dyn KomlaApi,
    input: &mut dyn BufRead,
    output: &mut dyn Write,
    errors: &mut dyn Write,
) -> anyhow::Result<()> {
    run_command_with_hook_input(args, environment, api, input, output, errors, None)
}

fn run_command_with_hook_input(
    args: &[String],
    environment: &CliEnvironment,
    api: &mut dyn KomlaApi,
    input: &mut dyn BufRead,
    output: &mut dyn Write,
    errors: &mut dyn Write,
    hook_input: Option<(Value, bool)>,
) -> anyhow::Result<()> {
    let mut args = args.to_vec();
    let mut environment = environment.clone();
    let cwd = take_option(&mut args, "--cwd")?;
    let short_cwd = take_option(&mut args, "-C")?;
    if cwd.is_some() && short_cwd.is_some() {
        bail!("use only one of --cwd or -C");
    }
    if let Some(cwd) = cwd.or(short_cwd) {
        environment.cwd = cwd;
        environment.explicit_cwd = true;
    }
    if let Some(target) = take_option(&mut args, "--workspace")? {
        let target = target.trim();
        if target.is_empty() {
            bail!("--workspace needs a workspace id, as `komla workspace list --json` shows it");
        }
        if matches!(
            args.first().map(String::as_str),
            Some("settings" | "skill" | "mcp" | "tags" | "trash")
        ) || args
            .get(..2)
            .is_some_and(|words| words == ["workspace", "trash"])
        {
            bail!("--workspace works with workspace, status, notify, agent and context commands");
        }
        if args.first().map(String::as_str) == Some("notify") && args.iter().any(|arg| arg == "--")
        {
            bail!(
                "--workspace doesn't work with `komla notify -- <command>`, which shows the terminal it runs in working"
            );
        }
        // The named workspace stands in for the calling terminal's.
        api.target_workspace(target);
        environment.target_workspace_id = Some(target.to_owned());
        environment.workspace_id = Some(target.to_owned());
        environment.terminal_id = None;
        environment.companion_inbox = None;
    }
    match args.first().map(String::as_str) {
        Some("settings") => settings_command(&args[1..], &environment, api, input, output),
        Some("skill") => skill_command(&args[1..], api, output, errors),
        Some("context") => context_command(&args[1..], &environment, api, output),
        Some(operation @ ("title" | "snooze" | "wake" | "tag" | "untag" | "trash")) => {
            let mut options = vec![operation.to_owned()];
            options.extend_from_slice(&args[1..]);
            workspace_command(&options, &environment, api, output)
        }
        Some("launch") => {
            let mut options = args[1..].to_vec();
            let here = take_flag(&mut options, "--here")?;
            if option_arguments(&options).any(|(_, arg)| arg == "--new-workspace") {
                bail!("komla launch creates a new workspace by default; use --here for a tab");
            }
            if here
                && option_arguments(&options).any(|(_, arg)| {
                    matches!(
                        arg,
                        "--project"
                            | "--name"
                            | "--description"
                            | "--branch"
                            | "--from-current-branch"
                    )
                })
            {
                bail!(
                    "--project, --name, --description, --branch, and --from-current-branch \
cannot be used with --here"
                );
            }
            options.insert(0, "launch".to_owned());
            if !here {
                options.insert(1, "--new-workspace".to_owned());
            }
            agent_command(&options, &environment, api, input, output)
        }
        Some("workspace") => workspace_command(&args[1..], &environment, api, output),
        Some("tags") => tags_command(&args[1..], &environment, api, output),
        Some("open") => open_command(&args[1..], &environment, api, output),
        Some("status") => status_command(&args[1..], &environment, api, input, output),
        Some("agent") => agent_command(&args[1..], &environment, api, input, output),
        Some("preview") => {
            let mut options = args[1..].to_vec();
            if !matches!(options.first().map(String::as_str), Some("open")) {
                options.insert(0, "open".to_owned());
            }
            preview_command(&options, &environment, api, output)
        }
        Some("notify") => notify_command(&args[1..], &environment, api, input, output, hook_input),
        Some("mcp") => mcp_command(&args[1..], api, input, output, errors),
        _ => bail!(USAGE),
    }
}

fn settings_command(
    args: &[String],
    environment: &CliEnvironment,
    api: &mut dyn KomlaApi,
    input: &mut dyn Read,
    output: &mut dyn Write,
) -> anyhow::Result<()> {
    let operation = args.first().context(SETTINGS_USAGE)?;
    let resource = args.get(1).context(SETTINGS_USAGE)?;
    let mut options = args[2..].to_vec();
    let scope = take_option(&mut options, "--scope")?;
    let file = take_option(&mut options, "--file")?;
    ensure_no_arguments(&options)?;
    let mut path = match resource.as_str() {
        "actions" => {
            let scope = scope.context("actions require --scope global or current-project")?;
            if scope != "global" && scope != "current-project" {
                bail!("actions scope must be global or current-project");
            }
            format!("/settings/actions?scope={scope}")
        }
        "workspace-setup" | "automations" | "appearance" | "status-items" | "hooks"
        | "shortcuts" | "terminal" | "agents" => {
            if scope.is_some() {
                bail!("{resource} does not accept --scope");
            }
            format!("/settings/{resource}")
        }
        _ => bail!(
            "settings resource must be actions, workspace-setup, automations, appearance, \
             status-items, hooks, shortcuts, terminal or agents"
        ),
    };
    if !environment.scoped_url && environment.terminal_id.is_none() {
        append_query(&mut path, "cwd", &environment.cwd);
    }
    let (method, body, allow_long_running) = match operation.as_str() {
        "get" => {
            if file.is_some() {
                bail!("--file is only valid with settings apply");
            }
            ("GET", Vec::new(), false)
        }
        "apply" => {
            let body = read_json_input(file.as_deref(), input)?;
            ("PUT", body, true)
        }
        _ => bail!("settings operation must be get or apply"),
    };
    let response = api.request(method, &path, &body, allow_long_running)?;
    write_success(response, output)
}

fn skill_command(
    args: &[String],
    api: &mut dyn KomlaApi,
    output: &mut dyn Write,
    errors: &mut dyn Write,
) -> anyhow::Result<()> {
    let name = args.first().context(SKILL_USAGE)?.as_str();
    if args.len() != 1 {
        bail!(SKILL_USAGE);
    }
    let filename = match SKILL_GUIDES.iter().find(|(guide, _)| *guide == name) {
        Some((_, filename)) => (*filename).to_owned(),
        None if name.ends_with(".md") => name.to_owned(),
        None => format!("{name}.md"),
    };
    if !filename
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || "._-".contains(character))
    {
        bail!("skill name contains unsupported characters");
    }
    match api.request("GET", &format!("/skills/{filename}"), &[], false) {
        Ok(response) => write_success(response, output),
        // A sandboxed agent can still read the guide; commands it runs next report the error.
        Err(error) if is_unreachable(&error) => {
            let Some(guide) = api.installed_guide(&filename) else {
                return Err(error);
            };
            writeln!(
                errors,
                "{error:#}. Showing the guide installed with Komla; its Komla commands need the \
                 connection. If a sandbox blocks network access, ask the user to approve running \
                 them with it; otherwise tell the user Komla can't be reached."
            )?;
            write_success(
                HttpResponse {
                    status: 200,
                    body: guide,
                },
                output,
            )
        }
        Err(error) => Err(error),
    }
}

fn workspace_command(
    args: &[String],
    environment: &CliEnvironment,
    api: &mut dyn KomlaApi,
    output: &mut dyn Write,
) -> anyhow::Result<()> {
    let operation = args
        .first()
        .context("usage: komla workspace <list|title|snooze|wake|tag|untag|trash> [arguments]")?;
    let mut options = args[1..].to_vec();
    match operation.as_str() {
        "list" => {
            let json_output = take_flag(&mut options, "--json")?;
            let include_trashed = take_flag(&mut options, "--all")?;
            if !options.is_empty() || environment.target_workspace_id.is_some() {
                bail!("usage: komla workspace list [--all] [--json]");
            }
            let request = if include_trashed {
                json!({"type": "workspace.list", "includeTrashed": true})
            } else {
                json!({"type": "workspace.list"})
            };
            let result = execute_operation(api, environment, request)?;
            if json_output {
                return write_operation_result(&result, true, output);
            }
            for workspace in result
                .get("workspaces")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let text = |name| workspace.get(name).and_then(Value::as_str);
                let mut line = format!(
                    "{}  {}",
                    text("id").unwrap_or(""),
                    text("name").unwrap_or("")
                );
                if let Some(branch) = text("branch") {
                    line.push_str(&format!("  [{branch}]"));
                }
                if let Some(tag) = text("tag") {
                    line.push_str(&format!("  ({tag})"));
                }
                writeln!(output, "{line}")?;
            }
            Ok(())
        }
        "title" => {
            let json_output = take_flag(&mut options, "--json")?;
            let description = take_option(&mut options, "--description")?;
            if options.len() != 1 {
                bail!("usage: komla workspace title <title> [--description <text>] [--cwd <path>]");
            }
            let mut operation = json!({"type": "workspace.title", "title": options.remove(0)});
            insert_json_optional(&mut operation, "description", description);
            let result = execute_operation(api, environment, operation)?;
            write_operation_result(&result, json_output, output)
        }
        "snooze" | "wake" => {
            let json_output = take_flag(&mut options, "--json")?;
            let until_notified =
                operation == "snooze" && take_flag(&mut options, "--until-notified")?;
            // A date and time may come as two arguments; Komla reads the time.
            let until = options.join(" ");
            let request = if operation == "snooze" {
                // Komla counts the length as JavaScript does, in UTF-16 code units.
                if (until.trim().is_empty() && !until_notified)
                    || until.encode_utf16().count() > MAX_SNOOZE_UNTIL
                {
                    bail!("usage: komla snooze <30m|2h|1d|17:30|YYYY-MM-DD HH:MM> [--until-notified] [--json]");
                }
                let mut request = json!({"type": "workspace.snooze"});
                if !until.trim().is_empty() {
                    request["until"] = json!(until);
                }
                if until_notified {
                    request["untilNotified"] = json!(true);
                }
                request
            } else {
                if !options.is_empty() {
                    bail!("usage: komla wake [--json]");
                }
                json!({"type": "workspace.wake"})
            };
            let result = execute_operation(api, environment, request)?;
            write_operation_result(&result, json_output, output)
        }
        "tag" | "untag" => {
            let json_output = take_flag(&mut options, "--json")?;
            let request = if operation == "tag" {
                let tooltip = take_option(&mut options, "--tooltip")?
                    .map(|value| value.trim().to_owned())
                    .filter(|value| !value.is_empty())
                    .map(|value| truncate_utf16(&value, MAX_TAG_TOOLTIP));
                let tone = take_option(&mut options, "--tone")?;
                if let Some(tone) = &tone {
                    if !TAG_TONES.contains(&tone.as_str()) {
                        bail!("--tone is {}, not {tone}", TAG_TONES.join(", "));
                    }
                }
                let icon = take_option(&mut options, "--icon")?
                    .map(|value| status_icon(&value))
                    .transpose()?;
                let spinner = take_flag(&mut options, "--spinner")?;
                let if_tag = take_option(&mut options, "--if")?
                    .map(|value| tag_name(&value, "--if"))
                    .transpose()?;
                // A tag of several words may come unquoted, as separate arguments.
                let mut request =
                    json!({"type": "workspace.tag", "tag": tag_name(&options.join(" "), "tag")?});
                insert_json_optional(&mut request, "tooltip", tooltip);
                insert_json_optional(&mut request, "tone", tone);
                insert_json_optional(&mut request, "icon", icon);
                insert_json_optional(&mut request, "ifTag", if_tag);
                if spinner {
                    request["spinner"] = json!(true);
                }
                request
            } else {
                let mut request = json!({"type": "workspace.tag"});
                if !options.is_empty() {
                    request["ifTag"] = json!(tag_name(&options.join(" "), "untag")?);
                }
                request
            };
            let result = execute_operation(api, environment, request)?;
            write_operation_result(&result, json_output, output)
        }
        "trash" => {
            let json_output = take_flag(&mut options, "--json")?;
            if !options.is_empty() {
                bail!("usage: komla trash [--json]");
            }
            let result = execute_operation(api, environment, json!({"type": "workspace.trash"}))?;
            write_operation_result(&result, json_output, output)
        }
        _ => bail!("workspace operation must be title, snooze, wake, tag, untag or trash"),
    }
}

fn tags_command(
    args: &[String],
    environment: &CliEnvironment,
    api: &mut dyn KomlaApi,
    output: &mut dyn Write,
) -> anyhow::Result<()> {
    let mut options = args.to_vec();
    let json_output = take_flag(&mut options, "--json")?;
    // `komla tags Blocked` is most likely `komla tag Blocked` mistyped.
    if !options.is_empty() {
        bail!("usage: komla tags [--json]; komla tag <tag> tags a workspace");
    }
    let result = execute_operation(api, environment, json!({"type": "tag.list"}))?;
    if json_output {
        return write_operation_result(&result, true, output);
    }
    for tag in result
        .get("tags")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let mut looks = vec![tag.get("tone").and_then(Value::as_str).unwrap_or("neutral")];
        if tag.get("hasIcon").and_then(Value::as_bool) == Some(true) {
            looks.push("icon");
        }
        if tag.get("spinner").and_then(Value::as_bool) == Some(true) {
            looks.push("spinner");
        }
        match tag.get("pullRequestState").and_then(Value::as_str) {
            Some("in-review") => looks.push("pull requests in review"),
            Some("needs-changes") => looks.push("pull requests needing changes"),
            _ => {}
        }
        if tag.get("hidden").and_then(Value::as_bool) == Some(true) {
            looks.push("hidden in the sidebar");
        }
        let name = tag.get("name").and_then(Value::as_str).unwrap_or("");
        writeln!(output, "{name}  ({})", looks.join(", "))?;
    }
    Ok(())
}

// Komla counts the length as JavaScript does, in UTF-16 code units.
fn tag_name(value: &str, what: &str) -> anyhow::Result<String> {
    let tag = value.trim();
    if tag.is_empty() || tag.encode_utf16().count() > MAX_TAG {
        bail!("{what} takes a tag of at most {MAX_TAG} characters; usage: komla tag <tag> [--tooltip <text>] [--tone <tone>] [--icon <file|svg>] [--spinner] [--if <tag>] [--json]");
    }
    Ok(tag.to_owned())
}

fn status_item_id(id: String) -> anyhow::Result<String> {
    let mut characters = id.chars();
    let valid = characters
        .next()
        .is_some_and(|first| first.is_ascii_alphanumeric())
        && characters
            .all(|character| character.is_ascii_alphanumeric() || "._-".contains(character))
        && id.len() <= 40;
    if !valid {
        bail!("status item ids are up to 40 letters, digits, dots, dashes and underscores, such as tests or pr");
    }
    Ok(id)
}

// Komla counts lengths as JavaScript does, in UTF-16 code units, after trimming.
fn bounded_status_text(name: &str, value: String, max: usize) -> anyhow::Result<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        bail!("{name} must not be empty");
    }
    if trimmed.encode_utf16().count() > max {
        bail!("{name} must be at most {max} characters");
    }
    Ok(trimmed.to_owned())
}

// The text as the status bar shows it, without terminal colors and links.
fn visible_status_text(text: &str) -> String {
    let mut visible = String::with_capacity(text.len());
    let mut characters = text.chars().peekable();
    while let Some(character) = characters.next() {
        if character != '\u{1b}' {
            visible.push(character);
            continue;
        }
        match characters.next() {
            // Parameters, then a final character from @ to ~.
            Some('[') => {
                for character in characters.by_ref() {
                    if ('@'..='~').contains(&character) {
                        break;
                    }
                }
            }
            // Up to BEL or ESC \.
            Some(']') => {
                while let Some(character) = characters.next() {
                    if character == '\u{7}' {
                        break;
                    }
                    if character == '\u{1b}' {
                        characters.next_if_eq(&'\\');
                        break;
                    }
                }
            }
            Some(other) => visible.push(other),
            None => {}
        }
    }
    visible
}

fn status_text(value: String) -> anyhow::Result<String> {
    let trimmed = value.trim();
    let visible = visible_status_text(trimmed);
    if visible.trim().is_empty() {
        bail!("status text must not be empty");
    }
    if visible.trim().encode_utf16().count() > MAX_STATUS_TEXT
        || trimmed.encode_utf16().count() > MAX_STATUS_RAW_TEXT
    {
        bail!("status text must be at most {MAX_STATUS_TEXT} characters, not counting terminal colors");
    }
    Ok(trimmed.to_owned())
}

// An icon: SVG markup and image data URLs go as they are; anything else names an image file,
// read here, so an agent on an SSH host can use its own files.
fn status_icon(value: &str) -> anyhow::Result<String> {
    use base64::Engine as _;

    let value = value.trim();
    if value.starts_with("<svg") || value.starts_with("data:image/") {
        if value.len() > MAX_STATUS_ICON_INPUT {
            bail!("icons must be at most {} KB", MAX_STATUS_ICON / 1024);
        }
        return Ok(value.to_owned());
    }
    let extension = Path::new(value)
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase);
    let media_type = match extension.as_deref() {
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        Some("jpg" | "jpeg") => "image/jpeg",
        _ => bail!(
            "icons are .svg, .png, .webp, .gif or .jpg files, SVG markup or an image data URL: {value}"
        ),
    };
    let mut file = fs::File::open(value).with_context(|| format!("could not read {value}"))?;
    let bytes = read_bounded(&mut file, MAX_STATUS_ICON, value)?;
    if bytes.is_empty() {
        bail!("{value} is empty");
    }
    Ok(format!(
        "data:{media_type};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

// Checks segments as Komla does, so a mistake is explained here rather than rejected as an
// invalid operation, and reads the icon files they name.
fn status_segments(json_text: &str) -> anyhow::Result<Value> {
    const EXAMPLE: &str = r#"[{"icon": "logo.svg"}, {"text": " CI", "color": "success"}]"#;
    let mut segments: Value = serde_json::from_str(json_text)
        .with_context(|| format!("segments must be a JSON array, such as {EXAMPLE}"))?;
    let Some(list) = segments.as_array_mut() else {
        bail!("segments must be a JSON array, such as {EXAMPLE}");
    };
    if list.is_empty() || list.len() > MAX_STATUS_SEGMENTS {
        bail!("segments must be 1 to {MAX_STATUS_SEGMENTS} parts");
    }
    let mut text = String::new();
    for segment in list.iter_mut() {
        let Some(fields) = segment.as_object_mut() else {
            bail!("each segment is an object, such as {EXAMPLE}");
        };
        if let Some(color) = fields.get("color") {
            if !color.as_str().is_some_and(is_status_color) {
                bail!("segment colors are success, warning, error, info, muted, foreground or a hex color such as #e5c07b");
            }
        }
        if let Some(icon) = fields.get("icon") {
            let Some(icon) = icon.as_str() else {
                bail!("a segment's icon is a file, SVG markup or an image data URL");
            };
            let icon = status_icon(icon)?;
            fields.insert("icon".to_owned(), Value::String(icon));
            if fields.keys().any(|key| key != "icon" && key != "color") {
                bail!("an icon segment takes only icon and color");
            }
            continue;
        }
        match fields.get("text").and_then(Value::as_str) {
            Some(part) if !part.is_empty() => text.push_str(part),
            _ => bail!("each segment has text or an icon, such as {EXAMPLE}"),
        }
        if fields.get("bold").is_some_and(|bold| !bold.is_boolean()) {
            bail!("a segment's bold is true or false");
        }
        if fields
            .keys()
            .any(|key| !matches!(key.as_str(), "text" | "color" | "bold"))
        {
            bail!("a text segment takes only text, color and bold");
        }
    }
    let visible = visible_status_text(&text);
    let visible = visible.trim();
    if visible.is_empty() || visible.encode_utf16().count() > MAX_STATUS_TEXT {
        bail!("segments must have 1 to {MAX_STATUS_TEXT} characters of text together");
    }
    Ok(segments)
}

fn is_status_color(color: &str) -> bool {
    if STATUS_THEME_COLORS.contains(&color) {
        return true;
    }
    color.strip_prefix('#').is_some_and(|digits| {
        matches!(digits.len(), 3 | 6) && digits.chars().all(|digit| digit.is_ascii_hexdigit())
    })
}

fn status_command(
    args: &[String],
    environment: &CliEnvironment,
    api: &mut dyn KomlaApi,
    input: &mut dyn Read,
    output: &mut dyn Write,
) -> anyhow::Result<()> {
    let mut options = args.get(1..).unwrap_or_default().to_vec();
    let json_output = take_flag(&mut options, "--json")?;
    let operation = match args.first().map(String::as_str) {
        Some("set") => {
            let tone = take_option(&mut options, "--tone")?;
            let color = take_option(&mut options, "--color")?;
            let tooltip = take_option(&mut options, "--tooltip")?;
            let link = take_option(&mut options, "--link")?;
            let popover_option = take_option(&mut options, "--popover")?;
            let popover_file = take_option(&mut options, "--popover-file")?;
            let icon = take_option(&mut options, "--icon")?;
            let icon_color = take_option(&mut options, "--icon-color")?;
            let segments_option = take_option(&mut options, "--segments")?;
            let segments_file = take_option(&mut options, "--segments-file")?;
            if popover_option.is_some() && popover_file.is_some() {
                bail!("use only one of --popover or --popover-file");
            }
            if segments_option.is_some() && segments_file.is_some() {
                bail!("use only one of --segments or --segments-file");
            }
            if popover_file.as_deref() == Some("-") && segments_file.as_deref() == Some("-") {
                bail!("only one of --popover-file and --segments-file can read stdin");
            }
            let has_segments = segments_option.is_some() || segments_file.is_some();
            let arguments = if has_segments { 1 } else { 2 };
            if options.len() != arguments || options.iter().any(|option| option.starts_with("--")) {
                if has_segments && options.len() == 2 {
                    bail!("give the text or --segments, not both");
                }
                bail!(STATUS_USAGE);
            }
            let text = if has_segments {
                None
            } else {
                Some(status_text(options.remove(1))?)
            };
            let id = status_item_id(options.remove(0))?;
            let segments = match segments_file {
                Some(path) => Some(read_text_input(&path, input, "segments")?),
                None => segments_option,
            }
            .map(|segments| status_segments(&segments))
            .transpose()?;
            let icon = icon.map(|icon| status_icon(&icon)).transpose()?;
            if let Some(icon_color) = &icon_color {
                if icon.is_none() {
                    bail!("--icon-color colors the --icon, so it needs one");
                }
                if !is_status_color(icon_color) {
                    bail!("--icon-color must be success, warning, error, info, muted, foreground or a hex color such as #e5c07b");
                }
            }
            if let Some(Value::Array(list)) = &segments {
                let icons = list.iter().filter(|segment| segment.get("icon").is_some());
                if icons.count() + usize::from(icon.is_some()) > MAX_STATUS_ICONS {
                    bail!("a status item shows at most {MAX_STATUS_ICONS} icons");
                }
            }
            if let Some(tone) = &tone {
                if !STATUS_TONES.contains(&tone.as_str()) {
                    bail!("--tone must be success, warning, error or info");
                }
            }
            if let Some(color) = &color {
                if !is_status_color(color) {
                    bail!("--color must be success, warning, error, info, muted, foreground or a hex color such as #e5c07b");
                }
            }
            let tooltip = tooltip
                .map(|tooltip| bounded_status_text("--tooltip", tooltip, MAX_STATUS_TOOLTIP))
                .transpose()?;
            let popover = match popover_file {
                Some(path) => Some(read_text_input(&path, input, "popover")?),
                None => popover_option,
            }
            .map(|popover| bounded_status_text("popover", popover, MAX_STATUS_POPOVER))
            .transpose()?;
            if let Some(link) = &link {
                if !(link.starts_with("http://") || link.starts_with("https://")) {
                    bail!("--link must be an http:// or https:// URL");
                }
            }
            let mut operation = json!({"type": "status.set", "id": id});
            insert_json_optional(&mut operation, "text", text);
            if let Some(segments) = segments {
                operation["segments"] = segments;
            }
            insert_json_optional(&mut operation, "icon", icon);
            insert_json_optional(&mut operation, "iconColor", icon_color);
            insert_json_optional(&mut operation, "tone", tone);
            insert_json_optional(&mut operation, "color", color);
            insert_json_optional(&mut operation, "tooltip", tooltip);
            insert_json_optional(&mut operation, "link", link);
            insert_json_optional(&mut operation, "popover", popover);
            operation
        }
        Some("clear") => {
            if options.len() > 1 || options.iter().any(|option| option.starts_with("--")) {
                bail!(STATUS_USAGE);
            }
            let mut operation = json!({"type": "status.clear"});
            insert_json_optional(
                &mut operation,
                "id",
                options.pop().map(status_item_id).transpose()?,
            );
            operation
        }
        Some("refresh") => {
            if options.len() != 1 || options[0].starts_with("--") {
                bail!(STATUS_USAGE);
            }
            json!({"type": "status.refresh", "id": status_item_id(options.remove(0))?})
        }
        _ => bail!(STATUS_USAGE),
    };
    let refresh = operation["type"] == "status.refresh";
    let result = execute_operation(api, environment, operation)?;
    write_operation_result(&result, json_output, output)?;
    // A command that failed shows as failed in the status bar; scripts see it too.
    match result.pointer("/status/error").and_then(Value::as_str) {
        Some(error) if refresh => bail!("the item's command failed: {error}"),
        _ => Ok(()),
    }
}

fn agent_command(
    args: &[String],
    environment: &CliEnvironment,
    api: &mut dyn KomlaApi,
    input: &mut dyn Read,
    output: &mut dyn Write,
) -> anyhow::Result<()> {
    match args.first().map(String::as_str) {
        Some("presets") => {
            let mut options = args[1..].to_vec();
            let include_inactive = take_flag(&mut options, "--all")?;
            let json_output = take_flag(&mut options, "--json")?;
            ensure_no_arguments(&options)?;
            let result = execute_operation(
                api,
                environment,
                json!({"type": "agent.presets", "includeInactive": include_inactive}),
            )?;
            write_operation_result(&result, json_output, output)
        }
        Some("launch") => {
            let mut options = args[1..].to_vec();
            let new_workspace = take_flag(&mut options, "--new-workspace")?;
            let destination = if new_workspace { "workspace" } else { "tab" };
            let json_output = take_flag(&mut options, "--json")?;
            let prompt_option = take_option(&mut options, "--prompt")?;
            let prompt_file = take_option(&mut options, "--prompt-file")?;
            if prompt_option.is_some() && prompt_file.is_some() {
                bail!("use only one of --prompt or --prompt-file");
            }
            let preset = take_option(&mut options, "--preset")?;
            let mode = take_option(&mut options, "--mode")?;
            if mode.is_some() && preset.is_none() {
                bail!("--mode requires --preset");
            }
            let name = take_option(&mut options, "--name")?;
            let description = take_option(&mut options, "--description")?;
            let branch = take_option(&mut options, "--branch")?;
            let from_current_branch = take_flag(&mut options, "--from-current-branch")?;
            let project = take_option(&mut options, "--project")?;
            if destination == "tab"
                && (project.is_some()
                    || name.is_some()
                    || description.is_some()
                    || branch.is_some()
                    || from_current_branch)
            {
                bail!(
                    "--project, --name, --description, --branch, and --from-current-branch \
require --new-workspace"
                );
            }
            let positional_prompt = match options.as_slice() {
                [] => None,
                [prompt] if !prompt.starts_with('-') => Some(prompt.clone()),
                _ => bail!(
                    "usage: komla agent launch [prompt] [--new-workspace] [--preset <name-or-id>]"
                ),
            };
            if positional_prompt.is_some() && (prompt_option.is_some() || prompt_file.is_some()) {
                bail!("provide the prompt positionally or with --prompt/--prompt-file, not both");
            }
            let prompt = match (positional_prompt, prompt_option, prompt_file) {
                (Some(prompt), None, None) | (None, Some(prompt), None) => Some(prompt),
                (None, None, Some(path)) => Some(read_text_input(&path, input, "prompt")?),
                (None, None, None) => None,
                _ => unreachable!(),
            };
            let offline_request = OfflineLaunchRequest {
                prompt: prompt.clone(),
                name: name.clone(),
                description: description.clone(),
                branch: branch.clone(),
                from_current_branch,
                cwd: None,
            };
            let offline_unsupported = preset.is_some() || mode.is_some() || project.is_some();
            let mut operation = json!({
                "type": "agent.launch",
                "destination": destination
            });
            insert_json_optional(&mut operation, "preset", preset);
            insert_json_optional(&mut operation, "mode", mode);
            insert_json_optional(&mut operation, "prompt", prompt);
            insert_json_optional(&mut operation, "project", project);
            insert_json_optional(&mut operation, "name", name);
            insert_json_optional(&mut operation, "description", description);
            insert_json_optional(&mut operation, "branch", branch);
            if from_current_branch {
                operation["fromCurrentBranch"] = json!(true);
            }
            let result = match execute_operation(api, environment, operation) {
                Err(error) if destination == "workspace" && is_unreachable(&error) => {
                    if offline_unsupported {
                        bail!(
                            "Komla isn't connected, so --preset, --mode, and --project are unavailable. \
Leave them out to start this workspace's agent in a new workspace on this host."
                        );
                    }
                    let created = api.create_workspace_offline(&offline_request)?;
                    if json_output {
                        writeln!(output, "{}", created.operation_result())?;
                    } else {
                        writeln!(output, "{}", created.summary())?;
                    }
                    return Ok(());
                }
                result => result?,
            };
            write_operation_result(&result, json_output, output)
        }
        _ => bail!("usage: komla agent <presets|launch> [arguments]"),
    }
}

fn context_command(
    args: &[String],
    environment: &CliEnvironment,
    api: &mut dyn KomlaApi,
    output: &mut dyn Write,
) -> anyhow::Result<()> {
    let mut options = args.to_vec();
    let json_output = take_flag(&mut options, "--json")?;
    ensure_no_arguments(&options)?;
    let result = execute_operation(api, environment, json!({"type": "context.get"}))?;
    write_operation_result(&result, json_output, output)
}

fn open_command(
    args: &[String],
    environment: &CliEnvironment,
    api: &mut dyn KomlaApi,
    output: &mut dyn Write,
) -> anyhow::Result<()> {
    let mut options = args.to_vec();
    let json_output = take_flag(&mut options, "--json")?;
    if options.len() > 1
        || options
            .first()
            .is_some_and(|option| option.starts_with('-'))
    {
        bail!("usage: komla open [folder] [--json]");
    }
    // Komla resolves the folder, so `.` and `..` reach it as they are here.
    let folder = Path::new(&environment.cwd).join(options.first().map_or(".", String::as_str));
    let result = execute_operation(
        api,
        environment,
        json!({"type": "folder.open", "path": folder.to_string_lossy()}),
    )?;
    write_operation_result(&result, json_output, output)
}

fn preview_command(
    args: &[String],
    environment: &CliEnvironment,
    api: &mut dyn KomlaApi,
    output: &mut dyn Write,
) -> anyhow::Result<()> {
    let operation = args
        .first()
        .context("usage: komla preview open [url] [--cwd <path>]")?;
    let mut options = args[1..].to_vec();
    let json_output = take_flag(&mut options, "--json")?;
    match operation.as_str() {
        "open" => {
            if options.len() > 1 {
                bail!("usage: komla preview open [url] [--cwd <path>]");
            }
            let mut operation = json!({"type": "preview.open"});
            insert_json_optional(&mut operation, "url", options.pop());
            let result = execute_operation(api, environment, operation)?;
            write_operation_result(&result, json_output, output)
        }
        _ => bail!("preview operation must be open"),
    }
}

fn notify_command(
    args: &[String],
    environment: &CliEnvironment,
    api: &mut dyn KomlaApi,
    input: &mut dyn Read,
    output: &mut dyn Write,
    preloaded_hook_input: Option<(Value, bool)>,
) -> anyhow::Result<()> {
    let mut options = args.to_vec();
    // A hook's own notifications run no hooks, so one can't set itself off again.
    let source = take_option(&mut options, "--source")?.unwrap_or_else(|| {
        if non_empty_env("KOMLA_HOOK_ID").is_some() {
            "hook"
        } else {
            "agent"
        }
        .to_owned()
    });
    let event = take_option(&mut options, "--event")?;
    let is_hook = event.is_some();
    if is_hook && environment.runs_hook_for_other_work(&source) {
        return Ok(());
    }
    // Agent hook runners parse hook stdout as protocol JSON (Codex rejects
    // unknown fields), so hook invocations must not echo Komla's response.
    let mut hook_stdout = std::io::sink();
    let output: &mut dyn Write = if is_hook && !environment.stdout_is_terminal {
        &mut hook_stdout
    } else {
        output
    };
    let message_option = take_option(&mut options, "--message")?;
    let body = take_option(&mut options, "--body")?
        .map(|value| truncate_utf16(&value, MAX_NOTIFICATION_BODY_UTF16_UNITS));
    let color = take_option(&mut options, "--color")?
        .filter(|value| !value.is_empty())
        .map(|value| truncate_utf16(&value, MAX_NOTIFICATION_COLOR_UTF16_UNITS));
    let badge = take_option(&mut options, "--badge")?
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .map(|value| truncate_utf16(&value, MAX_NOTIFICATION_BADGE_UTF16_UNITS));
    let icon = take_option(&mut options, "--icon")?
        .map(|value| status_icon(&value))
        .transpose()?;
    let icon_color = take_option(&mut options, "--icon-color")?;
    if let Some(icon_color) = &icon_color {
        if !is_status_color(icon_color) {
            bail!("--icon-color must be success, warning, error, info, muted, foreground or a hex color such as #e5c07b");
        }
    }
    let explicit_kind = take_option(&mut options, "--kind")?;
    let positional_kind = if explicit_kind.is_none() && event.is_none() {
        options
            .first()
            .filter(|value| is_notification_kind(value))
            .cloned()
    } else {
        None
    };
    if positional_kind.is_some() {
        options.remove(0);
    }
    let title = match options.as_slice() {
        [] => None,
        [title] if !title.starts_with('-') => {
            let title = title.trim();
            (!title.is_empty()).then(|| truncate_utf16(title, MAX_NOTIFICATION_TITLE_UTF16_UNITS))
        }
        _ => bail!(NOTIFY_USAGE),
    };
    if title.is_some() && message_option.is_some() {
        bail!("use --body, not --message, with a notification title");
    }
    let has_kind_input = explicit_kind.is_some() || positional_kind.is_some() || event.is_some();
    let (mut hook_input, mut hook_input_was_oversized) = if environment.stdin_is_terminal {
        (json!({}), false)
    } else if let Some(hook_input) = preloaded_hook_input {
        hook_input
    } else {
        read_optional_json(input)?
    };
    // Komla reads nothing of a tool's output, which may be large.
    if matches!(event.as_deref(), Some("PostToolUse" | "PostToolUseFailure")) {
        if let Some(object) = hook_input.as_object_mut() {
            object.remove("tool_response");
        }
        hook_input_was_oversized = hook_input_was_oversized
            && serde_json::to_vec(&hook_input)
                .map_or(true, |bytes| bytes.len() > MAX_FORWARDED_HOOK_INPUT_BYTES);
    }
    let cwd = (!environment.explicit_cwd)
        .then(|| hook_workspace(&source, &hook_input))
        .flatten()
        .unwrap_or_else(|| environment.cwd.clone());
    let mut hook_input = compact_hook_input(&source, hook_input, hook_input_was_oversized);
    if let Some(event_name) = event.as_ref() {
        if !hook_input.is_object() {
            hook_input = json!({});
        }
        if hook_input.get("hook_event_name").is_none() {
            hook_input["hook_event_name"] = json!(event_name);
        }
        // An automatic compact happens inside a turn, which ends with its own Stop.
        if event_name == "PostCompact"
            && hook_input.get("trigger").and_then(Value::as_str) != Some("manual")
        {
            return Ok(());
        }
    }
    if let Some(kind) = explicit_kind.as_deref() {
        if !is_notification_kind(kind) {
            bail!("unsupported notification kind: {kind}");
        }
    }
    let kind = explicit_kind
        .or(positional_kind)
        .or_else(|| {
            event
                .as_deref()
                .map(|event| kind_from_hook(&source, event, &hook_input).to_owned())
        })
        .unwrap_or_else(|| "generic".to_owned());
    let message = message_option
        .or_else(|| message_from_hook(&source, event.as_deref(), &hook_input))
        // Komla records a prompt-submit's message as the user's prompt, so an
        // event name must not stand in for missing prompt text.
        .or_else(|| event.filter(|_| kind != "prompt-submit"))
        .unwrap_or_default();
    if !has_kind_input && title.is_none() && message.is_empty() {
        bail!(NOTIFY_USAGE);
    }
    check_workspace_target(api, environment)?;
    deliver_notification(
        Notification {
            cwd,
            kind,
            source,
            message,
            hook_input,
            presentation: NotificationPresentation {
                title,
                body,
                color,
                badge,
                icon,
                icon_color,
            },
        },
        environment,
        api,
        output,
        // A hook blocks the agent until it exits, so it must not wait on a stalled Komla.
        !is_hook,
    )
}

/// A notification for another workspace is matched by its id alone, so an unknown id must fail
/// before Komla falls back to the calling folder's workspace.
fn check_workspace_target(
    api: &mut dyn KomlaApi,
    environment: &CliEnvironment,
) -> anyhow::Result<()> {
    let Some(target) = environment.target_workspace_id.as_deref() else {
        return Ok(());
    };
    let result = execute_operation(api, environment, json!({"type": "context.get"}))?;
    if result
        .pointer("/context/workspace/id")
        .and_then(Value::as_str)
        != Some(target)
    {
        bail!("No workspace has the id {target}; `komla workspace list --json` lists them.");
    }
    Ok(())
}

/// A notification for the current terminal, as `komla notify` sends it.
struct Notification {
    cwd: String,
    kind: String,
    source: String,
    message: String,
    hook_input: Value,
    presentation: NotificationPresentation,
}

/// Queues the notification in the companion's mailbox in a managed SSH workspace, and sends it
/// to Komla otherwise.
fn deliver_notification(
    notification: Notification,
    environment: &CliEnvironment,
    api: &mut dyn KomlaApi,
    output: &mut dyn Write,
    allow_long_running: bool,
) -> anyhow::Result<()> {
    let Notification {
        cwd,
        kind,
        source,
        message,
        hook_input,
        presentation,
    } = notification;
    let terminal_id = environment.terminal_id.clone();
    if let (Some(inbox), Some(terminal_id)) = (&environment.companion_inbox, &terminal_id) {
        let hook =
            PendingTerminalHook::new(terminal_id.clone(), cwd, kind, source, message, hook_input)
                .with_presentation(presentation);
        mailbox::deliver(inbox, &hook)?;
        writeln!(output, "{{\"queued\":true}}")?;
        return Ok(());
    }
    let mut payload = json!({
        "cwd": cwd,
        "kind": kind,
        "source": source,
        "message": message,
        "hookInput": hook_input,
    });
    let NotificationPresentation {
        title,
        body,
        color,
        badge,
        icon,
        icon_color,
    } = presentation;
    insert_json_optional(&mut payload, "title", title);
    insert_json_optional(&mut payload, "body", body);
    insert_json_optional(&mut payload, "color", color);
    insert_json_optional(&mut payload, "badge", badge);
    insert_json_optional(&mut payload, "icon", icon);
    insert_json_optional(&mut payload, "iconColor", icon_color);
    insert_json_optional(&mut payload, "terminalId", terminal_id);
    insert_json_optional(
        &mut payload,
        "workspaceId",
        environment.target_workspace_id.clone(),
    );
    let response = api.request(
        "POST",
        "/api/v1/notify",
        &serde_json::to_vec(&payload)?,
        allow_long_running,
    )?;
    write_success(response, output)
}

/// Set by Ctrl-C while `komla notify -- <command>` waits, as the command gets it too.
static COMMAND_INTERRUPTED: AtomicBool = AtomicBool::new(false);
/// The command `komla notify --` runs, which gets the SIGTERM or SIGHUP sent to `komla`.
#[cfg(unix)]
static COMMAND_CHILD: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);
/// A SIGTERM or SIGHUP that came before the command started.
#[cfg(unix)]
static COMMAND_TERMINATION: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);

/// The title and command of `komla notify [<title>] -- <command>`; None for a notification.
fn notify_run_arguments(args: &[String]) -> Option<(Option<&str>, &[String])> {
    match args {
        [notify, separator, command @ ..] if notify == "notify" && separator == "--" => {
            Some((None, command))
        }
        [notify, title, separator, command @ ..]
            if notify == "notify" && separator == "--" && !title.starts_with('-') =>
        {
            Some((
                Some(title.trim()).filter(|title| !title.is_empty()),
                command,
            ))
        }
        _ => None,
    }
}

/// Runs `komla notify [<title>] -- <command>` and exits as the command did. Outside a Komla
/// terminal the command just runs, without notifications.
fn notify_when_done(title: Option<&str>, command: &[String]) -> anyhow::Result<()> {
    if command.is_empty() {
        bail!(NOTIFY_USAGE);
    }
    let mut notify = |event: CommandEvent| {
        // Read again for each notification: another device can take a managed session over
        // while the command runs.
        let Some(mut api) = command_route() else {
            return;
        };
        let environment = api.environment.clone();
        notify_command_event(event, &environment, &mut api, &mut std::io::stderr());
    };
    let exit = run_notifying(
        title,
        command,
        &mut notify,
        &COMMAND_INTERRUPTED,
        &mut std::io::stderr(),
    )?;
    // A shell stops a script when a command dies of Ctrl-C, but not when it exits with 130.
    #[cfg(unix)]
    if exit.signal == Some(libc::SIGINT) {
        unsafe {
            libc::signal(libc::SIGINT, libc::SIG_DFL);
            libc::raise(libc::SIGINT);
        }
    }
    std::process::exit(exit.code)
}

/// The API of the Komla terminal this runs in, or None outside one.
fn command_route() -> Option<HttpKomlaApi> {
    CliEnvironment::current()
        .ok()
        .filter(|environment| environment.terminal_id.is_some())
        .map(|environment| HttpKomlaApi { environment })
}

/// Sends what `komla notify -- <command>` reports about the command, warning when Komla
/// doesn't take it.
fn notify_command_event(
    event: CommandEvent,
    environment: &CliEnvironment,
    api: &mut dyn KomlaApi,
    errors: &mut dyn Write,
) {
    let notification = Notification {
        cwd: environment.cwd.clone(),
        kind: event.kind.to_owned(),
        source: "command".to_owned(),
        // A prompt-submit's message would name the workspace after the command.
        message: String::new(),
        hook_input: json!({ "hook_event_name": event.event }),
        presentation: NotificationPresentation {
            title: event.title,
            body: event.body,
            ..NotificationPresentation::default()
        },
    };
    if let Err(error) =
        deliver_notification(notification, environment, api, &mut std::io::sink(), false)
    {
        let _ = writeln!(errors, "komla: could not notify Komla: {error:#}");
    }
}

/// How `komla notify -- <command>` exits: with the command's code, or by the signal that
/// killed it.
#[derive(Debug, PartialEq)]
struct CommandExit {
    code: i32,
    signal: Option<i32>,
}

/// Shows the terminal as working while `command` runs, then notifies how it ended, unless it
/// failed after Ctrl-C: whoever pressed it is there already.
fn run_notifying(
    title: Option<&str>,
    command: &[String],
    notify: &mut dyn FnMut(CommandEvent),
    interrupted: &AtomicBool,
    errors: &mut dyn Write,
) -> anyhow::Result<CommandExit> {
    let started = Instant::now();
    // Before the command starts, so a signal can't kill `komla` and leave it running unseen.
    note_command_interrupts(true);
    let mut child = match crate::desktop::platform_command(command).spawn() {
        Ok(child) => child,
        Err(error) => {
            note_command_interrupts(false);
            writeln!(errors, "komla: could not run {}: {error}", command[0])?;
            return Ok(CommandExit {
                code: if error.kind() == std::io::ErrorKind::NotFound {
                    127
                } else {
                    126
                },
                signal: None,
            });
        }
    };
    forward_command_termination(child.id());
    notify(CommandEvent {
        event: "UserPromptSubmit",
        kind: "prompt-submit",
        title: None,
        body: None,
    });
    let status = child.wait();
    // Ctrl-C can stop a slow notification again once the command is gone.
    note_command_interrupts(false);
    let status = status.with_context(|| format!("could not wait for {}", command[0]))?;
    let (code, failure) = command_exit(status);
    notify(command_end(
        title,
        &display_command(command),
        failure.as_deref(),
        // Whatever code a program exits with on Ctrl-C, as pytest exits with 2.
        interrupted.load(Ordering::SeqCst) && !status.success(),
        started.elapsed(),
    ));
    #[cfg(unix)]
    let signal = std::os::unix::process::ExitStatusExt::signal(&status);
    #[cfg(not(unix))]
    let signal = None;
    Ok(CommandExit { code, signal })
}

/// A hook event `komla notify -- <command>` reports, with the notification's title and body.
#[derive(Debug, PartialEq)]
struct CommandEvent {
    event: &'static str,
    kind: &'static str,
    title: Option<String>,
    body: Option<String>,
}

fn command_end(
    title: Option<&str>,
    command: &str,
    failure: Option<&str>,
    interrupted: bool,
    elapsed: Duration,
) -> CommandEvent {
    // Stops the working spinner without a notification.
    if interrupted {
        return CommandEvent {
            event: "Interrupt",
            kind: "interrupted",
            title: None,
            body: None,
        };
    }
    let elapsed = format_elapsed(elapsed);
    let (event, kind, default_title, body) = match failure {
        None => (
            "Stop",
            "turn-complete",
            "Done",
            format!("{command} finished in {elapsed}"),
        ),
        // Komla ends a turn on an error only when it is a StopFailure.
        Some(failure) => (
            "StopFailure",
            "error",
            "Failed",
            format!("{command} failed with {failure} after {elapsed}"),
        ),
    };
    CommandEvent {
        event,
        kind,
        title: Some(truncate_utf16(
            title.unwrap_or(default_title),
            MAX_NOTIFICATION_TITLE_UTF16_UNITS,
        )),
        body: Some(truncate_utf16(&body, MAX_NOTIFICATION_BODY_UTF16_UNITS)),
    }
}

/// The code to exit with, as a shell would, and how the command failed, if it did.
fn command_exit(status: ExitStatus) -> (i32, Option<String>) {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(signal) = status.signal() {
            return (128 + signal, Some(format!("signal {signal}")));
        }
    }
    let code = status.code().unwrap_or(1);
    (code, (code != 0).then(|| format!("exit code {code}")))
}

/// The command as it might have been typed, quoting arguments with spaces or quotes.
fn display_command(command: &[String]) -> String {
    command
        .iter()
        .map(|argument| {
            if argument.is_empty()
                || argument.contains(|character: char| {
                    character.is_whitespace() || character == '\'' || character == '"'
                })
            {
                offline_workspace::shell_quote(argument)
            } else {
                argument.clone()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn format_elapsed(elapsed: Duration) -> String {
    let seconds = elapsed.as_secs();
    match seconds {
        0..=59 => format!("{seconds}s"),
        60..=3599 => format!("{}m {}s", seconds / 60, seconds % 60),
        _ => format!("{}h {}m", seconds / 3600, seconds % 3600 / 60),
    }
}

#[cfg(unix)]
extern "C" fn note_command_interrupt(_signal: libc::c_int) {
    COMMAND_INTERRUPTED.store(true, Ordering::SeqCst);
}

#[cfg(unix)]
extern "C" fn pass_command_termination(signal: libc::c_int) {
    let child = COMMAND_CHILD.load(Ordering::SeqCst);
    if child > 0 {
        unsafe {
            libc::kill(child, signal);
        }
    } else {
        COMMAND_TERMINATION.store(signal, Ordering::SeqCst);
    }
}

/// Keeps `komla notify` running through Ctrl-C (and Ctrl-\) while the command runs, as the
/// command gets them too, so it can stop the working spinner once the command exits, and
/// passes SIGTERM and SIGHUP on to the command; `false` restores them. A handler, unlike an
/// ignored signal, doesn't carry over to the command.
#[cfg(unix)]
fn note_command_interrupts(note: bool) {
    if !note {
        COMMAND_CHILD.store(0, Ordering::SeqCst);
    }
    let interrupt = note_command_interrupt as *const () as libc::sighandler_t;
    let termination = pass_command_termination as *const () as libc::sighandler_t;
    for (signal, handler) in [
        (libc::SIGINT, interrupt),
        (libc::SIGQUIT, interrupt),
        (libc::SIGTERM, termination),
        (libc::SIGHUP, termination),
    ] {
        unsafe {
            libc::signal(signal, if note { handler } else { libc::SIG_DFL });
        }
    }
}

/// Sends the started command the SIGTERM and SIGHUP `komla` gets, and one that came already.
#[cfg(unix)]
fn forward_command_termination(child: u32) {
    let child = child as i32;
    COMMAND_CHILD.store(child, Ordering::SeqCst);
    let pending = COMMAND_TERMINATION.swap(0, Ordering::SeqCst);
    if pending != 0 {
        unsafe {
            libc::kill(child, pending);
        }
    }
}

/// Windows has no SIGTERM: closing the console ends the command too.
#[cfg(windows)]
fn forward_command_termination(_child: u32) {}

#[cfg(windows)]
unsafe extern "system" fn note_command_interrupt(event: u32) -> i32 {
    // CTRL_C_EVENT and CTRL_BREAK_EVENT; closing the console still ends the process.
    if event > 1 {
        return 0;
    }
    COMMAND_INTERRUPTED.store(true, Ordering::SeqCst);
    1
}

/// Keeps `komla notify` running through Ctrl-C and Ctrl-Break while the command runs, as the
/// command gets them too; `false` restores them. A handler routine, unlike ignoring Ctrl-C,
/// doesn't carry over to the command.
#[cfg(windows)]
fn note_command_interrupts(note: bool) {
    #[link(name = "kernel32")]
    extern "system" {
        fn SetConsoleCtrlHandler(
            handler: Option<unsafe extern "system" fn(u32) -> i32>,
            add: i32,
        ) -> i32;
    }
    unsafe {
        SetConsoleCtrlHandler(Some(note_command_interrupt), note as i32);
    }
}

/// Antigravity runs global hooks from its config directory, so take the
/// workspace from the payload instead.
fn hook_workspace(source: &str, hook_input: &Value) -> Option<String> {
    if source != "antigravity" {
        return None;
    }
    hook_input
        .get("workspacePaths")?
        .as_array()?
        .first()?
        .as_str()
        .map(str::to_owned)
}

fn kind_from_hook<'a>(source: &str, event: &'a str, hook_input: &Value) -> &'a str {
    if source == "antigravity" {
        // Protojson omits zero and false, so a missing invocationNum is the
        // turn's first model call and a missing fullyIdle is not idle.
        return match event {
            "PreInvocation" => match hook_input.get("invocationNum").and_then(Value::as_u64) {
                None | Some(0) => "prompt-submit",
                Some(_) => "activity",
            },
            "PostToolUse" => "activity",
            "Stop" if hook_input.get("fullyIdle").and_then(Value::as_bool) == Some(true) => {
                "turn-complete"
            }
            "Stop" => "activity",
            _ => "generic",
        };
    }
    if source == "claude-code" && event == "Notification" {
        return match hook_input.get("notification_type").and_then(Value::as_str) {
            Some("permission_prompt" | "elicitation_dialog") => "input-required",
            Some("idle_prompt") => "idle",
            _ => "generic",
        };
    }
    match event {
        // A manual /compact runs as its own command, which sends no Stop.
        "Stop" | "AfterAgent" | "PostCompact" => "turn-complete",
        "UserPromptSubmit" | "BeforeAgent" => "prompt-submit",
        "PermissionRequest" => "input-required",
        "PreToolUse" | "PostToolUse" | "PostToolUseFailure" | "BeforeTool" => "activity",
        // Claude ends a turn that fails on an API error with StopFailure instead of Stop.
        "StopFailure" => "error",
        // The turn stopped without news: Codex was cancelled, or Claude quit.
        "Interrupt" | "SessionEnd" => "interrupted",
        _ => "generic",
    }
}

fn message_from_hook(source: &str, event: Option<&str>, hook_input: &Value) -> Option<String> {
    if source != "claude-code" {
        return None;
    }
    let field = match event {
        Some("Stop") => hook_input
            .get("last_assistant_message")
            .or_else(|| hook_input.get("message")),
        Some("StopFailure") => ["last_assistant_message", "error_details", "error"]
            .into_iter()
            .filter_map(|field| hook_input.get(field))
            .find(|value| value.as_str().is_some_and(|text| !text.trim().is_empty())),
        Some("PostCompact") => return Some("Compacted the conversation".to_owned()),
        Some("PermissionRequest") => return Some(claude_permission_message(hook_input)),
        _ => hook_input.get("message"),
    };
    field.and_then(Value::as_str).map(str::to_owned)
}

/// What Claude's permission prompt asks: the question it puts to the user, or the tool call it
/// wants to make, on one line and short enough for a notification.
fn claude_permission_message(hook_input: &Value) -> String {
    let text = |value: Option<&Value>| {
        value
            .and_then(Value::as_str)
            .map(|text| text.split_whitespace().collect::<Vec<_>>().join(" "))
            .filter(|text| !text.is_empty())
            .map(|text| truncate_utf16(&text, MAX_PERMISSION_MESSAGE_UTF16_UNITS))
    };
    let tool_input = hook_input.get("tool_input");
    let question = tool_input
        .and_then(|input| input.get("questions"))
        .and_then(|questions| questions.get(0))
        .and_then(|question| text(question.get("question")));
    question
        .or_else(|| text(tool_input.and_then(|input| input.get("description"))))
        .or_else(|| text(tool_input.and_then(|input| input.get("command"))))
        .or_else(|| {
            text(hook_input.get("tool_name"))
                .map(|tool| format!("Claude needs approval for {tool}"))
        })
        .unwrap_or_else(|| "Claude needs approval".to_owned())
}

/// The kinds `--kind` accepts. Only an agent hook may report `interrupted`.
fn is_notification_kind(value: &str) -> bool {
    matches!(
        value,
        "input-required"
            | "turn-complete"
            | "error"
            | "idle"
            | "generic"
            | "prompt-submit"
            | "activity"
    )
}

fn truncate_utf16(value: &str, max_units: usize) -> String {
    let mut units = 0;
    value
        .chars()
        .take_while(|character| {
            let next_units = units + character.len_utf16();
            if next_units > max_units {
                return false;
            }
            units = next_units;
            true
        })
        .collect()
}

fn mcp_command(
    args: &[String],
    api: &mut dyn KomlaApi,
    input: &mut dyn BufRead,
    output: &mut dyn Write,
    errors: &mut dyn Write,
) -> anyhow::Result<()> {
    if !args.is_empty() {
        bail!("usage: komla mcp");
    }
    mcp_stdio(api, input, output, errors)
}

fn mcp_stdio(
    api: &mut dyn KomlaApi,
    input: &mut dyn BufRead,
    output: &mut dyn Write,
    errors: &mut dyn Write,
) -> anyhow::Result<()> {
    let mut line = String::new();
    loop {
        line.clear();
        if input.read_line(&mut line)? == 0 {
            return Ok(());
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let request: Value = match serde_json::from_str(trimmed) {
            Ok(request) => request,
            Err(error) => {
                writeln!(
                    errors,
                    "komla mcp: ignoring invalid JSON-RPC input: {error}"
                )?;
                continue;
            }
        };
        api.refresh_route();
        let exchange = mcp_exchange(api, &request).or_else(|error| {
            if is_unreachable(&error) {
                Ok(offline_mcp_response(api, &request).into_iter().collect())
            } else {
                Err(error)
            }
        });
        match exchange {
            Ok(messages) => {
                for message in messages {
                    writeln!(output, "{message}")?;
                }
                output.flush()?;
            }
            Err(error) => {
                if let Some(id) = request.get("id") {
                    writeln!(
                        output,
                        "{}",
                        json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "error": {"code": -32000, "message": error.to_string()}
                        })
                    )?;
                    output.flush()?;
                } else {
                    writeln!(errors, "komla mcp: {error:#}")?;
                }
            }
        }
    }
}

const SPAWN_AGENT_TOOL: &str = "spawn_agent_in_new_workspace";

/// Answers MCP while no Komla installation is reachable. Komla's MCP endpoint
/// is stateless, so requests go back to it as soon as a device reconnects.
fn offline_mcp_response(api: &mut dyn KomlaApi, request: &Value) -> Option<Value> {
    let id = request.get("id")?.clone();
    let result = match request.get("method").and_then(Value::as_str) {
        Some("initialize") => json!({
            "protocolVersion": request
                .pointer("/params/protocolVersion")
                .and_then(Value::as_str)
                .unwrap_or(MCP_PROTOCOL_VERSION),
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "komla", "version": env!("CARGO_PKG_VERSION")},
        }),
        Some("ping") => json!({}),
        Some("tools/list") => json!({"tools": [{
            "name": SPAWN_AGENT_TOOL,
            "description": "Spawn an AI coding agent in a new isolated Komla workspace: its own git branch and working directory, branched from the project's base branch or, with fromCurrentBranch, from your current branch. Use only when the user asks for an agent in a new workspace or worktree. Komla is not connected right now, so the workspace is created on this host and appears in Komla when a device reconnects.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "cwd": {"type": "string", "description": "Current working directory of the calling agent. Used to derive the project automatically."},
                    "name": {"type": "string", "description": "Concise label for the current work, 2-3 words."},
                    "description": {"type": "string", "description": "One sentence summary."},
                    "branchName": {"type": "string", "description": "Descriptive branch name for what is being worked on, e.g. \"fix-login-redirect\"."},
                    "initialPrompt": {"type": "string", "description": "Initial prompt to pass to the AI agent."},
                    "fromCurrentBranch": {"type": "boolean", "description": "Branch from your workspace's current branch instead of the project's base branch, so the new agent builds on its committed work. Uncommitted changes are not copied. Use only when the user wants the new work to build on this branch."}
                },
                "required": ["cwd"]
            }
        }]}),
        Some("tools/call") => offline_tool_call(api, request.get("params")),
        _ => {
            return Some(json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": {"code": -32000, "message": "Komla isn't connected"},
            }))
        }
    };
    Some(json!({"jsonrpc": "2.0", "id": id, "result": result}))
}

fn offline_tool_call(api: &mut dyn KomlaApi, params: Option<&Value>) -> Value {
    let text = |key: &str| {
        params
            .and_then(|params| params.pointer(&format!("/arguments/{key}")))
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(str::to_owned)
    };
    let tool = params
        .and_then(|params| params.get("name"))
        .and_then(Value::as_str);
    let outcome = if tool == Some(SPAWN_AGENT_TOOL) {
        api.create_workspace_offline(&OfflineLaunchRequest {
            prompt: text("initialPrompt"),
            name: text("name"),
            description: text("description"),
            branch: text("branchName"),
            from_current_branch: params
                .and_then(|params| params.pointer("/arguments/fromCurrentBranch"))
                .and_then(Value::as_bool)
                .unwrap_or(false),
            cwd: text("cwd").map(PathBuf::from),
        })
        .map(|created| created.summary())
        .map_err(|error| format!("{error:#}"))
    } else {
        Err(
            "Komla isn't connected. Reconnect from Komla on any device to use this tool."
                .to_owned(),
        )
    };
    match outcome {
        Ok(summary) => json!({"content": [{"type": "text", "text": summary}]}),
        Err(message) => json!({"content": [{"type": "text", "text": message}], "isError": true}),
    }
}

fn mcp_exchange(api: &mut dyn KomlaApi, request: &Value) -> anyhow::Result<Vec<Value>> {
    let response = api.request(
        "POST",
        "/api/v1/cli/mcp",
        &serde_json::to_vec(request)?,
        true,
    )?;
    if response.status == 202 && response.body.trim().is_empty() {
        return Ok(Vec::new());
    }
    if !(200..300).contains(&response.status) {
        bail!(http_error_message(&response));
    }
    parse_mcp_response(&response.body)
}

fn parse_mcp_response(body: &str) -> anyhow::Result<Vec<Value>> {
    let trimmed = body.trim();
    if trimmed.starts_with('{') || trimmed.starts_with('[') {
        let value: Value =
            serde_json::from_str(trimmed).context("Komla returned invalid MCP JSON")?;
        return Ok(match value {
            Value::Array(values) => values,
            value => vec![value],
        });
    }
    let mut messages = Vec::new();
    let mut data = Vec::new();
    for line in body.lines().chain(std::iter::once("")) {
        if let Some(value) = line.strip_prefix("data:") {
            data.push(value.trim_start());
        } else if line.is_empty() && !data.is_empty() {
            messages.push(
                serde_json::from_str(&data.join("\n"))
                    .context("Komla returned invalid MCP event data")?,
            );
            data.clear();
        }
    }
    if messages.is_empty() {
        bail!("Komla returned an empty MCP response");
    }
    Ok(messages)
}

fn execute_operation(
    api: &mut dyn KomlaApi,
    environment: &CliEnvironment,
    operation: Value,
) -> anyhow::Result<Value> {
    let mut path = "/api/v1/commands".to_owned();
    if !environment.scoped_url && environment.terminal_id.is_none() {
        append_query(&mut path, "cwd", &environment.cwd);
    }
    let may_have_side_effects = !matches!(
        operation.get("type").and_then(Value::as_str),
        Some("context.get" | "agent.presets" | "workspace.list" | "tag.list")
    );
    let response = api.request(
        "POST",
        &path,
        &serde_json::to_vec(&operation)?,
        may_have_side_effects,
    )?;
    let body: Value = serde_json::from_str(response.body.trim()).unwrap_or_else(|_| json!({}));
    if !(200..300).contains(&response.status)
        || body.get("ok").and_then(Value::as_bool) != Some(true)
    {
        let error = body.get("error").unwrap_or(&body);
        let code = error
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or("KOMLA_OPERATION_FAILED");
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or_else(|| response.body.trim());
        if message.is_empty() {
            bail!("Komla returned HTTP {}", response.status);
        }
        return Err(OperationFailure {
            code: code.to_owned(),
            message: message.to_owned(),
            details: error.get("details").cloned(),
        }
        .into());
    }
    body.get("result")
        .cloned()
        .context("Komla operation response did not contain a result")
}

fn insert_json_optional(value: &mut Value, name: &str, entry: Option<String>) {
    let Some(object) = value.as_object_mut() else {
        return;
    };
    if let Some(entry) = entry {
        object.insert(name.to_owned(), Value::String(entry));
    }
}

fn write_operation_result(
    result: &Value,
    json_output: bool,
    output: &mut dyn Write,
) -> anyhow::Result<()> {
    if json_output {
        writeln!(output, "{result}")?;
        return Ok(());
    }
    if let Some(state) = result.get("state").and_then(Value::as_str) {
        let destination = result
            .pointer("/destination/kind")
            .and_then(Value::as_str)
            .unwrap_or("tab");
        let preset = result
            .pointer("/agent/preset/name")
            .and_then(Value::as_str)
            .unwrap_or("agent");
        writeln!(output, "{preset} {state} in {destination}.")?;
        return Ok(());
    }
    if let Some(presets) = result.get("presets").and_then(Value::as_array) {
        let default_preset_id = result.pointer("/default/presetId").and_then(Value::as_str);
        let default_mode_id = result.pointer("/default/modeId").and_then(Value::as_str);
        for preset in presets {
            let name = preset
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("Unknown");
            let id = preset.get("id").and_then(Value::as_str).unwrap_or("");
            let mut attributes = Vec::new();
            if default_preset_id == Some(id) {
                attributes.push("default".to_owned());
            }
            if preset.get("active").and_then(Value::as_bool) == Some(false) {
                attributes.push("inactive".to_owned());
            }
            if preset.get("launchable").and_then(Value::as_bool) == Some(false) {
                attributes.push("unavailable".to_owned());
            }
            let environment = render_environment(preset.get("environment"));
            if !environment.is_empty() {
                attributes.push(environment);
            }
            writeln!(output, "{name} ({id}){}", render_attributes(&attributes))?;
            for mode in preset
                .get("modes")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let mode_name = mode
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("Unknown");
                let mode_id = mode.get("id").and_then(Value::as_str).unwrap_or("");
                let mut mode_attributes = Vec::new();
                if default_preset_id == Some(id) && default_mode_id == Some(mode_id) {
                    mode_attributes.push("default".to_owned());
                }
                if mode.get("launchable").and_then(Value::as_bool) == Some(false) {
                    mode_attributes.push("unavailable".to_owned());
                } else if mode.get("isolatedOnly").and_then(Value::as_bool) == Some(true) {
                    mode_attributes.push("isolated SSH host only".to_owned());
                }
                let environment = render_environment(mode.get("environment"));
                if !environment.is_empty() {
                    mode_attributes.push(environment);
                }
                writeln!(
                    output,
                    "  {mode_name} ({mode_id}){}",
                    render_attributes(&mode_attributes)
                )?;
            }
        }
        return Ok(());
    }
    if let Some(context) = result.get("context") {
        let workspace = context
            .pointer("/workspace/id")
            .and_then(Value::as_str)
            .unwrap_or("unresolved");
        let path = context
            .pointer("/workspace/path")
            .and_then(Value::as_str)
            .unwrap_or("");
        writeln!(output, "Workspace: {workspace}")?;
        if !path.is_empty() {
            writeln!(output, "Path: {path}")?;
        }
        return Ok(());
    }
    if let Some(status) = result.get("status") {
        let id = status.get("id").and_then(Value::as_str);
        let refreshed = status.get("refreshed").and_then(Value::as_bool) == Some(true);
        match (status.get("cleared").and_then(Value::as_u64), id) {
            (None, Some(id)) if refreshed => {
                if status.get("error").is_none() {
                    writeln!(output, "Status item {id} refreshed.")?
                }
            }
            (None, Some(id)) => writeln!(output, "Status item {id} set.")?,
            (Some(0), Some(id)) => writeln!(output, "No status item {id} to clear.")?,
            (Some(_), Some(id)) => writeln!(output, "Status item {id} cleared.")?,
            (Some(1), None) => writeln!(output, "Cleared 1 status item.")?,
            (Some(cleared), None) => writeln!(output, "Cleared {cleared} status items.")?,
            (None, None) => writeln!(output, "{result}")?,
        }
        return Ok(());
    }
    if let Some(snooze) = result.get("snooze") {
        let until_notified = snooze.get("untilNotified").and_then(Value::as_bool) == Some(true);
        match (
            snooze.get("untilText").and_then(Value::as_str),
            snooze.get("woke").and_then(Value::as_bool),
        ) {
            (Some(until), _) if until_notified => {
                writeln!(output, "Snoozed until the next notification, or {until}.")?
            }
            (Some(until), _) => writeln!(output, "Snoozed until {until}.")?,
            (None, _) if until_notified => {
                writeln!(output, "Snoozed until the next notification.")?
            }
            (None, Some(true)) => writeln!(output, "Workspace woken.")?,
            (None, _) => writeln!(output, "The workspace wasn't snoozed.")?,
        }
        return Ok(());
    }
    if let Some(tag) = result.get("tag") {
        let name = tag.get("tag").and_then(Value::as_str);
        if tag.get("changed").and_then(Value::as_bool) == Some(false) {
            match name {
                Some(name) => writeln!(output, "Left alone: the workspace is tagged {name}.")?,
                None => writeln!(output, "Left alone: the workspace has no tag.")?,
            }
            return Ok(());
        }
        match name {
            Some(name) if tag.get("added").and_then(Value::as_bool) == Some(true) => {
                writeln!(output, "Tagged {name}, a tag added to Komla's list.")?
            }
            Some(name) => writeln!(output, "Tagged {name}.")?,
            None => writeln!(output, "Tag removed.")?,
        }
        return Ok(());
    }
    if let Some(path) = result.pointer("/folder/path").and_then(Value::as_str) {
        writeln!(output, "Opening {path} in Komla.")?;
        return Ok(());
    }
    if let Some(trash) = result.get("trash") {
        if trash.get("afterTurn").and_then(Value::as_bool) == Some(true) {
            writeln!(
                output,
                "The workspace will move to the Trash when this turn ends."
            )?;
        } else {
            writeln!(output, "The workspace will move to the Trash in a moment.")?;
        }
        return Ok(());
    }
    if result.get("workspace").is_some() {
        writeln!(output, "Workspace updated.")?;
        return Ok(());
    }
    if let Some(preview) = result.get("preview") {
        let opened = preview.get("opened").and_then(Value::as_bool) == Some(true);
        writeln!(
            output,
            "Preview {}.",
            if opened { "opened" } else { "updated" }
        )?;
        return Ok(());
    }
    writeln!(output, "{result}")?;
    Ok(())
}

fn render_attributes(attributes: &[String]) -> String {
    if attributes.is_empty() {
        String::new()
    } else {
        format!(" [{}]", attributes.join(", "))
    }
}

fn render_environment(environment: Option<&Value>) -> String {
    let Some(environment) = environment else {
        return String::new();
    };
    match environment.get("kind").and_then(Value::as_str) {
        Some("local") => "local".to_owned(),
        Some("ssh") => environment
            .get("hostId")
            .and_then(Value::as_str)
            .map(|host| format!("ssh:{host}"))
            .unwrap_or_else(|| "ssh".to_owned()),
        _ => String::new(),
    }
}

fn write_operation_error(failure: &OperationFailure, output: &mut dyn Write) -> anyhow::Result<()> {
    let mut error = json!({
        "code": failure.code,
        "message": failure.message,
    });
    if let Some(details) = &failure.details {
        error
            .as_object_mut()
            .expect("error envelope is an object")
            .insert("details".to_owned(), details.clone());
    }
    writeln!(output, "{}", json!({"error": error}))?;
    Ok(())
}

fn option_index(args: &[String], name: &str) -> anyhow::Result<Option<usize>> {
    let mut matches =
        option_arguments(args).filter_map(|(index, argument)| (argument == name).then_some(index));
    let index = matches.next();
    if matches.next().is_some() {
        bail!("{name} may only be provided once");
    }
    Ok(index)
}

fn take_flag(args: &mut Vec<String>, name: &str) -> anyhow::Result<bool> {
    if let Some(index) = option_index(args, name)? {
        args.remove(index);
        return Ok(true);
    }
    Ok(false)
}

fn read_text_input(path: &str, input: &mut dyn Read, label: &str) -> anyhow::Result<String> {
    let body = if path == "-" {
        read_bounded(input, 64 * 1024, label)?
    } else {
        let mut file = fs::File::open(path).with_context(|| format!("could not read {path}"))?;
        read_bounded(&mut file, 64 * 1024, label)?
    };
    String::from_utf8(body).with_context(|| format!("{label} must be UTF-8"))
}

fn take_option(args: &mut Vec<String>, name: &str) -> anyhow::Result<Option<String>> {
    let Some(index) = option_index(args, name)? else {
        return Ok(None);
    };
    if index + 1 >= args.len() {
        bail!("{name} requires a value");
    }
    args.remove(index);
    Ok(Some(args.remove(index)))
}

fn ensure_no_arguments(args: &[String]) -> anyhow::Result<()> {
    if let Some(argument) = args.first() {
        bail!("unexpected argument: {argument}");
    }
    Ok(())
}

fn read_json_input(file: Option<&str>, input: &mut dyn Read) -> anyhow::Result<Vec<u8>> {
    let body = match file {
        Some(path) => fs::read(path).with_context(|| format!("could not read {path}"))?,
        None => read_bounded(input, MAX_CLI_RESPONSE_BYTES, "settings input")?,
    };
    if body.is_empty() {
        bail!("settings apply requires a JSON document on stdin or through --file");
    }
    serde_json::from_slice::<Value>(&body).context("settings input must be valid JSON")?;
    Ok(body)
}

fn read_optional_json(input: &mut dyn Read) -> anyhow::Result<(Value, bool)> {
    // Hook runners may leave the command's stdin pipe open after writing one
    // JSON value. Parse that value directly instead of waiting for EOF, which
    // would otherwise leave the hook blocked until the runner's own timeout.
    let mut limited = BufReader::new(input.take(MAX_HOOK_INPUT_BYTES as u64 + 1));
    let parsed = {
        let mut values = serde_json::Deserializer::from_reader(&mut limited).into_iter::<Value>();
        values.next()
    };
    let has_trailing_input = limited
        .buffer()
        .iter()
        .any(|byte| !byte.is_ascii_whitespace());
    let bytes_read = MAX_HOOK_INPUT_BYTES + 1 - limited.get_ref().limit() as usize;
    if bytes_read > MAX_HOOK_INPUT_BYTES {
        bail!("hook input exceeded {MAX_HOOK_INPUT_BYTES} bytes");
    }
    Ok(match parsed {
        Some(Ok(value)) if !has_trailing_input => {
            (value, bytes_read > MAX_FORWARDED_HOOK_INPUT_BYTES)
        }
        Some(Ok(_)) | Some(Err(_)) | None => (json!({}), false),
    })
}

enum HookInputRead {
    Progress,
    Done(anyhow::Result<(Value, bool)>),
}

/// Tells the waiting thread each time stdin hands over more bytes.
struct ProgressReader<R> {
    input: R,
    progress: mpsc::Sender<HookInputRead>,
}

impl<R: Read> Read for ProgressReader<R> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        let read = self.input.read(buffer)?;
        if read > 0 {
            let _ = self.progress.send(HookInputRead::Progress);
        }
        Ok(read)
    }
}

/// Gives up once stdin has been silent for `timeout`, rather than after `timeout` in all, so a
/// large input read and parsed in pieces on a busy computer isn't dropped. `deadline` bounds
/// the whole read.
fn read_process_hook_input(timeout: Duration, deadline: Duration) -> anyhow::Result<(Value, bool)> {
    let give_up_at = Instant::now() + deadline;
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let stdin = std::io::stdin();
        let mut input = ProgressReader {
            input: stdin.lock(),
            progress: sender.clone(),
        };
        let _ = sender.send(HookInputRead::Done(read_optional_json(&mut input)));
    });
    loop {
        let wait = timeout.min(give_up_at.saturating_duration_since(Instant::now()));
        match receiver.recv_timeout(wait) {
            Ok(HookInputRead::Progress) => continue,
            Ok(HookInputRead::Done(input)) => return input,
            Err(_) => return Ok((json!({}), false)),
        }
    }
}

fn compact_hook_input(source: &str, hook_input: Value, was_oversized: bool) -> Value {
    if !was_oversized {
        return hook_input;
    }
    let mut compact = serde_json::Map::new();
    for field in [
        "hook_event_name",
        "agent_id",
        "notification_type",
        "session_id",
        "turn_id",
        "prompt_id",
        // What PostCompact, SessionEnd and StopFailure mean depends on these.
        "trigger",
        "reason",
        "error",
        // OpenCode names a permission request, and the reply to it, with this.
        "permissionID",
    ] {
        if let Some(value) = hook_input.get(field).and_then(Value::as_str) {
            compact.insert(field.to_owned(), Value::String(value.to_owned()));
        }
    }
    if let Some(message) = hook_input.get("message").and_then(Value::as_str) {
        if message.len() <= 8192 {
            compact.insert("message".to_owned(), Value::String(message.to_owned()));
        }
    }
    // Antigravity's turn state is a number and a flag rather than an id.
    if source == "antigravity" {
        for field in ["invocationNum", "fullyIdle"] {
            if let Some(value) = hook_input
                .get(field)
                .filter(|value| value.is_u64() || value.is_boolean())
            {
                compact.insert(field.to_owned(), value.clone());
            }
        }
    }
    Value::Object(compact)
}

fn read_bounded(input: &mut dyn Read, limit: usize, label: &str) -> anyhow::Result<Vec<u8>> {
    let mut body = Vec::new();
    input
        .take(limit as u64 + 1)
        .read_to_end(&mut body)
        .context("could not read stdin")?;
    if body.len() > limit {
        bail!("{label} exceeded {limit} bytes");
    }
    Ok(body)
}

fn append_query(path: &mut String, name: &str, value: &str) {
    path.push(if path.contains('?') { '&' } else { '?' });
    path.push_str(name);
    path.push('=');
    path.push_str(&percent_encode(value));
}

fn percent_encode(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

fn write_success(response: HttpResponse, output: &mut dyn Write) -> anyhow::Result<()> {
    if !(200..300).contains(&response.status) {
        bail!(http_error_message(&response));
    }
    output.write_all(response.body.as_bytes())?;
    if !response.body.ends_with('\n') {
        writeln!(output)?;
    }
    Ok(())
}

fn http_error_message(response: &HttpResponse) -> String {
    let body = response.body.trim();
    if body.is_empty() {
        format!("Komla returned HTTP {}", response.status)
    } else {
        format!("Komla returned HTTP {}: {body}", response.status)
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::io::Cursor;

    use tempfile::TempDir;

    use super::*;

    #[test]
    fn help_detection_respects_option_values() {
        for flag in ["--help", "-h"] {
            for arguments in [
                vec!["notify", "Test notification", "--body", flag],
                vec!["launch", "--prompt", flag],
                vec!["agent", "launch", "--prompt", flag, "--json"],
                vec!["title", "Review", "--description", flag],
                vec!["settings", "apply", "actions", "--file", flag],
                vec!["git", "snapshot", "-C", flag],
                vec!["status", "set", "ci", "--segments", flag],
                vec!["status", "set", "ci", "--icon", flag],
            ] {
                let mut arguments: Vec<String> = arguments.into_iter().map(str::to_owned).collect();
                assert!(!help_requested(&arguments), "{arguments:?}");
                arguments.push(flag.to_owned());
                assert!(help_requested(&arguments), "{arguments:?}");
            }
            for arguments in [
                vec![flag],
                vec!["launch", flag],
                vec!["launch", "--here", flag],
            ] {
                assert!(help_requested(
                    &arguments.into_iter().map(str::to_owned).collect::<Vec<_>>()
                ));
            }
        }
    }

    #[test]
    fn help_and_usage_errors_agree_on_skill_guides_and_settings() {
        let guides = format!("skill <{}>", SKILL_GUIDES.map(|(guide, _)| guide).join("|"));
        assert!(USAGE.contains(&guides), "{guides}");
        assert!(SKILL_USAGE.ends_with(&guides), "{guides}");
        let settings = SETTINGS_USAGE.trim_start_matches("usage: komla ");
        assert!(USAGE.contains(settings), "{settings}");
    }

    #[test]
    fn public_help_omits_the_internal_companion_entrypoint() {
        assert!(!USAGE.contains("sidecar"));
        assert!(!USAGE.contains("__companion"));
    }

    #[test]
    fn git_snapshot_rejects_a_missing_target_value() {
        let mut output = Vec::new();
        let error =
            git_command(&["snapshot".to_owned(), "--target".to_owned()], &mut output).unwrap_err();

        assert!(error.to_string().contains("--target requires a value"));
        assert!(output.is_empty());
    }

    #[derive(Debug, PartialEq, Eq)]
    struct Request {
        method: String,
        path: String,
        body: Vec<u8>,
        allow_long_running: bool,
    }

    struct FakeApi {
        requests: Vec<Request>,
        responses: VecDeque<HttpResponse>,
        target: Option<String>,
    }

    impl FakeApi {
        fn responding(body: Value) -> Self {
            Self {
                requests: Vec::new(),
                target: None,
                responses: VecDeque::from([HttpResponse {
                    status: 200,
                    body: body.to_string(),
                }]),
            }
        }
    }

    impl KomlaApi for FakeApi {
        fn target_workspace(&mut self, workspace_id: &str) {
            self.target = Some(workspace_id.to_owned());
        }

        fn request(
            &mut self,
            method: &str,
            path: &str,
            body: &[u8],
            allow_long_running: bool,
        ) -> anyhow::Result<HttpResponse> {
            self.requests.push(Request {
                method: method.to_owned(),
                path: path.to_owned(),
                body: body.to_vec(),
                allow_long_running,
            });
            self.responses.pop_front().context("missing fake response")
        }
    }

    fn desktop_view() -> DesktopView<'static> {
        DesktopView {
            vnc_port: 5902,
            viewer_url: Some("http://127.0.0.1:6082/vnc.html"),
            viewer: None,
            vnc_password: "pa55word",
            vnc_ports: &[5901, 5902],
            app: Some("xterm -fa Monospace"),
        }
    }

    #[test]
    fn only_lists_the_desktop_in_komla_without_browser_or_app() {
        let mut api = FakeApi::responding(json!({
            "ok": true,
            "result": {"desktop": {"workspaceId": "workspace-1", "vncApp": "Screen Sharing"}},
        }));

        let shown = show_desktop_with(&mut api, &environment(), &desktop_view()).unwrap();

        assert_eq!(shown, Shown::Listed);
        assert_eq!(
            serde_json::from_slice::<Value>(&api.requests[0].body).unwrap(),
            json!({
                "type": "desktop.open",
                "vncPort": 5902,
                "url": "http://127.0.0.1:6082/vnc.html",
                "vncPassword": "pa55word",
                "vncPorts": [5901, 5902],
                "app": "xterm -fa Monospace",
            })
        );
    }

    #[test]
    fn asks_for_the_browser_preview_with_browser() {
        let mut api = FakeApi::responding(json!({
            "ok": true,
            "result": {"desktop": {"viewer": "preview", "vncApp": "Screen Sharing"}},
        }));
        let view = DesktopView {
            viewer: Some(Viewer::Preview),
            ..desktop_view()
        };

        let shown = show_desktop_with(&mut api, &environment(), &view).unwrap();

        assert_eq!(shown, Shown::Preview);
        let request = serde_json::from_slice::<Value>(&api.requests[0].body).unwrap();
        assert_eq!(request["viewer"], "preview");
    }

    #[test]
    fn asks_for_the_vnc_app_with_app() {
        let mut api = FakeApi::responding(json!({
            "ok": true,
            "result": {"desktop": {"viewer": "vnc-app", "vncApp": "Screen Sharing"}},
        }));
        let view = DesktopView {
            viewer: Some(Viewer::VncApp),
            ..desktop_view()
        };

        let shown = show_desktop_with(&mut api, &environment(), &view).unwrap();

        assert_eq!(
            shown,
            Shown::VncApp {
                name: "Screen Sharing".to_owned()
            }
        );
        let request = serde_json::from_slice::<Value>(&api.requests[0].body).unwrap();
        assert_eq!(request["viewer"], "vnc-app");
    }

    #[test]
    fn tells_when_komla_has_nowhere_to_show_the_desktop() {
        let message = "Install novnc and websockify on the host to show the desktop in Komla’s \
browser preview.";
        let mut api = FakeApi {
            requests: Vec::new(),
            target: None,
            responses: VecDeque::from([HttpResponse {
                status: 400,
                body: json!({
                    "ok": false,
                    "error": {"code": "DESKTOP_VIEWER_UNAVAILABLE", "message": message},
                })
                .to_string(),
            }]),
        };
        let view = DesktopView {
            viewer_url: None,
            viewer: Some(Viewer::Preview),
            ..desktop_view()
        };

        let error = show_desktop_with(&mut api, &environment(), &view).unwrap_err();

        let nowhere = error.downcast_ref::<NowhereToShow>().expect("{error:#}");
        assert_eq!(nowhere.to_string(), message);
    }

    #[test]
    fn other_failures_to_show_the_desktop_stay_ordinary_errors() {
        let mut api = FakeApi {
            requests: Vec::new(),
            target: None,
            responses: VecDeque::from([HttpResponse {
                status: 502,
                body: json!({
                    "ok": false,
                    "error": {"code": "DESKTOP_VIEWER_FAILED", "message": "Couldn’t open it"},
                })
                .to_string(),
            }]),
        };

        let error = show_desktop_with(&mut api, &environment(), &desktop_view()).unwrap_err();

        assert!(error.downcast_ref::<NowhereToShow>().is_none());
    }

    fn environment() -> CliEnvironment {
        CliEnvironment {
            api_url: "http://127.0.0.1:52863/terminals/terminal-1".to_owned(),
            cwd: "/repo with spaces".to_owned(),
            explicit_cwd: false,
            terminal_id: Some("terminal-1".to_owned()),
            workspace_id: Some("workspace-1".to_owned()),
            target_workspace_id: None,
            companion_inbox: None,
            scoped_url: true,
            stdin_is_terminal: false,
            stdout_is_terminal: false,
            run_by_grok: false,
            run_by_cursor: false,
            run_by_devin: false,
            run_by_detached_claude: false,
        }
    }

    #[test]
    fn fills_missing_process_context_from_the_managed_tmux_session() {
        let process = KomlaEnvironmentValues {
            terminal_id: Some("process-terminal".to_owned()),
            ..KomlaEnvironmentValues::default()
        };
        let tmux = KomlaEnvironmentValues {
            api_url: Some("http://127.0.0.1:62001/terminals/tmux-terminal".to_owned()),
            terminal_id: Some("tmux-terminal".to_owned()),
            workspace_id: Some("tmux-workspace".to_owned()),
            companion_inbox: Some("/remote/inbox".to_owned()),
        };

        let resolved = process.with_missing_from(tmux);

        assert_eq!(
            resolved.api_url.as_deref(),
            Some("http://127.0.0.1:62001/terminals/tmux-terminal")
        );
        assert_eq!(resolved.terminal_id.as_deref(), Some("process-terminal"));
        assert_eq!(resolved.workspace_id.as_deref(), Some("tmux-workspace"));
        assert_eq!(resolved.companion_inbox.as_deref(), Some("/remote/inbox"));
    }

    #[test]
    fn managed_session_route_overrides_the_inherited_process_route() {
        let process = KomlaEnvironmentValues {
            api_url: Some("http://127.0.0.1:62113/terminals/t1".to_owned()),
            terminal_id: Some("t1".to_owned()),
            workspace_id: Some("ws-42".to_owned()),
            companion_inbox: Some("/remote/9f2c/inbox".to_owned()),
        };
        let tmux = KomlaEnvironmentValues {
            api_url: Some("http://127.0.0.1:62587/terminals/t1".to_owned()),
            companion_inbox: Some("/remote/41ab/inbox".to_owned()),
            ..KomlaEnvironmentValues::default()
        };

        let managed = resolve_route_values(process.clone(), tmux.clone(), true);
        let unmanaged = resolve_route_values(process, tmux, false);

        assert_eq!(
            managed.api_url.as_deref(),
            Some("http://127.0.0.1:62587/terminals/t1")
        );
        assert_eq!(
            managed.companion_inbox.as_deref(),
            Some("/remote/41ab/inbox")
        );
        assert_eq!(managed.terminal_id.as_deref(), Some("t1"));
        assert_eq!(
            unmanaged.api_url.as_deref(),
            Some("http://127.0.0.1:62113/terminals/t1")
        );
    }

    #[test]
    fn recognizes_only_the_managed_tmux_socket() {
        assert!(is_managed_tmux_socket("/tmp/tmux-1000/komla-v1,4242,0"));
        assert!(!is_managed_tmux_socket("/tmp/tmux-1000/default,4242,0"));
        assert!(!is_managed_tmux_socket(
            "/tmp/tmux-1000/komla-companion-9f2c,1,0"
        ));
        assert!(!is_managed_tmux_socket(""));
    }

    #[test]
    fn mcp_stdio_refreshes_the_route_before_each_request() {
        struct RouteTrackingApi {
            inner: FakeApi,
            refreshed_before: Vec<usize>,
        }
        impl KomlaApi for RouteTrackingApi {
            fn refresh_route(&mut self) {
                self.refreshed_before.push(self.inner.requests.len());
            }
            fn request(
                &mut self,
                method: &str,
                path: &str,
                body: &[u8],
                allow_long_running: bool,
            ) -> anyhow::Result<HttpResponse> {
                self.inner.request(method, path, body, allow_long_running)
            }
        }
        let response = tool_response("done");
        let mut api = RouteTrackingApi {
            inner: FakeApi {
                requests: Vec::new(),
                target: None,
                responses: VecDeque::from([
                    HttpResponse {
                        status: 200,
                        body: response.to_string(),
                    },
                    HttpResponse {
                        status: 200,
                        body: response.to_string(),
                    },
                ]),
            },
            refreshed_before: Vec::new(),
        };
        let request = json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"});
        let mut input = Cursor::new(format!("{request}\n{request}\n").into_bytes());
        let mut output = Vec::new();
        let mut errors = Vec::new();

        mcp_stdio(&mut api, &mut input, &mut output, &mut errors).unwrap();

        assert_eq!(api.refreshed_before, vec![0, 1]);
    }

    /// Komla is unreachable; offline creation is recorded instead of touching the host.
    struct DisconnectedApi {
        offline_requests: Vec<OfflineLaunchRequest>,
    }

    impl KomlaApi for DisconnectedApi {
        fn request(&mut self, _: &str, _: &str, _: &[u8], _: bool) -> anyhow::Result<HttpResponse> {
            Err(KomlaUnreachable("connection refused".to_owned()).into())
        }

        fn create_workspace_offline(
            &mut self,
            request: &OfflineLaunchRequest,
        ) -> anyhow::Result<CreatedWorkspace> {
            self.offline_requests.push(request.clone());
            Ok(CreatedWorkspace {
                workspace_id: "ws-2".to_owned(),
                terminal_id: "t-2".to_owned(),
                name: "Add Search".to_owned(),
                branch: "add-search".to_owned(),
                path: PathBuf::from("/b/worktrees/app/add-search"),
                agent_name: "Claude Code".to_owned(),
                branched_from: None,
            })
        }
    }

    fn run_disconnected(args: &[&str]) -> (DisconnectedApi, anyhow::Result<String>) {
        let mut api = DisconnectedApi {
            offline_requests: Vec::new(),
        };
        let mut input = Cursor::new(Vec::<u8>::new());
        let mut output = Vec::new();
        let mut errors = Vec::new();
        let result = run_command(
            &args.iter().map(|arg| (*arg).to_owned()).collect::<Vec<_>>(),
            &environment(),
            &mut api,
            &mut input,
            &mut output,
            &mut errors,
        )
        .map(|()| String::from_utf8(output).unwrap());
        (api, result)
    }

    #[test]
    fn finds_the_host_data_directory_from_the_installed_executable() {
        assert_eq!(
            host_data_dir_from(
                Some(Path::new(
                    "/srv/dev/.komla/helpers/bin/protocol-1/abc123/komla"
                )),
                None
            ),
            Some(PathBuf::from("/srv/dev/.komla"))
        );
        assert_eq!(
            host_data_dir_from(
                Some(Path::new("/tmp/target/debug/komla")),
                Some(Path::new("/srv/dev/.komla/helpers/komla"))
            ),
            Some(PathBuf::from("/srv/dev/.komla"))
        );
    }

    #[test]
    fn launch_creates_the_workspace_on_the_host_while_komla_is_disconnected() {
        let (api, output) =
            run_disconnected(&["launch", "Add search", "--name", "Search", "--json"]);

        let result: Value = serde_json::from_str(&output.unwrap()).unwrap();
        assert_eq!(result["offline"], true);
        assert_eq!(result["destination"]["branch"], "add-search");
        assert_eq!(
            api.offline_requests[0].prompt.as_deref(),
            Some("Add search")
        );
        assert_eq!(api.offline_requests[0].name.as_deref(), Some("Search"));
    }

    #[test]
    fn launch_offline_starts_from_the_current_branch_on_request() {
        let (api, output) = run_disconnected(&["launch", "Build on it", "--from-current-branch"]);

        output.unwrap();
        assert!(api.offline_requests[0].from_current_branch);
    }

    #[test]
    fn launch_offline_refuses_options_only_komla_can_apply() {
        let (api, result) = run_disconnected(&["launch", "x", "--preset", "Codex"]);

        assert!(result.unwrap_err().to_string().contains("--preset"));
        assert!(api.offline_requests.is_empty());
    }

    #[test]
    fn unreachable_errors_suggest_one_approved_network_retry() {
        let hinted = with_network_hint(KomlaUnreachable("connection refused".to_owned()).into());
        let message = format!("{hinted:#}");

        assert!(message.starts_with("Komla isn't connected: connection refused."));
        assert!(message.contains("rerun this command once with network access approved"));
        assert!(message.contains("report that Komla is unavailable"));
        assert_eq!(
            format!("{:#}", with_network_hint(anyhow::anyhow!("bad flag"))),
            "bad flag"
        );
    }

    /// Komla is unreachable, but this host has its installed guides.
    struct OfflineGuideApi {
        guide: Option<String>,
    }

    impl KomlaApi for OfflineGuideApi {
        fn request(&mut self, _: &str, _: &str, _: &[u8], _: bool) -> anyhow::Result<HttpResponse> {
            Err(KomlaUnreachable("connection refused".to_owned()).into())
        }

        fn installed_guide(&self, filename: &str) -> Option<String> {
            assert_eq!(filename, "komla-onboarding-demo-instructions.md");
            self.guide.clone()
        }
    }

    fn run_offline_skill(guide: Option<&str>) -> (anyhow::Result<String>, String) {
        let mut api = OfflineGuideApi {
            guide: guide.map(str::to_owned),
        };
        let mut input = Cursor::new(Vec::<u8>::new());
        let mut output = Vec::new();
        let mut errors = Vec::new();
        let result = run_command(
            &["skill".to_owned(), "onboarding-demo".to_owned()],
            &environment(),
            &mut api,
            &mut input,
            &mut output,
            &mut errors,
        )
        .map(|()| String::from_utf8(output).unwrap());
        (result, String::from_utf8(errors).unwrap())
    }

    #[test]
    fn prints_the_installed_guide_when_komla_is_unreachable() {
        let (result, errors) = run_offline_skill(Some("# Komla Onboarding Demo"));

        assert_eq!(result.unwrap(), "# Komla Onboarding Demo\n");
        assert!(errors.contains("Showing the guide installed with Komla"));
        assert!(errors.contains("ask the user to approve running them with it"));
    }

    #[test]
    fn reports_komla_unreachable_without_an_installed_guide() {
        let (result, _) = run_offline_skill(None);

        assert!(is_unreachable(&result.unwrap_err()));
    }

    #[test]
    fn launch_into_a_tab_does_not_fall_back_while_komla_is_disconnected() {
        let (api, result) = run_disconnected(&["launch", "x", "--here"]);

        assert!(is_unreachable(&result.unwrap_err()));
        assert!(api.offline_requests.is_empty());
    }

    #[test]
    fn mcp_answers_locally_and_spawns_on_the_host_while_komla_is_disconnected() {
        let mut api = DisconnectedApi {
            offline_requests: Vec::new(),
        };
        let requests = [
            json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}}),
            json!({"jsonrpc": "2.0", "method": "notifications/initialized"}),
            json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}),
            json!({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "spawn_agent_in_new_workspace", "arguments": {"cwd": "/b/worktrees/app/first", "initialPrompt": "Add search", "branchName": "add-search"}}}),
            json!({"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "set_workspace_title", "arguments": {"title": "x"}}}),
            json!({"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "spawn_agent_in_new_workspace", "arguments": {"cwd": "/b/worktrees/app/first", "fromCurrentBranch": true}}}),
        ];
        let mut input = Cursor::new(
            requests
                .iter()
                .map(|request| format!("{request}\n"))
                .collect::<String>()
                .into_bytes(),
        );
        let mut output = Vec::new();
        let mut errors = Vec::new();

        mcp_stdio(&mut api, &mut input, &mut output, &mut errors).unwrap();

        let responses: Vec<Value> = String::from_utf8(output)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(responses.len(), 5);
        assert_eq!(responses[0]["result"]["protocolVersion"], "2025-06-18");
        assert_eq!(
            responses[1]["result"]["tools"][0]["name"],
            "spawn_agent_in_new_workspace"
        );
        assert!(responses[1]["result"]["tools"][0]["description"]
            .as_str()
            .unwrap()
            .contains("Use only when the user asks"));
        assert!(responses[2]["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("Branch: add-search"));
        assert_eq!(responses[3]["result"]["isError"], true);
        assert!(
            responses[1]["result"]["tools"][0]["inputSchema"]["properties"]["fromCurrentBranch"]
                .is_object()
        );
        let request = &api.offline_requests[0];
        assert_eq!(request.branch.as_deref(), Some("add-search"));
        assert_eq!(request.cwd, Some(PathBuf::from("/b/worktrees/app/first")));
        assert!(!request.from_current_branch);
        assert!(api.offline_requests[1].from_current_branch);
    }

    #[test]
    fn parses_only_komla_values_from_tmux_session_environment() {
        let parsed = parse_tmux_environment(
            b"PATH=/usr/bin\nKOMLA_API_URL=http://127.0.0.1:62001/terminals/term-1\n\
KOMLA_TERMINAL_ID=term-1\nKOMLA_WORKSPACE_ID=workspace-1\n\
KOMLA_COMPANION_INBOX=/remote/inbox\n-KOMLA_UNUSED\n",
        );

        assert_eq!(
            parsed,
            KomlaEnvironmentValues {
                api_url: Some("http://127.0.0.1:62001/terminals/term-1".to_owned()),
                terminal_id: Some("term-1".to_owned()),
                workspace_id: Some("workspace-1".to_owned()),
                companion_inbox: Some("/remote/inbox".to_owned()),
            }
        );
    }

    fn run_with(api: &mut FakeApi, args: &[&str], stdin: &str) -> anyhow::Result<String> {
        run_in(&environment(), api, args, stdin)
    }

    fn run_in(
        environment: &CliEnvironment,
        api: &mut FakeApi,
        args: &[&str],
        stdin: &str,
    ) -> anyhow::Result<String> {
        let mut input = Cursor::new(stdin.as_bytes());
        let mut output = Vec::new();
        let mut errors = Vec::new();
        run_command(
            &args
                .iter()
                .map(|argument| argument.to_string())
                .collect::<Vec<_>>(),
            environment,
            api,
            &mut input,
            &mut output,
            &mut errors,
        )?;
        Ok(String::from_utf8(output).unwrap())
    }

    fn tool_response(text: &str) -> Value {
        json!({
            "jsonrpc": "2.0",
            "id": 1,
            "result": {"content": [{"type": "text", "text": text}]}
        })
    }

    #[test]
    fn reads_scoped_settings_without_exposing_transport_details() {
        let mut api = FakeApi::responding(json!({"actions": []}));

        let output = run_with(
            &mut api,
            &["settings", "get", "actions", "--scope", "current-project"],
            "",
        )
        .unwrap();

        assert_eq!(output, "{\"actions\":[]}\n");
        assert_eq!(
            api.requests,
            vec![Request {
                method: "GET".to_owned(),
                path: "/settings/actions?scope=current-project".to_owned(),
                body: Vec::new(),
                allow_long_running: false,
            }]
        );
    }

    #[test]
    fn applies_settings_and_waits_for_the_desktop_confirmation() {
        let mut api = FakeApi::responding(json!({"status": "applied"}));

        run_with(
            &mut api,
            &["settings", "apply", "workspace-setup"],
            "{\"setupSteps\":[]}",
        )
        .unwrap();

        assert_eq!(api.requests[0].method, "PUT");
        assert_eq!(api.requests[0].path, "/settings/workspace-setup");
        assert!(api.requests[0].allow_long_running);
        assert_eq!(
            serde_json::from_slice::<Value>(&api.requests[0].body).unwrap(),
            json!({"setupSteps": []})
        );
    }

    #[test]
    fn fetches_a_named_skill_as_plain_text() {
        let mut api = FakeApi {
            requests: Vec::new(),
            target: None,
            responses: VecDeque::from([HttpResponse {
                status: 200,
                body: "# Project Setup\n".to_owned(),
            }]),
        };

        let output = run_with(&mut api, &["skill", "project-setup"], "").unwrap();

        assert_eq!(output, "# Project Setup\n");
        assert_eq!(
            api.requests[0].path,
            "/skills/komla-project-setup-instructions.md"
        );
    }

    #[test]
    fn applies_appearance_settings_without_a_scope() {
        let mut api = FakeApi::responding(json!({"status": "applied", "applied": true}));

        run_with(
            &mut api,
            &["settings", "apply", "appearance"],
            r#"{"palette":"nord","accent":"oklch(0.65 0.15 250)","borderRadius":6}"#,
        )
        .unwrap();

        assert_eq!(api.requests[0].method, "PUT");
        assert!(api.requests[0].path.starts_with("/settings/appearance"));

        let mut api = FakeApi::responding(json!({}));
        let error = run_with(
            &mut api,
            &["settings", "get", "appearance", "--scope", "global"],
            "",
        )
        .unwrap_err();
        assert_eq!(error.to_string(), "appearance does not accept --scope");
        assert!(api.requests.is_empty());
    }

    #[test]
    fn reads_and_applies_settings_files_without_a_scope() {
        for resource in [
            "automations",
            "status-items",
            "hooks",
            "shortcuts",
            "terminal",
            "agents",
        ] {
            let mut api = FakeApi::responding(json!({"status": "applied", "applied": true}));
            run_with(
                &mut api,
                &["settings", "apply", resource],
                r#"{"hooks":[]}"#,
            )
            .unwrap();
            assert_eq!(api.requests[0].method, "PUT");
            assert!(
                api.requests[0]
                    .path
                    .starts_with(&format!("/settings/{resource}")),
                "{}",
                api.requests[0].path
            );

            let mut api = FakeApi::responding(json!({}));
            run_with(&mut api, &["settings", "get", resource], "").unwrap();
            assert_eq!(api.requests[0].method, "GET");

            let mut api = FakeApi::responding(json!({}));
            let error = run_with(
                &mut api,
                &["settings", "get", resource, "--scope", "global"],
                "",
            )
            .unwrap_err();
            assert_eq!(
                error.to_string(),
                format!("{resource} does not accept --scope")
            );
            assert!(api.requests.is_empty());
        }
    }

    #[test]
    fn fetches_the_appearance_skill_by_its_short_name() {
        let mut api = FakeApi {
            requests: Vec::new(),
            target: None,
            responses: VecDeque::from([HttpResponse {
                status: 200,
                body: "# Komla Appearance\n".to_owned(),
            }]),
        };

        run_with(&mut api, &["skill", "appearance"], "").unwrap();

        assert_eq!(
            api.requests[0].path,
            "/skills/komla-appearance-instructions.md"
        );
    }

    #[test]
    fn fetches_the_status_items_and_automations_guides_by_their_short_names() {
        for (guide, path) in [
            ("status-items", "/skills/komla-status-items-instructions.md"),
            ("automations", "/skills/komla-automations-instructions.md"),
        ] {
            let mut api = FakeApi {
                requests: Vec::new(),
                target: None,
                responses: VecDeque::from([HttpResponse {
                    status: 200,
                    body: "# Guide\n".to_owned(),
                }]),
            };

            run_with(&mut api, &["skill", guide], "").unwrap();

            assert_eq!(api.requests[0].path, path);
        }
    }

    #[test]
    fn short_launch_destinations_and_agent_launch_default() {
        for (args, destination, prompt) in [
            (vec!["launch", "Build it"], "workspace", "Build it"),
            (vec!["launch", "Review it", "--here"], "tab", "Review it"),
            (vec!["agent", "launch", "Review it"], "tab", "Review it"),
        ] {
            let mut api = FakeApi::responding(json!({"ok": true, "result": {}}));
            run_with(&mut api, &args, "").unwrap();
            let body: Value = serde_json::from_slice(&api.requests[0].body).unwrap();
            assert_eq!(body["type"], "agent.launch");
            assert_eq!(body["destination"], destination);
            assert_eq!(body["prompt"], prompt);
        }
    }

    #[test]
    fn short_launch_supports_workspace_options_and_prompt_input() {
        let mut api = FakeApi::responding(json!({"ok": true, "result": {}}));
        run_with(
            &mut api,
            &[
                "launch",
                "--name",
                "Task",
                "--branch",
                "task",
                "--preset",
                "Codex",
                "--prompt-file",
                "-",
            ],
            "Build it",
        )
        .unwrap();
        let body: Value = serde_json::from_slice(&api.requests[0].body).unwrap();
        assert_eq!(body["destination"], "workspace");
        assert_eq!(body["name"], "Task");
        assert_eq!(body["branch"], "task");
        assert_eq!(body["preset"], "Codex");
        assert_eq!(body["prompt"], "Build it");
        assert!(body.get("fromCurrentBranch").is_none());
    }

    #[test]
    fn launch_starts_from_the_current_branch_on_request() {
        for args in [
            vec!["launch", "Build on it", "--from-current-branch"],
            vec![
                "agent",
                "launch",
                "Build on it",
                "--new-workspace",
                "--from-current-branch",
            ],
        ] {
            let mut api = FakeApi::responding(json!({"ok": true, "result": {}}));
            run_with(&mut api, &args, "").unwrap();
            let body: Value = serde_json::from_slice(&api.requests[0].body).unwrap();
            assert_eq!(body["destination"], "workspace", "{args:?}");
            assert_eq!(body["fromCurrentBranch"], true, "{args:?}");
        }
    }

    #[test]
    fn short_launch_preserves_flag_like_option_values() {
        for prompt in [
            "--here",
            "--new-workspace",
            "--name",
            "--project",
            "--description",
            "--branch",
            "--from-current-branch",
            "--json",
            "--cwd",
            "-C",
            "--prompt",
        ] {
            for here in [false, true] {
                let mut args = vec!["launch", "--prompt", prompt];
                if here {
                    args.push("--here");
                }
                let mut api = FakeApi::responding(json!({"ok": true, "result": {}}));
                run_with(&mut api, &args, "").unwrap_or_else(|error| panic!("{args:?}: {error}"));
                let body: Value = serde_json::from_slice(&api.requests[0].body).unwrap();
                assert_eq!(body["prompt"], prompt);
                assert_eq!(body["destination"], if here { "tab" } else { "workspace" });
            }
        }
    }

    #[test]
    fn short_launch_rejects_conflicting_destinations_and_workspace_options() {
        for args in [
            vec!["launch", "--here", "--new-workspace"],
            vec!["launch", "--here", "--name", "Task"],
            vec!["launch", "--here", "--branch", "task"],
            vec!["launch", "--here", "--from-current-branch"],
            vec!["agent", "launch", "--from-current-branch"],
            vec!["launch", "--here", "--here"],
            vec!["launch", "--prompt"],
            vec!["launch", "--here", "--prompt"],
            vec!["launch", "--prompt", "one", "--prompt", "two"],
        ] {
            let mut api = FakeApi::responding(json!({"ok": true, "result": {}}));
            assert!(run_with(&mut api, &args, "").is_err(), "{args:?}");
            assert!(api.requests.is_empty());
        }
    }

    #[test]
    fn short_preview_and_title_commands() {
        for (args, expected) in [
            (
                vec!["preview", "http://localhost:3000"],
                json!({"type": "preview.open", "url": "http://localhost:3000"}),
            ),
            (vec!["preview"], json!({"type": "preview.open"})),
            (
                vec!["title", "Build investigation"],
                json!({"type": "workspace.title", "title": "Build investigation"}),
            ),
        ] {
            let mut api = FakeApi::responding(json!({"ok": true, "result": {}}));
            run_with(&mut api, &args, "").unwrap();
            let body: Value = serde_json::from_slice(&api.requests[0].body).unwrap();
            for (key, value) in expected.as_object().unwrap() {
                assert_eq!(&body[key], value);
            }
        }
    }

    #[test]
    fn snooze_and_wake_commands_send_workspace_operations() {
        for (args, expected) in [
            (
                vec!["snooze", "2h"],
                json!({"type": "workspace.snooze", "until": "2h"}),
            ),
            // A date and time may come as two arguments.
            (
                vec!["snooze", "2026-10-21", "09:00"],
                json!({"type": "workspace.snooze", "until": "2026-10-21 09:00"}),
            ),
            (
                vec!["workspace", "snooze", "17:30"],
                json!({"type": "workspace.snooze", "until": "17:30"}),
            ),
            (
                vec!["snooze", "--until-notified"],
                json!({"type": "workspace.snooze", "untilNotified": true}),
            ),
            (
                vec!["snooze", "2h", "--until-notified"],
                json!({"type": "workspace.snooze", "until": "2h", "untilNotified": true}),
            ),
            (vec!["wake"], json!({"type": "workspace.wake"})),
            (vec!["workspace", "wake"], json!({"type": "workspace.wake"})),
        ] {
            let mut api = FakeApi::responding(json!({"ok": true, "result": {}}));
            run_with(&mut api, &args, "").unwrap_or_else(|error| panic!("{args:?}: {error}"));
            let body: Value = serde_json::from_slice(&api.requests[0].body).unwrap();
            assert_eq!(body["type"], expected["type"], "{args:?}");
            assert_eq!(body.get("until"), expected.get("until"), "{args:?}");
            assert_eq!(
                body.get("untilNotified"),
                expected.get("untilNotified"),
                "{args:?}"
            );
        }
        let too_long = "1".repeat(41);
        // 21 characters, but 42 UTF-16 units, as Komla counts them.
        let too_long_emoji = "😀".repeat(21);
        for args in [
            vec!["snooze"],
            vec!["snooze", &too_long],
            vec!["snooze", &too_long_emoji],
            vec!["wake", "now"],
            vec!["wake", "--until-notified"],
        ] {
            let mut api = FakeApi::responding(json!({"ok": true, "result": {}}));
            assert!(run_with(&mut api, &args, "").is_err(), "{args:?}");
            assert!(api.requests.is_empty());
        }
    }

    #[test]
    fn tag_and_untag_commands_send_workspace_operations() {
        for (args, expected) in [
            (
                vec!["tag", "Waiting for review"],
                json!({"type": "workspace.tag", "tag": "Waiting for review"}),
            ),
            // A tag of several words may come unquoted.
            (
                vec!["tag", "Waiting", "for", "merge", "--json"],
                json!({"type": "workspace.tag", "tag": "Waiting for merge"}),
            ),
            (
                vec!["workspace", "tag", "Blocked"],
                json!({"type": "workspace.tag", "tag": "Blocked"}),
            ),
            (vec!["untag"], json!({"type": "workspace.tag"})),
            (vec!["workspace", "untag"], json!({"type": "workspace.tag"})),
            // Only that tag, so a script leaves alone one put on since.
            (
                vec!["untag", "CI", "running"],
                json!({"type": "workspace.tag", "ifTag": "CI running"}),
            ),
            (
                vec![
                    "tag",
                    "CI running",
                    "--spinner",
                    "--tone",
                    "info",
                    "--tooltip",
                    " build 7 of 9 ",
                    "--if",
                    "In review",
                ],
                json!({
                    "type": "workspace.tag",
                    "tag": "CI running",
                    "spinner": true,
                    "tone": "info",
                    "tooltip": "build 7 of 9",
                    "ifTag": "In review",
                }),
            ),
            (
                vec!["tag", "CI failed", "--icon", "<svg/>"],
                json!({"type": "workspace.tag", "tag": "CI failed", "icon": "<svg/>"}),
            ),
        ] {
            let mut api = FakeApi::responding(json!({"ok": true, "result": {}}));
            run_with(&mut api, &args, "").unwrap_or_else(|error| panic!("{args:?}: {error}"));
            let body: Value = serde_json::from_slice(&api.requests[0].body).unwrap();
            assert_eq!(body, expected, "{args:?}");
        }
        let too_long = "x".repeat(41);
        // 21 characters, but 42 UTF-16 units, as Komla counts them.
        let too_long_emoji = "😀".repeat(21);
        for args in [
            vec!["tag"],
            vec!["tag", "  "],
            vec!["tag", &too_long],
            vec!["tag", &too_long_emoji],
            vec!["untag", &too_long],
            vec!["tag", "CI", "--tone", "purple"],
            vec!["tag", "CI", "--icon", "logo.bmp"],
            vec!["tag", "CI", "--if", " "],
        ] {
            let mut api = FakeApi::responding(json!({"ok": true, "result": {}}));
            assert!(run_with(&mut api, &args, "").is_err(), "{args:?}");
            assert!(api.requests.is_empty());
        }
    }

    #[test]
    fn tag_results_say_what_changed() {
        for (result, expected) in [
            (
                json!({"tag": {"tag": "CI running", "changed": true, "added": true}}),
                "Tagged CI running, a tag added to Komla's list.\n",
            ),
            (
                json!({"tag": {"tag": "Blocked", "changed": true}}),
                "Tagged Blocked.\n",
            ),
            (
                json!({"tag": {"tag": null, "changed": true}}),
                "Tag removed.\n",
            ),
            (
                json!({"tag": {"tag": "Blocked", "changed": false}}),
                "Left alone: the workspace is tagged Blocked.\n",
            ),
            (
                json!({"tag": {"tag": null, "changed": false}}),
                "Left alone: the workspace has no tag.\n",
            ),
        ] {
            let mut api = FakeApi::responding(json!({"ok": true, "result": result}));
            let output = run_with(&mut api, &["untag", "CI running"], "").unwrap();
            assert_eq!(output, expected);
        }
    }

    fn fake_api(bodies: Vec<Value>) -> FakeApi {
        FakeApi {
            requests: Vec::new(),
            target: None,
            responses: bodies
                .into_iter()
                .map(|body| HttpResponse {
                    status: 200,
                    body: body.to_string(),
                })
                .collect(),
        }
    }

    fn request_body(api: &FakeApi, index: usize) -> Value {
        serde_json::from_slice(&api.requests[index].body).unwrap()
    }

    #[test]
    fn workspace_option_notifies_the_named_workspace() {
        let mut api = fake_api(vec![
            json!({"ok": true, "result": {"context": {"workspace": {"id": "workspace-2"}}}}),
            json!({"success": true}),
        ]);
        run_with(
            &mut api,
            &["notify", "Review ready", "--workspace", "workspace-2"],
            "",
        )
        .unwrap();
        assert_eq!(request_body(&api, 0), json!({"type": "context.get"}));
        let notification = request_body(&api, 1);
        assert_eq!(notification["workspaceId"], "workspace-2");
        assert!(notification.get("terminalId").is_none());

        // Komla would fall back to the calling folder's workspace for an id it doesn't know.
        let mut api = fake_api(vec![
            json!({"ok": true, "result": {"context": {"connected": true}}}),
        ]);
        let error = run_with(
            &mut api,
            &["notify", "Review ready", "--workspace", "nope"],
            "",
        )
        .unwrap_err();
        assert!(error.to_string().contains("No workspace has the id nope"));
        assert_eq!(api.requests.len(), 1);
    }

    #[test]
    fn workspace_option_sends_operations_for_the_named_workspace() {
        let mut api = fake_api(vec![
            json!({"ok": true, "result": {"tag": {"tag": "Blocked"}}}),
        ]);
        run_with(
            &mut api,
            &["workspace", "tag", "Blocked", "--workspace", "workspace-2"],
            "",
        )
        .unwrap();
        assert_eq!(api.target.as_deref(), Some("workspace-2"));

        let mut api = fake_api(vec![
            json!({"ok": true, "result": {"tag": {"tag": "Blocked"}}}),
        ]);
        run_with(&mut api, &["tag", "Blocked"], "").unwrap();
        assert_eq!(api.target, None);
    }

    #[test]
    fn workspace_option_is_refused_where_it_cannot_apply() {
        for args in [
            vec!["trash", "--workspace", "workspace-2"],
            vec!["workspace", "trash", "--workspace", "workspace-2"],
            vec!["settings", "get", "hooks", "--workspace", "workspace-2"],
            vec!["workspace", "list", "--workspace", "workspace-2"],
            vec!["tag", "Blocked", "--workspace", " "],
        ] {
            let mut api = fake_api(Vec::new());
            assert!(run_with(&mut api, &args, "").is_err(), "{args:?}");
            assert!(api.requests.is_empty(), "{args:?}");
        }
        // It shows its own terminal working, so it says why rather than printing the usage.
        for args in [
            vec!["notify", "--workspace", "workspace-2", "--", "make"],
            vec![
                "notify",
                "Build",
                "--workspace",
                "workspace-2",
                "--",
                "make",
            ],
        ] {
            let mut api = fake_api(Vec::new());
            let error = run_with(&mut api, &args, "").unwrap_err().to_string();
            assert!(error.contains("terminal it runs in"), "{args:?}: {error}");
            assert!(api.requests.is_empty(), "{args:?}");
        }
    }

    #[test]
    fn workspace_list_prints_ids_names_branches_and_tags() {
        let result = json!({"ok": true, "result": {"workspaces": [
            {"id": "w1", "name": "Add search", "branch": "add-search", "tag": "In review"},
            {"id": "w2", "name": "Notes"},
        ]}});
        let mut api = fake_api(vec![result.clone()]);
        let output = run_with(&mut api, &["workspace", "list"], "").unwrap();
        assert_eq!(
            output,
            "w1  Add search  [add-search]  (In review)\nw2  Notes\n"
        );
        assert_eq!(request_body(&api, 0), json!({"type": "workspace.list"}));
        assert!(!api.requests[0].allow_long_running);

        let mut api = fake_api(vec![result]);
        let output = run_with(&mut api, &["workspace", "list", "--all", "--json"], "").unwrap();
        assert!(output.starts_with("{\"workspaces\":"));
        assert_eq!(
            request_body(&api, 0),
            json!({"type": "workspace.list", "includeTrashed": true})
        );
    }

    #[test]
    fn tags_lists_names_with_their_looks() {
        let result = json!({"ok": true, "result": {"tags": [
            {"name": "In review", "tone": "info", "pullRequestState": "in-review"},
            {"name": "CI running", "tone": "info", "hasIcon": true, "spinner": true},
            {"name": "Blocked", "tone": "error", "hidden": true},
        ]}});
        let mut api = fake_api(vec![result.clone()]);
        let output = run_with(&mut api, &["tags"], "").unwrap();
        assert_eq!(
            output,
            "In review  (info, pull requests in review)\nCI running  (info, icon, spinner)\nBlocked  (error, hidden in the sidebar)\n"
        );
        assert_eq!(request_body(&api, 0), json!({"type": "tag.list"}));
        assert!(!api.requests[0].allow_long_running);

        let mut api = fake_api(vec![result]);
        let output = run_with(&mut api, &["tags", "--json"], "").unwrap();
        assert!(output.starts_with("{\"tags\":"));
    }

    #[test]
    fn tags_refuses_a_tag_name_and_workspace_targeting() {
        for (args, expected) in [
            (vec!["tags", "Blocked"], "komla tag <tag>"),
            (vec!["tags", "list"], "komla tag <tag>"),
            (vec!["tags", "--workspace", "w1"], "--workspace works with"),
        ] {
            let mut api = fake_api(Vec::new());
            let error = run_with(&mut api, &args, "").unwrap_err().to_string();
            assert!(error.contains(expected), "{args:?}: {error}");
            assert!(api.requests.is_empty(), "{args:?}");
        }
    }

    #[test]
    fn tag_results_read_as_sentences() {
        for (result, expected) in [
            (
                json!({"tag": {"workspaceId": "w", "tag": "Waiting for review"}}),
                "Tagged Waiting for review.\n",
            ),
            (
                json!({"tag": {"workspaceId": "w", "tag": null}}),
                "Tag removed.\n",
            ),
        ] {
            let mut output = Vec::new();
            write_operation_result(&result, false, &mut output).unwrap();
            assert_eq!(String::from_utf8(output).unwrap(), expected);
        }
    }

    #[test]
    fn trash_command_sends_a_workspace_operation() {
        for args in [vec!["trash"], vec!["workspace", "trash", "--json"]] {
            let mut api = FakeApi::responding(json!({"ok": true, "result": {}}));
            run_with(&mut api, &args, "").unwrap_or_else(|error| panic!("{args:?}: {error}"));
            let body: Value = serde_json::from_slice(&api.requests[0].body).unwrap();
            assert_eq!(body["type"], "workspace.trash", "{args:?}");
        }
        let mut api = FakeApi::responding(json!({"ok": true, "result": {}}));
        assert!(run_with(&mut api, &["trash", "now"], "").is_err());
        assert!(api.requests.is_empty());
    }

    #[test]
    fn open_sends_the_folder_from_the_current_directory() {
        let cwd = Path::new("/repo with spaces");
        for (args, path) in [
            (vec!["open"], cwd.join(".")),
            (vec!["open", "notes", "--json"], cwd.join("notes")),
            (vec!["open", "/tmp/notes"], cwd.join("/tmp/notes")),
        ] {
            let path = path.to_string_lossy();
            let mut api =
                FakeApi::responding(json!({"ok": true, "result": {"folder": {"path": path}}}));
            run_with(&mut api, &args, "").unwrap_or_else(|error| panic!("{args:?}: {error}"));
            let body: Value = serde_json::from_slice(&api.requests[0].body).unwrap();
            assert_eq!(
                body,
                json!({"type": "folder.open", "path": path}),
                "{args:?}"
            );
        }
        for args in [vec!["open", "a", "b"], vec!["open", "--here"]] {
            let mut api = FakeApi::responding(json!({"ok": true, "result": {}}));
            assert!(run_with(&mut api, &args, "").is_err(), "{args:?}");
            assert!(api.requests.is_empty(), "{args:?}");
        }
    }

    #[test]
    fn open_says_where_it_opens() {
        let mut api =
            FakeApi::responding(json!({"ok": true, "result": {"folder": {"path": "/tmp/notes"}}}));
        assert_eq!(
            run_with(&mut api, &["open", "/tmp/notes"], "").unwrap(),
            "Opening /tmp/notes in Komla.\n"
        );
    }

    #[test]
    fn trash_results_read_as_sentences() {
        for (result, expected) in [
            (
                json!({"trash": {"workspaceId": "w", "afterTurn": true}}),
                "The workspace will move to the Trash when this turn ends.\n",
            ),
            (
                json!({"trash": {"workspaceId": "w", "afterTurn": false}}),
                "The workspace will move to the Trash in a moment.\n",
            ),
        ] {
            let mut output = Vec::new();
            write_operation_result(&result, false, &mut output).unwrap();
            assert_eq!(String::from_utf8(output).unwrap(), expected);
        }
    }

    #[test]
    fn snooze_and_wake_results_read_as_sentences() {
        for (result, expected) in [
            (
                json!({"snooze": {"workspaceId": "w", "until": 1, "untilText": "Wed, Oct 21, 9:00 AM"}}),
                "Snoozed until Wed, Oct 21, 9:00 AM.\n",
            ),
            (
                json!({"snooze": {"workspaceId": "w", "untilNotified": true}}),
                "Snoozed until the next notification.\n",
            ),
            (
                json!({"snooze": {"workspaceId": "w", "until": 1, "untilText": "Wed, Oct 21, 9:00 AM", "untilNotified": true}}),
                "Snoozed until the next notification, or Wed, Oct 21, 9:00 AM.\n",
            ),
            (
                json!({"snooze": {"workspaceId": "w", "woke": true}}),
                "Workspace woken.\n",
            ),
            (
                json!({"snooze": {"workspaceId": "w", "woke": false}}),
                "The workspace wasn't snoozed.\n",
            ),
        ] {
            let mut output = Vec::new();
            write_operation_result(&result, false, &mut output).unwrap();
            assert_eq!(String::from_utf8(output).unwrap(), expected);
        }
    }

    #[test]
    fn status_commands_send_status_operations() {
        for (args, expected) in [
            (
                vec![
                    "status",
                    "set",
                    "tests",
                    " 142/150 passing ",
                    "--tone",
                    "warning",
                    "--tooltip",
                    "8 failing in auth",
                    "--link",
                    "https://github.com/o/r/pull/1",
                ],
                json!({
                    "type": "status.set",
                    "id": "tests",
                    "text": "142/150 passing",
                    "tone": "warning",
                    "tooltip": "8 failing in auth",
                    "link": "https://github.com/o/r/pull/1"
                }),
            ),
            (
                vec![
                    "status",
                    "set",
                    "pr",
                    "\u{f407} #812",
                    "--color",
                    "#e5c07b",
                    "--popover",
                    "**Review** requested",
                ],
                json!({
                    "type": "status.set",
                    "id": "pr",
                    "text": "\u{f407} #812",
                    "color": "#e5c07b",
                    "popover": "**Review** requested"
                }),
            ),
            (
                vec![
                    "status",
                    "set",
                    "ci",
                    &format!("\u{1b}[32m\u{f00c}\u{1b}[0m CI {}", "x".repeat(50)),
                ],
                json!({
                    "type": "status.set",
                    "id": "ci",
                    "text": format!("\u{1b}[32m\u{f00c}\u{1b}[0m CI {}", "x".repeat(50))
                }),
            ),
            (
                vec!["status", "clear", "tests"],
                json!({"type": "status.clear", "id": "tests"}),
            ),
            (vec!["status", "clear"], json!({"type": "status.clear"})),
            (
                vec!["status", "refresh", "ci"],
                json!({"type": "status.refresh", "id": "ci"}),
            ),
        ] {
            let mut api = FakeApi::responding(json!({"ok": true, "result": {}}));
            run_with(&mut api, &args, "").unwrap();
            assert_eq!(api.requests[0].path, "/api/v1/commands");
            let body: Value = serde_json::from_slice(&api.requests[0].body).unwrap();
            assert_eq!(body, expected, "{args:?}");
        }
    }

    #[test]
    fn status_commands_report_what_changed() {
        for (result, expected) in [
            (
                json!({"status": {"id": "tests", "text": "ok"}}),
                "Status item tests set.\n",
            ),
            (
                json!({"status": {"id": "tests", "cleared": 1}}),
                "Status item tests cleared.\n",
            ),
            (
                json!({"status": {"id": "tests", "cleared": 0}}),
                "No status item tests to clear.\n",
            ),
            (
                json!({"status": {"cleared": 2}}),
                "Cleared 2 status items.\n",
            ),
        ] {
            let args = if result.pointer("/status/cleared").is_some() {
                vec!["status", "clear"]
            } else {
                vec!["status", "set", "tests", "ok"]
            };
            let mut api = FakeApi::responding(json!({"ok": true, "result": result}));
            assert_eq!(run_with(&mut api, &args, "").unwrap(), expected);
        }
    }

    #[test]
    fn status_refresh_says_whether_the_command_worked() {
        let mut api = FakeApi::responding(json!({
            "ok": true,
            "result": {"status": {"id": "ci", "refreshed": true, "text": "CI passing"}}
        }));
        assert_eq!(
            run_with(&mut api, &["status", "refresh", "ci"], "").unwrap(),
            "Status item ci refreshed.\n"
        );

        let mut api = FakeApi::responding(json!({
            "ok": true,
            "result": {"status": {"id": "ci", "refreshed": true, "error": "gh: not logged in"}}
        }));
        let error = run_with(&mut api, &["status", "refresh", "ci"], "").unwrap_err();
        assert_eq!(
            error.to_string(),
            "the item's command failed: gh: not logged in"
        );

        let mut api = FakeApi::responding(json!({"ok": true, "result": {}}));
        for args in [
            vec!["status", "refresh"],
            vec!["status", "refresh", "ci", "pr"],
            vec!["status", "refresh", "bad id"],
        ] {
            assert!(run_with(&mut api, &args, "").is_err(), "{args:?}");
        }
        assert!(api.requests.is_empty());
    }

    #[test]
    fn status_set_reads_the_popover_from_stdin() {
        let mut api = FakeApi::responding(json!({"ok": true, "result": {}}));
        run_with(
            &mut api,
            &["status", "set", "pr", "PR #812", "--popover-file", "-"],
            "## Checks\n- e2e failed\n",
        )
        .unwrap();
        let body: Value = serde_json::from_slice(&api.requests[0].body).unwrap();
        assert_eq!(body["popover"], "## Checks\n- e2e failed");
    }

    #[test]
    fn status_set_reads_icon_files_into_images() {
        let directory = TempDir::new().unwrap();
        let logo = directory.path().join("logo.svg");
        fs::write(&logo, "<svg/>").unwrap();
        let logo = logo.to_str().unwrap();
        let svg_url = "data:image/svg+xml;base64,PHN2Zy8+";

        let mut api = FakeApi::responding(json!({"ok": true, "result": {}}));
        run_with(
            &mut api,
            &[
                "status",
                "set",
                "ci",
                "CI",
                "--icon",
                logo,
                "--icon-color",
                "foreground",
            ],
            "",
        )
        .unwrap();
        let body: Value = serde_json::from_slice(&api.requests[0].body).unwrap();
        assert_eq!(
            body,
            json!({
                "type": "status.set",
                "id": "ci",
                "text": "CI",
                "icon": svg_url,
                "iconColor": "foreground"
            })
        );

        let mut api = FakeApi::responding(json!({"ok": true, "result": {}}));
        let segments = json!([
            {"text": "CI ", "color": "success", "bold": true},
            {"icon": logo, "color": "muted"},
            {"icon": "<svg viewBox='0 0 1 1'/>"}
        ]);
        run_with(
            &mut api,
            &["status", "set", "ci", "--segments-file", "-"],
            &segments.to_string(),
        )
        .unwrap();
        let body: Value = serde_json::from_slice(&api.requests[0].body).unwrap();
        assert_eq!(
            body,
            json!({
                "type": "status.set",
                "id": "ci",
                "segments": [
                    {"text": "CI ", "color": "success", "bold": true},
                    {"icon": svg_url, "color": "muted"},
                    {"icon": "<svg viewBox='0 0 1 1'/>"}
                ]
            })
        );
    }

    #[test]
    fn status_set_checks_segments_and_icons_before_asking_komla() {
        let directory = TempDir::new().unwrap();
        let big = directory.path().join("big.png");
        fs::write(&big, vec![0u8; 33 * 1024]).unwrap();
        let big = big.to_str().unwrap();
        let five_icons = json!([
            {"icon": "<svg/>"}, {"icon": "<svg/>"}, {"icon": "<svg/>"}, {"icon": "<svg/>"},
            {"icon": "<svg/>"}, {"text": "x"}
        ])
        .to_string();
        for (args, message) in [
            (
                vec!["status", "set", "ci", "CI", "--icon", "logo.bmp"],
                "icons are .svg",
            ),
            (vec!["status", "set", "ci", "CI", "--icon", big], "exceeded"),
            (
                vec!["status", "set", "ci", "CI", "--icon-color", "muted"],
                "needs one",
            ),
            (
                vec!["status", "set", "ci", "CI", "--segments", "[]"],
                "not both",
            ),
            (
                vec!["status", "set", "ci", "--segments", "{}"],
                "JSON array",
            ),
            (
                vec!["status", "set", "ci", "--segments", "[]"],
                "1 to 30 parts",
            ),
            (
                vec![
                    "status",
                    "set",
                    "ci",
                    "--segments",
                    r#"[{"text":"x","color":"red"}]"#,
                ],
                "segment colors",
            ),
            (
                vec![
                    "status",
                    "set",
                    "ci",
                    "--segments",
                    r#"[{"icon":"<svg/>"}]"#,
                ],
                "characters of text",
            ),
            (
                vec![
                    "status",
                    "set",
                    "ci",
                    "--segments",
                    r#"[{"text":"x","size":2}]"#,
                ],
                "only text, color and bold",
            ),
            (
                vec!["status", "set", "ci", "--segments", &five_icons],
                "at most 4 icons",
            ),
        ] {
            let mut api = FakeApi::responding(json!({"ok": true, "result": {}}));
            let error = run_with(&mut api, &args, "").unwrap_err().to_string();
            assert!(error.contains(message), "{args:?}: {error}");
            assert!(api.requests.is_empty(), "{args:?}");
        }
    }

    #[test]
    fn status_commands_check_arguments_before_asking_komla() {
        for (args, message) in [
            (vec!["status", "set", "tests"], "usage: komla status"),
            (vec!["status", "set", "bad id", "x"], "status item ids"),
            (
                vec!["status", "set", "tests", "  "],
                "status text must not be empty",
            ),
            (
                vec!["status", "set", "tests", &"x".repeat(61)],
                "at most 60",
            ),
            (
                vec!["status", "set", "tests", "\u{1b}[32m\u{1b}[0m"],
                "status text must not be empty",
            ),
            (
                vec!["status", "set", "tests", "x", "--tone", "green"],
                "--tone must be",
            ),
            (
                vec!["status", "set", "tests", "x", "--link", "file:///etc"],
                "--link must be",
            ),
            (
                vec!["status", "set", "tests", "x", "--color", "red; x: y"],
                "--color must be",
            ),
            (
                vec![
                    "status",
                    "set",
                    "tests",
                    "x",
                    "--popover",
                    "a",
                    "--popover-file",
                    "-",
                ],
                "only one of --popover or --popover-file",
            ),
            (
                vec!["status", "set", "tests", "x", "--bogus"],
                "usage: komla status",
            ),
            (vec!["status", "clear", "a", "b"], "usage: komla status"),
            (vec!["status", "list"], "usage: komla status"),
        ] {
            let mut api = FakeApi::responding(json!({"ok": true, "result": {}}));
            let error = run_with(&mut api, &args, "").unwrap_err().to_string();
            assert!(error.contains(message), "{args:?}: {error}");
            assert!(api.requests.is_empty(), "{args:?}");
        }
    }

    #[test]
    fn agent_launch_accepts_a_positional_prompt_and_new_workspace_flag() {
        let mut api = FakeApi::responding(json!({
            "ok": true,
            "result": {
                "state": "provisioning",
                "destination": {"kind": "workspace", "workspaceId": "workspace-2"},
                "agent": {"preset": {"id": "codex", "name": "Codex"}}
            }
        }));

        run_with(
            &mut api,
            &[
                "agent",
                "launch",
                "Build it",
                "--new-workspace",
                "--project",
                "Komla",
                "--preset",
                "Codex",
                "--name",
                "CLI work",
                "--branch",
                "cli-work",
            ],
            "",
        )
        .unwrap();

        let body: Value = serde_json::from_slice(&api.requests[0].body).unwrap();
        assert_eq!(api.requests[0].path, "/api/v1/commands");
        assert_eq!(body["type"], "agent.launch");
        assert_eq!(body["destination"], "workspace");
        assert_eq!(body["project"], "Komla");
        assert_eq!(body["preset"], "Codex");
        assert_eq!(body["branch"], "cli-work");
        assert_eq!(body["prompt"], "Build it");
        assert!(
            api.requests[0].allow_long_running,
            "side-effecting operations must not use the short request timeout"
        );
    }

    #[test]
    fn presets_json_uses_the_typed_operation_transport() {
        let result = json!({
            "default": {"presetId": "codex", "modeId": "plan"},
            "presets": [{"id": "codex", "name": "Codex", "modes": []}]
        });
        let mut api = FakeApi::responding(json!({"ok": true, "result": result}));

        let output = run_with(&mut api, &["agent", "presets", "--all", "--json"], "").unwrap();

        assert_eq!(
            serde_json::from_str::<Value>(output.trim()).unwrap(),
            result
        );
        assert_eq!(api.requests[0].path, "/api/v1/commands");
        assert_eq!(
            serde_json::from_slice::<Value>(&api.requests[0].body).unwrap(),
            json!({"type": "agent.presets", "includeInactive": true})
        );
    }

    #[test]
    fn presets_text_marks_modes_only_the_user_can_start() {
        let mut api = FakeApi::responding(json!({"ok": true, "result": {
            "presets": [{"id": "claude", "name": "Claude Code", "modes": [
                {"id": "plan", "name": "Plan"},
                {"id": "skip", "name": "Skip", "launchable": false},
                {"id": "yolo", "name": "YOLO", "launchable": true, "isolatedOnly": true}
            ]}]
        }}));

        let output = run_with(&mut api, &["agent", "presets"], "").unwrap();

        assert!(output.contains("  Plan (plan)\n"));
        assert!(output.contains("  Skip (skip) [unavailable]\n"));
        assert!(output.contains("  YOLO (yolo) [isolated SSH host only]\n"));
    }

    #[test]
    fn context_json_uses_the_typed_operation_transport() {
        let result = json!({
            "context": {"connected": true, "workspace": {"id": "workspace-1"}}
        });
        let mut api = FakeApi::responding(json!({"ok": true, "result": result}));

        let output = run_with(&mut api, &["context", "--json"], "").unwrap();

        assert_eq!(
            serde_json::from_str::<Value>(output.trim()).unwrap(),
            result
        );
        assert_eq!(api.requests[0].path, "/api/v1/commands");
    }

    #[test]
    fn rejects_conflicting_prompt_inputs_before_contacting_komla() {
        let mut api = FakeApi {
            requests: Vec::new(),
            target: None,
            responses: VecDeque::new(),
        };

        let error = run_with(
            &mut api,
            &[
                "agent",
                "launch",
                "--prompt",
                "inline",
                "--prompt-file",
                "task.md",
            ],
            "",
        )
        .unwrap_err();

        assert!(error
            .to_string()
            .contains("use only one of --prompt or --prompt-file"));
        assert!(api.requests.is_empty());
    }

    #[test]
    fn rejects_mode_without_preset_before_contacting_komla() {
        let mut api = FakeApi {
            requests: Vec::new(),
            target: None,
            responses: VecDeque::new(),
        };

        let error = run_with(&mut api, &["agent", "launch", "--mode", "plan"], "").unwrap_err();

        assert!(error.to_string().contains("--mode requires --preset"));
        assert!(api.requests.is_empty());
    }

    #[test]
    fn rejects_workspace_options_for_tab_launches_before_contacting_komla() {
        let mut api = FakeApi {
            requests: Vec::new(),
            target: None,
            responses: VecDeque::new(),
        };

        let error = run_with(&mut api, &["agent", "launch", "--branch", "other"], "").unwrap_err();

        assert!(error.to_string().contains(
            "--project, --name, --description, --branch, and --from-current-branch require --new-workspace"
        ));
        assert!(api.requests.is_empty());
    }

    #[test]
    fn mcp_rejects_diagnostic_subcommands() {
        let mut api = FakeApi {
            requests: Vec::new(),
            target: None,
            responses: VecDeque::new(),
        };

        let error = run_with(&mut api, &["mcp", "list"], "").unwrap_err();

        assert!(error.to_string().contains("usage: komla mcp"));
        assert!(api.requests.is_empty());
    }

    #[test]
    fn operation_failures_preserve_stable_error_fields() {
        let mut api = FakeApi {
            requests: Vec::new(),
            target: None,
            responses: VecDeque::from([HttpResponse {
                status: 404,
                body: json!({
                    "ok": false,
                    "error": {
                        "code": "WORKSPACE_NOT_FOUND",
                        "message": "No workspace matched.",
                        "details": {"cwd": "/missing"}
                    }
                })
                .to_string(),
            }]),
        };

        let error = execute_operation(&mut api, &environment(), json!({"type": "context.get"}))
            .unwrap_err();
        let failure = error.downcast_ref::<OperationFailure>().unwrap();
        let mut output = Vec::new();
        write_operation_error(failure, &mut output).unwrap();

        assert_eq!(
            serde_json::from_slice::<Value>(&output).unwrap(),
            json!({
                "error": {
                    "code": "WORKSPACE_NOT_FOUND",
                    "message": "No workspace matched.",
                    "details": {"cwd": "/missing"}
                }
            })
        );
    }

    #[test]
    fn mcp_stdio_forwards_json_rpc_and_decodes_event_stream_responses() {
        let response = tool_response("done");
        let mut api = FakeApi {
            requests: Vec::new(),
            target: None,
            responses: VecDeque::from([HttpResponse {
                status: 200,
                body: format!("event: message\ndata: {response}\n\n"),
            }]),
        };
        let request = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"name": "set_workspace_title", "arguments": {}}
        });

        let output = run_with(&mut api, &["mcp"], &format!("{request}\n")).unwrap();

        assert_eq!(
            serde_json::from_str::<Value>(output.trim()).unwrap(),
            response
        );
        assert_eq!(
            serde_json::from_slice::<Value>(&api.requests[0].body).unwrap(),
            request
        );
    }

    #[test]
    fn unmanaged_settings_requests_add_a_percent_encoded_cwd() {
        let mut environment = environment();
        environment.scoped_url = false;
        environment.terminal_id = None;
        let mut api = FakeApi::responding(json!({"actions": []}));
        let mut input = Cursor::new(Vec::<u8>::new());
        let mut output = Vec::new();
        let mut errors = Vec::new();

        run_command(
            &[
                "settings".to_owned(),
                "get".to_owned(),
                "actions".to_owned(),
                "--scope".to_owned(),
                "current-project".to_owned(),
            ],
            &environment,
            &mut api,
            &mut input,
            &mut output,
            &mut errors,
        )
        .unwrap();

        assert_eq!(
            api.requests[0].path,
            "/settings/actions?scope=current-project&cwd=%2Frepo%20with%20spaces"
        );
    }

    #[test]
    fn rejects_invalid_settings_scope_before_contacting_komla() {
        let mut api = FakeApi {
            requests: Vec::new(),
            target: None,
            responses: VecDeque::new(),
        };

        let error = run_with(
            &mut api,
            &["settings", "get", "actions", "--scope", "workspace"],
            "",
        )
        .unwrap_err();

        assert!(error
            .to_string()
            .contains("actions scope must be global or current-project"));
        assert!(api.requests.is_empty());
    }

    #[test]
    fn queues_notifications_in_the_companion_mailbox_when_available() {
        let temporary = TempDir::new().unwrap();
        let mut environment = environment();
        environment.companion_inbox = Some(temporary.path().to_owned());
        let mut api = FakeApi {
            requests: Vec::new(),
            target: None,
            responses: VecDeque::new(),
        };
        let mut input = Cursor::new(br#"{"hook":"payload"}"#);
        let mut output = Vec::new();
        let mut errors = Vec::new();

        run_command(
            &[
                "notify".to_owned(),
                "Review ready".to_owned(),
                "--kind".to_owned(),
                "turn-complete".to_owned(),
                "--body".to_owned(),
                "Authentication changes are waiting.".to_owned(),
                "--color".to_owned(),
                "#8b5cf6".to_owned(),
                "--badge".to_owned(),
                "Review".to_owned(),
                "--icon".to_owned(),
                "<svg/>".to_owned(),
                "--icon-color".to_owned(),
                "info".to_owned(),
                "--source".to_owned(),
                "codex".to_owned(),
            ],
            &environment,
            &mut api,
            &mut input,
            &mut output,
            &mut errors,
        )
        .unwrap();

        assert_eq!(String::from_utf8(output).unwrap(), "{\"queued\":true}\n");
        assert!(api.requests.is_empty());
        let path = fs::read_dir(temporary.path())
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let hook: PendingTerminalHook = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        assert_eq!(hook.terminal_id, "terminal-1");
        assert_eq!(hook.kind, "turn-complete");
        assert_eq!(hook.source, "codex");
        assert_eq!(hook.title.as_deref(), Some("Review ready"));
        assert_eq!(
            hook.body.as_deref(),
            Some("Authentication changes are waiting.")
        );
        assert_eq!(hook.color.as_deref(), Some("#8b5cf6"));
        assert_eq!(hook.badge.as_deref(), Some("Review"));
        assert_eq!(hook.icon.as_deref(), Some("<svg/>"));
        assert_eq!(hook.icon_color.as_deref(), Some("info"));
        assert_eq!(hook.hook_input, json!({"hook": "payload"}));
        assert!(hook.delivery_id.is_some());
    }

    #[test]
    fn hook_invocations_leave_stdout_empty_for_agent_hook_parsers() {
        let mut api = FakeApi::responding(json!({"success": true}));
        let output = run_with(
            &mut api,
            &["notify", "--source", "codex", "--event", "UserPromptSubmit"],
            r#"{"prompt":"hello"}"#,
        )
        .unwrap();
        assert_eq!(output, "");
        assert_eq!(api.requests.len(), 1);

        let temporary = TempDir::new().unwrap();
        let mut environment = environment();
        environment.companion_inbox = Some(temporary.path().to_owned());
        let mut api = FakeApi {
            requests: Vec::new(),
            target: None,
            responses: VecDeque::new(),
        };
        let output = run_in(
            &environment,
            &mut api,
            &["notify", "--source", "codex", "--event", "Stop"],
            r#"{"hook_event_name":"Stop"}"#,
        )
        .unwrap();
        assert_eq!(output, "");
        assert_eq!(fs::read_dir(temporary.path()).unwrap().count(), 1);
    }

    #[test]
    fn hook_invocations_print_the_response_when_stdout_is_a_terminal() {
        let mut environment = environment();
        environment.stdout_is_terminal = true;
        let mut api = FakeApi::responding(json!({"success": true}));

        let output = run_in(
            &environment,
            &mut api,
            &["notify", "--source", "my-agent", "--event", "Stop"],
            "",
        )
        .unwrap();

        assert_eq!(output, "{\"success\":true}\n");
    }

    #[test]
    fn hook_invocations_do_not_wait_indefinitely_for_komla() {
        let mut api = FakeApi::responding(json!({"success": true}));

        run_with(
            &mut api,
            &["notify", "--source", "codex", "--event", "Stop"],
            "",
        )
        .unwrap();

        assert!(!api.requests[0].allow_long_running);
    }

    #[test]
    fn normalizes_notification_presentation_before_queueing() {
        let temporary = TempDir::new().unwrap();
        let mut environment = environment();
        environment.companion_inbox = Some(temporary.path().to_owned());
        let mut api = FakeApi {
            requests: Vec::new(),
            target: None,
            responses: VecDeque::new(),
        };
        let mut input = Cursor::new(Vec::<u8>::new());
        let mut output = Vec::new();
        let mut errors = Vec::new();
        let title = format!("  {}  ", "💥".repeat(200));
        let body = "💥".repeat(40_000);
        let color = "x".repeat(300);

        run_command(
            &[
                "notify".to_owned(),
                title,
                "--body".to_owned(),
                body,
                "--color".to_owned(),
                color,
            ],
            &environment,
            &mut api,
            &mut input,
            &mut output,
            &mut errors,
        )
        .unwrap();

        let path = fs::read_dir(temporary.path())
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let hook: PendingTerminalHook = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        assert_eq!(hook.title.as_deref(), Some("💥".repeat(128).as_str()));
        assert_eq!(hook.body.unwrap().encode_utf16().count(), 64 * 1024);
        assert_eq!(hook.color.unwrap().encode_utf16().count(), 256);
    }

    #[test]
    fn sends_a_positional_message_as_a_generic_notification() {
        let mut api = FakeApi::responding(json!({"accepted": true}));

        run_with(&mut api, &["notify", "Review ready"], "").unwrap();

        let body: Value = serde_json::from_slice(&api.requests[0].body).unwrap();
        assert_eq!(body["kind"], "generic");
        assert_eq!(body["title"], "Review ready");
        assert_eq!(body["message"], "");
    }

    #[test]
    fn sends_custom_notification_presentation() {
        let mut api = FakeApi::responding(json!({"accepted": true}));

        run_with(
            &mut api,
            &[
                "notify",
                "Review ready",
                "--body",
                "Authentication changes are waiting.",
                "--kind",
                "input-required",
                "--color",
                "oklch(62% 0.2 285)",
            ],
            "",
        )
        .unwrap();

        let body: Value = serde_json::from_slice(&api.requests[0].body).unwrap();
        assert_eq!(body["title"], "Review ready");
        assert_eq!(body["body"], "Authentication changes are waiting.");
        assert_eq!(body["kind"], "input-required");
        assert_eq!(body["color"], "oklch(62% 0.2 285)");
    }

    #[test]
    fn sends_a_notification_badge_and_icon() {
        let directory = TempDir::new().unwrap();
        let icon = directory.path().join("ci.svg");
        fs::write(&icon, "<svg xmlns='http://www.w3.org/2000/svg'/>").unwrap();
        let mut api = FakeApi::responding(json!({"accepted": true}));

        run_with(
            &mut api,
            &[
                "notify",
                "CI failed on main",
                "--badge",
                "  CI  ",
                "--icon",
                icon.to_str().unwrap(),
                "--icon-color",
                "foreground",
                "--color",
                "error",
            ],
            "",
        )
        .unwrap();

        let body: Value = serde_json::from_slice(&api.requests[0].body).unwrap();
        assert_eq!(body["title"], "CI failed on main");
        assert_eq!(body["badge"], "CI");
        assert!(body["icon"]
            .as_str()
            .unwrap()
            .starts_with("data:image/svg+xml;base64,"));
        assert_eq!(body["iconColor"], "foreground");
        assert_eq!(body["color"], "error");
    }

    #[test]
    fn checks_notification_icons_before_sending() {
        let mut api = FakeApi::responding(json!({"accepted": true}));

        let error = run_with(&mut api, &["notify", "Done", "--icon", "logo.txt"], "").unwrap_err();
        assert!(error.to_string().contains("icons are .svg"));
        let error = run_with(
            &mut api,
            &[
                "notify",
                "Done",
                "--icon",
                "<svg/>",
                "--icon-color",
                "red; x",
            ],
            "",
        )
        .unwrap_err();
        assert!(error.to_string().contains("--icon-color must be"));
        assert!(api.requests.is_empty());
    }

    #[test]
    fn truncates_notification_presentation_before_http_delivery() {
        let mut api = FakeApi::responding(json!({"accepted": true}));
        let title = "t".repeat(300);
        let body = "b".repeat(64 * 1024 + 1);
        let color = "c".repeat(300);

        run_with(
            &mut api,
            &["notify", &title, "--body", &body, "--color", &color],
            "",
        )
        .unwrap();

        let body: Value = serde_json::from_slice(&api.requests[0].body).unwrap();
        assert_eq!(body["title"].as_str().unwrap().encode_utf16().count(), 256);
        assert_eq!(
            body["body"].as_str().unwrap().encode_utf16().count(),
            64 * 1024
        );
        assert_eq!(body["color"].as_str().unwrap().encode_utf16().count(), 256);
    }

    #[test]
    fn omits_blank_notification_presentation_before_http_delivery() {
        let mut api = FakeApi::responding(json!({"accepted": true}));

        run_with(
            &mut api,
            &["notify", "", "--kind", "generic", "--color", ""],
            "",
        )
        .unwrap();

        let body: Value = serde_json::from_slice(&api.requests[0].body).unwrap();
        assert_eq!(body["kind"], "generic");
        assert!(!body.as_object().unwrap().contains_key("title"));
        assert!(!body.as_object().unwrap().contains_key("color"));
    }

    #[test]
    fn tool_activity_preserves_identity_without_becoming_a_prompt() {
        for (source, event) in [
            ("codex", "PreToolUse"),
            ("claude-code", "PreToolUse"),
            ("custom-agent", "PreToolUse"),
            ("opencode", "PreToolUse"),
            ("gemini", "BeforeTool"),
        ] {
            let mut api = FakeApi::responding(json!({"accepted": true}));
            run_with(
                &mut api,
                &["notify", "--source", source, "--event", event],
                r#"{"session_id":"root","turn_id":"turn-2","agent_id":"child"}"#,
            )
            .unwrap();
            let body: Value = serde_json::from_slice(&api.requests[0].body).unwrap();
            assert_eq!(body["kind"], "activity");
            assert_eq!(body["hookInput"]["session_id"], "root");
            assert_eq!(body["hookInput"]["turn_id"], "turn-2");
            assert_eq!(body["hookInput"]["agent_id"], "child");
            assert_eq!(body["hookInput"]["hook_event_name"], event);
        }
    }

    #[test]
    fn antigravity_lifecycle_events_mark_the_turn_working_until_fully_idle() {
        for (event, input, kind) in [
            ("PreInvocation", r#"{}"#, "prompt-submit"),
            ("PreInvocation", r#"{"invocationNum":0}"#, "prompt-submit"),
            ("PreInvocation", r#"{"invocationNum":2}"#, "activity"),
            (
                "PostToolUse",
                r#"{"toolCall":{"name":"run_command"}}"#,
                "activity",
            ),
            ("Stop", r#"{"fullyIdle":true}"#, "turn-complete"),
            ("Stop", r#"{"fullyIdle":false}"#, "activity"),
            ("Stop", r#"{"terminationReason":"model_stop"}"#, "activity"),
        ] {
            let mut api = FakeApi::responding(json!({"accepted": true}));
            run_with(
                &mut api,
                &["notify", "--source", "antigravity", "--event", event],
                input,
            )
            .unwrap();
            let body: Value = serde_json::from_slice(&api.requests[0].body).unwrap();
            assert_eq!(body["kind"], kind, "{event} {input}");
            assert_eq!(body["hookInput"]["hook_event_name"], event);
        }
    }

    #[test]
    fn prompt_submits_without_prompt_text_do_not_send_the_event_name_as_the_prompt() {
        let mut api = FakeApi::responding(json!({"accepted": true}));
        run_with(
            &mut api,
            &[
                "notify",
                "--source",
                "antigravity",
                "--event",
                "PreInvocation",
            ],
            r#"{"conversationId":"conversation-1"}"#,
        )
        .unwrap();
        let body: Value = serde_json::from_slice(&api.requests[0].body).unwrap();
        assert_eq!(body["kind"], "prompt-submit");
        assert_eq!(body["message"], "");
    }

    #[test]
    fn antigravity_event_names_keep_their_meaning_for_other_sources() {
        for (event, kind) in [("PreInvocation", "generic"), ("Stop", "turn-complete")] {
            let mut api = FakeApi::responding(json!({"accepted": true}));
            run_with(
                &mut api,
                &["notify", "--source", "my-agent", "--event", event],
                r#"{"invocationNum":2}"#,
            )
            .unwrap();
            let body: Value = serde_json::from_slice(&api.requests[0].body).unwrap();
            assert_eq!(body["kind"], kind, "{event}");
        }
    }

    #[test]
    fn antigravity_hooks_report_the_workspace_instead_of_the_hooks_directory() {
        for (args, input, cwd) in [
            (
                vec!["notify", "--source", "antigravity", "--event", "Stop"],
                r#"{"workspacePaths":["/work/repo","/work/other"],"fullyIdle":true}"#,
                "/work/repo",
            ),
            (
                vec![
                    "notify",
                    "--source",
                    "antigravity",
                    "--event",
                    "Stop",
                    "--cwd",
                    "/explicit",
                ],
                r#"{"workspacePaths":["/work/repo"]}"#,
                "/explicit",
            ),
            (
                vec!["notify", "--source", "antigravity", "--event", "Stop"],
                r#"{"workspacePaths":[]}"#,
                "/repo with spaces",
            ),
            (
                vec!["notify", "--source", "codex", "--event", "Stop"],
                r#"{"workspacePaths":["/work/repo"]}"#,
                "/repo with spaces",
            ),
        ] {
            let mut api = FakeApi::responding(json!({"accepted": true}));
            run_with(&mut api, &args, input).unwrap();
            let body: Value = serde_json::from_slice(&api.requests[0].body).unwrap();
            assert_eq!(body["cwd"], cwd, "{args:?} {input}");
        }
    }

    #[test]
    fn oversized_antigravity_hooks_keep_their_lifecycle_state_and_workspace() {
        let input = json!({
            "fullyIdle": true,
            "workspacePaths": ["/work/repo"],
            "toolCall": {"args": {"CodeContent": "x".repeat(70000)}},
        })
        .to_string();
        let mut api = FakeApi::responding(json!({"accepted": true}));

        run_with(
            &mut api,
            &["notify", "--source", "antigravity", "--event", "Stop"],
            &input,
        )
        .unwrap();

        let body: Value = serde_json::from_slice(&api.requests[0].body).unwrap();
        assert_eq!(body["kind"], "turn-complete");
        assert_eq!(body["cwd"], "/work/repo");
        assert_eq!(
            body["hookInput"],
            json!({"hook_event_name": "Stop", "fullyIdle": true})
        );
    }

    #[test]
    fn notify_leaves_the_antigravity_reply_to_the_entry_point() {
        let mut api = FakeApi::responding(json!({"success": true}));
        let output = run_with(
            &mut api,
            &[
                "notify",
                "--source",
                "antigravity",
                "--event",
                "PreInvocation",
            ],
            r#"{"invocationNum":0}"#,
        )
        .unwrap();
        assert_eq!(output, "");

        let temporary = TempDir::new().unwrap();
        let mut environment = environment();
        environment.companion_inbox = Some(temporary.path().to_owned());
        let mut api = FakeApi {
            requests: Vec::new(),
            target: None,
            responses: VecDeque::new(),
        };
        let output = run_in(
            &environment,
            &mut api,
            &["notify", "--source", "antigravity", "--event", "Stop"],
            r#"{"fullyIdle":true}"#,
        )
        .unwrap();
        assert_eq!(output, "");
    }

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    fn notify_requests(count: usize) -> FakeApi {
        FakeApi {
            requests: Vec::new(),
            target: None,
            responses: (0..count)
                .map(|_| HttpResponse {
                    status: 200,
                    body: json!({"success": true}).to_string(),
                })
                .collect(),
        }
    }

    #[test]
    fn notify_runs_the_command_after_a_separator() {
        let args = strings(&["notify", "--", "npm", "run", "build"]);
        assert_eq!(notify_run_arguments(&args), Some((None, &args[2..])));
        let args = strings(&["notify", " Build ", "--", "make", "--", "-j4"]);
        assert_eq!(
            notify_run_arguments(&args),
            Some((Some("Build"), &args[3..]))
        );
        for args in [
            strings(&["notify", "Review ready"]),
            strings(&["notify", "--kind", "generic", "--", "make"]),
            strings(&["launch", "--", "make"]),
        ] {
            assert_eq!(notify_run_arguments(&args), None);
        }
    }

    #[test]
    fn a_command_run_by_notify_is_not_a_hook() {
        assert!(!is_notify_hook(&strings(&[
            "notify", "--", "grep", "--event", "log.txt"
        ])));
        assert!(is_notify_hook(&strings(&[
            "notify", "--source", "codex", "--event", "Stop"
        ])));
    }

    #[test]
    fn a_finished_command_notifies_how_it_ended() {
        let elapsed = Duration::from_secs(192);
        assert_eq!(
            command_end(None, "npm run build", None, false, elapsed),
            CommandEvent {
                event: "Stop",
                kind: "turn-complete",
                title: Some("Done".to_owned()),
                body: Some("npm run build finished in 3m 12s".to_owned()),
            }
        );
        assert_eq!(
            command_end(Some("Build"), "make", Some("exit code 2"), false, elapsed),
            CommandEvent {
                event: "StopFailure",
                kind: "error",
                title: Some("Build".to_owned()),
                body: Some("make failed with exit code 2 after 3m 12s".to_owned()),
            }
        );
        let long = "t".repeat(300);
        let title = command_end(Some(&long), "make", None, false, elapsed).title;
        assert_eq!(title.unwrap().encode_utf16().count(), 256);
        for failure in [None, Some("signal 2")] {
            assert_eq!(
                command_end(None, "make", failure, true, elapsed),
                CommandEvent {
                    event: "Interrupt",
                    kind: "interrupted",
                    title: None,
                    body: None,
                }
            );
        }
    }

    #[test]
    fn formats_how_long_a_command_ran() {
        assert_eq!(format_elapsed(Duration::from_millis(400)), "0s");
        assert_eq!(format_elapsed(Duration::from_secs(59)), "59s");
        assert_eq!(format_elapsed(Duration::from_secs(60)), "1m 0s");
        assert_eq!(format_elapsed(Duration::from_secs(3 * 3600 + 125)), "3h 2m");
    }

    #[test]
    fn displays_the_command_as_typed() {
        assert_eq!(
            display_command(&strings(&["sh", "-c", "sleep 1; exit 1", "", "it's"])),
            r#"sh -c 'sleep 1; exit 1' '' 'it'\''s'"#
        );
    }

    /// Runs `command` as `komla notify -- <command>` does, against a fake Komla that answers
    /// `answers` requests, and returns how it exited, the notification bodies and warnings.
    fn run_with_komla(
        title: Option<&str>,
        command: &[&str],
        interrupted: bool,
        answers: usize,
    ) -> (CommandExit, Vec<Value>, String) {
        let environment = environment();
        let mut api = notify_requests(answers);
        let mut warnings = Vec::new();
        let mut notify_warnings = Vec::new();
        let exit = run_notifying(
            title,
            &strings(command),
            &mut |event| notify_command_event(event, &environment, &mut api, &mut notify_warnings),
            &AtomicBool::new(interrupted),
            &mut warnings,
        )
        .unwrap();
        warnings.extend(notify_warnings);
        let bodies = api
            .requests
            .iter()
            .map(|request| {
                assert_eq!(request.path, "/api/v1/notify");
                assert!(!request.allow_long_running);
                serde_json::from_slice(&request.body).unwrap()
            })
            .collect();
        (exit, bodies, String::from_utf8(warnings).unwrap())
    }

    #[cfg(unix)]
    #[test]
    fn shows_the_terminal_working_until_the_command_fails_and_exits_with_its_code() {
        let (exit, bodies, warnings) = run_with_komla(None, &["sh", "-c", "exit 3"], false, 2);

        assert_eq!(
            exit,
            CommandExit {
                code: 3,
                signal: None
            }
        );
        assert_eq!(warnings, "");
        assert_eq!(
            bodies[0],
            json!({
                "cwd": "/repo with spaces",
                "kind": "prompt-submit",
                "source": "command",
                "message": "",
                "hookInput": {"hook_event_name": "UserPromptSubmit"},
                "terminalId": "terminal-1",
            })
        );
        assert_eq!(bodies[1]["kind"], "error");
        assert_eq!(bodies[1]["source"], "command");
        assert_eq!(
            bodies[1]["hookInput"],
            json!({"hook_event_name": "StopFailure"})
        );
        assert_eq!(bodies[1]["title"], "Failed");
        assert_eq!(
            bodies[1]["body"],
            "sh -c 'exit 3' failed with exit code 3 after 0s"
        );
    }

    #[cfg(unix)]
    #[test]
    fn reports_a_command_killed_by_a_signal_as_a_shell_does() {
        let (exit, bodies, _) = run_with_komla(None, &["sh", "-c", "kill -TERM $$"], false, 2);
        assert_eq!(
            exit,
            CommandExit {
                code: 143,
                signal: Some(libc::SIGTERM)
            }
        );
        assert_eq!(bodies[1]["kind"], "error");
    }

    #[cfg(unix)]
    #[test]
    fn a_command_ended_by_ctrl_c_only_stops_the_working_spinner() {
        for (command, code, signal) in [
            ("kill -INT $$", 130, Some(libc::SIGINT)),
            // As programs that catch Ctrl-C exit, pytest with 2.
            ("exit 130", 130, None),
            ("exit 2", 2, None),
        ] {
            let (exit, bodies, _) = run_with_komla(Some("Build"), &["sh", "-c", command], true, 2);
            assert_eq!(exit.signal, signal);
            assert_eq!(exit.code, code);
            assert_eq!(bodies[1]["kind"], "interrupted");
            assert_eq!(
                bodies[1]["hookInput"],
                json!({"hook_event_name": "Interrupt"})
            );
            assert!(bodies[1].get("title").is_none());
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_command_that_succeeds_after_ctrl_c_still_notifies_done() {
        let (_, bodies, _) = run_with_komla(None, &["sh", "-c", "exit 0"], true, 2);
        assert_eq!(bodies[1]["kind"], "turn-complete");
    }

    #[test]
    fn a_command_that_cannot_start_sends_nothing() {
        let (exit, bodies, warnings) =
            run_with_komla(None, &["komla-test-command-that-does-not-exist"], false, 0);

        assert_eq!(exit.code, 127);
        assert!(bodies.is_empty());
        assert!(
            warnings.starts_with("komla: could not run komla-test-command-that-does-not-exist:")
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_command_still_runs_when_komla_does_not_answer() {
        let (exit, bodies, warnings) = run_with_komla(None, &["true"], false, 0);

        assert_eq!(exit.code, 0);
        assert_eq!(bodies.len(), 2);
        assert_eq!(
            warnings,
            "komla: could not notify Komla: missing fake response\n".repeat(2)
        );
    }

    #[test]
    fn antigravity_hooks_reply_with_json_and_let_stop_end_the_turn() {
        let args = |values: &[&str]| {
            values
                .iter()
                .map(|value| value.to_string())
                .collect::<Vec<_>>()
        };
        for (event, reply) in [
            ("PreInvocation", "{}"),
            ("PostToolUse", "{}"),
            ("Stop", r#"{"decision":"stop"}"#),
        ] {
            assert_eq!(
                hook_reply(&args(&[
                    "notify",
                    "--source",
                    "antigravity",
                    "--event",
                    event
                ])),
                Some(reply)
            );
        }
        assert_eq!(
            hook_reply(&args(&["notify", "--source", "codex", "--event", "Stop"])),
            None
        );
        assert_eq!(
            hook_reply(&args(&[
                "notify",
                "--source",
                "antigravity",
                "Review ready"
            ])),
            None
        );
    }

    #[test]
    fn oversized_codex_hooks_retain_lifecycle_identity() {
        let input = json!({"session_id":"root", "turn_id":"turn-2", "agent_id":"child", "tool_input": "x".repeat(70000)});
        let compact = compact_hook_input("codex", input, true);
        assert_eq!(
            compact,
            json!({"session_id":"root", "turn_id":"turn-2", "agent_id":"child"})
        );
    }

    #[test]
    fn oversized_opencode_requests_retain_their_id() {
        let input = json!({"permissionID":"per_1", "tool_input": {"command": "x".repeat(70000)}});
        let compact = compact_hook_input("opencode", input, true);
        assert_eq!(compact, json!({"permissionID":"per_1"}));
    }

    #[test]
    fn defaults_message_only_notifications_to_generic() {
        let mut api = FakeApi::responding(json!({"accepted": true}));

        run_with(&mut api, &["notify", "--message", "Review ready"], "").unwrap();

        let body: Value = serde_json::from_slice(&api.requests[0].body).unwrap();
        assert_eq!(body["kind"], "generic");
        assert_eq!(body["message"], "Review ready");
    }

    #[test]
    fn keeps_kind_only_generic_notifications_compatible() {
        let mut api = FakeApi::responding(json!({"accepted": true}));

        run_with(&mut api, &["notify", "generic"], "").unwrap();

        let body: Value = serde_json::from_slice(&api.requests[0].body).unwrap();
        assert_eq!(body["kind"], "generic");
        assert_eq!(body["message"], "");
    }

    #[test]
    fn explicit_notification_kind_allows_a_title_named_like_a_kind() {
        let mut api = FakeApi::responding(json!({"accepted": true}));

        run_with(&mut api, &["notify", "--kind", "generic", "idle"], "").unwrap();

        let body: Value = serde_json::from_slice(&api.requests[0].body).unwrap();
        assert_eq!(body["kind"], "generic");
        assert_eq!(body["title"], "idle");
        assert_eq!(body["message"], "");
    }

    #[test]
    fn claude_permission_notifications_remain_actionable() {
        let mut api = FakeApi::responding(json!({"success": true}));
        let mut input =
            Cursor::new(br#"{"notification_type":"permission_prompt","message":"Approve Bash?"}"#);
        let mut output = Vec::new();
        let mut errors = Vec::new();

        run_command(
            &[
                "notify".to_owned(),
                "--source".to_owned(),
                "claude-code".to_owned(),
                "--event".to_owned(),
                "Notification".to_owned(),
            ],
            &environment(),
            &mut api,
            &mut input,
            &mut output,
            &mut errors,
        )
        .unwrap();

        let body: Value = serde_json::from_slice(&api.requests[0].body).unwrap();
        assert_eq!(body["kind"], "input-required");
        assert_eq!(body["message"], "Approve Bash?");
    }

    fn send_hook(source: &str, event: &str, hook_input: Value) -> Vec<Value> {
        let mut api = FakeApi::responding(json!({"success": true}));
        let mut input = Cursor::new(serde_json::to_vec(&hook_input).unwrap());
        run_command(
            &[
                "notify".to_owned(),
                "--source".to_owned(),
                source.to_owned(),
                "--event".to_owned(),
                event.to_owned(),
            ],
            &environment(),
            &mut api,
            &mut input,
            &mut Vec::new(),
            &mut Vec::new(),
        )
        .unwrap();
        api.requests
            .iter()
            .map(|request| serde_json::from_slice(&request.body).unwrap())
            .collect()
    }

    #[test]
    fn claude_turns_that_end_without_a_stop_still_end() {
        let failed = send_hook(
            "claude-code",
            "StopFailure",
            json!({"error": "rate_limit", "error_details": "429 Too Many Requests", "last_assistant_message": ""}),
        );
        assert_eq!(failed[0]["kind"], "error");
        assert_eq!(failed[0]["message"], "429 Too Many Requests");

        let compacted = send_hook(
            "claude-code",
            "PostCompact",
            json!({"trigger": "manual", "compact_summary": "x".repeat(70_000)}),
        );
        assert_eq!(compacted[0]["kind"], "turn-complete");
        assert_eq!(compacted[0]["message"], "Compacted the conversation");
        assert_eq!(compacted[0]["hookInput"]["trigger"], "manual");

        let ended = send_hook(
            "claude-code",
            "SessionEnd",
            json!({"reason": "prompt_input_exit"}),
        );
        assert_eq!(ended[0]["kind"], "interrupted");
    }

    #[test]
    fn codex_interrupts_stop_the_turn() {
        let interrupted = send_hook("codex", "Interrupt", json!({"turn_id": "turn-1"}));
        assert_eq!(interrupted[0]["kind"], "interrupted");
    }

    // Komla refuses an interrupt that no agent hook reported, so the CLI must not queue one.
    #[test]
    fn interrupted_is_not_a_kind_to_pass_by_hand() {
        let mut api = FakeApi::responding(json!({"accepted": true}));
        let error = run_with(&mut api, &["notify", "--kind", "interrupted"], "").unwrap_err();
        assert_eq!(
            error.to_string(),
            "unsupported notification kind: interrupted"
        );
        assert!(api.requests.is_empty());

        run_with(&mut api, &["notify", "interrupted"], "").unwrap();
        let body: Value = serde_json::from_slice(&api.requests[0].body).unwrap();
        assert_eq!(body["kind"], "generic");
        assert_eq!(body["title"], "interrupted");
    }

    #[test]
    fn opencode_reports_aborted_and_failed_turns() {
        let interrupted = send_hook("opencode", "Interrupt", json!({"sessionID": "ses_1"}));
        assert_eq!(interrupted[0]["kind"], "interrupted");
        assert_eq!(interrupted[0]["hookInput"]["hook_event_name"], "Interrupt");

        // The plugin passes OpenCode's error text, since only Claude's input is read for one.
        let mut api = FakeApi::responding(json!({"success": true}));
        let mut input = Cursor::new(br#"{"sessionID":"ses_1","error":"invalid api key"}"#.to_vec());
        let args = [
            "notify",
            "--source",
            "opencode",
            "--event",
            "StopFailure",
            "--message",
            "invalid api key",
        ]
        .map(str::to_owned);
        run_command(
            &args,
            &environment(),
            &mut api,
            &mut input,
            &mut Vec::new(),
            &mut Vec::new(),
        )
        .unwrap();
        let failed: Value = serde_json::from_slice(&api.requests[0].body).unwrap();
        assert_eq!(failed["kind"], "error");
        assert_eq!(failed["message"], "invalid api key");
        assert_eq!(failed["hookInput"]["hook_event_name"], "StopFailure");
    }

    #[test]
    fn hooks_grok_runs_for_other_agents_send_nothing() {
        let grok = CliEnvironment {
            run_by_grok: true,
            ..environment()
        };
        for (source, expected) in [("claude-code", 0), ("codex", 0), ("grok-build", 1)] {
            let mut api = FakeApi::responding(json!({"success": true}));
            let mut input = Cursor::new(br#"{"session_id":"s"}"#.to_vec());
            let args = ["notify", "--source", source, "--event", "Stop"].map(str::to_owned);
            run_command(
                &args,
                &grok,
                &mut api,
                &mut input,
                &mut Vec::new(),
                &mut Vec::new(),
            )
            .unwrap();
            assert_eq!(api.requests.len(), expected, "{source}");
        }
    }

    #[test]
    fn hooks_other_runners_run_for_claude_send_nothing() {
        let cursor = CliEnvironment {
            run_by_cursor: true,
            ..environment()
        };
        let devin = CliEnvironment {
            run_by_devin: true,
            ..environment()
        };
        let detached_claude = CliEnvironment {
            run_by_detached_claude: true,
            ..environment()
        };
        for (environment, source, expected) in [
            (&cursor, "claude-code", 0),
            (&cursor, "cursor", 1),
            (&devin, "claude-code", 0),
            (&devin, "devin", 1),
            (&detached_claude, "claude-code", 0),
            // A Codex run in a background Claude session's tool call still reports its own turn.
            (&detached_claude, "codex", 1),
        ] {
            let mut api = FakeApi::responding(json!({"success": true}));
            let mut input = Cursor::new(br#"{"session_id":"s"}"#.to_vec());
            let args = ["notify", "--source", source, "--event", "Stop"].map(str::to_owned);
            run_command(
                &args,
                environment,
                &mut api,
                &mut input,
                &mut Vec::new(),
                &mut Vec::new(),
            )
            .unwrap();
            assert_eq!(api.requests.len(), expected, "{source}");
        }
    }

    #[test]
    fn claude_permission_prompts_say_what_they_ask() {
        let message = |hook_input: Value| {
            send_hook("claude-code", "PermissionRequest", hook_input)[0]["message"].clone()
        };
        let question = message(json!({
            "tool_name": "AskUserQuestion",
            "tool_input": {"questions": [{"question": "Red or blue?", "header": "Color"}]},
        }));
        assert_eq!(question, "Red or blue?");
        let command = message(json!({
            "tool_name": "Bash",
            "tool_input": {"command": "curl -sI https://example.com"},
        }));
        assert_eq!(command, "curl -sI https://example.com");
        let described = message(json!({
            "tool_name": "Bash",
            "tool_input": {"command": "curl -sI https://example.com", "description": "Fetch headers"},
        }));
        assert_eq!(described, "Fetch headers");
        let edit = message(json!({"tool_name": "Edit", "tool_input": {"file_path": "/a"}}));
        assert_eq!(edit, "Claude needs approval for Edit");
        let heredoc = message(json!({
            "tool_name": "Bash",
            "tool_input": {"command": format!("cat > big <<'EOF'\n{}\nEOF", "x ".repeat(20_000))},
        }));
        assert!(!heredoc.as_str().unwrap().contains('\n'));
        assert_eq!(heredoc.as_str().unwrap().encode_utf16().count(), 8192);
        let sent = send_hook(
            "claude-code",
            "PermissionRequest",
            json!({"tool_name": "Edit"}),
        );
        assert_eq!(sent[0]["kind"], "input-required");
    }

    #[test]
    fn claude_tool_ends_are_activity() {
        for event in ["PostToolUse", "PostToolUseFailure"] {
            let sent = send_hook("claude-code", event, json!({"tool_name": "Bash"}));
            assert_eq!(sent[0]["kind"], "activity", "{event}");
        }
    }

    #[test]
    fn claude_tool_ends_leave_out_the_tools_output() {
        let sent = send_hook(
            "claude-code",
            "PostToolUse",
            json!({
                "session_id": "s1",
                "tool_name": "Bash",
                "tool_input": {"command": "npm test"},
                "tool_response": {"stdout": "x".repeat(70_000)},
            }),
        );
        assert_eq!(
            sent[0]["hookInput"],
            json!({
                "hook_event_name": "PostToolUse",
                "session_id": "s1",
                "tool_name": "Bash",
                "tool_input": {"command": "npm test"},
            })
        );
    }

    #[test]
    fn automatic_compacts_send_nothing() {
        assert!(send_hook("claude-code", "PostCompact", json!({"trigger": "auto"})).is_empty());
    }

    #[test]
    fn oversized_claude_subagent_completions_preserve_their_discriminator() {
        let mut api = FakeApi::responding(json!({"success": true}));
        let hook_input = json!({
            "last_assistant_message": "x".repeat(70_000),
            "hook_event_name": "SubagentStop",
            "agent_id": "agent-abc123",
        });
        let mut input = Cursor::new(serde_json::to_vec(&hook_input).unwrap());
        let mut output = Vec::new();
        let mut errors = Vec::new();

        run_command(
            &[
                "notify".to_owned(),
                "--source".to_owned(),
                "claude-code".to_owned(),
                "--event".to_owned(),
                "Stop".to_owned(),
            ],
            &environment(),
            &mut api,
            &mut input,
            &mut output,
            &mut errors,
        )
        .unwrap();

        let body: Value = serde_json::from_slice(&api.requests[0].body).unwrap();
        assert_eq!(
            body["hookInput"],
            json!({
                "hook_event_name": "SubagentStop",
                "agent_id": "agent-abc123",
            })
        );
    }

    #[test]
    fn unmanaged_notifications_omit_the_absent_terminal_identity() {
        let mut environment = environment();
        environment.scoped_url = false;
        environment.terminal_id = None;
        environment.workspace_id = None;
        environment.companion_inbox = None;
        let mut api = FakeApi::responding(json!({"accepted": true}));
        let mut input = Cursor::new(Vec::<u8>::new());
        let mut output = Vec::new();
        let mut errors = Vec::new();

        run_command(
            &["notify".to_owned(), "turn-complete".to_owned()],
            &environment,
            &mut api,
            &mut input,
            &mut output,
            &mut errors,
        )
        .unwrap();

        let body: Value = serde_json::from_slice(&api.requests[0].body).unwrap();
        assert!(body.get("terminalId").is_none());
        assert_eq!(body["cwd"], "/repo with spaces");
        assert!(api.requests[0].allow_long_running);
    }

    #[test]
    fn windows_user_profile_is_a_local_komla_data_fallback() {
        assert_eq!(
            default_komla_data_dir(None, Some(r"C:\Users\dev")),
            Some(PathBuf::from(r"C:\Users\dev").join(".komla"))
        );
    }

    #[test]
    fn installed_staging_cli_discovers_its_own_data_directory() {
        assert_eq!(
            installed_komla_data_dir(Some(Path::new("/Users/dev/.komla-staging/bin/komla"))),
            Some(PathBuf::from("/Users/dev/.komla-staging"))
        );
    }
}
