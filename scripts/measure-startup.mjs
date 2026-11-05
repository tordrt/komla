#!/usr/bin/env node
// Measures how long the built app (out/) takes to start, from spawning Electron to a usable
// window: the sidebar's workspace cards drawn. Komla opens no workspace at launch.
//
//   npm run startup-time -- [options]       (builds first)
//   node scripts/measure-startup.mjs [options]   (measures the existing out/ build)
//
//   --runs <n>         Measured launches (default 10).
//   --warmup <n>       Launches before those, not counted (default 1).
//   --workspaces <n>   Worktree workspaces to seed the sandbox with (default 6).
//   --reseed           Seed the sandbox again even when an earlier run left one.
//   --json <file>      Write every run's milestones and the summary to <file>.
//   --compare <file>   Print each milestone's median next to the one in an earlier --json file.
//   --save-baseline    Copy out/ to .cache/startup-baseline, for --baseline after a change.
//   --baseline <path>  Alternate launches with this build, a copy of out/ inside the checkout
//                      (so it finds node_modules) or a packaged executable, and print its
//                      medians next to these. Alternating keeps machine load out of the change.
//   --keep-going       Don't stop at the first run that misses a milestone.
//   --app <path>       Launch this packaged Komla executable instead of out/ with Electron. A
//                      packaged build doesn't run Electron's default app first, as out/ does.
//
// On Linux without a display it re-runs itself under xvfb-run. Timings on a shared machine are
// noisy: compare medians of several runs, and alternate before/after builds.
//
// Electron is spawned directly rather than through Playwright's launcher, whose loader holds
// the main process until the debugger attaches. The main process prints its milestones with
// KOMLA_STARTUP_TIMING=1 (src/main/lib/startup-timing.ts); the renderer's are recorded by a
// script added to the page over the DevTools protocol.
import { spawn, execFileSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'out');
const SAVED_BASELINE_DIR = path.join(ROOT, '.cache', 'startup-baseline');

