# Komla Integrations: Status Bar Items, Sidebar Panels and Plugins

What Komla shows of the user's own tools: a status bar item for a glance, a sidebar panel for a
list or a board beside their work, and a plugin that bundles them, run by shell commands, by
TypeScript code of its own, or by both. Each section below builds on the one before.

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

`projects` shows an item only in those projects' workspaces, by name or id; leave it out for every
project. Ask the user which they want when the item is about one project, such as its CI; `komla
context --json` gives this workspace's project. Sidebar panels and a plugin's items and panels take
it too. The user can also hide any item or panel in one project by right-clicking it.

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
It has Komla's font with Nerd Font icons, and the classes of `komla.css` (under **Pages that look
like Komla**), such as `k-badge` and `k-success`. It is 352 pixels wide and scrolls past 420 pixels tall.
Escape text from elsewhere, as `@html` does.

## Sidebar panels

A sidebar panel is a page in the workspace's sidebar, beside Diff and Files, for what needs
more room than a popover: the last test run's failures, a CI run's jobs, the issues on the user's
plate. Change them with `komla settings apply sidebar-panels`; `komla settings schema
sidebar-panels` lists every field. A panel takes a status item's fields, with a `title` for its tab
in place of `label` and no icon, and its `command` prints what a popover command prints, with the same buttons:

```json
{
  "_version": 1,
  "panels": [
    {
      "id": "nightly",
      "title": "Nightly",
      "command": "sh ~/.config/komla/nightly.sh",
      "intervalSeconds": 120,
      "commands": {
        "run": "gh workflow run nightly.yml",
        "fix": "komla launch \"Fix what failed in the last nightly run\""
      },
      "projects": ["my-project"]
    }
  ]
}
```

Its command runs when the user opens the panel and on its interval while it stays open, never
while it's closed, so a panel can run a slower command than an item. Make its page as under **HTML
popovers**, in the same sandbox and theme; it fills the panel and scrolls the page itself. The
panel is as wide as the user makes the sidebar, from 150 to 520 pixels, so make the page work at
150 first: let a row's title truncate or wrap, its meta line wrap, and never scroll sideways; add
detail with media queries as it widens. Plain text in place of JSON shows as a terminal shows it,
colors included, and `{"markdown": "…"}` as Markdown.

The sidebar's tab row shows Diff, Files and the panels in the order the user drags them to for
the project, as many as fit its width and at least two, and the rest in a menu at its end, so a
new panel doesn't crowd the row; picking one there or right-clicking a tab puts it in a tab's
place. Keep `title` to one short word, as short as Diff and Files where it can be: `PRs` rather
than `Pull requests`, `CI` rather than `Build status`. The sidebar at its narrowest keeps room for
the widest tab, and shorter titles let more fit.

### A page of its own

For a panel that does more than show a command's output, such as a board with filters or a form,
give it a `page`: an HTML file, or a folder with an `index.html` such as a React app's build, in
the `panels` folder beside `sidebar-panels.json` (a plugin keeps its own `panels` folder). The page
loads once and stays while the panel shows; its `command`, if it has one, now prints data for it
rather than a page:

```json
{
  "id": "reviews",
  "title": "Reviews",
  "page": "panels/reviews",
  "command": "gh pr list --search 'review-requested:@me' --json number,title,url",
  "intervalSeconds": 300,
  "commands": { "checkout": "gh pr checkout \"$(cat ~/.cache/komla-review)\"" },
  "capabilities": ["agent.launch.workspace"]
}
```

The page loads what it needs from its folder, nothing from the web, so bundle its scripts; a build
can use paths from `/`, which is the page's folder. Komla puts `komla` in the page before its own
scripts run:

- `komla.onData((data, error) => …)` gets what the command printed, its JSON or its text, each time
  it runs, and the last run's at once; `komla.data` holds it. `komla.refresh()` runs it now.
