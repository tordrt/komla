# Customize Komla

Change Komla's own settings through the Komla CLI. It reaches the Komla app this terminal belongs
to, also from an SSH host or a VM. Komla shows each change and saves it only if the user applies
it. Settings → General → Settings history records every change except automations, so the user can
undo it there later; tell them that after you change something.

## Choose the route

- **Theme, accent color, corner radius, or a custom theme:** run `komla skill appearance` and
  follow it. To only answer a question about them, run `komla settings get appearance`.
- **Quick Commands or Workspace Setup:** run `komla skill project-setup` and follow it. To only
  answer a question about them, run `komla settings get actions --scope current-project` (or
  `--scope global`) or `komla settings get workspace-setup`.
- **Status bar items:** run `komla skill status-items` for their format and how to make them look
  good, with icons, colors and HTML popovers, then change them as described below. The resource is `status-items`. The same guide covers `komla status set`, for a
  status you show only while you work, which needs no settings change.
- **Automations, agents Komla starts with a prompt on a schedule:** run `komla skill automations`
  for their format, then change them as described below. The resource is `automations`.
- **Hooks that run a command when an agent finishes or needs input, or a script on a timer in the
  background, such as one that tags workspaces while their CI runs; keyboard shortcuts; or the
  terminal's font and cursor:** change them as described below. The resources are `hooks`,
  `shortcuts` and `terminal`.
- **An argument the agent needs each time Komla starts it, or the picker beside the agent in the new
  workspace dialog, such as its effort levels or a model picker in their place:** change them as
  described below. The resource is `agents`.
- **Anything else,** such as notifications, other agent settings or SSH hosts: point the user to
  Komla's Settings.

Change Komla's settings only through `komla settings`, which shows the user each change first. Leave
the files in `{{komlaDir}}/settings/` alone, even where you can reach them: a write there takes
effect unseen, and a folder by that name on an SSH host or in a VM can belong to another Komla.

## Change settings

1. Run `komla settings get <resource>` to read the current settings.
2. If the user hasn't said what they want, ask them, then end your turn and wait.
3. Write the settings to a JSON file. For `status-items` and `hooks`, that is the whole file:
   change only what the user asked for and keep every other item. For `shortcuts` and `terminal`,
   it is only the values to change; the rest stay as they are. For `automations`, it is every
   automation of the project to keep.
4. Run `komla settings apply <resource> --file <path>`. It waits while Komla shows the change,
   with every command an item or hook runs, and the user chooses Apply changes or Cancel.
5. Read the result:
   - `"status": "applied"`: the user applied the change.
   - `"status": "cancelled"`: the user cancelled it. Ask what to change.
   - `"status": "unchanged"`: the settings already matched.
   - Error `INVALID_SETTINGS`: fix each problem in `error.details` and apply again.
   - Error `STALE_VERSION`: the settings changed in the meantime. Get them again and redo your
     change.

If `komla settings get` returns a `problem`, Komla can't read the file; its `content` shows what it
holds. Apply corrected settings without the `problem` and `content` fields.

### hooks

Commands Komla runs when something happens in a workspace: in the workspace's folder, or on its SSH
host.

```json
{
  "_version": 1,
  "hooks": [
    {
      "id": "lint-after-turn",
      "event": "agent.done",
      "command": "if npm run lint --silent; then komla status set lint 'Lint passes' --tone success; else komla status set lint 'Lint fails' --tone error; fi",
      "timeoutSeconds": 120,
      "projects": ["my-project"]
    },
    {
      "id": "ci-tag",
      "event": "interval",
      "intervalSeconds": 120,
      "command": "sh ~/.config/komla/ci-tag.sh"
    }
  ]
}
```

The second hook runs this script, saved at `~/.config/komla/ci-tag.sh` (on the SSH host too, for
SSH workspaces), in each workspace every two minutes:

