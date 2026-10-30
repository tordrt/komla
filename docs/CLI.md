# Komla CLI

Komla bundles a `komla` CLI that agents and hooks use to work with the desktop: launch agents,
send notifications, set status items and change settings. An MCP server exposes the same
operations to clients that require MCP.

## Commands

Komla-managed terminals include `komla` on `PATH`. They also expose its absolute path as
`KOMLA_CLI`, which is a fallback for hooks and integrations that must not depend on shell startup
files preserving `PATH`. The desktop installs its native build; SSH hosts receive a Linux or macOS
build automatically.

```bash
komla skill project-setup
komla notify --source my-agent --event Stop
komla notify "Review ready" --body "Authentication changes are waiting." --color '#8b5cf6'
komla settings get actions --scope current-project
komla context --json
komla agent presets
komla agent launch "Investigate the cache" --new-workspace --name "Investigate cache" --branch investigate-cache
komla workspace title "Cache investigation" --description "Trace stale cache reads."
komla open ~/notes
komla status set tests "142/150 passing" --tone warning --link https://github.com/org/repo/pull/812
komla status clear tests
komla agent launch "Review the current implementation."
komla preview open http://localhost:5173
```

`komla --help` prints an index of the commands, one line each, grouped by what they're for, with
the commands Komla and its integrations run last. `komla <command> --help` (or `komla help
<command>`) prints that command's page: its usage, what it does, its options and examples. A
command's first words show each command they start, such as every `status` command for `status`;
`workspace tag` and its siblings show `tag`'s page. Each command is one entry in
`native/src/help.rs`, wrapped at 80 columns when printed. The agent guides point there for options
and keep only when and how to use them.

`komla workspace list [--all] [--json]` lists the workspaces, with those in the Trash under
`--all`: each one's `id`, `name`, `project`, `branch`, `path`, `environment`, `agentActive`, the
`attention` it shows, its `tag` and the `linkedWorkspaceIds` it's linked to. Through an SSH host's tunnel it lists that host's
workspaces only. `--workspace <id>` makes any command that acts on a workspace (`tag`, `title`,
`snooze`, `status set`, `notify`, `agent launch`, `context` and the rest) act on that one in
place of the calling terminal's, so one script can keep every workspace current. It never
reaches past the SSH host a request came from. `trash` refuses it, as does `notify -- <command>`,
which shows the terminal it runs in working.

`komla workspace link <id>...` links the workspace to each of the others, both ways, as Link
Workspaces on a workspace's card does: each gets a symlink to the other in its `linked-workspaces/`
folder, which Git ignores, so an agent can read and edit both for a task that spans repositories.
Komla links local workspaces to local ones and SSH workspaces to others on the same host
(`WORKSPACE_LINK_UNSUPPORTED`), once each is ready and out of the Trash (`WORKSPACE_NOT_ACTIVE`).
`komla workspace unlink <id>...` removes those links, including one to a workspace that's gone.
Both print the ids the workspace is linked to afterward, and the user can turn them off with
`workspace.link` in Settings → Integrations & MCP.

`komla tag <tag>` gives the workspace its one tag, shown on its card while no agent is busy there
until it's taken off or replaced, so scripts use tags for what stays, such as CI under way:

```bash
komla tag "CI running" --spinner --tone info --tooltip "build 7 of 9" --workspace "$id"
komla tag "CI failed" --tone error --if "CI running" --workspace "$id"
komla untag "CI running" --workspace "$id"
```

