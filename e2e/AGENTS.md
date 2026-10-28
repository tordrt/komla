# AGENTS.md

## Project Overview

Playwright end-to-end tests that launch the **built** Electron app and drive its UI. Separate from `tests/` (Vitest unit tests that mock Electron).

## Commands

From the repo root:

```bash
npm run test:e2e   # Builds first, then runs full suite
npx playwright test --config e2e/playwright.config.ts path/to/spec.ts   # Single file (build must be fresh)
npm run screenshots          # Regenerate all screenshot tests
npm run screenshots:process  # Run scripts/process-screenshots.mjs to produce marketing variants
npm run screenshots:landing  # Landing-page screenshots + processing for the default (Claude) agent
```

**Build gotcha:** the launcher runs `out/main/index.js`, so `npm run build` must have completed. `test:e2e` does this automatically; ad-hoc `playwright test` runs do not.

## Conventions

- **Fixtures (`electron-app.ts`):** always import `test` and `expect` from `./electron-app`, not `@playwright/test` directly. You get `electronApp` (the `ElectronApplication`) and `appWindow` (first `Page`), with sandbox setup and teardown built in. Keep app launch, sandbox cleanup, and `KOMLA_DATA_DIR` setup in the shared fixture.
- **Seeding:** override `seedSandbox` and call `seedDefaultProject()` when a test needs the standard project and git-initialized repository. Give each file a distinct `branchPrefix`; use `initialFile` when the seed commit needs a tracked file. Existing examples in `git-diff.test.ts` and the fixture are the source of truth.
- **Sandbox:** `SANDBOX_DIR` (`/tmp/komla-e2e-<checkout hash>`, resolved) — wiped before every test. Each checkout has its own sandbox and Electron profile, so parallel worktrees' e2e runs don't collide: launch the app with `ELECTRON_ARGS` and name other sandboxes with `e2eSandboxDir()`. The screenshot, demo and video fixtures still use shared sandboxes and the default profile, so run those one at a time. `NODE_ENV=test` and `KOMLA_DATA_DIR` are set for the launched app. Assume no prior state.
- **testMatch is broad:** files ending in `.test.ts`, `.spec.ts`, `.screenshot.ts`, `.demo.ts`, `.video.ts` all run. Use the suffix that matches intent.
- **Runners:** tests share the sandbox directory, so preserve the serial runner configuration.
- **Helpers:** `agent-profiles.ts`, `demo-fixtures.ts`, `screenshot-fixtures.ts` — prefer these over re-implementing setup.

## Screenshots & demos

- `screenshots/` and `demos/` produce marketing assets consumed by the landing page via `scripts/process-screenshots.mjs`, which writes to `screenshots/` in the site's `public/` folder. The site lives outside this repo; set `KOMLA_SITE_PUBLIC_DIR` to its `public/` folder.
- Editing them changes what's shipped on the marketing site. Regenerate with `npm run screenshots:landing` (or for another agent: `AGENT=codex npm run screenshots:landing`, also `gemini` and `opencode`).

## Landing videos

`videos/*.video.ts` record the landing-page videos without manual screen recording. `npm run videos` builds, records every spec, and renders MP4s plus WebP posters into `videos/output/` (gitignored); `node scripts/render-videos.mjs --publish` copies the renders into `$KOMLA_SITE_PUBLIC_DIR/screenshots/`, replacing the shipped files of the same name. Rerun one with `npx playwright test --config e2e/playwright.config.ts e2e/videos/<name>.video.ts && node scripts/render-videos.mjs <name>` (after `npm run build`).

- **Requirements:** macOS for the shipped renders, which draw macOS traffic lights and ⌘ badges over the recording; Linux under `xvfb-run` works for dry runs. Every video runs on a Docker SSH host, so they also need Docker Desktop and the Linux remote companion for the container's architecture, e.g. `npm run build:native:matrix -- aarch64-unknown-linux-musl`. Worlds with `dictation` (the new workspace video) need that voice model downloaded in Komla, which keeps it in `~/.komla/models`.
- **World:** a spec declares projects and workspaces via `videoTest.use({ world })`; `videos/worlds.ts` holds the shared demo project and `DEVBOX`, the SSH host the landing videos use. With `sshHost`, `videos/ssh-host.ts` starts a Docker SSH host and Komla itself creates every workspace on it; `spawnedAgents` gives scenes to branches agents create mid-video.
- **Agent:** workspaces run `videos/scripted-agent.mjs`, a Claude Code (or, with `look: 'codex'`, Codex) look-alike that plays the scene for its branch: it edits the worktree for real, starts `videos/dev-server.mjs`, calls Komla's MCP tools and settings API, and posts the same notify hooks as the CLI. Presets run it through wrappers named like the real CLIs, and shells use a plain prompt (from the sandbox locally, `videos/ssh-host/bashrc` on the SSH host), so nothing from the recording machine shows. Terminal text is canvas-rendered, so wait on `waitForAgentTurn()` or `waitForAgentAt()`, not on text, and release `{ waitFor }` events with `director.cue()`.
- **Director:** drive the UI through `director` (`click`, `moveTo`, `type`, `press`, `camera`, `speed`, `poster`) so the timeline knows where the cursor, shortcut badges, zoom and speed-ups go; only `director.start()` to `director.finish()` is in the video. Do setup that would show loading states, such as the first Monaco load, before `start()`. A video can span a quit: `director.cut(caption)` ends a take before the app closes, `relaunchApp()` opens Komla again on the same sandbox, and `director.resume()` starts the next take; the renderer joins takes with the caption on a dark frame.
- **Rendering:** `scripts/render-videos.mjs` draws the cursor, click ripples, shortcut badges and traffic lights after recording; never inject them into the app. Native views over the window, such as the browser preview, are missing from the page screencast, so the recorder captures them as layers that the renderer composites back in.