```sh
#!/bin/sh
# Tags the workspace "CI running" while its pull request's checks run, then says how they ended.
out=$(gh pr view --json state,reviewDecision,statusCheckRollup --jq '
  [.statusCheckRollup[]? | if .__typename == "StatusContext" then
      (if .state == "SUCCESS" then "pass" elif .state == "FAILURE" or .state == "ERROR" then "fail" else "pending" end)
    elif .status != "COMPLETED" then "pending"
    elif .conclusion == "SUCCESS" or .conclusion == "NEUTRAL" or .conclusion == "SKIPPED" then "pass"
    else "fail" end] as $checks
  | (if .state != "OPEN" or ($checks | length) == 0 then "none"
     elif $checks | any(. == "fail") then "fail"
     elif $checks | any(. == "pending") then "pending"
     else "pass" end) + " " + (.reviewDecision // "")' 2>&1)
case $out in
  *"no pull requests found"*) out=none ;;
esac
read -r ci review <<END
$out
END
case $ci in
  pending | pass | fail | none) ;;
  # gh couldn't say, such as offline: try again next time.
  *) exit 0 ;;
esac
state="${TMPDIR:-/tmp}/komla-ci-$KOMLA_WORKSPACE_ID"
last=$(cat "$state" 2>/dev/null)
# No open pull request with checks, such as one merged or a branch without one: its tag goes.
if [ "$ci" = none ]; then
  case $last in
    pending) komla untag "CI running" ;;
    fail) komla untag "CI failed" ;;
  esac
  rm -f "$state"
  exit 0
fi
[ "$ci" = "$last" ] && exit 0
echo "$ci" > "$state"
if [ "$ci" = pending ]; then
  komla tag "CI running" --spinner --tone info
  exit 0
fi
# Checks that ended before this script saw them run are no news.
[ "$last" = pending ] || exit 0
if [ "$ci" = fail ]; then
  komla tag "CI failed" --tone error --if "CI running"
  komla notify "CI failed" --badge CI --color error
  exit 0
fi
case $review in
  CHANGES_REQUESTED) komla tag "Needs changes" --if "CI running" ;;
  APPROVED) komla untag "CI running" ;;
  *) komla tag "In review" --if "CI running" ;;
esac
komla notify "CI passed" --badge CI --color success
```

While the pull request's checks run, the workspace is tagged "CI running" with a spinner. When they
pass, it gets its review tag back ("In review", or "Needs changes" after a reviewer asked for
changes; none once approved) and a "CI passed" notification. When one fails, it's tagged "CI
failed" and notified instead, so a workspace the user filtered out of the sidebar by hiding the "In
review" and "CI running" tags comes back until they deal with it. Once the branch has no open pull
request with checks, such as after a merge, its "CI running" or "CI failed" tag goes. While gh
can't answer, such as offline or logged out, the tag stays as it was. It keeps the last state in a
file, so it notifies once, not every two minutes; an interval hook should set what holds (a tag or
status item) and notify only on a change. A workspace has one tag, so "CI running" replaces the
user's while checks run. `--if 'CI running'` leaves a tag the user put on since alone. Leave Tag
from pull requests (Settings → Workspace tags) off with this hook: tags a script sets count as the
user's, so Komla's pull request tagging stops moving them.

- `id`: up to 40 letters, digits, dots, dashes and underscores; unique in the file.
- `event`: `agent.done` when an agent finishes its turn, `agent.needs-input` when it asks for
  permission or an answer, `agent.error` when it reports an error, `agent.prompt` when a prompt
  is sent to it, `workspace.created` once a new workspace's terminals have started and it has its
  name (its setup steps may still be running), `workspace.trashed` when a workspace moves to the
  Trash, or `interval` to run on a timer instead of on an event.
- `intervalSeconds`: for `interval` hooks only, how often they run, 10 to 86,400. Komla runs
  them when it starts, after hooks.json changes, then on each interval, a few at a time; a run
  still going isn't started again.
- `runOn`: `workspace`, the default, runs the command in the workspace's folder or on its SSH
  host; an `interval` hook then runs in every workspace outside the Trash. `local` runs it on this
  computer in the home folder: once per interval for an `interval` hook, which has no workspace,
  or for an event even while the workspace's SSH host is away. A script on this computer acts on
  any workspace with `komla workspace list --json` and `--workspace <id>`, such as
  `komla workspace tag "In review" --workspace "$id"` or
  `komla tag "CI running" --spinner --workspace "$id"`.
