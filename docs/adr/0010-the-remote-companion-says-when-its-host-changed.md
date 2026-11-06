---
status: accepted
---

# The Remote Companion says when its host changed

SSH Workspace Sync used to find out what other Komla installations changed on a host by asking
it: on every focus at most every 30 seconds, when a workspace was opened, and every 30 seconds for
five minutes after another installation changed something there. Two people sharing hosts paid for
that traffic all day, and still learned of a change only once they came back to Komla.

The Remote Companion now tells its desktop instead. It lists the host's workspace manifest
directory every two seconds, which costs a few local stats and no network traffic, and posts an
`ssh-host-changed` notice through Komla's host-scoped tunnel when a manifest that another
installation wrote appears or changes, or any manifest goes. It skips manifests whose `writtenBy`
is its own installation's, so the desktop's own writes don't echo back. It also posts one when
another installation's managed tmux sessions start or end, from the session listing it already
takes every five seconds to decide whether to keep running. The notice carries nothing else: the
desktop answers it with an ordinary sync pass, which reads the manifests and the sessions as it
always has. Notices coalesce, and one the desktop didn't take is retried with backoff.

While a host's companion runs, focusing Komla or opening a workspace syncs that host at most once
an hour, in case the companion stopped without the desktop noticing, and nothing follows up after
another installation's change. A host without one, because none of
its workspaces has a Managed Remote Terminal Session here, still syncs on focus, but at most every
ten minutes, and still follows up after adopting a workspace until its sessions show.

The companion remains an accelerator rather than a correctness dependency, as ADR 0001 has it.
Komla still syncs a host when its data tunnel connects or reconnects, when it answers again after
being unreachable, when the user adds or opens it, and when a hook arrives for a terminal Komla
doesn't have. A notice the companion missed is made up by the next of those.

## Considered options

- Keep polling, less often: rejected because any interval is either too slow for a workspace a
  colleague just started or too frequent for a host nobody changes.
- Watch the directory with file system events: rejected because some mounts deliver none, and a
  missed event would leave a host unsynced until it reconnected. Listing it is cheap and can't miss
  a change.
- Send the changed manifests with the notice: rejected because the desktop must read the host
  anyway to merge and check sessions, and a manifest read on the host stays untrusted either way.
