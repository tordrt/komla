import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TRASH_RETENTION_MS } from '../../../src/shared/types';
import { createSshWorkspace, createWorkspace, createWorktreeWorkspace } from '../../factories';

import type { Workspace } from '../../../src/shared/types';

const mocks = vi.hoisted(() => ({
  workspaces: new Map<string, Workspace>(),
  deleteWorkspace: vi.fn<(id: string, force: boolean, deleteBranch: boolean) => Promise<void>>(),
  execGitAsync: vi.fn<(repoPath: string, args: string[]) => Promise<string>>(),
  broadcastToAll: vi.fn(),
  removeLeftovers:
    vi.fn<(keep: (workspaceId: string) => boolean, stopped: () => boolean) => Promise<void>>(),
}));

vi.mock('../../../src/main/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../../src/main/services/workspace.service', () => ({
  workspaceService: {
    list: () => [...mocks.workspaces.values()],
    get: (id: string) => mocks.workspaces.get(id),
    delete: mocks.deleteWorkspace,
  },
}));
vi.mock('../../../src/main/services/local-mirror.service', () => ({
  localMirrorService: { removeLeftovers: mocks.removeLeftovers },
}));
vi.mock('../../../src/main/services/git/git-exec', () => ({
  gitExec: { execGitAsync: mocks.execGitAsync },
}));
vi.mock('../../../src/main/services/project.service', () => ({
  projectService: {
    get: (id: string) =>
      id === 'project-1' ? { id, repositoryPath: '/repo', managed: false } : undefined,
  },
}));
vi.mock('../../../src/main/services/window.service', () => ({
  windowService: { broadcastToAll: mocks.broadcastToAll },
}));

const NOW = 100 * TRASH_RETENTION_MS;
const expired = NOW - TRASH_RETENTION_MS;

function add(...workspaces: Workspace[]): void {
  for (const workspace of workspaces) mocks.workspaces.set(workspace.id, workspace);
}

function branchStatus(status: { hasRemote: boolean; unpushedCommits: number; ahead: number }) {
  return {
    hasRemote: status.hasRemote,
    unpushedCommits: status.unpushedCommits,
    aheadTargetBranch: status.ahead,
  };
}

async function loadTrash() {
  return (await import('../../../src/main/services/workspace-trash.service')).workspaceTrash;
}

