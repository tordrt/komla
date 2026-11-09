# Changelog

## [1.1.0]

### New

- **Pop the prompt draft out over other apps.** The prompt draft can float in a window of its own that stays on top of your browser or any other app, so you can write a prompt about what you're looking at without switching back and forth. Its shortcut shows and hides it, and "Put back in Komla" brings the text back.
- **Start a workspace from any app.** Give "New Workspace from any app" keys in Settings > Shortcuts, and pressing them anywhere brings Komla forward with New Workspace open and the prompt ready to type. It ships unbound, since a system-wide shortcut takes those keys from every other app.
- **See the commits your branch is behind by.** The commit graph in the status bar now shows the commits on the target branch that your branch doesn't have yet, above your own. Click one to open its diff in History.

### Improvements

- The globe button lists your dev servers faster, most noticeably in SSH workspaces and when several workspaces share a machine.
- A remote workspace shows its cloud icon from the moment it starts setting up.
- The sidebar always lists workspaces with the tighter compact spacing, so the setting for it is gone.
- The macOS installer now shows a "Drag Komla into Applications" background, with an arrow from the app to the Applications folder.
- A workspace card keeps a small spinner for work still under way, such as running tests, even while a notification badge or a busy agent holds its title row.
- Dragging a workspace or project group near the top or bottom of the sidebar scrolls the list, so you can reach a spot that's out of view without dropping it first.
- When an agent uses `komla send` to type into another terminal, Komla now asks you first, showing the exact text and where it's going. A page-steered agent can no longer run commands in your shell tabs or answer another agent's prompt on its own.
- Launch mode pickers are less crowded: "Dangerously skip permissions" is now called YOLO for Claude Code and Amp, as it already was for other agents. It's still red and passes the same flags.

### Fixes

- Switching to another workspace right after trashing one no longer lags while the trashed workspace's files are deleted.
- Escape closes the file preview while you're typing in the Markdown editor or a note.
- Opening a diff of a file containing Unicode line or paragraph separators no longer pops up a dialog offering to remove them.
- The files list no longer shows files outside the workspace that have since been deleted.
- A status item an agent on an SSH host sets with a localhost link now opens through a tunnel to that host, instead of a page that isn't there on your own computer.
- With more than one Komla attached to the same SSH host, a Done you've seen in one no longer shows as unread in the others.

## [1.0.0]

Komla is a desktop app for running many AI coding agents in parallel, each in its own workspace, with one place to see which of them need you. This is the first release under the Komla name, and it is open source under the MIT License.
