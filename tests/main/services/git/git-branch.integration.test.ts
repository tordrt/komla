import { execFile } from 'child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { createServer } from 'http';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileAsync = promisify(execFile);

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
  },
}));

async function runGit(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd: repoPath,
    encoding: 'utf-8',
  });
  return stdout.trim();
}

describe('GitBranchService integration', () => {
  let repoPath: string;

  beforeEach(async () => {
    vi.resetModules();
    repoPath = mkdtempSync(join(tmpdir(), 'komla-git-branch-'));

    await runGit(repoPath, ['init']);
    await runGit(repoPath, ['config', 'user.name', 'Komla Test']);
    await runGit(repoPath, ['config', 'user.email', 'komla@example.com']);
    await runGit(repoPath, ['config', 'core.autocrlf', 'false']);
    writeFileSync(join(repoPath, 'conflict.txt'), 'base\n');
    writeFileSync(join(repoPath, 'local.txt'), 'committed\n');
    await runGit(repoPath, ['add', '.']);
    await runGit(repoPath, ['commit', '-m', 'initial']);
  });

  afterEach(() => {
    rmSync(repoPath, { recursive: true, force: true });
  });

  it('creates a branch whose name looks like an option, rather than running that option', async () => {
    const baseBranch = await runGit(repoPath, ['branch', '--show-current']);
    await runGit(repoPath, ['config', `branch.${baseBranch}.remote`, 'origin']);
    await runGit(repoPath, ['config', `branch.${baseBranch}.merge`, `refs/heads/${baseBranch}`]);
    const { gitBranchService } = await import('../../../../src/main/services/git/git-branch');

    await expect(gitBranchService.createBranch(repoPath, '--unset-upstream')).rejects.toThrow(
      /not a valid branch name/
    );

    expect(await runGit(repoPath, ['config', `branch.${baseBranch}.merge`])).toBe(
      `refs/heads/${baseBranch}`
    );
  });

  it("creates a branch from origin's copy of a start point the clone has no branch for, untracked", async () => {
    await runGit(repoPath, ['branch', 'develop']);
    const clonePath = mkdtempSync(join(tmpdir(), 'komla-git-branch-clone-'));
    try {
      await execFileAsync('git', ['clone', '--quiet', repoPath, clonePath]);
      const { gitBranchService } = await import('../../../../src/main/services/git/git-branch');

      await gitBranchService.createBranch(
        clonePath,
        'release',
        await gitBranchService.resolveStartRef(clonePath, 'develop')
      );

      expect(await runGit(clonePath, ['rev-parse', 'release'])).toBe(
        await runGit(clonePath, ['rev-parse', 'origin/develop'])
      );
      await expect(runGit(clonePath, ['config', 'branch.release.merge'])).rejects.toThrow();
    } finally {
      rmSync(clonePath, { recursive: true, force: true });
    }
  });

  it('fetches a branch from origin and returns it as a start point', async () => {
    const baseBranch = await runGit(repoPath, ['branch', '--show-current']);
    const clonePath = mkdtempSync(join(tmpdir(), 'komla-git-branch-clone-'));
    try {
      await execFileAsync('git', ['clone', '--quiet', repoPath, clonePath]);
      writeFileSync(join(repoPath, 'local.txt'), 'pushed later\n');
      await runGit(repoPath, ['commit', '-am', 'upstream change']);
      const upstreamHead = await runGit(repoPath, ['rev-parse', 'HEAD']);

      const { gitBranchService } = await import('../../../../src/main/services/git/git-branch');

      await expect(gitBranchService.fetchOriginStartPoint(clonePath, baseBranch)).resolves.toBe(
        `origin/${baseBranch}`
      );
      expect(await runGit(clonePath, ['rev-parse', `origin/${baseBranch}`])).toBe(upstreamHead);
      await expect(
        gitBranchService.fetchOriginStartPoint(clonePath, 'missing-branch')
      ).resolves.toBeUndefined();
      await expect(
        gitBranchService.fetchOriginStartPoint(repoPath, baseBranch)
      ).resolves.toBeUndefined();
    } finally {
      rmSync(clonePath, { recursive: true, force: true });
    }
  });

  it('fetches origin without prompts into a clone and a managed bare clone', async () => {
    const baseBranch = await runGit(repoPath, ['branch', '--show-current']);
    const clonePath = mkdtempSync(join(tmpdir(), 'komla-git-branch-clone-'));
    const barePath = mkdtempSync(join(tmpdir(), 'komla-git-branch-bare-'));
    try {
      await execFileAsync('git', ['clone', '--quiet', repoPath, clonePath]);
      await execFileAsync('git', ['clone', '--quiet', '--bare', repoPath, barePath]);
      writeFileSync(join(repoPath, 'local.txt'), 'pushed later\n');
      await runGit(repoPath, ['commit', '-am', 'upstream change']);
      const upstreamHead = await runGit(repoPath, ['rev-parse', 'HEAD']);

      const { gitBranchService } = await import('../../../../src/main/services/git/git-branch');

      await gitBranchService.fetchOriginWithoutPrompts(clonePath, false, 30_000, 0);
      await gitBranchService.fetchOriginWithoutPrompts(barePath, true, 30_000, 0);

      expect(await runGit(clonePath, ['rev-parse', `origin/${baseBranch}`])).toBe(upstreamHead);
      expect(await runGit(barePath, ['rev-parse', `refs/remotes/origin/${baseBranch}`])).toBe(
        upstreamHead
      );
    } finally {
      rmSync(clonePath, { recursive: true, force: true });
      rmSync(barePath, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')(
    'fetches origin without the credential helpers that open a dialog',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'komla-git-branch-helpers-'));
      const server = createServer((_req, res) => {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="test"' }).end();
      });
      try {
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/repo.git`;
        const clonePath = join(root, 'clone');
        await execFileAsync('git', ['clone', '--quiet', repoPath, clonePath]);
        await runGit(clonePath, ['remote', 'set-url', 'origin', url]);
        const keychain = join(root, 'git-credential-osxkeychain');
        writeFileSync(keychain, `#!/bin/sh\ntouch "${root}/keychain-ran"\n`);
        chmodSync(keychain, 0o755);
        await runGit(clonePath, ['config', '--add', 'credential.helper', keychain]);
        // git erases a login the server turns down from the store that gave it.
        const store = join(root, 'credentials');
        writeFileSync(store, `${url.replace('//', '//u:p@')}\n`);
        await runGit(clonePath, [
          'config',
          '--add',
          `credential.${url}.helper`,
          `store --file ${store}`,
        ]);

        const { gitBranchService } = await import('../../../../src/main/services/git/git-branch');
        await expect(
          gitBranchService.fetchOriginWithoutPrompts(clonePath, false, 30_000, 0)
        ).rejects.toThrow();

        expect(existsSync(join(root, 'keychain-ran'))).toBe(false);
        expect(readFileSync(store, 'utf8')).toBe('');
      } finally {
        server.close();
        rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it.skipIf(process.platform === 'win32')(
    "doesn't run an askpass program from config when fetching without prompts",
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'komla-git-branch-askpass-'));
      const server = createServer((_req, res) => {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="test"' }).end();
      });
      try {
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/repo.git`;
        const clonePath = join(root, 'clone');
        await execFileAsync('git', ['clone', '--quiet', repoPath, clonePath]);
        await runGit(clonePath, ['remote', 'set-url', 'origin', url]);
        const askpass = join(root, 'askpass.sh');
        writeFileSync(askpass, `#!/bin/sh\ntouch "${root}/askpass-ran"\necho secret\n`);
        chmodSync(askpass, 0o755);
        await runGit(clonePath, ['config', 'core.askPass', askpass]);

        const { gitBranchService } = await import('../../../../src/main/services/git/git-branch');
        await expect(
          gitBranchService.fetchOriginWithoutPrompts(clonePath, false, 30_000, 0)
        ).rejects.toThrow();

        expect(existsSync(join(root, 'askpass-ran'))).toBe(false);
      } finally {
        server.close();
        rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it.skipIf(process.platform === 'win32')(
    'stops a hanging background fetch so the git work behind it runs',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'komla-git-branch-stop-'));
      // Accepts the request and never answers, like a stalled network or an unanswered prompt.
      const server = createServer(() => {});
      try {
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/repo.git`;
        const clonePath = join(root, 'clone');
        await execFileAsync('git', ['clone', '--quiet', repoPath, clonePath]);
        await runGit(clonePath, ['remote', 'set-url', 'origin', url]);
        const requested = new Promise((resolve) => server.once('request', resolve));

        const { gitBranchService } = await import('../../../../src/main/services/git/git-branch');
        const { gitExec } = await import('../../../../src/main/services/git/git-exec');
        const fetch = gitBranchService.fetchOriginWithoutPrompts(clonePath, false, 30_000, 0);
        await requested;
        const started = Date.now();
        gitExec.stopBackgroundWork(clonePath);
        await expect(fetch).rejects.toThrow('stopped for other work');
        await gitExec.execGitWithProgress(clonePath, ['fetch', repoPath]);
        expect(Date.now() - started).toBeLessThan(5_000);
      } finally {
        server.closeAllConnections();
        server.close();
        rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it('keeps the local branch as the start point when it has unpushed commits', async () => {
    const baseBranch = await runGit(repoPath, ['branch', '--show-current']);
    const clonePath = mkdtempSync(join(tmpdir(), 'komla-git-branch-clone-'));
    try {
      await execFileAsync('git', ['clone', '--quiet', repoPath, clonePath]);
      await runGit(clonePath, ['config', 'user.name', 'Komla Test']);
      await runGit(clonePath, ['config', 'user.email', 'komla@example.com']);
      writeFileSync(join(clonePath, 'local.txt'), 'not pushed yet\n');
      await runGit(clonePath, ['commit', '-am', 'unpushed change']);

      const { gitBranchService } = await import('../../../../src/main/services/git/git-branch');

      await expect(
        gitBranchService.fetchOriginStartPoint(clonePath, baseBranch)
      ).resolves.toBeUndefined();

      writeFileSync(join(repoPath, 'conflict.txt'), 'pushed by someone else\n');
      await runGit(repoPath, ['commit', '-am', 'upstream change']);
      await expect(
        gitBranchService.fetchOriginStartPoint(clonePath, baseBranch)
      ).resolves.toBeUndefined();
    } finally {
      rmSync(clonePath, { recursive: true, force: true });
    }
  });

  it('aborts a real merge conflict and restores saved local changes', async () => {
    const baseBranch = await runGit(repoPath, ['branch', '--show-current']);
    await runGit(repoPath, ['checkout', '-b', 'topic']);
    writeFileSync(join(repoPath, 'conflict.txt'), 'topic\n');
    await runGit(repoPath, ['commit', '-am', 'topic change']);

    await runGit(repoPath, ['checkout', baseBranch]);
    writeFileSync(join(repoPath, 'conflict.txt'), 'base branch\n');
    await runGit(repoPath, ['commit', '-am', 'base change']);
    writeFileSync(join(repoPath, 'local.txt'), 'local work\n');

    const { gitBranchService } = await import('../../../../src/main/services/git/git-branch');
    const result = await gitBranchService.mergeFrom(repoPath, 'topic', { stash: true });

    expect(result.success).toBe(false);
    expect(result.message).toContain('was aborted');
    expect(result.message).not.toContain('safely');
    expect(result.message).toContain('saved local changes were restored');
    expect(readFileSync(join(repoPath, 'local.txt'), 'utf8')).toBe('local work\n');
    await expect(runGit(repoPath, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).rejects.toThrow();
  });

  it('aborts a real rebase conflict and restores saved local changes', async () => {
    const baseBranch = await runGit(repoPath, ['branch', '--show-current']);
    await runGit(repoPath, ['checkout', '-b', 'topic']);
    writeFileSync(join(repoPath, 'conflict.txt'), 'topic\n');
    await runGit(repoPath, ['commit', '-am', 'topic change']);

    await runGit(repoPath, ['checkout', baseBranch]);
    writeFileSync(join(repoPath, 'conflict.txt'), 'base branch\n');
    await runGit(repoPath, ['commit', '-am', 'base change']);
    await runGit(repoPath, ['checkout', 'topic']);
    writeFileSync(join(repoPath, 'local.txt'), 'local work\n');

    const { gitBranchService } = await import('../../../../src/main/services/git/git-branch');
    const result = await gitBranchService.rebaseOnBranch(repoPath, baseBranch, { stash: true });

    expect(result.success).toBe(false);
    expect(result.message).toContain('was aborted');
    expect(result.message).not.toContain('safely');
    expect(result.message).toContain('saved local changes were restored');
    expect(await runGit(repoPath, ['branch', '--show-current'])).toBe('topic');
    expect(readFileSync(join(repoPath, 'local.txt'), 'utf8')).toBe('local work\n');
  });

  async function createTopicBehindFetchedTarget(): Promise<string> {
    await runGit(repoPath, ['branch', '-M', 'main']);
    const localTargetCommit = await runGit(repoPath, ['rev-parse', 'HEAD']);
    for (const name of ['remote-one', 'remote-two']) {
      writeFileSync(join(repoPath, `${name}.txt`), `${name}\n`);
      await runGit(repoPath, ['add', `${name}.txt`]);
      await runGit(repoPath, ['commit', '-m', name]);
    }
    await runGit(repoPath, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    await runGit(repoPath, ['reset', '--hard', localTargetCommit]);
    await runGit(repoPath, ['checkout', '-b', 'topic']);
    writeFileSync(join(repoPath, 'topic.txt'), 'topic\n');
    await runGit(repoPath, ['add', 'topic.txt']);
    await runGit(repoPath, ['commit', '-m', 'topic']);
    return localTargetCommit;
  }

  it('fast-forwards a behind target and rebases onto it', async () => {
    await createTopicBehindFetchedTarget();

    const { gitBranchService } = await import('../../../../src/main/services/git/git-branch');
    expect(await gitBranchService.getBranchQuickStatus(repoPath)).toMatchObject({
      behindTargetBranch: 2,
    });

    const result = await gitBranchService.rebaseOnTargetBranch(repoPath);

    expect(result).toEqual({ success: true, message: 'Rebased on main successfully' });
    expect(await runGit(repoPath, ['rev-list', '--count', 'HEAD..origin/main'])).toBe('0');
    expect(await runGit(repoPath, ['rev-parse', 'main'])).toBe(
      await runGit(repoPath, ['rev-parse', 'origin/main'])
    );
  });

  it('fast-forwards a behind target and merges it', async () => {
    await createTopicBehindFetchedTarget();

    const { gitBranchService } = await import('../../../../src/main/services/git/git-branch');
    const result = await gitBranchService.mergeFrom(repoPath, 'main');

    expect(result).toEqual({ success: true, message: 'Merged main successfully' });
    expect(await runGit(repoPath, ['rev-list', '--count', 'HEAD..origin/main'])).toBe('0');
    expect(await runGit(repoPath, ['log', '-1', '--format=%s'])).toBe(
      "Merge branch 'main' into topic"
    );
    expect(await runGit(repoPath, ['rev-parse', 'main'])).toBe(
      await runGit(repoPath, ['rev-parse', 'origin/main'])
    );
  });

  it('rebases onto a target that only origin has', async () => {
    const baseCommit = await runGit(repoPath, ['rev-parse', 'HEAD']);
    writeFileSync(join(repoPath, 'develop.txt'), 'develop\n');
    await runGit(repoPath, ['add', 'develop.txt']);
    await runGit(repoPath, ['commit', '-m', 'develop']);
    await runGit(repoPath, ['update-ref', 'refs/remotes/origin/develop', 'HEAD']);
    await runGit(repoPath, ['reset', '--hard', baseCommit]);
    await runGit(repoPath, ['checkout', '-b', 'topic']);
    writeFileSync(join(repoPath, 'topic.txt'), 'topic\n');
    await runGit(repoPath, ['add', 'topic.txt']);
    await runGit(repoPath, ['commit', '-m', 'topic']);

    const { gitExec } = await import('../../../../src/main/services/git/git-exec');
    const { gitBranchService } = await import('../../../../src/main/services/git/git-branch');
    gitExec.registerTargetBranch(repoPath, 'develop');
    expect(await gitBranchService.getBranchQuickStatus(repoPath)).toMatchObject({
      behindTargetBranch: 1,
    });

    const result = await gitBranchService.rebaseOnTargetBranch(repoPath);

    expect(result).toEqual({ success: true, message: 'Rebased on develop successfully' });
    expect(await runGit(repoPath, ['rev-list', '--count', 'HEAD..origin/develop'])).toBe('0');
  });

  it('fast-forwards a target that only origin has, from origin rather than a same-named branch', async () => {
    const baseCommit = await runGit(repoPath, ['rev-parse', 'HEAD']);
    await runGit(repoPath, ['checkout', '-b', 'origin/develop']);
    writeFileSync(join(repoPath, 'stray.txt'), 'stray\n');
    await runGit(repoPath, ['add', 'stray.txt']);
    await runGit(repoPath, ['commit', '-m', 'stray']);
    await runGit(repoPath, ['checkout', '--detach', baseCommit]);
    writeFileSync(join(repoPath, 'develop.txt'), 'develop\n');
    await runGit(repoPath, ['add', 'develop.txt']);
    await runGit(repoPath, ['commit', '-m', 'develop']);
    await runGit(repoPath, ['update-ref', 'refs/remotes/origin/develop', 'HEAD']);
    await runGit(repoPath, ['checkout', '-b', 'topic']);
    writeFileSync(join(repoPath, 'topic.txt'), 'topic\n');
    await runGit(repoPath, ['add', 'topic.txt']);
    await runGit(repoPath, ['commit', '-m', 'topic']);

    const { gitExec } = await import('../../../../src/main/services/git/git-exec');
    const { gitBranchService } = await import('../../../../src/main/services/git/git-branch');
    gitExec.registerTargetBranch(repoPath, 'develop');

    const result = await gitBranchService.mergeToTargetBranch(repoPath);

    expect(result).toEqual({ success: true, message: 'Fast-forwarded develop to topic' });
    expect(await runGit(repoPath, ['rev-parse', 'develop'])).toBe(
      await runGit(repoPath, ['rev-parse', 'topic'])
    );
  });

  it("reports why a target only origin has can't be created", async () => {
    await runGit(repoPath, ['update-ref', 'refs/remotes/origin/develop', 'HEAD']);
    // A branch under develop/ keeps git from creating develop itself.
    await runGit(repoPath, ['branch', 'develop/blocker']);
    await runGit(repoPath, ['checkout', '-b', 'topic']);
    writeFileSync(join(repoPath, 'topic.txt'), 'topic\n');
    await runGit(repoPath, ['add', 'topic.txt']);
    await runGit(repoPath, ['commit', '-m', 'topic']);

    const { gitExec } = await import('../../../../src/main/services/git/git-exec');
    const { gitBranchService } = await import('../../../../src/main/services/git/git-branch');
    gitExec.registerTargetBranch(repoPath, 'develop');

    const result = await gitBranchService.mergeToTargetBranch(repoPath);

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/develop/);
    await expect(
      runGit(repoPath, ['rev-parse', '--verify', 'refs/heads/develop'])
    ).rejects.toThrow();
  });

  it('merges the fetched target without moving a checked-out target', async () => {
    const localTargetCommit = await createTopicBehindFetchedTarget();
    const targetPath = mkdtempSync(join(tmpdir(), 'komla-git-branch-main-'));
    rmSync(targetPath, { recursive: true });
    await runGit(repoPath, ['worktree', 'add', targetPath, 'main']);

    try {
      const { gitBranchService } = await import('../../../../src/main/services/git/git-branch');
      const result = await gitBranchService.mergeFrom(repoPath, 'main');

      expect(result).toEqual({ success: true, message: 'Merged main successfully' });
      expect(await runGit(repoPath, ['log', '-1', '--format=%s'])).toBe(
        "Merge remote-tracking branch 'origin/main' into topic"
      );
      expect(await runGit(targetPath, ['rev-parse', 'HEAD'])).toBe(localTargetCommit);
    } finally {
      rmSync(targetPath, { recursive: true, force: true });
    }
  });

  it('rebases onto the fetched target without moving a checked-out target', async () => {
    const localTargetCommit = await createTopicBehindFetchedTarget();
    const targetPath = mkdtempSync(join(tmpdir(), 'komla-git-branch-main-'));
    rmSync(targetPath, { recursive: true });
    await runGit(repoPath, ['worktree', 'add', targetPath, 'main']);

    try {
      const { gitBranchService } = await import('../../../../src/main/services/git/git-branch');
      const result = await gitBranchService.rebaseOnTargetBranch(repoPath);

      expect(result).toEqual({ success: true, message: 'Rebased on main successfully' });
      expect(await runGit(repoPath, ['rev-list', '--count', 'HEAD..origin/main'])).toBe('0');
      expect(await runGit(targetPath, ['rev-parse', 'HEAD'])).toBe(localTargetCommit);
      expect(await runGit(targetPath, ['status', '--porcelain'])).toBe('');
    } finally {
      rmSync(targetPath, { recursive: true, force: true });
    }
  });

  it('stashes through the git service when rebasing onto a branch', async () => {
    const baseBranch = await runGit(repoPath, ['branch', '--show-current']);
    await runGit(repoPath, ['checkout', '-b', 'topic']);
    await runGit(repoPath, ['checkout', baseBranch]);
    writeFileSync(join(repoPath, 'base.txt'), 'base\n');
    await runGit(repoPath, ['add', 'base.txt']);
    await runGit(repoPath, ['commit', '-m', 'base']);
    await runGit(repoPath, ['checkout', 'topic']);
    writeFileSync(join(repoPath, 'local.txt'), 'uncommitted\n');

    const { gitService } = await import('../../../../src/main/services/git');
    const result = await gitService.rebaseOnBranch(repoPath, baseBranch, { stash: true });

    expect(result).toEqual({ success: true, message: `Rebased on ${baseBranch} successfully` });
    expect(readFileSync(join(repoPath, 'local.txt'), 'utf8')).toBe('uncommitted\n');
  });

  it('reports a paused rebase in branch status until it is aborted', async () => {
    const baseBranch = await runGit(repoPath, ['branch', '--show-current']);
    await runGit(repoPath, ['checkout', '-b', 'topic']);
    writeFileSync(join(repoPath, 'conflict.txt'), 'topic\n');
    await runGit(repoPath, ['commit', '-am', 'topic change']);
    const topicHead = await runGit(repoPath, ['rev-parse', 'HEAD']);

    await runGit(repoPath, ['checkout', baseBranch]);
    writeFileSync(join(repoPath, 'conflict.txt'), 'base branch\n');
    await runGit(repoPath, ['commit', '-am', 'base change']);
    await runGit(repoPath, ['checkout', 'topic']);

    const { gitBranchService } = await import('../../../../src/main/services/git/git-branch');
    expect((await gitBranchService.getBranchQuickStatus(repoPath)).rebaseInProgress).toBe(false);

    const rebase = await gitBranchService.rebaseOnBranch(repoPath, baseBranch);
    expect(rebase.message).toContain('paused');
    expect(await gitBranchService.getBranchQuickStatus(repoPath)).toMatchObject({
      rebaseInProgress: true,
      currentBranch: 'HEAD',
    });

    const abort = await gitBranchService.abortRebase(repoPath);

    expect(abort).toEqual({ success: true, message: 'Rebase aborted. topic was restored.' });
    expect((await gitBranchService.getBranchQuickStatus(repoPath)).rebaseInProgress).toBe(false);
    expect(await runGit(repoPath, ['branch', '--show-current'])).toBe('topic');
    expect(await runGit(repoPath, ['rev-parse', 'HEAD'])).toBe(topicHead);
    expect(await runGit(repoPath, ['status', '--porcelain'])).toBe('');
  });

  it('refuses to merge a paused rebase into the target branch', async () => {
    await runGit(repoPath, ['branch', '-M', 'main']);
    await runGit(repoPath, ['checkout', '-b', 'topic']);
    writeFileSync(join(repoPath, 'topic.txt'), 'topic\n');
    await runGit(repoPath, ['add', 'topic.txt']);
    await runGit(repoPath, ['commit', '-m', 'clean topic change']);
    writeFileSync(join(repoPath, 'conflict.txt'), 'topic\n');
    await runGit(repoPath, ['commit', '-am', 'conflicting topic change']);

    await runGit(repoPath, ['checkout', 'main']);
    writeFileSync(join(repoPath, 'conflict.txt'), 'main\n');
    await runGit(repoPath, ['commit', '-am', 'main change']);
    const mainHead = await runGit(repoPath, ['rev-parse', 'main']);
    await runGit(repoPath, ['checkout', 'topic']);

    const { gitBranchService } = await import('../../../../src/main/services/git/git-branch');
    const rebase = await gitBranchService.rebaseOnBranch(repoPath, 'main');
    expect(rebase.message).toContain('paused');

    const result = await gitBranchService.mergeToTargetBranch(repoPath);

    expect(result).toEqual({
      success: false,
      message: 'Finish or abort the rebase in progress before fast-forwarding main',
    });
    expect(await runGit(repoPath, ['rev-parse', 'main'])).toBe(mainHead);
  });

  it('does not report a paused git am session as a rebase', async () => {
    const baseBranch = await runGit(repoPath, ['branch', '--show-current']);
    await runGit(repoPath, ['checkout', '-b', 'topic']);
    writeFileSync(join(repoPath, 'conflict.txt'), 'topic\n');
    await runGit(repoPath, ['commit', '-am', 'topic change']);
    const patch = await runGit(repoPath, ['format-patch', '-1', '-o', repoPath]);

    await runGit(repoPath, ['checkout', baseBranch]);
    writeFileSync(join(repoPath, 'conflict.txt'), 'base branch\n');
    await runGit(repoPath, ['commit', '-am', 'base change']);
    await expect(runGit(repoPath, ['am', patch])).rejects.toThrow();

    const { gitBranchService } = await import('../../../../src/main/services/git/git-branch');

    expect((await gitBranchService.getBranchQuickStatus(repoPath)).rebaseInProgress).toBe(false);
  });

  it('reports a failed abort when no rebase is in progress', async () => {
    const { gitBranchService } = await import('../../../../src/main/services/git/git-branch');

    const result = await gitBranchService.abortRebase(repoPath);

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/no rebase in progress/i);
  });

  it('does not overwrite an ignored file when the target branch is checked out', async () => {
    const baseBranch = await runGit(repoPath, ['branch', '--show-current']);
    writeFileSync(join(repoPath, '.gitignore'), 'generated.txt\n');
    await runGit(repoPath, ['add', '.gitignore']);
    await runGit(repoPath, ['commit', '-m', 'ignore generated file']);
    const localCommit = await runGit(repoPath, ['rev-parse', 'HEAD']);

    writeFileSync(join(repoPath, 'generated.txt'), 'remote tracked content\n');
    await runGit(repoPath, ['add', '-f', 'generated.txt']);
    await runGit(repoPath, ['commit', '-m', 'track generated file']);
    const remoteCommit = await runGit(repoPath, ['rev-parse', 'HEAD']);
    await runGit(repoPath, ['update-ref', `refs/remotes/origin/${baseBranch}`, remoteCommit]);
    await runGit(repoPath, ['reset', '--hard', localCommit]);
    writeFileSync(join(repoPath, 'generated.txt'), 'local ignored content\n');
    expect(await runGit(repoPath, ['status', '--porcelain'])).toBe('');

    const { gitBranchService } = await import('../../../../src/main/services/git/git-branch');
    const updated = await gitBranchService.fastForwardBranchToRemoteIfSafe(repoPath, baseBranch);

    expect(updated).toBe(false);
    expect(readFileSync(join(repoPath, 'generated.txt'), 'utf8')).toBe('local ignored content\n');
    expect(await runGit(repoPath, ['rev-parse', 'HEAD'])).toBe(localCommit);
  });

  it('releases its branch reservation after updating an unchecked-out target', async () => {
    const baseBranch = await runGit(repoPath, ['branch', '--show-current']);
    const localCommit = await runGit(repoPath, ['rev-parse', 'HEAD']);
    writeFileSync(join(repoPath, 'remote.txt'), 'remote content\n');
    await runGit(repoPath, ['add', 'remote.txt']);
    await runGit(repoPath, ['commit', '-m', 'remote change']);
    const remoteCommit = await runGit(repoPath, ['rev-parse', 'HEAD']);
    await runGit(repoPath, ['update-ref', `refs/remotes/origin/${baseBranch}`, remoteCommit]);
    await runGit(repoPath, ['reset', '--hard', localCommit]);
    await runGit(repoPath, ['checkout', '-b', 'feature']);

    const { gitBranchService } = await import('../../../../src/main/services/git/git-branch');
    const updated = await gitBranchService.fastForwardBranchToRemoteIfSafe(repoPath, baseBranch);

    expect(updated).toBe(true);
    expect(await runGit(repoPath, ['rev-parse', baseBranch])).toBe(remoteCommit);
    const worktrees = await runGit(repoPath, ['worktree', 'list', '--porcelain']);
    expect(worktrees.match(/^worktree /gm)).toHaveLength(1);
  });

  /** Gives the target a local commit and origin a different one, then starts `feature`. */
  async function createDivergedTarget(localFile: string, remoteFile: string) {
    const baseBranch = await runGit(repoPath, ['branch', '--show-current']);
    const baseCommit = await runGit(repoPath, ['rev-parse', 'HEAD']);
    writeFileSync(join(repoPath, remoteFile), 'remote\n');
    await runGit(repoPath, ['add', remoteFile]);
    await runGit(repoPath, ['commit', '-m', 'remote change']);
    const remoteCommit = await runGit(repoPath, ['rev-parse', 'HEAD']);
    await runGit(repoPath, ['update-ref', `refs/remotes/origin/${baseBranch}`, remoteCommit]);
    await runGit(repoPath, ['reset', '--hard', baseCommit]);
    writeFileSync(join(repoPath, localFile), 'local\n');
    await runGit(repoPath, ['add', localFile]);
    await runGit(repoPath, ['commit', '-m', 'local change']);
    const localCommit = await runGit(repoPath, ['rev-parse', 'HEAD']);
    await runGit(repoPath, ['checkout', '-b', 'feature', baseCommit]);
    return { baseBranch, localCommit, remoteCommit };
  }

  const checkoutsSince = async (reflogCount: number) =>
    (await runGit(repoPath, ['reflog', '--format=%gs']))
      .split('\n')
      .slice(0, -reflogCount || undefined)
      .filter((entry) => entry.startsWith('checkout:'));

  it('merges a diverged target from origin without switching the workspace', async () => {
    const { baseBranch, localCommit, remoteCommit } = await createDivergedTarget(
      'local-only.txt',
      'remote-only.txt'
    );
    const reflogCount = (await runGit(repoPath, ['reflog', '--format=%gs'])).split('\n').length;

    const { gitBranchService } = await import('../../../../src/main/services/git/git-branch');
    const result = await gitBranchService.mergeTargetBranchFromRemote(repoPath);

    expect(result).toEqual({
      success: true,
      message: `Merged origin/${baseBranch} into ${baseBranch}`,
    });
    expect(await runGit(repoPath, ['rev-list', '--parents', '-n', '1', baseBranch])).toMatch(
      new RegExp(`^[0-9a-f]+ ${localCommit} ${remoteCommit}$`)
    );
    expect(await runGit(repoPath, ['ls-tree', '--name-only', baseBranch])).toContain(
      'remote-only.txt'
    );
    expect(await runGit(repoPath, ['branch', '--show-current'])).toBe('feature');
    expect(await checkoutsSince(reflogCount)).toEqual([]);
    const worktrees = await runGit(repoPath, ['worktree', 'list', '--porcelain']);
    expect(worktrees.match(/^worktree /gm)).toHaveLength(1);
  });

  it('leaves a diverged target unchanged when merging origin into it would conflict', async () => {
    const { baseBranch, localCommit } = await createDivergedTarget('conflict.txt', 'conflict.txt');

    const { gitBranchService } = await import('../../../../src/main/services/git/git-branch');
    const result = await gitBranchService.mergeTargetBranchFromRemote(repoPath);

    expect(result.success).toBe(false);
    expect(result.message).toContain('would conflict in conflict.txt');
    expect(await runGit(repoPath, ['rev-parse', baseBranch])).toBe(localCommit);
    expect(await runGit(repoPath, ['branch', '--show-current'])).toBe('feature');
    expect(await runGit(repoPath, ['status', '--porcelain'])).toBe('');
  });

  it('fast-forwards an unchecked-out target branch without a helper checkout', async () => {
    const baseBranch = await runGit(repoPath, ['branch', '--show-current']);
    await runGit(repoPath, ['checkout', '-b', 'feature']);
    writeFileSync(join(repoPath, 'feature.txt'), 'feature\n');
    await runGit(repoPath, ['add', 'feature.txt']);
    await runGit(repoPath, ['commit', '-m', 'feature']);

    const { gitBranchService } = await import('../../../../src/main/services/git/git-branch');
    const result = await gitBranchService.mergeToTargetBranch(repoPath);

    expect(result).toEqual({ success: true, message: `Fast-forwarded ${baseBranch} to feature` });
    expect(await runGit(repoPath, ['rev-parse', baseBranch])).toBe(
      await runGit(repoPath, ['rev-parse', 'feature'])
    );
    const worktrees = await runGit(repoPath, ['worktree', 'list', '--porcelain']);
    expect(worktrees.match(/^worktree /gm)).toHaveLength(1);
  });

  it("keeps the workspace's FETCH_HEAD when moving the target", async () => {
    const baseBranch = await runGit(repoPath, ['branch', '--show-current']);
    const localCommit = await runGit(repoPath, ['rev-parse', 'HEAD']);
    writeFileSync(join(repoPath, 'remote.txt'), 'remote content\n');
    await runGit(repoPath, ['add', 'remote.txt']);
    await runGit(repoPath, ['commit', '-m', 'remote change']);
    const remoteCommit = await runGit(repoPath, ['rev-parse', 'HEAD']);
    await runGit(repoPath, ['update-ref', `refs/remotes/origin/${baseBranch}`, remoteCommit]);
    await runGit(repoPath, ['reset', '--hard', localCommit]);
    await runGit(repoPath, ['checkout', '-b', 'feature']);
    const fetchHead = `${localCommit}\t\tbranch 'some-branch' of example\n`;
    writeFileSync(join(repoPath, '.git', 'FETCH_HEAD'), fetchHead);

    const { gitBranchService } = await import('../../../../src/main/services/git/git-branch');
    const updated = await gitBranchService.fastForwardBranchToRemoteIfSafe(repoPath, baseBranch);

    expect(updated).toBe(true);
    expect(await runGit(repoPath, ['rev-parse', baseBranch])).toBe(remoteCommit);
    expect(readFileSync(join(repoPath, '.git', 'FETCH_HEAD'), 'utf8')).toBe(fetchHead);
  });

  it('does not count fetched target commits as workspace commits when the local target is behind', async () => {
    const baseBranch = await runGit(repoPath, ['branch', '--show-current']);
    const localTargetCommit = await runGit(repoPath, ['rev-parse', 'HEAD']);
    writeFileSync(join(repoPath, 'remote.txt'), 'remote target work\n');
    await runGit(repoPath, ['add', 'remote.txt']);
    await runGit(repoPath, ['commit', '-m', 'remote target work']);
    const remoteTargetCommit = await runGit(repoPath, ['rev-parse', 'HEAD']);
    await runGit(repoPath, ['update-ref', `refs/remotes/origin/${baseBranch}`, remoteTargetCommit]);
    await runGit(repoPath, ['branch', 'workspace', remoteTargetCommit]);
    await runGit(repoPath, ['reset', '--hard', localTargetCommit]);
    await runGit(repoPath, ['checkout', 'workspace']);

    const { gitBranchService } = await import('../../../../src/main/services/git/git-branch');
    const status = await gitBranchService.getBranchQuickStatus(repoPath);

    expect(status).toMatchObject({
      aheadTargetBranch: 0,
      behindTargetBranch: 0,
      targetBranchAheadRemote: 0,
      targetBranchBehindRemote: 1,
    });
  });

  it("reports origin's default branch in the status when origin/HEAD names one", async () => {
    await runGit(repoPath, ['update-ref', 'refs/remotes/origin/develop', 'HEAD']);
    await runGit(repoPath, [
      'symbolic-ref',
      'refs/remotes/origin/HEAD',
      'refs/remotes/origin/develop',
    ]);

    const { gitBranchService } = await import('../../../../src/main/services/git/git-branch');
    const status = await gitBranchService.getBranchQuickStatus(repoPath);

    expect(status.remoteDefaultBranch).toBe('develop');
  });

  it('pushes only the local branches origin is missing', async () => {
    const baseBranch = await runGit(repoPath, ['branch', '--show-current']);
    await runGit(repoPath, ['branch', 'feature']);
    const remotePath = mkdtempSync(join(tmpdir(), 'komla-git-branch-remote-'));
    try {
      await runGit(remotePath, ['init', '--bare', '--quiet']);
      await runGit(repoPath, ['remote', 'add', 'origin', remotePath]);
      await runGit(repoPath, ['push', '--quiet', 'origin', baseBranch]);
      writeFileSync(join(repoPath, 'local.txt'), 'not pushed\n');
      await runGit(repoPath, ['commit', '-am', 'local only']);

      const { gitBranchService } = await import('../../../../src/main/services/git/git-branch');

      await expect(
        gitBranchService.pushBranchesMissingFromOrigin(repoPath, [
          baseBranch,
          'feature',
          'not-a-branch',
        ])
      ).resolves.toEqual(['feature']);
      expect(await runGit(remotePath, ['branch', '--list', 'feature'])).toContain('feature');
      // A branch origin already has keeps its remote commit.
      expect(await runGit(remotePath, ['rev-parse', baseBranch])).not.toBe(
        await runGit(repoPath, ['rev-parse', baseBranch])
      );
      expect(await runGit(repoPath, ['rev-parse', '--abbrev-ref', 'feature@{upstream}'])).toBe(
        'origin/feature'
      );
    } finally {
      rmSync(remotePath, { recursive: true, force: true });
    }
  });
});
