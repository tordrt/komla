# Domain Glossary

## Workspace Lifecycle

**Trash**:
Where a workspace goes when the user is done with it: its terminals stop and it leaves the
workspace list, but restoring it brings it back with its agents resumed. After seven days it is
deleted for good, along with its branch unless that holds unpushed commits. Delete Permanently skips
the Trash.
_Avoid_: Archive

**Workspace Setup**:
A project's configuration for preparing and cleaning up its workspaces: Setup steps and Trash
cleanup.
_Avoid_: Project Setup

**Setup step**:
A command Workspace Setup launches when a workspace is created or every time it starts, in the
workspace or its Local copy, or a browser or blank note it opens in a pane beside them when the
workspace is created; after that the Saved layout opens them again. Steps run independently in the
background and never hold up the workspace or each other; list order is launch order, not
dependency order.

**Saved layout**:
A workspace's tabs as it last showed them while it had a browser or a note. When the workspace
starts again, each browser opens with the tabs it had and each note with its contents, in its place
beside the agent and the Setup steps' terminals that start again. Other terminals don't start again,
so their places go; a pane closed before the stop doesn't come back.

**Trash cleanup**:
A command that must succeed in the workspace before it moves to the Trash. Success then discards any
Local copy; failure leaves both the workspace and Local copy intact.

## Workspace Files

**Imported files**:
Files Komla copied into a workspace's `.komla-files/` folder because they were dropped or pasted
into a terminal or attached to a new workspace's prompt. Git ignores them, so they aren't project
content: the file panel lists them in a section of their own, not in the file tree.
_Avoid_: Attachments, which a Terminal Attachment already names

**Prompt draft**:
A floating window for writing a prompt while looking at files, to copy into an agent, with `@`
references to the file on screen. There's one per window, kept in memory until copied over or
Komla quits, and it floats over Quick Look and the file viewer too. A note is the lasting kind:
a file Komla keeps for the workspace outside the repository, which a draft can be saved as.
_Avoid_: Scratchpad, prompt composer

## Terminals

**Terminal replacement**:
Starting something new in an existing terminal pane: an agent, a Quick Command, a Local copy shell,
or a retry of its remote execution. The pane keeps its identity. The user confirms first when it
would interrupt an agent that is still working, or a reconnect or start that hasn't finished.
Reconnecting is not a replacement; it attaches to the same execution.
_Avoid_: Pane restart, terminal restart

**Managed Remote Terminal Session**:
The tmux session on an SSH host that runs a remote terminal and keeps it running while Komla is
disconnected. Komla's connection to it is a Terminal Attachment: a remote terminal may have none
while its session continues, and each Komla installation has its own.
_Avoid_: Remote agent session

**Local copy**:
A disposable, writable copy used to run a remote workspace's application on the local computer. It
syncs one way from the remote when Komla detects source changes; the remote remains authoritative
for source and Git, while ignored dependencies, secrets, caches, and other runtime state may remain
local. Moving its remote workspace to the Trash discards it; Komla recreates it on demand.
_Avoid_: Local mirror, local checkout, local workspace. Saved data keeps the old name:
`local-mirror`, `local-mirror-actions`, `capabilities.localMirror`, `.komla-local-mirror` and the
`mirrors` folder.

**Execution location**:
Where a terminal or Setup step runs: the workspace itself (on the host or an SSH host) or, for an
SSH workspace, its Local copy. Only execution on an SSH host can continue as a Managed Remote
Terminal Session.
_Avoid_: backend, which is where the workspace itself lives (`workspace.backend`)

## SSH Workspace Sync

**Komla installation**:
One Komla desktop install with its own settings and workspace list. A computer may run more than
one, such as a development build beside a release, and several may share an SSH host.
_Avoid_: device (outside user-facing copy), client, machine

**SSH Workspace Sync**:
Keeping an SSH host's workspaces consistent across the Komla installations that use the host: which
workspaces exist, their names, their agent tabs and their status. It is on by default for each SSH
host.
_Avoid_: Cross-device sync

**Workspace manifest**:
The description of one SSH workspace that a Komla installation publishes on its host, from which
other installations adopt the workspace and merge its changes. A manifest read from a host is
untrusted.

**Project manifest**:
A project's icon, color, Workspace Setup, Quick Commands and branch and merge settings, which a Komla
installation publishes on each SSH host where the project has workspaces, part by part, without
undoing what another installation changed there since. Another installation copies them when the
user picks them, adding the project if it lacks one for the repository; for a project it keeps in
sync, it offers them as they change. It takes a new icon or color unasked, and anything else only
once the user approves the changes. A manifest read from a host is untrusted: anything that can
write files there could have written it.

**Adoption**:
Adding to a Komla installation an SSH workspace that another installation, or an agent on the host,
published there. The workspace and its terminals keep their ids, so reconnecting attaches to the
same Managed Remote Terminal Sessions.
_Avoid_: Import, discovery

**Workspace missing from its host**:
An SSH workspace whose files are gone from its host without a tombstone from a deleting
installation. Komla keeps it but does not reconnect or restart it; the user removes it, or it
recovers when its files return.

**Disconnected SSH host**:
An SSH host the user disconnected from, so this Komla installation sends it nothing until they
connect again, across restarts: its terminals detach, leaving their Managed Remote Terminal
Sessions running, its tunnels and connections close, and neither SSH Workspace Sync nor the Remote
Companion reaches it. Its workspaces stay, showing Stale Workspace Status.
_Avoid_: Offline host, paused host

