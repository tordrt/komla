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
const LAUNCHERS = new Set([
  'bunx',
  'env',
  'exec',
  'nice',
  'nohup',
  'npx',
  'time',
  'timeout',
  'xvfb-run',
]);
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
const PACKAGE_MANAGER_VALUE_OPTIONS = [
  '--cwd',
  '--dir',
  '--filter',
  '--prefix',
  '--workspace',
  '-C',
  '-F',
];
/**
 * The options of launchers, package managers and `deno task` that take a value, as
 * `uv run --with httpx`, `env -u NAME` and `npm -w web` do; pnpm's `-w` takes none.
 */
const VALUE_OPTIONS = new Map([
  ['bun', PACKAGE_MANAGER_VALUE_OPTIONS],
  ['bunx', ['-p', '--package']],
  ['deno', ['-c', '-f', '--config', '--cwd', '--filter']],
  ['env', ['-C', '-u', '--chdir', '--unset']],
  ['exec', ['-a']],
  ['nice', ['-n', '--adjustment']],
  ['npm', [...PACKAGE_MANAGER_VALUE_OPTIONS, '-w', '--package']],
  ['npx', ['-p', '--package']],
  ['pnpm', PACKAGE_MANAGER_VALUE_OPTIONS],
  ['pdm', ['-p', '--project']],
  ['poetry', ['-C', '-P', '--directory', '--project']],
  ['time', ['-f', '-o', '--format', '--output']],
  ['timeout', ['-k', '-s', '--kill-after', '--signal']],
  ['turbo', PACKAGE_MANAGER_VALUE_OPTIONS],
  [
    'uv',
    [
      '-p',
      '--cache-dir',
      '--default-index',
      '--directory',
      '--env-file',
      '--extra',
      '--extra-index-url',
      '--group',
      '--index',
      '--index-url',
      '--package',
      '--project',
      '--python',
      '--with',
      '--with-editable',
      '--with-requirements',
    ],
  ],
  [
    'xvfb-run',
    [
      '-e',
      '-f',
      '-n',
      '-p',
      '-s',
      '-w',
      '--auth-file',
      '--error-file',
      '--server-args',
      '--server-num',
      '--wait',
    ],
  ],
  ['yarn', PACKAGE_MANAGER_VALUE_OPTIONS],
]);
/** `docker run` short options that take no value, alone or combined, as in `-it` and `-dit`. */
const DOCKER_SHORT_FLAGS = /^-[diPqt]+$/;
/** ssh options whose value follows, alone or last among combined ones: `-p 2222`, `-NL 8080:…`. */
const SSH_VALUE_OPTION = /^-[a-zA-Z]*[BbcDEeFIiJLlmOoPpQRSWw]$/;
/** `docker run` options that take no value, so the word after one is the image. */
const DOCKER_RUN_FLAGS = new Set([
  '--detach',
  '--init',
  '--interactive',
  '--no-healthcheck',
  '--oom-kill-disable',
  '--privileged',
  '--publish-all',
  '--quiet',
  '--read-only',
  '--rm',
  '--tty',
]);
const SHELLS = new Set(['bash', 'dash', 'sh', 'zsh']);
/** `while true; do …; done`, which only a `break` or `exit` in it ends. */
const ENDLESS_LOOP = /(?:^|[;&|(]|\bdo)\s*(?:while\s+(?:true|:)|until\s+false)\s*[;\n]/;
// Not an option such as `git diff --exit-code`.
const LOOP_EXIT = /(?<![-\w])(?:break|exit|return)\b/;
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

const takesValue = (program: string, option: string) =>
  VALUE_OPTIONS.get(program)?.includes(option) ?? false;

/** The index past the options at `index` and the values of those that take one. */
function skipOptions(program: string, words: string[], index: number): number {
  while (words[index]?.startsWith('-')) if (takesValue(program, words[index++])) index++;
  return index;
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
    if (subcommand) {
      // Its own options may come before the subcommand, as in `uv --directory api run`.
      const at = skipOptions(launcher, words, index + 1);
      if (words[at] !== subcommand) break;
      index = at;
    } else if (!LAUNCHERS.has(launcher)) break;
    index = skipOptions(launcher, words, index + 1);
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
    if (takesValue(program, option)) index++;
    // The package manager's own, as in `bun --hot index.ts`; pnpm's `-w` picks the workspace root.
    else if (option !== '-w' && LONG_RUNNING_FLAGS.has(option)) return true;
  }
  if (program === 'yarn' && args[index] === 'workspace') index += 2;
  if (args[index] === 'run' || args[index] === 'run-script') index++;
  const script = args[index];
  if (!script) return false;
  // Options after the script are the script's own, as in `npm run test -- --watch`, except the
  // package manager's before a `--`, as npm's `-w` is in `npm run build -w web`.
  const rest = args.slice(index + 1);
  const end = rest.includes('--') ? rest.indexOf('--') : rest.length;
  return (
    hasLongRunningPart(script) ||
    rest.some((arg, at) => LONG_RUNNING_FLAGS.has(arg) && !(at < end && takesValue(program, arg)))
  );
}

