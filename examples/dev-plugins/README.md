# Sample plugins for development

Plugins for trying Komla's sidebar and status bar with several plugins at once. They need nothing
installed beyond git and a POSIX shell. Between them they cover what a plugin can contribute:

| Plugin       | Shows                                                                                                                            | Made with                                                                                          |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Git activity | A Commits panel and an "N ahead" status item, refreshed on `branch.changed`                                                      | Shell commands, terminal text                                                                      |
| TODOs        | A TODOs panel with a filter and a count on its tab, and a setting                                                                | Plugin code (`main.ts`) and a page                                                                 |
| System       | Processes and Ports panels, and a load average status item                                                                       | Shell commands, `runOn: local`                                                                     |
| Branches     | A Branches panel with buttons to fetch and prune                                                                                 | A script in the plugin's folder printing Markdown                                                  |
| Focus timer  | One timer for every workspace: a Focus panel, the minutes left on its tab and in the status bar, and a notification when it's up | Plugin code keeps the timer in `~/.cache/komla-focus-timer`, which the status item's command reads |

Copy them, with `examples/plugins`, into the development data folder, then turn them on in
Settings → Plugins:

```sh
npm run dev:plugins            # into ~/.komla-dev/plugins, for npm run dev
npm run dev:plugins -- /tmp/komla-dev   # into another data folder, such as npm run dev:sandbox's
```

Copying again replaces those folders, so Komla stops them until you turn them on again.