function parseArgs(argv) {
  const options = {
    runs: 10,
    warmup: 1,
    workspaces: 6,
    reseed: false,
    json: null,
    compare: null,
    keepGoing: false,
    app: null,
    saveBaseline: false,
    baseline: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === '--runs') options.runs = Number(value());
    else if (arg === '--warmup') options.warmup = Number(value());
    else if (arg === '--workspaces') options.workspaces = Number(value());
    else if (arg === '--reseed') options.reseed = true;
    else if (arg === '--json') options.json = path.resolve(value());
    else if (arg === '--compare') options.compare = path.resolve(value());
    else if (arg === '--keep-going') options.keepGoing = true;
    else if (arg === '--app') options.app = path.resolve(value());
    else if (arg === '--save-baseline') options.saveBaseline = true;
    else if (arg === '--baseline') options.baseline = path.resolve(value());
    else if (arg === '--help' || arg === '-h') {
      const header = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\nimport ')[0];
      console.log(header.replace(/^#!.*\n/, '').replace(/^\/\/ ?/gm, ''));
      process.exit(0);
    } else throw new Error(`Unknown option ${arg}`);
  }
  for (const key of ['runs', 'warmup', 'workspaces']) {
    if (!Number.isInteger(options[key]) || options[key] < 0) {
      throw new Error(`--${key} needs a whole number`);
    }
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));

/** A directory only this checkout uses, so runs in other worktrees can't collide with it. */
function checkoutDir(name) {
  const checkout = createHash('sha256').update(ROOT).digest('hex').slice(0, 8);
  const tmp = process.platform === 'win32' ? os.tmpdir() : fs.realpathSync('/tmp');
  return path.join(tmp, `${name}-${checkout}`);
}

const SANDBOX_DIR = checkoutDir('komla-startup');
const PROFILE_DIR = checkoutDir('komla-startup-profile');
const SEEDED_MARKER = path.join(SANDBOX_DIR, '.seeded');
const NOTIFICATION_PORT =
  40_000 + (Number.parseInt(createHash('sha256').update(ROOT).digest('hex').slice(0, 4), 16) % 10_000);

// Milestones in the order they happen, with what they mean.
const MILESTONES = [
  ['main:process-start', 'Node started in the main process'],
  ['main:bundle-start', 'main bundle starts evaluating'],
  ['main:modules-loaded', "main bundle's modules evaluated"],
  ['main:app-ready', 'Electron app ready'],
  ['main:window-created', 'BrowserWindow created'],
  ['main:ready-handler-done', 'main startup code returned'],
  ['renderer:navigation-start', 'renderer page navigation starts'],
  ['renderer:modules-loaded', "renderer's modules evaluated"],
  ['renderer:first-contentful-paint', 'first contentful paint'],
  ['main:ready-to-show', 'window shown'],
  ['renderer:app-shell', 'app shell drawn (past Loading...)'],
  ['renderer:sidebar-cards', 'workspace cards drawn'],
];
const FINAL_MILESTONES = ['renderer:sidebar-cards'];

// Runs in the renderer page before its own scripts. Each milestone is taken in the animation
// frame after its condition holds, which is about when it reaches the screen.
const RENDERER_PROBE = `(() => {
  if (window.top !== window || !location.pathname.endsWith('/renderer/index.html')) return;
  if (window.__komlaStartupProbe) return;
  const marks = (window.__komlaStartupProbe = { installed: true, late: [] });
  const now = () => performance.timeOrigin + performance.now();
  marks['renderer:navigation-start'] = performance.timeOrigin;
  const checks = {
    'renderer:app-shell': () => document.querySelector('[data-testid="work-area"]'),
    'renderer:sidebar-cards': () => document.querySelector('.workspace-card-hover'),
  };
  for (const [name, check] of Object.entries(checks)) {
    if (check()) marks.late.push(name);
  }
  const tick = () => {
    for (const [name, check] of Object.entries(checks)) {
      if (!(name in marks) && check()) marks[name] = now();
    }
    if (Object.keys(checks).some((name) => !(name in marks))) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();`;

function electronEnv(extra = {}) {
  const env = { ...process.env, ...extra, KOMLA_DATA_DIR: SANDBOX_DIR };
  // Variables a Komla terminal sets would point the app at the Komla this runs in.
  for (const key of Object.keys(env)) {
    if (key.startsWith('KOMLA_') && !(key in extra) && key !== 'KOMLA_DATA_DIR') delete env[key];
  }
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  delete env.ELECTRON_RENDERER_URL;
  return env;
}

/** A DevTools protocol connection to the browser, with flat sessions for its pages. */
async function connectCdp(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error(`Could not connect to ${url}`)), {
      once: true,
    });
  });
  let nextId = 1;
  const pending = new Map();
  const listeners = new Set();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== undefined) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) request?.reject(new Error(message.error.message));
      else request?.resolve(message.result);
    } else {
      for (const listener of listeners) listener(message);
    }
  });
  socket.addEventListener('close', () => {
    for (const request of pending.values()) request.reject(new Error('DevTools disconnected'));
    pending.clear();
  });
  return {
    send(method, params = {}, sessionId) {
      const id = nextId++;
      socket.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    on(listener) {
      listeners.add(listener);
    },
    close() {
      socket.close();
    },
  };
}

/**
 * Spawns Electron and attaches to its pages as they open, paused until the renderer probe is
 * added, so no milestone is missed however early the window loads.
 */
async function launch({ env, target }) {
  const args = [
    `--user-data-dir=${PROFILE_DIR}`,
    '--remote-debugging-port=0',
    ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
    ...target.args,
  ];
  const spawnedAt = Date.now();
  const child = spawn(target.command, args, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  const marks = {};
  const output = [];
  let devToolsUrl;
  const devToolsReady = new Promise((resolve, reject) => {
    const onLine = (line) => {
      output.push(line);
      const mark = /^\[komla-startup\] (\S+) ([\d.]+)$/.exec(line);
      if (mark) marks[mark[1]] = Number(mark[2]);
      const devTools = /^DevTools listening on (ws:\/\/\S+)/.exec(line);
      if (devTools && !devToolsUrl) {
        devToolsUrl = devTools[1];
        resolve(devToolsUrl);
      }
    };
    for (const stream of [child.stdout, child.stderr]) {
      let buffered = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        buffered += chunk;
        const lines = buffered.split('\n');
        buffered = lines.pop();
        for (const line of lines) onLine(line.trimEnd());
      });
    }
    child.on('exit', (code) =>
      reject(new Error(`Electron exited (${code}) before DevTools was up:\n${output.join('\n')}`))
    );
  });
  const cdp = await connectCdp(await devToolsReady);
  const pages = [];
  cdp.on(async (message) => {
    if (message.method !== 'Target.attachedToTarget') return;
    const { sessionId, targetInfo, waitingForDebugger } = message.params;
    if (targetInfo.type === 'page') {
      pages.push({ sessionId, targetId: targetInfo.targetId });
      await cdp.send('Page.enable', {}, sessionId).catch(() => {});
      await cdp
        .send('Page.addScriptToEvaluateOnNewDocument', { source: RENDERER_PROBE }, sessionId)
        .catch(() => {});
      // Electron's main thread also serves DevTools, so the window's document may be loading
      // already; the probe notes any milestone it arrived too late for.
      await cdp.send('Runtime.evaluate', { expression: RENDERER_PROBE }, sessionId).catch(() => {});
    }
    if (waitingForDebugger) {
      await cdp.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
    }
  });
  await cdp.send('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
  });
  return { child, cdp, pages, marks, output, spawnedAt };
}

