import { EventEmitter } from 'events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('child_process', () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));
vi.mock('../../../../src/main/lib/logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));
vi.mock('../../../../src/main/services/askpass.service', () => ({
  askpassService: {
    isRunning: vi.fn(() => false),
    getHelperScriptPath: vi.fn(),
    getSocketPath: vi.fn(),
    issueSession: vi.fn(),
  },
}));

describe('extractGitError', () => {
  it('translates git ENOENT process errors into an actionable message', async () => {
    const { extractGitError } = await import('../../../../src/main/services/git/git-exec');
    const error = Object.assign(new Error('spawn git ENOENT'), {
      code: 'ENOENT',
      path: 'git',
    });

    expect(extractGitError(error, 'Git command failed')).toBe(
      'Git executable not found. Install Git or restart Komla after updating PATH.'
    );
  });
});

/** Runs `fn` with process.platform reporting `platform`, on a fresh copy of the modules. */
async function onPlatform(platform: NodeJS.Platform, fn: () => Promise<void>): Promise<void> {
  const original = process.platform;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  vi.resetModules();
  try {
    await fn();
  } finally {
    Object.defineProperty(process, 'platform', { value: original, configurable: true });
  }
}

describe.skipIf(process.platform === 'win32')('buildGitEnv', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // The PATH an app launched from the Dock gets, and the order a terminal sets.
  it('puts the common git folders PATH lacks ahead of the system ones on macOS', async () => {
    await onPlatform('darwin', async () => {
      const { buildGitEnv } = await import('../../../../src/main/services/git/git-exec');
      vi.stubEnv('PATH', '/usr/bin:/bin:/usr/sbin:/sbin');
      expect(buildGitEnv().PATH).toBe(
        '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
      );

      vi.stubEnv('PATH', '/usr/bin:/bin:/opt/homebrew/bin');
      expect(buildGitEnv().PATH).toBe('/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin');

      vi.stubEnv('PATH', '/custom/bin');
      expect(buildGitEnv().PATH).toBe(
        '/custom/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'
      );
    });
  });

  it('adds them after a PATH set elsewhere', async () => {
    await onPlatform('linux', async () => {
      const { buildGitEnv } = await import('../../../../src/main/services/git/git-exec');
      vi.stubEnv('PATH', '/usr/bin:/bin');
      expect(buildGitEnv().PATH).toBe('/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin');
    });
  });
});

