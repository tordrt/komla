#!/usr/bin/env node
/**
 * Scripted stand-in for Claude Code, used by the landing-page video specs.
 *
 * It draws a Claude Code-style TUI, plays the turns of one scene from a JSON
 * file, applies the scene's file edits to the workspace for real (so Komla's
 * diff, file tree and previews react), and posts the same lifecycle hooks the
 * real CLI does so sidebar badges change in step with the terminal.
 *
 * Usage: node scripted-agent.mjs --scenes <file.json> [--scene <key>] [--prompt <text>]
 *          [--as <cli> -- <cli args>]
 * The scene is keyed by the workspace's branch, so workspaces created mid-video
 * find theirs too; a branch without one plays the `default` scene, and
 * `--scene` picks one by name, as for a second agent in the same workspace.
 * `--prompt` starts the first turn at launch, like `claude "…"`. Wrappers
 * named like a CLI pass `--as <cli>` and the arguments it was given, which
 * the agent shows as its command line and reads its permission mode from.
 * A scene's `look` picks Claude Code's TUI (the default) or Codex's.
 * Next to the scenes file live Komla's `port` file (local runs), the
 * `agent-status/` turn counts specs wait on, and `cues/` the director writes
 * to release `waitFor` events.
 */
import { execFileSync, execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const argValue = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const scenesFile = argValue('--scenes');
const launchPrompt = argValue('--prompt');
const scenesDir = path.dirname(scenesFile);
const scenes = JSON.parse(fs.readFileSync(scenesFile, 'utf8'));
const branch = execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim();
const sceneKey = argValue('--scene') ?? (scenes[branch] ? branch : 'default');
const scene = scenes[sceneKey] ?? { turns: [] };
const codex = scene.look === 'codex';
// What followed the CLI's name, as typed; null when started without a wrapper.
const cliArgs = args.includes('--') ? args.slice(args.indexOf('--') + 1) : null;
// The prompt shows up as the first message instead.
const shownCommand =
  scene.command ??
  (cliArgs
    ? [
        argValue('--as'),
        ...cliArgs.filter((a, i) => a !== '--prompt' && cliArgs[i - 1] !== '--prompt'),
      ].join(' ')
    : `${codex ? 'codex' : 'claude'} --dangerously-skip-permissions`);
// Status and cue files use the scene key, so a spec can address a default-scene agent.
const branchKey = sceneKey.replace(/[^\w.-]/g, '_');
const statusFile = path.join(scenesDir, 'agent-status', `${branchKey}.json`);
const DEV_SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dev-server.mjs');
// Commits a `run` makes are the demo's, not the recording machine's user's.
const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'Komla',
  GIT_AUTHOR_EMAIL: 'demo@komla.dev',
  GIT_COMMITTER_NAME: 'Komla',
  GIT_COMMITTER_EMAIL: 'demo@komla.dev',
};
let turnsCompleted = 0;

// ── Theme (Claude Code dark) ────────────────────────────────────────────────
const rgb = (r, g, b) => `\x1b[38;2;${r};${g};${b}m`;
const bgRgb = (r, g, b) => `\x1b[48;2;${r};${g};${b}m`;
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const C = {
  claude: rgb(215, 119, 87),
  shimmer: rgb(245, 170, 140),
  text: rgb(255, 255, 255),
  dim: rgb(153, 153, 153),
  subtle: rgb(80, 80, 80),
  border: rgb(136, 136, 136),
  success: rgb(78, 186, 101),
  error: rgb(255, 107, 128),
  code: rgb(177, 185, 249),
  plan: rgb(72, 150, 140),
  accept: rgb(175, 135, 255),
  addedBg: bgRgb(34, 92, 43),
  removedBg: bgRgb(122, 41, 54),
  userBg: bgRgb(55, 55, 55),
};

const MODES = [
  { id: 'default', label: null },
  { id: 'acceptEdits', label: `${C.accept}⏵⏵ accept edits on` },
  { id: 'plan', label: `${C.plan}⏸ plan mode on` },
  { id: 'bypass', label: `${C.error}⏵⏵ bypass permissions on` },
];

