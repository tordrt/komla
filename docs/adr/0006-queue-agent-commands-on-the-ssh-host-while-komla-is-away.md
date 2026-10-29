---
status: accepted
---

# Queue agent commands on the SSH host while Komla is away

Agents on an SSH host keep working while no Komla installation is connected: the laptop sleeps,
the network drops, the user is away. Their hooks already wait in the Pending Terminal Hook mailbox
(ADR 0001), and `komla agent launch --new-workspace` already starts a workspace on the host by
itself. The other commands that change a workspace, `komla title`, `snooze`, `wake`, `tag`,
`untag` and `trash`, failed with "Komla is not running", so an agent that finished its work could
not say so.

When such a command can't reach Komla from a managed terminal on the host, the CLI queues it
instead. It writes the typed operation it would have sent, with the terminal, workspace and cwd it
ran in and the time it was asked, to an outbox beside the companion's hook inbox, and reports it
as queued. The companion delivers the outbox in order, oldest first, to `/api/v1/commands`
through its desktop's tunnel as soon as the desktop answers, exactly as the CLI would have sent
each command. The desktop runs it as any other Komla Operation, so capability policy and every
business rule stay in the desktop. A rejected command is dropped, as a rejected hook is. One the
desktop fails on is retried for a few minutes, and one whose workspace it hasn't added yet, as
for a workspace created on the host, for a minute. A command run while earlier ones still wait
never overtakes them: it queues behind them, except that while the companion's desktop answers it
first gives the companion a few seconds to deliver them and the hooks written before it, then goes
straight to Komla, so Komla's errors still reach the agent.

This keeps ADR 0001's boundary: the companion carries requests the CLI composed and has no
operations of its own.

- **Order with hooks.** Hooks and queued commands reach the desktop in the order they were
  written: each waits for the other queue's older entries, and on a tie the command goes first.
  An agent that snoozes until notified and then ends its turn wakes, and one that ends its turn
  and then snoozes stays snoozed, as they would have while connected. A command waits for older
  hooks for at most 30 seconds of the desktop answering, so a hook the desktop keeps failing on
  can't hold it up, and a
  hook waiting behind its terminal's newer prompt hook counts as that prompt's age, the order the
  mailbox delivers them in.
- **Time.** The desktop reads a relative snooze, such as `30m`, from when the agent asked, not
  when Komla connected. The companion says how long the command waited rather than when it was
  asked, so a host clock that is off doesn't shorten the snooze. A snooze that ran out meanwhile
  is rejected and dropped.
- **Which installation.** The outbox belongs to the installation attached to the terminal, the
  one its hooks go to. Other installations learn of a name or Trash change through SSH Workspace
  Sync when it is on.
- **Turned-off commands.** The desktop writes which commands the user turned off, with the message
  it gives for each, into the companion's config. The CLI refuses those at once rather than queue
  what the desktop would reject.
- **Listing.** `komla workspace list` lists the host's workspaces from their manifests, without
  tags, which only the desktop knows.
- **What doesn't queue.** Commands that answer with the desktop's data or act on its screen, such
  as `status`, `preview`, `open` and `komla agent launch` with `--preset`, `--mode` or
  `--project`, still need a connected desktop.

## Considered options

- Edit the workspace's manifest on the host and let SSH Workspace Sync merge it: rejected because
  the desktop merges another writer's changes only when sync is on, the manifest holds neither
  tags nor snoozes, and the CLI would apply rules, such as capability policy, that belong in the
  desktop.
- Have the desktop read the outbox when it connects: rejected because a command queued just after
  that read waits until the next connection, while the companion already polls its inbox and knows
  when its desktop answers.
- Keep failing: rejected because an agent's work outlives the connection, and Komla showing its
  state late is better than not at all.