/** The command `sh -c` or `bash -lc` runs, without its quotes. */
function shellCommand(program: string, args: string[]): string | undefined {
  if (!SHELLS.has(program)) return undefined;
  const option = args.findIndex((arg) => /^-[a-z]*c[a-z]*$/.test(arg));
  const command = option === -1 ? undefined : args[option + 1];
  return command?.replace(/^(["'])(.*)\1$/s, '$2');
}

/** `deno task dev`, also after the task's own options, as in `deno task --cwd web dev`. */
function runsLongRunningDenoTask([subcommand, ...args]: string[]): boolean | undefined {
  if (subcommand !== 'task') return undefined;
  // Otherwise a watch flag or nothing decides, as for any command.
  return hasLongRunningPart(args[skipOptions('deno', args, 0)] ?? '') || undefined;
}

/**
 * `php -S` and `php artisan serve` serve. A script, `php index.php` or `php artisan … --watch`,
 * is judged as any command is, but PHP's own options, such as `-w`, aren't a watcher's.
 */
function servesPhp(args: string[]): boolean | undefined {
  if (args.includes('-S') || (args[0] === 'artisan' && args[1] === 'serve')) return true;
  return args[0]?.startsWith('-') ? false : undefined;
}

/**
 * `ssh -N` forwards ports without running a command, until `-f` sends it to the background.
 * Otherwise the command it runs on the host decides, as `npm run dev` does in
 * `ssh dev "npm run dev"`, and a host's name, such as `dev`, says nothing.
 */
function sshServes(args: string[]): boolean {
  let at = 0;
  let flags = '';
  while (args[at]?.startsWith('-')) {
    const option = args[at++];
    if (/^-[a-zA-Z]+$/.test(option)) flags += option;
    if (SSH_VALUE_OPTION.test(option)) at++;
  }
  if (flags.includes('N')) return !flags.includes('f');
  const remote = args.slice(at + 1).join(' ');
  return remote !== '' && isLongRunningCommand(remote.replace(/^(["'])(.*)\1$/s, '$2'));
}

/**
 * Programs whose own arguments decide: true when they serve, false when they finish, and
 * undefined when the rest of the command decides, as for `php index.php`.
 */
const DECIDED_BY_ARGUMENTS = new Map<string, (args: string[]) => boolean | undefined>([
  ['celery', (args) => args.includes('worker') || args.includes('beat')],
  ['deno', runsLongRunningDenoTask],
  // Its `--watch` and `gh run watch` wait for checks, which finish.
  ['gh', () => false],
  // `desktop run` runs a GUI app until the app exits, and `mcp` serves stdio; the rest finish.
  [
    'komla',
    ([command, subcommand]) => command === 'mcp' || (command === 'desktop' && subcommand === 'run'),
  ],
  ['less', (args) => args.includes('+F')],
  ['php', servesPhp],
  ['sleep', ([duration]) => duration === 'infinity'],
  ['ssh', sshServes],
]);

/**
 * Whether `docker run` gives its image a command that names finite work, as in
 * `docker run app migrate`, rather than only an image, as in `docker run ghcr.io/acme/web:release`.
 * A word after an option is taken as its value, unless it takes none, as `-it` and `--init` do.
 */
function runsFiniteContainerCommand(args: string[]): boolean {
  const options = args.slice(1);
  const hasValue = (option = '') =>
    option.startsWith('-') &&
    !option.includes('=') &&
    !DOCKER_SHORT_FLAGS.test(option) &&
    !DOCKER_RUN_FLAGS.has(option);
  const positional = options.filter(
    (arg, at) => !arg.startsWith('-') && !hasValue(options[at - 1])
  );
  return positional.length > 1 && namesFiniteWork(positional);
}

/** Apps and containers: `node server.js`, `java -jar app.jar`, `docker compose up`, `vite`. */
function startsApp(program: string, args: string[]): boolean {
  const [subcommand = ''] = args;
  const detached = args.some(
    (arg) => arg === '--detach' || (DOCKER_SHORT_FLAGS.test(arg) && arg.includes('d'))
  );
  if (program === 'docker' || program === 'docker-compose') {
    if (args.includes('up')) return !detached;
    return (
      subcommand === 'run' &&
      !detached &&
      !args.includes('--rm') &&
      !runsFiniteContainerCommand(args)
    );
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
  // Node given a package's own script, as in `node node_modules/vite/bin/vite.js`, runs it.
  if (program === 'node' && /(?:^|[\\/])node_modules[\\/]/.test(args[0] ?? '')) {
    const [script, ...rest] = args;
    return { program: programName(script).replace(/\.[cm]?js$/, ''), args: rest };
  }
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
  const decided = DECIDED_BY_ARGUMENTS.get(program)?.(args);
  if (decided !== undefined) return decided;
  if (args.some((arg) => LONG_RUNNING_FLAGS.has(arg))) return true;
  const subcommand = args[0] ?? '';
  if (LONG_RUNNING_PROGRAMS.has(program) || hasLongRunningPart(program)) return true;
  if (LONG_RUNNING_WORDS.has(subcommand)) return true;
  if (RUN_SUBCOMMANDS.get(program)?.includes(subcommand)) return !namesFiniteWork(args);
  const follows = program === 'tail' || program === 'journalctl' || subcommand === 'logs';
  if (follows && args.some((arg) => FOLLOW_FLAG.test(arg))) return true;
  return startsApp(program, args);
}
