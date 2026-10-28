import { afterEach, describe, expect, it, vi } from 'vitest';

const logger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../../src/main/lib/logger', () => ({
  createLogger: () => logger,
}));

afterEach(() => vi.unstubAllEnvs());

import { WorkspaceStatusService } from '../../../src/main/services/workspace-status.service';
import { createWorkspace } from '../../factories';

import type { WorkspaceStatusServiceDependencies } from '../../../src/main/services/workspace-status.service';
import type { Workspace } from '../../../src/shared/types';

function createSshWorkspace(remoteDirectory = '/remote/project/worktree'): Workspace {
  return createWorkspace({
    id: 'workspace-1',
    branchName: 'feature/old',
    backend: {
      kind: 'ssh',
      hostId: 'host-1',
      remoteDirectory,
      remoteRepoPath: '/remote/project/repository',
      remoteProjectRoot: '/remote/project',
      gitUrl: 'git@example.com:team/project.git',
      branchName: 'feature/old',
      baseBranch: 'main',
      defaultBranch: 'main',
    },
  });
}

function createStatusService(
  overrides: Pick<WorkspaceStatusServiceDependencies, 'getWorkspace' | 'listWorkspaces'> &
    Partial<WorkspaceStatusServiceDependencies>
) {
  return new WorkspaceStatusService({
    saveWorkspaces: vi.fn(),
    broadcastWorkspaceUpdate: vi.fn(),
    publishWorkingTreeChange: vi.fn(),
    requestLocalCopySync: vi.fn(),
    getSshSnapshot: vi.fn(),
    restartLocalWatcher: vi.fn(),
    now: () => 1_700_000_000_500,
    ...overrides,
  });
}

