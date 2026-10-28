# Komla Project Setup

Propose a compact Komla setup.

## 1. Inspect the project

Build a runnable component inventory:

- Read package-manager workspace declarations and build-system configuration.
- Search nested manifests even when they are not listed; include apps, services, workers, packages,
  and infrastructure, but exclude dependency, build, cache, and vendored directories.
- Inspect scripts, task runners, Compose files, and workflow docs.
- Check lockfiles, submodules, required ignored files, and re-creatable paths.
- Find environment templates such as `.env.example`, project-owned bootstrap commands, startup
  docs, and config validators. Classify required files as tracked, templated, or local/ignored.
  Do not read or print values from ignored or local environment files.

For each runnable component, record its path, purpose, prerequisites, commands, environment files,
and dependency root. A workspace install covers declared members; an independent lockfile needs its
own install. Prefer a root entrypoint, workspace command, then explicit directory change, yielding a
working-directory-safe command.

Build an internal shortcut inventory across all components: development, preview, workers, tests,
watchers, typechecking, linting, builds, diagnostics, maintenance, and generation. Exclude
duplicates, lifecycle hooks, destructive commands, and production-affecting commands.

Treat unsuffixed `dev` or `start` as canonical unless project docs say otherwise. Recommend distinct
common variants as separate manual Quick Commands.

Rank every secondary runnable component by day-to-day value, readiness, and port safety. Put up to
three useful services in one compact group of separate Quick Commands; account for peers under **Other
useful options** or **Also detected**.

Automatic web servers require checked-in dynamic-port behavior, collision fallback, or an explicit
port option. Prefer a worktree-safe project command or wrapper that discovers a free port;
port selection belongs to the project, not Komla. Do not recommend a port number. Otherwise keep it manual.

The inspection is done when every manifest you found is either a component with its path, purpose
and commands, or noted as not runnable, and every component's useful commands are in the shortcut
inventory.

## 2. Read Komla settings

Read the settings with Komla's CLI, which carries this terminal's workspace and project to Komla in
local and SSH terminals; reach Komla only through `komla` commands. When a sandbox blocks a
Komla command's network access, ask the user to approve a retry with network access. If it still
fails, give the user the exact entries to make in Komla's Settings instead.

Run the three reads in one tool call, as three plain commands that print their JSON:

```bash
komla settings get actions --scope global
komla settings get actions --scope current-project
komla settings get workspace-setup
```

An error prints as `Komla returned HTTP <status>: <body>`; its JSON body names the error's `code`.
Quote the body when you report it.

The Workspace Setup response is authoritative for project kind. `WORKSPACE_SETUP_UNSUPPORTED` means
a directory project: propose Quick Commands only. Preserve existing settings and avoid likely
duplicate Quick Commands.

Read `setupCapabilities`. Prioritize `currentEnvironment`, then the `selectedForNewWorkspaces`
environment. Treat a configured-only SSH environment as optional; mention
it only when the repository would benefit from it.
`ssh.actionsRunInLocalCopy` means Terminal Commands (Quick Commands with `type: "command"`) use the
desktop copy in SSH Workspaces. A Terminal Command's `sshExecutionLocation` (`remote` or `local-mirror`) overrides that for the one Quick Command.

## 3. Propose a compact recommendation

Keep repository evidence out of the reply.
Surface a fact only beside the decision it explains. Show
monorepo breadth through selected Quick Commands and **Other useful options**; account for any remaining
runnable service in one name-only **Also detected** line.

Under **Recommended setup**, use at most three evidence-backed groups.
Label each recommended item `Add`, `Update`, or `Remove`, and name every affected setup step or
Quick Command:

- **Install dependencies on creation and environment readiness.** Prefer a lockfile-native
  `workspace-creation` step and project-owned bootstrap. A checked-in template may use a creation
  step that never overwrites an existing file. When secrets or user-specific values are required, state the
  manual prerequisite instead. Do not put secret values in chat, commands, or settings. Pair it
  with a Trash cleanup that frees what setup re-creates, such as `rm -rf node_modules dist`; a
  failing cleanup keeps the workspace out of the Trash. Restoring doesn't reinstall, so tell the user.
- **Primary development command** as a manual Project Quick Command, using the canonical command.
- **Secondary development commands**: group selected services while creating separate manual Quick Commands.

Every recommended development Quick Command must be dependency-ready. Prefer `workspace-creation` setup
covering each dependency root; otherwise use project bootstrap or a conditional install guard.
Keep the Quick Command simple when setup covers its dependencies or it bootstraps itself. When
`ssh.actionsRunInLocalCopy` is true, add `ssh-local-copy` dependency setup for recommended Quick Commands
and retain remote dependency setup for agents running on the SSH host.

For directory projects, omit setup and cleanup. Preserve the current layout unless the user chooses
a workflow change.

Under **Other useful options**, show one to three unselected shortcuts: at least one secondary
component when present, plus a useful test, build, or quality command. Show exact commands, not the
full list; do not print the full component or shortcut inventory. Offer more choices only when the
user asks; show a small relevant subset. Add a line there for each of these that applies:

- **Background:** offer `"background": true` for a Terminal Command that runs for minutes, such as
  tests, a build or `gh pr checks --watch`: it runs without a tab and Komla notifies how it ended;
  `komla skill customize` shows tagging the workspace meanwhile. Servers and watchers stay in tabs.
- **Automations:** when the repository has a recurring chore, such as CI or dependency updates, name
  one automation, an agent Komla starts with a fixed prompt on a schedule, and its schedule.
