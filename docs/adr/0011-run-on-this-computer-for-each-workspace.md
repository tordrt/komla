---
status: accepted
---

# Commands can run on this computer for each workspace

A status item's, panel's or hook's commands ran either where the workspace's files are
(`runOn: workspace`), on its SSH host for an SSH workspace, or on this computer once for every
workspace (`runOn: local`). An item about the workspace that needs what only this computer has, such
as its branch's pull request asked for with the user's `gh` login or a plugin's secret, which never
goes to a host (ADR 0010), fit neither: on the host it has no login or secret, and a `local` item
runs once, so every workspace shows the same output, and it isn't told which workspace it's for.
Only a plugin's code could do it, asking Komla for the branch and posting to a panel.

A third value, `runOn: local-per-workspace`, runs them on this computer in the home folder for each
workspace, as with `workspace`: each workspace has its own run and output, its events refresh it, and
an interval hook runs for every workspace outside the Trash whose files exist. It runs while an SSH workspace's host is
away, gets the plugin's secrets and its folder here, and doesn't make SSH hosts get a Plugin copy.
For an event hook it is the same as `local`, which already runs for the event's workspace.

Every command Komla runs for a workspace, whatever `runOn` says but `local`, now gets
`KOMLA_WORKSPACE_ID`, `KOMLA_WORKSPACE_NAME`, `KOMLA_BRANCH`, `KOMLA_PROJECT` and `KOMLA_REPO_URL`,
which hooks had but status items and panels didn't. `KOMLA_WORKSPACE_ID` makes the `komla` CLI act on
that workspace from the home folder. `KOMLA_BRANCH` is the branch Komla last saw checked out, as
the pull request status does, since a command in the home folder can't ask git. `KOMLA_REPO_URL` is
the URL an SSH workspace's host cloned, or for a workspace here the origin of the project's
repository, read with git and kept five minutes; either is without the password a URL may carry,
and an https one without its user name, which can be a token. `gh --repo` takes it as it is.

Considered: making `local` run for each workspace, which would run an account's usage once per
workspace and change what existing items do; letting a command name a host to run on, which no
contribution has needed and ties a plugin to one user's hosts.
