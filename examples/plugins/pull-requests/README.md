# Pull requests

A Komla plugin with the repository's open pull requests in a sidebar panel, beside Diff and Files:

- **Waiting on your review**, **Yours** and **Everything else**, newest first, each with its CI
  state, review decision, size and merge conflicts. Filter by title, number, author or branch.
- Click a pull request to see its failing and running checks, linked to their runs, and to hand it
  to an agent in a new workspace: **Review with an agent** for someone else's, **Fix checks** or
  **Address review** for your own. Komla asks before it starts the agent and shows its prompt.
- The panel's tab shows how many wait on your review, and so does a status bar item, which opens
  the panel when clicked.

It needs the [GitHub CLI](https://cli.github.com), signed in with `gh auth login`, where the
workspace runs, and a workspace whose repository is on GitHub. It asks GitHub once for each
repository, however many workspaces show it: when the panel opens, every three minutes, and soon
after a workspace's branch changes or an agent finishes there.

## Install

Copy this folder into Komla's plugins folder, then turn it on in Settings → Plugins:

```sh
cp -R examples/plugins/pull-requests ~/.komla/plugins/
```

## How it's made

- `komla-plugin.json` names the plugin's code, `main.ts`, its panel's page, the folder
  `panels/pull-requests`, and the status item, a command that counts what waits on your review
  and opens the panel with `"panel": "prs"`.
- `main.ts` runs in a process of its own while the plugin is on, as TypeScript without a build.
  When a window opens the panel, it runs the `gh` query with `komla.exec` where that workspace's
  files are, on its SSH host too, and gives every workspace of the repository the result with
  `komla.panels.post` and the count with `komla.panels.setBadge`. `komla.on('branch.changed')` and
  `komla.on('agent.done')` ask again once a burst of them settles, and `komla.panels.onMessage`
  answers the page's refresh button.
- `panels/pull-requests/app.js` gets the data from `komla.onData` and draws the lists with
  Komla's stylesheet, `/__komla/komla.css`, in the window's theme. It puts titles and names from
  GitHub in as text, never as HTML.
- Its buttons start agents with `komla.agent.launch(…)`, which the panel may do because it
  declares the `agent.launch.workspace` capability, and Komla asks the user first. Its prompts name
  the pull request by number and link only: its title and description are text anyone can write,
  so the agent reads them itself.

While you change it, turn on Development for it in Settings → Plugins: it then runs as its files
change, and the panel gets buttons to load the page again and open the developer tools.
`main.ts` imports its types from `@komla/sdk/plugin`, the Komla SDK in Komla's repository, which
an editor finds once the SDK is installed; Komla ignores the import. `komla skill integrations`
describes the rest.
