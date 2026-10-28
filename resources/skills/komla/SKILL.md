---
name: komla
description: Komla's `komla` CLI, for when the user asks Komla to start an agent in a new workspace or tab, preview a page, open a folder, or title, tag, snooze or trash this workspace, or to set up this project, run an agent on a schedule, run a script in the background or on a timer, show a status bar item or change Komla's settings.
---

# Use Komla

Komla terminals have `komla` on PATH and its absolute path in `KOMLA_CLI`; when `komla` isn't found,
run `"$KOMLA_CLI"` (PowerShell: `& $env:KOMLA_CLI`). When neither exists, this isn't a Komla
terminal: tell the user so. When a sandbox blocks a `komla` command's network access, ask the user
to approve running it again with network access.

```sh
komla launch "Fix the flaky login test"   # agent in a new isolated workspace; --here opens a tab instead
komla preview http://localhost:3000       # once the dev server responds
komla title "Login fix" --description "Fix the flaky login test"
komla snooze 2h                           # hides this workspace until then; komla wake ends it
komla snooze --until-notified             # until its next notification, such as your turn's end
komla tag "Waiting for review"            # says on its card what it waits on; komla untag takes it off
komla tags                                # lists the user's tags, to reuse one before making another
komla trash                               # moves this workspace to the Trash when your turn ends
komla open ~/notes                        # opens a folder on this computer in Komla; no agent
```

`komla --help` lists every command, option and guide, such as `--from-current-branch` to branch a
new workspace from this one. For anything else, print a guide with `komla skill <name>` and follow
it:

- `customize`: Komla's settings, such as Quick Commands, keyboard shortcuts, the theme, status
  bar items, agents Komla starts on a schedule, and hooks: scripts that run on agent events or on
  a timer in the background, such as one that tags workspaces "CI running" while their checks run.
- `project-setup`: Quick Commands and Workspace Setup for this project, including GUI apps shown
  from an SSH host.

Rules:

- Run each `komla` command for an effect the user asked for, and launch as many Komla agents as
  they ask for; your own subagents handle research and subtasks.
- Open a preview or a folder, tag, snooze or trash when the user says to, such as "show me the
  page in Komla", "tag this waiting for review once the PR is up" or "trash this when you're
  done"; run `komla trash` as your last step.
- Launch the default agent unless the user names another from `komla agent presets --json`.
  Report a new workspace as provisioning until the result says its agent started.
- Check each result before reporting success. Reach Komla only through `komla`; on an error,
  report it and stop. For a disabled capability, point the user to Settings → Integrations & MCP →
  MCP and CLI access.
