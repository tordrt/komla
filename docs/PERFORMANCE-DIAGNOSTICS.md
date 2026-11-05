# Performance Diagnostics

This document describes Komla main-process performance diagnostics.

## Purpose

`DiagnosticsService` emits periodic snapshots to help diagnose sluggishness and long-running instability.

Snapshots include:

- Main process memory (`rss`, heap usage, heap limit, external memory)
- Event loop lag (`p95`, `max`)
- Electron process metrics (`app.getAppMetrics()`), including top memory consumers
- App pressure counters (windows, workspaces, PTYs, watchers, background processes)

## Enable / Disable

- Enabled by default by `npm run dev` and all `dev:sandbox*` commands; set
  `KOMLA_DIAGNOSTICS=0` to explicitly disable for these commands.
- The `preview` and `preview:*` commands explicitly enable diagnostics.
- Otherwise disabled by default; set `KOMLA_DIAGNOSTICS=1` to enable.

## Interval

- Configure with `KOMLA_DIAGNOSTICS_INTERVAL_MS`
- Minimum: `5000` ms
- Default: `30000` ms

Example:

```bash
KOMLA_DIAGNOSTICS=1 KOMLA_DIAGNOSTICS_INTERVAL_MS=10000 npm run preview
```

## Where to Look

Look for `DiagnosticsService` log entries with message:

- `Performance snapshot`

Automatic warnings are logged for:

- Rapid memory growth between snapshots
- High event-loop lag
- Large PTY output buffers

## Related Files

- `src/main/services/diagnostics.service.ts`
- `src/main/index.ts`

## Startup Time

`npm run startup-time` builds the app, then launches it repeatedly on a seeded sandbox (a
project with six worktree workspaces) and prints the median, minimum, and p90 time from spawning
Electron to each startup milestone, ending with the sidebar's workspace cards drawn. Pass options
after `--`:

```bash
npm run startup-time -- --save-baseline     # builds, then keeps a copy of out/
# change something, then:
npm run startup-time -- --runs 20 --baseline .cache/startup-baseline
```

`--baseline` alternates launches between the two builds, so load from other work on the machine
reaches both alike. It also takes a packaged executable, as `--app` does for the build measured.

`node scripts/measure-startup.mjs --help` lists every option; it measures the existing `out/`
build without rebuilding. On Linux without a display it runs under `xvfb-run`. Timings on a
shared machine are noisy, so compare medians of many runs, and alternate builds when a change is
small.

The main process prints its milestones to stdout with `KOMLA_STARTUP_TIMING=1`
(`src/main/lib/startup-timing.ts`); without it, marking does nothing. The renderer's are read
over the DevTools protocol. To see what the main process spends its startup on, profile it with
`NODE_OPTIONS="--cpu-prof --cpu-prof-dir=<dir>"` and quit the app normally, so the profile is
written.

## SSH Local Copy Sync Triggers

`KOMLA_DIAGNOSTICS=1` also enables sync-trigger diagnostics. Rebuild the remote
companion along with the desktop app when testing changes to these diagnostics.

`WorkspaceStatusService` logs whether a reconnect refresh, or a snapshot that
refresh superseded, requested a sync.

Entries for each snapshot and sync request are logged at debug level, so they
also need `LOG_LEVEL=debug`. Desktop `LocalCopyService` entries identify each
request as `prepare`, `remote-change`, `initial-sync`, or `retry`, and show
whether it starts a sync, waits for one, or queues a follow-up.
`WorkspaceStatusService` logs each accepted SSH snapshot's timestamp, state hash,
and `workingTreeChanged` flag.

These entries appear in the development console, or in `logs/komla.log` for
packaged builds.

The setting is also sent to the remote companion. Its tmux pane emits
`[komla-sync ...]` lines containing the workspace ID, timestamp, triggering
watcher event (including paths and event type), classification, watcher reloads,
queue overflows, and emitted snapshot sequence/hash. Events filtered out by the
watcher do not produce trace lines. No file contents are logged.

Inspect the companion's pane on the SSH host, using its installation key:

```bash
tmux -L komla-companion-<installationKey> capture-pane -p -S -1000 -t =komla-companion-<installationKey>
```

The socket/session name and installation key are recorded in the companion's
config under `<remoteBasePath>/helpers/companion/`. With `LOG_LEVEL=debug`,
compare snapshot hashes and timestamps between the remote trace and desktop logs
to identify which events requested transfers. Diagnostics do not change watcher filtering or sync behavior.