A tag Komla doesn't have yet joins the user's tag list, with `--tone` (`neutral`, `info`,
`attention`, `success`, `warning` or `error`), `--icon` (as `status set` takes it, its shape shown
in the tag's color) and `--spinner`, which shows Komla's spinner in place of the tag glyph; a tag in
the list keeps the look the user gave it in Settings. A full list (50 tags) refuses new ones
(`TAG_LIST_FULL`). `--tooltip` adds hover text for this workspace, until its tag changes. `--if
<tag>` changes only a workspace that has that tag, and `untag <tag>` takes off only that tag, so a
script that finishes late leaves alone a tag the user put on since. The user removes any tag from
the card's Tag menu.

`komla tags [--json]` lists the user's tags in the list's order, so an agent can pick a tag the
user already has. Each tag has its `name` and `tone`; `hasIcon` and `spinner` mark the rest of its
look, `pullRequestState` (`in-review` or `needs-changes`) marks a tag Komla puts on workspaces whose
pull request stands so, and `hidden` marks one the user hides in the sidebar, whose workspaces move
to the Filtered shelf while nothing there needs the user. The list belongs to the user, so `tags`
takes no `--workspace` and works the same through an SSH host's tunnel.

`komla agent launch [prompt]` is the single launch interface. It opens a tab by default;
`--new-workspace` creates a workspace and launches exactly one agent there. Use `--prompt-file` for
longer instructions or stdin, and `--preset` with an optional `--mode` after discovering canonical
IDs through `komla agent presets --json`, which marks the modes agents may not start `launchable:
false`, with an `unavailableReason` that tells the user how to allow them, and the modes agents may
start only isolated `isolatedOnly: true`. Its `default` names a mode only when one is pinned. Each
mode's robot button in Settings → Agents decides where agents may start it: anywhere, only where
the new agent runs on an SSH host the user marked isolated (Treat as isolated in the host's
settings, on for new hosts), or never. By default agents may start modes that still ask before
acting anywhere, and ones that skip permission prompts (such as `--dangerously-skip-permissions` or
`--yolo`) only isolated. A tab runs where its workspace does; a new workspace runs where it will be
created. Agents may always start the launch mode pinned in Komla CLI launch defaults, while it
stays pinned. A mode agents may not start there is refused (`AGENT_MODE_REQUIRES_USER`, or
`AGENT_MODE_REQUIRES_ISOLATION` for one allowed only isolated). Without `--mode`, the pinned agent
starts in its pinned mode and any other agent in its Default mode, never in the calling workspace's
mode or the one it last started in. A workspace launch goes in the calling workspace's project,
or the one `--project <id-or-name>` names; outside every workspace `--project` is required, and
leaving it out lists the projects (`PROJECT_REQUIRED`). So does a directory that workspaces of
different projects share, unless only one of those projects has a terminal running there, or that
several SSH workspaces without a project share, unless only one of them does (`PROJECT_AMBIGUOUS`). Such a launch starts the workspace on the
device it ran on: this computer, unless Where agents start pins an SSH host, or the SSH host. A
pinned host that isn't set up yet, or no longer exists, refuses worktree launches from this
computer (`SSH_HOST_NOT_READY`) rather than starting them here, since agents may start the pinned
mode anywhere. On an SSH host, a launch from outside its workspaces, such as `ssh host
'~/.komla/helpers/komla agent launch "…" --new-workspace --project web'`, reaches Komla on the host
itself if it runs there, else the desktop whose companion route was written last and whose port
still accepts connections, and always starts the workspace on that host. Other commands outside a
workspace reach a desktop the same way, which acts only on that host's workspaces; agent hooks
(`komla notify`) and `komla mcp` reach only the host's own Komla.
`-C <path>` supplies context outside a managed terminal. `--from-current-branch` starts
the new worktree from the branch checked out in the calling workspace instead of the project's base
branch; uncommitted changes are not copied.

Typed commands call desktop-owned Komla Operations directly. `komla mcp` has one separate purpose:
it is a command-based stdio MCP adapter for clients that require MCP. It has no public `list` or
`call` subcommands, and agents should use the typed CLI commands when invoking Komla themselves.
Repository commands are the exception: `komla git snapshot` and
`komla git target <push|pull|merge-remote|merge-source|sync>` operate directly on the repository
selected by `-C <path>` and `--target <branch>`, without a desktop connection. Target operations
return JSON with `success`, `message`, and an optional `errorCode`; callers must check `success` for
Git failures. `sync` instead prints the ref to rebase onto or merge from: the target, fast-forwarded
to `origin/<target>` when it was strictly behind and no worktree was using it, or `origin/<target>`.
The desktop starts the executable's internal Remote Companion role automatically; it is not a
public CLI command and should not be added to agent instructions or invoked manually.

## Notifications

For custom lifecycle hooks, prefer the installed CLI:

```bash
komla notify --source my-agent --event Stop
komla notify "Review ready"
komla notify "Review ready" --body "Authentication changes are waiting."
komla notify "Tests failed" --kind error --body "3 integration tests failed." --color '#ef4444'
komla notify "CI failed on main" --badge CI --icon ci.svg --icon-color foreground --color error
```

The positional title appears in the workspace badge, or `--badge`'s shorter text with the title on
hover. `--body` replaces the card's normal secondary line while the notification is active,
`--kind` controls lifecycle behavior and default styling, and `--color` overrides the badge and
pane-border color: `success`, `warning`, `error`, `info`, `attention` and `muted` follow the theme
as Komla's own notifications do, and any other CSS color value fills the badge. `--icon` replaces
the kind's glyph with an image, as `komla status set --icon` takes it (an SVG, PNG, WebP, GIF or
JPEG file or SVG markup, up to 32 KB); `--icon-color` shows only its shape, in `foreground`,
`muted`, a status tone or a hex color. Quote hex colors because `#` starts a comment in common shells.

