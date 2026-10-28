# Komla Onboarding Demo

Give a live tour of the Komla CLI, the `komla` command every Komla terminal has, locally and on SSH
hosts alike. Fetching this instruction file through `komla skill` is bootstrapping, not
part of the demonstration.

The tour shows the CLI from two sides. First, as an agent uses it from its own workspace: it names
the workspace, reports progress in the status bar, hands a task to a new workspace and starts a dev
server for the user to find. Then, as a script or hook uses it from outside: it plays a CI job that
tags, snoozes and wakes that new workspace. It ends with one-liners for both.
Before starting, explain what will be created and ask for an affirmative response. Before each
step's first command, tell the user in one or two sentences what is about to happen and where in
Komla to look. After every operation, inspect the result; describe visible effects only after
success. On failure, report the error and stop. Never construct manual HTTP requests.

## 1. Name the workspace and show progress

Run `komla context --json` and `komla agent presets --json`. Confirm that the context identifies the
current workspace and that an active, launchable preset exists. Then run:

<!-- prettier-ignore -->
```sh
komla title "Welcome to Komla" --description "Komla CLI demo"
komla status set tour "Komla tour 1/4" --tone info --popover-file - <<'EOF'
<style>
  .head { display: flex; align-items: center; gap: 8px; }
  .head b { flex: 1; font-size: 13px; }
  .muted { color: var(--muted-foreground); }
  .pill { padding: 1px 8px; border-radius: 999px; font-size: 11px; font-weight: 500; color: var(--info); background: color-mix(in oklch, var(--info) 15%, transparent); }
  .bar { display: flex; gap: 3px; margin: 10px 0 8px; }
  .bar > span { flex: 1; height: 4px; border-radius: 2px; background: var(--muted); }
  .bar > .done { background: var(--success); }
  .bar > .now { background: var(--info); }
  .row { display: flex; gap: 8px; align-items: center; padding: 5px 0; border-top: 1px solid var(--border); }
  .row .icon { width: 16px; font-size: 14px; text-align: center; }
  .done .icon { color: var(--success); }
  .now .icon { color: var(--info); }
  .now .name { font-weight: 600; }
  .next { color: var(--muted-foreground); }
  .note { margin: 8px 0 0; font-size: 11px; }
  code { white-space: nowrap; }
</style>
<div class="head"><b>Komla CLI demo</b><span class="pill">Step 1 of 4</span></div>
<div class="bar"><span class="now"></span><span></span><span></span><span></span></div>
<div class="row now"><span class="icon">&#xf192;</span><span class="name">Name the workspace and show progress</span></div>
<div class="row next"><span class="icon">&#xf10c;</span><span class="name">Hand a task to a new workspace</span></div>
<div class="row next"><span class="icon">&#xf10c;</span><span class="name">Find a dev server with the globe button</span></div>
<div class="row next"><span class="icon">&#xf10c;</span><span class="name">Drive another workspace from a script</span></div>
<p class="note muted">Set with <code>komla status set</code>, an HTML page in Komla's theme colors. Setting the same id again updates it; <code>komla status clear</code> removes it.</p>
EOF
```

Point out the changed title in the sidebar and the item in the status bar, whose popover opens on a
click. Explain that agents use the same `komla` command for everything in this tour, with no setup,
and that `komla --help` lists every command.

At the start of each later step, set the item again the same way, with the step's number in the
text and the pill, the bar and rows before it marked `done` with the `&#xf058;` icon, and its own
marked `now`.

## 2. Hand a task to a new workspace

Explain that the new workspace appears in the sidebar. Git-backed projects get a separate branch
and working directory; directory-backed projects share the project directory.

Call `komla launch --json` with this prompt as the positional argument, `--name "Demo Workspace"`,
`--description "Workspace created by the Komla onboarding demo"` and `--branch komla-demo`. If
Komla refuses because the branch is already open in another workspace, such as one from an earlier
tour, run it again with `komla-demo-2`, then `komla-demo-3`. Record the new workspace's id from the
result.

> Say a friendly hello. Explain that another agent started you with the `komla launch` command, in a new Komla workspace with its own branch and folder, to show how agents can hand work to each other. Make no file changes, then stop.

Confirm the result. If provisioning is still running, say the workspace is visible and the agent
will start when ready. When the result names a `branch`, say the workspace has that branch to
itself, with Komla's branch prefix if the user set one; a directory-backed project has none.
Explain that without `--branch`, Komla names the branch from the prompt while it sets up the
workspace, so the launch result can't name it yet.
Mention that `--preset` picks another agent CLI from step 1, `--from-current-branch` builds on this
workspace's branch, and `--here` opens the agent in a tab beside this one instead. Also mention that
`--mode` picks a launch mode, and that agents may start a mode that skips permission prompts, such
as `--dangerously-skip-permissions` or `--yolo`, only on an SSH host the user marked isolated,
unless the user allows it with that mode's robot button in **Settings → Agents**.

