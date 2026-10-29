---
name: komla
description: Komla's `komla` CLI for day-to-day work, for when the user asks Komla to start an agent in a new workspace or tab, preview a page or open a folder, or to title, tag, snooze, link or trash this workspace, and for work that shows better in Komla, such as a preview of a dev server the agent started. Also points to the guide for setting up this project in Komla or changing its settings, such as Quick Commands, hooks, status bar items, the theme or agents it runs on a schedule. Not for the project's own setup, scripts or schedules outside Komla.
---

# Use Komla

Komla terminals have `komla` on PATH and its absolute path in `KOMLA_CLI`; when `komla` isn't found,
run `"$KOMLA_CLI"` (PowerShell: `& $env:KOMLA_CLI`). When neither exists, this isn't a Komla
terminal: tell the user so. When a sandbox blocks a `komla` command's network access, ask the user
to approve running it again with network access.

```sh
komla launch "Fix the flaky login test"   # an agent in a new isolated workspace; --here opens a tab
komla preview http://localhost:3000       # once the dev server responds
komla tags                                # the user's tags, to reuse one before making another
komla tag "Blocked"                       # says on its card what it waits on; komla untag takes it off
komla snooze 2h                           # hides this workspace until then; komla wake ends it
komla snooze --until-notified             # until its next notification, such as your turn's end
komla workspace list --json               # every workspace's id, branch and tag, dont do unless user wants this
komla trash                               # moves this workspace to the Trash when your turn ends
komla workspace link <id>                 # links another workspace, by its id, under linked-workspaces/
komla open ~/notes                        # opens a folder on this computer in Komla; no agent
komla title "Login fix" --description "Fix the flaky login test"
komla desktop run -- <app command>        # on an SSH host, shows the app on a virtual desktop
```

`komla <command> --help` shows a command's options and examples, such as `--from-current-branch`
for `komla launch`, which branches a new workspace from this one; `komla --help` lists every
command.

Rules:

- Keep tags to a word or two, since a card has little room, and reuse one `komla tags` lists, such
  as "Blocked", before you make one.
- Komla already notifies the user about your turns. `komla notify` is for the Quick Commands,
  hooks and status bar items the guides set up, or if you want to add some custom notification to a process you run for them.
- A `linked-workspaces/` folder in the workspace holds other workspaces linked to it, such as the
  repository an API lives in; read and edit them there when a task spans them. Link or unlink one
  with `komla workspace link` or `unlink` when the user asks to work across workspaces.
- Run `komla desktop run` only when the user asks to see a GUI app, such as an Electron app, that
  runs on a Komla SSH host. Elsewhere the app opens as usual and needs no `komla`.

## Settings and project setup

To set up this project in Komla or change its settings, first run `komla skill <guide>` and follow
it:
- `customize`: hooks, keyboard shortcuts, the terminal, agent presets, and which guide covers
  anything else.
- `project-setup`: Setup helpful quick Commands and Workspace Setup for this project.
- `status-items`: custom status bar items.
- `automations`: agents Komla starts on a schedule.
- `appearance`: custom theming and accent color.

