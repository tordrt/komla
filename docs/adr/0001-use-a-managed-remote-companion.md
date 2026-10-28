# Use a managed Remote Companion for SSH workspace observation

Komla will replace the long-lived SSH status and notification shell helpers with a minimal Rust
executable that it installs on the desktop and automatically deploys and version-manages on SSH
hosts without root access. An internal, desktop-owned role runs one ephemeral Remote Companion per SSH host to
observe workspaces with managed tmux sessions,
produce best-effort working-tree snapshots and forward agent-hook notifications
through Komla's existing host-scoped reverse SSH tunnel. Terminal launch and tmux control,
interactive Git and file operations, workspace provisioning, and MCP remain desktop-owned so the
companion does not become a general remote RPC service. The same executable exposes the Komla CLI
for agents: it discovers managed terminal context and adapts typed commands to desktop-owned Komla
Operations. Its `mcp` command is a separate stdio MCP adapter over those operations, not the
implementation of ordinary CLI commands. Business rules, confirmation, capability policy, and UI
effects remain in the desktop rather than being duplicated in Rust.

The companion remains alive while managed tmux sessions it owns exist, even when the desktop or
reverse tunnel disconnects, and while its desktop answers through the reverse tunnel. It retains only the latest snapshot for each workspace and retries that value;
newer snapshots replace older undelivered ones. Companion processes and mailboxes are namespaced per
Komla installation. Native filesystem events are the normal change signal. If watching or delivery
fails, Komla recovers through a fresh snapshot on connection, focus, agent completion, a known Git
operation, or manual refresh. The companion is an accelerator rather than a correctness dependency.

Agent hooks use one Pending Terminal Hook mailbox file per terminal; a newer offline hook supersedes
an older unacknowledged hook for that terminal. The hook goes to the mailbox of the installation
attached to the terminal. Every hook is also copied to the mailbox of every other installation
whose companion refreshed its receiving marker recently, which it does only while its desktop
answers, so those installations show alerts and the agent working too. No hook reports an agent
interrupted by a keystroke or a session stopped or replaced, so the installation that did it relays
an interrupt to the others through its companion over SSH. The others also stop the spinner when
the terminal's session is gone, after a long stretch without hooks, and on waking or reconnecting,
since copies aren't written while an installation is away. The attached installation alone names the workspace. The companion normalizes provider event names into
the existing hook transport shape, but Komla main owns and durably persists Remote Attention State
and all notification precedence and consumption semantics. A hidden tmux session keeps the
companion alive while managed terminal sessions remain and the mailbox file makes hook ingestion
atomic across a brief process replacement. Version one does not add a separate crash supervisor;
Komla recreates the process and obtains fresh Git state on its next connection. The companion is
therefore long-lived when useful but is not a permanent login or boot daemon.

The first companion release supports Linux and macOS SSH hosts on x86-64 and ARM64; native Windows
SSH hosts remain outside Komla's POSIX and tmux remote boundary. A working tmux installation is a
host setup requirement, giving remote terminals and the companion one persistent lifecycle model.
Invalid hooks are discarded, while a transient Komla failure leaves the terminal's one pending hook
available for retry.

The companion communicates with Komla using request-response HTTP through the host-scoped reverse
SSH tunnel. Any successful response accepts the posted value; the protocol has no heartbeat,
reconciliation cursor, source authority, or snapshot history. Komla marks retained status stale when
the SSH lifecycle ends and accepts either the next watcher snapshot or an explicit refresh as the
new current value.

The desktop keeps observation ordering, revisions, and freshness in memory. Its only restart cache
is each SSH workspace's `lastKnownGitStatus` in `workspaces.json`, written through the existing
coalesced workspace save; there is no separate observation file or durable snapshot queue. On
startup Komla projects that cached value as stale until it can be confirmed. The first successful
data tunnel in a host's monitored lifecycle triggers one best-effort background refresh for every
Monitored SSH Workspace on that host, with overlapping tunnel attempts coalesced.
