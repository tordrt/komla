---
status: accepted
---

# Select one of two execution adapters per workspace and Execution location

Komla will run Terminals and Setup steps through an Execution location module with exactly two
adapters: a local adapter and an SSH adapter. The adapter is chosen from the pair (workspace,
Execution location), not from `workspace.backend` alone, so an SSH workspace's Local copy runs
through the local adapter rooted at the Local copy, and only Workspace repository execution on an
SSH host uses the SSH adapter. The variance that justifies the seam is whether execution is backed
by a Managed Remote Terminal Session; a Local copy has none, so routing it through the SSH adapter
would duplicate local spawning there, and a third Local copy adapter would duplicate most of the
local one.

## Considered Options

- Choose per workspace backend, with the SSH adapter also owning its Local copy: rejected because
  the SSH adapter would carry a second, local execution path.
- Three adapters (local, SSH, Local copy): rejected because Local copy and local execution differ
  only in directory, sandboxing, and copy preparation.

## Consequences

The local adapter must not apply a workspace's sandbox method to Local copy execution, because
Local copy execution is never sandboxed. Git operations keep their separate Workspace repository
adapter seam, which is still chosen by `workspace.backend`.