Ask the user to open the Demo Workspace once its agent has said hello, read the greeting, then come
back to this tour workspace and ask to continue. Mention **⌘↓ / ⌘↑** on macOS or **Ctrl+↓ / Ctrl+↑**
on Windows and Linux for switching workspaces. Opening it also clears its Done badge, which would
otherwise cover what step 4 shows on its card. End the turn.

## 3. Find a dev server with the globe button

Explain that the agent will start a small dev server for the user to find and open themselves. Use a
newly created, uniquely named temporary directory for it. Record its exact path; never overwrite an
existing project file or assume the current workspace is disposable.

Write a self-contained `index.html` there: a Welcome to Komla heading, one sentence saying the user
found this page through the globe button, and a link to the CLI docs at https://komla.dev/komla-cli.
In its head, give it the title Welcome to Komla, `og:title` Welcome to Komla, `og:site_name` Komla
tour, an `og:description` of one sentence saying an agent started this server for the Komla tour,
`og:image` `preview.svg` and a `<link rel="icon" href="icon.svg">`. Write `icon.svg`, a simple
rounded square with a K, and `preview.svg`, 1200 by 630: a dark gradient with Welcome to Komla in
large type and Komla tour · dev server preview under it. Also write `ci-run.html`, the pretend CI
run page step 4 links to: a "CI run #128 · Komla tour" heading, a line saying a pretend CI script
made it, and the checks lint, unit, e2e and build, each passed with a duration. Keep both pages
small, styled inline, and readable in light and dark mode.

Start an environment-appropriate local HTTP server serving only that directory, bound to loopback on
an available port. Record how to stop that specific server and confirm that it responds. Then print
its root URL and the docs URL, https://komla.dev/komla-cli, each on its own line.

Don't open the page yourself. Ask the user to click the globe button at the top right of the window:
it lists the servers running in this workspace and the links its terminals print, so both appear
there. A click opens one in the default browser; Shift+click opens it in Komla's browser preview.
Ask them to rest the pointer on the server's row first: Komla shows a preview card with the page's
image, title and description, read from its Open Graph tags, and the row shows its icon and title,
as for any dev server or link, so a project's own tags show there too. On an SSH host, the card
leaves out the image. Mention that clicking the URL right in this terminal opens it too: where
**Settings → Terminal → Open links in** says, which is the default browser on a new install, and
Shift+click the other way. When the terminal runs on an SSH host, Komla forwards the port to this
computer by itself either way. Explain that an agent opens a page there itself with
`komla preview <url>`, or with no URL, a dev server it finds running in this workspace. Keep the
server running until the tour ends. End the turn and wait for the user to ask to continue. If the
user doesn't find the server under the globe button, open it yourself as the one exception: run
`komla preview <root URL>`, point out Komla's browser preview, end the turn and wait again. If that
fails too, report the error and go on to step 4, which doesn't need it.

## 4. Drive another workspace from a script

This step is the heart of the tour: take it slowly and make sure the user knows why it matters.
Before any command, explain that the commands it shows are how custom integrations extend Komla: a
CI watcher, a deploy script, a pull request bot or a hook Komla runs on a timer can put their own
tags, notifications and messages on a workspace's card, and rich status bar items of their own in
its status bar. With many agents working in parallel, the sidebar then says at a glance which
workspaces wait on what, without opening each one. Any script reaches any workspace:
`komla workspace list --json` finds it, and `--workspace <id>` points `tag`, `snooze`, `notify`,
`status set` and the other workspace commands at it.

Say the agent now plays a CI script for the Demo Workspace in three stages, pausing after each so
the user can watch the sidebar. Ask them to keep an eye on the Demo Workspace's card.

Run `komla workspace list --json` and find the Demo Workspace by its id. If it isn't listed, say so
and go to the wrap-up. Its agent must be finished before the snooze in stage 2, since that agent's
turn ending would wake it at once, and Komla refuses to snooze a workspace whose agent waits for
input or failed. If its `agentActive` is true, or its `attention` is `input-required` or `error`,
explain this, ask the user to let that agent finish or answer it, and end the turn; check again when
they continue. Any other `attention`, such as `turn-complete` for a Done the user hasn't seen, is a
badge that would cover the tag: ask them to open the Demo Workspace once and come back, end the
turn, and check again.