The CLI carries terminal and
current-directory context and uses durable SSH delivery automatically. Lifecycle hooks use `--event`
and may include detail with `--message`. With `--event`, the CLI prints nothing to stdout unless it
is a terminal (with `--source antigravity` it first prints the JSON reply Antigravity hooks require, `{}` or `{"decision":"stop"}` for `Stop`, even when Komla can't be reached), exits 0 even when delivery fails (the error goes to stderr), and stops waiting for
Komla after 10 seconds, so a missed notification never fails the agent's hook.
`PreToolUse`, `PostToolUse`, `PostToolUseFailure` and Gemini’s `BeforeTool` map to `activity`:
they restore the working indicator without creating attention or recording a user prompt. Pair them
with root `Stop` and `UserPromptSubmit` hooks (`AfterAgent` and `BeforeAgent` for Gemini). Forward original JSON on stdin, retaining session, turn, and subagent
identity. Completion hooks wait 750 ms before applying; fresh activity cancels pending completion.
An `input-required` hook whose `hookInput.permissionID` names the request waits 500 ms, so an
automatic approval can answer first; other `input-required` hooks apply at once. `activity` naming
the same `permissionID` cancels the request, even when it arrives first, as do a new prompt, the end
of the turn, an error or an interrupt. Other activity and other requests don't, since a parallel tool
call can start while the request waits, and an `idle` during the wait is dropped. The OpenCode
plugin names the `permissionID` in `PermissionRequest`, and sends a `PreToolUse` naming it when the
request is approved. Claude Code's `PermissionRequest` (also for `AskUserQuestion`, whose first
question becomes the text) shows its prompt at once; the `Notification` (`permission_prompt`) that
repeats it 6 seconds later, in the same session, is dropped, and a `PostToolUse` or
`PostToolUseFailure` with the same `tool_name` and `agent_id`, whose `tool_input` holds the
prompt's (an answered question adds its `answers`), clears the `input-required` once no other
prompt in the terminal waits, as when it is answered on another device. The CLI forwards tool ends
without their `tool_response`.
`StopFailure` maps to `error` and ends the turn with an error badge; an `error` from any other hook
or from `--kind error` only shows its badge. `Interrupt` and `SessionEnd` map to `interrupted`,
which stops the working indicator without a notification; `interrupted` is accepted only from those
hooks. Claude's `PostCompact` completes the turn after a manual `/compact` (`trigger` `manual`),
unless a `Stop` is held for background work (below) or the last prompt's turn has not ended (by a
`Stop`, `StopFailure`, `SessionEnd`, or an Esc the terminal title confirms), as `/code-review`'s has
not while its review runs as a background subagent; an automatic one sends nothing. For 15 seconds
after an interrupt or a failed turn, `activity` is treated as late news from that turn, unless a new
prompt arrives or the terminal title shows the agent working again. A `komla` CLI older than these
hooks, which an SSH host keeps when another device prepared it last, sends them as `generic`; Komla
reads them by `hook_event_name` in the same way, and drops an automatic `PostCompact`.
With `--source antigravity`, `PreInvocation` starts the turn on its first model call (a prompt
submit without prompt text, since Antigravity's payload has none) and is `activity` after that, `PostToolUse` is `activity`, and `Stop` completes the turn only when
`fullyIdle` is true. Antigravity runs hooks from the folder containing `hooks.json`, so the CLI takes
the workspace from `workspacePaths` instead of the current directory. Antigravity has no hook for
approval prompts or questions, so while its turn is working, a terminal alert from the same terminal
other than its end-of-turn "ready for input" one is shown as `input-required` right away. Terminal
alerts from a terminal whose program reports its state (below) are ignored, since the reports say
the same.
The OpenCode plugin file serves OpenCode 1.18.29 and later (`server()`) and OpenCode 2
(`Plugin.define` `setup()`). OpenCode 2 runs plugins in a service its sessions share, so its reports
pass `--cwd` with the session's folder and blank `KOMLA_TERMINAL_ID`, `KOMLA_WORKSPACE_ID` and
`TMUX`, which would name the terminal that started the service; there it reports
`session.execution.succeeded`, `failed` and `interrupted` (not `superseded`) as `Stop`,
`StopFailure` and `Interrupt`, and permission and form events as `PermissionRequest`.
OpenCode’s plugin sends `PreToolUse` from ordinary `tool.execute.before` calls; its question tool
continues to send `PermissionRequest`. When a root session goes idle after `session.error`, the plugin
sends `Interrupt` for `MessageAbortedError` and `StopFailure` with the error's message otherwise, in
place of `Stop`; idle straight after a `retry` status, which an abort during the retry wait leaves
without an error, also sends `Interrupt`. A later `busy` or `retry` status clears the error, since
the turn went on, and `ContextOverflowError` is ignored because OpenCode compacts and continues.
Synthetic message parts, which OpenCode writes itself, are not sent as prompts. Known subagent and older-turn lifecycle events are ignored.
OpenCode child (subagent) sessions report their tool activity under the root session and never send
`Stop`. An `idle` notification shows nothing: it only ends a turn whose `Stop` never came, and
after the same source's `Stop` it is ignored. A `Stop` whose `background_tasks` lists a running
`subagent`, or a running `shell` whose `command` does not look like a server, watcher or app
(judged from the first stage of the last command in an `&&`, `||` or `;` chain), is held: the
working indicator stays on and the turn completes on the next `Stop` without one, or after 30
minutes if none arrives. A manual `/compact` during the hold does not complete the turn. Claude's
`<task-notification>` and `<agent-message>` resume prompts start the working indicator but are not
recorded as user prompts.
Hooks lacking identity cannot provide complete stale-event protection. Legacy notifications without a hook event remain immediate.

Codex's default OSC title spinner provides a secondary completion signal for hook-identified
terminals: an observed working title must return to the same text without its spinner for two
seconds. New hooks or working titles cancel the pending fallback, and unknown titles do not imply
completion. After inferred completion, a matching late completion hook is acknowledged without
notifying again; renewed activity or a new prompt allows completion to notify again. Generic OSC
9/99/777 notifications continue to use the existing delayed fallback.

Any program can report its state in its own terminal with the Program Status Protocol
(`OSC 7501 ; state=idle|working|blocked|done|error : app=<name> [: kind=…] [: msg=<base64>] ST`,
and `state=clear` as it quits), as Codex 0.163, Claude Code 2.1.295 (`claude-code`), Antigravity
1.4 (`antigravity`), Grok Build (`grok-build`), Pi (`pi`), Mistral Vibe 3.0 and Devin do. Komla
answers the support query (`OSC 7501 ; ? ST`) that Claude Code, Antigravity and Pi send before they
report, except on Windows, where ConPTY carrying the answer is unverified. tmux forwards neither,
so SSH workspaces rely on hooks. While a terminal's program reports, the reports alone drive that
terminal's working indicator, done, `input-required` (with the decoded `msg`, such as Claude's
"approve Bash: npm install") and `error`; `idle` after `working` ends the turn quietly, as programs
report a cancelled turn. The `app` is the attention source, matching the agent's hook `--source`.
Reports with an `id` are records of the program's own, such as a Claude background subagent's, and
don't change the terminal's state. A later `done` with a `msg` fills in a done shown without one,
as Claude may send its summary a moment after its done. Hooks naming a reporting terminal, or naming
no terminal when the one terminal of their workspace where their agent reports is unambiguous, then
only name the workspace, dismiss the terminal's attention at a user prompt, and record replies;
another agent's hooks there, as Grok runs Claude Code's, say nothing else. A notice sent by hand
(no `--event`) shows as usual. A `StopFailure` turns the turn's end into an error, whether it ends
`done` or `idle`, unless the program works again first. OpenCode 2 ends every
turn `idle`, never `done`: when the program's own hooks reach Komla, an `idle` that ends a turn
stops the working indicator at once, and a `Stop` or `StopFailure` arriving before it or within
1.5 seconds after shows the done or the error; an `Interrupt`, or no hook, leaves it quiet. When the program's own hooks
reach Komla, its `done` waits up to 1.5 seconds for the `Stop`, whose reply becomes the done's
text and whose `background_tasks` hold the done as above until the program works and is done again,
or for 30 minutes. `komla notify` drops a hook Grok Build runs (`GROK_HOOK_EVENT` is set) for
another agent's `--source`, as Grok also runs the hooks Claude Code, Codex and Cursor read, and
likewise a hook Cursor (`CURSOR_VERSION` and `CURSOR_PROJECT_DIR`) or Devin (`DEVIN_PROJECT_DIR`)
runs, as both run Claude Code's. It also drops `--source claude-code` hooks from a Claude Code
background session (`CLAUDE_JOB_DIR`), whose daemon keeps the environment of the terminal that
started it, and from print and SDK mode (`CLAUDE_CODE_ENTRYPOINT` starting with `sdk`), such as a
`claude -p` another agent runs; `komla notify -- claude -p …` still reports such a run. Komla's
terminals don't inherit either variable from the process that started Komla.

