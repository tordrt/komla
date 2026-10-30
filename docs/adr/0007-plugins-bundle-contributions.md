---
status: accepted
---

# Plugins bundle Komla's existing contributions, and run code outside Electron's main process

Komla grew a set of separate ways to extend it, each its own settings file: status bar items, hooks,
Quick Commands, automations, themes. An integration such as "the pull request for this branch" is
a status item, a hook and a Quick Command in three files, which can't be shared, installed, updated
or turned off as one. Agents write those files through the confirmed settings API (ADR 0004).

A **Plugin** is a folder with a `komla-plugin.json` manifest that contributes entries of those same
kinds, in the same formats Komla already validates them with. It adds no new way to run code: a
plugin's status items and hooks are commands, run where the user's own are, in the workspace's
folder or on its SSH host. The user's own settings files keep working as they are and win when an
id collides.

This was chosen over loading JavaScript plugins into Electron's main process, as opencode and pi do
in their own processes. In Komla's main process, a plugin would share the event loop that carries
every terminal and IPC call. Its code would also run on the desktop while an SSH workspace's files
live on the host. Declarative contributions render the same on the desktop, in remote web and on
the phone, as Komla draws them; arbitrary plugin UI would not.

- **Trust.** Komla runs a plugin only once the user turns it on, in Settings or by approving
  `komla settings apply plugins`, and records a digest of the plugin's files at that point. When
  the files change, as after a `git pull`, the plugin stops until it is turned on again, so new
  commands never run unseen. The digest is of the files the user saw: if they change before the
  approval is written, nothing is turned on. Komla follows changes only to the plugins folder, so a
  plugin's links must lead to files in its own folder, and a plugin folder that is itself a link
  doesn't run. Plugins are installed for the user, in `~/.komla/plugins/`; a
  project's own plugins would need trusting per project, and are not part of this decision.
- **Ids.** A contribution's id is the plugin's id and its own, `<plugin>.<id>`, so `komla status
  refresh`, hidden status items and failure messages name it the same way everywhere.
- **Files.** `komla settings apply plugins` can write a plugin's manifest, so an agent anywhere,
  such as on an SSH host, can make one, and the approval shows what it runs. A command run on this
  computer gets `KOMLA_PLUGIN_DIR`, the plugin's folder, so a plugin can ship its scripts. An SSH
  workspace's commands run on the host, where that folder is not; such a plugin's items run with
  `runOn: local`.
- **Later.** Code that keeps state or follows more events than hooks offer would run in a separate
  plugin host, an Electron utility process with a typed API (`komla.on`, `statusItem().set`,
  `exec` routed through the execution-location adapters), behind the same trust rule. Quick
  Commands, automations and themes join as contribution kinds as plugins need them; Quick Commands
  first need a read-only form, since the user edits and reorders their own.
