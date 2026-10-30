# Komla Status Bar Items

A status bar item shows a few words from a command, refreshed on an interval, in every workspace or
a project's, and can open a popover with more and buttons that run commands. Change them with
`komla settings apply status-items`, following the steps in `komla skill customize`, which show the
user each change first. `komla settings schema status-items` lists every field and what the commands
can print.

Komla also has built-in items, which the user turns on by right-clicking the status bar and choosing
Customize status bar…, such as the branch's pull request and its checks, Claude Code and Codex
usage, resource usage and SSH hosts. When one already shows what the user wants, point them to it.

Some ideas: the last test run; whether staging answers; an account's usage or a cloud bill; the
issues assigned to the user, in a popover.

The user sees an item all day, so make it feel like part of Komla: an icon and a few words in the
bar, with color only where it signals state, and the details in the popover.

```json
{
  "_version": 1,
  "items": [
    {
      "id": "nightly",
      "command": "gh run list --workflow nightly.yml --limit 1 --json conclusion --jq '.[0] | {text: \"\\uf186 nightly\", tone: (if .conclusion == \"success\" then \"success\" elif .conclusion == \"\" then \"info\" else \"error\" end)}'",
      "intervalSeconds": 300,
      "popoverCommand": "sh ~/.config/komla/nightly.sh",
      "commands": {
        "run": "gh workflow run nightly.yml",
        "fix": "komla launch \"Fix what failed in the last nightly run\""
      },
      "projects": ["my-project"]
    }
  ]
}
```

Run each command yourself first where it will run, to check that it prints what the item should
show.

## HTML popovers

Make a popover an HTML page: rows with status icons, progress bars, small charts, in Komla's theme.
Komla shows Markdown plainly, so keep it for a line or two of plain text. The popover command prints
`{"html": "<page>", "buttons": [...]}`, such as this `~/.config/komla/nightly.sh`, which lists the
last runs:

```sh
#!/bin/sh
gh run list --workflow nightly.yml --limit 5 --json displayTitle,conclusion,createdAt | jq '{
  html: ("<style>
    .row { display: flex; gap: 8px; padding: 3px 0 }
    .row > :nth-child(2) { flex: 1 }
    .success { color: var(--success) }
    .failure { color: var(--error) }
    .muted { color: var(--muted-foreground) }
  </style>" + (map(@html "<div class=\"row\"><span class=\"\(.conclusion)\">\uf111</span><span>\(.displayTitle)</span><span class=\"muted\">\(.createdAt[5:10])</span></div>") | join(""))),
  buttons: [{label: "Run now", run: "run"}, {label: "Fix", run: "fix"}]
}'
```

The page runs in a sandbox: inline styles and scripts work, but nothing loads from the web. Use
Komla's theme colors so it fits every theme, dark and light: `--foreground`, `--muted-foreground`,
`--muted`, `--border`, `--card`, `--accent`, `--primary`, `--success`, `--warning`, `--error` and
`--info`, and `color-mix()` for tints. Keep its background transparent and `color-scheme` unset.
It has Komla's font with Nerd Font icons, is 352 pixels wide and scrolls past 420 pixels tall.
Escape text from elsewhere, as `@html` does.

## With the rest of Komla

An item is one part of what Komla can show; combine it with the rest:

- **Hooks and Quick Commands** update an item at once with `komla status refresh <id>`, such as
  the Quick Command that runs the tests, or an `agent.done` hook after each turn.
- **Clicking** an item can run a Quick Command, with `action`, in place of a popover.
- **Commands and buttons** run in the workspace's folder, unless `runOn` is `local`, with the
  `komla` CLI, so they can tag the workspace, notify, or `komla launch` an agent to fix what the
  popover shows. An item's command runs again and again, so tag or notify only when what it sees
  changes, keeping the last state in a file. `komla skill customize` says how to keep tags and
  notifications short.
- **A plugin** bundles items with the hooks and scripts they need, so the user can share them or
  turn them off as one. Make one when an item comes with a hook or a script of its own, or the
  user wants to share it; `komla skill customize` says how.

## While you work

When the user asks to see something in the status bar only while you work, such as test progress,
use `komla status set` instead of the file. Its item lasts until Komla quits; `komla status set
--help` lists its options.

```sh
komla status set tests "142/150 passing" --tone warning
komla status clear tests
```

Give it a popover page with `--popover-file -`, made as under **HTML popovers** and shown in the
same sandbox. The page runs as written, so escape text from elsewhere, such as a pull request title
or a log line, before putting it in. `--popover-markdown` takes plain Markdown in place of a page,
for a line or two of text.
