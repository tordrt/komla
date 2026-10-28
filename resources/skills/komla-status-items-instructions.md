# Komla Status Bar Items

Reference for the `status-items` settings resource and for `komla status set`. Change the resource
with `komla settings apply status-items`, following the steps in `komla skill customize`, which
show the user each change first; Komla's settings files change only through it.

Komla has built-in status bar items too, which the user turns on or off by right-clicking the
status bar and choosing Customize status bar…: Git menu, Target branch, Pull request (the branch's
pull request and its checks, and a notification when CI finishes), Open in editor, File search,
Files, Diff, Notes, Commit graph, Agent activity, Claude Code usage and Codex usage (how much of
the plan's usage limits is used), Automations, Notification sounds, Keep awake, SSH hosts,
Resource usage and Tips. When one shows what the user asks for, point them to it;
otherwise make them an item here.

## Make it look good

The user sees an item all day, so design it like part of Komla:

- **In the bar:** a few words led by an icon, such as a Nerd Font glyph or the service's logo as
  `icon`, with color only where it signals state. A green check and `12/12` as `segments` reads at
  a glance where `Tests: 12 passed` doesn't:
  `[{"text": "\uf058", "color": "success"}, {"text": " 12/12"}]`. Use `muted` for secondary parts.
- **In the popover:** for more than a few lines, print `html`: rows with status icons, a progress
  bar, a small inline SVG chart. Style it with Komla's theme variables so it matches every theme,
  dark and light, and tint fills with them, such as
  `color-mix(in oklch, var(--success) 15%, transparent)`. Keep the page's background transparent.
  The popover is 352 pixels wide, with the body padded 10 by 12 pixels.
- **Actions** go in `buttons` below the page, running the item's `commands`.

A popover for a pull request's checks prints `{"html": "<the page>", "buttons": [...]}`, with a
page such as this one, built by a small script or `jq` (`jq -n --arg html "$page" '{html: $html}'`
encodes it):

```html
<style>
  .head {
    display: flex;
    gap: 6px;
    align-items: baseline;
  }
  .muted {
    color: var(--muted-foreground);
  }
  .bar {
    height: 4px;
    margin: 8px 0;
    border-radius: 2px;
    background: var(--muted);
  }
  .bar > div {
    height: 100%;
    border-radius: 2px;
    background: var(--success);
  }
  .row {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 3px 0;
  }
  .row > :nth-child(2) {
    flex: 1;
  }
  .pass {
    color: var(--success);
  }
  .fail {
    color: var(--error);
  }
</style>
<div class="head"><b>&#xf407; #128</b><span class="muted">Fix the login race</span></div>
<div class="bar"><div style="width: 75%"></div></div>
<div class="row">
  <span class="pass">&#xf058;</span><span>unit</span><span class="muted">2m 10s</span>
</div>
<div class="row">
  <span class="fail">&#xf057;</span><span>e2e</span><span class="muted">5m 02s</span>
</div>
```

## Items that run a command

Status bar items whose text comes from a command. Komla runs each command on its interval while
the workspace is open: in the workspace's folder, or on its SSH host, unless `runOn` is `local`.

```json
{
  "_version": 1,
  "items": [
    {
      "id": "pr",
      "command": "gh pr view --json number,url --jq '{text: \"PR #\\(.number)\", link: .url}'",
      "intervalSeconds": 120,
      "label": "Pull request",
      "projects": ["my-project"]
    }
  ]
}
```

- `id`: up to 40 letters, digits, dots, dashes and underscores; unique in the file.
- `command`: runs in the user's shell. Komla shows the first line of its output, in the terminal
  colors it prints, with the rest as the tooltip, or a printed JSON object
  `{"text", "tone", "color", "tooltip", "link"}`: `tone` adds a dot (`success`, `warning`,
  `error` or `info`), `color` colors the text (those, `muted`, `foreground`, or a hex color such
  as `#e5c07b`), and `link` is an http(s) URL the item opens. To color parts of the text, such
  as an icon, print terminal colors (basic colors follow the theme), or give JSON `segments` in
  place of `text`: `[{"text": "\uf00c", "color": "success"}, {"text": " 2", "bold": true}]`;
  `color` then applies to the parts without one. Nerd Font icons, such as U+F407 for a pull
  request (`\uf407` in JSON), show from Komla's bundled font. Empty output hides the item.
- `icon`: a logo or image before the output, such as a service's logo: SVG markup or an image
  data URL (SVG, PNG, WebP, GIF or JPEG, up to 32 KB), or a file the user keeps in the settings
  folder's `icons` folder, named `icons/<file>`. Keep logos simple and square. `iconColor` shows
  the icon's shape in a color, such as `foreground` for a one-color logo that follows the theme;
  without it, the icon keeps its own colors. JSON output can name its own `icon` and `iconColor`
  in the same ways, or put icons anywhere with segments such as
  `{"icon": "<svg …>", "color": "success"}`, where `color` works as `iconColor` does. An item can
  show only icons, at most 4; it then reads as its `label`.
- `intervalSeconds`: how often it runs, 10 or more; 60 when left out. To update an item when
  something happens instead of waiting for its interval, run `komla status refresh <id>`, such
  as from a hook or a git hook; it runs the command again at once, and fails if the command does.
- `timeoutSeconds`: how long the command and popover command may run, 1 to 600; 15 when left
  out. Past it, Komla stops the command and shows the item's label.
- `runOn`: `workspace`, the default, runs the command where the workspace's files are, so it can
  show the workspace's branch, pull request or tests. `local` runs it on this computer in the
  user's home folder, even for an SSH workspace, and every workspace shows the same output, for
  items that don't depend on the workspace, such as an account's usage or the time. Its popover
  and button commands run there too.
- `label`: shown in place of the output while the command fails, and in the status bar's menu.
- `projects`: project names or ids to run it in; leave it out to run it in every workspace.
- `popoverCommand`: runs when the item is clicked, and its output shows in a popover: Markdown, or
  a printed JSON object `{"markdown", "buttons"}` or `{"html", "buttons"}`. Each button is
  `{"label", "link"}` to open an http(s) URL, `{"label", "action"}` to run one of the project's
  Quick Commands by title, or `{"label", "run"}` to run one of the item's `commands` by name. Buttons
  can't carry a command of their own, since output can include text from elsewhere, such as a
  pull request title.
- `html` shows as a page in a sandbox: inline `<style>` and `<script>` work, such as for a
  chart, but nothing loads from the web, and the page can't reach Komla. A click on an http(s)
  link opens it in the browser; the page's scripts can't open one without a click. Komla's theme colors are CSS variables (`--foreground`, `--background`,
  `--card`, `--muted`, `--muted-foreground`, `--border`, `--accent`, `--primary`,
  `--primary-foreground`, `--success`, `--warning`, `--error`, `--info`), and `data-theme` on
  `<html>` is `dark` or `light`; leave `color-scheme` unset, or the page loses the popover's
  background. The body uses Komla's font with Nerd Font icons, and the popover grows to the
  page's height, up to 420 pixels, then scrolls.
