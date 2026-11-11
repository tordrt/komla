<p align="center">
  <a href="https://komla.dev"><img src="docs/brand/komla-mark.svg" alt="Komla" width="72" /></a>
</p>

<h1 align="center">Komla</h1>

<p align="center">
  Run AI coding agents in parallel, each in its own git worktree, on your computer or over SSH.
</p>

<p align="center">
  <a href="https://komla.dev/download"><strong>Download</strong></a> ·
  <a href="https://komla.dev">Website</a> ·
  <a href="docs/FEATURES.md">Features</a> ·
  <a href="docs/CLI.md">Komla CLI</a> ·
  <a href="CHANGELOG.md">Changelog</a>
</p>

<p align="center">
  <img src="docs/readme/hero.webp" alt="Komla with Claude Code and Codex working side by side, a sidebar of workspaces showing which agents are working, done or waiting for input, and a new task started from the new workspace dialog" width="960" />
</p>

Komla is a desktop app for macOS, Windows and Linux that runs AI coding agent CLIs side by side: Claude Code, Codex, OpenCode, Gemini CLI and any other agent that runs in a terminal. It is free and open source, with no account.

## Features

- **Any agent CLI:** Komla runs the agent's own CLI in a terminal, so its models, flags and slash commands all work. Presets ship for Claude Code, Codex, OpenCode, Antigravity CLI, Gemini CLI, Cursor CLI, GitHub Copilot CLI, Amp, Goose and more.
- **A worktree per task:** each workspace has its own git worktree, so agents don't touch each other's changes.
- **Agent status:** every workspace card shows whether its agent is working, done or waiting on you, with a sound and a notification when one needs you.
- **Generated titles:** Komla names each workspace from its prompts and the agents' replies, with a title, a short description and a branch name, so the sidebar reads as a list of tasks.
- **Komla CLI:** every terminal, local or on an SSH host, has `komla` for agents, hooks and scripts. Agents start other agents in new workspaces or tabs, read and steer them and wait for their results, open previews and raise notifications. Scripts tag a workspace, mark its card with its pull request or show progress such as "CI running". An MCP server exposes the same operations. [docs/CLI.md →](docs/CLI.md)
- **Custom status bar and sidebar panels:** add your own status bar items and sidebar panels, such as a usage-limit indicator or a panel of pull request checks, or describe one and your agent builds it with `komla`. You confirm each change.
- **Plugins and the Komla SDK:** a plugin bundles status bar items, sidebar panels and hooks into one integration that installs and turns off as one. Its code gets the Komla SDK, a typed TypeScript client for the CLI's operations: it follows events such as an agent finishing or a branch changing, runs commands in a workspace and feeds its panels. Scripts and hooks can use the SDK too. [SDK →](docs/CLI.md#sdk)
- **SSH hosts:** run workspaces on a Linux or macOS host, where agents keep working while your laptop sleeps. Diffs, previews and file transfer work as they do locally. [Remote workspaces →](https://komla.dev/remote-workspaces)
  - **Port forwarding:** a dev server on the host opens at `localhost` in one click, through a tunnel Komla makes.
  - **GUI apps:** `komla desktop run` runs an app on a virtual desktop on the host, which you view over VNC or in a browser tab.
  - **Local copy:** sync a workspace's source to this computer to run desktop and mobile apps locally.
- **Review and git:** a diff viewer, commit, pull, rebase and push, pull requests with their CI checks, commit history and blame.
- **Previews:** open a workspace's dev servers, pages and reports in a browser beside the agent.
- **Automations:** run an agent on a schedule, each run in its own workspace.
- **Remote control (alpha):** check on agents and answer them from your phone over your own Tailscale network.
- **And:** a file editor, offline voice dictation, a Command Center, hooks, Quick Commands, terminal splits, multiple windows and themes.

[docs/FEATURES.md](docs/FEATURES.md) has the full list. Comparisons: [Conductor](https://komla.dev/guides/conductor-vs-komla), [cmux](https://komla.dev/guides/cmux-vs-komla) and [the Codex app](https://komla.dev/guides/codex-app-vs-komla).

## Install

**[Download Komla](https://komla.dev/download)** for your platform:

| Platform | Builds | Notes |
| --- | --- | --- |
| macOS | Apple Silicon, Intel | Signed and notarized by Apple |
| Windows (beta) | x64, ARM64 | Zip with an installer inside |
| Linux (beta) | x64, ARM64 | AppImage; needs FUSE (`sudo apt install fuse libfuse2`) |

You need Git and an agent CLI, such as Claude Code or Codex. Add a git repo, describe a task and pick the agent to run it.

Komla updates itself. On Linux that works when you run the AppImage file itself.

## Build from source

You need Node.js 22, npm 11 and the build tools for the native modules:

- **macOS:** Xcode Command Line Tools
- **Linux:** `build-essential`, Python, `libx11-dev` and `libxkbfile-dev`
- **Windows:** Visual Studio Build Tools; run the commands from Git Bash

Rust ([rustup](https://rustup.rs)) is optional. It builds the `komla` CLI and the companion that SSH workspaces use, and `npm test` skips their tests without it.

```bash
npm install
npm run dev
```

`npm run dev` keeps its data in `~/.komla-dev`, apart from an installed Komla. To package an installer, follow [Manual Platform Builds](docs/RELEASING.md#manual-platform-builds).

Builds from source don't update themselves, and their AI helpers need a custom endpoint under Settings → General → AI utilities.

## Privacy

Agents talk to their own APIs, as they would in any terminal. Komla's telemetry and AI helpers send this:

- **Telemetry:** an anonymous install ping, a daily heartbeat (app version, OS and agent, no install ID) and crash reports, all on by default. Usage analytics, tied to a random install ID, are opt-in. Settings → General → Privacy sets the level and has the switch for crash reports. `DO_NOT_TRACK=1` turns all of it off when it is set in the environment Komla starts in, such as a terminal you launch it from; a shell profile doesn't reach an app opened from the Dock or Start menu. [docs/ANALYTICS.md](docs/ANALYTICS.md) lists every event.
- **AI helpers:** two optional helpers send text through OpenRouter to Google, OpenAI or Mistral, which don't train on it, and Komla doesn't store it. Turn either off or use your own key in settings.
  - **Workspace names:** a workspace's prompts and the agents' replies to them, to name it. On by default.
  - **Commit messages:** your staged diff, only when you click generate.

## Contributing

Bug reports and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first. Questions and ideas go to [GitHub issues](https://github.com/tordrt/komla/issues) or [komla.dev/contact](https://komla.dev/contact).

## License

[MIT](LICENSE), copyright © 2026 Tafjord Invest AS. The license covers the code, not the Komla name or logo: a modified version you distribute needs a different name. See [TRADEMARK.md](TRADEMARK.md).