/** The permission mode Claude Code starts in for these arguments. */
function modeFromArgs(list) {
  if (list.includes('--dangerously-skip-permissions')) return 'bypass';
  const mode = list.includes('--permission-mode') && list[list.indexOf('--permission-mode') + 1];
  return MODES.some((m) => m.id === mode) ? mode : 'default';
}

// Codex keeps to the terminal's palette.
const X = {
  text: rgb(230, 230, 230),
  dim: rgb(135, 135, 135),
  cyan: rgb(86, 182, 194),
  green: rgb(98, 186, 114),
  red: rgb(224, 108, 117),
  bg: bgRgb(44, 46, 51),
};

// ── Text helpers ────────────────────────────────────────────────────────────
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const visibleWidth = (s) => [...s.replace(ANSI_RE, '')].length;
const cols = () => Math.max(40, process.stdout.columns || 100);
/** The first of `options` that fits on one row, as Claude Code drops detail in narrow terminals. */
const fit = (...options) => options.find((s) => visibleWidth(s) < cols()) ?? options.at(-1);

/** `**bold**` and `inline code` → ANSI, resetting to `base` afterwards. */
function inline(text, base = C.text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, `${BOLD}$1${RESET}${base}`)
    .replace(/`([^`]+)`/g, `${C.code}$1${base}`);
}

/** Word-wrap plain text to `width`, returning lines. */
function wrap(text, width) {
  const out = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(' ')) {
      const candidate = line ? `${line} ${word}` : word;
      if (visibleWidth(candidate) > width && line) {
        out.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    out.push(line);
  }
  return out;
}

/** Prefix the first wrapped line with `first` and indent the rest to match. */
function block(text, first, base = C.text, indent = 2) {
  const lines = wrap(text, cols() - indent - 1);
  return lines.map(
    (line, i) => `${i === 0 ? first : ' '.repeat(indent)}${base}${inline(line, base)}${RESET}`
  );
}

// ── Screen: static history above a redrawn live region ──────────────────────
let liveHeight = 0;
let input = '';
let spinner = null; // { verb, startedAt, tokens }
let modeIndex = Math.max(
  0,
  MODES.findIndex((m) => m.id === (scene.mode ?? (cliArgs ? modeFromArgs(cliArgs) : 'bypass')))
);
let permission = null; // { title, detail, resolve }
let tick = 0;

function liveLines() {
  if (codex) return codexLiveLines();
  const width = cols();
  const lines = [];
  if (spinner) {
    const glyphs = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];
    const glyph = glyphs[tick % glyphs.length];
    const verb = `${spinner.verb}…`;
    const band = tick % (verb.length + 6);
    const shimmered = [...verb]
      .map((ch, i) => (Math.abs(i - band + 3) <= 1 ? `${C.shimmer}${ch}` : `${C.claude}${ch}`))
      .join('');
    const secs = Math.floor((Date.now() - spinner.startedAt) / 1000);
    const tokens = (spinner.tokens / 1000).toFixed(1);
    const head = `${C.claude}${glyph} ${shimmered}${RESET}`;
    lines.push(
      fit(
        `${head} ${C.dim}(${secs}s · ↑ ${tokens}k tokens · esc to interrupt)${RESET}`,
        `${head} ${C.dim}(${secs}s · esc to interrupt)${RESET}`,
        head
      )
    );
    lines.push('');
  }
  if (permission) {
    const inner = width - 4;
    const pad = (s) => s + ' '.repeat(Math.max(0, inner - visibleWidth(s)));
    const row = (s) => `${C.code}│${RESET} ${pad(s)} ${C.code}│${RESET}`;
    // Wraps inside the box; `hang` indents continuation lines under an option's text.
    const rows = (text, { style = '', indent = 0, hang = 0 } = {}) =>
      wrap(text, inner - indent - hang).map((line, i) =>
        row(`${' '.repeat(indent + (i ? hang : 0))}${style}${line}${style && RESET}`)
      );
    lines.push(`${C.code}╭${'─'.repeat(width - 2)}╮${RESET}`);
    lines.push(...rows(permission.title, { style: BOLD }));
    lines.push(row(''));
    lines.push(...rows(permission.detail, { indent: 2 }));
    lines.push(row(''));
    lines.push(...rows('Do you want to proceed?'));
    lines.push(...rows('❯ 1. Yes', { style: C.code }));
    lines.push(...rows("2. Yes, and don't ask again this session", { indent: 2, hang: 3 }));
    lines.push(
      ...rows(`3. No, and tell Claude what to do differently ${C.dim}(esc)${RESET}`, {
        indent: 2,
        hang: 3,
      })
    );
    lines.push(`${C.code}╰${'─'.repeat(width - 2)}╯${RESET}`);
    return lines;
  }
  const rule = `${C.border}${'─'.repeat(width)}${RESET}`;
  const shown = input.length > width - 4 ? input.slice(input.length - (width - 4)) : input;
  lines.push(rule);
  lines.push(`${C.dim}❯${RESET} ${shown}\x1b[7m \x1b[27m`);
  lines.push(rule);
  const mode = MODES[modeIndex];
  lines.push(
    mode.label
      ? fit(
          `  ${mode.label}${RESET} ${C.dim}(shift+tab to cycle)${RESET}`,
          `  ${mode.label}${RESET}`
        )
      : `  ${C.dim}? for shortcuts${RESET}`
  );
  return lines;
}

/** Codex's status line, composer and footer. */
function codexLiveLines() {
  const width = cols();
  const lines = [];
  if (spinner) {
    const band = tick % (spinner.verb.length + 6);
    const shimmered = [...spinner.verb]
      .map((ch, i) => (Math.abs(i - band + 3) <= 1 ? `${X.text}${ch}` : `${X.dim}${ch}`))
      .join('');
    const secs = Math.floor((Date.now() - spinner.startedAt) / 1000);
    const head = `${X.dim}•${RESET} ${BOLD}${shimmered}${RESET}`;
    lines.push(fit(`${head} ${X.dim}(${secs}s • esc to interrupt)${RESET}`, head));
    lines.push('');
  }
  // Only foreground colors inside a row, so its background runs to the edge.
  const row = (s = '') => `${X.bg}${s}${' '.repeat(Math.max(0, width - visibleWidth(s)))}${RESET}`;
  const room = width - 5;
  const shown = input.length > room ? input.slice(input.length - room) : input;
  const field = input
    ? `${X.text}${shown}\x1b[7m \x1b[27m`
    : `\x1b[7m${X.dim}A\x1b[27msk Codex to do anything`;
  lines.push(row(), row(` ${X.text}\x1b[1m›\x1b[22m ${field}`), row());
  const model = `${scene.model ?? 'gpt-5.5'} ${scene.effort ?? 'medium'}`;
  lines.push(
    fit(
      `  ${X.dim}${model} · 100% context left · ? for shortcuts${RESET}`,
      `  ${X.dim}${model} · 100% context left${RESET}`
    )
  );
  return lines;
}

function eraseLive() {
  if (liveHeight === 0) return '';
  return `${liveHeight > 1 ? `\x1b[${liveHeight - 1}A` : ''}\r\x1b[J`;
}

function drawLive() {
  const lines = liveLines();
  process.stdout.write(`${eraseLive()}${lines.join('\r\n')}`);
  liveHeight = lines.length;
}

/**
 * Prints lines above the live region. Takes a render function (or fixed lines)
 * and keeps it, so a resize can clear the screen and reflow the whole history
 * at the new width, as Claude Code does.
 */
const history = [];
function print(render) {
  const lines = typeof render === 'function' ? render : () => render;
  history.push(lines);
  process.stdout.write(`${eraseLive()}${lines().join('\r\n')}\r\n`);
  liveHeight = 0;
  drawLive();
}

let resizeTimer;
function reflow() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const body = history.map((lines) => `${lines().join('\r\n')}\r\n`).join('');
    process.stdout.write(`\x1b[2J\x1b[3J\x1b[H${body}`);
    liveHeight = 0;
    drawLive();
  }, 40);
}

// ── Messages ────────────────────────────────────────────────────────────────
function banner() {
  const cwd = scene.displayCwd ?? process.cwd().replace(process.env.HOME ?? '', '~');
  if (codex) return codexBanner(cwd);
  const model = scene.model ?? 'Haiku 5.5';
  const effort = scene.effort ?? 'medium';
  return [
    `${C.claude} ▐▛███▜▌${RESET}   ${BOLD}Claude Code${RESET} ${C.dim}v${scene.version ?? '2.1.150'}${RESET}`,
    fit(
      `${C.claude}▝▜█████▛▘${RESET}  ${C.dim}${model} with ${effort} effort · Claude Max${RESET}`,
      `${C.claude}▝▜█████▛▘${RESET}  ${C.dim}${model} with ${effort} effort${RESET}`
    ),
    `${C.claude}  ▘▘ ▝▝${RESET}    ${C.dim}${cwd}${RESET}`,
    '',
  ];
}

function codexBanner(cwd) {
  const rows = [
    `${BOLD}>_ OpenAI Codex${RESET} ${X.dim}(v${scene.version ?? '0.132.0'})${RESET}`,
    '',
    `${X.dim}model:${RESET}     ${scene.model ?? 'gpt-5.5'} ${scene.effort ?? 'medium'}   ${X.cyan}/model${RESET} ${X.dim}to change${RESET}`,
    `${X.dim}directory:${RESET} ${cwd}`,
  ];
  const inner = Math.min(cols() - 4, Math.max(...rows.map(visibleWidth)));
  const pad = (s) => ' '.repeat(Math.max(0, inner - visibleWidth(s)));
  return [
    `${X.dim}╭${'─'.repeat(inner + 2)}╮${RESET}`,
    ...rows.map((s) => `${X.dim}│${RESET} ${s}${pad(s)} ${X.dim}│${RESET}`),
    `${X.dim}╰${'─'.repeat(inner + 2)}╯${RESET}`,
    '',
  ];
}

function userPrompt(text) {
  const width = cols();
  const [first, bg] = codex ? [`${X.dim}›${X.text} `, X.bg] : ['> ', C.userBg];
  return wrap(text, width - 4).map((line, i) => {
    const body = `${i === 0 ? first : '  '}${line}`;
    return `${bg}${C.text}${body}${' '.repeat(Math.max(0, width - visibleWidth(body)))}${RESET}`;
  });
}

function toolHeader(name, arg, ok = true) {
  return `${ok ? C.success : C.dim}●${RESET} ${BOLD}${name}${RESET}(${arg})`;
}

function resultLines(lines) {
  return lines.map((line, i) => `  ${i === 0 ? '⎿ ' : '  '} ${C.dim}${line}${RESET}`);
}

/** A tool call and its output; Codex groups reads under "Explored" and shows commands as "Ran". */
function toolLines(name, arg, result = []) {
  if (!codex) return [toolHeader(name, arg), ...resultLines(result)];
  const [bullet, head, out] =
    name === 'Read'
      ? [X.dim, `${BOLD}Explored${RESET}`, [`${X.cyan}Read${RESET} ${path.basename(arg)}`]]
      : name === 'Bash'
        ? [X.green, `${BOLD}Ran${RESET} ${arg}`, result]
        : [X.dim, `${BOLD}${name}${RESET} ${arg}`, result];
  return [
    `${bullet}•${RESET} ${head}`,
    ...out.map((line, i) => `  ${X.dim}${i ? ' ' : '└'}${RESET} ${X.dim}${line}${RESET}`),
  ];
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** Applies a find/replace edit to the workspace file and renders its hunk. */
function applyEdit(event) {
  const filePath = path.join(process.cwd(), event.edit);
  const before = fs.readFileSync(filePath, 'utf8');
  const index = event.fromEnd ? before.lastIndexOf(event.find) : before.indexOf(event.find);
  if (index < 0) throw new Error(`scripted-agent: "${event.find}" not found in ${event.edit}`);
  fs.writeFileSync(
    filePath,
    before.slice(0, index) + event.replace + before.slice(index + event.find.length)
  );

  // Lines the edit leaves alone at either end are context, not changes.
  let removed = event.find.split('\n');
  let added = event.replace.split('\n');
  let shared = 0;
  while (shared < removed.length && shared < added.length && removed[shared] === added[shared]) {
    shared++;
  }
  removed = removed.slice(shared);
  added = added.slice(shared);
  while (removed.length && added.length && removed.at(-1) === added.at(-1)) {
    removed = removed.slice(0, -1);
    added = added.slice(0, -1);
  }
  if (!removed.length && added.at(-1) === '') added = added.slice(0, -1);

  const startLine = before.slice(0, index).split('\n').length + shared;
  const allLines = before.split('\n');
  return () => hunkLines(event.edit, allLines, startLine, removed, added);
}

/** Codex's header for a file change, like "• Edited src/a.ts (+3 -1)". */
function codexChangeHeader(verb, file, added, removed) {
  return `${X.dim}•${RESET} ${BOLD}${verb}${RESET} ${file} (${X.green}+${added}${RESET} ${X.red}-${removed}${RESET})`;
}

function hunkLines(file, allLines, startLine, removed, added) {
  const context = codex ? 1 : 2;
  const width = cols();
  const numWidth = String(startLine + Math.max(removed.length, added.length) + context).length;
  // Claude Code shades changed lines; Codex colors their text.
  const row = (num, sign, text, bg = '') => {
    if (codex) {
      const color = sign === '+' ? X.green : sign === '-' ? X.red : X.dim;
      return `    ${X.dim}${String(num).padStart(numWidth)}${RESET} ${color}${sign}${text}${RESET}`;
    }
    const body = `      ${String(num).padStart(numWidth)} ${sign} ${text}`;
    const pad = bg ? ' '.repeat(Math.max(0, width - 2 - visibleWidth(body))) : '';
    return `${bg}${body}${pad}${RESET}`;
  };
  const summary = [
    added.length ? `Added ${plural(added.length, 'line')}` : null,
    removed.length
      ? `${added.length ? 'removed' : 'Removed'} ${plural(removed.length, 'line')}`
      : null,
  ].filter(Boolean);
  const lines = codex
    ? [codexChangeHeader('Edited', file, added.length, removed.length)]
    : [toolHeader('Update', file), ...resultLines([summary.join(', ')])];
  for (let n = Math.max(1, startLine - context); n < startLine; n++) {
    lines.push(row(n, ' ', allLines[n - 1]));
  }
  removed.forEach((text, i) => lines.push(row(startLine + i, '-', text, C.removedBg)));
  added.forEach((text, i) => lines.push(row(startLine + i, '+', text, C.addedBg)));
  const afterStart = startLine + removed.length;
  for (let n = afterStart; n < afterStart + context && n <= allLines.length; n++) {
    if (allLines[n - 1] === '' && n === allLines.length) break;
    lines.push(row(n - removed.length + added.length, ' ', allLines[n - 1]));
  }
  return lines;
}

function applyWrite(event) {
  const filePath = path.join(process.cwd(), event.write);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, event.content);
  const lines = event.content.split('\n');
  if (codex) {
    const written = lines.at(-1) === '' ? lines.slice(0, -1) : lines;
    return [
      codexChangeHeader('Added', event.write, written.length, 0),
      ...written
        .slice(0, 4)
        .map(
          (line, i) => `    ${X.dim}${String(i + 1).padStart(2)}${RESET} ${X.green}+${line}${RESET}`
        ),
      ...(written.length > 4
        ? [`    ${X.dim}… +${plural(written.length - 4, 'line')}${RESET}`]
        : []),
    ];
  }
  return [
    toolHeader('Write', event.write),
    ...resultLines([`Wrote ${plural(lines.length, 'line')} to ${event.write}`]),
    ...lines
      .slice(0, 4)
      .map((line, i) => `      ${C.dim}${String(i + 1).padStart(2)}${RESET} ${line}`),
    ...(lines.length > 4
      ? [`      ${C.dim}… +${lines.length - 4} lines (ctrl+o to expand)${RESET}`]
      : []),
  ];
}

// ── Hooks ───────────────────────────────────────────────────────────────────
const sessionId = `scripted-${process.env.KOMLA_TERMINAL_ID ?? process.pid}`;
let promptCount = 0;

/**
 * Sends JSON to Komla's HTTP server; SSH hosts reach it through KOMLA_NOTIFY_PORT.
 * Resolves with the response body, or '' when Komla can't be reached in `timeout` ms.
 */
function postToKomla(route, body, headers = {}, { method = 'POST', timeout = 15000 } = {}) {
  let port = process.env.KOMLA_NOTIFY_PORT;
  try {
    port ??= fs.readFileSync(path.join(scenesDir, 'port'), 'utf8').trim();
  } catch {
    return Promise.resolve('');
  }
  const payload = JSON.stringify(body);
  return new Promise((resolve) => {
    const req = http.request(`http://127.0.0.1:${port}${route}`, {
      method,
      timeout,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...headers,
      },
    });
    req.on('response', (res) => {
      let text = '';
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => resolve(text));
    });
    req.on('error', () => resolve(''));
    // Komla may have taken the request already, so a timeout isn't a refusal.
    req.on('timeout', () => {
      resolve(null);
      req.destroy();
    });
    req.end(payload);
  });
}

async function notify(event, kind, message) {
  const hookInput = { hook_event_name: event, session_id: sessionId, prompt_id: `p${promptCount}` };
  const reply = await postToKomla('/api/v1/notify', {
    terminalId: process.env.KOMLA_TERMINAL_ID || undefined,
    cwd: process.cwd(),
    kind,
    source: 'claude-code',
    hookInput,
    message,
  });
  // While Komla is closed, a hook on an SSH host waits in the companion's inbox, as the real
  // CLI's do through Komla's notify script, until Komla reconnects.
  if (reply === '' && process.env.KOMLA_NOTIFY_SCRIPT) await queueHook(event, hookInput);
  return reply;
}

function queueHook(event, hookInput) {
  return new Promise((resolve) => {
    const script = spawn(
      process.env.KOMLA_NOTIFY_SCRIPT,
      ['--source', 'claude-code', '--event', event],
      { stdio: ['pipe', 'ignore', 'ignore'] }
    );
    script.on('close', resolve);
    script.on('error', resolve);
    script.stdin.end(JSON.stringify(hookInput));
  });
}

/**
 * Calls a Komla MCP tool for real, scoped to this terminal like the `komla mcp`
 * adapter Claude Code uses; on SSH hosts the tunnel adds the host.
 */
function callMcp(tool, toolArgs) {
  return postToKomla(
    '/api/v1/cli/mcp',
    {
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: { name: tool, arguments: { cwd: process.cwd(), ...toolArgs } },
    },
    {
      Accept: 'application/json, text/event-stream',
      'x-komla-terminal-id': process.env.KOMLA_TERMINAL_ID ?? '',
    }
  );
}

function mcpHeader(tool, shown) {
  const argText = Object.entries(shown)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join(', ');
  if (codex) return `${X.dim}•${RESET} ${BOLD}Called${RESET} komla.${tool}(${argText})`;
  return `${C.success}●${RESET} ${BOLD}komla - ${tool}${RESET} (MCP)(${argText})`;
}

function sayLines(text) {
  return block(text, `${C.text}${codex ? '•' : '●'} `);
}

/** The end of a turn: Claude Code's "✻ Baked for 9s", Codex's rule. */
function doneLine(claudeText, codexText) {
  if (!codex) return `${C.dim}✻ ${claudeText}${RESET}`;
  const label = `─ ${codexText} `;
  return `${X.dim}${label}${'─'.repeat(Math.max(0, cols() - visibleWidth(label)))}${RESET}`;
}

/** Starts the demo dev server in the background, as `npm run dev` would. */
function startDevServer(dir, port) {
  spawn(process.execPath, [DEV_SERVER, path.join(process.cwd(), dir), String(port)], {
    detached: true,
    stdio: 'ignore',
  }).unref();
}

async function waitForCue(name) {
  // Lets the spec know this agent is ready and waiting on the cue.
  fs.mkdirSync(path.dirname(statusFile), { recursive: true });
  fs.writeFileSync(path.join(path.dirname(statusFile), `${branchKey}.at-${name}`), '');
  const cueFile = path.join(scenesDir, 'cues', branchKey, name);
  while (!fs.existsSync(cueFile)) await sleep(100);
}

// ── Turns ───────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const turns = [...(scene.turns ?? [])];
let running = false;

async function runTurn(turn, promptText) {
  running = true;
  promptCount++;
  print(() => ['', ...userPrompt(promptText), '']);
  void notify('UserPromptSubmit', 'prompt-submit', promptText);
  const startedAt = Date.now();
  spinner = { verb: turn.verb ?? (codex ? 'Working' : 'Thinking'), startedAt, tokens: 400 };
  let lastSay = null;

  for (const event of turn.events ?? []) {
    await sleep(event.delay ?? 700);
    if (event.verb) spinner.verb = event.verb;
    spinner.tokens += 300 + Math.floor(Math.random() * 500);
    if (event.think) {
      await sleep(event.think);
    } else if (event.say) {
      lastSay = event.say;
      print(() => [...sayLines(event.say), '']);
    } else if (event.edit) {
      void notify('PreToolUse', 'activity');
      const hunk = applyEdit(event);
      print(() => [...hunk(), '']);
    } else if (event.append) {
      void notify('PreToolUse', 'activity');
      const before = fs.readFileSync(path.join(process.cwd(), event.append), 'utf8');
      const last = before.trimEnd().split('\n').at(-1);
      const hunk = applyEdit({
        edit: event.append,
        find: `${last}\n`,
        replace: `${last}\n\n${event.content.trimEnd()}\n`,
        fromEnd: true,
      });
      print(() => [...hunk(), '']);
    } else if (event.write) {
      void notify('PreToolUse', 'activity');
      print([...applyWrite(event), '']);
    } else if (event.serve) {
      void notify('PreToolUse', 'activity');
      startDevServer(event.serve, event.port);
      print([
        ...toolLines('Bash', event.command ?? 'npm run dev', [
          'Running in the background (↓ to manage)',
        ]),
        '',
      ]);
    } else if (event.mcp) {
      void notify('PreToolUse', 'activity');
      await callMcp(event.mcp, event.args ?? {});
      print([
        mcpHeader(event.mcp, event.show ?? event.args ?? {}),
        ...resultLines(event.result ?? []),
        '',
      ]);
    } else if (event.appearance) {
      // Like `komla settings apply appearance`: Komla previews the theme until
      // the user keeps or reverts it, so this waits on them.
      void notify('PreToolUse', 'activity');
      const settings = JSON.parse(fs.readFileSync(path.join(process.cwd(), event.appearance)));
      const reply = await postToKomla(
        '/api/v1/settings/appearance',
        settings,
        { 'x-komla-terminal-id': process.env.KOMLA_TERMINAL_ID ?? '' },
        { method: 'PUT', timeout: 120000 }
      );
      let status = 'failed';
      try {
        status = JSON.parse(reply).status ?? JSON.parse(reply).error?.code ?? status;
      } catch {
        // Komla couldn't be reached.
      }
      print([
        ...toolLines('Bash', `komla settings apply appearance --file ${event.appearance}`, [
          `"status": "${status}"`,
        ]),
        '',
      ]);
    } else if (event.waitFor) {
      await waitForCue(event.waitFor);
    } else if (event.tool) {
      void notify('PreToolUse', 'activity');
      if (event.run)
        execSync(event.run, { stdio: 'ignore', env: { ...process.env, ...GIT_IDENTITY } });
      print([...toolLines(event.tool, event.arg ?? '', event.result), '']);
    } else if (event.permission) {
      const savedSpinner = spinner;
      spinner = null;
      void notify('PermissionRequest', 'input-required', event.permission.message);
      await new Promise((resolve) => {
        permission = { ...event.permission, resolve };
        drawLive();
      });
      permission = null;
      spinner = savedSpinner;
      drawLive();
    }
  }

  spinner = null;
  const secs = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
  print(() => [doneLine(`${turn.doneVerb ?? 'Baked'} for ${secs}s`, `Worked for ${secs}s`), '']);
  void notify('Stop', 'turn-complete', lastSay ?? undefined);
  running = false;
  turnsCompleted++;
  fs.mkdirSync(path.dirname(statusFile), { recursive: true });
  fs.writeFileSync(statusFile, JSON.stringify({ turnsCompleted }));
  scheduleAutoTurn();
}

/** Turns marked `auto` type their own prompt after `afterMs`, as if a user did. */
function scheduleAutoTurn() {
  const next = turns[0];
  if (!next?.auto) return;
  setTimeout(async () => {
    for (const ch of next.prompt) {
      input += ch;
      drawLive();
      await sleep(25 + Math.random() * 35);
    }
    await sleep(300);
    submit();
  }, next.afterMs ?? 1000);
}

function submit() {
  const text = input.trim();
  if (!text || running) return;
  input = '';
  const turn = turns.shift() ?? { events: [{ say: scene.fallbackReply ?? 'Done.' }] };
  void runTurn(turn, text);
}

// ── Input ───────────────────────────────────────────────────────────────────
function onData(data) {
  const str = data.toString('utf8');
  if (permission) {
    if (str.includes('\r') || /^[123]$/.test(str)) permission.resolve();
    return;
  }
  if (str === '\x03') return exit();
  if (str === '\x1b[Z') {
    modeIndex = (modeIndex + 1) % MODES.length;
    return drawLive();
  }
  if (str.startsWith('\x1b')) return;
  for (const ch of str) {
    if (ch === '\r') submit();
    else if (ch === '\x7f') input = input.slice(0, -1);
    else if (ch === '\x15') input = '';
    else if (ch >= ' ') input += ch;
  }
  drawLive();
}

function exit() {
  process.stdout.write(`${RESET}\x1b[?25h\r\n`);
  process.exit(0);
}

// ── Start ───────────────────────────────────────────────────────────────────
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on('data', onData);
process.stdout.on('resize', reflow);
process.on('SIGTERM', exit);

if (scene.title) process.stdout.write(`\x1b]0;${scene.title}\x07`);
// Replace the shell's echo of our real command line with the one a user would see. Komla
// echoes only local startup commands, so on an SSH host the banner comes first.
process.stdout.write('\x1b[?25l\x1b[2J\x1b[3J\x1b[H');
const onSshHost = Boolean(process.env.KOMLA_NOTIFY_SCRIPT);
print(() => [...(onSshHost ? [] : [`\x1b[2m ${shownCommand}${RESET}`]), ...banner()]);

for (const entry of scene.history ?? []) {
  if (entry.prompt) print(() => ['', ...userPrompt(entry.prompt), '']);
  else if (entry.say) print(() => [...sayLines(entry.say), '']);
  else if (entry.tool) print([...toolLines(entry.tool, entry.arg ?? '', entry.result), '']);
  else if (entry.done) print(() => [doneLine(entry.done, entry.done), '']);
}
setInterval(() => {
  tick++;
  if (spinner) drawLive();
}, 120);
if (launchPrompt) void runTurn(turns.shift() ?? { events: [] }, launchPrompt);
else scheduleAutoTurn();
