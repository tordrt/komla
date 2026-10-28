import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useConfigStore } from '../../../src/renderer/stores/config.store';
import { useSshHostsStore } from '../../../src/renderer/stores/ssh-hosts.store';

const host = {
  id: 'ssh-dev',
  name: 'Devbox',
  hostname: 'dev.example.com',
  basePath: '~/.komla',
};

function resetStore(): void {
  useSshHostsStore.setState(useSshHostsStore.getInitialState(), true);
}

function mockApi(overrides: Record<string, unknown> = {}) {
  const api = {
    listSshHosts: vi.fn().mockResolvedValue([host]),
    saveSshHost: vi.fn().mockImplementation(async (value) => value),
    onSshHostsChange: vi.fn().mockReturnValue(vi.fn()),
    deleteSshHost: vi.fn().mockResolvedValue({ deletedWorkspaceIds: ['workspace-1'] }),
    ...overrides,
  };
  (globalThis as { window?: unknown }).window = { api };
  return api;
}

describe('ssh-hosts.store', () => {
  beforeEach(() => {
    resetStore();
    mockApi();
  });

  it('loads hosts from dedicated SSH persistence', async () => {
    await useSshHostsStore.getState().loadHosts();

    expect(useSshHostsStore.getState()).toMatchObject({
      hosts: [host],
      isLoading: false,
      hasLoaded: true,
      error: null,
    });
  });

  it('shares an in-flight host load and retries after a transient failure', async () => {
    const loadError = new Error('load failed');
    const api = mockApi({ listSshHosts: vi.fn().mockRejectedValue(loadError) });

    const firstLoad = useSshHostsStore.getState().loadHosts();
    const secondLoad = useSshHostsStore.getState().loadHosts();
    await Promise.all([firstLoad, secondLoad]);

    expect(api.listSshHosts).toHaveBeenCalledOnce();
    expect(useSshHostsStore.getState()).toMatchObject({
      isLoading: false,
      hasLoaded: false,
      error: loadError.message,
    });

    api.listSshHosts.mockResolvedValueOnce([host]);
    await useSshHostsStore.getState().loadHosts();

    expect(api.listSshHosts).toHaveBeenCalledTimes(2);
    expect(useSshHostsStore.getState()).toMatchObject({
      hosts: [host],
      isLoading: false,
      hasLoaded: true,
      error: null,
    });
  });

  it('adds and updates saved hosts locally', async () => {
    await useSshHostsStore.getState().saveHost(host);
    await useSshHostsStore.getState().saveHost({ ...host, name: 'Renamed' });

    expect(useSshHostsStore.getState().hosts).toEqual([{ ...host, name: 'Renamed' }]);
  });

  it('clears pending first-host setup when settings closes', async () => {
    useSshHostsStore.setState({ hosts: [{ ...host, setupPending: true }] });

    await useSshHostsStore.getState().completePendingSetup();

    expect(window.api.saveSshHost).toHaveBeenCalledWith({ ...host, setupPending: false });
    expect(useSshHostsStore.getState().hosts).toEqual([{ ...host, setupPending: false }]);
  });

  it('starts new workspaces on the host once its first-time setup completes', async () => {
    const updateConfig = vi.fn().mockResolvedValue({ ok: true, error: null });
    useConfigStore.setState({ updateConfig });
    useSshHostsStore.setState({ hosts: [{ ...host, setupPending: true }] });

    await useSshHostsStore.getState().completePendingSetup();

    expect(updateConfig).toHaveBeenCalledWith({
      lastWorkspaceEnvironment: { kind: 'ssh', hostId: 'ssh-dev' },
    });
  });

  it('clears first-host setup that finishes saving after settings closes', async () => {
    let resolveInitialSave: ((savedHost: typeof host & { setupPending: boolean }) => void) | undefined;
    const initialSave = new Promise<typeof host & { setupPending: boolean }>((resolve) => {
      resolveInitialSave = resolve;
    });
    const api = mockApi({
      saveSshHost: vi
        .fn()
        .mockImplementationOnce(() => initialSave)
        .mockImplementation(async (value) => value),
    });
    const pendingHost = { ...host, setupPending: true };

    useSshHostsStore.getState().beginPendingSetup();
    const save = useSshHostsStore.getState().saveHost(pendingHost);
    await useSshHostsStore.getState().completePendingSetup();
    resolveInitialSave?.(pendingHost);
    await save;

    expect(api.saveSshHost).toHaveBeenNthCalledWith(1, pendingHost);
    expect(api.saveSshHost).toHaveBeenNthCalledWith(2, { ...host, setupPending: false });
    expect(useSshHostsStore.getState().hosts).toEqual([{ ...host, setupPending: false }]);
  });

  it('clears first-host setup saved after verification finishes outside settings', async () => {
    const pendingHost = { ...host, setupPending: true };

    useSshHostsStore.getState().beginPendingSetup();
    await useSshHostsStore.getState().completePendingSetup();
    await useSshHostsStore.getState().saveHost(pendingHost);

    expect(window.api.saveSshHost).toHaveBeenNthCalledWith(1, pendingHost);
    expect(window.api.saveSshHost).toHaveBeenNthCalledWith(2, { ...host, setupPending: false });
    expect(useSshHostsStore.getState().hosts).toEqual([{ ...host, setupPending: false }]);
  });

  it('removes a host after workspace cleanup succeeds', async () => {
    useSshHostsStore.setState({ hosts: [host] });

    const result = await useSshHostsStore
      .getState()
      .deleteHost('ssh-dev', { deleteRemoteData: true });

    expect(result).toEqual({ deletedWorkspaceIds: ['workspace-1'] });
    expect(window.api.deleteSshHost).toHaveBeenCalledWith('ssh-dev', {
      deleteRemoteData: true,
    });
    expect(useSshHostsStore.getState().hosts).toEqual([]);
  });

  it('replaces hosts from cross-window changes and unsubscribes', () => {
    let listener: ((hosts: (typeof host)[]) => void) | undefined;
    const unsubscribe = vi.fn();
    const api = mockApi({
      onSshHostsChange: vi.fn((callback) => {
        listener = callback;
        return unsubscribe;
      }),
    });
    useSshHostsStore.setState({ hosts: [host], error: 'stale error' });

    const cleanup = useSshHostsStore.getState().subscribeToChanges();
    listener?.([{ ...host, name: 'Renamed elsewhere' }]);

    expect(api.onSshHostsChange).toHaveBeenCalledOnce();
    expect(useSshHostsStore.getState()).toMatchObject({
      hosts: [{ ...host, name: 'Renamed elsewhere' }],
      error: null,
    });

    cleanup();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('preserves hosts and surfaces save errors', async () => {
    mockApi({ saveSshHost: vi.fn().mockRejectedValue(new Error('save failed')) });
    useSshHostsStore.setState({ hosts: [host] });

    expect(await useSshHostsStore.getState().saveHost({ ...host, name: 'Renamed' })).toEqual({
      ok: false,
      error: 'save failed',
    });
    expect(useSshHostsStore.getState().hosts).toEqual([host]);
  });
});