- `command`: runs in the user's shell, which also has the `komla` CLI, so a hook can run
  `komla status set`, `komla status refresh <id>` to update a status-items.json item, or
  `komla notify`, such as `komla notify "CI failed" --badge CI --icon ci.svg --color error`, or
  `komla tag`, which keeps a tag on the card until it's replaced or taken off, such as `komla tag
  "CI running" --spinner --tone info`: a tag Komla doesn't have yet joins the user's list with
  `--tone`, `--icon` and `--spinner` (`komla tag --help` lists its options). A hook's own
  notifications set off no hooks. Its output is discarded. It gets `KOMLA_EVENT` and
  `KOMLA_HOOK_ID`; when it runs for a workspace, also `KOMLA_WORKSPACE_ID`,
  `KOMLA_WORKSPACE_NAME`, `KOMLA_BRANCH`, `KOMLA_PROJECT`, and for agent
  events `KOMLA_TERMINAL_ID`, `KOMLA_AGENT` (such as `claude-code`) and `KOMLA_MESSAGE` (the agent's
  last answer, what it asks for, or the prompt, up to 4,000 characters), when Komla has them.
- `timeoutSeconds`: how long it may run, 1 to 3,600; 60 when left out. Past it, Komla stops the hook
  and everything it started.
- `projects`: project names or ids to run it in; leave it out to run it in every workspace.

At most 50 hooks. While a hook still runs for a terminal, that terminal's next event doesn't start
it again. When a hook fails in a workspace, or Komla can't read the file, Komla says why once,
until it succeeds there again. Run the command yourself first where it will run, with the variables it uses set, to check it.

### shortcuts

`{"shortcuts": {"<action>": "<keys>"}}`, such as `"workspace.new": "Cmd+N"`. `Cmd` means ⌘ on macOS
and Ctrl on Windows and Linux. `komla settings get shortcuts` lists every action with its keys. Avoid keys terminals
use, such as Ctrl+C, Ctrl+D, Ctrl+Z, Ctrl+L, Ctrl+R, Ctrl+A and Ctrl+E.

### agents

Agent presets: the commands Komla starts an agent with, and the picker beside the agent in the new
workspace dialog. `komla settings get agents` lists each preset's `id`, `name`, the `program` it
runs and its `levelPicker` with the names of its levels, not its commands or the levels' arguments.
Apply only the presets to change, each with its `id` and one or both of these:

- `addArguments`: arguments the agent needs each time it starts. Komla adds them right after the
  program in each command that runs it, and shows every command before and after.
- `levelPicker`: the picker's title, icon, visibility and levels.

  ```json
  {
    "presets": [
      {
        "id": "<id>",
        "levelPicker": {
          "title": "Model",
          "icon": "cpu",
          "levels": [
            { "name": "Sonnet", "arguments": "--model sonnet" },
            { "name": "Opus", "arguments": "--model opus" }
          ]
        }
      }
    ]
  }
  ```

  - `title`: up to 24 characters; `Effort` when left out.
  - `icon`: `gauge` (the default, which shows a meter of the picked level), `brain`, `lightbulb`,
    `lightning`, `sparkle`, `cpu`, `rocket`, `sliders`, `timer`, `atom`, `flask` or `fire`.
  - `hidden`: `true` hides the picker in the dialog and keeps its levels; new workspaces then start
    with Default, while existing ones keep their level. Left out, it stays as it is.
  - `levels`: the whole list, up to 12, lowest first; leave it out to keep the levels as they are.
    Each has a unique `name` (up to 40 characters) and the `arguments` Komla adds where launch mode
    arguments go when the user picks it. A level given by its current name alone keeps its
    arguments, so keep or reorder levels by name. The picker also offers Default, which adds
    nothing, and an empty list hides it. A level keeps the user's pick by its name, so rename one
    only when asked.

  The picker holds one list, so models in place of effort levels remove the effort levels: tell the
  user before you apply that.

Arguments and level arguments are only arguments: no `;`, `&`, `|`, `<`, `>`, backticks, `$(` or
`{{…}}` placeholders. Anything else about a preset, such as its commands, name or launch modes,
changes under Settings → Agents.

### terminal

The terminal's font, size, cursor and scrollback, such as `{"font": {"size": 14}}`.
`komla settings get terminal` shows every property.
Most terminal colors follow the theme, so change those through `komla skill appearance`.