- `komla.run(name)` runs one of `commands`, only from a click or a key press in the page, then
  runs the command again.
- `komla.workspace.list()`, `komla.agent.launch({ destination: "workspace", prompt })` and one such
  method for each Komla Operation, as `komla` commands have them, send it to Komla, with `{
workspace }` as a second argument to act on another workspace. `komla.call(request)` sends one as
  it is. Reading and notifying need nothing; anything else needs its capability in `capabilities`.
  Before it launches an agent, moves a workspace to the Trash, links workspaces or opens a folder,
  Komla asks the user, and only from a click in the page. Add `draft: true` to a workspace launch
  to open New Workspace with the prompt, project, agent and mode filled in instead: the user reads
  the prompt there, changes it and starts it, so Komla doesn't ask first. Prefer a draft for a
  button that hands an agent a task from what the page shows, such as "Fix this check".
- `komla.on("agent.done", event => …)` follows what happens in the workspace, as `refreshOn` names
  it below; `"*"` follows every event.
- The theme's colors are CSS variables, such as `var(--success)`, which change with the user's
  theme; `komla.onTheme(theme => …)` says when. `<link rel="stylesheet" href="/__komla/komla.css">`
  styles the page as Komla, as the next section shows.
- Links to http(s) pages open in the browser. Don't reload or navigate the page itself; call
  `komla.refresh()`.
- In a plugin with code, `komla.send(message)` asks the plugin's code and resolves to its answer.
- In a plugin's panel, `komla.openSettings()` opens Settings → Plugins at the plugin, only from a
  click or a key press.
- The page can't submit a form or open a popup: handle the button's `click`, or Enter in a field,
  instead of a form's `submit`.

Data can carry text from elsewhere, such as a pull request title: put it in the page with
`textContent` or your framework's text, never as HTML.

## Pages that look like Komla

The user keeps a panel open beside their work all day, so it should read as part of Komla, not as
a web page inside it. `komla.css` has the pieces; build from them before writing styles of your
own, and start from this skeleton:

```html
<link rel="stylesheet" href="/__komla/komla.css" />
<header class="k-header">
  <div class="k-toolbar">
    <label class="k-search">
      <span class="k-icon">&#xea6d;</span
      ><input class="k-input" type="search" placeholder="Filter runs" />
    </label>
    <button class="k-icon-button" title="Refresh" aria-label="Refresh">
      <span class="k-icon">&#xeb37;</span>
    </button>
  </div>
  <div class="k-meta"><span>main</span><span class="k-sep"></span><span>2m ago</span></div>
</header>
<div class="k-banner k-error" hidden></div>
<details class="k-section" open>
  <summary class="k-section-header">
    <span>Failing</span><span class="k-count k-error">2</span>
  </summary>
  <ul class="k-list">
    <li>
      <button class="k-item" aria-expanded="false">
        <span class="k-avatar" style="--k-hue: 210">TD</span>
        <span class="k-grow">
          <span class="k-clamp">A title, set with textContent</span>
          <span class="k-meta"
            ><span>#123</span><span class="k-sep"></span><span>5d ago</span></span
          >
        </span>
        <span class="k-icon k-error" title="2 checks failing">&#xf00d;</span>
      </button>
    </li>
  </ul>
</details>
<div class="k-empty">
  <span class="k-icon">&#xeab2;</span><strong>All clear</strong><span>Nothing fails on main.</span>
</div>
```

- **The panel's tab and header already name it.** Don't repeat the title. The page's header holds
  what the user acts on, a filter and a refresh, over a line of `k-meta`: where the data is from
  and when it updated. `k-header` stays at the top as the page scrolls; change the page's padding
  with `--k-page-x` and `--k-page-y`, not on `body`, so the header still meets the edges.
