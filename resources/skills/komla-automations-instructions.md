# Komla Automations

An automation starts an agent with a fixed prompt on a schedule, each run in a new workspace of the
current project. Komla starts the runs without asking, and nobody answers the agent's questions, so
the prompt is the whole task. Change them with `komla settings apply automations`, following the
steps in `komla skill customize` or `komla skill project-setup`, which show the user each change
first.

`komla settings get automations` lists the project's automations, the `targets` they can run on
and the `agents` they can start. Apply `{"automations": [...]}` alone: every automation to keep,
with its `id`, and new ones without one. An automation left out is deleted.

Some ideas: every morning, fix what broke in the last CI run on main; every Monday, update
dependencies; every night, find flaky tests; every Friday, draft a changelog from the week's merged
pull requests.

A run has the `komla` CLI too, so it can hand work out: go through new GitHub issues, a customer
feedback inbox or an error tracker, and `komla launch` an agent in its own workspace for each item
worth fixing or looking into, tagged with where it came from, such as "Bug" or "Feedback". It
should skip items it launched before and launch only a few at a time.

```json
{
  "automations": [
    {
      "name": "Triage issues",
      "prompt": "Go through the GitHub issues opened in the last day. For up to 5 worth fixing or looking into, skipping any already in a workspace title from `komla workspace list --all --json`, run `komla launch --json --name \"<a few words> #<number>\" \"<prompt>\"` and tag the workspace it prints with `komla tag <tag> --workspace <id>`, reusing one from `komla tags`. Don't comment on GitHub.",
      "target": { "kind": "local" },
      "presetId": "<preset id>",
      "launchModeId": "<mode id>",
      "schedule": { "cron": "0 7 * * *" }
    }
  ]
}
```

- `prompt`: a prompt that changes code should commit on the run's branch and not push, unless the
  user asks for more.
- `target`: one from `targets`. `{"kind": "local"}` runs while Komla is open on this computer; an
  SSH host without a `problem` runs from its cron, also while this computer is off.
- `schedule`: a five-field `cron`, read in `timeZone`, such as `Europe/Oslo`, or this computer's.
- `presetId` and `launchModeId`: an agent's `id` and one of its `modes`, from `agents`. Nobody
  answers permission prompts during a run, so an agent that stops to ask waits until the user opens
  the workspace. A mode with `skipsPermissionPrompts` never stops but acts on its own; an auto
  mode asks rarely, and a sandboxed one can block the network a task needs. Unless the user named a mode,
  offer the choice, recommend skipping prompts for a task that changes files, and apply after they
  choose.
- `startBranch`: the branch runs start from, instead of the project's target branch; `""` goes back.
- `enabled` and `missedRunGraceMinutes`: whether it runs, and how late a run missed while Komla or
  the host was off may start (0, 30, 60, 180, 720 or 1440).

Settings history doesn't record automations. After a change, tell the user they can run, change or
delete them under Settings → Automations.
