/** Script, subcommand and program name parts that serve, preview, watch or open a UI. */
const LONG_RUNNING_WORDS = new Set([
  'dev',
  'open',
  'preview',
  'runserver',
  'serve',
  'server',
  'start',
  'storybook',
  'ui',
  'watch',
]);
const LONG_RUNNING_FLAGS = new Set([
  '--continuous',
  '--hot',
  '--serve',
  '--ui',
  '--watch',
  '--watchAll',
  '-w',
]);
const LONG_RUNNING_PROGRAMS = new Set([
  'entr',
  'gunicorn',
  'ngrok',
  'nodemon',
  'uvicorn',
  'watchexec',
]);
/** Subcommands that run an app or a tunnel until it is stopped. */
const RUN_SUBCOMMANDS = new Map([
  ['cargo', 'run'],
  ['flask', 'run'],
  ['go', 'run'],
  ['kubectl', 'port-forward'],
  ['rails', 's'],
]);
/** Interpreters given a script file; `node server.js` starts an app, `node build.js` does not. */
const SCRIPT_RUNNERS = new Set(['bun', 'deno', 'node', 'php', 'python', 'python3', 'ruby']);
const SCRIPT_FILE = /\.(?:[cm]?js|ts|py|rb|php)$/;
const APP_SCRIPT_NAMES = new Set(['app', 'index', 'main']);
const FOLLOW_FLAG = /^(?:-[a-zA-Z]*[fF]|--follow)$/;
/** Launchers that run the command after their own flags; `timeout` also takes a duration. */
const LAUNCHERS = new Set(['bunx', 'exec', 'nice', 'nohup', 'npx', 'time', 'timeout', 'xvfb-run']);
const PACKAGE_MANAGERS = new Set(['bun', 'npm', 'pnpm', 'yarn']);
/** A shell word, keeping quoted parts such as `--server-args="-screen 0"` together. */
const WORD = /(?:[^\s"'<>()]|"[^"]*"|'[^']*')+/g;

/** The words of each pipeline stage of the last command in an `&&`, `||` or `;` chain. */
function lastCommandStages(command: string): string[][] {
  const chain = command
    .split(/&&|\|\||[;\n]/)
    .map((part) => part.trim())
    .filter(Boolean);
  return (chain[chain.length - 1] ?? '').split('|').map((stage) => stage.match(WORD) ?? []);
}

/** Skips environment assignments and launchers such as `timeout 600` or `xvfb-run -a`. */
function programIndex(words: string[]): number {
  let index = 0;
  while (index < words.length) {
    const word = words[index];
    if (/^\w+=/.test(word)) {
      index++;
      continue;
    }
    if (!LAUNCHERS.has(word)) break;
    index++;
    while (words[index]?.startsWith('-')) index++;
    if (word === 'timeout') index++;
  }
  return /^python3?$/.test(words[index] ?? '') && words[index + 1] === '-m' ? index + 2 : index;
}

function hasLongRunningPart(name: string): boolean {
  return name.split(/[-_.:]/).some((part) => LONG_RUNNING_WORDS.has(part));
}

/** `npm run dev`, `yarn start`, `pnpm test:watch` and similar package manager scripts. */
function runsLongRunningScript(args: string[]): boolean {
  const script = args[0] === 'run' || args[0] === 'run-script' ? args[1] : args[0];
  return !!script && hasLongRunningPart(script);
}

/** Apps and containers: `node server.js`, `java -jar app.jar`, `docker compose up`, `vite`. */
function startsApp(program: string, args: string[]): boolean {
  const [subcommand = ''] = args;
  const detached = args.includes('-d') || args.includes('--detach');
  if (program === 'docker' || program === 'docker-compose') {
    if (args.includes('up')) return !detached;
    return subcommand === 'run' && !detached && !args.includes('--rm');
  }
  if (program === 'java') return subcommand === '-jar';
  if (program === 'vite') return !subcommand || subcommand.startsWith('-');
  if (!SCRIPT_RUNNERS.has(program) || !SCRIPT_FILE.test(subcommand)) return false;
  const script = subcommand.split('/').pop() ?? '';
  return (
    APP_SCRIPT_NAMES.has(script.split('.')[0]) ||
    hasLongRunningPart(script) ||
    args.some((arg) => LONG_RUNNING_WORDS.has(arg))
  );
}

/**
 * Whether a background shell command looks like a server, watcher or other command that runs
 * until it is stopped. The first stage of the last command in an `&&`, `||` or `;` chain
 * decides, so `npm run build && npm start` is long-running and `npm test; echo $?` is not.
 */
export function isLongRunningCommand(command: string): boolean {
  const [words = [], ...piped] = lastCommandStages(command);
  if (piped.some(([program]) => program === 'entr')) return true;
  if (words.some((word) => LONG_RUNNING_FLAGS.has(word))) return true;
  const [path = '', ...args] = words.slice(programIndex(words));
  const program = path.split('/').pop() ?? '';
  const subcommand = args[0] ?? '';
  if (PACKAGE_MANAGERS.has(program)) return runsLongRunningScript(args);
  if (LONG_RUNNING_PROGRAMS.has(program) || hasLongRunningPart(program)) return true;
  if (LONG_RUNNING_WORDS.has(subcommand) || RUN_SUBCOMMANDS.get(program) === subcommand)
    return true;
  const follows = program === 'tail' || program === 'journalctl' || subcommand === 'logs';
  if (follows && args.some((arg) => FOLLOW_FLAG.test(arg))) return true;
  if (program === 'sleep') return subcommand === 'infinity';
  return startsApp(program, args);
}
