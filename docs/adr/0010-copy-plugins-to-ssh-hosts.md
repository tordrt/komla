---
status: accepted
---

# Plugins' files are copied to the SSH hosts where their commands run

A plugin's status items, panels and hooks run where a workspace's files are, so on its SSH host for
an SSH workspace, as does `komla.exec` from its code (ADRs 0007, 0009). Their commands got
`KOMLA_PLUGIN_DIR` only on this computer, so a plugin that ships a script, such as
`sh "$KOMLA_PLUGIN_DIR/checks.sh"`, couldn't run it in an SSH workspace. `runOn: local` ran it here
instead, away from the workspace's files, which defeats a plugin about the project.

Komla now copies each plugin that runs to the SSH hosts, and sets `KOMLA_PLUGIN_DIR` there to the
copy.

- **What is copied.** The files the plugin's digest has, read as Komla copies them and refused
  unless they still match the digest the user turned on, so a host gets only what the user saw.
  A plugin in development is copied as its files are, as it runs them, in the folder of their
  own digest. Only plugins that may run something there are copied: those with code, or with a
  contribution that doesn't run `runOn: local`. Secrets stay on this computer, as before.
- **Where.** `<host's Komla folder>/plugins/<installation>/<plugin>/<digest prefix>/`. Each
  revision has a folder of its own, extracted beside it and moved into place, so a command never
  sees half a copy. Each Komla installation keeps its own copies, so it removes only those of
  plugins it no longer runs, and several installations sharing a host each copy the plugins they
  run.
- **When.** A command on a host that names `KOMLA_PLUGIN_DIR` waits for its plugin's copy, made
  first if the host lacks it, and fails with why if Komla can't make it. One that doesn't name it
  runs at once, with the copy only when Komla knows it's there, and never starts one, so a copy
  that fails fails only the commands that need it. When SSH Workspace Sync
  reads a host, Komla copies what's missing, asking the host again only once the plugins change
  or ten minutes on, or a minute after a copy failed. A copy Komla made or saw is trusted for ten
  minutes before a command checks it again, since the host's files can go, and Komla forgets what
  it knew of a host when the host is edited or removed.
- **Removing.** Making a copy marks the plugin's other revisions, and a sync marks those no plugin
  runs and unmarks those it does. A copy or sync at least ten minutes after a revision was marked
  removes it, so a command still using it keeps its files, and a copy that finishes late, which
  marks the newer one, doesn't remove it: a sync, or a command checking the copy that runs,
  unmarks it. A sync also removes copies left
  half made an hour ago, by a connection that dropped, and the folders of plugins that no longer
  run.
- **How.** A tar archive Komla writes itself, piped to `tar -xf -` on the host, which every host
  with a POSIX shell has: no upload channel, rsync or companion is needed. A copy that fails is
  tried again a minute later, so a host that can't take it isn't sent the plugin on every poll.
- **Trust.** Anything on the host can change a copy, but what runs there could already change
  anything there. A copy doesn't reach back to this computer, whose plugin folder and digest stay
  what Komla runs here.

Not done: removing the copies of plugins turned off on a host whose SSH Workspace Sync is off,
waiting for the copy for a command that reads `KOMLA_PLUGIN_DIR` without naming it, such as a
workspace's script, and sharing plugins between installations through the host as Project
manifests share project settings.