describe('GitExec.execGitWithProgress', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('rejects with the error Git printed, without progress and fetch report lines', async () => {
    const childProcess = await import('child_process');
    const { gitExec } = await import('../../../../src/main/services/git/git-exec');
    vi.mocked(childProcess.spawn).mockImplementation(() => {
      const proc = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
      });
      queueMicrotask(() => {
        proc.stderr.emit(
          'data',
          Buffer.from(
            [
              'remote: Enumerating objects: 6, done.        ',
              'remote: Counting objects:  50% (3/6)        \rremote: Counting objects: 100% (6/6), done.        ',
              'remote: Total 4 (delta 0), reused 0 (delta 0), pack-reused 0 (from 0)        ',
              'Unpacking objects:  50% (2/4)\rUnpacking objects: 100% (4/4), 1.02 KiB | 1.02 MiB/s, done.',
              'From github.com:komla-dev/komla',
              ' * branch            main       -> FETCH_HEAD',
              '   a17f94e..61ae3c9  main       -> origin/main',
              'Updating files:  50% (1/2)\rUpdating files: 100% (2/2), done.',
              'error: The following untracked working tree files would be overwritten by merge:',
              '\tg',
              'Aborting',
              '',
            ].join('\n')
          )
        );
        proc.emit('close', 1);
      });
      return proc as never;
    });

    await expect(gitExec.execGitWithProgress('/repo', ['pull', '--progress'])).rejects.toThrow(
      new Error(
        'error: The following untracked working tree files would be overwritten by merge:\n\tg\nAborting'
      )
    );
  });

  it('runs without any way to prompt and gives up on git after the timeout', async () => {
    vi.useFakeTimers();
    vi.stubEnv('SSH_ASKPASS', '/usr/bin/ssh-askpass');
    vi.stubEnv('GIT_ASKPASS', '/editor/askpass.sh');
    vi.stubEnv('GIT_SSH_COMMAND', '');
    vi.stubEnv('GIT_SSH', '');
    try {
      const childProcess = await import('child_process');
      const { gitExec } = await import('../../../../src/main/services/git/git-exec');
      const kill = vi.fn();
      vi.mocked(childProcess.spawn).mockImplementation(() => {
        const proc = Object.assign(new EventEmitter(), {
          stdout: new EventEmitter(),
          stderr: new EventEmitter(),
          // A child such as ssh keeps git's output open, so 'close' never comes.
          kill,
        });
        return proc as never;
      });

      const fetch = gitExec.execGitWithProgress('/repo', ['fetch', 'origin'], undefined, {
        noPrompts: { config: '' },
        timeoutMs: 1_000,
      });
      const rejected = expect(fetch).rejects.toThrow('Git took longer than 1000 ms');
      await vi.advanceTimersByTimeAsync(1_000);
      await rejected;

      expect(kill).toHaveBeenCalled();
      const env = vi.mocked(childProcess.spawn).mock.calls[0][2]!.env!;
      expect(env).toMatchObject({
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'never',
        SSH_ASKPASS_REQUIRE: 'never',
        GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=15',
      });
      expect(env).not.toHaveProperty('SSH_ASKPASS');
      expect(env).not.toHaveProperty('GIT_ASKPASS');
    } finally {
      vi.unstubAllEnvs();
      vi.useRealTimers();
    }
  });

  it('stops background git, running or queued, so other work goes ahead', async () => {
    const childProcess = await import('child_process');
    const { gitExec } = await import('../../../../src/main/services/git/git-exec');
    const procs: Array<EventEmitter & { kill: () => void }> = [];
    vi.mocked(childProcess.spawn).mockImplementation(() => {
      const proc = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        // Exits on kill, but an ssh child keeps git's output open, so 'close' never comes.
        kill: vi.fn(() => queueMicrotask(() => proc.emit('exit', null, 'SIGTERM'))),
      });
      procs.push(proc);
      return proc as never;
    });
    const fetch = (): Promise<string> =>
      gitExec.execGitWithProgress('/repo', ['fetch', 'origin'], undefined, {
        noPrompts: { config: '' },
        background: gitExec.backgroundMark('/repo'),
      });

    const running = fetch();
    await vi.waitFor(() => expect(procs).toHaveLength(1));
    const queued = fetch();
    gitExec.stopBackgroundWork('/repo');
    await expect(running).rejects.toThrow('stopped for other work');
    await expect(queued).rejects.toThrow('stopped for other work');
    expect(procs[0].kill).toHaveBeenCalled();
    // The queued fetch never started git.
    expect(procs).toHaveLength(1);

    const pull = gitExec.execGitWithProgress('/repo', ['pull']);
    await vi.waitFor(() => expect(procs).toHaveLength(2));
    procs[1].emit('close', 0);
    await expect(pull).resolves.toBe('');
  });

  it("doesn't start background work begun before a stop", async () => {
    const childProcess = await import('child_process');
    const { gitExec } = await import('../../../../src/main/services/git/git-exec');
    const mark = gitExec.backgroundMark('/repo');
    gitExec.stopBackgroundWork('/repo');

    await expect(
      gitExec.execGitWithProgress('/repo', ['fetch', 'origin'], undefined, { background: mark })
    ).rejects.toThrow('stopped for other work');
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  it('still gives up on stopped git at the timeout when it never exits', async () => {
    vi.useFakeTimers();
    try {
      const childProcess = await import('child_process');
      const { gitExec } = await import('../../../../src/main/services/git/git-exec');
      const kill = vi.fn();
      vi.mocked(childProcess.spawn).mockImplementation(
        () =>
          Object.assign(new EventEmitter(), {
            stdout: new EventEmitter(),
            stderr: new EventEmitter(),
            kill,
          }) as never
      );

      const fetch = gitExec.execGitWithProgress('/repo', ['fetch', 'origin'], undefined, {
        timeoutMs: 1_000,
        background: gitExec.backgroundMark('/repo'),
      });
      const rejected = expect(fetch).rejects.toThrow('Git took longer than 1000 ms');
      await vi.advanceTimersByTimeAsync(0);
      gitExec.stopBackgroundWork('/repo');
      expect(kill).toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves running git to finish on Windows, which would end it without its cleanup', async () => {
    await onPlatform('win32', async () => {
      vi.useFakeTimers();
      try {
        const childProcess = await import('child_process');
        const { gitExec } = await import('../../../../src/main/services/git/git-exec');
        const kill = vi.fn();
        let proc: EventEmitter | undefined;
        vi.mocked(childProcess.spawn).mockImplementation(() => {
          proc = Object.assign(new EventEmitter(), {
            stdout: new EventEmitter(),
            stderr: new EventEmitter(),
            kill,
          });
          return proc as never;
        });

        const fetch = gitExec.execGitWithProgress('C:\\repo', ['fetch', 'origin'], undefined, {
          timeoutMs: 1_000,
          background: gitExec.backgroundMark('C:\\repo'),
        });
        await vi.advanceTimersByTimeAsync(0);
        gitExec.stopBackgroundWork('C:\\repo');
        proc!.emit('exit', 0);
        proc!.emit('close', 0);
        await expect(fetch).resolves.toBe('');

        const slow = gitExec.execGitWithProgress('C:\\repo', ['fetch', 'origin'], undefined, {
          timeoutMs: 1_000,
        });
        const rejected = expect(slow).rejects.toThrow('Git took longer than 1000 ms');
        await vi.advanceTimersByTimeAsync(1_000);
        await rejected;
        expect(kill).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('leaves git nobody marked background running', async () => {
    const childProcess = await import('child_process');
    const { gitExec } = await import('../../../../src/main/services/git/git-exec');
    const kill = vi.fn();
    let proc: EventEmitter | undefined;
    vi.mocked(childProcess.spawn).mockImplementation(() => {
      proc = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill,
      });
      return proc as never;
    });

    const pull = gitExec.execGitWithProgress('/repo', ['pull']);
    await vi.waitFor(() => expect(proc).toBeDefined());
    gitExec.stopBackgroundWork('/repo');
    proc!.emit('close', 0);
    await expect(pull).resolves.toBe('');
    expect(kill).not.toHaveBeenCalled();
  });

  it('keeps an ssh command the user or the repository set when running without prompts', async () => {
    const { applyNoPromptEnv } = await import('../../../../src/main/services/git/git-exec');
    const custom: NodeJS.ProcessEnv = { GIT_SSH_COMMAND: 'ssh -i ~/.ssh/work' };
    applyNoPromptEnv(custom, '');
    expect(custom.GIT_SSH_COMMAND).toBe('ssh -i ~/.ssh/work');

    const configured: NodeJS.ProcessEnv = {};
    applyNoPromptEnv(configured, 'core.sshcommand\nssh -i ~/.ssh/work\0');
    expect(configured).not.toHaveProperty('GIT_SSH_COMMAND');

    // A repository can clear a global one.
    const cleared: NodeJS.ProcessEnv = {};
    applyNoPromptEnv(cleared, 'core.sshcommand\nssh -i ~/.ssh/work\0core.sshcommand\n\0');
    expect(cleared.GIT_SSH_COMMAND).toBe('ssh -o BatchMode=yes -o ConnectTimeout=15');
  });

  it('keeps only the credential helpers known never to open a dialog on Linux', async () => {
    await onPlatform('linux', async () => {
      const { quietCredentialHelperConfig } = await import(
        '../../../../src/main/services/git/git-exec'
      );
      const entries = [
        'core.sshcommand\nssh -i ~/.ssh/work',
        'credential.helper\nosxkeychain',
        'credential.helper\n/opt/homebrew/libexec/git-core/git-credential-osxkeychain',
        'credential.helper\n!git credential-osxkeychain',
        'credential.helper\nlibsecret',
        'credential.helper\nmanager',
        'credential.helper\n/some/pass-helper',
        'credential.helper\nstore --file ~/.git-credentials',
        'credential.helper\ncache --timeout=3600',
        'credential.https://github.com.helper\n',
        'credential.https://github.com.helper\n!/opt/homebrew/bin/gh auth git-credential',
        "credential.https://gist.github.com.helper\n!'/Program Files/GitHub CLI/gh.exe' auth git-credential",
        'credential.https://x.test.helper\n!gh auth git-credential; osxkeychain get',
        '',
      ].join('\0');

      expect(quietCredentialHelperConfig(entries)).toEqual([
        'credential.helper=',
        'credential.helper=store --file ~/.git-credentials',
        'credential.helper=cache --timeout=3600',
        'credential.https://github.com.helper=',
      ]);
      expect(quietCredentialHelperConfig('')).toEqual(['credential.helper=']);
      // Can't be handed over as key=value, so no helper runs.
      expect(quietCredentialHelperConfig('credential.https://x.test/?a=b.helper\nstore\0')).toEqual(
        ['credential.helper=']
      );
    });
  });

  it('keeps gh and Git Credential Manager on macOS and Windows, where they never ask to unlock', async () => {
    const entries = [
      'credential.helper\n/usr/local/share/gcm-core/git-credential-manager',
      'credential.helper\nmanager',
      'credential.helper\nwincred',
      'credential.https://github.com.helper\n!/opt/homebrew/bin/gh auth git-credential',
      "credential.https://gist.github.com.helper\n!'/Program Files/GitHub CLI/gh.exe' auth git-credential",
      'credential.https://x.test.helper\n!gh auth git-credential; osxkeychain get',
      '',
    ].join('\0');
    const gh = [
      'credential.https://github.com.helper=!/opt/homebrew/bin/gh auth git-credential',
      "credential.https://gist.github.com.helper=!'/Program Files/GitHub CLI/gh.exe' auth git-credential",
    ];
    await onPlatform('darwin', async () => {
      const { quietCredentialHelperConfig } = await import(
        '../../../../src/main/services/git/git-exec'
      );
      expect(quietCredentialHelperConfig(entries)).toEqual([
        'credential.helper=',
        'credential.helper=/usr/local/share/gcm-core/git-credential-manager',
        'credential.helper=manager',
        ...gh,
      ]);
    });
    await onPlatform('win32', async () => {
      const { quietCredentialHelperConfig } = await import(
        '../../../../src/main/services/git/git-exec'
      );
      expect(quietCredentialHelperConfig(entries)).toEqual([
        'credential.helper=',
        'credential.helper=/usr/local/share/gcm-core/git-credential-manager',
        'credential.helper=manager',
        'credential.helper=wincred',
        ...gh,
      ]);
    });
  });

  it('hands the helper settings to git after its own, quoted for GIT_CONFIG_PARAMETERS', async () => {
    const { applyNoPromptEnv } = await import('../../../../src/main/services/git/git-exec');
    const env: NodeJS.ProcessEnv = { GIT_CONFIG_PARAMETERS: "'core.fsmonitor=false'" };
    applyNoPromptEnv(env, "credential.helper\nstore --file it's\0");
    expect(env.GIT_CONFIG_PARAMETERS).toBe(
      "'core.fsmonitor=false' 'core.askPass=' 'credential.helper=' 'credential.helper=store --file it'\\''s'"
    );
  });

  it('falls back to what Git printed on stdout when stderr held only transfer output', async () => {
    const childProcess = await import('child_process');
    const { gitExec } = await import('../../../../src/main/services/git/git-exec');
    vi.mocked(childProcess.spawn).mockImplementation(() => {
      const proc = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
      });
      queueMicrotask(() => {
        proc.stderr.emit(
          'data',
          Buffer.from(
            'From github.com:komla-dev/komla\n * branch            main       -> FETCH_HEAD\n'
          )
        );
        proc.stdout.emit(
          'data',
          Buffer.from(
            'Auto-merging f\nAutomatic merge failed; fix conflicts and then commit the result.\n'
          )
        );
        proc.emit('close', 1);
      });
      return proc as never;
    });

    await expect(gitExec.execGitWithProgress('/repo', ['pull', '--progress'])).rejects.toThrow(
      new Error('Auto-merging f\nAutomatic merge failed; fix conflicts and then commit the result.')
    );
  });
});

describe('GitExec SSH passphrase prompts', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('GIT_SSH_COMMAND', '');
    vi.stubEnv('GIT_SSH', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('gives git an askpass session that checks which ssh git runs', async () => {
    const childProcess = await import('child_process');
    const { askpassService } = await import('../../../../src/main/services/askpass.service');
    const { gitExec } = await import('../../../../src/main/services/git/git-exec');
    vi.mocked(askpassService.isRunning).mockReturnValue(true);
    vi.mocked(askpassService.getHelperScriptPath).mockReturnValue('/tmp/askpass.sh');
    vi.mocked(askpassService.getSocketPath).mockReturnValue('/tmp/askpass.sock');
    vi.mocked(askpassService.issueSession).mockReturnValue('session-1');
    vi.mocked(childProcess.spawn).mockImplementation(() => {
      const proc = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
      });
      queueMicrotask(() => proc.emit('close', 0));
      return proc as never;
    });
    const gitConfig = (error: Error | null, stdout = '') =>
      vi
        .mocked(childProcess.execFile)
        .mockImplementationOnce(((
          _file: string,
          _args: string[],
          _options: unknown,
          callback: (error: Error | null, stdout: string, stderr: string) => void
        ) => callback(error, stdout, '')) as never);

    await gitExec.execGitWithProgress('/repo', ['fetch'], undefined, { enableAskpass: true });

    expect(vi.mocked(childProcess.spawn).mock.calls[0][2]?.env).toMatchObject({
      SSH_ASKPASS: '/tmp/askpass.sh',
      KOMLA_ASKPASS_SOCKET: '/tmp/askpass.sock',
      KOMLA_ASKPASS_SESSION: 'session-1',
    });
    const usesPathSsh = vi.mocked(askpassService.issueSession).mock.calls[0][0];
    gitConfig(Object.assign(new Error('unset'), { code: 1 }));
    await expect(usesPathSsh?.()).resolves.toBe(true);
    gitConfig(null, 'ssh -F ~/.ssh/work_config\n');
    await expect(usesPathSsh?.()).resolves.toBe(false);
    expect(childProcess.execFile).toHaveBeenLastCalledWith(
      'git',
      ['config', '--get', 'core.sshCommand'],
      expect.objectContaining({ cwd: '/repo' }),
      expect.any(Function)
    );
  });

  it('does not treat git as running the ssh on PATH when told to run another', async () => {
    const { gitUsesPathSsh } = await import('../../../../src/main/services/git/git-exec');

    await expect(gitUsesPathSsh({ GIT_SSH_COMMAND: 'ssh -i ~/.ssh/deploy' })).resolves.toBe(false);
    await expect(gitUsesPathSsh({ GIT_SSH: '/usr/bin/plink' })).resolves.toBe(false);

    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      await expect(gitUsesPathSsh({})).resolves.toBe(false);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });
});