### Stage 1: CI starts

Run, with its id:

```sh
komla tag "CI running" --spinner --tone info --tooltip "Komla tour: a pretend CI run" --workspace <id> --json
```

Then give the Demo Workspace a status bar item with the details the card has no room for: a page
of the checks, and a button to the CI run page. Write this page to `ci-popover.html` in step 3's
temporary directory, or in a new uniquely named one if step 3 made none:

<!-- prettier-ignore -->
```html
<style>
  .head { display: flex; align-items: center; gap: 8px; }
  .head .title { flex: 1; min-width: 0; }
  .head b { display: block; font-size: 13px; }
  .muted { color: var(--muted-foreground); }
  .pill { padding: 1px 8px; border-radius: 999px; font-size: 11px; font-weight: 500; }
  .pill.info { color: var(--info); background: color-mix(in oklch, var(--info) 15%, transparent); }
  .pill.success { color: var(--success); background: color-mix(in oklch, var(--success) 15%, transparent); }
  .bar { display: flex; gap: 3px; margin: 10px 0 8px; }
  .bar > span { flex: 1; height: 4px; border-radius: 2px; background: var(--muted); }
  .bar > .done { background: var(--success); }
  .bar > .running { background: linear-gradient(90deg, var(--info) 40%, var(--muted) 40%); }
  .row { display: flex; gap: 8px; align-items: center; padding: 5px 0; border-top: 1px solid var(--border); }
  .row .icon { width: 16px; font-size: 14px; text-align: center; }
  .row .name { flex: 1; }
  .pass { color: var(--success); }
  .run { color: var(--info); display: inline-block; animation: spin 1.2s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .note { margin: 8px 0 0; font-size: 11px; }
</style>
<div class="head">
  <div class="title"><b>CI run #128</b><span class="muted">komla-demo · pushed 3m ago</span></div>
  <span class="pill info">Running</span>
</div>
<div class="bar"><span class="done"></span><span class="done"></span><span class="running"></span><span></span></div>
<div class="row"><span class="icon pass">&#xf058;</span><span class="name">lint</span><span class="muted">41s</span></div>
<div class="row"><span class="icon pass">&#xf058;</span><span class="name">unit</span><span class="muted">2m 10s</span></div>
<div class="row"><span class="icon run">&#xf110;</span><span class="name">e2e</span><span class="muted">running</span></div>
<div class="row"><span class="icon muted">&#xf017;</span><span class="name">build</span><span class="muted">queued</span></div>
<p class="note muted">Komla tour: set by a pretend CI script.</p>
```

Run, with its id and that file's path, adding `--link <root URL>/ci-run.html` when step 3's server
runs on this computer rather than on an SSH host:

```sh
komla status set ci --segments '[{"text":"\uf110","color":"info"},{"text":" CI 2/4"}]' --popover-file <path> --workspace <id>
```

Point out the CI running tag on the Demo Workspace's card, and the tooltip on hover. Then ask the
user to open the Demo Workspace and click the CI item in its status bar, which shows while that
workspace is open: the popover shows the checks so far, and, when it has a link, its button opens
the pretend CI run page. Explain that the page is plain HTML and CSS in Komla's theme colors, such
as `var(--success)`, shown in a sandbox: it loads nothing from the web, and its links open on a
click. Ask them to come back to this tab afterwards. If Komla refuses the item, report it, leave out
the parts about it and carry on without it. When the result says `added` is true, the tag is new to
the user's list and spins. Otherwise the user already had it: run `komla tags --json` and describe
its look from there. If it's `hidden`, the card moved to the Filtered shelf: ask the user to open
that shelf to see it, and in stage 2 say the card moves from there. If Komla refuses the tag because
the user's list is full, relay its hint and carry on without the tag, leaving it out of stage 2.
Explain that a tag stays until it's taken off, so it suits states that last, such as CI running,
Deploying or Waiting for review, and that a workspace has one tag at a time. End the turn and wait
for the user to ask to continue.

### Stage 2: snooze until CI ends

Before running anything, tell the user to watch the Demo Workspace leave the list for the Snoozed
shelf at the bottom of the sidebar. Then run:

```sh
komla snooze 1h --until-notified --workspace <id>
```

Point out the Snoozed shelf and ask the user to open it: the card is there, its tag still on it.
Explain that a workspace waiting on something out of the user's hands gets out of the way and comes
back at its next notification, in an hour at the latest, or sooner if an agent there needs input;
`komla wake --workspace <id>` brings it back without a notification.
Mention that an agent does the same for its own workspace without `--workspace`, such as
`komla tag "Waiting for review"` and `komla snooze --until-notified` after opening a pull request.
End the turn and wait for the user to ask to finish the CI run.