Codex 0.161 and later run every session's hooks in one shared `codex app-server` process, with the
environment of the terminal that started it, so a Codex hook's `terminalId` and `workspaceId` may
belong to another session. Komla places a `--source codex` hook in the workspace matching its `cwd`,
and keeps its terminal only if that terminal belongs to the workspace. While Codex reports in a
workspace, the reports drive its terminals' working indicators, `input-required` and `error`, and
Codex's hooks no longer do. Codex reports `working` until its background terminals exit, then `done` (0.164) or `idle`, and
the terminal spins until then and shows a done, as Codex before 0.164 ends every turn `idle`. Codex
also reports `working` a moment as it starts, within a second of its first report, which shows
nothing unless a `UserPromptSubmit` arrives meanwhile, as when it starts with a prompt. A
`UserPromptSubmit` binds its session to the terminal there that reported `working` without a
session yet. A turn whose `PreToolUse` command looks like a server or watcher ends at its `Stop`
(done) or `Interrupt` (quiet), and so does every later turn of the session while the server keeps
Codex `working`. An `Interrupt`, a confirmed Esc, or an `idle` within 2 seconds of an Esc or
Ctrl-C ends a turn without a notification. Codex killed before it could report `clear` counts as
quit once Enter, Ctrl-C or Ctrl-D finds another foreground process in its local terminal. Hooks
still name the workspace and record replies, and when they arrive first, the `Stop`'s reply and the
command a `PermissionRequest` names become the text of the done and the input-required.