- **One line of meaning per row.** A title of at most two lines (`k-clamp`), one muted `k-meta`
  line below it, with `k-sep` between its parts, and the row's state as an icon at its right. Put
  the rest, such as a run's failing jobs and the buttons that act on it, in the row's open state
  (`aria-expanded="true"`) rather than in every row.
- **Color says state, nothing else.** Use `k-success`, `k-warning`, `k-error` and `k-info` on
  icons, counts, badges and banners, and keep text in `--foreground` or `--muted-foreground`. Add
  no colors, gradients, shadows or font sizes of your own: the base is 12px, and meta is 11px.
- **Leave out what's empty.** Skip a section with nothing in it. When there's nothing at all, show
  `k-empty`: an icon, a line, and what to do when it's a problem, such as `gh auth login`.
- **Loading and errors.** Show `k-skeleton` rows or `k-spinner` until the first data comes. When
  a later refresh fails, keep what's shown and say so in a `k-banner` above it.
- **Icons** are Nerd Font glyphs in `k-icon`, or a `k-icon-button` for a button that is only an
  icon, never emoji: search `&#xea6d;`, refresh `&#xeb37;`, check `&#xf00c;`, cross `&#xf00d;`,
  running `&#xf192;`, branch `&#xe725;`, pull request `&#xea64;`, link out `&#xeb14;`, agent
  `&#xeb08;`.
- **Buttons.** At most one `k-primary` in view, `k-small` inside a row, and `<a class="k-button">`
  for a link to the web. The page can't load images from the web, so people get `k-avatar`
  initials, with `--k-hue` from a hash of their name.
- **Check it** at 150 and 520 pixels wide, in a dark theme and a light one. With Development on in
  Settings → Plugins, the panel's inspect button opens its developer tools.

The rest of `komla.css`: `k-row`, `k-stack` and `k-grow` lay out, `k-truncate` cuts a line short,
`k-muted`, `k-mono`, `k-tabular` and `k-kbd` style text, `k-card`, `k-table`, `k-progress` (with
`--value` from 0 to 1), `k-badge`, `k-dot`, `k-divider` and `k-link` show things, and `k-input`,
`k-button` and `k-ghost` take input. `[hidden]` hides any of them.

## With the rest of Komla

An item is one part of what Komla can show; combine it with the rest:

- **Events** run an item's or panel's command again at once, besides its interval, with
  `refreshOn`: `agent.done`, `agent.needs-input`, `agent.error`, `agent.prompt`,
  `workspace.created`, `workspace.trashed`, `working-tree.changed` (its uncommitted changes) and
  `branch.changed` (a checkout or commit). Prefer them to a short interval, such as
  `"refreshOn": ["branch.changed"]` for a branch's checks.
- **Hooks and Quick Commands** update an item at once with `komla status refresh <id>`, such as
  the Quick Command that runs the tests.
- **Clicking** an item can run a Quick Command, with `action`, or open a sidebar panel, with
  `panel` and its id, in place of a popover: a count in the bar, with the list in the panel.
- **Commands and buttons** run in the workspace's folder, unless `runOn` is `local`, with the
  `komla` CLI, so they can tag the workspace, notify, or `komla launch` an agent to fix what the
  popover shows, or `komla launch --draft` to open New Workspace with it filled in for the user to
  start. An item's command runs again and again, so tag or notify only when what it sees
  changes, keeping the last state in a file. `komla skill customize` says how to keep tags and
  notifications short.
- **A plugin** bundles items and panels with the hooks and scripts they need, so the user can
  share them or turn them off as one. Make one when an item comes with a hook or a script of its
  own, or the user wants to share it; `komla skill customize` says how.

## A plugin's code

A plugin can have code of its own: a `main` in its `komla-plugin.json`, a JavaScript or TypeScript
module in its folder such as `main.ts`. Komla runs it without a build step, in a process of its
own, while the plugin is on, and calls its `activate(komla)`.

Commands and code are both fine ways to build a plugin, and one plugin can mix them. Pick with the
user rather than for them, telling them what each gives:

