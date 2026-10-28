import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/main/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../../src/main/services/ssh-workspace.service', () => ({
  sshWorkspaceService: {},
}));

import { SshWorkspaceProvisioningService } from '../../../src/main/services/ssh-workspace-provisioning.service';
import { createWorkspace } from '../../factories';

import type { SshWorkspaceProvisioningDependencies } from '../../../src/main/services/ssh-workspace-provisioning.service';
import type { SshWorkspaceCreateResult } from '../../../src/main/services/ssh-workspace.service';
import type { SshWorkspaceBackend, Workspace } from '../../../src/shared/types';

function plan(branchName: string): SshWorkspaceCreateResult {
  const backend: SshWorkspaceBackend = {
    kind: 'ssh',
    hostId: 'host-1',
    remoteDirectory: `/remote/project/${branchName}`,
    remoteRepoPath: '/remote/project/repository.git',
    remoteProjectRoot: '/remote/project',
    gitUrl: 'git@example.com:team/project.git',
    branchName,
  };
  return {
    backend,
    workingDirectory: `ssh://${backend.hostId}${backend.remoteDirectory}`,
    repoName: 'project',
  };
}

function setup() {
  const workspace = createWorkspace({
    ...plan('feature'),
    branchName: 'feature',
    provisioning: true,
  });
  const workspaces = [workspace];
  let persisted: Workspace | undefined;
  const ssh = {
    ensureWorkspaceReady: vi
      .fn<SshWorkspaceProvisioningDependencies['ssh']['ensureWorkspaceReady']>()
      .mockResolvedValue({ createdWorktree: true, createdBranch: true }),
    withRemoteDirectoryAttempt: (backend: SshWorkspaceBackend, attempt: number) => ({
      ...backend,
      remoteDirectory: `${backend.remoteDirectory}-${attempt}`,
    }),
    deleteWorkspace: vi
      .fn<SshWorkspaceProvisioningDependencies['ssh']['deleteWorkspace']>()
      .mockResolvedValue(undefined),
  };
  const installCompanion = vi
    .fn<SshWorkspaceProvisioningDependencies['installCompanion']>()
    .mockResolvedValue('/remote/helpers/bin/komla');
  const dependencies: SshWorkspaceProvisioningDependencies = {
    listWorkspaces: () => workspaces,
    saveWorkspaces: vi.fn(),
    persistWorkspaces: vi.fn(async () => {
      persisted = structuredClone(workspace);
    }),
    broadcastWorkspaceUpdate: vi.fn(),
    maxAttempts: 3,
    nextBranchName: (base, _prefix, attempt) => `${base}-${attempt}`,
    workspaceName: (branch) => branch,
    branchConflictError: (branch, conflict) => new Error(`${branch} is open in ${conflict.name}`),
    installCompanion,
    ssh,
  };
  const module = new SshWorkspaceProvisioningService(dependencies);
  return {
    workspace,
    workspaces,
    ssh,
    installCompanion,
    dependencies,
    module,
    persisted: () => persisted!,
    prepare: () =>
      module.prepare(workspace, {
        initialBranchName: 'feature',
        params: { autoResolveBranchConflicts: true },
        branchPrefix: '',
        createPlan: plan,
      }),
    restart: () => new SshWorkspaceProvisioningService(dependencies),
  };
}

function conflict(code: string): Error {
  return Object.assign(new Error('remote conflict'), { code });
}