Remote delivery retains the latest prompt start separately from subsequent events and delivers the
start first, so coalescing during a disconnect does not lose turn identity. The companion opts into
`X-Komla-Hook-Pending: retry`: HTTP 202 means completion or a named permission request is still
settling or being persisted, not acknowledged. It retains that event for retry while allowing newer activity to replace it; HTTP 200
acknowledges durable acceptance. Clients without this header continue waiting for acceptance.

`komla notify [<title>] -- <command>` runs a command with the terminal's input and output and
reports it as the `command` source: `UserPromptSubmit` without a prompt when it starts, then `Stop`
titled Done, `StopFailure` titled Failed with the exit code, or `Interrupt` when it fails after
Ctrl-C. A title replaces Done and Failed. It passes SIGTERM and SIGHUP on to the command, exits with
the command's exit code, and the command still runs when Komla can't be reached. Komla treats the
`command` source as no agent: its turn end stops only its own spinner, it marks the terminal
`commandActive` while nothing else works there, and it runs no `agent.done` hooks or agent
telemetry.

## Confirmed settings

Agents should use `komla settings`; the CLI carries project context and keeps these resources
independent of the MCP enablement setting:

```text
komla settings get|apply actions --scope global
komla settings get|apply actions --scope current-project
komla settings get|apply workspace-setup
komla settings get|apply appearance
```

