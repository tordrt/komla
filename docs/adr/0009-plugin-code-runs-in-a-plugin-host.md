---
status: accepted
---

# Plugin code runs in a plugin host, and feeds status items and panels with events

Plugins began as bundles of commands (ADR 0007). Commands on intervals fall short for an
integration such as "the repository's pull requests": a status item and a sidebar panel each ask
GitHub on their own timers, each workspace of a repository asks again, and nothing can refresh
when something happens instead of on a timer. ADR 0008 foresaw a plugin host, events and a bridge
for panel pages on the Komla SDK; this records how they're built.

- **Plugin Host.** A plugin's `komla-plugin.json` may name a `main`, a JavaScript or TypeScript
  module in its folder. Komla runs it in an Electron `utilityProcess` of its own, with Node's
  type stripping, so it needs no build, and calls `activate(komla)`. The process talks to the main
  process over its parent port, not over HTTP. `komla` is an SDK client declaring every capability
  (plugin code is trusted as the plugin's commands are, ADR 0008), plus `on` for events, `exec`
  for shell commands where a workspace's files are, through the same runner as status items so an
  SSH workspace's run on its host, and `panels` to post a panel's data, set its badge and answer
  its page. The process starts when the plugin is on, stops (after `deactivate`, at most two
  seconds) when it's off or its files change, and starts again after it exits, waiting longer each
  time, until it exits four times in a minute; then it stays off until its files change. Settings
  shows its state and the last 200 lines it printed.
- **Komla Events.** The events hooks run on (`agent.done`, `agent.needs-input`, `agent.error`,
  `agent.prompt`, `workspace.created`, `workspace.trashed`) and two from the workspace watchers,
  `working-tree.changed` and `branch.changed`, are published once in the main process. Plugin code
  gets them in full. Windows get them without `message`, which can hold a prompt, and use them for
  `refreshOn` and to pass to panel pages.
- **`refreshOn` runs in windows.** A status item's or panel's `refreshOn` names events that run
  its command again once a burst of them settles (750 ms). The window runs it, as it runs items on
  their interval, so only what someone can see runs, rather than every workspace's items on every
  file save.
- **Panel state.** A panel's badge and the data plugin code posts for it live in the main process,
  per workspace or for every workspace, for as long as Komla runs. They aren't persisted: the code
  that set them sets them again. A plugin's state goes when its code stops.
- **One surface for pages.** A popover's page and a panel's page share Komla's theme variables,
  fonts and `komla.css`. A panel's page also gets `komla`: one method for each Komla Operation, as
  the SDK client has them, `on`, `setBadge` and `send`. What a page asks still goes through Komla's
  checks (ADR 0008): its manifest's capabilities, a confirmation for risky ones, and only from a
  click. `send` reaches the plugin's code with `activated`, whether it came from a click, and the
  page can't make plugin code act past it unless the code checks that; for an agent launch the
  example calls `komla.agent.launch` from the page, so Komla asks the user.
- **Linking.** A status item can open a sidebar panel with `panel`, in a plugin only its own, so a
  count sits in the bar and the list in the panel.
- **Development.** Turning on Development for a plugin in Settings runs its files as they change,
  without approving each change, and gives its panels buttons to load the page again and open the
  developer tools. Only Settings turns it on; `komla settings apply plugins` can't, as it would let
  an agent run changes unseen.
- **Settings and secrets.** A manifest declares `settings`, which the user fills in under the
  plugin in Settings. They live outside the plugin's folder, in `settings/plugin-settings.json`,
  so changing one doesn't change the digest the user approved. Secrets are encrypted with the OS
  keychain through Electron's `safeStorage`, or kept in that file alone, readable only by the
  user, on a computer without one, as Komla's other secrets are. Only the main process decrypts
  them, and they go to the plugin's code and to its commands that run on this computer, never to
  a window, a panel's page or an SSH host. Settings gets whether a secret is set. Settings and
  the plugin's own code (`komla.settings.set`) set them, agents never: an agent asks the user to
  enter a token in Settings, so it never passes through the agent's context. A page can open
  Settings at its plugin with `komla.openSettings()`, from a click, which is what the guide shows
  first; a page may also ask for a token itself and send it to its code, which then passes
  through a page that may show outside text, so that stays the plugin's choice. Plain settings
  also reach commands on an SSH host.

Not done: events over HTTP (server-sent events for scripts), a typed SDK bundle served to pages
that build their own client, agents setting plain plugin settings through `komla settings`, and
Quick Commands and automations as contributions.
A page that reloads itself loses its click token, since Komla can't tell its second hello from a
forged one.