describe('workspaceTrash', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mocks.workspaces.clear();
    mocks.deleteWorkspace.mockReset().mockImplementation(async (id) => {
      mocks.workspaces.delete(id);
    });
    mocks.execGitAsync.mockReset().mockResolvedValue('0');
    mocks.broadcastToAll.mockReset();
    mocks.removeLeftovers.mockReset().mockResolvedValue(undefined);
  });

  afterEach(async () => {
    (await loadTrash()).stop();
    vi.useRealTimers();
  });

  it('deletes for good only the workspaces whose time in the Trash is up', async () => {
    add(
      createWorktreeWorkspace({
        id: 'expired',
        projectId: 'project-1',
        branchName: 'agent/expired',
        status: 'trashed',
        trashedAt: expired,
      }),
      createWorktreeWorkspace({ id: 'recent', status: 'trashed', trashedAt: expired + 1 }),
      createWorktreeWorkspace({ id: 'active', status: 'active', trashedAt: expired })
    );

    await (await loadTrash()).check();

    expect(mocks.deleteWorkspace).toHaveBeenCalledTimes(1);
    expect(mocks.deleteWorkspace).toHaveBeenCalledWith('expired', true, true);
    expect(mocks.broadcastToAll).toHaveBeenCalledWith('workspaces:changed');
  });

  it('keeps a branch whose commits are found nowhere else, or that it could not check', async () => {
    const trashed = (id: string, branchName: string | undefined, projectId = 'project-1') =>
      createWorktreeWorkspace({ id, branchName, projectId, status: 'trashed', trashedAt: expired });
    add(
      trashed('elsewhere', 'agent/elsewhere'),
      trashed('only-here', 'agent/only-here'),
      trashed('unreadable', 'agent/unreadable'),
      trashed('no-branch', undefined),
      trashed('no-project', 'agent/no-project', 'gone')
    );
    mocks.execGitAsync.mockImplementation(async (_repo, args) => {
      if (args.includes('refs/heads/agent/only-here')) return '3';
      if (args.includes('refs/heads/agent/unreadable')) throw new Error('not a git repository');
      return '0';
    });

    await (await loadTrash()).check();

    expect(mocks.execGitAsync).toHaveBeenCalledWith('/repo', [
      'rev-list',
      '--count',
      'refs/heads/agent/elsewhere',
      '--not',
      '--exclude=agent/elsewhere',
      '--branches',
      '--remotes',
    ]);
    expect(mocks.deleteWorkspace.mock.calls).toEqual([
      ['elsewhere', true, true],
      ['only-here', true, false],
      ['unreadable', true, false],
      ['no-branch', true, false],
      ['no-project', true, false],
    ]);
  });

  it("judges an SSH workspace's branch by the last status its host reported", async () => {
    const reported = createSshWorkspace({ id: 'reported', status: 'trashed', trashedAt: expired });
    reported.lastKnownGitStatus = {
      branch: branchStatus({ hasRemote: true, unpushedCommits: 0, ahead: 1 }),
    } as Workspace['lastKnownGitStatus'];
    add(reported, createSshWorkspace({ id: 'unreported', status: 'trashed', trashedAt: expired }));

    await (await loadTrash()).check();

    expect(mocks.execGitAsync).not.toHaveBeenCalled();
    expect(mocks.deleteWorkspace.mock.calls).toEqual([
      ['reported', true, true],
      ['unreported', true, false],
    ]);
  });

  it('tries again at the next check when a deletion fails, and goes on with the rest', async () => {
    add(
      createWorkspace({ id: 'offline', status: 'trashed', trashedAt: expired }),
      createWorkspace({ id: 'reachable', status: 'trashed', trashedAt: expired })
    );
    mocks.deleteWorkspace.mockImplementationOnce(async () => {
      throw new Error('host is offline');
    });
    const trash = await loadTrash();

    await trash.check();
    expect(mocks.workspaces.has('offline')).toBe(true);
    expect(mocks.workspaces.has('reachable')).toBe(false);

    await trash.check();
    expect(mocks.workspaces.has('offline')).toBe(false);
  });

  it('leaves a workspace restored while an earlier one was being deleted', async () => {
    add(
      createWorkspace({ id: 'first', status: 'trashed', trashedAt: expired }),
      createWorkspace({ id: 'restored', status: 'trashed', trashedAt: expired })
    );
    mocks.deleteWorkspace.mockImplementationOnce(async (id) => {
      mocks.workspaces.delete(id);
      mocks.workspaces.get('restored')!.status = 'active';
    });

    await (await loadTrash()).check();

    expect(mocks.deleteWorkspace.mock.calls.map(([id]) => id)).toEqual(['first']);
  });

  it('finishes the deletion under way when stopped, then deletes no more', async () => {
    add(
      createWorkspace({ id: 'first', status: 'trashed', trashedAt: expired }),
      createWorkspace({ id: 'second', status: 'trashed', trashedAt: expired })
    );
    let finishFirst!: () => void;
    mocks.deleteWorkspace.mockImplementationOnce(
      (id) =>
        new Promise<void>((resolve) => {
          finishFirst = () => {
            mocks.workspaces.delete(id);
            resolve();
          };
        })
    );
    const trash = await loadTrash();
    trash.start();
    await vi.advanceTimersByTimeAsync(60_000);

    let stopped = false;
    const stopping = trash.stop().then(() => (stopped = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    finishFirst();
    await stopping;

    expect(mocks.deleteWorkspace.mock.calls.map(([id]) => id)).toEqual(['first']);
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
    expect(mocks.deleteWorkspace).toHaveBeenCalledTimes(1);
  });

  it('checks a minute after starting and then every hour', async () => {
    const trash = await loadTrash();
    trash.start();
    add(createWorkspace({ id: 'ws-1', status: 'trashed', trashedAt: expired }));

    await vi.advanceTimersByTimeAsync(59_000);
    expect(mocks.deleteWorkspace).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.deleteWorkspace).toHaveBeenCalledTimes(1);

    add(createWorkspace({ id: 'ws-2', status: 'trashed', trashedAt: expired }));
    await vi.advanceTimersByTimeAsync(59 * 60_000);
    expect(mocks.deleteWorkspace).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.deleteWorkspace).toHaveBeenCalledTimes(2);
  });
  it('removes local copies left by workspaces that are gone or in the Trash', async () => {
    add(
      createSshWorkspace({ id: 'active', status: 'active' }),
      createSshWorkspace({ id: 'trashed', status: 'trashed', trashedAt: expired + 1 })
    );

    await (await loadTrash()).check();

    expect(mocks.removeLeftovers).toHaveBeenCalledTimes(1);
    const keep = mocks.removeLeftovers.mock.calls[0]![0];
    expect(keep('active')).toBe(true);
    expect(keep('trashed')).toBe(false);
    expect(keep('gone')).toBe(false);
  });

  it('removes leftover local copies after deleting expired workspaces, and survives failure', async () => {
    add(createSshWorkspace({ id: 'expired', status: 'trashed', trashedAt: expired }));
    mocks.removeLeftovers.mockImplementation(async (keep) => {
      // The expired workspace is already deleted, so its copy is a leftover too.
      expect(mocks.deleteWorkspace).toHaveBeenCalledTimes(1);
      expect(keep('expired')).toBe(false);
      throw new Error('EACCES');
    });

    await expect((await loadTrash()).check()).resolves.toBeUndefined();
    expect(mocks.removeLeftovers).toHaveBeenCalledTimes(1);
  });
  it('lets a quit stop removing leftover local copies', async () => {
    let stoppedWhileRemoving: boolean | undefined;
    const trash = await loadTrash();
    mocks.removeLeftovers.mockImplementation(async (_keep, stopped) => {
      expect(stopped()).toBe(false);
      void trash.stop();
      stoppedWhileRemoving = stopped();
    });

    await trash.check();

    expect(stoppedWhileRemoving).toBe(true);
  });
});