The former `/api/v1/settings/...` paths remain compatibility aliases.

`komla settings schema <resource>` (`GET /settings/<resource>/schema`) prints the fields a settings
file takes, with their limits, defaults and descriptions, rendered from the Zod schema Komla
validates it with; `--json` prints the JSON Schema. The descriptions live on the schemas as
`.meta({ description })`, so the agent guides keep only when and how to use a resource. Status bar
items add what their commands print. Quick Commands, Workspace Setup, automations and appearance
answer `SCHEMA_UNAVAILABLE` naming their guide, because Komla checks them beyond their HTTP
schemas.

The CLI resolves the scoped transport internally. Project Setup uses one environment-independent
workflow for local, SSH, and SSH Local-copy terminals; its destination values select where each
step runs.
Self-integration likewise uses one set of instructions, with a short section for SSH hosts. The
former SSH Project Setup and SSH Self-integration filenames alias to the common instructions for
compatibility.

No identity header or `cwd` is needed from a managed terminal. Unmanaged callers may use the
unscoped origin routes with `X-Komla-Terminal-Id`, or a URL-encoded `cwd` fallback. The SSH gateway
scopes workspace and remote-path identity to the forwarded host.
Apply commands remain open while Komla presents an in-app confirmation dialog. Komla activates the
app, restores and shows the resolved workspace window, and focuses it when dispatching that dialog.
The input is the complete desired state for that resource. JSON CLI output uses stable domain
results and errors rather than MCP response envelopes.

`plugins` lists the folders in `~/.komla/plugins/` with a `komla-plugin.json`, each with its
`state` (`on`, `off` or `changed`) and the status bar items and hooks it adds, and under `invalid`
the ones Komla can't read, with why, so each id is listed once. Apply takes
only the plugins to change, as `{"plugins": [{"id": "github-prs", "enabled": true}]}`, and the
confirmation lists every command a plugin turned on runs. An entry with a `manifest` writes it as
the plugin's `komla-plugin.json`, in a new folder `<id>` for a new plugin, so an agent on an SSH
host can make a plugin too; scripts a plugin ships still have to be copied to this computer. Turning one on records a digest of its
files, so a plugin whose files change shows as `changed` and stops until it is turned on again (ADR
0007). `komla settings schema plugins` also prints the manifest's fields.

Appearance covers the theme, a custom theme's colors, the accent color and the corner radius, and
it is the same in every project. GET responses include the read-only built-in `themes` and any
`problems` with the current custom theme; callers omit both from PUT bodies. Komla rejects
unreadable custom themes with `INVALID_APPEARANCE`, listing each problem in `details`. While the
confirmation is open, the window previews the proposed appearance without saving it until the
user applies it. With Match system appearance on, GET reports the theme showing, and PUT replaces
the light theme for a light theme and the dark theme otherwise; its result reports the theme it
replaced.

Workspace Setup GET responses include read-only `setupCapabilities`: the current execution
environment and SSH availability. Whether new workspaces start on an SSH host is marked separately
from SSH being merely configured. The SSH capability also reports whether project Terminal Commands run in the SSH Local
copy. Callers omit this metadata from PUT bodies.

## MCP

### HTTP setup

#### Claude Code

Add the MCP server via CLI:

```bash
claude mcp add --transport http --scope user komla http://localhost:52863/api/v1/mcp
```