/** Evaluates an expression in a page, awaiting it, and returns its JSON value. */
async function evaluate(app, sessionId, expression) {
  const result = await app.cdp.send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true },
    sessionId
  );
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? 'Evaluation failed');
  }
  return result.result.value;
}

/** Polls an expression in the renderer page until it returns something truthy. */
async function waitFor(app, expression, options) {
  return (await waitForPage(app, expression, options)).value;
}

/** Polls until `expression` is truthy on a renderer page, and returns that page and value. */
async function waitForPage(app, expression, { timeoutMs = 30_000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const page of app.pages) {
      const value = await evaluate(
        app,
        page.sessionId,
        `location.pathname.endsWith('/renderer/index.html') && (${expression})`
      ).catch(() => undefined);
      if (value) return { page, value };
    }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${expression}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function stop({ child, cdp }) {
  cdp.close();
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  const timer = setTimeout(() => {
    // The whole process group, so no helper is left holding the profile.
    try {
      if (process.platform === 'win32') child.kill('SIGKILL');
      else process.kill(-child.pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }, 15_000);
  await exited;
  clearTimeout(timer);
}

function git(args, cwd) {
  execFileSync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Startup',
      GIT_AUTHOR_EMAIL: 'startup@test.local',
      GIT_COMMITTER_NAME: 'Startup',
      GIT_COMMITTER_EMAIL: 'startup@test.local',
    },
  });
}

/** A project with workspaces in it, as someone who uses Komla daily would have. */
async function seed(workspaceCount) {
  console.log(`Seeding ${SANDBOX_DIR} with ${workspaceCount} workspaces...`);
  fs.rmSync(SANDBOX_DIR, { recursive: true, force: true });
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(SANDBOX_DIR, 'settings'), { recursive: true });
  fs.writeFileSync(
    path.join(SANDBOX_DIR, 'config.json'),
    JSON.stringify({
      agentSetupComplete: true,
      usageTelemetryConsentAnswered: true,
      aiHelpersOffDismissed: true,
      // Not Komla's default, which the Komla this runs in may hold.
      notificationPort: NOTIFICATION_PORT,
    })
  );
  const repoDir = path.join(SANDBOX_DIR, 'startup-repo');
  fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
  git(['init', '-b', 'main'], repoDir);
  for (let i = 0; i < 50; i++) {
    fs.writeFileSync(path.join(repoDir, 'src', `file-${i}.ts`), `export const value${i} = ${i};\n`);
  }
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# Startup\n');
  git(['add', '.'], repoDir);
  git(['commit', '-m', 'init'], repoDir);
  fs.writeFileSync(
    path.join(SANDBOX_DIR, 'settings', 'projects.json'),
    JSON.stringify({
      _version: 1,
      projects: [
        {
          id: 'startup-project',
          name: 'startup-repo',
          repositoryPath: repoDir,
          defaultBranchPrefix: 'startup/',
          createdAt: Date.now(),
          order: 0,
          managed: false,
        },
      ],
    })
  );

  const app = await launch({ env: electronEnv(), target: currentTarget() });
  try {
    // Each create runs once, on the page that has the API: a failed one isn't retried.
    const { page } = await waitForPage(app, `typeof window.api?.createWorkspace === 'function'`);
    for (let i = 0; i < workspaceCount; i++) {
      const params = {
        mode: 'worktree',
        projectId: 'startup-project',
        branchName: `startup/workspace-${i}`,
        customName: `Workspace ${i}`,
      };
      const result = await evaluate(
        app,
        page.sessionId,
        `window.api.createWorkspace(${JSON.stringify(params)}).then((r) => r ?? {})`
      );
      if (!result || '__workspaceCreateError' in result) {
        throw new Error(`Could not create a workspace: ${JSON.stringify(result)}`);
      }
    }
    await waitFor(
      app,
      `window.api.getWorkspaces().then((all) => all.every((w) => !w.provisioning && !w.provisionError))`,
      { timeoutMs: 60_000, intervalMs: 250 }
    );
  } finally {
    await stop(app);
  }

  fs.writeFileSync(SEEDED_MARKER, String(workspaceCount));
}