describe('GitExec cache invalidation', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('invalidateCache clears entries matching a key prefix', async () => {
    const { gitExec } = await import('../../../../src/main/services/git/git-exec');

    gitExec.setCache('currentBranch:/repo', 'feature');
    gitExec.setCache('currentBranch:/other', 'main');
    gitExec.setCache('hasUncommittedChanges:/repo', true);

    gitExec.invalidateCache('currentBranch:/repo');

    expect(gitExec.getCached('currentBranch:/repo')).toBeUndefined();
    expect(gitExec.getCached('currentBranch:/other')).toBe('main');
    expect(gitExec.getCached('hasUncommittedChanges:/repo')).toBe(true);
  });

  it('invalidateCache with no prefix clears all entries', async () => {
    const { gitExec } = await import('../../../../src/main/services/git/git-exec');

    gitExec.setCache('currentBranch:/repo', 'feature');
    gitExec.setCache('hasUncommittedChanges:/repo', true);

    gitExec.invalidateCache();

    expect(gitExec.getCached('currentBranch:/repo')).toBeUndefined();
    expect(gitExec.getCached('hasUncommittedChanges:/repo')).toBeUndefined();
  });
});

describe('GitExec.resolvePublishedCommit', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the exact commit from the selected origin branch', async () => {
    const { gitExec } = await import('../../../../src/main/services/git/git-exec');
    const execSpy = vi.spyOn(gitExec, 'execGitAsync').mockResolvedValueOnce('0123456789abcdef');
    const fetchSpy = vi.spyOn(gitExec, 'execGitWithProgress').mockResolvedValue('');

    await expect(gitExec.resolvePublishedCommit('/repo', 'main')).resolves.toBe('0123456789abcdef');
    expect(execSpy).toHaveBeenCalledWith('/repo', [
      'rev-parse',
      '--verify',
      'refs/remotes/origin/main^{commit}',
    ]);
    expect(fetchSpy).toHaveBeenCalledWith(
      '/repo',
      ['fetch', 'origin', '+refs/heads/*:refs/remotes/origin/*', '--prune'],
      undefined,
      { enableAskpass: true }
    );
    execSpy.mockRestore();
    fetchSpy.mockRestore();
  });

  it('refreshes an existing origin ref before resolving it', async () => {
    const { gitExec } = await import('../../../../src/main/services/git/git-exec');
    const execSpy = vi.spyOn(gitExec, 'execGitAsync').mockResolvedValueOnce('fresh-commit');
    const fetchSpy = vi.spyOn(gitExec, 'execGitWithProgress').mockResolvedValue('');

    await expect(gitExec.resolvePublishedCommit('/repo', 'main')).resolves.toBe('fresh-commit');
    expect(fetchSpy).toHaveBeenCalledWith(
      '/repo',
      ['fetch', 'origin', '+refs/heads/*:refs/remotes/origin/*', '--prune'],
      undefined,
      { enableAskpass: true }
    );
    expect(fetchSpy.mock.invocationCallOrder[0]).toBeLessThan(execSpy.mock.invocationCallOrder[0]);
    execSpy.mockRestore();
    fetchSpy.mockRestore();
  });

  it('accepts an origin-qualified branch name', async () => {
    const { gitExec } = await import('../../../../src/main/services/git/git-exec');
    const execSpy = vi.spyOn(gitExec, 'execGitAsync').mockResolvedValueOnce('0123456789abcdef');
    const fetchSpy = vi.spyOn(gitExec, 'execGitWithProgress').mockResolvedValue('');

    await expect(gitExec.resolvePublishedCommit('/repo', 'origin/release')).resolves.toBe(
      '0123456789abcdef'
    );
    expect(execSpy).toHaveBeenCalledWith('/repo', [
      'rev-parse',
      '--verify',
      'refs/remotes/origin/release^{commit}',
    ]);
    execSpy.mockRestore();
    fetchSpy.mockRestore();
  });

  it('rejects a local-only revision', async () => {
    const { gitExec } = await import('../../../../src/main/services/git/git-exec');
    const execSpy = vi
      .spyOn(gitExec, 'execGitAsync')
      .mockRejectedValue(new Error('unknown revision'));
    const fetchSpy = vi.spyOn(gitExec, 'execGitWithProgress').mockResolvedValue('');

    await expect(gitExec.resolvePublishedCommit('/repo', 'feature/local')).rejects.toThrow(
      'has not been pushed to origin'
    );
    expect(fetchSpy).toHaveBeenCalledOnce();
    execSpy.mockRestore();
    fetchSpy.mockRestore();
  });

  it('reports origin refresh failures separately from unpublished revisions', async () => {
    const { gitExec } = await import('../../../../src/main/services/git/git-exec');
    const execSpy = vi.spyOn(gitExec, 'execGitAsync');
    const fetchSpy = vi
      .spyOn(gitExec, 'execGitWithProgress')
      .mockRejectedValue(new Error('Authentication failed'));

    await expect(gitExec.resolvePublishedCommit('/repo', 'main')).rejects.toThrow(
      'Could not verify whether selected revision "main" is available on origin: Authentication failed'
    );
    expect(execSpy).not.toHaveBeenCalled();
    execSpy.mockRestore();
    fetchSpy.mockRestore();
  });
});