### Stage 3: CI passes

Before running anything, tell the user to watch the Demo Workspace come back into the list. Then
run:

```sh
komla untag "CI running" --workspace <id>
komla notify "CI passed" --body "Komla tour: all checks passed" --color success --workspace <id>
```

If the stage 1 item was set, rewrite `ci-popover.html` for a passed run and set the item again with
the same command, `--link` included, but with
`'[{"text":"\uf058","color":"success"},{"text":" CI 4/4"}]'` as its segments. In the page, the pill
becomes `<span class="pill success">Passed</span>`, every bar segment and check is done, e2e took
5m 02s and build 1m 15s with the passed icon, and the subtitle reads `komla-demo · 9m 08s in all`.

Point out that the Demo Workspace is back in the list with a CI passed badge: the notification woke
it. Explain that `untag` with a name takes off only that tag, so a slow script
leaves alone a tag the user put on since, and that `tag --if "CI running"` replaces one the same
way. Explain how the pieces split the work: the tag and the badge say at a glance where CI stands,
from the sidebar, and the status bar item keeps the details and the way to the CI run page, setting
the same id again as each check finishes.

Ask the user to open the Demo Workspace again and click its CI item: the same item now shows the
passed run, as a script sets it again with what changed. An item an agent or script sets lasts until
Komla quits. For one Komla keeps, backed by a command that asks the CI service on an interval, with
buttons that run commands such as rerunning failed jobs, the user approves it in
`status-items.json`; `komla skill status-items` shows how. Then ask the user to come back to this
tab and ask to continue. End the turn.

## Wrap up

Recap the visible effects. Run `komla status clear tour`. If step 4 found the Demo Workspace, run
`komla untag "CI running" --workspace <id>` and `komla wake --workspace <id> --json`, which change
nothing when there's nothing to undo; when the result says `woke` is true, say the Demo Workspace
came back marked Woke. If `komla status set ci` succeeded, run
`komla status clear ci --workspace <id>`. If a cleanup command fails, report it and carry on with
the rest of the cleanup. Stop the specific demo server and remove only the temporary directories
created in steps 3 and 4. Preserve the user's original workspace and project files.

Then list what else the CLI does, one line each with its command, without running them. For agents
in their own workspace:

- `komla trash` as an agent's last step moves its workspace to the Trash once its turn ends.
- `komla tags` lists the user's tags, so an agent reuses one before making another.
- `komla desktop run -- <app>` runs a GUI app from an SSH host or a machine without a display on a
  virtual desktop, which opens from the globe button.

For scripts, hooks and integrations:

- `komla notify -- npm test` runs a slow command, shows its tab as working, and notifies Done or
  Failed when it ends; it also works in Quick Commands.
- `--json`, which `komla --help` lists for each command that takes it, gives output a script can
  parse.
- `komla skill customize` sets up hooks that run a script when an agent finishes or needs input, or
  on a timer, such as one that tags workspaces while their CI runs; it also covers automations that
  start an agent on a schedule, keyboard shortcuts and status bar items that run a command.
- `komla skill project-setup` sets up Quick Commands for the dev server, tests and builds, and
  Workspace Setup that installs dependencies in each new workspace.
- `komla settings get` and `komla settings apply` read and change those settings; Komla shows each
  change and saves it only if the user applies it.

Explain that the Komla skill tells agents what the `komla` command can do; one switch in
**Settings → Integrations & MCP** adds it for every agent. Invite the user to start a real task, or
to ask an agent in Komla to set up this project or hand a task to another agent in its own
workspace.

End by showing the user how to remove the tour's two workspaces, the Demo Workspace and this one:

- **Move to Trash:** right-click a workspace's card and choose **Move to Trash**, or open it and
  press **⌘⇧⌫** on macOS or **Ctrl+Shift+Delete** on Windows and Linux. Its terminals stop, and
  the Trash shelf at the bottom of the sidebar keeps it for 7 days, so **Restore Workspace** in its
  right-click menu brings it back.
- **Delete Permanently…:** in the same right-click menu, on a card in the list or in the Trash,
  removes it at once; **Empty Trash** on the open Trash shelf removes everything there.
- Suggest removing the Demo Workspace first and this one last, since moving this one to the Trash
  stops this agent.

When stage 1's tag was `added`, say that CI running joined the user's tags and that the agent can't
remove a tag from the list: they can keep it for a real CI hook, or delete it with the delete button
beside it in **Settings → General → Workspace tags**. Stop there.
