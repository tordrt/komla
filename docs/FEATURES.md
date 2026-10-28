# Komla Features

A short, user-facing list of what Komla does.
Behavior details belong in the code, its tests, and the domain docs such as `CLI.md`.

## Run Any AI Coding Agent

Presets ship for Claude Code, Codex, Antigravity CLI, OpenCode, Gemini CLI, Grok Build, Cursor CLI, GitHub Copilot CLI, Hermes Agent, Factory Droid, Amp, Mistral Vibe, Pi, Kiro CLI, Qwen Code, Auggie, Devin, and Goose, and any other agent that runs in a terminal can be added.
Each agent preset has configurable open, continue, and prompt commands, launch modes, and reasoning effort levels, managed in Settings → Agents.
Pick the agent, launch mode, and effort right in the new workspace dialog.

## Smart Notifications

Get alerted the moment an agent finishes, needs your input, or hits an error, without polling terminals.
Komla hooks into Claude Code, Codex, Antigravity CLI, and OpenCode, and other agents can set themselves up through agent-led setup.
Workspaces that need attention are badged in the sidebar, on terminal tabs, and on the macOS dock; hovering a badge shows the agent's message.
A workspace running several agents shows each agent's state on its sidebar card.
Notification sounds play once and are skipped when you're already looking at that terminal; the speaker in the status bar mutes them.
When Komla updates its hooks, Settings → Integrations & MCP offers to review and apply the update for each agent, on this computer and SSH hosts.

`komla notify "Review ready"` raises a notification from any script, and `komla notify -- npm run build` runs a command and notifies when it finishes or fails.

## Agent CLI and MCP

Onboarding finds the agent CLIs you have installed and offers one-click notification and MCP setup for each.
Every managed terminal, local or SSH, gets a `komla` CLI that agents use to launch agents in new workspaces or tabs, open browser previews, set workspace titles, and show status bar items.
An optional MCP adapter exposes the same operations to MCP clients.
Agents can also change Komla itself with `komla settings` (Quick Commands, Workspace Setup, status items, hooks, shortcuts, themes, automations); every change waits for you to confirm it.
The bundled Komla and Customize skills teach agents how to use the CLI.
`komla desktop run -- <command>` runs a GUI app from an SSH host on a virtual desktop you can view over VNC or in a browser tab.
Tips, at the right end of the status bar, walks through setup and demos.

## Git Worktree-Based Workspaces

Every workspace in a git project is backed by a real git worktree, so agents never interfere with each other and you can work on many branches at once.
Start from any local or remote branch, or open a workspace on an existing branch; new branches start from the latest origin version of their base.
AI can name the branch from your prompt.
Choose where the agent runs (this computer or an SSH host, which can be a VM or a container) in the same dialog.
Projects get a color or an icon found in the repository.

## At-a-Glance Project Overview

The sidebar groups workspaces by project, with git change counts, ahead/behind status, and agent state on every card.
Collapsed project headers summarize how many workspaces need input, hit an error, or are running.

## Status Bar

A thin bar along the bottom shows what needs a glance: the git menu and target branch, Open in editor, notes, a commit graph, agent activity, sound mute, keep awake, SSH host status and forwarded ports, resource usage, and available updates.
Agents can add their own items with `komla status set`, and `status-items.json` defines items backed by commands, with icons, colors, links, and popovers.
Right-click the bar to hide or customize items.

## Built-in Git GUI

Fetch, push, pull, rebase, merge from main, fast-forward the target branch, and switch branches from the git menu.
Browse, create, delete, and compare local and remote branches.
A built-in dialog handles SSH key passphrases and can remember them until Komla quits.
Settings → Git sets branch prefixes, what the ahead/behind counts do, and background fetching, with per-project overrides.

## Diff Viewer

A Monaco diff viewer with split and unified modes, a file sidebar, and controls to restore or discard files.
Write a commit message or ask AI for a draft from the diff, then commit staged or all changes.
Compare against uncommitted changes, the target branch, or any other branch.
Live follow mode jumps to the latest file your agent changed.

## Commit History