- **Commands** are a line of shell each, in the manifest, which each workspace that shows the item
  or panel runs on its interval and `refreshOn` events. They need nothing else and are quick to
  read, but each workspace asks again, and they keep no state between runs.
- **Code** is TypeScript with the Komla SDK's types. It runs once for every workspace, so it can ask
  a service once, keep state, follow events, and answer what its panel's page sends. Status bar
  items still run commands; code feeds panels.

```ts
import type { KomlaPlugin } from '@komla/sdk/plugin';

export function activate(komla: KomlaPlugin) {
  komla.panels.onOpen('ci', async ({ workspace }) => {
    const runs = JSON.parse(await komla.exec('gh run list --json name,conclusion', { workspace }));
    komla.panels.post('ci', runs, { workspace });
  });
}
```

- `komla.exec(command, { workspace })` runs a shell command where the workspace's files are, on its
  SSH host for an SSH workspace, and resolves to what it printed; without a workspace, in the
  plugin's folder on this computer.
- `komla.panels.post(panel, data, { workspace })` gives the plugin's panel's page data, which it
  gets from `komla.onData`; without a workspace, every workspace's page gets it. `komla.panels.onOpen` says when a window opens the panel, and
  `komla.panels.onMessage(panel, (message, { workspace, activated }) => answer)` answers the page's
  `komla.send`. The page shows outside text, so check its messages, and act past the page only
  when `activated`, from a click; the page can launch an agent itself, which Komla asks about, or
  draft one, which it doesn't.
- `komla.on(event, listener)` follows the events `refreshOn` names, in every workspace, and
  `komla.workspace.list()` and the other Komla Operations work as in a page, without
  `capabilities`, within what the user leaves on.
- What it prints shows under the plugin in Settings → Plugins, which turns it on. Turn on
  Development there while you write a plugin: it then runs as its files change, and its panels
  get buttons to load their page again and inspect it.

### Settings and secrets

When a plugin needs something from the user, such as a repository, a team or an API token, declare
it in `settings` in `komla-plugin.json` rather than writing it into a script. The user fills them
in under the plugin in Settings → Plugins:

```json
{
  "settings": [
    { "id": "team", "title": "Team", "type": "text", "placeholder": "ENG" },
    { "id": "token", "title": "API token", "type": "secret" },
    {
      "id": "sort",
      "title": "Sort by",
      "type": "choice",
      "options": ["updated", "created"],
      "default": "updated"
    }
  ]
}
```

- A setting is `text`, `number`, `boolean`, `choice` (one of `options`) or `secret`, with an
  optional `default`, `description` and `placeholder`.
- The plugin's code reads them with `komla.settings.get("team")`, or all of them with
  `komla.settings.get()`, and follows changes with `komla.settings.onChange(settings => …)`.
- Its commands get them as variables, `KOMLA_SETTING_TEAM` and so on. On an SSH host they get
  every setting but the secrets, so a command there that needs a token runs with `"runOn":
"local"`, or the plugin's code calls the service itself.
- A secret is encrypted with the OS keychain. You can't read or set one: once the plugin is
  ready, tell the user which secret to enter in Settings → Plugins, and never ask them to paste
  it into the chat.
- When a setting is missing, have the page say so instead of failing: the code tells the page,
  through `komla.send` or the data it posts, and the page shows a button that calls
  `komla.openSettings()`, which opens Settings → Plugins at the plugin. Prefer this for a secret.
- A page may instead ask for it in a field of its own: a click sends what the user typed to the
  code with `komla.send`, and the code saves it with `await komla.settings.set({ token })`, or
  clears it with `null`. Do it only for a plugin whose page shows nothing from elsewhere as HTML,
  since the secret passes through the page; the code checks `activated` before saving.

The Pull requests example in Komla's repository, `examples/plugins/pull-requests`, has code, a
page, a setting and a status item that opens the panel.

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