The `--scope user` flag ensures the MCP server is available in all workspaces, not just the current directory.

Or manually add to `~/.claude.json`:

```json
{
  "mcpServers": {
    "komla": {
      "type": "http",
      "url": "http://localhost:52863/api/v1/mcp"
    }
  }
}
```

**Note:** Komla must be running for the MCP server to work.

#### Codex CLI

Add the MCP server via CLI:

```bash
codex mcp add komla --url http://localhost:52863/api/v1/mcp
```

Or manually add to `~/.codex/config.toml`:

```toml
[mcp_servers.komla]
url = "http://localhost:52863/api/v1/mcp"
```

#### Other MCP clients

If your client supports MCP over HTTP, use:

```text
http://localhost:52863/api/v1/mcp
```

Example generic JSON shape:

```json
{
  "mcpServers": {
    "komla": {
      "type": "http",
      "url": "http://localhost:52863/api/v1/mcp"
    }
  }
}
```

### Tools

#### `spawn_agent_in_new_workspace`

Spawn an AI coding agent in a new isolated Komla workspace. Branches from the project's configured base branch (e.g. main), or from the calling workspace's current branch with `fromCurrentBranch`. Only use when the user explicitly requests it.

| Parameter           | Required | Description                                                                              |
| ------------------- | -------- | ---------------------------------------------------------------------------------------- |
| `cwd`               | Yes      | Current working directory of the calling agent. Used to derive the project automatically |
| `name`              | No       | Workspace display name. Defaults to branch name                                          |
| `description`       | No       | One sentence summary of the work                                                         |
| `branchName`        | No       | Branch name for the worktree. Will be prefixed with project's default prefix if needed   |
| `initialPrompt`     | No       | Prompt to pass to the AI agent on startup                                                |
| `fromCurrentBranch` | No       | Branch from the calling workspace's current branch; uncommitted changes are not copied   |

**Example usage in Claude Code:**

> Create a Komla workspace for the "komla" project with branch "feature/new-feature"

#### `set_status_item`

Show a short status in Komla's status bar while the calling workspace is open, such as test results, a build or deploy state, or the pull request for the work. `komla status set <id> <text>` and `komla status clear [id]` are the CLI forms. Setting an id again replaces its item. Items live until Komla quits; a workspace shows at most 20.

| Parameter         | Required | Description                                                                               |
| ----------------- | -------- | ----------------------------------------------------------------------------------------- |
| `cwd`             | Yes      | Current working directory of the calling agent                                            |
| `id`              | Yes      | Up to 40 letters, digits, dots, dashes and underscores, such as `tests`                   |
| `text`            | No       | What the item shows, up to 60 characters. Omit it to clear the item                       |
| `tone`            | No       | `success`, `warning`, `error` or `info`, shown as a dot in the theme's color              |
| `tooltip`         | No       | Longer detail shown on hover, up to 500 characters                                        |
| `link`            | No       | HTTP(S) URL the item opens in the default browser when clicked                            |
| `popover`         | No       | A sandboxed HTML page shown in a popover on click; `link` then shows as a button below it |
| `popoverMarkdown` | No       | Plain Markdown in place of the page, for a line or two of text                            |

#### `spawn_agent_new_tab`

Spawn a new AI agent in a new tab within the current Komla workspace. Only use when the user explicitly requests it.

| Parameter | Required | Description                                    |
| --------- | -------- | ---------------------------------------------- |
| `cwd`     | Yes      | Current working directory of the calling agent |
| `prompt`  | No       | Prompt to pass to the new AI agent             |

#### `set_workspace_title`

Set or update the title for an existing Komla workspace by matching the agent's current working directory.

| Parameter | Required | Description                                                                          |
| --------- | -------- | ------------------------------------------------------------------------------------ |
| `cwd`     | Yes      | Agent current working directory (can be the workspace root or a nested subdirectory) |
| `title`   | Yes      | Concise workspace title to display in the Komla sidebar                              |

**Example usage in Claude Code:**

> Set workspace title to "Fix MCP title updates" for cwd `/Users/me/.komla/worktrees/komla/agent-mcp-title`

## Architecture

