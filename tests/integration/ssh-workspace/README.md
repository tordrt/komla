# SSH remote-workspace integration tests

This suite builds a cached `debian:13-slim` test image and starts a fresh
Docker container as an ordinary SSH host. Komla connects to its real OpenSSH
server through a random loopback port.

## What it covers

- Host capability detection and remote helper installation.
- Bare-repository cloning and remote Git worktree creation.
- Idempotent workspace preparation.
- Managed and persistent tmux terminals.
- Local and reverse SSH port forwarding.
- `komla desktop run`: GUI apps on virtual desktops of their own, each desktop's request to show
  itself through the tunnel, noVNC reaching the VNC server through the preview forward, the VNC
  port forward a VNC app such as Screen Sharing uses, and the desktop stopping with its terminal.
- Terminal, workspace, and SSH-host identity delivery through the host-scoped tunnel.
- Remote notification-helper and workspace-status delivery through the host-scoped tunnel.
- Remote Companion install onto a content-addressed helper path.
- Companion tmux session, initial snapshot, and working-tree change delivery through the tunnel.
- Companion hook mailbox forwarding.
- Unchanged retained status becomes current after desktop observation restarts and reconnects,
  while the remote companion process survives.
- Native CLI target merges update pushed ahead counts, including repeated already-up-to-date merges.
- Additional real tmux panes and workspaces reuse the data tunnel without triggering recovery scans.
- Closed failure when the companion artifact is missing.
- Local-mirror synchronization through rsync.
- Workspace Setup uploads from a shell-sensitive local project path into the real remote worktree.
- Successful visible Workspace Setup commands remain interactive in their remote terminal.
- Remote Git status, restore, discard, push, and deletion operations.
- Absolute and shell-sensitive configured base paths.
- Canonical-path safety checks.

`docker exec` is used only to seed the Git origin and inspect the test host.
All Komla operations use ordinary `ssh` and `rsync` with the generated
unprivileged test-user key.

## Running

Docker Engine on Linux or Docker Desktop on macOS must be installed and
running. Docker Compose is not required.

```bash
npm run test:integration
```

Build the companion artifact for the container's Linux architecture before running the suite
(`npm run build:native` on a matching Linux host). The reconnect regressions use
the production observation and status services with real SSH snapshot commands; Electron UI
and persistence side effects are stubbed, so they do not launch or restart the desktop app itself.

The image is rebuilt on every invocation so Docker notices fixture changes,
but unchanged layers remain cached. Each run removes its disposable container
and temporary SSH keys afterward.
