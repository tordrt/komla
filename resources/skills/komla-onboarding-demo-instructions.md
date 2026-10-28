# Komla Onboarding Demo

Give a live tour of the Komla CLI, the `komla` command every Komla terminal has, locally and on SSH
hosts alike. Fetching this instruction file through `komla skill` is bootstrapping, not
part of the demonstration.

The tour shows a workspace title, a parallel workspace, a browser preview, a status bar item and a
sibling tab, then names what else the CLI can do.
Before starting, explain what will be created and ask for an affirmative response. Before each
step's first command, tell the user in one or two sentences what is about to happen and where in
Komla to look. After every operation, inspect the result; describe visible effects only after
success. On failure, report the error and stop. Never construct manual HTTP requests.

## 1. Connect and name the workspace

Run `komla context --json` and `komla agent presets --json`. Confirm that the context identifies the
current workspace and that an active, launchable preset exists. Then run:

```sh
komla title "Welcome to Komla" --description "Komla CLI demo"
```

Point out the changed title in the sidebar. Explain that agents use the same `komla` command for
everything in this tour, with no setup, and that `komla --help` lists every command. If a capability
is disabled, name it and direct the user to **Settings → Integrations & MCP → MCP and CLI access**
rather than changing settings yourself.

## 2. Launch an agent in a new workspace

Explain that the new workspace appears in the sidebar. Git-backed projects get a separate branch
and working directory; directory-backed projects share the project directory.

Call `komla launch` with this prompt as the positional argument, `--name "Demo Workspace"` and
`--description "Workspace created by the Komla onboarding demo"`. Let Komla choose a branch.

> Say a friendly hello. Explain that another agent started you with the `komla launch` command, in a new Komla workspace with its own branch and folder, to show how agents can hand work to each other. Make no file changes, then stop.

Confirm the result. If provisioning is still running, say the workspace is visible and the agent
will start when ready. Describe branch isolation only when the result establishes it. Ask the user
to stay in the original tour workspace for now. Mention **⌘↓ / ⌘↑** on macOS or
**Ctrl+↓ / Ctrl+↑** on Windows and Linux for switching workspaces. Mention that `--preset` picks
another agent CLI from step 1 and `--from-current-branch` builds on this workspace's branch.

## 3. Open a browser preview

Explain that the agent will create a small welcome page and show it beside the terminal.
Use a newly created, uniquely named temporary directory for the demo page. Record its exact path;
never overwrite an existing project file or assume the current workspace is disposable.

Write a self-contained `index.html` in that directory: a Welcome to Komla heading, then these short
sections.

- **The `komla` command:** agents use it to start other agents, open previews like this page, show
  status bar items and name workspaces. It also carries Komla's built-in skills, guides an agent
  loads with `komla skill` to set up a project or customize Komla, and reads and changes Komla's
  settings with `komla settings`.
- **Make Komla yours:** requests the user can give any agent in Komla, which handles them with
  those skills; write each as a quoted one-liner:
  "Set up this project in Komla" (Quick Commands for the dev server, tests and builds, and
  Workspace Setup that installs dependencies in each new workspace); "Add a status bar item that
  shows whether CI passes"; "Run a script when an agent finishes or needs input"; "Add a shortcut
  for creating a workspace". Say that Komla shows every change and saves it only when the user
  applies it.
- **Find it again:** the globe button at the top right of the window lists this workspace's running
  servers and the links its terminals printed. A click opens one in the default browser;
  Shift+click opens it in Komla.
- A link to the CLI docs at https://komla.dev/komla-cli.

Start an environment-appropriate local HTTP server serving only that directory, bound to loopback on
an available port. Record how to stop that specific server and confirm that it responds.

Run `komla preview <root URL>`. After success, point out the browser pane. Explain that without a
URL, `komla preview` opens a dev server it finds running in this workspace's terminals. Keep the
server running until the tour ends.

Then print the docs URL, https://komla.dev/komla-cli, on its own line, and ask the user to click
the globe button at the top right of the window: it lists the demo server and that docs link,
because Komla collects the servers and links its terminals print. End the turn and wait for the user
to ask to continue.

## 4. Show a status bar item

Explain that agents can show progress, test results or a pull request in Komla's status bar. Run:

```sh
komla status set demo "Komla tour" --tone info --popover "**Komla tour**: shown with \`komla status set\`. Run it again with the same id to update it, or \`komla status clear\` to remove it."
```

Point out the item in the status bar and that clicking it opens the popover. It shows while this
workspace is open; keep it until the tour ends.

## 5. Launch a sibling agent tab

Explain that this creates a separate agent process in the same workspace and directory. Call
`komla launch --here` with this positional prompt:

> Say a friendly hello, explain that this is another agent tab in the same workspace, sharing its files with the tour tab, and ask the user to close this tab and return to the original tour tab to continue. Make no file changes.

After success, the new tab becomes active. End the turn and wait for the user to return and ask to
continue.

## Wrap up

Recap the visible effects. Run `komla status clear demo`, stop the specific demo server and remove
only the temporary directory created in step 3. Explain that the sibling tab can be closed and the
extra Demo Workspace can be deleted. Preserve the user's original workspace and project files.

Then explain that the CLI also carries Komla's built-in skills, guides that let any agent set up
a project and customize Komla, one line each with its command, without running them:

- `komla skill project-setup` sets up this project: Quick Commands for the dev server, tests and
  builds, and Workspace Setup that installs dependencies in each new workspace.
- `komla skill customize` customizes Komla: automations that start an agent with a fixed prompt on
  a schedule, such as checking CI every weekday morning; keyboard shortcuts; hooks that run a
  script when an agent finishes or needs input, or on a timer, such as one that tags workspaces
  while their CI runs; and status bar items that run a command.
- `komla settings get` and `komla settings apply` read and change those settings, plus terminal
  and agent settings; Komla shows each change and saves it only if the user applies it.

Then show what else the CLI does, the same way:

- `komla notify -- npm test` runs a slow command, shows its tab as working, and notifies Done or
  Failed when it ends; it also works in Quick Commands.
- `komla snooze 2h` hides this workspace until then, or until an agent there needs input;
  `komla wake` brings it back.
- `komla desktop run -- <app>` runs a GUI app from an SSH host or a machine without a display on a
  virtual desktop, which opens from the globe button in a VNC app or the browser preview.

Explain that the Komla skill tells agents what the `komla` command can do; one switch in
**Settings → Integrations & MCP** adds it for every agent, and it loads the other guides through
`komla skill`. Invite the user to start a real task, or
to ask an agent in Komla to set up this project or hand a task to another agent in its own
workspace. Stop there.