History shows the workspace's commits as a graph, local and over SSH, from HEAD or any branch.
Choose a commit to see its message, author, parents, refs, and changed files.

## Git Blame View

Toggle blame annotations in the editor gutter to see who changed each line and when, and jump to that commit.

## File History

Right-click a file to see every commit that touched it, following renames.

## File Explorer & Code Editor

Browse the file tree, create, rename, move, and delete files, and find files by name or content from the Command Center.
Moves and renames can be undone from their toast; local deletes go to the system Trash, while deletes in SSH workspaces are permanent.
Open files in the built-in Monaco editor, with an optional Vim mode.
When an agent rewrites the open file, the editor updates in place.
Markdown files open as rich text that saves back only what you changed.
Notes are per-workspace Markdown scratch documents for drafting prompts, kept outside the repository.

## Inline File Panels

Show a file tree and file preview beside your terminals and watch your agent's changes in real time.
Panels are resizable and remember their width per workspace.

## Terminal Tabs & Splits

Open multiple terminals per workspace as tabs, and split any tab into panes.
The + menu opens a terminal, a host or Local copy shell, an agent from any preset, or a Quick Command.
New browser and New note in the + menu open a browser or a note as a pane of its own.
Split Right and Split Down in a pane's right-click menu open a terminal beside it, and their arrows open a browser or a note there instead.
Replace With in that menu swaps a pane for a terminal, a browser, or a note.
A browser pane works like the browser panel, with tabs, the server picker, and SSH tunnels, and links that open a new window open as a tab in the same pane.
Drag tabs and panes to rearrange them, search terminal output, and enter multi-line input with Shift+Enter.
Terminals use xterm.js with WebGL, with clickable web links, file links, and OSC 8 hyperlinks.

Links to local dev servers open in a built-in browser panel with tabs, beside the terminals; other sites open in your default browser.
In SSH workspaces, Komla tunnels dev-server ports from the host automatically.
The browser's URL picker lists the servers your workspace's terminals are running.
File and folder links an agent prints open in a file viewer that shows images, PDFs, HTML, Markdown, media, and text, wherever the terminal runs.

## Project Setup Automation

Define setup steps per project: copy `.env` files, install dependencies, initialize submodules, launch agents, or run Quick Commands, when a workspace is created or every time it starts.
Setup runs in the background while the workspace opens, with progress and failures in the status bar.
The bundled project setup skill has your agent inspect the repository and propose a setup for you to confirm.

## SSH Remote Workspaces

Run agents, setup steps, and git operations in managed worktrees on a Linux or macOS SSH host.
Add hosts in one dialog, fill them in from `~/.ssh/config`, and let Komla check and set up the machine.
Terminals run in tmux on the host, so agents keep working when you disconnect, and you can reconnect without stopping them.
Browse, edit, and diff remote files in the built-in tree and editors.
A small companion on the host pushes git status as files change, instead of polling over SSH.

Resume SSH workspaces from another device: devices sync workspaces, tabs, and layout through the host, and notifications reach every connected device.
Agents can start new SSH workspaces on the host even while no device is connected.

For desktop, mobile, and other locally interactive apps, a Local copy syncs the remote source one way to this computer, so Quick Commands and terminals can run it locally.

## Remote Control

