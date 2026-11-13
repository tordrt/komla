# Changelog

## [1.2.0]

### New

- **Scratch workspaces.** Start an agent for a quick one-off, like a throwaway script or trying an idea, without picking a project or making a folder first. New Scratch Workspace is in Quick create, the sidebar's Scratch group and the New Workspace dialog's project list. Its folder is cleaned up when the workspace is deleted for good, unless you choose Keep Folder.
- **File tree actions in the header.** A new button in the file tree's header opens Expand All, Collapse All and Rollback All Changes, so you no longer have to right-click a sliver of empty space to find them.

### Improvements

- Switching workspaces is much snappier with many terminals open. Clicking a workspace highlights it at once, terminals in hidden workspaces no longer redraw in the background, and the occasional second-long freeze when switching is gone.
- Opening, creating or restarting a workspace no longer briefly freezes the window when lots of workspaces are open.
- Stepping onto an SSH workspace after a restart, sleep or dropped connection opens it right away and connects in the background, instead of leaving the previous workspace on screen.
- Workspaces started in the background no longer resize their split panes' terminals twice the first time you open them.
- The workspace card no longer shows a "Connecting…" spinner.
- A workspace started with `komla launch`, from your phone or by an automation, now shows its project in the sidebar even if you'd hidden it, so you no longer have to search for it.
- A workspace you opened from the Working shelf moves back into its group as soon as its agent stops, instead of only once you switch away.

### Fixes

- Quitting Komla right after opening a workspace no longer sometimes leaves it running in the background.
- A request to review settings changes or allow a message is no longer cancelled by a stray Enter or Escape while you're typing to an agent. Only the Cancel button cancels it.
- An agent on an SSH host no longer keeps spinning after it finished while the connection was down.
- An SSH workspace launched with a long prompt now starts its agent, instead of appearing without one.
- An SSH workspace's Git status is up to date right after a commit, land or push, including on hosts with many workspaces, instead of showing it a commit ahead.
- After switching environment in the New Workspace dialog, Enter now launches the workspace instead of switching the environment back.
- A workspace moved to the Trash is always stopped first, so the Trash no longer holds workspaces that are still running.
- An SSH workspace that's missing from its host no longer shows "Failed to create SSH workspace" again every time it changes.

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
