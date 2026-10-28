# AGENTS.md

## Project Model

Komla is an Electron desktop app for running multiple AI coding agent CLIs in parallel. A workspace is backed by a git worktree or an arbitrary directory; each workspace contains tabs, each tab contains a pane tree, and each pane owns an ephemeral terminal PTY. Terminals are not persisted across restarts.

## Working Loop

- **Red-green:** for a bug, first reproduce it with a failing test. For validation, cover invalid inputs. For a refactor, establish the relevant baseline before editing.
- **Scope:** report unrelated problems without changing them. Remove only dead code created by your own change.

## Verification

Before finishing, run every check the changed scopes require. Run commands from the repository root unless scoped instructions say otherwise. Use `npm run` as the authoritative script list.

- Desktop, shared, or root tooling changes: run `npm test`. It type-checks `src/` first; `npm run typecheck` runs only that step.
- Changes under `src/`: also run `npm run lint`.
- Changes under `packages/` or `remote-web/`: also run that workspace's own `npm test`.
- End-to-end behavior: follow `e2e/AGENTS.md`; `npm run test:e2e` builds before running Playwright.
- Release validation or a broad cross-process change: run `npm run smoke-test`.

Run `npm install` after dependency changes. Its postinstall flow rebuilds native modules such as `node-pty`.

In a git worktree, `node_modules` is the worktree's own clone (hardlinks, or copy-on-write on macOS) of a store keyed by `package-lock.json` that sibling worktrees share at `../_deps/`. Dev, test, and build scripts re-clone it when the lockfile changes, so npm installs in one worktree never reach another. On Linux and Windows the clone shares files with the store: don't edit files under `node_modules` in place. See `scripts/worktree-deps.cjs`.

Add renderer-only packages with `npm install -D`: Vite bundles them, while everything in `dependencies` ships again in the installer's `node_modules`. Packages the main process or preload imports stay in `dependencies`. A devDependency imported there is bundled into `out/`, which breaks native addons and packages that read their own files at runtime.

## Architecture

- `src/main/`: Electron main process; owns PTYs, git operations, IPC handlers, and domain services.
- `src/preload/index.ts`: typed `contextBridge` surface exposed as `window.api`.
- `src/renderer/`: React UI and Zustand state.
- `src/shared/`: contracts and constants shared across processes.
- `src/main/services/`: one service per domain; `git.service.ts` is the facade over modular git subservices.
- `src/main/ipc/handlers/`: main-process handlers organized by domain. New renderer-to-main operations must update the IPC constant, schema, handler, preload surface, and registration.

Komla runs on macOS, Windows, and Linux. Treat filesystem paths, shell execution, process spawning, and native modules as cross-platform boundaries.

## Scoped Instructions

- **Remote control:** before changing `remote-web/`, `packages/remote-protocol/`, or `src/main/services/remote-control-*`, read `remote-web/AGENTS.md`.
- **End-to-end tests or screenshots:** before changing `e2e/`, read `e2e/AGENTS.md`.

## Context Pointers

- **Domain language:** `GLOSSARY.md` defines Komla's terms and the names to avoid. Use them in code, UI copy, and conversation; read it before naming a concept or writing user-facing copy.
- **Decisions:** `docs/adr/` records why the remote companion, execution locations, SSH exec channel, settings management API, and phone access are designed as they are. Read the relevant ADR before changing one of them.
- **Feature list:** `docs/FEATURES.md` is a short, user-facing summary, not a spec. Edit it only when asked.
- **CLI and MCP:** read `docs/CLI.md` before changing `komla` CLI commands, MCP tools, HTTP routes, discovery, or notification-port behavior.
- **Analytics:** read `docs/ANALYTICS.md` before adding, removing, or renaming app telemetry events.
- **Performance:** read `docs/PERFORMANCE-DIAGNOSTICS.md` before changing diagnostics or profiling instrumentation.
- **Release:** follow `docs/RELEASING.md` for a release.
- **Linux testing:** read `docs/LINUX-TESTING.md` before running Komla on a Linux desktop, virtual or VM, for manual testing.