describe('SSH Workspace repository provisioning', () => {
  it('installs the Remote Companion once, when setup asks for it', async () => {
    const f = setup();
    const answers: Array<string | undefined> = [];
    f.ssh.ensureWorkspaceReady
      .mockImplementationOnce(async (_backend, companion) => {
        answers.push(await companion?.());
        throw conflict('SSH_WORKTREE_PATH_CONFLICT');
      })
      .mockImplementationOnce(async (_backend, companion) => {
        answers.push(await companion?.());
        return { createdWorktree: true, createdBranch: true };
      });

    await f.prepare();

    expect(answers).toEqual(['/remote/helpers/bin/komla', '/remote/helpers/bin/komla']);
    expect(f.installCompanion).toHaveBeenCalledTimes(1);
    expect(f.installCompanion).toHaveBeenCalledWith(
      expect.objectContaining({ hostId: 'host-1', remoteProjectRoot: '/remote/project' })
    );
  });

  it('does not install the Remote Companion when setup does not ask for it', async () => {
    const f = setup();

    await f.prepare();

    expect(f.installCompanion).not.toHaveBeenCalled();
  });

  it('prepares a workspace without the Remote Companion when it cannot be installed', async () => {
    const f = setup();
    f.installCompanion.mockImplementation(() => {
      throw new Error('unsupported host');
    });
    let answer: string | undefined = 'not asked';
    f.ssh.ensureWorkspaceReady.mockImplementationOnce(async (_backend, companion) => {
      answer = await companion?.();
      return { createdWorktree: true, createdBranch: true };
    });

    await f.prepare();

    expect(answer).toBeUndefined();
  });

  it('persists final ownership and directory after branch and folder retries for restart recovery', async () => {
    const f = setup();
    f.workspaces.push(createWorkspace({ ...plan('feature'), branchName: 'feature' }));
    f.ssh.ensureWorkspaceReady
      .mockRejectedValueOnce(conflict('SSH_BRANCH_ALREADY_EXISTS'))
      .mockRejectedValueOnce(conflict('SSH_WORKTREE_PATH_CONFLICT'))
      .mockResolvedValueOnce({
        createdWorktree: true,
        createdBranch: false,
        defaultBranch: 'trunk',
        baseBranch: 'trunk',
      });

    await f.prepare();

    expect(f.workspace).toMatchObject({
      branchName: 'feature-2',
      workingDirectory: 'ssh://host-1/remote/project/feature-2-2',
      backend: { defaultBranch: 'trunk', baseBranch: 'trunk' },
    });
    expect(f.persisted()).toMatchObject({
      provisioningWorktreeCreated: true,
      provisioningBranchCreated: false,
    });
    expect(await f.restart().recover(f.persisted(), 'interrupted')).toBe('remove');
    expect(f.ssh.deleteWorkspace).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ remoteDirectory: '/remote/project/feature-2-2' }),
      false,
      'feature-2'
    );
  });

  it('waits for the ownership checkpoint before preparation is ready for Terminal launch', async () => {
    const f = setup();
    let finishSave!: () => void;
    f.dependencies.persistWorkspaces = () =>
      new Promise<void>((resolve) => {
        finishSave = resolve;
      });
    const launch = vi.fn();
    const preparation = f.prepare().then(launch);
    await vi.waitFor(() => expect(finishSave).toBeTypeOf('function'));
    expect(launch).not.toHaveBeenCalled();
    finishSave();
    await preparation;
    expect(launch).toHaveBeenCalledOnce();
  });

  it('retains in-memory ownership for recovery when its persistence checkpoint fails', async () => {
    const f = setup();
    f.dependencies.persistWorkspaces = async () => {
      throw new Error('disk full');
    };
    await expect(f.prepare()).rejects.toThrow('disk full');
    expect(await f.module.recover(f.workspace, 'failed')).toBe('remove');
    expect(f.ssh.deleteWorkspace).toHaveBeenCalledExactlyOnceWith(
      f.workspace.backend,
      true,
      'feature'
    );
  });

  it.each(['interrupted', 'failed', 'cancelled'] as const)(
    'does not infer ownership from successful preparation during %s recovery',
    async (reason) => {
      const f = setup();
      f.ssh.ensureWorkspaceReady.mockResolvedValueOnce({
        createdWorktree: false,
        createdBranch: false,
      });
      await f.prepare();
      expect(await f.module.recover(f.workspace, reason)).toBe('remove');
      expect(f.ssh.deleteWorkspace).not.toHaveBeenCalled();
    }
  );

  it('does not contact SSH when interrupted ownership metadata is missing', async () => {
    const f = setup();
    expect(await f.module.recover(f.workspace, 'interrupted')).toBe('remove');
    expect(f.ssh.deleteWorkspace).not.toHaveBeenCalled();
  });

  it.each(['interrupted', 'failed'] as const)(
    'retains ownership and retry guidance when %s recovery fails',
    async (reason) => {
      const f = setup();
      await f.prepare();
      f.workspace.provisionError = 'Terminal launch failed';
      f.ssh.deleteWorkspace.mockRejectedValueOnce(new Error('host offline'));
      expect(await f.module.recover(f.workspace, reason)).toBe('retain');
      expect(f.workspace.provisionError).toContain('retry cleanup');
      const restored = structuredClone(f.workspace);
      expect(await f.restart().recover(restored, reason)).toBe('remove');
      expect(f.ssh.deleteWorkspace).toHaveBeenLastCalledWith(f.workspace.backend, true, 'feature');
    }
  );

  it('clears rollback ownership only when provisioning completes', async () => {
    const f = setup();
    await f.prepare();
    f.module.complete(f.workspace);
    expect(f.workspace.provisioning).toBe(false);
    expect(await f.module.recover(f.workspace, 'interrupted')).toBe('remove');
    expect(f.ssh.deleteWorkspace).not.toHaveBeenCalled();
  });

  it('prepares an unpublished immediate workspace without a persistence checkpoint', async () => {
    const f = setup();
    f.workspace.provisioning = undefined;
    f.workspaces.length = 0;
    await f.prepare();
    expect(f.dependencies.saveWorkspaces).not.toHaveBeenCalled();
    expect(f.dependencies.persistWorkspaces).not.toHaveBeenCalled();
  });

  it('rejects a Komla branch conflict during planning before contacting SSH', () => {
    const f = setup();
    expect(() =>
      f.module.plan({
        initialBranchName: 'feature',
        params: {},
        branchPrefix: '',
        createPlan: plan,
      })
    ).toThrow('feature is open');
    expect(f.ssh.ensureWorkspaceReady).not.toHaveBeenCalled();
  });

  it('stops at the retry limit and reports local and remote conflicts', async () => {
    const f = setup();
    f.workspaces.push(createWorkspace({ ...plan('feature'), branchName: 'feature' }));
    f.ssh.ensureWorkspaceReady.mockRejectedValue(conflict('SSH_BRANCH_ALREADY_EXISTS'));
    await expect(f.prepare()).rejects.toThrow(
      '1 Komla workspace conflicts, 2 existing remote branches'
    );
    expect(f.ssh.ensureWorkspaceReady).toHaveBeenCalledTimes(2);
    expect(f.dependencies.persistWorkspaces).not.toHaveBeenCalled();
  });

  it('does not retry unrelated failures whose text mentions a conflict', async () => {
    const f = setup();
    f.ssh.ensureWorkspaceReady.mockRejectedValueOnce(
      new Error('SSH_BRANCH_ALREADY_EXISTS: permission denied')
    );
    await expect(f.prepare()).rejects.toThrow('permission denied');
    expect(f.ssh.ensureWorkspaceReady).toHaveBeenCalledOnce();
    expect(f.dependencies.persistWorkspaces).not.toHaveBeenCalled();
  });

  it('rejects a local workspace before changing it or contacting SSH', async () => {
    const f = setup();
    const workspace = createWorkspace();
    const original = structuredClone(workspace);
    await expect(
      f.module.prepare(workspace, {
        initialBranchName: 'feature',
        params: {},
        branchPrefix: '',
        createPlan: plan,
      })
    ).rejects.toThrow('requires an SSH workspace');
    await expect(f.module.recover(workspace, 'failed')).rejects.toThrow(
      'requires an SSH workspace'
    );
    expect(() => f.module.complete(workspace)).toThrow('requires an SSH workspace');
    expect(workspace).toEqual(original);
    expect(f.ssh.ensureWorkspaceReady).not.toHaveBeenCalled();
    expect(f.ssh.deleteWorkspace).not.toHaveBeenCalled();
  });
});
