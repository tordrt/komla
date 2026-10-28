# Komla Automations

Reference for the `automations` settings resource. Change it with
`komla settings apply automations`, following the steps in `komla skill customize` or
`komla skill project-setup`, which show the user each change first.

An automation starts an agent with a fixed prompt on a schedule, each run in a new workspace of the
current project. Komla starts the runs without asking again, and nobody answers the agent's
questions. `komla settings get automations` lists the project's automations, the `targets` they
can run on and the `agents` they can start. Apply `{"automations": [...]}` alone, without `project`,
`targets` and `agents`: every automation to keep with its `id`, and new ones without one. An
automation left out is deleted.

```json
{
  "automations": [
    {
      "name": "Fix CI",
      "prompt": "Check the latest CI run on main. If it failed, fix the cause and commit on this branch. Don't push.",
      "target": { "kind": "local" },
      "presetId": "<preset id>",
      "launchModeId": "<mode id>",
      "schedule": { "cron": "0 8 * * 1-5" }
    }
  ]
}
```

- `prompt`: the whole task, since the agent works alone. A prompt that changes code should commit
  on the run's branch and not push, unless the user asks for more.
- `target`: one from `targets`. `{"kind": "local"}` runs while Komla is open on this computer. An
  SSH host without a `problem` runs from the host's cron, also while this computer is off, so
  prefer one when the user has it.
- `schedule`: `cron` is five fields, such as `0 8 * * 1-5` for weekdays at 8:00, read in
  `timeZone`, an IANA name such as `Europe/Oslo`; this computer's when left out.
- `presetId` and `launchModeId`: an agent's `id` and one of its `modes`' `id`, from `agents`; a mode
  needs its agent. Nobody answers permission prompts during a run, so an agent that stops to ask
  waits until the user opens the workspace. A mode with `skipsPermissionPrompts`, such as Claude
  Code's Dangerously skip permissions or Codex's YOLO, never stops to ask but acts on its own;
  Claude Code's Auto and Codex's Workspace auto ask rarely. Unless the user named a mode, offer
  these two kinds, recommend the skipping one for a task that changes files, and apply after they
  choose. Without a mode, the agent asks as it does by default; a plan or read-only mode suits only
  a task that reports without changing files. A sandboxed mode, such as Codex's Workspace auto, can
  block the network a task needs, such as `gh` checking CI.
- `startBranch`: the branch each run starts from, such as `release/1.x`. Without it, runs start
  from the project's target branch, and follow it when it changes. `""` goes back to that. Diffs and
  PRs compare with the project's target branch, or with `startBranch` when the project has none.
- `enabled`: `false` keeps it without running it; `true` when left out.
- `missedRunGraceMinutes`: how late a run missed while Komla or the host was off may still start:
  0, 30, 60, 180, 720 (the default) or 1440.

These defaults are for new automations; an existing one keeps its value for a field left out.

Settings history doesn't record automations. After a change, tell the user they can run, change or
delete them under Settings → Automations.
