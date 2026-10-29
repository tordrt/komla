# Domain Glossary

## Workspace Lifecycle

**Trash**:
Where a workspace goes when the user is done with it: its terminals stop and it leaves the
workspace list, but restoring it brings it back with its agents resumed. After seven days it is
deleted for good, along with its branch unless that holds unpushed commits. Delete Permanently skips
the Trash.
_Avoid_: Archive

**Workspace Setup**:
A project's configuration for preparing and cleaning up its workspaces: Setup steps, Stop steps,
and Trash cleanup.
_Avoid_: Project Setup

**Setup step**:
A command Workspace Setup launches when a workspace is created or every time it starts, in the
workspace or its Local copy. Steps run independently in the background and never hold up the
workspace or each other; list order is launch order, not dependency order.

**Stop step**:
A Setup step that runs in the background once a workspace's terminals stop, to end what outlives
them, such as containers started with `docker compose up -d`. Stopping, moving to the Trash and
deleting a running workspace all run it, and so does quitting Komla for a local workspace; starting
or deleting the workspace waits for it. It never launches an agent.
_Avoid_: Teardown script

**Trash cleanup**:
A command that must succeed in the workspace before it moves to the Trash. Success then discards any
Local copy; failure leaves both the workspace and Local copy intact.

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
_Avoid_: Local mirror, local checkout, local workspace

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
installation publishes on each SSH host where the project has workspaces. Another installation
copies them only when the user picks them, adding the project if it lacks one for the repository;
it never merges them on its own. A manifest read from a host is untrusted.

**Adoption**:
Adding to a Komla installation an SSH workspace that another installation, or an agent on the host,
published there. The workspace and its terminals keep their ids, so reconnecting attaches to the
same Managed Remote Terminal Sessions.
_Avoid_: Import, discovery

**Workspace missing from its host**:
An SSH workspace whose files are gone from its host without a tombstone from a deleting
installation. Komla keeps it but does not reconnect or restart it; the user removes it, or it
recovers when its files return.

## Quick Commands

**Quick Command**:
A reusable launcher, global or scoped to projects: a Saved Prompt starts an AI coding agent with a
prompt, and a Terminal Command runs a shell command in a terminal. Code, `actions.json`, and
`komla settings actions` call these Actions (prompt and terminal actions, action launch); user-facing
copy says Quick Command, Saved Prompt, and Terminal Command.

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
and agent-hook notifications, so Komla keeps it current even off screen. It is best-effort: desktop
refresh recovers anything it misses, and it does not interpret Attention.
_Avoid_: Remote agent, daemon, sidecar

**SSH Exec Channel**:
A role of the Komla executable that Komla starts over its own SSH session to run the shell commands
it composes on that host, without an ssh exec per command. It lives only as long as that session
and owns no operations; every command still works without it.
_Avoid_: Companion RPC, exec server

**Komla Operation**:
A typed request and result owned by the Electron main process for an agent-facing Komla action or
query. The CLI and MCP are adapters over Komla Operations; neither adapter owns workspace,
selection, authorization, persistence, or UI rules.
_Avoid_: MCP operation, CLI endpoint