describe('WorkspaceStatusService', () => {
  it.each(['', ' M src/app.ts\0'])(
    'preserves remote activity across startup and reconnect for status %j',
    async (status) => {
      const workspace = createSshWorkspace();
      workspace.lastActivityAt = 1_600_000_000_000;
      const publishWorkingTreeChange = vi.fn();
      const dependencies = {
        getWorkspace: () => workspace,
        listWorkspaces: () => [workspace],
        publishWorkingTreeChange,
      };
      const snapshot = {
        source: { kind: 'remote-companion' as const, sequence: 1 },
        workspaceId: workspace.id,
        cwd: '/remote/project/worktree',
        observedAt: 1_700_000_000_000,
        stateHash: 'initial',
        statusB64: Buffer.from(status).toString('base64'),
        numstatB64: Buffer.from(status ? '3\t1\tsrc/app.ts\0' : '').toString('base64'),
        workingTreeChanged: true,
        branch: { currentBranch: 'feature/old', targetBranch: 'main' },
      };
      const original = createStatusService(dependencies);
      await original.change({ kind: 'snapshot-observed', snapshot });
      expect(workspace.lastActivityAt).toBe(1_600_000_000_000);

      const reopened = createStatusService(dependencies);
      await reopened.change({ kind: 'restore' });
      await reopened.change({ kind: 'snapshot-observed', snapshot });
      await reopened.change({ kind: 'remote-source-unreachable', workspaceIds: [workspace.id] });
      await reopened.change({ kind: 'snapshot-observed', snapshot });
      expect(workspace.lastActivityAt).toBe(1_600_000_000_000);
      expect(publishWorkingTreeChange).toHaveBeenLastCalledWith(
        workspace.id,
        ['file'],
        1_600_000_000_000,
        undefined
      );
    }
  );

  it('publishes what a Remote Companion report says changed', async () => {
    const workspace = createSshWorkspace();
    const publishWorkingTreeChange = vi.fn();
    const service = createStatusService({
      getWorkspace: () => workspace,
      listWorkspaces: () => [workspace],
      publishWorkingTreeChange,
    });

    await service.change({
      kind: 'snapshot-observed',
      snapshot: {
        source: { kind: 'remote-companion', sequence: 1 },
        workspaceId: workspace.id,
        cwd: '/remote/project/worktree',
        observedAt: 1_700_000_000_000,
        stateHash: 'state-1',
        fileListHash: 'file-list',
        changedPaths: ['src/app.ts'],
        branch: { currentBranch: 'feature/old', targetBranch: 'main' },
      },
    });

    expect(publishWorkingTreeChange).toHaveBeenLastCalledWith(
      workspace.id,
      ['file'],
      workspace.lastActivityAt,
      { fileListHash: 'file-list', changedPaths: ['src/app.ts'] }
    );

    // A scan can see a checkout before the companion sees the files it changed.
    await service.change({
      kind: 'snapshot-observed',
      snapshot: {
        source: { kind: 'remote-companion', sequence: 2 },
        workspaceId: workspace.id,
        cwd: '/remote/project/worktree',
        observedAt: 1_700_000_000_100,
        stateHash: 'state-2',
        fileListHash: 'file-list-2',
        changedPaths: ['src/app.ts'],
        branch: { currentBranch: 'feature/new', targetBranch: 'main' },
      },
    });

    expect(publishWorkingTreeChange).toHaveBeenLastCalledWith(
      workspace.id,
      ['file', 'git-head', 'git-branch'],
      workspace.lastActivityAt,
      { fileListHash: 'file-list-2' }
    );
    expect(publishWorkingTreeChange.mock.lastCall?.[3]).not.toHaveProperty('changedPaths');
  });

  it('advances remote activity for changed files but not unchanged or incomplete snapshots', async () => {
    const workspace = createSshWorkspace();
    workspace.lastActivityAt = 1_600_000_000_000;
    let now = 1_700_000_000_500;
    const publishWorkingTreeChange = vi.fn();
    const saveWorkspaces = vi.fn();
    const service = createStatusService({
      getWorkspace: () => workspace,
      listWorkspaces: () => [workspace],
      now: () => now,
      publishWorkingTreeChange,
      saveWorkspaces,
    });
    const statuses = [
      { status: '', numstat: '', expected: 1_600_000_000_000 },
      { status: ' M src/app.ts\0', numstat: '3\t1\tsrc/app.ts\0', expected: now + 1 },
      { status: ' M src/app.ts\0', numstat: '3\t1\tsrc/app.ts\0', expected: now + 1 },
      { status: ' M src/app.ts\0', numstat: '4\t1\tsrc/app.ts\0', expected: now + 3 },
      { status: '', numstat: '', incomplete: true, expected: now + 3 },
      { status: '', numstat: '', expected: now + 5 },
    ];
    for (const [index, item] of statuses.entries()) {
      await service.change({
        kind: 'snapshot-observed',
        snapshot: {
          source: { kind: 'remote-companion', sequence: index + 1 },
          workspaceId: workspace.id,
          cwd: '/remote/project/worktree',
          observedAt: now,
          stateHash: `state-${index}`,
          statusB64: Buffer.from(item.status).toString('base64'),
          numstatB64: Buffer.from(item.numstat).toString('base64'),
          statusTooLarge: item.incomplete,
          workingTreeChanged: true,
          branch: { currentBranch: 'feature/old', aheadTargetBranch: index },
        },
      });
      expect(workspace.lastActivityAt).toBe(item.expected);
      expect(publishWorkingTreeChange).toHaveBeenLastCalledWith(
        workspace.id,
        ['file'],
        item.expected,
        undefined
      );
      expect(saveWorkspaces).toHaveBeenCalledTimes(index + 1);
      now++;
    }
  });

  it('syncs file events but not metadata-only snapshots, even with identical Git summaries', async () => {
    const workspace = createSshWorkspace();
    const requestLocalCopySync = vi.fn();
    const service = createStatusService({
      getWorkspace: () => workspace,
      listWorkspaces: () => [workspace],
      requestLocalCopySync,
    });
    for (const [index, workingTreeChanged] of [false, true, false, true].entries()) {
      await service.change({
        kind: 'snapshot-observed',
        snapshot: {
          source: { kind: 'remote-companion', sequence: index + 1 },
          workspaceId: workspace.id,
          cwd: '/remote/project/worktree',
          observedAt: 1_700_000_000_000 + index,
          stateHash: 'same-git-summary',
          workingTreeChanged,
          branch: { currentBranch: 'feature/old', aheadTargetBranch: 0 },
        },
      });
      expect(requestLocalCopySync).toHaveBeenCalledTimes(Math.floor((index + 1) / 2));
    }
    expect(service.read(workspace.id)?.revision).toBe(4);
  });

  it('keeps per-snapshot sync decisions out of info diagnostics', async () => {
    vi.stubEnv('KOMLA_DIAGNOSTICS', '1');
    const workspace = createSshWorkspace();
    const service = createStatusService({
      getWorkspace: () => workspace,
      listWorkspaces: () => [workspace],
    });

    await service.change({
      kind: 'snapshot-observed',
      snapshot: {
        source: { kind: 'remote-companion', sequence: 1 },
        workspaceId: workspace.id,
        cwd: '/remote/project/worktree',
        observedAt: 1_700_000_000_000,
        stateHash: 'changed',
        workingTreeChanged: true,
        branch: { currentBranch: 'feature/old', aheadTargetBranch: 0 },
      },
    });

    expect(logger.info).not.toHaveBeenCalledWith(
      'SSH snapshot local copy sync decision',
      expect.anything()
    );
    expect(logger.debug).toHaveBeenCalledWith(
      'SSH snapshot local copy sync decision',
      expect.objectContaining({ workspaceId: workspace.id, workingTreeChanged: true })
    );
  });

  it.each([
    { localCopyCurrent: true, syncs: 0 },
    { localCopyCurrent: false, syncs: 1 },
  ])(
    'syncs after a reconnect refresh only when the local copy is not current ($localCopyCurrent)',
    async ({ localCopyCurrent, syncs }) => {
      const workspace = createSshWorkspace();
      const requestLocalCopySync = vi.fn();
      const isLocalCopyCurrent = vi.fn(() => localCopyCurrent);
      const service = createStatusService({
        getWorkspace: () => workspace,
        listWorkspaces: () => [workspace],
        requestLocalCopySync,
        isLocalCopyCurrent,
        getSshSnapshot: vi.fn().mockResolvedValue({
          statusText: ' M src/app.ts\0',
          numstatText: '3\t1\tsrc/app.ts\0',
          statusTooLarge: false,
          branch: { currentBranch: 'feature/old', targetBranch: 'main' },
        }),
      });

      await service.change({
        kind: 'refresh-requested',
        workspaceId: workspace.id,
        reason: 'reconnected',
      });

      expect(service.read(workspace.id)?.workingTree.files).toEqual([
        expect.objectContaining({ path: 'src/app.ts' }),
      ]);
      expect(isLocalCopyCurrent).toHaveBeenCalledWith(workspace.id);
      expect(requestLocalCopySync).toHaveBeenCalledTimes(syncs);

      await service.change({ kind: 'refresh-requested', workspaceId: workspace.id });

      expect(requestLocalCopySync).toHaveBeenCalledTimes(syncs + 1);
    }
  );

  it.each([
    { statusText: '', syncs: 0 },
    { statusText: ' M src/app.ts\0', syncs: 1 },
  ])(
    'syncs the local copy after a refresh for a fetch only when files changed ($syncs)',
    async ({ statusText, syncs }) => {
      const workspace = createSshWorkspace();
      workspace.lastKnownGitStatus = {
        branch: {
          currentBranch: 'feature/old',
          mainBranch: 'main',
          defaultBranch: 'main',
          aheadTargetBranch: 0,
          behindTargetBranch: 0,
          hasRemote: true,
          hasOriginRemote: true,
          unpushedCommits: 0,
          behindRemote: 0,
          targetBranchHasRemote: true,
          targetBranchAheadRemote: 0,
          targetBranchBehindRemote: 0,
        },
        diff: { files: [], summary: { additions: 0, deletions: 0, filesChanged: 0 } },
        updatedAt: 1_699_999_999_000,
      };
      const requestLocalCopySync = vi.fn();
      const service = createStatusService({
        getWorkspace: () => workspace,
        listWorkspaces: () => [workspace],
        requestLocalCopySync,
        isLocalCopyCurrent: () => false,
        getSshSnapshot: vi.fn().mockResolvedValue({
          statusText,
          numstatText: '',
          statusTooLarge: false,
          branch: { currentBranch: 'feature/old', targetBranch: 'main', behindTargetBranch: 2 },
        }),
      });

      await service.change({
        kind: 'refresh-requested',
        workspaceId: workspace.id,
        reason: 'fetched',
      });

      expect(service.read(workspace.id)?.branch.behindTargetBranch).toBe(2);
      expect(requestLocalCopySync).toHaveBeenCalledTimes(syncs);
    }
  );

  describe('a snapshot superseded by a refresh', () => {
    function createSupersededHarness() {
      const workspace = createSshWorkspace();
      const requestLocalCopySync = vi.fn();
      const service = createStatusService({
        getWorkspace: () => workspace,
        listWorkspaces: () => [workspace],
        requestLocalCopySync,
        isLocalCopyCurrent: () => true,
        getSshSnapshot: vi.fn().mockResolvedValue({
          observedAt: 1_700_000_000_200,
          statusText: '',
          numstatText: '',
          statusTooLarge: false,
          branch: { currentBranch: 'feature/old', targetBranch: 'main' },
        }),
      });
      // Observed while disconnected and delivered after the refresh.
      const deliver = (workingTreeChanged?: boolean) =>
        service.change({
          kind: 'snapshot-observed',
          snapshot: {
            source: { kind: 'remote-companion', sequence: 1 },
            workspaceId: workspace.id,
            cwd: '/remote/project/worktree',
            observedAt: 1_700_000_000_100,
            stateHash: 'observed-while-disconnected',
            ...(workingTreeChanged === undefined ? {} : { workingTreeChanged }),
            branch: { currentBranch: 'feature/old', targetBranch: 'main' },
          },
        });
      return { workspace, requestLocalCopySync, service, deliver };
    }

    it.each([
      { workingTreeChanged: true, syncs: 1 },
      { workingTreeChanged: undefined, syncs: 1 },
      { workingTreeChanged: false, syncs: 0 },
    ])(
      'syncs once after a reconnect refresh skipped its sync (files changed: $workingTreeChanged)',
      async ({ workingTreeChanged, syncs }) => {
        const { workspace, requestLocalCopySync, service, deliver } = createSupersededHarness();
        await service.change({
          kind: 'refresh-requested',
          workspaceId: workspace.id,
          reason: 'reconnected',
        });

        expect((await deliver(workingTreeChanged)).disposition).toBe('superseded');
        // The Remote Companion resends a snapshot whose delivery timed out.
        expect((await deliver(workingTreeChanged)).disposition).toBe('superseded');

        expect(requestLocalCopySync).toHaveBeenCalledTimes(syncs);
      }
    );

    it('does not sync again after a refresh that already synced', async () => {
      const { workspace, requestLocalCopySync, service, deliver } = createSupersededHarness();
      await service.change({ kind: 'refresh-requested', workspaceId: workspace.id });
      expect(requestLocalCopySync).toHaveBeenCalledOnce();

      expect((await deliver(true)).disposition).toBe('superseded');

      expect(requestLocalCopySync).toHaveBeenCalledOnce();
    });
  });

  it('accepts a Remote Companion snapshot through one Workspace Status interface', async () => {
    const workspace = createSshWorkspace();
    const effects: string[] = [];
    const service = createStatusService({
      getWorkspace: (workspaceId) => (workspaceId === workspace.id ? workspace : undefined),
      listWorkspaces: () => [workspace],
      saveWorkspaces: () => effects.push('save'),
      broadcastWorkspaceUpdate: () => effects.push('broadcast'),
      publishWorkingTreeChange: () => effects.push('worktree'),
      requestLocalCopySync: () => effects.push('sync'),
    });

    const receipt = await service.change({
      kind: 'snapshot-observed',
      snapshot: {
        source: { kind: 'remote-companion', sequence: 1 },
        workspaceId: workspace.id,
        hostId: 'host-1',
        cwd: '/remote/project/worktree/',
        observedAt: 1_700_000_000_000,
        stateHash: 'remote-hash-1',
        statusB64: Buffer.from(' M src/app.ts\0').toString('base64'),
        numstatB64: Buffer.from('3\t1\tsrc/app.ts\0').toString('base64'),
        statusTooLarge: false,
        branch: {
          currentBranch: 'feature/current',
          targetBranch: 'main',
          aheadTargetBranch: 2,
          behindTargetBranch: 0,
          hasRemote: true,
          hasOriginRemote: true,
          unpushedCommits: 1,
          behindRemote: 0,
          targetBranchHasRemote: true,
          targetBranchAheadRemote: 0,
          targetBranchBehindRemote: 0,
        },
      },
    });

    expect(receipt).toEqual({
      disposition: 'accepted',
      workspaceId: workspace.id,
      stateHash: 'remote-hash-1',
    });
    expect(service.read(workspace.id)).toMatchObject({
      workspaceId: workspace.id,
      repositoryRevision: 1,
      workingTree: {
        files: [
          {
            path: 'src/app.ts',
            status: 'modified',
            staged: false,
            additions: 3,
            deletions: 1,
          },
        ],
        summary: { additions: 3, deletions: 1, filesChanged: 1 },
      },
      branch: {
        currentBranch: 'feature/current',
        targetBranch: 'main',
        defaultBranch: 'main',
      },
      confirmation: { kind: 'current', confirmedAt: 1_700_000_000_000 },
    });
    expect(workspace.lastKnownGitStatus?.branch.currentBranch).toBe('feature/current');
    expect(workspace.branchName).toBe('feature/current');
    expect(workspace.backend?.branchName).toBe('feature/current');
    expect(effects).toEqual(['save', 'broadcast', 'worktree', 'sync']);
  });

  it('matches equivalent root paths for a Remote Companion snapshot', async () => {
    const workspace = createSshWorkspace('/');
    const service = createStatusService({
      getWorkspace: () => workspace,
      listWorkspaces: () => [workspace],
    });

    const receipt = await service.change({
      kind: 'snapshot-observed',
      snapshot: {
        source: { kind: 'remote-companion', sequence: 1 },
        workspaceId: workspace.id,
        cwd: '///',
        observedAt: 1_700_000_000_000,
        stateHash: 'root-path',
        statusB64: '',
        numstatB64: '',
        branch: { currentBranch: 'feature/old', targetBranch: 'main' },
      },
    });

    expect(receipt.disposition).toBe('accepted');
  });

  it('rejects invalid Remote Companion targets while allowing an omitted optional host', async () => {
    const sshWorkspace = createSshWorkspace();
    const localWorkspace = createWorkspace({ id: 'workspace-local' });
    const service = createStatusService({
      getWorkspace: (workspaceId) =>
        [sshWorkspace, localWorkspace].find((workspace) => workspace.id === workspaceId),
      listWorkspaces: () => [sshWorkspace, localWorkspace],
    });
    const snapshot = (workspaceId: string, cwd: string, hostId?: string) => ({
      kind: 'snapshot-observed' as const,
      snapshot: {
        source: { kind: 'remote-companion' as const, sequence: 1 },
        workspaceId,
        ...(hostId === undefined ? {} : { hostId }),
        cwd,
        observedAt: 1_700_000_000_000,
        stateHash: `${workspaceId}:${cwd}:${hostId ?? 'no-host'}`,
        statusB64: '',
        numstatB64: '',
        branch: { currentBranch: 'feature/old', targetBranch: 'main' },
      },
    });

    const missingWorkspace = await service.change(
      snapshot('missing-workspace', '/remote/project/worktree')
    );
    const localTarget = await service.change(
      snapshot(localWorkspace.id, localWorkspace.workingDirectory)
    );
    const wrongHost = await service.change(
      snapshot(sshWorkspace.id, '/remote/project/worktree', 'host-2')
    );
    const wrongDirectory = await service.change(
      snapshot(sshWorkspace.id, '/remote/other', 'host-1')
    );
    const omittedHost = await service.change(
      snapshot(sshWorkspace.id, '/remote/project/worktree/')
    );

    expect(missingWorkspace).toMatchObject({
      disposition: 'rejected',
      code: 'workspace-not-found',
    });
    expect(localTarget).toMatchObject({
      disposition: 'rejected',
      code: 'target-mismatch',
    });
    expect(wrongHost).toMatchObject({
      disposition: 'rejected',
      code: 'target-mismatch',
    });
    expect(wrongDirectory).toMatchObject({
      disposition: 'rejected',
      code: 'target-mismatch',
    });
    expect(omittedHost.disposition).toBe('accepted');
  });

  it('treats Remote Companion snapshots as latest values and ignores an exact retry', async () => {
    const workspace = createSshWorkspace();
    const saveWorkspaces = vi.fn();
    const service = createStatusService({
      getWorkspace: () => workspace,
      listWorkspaces: () => [workspace],
      saveWorkspaces,
    });
    const change = {
      kind: 'snapshot-observed' as const,
      snapshot: {
        source: { kind: 'remote-companion' as const, sequence: 7 },
        workspaceId: workspace.id,
        cwd: '/remote/project/worktree',
        observedAt: 1_700_000_000_000,
        stateHash: 'remote-hash-7',
        statusB64: '',
        numstatB64: '',
        branch: { currentBranch: 'feature/old', targetBranch: 'main' },
      },
    };

    const first = await service.change(change);
    const duplicate = await service.change(change);

    expect(first.disposition).toBe('accepted');
    expect(duplicate.disposition).toBe('duplicate');
    expect(saveWorkspaces).toHaveBeenCalledOnce();
  });

  it('normalizes and orders snapshots from one local watcher', async () => {
    const workspace = createWorkspace({ id: 'workspace-local', branchName: 'feature/local' });
    const publishWorkingTreeChange = vi.fn();
    const service = createStatusService({
      getWorkspace: () => workspace,
      listWorkspaces: () => [workspace],
      publishWorkingTreeChange,
    });
    const source = {
      kind: 'local-watcher' as const,
      instanceId: 'desktop-1',
      epoch: 'watcher-1',
    };
    const branch = {
      currentBranch: 'feature/local',
      mainBranch: 'main',
      defaultBranch: 'main',
      aheadTargetBranch: 1,
      behindTargetBranch: 0,
      hasRemote: false,
      hasOriginRemote: true,
      unpushedCommits: 0,
      behindRemote: 0,
      targetBranchHasRemote: true,
      targetBranchAheadRemote: 0,
      targetBranchBehindRemote: 0,
    };
    const changedTree = {
      files: [
        {
          path: 'src/local.ts',
          status: 'modified' as const,
          staged: false,
          additions: 4,
          deletions: 2,
        },
      ],
      summary: { additions: 4, deletions: 2, filesChanged: 1 },
    };

    const accepted = await service.change({
      kind: 'snapshot-observed',
      snapshot: {
        source: { ...source, sequence: 2 },
        workspaceId: workspace.id,
        observedAt: 1_700_000_000_002,
        workingTree: changedTree,
        branch,
      },
    });
    const superseded = await service.change({
      kind: 'snapshot-observed',
      snapshot: {
        source: { ...source, sequence: 1 },
        workspaceId: workspace.id,
        observedAt: 1_700_000_000_001,
        workingTree: { files: [], summary: { additions: 0, deletions: 0, filesChanged: 0 } },
        branch,
      },
    });

    expect(accepted).toMatchObject({ disposition: 'accepted', workspaceId: workspace.id });
    expect(superseded).toMatchObject({ disposition: 'superseded', workspaceId: workspace.id });
    expect(service.read(workspace.id)?.workingTree).toEqual(changedTree);
    expect(publishWorkingTreeChange).not.toHaveBeenCalled();
  });

  it('keeps a paused local rebase in the projected branch status', async () => {
    const workspace = createWorkspace({ id: 'workspace-local', branchName: 'feature/local' });
    const service = createStatusService({
      getWorkspace: () => workspace,
      listWorkspaces: () => [workspace],
    });

    await service.change({
      kind: 'snapshot-observed',
      snapshot: {
        source: { kind: 'local-watcher', instanceId: 'desktop-1', epoch: 'watcher-1', sequence: 1 },
        workspaceId: workspace.id,
        observedAt: 1_700_000_000_001,
        workingTree: { files: [], summary: { additions: 0, deletions: 0, filesChanged: 0 } },
        branch: {
          currentBranch: 'HEAD',
          mainBranch: 'main',
          defaultBranch: 'main',
          aheadTargetBranch: 0,
          behindTargetBranch: 0,
          hasRemote: false,
          hasOriginRemote: false,
          unpushedCommits: 0,
          behindRemote: 0,
          targetBranchHasRemote: false,
          targetBranchAheadRemote: 0,
          targetBranchBehindRemote: 0,
          rebaseInProgress: true,
        },
      },
    });

    expect(service.read(workspace.id)?.branch.rebaseInProgress).toBe(true);
  });

  it.each([true, false])(
    'retains confirmation across restart with prior complete status: %s',
    async (hasCompleteStatus) => {
      const workspace = createSshWorkspace();
      const service = createStatusService({
        getWorkspace: () => workspace,
        listWorkspaces: () => [workspace],
      });
      const first = {
        kind: 'snapshot-observed' as const,
        snapshot: {
          source: { kind: 'remote-companion' as const, sequence: 1 },
          workspaceId: workspace.id,
          cwd: '/remote/project/worktree',
          observedAt: 1_700_000_000_001,
          stateHash: 'complete',
          statusB64: Buffer.from(' M src/app.ts\0').toString('base64'),
          numstatB64: Buffer.from('3\t1\tsrc/app.ts\0').toString('base64'),
          statusTooLarge: false,
          branch: { currentBranch: 'feature/old', targetBranch: 'main' },
        },
      };
      if (hasCompleteStatus) await service.change(first);

      await service.change({
        kind: 'snapshot-observed',
        snapshot: {
          ...first.snapshot,
          source: { kind: 'remote-companion', sequence: 2 },
          observedAt: 1_700_000_000_002,
          stateHash: 'incomplete',
          statusB64: '',
          numstatB64: '',
          statusTooLarge: true,
        },
      });

      if (hasCompleteStatus)
        expect(service.read(workspace.id)).toMatchObject({
          workingTree: {
            files: [{ path: 'src/app.ts', additions: 3, deletions: 1 }],
          },
          confirmation: {
            kind: 'stale',
            staleSince: 1_700_000_000_002,
            lastConfirmedAt: 1_700_000_000_001,
            reason: 'snapshot-failed',
          },
        });
      const lastConfirmedAt = hasCompleteStatus ? 1_700_000_000_001 : undefined;
      expect(service.read(workspace.id)?.confirmation).toMatchObject({
        kind: 'stale',
        reason: 'snapshot-failed',
      });
      await service.change({ kind: 'workspace-removed', workspaceId: workspace.id });
      await service.change({ kind: 'restore' });
      expect(service.read(workspace.id)?.confirmation).toEqual({
        kind: 'stale',
        staleSince: 1_700_000_000_500,
        reason: 'source-unreachable',
        ...(lastConfirmedAt === undefined ? {} : { lastConfirmedAt }),
      });
    }
  );

  it('returns a retry receipt without committing authority state when projection effects fail', async () => {
    const workspace = createSshWorkspace();
    const service = createStatusService({
      getWorkspace: () => workspace,
      listWorkspaces: () => [workspace],
      saveWorkspaces: () => {
        throw new Error('persistence unavailable');
      },
    });

    const receipt = await service.change({
      kind: 'snapshot-observed',
      snapshot: {
        source: { kind: 'remote-companion', sequence: 1 },
        workspaceId: workspace.id,
        cwd: '/remote/project/worktree',
        observedAt: 1_700_000_000_001,
        stateHash: 'retry-me',
        statusB64: '',
        numstatB64: '',
        branch: { currentBranch: 'feature/old', targetBranch: 'main' },
      },
    });

    expect(receipt).toEqual({
      disposition: 'retry',
      workspaceId: workspace.id,
      stateHash: 'retry-me',
      code: 'internal-failure',
    });
    expect(service.read(workspace.id)).toBeUndefined();
  });

  it('observes accepted projections while isolating listener failures', async () => {
    const workspace = createWorkspace({ id: 'workspace-local', branchName: 'feature/local' });
    const service = createStatusService({
      getWorkspace: () => workspace,
      listWorkspaces: () => [workspace],
    });
    const received = vi.fn();
    const failingCursor = service.observe(() => {
      throw new Error('renderer closed');
    });
    const cursor = service.observe(received);

    await service.change({
      kind: 'snapshot-observed',
      snapshot: {
        source: {
          kind: 'local-watcher',
          instanceId: 'desktop-1',
          epoch: 'watcher-1',
          sequence: 1,
        },
        workspaceId: workspace.id,
        observedAt: 1_700_000_000_001,
        workingTree: { files: [], summary: { additions: 0, deletions: 0, filesChanged: 0 } },
        branch: {
          currentBranch: 'feature/local',
          mainBranch: 'main',
          defaultBranch: 'main',
          aheadTargetBranch: 0,
          behindTargetBranch: 0,
          hasRemote: false,
          hasOriginRemote: false,
          unpushedCommits: 0,
          behindRemote: 0,
          targetBranchHasRemote: false,
          targetBranchAheadRemote: 0,
          targetBranchBehindRemote: 0,
        },
      },
    });

    expect(received).toHaveBeenCalledOnce();
    expect(cursor.initial).toEqual([]);
    cursor.close();
    failingCursor.close();
  });

  it('publishes immutable projections without retaining caller-owned snapshot objects', async () => {
    const workspace = createWorkspace({
      id: 'workspace-local',
      branchName: 'feature/local',
    });
    const service = createStatusService({
      getWorkspace: () => workspace,
      listWorkspaces: () => [workspace],
    });
    const workingTree = {
      files: [
        {
          path: 'src/original.ts',
          status: 'modified' as const,
          staged: false,
          additions: 1,
          deletions: 0,
        },
      ],
      summary: { additions: 1, deletions: 0, filesChanged: 1 },
    };

    await service.change({
      kind: 'snapshot-observed',
      snapshot: {
        source: {
          kind: 'local-watcher',
          instanceId: 'desktop-1',
          epoch: 'watcher-1',
          sequence: 1,
        },
        workspaceId: workspace.id,
        observedAt: 1_700_000_000_001,
        workingTree,
        branch: {
          currentBranch: 'feature/local',
          mainBranch: 'main',
          defaultBranch: 'main',
          aheadTargetBranch: 0,
          behindTargetBranch: 0,
          hasRemote: false,
          hasOriginRemote: false,
          unpushedCommits: 0,
          behindRemote: 0,
          targetBranchHasRemote: false,
          targetBranchAheadRemote: 0,
          targetBranchBehindRemote: 0,
        },
      },
    });

    workingTree.files[0]!.path = 'src/caller-mutated.ts';
    const published = service.read(workspace.id)!;

    expect(published.workingTree.files[0]?.path).toBe('src/original.ts');
    expect(Object.isFrozen(published)).toBe(true);
    expect(Object.isFrozen(published.workingTree)).toBe(true);
    expect(Object.isFrozen(published.workingTree.files)).toBe(true);
    expect(Object.isFrozen(published.workingTree.files[0])).toBe(true);
    expect(Object.isFrozen(published.branch)).toBe(true);
    expect(Object.isFrozen(published.confirmation)).toBe(true);
    expect(() => {
      published.workingTree.files[0]!.path = 'src/reader-mutated.ts';
    }).toThrow(TypeError);
  });

  it('serializes Workspace Status changes per workspace', async () => {
    const workspace = createSshWorkspace();
    let releaseFirst!: () => void;
    const firstEffect = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const saveWorkspaces = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => firstEffect)
      .mockResolvedValue(undefined);
    const service = createStatusService({
      getWorkspace: () => workspace,
      listWorkspaces: () => [workspace],
      saveWorkspaces,
    });
    const snapshot = (sequence: number) => ({
      kind: 'snapshot-observed' as const,
      snapshot: {
        source: { kind: 'remote-companion' as const, sequence },
        workspaceId: workspace.id,
        cwd: '/remote/project/worktree',
        observedAt: 1_700_000_000_000 + sequence,
        stateHash: `hash-${sequence}`,
        statusB64: '',
        numstatB64: '',
        branch: { currentBranch: 'feature/old', targetBranch: 'main' },
      },
    });

    const first = service.change(snapshot(1));
    const second = service.change(snapshot(2));
    await vi.waitFor(() => expect(saveWorkspaces).toHaveBeenCalledOnce());

    expect(service.read(workspace.id)).toBeUndefined();
    releaseFirst();
    await Promise.all([first, second]);

    expect(service.read(workspace.id)?.confirmation).toEqual({
      kind: 'current',
      confirmedAt: 1_700_000_000_002,
    });
  });

  it('serializes a refresh before a later snapshot for the same workspace', async () => {
    const workspace = createSshWorkspace();
    let releaseRefresh!: (snapshot: {
      statusText: string;
      numstatText: string;
      statusTooLarge: boolean;
      branch: {
        currentBranch: string;
        mainBranch: string;
        defaultBranch: string;
        aheadTargetBranch: number;
        behindTargetBranch: number;
        hasRemote: boolean;
        hasOriginRemote: boolean;
        unpushedCommits: number;
        behindRemote: number;
        targetBranchHasRemote: boolean;
        targetBranchAheadRemote: number;
        targetBranchBehindRemote: number;
      };
    }) => void;
    const pendingRefresh = new Promise<Parameters<typeof releaseRefresh>[0]>((resolve) => {
      releaseRefresh = resolve;
    });
    const service = createStatusService({
      getWorkspace: () => workspace,
      listWorkspaces: () => [workspace],
      getSshSnapshot: vi.fn(() => pendingRefresh),
    });
    const completions: string[] = [];

    const refresh = service
      .change({ kind: 'refresh-requested', workspaceId: workspace.id })
      .then(() => completions.push('refresh'));
    const snapshot = service
      .change({
        kind: 'snapshot-observed',
        snapshot: {
          source: { kind: 'remote-companion', sequence: 1 },
          workspaceId: workspace.id,
          cwd: '/remote/project/worktree',
          observedAt: 1_700_000_000_600,
          stateHash: 'later-snapshot',
          statusB64: '',
          numstatB64: '',
          branch: { currentBranch: 'feature/latest', targetBranch: 'main' },
        },
      })
      .then(() => completions.push('snapshot'));
    await Promise.resolve();
    releaseRefresh({
      statusText: '',
      numstatText: '',
      statusTooLarge: false,
      branch: {
        currentBranch: 'feature/refreshed',
        mainBranch: 'main',
        defaultBranch: 'main',
        aheadTargetBranch: 0,
        behindTargetBranch: 0,
        hasRemote: true,
        hasOriginRemote: true,
        unpushedCommits: 0,
        behindRemote: 0,
        targetBranchHasRemote: true,
        targetBranchAheadRemote: 0,
        targetBranchBehindRemote: 0,
      },
    });

    await Promise.all([refresh, snapshot]);

    expect(completions).toEqual(['refresh', 'snapshot']);
    expect(service.read(workspace.id)?.branch.currentBranch).toBe('feature/latest');
  });

  it('restores persisted SSH Workspace Status as stale without effects', async () => {
    const workspace = createSshWorkspace();
    workspace.lastKnownGitStatus = {
      branch: {
        currentBranch: 'feature/old',
        mainBranch: 'main',
        defaultBranch: 'main',
        aheadTargetBranch: 1,
        behindTargetBranch: 0,
        hasRemote: true,
        hasOriginRemote: true,
        unpushedCommits: 1,
        behindRemote: 0,
        targetBranchHasRemote: true,
        targetBranchAheadRemote: 0,
        targetBranchBehindRemote: 0,
      },
      diff: { files: [], summary: { additions: 0, deletions: 0, filesChanged: 0 } },
      updatedAt: 1_699_999_999_000,
      lastConfirmedAt: 1_699_999_999_000,
    };
    const effects = vi.fn();
    const service = createStatusService({
      getWorkspace: () => workspace,
      listWorkspaces: () => [workspace],
      saveWorkspaces: effects,
      broadcastWorkspaceUpdate: effects,
      publishWorkingTreeChange: effects,
      requestLocalCopySync: effects,
    });

    await service.change({ kind: 'restore' });

    expect(service.read(workspace.id)?.confirmation).toEqual({
      kind: 'stale',
      staleSince: 1_700_000_000_500,
      lastConfirmedAt: 1_699_999_999_000,
      reason: 'source-unreachable',
    });
    expect(effects).not.toHaveBeenCalled();
  });

  it('marks Remote Companion status stale without effects and permits a fresh source sequence', async () => {
    const workspace = createSshWorkspace();
    const effects = vi.fn();
    const service = createStatusService({
      getWorkspace: () => workspace,
      listWorkspaces: () => [workspace],
      saveWorkspaces: effects,
      broadcastWorkspaceUpdate: effects,
      publishWorkingTreeChange: effects,
      requestLocalCopySync: effects,
    });
    const snapshot = {
      kind: 'snapshot-observed' as const,
      snapshot: {
        source: { kind: 'remote-companion' as const, sequence: 3 },
        workspaceId: workspace.id,
        cwd: '/remote/project/worktree',
        observedAt: 1_700_000_000_100,
        stateHash: 'remote-hash-3',
        statusB64: '',
        numstatB64: '',
        branch: { currentBranch: 'feature/old', targetBranch: 'main' },
      },
    };
    await service.change(snapshot);
    effects.mockClear();

    const receipt = await service.change({
      kind: 'remote-source-unreachable',
      workspaceIds: [workspace.id],
    });

    expect(receipt).toEqual({
      disposition: 'applied',
      change: 'remote-source-unreachable',
      workspaceIds: [workspace.id],
    });
    expect(service.read(workspace.id)?.confirmation).toEqual({
      kind: 'stale',
      staleSince: 1_700_000_000_500,
      lastConfirmedAt: 1_700_000_000_100,
      reason: 'source-unreachable',
    });
    expect(effects).not.toHaveBeenCalled();
    expect((await service.change(snapshot)).disposition).toBe('accepted');
  });

  it('confirms unchanged SSH status after reopening with a retained snapshot', async () => {
    const workspace = createSshWorkspace();
    workspace.lastActivityAt = 1_600_000_000_000;
    const branch = {
      currentBranch: 'feature/old',
      mainBranch: 'main',
      defaultBranch: 'main',
      aheadTargetBranch: 0,
      behindTargetBranch: 0,
      hasRemote: false,
      hasOriginRemote: false,
      unpushedCommits: 0,
      behindRemote: 0,
      targetBranchHasRemote: false,
      targetBranchAheadRemote: 0,
      targetBranchBehindRemote: 0,
    };
    const getSshSnapshot = vi.fn().mockResolvedValue({
      statusText: '',
      numstatText: '',
      statusTooLarge: false,
      branch,
    });
    const dependencies = {
      getWorkspace: () => workspace,
      listWorkspaces: () => [workspace],
      getSshSnapshot,
    };
    const original = createStatusService(dependencies);
    await original.change({ kind: 'refresh-requested', workspaceId: workspace.id });
    const reopened = createStatusService(dependencies);
    await reopened.change({ kind: 'restore' });
    expect(reopened.read(workspace.id)?.confirmation.kind).toBe('stale');
    const retained = reopened.read(workspace.id);

    await reopened.change({ kind: 'refresh-requested', workspaceId: workspace.id });

    expect(workspace.lastActivityAt).toBe(1_600_000_000_000);
    expect(reopened.read(workspace.id)).toMatchObject({
      workingTree: retained?.workingTree,
      branch: retained?.branch,
      confirmation: { kind: 'current', confirmedAt: 1_700_000_000_500 },
    });
  });

  it('keeps an SSH refresh newer than delayed companion snapshots despite desktop clock skew', async () => {
    const workspace = createSshWorkspace();
    const getSshSnapshot = vi.fn().mockResolvedValue({
      observedAt: 1_700_000_000_200,
      statusText: ' M src/refreshed.ts\0',
      numstatText: '5\t2\tsrc/refreshed.ts\0',
      statusTooLarge: false,
      branch: {
        currentBranch: 'feature/refreshed',
        mainBranch: 'main',
        defaultBranch: 'main',
        aheadTargetBranch: 2,
        behindTargetBranch: 0,
        hasRemote: true,
        hasOriginRemote: true,
        unpushedCommits: 1,
        behindRemote: 0,
        targetBranchHasRemote: true,
        targetBranchAheadRemote: 0,
        targetBranchBehindRemote: 0,
      },
    });
    const service = createStatusService({
      getWorkspace: () => workspace,
      listWorkspaces: () => [workspace],
      now: () => 100, // Desktop time must not order remote observations.
      getSshSnapshot,
    });
    const remoteSnapshot = {
      kind: 'snapshot-observed' as const,
      snapshot: {
        source: { kind: 'remote-companion' as const, sequence: 10 },
        workspaceId: workspace.id,
        cwd: '/remote/project/worktree',
        observedAt: 1_700_000_000_100,
        stateHash: 'remote-hash-10',
        statusB64: '',
        numstatB64: '',
        branch: { currentBranch: 'feature/old', targetBranch: 'main' },
      },
    };
    await service.change(remoteSnapshot);

    const receipt = await service.change({ kind: 'refresh-requested', workspaceId: workspace.id });

    expect(receipt).toEqual({
      disposition: 'applied',
      change: 'refresh-requested',
      workspaceIds: [workspace.id],
    });
    expect(getSshSnapshot).toHaveBeenCalledWith(workspace.backend, 'main');
    expect(service.read(workspace.id)).toMatchObject({
      repositoryRevision: 2,
      workingTree: {
        files: [{ path: 'src/refreshed.ts', additions: 5, deletions: 2 }],
      },
      branch: { currentBranch: 'feature/refreshed' },
      confirmation: { kind: 'current', confirmedAt: 100 },
    });
    expect((await service.change(remoteSnapshot)).disposition).toBe('superseded');
    expect(service.read(workspace.id)?.branch.currentBranch).toBe('feature/refreshed');
    const newer = {
      ...remoteSnapshot,
      snapshot: {
        ...remoteSnapshot.snapshot,
        observedAt: 1_700_000_000_300,
        source: { kind: 'remote-companion' as const, sequence: 1 },
      },
    };
    expect((await service.change(newer)).disposition).toBe('accepted');
    expect((await service.change(remoteSnapshot)).disposition).toBe('superseded');
  });

  it('does not cache an incomplete SSH refresh as a complete Working Tree Snapshot', async () => {
    const workspace = createSshWorkspace();
    workspace.lastKnownGitStatus = {
      branch: {
        currentBranch: 'feature/old',
        mainBranch: 'main',
        defaultBranch: 'main',
        aheadTargetBranch: 0,
        behindTargetBranch: 0,
        hasRemote: true,
        hasOriginRemote: true,
        unpushedCommits: 0,
        behindRemote: 0,
        targetBranchHasRemote: true,
        targetBranchAheadRemote: 0,
        targetBranchBehindRemote: 0,
      },
      diff: {
        files: [
          {
            path: 'src/retained.ts',
            status: 'modified',
            staged: false,
            additions: 2,
            deletions: 1,
          },
        ],
        summary: { additions: 2, deletions: 1, filesChanged: 1 },
      },
      updatedAt: 1_700_000_000_000,
      lastConfirmedAt: 1_700_000_000_000,
    };
    const service = createStatusService({
      getWorkspace: () => workspace,
      listWorkspaces: () => [workspace],
      getSshSnapshot: vi.fn().mockResolvedValue({
        statusText: '',
        numstatText: '',
        statusTooLarge: true,
        branch: workspace.lastKnownGitStatus.branch,
      }),
    });

    await service.change({ kind: 'refresh-requested', workspaceId: workspace.id });

    expect(service.read(workspace.id)?.workingTree.files).toEqual([
      expect.objectContaining({ path: 'src/retained.ts' }),
    ]);
    expect(
      service.read({ kind: 'working-tree-for-diff', workspaceId: workspace.id })
    ).toBeUndefined();
    expect(service.read(workspace.id)?.confirmation).toEqual({
      kind: 'stale',
      staleSince: 1_700_000_000_500,
      lastConfirmedAt: 1_700_000_000_000,
      reason: 'snapshot-failed',
    });
  });

  it('refreshes local status by restarting its watcher', async () => {
    const workspace = createWorkspace({ id: 'workspace-local' });
    const restartLocalWatcher = vi.fn(async () => {
      await service.change({
        kind: 'snapshot-observed',
        snapshot: {
          workspaceId: workspace.id,
          source: { kind: 'local-watcher', instanceId: 'watcher', epoch: 'restart', sequence: 1 },
          observedAt: 1_700_000_000_500,
          workingTree: { files: [], summary: { additions: 0, deletions: 0, filesChanged: 0 } },
          branch: {
            currentBranch: 'main',
            mainBranch: 'main',
            defaultBranch: 'main',
            aheadTargetBranch: 0,
            behindTargetBranch: 0,
            hasRemote: false,
            hasOriginRemote: false,
            unpushedCommits: 0,
            behindRemote: 0,
            targetBranchHasRemote: false,
            targetBranchAheadRemote: 0,
            targetBranchBehindRemote: 0,
          },
        },
      });
    });
    const service = createStatusService({
      getWorkspace: () => workspace,
      listWorkspaces: () => [workspace],
      restartLocalWatcher,
    });

    await service.change({ kind: 'refresh-requested', workspaceId: workspace.id });

    expect(restartLocalWatcher).toHaveBeenCalledWith(workspace.id, workspace.workingDirectory);
    expect(service.read(workspace.id)?.confirmation).toEqual({
      kind: 'current',
      confirmedAt: 1_700_000_000_500,
    });
  });

  it.each([true, false])('invalidates the mutated SSH workspace cache and syncs on the next watcher snapshot (summary changed: %s)', async (summaryChanged) => {
    const workspace = createSshWorkspace();
    const requestLocalCopySync = vi.fn();
    const getSshSnapshot = vi.fn().mockRejectedValue(new Error('agent refused operation'));
    const service = createStatusService({
      getWorkspace: () => workspace,
      listWorkspaces: () => [workspace],
      requestLocalCopySync,
      getSshSnapshot,
    });
    await service.change({
      kind: 'snapshot-observed',
      snapshot: {
        source: { kind: 'remote-companion', sequence: 1 },
        workspaceId: workspace.id,
        cwd: '/remote/project/worktree',
        observedAt: 1_700_000_000_100,
        stateHash: 'complete',
        statusB64: Buffer.from(' M src/app.ts\0').toString('base64'),
        numstatB64: Buffer.from('3\t1\tsrc/app.ts\0').toString('base64'),
        branch: { currentBranch: 'feature/old', targetBranch: 'main' },
      },
    });
    expect(
      service.read({ kind: 'working-tree-for-diff', workspaceId: workspace.id })
    ).toBeDefined();
    requestLocalCopySync.mockClear();

    const receipt = await service.change({
      kind: 'repository-mutated',
      workspaceId: workspace.id,
    });

    expect(receipt).toEqual({
      disposition: 'applied',
      change: 'repository-mutated',
      workspaceIds: [workspace.id],
    });
    expect(
      service.read({ kind: 'working-tree-for-diff', workspaceId: workspace.id })
    ).toBeUndefined();
    expect(requestLocalCopySync).not.toHaveBeenCalled();
    expect(getSshSnapshot).not.toHaveBeenCalled();
    expect(service.read(workspace.id)?.confirmation.kind).toBe('current');

    await service.change({
      kind: 'snapshot-observed',
      snapshot: {
        source: { kind: 'remote-companion', sequence: 2 },
        workspaceId: workspace.id,
        cwd: '/remote/project/worktree',
        observedAt: 1_700_000_000_200,
        stateHash: summaryChanged ? 'after-mutation' : 'complete',
        statusB64: summaryChanged ? '' : Buffer.from(' M src/app.ts\0').toString('base64'),
        numstatB64: summaryChanged ? '' : Buffer.from('3\t1\tsrc/app.ts\0').toString('base64'),
        branch: { currentBranch: 'feature/old', targetBranch: 'main' },
      },
    });

    expect(requestLocalCopySync).toHaveBeenCalledExactlyOnceWith(workspace.id);
  });

  it('forgets all Workspace Status state when a workspace is removed', async () => {
    const workspace = createWorkspace({ id: 'workspace-local' });
    const service = createStatusService({
      getWorkspace: () => workspace,
      listWorkspaces: () => [workspace],
    });
    await service.change({
      kind: 'snapshot-observed',
      snapshot: {
        source: {
          kind: 'local-watcher',
          instanceId: 'desktop-1',
          epoch: 'watcher-1',
          sequence: 1,
        },
        workspaceId: workspace.id,
        observedAt: 1_700_000_000_100,
        workingTree: { files: [], summary: { additions: 0, deletions: 0, filesChanged: 0 } },
        branch: {
          currentBranch: 'feature/local',
          mainBranch: 'main',
          defaultBranch: 'main',
          aheadTargetBranch: 0,
          behindTargetBranch: 0,
          hasRemote: false,
          hasOriginRemote: false,
          unpushedCommits: 0,
          behindRemote: 0,
          targetBranchHasRemote: false,
          targetBranchAheadRemote: 0,
          targetBranchBehindRemote: 0,
        },
      },
    });

    await service.change({ kind: 'workspace-removed', workspaceId: workspace.id });

    expect(service.read(workspace.id)).toBeUndefined();
  });
});

it('confirms remote status even when an untracked line count is unavailable', async () => {
  const workspace = createSshWorkspace();
  const service = createStatusService({
    getWorkspace: () => workspace,
    listWorkspaces: () => [workspace],
    getSshSnapshot: vi.fn().mockResolvedValue({
      statusText: ' M tracked.txt\0?? large.txt\0',
      numstatText: '3\t2\ttracked.txt\0',
      statusTooLarge: false,
      branch: { currentBranch: 'main', targetBranch: 'main' },
    }),
  });
  await service.change({ kind: 'refresh-requested', workspaceId: workspace.id });
  expect(service.read(workspace.id)).toMatchObject({
    confirmation: { kind: 'current' },
    workingTree: {
      files: [
        expect.objectContaining({ path: 'tracked.txt', additions: 3, deletions: 2 }),
        expect.objectContaining({ path: 'large.txt', lineCountsUnavailable: true }),
      ],
      summary: { additions: 3, deletions: 2, filesChanged: 2 },
    },
  });
});
