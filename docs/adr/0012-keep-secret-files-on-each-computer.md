---
status: accepted
---

# Keep Secret files' contents on each computer, and write them where a step runs

Workspaces need ignored files such as `.env` that hold secrets. Workspace Setup could only copy
one with a command: `cp "{{localProjectPath}}/.env" .env`, or `scp` to an SSH host. That needs a
plaintext `.env` in the project's own folder on this computer. It doesn't help a project added from
a repository URL, which has none, or another computer. And Workspace Setup goes into the Project
manifest that every Komla installation reads from an SSH host, so a secret can't go in a step's
command.

A Secret file is a Setup step (`kind: "secret-file"`) that names a `file`, a path inside where the
step runs. Its contents live apart from the step, in `settings/secret-files.json`, by project and
step id. The OS keychain encrypts them through Electron's `safeStorage`, as it does Plugin
Settings' secrets. On a computer without a keychain, such as Linux without a keyring, where
`safeStorage` would only offer `basic_text`, the contents stay unencrypted in that file, readable by
the user alone. Settings says so. That's no worse than the `.env` the copy step needs. The names
each file sets are kept readable beside them, so Settings can list them without the keychain
prompting. Settings sends new contents one way and never gets them back. The renderer only holds
them in the project's draft until it saves, and they save only for a step that's already saved, so
contents never outlive a step that never was. Removing the step or its project in Komla removes
them. A step that goes from `projects.json` otherwise, as when it's edited by hand, leaves its
contents unused rather than lost to a mistaken edit.

Komla writes the file itself, as a background step, so the contents appear in no command line,
terminal, scrollback or Setup activity output. In the Workspace repository on this computer or in
a Local copy, it writes a temporary file readable by the user alone and renames it over the target.
On an SSH host, it sends the contents as the stdin of a POSIX command, over the SSH connection
Komla already has, and that command does the same there. Either way, a link at the path is replaced
rather than written through, and a folder there is left alone. In a Workspace repository it then
asks Git whether it ignores the file, and the step's activity warns when Git doesn't, since the
file could otherwise be committed.

The Project manifest carries the step, its `file` and its destination, never the contents.
Another installation that copies the step has none for it until its user adds them, and until
then the step fails, saying so. A manifest read from a host is untrusted. So the path must be
relative, without `..` or a `.git` segment, which is checked again as the step runs. A host that
moves a Secret file to a destination it can read changes the step, which the user approves like any
other change to Workspace Setup, and the approval names the file and where it's written. Agents
can add, edit or remove a Secret file step through `komla settings`, with the user's confirmation,
but can't read or set its contents through any Komla API.

What it doesn't protect: once written, the file belongs to the workspace, and anything running
there as the user can read it, agents included. Settings says so beside the contents. A Secret file
keeps secrets out of the repository's own folder, the project's settings, the Project manifest and
command lines. It doesn't keep them from the agent the workspace runs. A workspace that the Komla
Remote Companion creates on a host while Komla is away runs no Setup steps (ADR 0006), so it gets no
Secret file. A Komla installation too old to know the kind can't read a Project manifest that has
one, as with the browser and note kinds before it.

Considered: injecting secrets as environment variables into Setup steps' and Quick Commands'
terminals. They'd reach the agent all the same, through `env` or `/proc/<pid>/environ`, and they'd
leak into scrollback and phone streams more readily than a file does. Substituting `{{secret:NAME}}`
into commands: that puts them in command lines and shell history. A vault integration such as
1Password or Doppler: `op run` and `doppler run` already work as a Setup step's command.