## Quick Commands

**Quick Command**:
A reusable launcher, global or scoped to projects: a Saved Prompt starts an AI coding agent with a
prompt, and a Terminal Command runs a shell command in a terminal. Code, `actions.json`, and
`komla settings actions` call these Actions (prompt and terminal actions, action launch); user-facing
copy says Quick Command, Saved Prompt, and Terminal Command.

## Customization

**Sidebar Panel**:
A tab in a workspace's sidebar beside Diff and Files, whose page comes from a command Komla runs
while the panel is open, or is a page of its own that gets data from its command or its plugin's
code. Users and agents define panels in `sidebar-panels.json`, in the format of
status bar items, and their pages and buttons work as a status item's popover does. Code and
`komla settings` call the file and resource `sidebar-panels`.
_Avoid_: Custom pane, sidebar pane (a pane is a split inside a tab), sidebar tab

## Plugins

**Plugin**:
A folder in `~/.komla/plugins/` whose `komla-plugin.json` names it and lists its Contributions, so
an integration installs, updates and turns off as one. Komla runs it only while it is turned on and
its files are as they were when the user turned it on.
_Avoid_: Extension, add-on

**Contribution**:
One status bar item, Sidebar Panel or hook a Plugin adds, in the format of the user's own
`status-items.json`, `sidebar-panels.json` or `hooks.json`, with the id `<plugin>.<id>`.

**Plugin copy**:
Komla's copy on an SSH host of the files of a Plugin that runs, which its commands there get as
`KOMLA_PLUGIN_DIR`. Each Komla installation keeps its own, one for each revision of the files.
_Avoid_: Plugin deployment, plugin mirror; a Local copy goes the other way, from a host to here

**Plugin Host**:
The process of its own in which Komla runs a Plugin's code, its `main`, while the plugin is on, and
calls `activate(komla)` with a Komla SDK client that also follows Komla Events, runs commands in a
workspace and feeds the plugin's Sidebar Panels.
_Avoid_: Extension host, plugin runtime

**Komla Event**:
Something that happened in a workspace, such as `agent.done` or `branch.changed`, which status
items and Sidebar Panels refresh on with `refreshOn`, and panel pages and plugin code follow with
`komla.on`. The events hooks run on are Komla Events too.
_Avoid_: Hook event, for those that aren't hooks'

**Plugin Setting**:
A value a Plugin's `komla-plugin.json` declares and the user fills in in Settings → Plugins, or in
the plugin's own page, which its code saves, such as a repository or, as a secret, an API token.
Its code reads and sets them with `komla.settings` and its commands get them as
`KOMLA_SETTING_<ID>`; agents never read or set a secret.
_Avoid_: Plugin config, plugin preferences

**Panel Badge**:
A short mark on a Sidebar Panel's tab, such as a count, which its page or its plugin's code sets.

## Workspace Status

Say which of these you mean rather than "git status":

- **Working Tree Snapshot**: the uncommitted changes relative to `HEAD`, last observed. It feeds the
  change pills on a workspace card.
- **Branch Comparison**: the differences between a workspace branch and another branch or their
  merge base, including committed changes.
- **Branch Status**: ahead and behind counts of a workspace branch against its target branch and its
  upstream.

**Stale Workspace Status**:
Status Komla can no longer confirm is current. It may stay visible, but must look different from
confirmed status.

**Attention**:
What Komla shows about the agent in one terminal: whether it is working, and the attention it raised
that the user hasn't resolved (needs input, error, done). It is current state derived from agent
hooks, terminal titles and alerts, and the terminal's execution, not a notification history, and it
is per Komla installation. A done or notice the user saw on screen without focusing its terminal is
seen: it stays only on that terminal's pane. A workspace shows the highest-ranked attention among
its terminals that isn't seen, the latest among equals.
_Avoid_: Notification state, hook history

## Komla Executable Roles

**Komla Remote Companion**:
Komla's executable running as a user process on an SSH host, deployed automatically. While an SSH
workspace outside the Trash has a Managed Remote Terminal Session, the companion relays its status
and agent-hook notifications, so Komla keeps it current even off screen, and says when another
installation changes the host's workspaces or sessions, so SSH Workspace Sync seldom asks. It is
best-effort: desktop refresh recovers anything it misses, and it does not interpret Attention.
_Avoid_: Remote agent, daemon, sidecar

**SSH Exec Channel**:
A role of the Komla executable that Komla starts over its own SSH session to run the shell commands
it composes on that host, without an ssh exec per command. It lives only as long as that session
and owns no operations; every command still works without it.
_Avoid_: Companion RPC, exec server

**Komla Operation**:
A typed request and result owned by the Electron main process for an agent-facing Komla action or
query. The CLI, MCP and the Komla SDK are adapters over Komla Operations; no adapter owns
workspace, selection, authorization, persistence, or UI rules.
_Avoid_: MCP operation, CLI endpoint

**Komla SDK**:
The `@komla/sdk` TypeScript client for Komla Operations, whose types are rendered from their
schemas. One client runs over different transports: Komla's local HTTP server for scripts and
hooks, the Plugin Host's port for plugin code, and `komla` in a panel's page. A client declares
the capabilities it uses and refuses operations that need any other, so code that shows outside
text can't launch an agent.
_Avoid_: Plugin API, which names only one of its consumers