- `commands`: up to 12 named commands for the popover's buttons (it shows at most 6 at once), such as
  `{"rerun": "gh run rerun --failed"}`. Komla runs one in the workspace when its button is
  clicked, then updates the item and the popover.
- `action`: a Quick Command, by title, that clicking the item runs, instead of a popover.

An item with a popover:

```json
{
  "id": "pr",
  "command": "gh pr view --json number --jq '\"\\uf407 #\\(.number)\"'",
  "popoverCommand": "gh pr checks --json name,state --jq '{markdown: (map(\"- \\(.name): \\(.state)\") | join(\"\\n\")), buttons: [{label: \"Rerun failed\", run: \"rerun\"}]}'",
  "commands": { "rerun": "gh run rerun --failed" }
}
```

At most 30 items. If Komla can't read the file, a warning item in the status bar says what's wrong.
Run the command yourself first where it will run, to check that it prints what the item should show.

## While you work

For a status that only matters while you work, such as test progress or a pull request, use
`komla status set` instead of the file, when the user asks to see something there:

```sh
komla status set tests "142/150 passing" --tone warning --link https://github.com/org/repo/pull/12
komla status clear tests
```

The item shows while this workspace is open and lasts until Komla quits. A script can set items
for other workspaces with `--workspace <id>`, as from an interval hook (`komla skill customize`). Setting the same id
replaces it, so update it as work progresses. Keep the text to a few words and set at most a few
items. `komla --help` lists the options for icons, colors and a Markdown popover.
