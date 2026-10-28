# Komla

Run coding agents in parallel, and stay in control.

Komla is a desktop app for running AI coding agent CLIs side by side. Each workspace gets its own git worktree, so agents never step on each other's changes, and Komla shows at a glance which agent is working, which one is done and which one needs you.

![Komla running several coding agents in parallel](https://komla.dev/screenshots/landing-hero-dark-1280w.png)

**[Download for macOS, Windows and Linux](https://komla.dev/download)**

## Features

- **Any agent that runs in a terminal:** Claude Code, Codex CLI, Gemini CLI, OpenCode, Amp, Kiro CLI and more, or your own command.
- **Isolated workspaces:** each workspace is a git worktree or a folder, with its own tabs, split panes and terminals.
- **Notifications:** know the moment an agent finishes or needs input, with badges in the sidebar and the dock.
- **Review and ship in the app:** file tree, code editor, diffs, history, blame, commit and push.
- **SSH workspaces** on your own servers.

[docs/FEATURES.md](docs/FEATURES.md) describes everything Komla does.

Komla is free with up to 4 workspaces running at once. A [license](https://komla.dev/pricing) unlocks unlimited workspaces and pays for Komla's development.

## Build from source

You need Node.js 22 and npm 11, plus the native build tools for `node-pty` and `keyboard-layout`: the Xcode Command Line Tools on macOS, `build-essential`, Python, `libx11-dev` and `libxkbfile-dev` on Linux, or the Visual Studio Build Tools on Windows. On Windows, run the commands from Git Bash.

Rust ([rustup](https://rustup.rs)) is optional. It builds the `komla` CLI and the companion that SSH workspaces use (`npm run dev -- --companion`) and runs their tests, which `npm test` skips without it.

```bash
npm install
npm run dev
```

`npm run dev` keeps its data in `~/.komla-dev`, so it never touches an installed Komla. To package an installer, follow [Manual Platform Builds](docs/RELEASING.md#manual-platform-builds). Packaging bundles the Komla CLI for every platform, and its macOS builds need a Mac.

Builds from source don't update themselves. Komla's AI helpers, which name workspaces and write commit messages, work in them once you choose a custom endpoint under Settings → General → AI utilities.

## Privacy

By default Komla sends an anonymous install ping and a daily heartbeat (app version, OS, agent and license tier, no install ID), plus crash reports. Usage analytics tied to a random install ID are opt-in. Settings → General → Privacy changes either. `DO_NOT_TRACK=1` turns all of it off when it's set in the environment Komla starts in, such as a terminal you launch it from; a shell profile doesn't reach an app opened from the Dock or Start menu. [docs/ANALYTICS.md](docs/ANALYTICS.md) lists every event.

## Contributing

Bug reports and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before you start.

## License

Copyright © 2026 Tafjord Invest AS

Komla is free software: you can redistribute it and modify it under the terms of the [GNU Affero General Public License, version 3](LICENSE).

The license covers the code, not the Komla name or logo. If you distribute a modified version, give it a different name. [TRADEMARK.md](TRADEMARK.md) has the details.