// Read in the renderer page once its final milestones are in.
// Adds the probe first if the page's document came too late for the other ways in.
const COLLECT_MARKS = `(() => {
  ${RENDERER_PROBE}
  const probe = window.__komlaStartupProbe;
  if (!probe) return false;
  if (!${JSON.stringify(FINAL_MILESTONES)}.every((name) => name in probe)) return false;
  if (probe.late.length > 0) return { late: probe.late };
  const marks = { ...probe };
  delete marks.installed;
  delete marks.late;
  for (const entry of performance.getEntriesByType('paint')) {
    marks['renderer:' + entry.name] = performance.timeOrigin + entry.startTime;
  }
  for (const entry of performance.getEntriesByType('mark')) {
    if (entry.name.startsWith('komla:')) {
      marks['renderer:' + entry.name.slice('komla:'.length)] =
        performance.timeOrigin + entry.startTime;
    }
  }
  return marks;
})()`;

async function measureOnce(target, timeoutMs = 30_000) {
  const app = await launch({ env: electronEnv({ KOMLA_STARTUP_TIMING: '1' }), target });
  try {
    const rendererMarks = await waitFor(app, COLLECT_MARKS, { timeoutMs }).catch(async () => {
      const reached = await waitFor(app, 'JSON.stringify(window.__komlaStartupProbe ?? null)', {
        timeoutMs: 1_000,
      }).catch(() => 'unknown');
      const shot = path.join(os.tmpdir(), 'komla-startup-timeout.png');
      for (const page of app.pages) {
        const image = await app.cdp
          .send('Page.captureScreenshot', {}, page.sessionId)
          .catch(() => null);
        if (image) fs.writeFileSync(shot, Buffer.from(image.data, 'base64'));
      }
      throw new Error(
        `Timed out waiting for the renderer's milestones; reached ${reached}. Screenshot: ${shot}`
      );
    });
    if (rendererMarks.late) {
      throw new Error(`The renderer probe arrived after ${rendererMarks.late.join(', ')}`);
    }
    // ready-to-show can come after the page's first frames.
    const deadline = Date.now() + 5_000;
    while (!('main:ready-to-show' in app.marks) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const relative = {};
    for (const [name, at] of Object.entries({ ...app.marks, ...rendererMarks })) {
      relative[name] = at - app.spawnedAt;
    }
    return relative;
  } catch (error) {
    error.message += `\n--- app output ---\n${app.output.slice(-40).join('\n')}`;
    throw error;
  } finally {
    await stop(app);
  }
}

function quantile(sorted, q) {
  if (sorted.length === 0) return NaN;
  const index = (sorted.length - 1) * q;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  return sorted[low] + (sorted[high] - sorted[low]) * (index - low);
}

function summarize(runs) {
  const summary = {};
  const names = new Set(runs.flatMap((run) => Object.keys(run)));
  for (const name of names) {
    const values = runs
      .map((run) => run[name])
      .filter((v) => v !== undefined)
      .sort((a, b) => a - b);
    summary[name] = {
      median: quantile(values, 0.5),
      min: values[0],
      p90: quantile(values, 0.9),
      n: values.length,
    };
  }
  return summary;
}

function orderedNames(summary) {
  const known = MILESTONES.map(([name]) => name).filter((name) => name in summary);
  const extra = Object.keys(summary)
    .filter((name) => !known.includes(name))
    .sort((a, b) => summary[a].median - summary[b].median);
  return [...known, ...extra];
}

function printSummary(summary, previous) {
  const descriptions = Object.fromEntries(MILESTONES);
  const pad = (s, n) => String(s).padStart(n);
  const ms = (v) => (Number.isFinite(v) ? v.toFixed(0) : '-');
  const header = `${'milestone'.padEnd(34)}${pad('median', 8)}${pad('min', 8)}${pad('p90', 8)}${
    previous ? `${pad('before', 8)}${pad('change', 8)}` : ''
  }  `;
  console.log(`\nms after spawning Electron:\n${header}`);
  for (const name of orderedNames(summary)) {
    const { median, min, p90 } = summary[name];
    let line = `${name.padEnd(34)}${pad(ms(median), 8)}${pad(ms(min), 8)}${pad(ms(p90), 8)}`;
    if (previous) {
      const before = previous[name]?.median;
      const change = Number.isFinite(before) ? median - before : NaN;
      line += `${pad(ms(before), 8)}${pad(Number.isFinite(change) ? (change > 0 ? '+' : '') + ms(change) : '-', 8)}`;
    }
    if (descriptions[name]) line += `  ${descriptions[name]}`;
    console.log(line);
  }
}

/** How to launch a build: a packaged executable, or a directory laid out like out/. */
function targetFor(buildPath) {
  const entry = path.join(buildPath, 'main', 'index.js');
  if (fs.existsSync(entry)) return { command: require('electron'), args: [entry], path: buildPath };
  if (fs.existsSync(buildPath) && fs.statSync(buildPath).isFile()) {
    return { command: buildPath, args: [], path: buildPath };
  }
  throw new Error(`${buildPath} is neither a build like out/ nor an executable`);
}

function currentTarget() {
  if (options.app) return targetFor(options.app);
  if (!fs.existsSync(path.join(OUT_DIR, 'main', 'index.js'))) {
    throw new Error(`${OUT_DIR} has no build; run \`npm run build\` first`);
  }
  return targetFor(OUT_DIR);
}

async function main() {
  const current = currentTarget();
  if (options.saveBaseline) {
    fs.rmSync(SAVED_BASELINE_DIR, { recursive: true, force: true });
    fs.cpSync(OUT_DIR, SAVED_BASELINE_DIR, { recursive: true });
    console.log(`Saved out/ to ${SAVED_BASELINE_DIR}; compare with --baseline ${SAVED_BASELINE_DIR}`);
    return;
  }
  const targets = [{ label: 'current', ...current, runs: [] }];
  if (options.baseline) targets.push({ label: 'baseline', ...targetFor(options.baseline), runs: [] });

  const seeded = fs.existsSync(SEEDED_MARKER) && fs.readFileSync(SEEDED_MARKER, 'utf8');
  if (options.reseed || seeded !== String(options.workspaces)) await seed(options.workspaces);

  const failures = [];
  for (let i = 0; i < options.warmup + options.runs; i++) {
    const warmup = i < options.warmup;
    const label = warmup ? `warmup ${i + 1}` : `run ${i - options.warmup + 1}/${options.runs}`;
    // Each build goes first in every other round, so neither always follows the other.
    const order = i % 2 === 0 ? targets : [...targets].reverse();
    for (const target of order) {
      const name = targets.length > 1 ? `${label} ${target.label}` : label;
      try {
        const run = await measureOnce(target);
        const finals = FINAL_MILESTONES.map(
          (milestone) => `${milestone.split(':')[1]} ${run[milestone].toFixed(0)}`
        );
        console.log(`${name}: ${finals.join(', ')} ms`);
        if (!warmup) target.runs.push(run);
      } catch (error) {
        console.error(`${name} failed: ${error.message}`);
        failures.push(error.message);
        if (!options.keepGoing) process.exit(1);
      }
    }
  }
  const summary = summarize(targets[0].runs);
  const baselineSummary = targets[1] ? summarize(targets[1].runs) : null;
  const previous =
    baselineSummary ??
    (options.compare ? JSON.parse(fs.readFileSync(options.compare, 'utf8')).summary : null);
  printSummary(summary, previous);
  if (options.json) {
    fs.writeFileSync(
      options.json,
      JSON.stringify(
        {
          date: new Date().toISOString(),
          options,
          runs: targets[0].runs,
          summary,
          ...(targets[1] && { baseline: { runs: targets[1].runs, summary: baselineSummary } }),
          failures,
        },
        null,
        2
      )
    );
    console.log(`\nWrote ${options.json}`);
  }
}

if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
  const child = spawn(
    'xvfb-run',
    ['-a', '-s', '-screen 0 1920x1080x24', process.execPath, ...process.argv.slice(1)],
    { stdio: 'inherit' }
  );
  child.on('exit', (code) => process.exit(code ?? 1));
} else {
  await main();
}
