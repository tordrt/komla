import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mockElectron } from '../../mocks/electron';

import type { Workspace } from '../../../src/shared/types/workspace';

vi.mock('electron', () => mockElectron());
vi.mock('../../../src/main/lib/atomic-write', () => ({
  writeFileAtomic: vi.fn(() => Promise.resolve()),
}));

const workspace = (overrides: Partial<Workspace> = {}) =>
  ({ id: 'ws-1', terminals: [], status: 'active', ...overrides }) as unknown as Workspace;

describe('workspaceStore', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  describe('updateLinkedWorkspaceIds', () => {
    it('throws for a workspace it does not have', async () => {
      const { workspaceStore } = await import('../../../src/main/services/workspace/store');
      expect(() => workspaceStore.updateLinkedWorkspaceIds('missing', [])).toThrow(
        'Workspace missing not found'
      );
    });

    it('clears a Trash date left on a workspace restarted from the Trash', async () => {
      const { workspaceStore } = await import('../../../src/main/services/workspace/store');
      const restarted = workspace({ trashedAt: 1_000 });
      workspaceStore.workspaces.set(restarted.id, restarted);

      workspaceStore.updateLinkedWorkspaceIds(restarted.id, ['ws-2']);

      expect(restarted.linkedWorkspaceIds).toEqual(['ws-2']);
      expect(restarted.trashedAt).toBeUndefined();
    });

    it('keeps the Trash date of a workspace in the Trash', async () => {
      const { workspaceStore } = await import('../../../src/main/services/workspace/store');
      const trashed = workspace({ status: 'trashed', trashedAt: 1_000 });
      workspaceStore.workspaces.set(trashed.id, trashed);

      workspaceStore.updateLinkedWorkspaceIds(trashed.id, undefined);

      expect(trashed.trashedAt).toBe(1_000);
    });
  });

  it('refuses a checked save until it has an owner to save for', async () => {
    const { workspaceStore } = await import('../../../src/main/services/workspace/store');

    await expect(workspaceStore.saveWorkspacesImmediateChecked()).rejects.toThrow(
      'no owner to save for'
    );
  });

  it('runs the owner’s part of a save, then writes to the owner’s path', async () => {
    const { workspaceStore } = await import('../../../src/main/services/workspace/store');
    const { writeFileAtomic } = await import('../../../src/main/lib/atomic-write');
    const saving = vi.fn();
    workspaceStore.attach({
      workspacesPath: '/data/workspaces.json',
      terminalStatus: () => null,
      saving,
      persistedSources: () => undefined,
    });
    workspaceStore.workspaces.set('ws-1', workspace());

    await workspaceStore.saveWorkspacesImmediateChecked();

    expect(saving).toHaveBeenCalledOnce();
    expect(writeFileAtomic).toHaveBeenCalledWith('/data/workspaces.json', expect.any(String));
  });

  it('gives lookups the status the owner reports for a Terminal', async () => {
    const { workspaceStore } = await import('../../../src/main/services/workspace/store');
    const terminal = { id: 't-1', status: 'starting' };
    workspaceStore.attach({
      workspacesPath: '/data/workspaces.json',
      terminalStatus: () => 'running',
      saving: vi.fn(),
      persistedSources: () => undefined,
    });
    workspaceStore.workspaces.set(
      'ws-1',
      workspace({ terminals: [terminal] as unknown as Workspace['terminals'] })
    );

    expect(workspaceStore.get('ws-1')?.terminals[0]?.status).toBe('running');
  });
});
