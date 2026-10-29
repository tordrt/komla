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
  'studio',
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
/**
 * Name parts that make a script finite despite one above, as `build:server` and `test:ui:ci`
 * are; `watch` still runs until it is stopped, as in `build:watch`.
 */
const FINITE_WORDS = new Set([
  'build',
  'check',
  'ci',
  'compile',
  'deploy',
  'install',
  'lint',
  'migrate',
  'migration',
  'pr',
  'release',
  'typecheck',
]);
const LONG_RUNNING_PROGRAMS = new Set([
  'air',
  'electron',
  'entr',
  'gunicorn',
  'mongod',
  'ngrok',
  'nodemon',
  'postgres',
  'uvicorn',
  'watchexec',
]);
/** Subcommands that run an app or a tunnel until it is stopped. */
const RUN_SUBCOMMANDS = new Map([
  ['caddy', ['run']],
  ['cargo', ['run']],
  ['dotnet', ['run']],
  ['flask', ['run']],
  ['go', ['run']],
  ['jupyter', ['lab', 'notebook']],
  ['kubectl', ['port-forward']],
  ['rails', ['s']],
  ['streamlit', ['run']],
]);
/** Interpreters given a script file; `node server.js` starts an app, `node build.js` does not. */
const SCRIPT_RUNNERS = new Set(['bun', 'deno', 'node', 'php', 'python', 'ruby']);
const SCRIPT_FILE = /\.(?:[cm]?js|ts|py|rb|php)$/;
const APP_SCRIPT_NAMES = new Set(['app', 'index', 'main']);
const FOLLOW_FLAG = /^(?:-[a-zA-Z]*[fF]|--follow)$/;
/** Launchers that run the command after their own flags; `timeout` also takes a duration. */
const LAUNCHERS = new Set(['bunx', 'exec', 'nice', 'nohup', 'npx', 'time', 'timeout', 'xvfb-run']);
/** Launchers that run the command after a subcommand of theirs, as `uv run` does. */
const SUBCOMMAND_LAUNCHERS = new Map([
  ['bundle', 'exec'],
  ['npm', 'exec'],
  ['pdm', 'run'],
  ['pipenv', 'run'],
  ['pnpm', 'exec'],
  ['poetry', 'run'],
  ['uv', 'run'],
]);
/** Package managers, and Turborepo, which runs their scripts. */
const PACKAGE_MANAGERS = new Set(['bun', 'npm', 'pnpm', 'turbo', 'yarn']);
/** Package manager options that take a value, such as the package `--filter` picks. */
const PACKAGE_MANAGER_VALUE_OPTIONS = new Set([
  '--cwd',
  '--dir',
  '--filter',
  '--prefix',
  '--workspace',
  '-C',
  '-F',
]);
const SHELLS = new Set(['bash', 'dash', 'sh', 'zsh']);
/** `while true; do …; done`, which only a `break` or `exit` in it ends. */
const ENDLESS_LOOP = /(?:^|[;&|(]|\bdo)\s*(?:while\s+(?:true|:)|until\s+false)\s*[;\n]/;
const LOOP_EXIT = /\b(?:break|exit|return)\b/;
/** `python3`, `python3.13t`, `pythonw`, `Python` or the Windows launcher `py`. */
const PYTHON = /^(?:pythonw?(?:\d+(?:\.\d+)*t?)?|pyw?)$/i;
/** The `py` launcher's own options, which pick a Python: `-3.12-arm64` or `-V:Anaconda3/3.12`. */
const PY_LAUNCHER_OPTION = /^-(?:\d|V:)/;
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

const unquote = (word: string) => word.replace(/["']/g, '');

/**
 * A program's name, without its quotes, its path or a Windows `.exe`, `.cmd`, `.bat` or `.ps1`:
 * `".venv\Scripts\python.exe"` is Python. Arguments keep their quotes, as a quoted one is text,
 * such as the pattern in `rg "serve" src`, not a subcommand.
 */
function programName(path: string): string {
  return unquote(path)
    .split(/[\\/]/)
    .pop()!
    .replace(/\.(?:exe|cmd|bat|ps1)$/i, '');
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
    const launcher = programName(word);
    const subcommand = SUBCOMMAND_LAUNCHERS.get(launcher);
    if (subcommand && words[index + 1] === subcommand) index++;
    else if (!LAUNCHERS.has(launcher)) break;
    index++;
    while (words[index]?.startsWith('-')) index++;
    if (launcher === 'timeout') index++;
  }
  return index;
}

/**
 * Python's arguments after its own options, such as `-I`, `-u` or `-X utf8`, and the module that
 * `-m` runs: `python3 -Im http.server` runs the module, and `python3 -c` only a command.
 */
function pythonArguments(args: string[]): { module?: string; rest: string[] } {
  let index = 0;
  while (index < args.length && /^-./.test(args[index])) {
    const word = args[index++];
    if (word === '--') break;
    // The one long option that takes a value.
    if (word === '--check-hash-based-pycs') index++;
    if (word.startsWith('--')) continue;
    // Options combine, as in `-Iu`; the first that takes a value ends the word.
    const at = word.slice(1).search(/[mcXW]/) + 1;
    if (at === 0) continue;
    const value = word.slice(at + 1) || args[index++];
    if (word[at] === 'm') return { module: value, rest: args.slice(index) };
    if (word[at] === 'c') return { rest: [] };
  }
  return { rest: args.slice(index) };
}

function hasLongRunningPart(name: string): boolean {
  const parts = name.split(/[-_.:]/);
  if (parts.includes('watch')) return true;
  return (
    parts.some((part) => LONG_RUNNING_WORDS.has(part)) &&
    !parts.some((part) => FINITE_WORDS.has(part))
  );
}

/** Whether the last argument names finite work, as `migrate` does in `cargo run --bin migrate`. */
function namesFiniteWork(args: string[]): boolean {
  const last = args[args.length - 1];
  if (!last || last.startsWith('-')) return false;
  return programName(last)
    .split(/[-_.:]/)
    .some((part) => FINITE_WORDS.has(part));
}

/**
 * `npm run dev`, `yarn start`, `pnpm test:watch` and similar package manager scripts, also of
 * a package that `pnpm --filter web`, `npm -w web` or `yarn workspace web` picks.
 */
function runsLongRunningScript(program: string, args: string[]): boolean {
  let index = 0;
  while (args[index]?.startsWith('-')) {
    const option = args[index++];
    // npm's `-w` names a workspace; pnpm's picks the workspace root and takes no value.
    if (option === '-w') {
      if (program === 'npm') index++;
    } else if (PACKAGE_MANAGER_VALUE_OPTIONS.has(option)) {
      index++;
    } else if (LONG_RUNNING_FLAGS.has(option)) {
      // The package manager's own, as in `bun --hot index.ts`.
      return true;
    }
  }
  if (program === 'yarn' && args[index] === 'workspace') index += 2;
  if (args[index] === 'run' || args[index] === 'run-script') index++;
  const script = args[index];
  if (!script) return false;
  // Options after the script are the script's own, as in `npm run test -- --watch`.
  return (
    hasLongRunningPart(script) || args.slice(index + 1).some((arg) => LONG_RUNNING_FLAGS.has(arg))
  );
}

/** The command `sh -c` or `bash -lc` runs, without its quotes. */
function shellCommand(program: string, args: string[]): string | undefined {
  if (!SHELLS.has(program)) return undefined;
  const option = args.findIndex((arg) => /^-[a-z]*c[a-z]*$/.test(arg));
  const command = option === -1 ? undefined : args[option + 1];
  return command?.replace(/^(["'])(.*)\1$/s, '$2');
}

/**
 * Programs whose own arguments say they serve: `php -S`, `php artisan serve`, `deno task dev`,
 * a Celery worker, an ssh tunnel or `less +F`; and GitHub's CLI, whose `--watch` waits for checks,
 * which finish. Undefined for other programs.
 */
function servesByArguments(program: string, args: string[]): boolean | undefined {
  const [subcommand = ''] = args;
  switch (program) {
    case 'php':
      return subcommand === '-S' || (subcommand === 'artisan' && args[1] === 'serve');
    case 'deno':
      return subcommand === 'task' ? hasLongRunningPart(args[1] ?? '') : undefined;
    case 'celery':
      return args.includes('worker') || args.includes('beat');
    case 'ssh': {
      // `-N` forwards ports without running a command; `-f` then sends ssh to the background.
      const options = args.filter((arg) => /^-[a-zA-Z]+$/.test(arg)).join('');
      return options.includes('N') && !options.includes('f');
    }
    case 'less':
      return args.includes('+F');
    case 'gh':
      return false;
    default:
      return undefined;
  }
}

/** Apps and containers: `node server.js`, `java -jar app.jar`, `docker compose up`, `vite`. */
function startsApp(program: string, args: string[]): boolean {
  const [subcommand = ''] = args;
  const detached = args.includes('-d') || args.includes('--detach');
  if (program === 'docker' || program === 'docker-compose') {
    if (args.includes('up')) return !detached;
    return subcommand === 'run' && !detached && !args.includes('--rm') && !namesFiniteWork(args);
  }
  if (program === 'java') return subcommand === '-jar';
  if (program === 'vite') return !subcommand || subcommand.startsWith('-');
  if (!SCRIPT_RUNNERS.has(program) || !SCRIPT_FILE.test(subcommand)) return false;
  const script = subcommand.split(/[\\/]/).pop() ?? '';
  return (
    APP_SCRIPT_NAMES.has(script.split('.')[0]) ||
    hasLongRunningPart(script) ||
    args.some((arg) => LONG_RUNNING_WORDS.has(arg))
  );
}

/** The program a command runs and its arguments; for Python, the module `-m` runs, if any. */
function programAndArgs(words: string[]): { program: string; args: string[] } {
  const [path = '', ...args] = words.slice(programIndex(words));
  const program = programName(path);
  if (!PYTHON.test(program)) return { program, args };
  const launcher = /^pyw?$/i.test(program) && PY_LAUNCHER_OPTION.test(args[0] ?? '');
  const { module, rest } = pythonArguments(launcher ? args.slice(1) : args);
  return { program: module ? unquote(module) : 'python', args: rest };
}

/**
 * Whether a background shell command looks like a server, watcher or other command that runs
 * until it is stopped. The first stage of the last command in an `&&`, `||` or `;` chain
 * decides, so `npm run build && npm start` is long-running and `npm test; echo $?` is not.
 */
export function isLongRunningCommand(command: string): boolean {
  if (ENDLESS_LOOP.test(command) && !LOOP_EXIT.test(command)) return true;
  const [words = [], ...piped] = lastCommandStages(command);
  if (piped.some(([program]) => program === 'entr')) return true;
  const { program, args } = programAndArgs(words);
  const shelled = shellCommand(program, args);
  if (shelled !== undefined) return isLongRunningCommand(shelled);
  if (PACKAGE_MANAGERS.has(program)) return runsLongRunningScript(program, args);
  const serves = servesByArguments(program, args);
  if (serves !== undefined) return serves;
  if (args.some((arg) => LONG_RUNNING_FLAGS.has(arg))) return true;
  const subcommand = args[0] ?? '';
  if (LONG_RUNNING_PROGRAMS.has(program) || hasLongRunningPart(program)) return true;
  if (LONG_RUNNING_WORDS.has(subcommand)) return true;
  if (RUN_SUBCOMMANDS.get(program)?.includes(subcommand)) return !namesFiniteWork(args);
  const follows = program === 'tail' || program === 'journalctl' || subcommand === 'logs';
  if (follows && args.some((arg) => FOLLOW_FLAG.test(arg))) return true;
  if (program === 'sleep') return subcommand === 'infinity';
  return startsApp(program, args);
}