Use Komla's terminals from a phone's, tablet's or another computer's browser over your own Tailscale network. Remote control is an unstable alpha, and Settings → Remote says so. It requires Tailscale, signed in to the same account on this computer and on each device: Settings → Remote says so up front, offers the download while Tailscale is missing (even before remote control is on), and the pair dialog asks to connect the device to Tailscale first. Before you turn it on, it warns that macOS may ask for your password to let Komla use "Komla Safe Storage" in the keychain (and Linux desktops may ask to unlock the keyring), since the key devices use to recognize this computer is kept there; Windows doesn't ask. It is off until you turn it on there; its status line then shows the address devices pair at. Komla then serves the app from this computer; while it isn't on your tailnet yet, the status offers to publish it with Tailscale Serve (or to get Tailscale, if it isn't installed). SSH hosts comes next, then Devices, which lists the paired devices; Pair a device shows the pairing QR code in a dialog, which then offers direct access to SSH hosts that don't have it yet. The Tailscale address and port live under Network options at the bottom, which open by themselves only when Komla can't detect the address. Komla runs no relay of its own, and it won't run remote control while Tailscale Funnel is on for the Tailscale Serve route Komla set up, since Funnel would put it on the public internet. Pair a device by scanning a one-time QR code: it signs in with a passkey (such as Face ID or Touch ID) together with a key kept in that browser, and after a dropped connection it reconnects without the passkey for two minutes, up to eight hours after the passkey was last used. Paired devices can be renamed or removed, and removing one disconnects it. Komla takes down the Tailscale route it set up when you turn remote control off or quit, and restores it at the next launch while remote control is on. Allow access to this computer, on by default and shown once there is an SSH host (or while it is off), can be turned off so devices reach only SSH workspaces: this computer's own workspaces and terminals and Local copy shells disappear from the app and send no notifications, Quick Commands a project runs in the Local copy are refused, and a terminal open on a device lets go at once, while Komla still pairs devices, vouches for hosts and creates workspaces on SSH hosts. An option, off by default, keeps the computer awake while remote control is on.

The phone app can be added to the Home Screen and opens like an app. On an iPhone or iPad the Home Screen app keeps its own keys, separate from Safari, so it pairs itself from a pasted pairing link: the page a scanned code opens in Safari offers Copy pairing link with the steps, and a device that isn't paired yet takes a pasted link. It reconnects as soon as the phone wakes or changes network, without reloading: an open terminal keeps its screen and shows what it missed, and the terminal keeps the phone's size for a minute so a brief drop doesn't make it redraw. The app says so when this computer can't be reached. One device uses remote control at a time: the newest sign-in, on another device or in a new tab, takes over, and the old one says so and stops reconnecting. Workspaces are grouped into Needs you, Working, Idle and Stopped under the titles the sidebar shows, with filters for what needs you or is working and a search that matches words in any order, forgiving a typo in each, against the title, description, branch, project, folder, terminal and host names, what a workspace needs from you, and its last prompt, listing title matches first. A workspace opens to a tab for each of its terminals, a row of terminal keys (Esc, Tab, Shift-Tab, Ctrl, Alt, arrows, Ctrl-C, Ctrl-D) and a message box with dictation. Its + button opens a New tab sheet: tap an agent to start it in its last-used mode, or open a terminal, an agent with a prompt, or a Quick Command. New workspace and Agent with a prompt open bottom sheets where project, agent, mode and environment are picked from lists, with the prompt below; if Komla can't create the workspace, the sheet says why.

From the phone's Settings, a paired phone can turn on notifications for when an agent needs input, finishes or fails, either only while you're away from this computer (the default) or always. Tapping one opens that workspace. Komla sends them straight to the phone browser's own push service, encrypted so only the phone can read them, and never includes terminal output. Nothing is sent about a terminal the phone is showing. On an iPhone or iPad, notifications need the app on the Home Screen.

A paired device can also open an SSH host directly, so its running terminals stay reachable while this computer sleeps or would need a new SSH login (for example with an SSH agent that asks for a fingerprint); Settings recommends it. Turn it on for a host under SSH hosts in Settings → Remote, or when pairing: Komla sets up the Komla companion on the host and publishes it there with Tailscale Serve, so the host needs Tailscale, and Settings shows the address it's published at. The app's header then switches between each host and this computer, listed last. The app opens on a host: the one it last signed in to, or else the first one, and right after pairing it moves to a host as soon as one has direct access; it opens on this computer only once this computer is picked there, or a host turned the device away. When this computer can't be reached, the app offers the hosts instead, and while a host is connecting it offers the other hosts and then this computer; a notification always opens on this computer. A host shows its workspaces and lets the phone watch and type into their running terminals. It also creates workspaces, starts, restarts and stops them, and opens and closes agent and shell tabs, with this computer asleep: Komla gives the host its projects and agents (their commands for each launch mode) whenever it connects and they changed. A host offers only projects that already have a workspace there, since it can't clone without the SSH credentials this computer forwards. A workspace it creates starts only its agent, without the project's setup steps, and the next time Komla connects it adds the workspace like one an automation started; a restart there resumes the agent's last session in one new tab, as on this computer. Voice, notifications, Quick Commands and generated titles still need this computer. Komla tells a host which phones to trust over a connection it already has open and renews that every time it connects; a host trusts no phone once Komla hasn't reached it for a week, and a removed phone loses access to a host the next time Komla connects to it.

## Quick Commands

Save prompts and terminal commands you use often.
Saved Prompts support Markdown and tokens like `{{user_input}}` and `{{target_branch}}`.
Run them from the split button at the right end of the tab bar, the + menu, or a terminal's right-click menu; each workspace remembers its default.
Quick Commands can be scoped to a project and are edited in Settings → Quick Commands.

## Automations

Start an agent with the same prompt on a schedule from Settings → Automations: hourly, daily, weekly, or with a cron expression.
Each run gets a new workspace, so you can open it and continue the conversation.
Automations run on this computer while Komla is open, or on an SSH host through cron, so they run even while every device is off.
Templates cover dependency updates, CI fixes, issue triage, flaky test hunts, security audits, and daily summaries.

## Hooks

`hooks.json` runs your commands when an agent finishes, needs input, or a new workspace starts, with the workspace, agent, and message as environment variables.
Hooks run locally or on the SSH host and can call the `komla` CLI.

## Customizable Themes & Appearance

Choose Komla Dark (the default), Komla Light, or a well-known theme such as Catppuccin, Dracula, GitHub, Gruvbox, Nord, One Dark, Rosé Pine, Solarized, or Tokyo Night, and pick from 12 accent colors.
Match system appearance switches between a dark and a light theme with the system.
Ask an agent to design a custom theme from a description; Komla previews it before you apply it.
Terminals stay dark in every theme, with customizable ANSI colors, font, size, line height, and padding.
Changes apply instantly.

## Settings

Search Settings from the sidebar to jump to any setting.
Settings history lists every change to the settings files, whether made in Komla, by an agent, or by hand, and can revert any of them.

## Voice Dictation

Dictate prompts instead of typing them; speech is transcribed on this computer by a downloaded NVIDIA Parakeet model.
Double-tap Cmd (Ctrl on Windows and Linux) to start and stop recording, or use the mic in the new workspace dialog.

## Keyboard Shortcuts

Fully customizable shortcuts for workspaces, terminals, panes, files, and more.
Cmd+1–9 switches workspaces, and Cmd/Ctrl+Shift+A jumps to the next workspace that needs you.

## Multi-Window Support

Open multiple windows and move workspaces between them.

## Quick Create

Create a workspace with an auto-generated branch name straight from the project dropdown.

## Open a Folder

Open any folder on this computer as a workspace without adding a project first.

## Workspace Management

Archive, stop, or delete workspaces, one at a time or several at once.
Reorder workspaces by drag and drop, sort by recent activity, and filter the sidebar by project or host.
Set a custom title or let Komla name the workspace from its prompts.

## Dashboard Overview

An inbox of every workspace across your projects, with workspaces that need you first.
Each row shows what the agent asked, is working on, or was last told.
Stopped workspaces nobody touched in a week or a month gather in groups you can clear in one go, keeping ones with unsaved work.

## Command Center

Cmd+P (Ctrl+Shift+P on Windows and Linux) searches every workspace across windows, and every command and shortcut.
Its Files and Content modes search the open workspace's files by name or content, on the host for SSH workspaces.

## Auto-Updates

Komla updates itself with small differential downloads and asks before restarting while terminals are running.

## Cross-Platform

Available for macOS (Apple Silicon and Intel), Windows (x64 and ARM64), and Linux (x64 and ARM64 AppImage).

## One-Time Purchase

No subscription. The free tier gives you unlimited local workspaces and up to 4 SSH workspaces at once, with full functionality. A single one-time purchase unlocks unlimited SSH workspaces. Volume discounts available for teams.
