import { execFile, spawn } from 'child_process';
import { lstatSync, readFileSync, realpathSync, statSync } from 'fs';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'path';
import { StringDecoder } from 'string_decoder';
import { promisify } from 'util';

import { createLogger } from '../../lib/logger';
import { applySshAskpassEnv } from '../../lib/ssh-client';
import { askpassService } from '../askpass.service';

const logger = createLogger('GitService');

const execFileAsync = promisify(execFile);

const COMMON_GIT_DIRS =
  process.platform === 'win32'
    ? [
        process.env.ProgramFiles ? `${process.env.ProgramFiles}\\Git\\cmd` : '',
        process.env['ProgramFiles(x86)'] ? `${process.env['ProgramFiles(x86)']}\\Git\\cmd` : '',
        process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Programs\\Git\\cmd` : '',
      ].filter(Boolean)
    : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];

function getPathEnvKey(env: NodeJS.ProcessEnv): string {
  if (process.platform !== 'win32') return 'PATH';
  return Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'Path';
}

export function buildGitEnv(extraEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
  const pathKey = getPathEnvKey(env);
  const currentPath = env[pathKey] ?? '';
  const pathParts = currentPath.split(delimiter).filter(Boolean);
  const normalized = new Set(
    pathParts.map((part) => (process.platform === 'win32' ? part.toLowerCase() : part))
  );
  const missingCommonDirs = COMMON_GIT_DIRS.filter((dir) => {
    const key = process.platform === 'win32' ? dir.toLowerCase() : dir;
    return !normalized.has(key);
  });

  if (missingCommonDirs.length > 0) {
    // Ahead of the system folders, so an app launched from the Dock runs the git a terminal
    // runs (Homebrew's over Apple's), with that git's config and Keychain helper.
    const systemDir =
      process.platform === 'darwin'
        ? pathParts.findIndex((part) => part === '/usr/bin' || part === '/bin')
        : -1;
    const at = systemDir === -1 ? pathParts.length : systemDir;
    pathParts.splice(at, 0, ...missingCommonDirs);
    env[pathKey] = pathParts.join(delimiter);
  }

  if (process.platform === 'win32') {
    for (const key of Object.keys(env)) {
      if (key !== pathKey && key.toLowerCase() === 'path') {
        delete env[key];
      }
    }
  }

  // Never run a repository's fsmonitor hook: whoever can write its config, such
  // as an agent, would have their command run by every status refresh. This is
  // how `git -c` hands config to git, and unlike GIT_CONFIG_COUNT, git before
  // 2.31 reads it too.
  env.GIT_CONFIG_PARAMETERS = [env.GIT_CONFIG_PARAMETERS, "'core.fsmonitor=false'"]
    .filter(Boolean)
    .join(' ');

  return env;
}

/** A local worktree workspace and the repositories its worktree may have been added from. */
export interface ManagedWorktree {
  worktreePath: string;
  repoPaths: string[];
}

function readGitFile(gitFile: string): string | undefined {
  const match = readFileSync(gitFile, 'utf-8').match(/^gitdir:\s*(.+?)\s*$/m);
  return match ? resolve(dirname(gitFile), match[1]) : undefined;
}

/** The directory with a repository's config, objects and `worktrees/`. */
function commonGitDir(repoPath: string): string {
  const dotGit = join(repoPath, '.git');
  let gitDir: string;
  try {
    gitDir = statSync(dotGit).isFile() ? (readGitFile(dotGit) ?? dotGit) : dotGit;
  } catch {
    // A bare repository, like a managed project's clone.
    return repoPath;
  }
  try {
    return resolve(gitDir, readFileSync(join(gitDir, 'commondir'), 'utf-8').trim());
  } catch {
    return gitDir;
  }
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

function samePath(a: string, b: string): boolean {
  return process.platform === 'linux' ? a === b : a.toLowerCase() === b.toLowerCase();
}

/**
 * The gitdir a managed worktree's `.git` file names, once it is confirmed to be
 * one `git worktree add` made in one of the project's repositories. An agent in the
 * worktree can rewrite that file, or swap in a repository of its own, so that
 * git runs commands from config it wrote (fsmonitor, filters, hooks) as Komla,
 * outside the agent's sandbox. Undefined when there is nothing to pin.
 */
function verifiedWorktreeGitDir({ worktreePath, repoPaths }: ManagedWorktree): string | undefined {
  const gitFile = join(worktreePath, '.git');
  let entry: ReturnType<typeof lstatSync>;
  try {
    entry = lstatSync(gitFile);
  } catch {
    // Not created yet, or already removed: git finds no repository here.
    return undefined;
  }
  try {
    const gitDir = entry.isFile() ? readGitFile(gitFile) : undefined;
    if (gitDir) {
      const verified = realpathSync.native(gitDir);
      for (const repoPath of repoPaths) {
        const worktrees = join(commonGitDir(repoPath), 'worktrees');
        if (samePath(dirname(verified), realpathOrSelf(worktrees))) return verified;
      }
    } else if (
      entry.isDirectory() &&
      repoPaths.some((repoPath) => samePath(realpathOrSelf(worktreePath), realpathOrSelf(repoPath)))
    ) {
      // The project's own checkout.
      return undefined;
    }
  } catch {
    // A gitdir that doesn't exist is refused below as well.
  }
  throw new Error(
    `Komla stopped running git in ${worktreePath} because its .git no longer points into ${repoPaths[0]}. ` +
      `If you moved the project, run "git worktree repair" there.`
  );
}

/**
 * The environment applyNoPromptEnv sets and removes, which background fetches on SSH hosts apply
 * too. They leave the host's credential helpers alone: those can't open a dialog here.
 */
export const NO_PROMPT_GIT_ENV = {
  set: { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', SSH_ASKPASS_REQUIRE: 'never' },
  unset: ['SSH_ASKPASS', 'GIT_ASKPASS'],
  sshCommand: 'ssh -o BatchMode=yes -o ConnectTimeout=15',
} as const;

/**
 * The `git config -z --get-regexp` pattern for the settings `applyNoPromptEnv` reads: the
 * repository's own ssh command and every credential helper.
 */
export const NO_PROMPT_CONFIG_KEYS = '^(core\\.sshcommand|credential\\.(.*\\.)?helper)$';

// Helpers that answer from their own store without ever opening a window. Git Credential Manager
// keeps to that with GCM_INTERACTIVE=never on Windows and macOS; on Linux it may use a keyring or
// gpg that asks to unlock. Others, such as osxkeychain (macOS asks for the login password when
// the helper isn't on a Keychain item's access list) or libsecret, can show a dialog.
const QUIET_CREDENTIAL_HELPERS = new Set([
  'store',
  'cache',
  ...(process.platform === 'win32' ? ['wincred', 'manager', 'manager-core'] : []),
  ...(process.platform === 'darwin' ? ['manager', 'manager-core'] : []),
]);

/** A helper setting's program, unquoted, and the arguments after it. */
function splitHelper(helper: string): [string, string] {
  const match = /^\s*(?:'([^']*)'|"([^"]*)"|((?:\\.|\S)+))(.*)$/s.exec(helper);
  if (!match) return ['', ''];
  const program = match[1] ?? match[2] ?? match[3].replace(/\\(.)/g, '$1');
  return [program, match[4].trim()];
}

function isQuietHelper(helper: string): boolean {
  if (helper.startsWith('!')) {
    // What `gh auth setup-git` writes. gh reads its token without a dialog on macOS and Windows;
    // on Linux it keeps it in a keyring that may ask to unlock.
    const [program, args] = splitHelper(helper.slice(1));
    return (
      (process.platform === 'darwin' || process.platform === 'win32') &&
      /^gh(\.exe)?$/i.test(basename(program)) &&
      args === 'auth git-credential'
    );
  }
  const name = basename(splitHelper(helper)[0])
    .replace(/^git-credential-/, '')
    .replace(/\.exe$/i, '');
  return QUIET_CREDENTIAL_HELPERS.has(name);
}

function parseConfigEntries(entries: string): Array<[key: string, value: string | undefined]> {
  return entries
    .split('\0')
    .filter(Boolean)
    .map((entry) => {
      const [key, value] = entry.split(/\n(.*)/s);
      return [key, value];
    });
}

/**
 * The credential helper settings to hand git so it runs the helpers it would anyway, in order and
 * for the same URLs, minus any that could open a dialog. `entries` is `git config -z
 * --get-regexp` output; settings other than credential helpers are ignored.
 */
export function quietCredentialHelperConfig(entries: string): string[] {
  // An empty helper clears the ones set before it, here every one from config files.
  const config = ['credential.helper='];
  for (const [key, value] of parseConfigEntries(entries)) {
    if (!/^credential\.(.*\.)?helper$/.test(key)) continue;
    // A URL holding "=" can't be handed over in key=value form: run no helper at all.
    if (key.includes('=')) return ['credential.helper='];
    if (value === '' || (value !== undefined && isQuietHelper(value))) {
      config.push(`${key}=${value}`);
    }
  }
  return config;
}

/**
 * Makes git and the ssh it runs fail rather than ask for anything: no terminal prompt, credential
 * dialog, passphrase dialog or host key question. `config` is the repository's
 * NO_PROMPT_CONFIG_KEYS settings. Unless the repository sets its own ssh command, which the
 * environment variable would replace, ssh also gives up on hosts that need a password or an
 * unknown host key.
 */
export function applyNoPromptEnv(env: NodeJS.ProcessEnv, config: string): void {
  Object.assign(env, NO_PROMPT_GIT_ENV.set);
  for (const name of NO_PROMPT_GIT_ENV.unset) delete env[name];
  // The last one wins, as with `git config --get`: a repository can clear a global one.
  const ownSshCommand = parseConfigEntries(config).findLast(
    ([key]) => key === 'core.sshcommand'
  )?.[1];
  if (!ownSshCommand && !env.GIT_SSH_COMMAND && !env.GIT_SSH) {
    env.GIT_SSH_COMMAND = NO_PROMPT_GIT_ENV.sshCommand;
  }
  // Read after config files, so these replace their askpass program and helpers.
  env.GIT_CONFIG_PARAMETERS = [
    env.GIT_CONFIG_PARAMETERS,
    ...['core.askPass=', ...quietCredentialHelperConfig(config)].map(
      (setting) => `'${setting.replace(/'/g, "'\\''")}'`
    ),
  ]
    .filter(Boolean)
    .join(' ');
}