```
typed CLI ─┐
           ├─► Komla Operations ─► workspace, agent, preview, and settings services
MCP adapter┘
```

Electron owns context resolution, preset and mode selection, validation, authorization, workspace
lifecycle, persistence, and UI effects. The Rust executable parses commands, carries managed
terminal context, and renders results; it does not duplicate those business rules. MCP enablement
controls the MCP adapter only. Individual Agent Capability controls apply consistently to typed CLI
commands and their MCP equivalents.

The HTTP MCP server runs inline in Komla's HTTP server on port 52863 using Streamable HTTP. The
installed executable exposes the same adapter over stdio with `komla mcp`.

In a managed terminal on an SSH host, `komla title`, `snooze`, `wake`, `tag`, `untag` and `trash`
queue when Komla can't be reached, because it is away or a sandbox blocks the connection, and
answer `Komla couldn't be reached, so this waits on the host until it can.` (`{"queued":true}` with
`--json`). A command run while earlier ones still wait queues behind them, answering `Komla hasn't
received earlier commands from this host yet, so this waits behind them.`, except that while the
companion's desktop answers it first gives the companion up to 5 seconds to deliver them and the
hooks written before it, then goes to Komla directly. The CLI writes the request it would have sent, with the terminal's context and the time,
to `outbox/` beside the companion's hook inbox, readable only by the user. The companion posts the
outbox to `/api/v1/commands` in order once its desktop answers, interleaved with hooks in the order
both were written; on a tie the command goes first, and a command waits for older hooks for at
most 30 seconds of the desktop answering. It sends `X-Komla-Queued-Ms`, how long the
command waited by the host's clock, from which Komla counts a relative snooze by its own. Komla
runs each as any other operation. The companion drops a command Komla rejects, such as a snooze
that ran out. It retries a server error, backing off to a minute and giving up after ten tries,
and a 404, as for a workspace created on the host that Komla hasn't added yet, every 10 seconds
for a minute. A command the user turned off is refused instead of queued, with the `CAPABILITY_DISABLED`
message the desktop wrote to the companion's config as `turnedOffCommands`, which it rewrites when
the setting changes. See [ADR 0006](adr/0006-queue-agent-commands-on-the-ssh-host-while-komla-is-away.md).
`komla workspace list` on an SSH host that can't reach Komla lists the workspaces whose manifests
are on the host, newest first, without the tags, links, attention and agent state only the desktop knows,
and says so on stderr.

Komla's HTTP server listens on 127.0.0.1 only and answers only requests whose `Host` header is an
IP address or `localhost` or a `.localhost` name, on any port, since SSH tunnels arrive through
other ports. Others get 403, so
a web page that points its own domain at 127.0.0.1 (DNS rebinding), such as a site open in Komla's
browser, can't reach the API. Every route also refuses requests with an `Origin` header or a
`Sec-Fetch-Site` other than `none`, which browsers send for web pages and Komla's own clients and
agents' MCP clients don't, so pages reaching Komla through an SSH host's gateway, which rewrites
`Host`, are refused too. Browser-based MCP clients, such as the MCP Inspector, can't connect.

On SSH hosts, enabling MCP configures each agent to launch `<base path>/helpers/komla mcp` over
stdio rather than a tunnel URL, because agent configuration files are shared by every Komla
installation that uses the host. Inside a managed terminal the adapter re-reads the tmux session
environment before each request, so calls reach whichever desktop currently owns the terminal.
When no desktop can be reached, the adapter answers `initialize` and `tools/list` itself, offering
only `spawn_agent_in_new_workspace`, which creates the worktree on the host and starts the calling
workspace's agent in tmux, using the agent command saved in that workspace's manifest; the next
device to connect adds the workspace. Other tools report that Komla isn't connected. Requests go
back to Komla once a desktop reconnects; Komla's MCP endpoint is stateless, so no new handshake is
needed.

## Development

The adapters are implemented in `src/main/services/http-server.service.ts`; typed requests delegate
to `KomlaOperationService`. The MCP transport creates a stateless `McpServer` and
`StreamableHTTPServerTransport` per request, then delegates its tools to the same operation module.
