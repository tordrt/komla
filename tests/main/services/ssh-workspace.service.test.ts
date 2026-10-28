/* eslint-disable import/order -- Vitest's hoisted Electron mock must precede service imports. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  ReadStream,
  lstatSync,
  readlinkSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';

import { mockElectron } from '../../mocks/electron';
import type { SshWorkspaceBackend, Workspace } from '../../../src/shared/types';
import { komlaSshRemoteDataPort } from '../../../src/shared/types/ssh';
import { sshWorkspaceDiff } from '../../../src/main/services/workspace-git/ssh-diff';
import { sshWorkspaceGit } from '../../../src/main/services/workspace-git/ssh-git';
import { CLAUDE_VERSION_CACHE_MS } from '../../../src/main/lib/claude-hook-events';

const { execFileMock, askpassMock, configGetMock, generateCommitMessageMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  askpassMock: {
    isRunning: vi.fn(() => false),
    getHelperScriptPath: vi.fn(() => null),
    getSocketPath: vi.fn(() => null),
    issueSession: vi.fn(() => 'askpass-session'),
  },
  configGetMock: vi.fn(),
  generateCommitMessageMock: vi.fn(),
}));

vi.mock('electron', () => mockElectron());

vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  execFile: execFileMock,
}));

// The Komla skill the desktop installs into agents' skills folders.
const KOMLA_SKILL = '---\nname: komla\ndescription: Control Komla\n---\n\n# Use Komla\n';
vi.mock('../../../src/main/lib/komla-skill-file', () => ({
  readKomlaSkill: () => KOMLA_SKILL,
}));

vi.mock('../../../src/main/services/askpass.service', () => ({
  askpassService: askpassMock,
}));

vi.mock('../../../src/main/services/utility-inference.service', () => ({
  utilityInferenceService: {
    generateCommitMessage: generateCommitMessageMock,
  },
}));

const sshHosts = [
  {
    id: 'ssh-dev',
    name: 'Devbox',
    hostname: '203.0.113.20',
    user: 'devuser',
    basePath: '~/.komla',
  },
  {
    id: 'ssh-agent',
    name: 'Agent Host',
    hostname: 'agent.example.com',
    user: 'dev',
    basePath: '~/.komla',
    forwardAgent: true,
  },
  {
    id: 'ssh-unconfigured',
    name: 'Unconfigured Host',
    hostname: 'unconfigured.example.com',
    basePath: '~/.komla',
  },
  {
    id: 'ssh-custom-home',
    name: 'Custom Home Host',
    hostname: 'custom-home.example.com',
    basePath: '~/.komla',
  },
  {
    id: 'ssh-status-test',
    name: 'Status Test Host',
    hostname: 'status.example.com',
    user: 'dev',
    basePath: '~/.komla',
  },
  {
    id: 'ssh-lazy-pool',
    name: 'Lazy Pool Host',
    hostname: 'lazy-pool.example.com',
    user: 'dev',
    basePath: '~/.komla',
  },
  {
    id: 'ssh-expandable-pool',
    name: 'Expandable Pool Host',
    hostname: 'expandable-pool.example.com',
    user: 'dev',
    basePath: '~/.komla',
  },
  {
    id: 'ssh-workspace-base-cache',
    name: 'Workspace Base Cache Host',
    hostname: 'workspace-base-cache.example.com',
    user: 'dev',
    basePath: '~/.komla',
  },
  {
    id: 'ssh-workspace-base-retry',
    name: 'Workspace Base Retry Host',
    hostname: 'workspace-base-retry.example.com',
    user: 'dev',
    basePath: '~/.komla',
  },
  {
    id: 'ssh-integrations',
    name: 'Integrations Host',
    hostname: 'integrations.example.com',
    user: 'devuser',
    basePath: '~/.komla',
  },
  {
    id: 'ssh-integrations-unresolved',
    name: 'Unresolved Integrations Host',
    hostname: 'integrations-unresolved.example.com',
    user: 'devuser',
    basePath: '~/.komla',
  },
];

vi.mock('../../../src/main/services/config.service', () => ({
  configService: {
    get: configGetMock,
  },
}));

vi.mock('../../../src/main/services/ssh-host.service', () => ({
  sshHostService: {
    has: vi.fn((hostId: string) => sshHosts.some((host) => host.id === hostId)),
    get: vi.fn((hostId: string) => sshHosts.find((host) => host.id === hostId)),
  },
}));

vi.mock('../../../src/main/services/http-server.service', () => ({
  httpServerService: {
    getActualPort: vi.fn(() => 54183),
  },
}));

const originalPlatform = process.platform;
const originalPath = process.env.PATH;
const originalSystemRoot = process.env.SystemRoot;

// Runs generated scripts or remote commands in a real POSIX shell standing in for the SSH host,
// and Windows has none.
const itWithPosixShell = it.skipIf(process.platform === 'win32');
// Terminal control-master pools are Unix sockets, which Komla only uses on macOS and Linux.
const itWithControlMasters = it.skipIf(process.platform === 'win32');

// Komla shares SSH connections through control masters only from macOS and Linux clients.
function expectInteractiveSshMultiplexing(sshArgs: unknown): void {
  if (process.platform === 'darwin' || process.platform === 'linux') {
    expect(sshArgs).toContain('ControlPersist=600');
  } else {
    expect(sshArgs).not.toContain('ControlPersist=600');
  }
}

function runGit(args: string[], cwd?: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    // Capture stderr instead of echoing it: fixture clones and pushes are noisy.
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Komla Test',
      GIT_AUTHOR_EMAIL: 'komla@example.com',
      GIT_COMMITTER_NAME: 'Komla Test',
      GIT_COMMITTER_EMAIL: 'komla@example.com',
    },
  }).trim();
}

// In a Komla terminal, process.env holds the variables and tmux server the notify script reads.
function envWithoutKomlaTerminal(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^(KOMLA_|TMUX)/.test(name))
  );
}

function createTargetBranchTestRepo(): {
  root: string;
  originPath: string;
  seedPath: string;
  remoteRepoPath: string;
  featurePath: string;
  backend: SshWorkspaceBackend;
} {
  const root = mkdtempSync(join(tmpdir(), 'komla-ssh-target-'));
  const originPath = join(root, 'origin.git');
  const seedPath = join(root, 'seed');
  const remoteRepoPath = join(root, 'remote', 'repo.git');
  const featurePath = join(root, 'worktrees', 'feature');

  runGit(['init', '--bare', originPath]);
  runGit(['clone', originPath, seedPath]);
  writeFileSync(join(seedPath, 'shared.txt'), 'initial\n');
  runGit(['add', 'shared.txt'], seedPath);
  runGit(['commit', '-m', 'initial'], seedPath);
  runGit(['branch', '-M', 'main'], seedPath);
  runGit(['push', '-u', 'origin', 'main'], seedPath);
  runGit(['--git-dir', originPath, 'symbolic-ref', 'HEAD', 'refs/heads/main']);

  mkdirSync(join(root, 'remote'), { recursive: true });
  mkdirSync(join(root, 'worktrees'), { recursive: true });
  runGit(['clone', '--bare', originPath, remoteRepoPath]);
  runGit(['--git-dir', remoteRepoPath, 'config', 'user.name', 'Komla Test']);
  runGit(['--git-dir', remoteRepoPath, 'config', 'user.email', 'komla@example.com']);
  runGit([
    '--git-dir',
    remoteRepoPath,
    'config',
    'remote.origin.fetch',
    '+refs/heads/*:refs/remotes/origin/*',
  ]);
  runGit(['--git-dir', remoteRepoPath, 'fetch', 'origin', '--prune']);
  runGit(['--git-dir', remoteRepoPath, 'worktree', 'add', '-b', 'feature', featurePath, 'main']);
  writeFileSync(join(featurePath, 'feature.txt'), 'feature\n');
  runGit(['add', 'feature.txt'], featurePath);
  runGit(['commit', '-m', 'feature'], featurePath);

  return {
    root,
    originPath,
    seedPath,
    remoteRepoPath,
    featurePath,
    backend: {
      kind: 'ssh',
      hostId: 'ssh-dev',
      remoteDirectory: featurePath,
      remoteRepoPath,
      remoteProjectRoot: join(root, 'worktrees'),
      gitUrl: originPath,
      projectName: 'target-test',
      branchName: 'feature',
      baseBranch: 'main',
    },
  };
}

function createBranchConflict(repo: ReturnType<typeof createTargetBranchTestRepo>): void {
  writeFileSync(join(repo.featurePath, 'shared.txt'), 'feature change\n');
  runGit(['add', 'shared.txt'], repo.featurePath);
  runGit(['commit', '-m', 'feature conflict'], repo.featurePath);

  const targetPath = join(repo.root, 'worktrees', 'main');
  runGit(['--git-dir', repo.remoteRepoPath, 'worktree', 'add', targetPath, 'main']);
  writeFileSync(join(targetPath, 'shared.txt'), 'main change\n');
  runGit(['add', 'shared.txt'], targetPath);
  runGit(['commit', '-m', 'main conflict'], targetPath);
}

async function buildLazySetupCommand(
  backend: SshWorkspaceBackend,
  companionPath?: string
): Promise<string> {
  const { sshWorkspaceService } = await import('../../../src/main/services/ssh-workspace.service');
  return (
    sshWorkspaceService as unknown as {
      buildLazySetupCommand(backend: SshWorkspaceBackend, companionPath?: string): string;
    }
  ).buildLazySetupCommand(backend, companionPath);
}

function writeCompanionStub(root: string, script = ''): { path: string; callsPath: string } {
  const path = join(root, 'komla');
  const callsPath = join(root, 'companion-calls');
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${callsPath}'\n${script}\n`, {
    mode: 0o755,
  });
  return { path, callsPath };
}

async function runGitSshBootstrap(
  backend: SshWorkspaceBackend,
  env: NodeJS.ProcessEnv,
  cwd?: string
): Promise<string> {
  const setupCommand = await buildLazySetupCommand(backend);
  const setupBodyStart = setupCommand.indexOf('\nif [ ! -d ');
  if (setupBodyStart < 0) throw new Error('Could not find SSH setup body');
  const bootstrap = `${setupCommand.slice(0, setupBodyStart)}\nprintf '%s' "\${GIT_SSH_COMMAND-}"`;
  return execFileSync('/bin/sh', ['-c', bootstrap], { encoding: 'utf8', env, cwd });
}

let sshStringInputs: string[] = [];

function captureSshStringInput(onEnd?: (input: string) => void): {
  stdin: PassThrough;
  kill: ReturnType<typeof vi.fn>;
} {
  const chunks: Buffer[] = [];
  const stdin = new PassThrough();
  stdin.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
  stdin.on('end', () => {
    const input = Buffer.concat(chunks).toString('utf8');
    sshStringInputs.push(input);
    onEnd?.(input);
  });
  return { stdin, kill: vi.fn() };
}

function mockRemoteShell(remoteHome: string, pathPrefix?: string): void {
  execFileMock.mockImplementation((_file, args, options, callback) => {
    const remoteCommand = String((args as string[]).at(-1));
    if (remoteCommand === "sh -lc 'sh -s'") {
      return captureSshStringInput((input) => {
        try {
          const testCommand = pathPrefix
            ? `PATH=${pathPrefix}:$PATH; export PATH; ${input}`
            : input;
          const stdout = execFileSync('/bin/sh', ['-c', testCommand], {
            cwd: remoteHome,
            encoding: 'utf8',
            stdio: 'pipe',
            env: {
              ...process.env,
              HOME: remoteHome,
              PATH: pathPrefix ? `${pathPrefix}:${process.env.PATH}` : process.env.PATH,
            },
          });
          callback(null, stdout, '');
        } catch (error) {
          const failure = error as Error & { stdout?: string; stderr?: string };
          const { stdout = '', stderr = '' } = failure;
          delete failure.stdout;
          delete failure.stderr;
          callback(failure, stdout, stderr);
        }
      });
    }

    try {
      const testCommand = pathPrefix
        ? remoteCommand.replace("sh -lc '", `sh -lc 'PATH=${pathPrefix}:$PATH; export PATH; `)
        : remoteCommand;
      const stdout = execFileSync('/bin/sh', ['-c', testCommand], {
        cwd: remoteHome,
        encoding: 'utf8',
        stdio: 'pipe',
        maxBuffer: (options as { maxBuffer?: number } | undefined)?.maxBuffer,
        env: {
          ...process.env,
          HOME: remoteHome,
          PATH: pathPrefix ? `${pathPrefix}:${process.env.PATH}` : process.env.PATH,
        },
      });
      callback(null, { stdout, stderr: '' });
    } catch (error) {
      const failure = error as Error & { stdout?: string; stderr?: string };
      callback(failure, failure.stdout ?? '', failure.stderr ?? '');
    }
  });
}

function createFailingGitAbortShim(root: string, operation: 'merge' | 'rebase'): string {
  const binPath = join(root, 'bin');
  const shimPath = join(binPath, 'git');
  const gitPath = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  mkdirSync(binPath, { recursive: true });
  writeFileSync(
    shimPath,
    `#!/bin/sh\nif [ "$1" = ${operation} ] && [ "$2" = --abort ]; then exit 1; fi\nexec ${gitPath} "$@"\n`
  );
  chmodSync(shimPath, 0o755);
  return binPath;
}

function createInlineTerminalHarness(root: string): void {
  const sessionState = join(root, 'session');
  writeFileSync(
    join(root, 'ssh'),
    [
      '#!/bin/sh',
      'last=',
      'for argument do last="$argument"; done',
      'case " $* " in *" -O check "*) exit 1 ;; esac',
      'exec /bin/sh -c "$last"',
      '',
    ].join('\n'),
    { mode: 0o755 }
  );
  writeFileSync(
    join(root, 'tmux'),
    [
      '#!/bin/sh',
      `state=${JSON.stringify(sessionState)}`,
      'case " $* " in',
      '  *" show-options "*) exit 0 ;;',
      '  *" has-session -t "*) [ -f "$state" ] ;;',
      '  *" has-session "*) [ -f "$state" ] ;;',
      '  *" new-session "*)',
      '    : > "$state"',
      '    case " $* " in *" komla_launch_guard "*) exit 0 ;; esac',
      '    last=',
      '    for argument do last="$argument"; done',
      '    /bin/sh -c "$last"',
      '    rm -f "$state"',
      '    ;;',
      '  *" attach-session "*) [ -f "$state" ] ;;',
      '  *) exit 0 ;;',
      'esac',
      '',
    ].join('\n'),
    { mode: 0o755 }
  );
}

async function resolveRemoteBasePathForTest(basePath: string): Promise<string> {
  const { sshWorkspaceService } = await import('../../../src/main/services/ssh-workspace.service');
  return (
    sshWorkspaceService as unknown as {
      resolveRemoteBasePath(host: {
        id: string;
        name: string;
        hostname: string;
        basePath: string;
      }): Promise<string>;
    }
  ).resolveRemoteBasePath({
    id: 'ssh-path-resolution',
    name: 'Path resolution',
    hostname: 'path.example.com',
    basePath,
  });
}

describe('generateTmuxServerScript', () => {
  itWithPosixShell('starts the managed server without the user tmux config before applying Komla settings', async () => {
    const { generateTmuxServerScript } =
      await import('../../../src/main/services/ssh-workspace.service');
    const tempPath = mkdtempSync(join(tmpdir(), 'komla-tmux-server-'));
    const logPath = join(tempPath, 'tmux.log');
    writeFileSync(join(tempPath, 'server.sh'), generateTmuxServerScript(), { mode: 0o755 });
    // A stub tmux with no server running: has-session fails and options read back empty.
    writeFileSync(
      join(tempPath, 'tmux'),
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TMUX_LOG"\ncase "$*" in *has-session*) exit 1 ;; esac\nexit 0\n',
      { mode: 0o755 }
    );

    try {
      execFileSync('/bin/sh', [join(tempPath, 'server.sh')], {
        env: {
          ...process.env,
          PATH: [tempPath, process.env.PATH ?? ''].join(':'),
          TMUX_LOG: logPath,
        },
      });

      const calls = readFileSync(logPath, 'utf8').trim().split('\n');
      expect(calls[0]).toBe('-L komla-v1 has-session');
      expect(calls[1]).toBe(
        '-L komla-v1 -f /dev/null new-session -d -s komla_launch_guard sleep 5'
      );
      expect(calls).toContain('-L komla-v1 set-option -g prefix None');
      expect(calls).toContain('-L komla-v1 set-option -as terminal-features *:hyperlinks');
      expect(calls).toContain('-L komla-v1 set-option -sa terminal-features ,xterm-256color:RGB');
      expect(calls).toContain('-L komla-v1 set-option -g allow-passthrough on');
      expect(calls).toContain(
        '-L komla-v1 set-hook -g client-attached run-shell -b "kill -CONT #{pane_pid} 2>/dev/null || true"'
      );
      expect(calls.at(-1)).toBe('-L komla-v1 set-option -g @komla_config_version 9');
    } finally {
      rmSync(tempPath, { recursive: true, force: true });
    }
  });

  itWithPosixShell("starts tmux's search again from the stored query only where the running server can", async () => {
    const { generateTmuxServerScript } =
      await import('../../../src/main/services/ssh-workspace.service');
    const tempPath = mkdtempSync(join(tmpdir(), 'komla-tmux-server-'));
    const logPath = join(tempPath, 'tmux.log');
    writeFileSync(join(tempPath, 'server.sh'), generateTmuxServerScript(), { mode: 0o755 });
    // The binary was upgraded past 3.1, but the server still running is older.
    writeFileSync(
      join(tempPath, 'tmux'),
      [
        '#!/bin/sh',
        'printf "%s\\n" "$*" >> "$TMUX_LOG"',
        "case \"$*\" in *has-session*) exit 1 ;; *'#{version}'*) echo 3.0a ;; -V) echo 'tmux 3.5a' ;; esac",
        'exit 0',
        '',
      ].join('\n'),
      { mode: 0o755 }
    );

    try {
      execFileSync('/bin/sh', [join(tempPath, 'server.sh')], {
        env: {
          ...process.env,
          PATH: [tempPath, process.env.PATH ?? ''].join(':'),
          TMUX_LOG: logPath,
        },
      });

      const calls = readFileSync(logPath, 'utf8').trim().split('\n');
      const step = calls.find((call) => call.includes('bind-key -n User0'));
      expect(step).toContain('send-keys -X search-again');
      expect(step).not.toContain('@komla_find_query');
    } finally {
      rmSync(tempPath, { recursive: true, force: true });
    }
  });

  itWithPosixShell('passes 24-bit color through tmux too old for terminal-features', async () => {
    const { generateTmuxServerScript } =
      await import('../../../src/main/services/ssh-workspace.service');
    const tempPath = mkdtempSync(join(tmpdir(), 'komla-tmux-server-'));
    const logPath = join(tempPath, 'tmux.log');
    writeFileSync(join(tempPath, 'server.sh'), generateTmuxServerScript(), { mode: 0o755 });
    // tmux before 3.2 has no terminal-features option.
    writeFileSync(
      join(tempPath, 'tmux'),
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TMUX_LOG"\ncase "$*" in *has-session*|*terminal-features*) exit 1 ;; esac\nexit 0\n',
      { mode: 0o755 }
    );

    try {
      execFileSync('/bin/sh', [join(tempPath, 'server.sh')], {
        env: {
          ...process.env,
          PATH: [tempPath, process.env.PATH ?? ''].join(':'),
          TMUX_LOG: logPath,
        },
      });

      const calls = readFileSync(logPath, 'utf8').trim().split('\n');
      expect(calls).toContain('-L komla-v1 set-option -ga terminal-overrides ,xterm-256color:Tc');
    } finally {
      rmSync(tempPath, { recursive: true, force: true });
    }
  });

  // search_count, which the result reads, arrived in tmux 3.5.
  const tmuxVersion = spawnSync('tmux', ['-V'], { encoding: 'utf8' }).stdout?.match(/(\d+)\.(\d+)/);
  it.skipIf(!tmuxVersion || Number(`${tmuxVersion[1]}.${tmuxVersion[2]}`) < 3.5)(
    "finds in a session's tmux history and maps the search bar's steps",
    async () => {
      const { generateTmuxServerScript, sshWorkspaceService } =
        await import('../../../src/main/services/ssh-workspace.service');
      const { MANAGED_TMUX_FIND_INPUTS } = await import('../../../src/shared/lib/ssh-tmux-attach');
      const tempPath = mkdtempSync(join(tmpdir(), 'komla-tmux-server-'));
      writeFileSync(join(tempPath, 'server.sh'), generateTmuxServerScript(), { mode: 0o755 });
      // A private socket directory keeps the real tmux away from any running komla-v1 server.
      const { TMUX: _tmux, TMUX_PANE: _pane, ...env } = process.env;
      const tmuxEnv = { ...env, TMUX_TMPDIR: tempPath };
      const tmux = (...args: string[]) =>
        execFileSync('tmux', ['-L', 'komla-v1', ...args], { env: tmuxEnv, encoding: 'utf8' });
      const host = {
        id: 'ssh-tmux-find',
        name: 'tmux find',
        hostname: 'tmux.example.com',
        basePath: '~/.komla',
        // Checked before an upgrade: the running server's own version decides how to search.
        capabilities: { tmux: { status: 'available', version: 'tmux 3.0' } },
      };
      sshHosts.push(host as (typeof sshHosts)[number]);
      const run = vi
        .spyOn(sshWorkspaceService, 'run')
        .mockImplementation(async (_host, command) =>
          execFileSync('/bin/sh', ['-c', command], { env: tmuxEnv, encoding: 'utf8' })
        );
      const backend = {
        kind: 'ssh' as const,
        hostId: host.id,
        remoteDirectory: tempPath,
        remoteRepoPath: '/home/dev/repo.git',
        remoteProjectRoot: '/home/dev',
        gitUrl: 'git@example.com:repo.git',
      };

      try {
        execFileSync('/bin/sh', [join(tempPath, 'server.sh')], { env: tmuxEnv });
        tmux(
          'new-session',
          '-d',
          '-s',
          'komla-term-find',
          String.raw`printf 'needle a.b\naxb alpha;\nalpha\nneedle\n'; exec sleep 60`
        );
        await vi.waitFor(() =>
          expect(tmux('capture-pane', '-p', '-t', 'komla-term-find:')).toContain('alpha')
        );

        // tmux shows an escape as \033, \e or the escape itself depending on its version.
        Object.values(MANAGED_TMUX_FIND_INPUTS).forEach((input, index) => {
          expect(['\\033', '\\e', '\x1b'].map((escape) => input.replace('\x1b', escape))).toContain(
            tmux('show-options', '-sv', `user-keys[${index}]`).trim()
          );
        });
        expect(tmux('list-keys', '-T', 'root', 'User0')).toContain('send-keys -X search-again');
        expect(tmux('list-keys', '-T', 'root', 'User1')).toContain('send-keys -X search-reverse');
        expect(tmux('list-keys', '-T', 'root', 'User2')).toContain('send-keys -X cancel');
        // Once tmux has left the search, a step starts it again from the stored query.
        expect(tmux('list-keys', '-T', 'root', 'User0')).toContain('#{@komla_find_query}');
        expect(tmux('list-keys', '-T', 'root', 'User1')).toContain('#{@komla_find_query}');

        await expect(
          sshWorkspaceService.findInTerminalSession(backend, 'term-find', 'needle')
        ).resolves.toEqual({ found: true, count: 2, alternateScreen: false });
        expect(
          tmux('display-message', '-p', '-t', 'komla-term-find:', '#{pane_in_mode}').trim()
        ).toBe('1');
        // Plain text, not a regular expression that would match axb too.
        await expect(
          sshWorkspaceService.findInTerminalSession(backend, 'term-find', 'a.b')
        ).resolves.toEqual({ found: true, count: 1, alternateScreen: false });
        // tmux would read the trailing `;` as the end of a command and search for alpha.
        await expect(
          sshWorkspaceService.findInTerminalSession(backend, 'term-find', 'alpha;')
        ).resolves.toEqual({ found: true, count: 1, alternateScreen: false });
        expect(tmux('show-options', '-wv', '-t', 'komla-term-find:', '@komla_find_query')).toBe(
          'alpha;\n'
        );
        await expect(
          sshWorkspaceService.findInTerminalSession(backend, 'term-find', 'missing')
        ).resolves.toEqual({ found: false, count: 0, alternateScreen: false });

        // A full-screen program keeps no tmux history, and scroll mode would freeze it.
        tmux(
          'new-session',
          '-d',
          '-s',
          'komla-term-full',
          String.raw`printf '[?1049hneedle'; exec sleep 60`
        );
        await vi.waitFor(() =>
          expect(tmux('capture-pane', '-p', '-t', 'komla-term-full:')).toContain('needle')
        );
        await expect(
          sshWorkspaceService.findInTerminalSession(backend, 'term-full', 'needle')
        ).resolves.toEqual({ found: null, count: null, alternateScreen: true });
        expect(
          tmux('display-message', '-p', '-t', 'komla-term-full:', '#{pane_in_mode}').trim()
        ).toBe('0');
      } finally {
        run.mockRestore();
        sshHosts.splice(sshHosts.indexOf(host as (typeof sshHosts)[number]), 1);
        spawnSync('tmux', ['-L', 'komla-v1', 'kill-server'], { env: tmuxEnv });
        rmSync(tempPath, { recursive: true, force: true });
      }
    }
  );
});

describe('sshWorkspaceService', () => {
  beforeEach(() => {
    execFileMock.mockReset();
    sshStringInputs = [];
    configGetMock.mockReturnValue({ notificationPort: 54183 });
    askpassMock.isRunning.mockReturnValue(false);
    askpassMock.getHelperScriptPath.mockReturnValue(null);
    askpassMock.getSocketPath.mockReturnValue(null);
    generateCommitMessageMock.mockReset().mockResolvedValue({
      subject: 'Add remote file',
      body: null,
    });
  });

  it.each([
    ['', { found: null, count: null, alternateScreen: false }],
    ['1 \n', { found: true, count: null, alternateScreen: false }],
    ['0 \n', { found: false, count: 0, alternateScreen: false }],
  ])(
    'reads a tmux search on a host whose tmux version is unknown from %j',
    async (output, result) => {
      const { sshWorkspaceService } =
        await import('../../../src/main/services/ssh-workspace.service');
      const run = vi.spyOn(sshWorkspaceService, 'run').mockResolvedValue(output);
      try {
        await expect(
          sshWorkspaceService.findInTerminalSession(
            {
              kind: 'ssh',
              hostId: 'ssh-dev',
              remoteDirectory: '/home/devuser/work',
              remoteRepoPath: '/home/devuser/repo.git',
              remoteProjectRoot: '/home/devuser',
              gitUrl: 'git@example.com:repo.git',
            },
            'term-old',
            'needle'
          )
        ).resolves.toEqual(result);
      } finally {
        run.mockRestore();
      }
    }
  );

  itWithPosixShell("searches plain text with the search command of the host's running tmux server", async () => {
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    const tempPath = mkdtempSync(join(tmpdir(), 'komla-tmux-find-'));
    const logPath = join(tempPath, 'tmux.log');
    // A server from before 3.1, whose search-backward is the plain-text search.
    writeFileSync(
      join(tempPath, 'tmux'),
      [
        '#!/bin/sh',
        'printf "%s\\n" "$*" >> "$TMUX_LOG"',
        "case \"$*\" in *'#{alternate_on} #{version}'*) echo '0 3.0a' ;; esac",
        'exit 0',
        '',
      ].join('\n'),
      { mode: 0o755 }
    );
    const run = vi.spyOn(sshWorkspaceService, 'run').mockImplementation(async (_host, command) =>
      execFileSync('/bin/sh', ['-c', command], {
        env: {
          ...process.env,
          PATH: [tempPath, process.env.PATH ?? ''].join(':'),
          TMUX_LOG: logPath,
        },
        encoding: 'utf8',
      })
    );
    try {
      await sshWorkspaceService.findInTerminalSession(
        {
          kind: 'ssh',
          hostId: 'ssh-dev',
          remoteDirectory: '/home/devuser/work',
          remoteRepoPath: '/home/devuser/repo.git',
          remoteProjectRoot: '/home/devuser',
          gitUrl: 'git@example.com:repo.git',
        },
        'term-old',
        'a.b'
      );

      expect(readFileSync(logPath, 'utf8')).toContain('-X search-backward a.b ;');
    } finally {
      run.mockRestore();
      rmSync(tempPath, { recursive: true, force: true });
    }
  });

  it('streams a local file into an SSH command and returns its output', async () => {
    const testDirectory = mkdtempSync(join(tmpdir(), 'komla-ssh-upload-'));
    const sourcePath = join(testDirectory, 'upload.bin');
    writeFileSync(sourcePath, Buffer.from([0, 1, 2, 255]));
    const received: Buffer[] = [];
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      const stdin = new PassThrough();
      stdin.on('data', (chunk) => received.push(Buffer.from(chunk)));
      stdin.on('end', () => callback(null, 'STATUS=OK\nPATH=.komla-files/upload.bin\n', ''));
      return { stdin, kill: vi.fn() };
    });

    try {
      const host = sshHosts[0];
      const { sshWorkspaceService } =
        await import('../../../src/main/services/ssh-workspace.service');
      await expect(
        sshWorkspaceService.runWithFileInput(host, 'cat >/tmp/upload', sourcePath)
      ).resolves.toContain('PATH=.komla-files/upload.bin');
      expect(Buffer.concat(received)).toEqual(Buffer.from([0, 1, 2, 255]));
      expect(execFileMock.mock.calls[0][1].at(-1)).toContain('cat >/tmp/upload');
      expect(execFileMock.mock.calls[0][2]).toHaveProperty('timeout', 120_000);
    } finally {
      rmSync(testDirectory, { recursive: true, force: true });
    }
  });

  it('uses the interactive connection purpose for file uploads by default', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const testDirectory = mkdtempSync(join(tmpdir(), 'komla-ssh-interactive-upload-'));
    const sourcePath = join(testDirectory, 'upload.bin');
    writeFileSync(sourcePath, 'upload');
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      const stdin = new PassThrough();
      stdin.on('end', () => callback(null, 'ok', ''));
      stdin.resume();
      return { stdin, kill: vi.fn() };
    });

    try {
      const { sshWorkspaceService } =
        await import('../../../src/main/services/ssh-workspace.service');
      await sshWorkspaceService.runWithFileInput(sshHosts[0], 'cat >/tmp/upload', sourcePath);

      const args = execFileMock.mock.calls[0][1] as string[];
      expect(args).toContain('ControlPersist=600');
    } finally {
      rmSync(testDirectory, { recursive: true, force: true });
    }
  });

  it('destroys the source stream when SSH exits before consuming the file', async () => {
    const testDirectory = mkdtempSync(join(tmpdir(), 'komla-ssh-upload-'));
    const sourcePath = join(testDirectory, 'upload.bin');
    writeFileSync(sourcePath, Buffer.alloc(1024 * 1024));
    const destroySpy = vi.spyOn(ReadStream.prototype, 'destroy');
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      const stdin = new Writable({
        highWaterMark: 1,
        write: () => undefined,
      });
      setImmediate(() => callback(new Error('SSH connection closed'), '', ''));
      return { stdin, kill: vi.fn() };
    });

    try {
      const host = sshHosts[0];
      const { sshWorkspaceService } =
        await import('../../../src/main/services/ssh-workspace.service');
      await expect(
        sshWorkspaceService.runWithFileInput(host, 'cat >/tmp/upload', sourcePath)
      ).rejects.toThrow('SSH connection closed');
      expect(destroySpy).toHaveBeenCalled();
    } finally {
      destroySpy.mockRestore();
      rmSync(testDirectory, { recursive: true, force: true });
    }
  });

  itWithPosixShell('writes both helper scripts in one round trip', async () => {
    const remoteHome = realpathSync(mkdtempSync(join(tmpdir(), 'komla-ssh-helpers-')));
    const helpers = join(remoteHome, '.komla', 'helpers');
    mkdirSync(helpers, { recursive: true });
    // A linked script is replaced at its target, as any other remote write.
    writeFileSync(join(helpers, 'notify-target.sh'), 'old\n');
    symlinkSync('notify-target.sh', join(helpers, 'notify.sh'));
    mockRemoteShell(remoteHome);

    try {
      const { generateNotifyShellScript, generateTmuxServerScript, sshWorkspaceService } =
        await import('../../../src/main/services/ssh-workspace.service');
      await sshWorkspaceService.ensureRemoteNotificationScript({
        kind: 'ssh',
        hostId: 'ssh-dev',
        remoteDirectory: `${remoteHome}/.komla/worktrees/komla/ws`,
        remoteRepoPath: `${remoteHome}/.komla/repos/komla/repo.git`,
        remoteProjectRoot: `${remoteHome}/.komla/worktrees/komla`,
      });

      const helperCalls = execFileMock.mock.calls.filter((call) => {
        const command = String((call[1] as string[]).at(-1));
        return call[0] === 'ssh' && command.includes('tmux-server.sh');
      });
      expect(helperCalls).toHaveLength(1);
      expect(String((helperCalls[0]![1] as string[]).at(-1))).toContain('notify.sh');
      expect(readFileSync(join(helpers, 'notify-target.sh'), 'utf8')).toBe(
        generateNotifyShellScript()
      );
      expect(readFileSync(join(helpers, 'tmux-server.sh'), 'utf8')).toBe(
        generateTmuxServerScript()
      );
      for (const script of ['notify-target.sh', 'tmux-server.sh']) {
        expect(statSync(join(helpers, script)).mode & 0o777).toBe(0o755);
      }
    } finally {
      rmSync(remoteHome, { recursive: true, force: true });
    }
  });

  // Runs the remote commands in a real POSIX shell standing in for the SSH host.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'fails the remote layout when it cannot write its data marker, though notify.sh is installed',
    async () => {
      const remoteHome = realpathSync(mkdtempSync(join(tmpdir(), 'komla-ssh-layout-')));
      const base = join(remoteHome, '.komla');
      mkdirSync(join(base, 'helpers'), { recursive: true });
      writeFileSync(join(base, 'helpers', 'notify.sh'), '#!/bin/sh\n', { mode: 0o755 });
      writeFileSync(join(base, '.komla-managed'), 'komla-ssh-data-v1\n', { mode: 0o444 });
      mockRemoteShell(remoteHome);

      try {
        const { sshWorkspaceService } =
          await import('../../../src/main/services/ssh-workspace.service');
        await expect(
          sshWorkspaceService.enableIntegration('ssh-dev', 'codex', 'notifications')
        ).rejects.toThrow('.komla-managed');
      } finally {
        rmSync(remoteHome, { recursive: true, force: true });
      }
    }
  );

  itWithPosixShell('includes untracked files when generating a remote commit draft', async () => {
    const repo = createTargetBranchTestRepo();
    mockRemoteShell(repo.root);
    writeFileSync(join(repo.featurePath, 'new file.txt'), 'new content\n');

    try {
      const { sshWorkspaceService } =
        await import('../../../src/main/services/ssh-workspace.service');
      const result = await sshWorkspaceGit.generateCommitDraft(repo.backend);

      expect(result).toMatchObject({ subject: 'Add remote file', scope: 'all', fileCount: 1 });
      expect(generateCommitMessageMock).toHaveBeenCalledWith(
        expect.stringContaining('--- untracked file: new file.txt')
      );
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  itWithPosixShell('generates a remote commit draft before the first commit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'komla-ssh-unborn-'));
    const workspacePath = join(root, 'workspace');
    mkdirSync(workspacePath);
    runGit(['init'], workspacePath);
    writeFileSync(join(workspacePath, 'first.txt'), 'first content\n');
    mockRemoteShell(root);

    try {
      const { sshWorkspaceService } =
        await import('../../../src/main/services/ssh-workspace.service');
      const result = await sshWorkspaceGit.generateCommitDraft({
        kind: 'ssh',
        hostId: 'ssh-dev',
        remoteDirectory: workspacePath,
        remoteRepoPath: join(root, 'repo.git'),
        remoteProjectRoot: root,
        gitUrl: 'https://github.com/example/repo.git',
      });

      expect(result).toMatchObject({ subject: 'Add remote file', scope: 'all', fileCount: 1 });
      expect(generateCommitMessageMock).toHaveBeenCalledWith(
        expect.stringContaining('--- untracked file: first.txt')
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  itWithPosixShell('limits remote diff output before generating a commit draft', async () => {
    const repo = createTargetBranchTestRepo();
    mockRemoteShell(repo.root);
    writeFileSync(join(repo.featurePath, 'feature.txt'), 'x'.repeat(11 * 1024 * 1024));

    try {
      const { sshWorkspaceService } =
        await import('../../../src/main/services/ssh-workspace.service');
      const result = await sshWorkspaceGit.generateCommitDraft(repo.backend);

      expect(result).toMatchObject({ subject: 'Add remote file', scope: 'all', fileCount: 1 });
      expect(generateCommitMessageMock.mock.calls[0][0]).toHaveLength(300_000);
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalSystemRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = originalSystemRoot;
  });

  itWithPosixShell.each([
    {
      name: 'stdin hooks',
      inputModeArgs: [] as string[],
      hookInput: '{"prompt":"Fix the \\"remote\\" title\\nnow"}',
    },
    {
      name: 'argv hooks',
      inputModeArgs: ['--input', 'argv'],
      hookInput: '{"prompt":"Resume the existing session"}',
    },
  ])('forwards prompt payloads from $name', async ({ inputModeArgs, hookInput }) => {
    const { generateNotifyShellScript } =
      await import('../../../src/main/services/ssh-workspace.service');
    const tempPath = mkdtempSync(join(tmpdir(), 'komla-ssh-notify-'));
    const scriptPath = join(tempPath, 'notify.sh');
    const curlPath = join(tempPath, 'curl');
    const capturePath = join(tempPath, 'payload.json');
    writeFileSync(scriptPath, generateNotifyShellScript(), { mode: 0o755 });
    writeFileSync(
      curlPath,
      '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = --data ]; then shift; printf %s "$1" > "$KOMLA_TEST_CAPTURE"; exit 0; fi\n  shift\ndone\nexit 1\n',
      { mode: 0o755 }
    );

    try {
      execFileSync(
        '/bin/sh',
        [
          scriptPath,
          '--source',
          'claude-code',
          '--event',
          'UserPromptSubmit',
          ...inputModeArgs,
          ...(inputModeArgs.length > 0 ? [hookInput] : []),
        ],
        {
          input: inputModeArgs.length === 0 ? hookInput : undefined,
          env: {
            ...envWithoutKomlaTerminal(),
            PATH: [tempPath, process.env.PATH ?? ''].join(':'),
            KOMLA_NOTIFY_PORT: '54183',
            KOMLA_TERMINAL_ID: 'term-remote',
            KOMLA_TEST_CAPTURE: capturePath,
          },
        }
      );

      expect(JSON.parse(readFileSync(capturePath, 'utf8'))).toMatchObject({
        terminalId: 'term-remote',
        kind: 'prompt-submit',
        source: 'claude-code',
        hookInput: JSON.parse(hookInput),
      });
    } finally {
      rmSync(tempPath, { recursive: true, force: true });
    }
  });

  itWithPosixShell('drops oversized remote notification hook input', async () => {
    const { generateNotifyShellScript } =
      await import('../../../src/main/services/ssh-workspace.service');
    const tempPath = mkdtempSync(join(tmpdir(), 'komla-ssh-notify-large-'));
    const scriptPath = join(tempPath, 'notify.sh');
    const curlPath = join(tempPath, 'curl');
    const capturePath = join(tempPath, 'payload.json');
    writeFileSync(scriptPath, generateNotifyShellScript(), { mode: 0o755 });
    writeFileSync(
      curlPath,
      '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = --data ]; then shift; printf %s "$1" > "$KOMLA_TEST_CAPTURE"; exit 0; fi\n  shift\ndone\nexit 1\n',
      { mode: 0o755 }
    );

    try {
      execFileSync('/bin/sh', [scriptPath, '--source', 'claude-code', '--event', 'Stop'], {
        input: JSON.stringify({ message: 'x'.repeat(70_000) }),
        env: {
          ...envWithoutKomlaTerminal(),
          PATH: [tempPath, process.env.PATH ?? ''].join(':'),
          KOMLA_NOTIFY_PORT: '54183',
          KOMLA_TEST_CAPTURE: capturePath,
        },
      });
      expect(JSON.parse(readFileSync(capturePath, 'utf8')).hookInput).toEqual({});
    } finally {
      rmSync(tempPath, { recursive: true, force: true });
    }
  });

  itWithPosixShell('uses direct HTTP when no companion mailbox was configured for the terminal', async () => {
    const { generateNotifyShellScript } =
      await import('../../../src/main/services/ssh-workspace.service');
    const tempPath = mkdtempSync(join(tmpdir(), 'komla-ssh-notify-fallback-'));
    const scriptPath = join(tempPath, 'notify.sh');
    const companionPath = join(tempPath, 'komla');
    const companionCapture = join(tempPath, 'companion-called');
    const curlPath = join(tempPath, 'curl');
    const capturePath = join(tempPath, 'payload.json');
    writeFileSync(scriptPath, generateNotifyShellScript(), { mode: 0o755 });
    writeFileSync(
      companionPath,
      '#!/bin/sh\ncat >/dev/null\nprintf called > "$KOMLA_TEST_COMPANION_CAPTURE"\n',
      { mode: 0o755 }
    );
    writeFileSync(join(tempPath, 'tmux'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    writeFileSync(
      curlPath,
      '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = --data ]; then shift; printf %s "$1" > "$KOMLA_TEST_CAPTURE"; exit 0; fi\n  shift\ndone\nexit 1\n',
      { mode: 0o755 }
    );

    try {
      execFileSync('/bin/sh', [scriptPath, '--source', 'codex', '--event', 'Stop'], {
        input: '{}',
        env: {
          ...envWithoutKomlaTerminal(),
          PATH: [tempPath, process.env.PATH ?? ''].join(':'),
          KOMLA_NOTIFY_PORT: '54183',
          KOMLA_TERMINAL_ID: 'term-remote',
          KOMLA_TEST_CAPTURE: capturePath,
          KOMLA_TEST_COMPANION_CAPTURE: companionCapture,
        },
      });

      expect(existsSync(companionCapture)).toBe(false);
      expect(JSON.parse(readFileSync(capturePath, 'utf8'))).toMatchObject({
        terminalId: 'term-remote',
        kind: 'turn-complete',
      });
    } finally {
      rmSync(tempPath, { recursive: true, force: true });
    }
  });

  itWithPosixShell('queues a hook when its configured companion session is restarting', async () => {
    const { generateNotifyShellScript } =
      await import('../../../src/main/services/ssh-workspace.service');
    const tempPath = mkdtempSync(join(tmpdir(), 'komla-ssh-notify-restart-'));
    const scriptPath = join(tempPath, 'notify.sh');
    const companionPath = join(tempPath, 'komla');
    const companionCapture = join(tempPath, 'companion-called');
    const httpCapture = join(tempPath, 'http-called');
    writeFileSync(scriptPath, generateNotifyShellScript(), { mode: 0o755 });
    writeFileSync(
      companionPath,
      '#!/bin/sh\ncat >/dev/null\nprintf called > "$KOMLA_TEST_COMPANION_CAPTURE"\n',
      { mode: 0o755 }
    );
    writeFileSync(join(tempPath, 'tmux'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    writeFileSync(
      join(tempPath, 'curl'),
      '#!/bin/sh\nprintf called > "$KOMLA_TEST_HTTP_CAPTURE"\n',
      { mode: 0o755 }
    );

    try {
      execFileSync('/bin/sh', [scriptPath, '--source', 'codex', '--event', 'Stop'], {
        input: '{}',
        env: {
          ...envWithoutKomlaTerminal(),
          PATH: [tempPath, process.env.PATH ?? ''].join(':'),
          KOMLA_NOTIFY_PORT: '54183',
          KOMLA_TERMINAL_ID: 'term-remote',
          KOMLA_COMPANION_INBOX: '/home/dev/.komla/helpers/companion/install/inbox',
          KOMLA_COMPANION_SESSION: 'komla-companion-install',
          KOMLA_COMPANION_TMUX_SOCKET: 'komla-companion-install',
          KOMLA_TEST_COMPANION_CAPTURE: companionCapture,
          KOMLA_TEST_HTTP_CAPTURE: httpCapture,
        },
      });

      expect(readFileSync(companionCapture, 'utf8')).toBe('called');
      expect(existsSync(httpCapture)).toBe(false);
    } finally {
      rmSync(tempPath, { recursive: true, force: true });
    }
  });

  itWithPosixShell('discovers a recovered terminal companion mailbox from its tmux session', async () => {
    const { generateNotifyShellScript } =
      await import('../../../src/main/services/ssh-workspace.service');
    const tempPath = mkdtempSync(join(tmpdir(), 'komla-ssh-notify-recovered-'));
    const scriptPath = join(tempPath, 'notify.sh');
    const companionPath = join(tempPath, 'komla');
    const companionCapture = join(tempPath, 'companion-inbox');
    const httpCapture = join(tempPath, 'http-called');
    writeFileSync(scriptPath, generateNotifyShellScript(), { mode: 0o755 });
    writeFileSync(
      companionPath,
      '#!/bin/sh\ncat >/dev/null\nprintf %s "$2" > "$KOMLA_TEST_COMPANION_CAPTURE"\n',
      { mode: 0o755 }
    );
    writeFileSync(
      join(tempPath, 'tmux'),
      '#!/bin/sh\nprintf "%s\\n" "KOMLA_COMPANION_INBOX=/home/dev/.komla/helpers/companion/install/inbox"\n',
      { mode: 0o755 }
    );
    writeFileSync(
      join(tempPath, 'curl'),
      '#!/bin/sh\nprintf called > "$KOMLA_TEST_HTTP_CAPTURE"\n',
      { mode: 0o755 }
    );

    try {
      execFileSync('/bin/sh', [scriptPath, '--source', 'codex', '--event', 'Stop'], {
        input: '{}',
        env: {
          ...envWithoutKomlaTerminal(),
          PATH: [tempPath, process.env.PATH ?? ''].join(':'),
          KOMLA_NOTIFY_PORT: '54183',
          KOMLA_TERMINAL_ID: 'term-remote',
          KOMLA_TEST_COMPANION_CAPTURE: companionCapture,
          KOMLA_TEST_HTTP_CAPTURE: httpCapture,
        },
      });

      expect(readFileSync(companionCapture, 'utf8')).toBe(
        '/home/dev/.komla/helpers/companion/install/inbox'
      );
      expect(existsSync(httpCapture)).toBe(false);
    } finally {
      rmSync(tempPath, { recursive: true, force: true });
    }
  });

  it('uses one stable remote Komla data port without owning reverse forwarding', async () => {
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    const backend = {
      kind: 'ssh' as const,
      hostId: 'ssh-dev',
      remoteDirectory: '/home/devuser/.komla/worktrees/komla/claude-onyx-grove',
      remoteRepoPath: '/home/devuser/.komla/repos/komla/repo.git',
      remoteProjectRoot: '/home/devuser/.komla/worktrees/komla',
      gitUrl: 'https://github.com/komla-dev/komla.git',
      projectName: 'komla',
    };

    const first = sshWorkspaceService.buildTerminalCommand(
      backend,
      'claude',
      'term-a',
      undefined,
      'start'
    );
    const second = sshWorkspaceService.buildTerminalCommand(
      backend,
      'claude',
      'term-b',
      undefined,
      'start'
    );

    expect(first).not.toContain("'127.0.0.1:54183:127.0.0.1:54183'");
    expect(first).not.toEqual(second);
    expect(first).not.toContain("'-R'");
    expect(second).not.toContain("'-R'");

    const dataPort = first.match(/KOMLA_NOTIFY_PORT=.*?(\d+)/)?.[1];
    expect(dataPort).toBeDefined();
    expect(first).toMatch(new RegExp(`KOMLA_NOTIFY_PORT=.*${dataPort}`));
    expect(first).toMatch(new RegExp(`KOMLA_MCP_PORT=.*${dataPort}`));
    expect(first).not.toContain('ExitOnForwardFailure=no');
    expect(first).not.toContain('KOMLA_WORKSPACE_ID=');
  });

  it.each([true, false])(
    'launches terminals inside the local shell only when ssh forwards the agent (%s)',
    async (forwards) => {
      const { sshWorkspaceService } =
        await import('../../../src/main/services/ssh-workspace.service');
      const { sshConnectionService } =
        await import('../../../src/main/services/ssh-connection.service');
      const forwardsAgent = vi
        .spyOn(sshConnectionService, 'forwardsAgent')
        .mockReturnValue(forwards);

      try {
        const launch = sshWorkspaceService.buildTerminalLaunchCommand(
          {
            kind: 'ssh',
            hostId: 'ssh-dev',
            remoteDirectory: '/home/dev/.komla/worktrees/komla/launch',
            remoteRepoPath: '/home/dev/.komla/repos/komla/repo.git',
            remoteProjectRoot: '/home/dev/.komla/worktrees/komla',
            gitUrl: 'https://github.com/komla-dev/komla.git',
          },
          null,
          'term-agent-forwarding',
          undefined,
          'start'
        );

        expect(launch.localLoginShell).toBe(forwards);
        expect(forwardsAgent).toHaveBeenCalledWith(expect.objectContaining({ id: 'ssh-dev' }));
      } finally {
        forwardsAgent.mockRestore();
      }
    }
  );

  it('creates managed remote terminal sessions without an uploaded launcher', async () => {
    // A Windows client wraps the same script for PowerShell; see the Windows terminal tests.
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    const command = sshWorkspaceService.buildTerminalCommand(
      {
        kind: 'ssh',
        hostId: 'ssh-dev',
        remoteDirectory: '/home/devuser/.komla/worktrees/komla/inline-launch',
        remoteRepoPath: '/home/devuser/.komla/repos/komla/repo.git',
        remoteProjectRoot: '/home/devuser/.komla/worktrees/komla',
        gitUrl: 'https://github.com/komla-dev/komla.git',
        projectName: 'komla',
        branchName: 'agent/inline-launch',
        baseBranch: 'main',
      },
      'codex --resume',
      'term-inline',
      'ws-inline',
      'start'
    );

    expect(command).not.toContain('/helpers/terminal.sh');
    expect(command).toContain('tmux -L komla-v1 new-session -d -s');
    expect(command).toContain('komla-term-inline');
    expect(command).toMatch(/@komla_config_version 2>[^\n]+ != ['"]+9['"]+ \]; then/);
    expect(command).toMatch(/set-option -g @komla_config_version ['"]+9['"]+/);
    expect(command).toContain('tmux -L komla-v1 set-option -g set-titles on');
    expect(command).toContain('tmux -L komla-v1 set-option -g set-titles-string "#{pane_title}"');
    expect(command).toContain('codex --resume');
  });

  itWithPosixShell('executes quoted commands and Komla env through inline tmux creation', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    const root = mkdtempSync(join(tmpdir(), 'komla-inline-terminal-'));
    const capturePath = join(root, 'capture.txt');
    createInlineTerminalHarness(root);

    try {
      const launch = sshWorkspaceService.buildTerminalLaunchCommand(
        {
          kind: 'ssh',
          hostId: 'ssh-dev',
          remoteDirectory: root,
          remoteRepoPath: '/home/dev/repo.git',
          remoteProjectRoot: '/home/dev',
          gitUrl: 'git@example.com:repo.git',
        },
        `printf "%s\\n" "quote ' survives:$KOMLA_TERMINAL_ID:$KOMLA_REMOTE_WORKSPACE_DIR" > '${capturePath}'`,
        'term-inline-runtime',
        'ws-inline-runtime',
        'start'
      );
      const result = spawnSync('/bin/sh', ['-c', launch.command], {
        env: { ...process.env, PATH: `${root}:${process.env.PATH ?? ''}` },
        encoding: 'utf8',
      });

      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(capturePath, 'utf8')).toBe(
        `quote ' survives:term-inline-runtime:${root}\n`
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  itWithPosixShell.each([
    { label: 'a plain zsh', shell: 'zsh', command: null, invocations: '-lc\n-i\n' },
    { label: 'an empty command in zsh', shell: 'zsh', command: '', invocations: '-lc\n-i\n' },
    // bash's login files source .bashrc, which expects an interactive shell.
    { label: 'a plain bash', shell: 'bash', command: null, invocations: '-lic\n-i\n' },
    { label: 'an agent command', shell: 'zsh', command: 'true', invocations: '-lic\n' },
  ])('reads the startup files $label expects', async ({ shell, command, invocations }) => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    const root = mkdtempSync(join(tmpdir(), 'komla-inline-shell-flags-'));
    const shellPath = join(root, shell);
    const invocationsPath = join(root, 'invocations.txt');
    createInlineTerminalHarness(root);
    writeFileSync(
      shellPath,
      [
        '#!/bin/sh',
        `printf '%s\\n' "$1" >> '${invocationsPath}'`,
        '[ "$1" = -i ] && exit 0',
        'shift',
        'exec /bin/sh -c "$1"',
        '',
      ].join('\n'),
      { mode: 0o755 }
    );

    try {
      const launch = sshWorkspaceService.buildTerminalLaunchCommand(
        {
          kind: 'ssh',
          hostId: 'ssh-dev',
          remoteDirectory: root,
          remoteRepoPath: '/home/dev/repo.git',
          remoteProjectRoot: '/home/dev',
          gitUrl: 'git@example.com:repo.git',
        },
        command,
        'term-shell-flags',
        'ws-shell-flags',
        'start'
      );
      spawnSync('/bin/sh', ['-c', launch.command], {
        env: { ...process.env, PATH: `${root}:${process.env.PATH ?? ''}`, SHELL: shellPath },
        encoding: 'utf8',
      });

      expect(readFileSync(invocationsPath, 'utf8')).toBe(invocations);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  itWithPosixShell.each([
    { label: 'through the companion PTY proxy', proxy: 'current', expected: 'proxied:-lic\nran\n' },
    { label: 'directly with a companion older than the proxy', proxy: 'old', expected: 'ran\n' },
    { label: 'directly before the companion is installed', proxy: 'none', expected: 'ran\n' },
  ])('starts the shell $label', async ({ proxy, expected }) => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    const root = mkdtempSync(join(tmpdir(), 'komla-inline-pty-proxy-'));
    const logPath = join(root, 'log.txt');
    createInlineTerminalHarness(root);
    mkdirSync(join(root, 'helpers'));
    if (proxy !== 'none') {
      writeFileSync(
        join(root, 'helpers', 'komla'),
        [
          '#!/bin/sh',
          '[ "$1" = __pty-proxy ] || exit 1',
          proxy === 'old' ? 'exit 1' : '[ "$2" = --check ] && exit 0',
          `printf 'proxied:%s\\n' "$3" >> '${logPath}'`,
          'shift',
          'exec "$@"',
          '',
        ].join('\n'),
        { mode: 0o755 }
      );
    }

    try {
      const launch = sshWorkspaceService.buildTerminalLaunchCommand(
        {
          kind: 'ssh',
          hostId: 'ssh-dev',
          remoteDirectory: root,
          remoteRepoPath: join(root, 'repo.git'),
          remoteProjectRoot: join(root, 'projects', 'repo'),
          gitUrl: 'git@example.com:repo.git',
        },
        `printf 'ran\\n' >> '${logPath}'`,
        'term-pty-proxy',
        'ws-pty-proxy',
        'start'
      );
      const result = spawnSync('/bin/sh', ['-c', launch.command], {
        env: { ...process.env, PATH: `${root}:${process.env.PATH ?? ''}`, SHELL: '/bin/sh' },
        encoding: 'utf8',
      });

      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(logPath, 'utf8')).toBe(expected);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  itWithPosixShell('rejects replacement when the existing managed session survives termination', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    const root = mkdtempSync(join(tmpdir(), 'komla-inline-replace-'));
    const capturePath = join(root, 'replacement.txt');
    writeFileSync(
      join(root, 'ssh'),
      [
        '#!/bin/sh',
        'last=',
        'for argument do last="$argument"; done',
        'case " $* " in *" -O check "*) exit 1 ;; esac',
        'exec /bin/sh -c "$last"',
        '',
      ].join('\n'),
      { mode: 0o755 }
    );
    writeFileSync(
      join(root, 'tmux'),
      [
        '#!/bin/sh',
        'case " $* " in',
        '  *" kill-session "*) exit 1 ;;',
        '  *" has-session "*) exit 0 ;;',
        '  *" show-options "*) exit 0 ;;',
        '  *" new-session "*) exit 1 ;;',
        '  *" attach-session "*) exit 0 ;;',
        '  *) exit 0 ;;',
        'esac',
        '',
      ].join('\n'),
      { mode: 0o755 }
    );

    try {
      const launch = sshWorkspaceService.buildTerminalLaunchCommand(
        {
          kind: 'ssh',
          hostId: 'ssh-dev',
          remoteDirectory: root,
          remoteRepoPath: '/home/dev/repo.git',
          remoteProjectRoot: '/home/dev',
          gitUrl: 'git@example.com:repo.git',
        },
        `printf replaced > '${capturePath}'`,
        'term-inline-replace',
        'ws-inline-replace',
        'replace'
      );
      const result = spawnSync('/bin/sh', ['-c', launch.command], {
        env: { ...process.env, PATH: `${root}:${process.env.PATH ?? ''}` },
        encoding: 'utf8',
      });

      expect(result.status).not.toBe(0);
      expect(existsSync(capturePath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  itWithPosixShell('seeds Komla recovery context into each new managed session', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    const root = mkdtempSync(join(tmpdir(), 'komla-inline-context-'));
    const sessionState = join(root, 'session');
    const environmentLog = join(root, 'environment.log');
    writeFileSync(environmentLog, '');
    writeFileSync(
      join(root, 'ssh'),
      [
        '#!/bin/sh',
        'last=',
        'for argument do last="$argument"; done',
        'case " $* " in *" -O check "*) exit 1 ;; esac',
        'exec /bin/sh -c "$last"',
        '',
      ].join('\n'),
      { mode: 0o755 }
    );
    writeFileSync(
      join(root, 'tmux'),
      [
        '#!/bin/sh',
        `state=${JSON.stringify(sessionState)}`,
        `environment_log=${JSON.stringify(environmentLog)}`,
        'case " $* " in',
        '  *" show-options "*) exit 0 ;;',
        '  *" has-session -t "*) [ -f "$state" ] ;;',
        '  *" has-session "*) [ -f "$state" ] ;;',
        '  *" new-session "*) : > "$state" ;;',
        '  *" set-environment "*) printf "%s\\n" "$*" >> "$environment_log" ;;',
        '  *" attach-session "*) [ -f "$state" ] ;;',
        '  *) exit 0 ;;',
        'esac',
        '',
      ].join('\n'),
      { mode: 0o755 }
    );

    try {
      const launch = sshWorkspaceService.buildTerminalLaunchCommand(
        {
          kind: 'ssh',
          hostId: 'ssh-dev',
          remoteDirectory: root,
          remoteRepoPath: '/home/dev/repo.git',
          remoteProjectRoot: '/home/dev',
          gitUrl: 'git@example.com:repo.git',
        },
        null,
        'term-inline-context',
        'ws-inline-context',
        'start',
        { companion: { hookInbox: '/remote/inbox' } }
      );
      const result = spawnSync('/bin/sh', ['-c', launch.command], {
        env: { ...process.env, PATH: `${root}:${process.env.PATH ?? ''}` },
        encoding: 'utf8',
      });
      const entries = readFileSync(environmentLog, 'utf8').trim().split('\n');

      expect(result.status, result.stderr).toBe(0);
      expect(entries).toEqual(
        expect.arrayContaining([
          '-L komla-v1 set-environment -t =komla-term-inline-context KOMLA_TERMINAL_ID term-inline-context',
          '-L komla-v1 set-environment -t =komla-term-inline-context KOMLA_WORKSPACE_ID ws-inline-context',
          '-L komla-v1 set-environment -t =komla-term-inline-context KOMLA_COMPANION_INBOX /remote/inbox',
        ])
      );
      expect(entries).toContainEqual(
        expect.stringMatching(
          /^-L komla-v1 set-environment -t =komla-term-inline-context KOMLA_API_URL http:\/\/127\.0\.0\.1:\d+\/terminals\/term-inline-context$/
        )
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  itWithPosixShell.each(['start', 'reconnect'] as const)(
    "updates an outdated tmux server's settings before reattaching on %s",
    async (action) => {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      const { sshWorkspaceService } =
        await import('../../../src/main/services/ssh-workspace.service');
      const root = mkdtempSync(join(tmpdir(), 'komla-inline-reattach-'));
      const tmuxLog = join(root, 'tmux.log');
      writeFileSync(
        join(root, 'ssh'),
        [
          '#!/bin/sh',
          'last=',
          'for argument do last="$argument"; done',
          'case " $* " in *" -O check "*) exit 1 ;; esac',
          'exec /bin/sh -c "$last"',
          '',
        ].join('\n'),
        { mode: 0o755 }
      );
      // The session already exists on a server an older Komla configured.
      writeFileSync(
        join(root, 'tmux'),
        `#!/bin/sh\nprintf "%s\\n" "$*" >> ${JSON.stringify(tmuxLog)}\nexit 0\n`,
        { mode: 0o755 }
      );

      try {
        const launch = sshWorkspaceService.buildTerminalLaunchCommand(
          {
            kind: 'ssh',
            hostId: 'ssh-dev',
            remoteDirectory: root,
            remoteRepoPath: '/home/dev/repo.git',
            remoteProjectRoot: '/home/dev',
            gitUrl: 'git@example.com:repo.git',
          },
          null,
          'term-reattach',
          'ws-reattach',
          action
        );
        const result = spawnSync('/bin/sh', ['-c', launch.command], {
          env: { ...process.env, PATH: `${root}:${process.env.PATH ?? ''}` },
          encoding: 'utf8',
        });
        const calls = readFileSync(tmuxLog, 'utf8').trim().split('\n');
        const attach = calls.findIndex((call) => call.includes(' attach-session '));
        const bind = calls.findIndex((call) => call.includes(' bind-key -n User0 '));
        const configured = calls.indexOf('-L komla-v1 set-option -g @komla_config_version 9');

        expect(result.status, result.stderr).toBe(0);
        expect(calls.some((call) => call.includes(' new-session '))).toBe(false);
        expect(bind).toBeGreaterThan(-1);
        expect(bind).toBeLessThan(attach);
        expect(configured).toBeGreaterThan(bind);
        expect(configured).toBeLessThan(attach);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it('only announces remote preparation when the repo or worktree is missing', async () => {
    const setupCommand = await buildLazySetupCommand({
      kind: 'ssh',
      hostId: 'ssh-dev',
      remoteDirectory: '/home/devuser/.komla/worktrees/komla/claude-onyx-grove',
      remoteRepoPath: '/home/devuser/.komla/repos/komla/repo.git',
      remoteProjectRoot: '/home/devuser/.komla/worktrees/komla',
      gitUrl: 'https://github.com/komla-dev/komla.git',
      projectName: 'komla',
      branchName: 'claude/onyx-grove',
      baseBranch: 'main',
    });

    expect(setupCommand).toContain(
      [
        "if [ ! -d '/home/devuser/.komla/repos/komla/repo.git' ] || [ ! -d '/home/devuser/.komla/worktrees/komla/claude-onyx-grove' ]; then",
        '  printf "\\033[2m[komla] preparing remote workspace\\033[0m\\n"',
        'fi',
      ].join('\n')
    );
  });

  it('does not probe the Git remote default branch when the target branch is known', async () => {
    const setupCommand = await buildLazySetupCommand({
      kind: 'ssh',
      hostId: 'ssh-dev',
      remoteDirectory: '/home/devuser/.komla/worktrees/komla/known-target',
      remoteRepoPath: '/home/devuser/.komla/repos/komla/repo.git',
      remoteProjectRoot: '/home/devuser/.komla/worktrees/komla',
      gitUrl: 'https://github.com/komla-dev/komla.git',
      projectName: 'komla',
      branchName: 'agent/known-target',
      baseBranch: 'main',
    });

    expect(setupCommand).not.toContain('ls-remote --symref origin HEAD');
  });

  it('does not probe the Git remote default branch when checking out an existing branch', async () => {
    const setupCommand = await buildLazySetupCommand({
      kind: 'ssh',
      hostId: 'ssh-dev',
      remoteDirectory: '/home/devuser/.komla/worktrees/komla/existing-branch',
      remoteRepoPath: '/home/devuser/.komla/repos/komla/repo.git',
      remoteProjectRoot: '/home/devuser/.komla/worktrees/komla',
      gitUrl: 'https://github.com/komla-dev/komla.git',
      projectName: 'komla',
      branchName: 'feature/existing-branch',
      checkoutExistingBranch: true,
    });

    expect(setupCommand).not.toContain('ls-remote --symref origin HEAD');
    expect(setupCommand).not.toContain('could not determine the remote default branch');
  });

  it('shares the resolved workspace base path across concurrent and later creations', async () => {
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    let resolvePath!: (value: string) => void;
    const run = vi.spyOn(sshWorkspaceService, 'run').mockReturnValueOnce(
      new Promise<string>((resolve) => {
        resolvePath = resolve;
      })
    );

    const first = sshWorkspaceService.resolveWorkspaceBasePath('ssh-workspace-base-cache');
    const second = sshWorkspaceService.resolveWorkspaceBasePath('ssh-workspace-base-cache');

    expect(run).toHaveBeenCalledOnce();
    resolvePath('/home/dev/.komla\n');
    await expect(Promise.all([first, second])).resolves.toEqual([
      '/home/dev/.komla',
      '/home/dev/.komla',
    ]);
    await expect(
      sshWorkspaceService.resolveWorkspaceBasePath('ssh-workspace-base-cache')
    ).resolves.toBe('/home/dev/.komla');
    expect(run).toHaveBeenCalledOnce();
    run.mockRestore();
  });

  it('retries workspace base-path resolution after a failed probe', async () => {
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    const run = vi
      .spyOn(sshWorkspaceService, 'run')
      .mockRejectedValueOnce(new Error('host offline'))
      .mockResolvedValueOnce('/home/dev/.komla\n');

    await expect(
      sshWorkspaceService.resolveWorkspaceBasePath('ssh-workspace-base-retry')
    ).rejects.toThrow('host offline');
    await expect(
      sshWorkspaceService.resolveWorkspaceBasePath('ssh-workspace-base-retry')
    ).resolves.toBe('/home/dev/.komla');
    expect(run).toHaveBeenCalledTimes(2);
    run.mockRestore();
  });

  itWithPosixShell.each([
    ['GIT_SSH_COMMAND', 'custom-ssh --identity deploy'],
    ['GIT_SSH', '/opt/bin/custom-ssh'],
  ])('preserves a configured %s Git transport', async (variable, value) => {
    const backend = {
      kind: 'ssh' as const,
      hostId: 'ssh-dev',
      remoteDirectory: '/home/devuser/.komla/worktrees/komla/transport-test',
      remoteRepoPath: '/home/devuser/.komla/repos/komla/repo.git',
      remoteProjectRoot: '/home/devuser/.komla/worktrees/komla',
      gitUrl: 'git@github.com:komla-dev/komla.git',
      projectName: 'komla',
      branchName: 'transport-test',
      baseBranch: 'main',
    };

    const output = await runGitSshBootstrap(backend, {
      ...process.env,
      GIT_SSH_COMMAND: variable === 'GIT_SSH_COMMAND' ? value : undefined,
      GIT_SSH: variable === 'GIT_SSH' ? value : undefined,
    });

    expect(output).toBe(variable === 'GIT_SSH_COMMAND' ? value : '');
  });

  itWithPosixShell('preserves a repository core.sshCommand transport', async () => {
    const root = mkdtempSync(join(tmpdir(), 'komla-ssh-transport-'));
    const remoteRepoPath = join(root, 'repo.git');
    const backend = {
      kind: 'ssh' as const,
      hostId: 'ssh-dev',
      remoteDirectory: join(root, 'worktree'),
      remoteRepoPath,
      remoteProjectRoot: root,
      gitUrl: 'git@github.com:komla-dev/komla.git',
      projectName: 'komla',
      branchName: 'transport-test',
      baseBranch: 'main',
    };

    try {
      runGit(['init', '--bare', remoteRepoPath]);
      runGit(['-C', remoteRepoPath, 'config', 'core.sshCommand', 'custom-ssh --identity deploy']);

      expect(
        await runGitSshBootstrap(backend, { ...process.env, GIT_SSH_COMMAND: undefined })
      ).toBe('');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  itWithPosixShell('ignores core.sshCommand from an unrelated working-directory repository', async () => {
    const root = mkdtempSync(join(tmpdir(), 'komla-unrelated-ssh-transport-'));
    const binPath = join(root, 'bin');
    const homePath = join(root, 'home');
    const loginPath = join(root, 'login-repo');
    const backend = {
      kind: 'ssh' as const,
      hostId: 'ssh-dev',
      remoteDirectory: join(root, 'worktree'),
      remoteRepoPath: join(root, 'repo.git'),
      remoteProjectRoot: root,
      gitUrl: 'git@github.com:komla-dev/komla.git',
      projectName: 'komla',
      branchName: 'transport-test',
      baseBranch: 'main',
    };

    try {
      mkdirSync(binPath);
      mkdirSync(homePath);
      mkdirSync(loginPath);
      runGit(['init'], loginPath);
      runGit(['config', 'core.sshCommand', 'unrelated-custom-ssh'], loginPath);
      writeFileSync(join(binPath, 'ssh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

      expect(
        await runGitSshBootstrap(
          backend,
          {
            ...process.env,
            HOME: homePath,
            GIT_CONFIG_NOSYSTEM: '1',
            PATH: `${binPath}:${process.env.PATH ?? ''}`,
            GIT_SSH_COMMAND: undefined,
            GIT_SSH: undefined,
          },
          loginPath
        )
      ).toBe('ssh -o StrictHostKeyChecking=accept-new');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  itWithPosixShell('preserves an environment-injected core.sshCommand transport', async () => {
    const root = mkdtempSync(join(tmpdir(), 'komla-env-ssh-transport-'));
    const binPath = join(root, 'bin');
    const homePath = join(root, 'home');
    const backend = {
      kind: 'ssh' as const,
      hostId: 'ssh-dev',
      remoteDirectory: join(root, 'worktree'),
      remoteRepoPath: join(root, 'repo.git'),
      remoteProjectRoot: root,
      gitUrl: 'git@github.com:komla-dev/komla.git',
      projectName: 'komla',
      branchName: 'transport-test',
      baseBranch: 'main',
    };

    try {
      mkdirSync(binPath);
      mkdirSync(homePath);
      writeFileSync(join(binPath, 'ssh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

      expect(
        await runGitSshBootstrap(backend, {
          ...process.env,
          HOME: homePath,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'core.sshCommand',
          GIT_CONFIG_VALUE_0: 'custom-ssh --identity deploy',
          PATH: `${binPath}:${process.env.PATH ?? ''}`,
          GIT_SSH_COMMAND: undefined,
          GIT_SSH: undefined,
        })
      ).toBe('');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  itWithPosixShell('preserves core.sshCommand from an included global config', async () => {
    const root = mkdtempSync(join(tmpdir(), 'komla-included-ssh-transport-'));
    const binPath = join(root, 'bin');
    const homePath = join(root, 'home');
    const includedConfigPath = join(root, 'included.gitconfig');
    const backend = {
      kind: 'ssh' as const,
      hostId: 'ssh-dev',
      remoteDirectory: join(root, 'worktree'),
      remoteRepoPath: join(root, 'repo.git'),
      remoteProjectRoot: root,
      gitUrl: 'git@github.com:komla-dev/komla.git',
      projectName: 'komla',
      branchName: 'transport-test',
      baseBranch: 'main',
    };

    try {
      mkdirSync(binPath);
      mkdirSync(homePath);
      runGit([
        'config',
        '--file',
        join(homePath, '.gitconfig'),
        'include.path',
        includedConfigPath,
      ]);
      runGit(['config', '--file', includedConfigPath, 'core.sshCommand', 'included-ssh']);
      writeFileSync(join(binPath, 'ssh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

      expect(
        await runGitSshBootstrap(backend, {
          ...process.env,
          HOME: homePath,
          GIT_CONFIG_NOSYSTEM: '1',
          PATH: `${binPath}:${process.env.PATH ?? ''}`,
          GIT_SSH_COMMAND: undefined,
          GIT_SSH: undefined,
        })
      ).toBe('');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  itWithPosixShell('preserves command-scoped core.sshCommand without requiring Git --show-scope', async () => {
    const root = mkdtempSync(join(tmpdir(), 'komla-old-git-ssh-transport-'));
    const binPath = join(root, 'bin');
    const homePath = join(root, 'home');
    const realGitPath = execFileSync('/bin/sh', ['-c', 'command -v git'], {
      encoding: 'utf8',
    }).trim();
    const backend = {
      kind: 'ssh' as const,
      hostId: 'ssh-dev',
      remoteDirectory: join(root, 'worktree'),
      remoteRepoPath: join(root, 'repo.git'),
      remoteProjectRoot: root,
      gitUrl: 'git@github.com:komla-dev/komla.git',
      projectName: 'komla',
      branchName: 'transport-test',
      baseBranch: 'main',
    };

    try {
      mkdirSync(binPath);
      mkdirSync(homePath);
      writeFileSync(
        join(binPath, 'git'),
        [
          '#!/bin/sh',
          'for arg in "$@"; do',
          '  [ "$arg" = --show-scope ] && exit 129',
          'done',
          'exec "$KOMLA_TEST_REAL_GIT" "$@"',
          '',
        ].join('\n'),
        { mode: 0o755 }
      );
      writeFileSync(join(binPath, 'ssh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

      expect(
        await runGitSshBootstrap(backend, {
          ...process.env,
          HOME: homePath,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'core.sshCommand',
          GIT_CONFIG_VALUE_0: 'custom-ssh --identity deploy',
          KOMLA_TEST_REAL_GIT: realGitPath,
          PATH: `${binPath}:${process.env.PATH ?? ''}`,
          GIT_SSH_COMMAND: undefined,
          GIT_SSH: undefined,
        })
      ).toBe('');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  itWithPosixShell('does not enable accept-new when the remote SSH client does not support it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'komla-old-ssh-'));
    const binPath = join(root, 'bin');
    const backend = {
      kind: 'ssh' as const,
      hostId: 'ssh-dev',
      remoteDirectory: join(root, 'worktree'),
      remoteRepoPath: join(root, 'repo.git'),
      remoteProjectRoot: root,
      gitUrl: 'git@github.com:komla-dev/komla.git',
      projectName: 'komla',
      branchName: 'old-ssh-test',
      baseBranch: 'main',
    };

    try {
      mkdirSync(binPath);
      writeFileSync(join(binPath, 'ssh'), '#!/bin/sh\nexit 255\n', { mode: 0o755 });

      expect(
        await runGitSshBootstrap(backend, {
          ...process.env,
          PATH: `${binPath}:${process.env.PATH ?? ''}`,
          GIT_SSH_COMMAND: undefined,
          GIT_SSH: undefined,
        })
      ).toBe('');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  itWithPosixShell('enables accept-new when SSH supports it and no custom Git transport is configured', async () => {
    const root = mkdtempSync(join(tmpdir(), 'komla-current-ssh-'));
    const binPath = join(root, 'bin');
    const backend = {
      kind: 'ssh' as const,
      hostId: 'ssh-dev',
      remoteDirectory: join(root, 'worktree'),
      remoteRepoPath: join(root, 'repo.git'),
      remoteProjectRoot: root,
      gitUrl: 'git@github.com:komla-dev/komla.git',
      projectName: 'komla',
      branchName: 'current-ssh-test',
      baseBranch: 'main',
    };

    try {
      mkdirSync(binPath);
      writeFileSync(join(binPath, 'ssh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

      expect(
        await runGitSshBootstrap(backend, {
          ...process.env,
          PATH: `${binPath}:${process.env.PATH ?? ''}`,
          GIT_SSH_COMMAND: undefined,
          GIT_SSH: undefined,
        })
      ).toBe('ssh -o StrictHostKeyChecking=accept-new');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('generates exact managed tmux start, reconnect, and replace operations', async () => {
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    const backend = {
      kind: 'ssh' as const,
      hostId: 'ssh-dev',
      remoteDirectory: '/home/devuser/.komla/worktrees/komla/tmux-test',
      remoteRepoPath: '/home/devuser/.komla/repos/komla/repo.git',
      remoteProjectRoot: '/home/devuser/.komla/worktrees/komla',
      gitUrl: 'https://github.com/komla-dev/komla.git',
      projectName: 'komla',
      branchName: 'agent/tmux-test',
      baseBranch: 'main',
    };

    const start = sshWorkspaceService.buildTerminalCommand(
      backend,
      'codex --resume',
      'term-quoted',
      'ws-1',
      'start'
    );
    const reconnect = sshWorkspaceService.buildTerminalCommand(
      backend,
      null,
      'term-quoted',
      'ws-1',
      'reconnect'
    );
    const replace = sshWorkspaceService.buildTerminalCommand(
      backend,
      'claude',
      'term-quoted',
      'ws-1',
      'replace'
    );

    for (const generated of [start, reconnect, replace]) {
      expect(generated).not.toContain('/helpers/terminal.sh');
      expect(generated).toContain('=komla-term-quoted');
    }
    expect(start).toContain('codex --resume');
    expect(start).toContain('new-session -d -s');
    expect(reconnect.indexOf('attach-session')).toBeLessThan(reconnect.indexOf('new-session'));
    expect(reconnect).not.toContain('codex --resume');
    expect(replace).toContain('claude');
    expect(replace.indexOf('kill-session')).toBeLessThan(replace.indexOf('new-session'));
    expect(start).toContain('@komla_config_version');
    expect(start).toContain('Agent command failed with exit code');
    expect(start).toContain('Starting a remote shell so you can fix the problem');
  });

  it('kills and confirms exact managed terminal sessions in one SSH command', async () => {
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(null, { stdout: '', stderr: '' });
    });
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    const backend = {
      kind: 'ssh' as const,
      hostId: 'ssh-dev',
      remoteDirectory: '/home/devuser/.komla/worktrees/komla/tmux-test',
      remoteRepoPath: '/home/devuser/.komla/repos/komla/repo.git',
      remoteProjectRoot: '/home/devuser/.komla/worktrees/komla',
      gitUrl: 'https://github.com/komla-dev/komla.git',
      projectName: 'komla',
    };

    await sshWorkspaceService.killTerminalSessions(backend, ['term-a', 'term-b']);

    const remoteCommand = (execFileMock.mock.calls[0][1] as string[]).at(-1) ?? '';
    expect(remoteCommand).toContain('komla-term-a');
    expect(remoteCommand).toContain('komla-term-b');
    expect(remoteCommand).toContain('kill-session');
    expect(remoteCommand.match(/has-session/g)).toHaveLength(4);
    expect(remoteCommand).not.toContain('command -v tmux');
    expect(remoteCommand).not.toContain('list-commands');
  });

  it('admits remote terminal cleanup while background SSH work waits', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const callbacks: Array<(error: null, result: { stdout: string; stderr: string }) => void> = [];
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callbacks.push(callback);
    });
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    const backend = {
      kind: 'ssh' as const,
      hostId: 'ssh-dev',
      remoteDirectory: '/home/dev/worktree',
      remoteRepoPath: '/home/dev/repo.git',
      remoteProjectRoot: '/home/dev',
      gitUrl: 'git@example.com:repo.git',
    };
    const host = sshHosts[0];

    const backgroundRuns = Array.from({ length: 4 }, (_, index) =>
      sshWorkspaceService.run(host, `printf background-${index}`)
    );
    await vi.waitFor(() => expect(execFileMock).toHaveBeenCalledTimes(3));

    const cleanup = sshWorkspaceService.killTerminalSessions(backend, ['term-live']);
    await vi.waitFor(() => expect(execFileMock).toHaveBeenCalledTimes(4));
    expect(execFileMock.mock.calls[3][1].at(-1)).toContain('kill-session');

    callbacks[3]?.(null, { stdout: '', stderr: '' });
    await cleanup;
    callbacks[0]?.(null, { stdout: 'background-0\n', stderr: '' });
    await vi.waitFor(() => expect(execFileMock).toHaveBeenCalledTimes(5));
    callbacks[1]?.(null, { stdout: 'background-1\n', stderr: '' });
    callbacks[2]?.(null, { stdout: 'background-2\n', stderr: '' });
    callbacks[4]?.(null, { stdout: 'background-3\n', stderr: '' });
    await Promise.all(backgroundRuns);
  });

  it('discovers only exact managed terminal sessions for startup recovery', async () => {
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(null, { stdout: 'term-a\n', stderr: '' });
    });
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    const backend = {
      kind: 'ssh' as const,
      hostId: 'ssh-dev',
      remoteDirectory: '/home/devuser/.komla/worktrees/komla/tmux-test',
      remoteRepoPath: '/home/devuser/.komla/repos/komla/repo.git',
      remoteProjectRoot: '/home/devuser/.komla/worktrees/komla',
      gitUrl: 'https://github.com/komla-dev/komla.git',
      projectName: 'komla',
    };

    const active = await sshWorkspaceService.findTerminalSessions(backend, ['term-a', 'term-b']);

    expect(active).toEqual(new Set(['term-a']));
    const remoteCommand = (execFileMock.mock.calls[0][1] as string[]).at(-1) ?? '';
    expect(remoteCommand).toContain('=komla-term-a');
    expect(remoteCommand).toContain('=komla-term-b');
    expect(remoteCommand).not.toContain('list-sessions');
    expect(remoteCommand).not.toContain('command -v tmux');
    expect(remoteCommand).not.toContain('list-commands');
  });

  it('relays an interrupt through the companion this device installed', async () => {
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(null, { stdout: '', stderr: '' });
    });
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    const backend = {
      kind: 'ssh' as const,
      hostId: 'ssh-dev',
      remoteDirectory: '/home/dev/.komla/worktrees/app/fix',
      remoteRepoPath: '/home/dev/.komla/repos/app/repo.git',
      remoteProjectRoot: '/home/dev/.komla/worktrees/app',
      gitUrl: 'https://github.com/acme/app.git',
      projectName: 'app',
    };

    await sshWorkspaceService.relayInterrupt(
      backend,
      {
        executable: '/home/dev/.komla/helpers/bin/protocol-1/digest/komla',
        hookInbox: '/home/dev/.komla/helpers/companion/key/inbox',
      },
      'term-a',
      ['claude-code', 'codex']
    );

    const remoteCommand = (execFileMock.mock.calls[0][1] as string[]).at(-1) ?? '';
    expect(remoteCommand).toMatch(
      /digest\/komla'.*'__relay-interrupt'.*companion\/key\/inbox'.*'term-a'.*'claude-code'.*'codex'/
    );
  });

  it('uses askpass for background SSH commands when available', async () => {
    askpassMock.isRunning.mockReturnValue(true);
    askpassMock.getHelperScriptPath.mockReturnValue('/tmp/komla-askpass.sh');
    askpassMock.getSocketPath.mockReturnValue('/tmp/komla-askpass.sock');
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(null, { stdout: 'ok\n', stderr: '' });
    });
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');

    await sshWorkspaceService.run(
      {
        id: 'ssh-dev',
        name: 'Devbox',
        hostname: '203.0.113.20',
        user: 'devuser',
        basePath: '~/.komla',
      },
      'printf ok'
    );

    const options = execFileMock.mock.calls[0][2] as { env?: NodeJS.ProcessEnv };
    expect(options.env).toMatchObject({
      SSH_ASKPASS: '/tmp/komla-askpass.sh',
      SSH_ASKPASS_REQUIRE: 'force',
      DISPLAY: ':',
      KOMLA_ASKPASS_SOCKET: '/tmp/komla-askpass.sock',
      KOMLA_ASKPASS_SESSION: 'askpass-session',
    });
  });

  itWithPosixShell('streams output and retries a stale multiplexed SSH session without multiplexing', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const root = mkdtempSync(join(tmpdir(), 'komla-streaming-ssh-'));
    const sshPath = join(root, 'ssh');
    const argsPath = join(root, 'args.txt');
    const envPath = join(root, 'env.txt');
    const refusedPath = join(root, 'refused');
    writeFileSync(
      sshPath,
      '#!/bin/sh\nif [ ! -e "$KOMLA_TEST_SSH_REFUSED" ]; then touch "$KOMLA_TEST_SSH_REFUSED"; printf "Session open refused by peer" >&2; exit 255; fi\nprintf "%s\\n" "$@" > "$KOMLA_TEST_SSH_ARGS"\nprintf "%s" "${SSH_ASKPASS-}" > "$KOMLA_TEST_SSH_ENV"\nprintf "setup stdout"\nprintf "setup stderr" >&2\n'
    );
    chmodSync(sshPath, 0o755);
    process.env.PATH = `${root}:${originalPath ?? ''}`;
    process.env.KOMLA_TEST_SSH_ARGS = argsPath;
    process.env.KOMLA_TEST_SSH_ENV = envPath;
    process.env.KOMLA_TEST_SSH_REFUSED = refusedPath;
    askpassMock.isRunning.mockReturnValue(true);
    askpassMock.getHelperScriptPath.mockReturnValue('/tmp/komla-askpass.sh');
    askpassMock.getSocketPath.mockReturnValue('/tmp/komla-askpass.sock');
    const stdout: string[] = [];
    const stderr: string[] = [];

    try {
      const { sshWorkspaceService } =
        await import('../../../src/main/services/ssh-workspace.service');
      await expect(
        sshWorkspaceService.runStreaming(
          {
            id: 'ssh-stream',
            name: 'Streaming Host',
            hostname: 'stream.example.com',
            user: 'dev',
            port: 2222,
            basePath: '~/.komla',
          },
          "cd '/remote/work tree' || exit $?\nprintf ready",
          { onData: (data) => stdout.push(data), onErrorData: (data) => stderr.push(data) }
        )
      ).resolves.toBe(0);

      const args = readFileSync(argsPath, 'utf8');
      expect(args).toContain('2222');
      expect(args).toContain('dev@stream.example.com');
      expect(args).toContain('ControlPath=none');
      expect(args).toContain(`sh -lc 'cd '"'"'/remote/work tree'"'"' || exit $?`);
      expect(args).toContain('printf ready');
      expect(readFileSync(envPath, 'utf8')).toBe('/tmp/komla-askpass.sh');
      expect(stdout.join('')).toBe('setup stdout');
      expect(stderr.join('')).toContain('Session open refused by peer');
      expect(stderr.join('')).toContain('setup stderr');
    } finally {
      delete process.env.KOMLA_TEST_SSH_ARGS;
      delete process.env.KOMLA_TEST_SSH_ENV;
      delete process.env.KOMLA_TEST_SSH_REFUSED;
      rmSync(root, { recursive: true, force: true });
    }
  });

  itWithPosixShell('shares streaming SSH connections within a workspace but not between workspaces', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const root = mkdtempSync(join(tmpdir(), 'komla-scoped-streaming-ssh-'));
    const sshPath = join(root, 'ssh');
    const argsPath = join(root, 'args.txt');
    writeFileSync(sshPath, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$KOMLA_TEST_SSH_ARGS"\n', {
      mode: 0o755,
    });
    process.env.PATH = `${root}:${originalPath ?? ''}`;
    process.env.KOMLA_TEST_SSH_ARGS = argsPath;

    try {
      const { sshWorkspaceService } =
        await import('../../../src/main/services/ssh-workspace.service');
      const host = {
        id: 'ssh-stream-scoped',
        name: 'Streaming Host',
        hostname: 'stream.example.com',
        user: 'dev',
        basePath: '~/.komla',
      };

      await sshWorkspaceService.runStreaming(host, 'printf first', {
        workspaceId: 'workspace-first',
      });
      await sshWorkspaceService.runStreaming(host, 'printf second', {
        workspaceId: 'workspace-first',
      });
      await sshWorkspaceService.runStreaming(host, 'printf third', {
        workspaceId: 'workspace-second',
      });

      const controlPaths = readFileSync(argsPath, 'utf8')
        .trim()
        .split('\n')
        .map((args) => args.match(/ControlPath=([^ ]+)/)?.[1]);
      expect(controlPaths[0]).toBeTruthy();
      expect(controlPaths[1]).toBe(controlPaths[0]);
      expect(controlPaths[2]).not.toBe(controlPaths[0]);
    } finally {
      delete process.env.KOMLA_TEST_SSH_ARGS;
      rmSync(root, { recursive: true, force: true });
    }
  });

  itWithPosixShell('launches independent streaming commands without waiting for earlier commands to exit', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const root = mkdtempSync(join(tmpdir(), 'komla-concurrent-streaming-ssh-'));
    const sshPath = join(root, 'ssh');
    const startedPath = join(root, 'started.txt');
    writeFileSync(
      sshPath,
      '#!/bin/sh\nprintf "started\\n" >> "$KOMLA_TEST_SSH_STARTED"\ntrap \'exit 143\' TERM INT\nwhile :; do sleep 0.1; done\n'
    );
    chmodSync(sshPath, 0o755);
    process.env.PATH = `${root}:${originalPath ?? ''}`;
    process.env.KOMLA_TEST_SSH_STARTED = startedPath;
    const controllers = Array.from({ length: 4 }, () => new AbortController());
    let runs: Promise<unknown>[] = [];

    try {
      const { sshWorkspaceService } =
        await import('../../../src/main/services/ssh-workspace.service');
      const host = {
        id: 'ssh-stream-concurrent',
        name: 'Streaming Host',
        hostname: 'stream.example.com',
        user: 'dev',
        basePath: '~/.komla',
      };
      runs = controllers.map((controller, index) =>
        sshWorkspaceService
          .runStreaming(host, `printf ${index}`, {
            signal: controller.signal,
          })
          .catch((error: unknown) => error)
      );

      await vi.waitFor(() => {
        const started = existsSync(startedPath)
          ? readFileSync(startedPath, 'utf8').trim().split('\n')
          : [];
        expect(started).toHaveLength(4);
      });
    } finally {
      controllers.forEach((controller) => controller.abort());
      await Promise.all(runs);
      delete process.env.KOMLA_TEST_SSH_STARTED;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('opportunistically multiplexes noninteractive SSH commands on Linux', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(null, { stdout: 'ok\n', stderr: '' });
    });
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');

    await sshWorkspaceService.run(
      {
        id: 'ssh-dev',
        name: 'Devbox',
        hostname: '203.0.113.20',
        user: 'devuser',
        port: 2222,
        identityFile: '/home/devuser/.ssh/id_ed25519',
        basePath: '~/.komla',
        extraSshArgs: ['-J', 'bastion'],
      },
      'printf ok'
    );

    const args = execFileMock.mock.calls[0][1] as string[];
    expect(args).toEqual(
      expect.arrayContaining([
        'ServerAliveInterval=30',
        'ServerAliveCountMax=3',
        'ControlMaster=auto',
        'ControlPersist=60',
        expect.stringMatching(/^ControlPath=/),
      ])
    );
    const controlPath = args.find((arg) => arg.startsWith('ControlPath='))?.slice(12);
    expect(controlPath?.split(/[/\\]/).at(-1)).toMatch(/^[a-f0-9]{24}$/);
    expect(args.at(-2)).toBe('devuser@203.0.113.20');
  });

  it('limits background SSH concurrency without blocking every command on the same host', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const callbacks: Array<(error: null, result: { stdout: string; stderr: string }) => void> = [];
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callbacks.push(callback);
    });
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    const host = {
      id: 'ssh-dev',
      name: 'Devbox',
      hostname: '203.0.113.20',
      user: 'devuser',
      basePath: '~/.komla',
    };

    const runs = Array.from({ length: 5 }, (_, index) =>
      sshWorkspaceService.run(host, `printf ${index}`)
    );

    await vi.waitFor(() => expect(execFileMock).toHaveBeenCalledTimes(3));
    callbacks[0]?.(null, { stdout: '0\n', stderr: '' });
    await vi.waitFor(() => expect(execFileMock).toHaveBeenCalledTimes(4));
    callbacks[1]?.(null, { stdout: '1\n', stderr: '' });
    await vi.waitFor(() => expect(execFileMock).toHaveBeenCalledTimes(5));
    callbacks.slice(2).forEach((callback, index) => {
      callback(null, { stdout: `${index + 2}\n`, stderr: '' });
    });
    await expect(Promise.all(runs)).resolves.toEqual(['0\n', '1\n', '2\n', '3\n', '4\n']);
  });

  it('admits an interactive SSH command while background work waits', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const callbacks: Array<(error: null, result: { stdout: string; stderr: string }) => void> = [];
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callbacks.push(callback);
    });
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    const host = {
      id: 'ssh-dev',
      name: 'Devbox',
      hostname: '203.0.113.20',
      user: 'devuser',
      basePath: '~/.komla',
    };

    const backgroundRuns = Array.from({ length: 4 }, (_, index) =>
      sshWorkspaceService.run(host, `printf background-${index}`)
    );
    await vi.waitFor(() => expect(execFileMock).toHaveBeenCalledTimes(3));

    const interactiveRun = sshWorkspaceService.run(host, 'printf interactive', {
      purpose: { kind: 'interactive' },
    });
    await vi.waitFor(() => expect(execFileMock).toHaveBeenCalledTimes(4));
    expect(execFileMock.mock.calls[3][1].at(-1)).toContain('printf interactive');

    callbacks[3]?.(null, { stdout: 'interactive\n', stderr: '' });
    await expect(interactiveRun).resolves.toBe('interactive\n');
    callbacks[0]?.(null, { stdout: 'background-0\n', stderr: '' });
    await vi.waitFor(() => expect(execFileMock).toHaveBeenCalledTimes(5));
    callbacks[1]?.(null, { stdout: 'background-1\n', stderr: '' });
    callbacks[2]?.(null, { stdout: 'background-2\n', stderr: '' });
    callbacks[4]?.(null, { stdout: 'background-3\n', stderr: '' });
    await expect(Promise.all(backgroundRuns)).resolves.toEqual([
      'background-0\n',
      'background-1\n',
      'background-2\n',
      'background-3\n',
    ]);
  });

  it('isolates interactive commands from the background SSH control master', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(null, { stdout: 'ok\n', stderr: '' });
    });
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    const host = {
      id: 'ssh-dev',
      name: 'Devbox',
      hostname: '203.0.113.20',
      user: 'devuser',
      basePath: '~/.komla',
    };

    await sshWorkspaceService.run(host, 'printf background');
    await sshWorkspaceService.run(host, 'printf interactive', {
      purpose: { kind: 'interactive' },
    });

    const controlPaths = execFileMock.mock.calls.map((call) =>
      (call[1] as string[]).find((arg) => arg.startsWith('ControlPath='))
    );
    const persistOptions = execFileMock.mock.calls.map((call) =>
      (call[1] as string[]).find((arg) => arg.startsWith('ControlPersist='))
    );
    expect(controlPaths[0]).toBeTruthy();
    expect(controlPaths[1]).toBeTruthy();
    expect(controlPaths[1]).not.toBe(controlPaths[0]);
    expect(persistOptions).toEqual(['ControlPersist=60', 'ControlPersist=600']);
  });

  it('retries a refused multiplexed session without the control socket', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    execFileMock
      .mockImplementationOnce((_file, _args, _options, callback) => {
        callback(
          Object.assign(new Error('SSH failed'), {
            stderr:
              'mux_client_request_session: session request failed: Session open refused by peer',
          })
        );
      })
      .mockImplementationOnce((_file, _args, _options, callback) => {
        callback(null, { stdout: 'ok\n', stderr: '' });
      });
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');

    await expect(
      sshWorkspaceService.run(
        {
          id: 'ssh-dev',
          name: 'Devbox',
          hostname: '203.0.113.20',
          user: 'devuser',
          basePath: '~/.komla',
        },
        'printf ok'
      )
    ).resolves.toBe('ok\n');

    const retryArgs = execFileMock.mock.calls[1]?.[1] as string[];
    expect(retryArgs).toContain('ControlPath=none');
    expect(retryArgs.some((arg) => arg.startsWith('ControlMaster='))).toBe(false);
    expect(retryArgs.some((arg) => arg.startsWith('ControlPersist='))).toBe(false);
  });

  it('retries a multiplexed command that exceeds the control-socket message limit', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    execFileMock
      .mockImplementationOnce((_file, _args, _options, callback) => {
        callback(
          Object.assign(new Error('SSH failed'), {
            stderr:
              'mm_send_fd: sendmsg(1): Message too long\n' +
              'mux_client_request_session: send fds failed',
          })
        );
      })
      .mockImplementationOnce((_file, _args, _options, callback) => {
        callback(null, { stdout: 'ok\n', stderr: '' });
      });
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');

    await expect(
      sshWorkspaceService.run(
        {
          id: 'ssh-dev',
          name: 'Devbox',
          hostname: '203.0.113.20',
          user: 'devuser',
          basePath: '~/.komla',
        },
        'printf ok'
      )
    ).resolves.toBe('ok\n');

    const retryArgs = execFileMock.mock.calls[1]?.[1] as string[];
    expect(retryArgs).toContain('ControlPath=none');
  });

  it('uses a new multiplexed connection after agent forwarding changes', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(null, { stdout: 'ok\n', stderr: '' });
    });
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    const baseHost = {
      id: 'ssh-dev',
      name: 'Devbox',
      hostname: '203.0.113.20',
      user: 'devuser',
      basePath: '~/.komla',
    };

    await sshWorkspaceService.run(baseHost, 'printf first');
    await sshWorkspaceService.run({ ...baseHost, forwardAgent: true }, 'printf second');

    const firstArgs = execFileMock.mock.calls[0][1] as string[];
    const secondArgs = execFileMock.mock.calls[1][1] as string[];
    const firstControlPath = firstArgs.find((arg) => arg.startsWith('ControlPath='));
    const secondControlPath = secondArgs.find((arg) => arg.startsWith('ControlPath='));
    expect(firstArgs).not.toContain('-A');
    expect(secondArgs).toContain('-A');
    expect(secondControlPath).not.toBe(firstControlPath);
  });

  it('keeps standalone SSH command behavior on Windows', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(null, { stdout: 'ok\n', stderr: '' });
    });
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');

    await sshWorkspaceService.run(
      {
        id: 'ssh-dev',
        name: 'Devbox',
        hostname: '203.0.113.20',
        user: 'devuser',
        basePath: '~/.komla',
      },
      'printf ok'
    );

    const args = execFileMock.mock.calls[0][1] as string[];
    expect(args.some((arg) => arg.includes('ControlMaster'))).toBe(false);
    expect(args.some((arg) => arg.includes('ControlPath'))).toBe(false);
    expect(args.some((arg) => arg.includes('ControlPersist'))).toBe(false);
  });

  itWithPosixShell('multiplexes Unix terminals across a lazy bounded control-master pool', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    const backend = {
      kind: 'ssh' as const,
      hostId: 'ssh-dev',
      remoteDirectory: '/home/devuser/.komla/worktrees/komla/agent-fast-terminal',
      remoteRepoPath: '/home/devuser/.komla/repos/komla/repo.git',
      remoteProjectRoot: '/home/devuser/.komla/worktrees/komla',
      gitUrl: 'https://github.com/komla-dev/komla.git',
      projectName: 'komla',
      branchName: 'agent/fast-terminal',
      baseBranch: 'main',
    };

    const launch = sshWorkspaceService.buildTerminalLaunchCommand(
      backend,
      'codex',
      'term-fast',
      'ws-fast',
      'start'
    );

    expect(launch.command).toContain('/bin/sh -c');
    expect(launch.command).toContain('ServerAliveInterval=30');
    expect(launch.command).toContain('ServerAliveCountMax=3');
    expect(launch.command).toContain('ControlMaster=auto');
    expect(launch.startupMode).toBe('wait-for-marker');
    expect(launch.command).toContain('ControlPersist=60');
    expect(launch.command).toContain('ControlMaster=no');
    expect(launch.command).toContain('-O');
    expect(launch.command).toContain('check');
    expect(launch.command).not.toContain("'-T'");
    expect(launch.command).not.toContain("'true'");
    const terminalControlPaths = Array.from(
      launch.command.matchAll(/\/tmp\/komla-ssh-[^'" ]+\/[a-f0-9]{24}/g),
      (match) => match[0]
    );
    expect(new Set(terminalControlPaths).size).toBe(2);
    expect(launch.command).toContain('ControlPath=none');
    expect(spawnSync('/bin/sh', ['-n', '-c', launch.command]).status).toBe(0);
    const fakeBin = mkdtempSync(join(tmpdir(), 'komla-ssh-pool-command-'));
    writeFileSync(join(fakeBin, 'ssh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    try {
      const commandResult = spawnSync('/bin/sh', ['-c', launch.command], {
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ''}` },
        encoding: 'utf8',
      });
      expect(commandResult.status, commandResult.stderr).toBe(0);
    } finally {
      rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  itWithPosixShell('tries the next terminal master when the real session is refused before attachment', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    const launch = sshWorkspaceService.buildTerminalLaunchCommand(
      {
        kind: 'ssh',
        hostId: 'ssh-dev',
        remoteDirectory: '/home/dev/worktree',
        remoteRepoPath: '/home/dev/repo.git',
        remoteProjectRoot: '/home/dev',
        gitUrl: 'git@example.com:repo.git',
      },
      'codex',
      'term-capacity-fallback',
      'ws-capacity-fallback',
      'start'
    );
    const fakeBin = mkdtempSync(join(tmpdir(), 'komla-ssh-capacity-fallback-'));
    const statePath = join(fakeBin, 'refused-once');
    const launchesPath = join(fakeBin, 'launches.log');
    writeFileSync(
      join(fakeBin, 'ssh'),
      [
        '#!/bin/sh',
        'case " $* " in *" -O check "*) exit 0 ;; esac',
        'printf "launch\\n" >> "$KOMLA_TEST_SSH_LAUNCHES"',
        'if [ ! -f "$KOMLA_TEST_SSH_STATE" ]; then',
        '  : > "$KOMLA_TEST_SSH_STATE"',
        '  printf "mux_client_request_session: session request failed: Session open refused by peer\\n" >&2',
        '  exit 255',
        'fi',
        'exit 0',
        '',
      ].join('\n'),
      { mode: 0o755 }
    );

    try {
      const commandResult = spawnSync('/bin/sh', ['-c', launch.command], {
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
          KOMLA_TEST_SSH_STATE: statePath,
          KOMLA_TEST_SSH_LAUNCHES: launchesPath,
        },
        encoding: 'utf8',
      });

      expect(commandResult.status, commandResult.stderr).toBe(0);
      expect(readFileSync(launchesPath, 'utf8')).toBe('launch\nlaunch\n');
    } finally {
      rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  itWithPosixShell('reuses a later live terminal master before creating a missing preferred master', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    const launch = sshWorkspaceService.buildTerminalLaunchCommand(
      {
        kind: 'ssh',
        hostId: 'ssh-dev',
        remoteDirectory: '/home/dev/worktree',
        remoteRepoPath: '/home/dev/repo.git',
        remoteProjectRoot: '/home/dev',
        gitUrl: 'git@example.com:repo.git',
      },
      null,
      'term-reuse-live-master',
      'ws-reuse-live-master',
      'reconnect'
    );
    const fakeBin = mkdtempSync(join(tmpdir(), 'komla-ssh-reuse-live-master-'));
    const checksPath = join(fakeBin, 'checks');
    const launchArgsPath = join(fakeBin, 'launch-args');
    writeFileSync(
      join(fakeBin, 'ssh'),
      [
        '#!/bin/sh',
        'case " $* " in',
        '  *" -O check "*)',
        '    komla_checks=0',
        '    if [ -f "$KOMLA_TEST_SSH_CHECKS" ]; then komla_checks=$(cat "$KOMLA_TEST_SSH_CHECKS"); fi',
        '    komla_checks=$((komla_checks + 1))',
        '    printf "%s" "$komla_checks" > "$KOMLA_TEST_SSH_CHECKS"',
        '    if [ "$komla_checks" -eq 1 ]; then exit 1; fi',
        '    exit 0',
        '    ;;',
        'esac',
        'printf "%s\\n" "$*" > "$KOMLA_TEST_SSH_LAUNCH_ARGS"',
        'exit 0',
        '',
      ].join('\n'),
      { mode: 0o755 }
    );

    try {
      const commandResult = spawnSync('/bin/sh', ['-c', launch.command], {
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
          KOMLA_TEST_SSH_CHECKS: checksPath,
          KOMLA_TEST_SSH_LAUNCH_ARGS: launchArgsPath,
        },
        encoding: 'utf8',
      });

      expect(commandResult.status, commandResult.stderr).toBe(0);
      expect(readFileSync(checksPath, 'utf8')).toBe('2');
      expect(readFileSync(launchArgsPath, 'utf8')).toContain('ControlMaster=no');
    } finally {
      rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it.each(['reconnect', 'start'] as const)(
    'claims routing of an existing managed session before attaching on %s',
    async (action) => {
      const { sshWorkspaceService } =
        await import('../../../src/main/services/ssh-workspace.service');
      const { command } = sshWorkspaceService.buildTerminalLaunchCommand(
        {
          kind: 'ssh',
          hostId: 'ssh-dev',
          remoteDirectory: '/home/dev/.komla/worktrees/app/main',
          remoteRepoPath: '/home/dev/.komla/repos/app/repo.git',
          remoteProjectRoot: '/home/dev/.komla/worktrees/app',
          gitUrl: 'git@example.com:repo.git',
        },
        null,
        'term-handoff',
        'ws-handoff',
        action,
        {
          companion: {
            installationKey: '41ab41ab41ab41ab',
            hookInbox: '/home/dev/.komla/helpers/companion/41ab41ab41ab41ab/inbox',
            tmuxSocket: 'komla-companion-41ab41ab41ab41ab',
            sessionName: 'komla-companion-41ab41ab41ab41ab',
          },
        }
      );

      const firstAttach = command.indexOf('tmux -u -L komla-v1 attach-session');
      const claimApiUrl = command.indexOf('set-environment -t');
      expect(claimApiUrl).toBeGreaterThan(-1);
      expect(claimApiUrl).toBeLessThan(firstAttach);
      const claim = command.slice(claimApiUrl, firstAttach);
      expect(claim).toContain('KOMLA_API_URL');
      expect(claim).toContain(`127.0.0.1:${komlaSshRemoteDataPort('ssh-dev')}`);
      expect(claim).toContain('/home/dev/.komla/helpers/companion/41ab41ab41ab41ab/inbox');
      expect(claim).toContain('@komla_installation_key');
      expect(claim).toContain('41ab41ab41ab41ab');
      // tmux rejects the exact-match prefix in set-option targets.
      expect(claim).not.toMatch(/set-option -t \S*=komla-term-handoff/);
    }
  );

  itWithPosixShell('tries another missing terminal master after a create race reaches capacity', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    const launch = sshWorkspaceService.buildTerminalLaunchCommand(
      {
        kind: 'ssh',
        hostId: 'ssh-dev',
        remoteDirectory: '/home/dev/worktree',
        remoteRepoPath: '/home/dev/repo.git',
        remoteProjectRoot: '/home/dev',
        gitUrl: 'git@example.com:repo.git',
      },
      null,
      'term-create-capacity-race',
      'ws-create-capacity-race',
      'reconnect'
    );
    const fakeBin = mkdtempSync(join(tmpdir(), 'komla-ssh-create-capacity-race-'));
    const launchesPath = join(fakeBin, 'launches');
    writeFileSync(
      join(fakeBin, 'ssh'),
      [
        '#!/bin/sh',
        'case " $* " in *" -O check "*) exit 1 ;; esac',
        'komla_launches=0',
        'if [ -f "$KOMLA_TEST_SSH_LAUNCHES" ]; then komla_launches=$(cat "$KOMLA_TEST_SSH_LAUNCHES"); fi',
        'komla_launches=$((komla_launches + 1))',
        'printf "%s" "$komla_launches" > "$KOMLA_TEST_SSH_LAUNCHES"',
        'if [ "$komla_launches" -eq 1 ]; then',
        '  printf "mux_client_request_session: session request failed: Session open refused by peer\\n" >&2',
        '  exit 255',
        'fi',
        'exit 0',
        '',
      ].join('\n'),
      { mode: 0o755 }
    );

    try {
      const commandResult = spawnSync('/bin/sh', ['-c', launch.command], {
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
          KOMLA_TEST_SSH_LAUNCHES: launchesPath,
        },
        encoding: 'utf8',
      });

      expect(commandResult.status, commandResult.stderr).toBe(0);
      expect(readFileSync(launchesPath, 'utf8')).toBe('2');
    } finally {
      rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it('shares terminal control-master pools between workspaces on the same host', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    const backend = {
      kind: 'ssh' as const,
      hostId: 'ssh-dev',
      remoteDirectory: '/home/devuser/.komla/worktrees/komla/agent-shared-host',
      remoteRepoPath: '/home/devuser/.komla/repos/komla/repo.git',
      remoteProjectRoot: '/home/devuser/.komla/worktrees/komla',
      gitUrl: 'https://github.com/komla-dev/komla.git',
      projectName: 'komla',
      branchName: 'agent/shared-host',
      baseBranch: 'main',
    };

    const firstWorkspaceLaunch = sshWorkspaceService.buildTerminalLaunchCommand(
      backend,
      null,
      'term-first',
      'workspace-first',
      'start'
    );
    const secondPaneLaunch = sshWorkspaceService.buildTerminalLaunchCommand(
      backend,
      null,
      'term-second',
      'workspace-first',
      'start'
    );
    const secondWorkspaceLaunch = sshWorkspaceService.buildTerminalLaunchCommand(
      backend,
      null,
      'term-third',
      'workspace-second',
      'start'
    );
    const controlPaths = (command: string): Set<string> =>
      new Set(
        Array.from(command.matchAll(/\/tmp\/komla-ssh-[^'" ]+\/[a-f0-9]{24}/g), (match) => match[0])
      );

    expect(controlPaths(secondPaneLaunch.command)).toEqual(
      controlPaths(firstWorkspaceLaunch.command)
    );
    expect(controlPaths(secondWorkspaceLaunch.command)).toEqual(
      controlPaths(firstWorkspaceLaunch.command)
    );
  });

  itWithControlMasters('checks only the current terminal master and one lazy expansion candidate', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    const launch = sshWorkspaceService.buildTerminalLaunchCommand(
      {
        kind: 'ssh',
        hostId: 'ssh-lazy-pool',
        remoteDirectory: '/home/dev/workspace',
        remoteRepoPath: '/home/dev/repo.git',
        remoteProjectRoot: '/home/dev',
        gitUrl: 'git@example.com:repo.git',
      },
      null,
      'term-lazy-pool',
      'workspace-lazy-pool',
      'start'
    );
    const controlPaths = new Set(
      Array.from(
        launch.command.matchAll(/\/tmp\/komla-ssh-[^'" ]+\/[a-f0-9]{24}/g),
        (match) => match[0]
      )
    );

    expect(controlPaths.size).toBe(2);
    sshWorkspaceService.releaseTerminalPoolAssignment('term-lazy-pool');
  });

  itWithControlMasters('expands beyond four terminal masters before falling back to standalone SSH', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    const backend = {
      kind: 'ssh' as const,
      hostId: 'ssh-expandable-pool',
      remoteDirectory: '/home/dev/workspace',
      remoteRepoPath: '/home/dev/repo.git',
      remoteProjectRoot: '/home/dev',
      gitUrl: 'git@example.com:repo.git',
    };
    const terminalControlPaths = (command: string): string[] => [
      ...new Set(
        Array.from(command.matchAll(/\/tmp\/komla-ssh-[^'" ]+\/[a-f0-9]{24}/g), (match) => match[0])
      ),
    ];
    const usedMasterPaths: string[] = [];
    const capacityTransitions = [
      { kind: 'pooled' as const, poolIndex: 1 as const },
      { kind: 'pooled' as const, poolIndex: 2 as const },
      { kind: 'pooled' as const, poolIndex: 3 as const },
      { kind: 'standalone' as const },
    ];

    for (const [index, transition] of capacityTransitions.entries()) {
      const terminalId = `term-expandable-pool-${index}`;
      const launch = sshWorkspaceService.buildTerminalLaunchCommand(
        backend,
        null,
        terminalId,
        `workspace-expandable-pool-${index}`,
        'start'
      );
      usedMasterPaths.push(terminalControlPaths(launch.command)[0]);
      sshWorkspaceService.recordTerminalPoolAssignment(terminalId, transition);
    }

    const fifthMasterLaunch = sshWorkspaceService.buildTerminalLaunchCommand(
      backend,
      null,
      'term-expandable-pool-4',
      'workspace-expandable-pool-4',
      'start'
    );
    expect(usedMasterPaths).not.toContain(terminalControlPaths(fifthMasterLaunch.command)[0]);

    for (let index = 0; index <= 4; index += 1) {
      sshWorkspaceService.releaseTerminalPoolAssignment(`term-expandable-pool-${index}`);
    }
  });

  it('routes new terminals away from a host pool member after a capacity fallback', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    const backend = {
      kind: 'ssh' as const,
      hostId: 'ssh-status-test',
      remoteDirectory: '/home/dev/workspace',
      remoteRepoPath: '/home/dev/repo.git',
      remoteProjectRoot: '/home/dev',
      gitUrl: 'git@example.com:repo.git',
      projectName: 'repo',
      branchName: 'feature/pool-routing',
      baseBranch: 'main',
    };

    const first = sshWorkspaceService.buildTerminalLaunchCommand(
      backend,
      null,
      'term-pool-first',
      'workspace-first',
      'start'
    );
    const second = sshWorkspaceService.buildTerminalLaunchCommand(
      backend,
      null,
      'term-pool-second',
      'workspace-second',
      'start'
    );
    const terminalControlPaths = (command: string): string[] => [
      ...new Set(
        Array.from(command.matchAll(/\/tmp\/komla-ssh-[^'" ]+\/[a-f0-9]{24}/g), (match) => match[0])
      ),
    ];
    const originalOrder = terminalControlPaths(first.command);
    expect(terminalControlPaths(second.command)[0]).toBe(originalOrder[0]);

    sshWorkspaceService.recordTerminalPoolAssignment('term-pool-second', {
      kind: 'pooled',
      poolIndex: 1,
    });
    const afterCapacityFailure = sshWorkspaceService.buildTerminalLaunchCommand(
      backend,
      null,
      'term-pool-third',
      'workspace-third',
      'start'
    );
    expect(terminalControlPaths(afterCapacityFailure.command)[0]).toBe(originalOrder[1]);

    sshWorkspaceService.releaseTerminalPoolAssignment('term-pool-first');
    const afterCapacityReturns = sshWorkspaceService.buildTerminalLaunchCommand(
      backend,
      null,
      'term-pool-fourth',
      'workspace-fourth',
      'start'
    );
    expect(terminalControlPaths(afterCapacityReturns.command)[0]).toBe(originalOrder[0]);

    for (const terminalId of ['term-pool-second', 'term-pool-third', 'term-pool-fourth']) {
      sshWorkspaceService.releaseTerminalPoolAssignment(terminalId);
    }
  });

  it('optimistically reconnects directly to the managed remote terminal session', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    const backend = {
      kind: 'ssh' as const,
      hostId: 'ssh-dev',
      remoteDirectory: '/home/devuser/.komla/worktrees/komla/agent-reconnect',
      remoteRepoPath: '/home/devuser/.komla/repos/komla/repo.git',
      remoteProjectRoot: '/home/devuser/.komla/worktrees/komla',
      gitUrl: 'https://github.com/komla-dev/komla.git',
      projectName: 'komla',
      branchName: 'agent/reconnect',
      baseBranch: 'main',
    };

    const launch = sshWorkspaceService.buildTerminalLaunchCommand(
      backend,
      null,
      'term-reconnect',
      'ws-reconnect',
      'reconnect'
    );
    expect(launch.command).toContain('ControlMaster=no');
    expect(launch.command).toContain('ControlPath=none');
    expect(launch.command).not.toContain('command -v tmux');
    expect(launch.command).not.toContain('list-commands');
    expect(launch.command).not.toContain("'-T'");
    expect(launch.command).not.toContain('/helpers/terminal.sh');
    expect(launch.command).toContain('komla-ssh-terminal.XXXXXX');
    expect(launch.command).toContain('Session open refused by peer');
    expect(launch.command).toContain('mux_client_request_session: send fds failed');
    expect(launch.command).toContain('tmux -u -L komla-v1 attach-session');
    const optimisticAttach = launch.command.slice(
      launch.command.indexOf('if tmux -L komla-v1 has-session'),
      launch.command.indexOf('saved managed remote terminal session ended')
    );
    expect(optimisticAttach).not.toContain('exec tmux -u -L komla-v1 attach-session');
    expect(optimisticAttach).toContain('&& exit 0');
    expect(launch.command).toContain('managed-remote-terminal-session-replaced');
    expect(launch.command).toContain('=komla-term-reconnect');
    expect(launch.command).toContain('tmux -L komla-v1 new-session -d -s');
    expect(launch.command.indexOf('attach-session')).toBeLessThan(
      launch.command.indexOf('new-session')
    );
    expect(launch.command.indexOf('has-session')).toBeLessThan(
      launch.command.indexOf('attach-session')
    );
  });

  it.each(['start', 'replace', 'reconnect'] as const)(
    'attaches %s terminals as UTF-8 clients whatever the remote locale',
    async (action) => {
      const { sshWorkspaceService } =
        await import('../../../src/main/services/ssh-workspace.service');

      const launch = sshWorkspaceService.buildTerminalLaunchCommand(
        {
          kind: 'ssh',
          hostId: 'ssh-dev',
          remoteDirectory: '/home/dev/.komla/worktrees/komla/utf8',
          remoteRepoPath: '/home/dev/.komla/repos/komla/repo.git',
          remoteProjectRoot: '/home/dev/.komla/worktrees/komla',
          gitUrl: 'https://github.com/komla-dev/komla.git',
        },
        null,
        `term-utf8-${action}`,
        undefined,
        action
      );

      const attaches = launch.command.match(/attach-session/g) ?? [];
      expect(attaches.length).toBeGreaterThan(0);
      expect(launch.command.match(/tmux -u -L komla-v1 attach-session/g)).toHaveLength(
        attaches.length
      );
    }
  );

  itWithPosixShell.each([
    ['keeps', 'latest', false],
    ['detaches', 'largest', true],
    ['detaches', '', true],
  ] as const)(
    "%s other devices' clients when the server sizes windows by '%s'",
    async (_, windowSize, detaches) => {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      const { sshWorkspaceService } =
        await import('../../../src/main/services/ssh-workspace.service');
      const root = mkdtempSync(join(tmpdir(), 'komla-shared-attach-'));
      const tmuxLog = join(root, 'tmux.log');
      writeFileSync(
        join(root, 'ssh'),
        [
          '#!/bin/sh',
          'last=',
          'for argument do last="$argument"; done',
          'case " $* " in *" -O check "*) exit 1 ;; esac',
          'exec /bin/sh -c "$last"',
          '',
        ].join('\n'),
        { mode: 0o755 }
      );
      // tmux before 2.9 has no window-size option, and before 3.1 no `latest`.
      writeFileSync(
        join(root, 'tmux'),
        [
          '#!/bin/sh',
          `printf "%s\\n" "$*" >> ${JSON.stringify(tmuxLog)}`,
          `case " $* " in *" show-options -gqv window-size "*) printf '%s' ${JSON.stringify(windowSize)} ;; esac`,
          'exit 0',
          '',
        ].join('\n'),
        { mode: 0o755 }
      );

      try {
        const launch = sshWorkspaceService.buildTerminalLaunchCommand(
          {
            kind: 'ssh',
            hostId: 'ssh-dev',
            remoteDirectory: root,
            remoteRepoPath: '/home/dev/repo.git',
            remoteProjectRoot: '/home/dev',
            gitUrl: 'git@example.com:repo.git',
          },
          null,
          'term-shared',
          'ws-shared',
          'reconnect'
        );
        const result = spawnSync('/bin/sh', ['-c', launch.command], {
          env: { ...process.env, PATH: `${root}:${process.env.PATH ?? ''}` },
          encoding: 'utf8',
        });
        const attach = readFileSync(tmuxLog, 'utf8')
          .trim()
          .split('\n')
          .find((call) => call.includes(' attach-session '));

        expect(result.status, result.stderr).toBe(0);
        expect(attach).toBe(
          `-u -L komla-v1 attach-session ${detaches ? '-d ' : ''}-t =komla-term-shared`
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it('hands a session to the device whose client became its latest, where tmux can tell', async () => {
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');

    const launch = sshWorkspaceService.buildTerminalLaunchCommand(
      {
        kind: 'ssh',
        hostId: 'ssh-dev',
        remoteDirectory: '/home/dev/.komla/worktrees/komla/shared',
        remoteRepoPath: '/home/dev/.komla/repos/komla/repo.git',
        remoteProjectRoot: '/home/dev/.komla/worktrees/komla',
        gitUrl: 'https://github.com/komla-dev/komla.git',
      },
      null,
      'term-shared',
      undefined,
      'reconnect'
    );

    expect(launch.command).toMatch(
      /set-hook -g client-active '[^\n]+@komla_route_[^\n]+KOMLA_COMPANION_INBOX[^\n]+' 2>\/dev\/null \|\| true/
    );
    const claim = launch.command.slice(
      0,
      launch.command.indexOf('tmux -u -L komla-v1 attach-session')
    );
    expect(claim).toContain('if komla_tty=$(tty 2>/dev/null); then');
  });

  it('keeps Windows terminals on standalone SSH connections', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    const backend = {
      kind: 'ssh' as const,
      hostId: 'ssh-dev',
      remoteDirectory: '/home/devuser/.komla/worktrees/komla/agent-windows',
      remoteRepoPath: '/home/devuser/.komla/repos/komla/repo.git',
      remoteProjectRoot: '/home/devuser/.komla/worktrees/komla',
      gitUrl: 'https://github.com/komla-dev/komla.git',
      projectName: 'komla',
      branchName: 'agent/windows',
      baseBranch: 'main',
    };

    const launch = sshWorkspaceService.buildTerminalLaunchCommand(
      backend,
      null,
      'term-windows',
      'ws-windows',
      'start'
    );

    expect(launch.command).not.toContain('ControlMaster');
    expect(launch.command).not.toContain('ControlPath');
    expect(launch.command).not.toContain('/bin/sh -c');
    expect(launch.command).toMatch(
      /^& \{ \$PSNativeCommandArgumentPassing = 'Legacy'; & 'ssh' '-tt'/
    );
    expect(launch.command).toContain(String.raw`has-session -t \"$target\"`);
    expect(launch.command).not.toContain('; exec ssh');
    expect(launch.command).toMatch(/ \}; exit \$LASTEXITCODE$/);

    const promptLaunch = sshWorkspaceService.buildTerminalLaunchCommand(
      backend,
      'claude "$(printf -- \'Don\u2019t touch\')"',
      'term-windows',
      'ws-windows',
      'start'
    );
    expect(promptLaunch.command).toContain('Don\u2019\u2019t touch');
    expect(promptLaunch.command).not.toContain('Don\u2019t touch');
  });

  it('uses Windows OpenSSH for remote terminals launched from WSL', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    process.env.SystemRoot = 'D:\\Windows';
    configGetMock.mockReturnValue({ notificationPort: 54183, shellMode: 'wsl' });
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    const launch = sshWorkspaceService.buildTerminalLaunchCommand(
      {
        kind: 'ssh',
        hostId: 'ssh-dev',
        remoteDirectory: '/home/devuser/.komla/worktrees/komla/agent-wsl',
        remoteRepoPath: '/home/devuser/.komla/repos/komla/repo.git',
        remoteProjectRoot: '/home/devuser/.komla/worktrees/komla',
        gitUrl: 'https://github.com/komla-dev/komla.git',
        projectName: 'komla',
        branchName: 'agent/wsl',
        baseBranch: 'main',
      },
      null,
      'term-wsl',
      'ws-wsl',
      'start'
    );

    expect(launch.command).toContain('/mnt/d/Windows/System32/OpenSSH/ssh.exe');
    expect(launch.command).toContain('/proc/sys/fs/binfmt_misc/WSLInterop');
    expect(launch.command).toContain(`else exec '"'"'ssh'"'"' '"'"'-tt'"'"'`);
    expect(launch.command).not.toContain('ControlMaster');
    expect(launch.command).not.toContain('ControlPath');
  });

  it('respects user-supplied SSH multiplexing options', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(null, { stdout: 'ok\n', stderr: '' });
    });
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');

    await sshWorkspaceService.run(
      {
        id: 'ssh-dev',
        name: 'Devbox',
        hostname: '203.0.113.20',
        user: 'devuser',
        basePath: '~/.komla',
        extraSshArgs: ['-o', 'ControlPath=/tmp/user-ssh-control'],
      },
      'printf ok'
    );

    const args = execFileMock.mock.calls[0][1] as string[];
    expect(args.filter((arg) => arg.startsWith('ControlPath='))).toEqual([
      'ControlPath=/tmp/user-ssh-control',
    ]);
    expect(args).not.toContain('ControlMaster=auto');
    expect(args).not.toContain('ControlPersist=60');
  });

  it('respects user-supplied SSH keepalive options', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(null, { stdout: 'ok\n', stderr: '' });
    });
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');

    await sshWorkspaceService.run(
      {
        id: 'ssh-dev',
        name: 'Devbox',
        hostname: '203.0.113.20',
        user: 'devuser',
        basePath: '~/.komla',
        extraSshArgs: ['-oServerAliveInterval=10', '-o', 'ServerAliveCountMax=6'],
      },
      'printf ok'
    );

    const args = execFileMock.mock.calls[0][1] as string[];
    expect(args).toContain('-oServerAliveInterval=10');
    expect(args).toContain('ServerAliveCountMax=6');
    expect(args).not.toContain('ServerAliveInterval=30');
    expect(args).not.toContain('ServerAliveCountMax=3');
  });

  it('runs remote action commands as shell syntax after exporting Komla env', async () => {
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    const backend = {
      kind: 'ssh' as const,
      hostId: 'ssh-dev',
      remoteDirectory: '/home/devuser/.komla/worktrees/komla/clear-sage',
      remoteRepoPath: '/home/devuser/.komla/repos/komla/repo.git',
      remoteProjectRoot: '/home/devuser/.komla/worktrees/komla',
      gitUrl: 'https://github.com/komla-dev/komla.git',
      projectName: 'komla',
      branchName: 'clear-sage',
      baseBranch: 'main',
    };

    const command = sshWorkspaceService.buildTerminalCommand(
      backend,
      'cd license-worker && npm run dev',
      'term-a',
      'ws-1',
      'start'
    );

    expect(command).toContain('KOMLA_NOTIFY_HOST=');
    expect(command).toMatch(/KOMLA_API_URL=.*http:\/\/127\.0\.0\.1:\d+\/terminals\/term-a/);
    expect(command).toContain('cd license-worker && npm run dev');
    expect(command).not.toContain('/home/devuser/.komla/helpers/terminal.sh');
  });

  it('does not embed a legacy Git observer in managed terminal launches', async () => {
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    const backend = {
      kind: 'ssh' as const,
      hostId: 'ssh-dev',
      remoteDirectory: '/home/devuser/.komla/worktrees/komla/claude-onyx-grove',
      remoteRepoPath: '/home/devuser/.komla/repos/komla/repo.git',
      remoteProjectRoot: '/home/devuser/.komla/worktrees/komla',
      gitUrl: 'https://github.com/komla-dev/komla.git',
      projectName: 'komla',
      branchName: 'claude/onyx-grove',
      baseBranch: 'main',
    };

    const command = sshWorkspaceService.buildTerminalCommand(
      backend,
      'claude',
      'term-a',
      'ws-1',
      'start'
    );

    expect(command).toContain('KOMLA_WORKSPACE_ID=');
    expect(command).toContain('KOMLA_REMOTE_WORKSPACE_DIR=');
    expect(command).toContain('KOMLA_TARGET_BRANCH=');
    expect(command).not.toContain('/api/v1/ssh-workspace-status');
    expect(command).not.toContain('git status');
  });

  it('restores files inside the remote workspace over SSH', async () => {
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(null, { stdout: '', stderr: '' });
    });
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    const backend = {
      kind: 'ssh' as const,
      hostId: 'ssh-dev',
      remoteDirectory: '/home/devuser/.komla/worktrees/komla/clear-sage',
      remoteRepoPath: '/home/devuser/.komla/repos/komla/repo.git',
      remoteProjectRoot: '/home/devuser/.komla/worktrees/komla',
      gitUrl: 'https://github.com/komla-dev/komla.git',
      projectName: 'komla',
      branchName: 'clear-sage',
      baseBranch: 'main',
    };

    await sshWorkspaceGit.restoreFile(backend, 'src/app.ts', 'modified');

    const remoteCommand = execFileMock.mock.calls[0][1].at(-1);
    expect(remoteCommand).toContain('/home/devuser/.komla/worktrees/komla/clear-sage');
    expect(remoteCommand).toContain('src/app.ts');
    expect(remoteCommand).toContain('git checkout HEAD -- ":(literal)$file"');
  });

  it('lists remote workspace branches over SSH', async () => {
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(null, {
        stdout:
          'feature/current\nmain\n__KOMLA_REMOTE_BRANCHES__\norigin/main\nupstream/feature/remote\norigin/HEAD\n',
        stderr: '',
      });
    });
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    const backend = {
      kind: 'ssh' as const,
      hostId: 'ssh-dev',
      remoteDirectory: '/home/devuser/.komla/worktrees/komla/clear-sage',
      remoteRepoPath: '/home/devuser/.komla/repos/komla/repo.git',
      remoteProjectRoot: '/home/devuser/.komla/worktrees/komla',
      gitUrl: 'https://github.com/komla-dev/komla.git',
      projectName: 'komla',
      branchName: 'clear-sage',
      baseBranch: 'main',
    };

    const branches = await sshWorkspaceGit.listBranches(backend, true);

    expect(branches).toEqual([
      { name: 'feature/current', isRemoteOnly: false },
      { name: 'main', isRemoteOnly: false },
      { name: 'main', isRemoteOnly: true, remoteRef: 'origin/main' },
      { name: 'feature/remote', isRemoteOnly: true, remoteRef: 'upstream/feature/remote' },
    ]);
    const remoteCommand = execFileMock.mock.calls[0][1].at(-1);
    expect(remoteCommand).toContain('git branch --sort=-committerdate');
    expect(remoteCommand).toContain('git branch -r --sort=-committerdate');
  });

  itWithPosixShell('reads the commit graph of a remote workspace over SSH', async () => {
    const repo = createTargetBranchTestRepo();
    runGit(['push', '-u', 'origin', 'feature'], repo.featurePath);
    writeFileSync(join(repo.featurePath, 'later.txt'), 'later\n');
    runGit(['add', 'later.txt'], repo.featurePath);
    runGit(['commit', '-m', 'later\n\nWith a body'], repo.featurePath);
    mockRemoteShell(repo.root);

    try {
      const graph = await sshWorkspaceGit.getCommitGraph(repo.backend, { limit: 2 });

      expect(graph).toMatchObject({
        currentBranch: 'feature',
        upstream: 'origin/feature',
        hasMore: true,
      });
      expect(graph.commits.map((commit) => [commit.message, commit.refs])).toEqual([
        ['later\n\nWith a body', [{ kind: 'branch', name: 'feature' }]],
        ['feature', [{ kind: 'remote', name: 'origin/feature' }]],
      ]);
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  itWithPosixShell("reads a remote commit's changes, a merge's against its first parent", async () => {
    const repo = createTargetBranchTestRepo();
    runGit(['switch', '-c', 'side'], repo.featurePath);
    writeFileSync(join(repo.featurePath, 'side.txt'), 'from side\n');
    runGit(['add', 'side.txt'], repo.featurePath);
    runGit(['commit', '-m', 'side'], repo.featurePath);
    runGit(['switch', 'feature'], repo.featurePath);
    writeFileSync(join(repo.featurePath, 'shared.txt'), 'changed on feature\n');
    runGit(['commit', '-am', 'change shared'], repo.featurePath);
    const change = runGit(['rev-parse', 'HEAD'], repo.featurePath);
    runGit(['merge', '--no-ff', '-m', 'Merge side', 'side'], repo.featurePath);
    const merge = runGit(['rev-parse', 'HEAD'], repo.featurePath);
    const root = runGit(['rev-list', '--max-parents=0', 'HEAD'], repo.featurePath);
    const workspace = { id: 'feature', backend: repo.backend } as Workspace;
    mockRemoteShell(repo.root);

    try {
      const mergeDiff = await sshWorkspaceDiff.getCommitDiff(workspace, merge);
      expect(mergeDiff.commit).toMatchObject({ hash: merge, message: 'Merge side' });
      expect(mergeDiff.commit.parentHashes).toEqual([change, expect.any(String)]);
      expect(mergeDiff.files).toEqual([
        expect.objectContaining({ path: 'side.txt', status: 'added', additions: 1 }),
      ]);
      expect((await sshWorkspaceDiff.getCommitDiff(workspace, root)).files).toEqual([
        expect.objectContaining({ path: 'shared.txt', status: 'added' }),
      ]);

      await expect(
        sshWorkspaceDiff.getCommitFileDiff(workspace, merge, 'side.txt')
      ).resolves.toMatchObject({ status: 'added', oldContent: null, newContent: 'from side\n' });
      await expect(
        sshWorkspaceDiff.getCommitFileDiff(workspace, change, 'shared.txt')
      ).resolves.toMatchObject({
        status: 'modified',
        oldContent: 'initial\n',
        newContent: 'changed on feature\n',
        isBinary: false,
      });
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  itWithPosixShell('reads both sides of a remote image diff as image data', async () => {
    const repo = createTargetBranchTestRepo();
    // Bytes that aren't valid UTF-8, so a text round trip would corrupt them.
    const oldPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x01]);
    const newPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xfe, 0x02]);
    writeFileSync(join(repo.featurePath, 'logo.png'), oldPng);
    runGit(['add', 'logo.png'], repo.featurePath);
    runGit(['commit', '-m', 'add logo'], repo.featurePath);
    const added = runGit(['rev-parse', 'HEAD'], repo.featurePath);
    writeFileSync(join(repo.featurePath, 'logo.png'), newPng);
    const workspace = { id: 'feature', backend: repo.backend } as Workspace;
    mockRemoteShell(repo.root);

    try {
      await expect(
        sshWorkspaceDiff.getCommitFileDiff(workspace, added, 'logo.png')
      ).resolves.toMatchObject({
        status: 'added',
        isBinary: true,
        isImage: true,
        mimeType: 'image/png',
        oldImageData: null,
        newImageData: oldPng.toString('base64'),
      });
      await expect(
        sshWorkspaceDiff.getFullFileDiff(workspace, 'logo.png', false)
      ).resolves.toMatchObject({
        status: 'modified',
        isBinary: true,
        isImage: true,
        mimeType: 'image/png',
        oldImageData: oldPng.toString('base64'),
        newImageData: newPng.toString('base64'),
      });
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  itWithPosixShell('reads a remote image over the text size cap, and leaves an image git sees as text', async () => {
    const repo = createTargetBranchTestRepo();
    const largePng = Buffer.alloc(6 * 1024 * 1024, 0xff);
    largePng.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    writeFileSync(join(repo.featurePath, 'large.png'), largePng);
    // A Git LFS pointer: text at an image path, not the image itself.
    writeFileSync(
      join(repo.featurePath, 'pointer.png'),
      'version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 12345\n'
    );
    runGit(['add', 'large.png', 'pointer.png'], repo.featurePath);
    runGit(['commit', '-m', 'add images'], repo.featurePath);
    const added = runGit(['rev-parse', 'HEAD'], repo.featurePath);
    const workspace = { id: 'feature', backend: repo.backend } as Workspace;
    mockRemoteShell(repo.root);

    try {
      await expect(
        sshWorkspaceDiff.getCommitFileDiff(workspace, added, 'large.png')
      ).resolves.toMatchObject({ isImage: true, newImageData: largePng.toString('base64') });
      const pointer = await sshWorkspaceDiff.getCommitFileDiff(workspace, added, 'pointer.png');
      expect(pointer).toMatchObject({ status: 'added', isBinary: true });
      expect(pointer.isImage).toBeUndefined();
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  itWithPosixShell('reads a remote commit whose message or file names imitate its output, signed and shown so', async () => {
    const repo = createTargetBranchTestRepo();
    const subject = 'imitate __KOMLA_NUMSTAT__';
    for (const name of ['café.txt', 'x__KOMLA_NAME_STATUS__']) {
      writeFileSync(join(repo.featurePath, name), 'one\n');
    }
    runGit(['add', '.'], repo.featurePath);
    runGit(['commit', '-m', `${subject}\n\n__KOMLA_NAME_STATUS__`], repo.featurePath);
    // Signed again with a signature git can't verify, which it says on stdout when showing them.
    const signed = runGit(['cat-file', 'commit', 'HEAD'], repo.featurePath).replace(
      /^(committer .*)$/m,
      '$1\ngpgsig -----BEGIN SSH SIGNATURE-----\n U1NIU0lH\n -----END SSH SIGNATURE-----'
    );
    const hash = execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], {
      cwd: repo.featurePath,
      input: `${signed}\n`,
      encoding: 'utf8',
    }).trim();
    runGit(['update-ref', 'HEAD', hash], repo.featurePath);
    runGit(['config', 'log.showSignature', 'true'], repo.featurePath);
    const workspace = { id: 'feature', backend: repo.backend } as Workspace;
    mockRemoteShell(repo.root);

    try {
      const diff = await sshWorkspaceDiff.getCommitDiff(workspace, hash);

      expect(diff.commit).toMatchObject({ hash, message: `${subject}\n\n__KOMLA_NAME_STATUS__` });
      expect(diff.files.map((file) => [file.path, file.status])).toEqual([
        ['café.txt', 'added'],
        ['x__KOMLA_NAME_STATUS__', 'added'],
      ]);
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  itWithPosixShell("reads older commits of one file's history on another remote branch", async () => {
    const repo = createTargetBranchTestRepo();
    for (const line of ['two', 'three']) {
      writeFileSync(join(repo.featurePath, 'shared.txt'), `${line}\n`);
      runGit(['commit', '-am', line], repo.featurePath);
    }
    runGit(['switch', '-c', 'elsewhere', 'main'], repo.featurePath);
    mockRemoteShell(repo.root);

    try {
      const graph = await sshWorkspaceGit.getCommitGraph(repo.backend, {
        limit: 1,
        skip: 1,
        ref: 'feature',
        path: 'shared.txt',
      });

      expect(graph.commits.map((commit) => commit.message)).toEqual(['two']);
      expect(graph.hasMore).toBe(true);
      await expect(
        sshWorkspaceGit.getCommitGraph(repo.backend, { limit: 1, path: '../escape' })
      ).rejects.toThrow('escapes the workspace');
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  itWithPosixShell('reads an empty commit graph for a remote branch without commits', async () => {
    const root = mkdtempSync(join(tmpdir(), 'komla-ssh-graph-'));
    runGit(['init', '-b', 'main', join(root, 'empty')]);
    mockRemoteShell(root);

    try {
      const graph = await sshWorkspaceGit.getCommitGraph(
        {
          kind: 'ssh',
          hostId: 'ssh-dev',
          remoteDirectory: join(root, 'empty'),
          remoteRepoPath: join(root, 'empty', '.git'),
          remoteProjectRoot: root,
          gitUrl: '',
          projectName: 'empty',
          branchName: 'main',
          baseBranch: 'main',
        },
        { limit: 50 }
      );

      expect(graph).toEqual({ commits: [], hasMore: false, currentBranch: null, upstream: null });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  itWithPosixShell('switches a remote-only branch from a non-origin remote', async () => {
    const repo = createTargetBranchTestRepo();
    runGit(['switch', '-c', 'upstream-only'], repo.seedPath);
    writeFileSync(join(repo.seedPath, 'upstream.txt'), 'upstream\n');
    runGit(['add', 'upstream.txt'], repo.seedPath);
    runGit(['commit', '-m', 'upstream branch'], repo.seedPath);
    runGit(['push', 'origin', 'upstream-only'], repo.seedPath);
    runGit(['remote', 'add', 'upstream', repo.originPath], repo.featurePath);
    runGit(['fetch', 'upstream', 'upstream-only'], repo.featurePath);
    mockRemoteShell(repo.root);

    try {
      const { sshWorkspaceService } =
        await import('../../../src/main/services/ssh-workspace.service');
      const result = await sshWorkspaceGit.switchBranch(repo.backend, 'upstream-only');

      expect(result).toEqual({
        success: true,
        message: 'Switched to branch upstream-only',
      });
      expect(runGit(['branch', '--show-current'], repo.featurePath)).toBe('upstream-only');
      expect(runGit(['rev-parse', '--abbrev-ref', '@{upstream}'], repo.featurePath)).toBe(
        'upstream/upstream-only'
      );
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  it('merges remote workspace branches over SSH with origin fallback', async () => {
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(null, { stdout: 'status=success\nmessage=Merged main successfully\n', stderr: '' });
    });
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    const backend = {
      kind: 'ssh' as const,
      hostId: 'ssh-dev',
      remoteDirectory: '/home/devuser/.komla/worktrees/komla/clear-sage',
      remoteRepoPath: '/home/devuser/.komla/repos/komla/repo.git',
      remoteProjectRoot: '/home/devuser/.komla/worktrees/komla',
      gitUrl: 'https://github.com/komla-dev/komla.git',
      projectName: 'komla',
      branchName: 'clear-sage',
      baseBranch: 'main',
    };

    const result = await sshWorkspaceGit.mergeFrom(backend, 'main', { stash: true });

    const remoteCommand = execFileMock.mock.calls[0][1].at(-1);
    expect(result).toEqual({ success: true, message: 'Merged main successfully' });
    expect(remoteCommand).toContain('origin/$branch');
    expect(remoteCommand).toContain('git merge "$ref"');
    expect(remoteCommand).toContain('komla-auto-stash-before-merge');
    expect(remoteCommand).toContain('git stash apply "$stash_sha"');
  });

  itWithPosixShell('restores its own auto-stash when another worktree of the repo stashes meanwhile', async () => {
    const repo = createTargetBranchTestRepo();
    const targetPath = join(repo.root, 'worktrees', 'main');
    runGit(['--git-dir', repo.remoteRepoPath, 'worktree', 'add', targetPath, 'main']);
    writeFileSync(join(targetPath, 'main.txt'), 'main\n');
    runGit(['add', 'main.txt'], targetPath);
    runGit(['commit', '-m', 'main change'], targetPath);
    const otherPath = join(repo.root, 'worktrees', 'other');
    runGit(['--git-dir', repo.remoteRepoPath, 'worktree', 'add', '-b', 'other', otherPath, 'main']);
    writeFileSync(join(otherPath, 'other-dirty.txt'), 'other session\n');
    writeFileSync(join(repo.featurePath, 'dirty.txt'), 'uncommitted\n');
    // Another session stashes in its own worktree while this merge runs.
    writeFileSync(
      join(repo.remoteRepoPath, 'hooks', 'post-merge'),
      `#!/bin/sh\nunset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE\ngit -C '${otherPath}' stash push -u -m other-session >/dev/null\n`,
      { mode: 0o755 }
    );
    mockRemoteShell(repo.root);

    try {
      const result = await sshWorkspaceGit.mergeFrom(repo.backend, 'main', { stash: true });

      expect(result).toEqual({ success: true, message: 'Merged main successfully' });
      expect(existsSync(join(repo.featurePath, 'dirty.txt'))).toBe(true);
      expect(existsSync(join(repo.featurePath, 'other-dirty.txt'))).toBe(false);
      const stashes = runGit(['stash', 'list'], repo.featurePath);
      expect(stashes).toContain('other-session');
      expect(stashes).not.toContain('komla-auto-stash-before-merge');
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  itWithPosixShell('leaves an older auto-stash with the same name alone when the stash saves nothing', async () => {
    const repo = createTargetBranchTestRepo();
    const otherPath = join(repo.root, 'worktrees', 'other');
    runGit(['--git-dir', repo.remoteRepoPath, 'worktree', 'add', '-b', 'other', otherPath, 'main']);
    writeFileSync(join(otherPath, 'other-dirty.txt'), 'earlier run\n');
    writeFileSync(join(repo.featurePath, 'dirty.txt'), 'uncommitted\n');
    // An earlier run whose process ID this run reuses kept its stash, and this run's stash push
    // saves nothing (say, only a dirty submodule changed).
    const binPath = join(repo.root, 'bin');
    const gitPath = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    mkdirSync(binPath, { recursive: true });
    writeFileSync(
      join(binPath, 'git'),
      [
        '#!/bin/sh',
        `if [ "$1" = diff ]; then ${gitPath} -C '${otherPath}' stash push -u -m "komla-auto-stash-before-merge-$PPID" >/dev/null; fi`,
        'if [ "$1" = stash ] && [ "$2" = push ]; then echo "No local changes to save"; exit 0; fi',
        `exec ${gitPath} "$@"`,
        '',
      ].join('\n'),
      { mode: 0o755 }
    );
    mockRemoteShell(repo.root, binPath);

    try {
      const result = await sshWorkspaceGit.mergeFrom(repo.backend, 'main', { stash: true });

      expect(result.success).toBe(true);
      expect(existsSync(join(repo.featurePath, 'other-dirty.txt'))).toBe(false);
      expect(runGit(['stash', 'list'], repo.featurePath)).toContain(
        'komla-auto-stash-before-merge'
      );
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  itWithPosixShell('reports remote merge conflicts clearly after safely aborting', async () => {
    const repo = createTargetBranchTestRepo();
    createBranchConflict(repo);
    mockRemoteShell(repo.root);

    try {
      const { sshWorkspaceService } =
        await import('../../../src/main/services/ssh-workspace.service');

      const result = await sshWorkspaceGit.mergeFrom(repo.backend, 'main');

      expect(result).toEqual({
        success: false,
        message: 'Merge from main encountered conflicts in shared.txt. The merge was aborted.',
      });
      expect(runGit(['status', '--porcelain'], repo.featurePath)).toBe('');
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  itWithPosixShell('leaves an active remote merge and auto-stash untouched when abort fails', async () => {
    const repo = createTargetBranchTestRepo();
    createBranchConflict(repo);
    writeFileSync(join(repo.featurePath, 'dirty.txt'), 'uncommitted\n');
    mockRemoteShell(repo.root, createFailingGitAbortShim(repo.root, 'merge'));

    try {
      const { sshWorkspaceService } =
        await import('../../../src/main/services/ssh-workspace.service');

      const result = await sshWorkspaceGit.mergeFrom(repo.backend, 'main', { stash: true });

      expect(result).toEqual({
        success: false,
        message:
          'Merge from main encountered conflicts in shared.txt, and Git could not abort the merge. The merge is still active; resolve or abort it manually.',
      });
      expect(runGit(['status', '--porcelain'], repo.featurePath)).toContain('UU shared.txt');
      expect(existsSync(join(repo.featurePath, 'dirty.txt'))).toBe(false);
      expect(runGit(['stash', 'list'], repo.featurePath)).toContain(
        'komla-auto-stash-before-merge'
      );
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  itWithPosixShell('reports remote rebase conflicts clearly after safely aborting', async () => {
    const repo = createTargetBranchTestRepo();
    createBranchConflict(repo);
    mockRemoteShell(repo.root);

    try {
      const { sshWorkspaceService } =
        await import('../../../src/main/services/ssh-workspace.service');

      const result = await sshWorkspaceGit.rebaseOnBranch(repo.backend, 'main');

      expect(execFileMock.mock.calls.at(-1)?.[1]).toContain('ControlPersist=600');
      expect(result).toEqual({
        success: false,
        message: 'Rebase onto main encountered conflicts in shared.txt. The rebase was aborted.',
      });
      expect(runGit(['status', '--porcelain'], repo.featurePath)).toBe('');
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  function pushTwoTargetCommits(repo: ReturnType<typeof createTargetBranchTestRepo>): void {
    for (const name of ['remote-one', 'remote-two']) {
      writeFileSync(join(repo.seedPath, `${name}.txt`), `${name}\n`);
      runGit(['add', `${name}.txt`], repo.seedPath);
      runGit(['commit', '-m', name], repo.seedPath);
    }
    runGit(['push', 'origin', 'main'], repo.seedPath);
    runGit(['--git-dir', repo.remoteRepoPath, 'fetch', 'origin', '--prune']);
  }

  async function installCompanion(
    repo: ReturnType<typeof createTargetBranchTestRepo>,
    install: (path: string) => Promise<string>
  ) {
    const companion = writeCompanionStub(repo.root, "printf 'origin/main\\n'");
    const { remoteCompanionService } =
      await import('../../../src/main/services/remote-companion.service');
    const ensureInstalled = vi
      .spyOn(remoteCompanionService, 'ensureInstalled')
      .mockImplementation(() => install(companion.path));
    return { callsPath: companion.callsPath, ensureInstalled };
  }

  itWithPosixShell('rebases a remote workspace onto the target ref the installed companion resolves', async () => {
    const repo = createTargetBranchTestRepo();
    pushTwoTargetCommits(repo);
    const { callsPath, ensureInstalled } = await installCompanion(repo, (path) =>
      Promise.resolve(path)
    );
    mockRemoteShell(repo.root);

    try {
      const result = await sshWorkspaceGit.rebaseOnBranch(repo.backend, 'main', {
        targetBranch: 'main',
      });

      expect(result).toEqual({ success: true, message: 'Rebased on main successfully' });
      expect(runGit(['rev-list', '--count', 'HEAD..origin/main'], repo.featurePath)).toBe('0');
      expect(readFileSync(callsPath, 'utf8')).toBe('git target sync --target main\n');
      expect(ensureInstalled).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'ssh-dev' }),
        join(repo.root, '..')
      );
    } finally {
      ensureInstalled.mockRestore();
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  itWithPosixShell('merges the target ref the installed companion resolves into a remote workspace', async () => {
    const repo = createTargetBranchTestRepo();
    pushTwoTargetCommits(repo);
    const { callsPath, ensureInstalled } = await installCompanion(repo, (path) =>
      Promise.resolve(path)
    );
    mockRemoteShell(repo.root);

    try {
      const result = await sshWorkspaceGit.mergeFrom(repo.backend, 'main', {
        targetBranch: 'main',
      });

      expect(result).toEqual({ success: true, message: 'Merged main successfully' });
      expect(runGit(['log', '-1', '--format=%s'], repo.featurePath)).toBe(
        "Merge remote-tracking branch 'origin/main' into feature"
      );
      expect(readFileSync(callsPath, 'utf8')).toBe('git target sync --target main\n');
    } finally {
      ensureInstalled.mockRestore();
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  itWithPosixShell('uses the local target as it is when the companion cannot be installed', async () => {
    const repo = createTargetBranchTestRepo();
    pushTwoTargetCommits(repo);
    const { callsPath, ensureInstalled } = await installCompanion(repo, () =>
      Promise.reject(new Error('unsupported host'))
    );
    const localTarget = runGit(['--git-dir', repo.remoteRepoPath, 'rev-parse', 'main']);
    mockRemoteShell(repo.root);

    try {
      const result = await sshWorkspaceGit.rebaseOnBranch(repo.backend, 'main', {
        targetBranch: 'main',
      });

      expect(result).toEqual({ success: true, message: 'Already up to date' });
      expect(runGit(['--git-dir', repo.remoteRepoPath, 'rev-parse', 'main'])).toBe(localTarget);
      expect(existsSync(callsPath)).toBe(false);
    } finally {
      ensureInstalled.mockRestore();
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  itWithPosixShell('does not ask the companion about a branch that is not the target', async () => {
    const repo = createTargetBranchTestRepo();
    pushTwoTargetCommits(repo);
    const { callsPath, ensureInstalled } = await installCompanion(repo, (path) =>
      Promise.resolve(path)
    );
    mockRemoteShell(repo.root);

    try {
      const result = await sshWorkspaceGit.rebaseOnBranch(repo.backend, 'main', {
        targetBranch: 'develop',
      });

      expect(result).toEqual({ success: true, message: 'Already up to date' });
      expect(ensureInstalled).not.toHaveBeenCalled();
      expect(existsSync(callsPath)).toBe(false);
    } finally {
      ensureInstalled.mockRestore();
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  itWithPosixShell('leaves an active remote rebase and auto-stash untouched when abort fails', async () => {
    const repo = createTargetBranchTestRepo();
    createBranchConflict(repo);
    writeFileSync(join(repo.featurePath, 'dirty.txt'), 'uncommitted\n');
    mockRemoteShell(repo.root, createFailingGitAbortShim(repo.root, 'rebase'));

    try {
      const { sshWorkspaceService } =
        await import('../../../src/main/services/ssh-workspace.service');

      const result = await sshWorkspaceGit.rebaseOnBranch(repo.backend, 'main', {
        stash: true,
      });

      expect(result).toEqual({
        success: false,
        message:
          'Rebase onto main encountered conflicts in shared.txt, and Git could not abort the rebase. The rebase is still active; resolve or abort it manually.',
      });
      expect(runGit(['status', '--porcelain'], repo.featurePath)).toContain('UU shared.txt');
      expect(existsSync(join(repo.featurePath, 'dirty.txt'))).toBe(false);
      expect(runGit(['stash', 'list'], repo.featurePath)).toContain(
        'komla-auto-stash-before-rebase'
      );
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  it('merges a remote workspace branch into the target branch using a helper worktree', async () => {
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(null, {
        stdout: JSON.stringify({ success: true, message: 'Fast-forwarded main to clear-sage' }),
        stderr: '',
      });
    });
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    const backend = {
      kind: 'ssh' as const,
      hostId: 'ssh-dev',
      remoteDirectory: '/home/devuser/.komla/worktrees/komla/clear-sage',
      remoteRepoPath: '/home/devuser/.komla/repos/komla/repo.git',
      remoteProjectRoot: '/home/devuser/.komla/worktrees/komla',
      gitUrl: 'https://github.com/komla-dev/komla.git',
      projectName: 'komla',
      branchName: 'clear-sage',
      baseBranch: 'main',
    };

    const result = await sshWorkspaceGit.mergeToTargetBranch(backend);

    const remoteCommand = execFileMock.mock.calls[0][1].at(-1);
    expect(result).toEqual({ success: true, message: 'Fast-forwarded main to clear-sage' });
    expect(remoteCommand).toContain('git target merge-source');
    expect(remoteCommand).toContain('/home/devuser/.komla/helpers/komla');
    expect(remoteCommand).not.toContain('target_operation_lock');
  });

  it('pushes the remote target branch using the helper worktree', async () => {
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(null, {
        stdout: JSON.stringify({ success: true, message: 'Pushed 2 commit(s) to origin' }),
        stderr: '',
      });
    });
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    const backend = {
      kind: 'ssh' as const,
      hostId: 'ssh-dev',
      remoteDirectory: '/home/devuser/.komla/worktrees/komla/clear-sage',
      remoteRepoPath: '/home/devuser/.komla/repos/komla/repo.git',
      remoteProjectRoot: '/home/devuser/.komla/worktrees/komla',
      gitUrl: 'https://github.com/komla-dev/komla.git',
      projectName: 'komla',
      branchName: 'clear-sage',
      baseBranch: 'main',
    };

    const result = await sshWorkspaceGit.pushTargetBranch(backend);

    const remoteCommand = execFileMock.mock.calls[0][1].at(-1);
    expect(result).toEqual({ success: true, message: 'Pushed 2 commit(s) to origin' });
    expect(remoteCommand).toContain('git target push');
    expect(remoteCommand).not.toContain('git -C');
  });

  it('rejects remote restore paths that escape the workspace', async () => {
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    const backend = {
      kind: 'ssh' as const,
      hostId: 'ssh-dev',
      remoteDirectory: '/home/devuser/.komla/worktrees/komla/clear-sage',
      remoteRepoPath: '/home/devuser/.komla/repos/komla/repo.git',
      remoteProjectRoot: '/home/devuser/.komla/worktrees/komla',
      gitUrl: 'https://github.com/komla-dev/komla.git',
      projectName: 'komla',
      branchName: 'clear-sage',
      baseBranch: 'main',
    };

    await expect(sshWorkspaceGit.restoreFile(backend, '../secret', 'modified')).rejects.toThrow(
      'escapes the workspace'
    );
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('discards all remote workspace changes over SSH', async () => {
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(null, { stdout: '', stderr: '' });
    });
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    const backend = {
      kind: 'ssh' as const,
      hostId: 'ssh-dev',
      remoteDirectory: '/home/devuser/.komla/worktrees/komla/clear-sage',
      remoteRepoPath: '/home/devuser/.komla/repos/komla/repo.git',
      remoteProjectRoot: '/home/devuser/.komla/worktrees/komla',
      gitUrl: 'https://github.com/komla-dev/komla.git',
      projectName: 'komla',
      branchName: 'clear-sage',
      baseBranch: 'main',
    };

    const result = await sshWorkspaceGit.discardAllChanges(backend);

    const remoteCommand = execFileMock.mock.calls[0][1].at(-1);
    expect(result.success).toBe(true);
    expect(remoteCommand).toContain('git reset --hard HEAD');
    expect(remoteCommand).toContain('git clean -fd');
  });

  it('plans SSH workspace paths without connecting to the host', async () => {
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');

    const plan = sshWorkspaceService.createWorkspacePlan({
      hostId: 'ssh-dev',
      gitUrl: 'git@github.com:komla-dev/komla.git',
      projectName: 'komla',
      branchName: 'claude/lazy-launch',
      baseBranch: 'main',
      resolvedBasePath: '/home/devuser/.komla',
    });

    expect(execFileMock).not.toHaveBeenCalled();
    expect(plan.workingDirectory).toBe(
      'ssh://ssh-dev/home/devuser/.komla/worktrees/komla/claude-lazy-launch'
    );
    expect(plan.backend).toMatchObject({
      remoteRepoPath: '/home/devuser/.komla/repos/komla/repo.git',
      remoteDirectory: '/home/devuser/.komla/worktrees/komla/claude-lazy-launch',
      gitUrl: 'git@github.com:komla-dev/komla.git',
      branchName: 'claude/lazy-launch',
      baseBranch: 'main',
    });
  });

  it('uses remote HEAD as a start point without treating it as a target branch', async () => {
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');

    const plan = sshWorkspaceService.createWorkspacePlan({
      hostId: 'ssh-dev',
      gitUrl: 'git@github.com:komla-dev/komla.git',
      projectName: 'komla',
      branchName: 'agent/remote-default',
      baseBranch: 'HEAD',
      resolvedBasePath: '/home/devuser/.komla',
    });

    expect(plan.backend.baseBranch).toBeUndefined();
    expect(plan.backend.startPoint).toBe('HEAD');
  });

  it('plans sibling workspaces with the source backend exact repository roots', async () => {
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    const sourceBackend = {
      kind: 'ssh' as const,
      hostId: 'ssh-dev',
      remoteDirectory: '/srv/custom/worktrees/source',
      remoteRepoPath: '/srv/custom/repos/exact-repo.git',
      remoteProjectRoot: '/srv/custom/worktrees',
      gitUrl: 'git@github.com:example/repo.git',
      projectName: 'Original Project',
    };

    const plan = sshWorkspaceService.createWorkspacePlan({
      hostId: 'ssh-dev',
      gitUrl: sourceBackend.gitUrl,
      projectName: 'A Newly Renamed Project',
      branchName: 'agent/sibling',
      sourceBackend,
    });

    expect(plan.backend.remoteRepoPath).toBe('/srv/custom/repos/exact-repo.git');
    expect(plan.backend.remoteProjectRoot).toBe('/srv/custom/worktrees');
    expect(plan.backend.remoteDirectory).toBe('/srv/custom/worktrees/agent-sibling');

    const setupCommand = await buildLazySetupCommand(plan.backend);
    expect(setupCommand).toContain('/srv/custom/repos/exact-repo.git.komla/.setup-lock');
    expect(setupCommand).not.toContain('exact-repo.git/.setup-lock');
  });

  it('uses readable project-name remote roots and validates identity during setup', async () => {
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');

    const first = sshWorkspaceService.createWorkspacePlan({
      hostId: 'ssh-dev',
      gitUrl: 'git@github.com:example/one.git',
      projectId: 'project-one',
      projectName: 'Shared Name',
      branchName: 'agent/one',
      baseBranch: 'main',
      resolvedBasePath: '/home/devuser/.komla',
    });
    const second = sshWorkspaceService.createWorkspacePlan({
      hostId: 'ssh-dev',
      gitUrl: 'git@github.com:example/two.git',
      projectId: 'project-two',
      projectName: 'Shared Name',
      branchName: 'agent/two',
      baseBranch: 'main',
      resolvedBasePath: '/home/devuser/.komla',
    });

    expect(first.backend.remoteRepoPath).toBe('/home/devuser/.komla/repos/Shared-Name/repo.git');
    expect(second.backend.remoteRepoPath).toBe('/home/devuser/.komla/repos/Shared-Name/repo.git');
    expect(first.backend.remoteProjectRoot).toBe('/home/devuser/.komla/worktrees/Shared-Name');
    expect(second.backend.remoteProjectRoot).toBe('/home/devuser/.komla/worktrees/Shared-Name');
  });

  itWithPosixShell('adopts an existing remote repo when the same project is re-added with a new ID', async () => {
    const root = mkdtempSync(join(tmpdir(), 'komla-ssh-readded-project-'));
    const originPath = join(root, 'origin.git');
    const seedPath = join(root, 'seed');

    try {
      runGit(['init', '--bare', originPath]);
      runGit(['clone', originPath, seedPath]);
      writeFileSync(join(seedPath, 'README.md'), 'same repository\n');
      runGit(['add', 'README.md'], seedPath);
      runGit(['commit', '-m', 'initial'], seedPath);
      runGit(['branch', '-M', 'main'], seedPath);
      runGit(['push', '-u', 'origin', 'main'], seedPath);
      runGit(['--git-dir', originPath, 'symbolic-ref', 'HEAD', 'refs/heads/main']);

      const { sshWorkspaceService } =
        await import('../../../src/main/services/ssh-workspace.service');
      const plan = sshWorkspaceService.createWorkspacePlan({
        hostId: 'ssh-dev',
        gitUrl: originPath,
        projectId: 'new-project-id',
        projectName: 'readded-project',
        branchName: 'agent/new-work',
        baseBranch: 'main',
        resolvedBasePath: join(root, '.komla'),
      });
      const projectRepoRoot = join(plan.backend.remoteRepoPath, '..');
      mkdirSync(projectRepoRoot, { recursive: true });
      runGit(['clone', '--bare', originPath, plan.backend.remoteRepoPath]);
      writeFileSync(join(projectRepoRoot, '.project-id'), 'old-project-id\n');

      const setupCommand = await buildLazySetupCommand(plan.backend);
      execFileSync('/bin/sh', ['-c', setupCommand], { encoding: 'utf8' });

      expect(readFileSync(join(projectRepoRoot, '.project-id'), 'utf8')).toBe('new-project-id\n');
      expect(existsSync(plan.backend.remoteDirectory)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  itWithPosixShell('adopts an existing HTTPS remote after Komla converts the same repository to SSH', async () => {
    const root = mkdtempSync(join(tmpdir(), 'komla-ssh-readded-protocol-'));
    const binPath = join(root, 'bin');

    try {
      const { sshWorkspaceService } =
        await import('../../../src/main/services/ssh-workspace.service');
      const plan = sshWorkspaceService.createWorkspacePlan({
        hostId: 'ssh-dev',
        gitUrl: 'git@github.com:komla-dev/komla.git',
        projectId: 'new-project-id',
        projectName: 'readded-protocol',
        branchName: 'agent/new-work',
        baseBranch: 'main',
        resolvedBasePath: join(root, '.komla'),
      });
      mkdirSync(join(plan.backend.remoteRepoPath, '..'), { recursive: true });
      runGit(['init', '--bare', plan.backend.remoteRepoPath]);
      runGit(
        ['config', 'remote.origin.url', 'https://github.com/komla-dev/komla.git'],
        plan.backend.remoteRepoPath
      );
      mkdirSync(plan.backend.remoteDirectory, { recursive: true });
      runGit(['init'], plan.backend.remoteDirectory);
      runGit(['symbolic-ref', 'HEAD', 'refs/heads/agent/new-work'], plan.backend.remoteDirectory);
      mkdirSync(binPath);
      const realGit = execFileSync('sh', ['-lc', 'command -v git'], { encoding: 'utf8' }).trim();
      writeFileSync(
        join(binPath, 'git'),
        [
          '#!/bin/sh',
          'case " $* " in',
          '  *" ls-remote "*) exit 0 ;;',
          'esac',
          `exec ${JSON.stringify(realGit)} "$@"`,
        ].join('\n'),
        { mode: 0o755 }
      );

      const setupCommand = await buildLazySetupCommand(plan.backend);
      expect(() =>
        execFileSync('/bin/sh', ['-c', setupCommand], {
          encoding: 'utf8',
          env: { ...process.env, PATH: `${binPath}:${process.env.PATH ?? ''}` },
        })
      ).not.toThrow();
      expect(
        runGit(['config', '--get', 'remote.origin.url'], plan.backend.remoteRepoPath).trim()
      ).toBe('git@github.com:komla-dev/komla.git');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  itWithPosixShell('ignores HTTPS credentials when adopting the same hosted repository', async () => {
    const root = mkdtempSync(join(tmpdir(), 'komla-ssh-readded-credentials-'));
    const binPath = join(root, 'bin');

    try {
      const { sshWorkspaceService } =
        await import('../../../src/main/services/ssh-workspace.service');
      const plan = sshWorkspaceService.createWorkspacePlan({
        hostId: 'ssh-dev',
        gitUrl: 'git@gitlab.com:team/repo.git',
        projectId: 'new-project-id',
        projectName: 'readded-credentials',
        branchName: 'agent/new-work',
        baseBranch: 'main',
        resolvedBasePath: join(root, '.komla'),
      });
      mkdirSync(join(plan.backend.remoteRepoPath, '..'), { recursive: true });
      runGit(['init', '--bare', plan.backend.remoteRepoPath]);
      runGit(
        ['config', 'remote.origin.url', 'https://old-token@gitlab.com/team/repo.git'],
        plan.backend.remoteRepoPath
      );
      mkdirSync(plan.backend.remoteDirectory, { recursive: true });
      runGit(['init'], plan.backend.remoteDirectory);
      runGit(['symbolic-ref', 'HEAD', 'refs/heads/agent/new-work'], plan.backend.remoteDirectory);
      mkdirSync(binPath);
      const realGit = execFileSync('sh', ['-lc', 'command -v git'], { encoding: 'utf8' }).trim();
      writeFileSync(
        join(binPath, 'git'),
        [
          '#!/bin/sh',
          'case " $* " in',
          '  *" ls-remote "*) exit 0 ;;',
          'esac',
          `exec ${JSON.stringify(realGit)} "$@"`,
        ].join('\n'),
        { mode: 0o755 }
      );

      const setupCommand = await buildLazySetupCommand(plan.backend);
      expect(() =>
        execFileSync('/bin/sh', ['-c', setupCommand], {
          encoding: 'utf8',
          env: { ...process.env, PATH: `${binPath}:${process.env.PATH ?? ''}` },
        })
      ).not.toThrow();
      expect(
        runGit(['config', '--get', 'remote.origin.url'], plan.backend.remoteRepoPath).trim()
      ).toBe('git@gitlab.com:team/repo.git');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== 'win32')(
    'validates an adopted transport before replacing the shared origin',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'komla-ssh-adoption-validation-'));
      const binPath = join(root, 'bin');
      const realGit = execFileSync('sh', ['-lc', 'command -v git'], { encoding: 'utf8' }).trim();

      try {
        const { sshWorkspaceService } =
          await import('../../../src/main/services/ssh-workspace.service');
        const plan = sshWorkspaceService.createWorkspacePlan({
          hostId: 'ssh-dev',
          gitUrl: 'git@github.com:komla-dev/komla.git',
          projectId: 'new-project-id',
          projectName: 'invalid-transport-adoption',
          branchName: 'agent/new-work',
          baseBranch: 'main',
          resolvedBasePath: join(root, '.komla'),
        });
        mkdirSync(join(plan.backend.remoteRepoPath, '..'), { recursive: true });
        runGit(['init', '--bare', plan.backend.remoteRepoPath]);
        runGit(
          ['config', 'remote.origin.url', 'https://github.com/komla-dev/komla.git'],
          plan.backend.remoteRepoPath
        );
        mkdirSync(plan.backend.remoteDirectory, { recursive: true });
        mkdirSync(binPath);
        writeFileSync(
          join(binPath, 'git'),
          [
            '#!/bin/sh',
            'case " $* " in',
            '  *" ls-remote "*) exit 72 ;;',
            'esac',
            `exec ${JSON.stringify(realGit)} "$@"`,
          ].join('\n'),
          { mode: 0o755 }
        );

        const setupCommand = await buildLazySetupCommand(plan.backend);
        const result = spawnSync('/bin/sh', ['-c', setupCommand], {
          encoding: 'utf8',
          env: { ...process.env, PATH: `${binPath}:${process.env.PATH ?? ''}` },
        });

        expect(result.status).not.toBe(0);
        expect(
          runGit(['config', '--get', 'remote.origin.url'], plan.backend.remoteRepoPath).trim()
        ).toBe('https://github.com/komla-dev/komla.git');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it.runIf(process.platform !== 'win32')(
    'restores the shared origin when fetching an adopted transport fails',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'komla-ssh-adoption-fetch-failure-'));
      const binPath = join(root, 'bin');
      const realGit = execFileSync('sh', ['-lc', 'command -v git'], { encoding: 'utf8' }).trim();

      try {
        const { sshWorkspaceService } =
          await import('../../../src/main/services/ssh-workspace.service');
        const plan = sshWorkspaceService.createWorkspacePlan({
          hostId: 'ssh-dev',
          gitUrl: 'git@github.com:komla-dev/komla.git',
          projectId: 'new-project-id',
          projectName: 'failed-transport-adoption',
          branchName: 'agent/new-work',
          baseBranch: 'main',
          resolvedBasePath: join(root, '.komla'),
        });
        mkdirSync(join(plan.backend.remoteRepoPath, '..'), { recursive: true });
        runGit(['init', '--bare', plan.backend.remoteRepoPath]);
        runGit(
          ['config', 'remote.origin.url', 'https://github.com/komla-dev/komla.git'],
          plan.backend.remoteRepoPath
        );
        mkdirSync(binPath);
        const gitWrapper = join(binPath, 'git');
        writeFileSync(
          gitWrapper,
          [
            '#!/bin/sh',
            'case " $* " in',
            '  *" ls-remote "*) exit 0 ;;',
            '  *" fetch origin "*) exit 71 ;;',
            'esac',
            `exec ${JSON.stringify(realGit)} "$@"`,
          ].join('\n'),
          { mode: 0o755 }
        );

        const setupCommand = await buildLazySetupCommand(plan.backend);
        const result = spawnSync('/bin/sh', ['-c', setupCommand], {
          encoding: 'utf8',
          env: { ...process.env, PATH: `${binPath}:${process.env.PATH ?? ''}` },
        });

        expect(result.status).not.toBe(0);
        expect(
          runGit(['config', '--get', 'remote.origin.url'], plan.backend.remoteRepoPath).trim()
        ).toBe('https://github.com/komla-dev/komla.git');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  );

  itWithPosixShell('does not adopt a generic SSH remote owned by a different username', async () => {
    const root = mkdtempSync(join(tmpdir(), 'komla-ssh-username-collision-'));

    try {
      const { sshWorkspaceService } =
        await import('../../../src/main/services/ssh-workspace.service');
      const plan = sshWorkspaceService.createWorkspacePlan({
        hostId: 'ssh-dev',
        gitUrl: 'bob@example.com:repo.git',
        projectId: 'new-project-id',
        projectName: 'username-collision',
        branchName: 'agent/new-work',
        baseBranch: 'main',
        resolvedBasePath: join(root, '.komla'),
      });
      const projectRepoRoot = join(plan.backend.remoteRepoPath, '..');
      mkdirSync(projectRepoRoot, { recursive: true });
      runGit(['init', '--bare', plan.backend.remoteRepoPath]);
      runGit(
        ['config', 'remote.origin.url', 'alice@example.com:repo.git'],
        plan.backend.remoteRepoPath
      );
      mkdirSync(plan.backend.remoteDirectory, { recursive: true });

      const setupCommand = await buildLazySetupCommand(plan.backend);
      const result = spawnSync('/bin/sh', ['-c', setupCommand], { encoding: 'utf8' });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('remote project name collides with a different Git repo');
      expect(
        runGit(['config', '--get', 'remote.origin.url'], plan.backend.remoteRepoPath).trim()
      ).toBe('alice@example.com:repo.git');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  itWithPosixShell('refuses a Git URL that git would read as an option', async () => {
    const root = mkdtempSync(join(tmpdir(), 'komla-ssh-dash-url-'));

    try {
      const { sshWorkspaceService } =
        await import('../../../src/main/services/ssh-workspace.service');
      const plan = sshWorkspaceService.createWorkspacePlan({
        hostId: 'ssh-dev',
        gitUrl: '--bare',
        projectId: 'dash-project-id',
        projectName: 'dash-url',
        branchName: 'agent/new-work',
        baseBranch: 'main',
        resolvedBasePath: join(root, '.komla'),
      });

      const setupCommand = await buildLazySetupCommand(plan.backend);
      const result = spawnSync('/bin/sh', ['-c', setupCommand], { encoding: 'utf8' });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`a Git URL can't start with "-"`);
      expect(existsSync(plan.backend.remoteRepoPath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  itWithPosixShell('does not adopt a distinct generic repository whose path differs only by .git', async () => {
    const root = mkdtempSync(join(tmpdir(), 'komla-ssh-dot-git-collision-'));
    const firstOriginPath = join(root, 'origin');
    const secondOriginPath = join(root, 'origin.git');

    try {
      runGit(['init', '--bare', firstOriginPath]);
      runGit(['init', '--bare', secondOriginPath]);

      const { sshWorkspaceService } =
        await import('../../../src/main/services/ssh-workspace.service');
      const plan = sshWorkspaceService.createWorkspacePlan({
        hostId: 'ssh-dev',
        gitUrl: secondOriginPath,
        projectId: 'new-project-id',
        projectName: 'dot-git-collision',
        branchName: 'agent/new-work',
        baseBranch: 'main',
        resolvedBasePath: join(root, '.komla'),
      });
      mkdirSync(join(plan.backend.remoteRepoPath, '..'), { recursive: true });
      runGit(['clone', '--bare', firstOriginPath, plan.backend.remoteRepoPath]);

      const setupCommand = await buildLazySetupCommand(plan.backend);
      const result = spawnSync('/bin/sh', ['-c', setupCommand], { encoding: 'utf8' });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('remote project name collides with a different Git repo');
      expect(
        runGit(['config', '--get', 'remote.origin.url'], plan.backend.remoteRepoPath).trim()
      ).toBe(firstOriginPath);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  itWithPosixShell('does not adopt an existing remote project directory for a different Git repo', async () => {
    const root = mkdtempSync(join(tmpdir(), 'komla-ssh-project-collision-'));
    const firstOriginPath = join(root, 'first-origin.git');
    const secondOriginPath = join(root, 'second-origin.git');

    try {
      runGit(['init', '--bare', firstOriginPath]);
      runGit(['init', '--bare', secondOriginPath]);

      const { sshWorkspaceService } =
        await import('../../../src/main/services/ssh-workspace.service');
      const plan = sshWorkspaceService.createWorkspacePlan({
        hostId: 'ssh-dev',
        gitUrl: secondOriginPath,
        projectId: 'new-project-id',
        projectName: 'colliding-project',
        branchName: 'agent/new-work',
        baseBranch: 'main',
        resolvedBasePath: join(root, '.komla'),
      });
      const projectRepoRoot = join(plan.backend.remoteRepoPath, '..');
      mkdirSync(projectRepoRoot, { recursive: true });
      runGit(['clone', '--bare', firstOriginPath, plan.backend.remoteRepoPath]);
      writeFileSync(join(projectRepoRoot, '.project-id'), 'old-project-id\n');

      const setupCommand = await buildLazySetupCommand(plan.backend);
      const result = spawnSync('/bin/sh', ['-c', setupCommand], { encoding: 'utf8' });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('remote project name collides with a different Git repo');
      expect(readFileSync(join(projectRepoRoot, '.project-id'), 'utf8')).toBe('old-project-id\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses a numeric fallback for branch names with the same readable slug', async () => {
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');

    const slashBranch = sshWorkspaceService.createWorkspacePlan({
      hostId: 'ssh-dev',
      gitUrl: 'git@github.com:example/repo.git',
      projectName: 'repo',
      branchName: 'feature/foo',
      resolvedBasePath: '/home/devuser/.komla',
    });
    const dashBranch = sshWorkspaceService.createWorkspacePlan({
      hostId: 'ssh-dev',
      gitUrl: 'git@github.com:example/repo.git',
      projectName: 'repo',
      branchName: 'feature-foo',
      resolvedBasePath: '/home/devuser/.komla',
    });

    expect(slashBranch.backend.remoteDirectory.endsWith('/feature-foo')).toBe(true);
    expect(dashBranch.backend.remoteDirectory.endsWith('/feature-foo')).toBe(true);
    expect(
      sshWorkspaceService.withRemoteDirectoryAttempt(dashBranch.backend, 2).remoteDirectory
    ).toBe('/home/devuser/.komla/worktrees/repo/feature-foo-2');

    const setupCommand = await buildLazySetupCommand(slashBranch.backend);
    expect(setupCommand).toContain('symbolic-ref --quiet --short HEAD');
    expect(setupCommand).toContain('remote worktree path belongs to a different branch');
    expect(setupCommand).toContain('feature/foo');
  });

  it('keeps SSH target branch separate from the worktree start point', async () => {
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');

    const plan = sshWorkspaceService.createWorkspacePlan({
      hostId: 'ssh-dev',
      gitUrl: 'git@github.com:komla-dev/komla.git',
      projectId: 'project-1',
      projectName: 'komla',
      branchName: 'agent/release-fix',
      baseBranch: 'main',
      startPoint: 'origin/release',
      resolvedBasePath: '/home/devuser/.komla',
    });
    const command = sshWorkspaceService.buildTerminalCommand(
      plan.backend,
      'codex',
      'term-a',
      undefined,
      'start'
    );
    const setupCommand = await buildLazySetupCommand(plan.backend);

    expect(setupCommand).toContain(
      "export GIT_SSH_COMMAND='ssh -o StrictHostKeyChecking=accept-new'"
    );
    expect(plan.backend.baseBranch).toBe('main');
    expect(plan.backend.startPoint).toBe('origin/release');
    expect(command).toContain('KOMLA_TARGET_BRANCH=');
    expect(command).toContain('main');
    expect(setupCommand).toContain('worktree add --no-track -b');
    expect(setupCommand).toContain('agent/release-fix');
    expect(setupCommand).toContain('/home/devuser/.komla/repos/komla/.project-id');
    expect(setupCommand).toContain('remote project name collides with a different Git repo');
    expect(setupCommand).toContain('origin/release');
  });

  it('reads branch status through the installed Komla CLI snapshot', async () => {
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    const run = vi.spyOn(sshWorkspaceService, 'run').mockResolvedValue(
      JSON.stringify({
        statusB64: '',
        numstatB64: '',
        statusTooLarge: false,
        branch: {
          currentBranch: 'feature',
          targetBranch: 'main',
          defaultBranch: 'trunk',
          aheadTargetBranch: 1,
          behindTargetBranch: 0,
          hasRemote: false,
          hasOriginRemote: true,
          unpushedCommits: 0,
          behindRemote: 0,
          targetBranchHasRemote: true,
          targetBranchAheadRemote: 0,
          targetBranchBehindRemote: 0,
        },
      })
    );
    const backend: SshWorkspaceBackend = {
      kind: 'ssh',
      hostId: 'ssh-dev',
      remoteDirectory: '/home/devuser/.komla/worktrees/project/feature',
      remoteRepoPath: '/home/devuser/.komla/repos/project/repo.git',
      remoteProjectRoot: '/home/devuser/.komla/worktrees/project',
      gitUrl: 'git@example.com:project.git',
      baseBranch: 'main',
    };

    const status = await sshWorkspaceGit.getBranchQuickStatus(backend, 'main');

    expect(status).toMatchObject({
      currentBranch: 'feature',
      defaultBranch: 'trunk',
      aheadTargetBranch: 1,
    });
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'ssh-dev' }),
      "'/home/devuser/.komla/helpers/komla' git snapshot -C '/home/devuser/.komla/worktrees/project/feature' --target 'main'"
    );
    run.mockRestore();
  });

  it('rejects an invalid Komla CLI snapshot', async () => {
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    const run = vi.spyOn(sshWorkspaceService, 'run').mockResolvedValue(
      JSON.stringify({
        statusB64: '',
        numstatB64: '',
        statusTooLarge: false,
        branch: {
          currentBranch: 'feature',
          targetBranch: 'main',
          aheadTargetBranch: -1,
          behindTargetBranch: 0,
          hasRemote: false,
          hasOriginRemote: true,
          unpushedCommits: 0,
          behindRemote: 0,
          targetBranchHasRemote: true,
          targetBranchAheadRemote: 0,
          targetBranchBehindRemote: 0,
        },
      })
    );
    const backend: SshWorkspaceBackend = {
      kind: 'ssh',
      hostId: 'ssh-dev',
      remoteDirectory: '/home/devuser/.komla/worktrees/project/feature',
      remoteRepoPath: '/home/devuser/.komla/repos/project/repo.git',
      remoteProjectRoot: '/home/devuser/.komla/worktrees/project',
      gitUrl: 'git@example.com:project.git',
    };

    await expect(sshWorkspaceGit.getSnapshot(backend, 'main')).rejects.toThrow();
    run.mockRestore();
  });

  itWithPosixShell('pulls the published feature branch when its legacy upstream is origin/main', async () => {
    const repo = createTargetBranchTestRepo();

    try {
      runGit(['push', 'origin', 'feature'], repo.featurePath);
      runGit(['fetch', 'origin'], repo.seedPath);
      runGit(['switch', '--track', 'origin/feature'], repo.seedPath);
      writeFileSync(join(repo.seedPath, 'remote-feature.txt'), 'remote feature\n');
      runGit(['add', 'remote-feature.txt'], repo.seedPath);
      runGit(['commit', '-m', 'remote feature'], repo.seedPath);
      runGit(['push', 'origin', 'feature'], repo.seedPath);
      runGit(['fetch', 'origin'], repo.featurePath);
      runGit(['branch', '--set-upstream-to=origin/main', 'feature'], repo.featurePath);
      mockRemoteShell(repo.root);
      const result = await sshWorkspaceGit.pull(repo.backend);

      expect(result.success).toBe(true);
      expect(runGit(['rev-parse', 'feature'], repo.featurePath)).toBe(
        runGit(['rev-parse', 'origin/feature'], repo.featurePath)
      );
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  function divergeFeatureFromOrigin(
    repo: ReturnType<typeof createTargetBranchTestRepo>,
    remoteFile: string
  ): void {
    runGit(['push', 'origin', 'feature'], repo.featurePath);
    runGit(['fetch', 'origin'], repo.seedPath);
    runGit(['switch', '--track', 'origin/feature'], repo.seedPath);
    writeFileSync(join(repo.seedPath, remoteFile), 'remote change\n');
    runGit(['add', remoteFile], repo.seedPath);
    runGit(['commit', '-m', 'remote change'], repo.seedPath);
    runGit(['push', 'origin', 'feature'], repo.seedPath);
    writeFileSync(join(repo.featurePath, 'shared.txt'), 'local change\n');
    runGit(['commit', '-am', 'local change'], repo.featurePath);
    // Pull merges like a local pull does, whatever the host's own pull settings say.
    runGit(['config', 'pull.rebase', 'true'], repo.featurePath);
    runGit(['config', 'pull.ff', 'true'], repo.featurePath);
  }

  itWithPosixShell('merges a diverged branch on pull, like a local pull', async () => {
    const repo = createTargetBranchTestRepo();

    try {
      divergeFeatureFromOrigin(repo, 'remote.txt');
      mockRemoteShell(repo.root);

      const result = await sshWorkspaceGit.pull(repo.backend);

      expect(result).toEqual({ success: true, message: 'Pulled from origin' });
      const parents = runGit(['rev-list', '--parents', '-n', '1', 'HEAD'], repo.featurePath);
      expect(parents.split(' ')).toHaveLength(3);
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  itWithPosixShell('reports the whole pull failure, not the fetch line Git prints first', async () => {
    const repo = createTargetBranchTestRepo();
    const hooksPath = join(repo.root, 'hooks');

    try {
      divergeFeatureFromOrigin(repo, 'remote.txt');
      mkdirSync(hooksPath);
      const hook = '#!/bin/sh\necho "blocked by hook"\nexit 1\n';
      writeFileSync(join(hooksPath, 'pre-merge-commit'), hook, { mode: 0o755 });
      runGit(['config', 'core.hooksPath', hooksPath], repo.featurePath);
      mockRemoteShell(repo.root);

      const result = await sshWorkspaceGit.pull(repo.backend);

      expect(result.success).toBe(false);
      expect(result.message).toContain('blocked by hook');
      expect(result.message).not.toMatch(/^From /m);
      expect(result.message).not.toContain('FETCH_HEAD');
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  itWithPosixShell('leaves a conflicted pull merge in place and names the files, like a local pull', async () => {
    const repo = createTargetBranchTestRepo();

    try {
      divergeFeatureFromOrigin(repo, 'shared.txt');
      mockRemoteShell(repo.root);

      const result = await sshWorkspaceGit.pull(repo.backend);

      expect(result).toEqual({
        success: false,
        message:
          'Pull paused because shared.txt has conflicts. Resolve the conflicts in this workspace, then complete the merge.',
      });
      expect(runGit(['rev-parse', '--verify', 'MERGE_HEAD'], repo.featurePath)).toBe(
        runGit(['rev-parse', 'origin/feature'], repo.featurePath)
      );
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  it('checks out an existing branch instead of rejecting it', async () => {
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');

    const plan = sshWorkspaceService.createWorkspacePlan({
      hostId: 'ssh-dev',
      gitUrl: 'git@github.com:komla-dev/komla.git',
      projectName: 'komla',
      branchName: 'feature/existing',
      baseBranch: 'main',
      checkoutExistingBranch: true,
      resolvedBasePath: '/home/devuser/.komla',
    });
    const setupCommand = await buildLazySetupCommand(plan.backend);

    expect(plan.backend.checkoutExistingBranch).toBe(true);
    expect(setupCommand).toContain('refs/heads/feature/existing');
    expect(setupCommand).toContain('refs/remotes/origin/feature/existing');
    expect(setupCommand).not.toContain('update-ref');
    expect(setupCommand).toContain('merge --ff-only "$origin_branch"');
    expect(setupCommand).toContain('branch --set-upstream-to=');
    expect(setupCommand).toContain('worktree add');
    expect(setupCommand).toContain('selected branch is not available on the SSH host');
    expect(setupCommand).not.toContain('selected starting revision is no longer available');
    expect(setupCommand).not.toContain('__KOMLA_SSH_BRANCH_ALREADY_EXISTS__');
  });

  itWithPosixShell('creates a remote worktree for an existing origin branch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'komla-ssh-existing-'));
    const originPath = join(root, 'origin.git');
    const seedPath = join(root, 'seed');

    try {
      runGit(['init', '--bare', originPath]);
      runGit(['clone', originPath, seedPath]);
      writeFileSync(join(seedPath, 'shared.txt'), 'initial\n');
      runGit(['add', 'shared.txt'], seedPath);
      runGit(['commit', '-m', 'initial'], seedPath);
      runGit(['branch', '-M', 'main'], seedPath);
      runGit(['push', '-u', 'origin', 'main'], seedPath);
      runGit(['checkout', '-b', 'feature/existing'], seedPath);
      writeFileSync(join(seedPath, 'feature.txt'), 'existing branch\n');
      runGit(['add', 'feature.txt'], seedPath);
      runGit(['commit', '-m', 'feature'], seedPath);
      runGit(['push', '-u', 'origin', 'feature/existing'], seedPath);
      runGit(['--git-dir', originPath, 'symbolic-ref', 'HEAD', 'refs/heads/main']);

      const { sshWorkspaceService } =
        await import('../../../src/main/services/ssh-workspace.service');
      const plan = sshWorkspaceService.createWorkspacePlan({
        hostId: 'ssh-dev',
        gitUrl: originPath,
        projectName: 'existing-project',
        branchName: 'feature/existing',
        baseBranch: 'deleted-base',
        checkoutExistingBranch: true,
        resolvedBasePath: join(root, '.komla'),
      });
      const setupCommand = await buildLazySetupCommand(plan.backend);

      const output = execFileSync('/bin/sh', ['-c', setupCommand], { encoding: 'utf8' });

      expect(output).not.toContain('__KOMLA_SSH_WORKSPACE_BRANCH_CREATED__');
      expect(output).toContain('__KOMLA_SSH_WORKSPACE_WORKTREE_CREATED__');
      expect(runGit(['branch', '--show-current'], plan.backend.remoteDirectory)).toBe(
        'feature/existing'
      );
      expect(
        runGit(
          ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
          plan.backend.remoteDirectory
        )
      ).toBe('origin/feature/existing');
      expect(readFileSync(join(plan.backend.remoteDirectory, 'feature.txt'), 'utf8')).toBe(
        'existing branch\n'
      );
      writeFileSync(join(plan.backend.remoteDirectory, 'pushed.txt'), 'plain push\n');
      runGit(['add', 'pushed.txt'], plan.backend.remoteDirectory);
      runGit(['commit', '-m', 'plain push'], plan.backend.remoteDirectory);
      runGit(['push'], plan.backend.remoteDirectory);
      expect(runGit(['show', 'feature/existing:pushed.txt'], originPath)).toBe('plain push');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  itWithPosixShell('checks a branch out again after its remote worktree directory was removed by hand', async () => {
    const root = mkdtempSync(join(tmpdir(), 'komla-ssh-existing-pruned-'));
    const originPath = join(root, 'origin.git');
    const seedPath = join(root, 'seed');

    try {
      runGit(['init', '--bare', originPath]);
      runGit(['clone', originPath, seedPath]);
      writeFileSync(join(seedPath, 'feature.txt'), 'initial\n');
      runGit(['add', 'feature.txt'], seedPath);
      runGit(['commit', '-m', 'initial'], seedPath);
      runGit(['branch', '-M', 'feature/existing'], seedPath);
      runGit(['push', '-u', 'origin', 'feature/existing'], seedPath);
      runGit(['--git-dir', originPath, 'symbolic-ref', 'HEAD', 'refs/heads/feature/existing']);

      const { sshWorkspaceService } =
        await import('../../../src/main/services/ssh-workspace.service');
      const plan = sshWorkspaceService.createWorkspacePlan({
        hostId: 'ssh-dev',
        gitUrl: originPath,
        projectName: 'pruned-project',
        branchName: 'feature/existing',
        checkoutExistingBranch: true,
        resolvedBasePath: join(root, '.komla'),
      });
      const setupCommand = await buildLazySetupCommand(plan.backend);
      execFileSync('/bin/sh', ['-c', setupCommand], { encoding: 'utf8', stdio: 'pipe' });
      rmSync(plan.backend.remoteDirectory, { recursive: true, force: true });

      execFileSync('/bin/sh', ['-c', setupCommand], { encoding: 'utf8', stdio: 'pipe' });

      expect(runGit(['branch', '--show-current'], plan.backend.remoteDirectory)).toBe(
        'feature/existing'
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  itWithPosixShell('fast-forwards a stale local branch after checking it out', async () => {
    const root = mkdtempSync(join(tmpdir(), 'komla-ssh-existing-stale-'));
    const originPath = join(root, 'origin.git');
    const seedPath = join(root, 'seed');

    try {
      runGit(['init', '--bare', originPath]);
      runGit(['clone', originPath, seedPath]);
      writeFileSync(join(seedPath, 'feature.txt'), 'initial\n');
      runGit(['add', 'feature.txt'], seedPath);
      runGit(['commit', '-m', 'initial'], seedPath);
      runGit(['branch', '-M', 'feature/existing'], seedPath);
      runGit(['push', '-u', 'origin', 'feature/existing'], seedPath);
      runGit(['--git-dir', originPath, 'symbolic-ref', 'HEAD', 'refs/heads/feature/existing']);

      const { sshWorkspaceService } =
        await import('../../../src/main/services/ssh-workspace.service');
      const plan = sshWorkspaceService.createWorkspacePlan({
        hostId: 'ssh-dev',
        gitUrl: originPath,
        projectName: 'stale-existing-project',
        branchName: 'feature/existing',
        baseBranch: 'feature/existing',
        checkoutExistingBranch: true,
        resolvedBasePath: join(root, '.komla'),
      });

      mkdirSync(join(plan.backend.remoteRepoPath, '..'), { recursive: true });
      runGit(['clone', '--bare', originPath, plan.backend.remoteRepoPath]);

      writeFileSync(join(seedPath, 'feature.txt'), 'latest\n');
      runGit(['add', 'feature.txt'], seedPath);
      runGit(['commit', '-m', 'latest'], seedPath);
      runGit(['push', 'origin', 'feature/existing'], seedPath);

      const setupCommand = await buildLazySetupCommand(plan.backend);
      execFileSync('/bin/sh', ['-c', setupCommand], { encoding: 'utf8' });

      expect(readFileSync(join(plan.backend.remoteDirectory, 'feature.txt'), 'utf8')).toBe(
        'latest\n'
      );
      expect(
        runGit(['rev-parse', 'refs/heads/feature/existing'], plan.backend.remoteRepoPath)
      ).toBe(
        runGit(['rev-parse', 'refs/remotes/origin/feature/existing'], plan.backend.remoteRepoPath)
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  itWithPosixShell('does not move an existing branch that another worktree has checked out', async () => {
    const root = mkdtempSync(join(tmpdir(), 'komla-ssh-existing-busy-'));
    const originPath = join(root, 'origin.git');
    const seedPath = join(root, 'seed');
    const otherPath = join(root, 'other');

    try {
      runGit(['init', '--bare', originPath]);
      runGit(['clone', originPath, seedPath]);
      writeFileSync(join(seedPath, 'feature.txt'), 'initial\n');
      runGit(['add', 'feature.txt'], seedPath);
      runGit(['commit', '-m', 'initial'], seedPath);
      runGit(['branch', '-M', 'feature/existing'], seedPath);
      runGit(['push', '-u', 'origin', 'feature/existing'], seedPath);
      runGit(['--git-dir', originPath, 'symbolic-ref', 'HEAD', 'refs/heads/feature/existing']);

      const { sshWorkspaceService } =
        await import('../../../src/main/services/ssh-workspace.service');
      const plan = sshWorkspaceService.createWorkspacePlan({
        hostId: 'ssh-dev',
        gitUrl: originPath,
        projectName: 'busy-existing-project',
        branchName: 'feature/existing',
        baseBranch: 'feature/existing',
        checkoutExistingBranch: true,
        resolvedBasePath: join(root, '.komla'),
      });

      mkdirSync(join(plan.backend.remoteRepoPath, '..'), { recursive: true });
      runGit(['clone', '--bare', originPath, plan.backend.remoteRepoPath]);
      runGit(['worktree', 'add', otherPath, 'feature/existing'], plan.backend.remoteRepoPath);
      const otherHead = runGit(['rev-parse', 'HEAD'], otherPath);

      writeFileSync(join(seedPath, 'feature.txt'), 'latest\n');
      runGit(['add', 'feature.txt'], seedPath);
      runGit(['commit', '-m', 'latest'], seedPath);
      runGit(['push', 'origin', 'feature/existing'], seedPath);

      const setupCommand = await buildLazySetupCommand(plan.backend);
      expect(() =>
        execFileSync('/bin/sh', ['-c', setupCommand], { encoding: 'utf8', stdio: 'pipe' })
      ).toThrow();

      expect(runGit(['rev-parse', 'HEAD'], otherPath)).toBe(otherHead);
      expect(runGit(['status', '--porcelain'], otherPath)).toBe('');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  itWithPosixShell('starts a target-based SSH workspace from the ref the companion resolves', async () => {
    const root = mkdtempSync(join(tmpdir(), 'komla-ssh-companion-start-'));
    const originPath = join(root, 'origin.git');
    const seedPath = join(root, 'seed');

    try {
      runGit(['init', '--bare', originPath]);
      runGit(['clone', originPath, seedPath]);
      writeFileSync(join(seedPath, 'shared.txt'), 'initial\n');
      runGit(['add', 'shared.txt'], seedPath);
      runGit(['commit', '-m', 'initial'], seedPath);
      runGit(['branch', '-M', 'main'], seedPath);
      runGit(['push', '-u', 'origin', 'main'], seedPath);
      runGit(['--git-dir', originPath, 'symbolic-ref', 'HEAD', 'refs/heads/main']);

      const { sshWorkspaceService } =
        await import('../../../src/main/services/ssh-workspace.service');
      const plan = sshWorkspaceService.createWorkspacePlan({
        hostId: 'ssh-dev',
        gitUrl: originPath,
        projectName: 'companion-start-project',
        branchName: 'agent/new-work',
        baseBranch: 'main',
        startPoint: 'main',
        resolvedBasePath: join(root, '.komla'),
      });

      mkdirSync(join(plan.backend.remoteRepoPath, '..'), { recursive: true });
      runGit(['clone', '--bare', originPath, plan.backend.remoteRepoPath]);
      const localMain = runGit(['rev-parse', 'main'], plan.backend.remoteRepoPath);

      writeFileSync(join(seedPath, 'shared.txt'), 'latest\n');
      runGit(['commit', '-am', 'latest'], seedPath);
      runGit(['push', 'origin', 'main'], seedPath);

      const companion = writeCompanionStub(root, "printf 'main\\n'");
      const setupCommand = await buildLazySetupCommand(plan.backend, companion.path);
      execFileSync('/bin/sh', ['-c', setupCommand], { encoding: 'utf8' });

      expect(readFileSync(companion.callsPath, 'utf8')).toBe(
        `git target sync -C ${plan.backend.remoteRepoPath} --target main\n`
      );
      expect(runGit(['rev-parse', 'HEAD'], plan.backend.remoteDirectory)).toBe(localMain);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('asks for the companion during setup only when a new branch starts from the target', async () => {
    execFileMock.mockImplementation((_file, _args, _options, callback) =>
      captureSshStringInput(() => callback(null, '', ''))
    );
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    const companion = vi.fn(() => Promise.resolve('/home/devuser/.komla/helpers/bin/komla'));
    const existing = sshWorkspaceService.createWorkspacePlan({
      hostId: 'ssh-dev',
      gitUrl: 'git@github.com:komla-dev/komla.git',
      projectName: 'komla',
      branchName: 'feature/existing',
      baseBranch: 'main',
      checkoutExistingBranch: true,
      resolvedBasePath: '/home/devuser/.komla',
    });
    const fromTarget = sshWorkspaceService.createWorkspacePlan({
      hostId: 'ssh-dev',
      gitUrl: 'git@github.com:komla-dev/komla.git',
      projectName: 'komla',
      branchName: 'agent/new-work',
      baseBranch: 'main',
      startPoint: 'main',
      resolvedBasePath: '/home/devuser/.komla',
    });

    await sshWorkspaceService.ensureWorkspaceReady(existing.backend, companion);
    expect(companion).not.toHaveBeenCalled();
    expect(sshStringInputs.at(-1)).not.toContain('git target sync');

    await sshWorkspaceService.ensureWorkspaceReady(fromTarget.backend, companion);
    expect(companion).toHaveBeenCalledTimes(1);
    expect(sshStringInputs.at(-1)).toContain(
      "'/home/devuser/.komla/helpers/bin/komla' git target sync"
    );
  });

  it('starts target-based SSH workspaces from the freshest non-conflicting target ref', async () => {
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');

    const plan = sshWorkspaceService.createWorkspacePlan({
      hostId: 'ssh-dev',
      gitUrl: 'git@github.com:komla-dev/komla.git',
      projectName: 'komla',
      branchName: 'agent/new-work',
      baseBranch: 'main',
      startPoint: 'main',
      resolvedBasePath: '/home/devuser/.komla',
    });
    const setupCommand = await buildLazySetupCommand(plan.backend);

    expect(setupCommand).toContain("start_ref='main'");
    expect(setupCommand).toContain("merge-base --is-ancestor 'main' 'origin/main'");
    expect(setupCommand).toContain("start_ref='origin/main'");
    expect(setupCommand).toContain('worktree add --no-track -b');
    expect(setupCommand).toContain('"$start_ref"');
  });

  it('checks for an existing remote branch before worktree creation', async () => {
    const marker = '__KOMLA_SSH_BRANCH_ALREADY_EXISTS__';
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      return captureSshStringInput(() => {
        callback(Object.assign(new Error('remote command failed'), { stderr: marker }), '', marker);
      });
    });
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    const plan = sshWorkspaceService.createWorkspacePlan({
      hostId: 'ssh-dev',
      gitUrl: 'git@github.com:komla-dev/komla.git',
      projectName: 'komla',
      branchName: 'agent/existing',
      baseBranch: 'main',
      resolvedBasePath: '/home/devuser/.komla',
    });

    await expect(sshWorkspaceService.ensureWorkspaceReady(plan.backend)).rejects.toMatchObject({
      code: 'SSH_BRANCH_ALREADY_EXISTS',
      message: 'Branch "agent/existing" already exists on the SSH host.',
    });

    const remoteCommand = sshStringInputs[0];
    expect(remoteCommand).toContain('worktree add --no-track -b');
    expect(remoteCommand).toContain(marker);
    const branchCheckIndex = remoteCommand?.indexOf('show-ref --verify --quiet') ?? -1;
    const worktreeAddIndex = remoteCommand?.indexOf('worktree add --no-track -b') ?? -1;
    expect(branchCheckIndex).toBeGreaterThan(-1);
    expect(branchCheckIndex).toBeLessThan(worktreeAddIndex);
    expect(remoteCommand?.slice(worktreeAddIndex)).toContain('show-ref --verify --quiet');
    expect(remoteCommand?.slice(worktreeAddIndex)).toContain(marker);
  });

  it('reports whether this setup invocation created the workspace branch and worktree', async () => {
    const branchMarker = '__KOMLA_SSH_WORKSPACE_BRANCH_CREATED__';
    const worktreeMarker = '__KOMLA_SSH_WORKSPACE_WORKTREE_CREATED__';
    execFileMock
      .mockImplementationOnce((_file, _args, _options, callback) => {
        return captureSshStringInput(() => {
          callback(null, `${branchMarker}\n${worktreeMarker}\n`, '');
        });
      })
      .mockImplementationOnce((_file, _args, _options, callback) => {
        return captureSshStringInput(() => callback(null, '', ''));
      });
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    const plan = sshWorkspaceService.createWorkspacePlan({
      hostId: 'ssh-dev',
      gitUrl: 'git@github.com:komla-dev/komla.git',
      projectName: 'komla',
      branchName: 'agent/new-work',
      baseBranch: 'main',
      resolvedBasePath: '/home/devuser/.komla',
    });

    await expect(sshWorkspaceService.ensureWorkspaceReady(plan.backend)).resolves.toEqual({
      createdBranch: true,
      createdWorktree: true,
    });
    await expect(sshWorkspaceService.ensureWorkspaceReady(plan.backend)).resolves.toEqual({
      createdBranch: false,
      createdWorktree: false,
    });

    const remoteCommand = sshStringInputs[0];
    expect(remoteCommand).toContain(branchMarker);
    expect(remoteCommand).toContain(worktreeMarker);
  });

  it('streams workspace provisioning with default interactive SSH connection reuse', async () => {
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    const { sshConnectionService } =
      await import('../../../src/main/services/ssh-connection.service');
    const runWithInput = vi
      .spyOn(sshConnectionService, 'runWithInput')
      .mockImplementation(async () => '' as never);
    const plan = sshWorkspaceService.createWorkspacePlan({
      hostId: 'ssh-agent',
      gitUrl: 'git@github.com:komla-dev/komla.git',
      projectName: 'komla',
      branchName: 'agent/new-work',
      baseBranch: 'main',
      resolvedBasePath: '/home/dev/.komla',
    });

    try {
      await sshWorkspaceService.ensureWorkspaceReady(plan.backend);

      expect(runWithInput).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'ssh-agent' }),
        'sh -s',
        expect.stringContaining('creating remote worktree'),
        {
          purpose: { kind: 'interactive' },
        }
      );
      expect(execFileMock).not.toHaveBeenCalled();
    } finally {
      runWithInput.mockRestore();
    }
  });

  it('reports the concrete remote default branch when the target is unresolved', async () => {
    const targetMarker = '__KOMLA_SSH_WORKSPACE_TARGET__=';
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      return captureSshStringInput(() => callback(null, `${targetMarker}master\n`, ''));
    });
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    const plan = sshWorkspaceService.createWorkspacePlan({
      hostId: 'ssh-dev',
      gitUrl: 'git@github.com:komla-dev/komla.git',
      projectName: 'komla',
      branchName: 'agent/new-work',
      resolvedBasePath: '/home/devuser/.komla',
    });

    await expect(sshWorkspaceService.ensureWorkspaceReady(plan.backend)).resolves.toEqual({
      createdBranch: false,
      createdWorktree: false,
      baseBranch: 'master',
      defaultBranch: 'master',
    });

    const remoteCommand = sshStringInputs[0];
    expect(remoteCommand).toContain(targetMarker);
  });

  it('reports the remote default branch alongside an explicit target', async () => {
    const targetMarker = '__KOMLA_SSH_WORKSPACE_TARGET__=';
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      return captureSshStringInput(() => callback(null, `${targetMarker}master\n`, ''));
    });
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    const plan = sshWorkspaceService.createWorkspacePlan({
      hostId: 'ssh-dev',
      gitUrl: 'git@github.com:komla-dev/komla.git',
      projectName: 'komla',
      branchName: 'agent/new-work',
      baseBranch: 'release',
      resolvedBasePath: '/home/devuser/.komla',
    });

    await expect(sshWorkspaceService.ensureWorkspaceReady(plan.backend)).resolves.toEqual({
      createdBranch: false,
      createdWorktree: false,
      defaultBranch: 'master',
    });

    const remoteCommand = sshStringInputs[0];
    expect(remoteCommand).toContain(targetMarker);
  });

  itWithPosixShell('keeps an existing SSH worktree usable when origin is unavailable', async () => {
    const repo = createTargetBranchTestRepo();

    try {
      mockRemoteShell(repo.root);
      rmSync(repo.originPath, { recursive: true, force: true });
      const { sshWorkspaceService } =
        await import('../../../src/main/services/ssh-workspace.service');

      await expect(sshWorkspaceService.ensureWorkspaceReady(repo.backend)).resolves.toEqual({
        createdBranch: false,
        createdWorktree: false,
      });
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  // Runs the remote commands in a real POSIX shell standing in for the SSH host.
  describe.skipIf(process.platform === 'win32')('managed repo layout on the host', () => {
    let root: string;
    let originPath: string;
    let base: string;
    let repoLink: string;
    let movedRepoPath: string;

    beforeEach(() => {
      root = realpathSync(mkdtempSync(join(tmpdir(), 'komla-ssh-dot-git-')));
      originPath = join(root, 'origin.git');
      const seedPath = join(root, 'seed');
      base = join(root, '.komla');
      repoLink = join(base, 'repos', 'app', 'repo.git');
      movedRepoPath = join(base, 'repos', 'app', '.git');
      runGit(['init', '--bare', '-b', 'main', originPath]);
      runGit(['clone', originPath, seedPath]);
      writeFileSync(join(seedPath, 'shared.txt'), 'initial\n');
      runGit(['add', 'shared.txt'], seedPath);
      runGit(['commit', '-m', 'initial'], seedPath);
      runGit(['push', '-u', 'origin', 'HEAD:main'], seedPath);
      mockRemoteShell(root);
    });

    afterEach(() => {
      rmSync(root, { recursive: true, force: true });
    });

    const setUp = async (branchName: string) => {
      const { sshWorkspaceService } =
        await import('../../../src/main/services/ssh-workspace.service');
      const plan = sshWorkspaceService.createWorkspacePlan({
        hostId: 'ssh-dev',
        gitUrl: originPath,
        projectName: 'app',
        branchName,
        baseBranch: 'main',
        resolvedBasePath: base,
      });
      expect(plan.backend.remoteRepoPath).toBe(repoLink);
      await sshWorkspaceService.ensureWorkspaceReady(plan.backend);
      return plan.backend.remoteDirectory;
    };

    it('keeps a new repo at .git with repo.git linking to it', async () => {
      const worktree = await setUp('feature/new');

      expect(readlinkSync(repoLink)).toBe('.git');
      expect(lstatSync(movedRepoPath).isDirectory()).toBe(true);
      expect(runGit(['rev-parse', '--git-common-dir'], worktree)).toBe(movedRepoPath);
    });
  });

  itWithPosixShell('reports a clear error when the remote default branch cannot be resolved', async () => {
    const root = mkdtempSync(join(tmpdir(), 'komla-ssh-missing-default-'));
    const originPath = join(root, 'origin.git');

    try {
      runGit(['init', '--bare', originPath]);
      mockRemoteShell(root);
      const { sshWorkspaceService } =
        await import('../../../src/main/services/ssh-workspace.service');
      const plan = sshWorkspaceService.createWorkspacePlan({
        hostId: 'ssh-dev',
        gitUrl: originPath,
        projectName: 'missing-default',
        branchName: 'feature/new',
        resolvedBasePath: join(root, '.komla'),
      });

      await expect(sshWorkspaceService.ensureWorkspaceReady(plan.backend)).rejects.toThrow(
        'Could not determine the remote default branch'
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  itWithPosixShell('refreshes a cached bare repository after the remote default branch is renamed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'komla-ssh-default-rename-'));
    const originPath = join(root, 'origin.git');
    const seedPath = join(root, 'seed');

    try {
      runGit(['init', '--bare', originPath]);
      runGit(['clone', originPath, seedPath]);
      writeFileSync(join(seedPath, 'shared.txt'), 'initial\n');
      runGit(['add', 'shared.txt'], seedPath);
      runGit(['commit', '-m', 'initial'], seedPath);
      runGit(['branch', '-M', 'main'], seedPath);
      runGit(['push', '-u', 'origin', 'main'], seedPath);
      runGit(['--git-dir', originPath, 'symbolic-ref', 'HEAD', 'refs/heads/main']);

      mockRemoteShell(root);
      const { sshWorkspaceService } =
        await import('../../../src/main/services/ssh-workspace.service');
      const firstPlan = sshWorkspaceService.createWorkspacePlan({
        hostId: 'ssh-dev',
        gitUrl: originPath,
        projectName: 'default-rename',
        branchName: 'feature/first',
        resolvedBasePath: join(root, '.komla'),
      });

      await expect(
        sshWorkspaceService.ensureWorkspaceReady(firstPlan.backend)
      ).resolves.toMatchObject({ baseBranch: 'main' });

      runGit(['branch', '-m', 'main', 'trunk'], seedPath);
      runGit(['push', '-u', 'origin', 'trunk'], seedPath);
      runGit(['--git-dir', originPath, 'symbolic-ref', 'HEAD', 'refs/heads/trunk']);
      runGit(['push', 'origin', '--delete', 'main'], seedPath);

      const siblingPlan = sshWorkspaceService.createWorkspacePlan({
        hostId: 'ssh-dev',
        gitUrl: originPath,
        projectName: 'default-rename',
        branchName: 'feature/second',
        sourceBackend: firstPlan.backend,
      });

      await expect(
        sshWorkspaceService.ensureWorkspaceReady(siblingPlan.backend)
      ).resolves.toMatchObject({ baseBranch: 'trunk' });
      expect(runGit(['rev-parse', 'HEAD'], siblingPlan.backend.remoteDirectory)).toBe(
        runGit(['rev-parse', 'refs/heads/trunk'], originPath)
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not treat a marker embedded in the failed SSH command as remote output', async () => {
    const branchMarker = '__KOMLA_SSH_BRANCH_ALREADY_EXISTS__';
    const pathMarker = '__KOMLA_SSH_WORKTREE_PATH_CONFLICT__';
    const checkoutError = Object.assign(
      new Error(
        `Command failed: ssh dev.example.com 'printf ${branchMarker}; printf ${pathMarker}'`
      ),
      { stderr: 'fatal: could not create work tree dir: Permission denied' }
    );
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      return captureSshStringInput(() => callback(checkoutError, '', checkoutError.stderr));
    });
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    const plan = sshWorkspaceService.createWorkspacePlan({
      hostId: 'ssh-dev',
      gitUrl: 'git@github.com:komla-dev/komla.git',
      projectName: 'komla',
      branchName: 'agent/new-work',
      baseBranch: 'main',
      resolvedBasePath: '/home/devuser/.komla',
    });

    await expect(sshWorkspaceService.ensureWorkspaceReady(plan.backend)).rejects.toThrow(
      'fatal: could not create work tree dir: Permission denied'
    );
  });

  it('shows a concise setup error without the generated SSH command', async () => {
    const stderr = [
      '\u001b[31m[komla] remote project name collides with a different Git repo\u001b[0m',
      'path: /home/dev/.komla/repos/komla',
    ].join('\n');
    const setupError = Object.assign(
      new Error("Command failed: ssh dev.example.com sh -lc 'set -e; generated setup script'"),
      { stderr }
    );
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      return captureSshStringInput(() => callback(setupError, '', stderr));
    });
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    const plan = sshWorkspaceService.createWorkspacePlan({
      hostId: 'ssh-dev',
      gitUrl: 'git@github.com:komla-dev/komla.git',
      projectName: 'komla',
      branchName: 'agent/new-work',
      baseBranch: 'main',
      resolvedBasePath: '/home/devuser/.komla',
    });

    await expect(sshWorkspaceService.ensureWorkspaceReady(plan.backend)).rejects.toMatchObject({
      message: 'Remote project name collides with a different Git repo.',
    });
  });

  it('classifies an exact remote worktree path conflict marker', async () => {
    const marker = '__KOMLA_SSH_WORKTREE_PATH_CONFLICT__';
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      return captureSshStringInput(() => {
        callback(Object.assign(new Error('remote command failed'), { stderr: marker }), '', marker);
      });
    });
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    const plan = sshWorkspaceService.createWorkspacePlan({
      hostId: 'ssh-dev',
      gitUrl: 'git@github.com:komla-dev/komla.git',
      projectName: 'komla',
      branchName: 'agent/path-conflict',
      baseBranch: 'main',
      resolvedBasePath: '/home/devuser/.komla',
    });

    await expect(sshWorkspaceService.ensureWorkspaceReady(plan.backend)).rejects.toMatchObject({
      code: 'SSH_WORKTREE_PATH_CONFLICT',
      message: 'Remote worktree path belongs to a different branch.',
    });
  });

  it('explains remote Git SSH authentication failures when agent forwarding is disabled', async () => {
    const stderr = [
      'git@github.com: Permission denied (publickey).',
      'fatal: Could not read from remote repository.',
    ].join('\n');
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(
        Object.assign(new Error('Command failed: ssh with generated setup script'), { stderr }),
        '',
        stderr
      );
      return captureSshStringInput();
    });
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    const plan = sshWorkspaceService.createWorkspacePlan({
      hostId: 'ssh-dev',
      gitUrl: 'git@github.com:komla-dev/komla.git',
      projectName: 'komla',
      branchName: 'agent/auth-failure',
      resolvedBasePath: '/home/devuser/.komla',
    });

    await expect(sshWorkspaceService.ensureWorkspaceReady(plan.backend)).rejects.toMatchObject({
      code: 'SSH_GIT_AUTH_FAILED',
      message: expect.stringContaining('Enable "Forward SSH agent"'),
    });
  });

  it('explains remote Git host key verification failures', async () => {
    const stderr = [
      'Host key verification failed.',
      'fatal: Could not read from remote repository.',
    ].join('\n');
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(
        Object.assign(new Error('Command failed: ssh with generated setup script'), { stderr }),
        '',
        stderr
      );
      return captureSshStringInput();
    });
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    const plan = sshWorkspaceService.createWorkspacePlan({
      hostId: 'ssh-agent',
      gitUrl: 'git@github.com:komla-dev/komla.git',
      projectName: 'komla',
      branchName: 'agent/host-key-failure',
      resolvedBasePath: '/home/dev/.komla',
    });

    await expect(sshWorkspaceService.ensureWorkspaceReady(plan.backend)).rejects.toMatchObject({
      code: 'SSH_GIT_HOST_KEY_VERIFICATION_FAILED',
      message: expect.stringContaining('could not verify the Git remote'),
    });
  });

  it('explains remote Git SSH authentication failures when forwarded keys are unavailable', async () => {
    const stderr = [
      'git@github.com: Permission denied (publickey).',
      'fatal: Could not read from remote repository.',
    ].join('\n');
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(Object.assign(new Error('remote command failed'), { stderr }), '', stderr);
      return captureSshStringInput();
    });
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    const plan = sshWorkspaceService.createWorkspacePlan({
      hostId: 'ssh-agent',
      gitUrl: 'git@github.com:komla-dev/komla.git',
      projectName: 'komla',
      branchName: 'agent/forwarded-auth-failure',
      resolvedBasePath: '/home/dev/.komla',
    });

    await expect(sshWorkspaceService.ensureWorkspaceReady(plan.backend)).rejects.toMatchObject({
      code: 'SSH_GIT_AUTH_FAILED',
      message: expect.stringContaining('SSH agent forwarding is enabled'),
    });
  });

  it('plans SSH workspace paths from a resolved remote base path when the host user is blank', async () => {
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');

    const plan = sshWorkspaceService.createWorkspacePlan({
      hostId: 'ssh-custom-home',
      gitUrl: 'git@github.com:komla-dev/komla.git',
      projectName: 'komla',
      branchName: 'claude/remote-home',
      baseBranch: 'main',
      resolvedBasePath: '/var/lib/dev/.komla',
    });

    expect(execFileMock).not.toHaveBeenCalled();
    expect(plan.workingDirectory).toBe(
      'ssh://ssh-custom-home/var/lib/dev/.komla/worktrees/komla/claude-remote-home'
    );
    expect(plan.backend).toMatchObject({
      remoteRepoPath: '/var/lib/dev/.komla/repos/komla/repo.git',
      remoteDirectory: '/var/lib/dev/.komla/worktrees/komla/claude-remote-home',
    });

    const command = sshWorkspaceService.buildTerminalCommand(
      plan.backend,
      null,
      'term-custom-home',
      undefined,
      'start'
    );
    expect(command).not.toContain('/var/lib/dev/.komla/helpers/terminal.sh');
    expect(command).toContain('KOMLA_REMOTE_WORKSPACE_DIR=');
    expect(command).toContain('/var/lib/dev/.komla/worktrees/komla/claude-remote-home');
    expect(command).not.toContain('/home/');
  });

  it('allows a deferred plan for an SSH-config user before the remote home is resolved', async () => {
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');

    const plan = sshWorkspaceService.createWorkspacePlan({
      hostId: 'ssh-unconfigured',
      gitUrl: 'git@github.com:komla-dev/komla.git',
      projectName: 'komla',
      branchName: 'claude/deferred-home',
    });

    expect(execFileMock).not.toHaveBeenCalled();
    expect(plan.backend.remoteDirectory).toBe('~/.komla/worktrees/komla/claude-deferred-home');
  });

  it('uses SSH clone URLs for forwarded-agent hosts with GitHub HTTPS remotes', async () => {
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');

    const plan = sshWorkspaceService.createWorkspacePlan({
      hostId: 'ssh-agent',
      gitUrl: 'https://github.com/komla-dev/komla.git',
      projectName: 'komla',
      branchName: 'claude/forwarded-agent',
      baseBranch: 'main',
    });

    expect(execFileMock).not.toHaveBeenCalled();
    expect(plan.backend.gitUrl).toBe('git@github.com:komla-dev/komla.git');
  });

  it('returns an SSH terminal launch without connection metadata output', async () => {
    // A Windows client launches ssh from PowerShell, without exec; see the Windows terminal tests.
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    const backend = {
      kind: 'ssh' as const,
      hostId: 'ssh-dev',
      remoteDirectory: '/home/devuser/.komla/worktrees/komla/claude-onyx-grove',
      remoteRepoPath: '/home/devuser/.komla/repos/komla/repo.git',
      remoteProjectRoot: '/home/devuser/.komla/worktrees/komla',
      gitUrl: 'https://github.com/komla-dev/komla.git',
      projectName: 'komla',
    };

    const launch = sshWorkspaceService.buildTerminalLaunchCommand(
      backend,
      'codex "hello"',
      'term-a',
      undefined,
      'start'
    );

    expect(launch.command).toContain('ssh');
    expect(launch.command).toContain('exec ssh');
    expect(launch.command).not.toContain('host=%s');
    expect(launch.command).not.toContain('/home/devuser/.komla/helpers/terminal.sh');
    expect(launch.command).toContain('/home/devuser/.komla/helpers/notify.sh');
    expect(launch.command).toContain('COLORTERM=');
    expect(launch.command).toContain('truecolor');
    expect(launch.command).toContain('FORCE_HYPERLINK=');
    expect(launch.command).not.toContain('TERM_PROGRAM=');
    expect(launch).not.toHaveProperty('displayCommand');
  });

  it('routes hooks through the companion mailbox', async () => {
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    const companion = {
      installationKey: 'install-key',
      tmuxSocket: 'komla-companion-install-key',
      sessionName: 'komla-companion-install-key',
      hookInbox: '/home/devuser/.komla/helpers/companion/install-key/inbox',
    };

    const launch = sshWorkspaceService.buildTerminalLaunchCommand(
      {
        kind: 'ssh',
        hostId: 'ssh-dev',
        remoteDirectory: '/home/devuser/.komla/worktrees/komla/true-grass',
        remoteRepoPath: '/home/devuser/.komla/repos/komla/repo.git',
        remoteProjectRoot: '/home/devuser/.komla/worktrees/komla',
        gitUrl: 'https://github.com/komla-dev/komla.git',
        projectName: 'komla',
      },
      'codex',
      'term-remote',
      'ws-remote',
      'start',
      { companion }
    );

    expect(launch.command).toContain('KOMLA_COMPANION_INBOX=');
    expect(launch.command).toContain(companion.hookInbox);
    expect(launch.command).toContain('KOMLA_CLI=');
    expect(launch.command).toContain('/home/devuser/.komla/helpers/komla');
    expect(launch.command).toContain('KOMLA_COMPANION_SESSION=');
    expect(launch.command).toContain(companion.sessionName);
    expect(launch.command).toContain('KOMLA_COMPANION_TMUX_SOCKET=');
    expect(launch.command).toContain(companion.tmuxSocket);
  });

  it('does not expose connection metadata when reconnecting', async () => {
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    const launch = sshWorkspaceService.buildTerminalLaunchCommand(
      {
        kind: 'ssh',
        hostId: 'ssh-dev',
        remoteDirectory: '/home/devuser/.komla/worktrees/komla/true-grass',
        remoteRepoPath: '/home/devuser/.komla/repos/komla/repo.git',
        remoteProjectRoot: '/home/devuser/.komla/worktrees/komla',
        gitUrl: 'https://github.com/komla-dev/komla.git',
        projectName: 'komla',
      },
      null,
      'term-remote',
      'ws-remote',
      'reconnect'
    );

    expect(launch).not.toHaveProperty('displayCommand');
  });

  it('verifies and prepares a host before workspace creation', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    execFileMock.mockImplementation((file, _args, _options, callback) => {
      if (file === 'scp') {
        callback(null, { stdout: '', stderr: '' });
        return;
      }

      const sshCall = execFileMock.mock.calls.filter((call) => call[0] === 'ssh').length;
      if (sshCall === 1) {
        callback(null, { stdout: '/home/devuser/.komla\n', stderr: '' });
        return;
      }
      if (sshCall === 2) {
        callback(null, { stdout: 'git version 2.43.0\n', stderr: '' });
        return;
      }
      if (sshCall === 3) {
        callback(null, { stdout: 'userName=Tordrt\nuserEmail=devuser@example.com\n', stderr: '' });
        return;
      }
      if (sshCall === 4) {
        callback(null, { stdout: 'status=available\nversion=tmux 3.4\n', stderr: '' });
        return;
      }
      if (sshCall === 5) {
        callback(null, {
          stdout: 'rsyncStatus=available\nmonitoringStatus=available\n',
          stderr: '',
        });
        return;
      }
      callback(null, { stdout: '', stderr: '' });
    });

    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');

    const result = await sshWorkspaceService.verifyAndPrepareHost({
      id: 'ssh-dev',
      name: 'Devbox',
      hostname: '203.0.113.20',
      user: 'devuser',
      basePath: '/home/devuser/~/.komla',
    });

    expect(result).toEqual({
      ok: true,
      prepared: true,
      resolvedBasePath: '/home/devuser/.komla',
      notifyScriptPath: '/home/devuser/.komla/helpers/notify.sh',
      git: { status: 'available', version: 'git version 2.43.0' },
      localMirror: {
        platform: 'supported',
        localRsync: 'available',
        remoteRsync: 'available',
      },
      tmux: {
        status: 'available',
        version: 'tmux 3.4',
      },
      monitoring: {
        status: 'available',
        missingRequirements: [],
      },
      gitIdentity: {
        configured: true,
        userName: 'Tordrt',
        userEmail: 'devuser@example.com',
      },
    });
    const notifyWrite = execFileMock.mock.calls.find(
      (call) =>
        call[0] === 'ssh' &&
        String((call[1] as string[]).at(-1)).includes('cat >') &&
        String((call[1] as string[]).at(-1)).includes('/home/devuser/.komla/helpers/notify.sh')
    );
    expect(notifyWrite?.[1]).toEqual(
      expect.arrayContaining(['ControlMaster=auto', expect.stringMatching(/^ControlPath=/)])
    );
    expect(execFileMock.mock.calls.some((call) => call[0] === 'scp')).toBe(false);
    const layoutCall = execFileMock.mock.calls.find(
      (call) => call[0] === 'ssh' && String((call[1] as string[]).at(-1)).includes('.komla-managed')
    );
    expect(layoutCall).toBeDefined();
  });

  itWithPosixShell.each([
    ['a home-relative path', '~/.komla-test', (home: string) => `${home}/.komla-test`],
    ['an absolute path', '__ABSOLUTE__', (_home: string, absolute: string) => absolute],
  ])('resolves %s with the real remote shell script', async (_name, configured, expectedPath) => {
    const tempPath = mkdtempSync(join(tmpdir(), 'komla-ssh-base-path-'));
    const remoteHome = realpathSync(tempPath);
    const absolutePath = `${remoteHome}/absolute-komla`;
    mockRemoteShell(remoteHome);

    try {
      const basePath = configured === '__ABSOLUTE__' ? absolutePath : configured;
      const resolved = await resolveRemoteBasePathForTest(basePath);

      expect(resolved).toBe(expectedPath(remoteHome, absolutePath));
    } finally {
      rmSync(tempPath, { recursive: true, force: true });
    }
  });

  itWithPosixShell('resolves a bare tilde to home before rejecting it as an unsafe base path', async () => {
    const tempPath = mkdtempSync(join(tmpdir(), 'komla-ssh-home-path-'));
    const remoteHome = realpathSync(tempPath);
    mockRemoteShell(remoteHome);

    try {
      await expect(resolveRemoteBasePathForTest('~')).rejects.toThrow();

      const firstCall = execFileMock.mock.calls[0];
      if (!firstCall) throw new Error('Expected the remote resolution command to run');
      const resolutionCommand = String((firstCall[1] as string[]).at(-1));
      expect(resolutionCommand).toContain('"~") resolved="$HOME"');
      expect(resolutionCommand).toContain('[ "$resolved" = "$home_real" ]');
    } finally {
      rmSync(tempPath, { recursive: true, force: true });
    }
  });

  it('reports missing Git without preparing or changing the remote host', async () => {
    execFileMock.mockImplementation((file, args, _options, callback) => {
      if (file === 'rsync') {
        callback(null, { stdout: 'rsync version 3.2.7\n', stderr: '' });
        return;
      }
      const command = String((args as string[]).at(-1));
      const stdout = command.includes('probe_real=')
        ? '/home/dev/.komla\n'
        : command.includes('command -v git')
          ? 'status=missing\n'
          : command.includes('command -v tmux')
            ? 'status=missing\n'
            : command.includes('command -v rsync')
              ? 'rsyncStatus=available\nmonitoringStatus=available\n'
              : '';
      callback(null, { stdout, stderr: '' });
    });

    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    const host = {
      id: 'ssh-no-git',
      name: 'No Git',
      hostname: 'no-git.example.com',
      basePath: '~/.komla',
    };

    await expect(sshWorkspaceService.checkHostCapabilities(host)).resolves.toMatchObject({
      prepared: false,
      git: { status: 'missing' },
      tmux: { status: 'missing' },
    });
    await expect(sshWorkspaceService.verifyAndPrepareHost(host)).resolves.toMatchObject({
      prepared: false,
      git: { status: 'missing' },
    });

    expect(
      execFileMock.mock.calls.some(
        (call) =>
          call[0] === 'ssh' && String((call[1] as string[]).at(-1)).includes('.komla-managed')
      )
    ).toBe(false);
  });

  it('reports missing remote monitoring tools without preparing the host', async () => {
    execFileMock.mockImplementation((file, args, _options, callback) => {
      if (file === 'rsync') {
        callback(null, { stdout: 'rsync version 3.2.7\n', stderr: '' });
        return;
      }
      const command = String((args as string[]).at(-1));
      const stdout = command.includes('probe_real=')
        ? '/home/dev/.komla\n'
        : command.includes('command -v git')
          ? 'status=available\nversion=git version 2.43.0\n'
          : command.includes('name="$(git config --global')
            ? 'userName=Dev\nuserEmail=dev@example.com\n'
            : command.includes('command -v tmux')
              ? 'status=available\nversion=tmux 3.4\n'
              : command.includes('for tool in awk')
                ? 'rsyncStatus=available\nmonitoringStatus=missing\nrequirements=readlink,curl or wget\n'
                : '';
      callback(null, { stdout, stderr: '' });
    });

    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    const host = {
      id: 'ssh-missing-monitoring',
      name: 'Minimal host',
      hostname: 'minimal.example.com',
      basePath: '~/.komla',
    };

    await expect(sshWorkspaceService.verifyAndPrepareHost(host)).resolves.toMatchObject({
      prepared: false,
      monitoring: {
        status: 'missing',
        missingRequirements: ['readlink', 'curl or wget'],
      },
    });
    expect(
      execFileMock.mock.calls.some((call) =>
        String((call[1] as string[]).at(-1)).includes(
          'for tool in awk cat head mkdir mv readlink rm sed sleep tr wc xargs'
        )
      )
    ).toBe(true);
    expect(
      execFileMock.mock.calls.some((call) =>
        String((call[1] as string[]).at(-1)).includes('.komla-managed')
      )
    ).toBe(false);
  });

  it('checks only the remote global Git identity', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const remoteCommands: string[] = [];
    execFileMock.mockImplementation((file, args, _options, callback) => {
      if (file === 'git') {
        const key = (args as string[]).at(-1);
        callback(null, {
          stdout: key === 'user.name' ? 'Local Name\n' : 'local@example.com\n',
          stderr: '',
        });
        return;
      }
      if (file === 'rsync') {
        callback(null, { stdout: 'rsync version 3.2.7\n', stderr: '' });
        return;
      }
      const command = String((args as string[]).at(-1));
      remoteCommands.push(command);
      const stdout = command.includes('probe_real=')
        ? '/home/dev/.komla\n'
        : command.includes('command -v git')
          ? 'status=available\nversion=git version 2.43.0\n'
          : command.includes('name="$(git config --global')
            ? 'userName=\nuserEmail=\n'
            : command.includes('name="$(git config')
              ? 'userName=Login Repo Name\nuserEmail=login-repo@example.com\n'
              : command.includes('command -v tmux')
                ? 'status=available\nversion=tmux 3.4\n'
                : command.includes('command -v rsync')
                  ? 'rsyncStatus=available\nmonitoringStatus=available\n'
                  : '';
      callback(null, { stdout, stderr: '' });
    });

    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    const result = await sshWorkspaceService.checkHostCapabilities({
      id: 'ssh-dev',
      name: 'Devbox',
      hostname: 'dev.example.com',
      basePath: '~/.komla',
    });

    expect(result.gitIdentity).toEqual({ configured: false });
    expect(result.localGitIdentity).toEqual({
      configured: true,
      userName: 'Local Name',
      userEmail: 'local@example.com',
    });
    expect(
      remoteCommands.some((command) => command.includes('git config --global --get user.name'))
    ).toBe(true);
  });

  it('copies the local global git identity when the remote identity is incomplete', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const remoteCommands: string[] = [];
    let identityCopied = false;
    execFileMock.mockImplementation((file, args, _options, callback) => {
      if (file === 'git') {
        const key = (args as string[]).at(-1);
        callback(null, {
          stdout: key === 'user.name' ? 'Local Name\n' : 'local@example.com\n',
          stderr: '',
        });
        return;
      }
      if (file === 'rsync') {
        callback(null, { stdout: 'rsync version 3.2.7\n', stderr: '' });
        return;
      }
      const command = String((args as string[]).at(-1));
      remoteCommands.push(command);
      if (command.includes('git config --global user.email')) identityCopied = true;
      const stdout = command.includes('probe_real=')
        ? '/home/dev/.komla\n'
        : command.includes('command -v git')
          ? 'status=available\nversion=git version 2.43.0\n'
          : command.includes('name="$(git config --global')
            ? identityCopied
              ? 'userName=Local Name\nuserEmail=local@example.com\n'
              : 'userName=Remote Name\nuserEmail=\n'
            : command.includes('command -v tmux')
              ? 'status=available\nversion=tmux 3.4\n'
              : command.includes('command -v rsync')
                ? 'rsyncStatus=available\nmonitoringStatus=available\n'
                : '';
      callback(null, { stdout, stderr: '' });
    });

    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    const result = await sshWorkspaceService.verifyAndPrepareHost({
      id: 'ssh-dev',
      name: 'Devbox',
      hostname: 'dev.example.com',
      basePath: '~/.komla',
    });

    expect(result.gitIdentity).toEqual({
      configured: true,
      userName: 'Local Name',
      userEmail: 'local@example.com',
    });
    const identityCommand = remoteCommands.find((command) =>
      command.includes('git config --global user.email')
    );
    expect(identityCommand).toContain('local@example.com');
    expect(identityCommand).toContain('git config --global user.name');
    expect(execFileMock).toHaveBeenCalledWith(
      'git',
      ['config', '--global', '--get', 'user.name'],
      expect.any(Object),
      expect.any(Function)
    );
    expect(execFileMock).toHaveBeenCalledWith(
      'git',
      ['config', '--global', '--get', 'user.email'],
      expect.any(Object),
      expect.any(Function)
    );
  });

  it('continues setup and reports the actual identity when copying the Git name fails', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const remoteCommands: string[] = [];
    let identityCopyAttempted = false;
    execFileMock.mockImplementation((file, args, _options, callback) => {
      if (file === 'git') {
        const key = (args as string[]).at(-1);
        callback(null, {
          stdout: key === 'user.name' ? 'Local Name\n' : 'local@example.com\n',
          stderr: '',
        });
        return;
      }
      if (file === 'rsync') {
        callback(null, { stdout: 'rsync version 3.2.7\n', stderr: '' });
        return;
      }
      const command = String((args as string[]).at(-1));
      remoteCommands.push(command);
      if (command.includes('git config --global user.email')) identityCopyAttempted = true;
      const stdout = command.includes('probe_real=')
        ? '/home/dev/.komla\n'
        : command.includes('command -v git')
          ? 'status=available\nversion=git version 2.43.0\n'
          : command.includes('name="$(git config --global')
            ? identityCopyAttempted
              ? 'userName=\nuserEmail=local@example.com\n'
              : 'userName=\nuserEmail=\n'
            : command.includes('command -v tmux')
              ? 'status=available\nversion=tmux 3.4\n'
              : command.includes('command -v rsync')
                ? 'rsyncStatus=available\nmonitoringStatus=available\n'
                : '';
      callback(null, { stdout, stderr: '' });
    });

    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    const result = await sshWorkspaceService.verifyAndPrepareHost({
      id: 'ssh-dev',
      name: 'Devbox',
      hostname: 'dev.example.com',
      basePath: '~/.komla',
    });

    expect(result).toMatchObject({
      prepared: true,
      gitIdentity: {
        configured: false,
        userEmail: 'local@example.com',
      },
    });
    expect(result.gitIdentity?.userName).toBeUndefined();
    const identityCommand = remoteCommands.find((command) =>
      command.includes('git config --global user.email')
    );
    expect(identityCommand).toContain('git config --global user.name');
    expect(identityCommand).toContain('git config --global user.email');
    expect(identityCommand?.match(/\|\| true/g)).toHaveLength(2);
    expect(remoteCommands.some((command) => command.includes('.komla-managed'))).toBe(true);
  });

  it('reports missing local and remote rsync during host setup', async () => {
    execFileMock.mockImplementation((file, _args, _options, callback) => {
      if (file === 'rsync') {
        callback(Object.assign(new Error('spawn rsync ENOENT'), { code: 'ENOENT' }), '', '');
        return;
      }
      const sshCall = execFileMock.mock.calls.filter((call) => call[0] === 'ssh').length;
      const stdout =
        sshCall === 1
          ? '/home/dev/.komla\n'
          : sshCall === 2
            ? 'git version 2.43.0\n'
            : sshCall === 3
              ? 'userName=Dev\nuserEmail=dev@example.com\n'
              : sshCall === 4
                ? 'status=available\nversion=tmux 3.4\n'
                : sshCall === 5
                  ? 'status=missing\n'
                  : '';
      callback(null, { stdout, stderr: '' });
    });

    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    const result = await sshWorkspaceService.verifyAndPrepareHost({
      id: 'ssh-dev',
      name: 'Devbox',
      hostname: 'dev.example.com',
      user: 'dev',
      basePath: '~/.komla',
    });

    expect(result.localMirror).toEqual({
      // Komla does not mirror workspaces to a Windows client.
      platform: process.platform === 'win32' ? 'unsupported' : 'supported',
      localRsync: 'missing',
      remoteRsync: 'missing',
    });
    expect(
      execFileMock.mock.calls.some(
        (call) =>
          call[0] === 'ssh' && String((call[1] as string[]).at(-1)).includes('command -v rsync')
      )
    ).toBe(true);
  });

  it('rejects a canonical home or root base path before creating the remote layout', async () => {
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(
        Object.assign(new Error('remote command failed'), {
          stderr: '[komla] refusing to use an unsafe remote data path',
        }),
        '',
        '[komla] refusing to use an unsafe remote data path'
      );
      return undefined;
    });

    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');

    await expect(
      sshWorkspaceService.verifyAndPrepareHost({
        id: 'ssh-dev',
        name: 'Devbox',
        hostname: '203.0.113.20',
        user: 'devuser',
        basePath: '/home/devuser',
      })
    ).rejects.toThrow();

    expect(execFileMock).toHaveBeenCalledTimes(1);
    const resolutionCommand = String((execFileMock.mock.calls[0]?.[1] as string[]).at(-1));
    expect(resolutionCommand).toContain('probe_real=$(cd -P "$probe" && pwd -P)');
    expect(resolutionCommand).toContain('home_real=$(cd -P "$HOME" && pwd -P)');
    expect(resolutionCommand).toContain('[ "$resolved" = / ]');
    expect(resolutionCommand).not.toContain('.komla-managed');
  });

  it('uses unbracketed IPv6 literals for SSH stdin writes', async () => {
    execFileMock.mockImplementation((file, _args, _options, callback) => {
      if (file === 'scp') {
        callback(null, { stdout: '', stderr: '' });
        return;
      }

      const sshCall = execFileMock.mock.calls.filter((call) => call[0] === 'ssh').length;
      const stdout =
        sshCall === 1
          ? '/home/dev/.komla\n'
          : sshCall === 2
            ? 'git version 2.43.0\n'
            : sshCall === 3
              ? 'userName=Dev\nuserEmail=dev@example.com\n'
              : sshCall === 4
                ? 'status=missing\n'
                : '';
      callback(null, { stdout, stderr: '' });
    });

    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    await sshWorkspaceService.verifyAndPrepareHost({
      id: 'ssh-ipv6',
      name: 'IPv6 host',
      hostname: '2001:db8::1',
      user: 'dev',
      basePath: '~/.komla',
    });

    const sshTargets = execFileMock.mock.calls
      .filter((call) => call[0] === 'ssh')
      .map((call) => call[1] as string[]);
    expect(sshTargets.every((args) => args.includes('dev@2001:db8::1'))).toBe(true);
    expect(execFileMock.mock.calls.some((call) => call[0] === 'scp')).toBe(false);
  });

  it.each([
    ['missing', 'status=missing\n', { status: 'missing' }],
    [
      'unusable',
      'status=unusable\nversion=tmux 1.8\n',
      { status: 'unusable', version: 'tmux 1.8' },
    ],
  ] as const)(
    'requires %s tmux before preparing the host',
    async (_label, tmuxOutput, expected) => {
      execFileMock.mockImplementation((file, _args, _options, callback) => {
        if (file === 'scp') {
          callback(null, { stdout: '', stderr: '' });
          return;
        }

        const sshCall = execFileMock.mock.calls.filter((call) => call[0] === 'ssh').length;
        const stdout =
          sshCall === 1
            ? '/home/dev/.komla\n'
            : sshCall === 2
              ? 'git version 2.43.0\n'
              : sshCall === 3
                ? 'userName=Dev\nuserEmail=dev@example.com\n'
                : sshCall === 4
                  ? tmuxOutput
                  : sshCall === 5
                    ? 'rsyncStatus=available\nmonitoringStatus=available\n'
                    : '';
        callback(null, { stdout, stderr: '' });
      });

      const { sshWorkspaceService } =
        await import('../../../src/main/services/ssh-workspace.service');
      sshWorkspaceService.forgetHost('ssh-dev');
      const result = await sshWorkspaceService.verifyAndPrepareHost({
        id: 'ssh-dev',
        name: 'Devbox',
        hostname: 'dev.example.com',
        user: 'dev',
        basePath: '~/.komla',
      });

      expect(result).toMatchObject({
        prepared: false,
        tmux: expected,
      });
      const tmuxProbe = execFileMock.mock.calls[3]?.[1]?.at(-1);
      expect(tmuxProbe).toContain('command -v tmux');
      expect(tmuxProbe).toContain('tmux -L komla-v1 list-commands');
      expect(
        execFileMock.mock.calls.some(
          (call) =>
            call[0] === 'ssh' && String((call[1] as string[]).at(-1)).includes('.komla-managed')
        )
      ).toBe(false);
    }
  );

  it.each([
    ['available', 'status=available\nversion=tmux 3.4\n', true],
    ['missing', 'status=missing\n', false],
    ['unusable', 'status=unusable\nversion=tmux 1.8\n', false],
  ] as const)(
    'reports whether %s tmux can persist terminal sessions',
    async (_label, output, expected) => {
      execFileMock.mockImplementation((_file, _args, _options, callback) => {
        callback(null, { stdout: output, stderr: '' });
      });

      const { sshWorkspaceService } =
        await import('../../../src/main/services/ssh-workspace.service');
      const backend = {
        kind: 'ssh' as const,
        hostId: 'ssh-dev',
        remoteDirectory: '/home/dev/worktree',
        remoteRepoPath: '/home/dev/repo.git',
        remoteProjectRoot: '/home/dev',
        gitUrl: 'git@example.com:repo.git',
      };
      sshWorkspaceService.forgetHost(backend.hostId);

      await expect(
        Promise.all([
          sshWorkspaceService.supportsPersistentTerminalSessions(backend),
          sshWorkspaceService.supportsPersistentTerminalSessions(backend),
        ])
      ).resolves.toEqual([expected, expected]);
      expect(
        execFileMock.mock.calls.filter((call) =>
          String((call[1] as string[]).at(-1)).includes('version="$(tmux -V')
        )
      ).toHaveLength(1);
      expect(
        execFileMock.mock.calls.some((call) =>
          String((call[1] as string[]).at(-1)).includes('setup_lock_attempt=0')
        )
      ).toBe(false);

      execFileMock.mockClear();
      await expect(sshWorkspaceService.supportsPersistentTerminalSessions(backend)).resolves.toBe(
        expected
      );
      expect(
        execFileMock.mock.calls.some((call) =>
          String((call[1] as string[]).at(-1)).includes('version="$(tmux -V')
        )
      ).toBe(false);
    }
  );

  it('reuses the tmux status detected during host verification for terminal persistence', async () => {
    execFileMock.mockImplementation((file, args, _options, callback) => {
      if (file === 'rsync') {
        callback(null, { stdout: 'rsync version 3.2.7\n', stderr: '' });
        return;
      }
      const command = String((args as string[]).at(-1));
      const stdout = command.includes('probe_real=')
        ? '/home/dev/.komla\n'
        : command.includes('command -v git')
          ? 'status=available\nversion=git version 2.43.0\n'
          : command.includes('name="$(git config --global')
            ? 'userName=Dev\nuserEmail=dev@example.com\n'
            : command.includes('version="$(tmux -V')
              ? 'status=available\nversion=tmux 3.4\n'
              : command.includes('for tool in awk')
                ? 'rsyncStatus=available\nmonitoringStatus=available\n'
                : '';
      callback(null, { stdout, stderr: '' });
    });

    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    const host = {
      id: 'ssh-dev',
      name: 'Devbox',
      hostname: '203.0.113.20',
      user: 'devuser',
      basePath: '~/.komla',
    };
    const backend = {
      kind: 'ssh' as const,
      hostId: host.id,
      remoteDirectory: '/home/dev/worktree',
      remoteRepoPath: '/home/dev/repo.git',
      remoteProjectRoot: '/home/dev',
      gitUrl: 'git@example.com:repo.git',
    };
    sshWorkspaceService.forgetHost(host.id);

    await expect(sshWorkspaceService.checkHostCapabilities(host)).resolves.toMatchObject({
      tmux: { status: 'available', version: 'tmux 3.4' },
    });
    await expect(sshWorkspaceService.supportsPersistentTerminalSessions(backend)).resolves.toBe(
      true
    );

    expect(
      execFileMock.mock.calls.filter((call) =>
        String((call[1] as string[]).at(-1)).includes('version="$(tmux -V')
      )
    ).toHaveLength(1);
  });

  it('shares failed persistent-session checks and retries after rejection', async () => {
    let shouldFail = true;
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      if (shouldFail) {
        setImmediate(() => callback(new Error('host unreachable'), '', ''));
        return;
      }
      callback(null, { stdout: 'status=available\nversion=tmux 3.4\n', stderr: '' });
    });

    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    const backend = {
      kind: 'ssh' as const,
      hostId: 'ssh-dev',
      remoteDirectory: '/home/dev/worktree',
      remoteRepoPath: '/home/dev/repo.git',
      remoteProjectRoot: '/home/dev',
      gitUrl: 'git@example.com:repo.git',
    };
    sshWorkspaceService.forgetHost(backend.hostId);

    const first = sshWorkspaceService.supportsPersistentTerminalSessions(backend);
    const second = sshWorkspaceService.supportsPersistentTerminalSessions(backend);
    await expect(Promise.all([first, second])).rejects.toThrow('host unreachable');
    expect(execFileMock).toHaveBeenCalledOnce();

    shouldFail = false;
    await expect(sshWorkspaceService.supportsPersistentTerminalSessions(backend)).resolves.toBe(
      true
    );
  });

  it('enables remote Codex notification hooks for an SSH host', async () => {
    let hooksJson = '';
    execFileMock.mockImplementation((file, args, _options, callback) => {
      const sshCall = execFileMock.mock.calls.filter((call) => call[0] === 'ssh').length;
      if (sshCall === 1) {
        callback(null, { stdout: '/home/devuser/.komla\n', stderr: '' });
        return undefined;
      }
      const command = (args as string[]).at(-1) ?? '';
      callback(null, { stdout: command.includes('if [ -f') ? '0' : '', stderr: '' });
      return {
        stdin: {
          on: vi.fn(),
          end: vi.fn((input: string) => {
            if (command.includes('.codex/hooks.json')) hooksJson = input;
          }),
        },
      };
    });

    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');

    await sshWorkspaceService.enableIntegration('ssh-dev', 'codex', 'notifications');

    const sshCommands = execFileMock.mock.calls
      .filter((call) => call[0] === 'ssh')
      .map((call) => (call[1] as string[]).join(' '));
    expect(sshCommands.some((command) => command.includes('.codex'))).toBe(true);
    expect(hooksJson).toContain("helpers/komla' notify");
    expect(hooksJson).not.toContain('helpers/notify.sh');
    expect(sshCommands.some((command) => command.includes('.codex/hooks.json'))).toBe(true);
    expect(hooksJson).toContain("--event 'UserPromptSubmit'");
    expect(hooksJson).toContain("--event 'UserPromptSubmit' >/dev/null # komla-managed");
    expect(hooksJson).toContain("--event 'Interrupt' >/dev/null # komla-managed");
    expect(hooksJson).not.toContain('--input argv');
  });

  it('uses the Komla CLI from the remote OpenCode notification plugin', async () => {
    let pluginContent = '';
    execFileMock.mockImplementation((file, args, _options, callback) => {
      const command = String((args as string[]).at(-1));
      const stdout = command.includes('printf "%s\\n" "$resolved"')
        ? '/home/devuser/.komla\n'
        : command.includes('printf "%s\\n" "$HOME"')
          ? '/home/devuser\n'
          : '';
      callback(null, { stdout, stderr: '' });
      return file === 'ssh'
        ? {
            stdin: {
              on: vi.fn(),
              end: vi.fn((input: string) => {
                if (command.includes('komla-notify.js')) pluginContent = input;
              }),
            },
          }
        : undefined;
    });

    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');

    await sshWorkspaceService.enableIntegration('ssh-dev', 'opencode', 'notifications');

    expect(pluginContent).toContain('const args = ["notify"');
    expect(pluginContent).toContain('execFile("/home/devuser/.komla/helpers/komla", args');
    expect(pluginContent).toContain('proc.stdin?.end(JSON.stringify');
    expect(pluginContent).not.toContain('helpers/notify.sh');
    expect(pluginContent).toContain('notify("PreToolUse"');
    expect(pluginContent).toContain('recentStops.delete');
  });

  it('preserves user hooks when replacing managed hooks in the same matcher', async () => {
    const existingSettings = {
      hooks: {
        Notification: [
          {
            matcher: 'shared',
            metadata: { owner: 'user' },
            hooks: [
              { type: 'command', command: 'user-hook-one' },
              { type: 'command', command: 'old-hook # komla-managed' },
              { type: 'command', command: 'user-hook-two' },
            ],
          },
          {
            matcher: 'duplicate',
            hooks: [{ type: 'command', command: 'old-duplicate # komla-managed' }],
          },
        ],
      },
    };
    let writtenSettings = '';
    execFileMock.mockImplementation((file, args, _options, callback) => {
      const command = String((args as string[]).at(-1));
      if (command.includes('printf "%s\\n" "$resolved"')) {
        callback(null, { stdout: '/home/devuser/.komla\n', stderr: '' });
      } else if (command.includes('printf "%s\\n" "$HOME"')) {
        callback(null, { stdout: '/home/devuser\n', stderr: '' });
      } else if (command.includes('.claude/settings.json') && command.includes('printf "1"')) {
        callback(null, { stdout: `1${JSON.stringify(existingSettings)}`, stderr: '' });
      } else {
        callback(null, { stdout: '', stderr: '' });
      }
      return file === 'ssh'
        ? {
            stdin: {
              on: vi.fn(),
              end: vi.fn((input: string) => {
                if (command.includes('.claude/settings.json')) writtenSettings = input;
              }),
            },
          }
        : undefined;
    });

    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    await sshWorkspaceService.enableIntegration('ssh-dev', 'claude', 'notifications');

    const notificationMatchers = JSON.parse(writtenSettings).hooks.Notification;
    expect(notificationMatchers).toHaveLength(2);
    expect(notificationMatchers[0]).toEqual({
      matcher: 'shared',
      metadata: { owner: 'user' },
      hooks: [
        { type: 'command', command: 'user-hook-one' },
        { type: 'command', command: 'user-hook-two' },
      ],
    });
    expect(notificationMatchers[1].hooks[0].command).toContain('komla-managed');
  });

  it('removes only managed hooks when disabling notifications', async () => {
    const existingSettings = {
      hooks: {
        Notification: [
          {
            matcher: 'shared',
            metadata: { owner: 'user' },
            hooks: [
              { type: 'command', command: 'user-hook' },
              { type: 'command', command: 'old-hook # komla-managed' },
            ],
          },
          {
            matcher: 'managed-only',
            hooks: [{ type: 'command', command: 'duplicate # komla-managed' }],
          },
        ],
      },
    };
    let writtenSettings = '';
    execFileMock.mockImplementation((file, args, _options, callback) => {
      const command = String((args as string[]).at(-1));
      if (command.includes('printf "%s\\n" "$HOME"')) {
        callback(null, { stdout: '/home/devuser\n', stderr: '' });
      } else if (command.includes('.claude/settings.json') && command.includes('printf "1"')) {
        callback(null, { stdout: `1${JSON.stringify(existingSettings)}`, stderr: '' });
      } else {
        callback(null, { stdout: '', stderr: '' });
      }
      return file === 'ssh'
        ? {
            stdin: {
              on: vi.fn(),
              end: vi.fn((input: string) => {
                if (command.includes('.claude/settings.json')) writtenSettings = input;
              }),
            },
          }
        : undefined;
    });

    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    await sshWorkspaceService.disableIntegration('ssh-dev', 'claude', 'notifications');

    expect(JSON.parse(writtenSettings)).toEqual({
      hooks: {
        Notification: [
          {
            matcher: 'shared',
            metadata: { owner: 'user' },
            hooks: [{ type: 'command', command: 'user-hook' }],
          },
        ],
      },
    });
  });

  it('writes remote configuration through an atomic symlink-aware replacement', async () => {
    execFileMock.mockImplementation((file, args, _options, callback) => {
      const command = String((args as string[]).at(-1));
      if (command.includes('printf "%s\\n" "$HOME"')) {
        callback(null, { stdout: '/home/devuser\n', stderr: '' });
      } else {
        callback(null, {
          stdout: command.includes('.codex/config.toml') ? '[profile.default]\n' : '',
          stderr: '',
        });
      }
      return file === 'ssh' ? { stdin: { on: vi.fn(), end: vi.fn() } } : undefined;
    });

    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    await sshWorkspaceService.enableIntegration('ssh-agent', 'codex', 'mcp');

    const writeCommand = execFileMock.mock.calls
      .filter((call) => call[0] === 'ssh')
      .map((call) => String((call[1] as string[]).at(-1)))
      .find((command) => command.includes('.codex/config.toml') && command.includes('mktemp'));
    expect(writeCommand).toContain('while [ -L "$target" ]');
    expect(writeCommand).toContain('readlink "$target"');
    expect(writeCommand).toContain('cat > "$temp_path"');
    expect(writeCommand).toContain('mv -f "$temp_path" "$target"');
    expect(writeCommand?.indexOf('cat > "$temp_path"')).toBeLessThan(
      writeCommand?.indexOf('mv -f "$temp_path" "$target"') ?? -1
    );
  });

  it('does not overwrite malformed remote agent JSON configuration', async () => {
    execFileMock.mockImplementation((file, args, _options, callback) => {
      if (file === 'scp') {
        callback(null, { stdout: '', stderr: '' });
        return;
      }
      const command = (args as string[]).at(-1) ?? '';
      if (command.includes('printf "%s\\n" "$HOME"')) {
        callback(null, { stdout: '/home/devuser\n', stderr: '' });
        return;
      }
      callback(null, { stdout: command.includes('if [ -f') ? '1{not-json' : '', stderr: '' });
    });

    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');

    await expect(
      sshWorkspaceService.enableIntegration('ssh-dev', 'codex', 'notifications')
    ).rejects.toThrow('contains invalid JSON');

    const configWrites = execFileMock.mock.calls.filter(
      (call) => call[0] === 'scp' && (call[1] as string[]).at(-1)?.includes('.codex/hooks.json')
    );
    expect(configWrites).toHaveLength(0);
  });

  it('configures remote Codex MCP for the stable SSH MCP tunnel', async () => {
    execFileMock.mockImplementation((file, args, _options, callback) => {
      if (file === 'scp') {
        callback(null, { stdout: '', stderr: '' });
        return;
      }

      const remoteCommand = (args as string[]).at(-1) ?? '';
      if (remoteCommand.includes('printf "%s\\n" "$HOME"')) {
        callback(null, { stdout: '/home/devuser\n', stderr: '' });
        return;
      }
      if (remoteCommand.includes('.codex/config.toml')) {
        callback(null, { stdout: '[profile.default]\nmodel = "gpt-5"\n', stderr: '' });
        return;
      }
      callback(null, { stdout: '', stderr: '' });
    });

    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');

    await sshWorkspaceService.enableIntegration('ssh-dev', 'codex', 'mcp');

    const sshCommands = execFileMock.mock.calls
      .filter((call) => call[0] === 'ssh')
      .map((call) => String((call[1] as string[]).at(-1)));
    expect(sshCommands.some((command) => command.includes('.codex/config.toml'))).toBe(true);
  });

  it.each([
    [
      'claude',
      '.claude.json',
      (written: string) =>
        expect(JSON.parse(written).mcpServers.komla).toEqual({
          type: 'stdio',
          command: '/home/devuser/.komla/helpers/komla',
          args: ['mcp'],
        }),
    ],
    [
      'codex',
      '.codex/config.toml',
      (written: string) => {
        expect(written).toContain(
          '[mcp_servers.komla]\ncommand = "/home/devuser/.komla/helpers/komla"\nargs = ["mcp"]\n'
        );
        expect(written).not.toContain('url =');
      },
    ],
    [
      'antigravity',
      '.gemini/config/mcp_config.json',
      (written: string) =>
        expect(JSON.parse(written).mcpServers.komla).toEqual({
          command: '/home/devuser/.komla/helpers/komla',
          args: ['mcp'],
        }),
    ],
    [
      'opencode',
      '.config/opencode/opencode.json',
      (written: string) =>
        expect(JSON.parse(written).mcp.komla).toEqual({
          type: 'local',
          command: ['/home/devuser/.komla/helpers/komla', 'mcp'],
        }),
    ],
  ] as const)(
    'configures remote %s MCP to launch the shared stdio adapter',
    async (agent, configPath, assertWritten) => {
      let written = '';
      execFileMock.mockImplementation((file, args, _options, callback) => {
        const remoteCommand = String((args as string[]).at(-1));
        const isWrite = remoteCommand.includes('cat > "$temp_path"');
        if (remoteCommand.includes('printf "%s\\n" "$HOME"')) {
          callback(null, { stdout: '/home/devuser\n', stderr: '' });
        } else if (remoteCommand.includes('configured=')) {
          callback(null, { stdout: '/home/devuser/.komla\n', stderr: '' });
        } else if (remoteCommand.includes('printf "1"')) {
          callback(null, { stdout: '0', stderr: '' });
        } else {
          callback(null, { stdout: '', stderr: '' });
        }
        return file === 'ssh'
          ? {
              stdin: {
                on: vi.fn(),
                end: vi.fn((input: string) => {
                  if (isWrite && remoteCommand.includes(configPath)) written = input;
                }),
              },
            }
          : undefined;
      });

      const { sshWorkspaceService } =
        await import('../../../src/main/services/ssh-workspace.service');
      await sshWorkspaceService.enableIntegration('ssh-dev', agent, 'mcp');

      assertWritten(written);
    }
  );

  it('fails instead of reporting a workspace missing when its host replies unexpectedly', async () => {
    execFileMock.mockImplementation((file, _args, _options, callback) => {
      callback(null, { stdout: 'Welcome to Ubuntu\npresent', stderr: '' });
      return file === 'ssh' ? { stdin: { on: vi.fn(), end: vi.fn() } } : undefined;
    });
    const { sshWorkspaceSyncHost } =
      await import('../../../src/main/services/ssh-workspace-sync/host');

    await expect(
      sshWorkspaceSyncHost.inspect(
        {
          kind: 'ssh',
          hostId: 'ssh-dev',
          remoteDirectory: '/home/devuser/.komla/worktrees/app/main',
          remoteRepoPath: '/home/devuser/.komla/repos/app/repo.git',
          remoteProjectRoot: '/home/devuser/.komla/worktrees/app',
          gitUrl: 'git@github.com:acme/app.git',
        },
        'ws-42'
      )
    ).rejects.toThrow('Unexpected reply');
  });

  it('preserves remote Codex settings around the Komla MCP table', async () => {
    const existingConfig = [
      'model = "gpt-5"',
      '',
      '[mcp_servers.komla]',
      'url = "http://127.0.0.1:62000/api/v1/mcp"',
      '',
      '[projects."/worktree"]',
      'trust_level = "trusted"',
      '',
      '[hooks.state]',
      'trusted_hash = "abc123"',
      '',
      '[tui]',
      'status_line = ["model-name", "context-remaining"]',
      '',
    ].join('\n');
    let writtenConfig = '';
    execFileMock.mockImplementation((file, args, _options, callback) => {
      const remoteCommand = String((args as string[]).at(-1));
      const isWrite = remoteCommand.includes('cat > "$temp_path"');
      if (remoteCommand.includes('printf "%s\\n" "$HOME"')) {
        callback(null, { stdout: '/home/devuser\n', stderr: '' });
      } else if (remoteCommand.includes('.codex/config.toml') && !isWrite) {
        callback(null, { stdout: existingConfig, stderr: '' });
      } else {
        callback(null, { stdout: '', stderr: '' });
      }
      return file === 'ssh'
        ? {
            stdin: {
              on: vi.fn(),
              end: vi.fn((input: string) => {
                if (isWrite) writtenConfig = input;
              }),
            },
          }
        : undefined;
    });

    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    await sshWorkspaceService.enableIntegration('ssh-dev', 'codex', 'mcp');

    expect(writtenConfig).toContain('[projects."/worktree"]');
    expect(writtenConfig).toContain('[hooks.state]');
    expect(writtenConfig).toContain('[tui]');
    expect(writtenConfig).toContain('status_line = ["model-name", "context-remaining"]');
    expect(writtenConfig).not.toContain('62000');
    expect(writtenConfig.match(/\[mcp_servers\.komla\]/g)).toHaveLength(1);
  });

  // Serves remote reads from `files` and records remote writes into it.
  function serveRemoteFiles(
    files: Record<string, string>,
    { unresolvedBasePath = false, claudeVersion = '' } = {}
  ): void {
    execFileMock.mockImplementation((file, args, _options, callback) => {
      const command = String((args as string[]).at(-1));
      if (command.includes('claude --version')) {
        callback(null, { stdout: claudeVersion && `${claudeVersion} (Claude Code)\n`, stderr: '' });
        return undefined;
      }
      if (unresolvedBasePath && command.includes('printf "%s\\n" "$resolved"')) {
        callback(new Error('cd: permission denied'), { stdout: '', stderr: 'permission denied' });
        return undefined;
      }
      // Remote commands arrive wrapped in `sh -lc '...'`, so quoted paths read '"'"'<path>'"'"'.
      const writePath = /target='"'"'([^']+)'/.exec(command)?.[1];
      const readPath = writePath ? undefined : /if \[ -f '"'"'([^']+)'/.exec(command)?.[1];
      const removedList = /rm -rf ((?:'"'"'[^']+'"'"' ?)+)/.exec(command)?.[1] ?? '';
      const removedPaths = [...removedList.matchAll(/'"'"'([^']+)'"'"'/g)].map(([, path]) => path);
      for (const path of Object.keys(files)) {
        if (removedPaths.some((removed) => path.startsWith(`${removed}/`))) delete files[path];
      }
      let stdout = '';
      if (command.includes('__KOMLA_SKILL_FILE__')) {
        // Every skills folder's Komla skill in one read, each after a delimiter line and whether
        // the skill goes there: a folder it needs exists when a file is under it.
        stdout = command
          .split('\n')
          .filter((line) => line.includes('__KOMLA_SKILL_FILE__'))
          .map((line) => {
            const path = /if \[ -f '"'"'([^']+)'/.exec(line)![1];
            const needed = /if \[ -d '"'"'([^']+)'/.exec(line)?.[1];
            const applies = !needed || Object.keys(files).some((p) => p.startsWith(`${needed}/`));
            return `\n__KOMLA_SKILL_FILE__\n${applies ? 1 : 0}\n${files[path] ?? ''}`;
          })
          .join('');
      } else if (command.includes('printf "%s\\n" "$resolved"')) stdout = '/home/devuser/.komla\n';
      else if (command.includes('printf "%s\\n" "$HOME"')) stdout = '/home/devuser\n';
      else if (readPath && command.includes('printf "1"')) {
        stdout = readPath in files ? `1${files[readPath]}` : '0';
      } else if (readPath) stdout = files[readPath] ?? '';
      callback(null, { stdout, stderr: '' });
      return file === 'ssh'
        ? {
            stdin: {
              on: vi.fn(),
              end: vi.fn((input: string) => {
                if (writePath) files[writePath] = input;
              }),
            },
          }
        : undefined;
    });
  }

  it('reports no notification update right after Komla installs remote notifications', async () => {
    serveRemoteFiles({});
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    const agents = ['claude', 'codex', 'antigravity', 'opencode'] as const;
    for (const agent of agents) {
      await sshWorkspaceService.enableIntegration('ssh-integrations', agent, 'notifications');
    }

    const status = await sshWorkspaceService.getIntegrationStatus('ssh-integrations');

    for (const agent of agents) {
      expect(status[agent].notifications).toBe(true);
      expect(status[agent].update).toBeUndefined();
    }
  });

  // Asking starts an interactive login shell on the host.
  it("asks the host's Claude for its version only when Komla's Claude hooks are installed", async () => {
    serveRemoteFiles({}, { claudeVersion: '2.1.296' });
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    const versionProbes = () =>
      execFileMock.mock.calls.filter(([, args]) =>
        String((args as string[]).at(-1)).includes('claude --version')
      ).length;
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + CLAUDE_VERSION_CACHE_MS);
      execFileMock.mockClear();
      await sshWorkspaceService.getIntegrationStatus('ssh-integrations');
      expect(versionProbes()).toBe(0);

      await sshWorkspaceService.enableIntegration('ssh-integrations', 'claude', 'notifications');
      vi.setSystemTime(Date.now() + CLAUDE_VERSION_CACHE_MS);
      execFileMock.mockClear();
      await sshWorkspaceService.getIntegrationStatus('ssh-integrations');
      expect(versionProbes()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("installs Claude's turn-end hooks only when the host's Claude accepts them", async () => {
    const files: Record<string, string> = {};
    serveRemoteFiles(files);
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    const settingsPath = '/home/devuser/.claude/settings.json';
    await sshWorkspaceService.enableIntegration('ssh-integrations', 'claude', 'notifications');
    expect(Object.keys(JSON.parse(files[settingsPath]).hooks)).not.toContain('StopFailure');

    // Status checks reuse the host's Claude version for a while; enabling probes afresh.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      serveRemoteFiles(files, { claudeVersion: '2.1.296' });
      expect(
        (await sshWorkspaceService.getIntegrationStatus('ssh-integrations')).claude.update
      ).toBeUndefined();
      vi.setSystemTime(Date.now() + CLAUDE_VERSION_CACHE_MS);
      const upgraded = await sshWorkspaceService.getIntegrationStatus('ssh-integrations');
      expect(upgraded.claude.update?.preview).toContain("--event 'StopFailure'");

      await sshWorkspaceService.enableIntegration('ssh-integrations', 'claude', 'notifications');
      const hooks = JSON.parse(files[settingsPath]).hooks;
      expect(hooks.PostCompact[0].hooks[0].command).toContain(
        "--event 'PostCompact' # komla-managed"
      );
      expect(hooks.SessionEnd[0].hooks[0].command).toContain(
        "--event 'SessionEnd' # komla-managed"
      );
      expect(
        (await sshWorkspaceService.getIntegrationStatus('ssh-integrations')).claude.update
      ).toBeUndefined();

      // A downgraded Claude discards the whole file over these events.
      serveRemoteFiles(files, { claudeVersion: '2.1.50' });
      vi.setSystemTime(Date.now() + CLAUDE_VERSION_CACHE_MS);
      expect(
        (await sshWorkspaceService.getIntegrationStatus('ssh-integrations')).claude.update
      ).toBeDefined();
      await sshWorkspaceService.enableIntegration('ssh-integrations', 'claude', 'notifications');
      expect(Object.keys(JSON.parse(files[settingsPath]).hooks).sort()).toEqual([
        'Notification',
        'PreToolUse',
        'Stop',
        'UserPromptSubmit',
      ]);
    } finally {
      vi.useRealTimers();
    }

    await sshWorkspaceService.disableIntegration('ssh-integrations', 'claude', 'notifications');
    expect(JSON.parse(files[settingsPath]).hooks).toBeUndefined();
  });

  const antigravityHooksPath = '/home/devuser/.gemini/config/hooks.json';
  const antigravitySettingsPath = '/home/devuser/.gemini/antigravity-cli/settings.json';
  const antigravityCommand = (event: string) =>
    `'/home/devuser/.komla/helpers/komla' notify --source 'antigravity' --event '${event}' # komla-managed`;
  const antigravityHookSet = {
    PreInvocation: [{ type: 'command', command: antigravityCommand('PreInvocation') }],
    PostToolUse: [
      { matcher: '*', hooks: [{ type: 'command', command: antigravityCommand('PostToolUse') }] },
    ],
    Stop: [{ type: 'command', command: antigravityCommand('Stop') }],
  };
  const userHookSet = {
    PostToolUse: [
      { matcher: 'run_command', hooks: [{ type: 'command', command: './scripts/lint.sh' }] },
    ],
  };

  it("adds the Komla skill to the host's skills folders and removes only Komla's", async () => {
    const userSkill = '---\nname: notes\n---\n';
    const files: Record<string, string> = {
      '/home/devuser/.claude/skills/komla/SKILL.md': userSkill,
    };
    serveRemoteFiles(files);
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');

    await sshWorkspaceService.setKomlaSkill('ssh-integrations', true);

    expect(files['/home/devuser/.claude/skills/komla/SKILL.md']).toBe(KOMLA_SKILL);
    expect(files['/home/devuser/.agents/skills/komla/SKILL.md']).toBe(KOMLA_SKILL);
    // Antigravity CLI's folder only where ~/.gemini exists.
    expect(files['/home/devuser/.gemini/config/skills/komla/SKILL.md']).toBeUndefined();
    expect(
      (await sshWorkspaceService.getIntegrationStatus('ssh-integrations')).komlaSkill
    ).toBe(true);

    files['/home/devuser/.claude/skills/komla/SKILL.md'] = userSkill;
    await sshWorkspaceService.setKomlaSkill('ssh-integrations', false);

    expect(files['/home/devuser/.agents/skills/komla/SKILL.md']).toBeUndefined();
    expect(files['/home/devuser/.claude/skills/komla/SKILL.md']).toBe(userSkill);
    expect(
      (await sshWorkspaceService.getIntegrationStatus('ssh-integrations')).komlaSkill
    ).toBe(false);
  });

  it('brings the Komla skill on the host up to date when it checks, filling in missing copies', async () => {
    const files: Record<string, string> = {
      '/home/devuser/.agents/skills/komla/SKILL.md': '---\nname: komla\n---\nOld\n',
      '/home/devuser/.gemini/settings.json': '{}',
    };
    serveRemoteFiles(files);
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');

    const status = await sshWorkspaceService.getIntegrationStatus('ssh-integrations');

    expect(status.komlaSkill).toBe(true);
    expect(files['/home/devuser/.agents/skills/komla/SKILL.md']).toBe(KOMLA_SKILL);
    expect(files['/home/devuser/.claude/skills/komla/SKILL.md']).toBe(KOMLA_SKILL);
    expect(files['/home/devuser/.gemini/config/skills/komla/SKILL.md']).toBe(KOMLA_SKILL);
  });

  it('installs a Komla Antigravity hook set beside other hook sets and removes only it', async () => {
    const files: Record<string, string> = {
      [antigravityHooksPath]: JSON.stringify({ lint: userHookSet }),
      [antigravitySettingsPath]: JSON.stringify({ trustedWorkspaces: ['/work'] }),
    };
    serveRemoteFiles(files);
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');

    await sshWorkspaceService.enableIntegration('ssh-integrations', 'antigravity', 'notifications');

    expect(JSON.parse(files[antigravityHooksPath])).toEqual({
      lint: userHookSet,
      komla: antigravityHookSet,
    });
    // Approval prompts reach Komla only as Antigravity's terminal alerts.
    expect(JSON.parse(files[antigravitySettingsPath])).toEqual({
      trustedWorkspaces: ['/work'],
      notifications: true,
    });
    await expect(
      sshWorkspaceService.getIntegrationStatus('ssh-integrations')
    ).resolves.toMatchObject({ antigravity: { notifications: true, update: undefined } });

    await sshWorkspaceService.disableIntegration('ssh-integrations', 'antigravity', 'notifications');

    expect(JSON.parse(files[antigravityHooksPath])).toEqual({ lint: userHookSet });
    expect(JSON.parse(files[antigravitySettingsPath])).toMatchObject({ notifications: true });
  });

  it('reports outdated and disabled Antigravity hook sets', async () => {
    const files: Record<string, string> = {
      [antigravityHooksPath]: JSON.stringify({
        komla: { Stop: [{ type: 'command', command: "'/old/komla' notify # komla-managed" }] },
      }),
    };
    serveRemoteFiles(files);
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');

    const outdated = await sshWorkspaceService.getIntegrationStatus('ssh-integrations');

    expect(outdated.antigravity.notifications).toBe(true);
    expect(outdated.antigravity.update?.files).toEqual([
      { path: antigravityHooksPath, description: expect.any(String) },
      { path: antigravitySettingsPath, description: expect.any(String) },
    ]);
    expect(JSON.parse(outdated.antigravity.update?.preview ?? '{}')).toEqual({
      komla: antigravityHookSet,
    });

    files[antigravityHooksPath] = JSON.stringify({
      komla: { ...antigravityHookSet, enabled: false },
    });
    const disabled = await sshWorkspaceService.getIntegrationStatus('ssh-integrations');

    expect(disabled.antigravity).toMatchObject({ notifications: false, update: undefined });
  });

  it('offers to turn Antigravity terminal alerts back on for a current hook set', async () => {
    const files: Record<string, string> = {
      [antigravityHooksPath]: JSON.stringify({ komla: antigravityHookSet }),
      [antigravitySettingsPath]: JSON.stringify({ notifications: false }),
    };
    serveRemoteFiles(files);
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');

    const status = await sshWorkspaceService.getIntegrationStatus('ssh-integrations');

    expect(status.antigravity.update?.files).toEqual([
      { path: antigravitySettingsPath, description: expect.any(String) },
    ]);
  });

  it('reads an empty Komla hook set and a disabled MCP server as not configured', async () => {
    const files: Record<string, string> = {
      [antigravityHooksPath]: JSON.stringify({ komla: {} }),
      '/home/devuser/.gemini/config/mcp_config.json': JSON.stringify({
        mcpServers: { komla: { command: 'komla', args: ['mcp'], disabled: true } },
      }),
    };
    serveRemoteFiles(files);
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');

    const status = await sshWorkspaceService.getIntegrationStatus('ssh-integrations');

    expect(status.antigravity).toMatchObject({ notifications: false, mcp: false });
  });

  it('reports outdated remote notification setups and remembers them per host', async () => {
    const files: Record<string, string> = {
      '/home/devuser/.claude/settings.json': JSON.stringify({
        hooks: {
          Notification: [
            {
              matcher: '',
              hooks: [
                {
                  type: 'command',
                  command: "'/home/devuser/.komla/helpers/notify.sh' # komla-managed",
                },
              ],
            },
          ],
        },
      }),
      '/home/devuser/.config/opencode/plugins/komla-notify.js': '// Komla notification plugin\n',
    };
    serveRemoteFiles(files);
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    await sshWorkspaceService.enableIntegration('ssh-integrations', 'codex', 'notifications');
    const changes = vi.fn();
    sshWorkspaceService.onIntegrationUpdatesChanged(changes);

    const status = await sshWorkspaceService.getIntegrationStatus('ssh-integrations');

    expect(status.claude.notifications).toBe(true);
    expect(status.claude.update?.files).toEqual([
      { path: '/home/devuser/.claude/settings.json', description: expect.any(String) },
    ]);
    expect(status.claude.update?.preview).toContain(
      "'/home/devuser/.komla/helpers/komla' notify --source 'claude-code' --event 'UserPromptSubmit' # komla-managed"
    );
    expect(status.codex.update).toBeUndefined();
    expect(status.antigravity.update).toBeUndefined();
    expect(status.opencode.update?.files[0]?.path).toBe(
      '/home/devuser/.config/opencode/plugins/komla-notify.js'
    );
    expect(status.opencode.update?.preview).toContain(
      'execFile("/home/devuser/.komla/helpers/komla"'
    );
    const cached = sshWorkspaceService.getCachedIntegrationUpdates();
    expect(cached['ssh-integrations']).toEqual({
      claude: status.claude.update?.preview,
      opencode: status.opencode.update?.preview,
    });
    expect(changes).toHaveBeenLastCalledWith(cached);

    await sshWorkspaceService.enableIntegration('ssh-integrations', 'claude', 'notifications');
    await sshWorkspaceService.getIntegrationStatus('ssh-integrations');
    expect(
      Object.keys(sshWorkspaceService.getCachedIntegrationUpdates()['ssh-integrations'])
    ).toEqual(['opencode']);

    sshWorkspaceService.forgetHost('ssh-integrations');
    expect(sshWorkspaceService.getCachedIntegrationUpdates()['ssh-integrations']).toBeUndefined();
    expect(changes).toHaveBeenCalledTimes(3);
    expect(changes.mock.lastCall?.[0]).not.toHaveProperty('ssh-integrations');
  });

  it('refreshes remembered integration updates when a workspace connects to the host', async () => {
    serveRemoteFiles({ '/home/devuser/.config/opencode/plugins/komla-notify.js': '// old\n' });
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    sshWorkspaceService.forgetHost('ssh-integrations');

    await sshWorkspaceService.ensureRemoteNotificationScript({
      kind: 'ssh',
      hostId: 'ssh-integrations',
      remoteDirectory: '/home/devuser/.komla/worktrees/komla/claude-onyx-grove',
      remoteRepoPath: '/home/devuser/.komla/repos/komla/repo.git',
      remoteProjectRoot: '/home/devuser/.komla/worktrees/komla',
      gitUrl: 'https://github.com/komla-dev/komla.git',
    });

    await vi.waitFor(() =>
      expect(
        Object.keys(sshWorkspaceService.getCachedIntegrationUpdates()['ssh-integrations'] ?? {})
      ).toEqual(['opencode'])
    );
  });

  it('still reports installed integrations when the base path cannot be resolved', async () => {
    serveRemoteFiles(
      {
        '/home/devuser/.claude.json': JSON.stringify({ mcpServers: { komla: { command: 'x' } } }),
        '/home/devuser/.config/opencode/plugins/komla-notify.js': '// Komla notification plugin\n',
      },
      { unresolvedBasePath: true }
    );
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');

    const status = await sshWorkspaceService.getIntegrationStatus('ssh-integrations-unresolved');

    expect(status.claude.mcp).toBe(true);
    expect(status.opencode.notifications).toBe(true);
    expect(status.opencode.update).toBeUndefined();
  });

  // Holds the first read of `pathFragment` until the returned release function is called.
  function holdRemoteRead(pathFragment: string): { released: () => boolean; release: () => void } {
    const serve = execFileMock.getMockImplementation()!;
    let release: (() => void) | undefined;
    execFileMock.mockImplementation((file, args, options, callback) => {
      const command = String((args as string[]).at(-1));
      if (!release && command.includes(pathFragment) && command.includes('if [ -f')) {
        void new Promise<void>((resolve) => {
          release = resolve;
        }).then(() => serve(file, args, options, callback));
        return { stdin: { on: vi.fn(), end: vi.fn() } };
      }
      return serve(file, args, options, callback);
    });
    return { released: () => release !== undefined, release: () => release?.() };
  }

  it('ignores an integration check that finishes after the host was forgotten', async () => {
    serveRemoteFiles({ '/home/devuser/.config/opencode/plugins/komla-notify.js': '// old\n' });
    const held = holdRemoteRead('komla-notify.js');
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    sshWorkspaceService.forgetHost('ssh-integrations');

    const check = sshWorkspaceService.getIntegrationStatus('ssh-integrations');
    await vi.waitFor(() => expect(held.released()).toBe(true));
    sshWorkspaceService.forgetHost('ssh-integrations');
    held.release();
    await check;

    expect(sshWorkspaceService.getCachedIntegrationUpdates()['ssh-integrations']).toBeUndefined();
  });

  it('runs the connect-time integration check in order with integration changes', async () => {
    const pluginPath = '/home/devuser/.config/opencode/plugins/komla-notify.js';
    const files: Record<string, string> = { [pluginPath]: '// old\n' };
    serveRemoteFiles(files);
    const held = holdRemoteRead('komla-notify.js');
    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    sshWorkspaceService.forgetHost('ssh-integrations');

    await sshWorkspaceService.ensureRemoteNotificationScript({
      kind: 'ssh',
      hostId: 'ssh-integrations',
      remoteDirectory: '/home/devuser/.komla/worktrees/komla/claude-onyx-grove',
      remoteRepoPath: '/home/devuser/.komla/repos/komla/repo.git',
      remoteProjectRoot: '/home/devuser/.komla/worktrees/komla',
      gitUrl: 'https://github.com/komla-dev/komla.git',
    });
    await vi.waitFor(() => expect(held.released()).toBe(true));
    const enable = sshWorkspaceService.enableIntegration('ssh-integrations', 'opencode', 'notifications');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(files[pluginPath]).toBe('// old\n');

    held.release();
    await enable;
    expect(files[pluginPath]).not.toBe('// old\n');
    await sshWorkspaceService.getIntegrationStatus('ssh-integrations');
    expect(sshWorkspaceService.getCachedIntegrationUpdates()['ssh-integrations']).toBeUndefined();
  });

  it('serializes integration configuration changes for the same SSH host', async () => {
    let releaseFirstHomeRead: (() => void) | undefined;
    let codexConfig = '[profile.default]\n';
    execFileMock.mockImplementation((file, args, _options, callback) => {
      if (file === 'scp') {
        callback(null, { stdout: '', stderr: '' });
        return;
      }

      const remoteCommand = (args as string[]).at(-1) ?? '';
      if (remoteCommand.includes('printf "%s\\n" "$HOME"')) {
        if (!releaseFirstHomeRead) {
          releaseFirstHomeRead = () => callback(null, { stdout: '/home/devuser\n', stderr: '' });
          return;
        }
        callback(null, { stdout: '/home/devuser\n', stderr: '' });
        return;
      }
      callback(null, {
        stdout: remoteCommand.includes('.codex/config.toml') ? codexConfig : '',
        stderr: '',
      });
      return {
        stdin: {
          on: vi.fn(),
          end: vi.fn((input: string) => {
            if (remoteCommand.includes('.codex/config.toml')) codexConfig = input;
          }),
        },
      };
    });

    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');

    const enable = sshWorkspaceService.enableIntegration('ssh-dev', 'codex', 'mcp');
    const disable = sshWorkspaceService.disableIntegration('ssh-dev', 'codex', 'mcp');
    // Enabling resolves the base path, then blocks on the home read; disabling must not start.
    await vi.waitFor(() =>
      expect(execFileMock.mock.calls.filter((call) => call[0] === 'ssh')).toHaveLength(2)
    );

    releaseFirstHomeRead?.();
    await Promise.all([enable, disable]);

    const configWrites = execFileMock.mock.calls.filter(
      (call) =>
        call[0] === 'ssh' &&
        String((call[1] as string[]).at(-1)).includes('cat >') &&
        String((call[1] as string[]).at(-1)).includes('.codex/config.toml')
    );
    expect(configWrites).toHaveLength(2);
    for (const write of configWrites) {
      expectInteractiveSshMultiplexing(write[1]);
    }
  });

  it('removes remote Codex MCP configuration', async () => {
    execFileMock.mockImplementation((file, args, _options, callback) => {
      if (file === 'scp') {
        callback(null, { stdout: '', stderr: '' });
        return;
      }

      const remoteCommand = (args as string[]).at(-1) ?? '';
      if (remoteCommand.includes('printf "%s\\n" "$HOME"')) {
        callback(null, { stdout: '/home/devuser\n', stderr: '' });
        return;
      }
      if (remoteCommand.includes('.codex/config.toml')) {
        callback(null, {
          stdout:
            '[profile.default]\nmodel = "gpt-5"\n\n[mcp_servers.komla]\nurl = "http://127.0.0.1:62000/api/v1/mcp"\n',
          stderr: '',
        });
        return;
      }
      callback(null, { stdout: '', stderr: '' });
    });

    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');

    await sshWorkspaceService.disableIntegration('ssh-dev', 'codex', 'mcp');

    const sshCommands = execFileMock.mock.calls
      .filter((call) => call[0] === 'ssh')
      .map((call) => String((call[1] as string[]).at(-1)));
    expect(sshCommands.some((command) => command.includes('.codex/config.toml'))).toBe(true);
  });

  it('removes all Komla-managed data and integrations from an SSH host', async () => {
    execFileMock.mockImplementation((_file, args, _options, callback) => {
      const remoteCommand = String((args as string[]).at(-1));
      const stdout = remoteCommand.includes('configured=')
        ? '/home/devuser/.komla\n'
        : remoteCommand.includes('printf "%s\\n" "$HOME"')
          ? '/home/devuser\n'
          : remoteCommand.includes('printf "1"')
            ? '0'
            : '';
      callback(null, { stdout, stderr: '' });
      return {
        stdin: {
          on: vi.fn(),
          end: vi.fn(),
        },
      };
    });

    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');
    await sshWorkspaceService.deleteHostData('ssh-dev');

    const sshCommands = execFileMock.mock.calls.map((call) => String((call[1] as string[]).at(-1)));
    expect(sshCommands.some((command) => command.includes('/helpers/terminal.sh'))).toBe(false);
    expect(sshCommands.some((command) => command.includes('tmux -L komla-v1 kill-server'))).toBe(
      true
    );
    expect(
      sshCommands.find((command) => command.includes('tmux -L komla-v1 kill-server'))
    ).not.toContain('command -v tmux');
    expect(sshCommands.some((command) => command.includes('.claude/settings.json'))).toBe(true);
    expect(sshCommands.some((command) => command.includes('.codex/config.toml'))).toBe(true);
    expect(sshCommands.some((command) => command.includes('.gemini/config/hooks.json'))).toBe(true);
    expect(sshCommands.some((command) => command.includes('.gemini/config/mcp_config.json'))).toBe(
      true
    );
    expect(sshCommands.some((command) => command.includes('komla-notify.js'))).toBe(true);

    const purgeCommand = sshCommands.find(
      (command) => command.includes('remote data ownership marker') && command.includes('rm -rf --')
    );
    expect(purgeCommand).toContain('.komla-managed');
    expect(purgeCommand).toContain('refusing to delete an unsafe remote data path');
    expect(purgeCommand).toContain('refusing to delete remote data containing unrecognized files');
  });

  it('explains when the SSH agent refuses a key request during host deletion', async () => {
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      const error = Object.assign(new Error('Command failed: ssh ...'), {
        stderr:
          'sign_and_send_pubkey: signing failed for ED25519 "Work key" from agent: agent refused operation\n' +
          'dev@example.com: Permission denied (publickey).\n',
      });
      callback(error);
      return { stdin: { on: vi.fn(), end: vi.fn() } };
    });

    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');

    await expect(sshWorkspaceService.deleteHostData('ssh-dev')).rejects.toThrow(
      'Your SSH agent did not approve use of the SSH key. Approve the key request or unlock the key in your SSH agent, then try again.'
    );
  });

  it('skips remote worktree removal when the bare repo or worktree is missing', async () => {
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      const sshCall = execFileMock.mock.calls.filter((call) => call[0] === 'ssh').length;
      if (sshCall === 1) {
        callback(null, { stdout: '/home/devuser/.komla\n', stderr: '' });
        return;
      }
      callback(null, { stdout: '', stderr: '' });
    });

    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');

    await sshWorkspaceService.deleteWorkspace({
      kind: 'ssh',
      hostId: 'ssh-dev',
      remoteDirectory: '/home/devuser/.komla/worktrees/komla/claude-missing',
      remoteRepoPath: '/home/devuser/.komla/repos/komla/repo.git',
      remoteProjectRoot: '/home/devuser/.komla/worktrees/komla',
      gitUrl: 'https://github.com/komla-dev/komla.git',
      projectName: 'komla',
      branchName: 'claude/missing',
      baseBranch: 'main',
    });

    const deleteCommand = (execFileMock.mock.calls.at(-1)?.[1] as string[]).at(-1);
    expect(deleteCommand).toContain('if [ -d');
    expect(deleteCommand).toContain('worktree remove --force');
    expect(deleteCommand).toContain('rm -rf --');
    expect(deleteCommand).toContain('failed to delete remote workspace directory');
    expect(deleteCommand).toContain('worktree prune');
    for (const call of execFileMock.mock.calls.filter((call) => call[0] === 'ssh')) {
      expectInteractiveSshMultiplexing(call[1]);
    }
  });

  it('deletes and verifies the requested remote workspace branch', async () => {
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      const sshCall = execFileMock.mock.calls.filter((call) => call[0] === 'ssh').length;
      if (sshCall === 1) {
        callback(null, { stdout: '/home/devuser/.komla\n', stderr: '' });
        return;
      }
      callback(null, { stdout: '', stderr: '' });
    });

    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');

    await sshWorkspaceService.deleteWorkspace(
      {
        kind: 'ssh',
        hostId: 'ssh-dev',
        remoteDirectory: '/home/devuser/.komla/worktrees/komla/feature-cleanup',
        remoteRepoPath: '/home/devuser/.komla/repos/komla/repo.git',
        remoteProjectRoot: '/home/devuser/.komla/worktrees/komla',
        gitUrl: 'https://github.com/komla-dev/komla.git',
        projectName: 'komla',
        branchName: 'feature/cleanup',
        baseBranch: 'main',
      },
      true,
      'feature/cleanup'
    );

    const deleteCommand = (execFileMock.mock.calls.at(-1)?.[1] as string[]).at(-1);
    expect(deleteCommand).toContain('show-ref --verify --quiet');
    expect(deleteCommand).toContain('refs/heads/feature/cleanup');
    expect(deleteCommand).toContain('branch -D');
    expect(deleteCommand).toContain('feature/cleanup');
    expect(deleteCommand).toContain('failed to delete remote workspace branch');
    expect(deleteCommand).not.toMatch(/branch -D[^\n]+\|\| true/);
  });

  it.each([
    { allowBranchToRemain: true, rejects: false },
    { allowBranchToRemain: false, rejects: true },
  ])(
    'treats a branch Git refuses to delete as fatal unless allowed (allowed: $allowBranchToRemain)',
    async ({ allowBranchToRemain, rejects }) => {
      const stderr = '[komla] failed to delete remote workspace branch\n';
      execFileMock.mockImplementation((_file, _args, _options, callback) => {
        const sshCall = execFileMock.mock.calls.filter((call) => call[0] === 'ssh').length;
        if (sshCall === 1) {
          callback(null, { stdout: '/home/devuser/.komla\n', stderr: '' });
          return;
        }
        callback(Object.assign(new Error('remote command failed'), { stderr }), '', stderr);
      });
      const { sshWorkspaceService } =
        await import('../../../src/main/services/ssh-workspace.service');

      const deleting = sshWorkspaceService.deleteWorkspace(
        {
          kind: 'ssh',
          hostId: 'ssh-dev',
          remoteDirectory: '/home/devuser/.komla/worktrees/komla/feature-cleanup',
          remoteRepoPath: '/home/devuser/.komla/repos/komla/repo.git',
          remoteProjectRoot: '/home/devuser/.komla/worktrees/komla',
          gitUrl: 'https://github.com/komla-dev/komla.git',
          projectName: 'komla',
          branchName: 'feature/cleanup',
          baseBranch: 'main',
        },
        true,
        'feature/cleanup',
        { allowBranchToRemain }
      );

      if (rejects) await expect(deleting).rejects.toThrow();
      else await expect(deleting).resolves.toBeUndefined();
    }
  );

  it('refuses to delete remote workspaces outside the managed base path', async () => {
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(null, { stdout: '/home/devuser/.komla\n', stderr: '' });
    });

    const { sshWorkspaceService } =
      await import('../../../src/main/services/ssh-workspace.service');

    await expect(
      sshWorkspaceService.deleteWorkspace({
        kind: 'ssh',
        hostId: 'ssh-dev',
        remoteDirectory: '/tmp/outside',
        remoteRepoPath: '/home/devuser/.komla/repos/komla/repo.git',
        remoteProjectRoot: '/home/devuser/.komla/worktrees/komla',
        gitUrl: 'https://github.com/komla-dev/komla.git',
        projectName: 'komla',
        branchName: 'claude/outside',
        baseBranch: 'main',
      })
    ).rejects.toThrow('Refusing to delete remote workspace outside /home/devuser/.komla');
  });
});
