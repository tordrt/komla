# REVIEW.md

Which `/code-review` level a change gets in this repo, for `/ready`.

Review a branch at the highest level any of its changed files calls for. A file that no list or
rule below puts at another level gets `medium`.

## `high`, plus one `/security-review`

These paths are Komla's trust boundaries: auth, secrets, and the network and IPC surfaces where
input from another process, machine or web page arrives. Remote control is a remote shell, and the
local HTTP API and SSH hosts can start agents and run commands, so a mistake here hands someone a
terminal.

The lists can't name every such file, so a change elsewhere is `high` too when it opens a new
boundary, such as a new listener, route or IPC channel or a new place that stores or sends a
secret. It's also `high` when it changes how code builds a command from a branch name, path,
setting or other input, or runs a command on an SSH host, wherever that code is.

**Remote control and phone access** (read `remote-web/AGENTS.md` and
`docs/REMOTE_CONTROL_SECURITY.md`)

- `remote-web/web/`
- `packages/remote-protocol/src/`
- `src/main/services/remote-control-*`
- `src/main/services/remote-workspace-*`
- `src/main/services/remote-companion.service.ts`
- `src/main/services/paired-device-registry.service.ts`
- `src/main/lib/webauthn-verify*.ts`
- `src/main/lib/identity-crypto.ts`
- `src/main/lib/remote-session-resumption.ts`
- `src/main/lib/web-push.ts`
- `src/main/lib/tailscale-command.ts`

**Local HTTP API, MCP, the CLI and other local processes** (read `docs/CLI.md`)

- `src/main/services/http-server/`
- `src/main/services/http-server.service.ts`
- `src/main/lib/local-host-header.ts`
- `src/main/lib/komla-request-route.ts`
- `src/main/services/komla-operation/`
- `src/main/services/komla-operation.service.ts`
- `src/main/services/notification-delivery.service.ts`
- `src/main/services/notification-target-resolution.service.ts`
- `src/main/services/open-folder-request.ts`, and the `second-instance` and `open-file` handlers
  in `src/main/index.ts`, which take another process's arguments
- `src/main/services/settings-approval*.ts`
- `src/main/services/settings-management*.ts`
- `packages/sdk/src/`

**Renderer-to-main IPC**

- `src/preload/`
- `src/shared/ipc/`
- `src/main/ipc/`

**SSH hosts and the Remote Companion**

- `src/main/lib/ssh-*.ts`
- `src/main/services/ssh-*`, files and folders
- `src/main/services/workspace-git/ssh-*`
- `src/shared/lib/ssh-*`
- `src/main/services/managed-remote-terminal-lifecycle*`
- `src/main/services/git-host-keys.ts`
- `src/main/services/askpass*.ts`
- `native/src/`: the whole Remote Companion, which runs on SSH hosts, serves phone remote control,
  and creates workspaces and starts agents from queued requests while Komla is away

**Secrets and installation identity**

- `src/main/lib/secure-storage.ts`
- `src/main/services/utility-secret.service.ts`
- `src/main/services/install-identity.service.ts`
- `src/main/services/utility-inference.service.ts`, which sends the stored API key

**Web content and plugin code inside Komla**

- `src/main/services/window.service.ts`
- `src/main/services/page-link-guard.ts`
- `src/main/services/html-preview.service.ts`
- `src/main/services/dev-preview.service.ts`
- `src/main/services/sidebar-panel-page.ts`
- `src/main/services/status-popover-page.ts`
- `src/main/services/link-preview/`, which fetches outside URLs and refuses local and private
  addresses
- `src/main/services/sidebar-panel-operations.ts`
- `src/main/services/plugin*`
- `src/main/workers/plugin-host*.ts`

**Commands and paths built from settings or input**

- `src/shared/lib/shell-quote.ts`
- `src/shared/lib/template-vars.ts`
- `src/main/lib/workspace-launch-variables.ts`
- `src/main/lib/shell-command.ts`
- `src/main/lib/shell.ts`
- `src/main/lib/wsl.ts`
- `src/main/lib/powershell-native-arguments.ts`
- `src/main/ipc/validation/path-safety.ts`
- `src/main/services/execution-location/`
- `src/main/services/workspace-command.ts`
- `src/main/services/hooks.service.ts`
- `src/main/services/automation/`
- `src/main/services/automation.service.ts`

**Hooks and MCP config Komla writes into agents' settings**, which run on every agent event

- `src/main/services/claude-settings.service.ts`
- `src/main/services/codex-settings.service.ts`
- `src/main/services/opencode-settings.service.ts`
- `src/main/services/antigravity-settings.service.ts`
- `src/main/lib/codex-mcp-config.ts`
- `src/main/lib/komla-cli.ts`, which builds the hook commands and every workspace command's `PATH`
- `src/main/services/notify-script.ts`

**Updates, release and supply chain** (read `docs/RELEASING.md`)

- `src/main/services/update.service.ts`
- `.github/workflows/`
- `package-lock.json`, `.npmrc`, and the `package.json` at the root and in each workspace
- `native/Cargo.toml` and `native/Cargo.lock`
- `scripts/worktree-deps.cjs` and `scripts/install-git-hooks.cjs`, which run on `npm install`
- `scripts/git-hooks/`
- `electron-builder.yml`
- `build/`
- `scripts/release.sh`
- `scripts/windows-sign.cjs`
- `scripts/beforePack.cjs` and `scripts/afterPack.cjs`
- `scripts/generate-checksums.sh`
- `scripts/audit-shipped-deps.mjs`

## `low`

Prose that nothing runs and no agent follows as instructions:

- `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`, `TRADEMARK.md`
- `docs/FEATURES.md` and `docs/BRAND.md`
- `.github/pull_request_template.md`
- A change to code comments only, in a file that no `high` list names

The rest of `docs/` gets `medium`. `AGENTS.md` tells agents to read the ADRs, `docs/CLI.md`,
`docs/RELEASING.md` and the other guides before changing what they cover, this file points to
`docs/REMOTE_CONTROL_SECURITY.md`, and `docs/brand/` holds generated marks that a test checks
against the app icon. Agents also follow `AGENTS.md`, `CLAUDE.md`, `GLOSSARY.md`,
`REVIEW.md` and the skills in `resources/skills/` as instructions, and Komla installs those skills
into users' agents, so they get `medium` as well.
