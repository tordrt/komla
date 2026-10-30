# Customize Komla

Change Komla's settings through the `komla` CLI, from this computer, an SSH host or a VM. Komla
shows each change and saves it only if the user applies it. Settings → General → Settings history
records every change except automations and plugins, so the user can undo it there later; tell them
that after you change something.

## What goes where

| The user wants                                       | Read                        | Resource                         |
| ---------------------------------------------------- | --------------------------- | -------------------------------- |
| A theme, accent color or corner radius               | `komla skill appearance`    | `appearance`                     |
| Quick Commands or Workspace Setup                    | `komla skill project-setup` | `actions`, `workspace-setup`     |
| A custom status bar item                             | `komla skill status-items`  | `status-items`                   |
| An agent Komla starts with a prompt on a schedule    | `komla skill automations`   | `automations`                    |
| A hook, a shortcut, or the terminal's font or cursor | this guide                  | `hooks`, `shortcuts`, `terminal` |
| An agent preset's arguments or level picker          | this guide                  | `agents`                         |
| Status items and hooks to share or turn off as one   | this guide                  | `plugins`                        |

For anything else, such as notification settings or SSH hosts, point the user to Komla's Settings.

Change settings only through `komla settings`. Leave the files in `{{komlaDir}}/settings/` alone,
even where you can reach them: a write there takes effect unseen, and a folder by that name on an
SSH host or in a VM can belong to another Komla.

## Change settings

1. `komla settings get <resource>` reads the current settings. For `status-items`, `hooks`,
   `plugins`, `shortcuts`, `terminal` and `agents`, `komla settings schema <resource>` lists every
   field.
   When `get` returns a `problem` for `status-items` or `hooks`, Komla can't read that file, and
   `content` shows what it holds: apply corrected settings without `problem` and `content`.
2. If the user hasn't said what they want, ask them and wait.
3. Write the settings to a JSON file: the whole file for `status-items` and `hooks`, keeping the
   entries the user didn't ask to change; only what changes for `shortcuts`, `terminal` and
   `agents`. Try any command the settings run yourself first, where it will run.
4. `komla settings apply <resource> --file <path>` waits while the user applies or cancels the
   change. Its result says `applied`, `cancelled` or `unchanged`. On `INVALID_SETTINGS`, fix what
   `error.details` names; on `STALE_VERSION`, get the settings again and redo the change.

## Tags, notifications and status items

Quick Commands, hooks and status bar items run where the `komla` CLI is, so they can tell the user
what they see: `komla tag` for a state that holds, such as a spinner while tests run; `komla
notify` for news once, such as a run that ended; `komla status set` for a value to keep in view.

A workspace has one tag, and its card has room for a word or two. Keep tags and notification
titles short, reuse the tags `komla tags` lists, and notify only when something changes.
`komla notify -- <command>` says Done or Failed by itself, and a background Quick Command notifies
without it. Their `--help` shows icons, tones and spinners. A Quick Command that runs the tests:

```sh
komla tag "Testing" --spinner --tone info; if komla notify -- npm run test:e2e; then komla untag "Testing"; else komla tag "Failing" --tone error --if "Testing"; fi
```

## Hooks

A hook runs a command when an agent finishes, needs input or fails, when a prompt is sent to it,
when a workspace is created or moved to the Trash, or on a timer. Some ideas: lint after each turn
and show the result in the status bar; play a sound on this computer when an agent needs input
(`"runOn": "local"`); tag each workspace while its pull request's checks run, and notify how they
ended.

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
    }
  ]
}
```

An `interval` hook runs again and again, so keep its last state in a file and notify only when it
changes. Tags a hook sets count as the user's, so Komla's Tag from pull requests stops moving them.

## Plugins

A plugin is a folder in `{{komlaDir}}/plugins/` whose `komla-plugin.json` bundles status bar items
and hooks, in the formats `status-items` and `hooks` take, so they can be shared and turned on or
off together. Make one when the user wants an integration to share or to keep apart from their own
settings; otherwise change `status-items` and `hooks`. `komla settings schema plugins` shows what
the manifest takes.

Komla runs a plugin only once the user turns it on, and stops it when any of its files change until
they turn it on again, so writing the folder runs nothing. Write it on this computer, then turn it on
with `komla settings apply plugins` and `{"plugins": [{"id": "<plugin id>", "enabled": true}]}`.
Each item and hook gets the id `<plugin id>.<id>`. Commands that run on this computer get
`KOMLA_PLUGIN_DIR`, the plugin's folder, for scripts it ships; an SSH workspace's commands run on
its host, without that folder. Keep a plugin's state, such as an `interval` hook's last result,
outside its folder, since any change there stops it. Its links must lead to files in its folder, and
the folder itself can't be a link.

## Shortcuts, agents and the terminal

- **Shortcuts:** avoid keys terminals use, such as Ctrl+C, Ctrl+D, Ctrl+R and Ctrl+A.
- **Agents:** a preset's level picker holds one list, so models in place of effort levels remove
  the effort levels. Tell the user before you apply that.
- **Terminal:** most of its colors follow the theme; change those through `komla skill appearance`.