- **Desktop apps on SSH hosts:** an optional extra for users who run apps on the SSH host. When SSH
  is configured or current and a component opens native windows (Electron, Tauri, Qt, GTK, Flutter
  desktop), a manual Quick Command `komla desktop run -- <command>` with
  `"sshExecutionLocation": "remote"` runs the app on a virtual desktop on the host (prerequisite, if
  missing: `sudo apt install -y tigervnc-standalone-server openbox novnc websockify`).
  Keep the plain development command as the recommendation; many users run apps locally through
  the Local copy instead.

Choose the recommended setup for its concrete benefit. Mention existing settings only when they
materially constrain a change. For Git projects, state once:
“New-workspace workflow is configurable: Komla can automatically start selected
services and arrange them in tabs, split panes, or background processes whenever a new workspace
is created.”

If a lightweight web server handles port conflicts or supports an explicit port option with a
verified worktree-safe wrapper, ask:

```text
❓ How should <server> fit into new workspaces?
Alternatives:
- Keep as a manual Quick Command — open only the agent; launch the server when needed.
- Start in a new tab — run <prerequisite && dev command> for each workspace.
- Start beside the agent — choose split right or split bottom.
- Customize the workflow — say what starts automatically and place each process in a new tab,
  split right, split bottom, or background.
Recommendation: <placement>, because <brief decision-relevant reason>.
```

Otherwise ask:

```text
❓ Would you like me to create this recommended minimal setup in Komla?
Alternatives:
- Proceed with this setup — create or update exactly the items above after Komla's confirmation.
- Modify the setup — name an item to add, remove, or edit.
- Add more shortcuts — show a short list of other relevant Quick Commands.
- Configure new-workspace workflow — choose services to start automatically and place each in a
  new tab, split right, split bottom, or background.
```

The final proceed question has no second Recommendation: **Recommended setup** already states it.
Ask one or two focused questions in a message; prefer one when the recommendation is already clear.
Resolve choices before asking the explicit proceed question. While waiting, end with the question;
the proposal is not “awaiting approval.” After the user proceeds, send the changes without another
chat confirmation.

## 4. Build complete desired state

`settings apply` replaces the whole resource: edit the `settings get` result.

Quick Commands:

- Submit only `{ "actions": [...] }`; omit response-only `scope` and `project`.
- Preserve remaining Quick Commands and their returned IDs. New Quick Command entries omit `id`, `projectCount`,
  and `projectIds`; Komla generates the Quick Command ID and infers the project association from the
  request context. Use this minimal entry shape:
  `{ "title": "Develop", "content": "npm run dev", "type": "command" }`.
- Round-trip `projectCount` only on existing project Quick Commands.
- Keep Multi-project Quick Commands and preserve valid preset, launch-mode, SSH execution location,
  and `background` fields.
- Use `type: "command"` for commands. Define each automatically started command once as a
  Project-scoped Quick Command.

Workspace Setup:

- Omit response-only `project` and `setupCapabilities`; send `setupSteps`, `agentPlacement`,
  `agentLayoutOrder`, and `trashCleanupScript`.
- Preserve existing step IDs; omit IDs on new steps.
- Give every new step `placement`, `destination`, and `trigger`. Use returned values for existing
  steps; common defaults are `background`, `workspace-repository`, and `workspace-creation`.
- Reference an automatic Quick Command's generated ID from its visible setup step.

Use `workspace-creation` for one-time preparation and `every-workspace-start` for terminal layout
or processes Komla should recreate on each start. Use `workspace-stop` for a `background` command
that ends what outlives the terminals, such as `docker compose down` after `docker compose up -d`.
It runs when a running workspace stops, including at quit, and cannot launch an agent.

Destinations are environment-aware. Prefer `workspace-repository`: it means the local worktree for
a local Workspace and the authoritative remote worktree for SSH. Use
`local-workspace-repository`, `ssh-workspace-repository`, or the disposable desktop
`ssh-local-copy` only for genuinely location-specific work. A destination selects the cwd and
machine; it does not transfer files. If an SSH workflow needs a desktop
file, ask for its exact desktop source path before creating a copy command; never infer the path or
expose secret values. Use `{{destinationPath}}` when a command needs its resolved working directory.

Workspace setup steps do not provide dependency ordering and separate parallel setup steps could
race. For automatic startup, use a project-provided bootstrap command or a single visible setup
command such as `npm install && npm run dev`; omit the redundant install step. Use this only when
the prerequisite is safe on every start. Otherwise keep installation on `workspace-creation` and
launch the server manually.

Submit Quick Commands before Workspace Setup when a setup step needs a generated Quick Command ID.

Automations: run `komla skill automations` for their format and how to pick the agent's mode,
then read them with `komla settings get automations`.

## 5. Apply after confirmation

Send the complete body to the matching CLI resource in a quoted heredoc, so the JSON reaches Komla
unchanged.

```bash
komla settings apply actions --scope current-project <<'JSON'
<complete JSON body>
JSON

komla settings apply workspace-setup <<'JSON'
<complete JSON body>
JSON
```

Run only the command for each resource being changed. Global Quick Commands use `--scope global`.

Say: “Creating this setup in Komla now. Komla should show a confirmation dialog in the target Komla
window before saving.” A pending `settings apply` proves only that confirmation has not resolved,
so say the dialog should appear, not that it did. If none appears, report a visibility failure and cancel the pending request
when possible. Wait without a short timeout.

Report `applied`, `unchanged`, or `cancelled`. On `STALE_VERSION` or `STALE_ACTION_METADATA`, the
settings changed in the meantime: get them again and ask before retrying. On another error, report
its code and message.

Finally recap only what was configured. `workspace-creation` steps affect new workspaces only.