describe('GitService.invalidateBranchCache', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('invalidates both currentBranch and hasUncommittedChanges caches', async () => {
    const { gitExec } = await import('../../../../src/main/services/git/git-exec');
    const { gitService } = await import('../../../../src/main/services/git/index');

    const repoPath = '/repo';

    // Seed caches
    gitExec.setCache(`currentBranch:${repoPath}`, 'old-branch', 30000);
    gitExec.setCache(`hasUncommittedChanges:${repoPath}`, true, 2000);
    gitExec.setCache(`mainBranch:${repoPath}`, 'main', 30000);

    // Verify caches exist before invalidation
    expect(gitExec.getCached(`currentBranch:${repoPath}`)).toBe('old-branch');
    expect(gitExec.getCached(`hasUncommittedChanges:${repoPath}`)).toBe(true);
    expect(gitExec.getCached(`mainBranch:${repoPath}`)).toBe('main');

    // Call invalidateBranchCache
    gitService.invalidateBranchCache(repoPath);

    // currentBranch and hasUncommittedChanges should be cleared
    expect(gitExec.getCached(`currentBranch:${repoPath}`)).toBeUndefined();
    expect(gitExec.getCached(`hasUncommittedChanges:${repoPath}`)).toBeUndefined();

    // mainBranch should NOT be cleared (not part of invalidateBranchCache)
    expect(gitExec.getCached(`mainBranch:${repoPath}`)).toBe('main');
  });

  it('does not affect caches for other repo paths', async () => {
    const { gitExec } = await import('../../../../src/main/services/git/git-exec');
    const { gitService } = await import('../../../../src/main/services/git/index');

    gitExec.setCache('currentBranch:/repo-a', 'feature-a', 30000);
    gitExec.setCache('hasUncommittedChanges:/repo-a', true, 2000);
    gitExec.setCache('currentBranch:/repo-b', 'feature-b', 30000);
    gitExec.setCache('hasUncommittedChanges:/repo-b', false, 2000);

    gitService.invalidateBranchCache('/repo-a');

    expect(gitExec.getCached('currentBranch:/repo-a')).toBeUndefined();
    expect(gitExec.getCached('hasUncommittedChanges:/repo-a')).toBeUndefined();

    // repo-b untouched
    expect(gitExec.getCached('currentBranch:/repo-b')).toBe('feature-b');
    expect(gitExec.getCached('hasUncommittedChanges:/repo-b')).toBe(false);
  });
});