/** Whether git runs, looking in the same places as every other Komla git command. */
export async function isGitInstalled(): Promise<boolean> {
  try {
    await execFileAsync('git', ['--version'], { env: buildGitEnv() });
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether git in `cwd` runs the `ssh` on PATH, which Komla checks before remembering key
 * passphrases. Git for Windows runs its own bundled ssh.
 */
export async function gitUsesPathSsh(env: NodeJS.ProcessEnv, cwd?: string): Promise<boolean> {
  if (process.platform === 'win32' || env.GIT_SSH_COMMAND || env.GIT_SSH) return false;
  try {
    await execFileAsync('git', ['config', '--get', 'core.sshCommand'], { cwd, env });
    return false;
  } catch (error) {
    // git config exits 1 when the key is unset
    return (error as { code?: unknown }).code === 1;
  }
}

/**
 * Extract a human-readable message from an unknown catch value.
 * Node.js child-process errors carry `stderr` and/or `message`; this function
 * checks for those properties with proper runtime type narrowing instead of
 * relying on an unsafe type assertion.
 */
export function extractGitError(error: unknown, fallback: string): string {
  if (typeof error === 'object' && error !== null) {
    const obj = error as Record<string, unknown>;
    if (obj['code'] === 'ENOENT' && (obj['path'] === 'git' || obj['spawnargs'])) {
      return 'Git executable not found. Install Git or restart Komla after updating PATH.';
    }
    if (typeof obj['stderr'] === 'string' && obj['stderr']) return obj['stderr'];
    if (typeof obj['message'] === 'string' && obj['message']) return obj['message'];
  }
  if (error instanceof Error) return error.message;
  return fallback;
}

/** Progress counters and fetch report lines, which Git prints ahead of the actual failure. */
const GIT_TRANSFER_NOISE = [
  /^(remote: )?(Enumerating|Counting|Compressing|Receiving|Resolving|Unpacking|Writing) (objects|deltas)\b/,
  /^(remote: )?Total \d+ \(delta/,
  /^(Updating|Checking out) files:/,
  /^From \S/,
  /^ [ +*=t-] .* -> \S/,
];

/** Keeps what a terminal would leave on screen once Git's transfer output is gone. */
export function stripGitTransferNoise(output: string): string {
  return output
    .split('\n')
    .map((line) => (line.split('\r').findLast((part) => part.trim()) ?? '').trimEnd())
    .filter((line) => !GIT_TRANSFER_NOISE.some((pattern) => pattern.test(line)))
    .join('\n')
    .trim();
}

function formatConflictedFiles(files: string[]): string {
  if (files.length === 1) return `${files[0]} has conflicts`;

  const visibleFiles = files.slice(0, 5);
  const remaining = files.length - visibleFiles.length;
  const suffix = remaining > 0 ? `, and ${remaining} more` : '';
  return `${files.length} files have conflicts: ${visibleFiles.join(', ')}${suffix}`;
}

export function activeConflictMessage(
  operation: string,
  files: string[],
  completion: string
): string {
  return `${operation} paused because ${formatConflictedFiles(files)}. Resolve the conflicts in this workspace, then ${completion}.`;
}

const BACKGROUND_STOPPED = 'Git was stopped for other work in this repository';

export interface GitProgressCallback {
  (percent: number, stage: string): void;
}

interface RepoLock {
  activeReaders: Set<Promise<void>>;
  lastWriter: Promise<void>;
  pendingWrites: number;
}

export { logger };

class GitExec {
  // Cache for frequently called methods
  cache = new Map<string, { value: unknown; expiry: number }>();
  readonly CACHE_TTL_MS = 2000; // 2 seconds
  readonly BRANCH_CACHE_TTL_MS = 30_000; // 30 seconds for branch names (invalidated explicitly on switch)

  // Registry mapping worktree paths to configured target branches
  targetBranchMap = new Map<string, string>();

  private managedWorktreeLookup: (path: string) => ManagedWorktree | undefined = () => undefined;

  // Per-path read-write lock to prevent index.lock conflicts.
  // Each worktree (or bare repo) gets its own lock keyed by resolved path.
  // Git's own per-ref lockfiles handle cross-worktree coordination for shared
  // state (refs, remote-tracking branches), so repo-level serialization is unnecessary.
  private pathLocks = new Map<string, RepoLock>();

  // Stops for the background git work in each path, keyed like pathLocks.
  private backgroundStops = new Map<string, Set<() => void>>();
  // How often stopBackgroundWork ran in each path, so work begun before a stop can tell.
  private backgroundStopCounts = new Map<string, number>();

  // Git subcommands that are safe to run concurrently within the same path.
  // `status` refreshes the index stat cache but is safe under per-path locking
  // since each worktree has its own index. `fetch` is excluded because it updates
  // remote-tracking refs. Commands with mutating subcommands (branch, config,
  // remote, tag, reflog) are intentionally excluded — the serialization cost is
  // negligible and avoids ref/config corruption from variants like `branch -D`.
  private static readonly CONCURRENT_SAFE_COMMANDS = new Set([
    'blame',
    'cat-file',
    'count-objects',
    'describe',
    'diff',
    'diff-tree',
    'for-each-ref',
    'fsck',
    'log',
    'ls-files',
    'ls-remote',
    'ls-tree',
    'merge-base',
    'name-rev',
    'rev-list',
    'rev-parse',
    'shortlog',
    'show',
    'show-ref',
    'status',
    'verify-commit',
  ]);

  private getLock(pathKey: string): RepoLock {
    let lock = this.pathLocks.get(pathKey);
    if (!lock) {
      lock = { activeReaders: new Set(), lastWriter: Promise.resolve(), pendingWrites: 0 };
      this.pathLocks.set(pathKey, lock);
    }
    return lock;
  }

  private cleanupLock(pathKey: string): void {
    const lock = this.pathLocks.get(pathKey);
    if (lock && lock.activeReaders.size === 0 && lock.pendingWrites === 0) {
      this.pathLocks.delete(pathKey);
    }
  }

  private isConcurrentSafe(args: string[]): boolean {
    const cmd = args.find((a) => !a.startsWith('-'));
    return cmd ? GitExec.CONCURRENT_SAFE_COMMANDS.has(cmd) : false;
  }

  /**
   * Enqueue a read operation. Readers wait for active writers, then run concurrently.
   */
  private enqueueRead<T>(repoPath: string, fn: () => Promise<T>): Promise<T> {
    const pathKey = resolve(repoPath);
    const lock = this.getLock(pathKey);

    // Wait for the last enqueued writer, then run concurrently with other readers
    const gate = lock.lastWriter;
    const run = gate.then(fn);

    const done: Promise<void> = run.then(
      () => {},
      () => {}
    );
    lock.activeReaders.add(done);
    void done.then(() => {
      lock.activeReaders.delete(done);
      this.cleanupLock(pathKey);
    });

    return run;
  }

  /**
   * Enqueue a write operation. Writers wait for all active readers and prior writers.
   */
  private enqueueWrite<T>(repoPath: string, fn: () => Promise<T>): Promise<T> {
    const pathKey = resolve(repoPath);
    const lock = this.getLock(pathKey);

    lock.pendingWrites++;

    const prevWriter = lock.lastWriter;
    const currentReaders = [...lock.activeReaders];

    const run = Promise.all([prevWriter, ...currentReaders])
      .then(
        () => {},
        () => {}
      )
      .then(fn);

    const done: Promise<void> = run.then(
      () => {},
      () => {}
    );
    lock.lastWriter = done;

    void done.then(() => {
      lock.pendingWrites--;
      this.cleanupLock(pathKey);
    });

    return run;
  }

  /**
   * Return env overrides for a git command in `repoPath`, throwing if it is a
   * managed worktree whose `.git` no longer leads into its project.
   * Setting GIT_OPTIONAL_LOCKS=0 for read-only commands prevents git from acquiring the index lock
   * just to refresh stat caches, avoiding lock conflicts with external processes
   * (e.g. AI agents in terminals) that run concurrent git operations on the same repo.
   * Read-only commands, which Komla also runs on its own, pin the verified gitdir
   * so that git never reads a `.git` file rewritten after the check.
   */
  private envFor(repoPath: string, args: string[]): NodeJS.ProcessEnv | undefined {
    const worktree = this.managedWorktreeLookup(repoPath);
    const gitDir = worktree && verifiedWorktreeGitDir(worktree);
    if (this.isConcurrentSafe(args)) {
      return {
        GIT_OPTIONAL_LOCKS: '0',
        ...(gitDir && { GIT_DIR: gitDir, GIT_WORK_TREE: worktree.worktreePath }),
      };
    }
    return undefined;
  }

  /**
   * Enqueue a git operation with automatic read/write classification.
   * Read-only commands run concurrently; others are serialized exclusively.
   */
  private enqueue<T>(repoPath: string, args: string[], fn: () => Promise<T>): Promise<T> {
    if (this.isConcurrentSafe(args)) {
      return this.enqueueRead(repoPath, fn);
    }
    return this.enqueueWrite(repoPath, fn);
  }

  /**
   * Register a workspace's configured target branch for git operations.
   * Called by WorkspaceService when creating/loading workspaces.
   */
  registerTargetBranch(worktreePath: string, baseBranch?: string): void {
    if (baseBranch) {
      this.targetBranchMap.set(worktreePath, baseBranch);
    } else {
      this.targetBranchMap.delete(worktreePath);
    }
  }

  /**
   * Let git commands in a worktree workspace check its `.git` file first.
   * Set by WorkspaceService, which knows each worktree's project.
   */
  setManagedWorktreeLookup(lookup: (path: string) => ManagedWorktree | undefined): void {
    this.managedWorktreeLookup = lookup;
  }

  /**
   * Get the target branch for git operations.
   * Returns configured baseBranch if registered, otherwise detects the default branch.
   */
  async getTargetBranch(worktreePath: string): Promise<string> {
    const configured = this.targetBranchMap.get(worktreePath);
    if (configured) {
      return configured;
    }
    return this.getMainBranch(worktreePath);
  }

  getCached<T>(key: string): T | undefined {
    const cached = this.cache.get(key);
    if (cached && Date.now() < cached.expiry) return cached.value as T;
    return undefined;
  }

  setCache(key: string, value: unknown, ttlMs?: number): void {
    this.cache.set(key, { value, expiry: Date.now() + (ttlMs ?? this.CACHE_TTL_MS) });
  }

  invalidateCache(keyPrefix?: string): void {
    if (keyPrefix) {
      for (const key of this.cache.keys()) {
        if (key.startsWith(keyPrefix)) {
          this.cache.delete(key);
        }
      }
    } else {
      this.cache.clear();
    }
  }

  async execGitAsync(repoPath: string, args: string[]): Promise<string> {
    const env = buildGitEnv(this.envFor(repoPath, args));
    return this.enqueue(repoPath, args, async () => {
      try {
        const { stdout } = await execFileAsync('git', args, {
          cwd: repoPath,
          encoding: 'utf-8',
          maxBuffer: 50 * 1024 * 1024, // 50MB buffer for large outputs
          env,
        });
        return stdout.trim();
      } catch (error: unknown) {
        throw new Error(extractGitError(error, 'Git command failed'));
      }
    });
  }

  async resolvePublishedCommit(repoPath: string, revision: string): Promise<string> {
    const originRevision = revision
      .replace(/^refs\/remotes\/origin\//, '')
      .replace(/^origin\//, '');
    const resolveOriginCommit = async (): Promise<string | null> => {
      try {
        return await this.execGitAsync(repoPath, [
          'rev-parse',
          '--verify',
          `refs/remotes/origin/${originRevision}^{commit}`,
        ]);
      } catch {
        return null;
      }
    };

    try {
      await this.execGitWithProgress(
        repoPath,
        ['fetch', 'origin', '+refs/heads/*:refs/remotes/origin/*', '--prune'],
        undefined,
        { enableAskpass: true }
      );
    } catch (error) {
      throw new Error(
        `Could not verify whether selected revision "${revision}" is available on origin: ${extractGitError(error, 'Git fetch failed')}`
      );
    }
    const commit = await resolveOriginCommit();
    if (!commit) {
      throw new Error(
        `Selected revision "${revision}" has not been pushed to origin. Push it before creating an SSH workspace.`
      );
    }
    return commit;
  }

  /**
   * Like execGitAsync but preserves leading whitespace in the output.
   * Used by callers that parse positional columns (e.g. git status --porcelain).
   */
  async execGitAsyncRaw(repoPath: string, args: string[]): Promise<string> {
    const env = buildGitEnv(this.envFor(repoPath, args));
    return this.enqueue(repoPath, args, async () => {
      try {
        const { stdout } = await execFileAsync('git', args, {
          cwd: repoPath,
          encoding: 'utf-8',
          maxBuffer: 50 * 1024 * 1024,
          env,
        });
        return stdout.trimEnd();
      } catch (error: unknown) {
        throw new Error(extractGitError(error, 'Git command failed'));
      }
    });
  }

  execGitAsyncRawLimited(
    repoPath: string,
    args: string[],
    maxChars: number
  ): Promise<{ output: string; truncated: boolean }> {
    return this.enqueue(
      repoPath,
      args,
      () =>
        new Promise((resolve, reject) => {
          const env = buildGitEnv(this.envFor(repoPath, args));
          const proc = spawn('git', args, { cwd: repoPath, env });
          const decoder = new StringDecoder('utf8');
          let output = '';
          let stderr = '';
          let truncated = false;

          const appendOutput = (text: string): void => {
            const remaining = maxChars - output.length;
            if (text.length > remaining) truncated = true;
            if (remaining > 0) output += text.slice(0, remaining);
          };

          proc.stdout.on('data', (data: Buffer) => {
            appendOutput(decoder.write(data));
          });
          proc.stderr.on('data', (data: Buffer) => {
            if (stderr.length < 64_000) {
              stderr += data.toString('utf8').slice(0, 64_000 - stderr.length);
            }
          });
          proc.on('close', (code) => {
            appendOutput(decoder.end());
            if (code === 0) {
              resolve({ output: output.trimEnd(), truncated });
            } else {
              reject(new Error(stderr.trim() || `Git exited with code ${code}`));
            }
          });
          proc.on('error', (error) => {
            reject(new Error(extractGitError(error, 'Git command failed')));
          });
        })
    );
  }

  /**
   * `git patch-id --stable` over the diffs `git <args>` prints, such as a `log -p` or a `diff`.
   * The diffs stream into patch-id, so a long history never sits in memory.
   */
  execGitPatchIds(repoPath: string, args: string[]): Promise<string> {
    return this.enqueue(
      repoPath,
      args,
      () =>
        new Promise((resolve, reject) => {
          const env = buildGitEnv(this.envFor(repoPath, args));
          const diffs = spawn('git', args, { cwd: repoPath, env });
          const patchIds = spawn('git', ['patch-id', '--stable'], { cwd: repoPath, env });
          // patch-id exiting early is reported by its own exit code.
          patchIds.stdin.on('error', () => {});
          diffs.stdout.pipe(patchIds.stdin);
          const diffsExit = new Promise<number | null>((done) => diffs.on('close', done));
          let output = '';
          let stderr = '';
          patchIds.stdout.setEncoding('utf8');
          patchIds.stdout.on('data', (data: string) => {
            output += data;
          });
          for (const proc of [diffs, patchIds]) {
            proc.stderr.on('data', (data: Buffer) => {
              if (stderr.length < 64_000) stderr += data.toString('utf8');
            });
            proc.on('error', (error) => {
              reject(new Error(extractGitError(error, 'Git command failed')));
            });
          }
          patchIds.on('close', (code) => {
            void diffsExit.then((diffsCode) => {
              if (diffsCode !== 0 || code !== 0) {
                reject(new Error(stderr.trim() || `Git exited with code ${diffsCode || code}`));
                return;
              }
              resolve(output.trim());
            });
          });
        })
    );
  }

  execGitWriteSequence(repoPath: string, commands: string[][]): Promise<string[]> {
    return this.enqueueWrite(repoPath, async () => {
      const outputs: string[] = [];
      for (const args of commands) {
        const env = buildGitEnv(this.envFor(repoPath, args));
        try {
          const { stdout } = await execFileAsync('git', args, {
            cwd: repoPath,
            encoding: 'utf-8',
            maxBuffer: 50 * 1024 * 1024,
            env,
          });
          outputs.push(stdout.trim());
        } catch (error: unknown) {
          throw new Error(extractGitError(error, 'Git command failed'));
        }
      }
      return outputs;
    });
  }

  /**
   * A file's text at a ref, byte for byte. Read file content through this rather than
   * execGitAsync, whose trim drops the final newline and leading blank lines.
   */
  async readBlobText(repoPath: string, ref: string, filePath: string): Promise<string> {
    const buf = await this.execGitAsyncBuffer(repoPath, ['show', `${ref}:${filePath}`]);
    return buf.toString('utf-8');
  }

  execGitAsyncBuffer(repoPath: string, args: string[]): Promise<Buffer> {
    return this.enqueue(repoPath, args, () => {
      return new Promise((res, reject) => {
        const env = buildGitEnv(this.envFor(repoPath, args));
        execFile(
          'git',
          args,
          {
            cwd: repoPath,
            encoding: 'buffer',
            maxBuffer: 50 * 1024 * 1024,
            env,
          },
          (error, stdout) => {
            if (error) {
              reject(new Error(extractGitError(error, 'Git command failed')));
            } else {
              res(stdout);
            }
          }
        );
      });
    });
  }

  /**
   * Execute a git command with progress streaming via spawn.
   * Parses git's progress output (e.g., "Receiving objects: 45% (123/273)")
   * and calls the onProgress callback with percent and stage.
   *
   * @param repoPath - Path to the git repository
   * @param args - Git command arguments
   * @param onProgress - Optional progress callback
   * @param options - enableAskpass for SSH passphrase prompting; noPrompts to fail instead of
   *   asking for anything (see applyNoPromptEnv); timeoutMs to stop git after that long;
   *   background, a backgroundMark taken when the work began, to let stopBackgroundWork stop git
   */
  execGitWithProgress(
    repoPath: string,
    args: string[],
    onProgress?: GitProgressCallback,
    options?: {
      enableAskpass?: boolean;
      noPrompts?: { config: string };
      timeoutMs?: number;
      background?: number;
    }
  ): Promise<string> {
    const pathKey = resolve(repoPath);
    // Work stopped since its mark was taken doesn't start.
    let stopped =
      options?.background !== undefined && options.background !== this.backgroundMark(repoPath);
    let stopRunning: (() => void) | undefined;
    const stop = (): void => {
      stopped = true;
      stopRunning?.();
    };
    const run = this.enqueue(
      repoPath,
      args,
      () =>
        new Promise<string>((res, reject) => {
          if (stopped) {
            reject(new Error(BACKGROUND_STOPPED));
            return;
          }

          // Build environment based on options
          const env = buildGitEnv(this.envFor(repoPath, args));

          // Without the passphrase dialog, disable terminal prompts
          if (options?.noPrompts) {
            applyNoPromptEnv(env, options.noPrompts.config);
          } else if (
            !options?.enableAskpass ||
            !applySshAskpassEnv(env, askpassService, () => gitUsesPathSsh(env, repoPath))
          ) {
            env.GIT_TERMINAL_PROMPT = '0';
          }

          const proc = spawn('git', args, {
            cwd: repoPath,
            env,
          });
          // Windows ends a killed git at once, without removing its lock files, which would
          // fail every later command needing them; there git is left to finish on its own.
          const killable = process.platform !== 'win32';
          let timedOut = false;
          // Settles right away: a child such as ssh can keep git's output open after the kill,
          // so 'close' may never come.
          const timeout =
            options?.timeoutMs === undefined
              ? undefined
              : setTimeout(() => {
                  timedOut = true;
                  if (killable) proc.kill();
                  reject(new Error(`Git took longer than ${options.timeoutMs} ms`));
                }, options.timeoutMs);

          // Settles once git is gone, so work queued behind it finds no lock files left, and
          // without waiting for 'close', which a child such as ssh can hold off. The timeout
          // still settles it should git not exit.
          let exited = false;
          proc.on('exit', () => {
            exited = true;
          });
          if (killable) {
            stopRunning = () => {
              if (exited) reject(new Error(BACKGROUND_STOPPED));
              else proc.once('exit', () => reject(new Error(BACKGROUND_STOPPED)));
              proc.kill();
            };
          }

          let stdout = '';
          let stderr = '';

          proc.stdout.on('data', (data) => {
            stdout += data.toString();
          });

          proc.stderr.on('data', (data) => {
            const line = data.toString();
            stderr += line;

            // Parse git progress output
            // Format: "Receiving objects:  45% (123/273)" or "Compressing objects:  10% (5/50)"
            const match = line.match(/(\w+(?:\s+\w+)?):\s*(\d+)%/);
            if (match && onProgress) {
              onProgress(parseInt(match[2], 10), match[1]);
            }
          });

          proc.on('close', (code) => {
            clearTimeout(timeout);
            if (timedOut) return;
            if (code === 0) {
              res(stdout.trim());
            } else {
              // Merge outcomes such as "Automatic merge failed" go to stdout.
              reject(
                new Error(
                  stripGitTransferNoise(stderr) || stdout.trim() || `Git exited with code ${code}`
                )
              );
            }
          });

          proc.on('error', (error) => {
            clearTimeout(timeout);
            reject(error);
          });
        })
    );
    if (options?.background !== undefined) {
      let stops = this.backgroundStops.get(pathKey);
      if (!stops) {
        stops = new Set();
        this.backgroundStops.set(pathKey, stops);
      }
      stops.add(stop);
      const forget = (): void => {
        stops.delete(stop);
        if (stops.size === 0 && this.backgroundStops.get(pathKey) === stops) {
          this.backgroundStops.delete(pathKey);
        }
      };
      void run.then(forget, forget);
    }
    return run;
  }

  /**
   * Stops git started with `background` in `repoPath`, so the work that follows doesn't wait for
   * it: queued git and git whose work began before this never start, and running git is killed
   * (left to finish on Windows). Its promise rejects once git has exited.
   */
  stopBackgroundWork(repoPath: string): void {
    const pathKey = resolve(repoPath);
    this.backgroundStopCounts.set(pathKey, (this.backgroundStopCounts.get(pathKey) ?? 0) + 1);
    for (const stop of this.backgroundStops.get(pathKey) ?? []) stop();
  }

  /** Marks the start of background work in `repoPath`, for execGitWithProgress's `background`. */
  backgroundMark(repoPath: string): number {
    return this.backgroundStopCounts.get(resolve(repoPath)) ?? 0;
  }

  /**
   * The branch origin/HEAD names, or null when the repository doesn't record one.
   * Verifies the remote tracking ref actually resolves — it can be stale/dangling.
   */
  async getRemoteDefaultBranch(repoPath: string): Promise<string | null> {
    const cacheKey = `remoteDefaultBranch:${repoPath}`;
    const cached = this.getCached<string | null>(cacheKey);
    if (cached !== undefined) return cached;

    let result: string | null = null;
    try {
      const ref = await this.execGitAsync(repoPath, ['symbolic-ref', 'refs/remotes/origin/HEAD']);
      // ref looks like "refs/remotes/origin/<branch>" — extract the branch name
      const branch = ref.replace('refs/remotes/origin/', '');
      if (branch) {
        await this.execGitAsync(repoPath, [
          'rev-parse',
          '--verify',
          `refs/remotes/origin/${branch}`,
        ]);
        result = branch;
      }
    } catch {
      // No origin, origin/HEAD not set, or dangling ref
    }

    this.setCache(cacheKey, result, this.BRANCH_CACHE_TTL_MS);
    return result;
  }

  async getMainBranch(repoPath: string): Promise<string> {
    const cacheKey = `mainBranch:${repoPath}`;
    const cached = this.getCached<string>(cacheKey);
    if (cached !== undefined) return cached;

    let result: string | undefined;

    // 1. The remote's default branch (origin/HEAD) wins over a leftover local main or master
    result = (await this.getRemoteDefaultBranch(repoPath)) ?? undefined;

    // 2. Then the conventional names
    if (!result) {
      try {
        await this.execGitAsync(repoPath, ['rev-parse', '--verify', 'refs/heads/main']);
        result = 'main';
      } catch {
        try {
          await this.execGitAsync(repoPath, ['rev-parse', '--verify', 'refs/heads/master']);
          result = 'master';
        } catch {
          // Neither main nor master exist
        }
      }
    }

    // 3. Fall back to whatever HEAD points to (works for local-only repos)
    // In bare repos HEAD is a symbolic pointer that may reference a branch
    // with no commits yet, so verify the ref actually resolves.
    if (!result) {
      try {
        const ref = await this.execGitAsync(repoPath, ['symbolic-ref', 'HEAD']);
        const branch = ref.replace('refs/heads/', '');
        if (branch) {
          await this.execGitAsync(repoPath, ['rev-parse', '--verify', `refs/heads/${branch}`]);
          result = branch;
        }
      } catch {
        // Detached HEAD, empty repo, or HEAD points to unborn branch
      }
    }

    // 4. Last resort — default to 'main' (matches git's default init.defaultBranch).
    // This only fires for truly degenerate cases (empty repo, no branches at all).
    if (!result) {
      result = 'main';
    }

    this.setCache(cacheKey, result, this.BRANCH_CACHE_TTL_MS);
    return result;
  }

  async getCurrentBranch(path: string): Promise<string> {
    const cacheKey = `currentBranch:${path}`;
    const cached = this.getCached<string>(cacheKey);
    if (cached !== undefined) return cached;

    const result = await this.execGitAsync(path, ['rev-parse', '--abbrev-ref', 'HEAD']);
    this.setCache(cacheKey, result, this.BRANCH_CACHE_TTL_MS);
    return result;
  }

  /**
   * The branch HEAD points at, read live and unabbreviated so a tag or remote
   * sharing its name can't turn it into `heads/<name>`. Undefined when detached.
   */
  async getCheckedOutBranch(path: string): Promise<string | undefined> {
    const ref = await this.execGitAsync(path, ['symbolic-ref', '--quiet', 'HEAD']).catch(() => '');
    return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : undefined;
  }

  async hasUncommittedChanges(path: string): Promise<boolean> {
    const cacheKey = `hasUncommittedChanges:${path}`;
    const cached = this.getCached<boolean>(cacheKey);
    if (cached !== undefined) return cached;

    const status = await this.execGitAsync(path, ['status', '--porcelain']);
    const result = !!status;
    this.setCache(cacheKey, result);
    return result;
  }

  async isGitRepo(path: string): Promise<boolean> {
    const cacheKey = `isGitRepo:${path}`;
    const cached = this.getCached<boolean>(cacheKey);
    if (cached !== undefined) return cached;

    let result: boolean;
    try {
      await this.execGitAsync(path, ['rev-parse', '--git-dir']);
      result = true;
    } catch {
      result = false;
    }
    this.setCache(cacheKey, result, this.BRANCH_CACHE_TTL_MS);
    return result;
  }

  async getRepoRoot(path: string): Promise<string> {
    return this.execGitAsync(path, ['rev-parse', '--show-toplevel']);
  }

  /** The Git directory a repository shares with its linked worktrees, as an absolute path. */
  async getCommonGitDir(path: string): Promise<string> {
    const gitDir = await this.execGitAsync(path, ['rev-parse', '--git-common-dir']);
    return isAbsolute(gitDir) ? gitDir : resolve(path, gitDir);
  }

  /**
   * Check if a remote exists
   */
  async hasRemote(repoPath: string, name: string): Promise<boolean> {
    try {
      await this.execGitAsync(repoPath, ['remote', 'get-url', name]);
      return true;
    } catch {
      return false;
    }
  }

  async hasRemoteTrackingBranch(worktreePath: string): Promise<boolean> {
    try {
      const branch = await this.getCurrentBranch(worktreePath);
      // Check if there's an upstream configured for this branch
      await this.execGitAsync(worktreePath, ['config', '--get', `branch.${branch}.remote`]);
      return true;
    } catch {
      // Fallback: check if the remote ref exists (for bare clone worktrees)
      try {
        const branch = await this.getCurrentBranch(worktreePath);
        await this.execGitAsync(worktreePath, ['rev-parse', '--verify', `origin/${branch}`]);
        return true;
      } catch {
        return false;
      }
    }
  }

  async getUnpushedCommits(worktreePath: string): Promise<number> {
    try {
      const branch = await this.getCurrentBranch(worktreePath);
      // Get the upstream tracking branch
      const upstream = await this.execGitAsync(worktreePath, [
        'rev-parse',
        '--abbrev-ref',
        `${branch}@{upstream}`,
      ]);
      if (!upstream) return 0;
      // Count commits ahead of upstream
      const output = await this.execGitAsync(worktreePath, [
        'rev-list',
        '--count',
        `${upstream}..${branch}`,
      ]);
      return parseInt(output, 10) || 0;
    } catch {
      // No upstream or error - return 0
      return 0;
    }
  }

  async getCommitsBehindRemote(worktreePath: string): Promise<number> {
    try {
      const branch = await this.getCurrentBranch(worktreePath);
      // Get the upstream tracking branch
      const upstream = await this.execGitAsync(worktreePath, [
        'rev-parse',
        '--abbrev-ref',
        `${branch}@{upstream}`,
      ]);
      if (!upstream) return 0;
      // Count commits behind upstream
      const output = await this.execGitAsync(worktreePath, [
        'rev-list',
        '--count',
        `${branch}..${upstream}`,
      ]);
      return parseInt(output, 10) || 0;
    } catch {
      // No upstream or error - return 0
      return 0;
    }
  }

  /**
   * Get the number of commits a branch is ahead/behind another ref
   */
  async getAheadBehind(
    repoPath: string,
    branch: string,
    baseBranch: string
  ): Promise<{ ahead: number; behind: number }> {
    try {
      const output = await this.execGitAsync(repoPath, [
        'rev-list',
        '--left-right',
        '--count',
        `${baseBranch}...${branch}`,
      ]);
      const [behind, ahead] = output.split('\t').map((n) => parseInt(n, 10) || 0);
      return { ahead, behind };
    } catch {
      return { ahead: 0, behind: 0 };
    }
  }
}

export const gitExec = new GitExec();
