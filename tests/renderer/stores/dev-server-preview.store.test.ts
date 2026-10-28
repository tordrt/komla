/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useConfigStore } from '../../../src/renderer/stores/config.store';
import { useDevServerPreviewStore } from '../../../src/renderer/stores/dev-server-preview.store';
import { useFileViewerStore } from '../../../src/renderer/stores/file-viewer.store';
import { usePaneSurfacesStore } from '../../../src/renderer/stores/pane-surfaces.store';
import { useWorkspacesStore } from '../../../src/renderer/stores/workspaces.store';

import type { AppConfig, SshPreviewForward } from '../../../src/renderer/types';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function resetStores(): void {
  useDevServerPreviewStore.setState(useDevServerPreviewStore.getInitialState(), true);
  useFileViewerStore.setState(useFileViewerStore.getInitialState(), true);
  useWorkspacesStore.setState(useWorkspacesStore.getInitialState(), true);
  usePaneSurfacesStore.setState({ surfaces: {} });
  useConfigStore.setState({ config: null });
}

describe('dev-server-preview.store', () => {
  beforeEach(() => {
    resetStores();
    (window as unknown as { api?: unknown }).api = {
      updateWorkspace: vi.fn().mockResolvedValue(undefined),
      startSshPreviewForward: vi.fn(),
      stopSshPreviewForward: vi.fn().mockResolvedValue(undefined),
    };
  });

  it('keeps the page of a tab shown again through the tunnel it already has', async () => {
    const api = window.api as unknown as {
      startSshPreviewForward: ReturnType<typeof vi.fn>;
    };
    const forward = (id: string, port: number) => ({
      id,
      workspaceId: 'ws-1',
      localUrl: `http://127.0.0.1:${port}`,
      localPort: port,
      remotePort: port,
    });
    api.startSshPreviewForward
      .mockResolvedValueOnce(forward('forward-1', 6081))
      .mockResolvedValueOnce(forward('forward-2', 6082))
      .mockResolvedValueOnce(forward('forward-1', 6081));
    const store = useDevServerPreviewStore.getState();

    await store.startSshPreviewForward('ws-1', 'tab-1', 6081);
    await store.startSshPreviewForward('ws-1', 'tab-2', 6082);
    expect(useDevServerPreviewStore.getState().reloadKeyByWorkspace['ws-1']).toBe(2);
    await store.startSshPreviewForward('ws-1', 'tab-1', 6081);

    expect(api.startSshPreviewForward).toHaveBeenLastCalledWith('ws-1', 'tab-1', 6081, 'http');
    expect(useDevServerPreviewStore.getState().remoteForwardByWorkspace['ws-1']).toMatchObject({
      status: 'active',
      tabId: 'tab-1',
      forward: { id: 'forward-1' },
    });
    expect(useDevServerPreviewStore.getState().reloadKeyByWorkspace['ws-1']).toBe(2);
  });

  it('asks the main process to reuse the forward when only its URL path changes', async () => {
    const api = window.api as unknown as {
      startSshPreviewForward: ReturnType<typeof vi.fn>;
    };
    api.startSshPreviewForward.mockResolvedValue({
      id: 'forward-old',
      workspaceId: 'ws-1',
      localUrl: 'http://127.0.0.1:53001',
      localPort: 53001,
      remotePort: 3000,
    });

    await useDevServerPreviewStore.getState().startSshPreviewForward('ws-1', 'tab-1', 3000);
    await useDevServerPreviewStore
      .getState()
      .startSshPreviewForward('ws-1', 'tab-1', 3000, '/dashboard?tab=preview');

    expect(api.startSshPreviewForward).toHaveBeenCalledTimes(2);
    expect(useDevServerPreviewStore.getState().remoteForwardByWorkspace['ws-1']).toMatchObject({
      status: 'active',
      pathSuffix: '/dashboard?tab=preview',
      forward: { id: 'forward-old', localPort: 53001 },
    });
  });

  it('replaces stale renderer state with the forward returned by the main process', async () => {
    const api = window.api as unknown as {
      startSshPreviewForward: ReturnType<typeof vi.fn>;
    };
    api.startSshPreviewForward
      .mockResolvedValueOnce({
        id: 'forward-old',
        workspaceId: 'ws-1',
        localUrl: 'http://127.0.0.1:53001',
        localPort: 53001,
        remotePort: 3000,
      })
      .mockResolvedValueOnce({
        id: 'forward-new',
        workspaceId: 'ws-1',
        localUrl: 'http://127.0.0.1:53002',
        localPort: 53002,
        remotePort: 3000,
      });

    await useDevServerPreviewStore.getState().startSshPreviewForward('ws-1', 'tab-1', 3000);
    await useDevServerPreviewStore.getState().startSshPreviewForward('ws-1', 'tab-1', 3000);

    expect(api.startSshPreviewForward).toHaveBeenCalledTimes(2);
    expect(useDevServerPreviewStore.getState().remoteForwardByWorkspace['ws-1']).toMatchObject({
      status: 'active',
      forward: { id: 'forward-new', localPort: 53002 },
    });
  });

  it('clears renderer forward state without stopping the main-process forward', async () => {
    const api = window.api as unknown as {
      startSshPreviewForward: ReturnType<typeof vi.fn>;
      stopSshPreviewForward: ReturnType<typeof vi.fn>;
    };
    api.startSshPreviewForward.mockResolvedValue({
      id: 'forward-old',
      workspaceId: 'ws-1',
      localUrl: 'http://127.0.0.1:53001',
      localPort: 53001,
      remotePort: 3000,
    });
    await useDevServerPreviewStore.getState().startSshPreviewForward('ws-1', 'tab-1', 3000);

    useDevServerPreviewStore.getState().clearSshPreviewForwardState('ws-1');

    expect(useDevServerPreviewStore.getState().remoteForwardByWorkspace['ws-1']).toBeUndefined();
    expect(api.stopSshPreviewForward).not.toHaveBeenCalled();
  });

  it('ignores an older forward completion after a newer request starts', async () => {
    const first = deferred<SshPreviewForward>();
    const second = deferred<SshPreviewForward>();
    const api = window.api as unknown as {
      startSshPreviewForward: ReturnType<typeof vi.fn>;
    };
    api.startSshPreviewForward
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const firstStart = useDevServerPreviewStore
      .getState()
      .startSshPreviewForward('ws-1', 'tab-1', 3000);
    const secondStart = useDevServerPreviewStore
      .getState()
      .startSshPreviewForward('ws-1', 'tab-1', 5173);
    second.resolve({
      id: 'forward-new',
      workspaceId: 'ws-1',
      localUrl: 'http://127.0.0.1:53002',
      localPort: 53002,
      remotePort: 5173,
    });
    await secondStart;
    first.resolve({
      id: 'forward-old',
      workspaceId: 'ws-1',
      localUrl: 'http://127.0.0.1:53001',
      localPort: 53001,
      remotePort: 3000,
    });
    await firstStart;

    expect(useDevServerPreviewStore.getState().remoteForwardByWorkspace['ws-1']).toMatchObject({
      status: 'active',
      remotePort: 5173,
      forward: { id: 'forward-new' },
    });
    expect(useDevServerPreviewStore.getState().reloadKeyByWorkspace['ws-1']).toBe(1);
  });

  it('passes HTTPS through to the main-process forward request', async () => {
    const api = window.api as unknown as {
      startSshPreviewForward: ReturnType<typeof vi.fn>;
    };
    api.startSshPreviewForward.mockResolvedValue({
      id: 'forward-https',
      workspaceId: 'ws-1',
      localUrl: 'https://127.0.0.1:53001',
      localPort: 53001,
      remotePort: 443,
    });

    await useDevServerPreviewStore
      .getState()
      .startSshPreviewForward('ws-1', 'tab-1', 443, '/dashboard', 'https');

    expect(api.startSshPreviewForward).toHaveBeenCalledWith('ws-1', 'tab-1', 443, 'https');
    expect(useDevServerPreviewStore.getState().remoteForwardByWorkspace['ws-1']).toMatchObject({
      status: 'active',
      scheme: 'https',
      pathSuffix: '/dashboard',
    });
  });

  it('does not let an older stop completion delete a newer forward', async () => {
    const stop = deferred<void>();
    const api = window.api as unknown as {
      startSshPreviewForward: ReturnType<typeof vi.fn>;
      stopSshPreviewForward: ReturnType<typeof vi.fn>;
    };
    api.startSshPreviewForward.mockResolvedValueOnce({
      id: 'forward-old',
      workspaceId: 'ws-1',
      localUrl: 'http://127.0.0.1:53001',
      localPort: 53001,
      remotePort: 3000,
    });
    api.stopSshPreviewForward.mockReturnValue(stop.promise);
    await useDevServerPreviewStore.getState().startSshPreviewForward('ws-1', 'tab-1', 3000);

    const stopping = useDevServerPreviewStore.getState().stopSshPreviewForward('ws-1');
    api.startSshPreviewForward.mockResolvedValueOnce({
      id: 'forward-new',
      workspaceId: 'ws-1',
      localUrl: 'http://127.0.0.1:53002',
      localPort: 53002,
      remotePort: 5173,
    });
    await useDevServerPreviewStore.getState().startSshPreviewForward('ws-1', 'tab-1', 5173);
    stop.resolve();
    await stopping;

    expect(useDevServerPreviewStore.getState().remoteForwardByWorkspace['ws-1']).toMatchObject({
      status: 'active',
      remotePort: 5173,
      forward: { id: 'forward-new' },
    });
  });

  it('stops the active main-process forward when a pending replacement is cancelled', async () => {
    const api = window.api as unknown as {
      startSshPreviewForward: ReturnType<typeof vi.fn>;
      stopSshPreviewForward: ReturnType<typeof vi.fn>;
    };
    api.startSshPreviewForward.mockResolvedValueOnce({
      id: 'forward-old',
      workspaceId: 'ws-1',
      localUrl: 'http://127.0.0.1:53001',
      localPort: 53001,
      remotePort: 3000,
    });
    await useDevServerPreviewStore.getState().startSshPreviewForward('ws-1', 'tab-1', 3000);
    useDevServerPreviewStore.getState().requestSshPreviewForward('ws-1', 'tab-1', 5173);

    await useDevServerPreviewStore.getState().stopSshPreviewForward('ws-1');

    expect(api.stopSshPreviewForward).toHaveBeenCalledWith('ws-1', 'tab-1');
    expect(useDevServerPreviewStore.getState().remoteForwardByWorkspace['ws-1']).toBeUndefined();
  });

  it('keeps a user stop with the saved URL its tunnel belonged to', async () => {
    const api = window.api as unknown as {
      startSshPreviewForward: ReturnType<typeof vi.fn>;
      stopSshPreviewForward: ReturnType<typeof vi.fn>;
    };
    api.startSshPreviewForward.mockResolvedValueOnce({
      id: 'forward-old',
      workspaceId: 'ws-1',
      localUrl: 'http://127.0.0.1:53001',
      localPort: 53001,
      remotePort: 3000,
    });
    await useDevServerPreviewStore
      .getState()
      .startSshPreviewForward('ws-1', 'tab-1', 3000, '/app', 'http', 'http://localhost:3000/app');

    await useDevServerPreviewStore.getState().stopSshPreviewForward('ws-1', { keepStopped: true });

    expect(api.stopSshPreviewForward).toHaveBeenCalledWith('ws-1', 'tab-1');
    expect(useDevServerPreviewStore.getState().remoteForwardByWorkspace['ws-1']).toMatchObject({
      status: 'stopped',
      remotePort: 3000,
      pathSuffix: '/app',
      savedUrl: 'http://localhost:3000/app',
    });
  });

  it('marks a forward stopped when its workspace stops', () => {
    useDevServerPreviewStore
      .getState()
      .requestSshPreviewForward('ws-1', 'tab-1', 3000, '', 'http', 'http://localhost:3000');

    useDevServerPreviewStore.getState().clearSshPreviewForwardState('ws-1', { keepStopped: true });

    expect(useDevServerPreviewStore.getState().remoteForwardByWorkspace['ws-1']).toMatchObject({
      status: 'stopped',
      savedUrl: 'http://localhost:3000',
    });
  });

  it("keeps a browser pane's tunnel apart from the browser panel's", async () => {
    const api = window.api as unknown as {
      startSshPreviewForward: ReturnType<typeof vi.fn>;
    };
    api.startSshPreviewForward.mockImplementation((_ws: string, _tab: string, port: number) =>
      Promise.resolve({
        id: `forward-${port}`,
        workspaceId: 'ws-1',
        localUrl: `http://127.0.0.1:${port}`,
        localPort: port,
        remotePort: port,
      })
    );
    usePaneSurfacesStore.setState({
      surfaces: {
        'surface:browser:a': {
          kind: 'browser',
          workspaceId: 'ws-1',
          browserTabs: [],
          activeBrowserTabId: undefined,
        },
      },
    });
    const store = useDevServerPreviewStore.getState();

    await store.startSshPreviewForward('ws-1', 'tab-1', 3000);
    await store.startSshPreviewForward('ws-1', 'surface:browser:a/tab-2', 5173);

    expect(api.startSshPreviewForward).toHaveBeenLastCalledWith(
      'ws-1',
      'surface:browser:a/tab-2',
      5173,
      'http'
    );
    const { remoteForwardByWorkspace, reloadKeyByWorkspace } = useDevServerPreviewStore.getState();
    expect(remoteForwardByWorkspace['ws-1']).toMatchObject({ status: 'active', tabId: 'tab-1' });
    expect(remoteForwardByWorkspace['surface:browser:a']).toMatchObject({
      status: 'active',
      tabId: 'surface:browser:a/tab-2',
    });
    expect(reloadKeyByWorkspace).toEqual({ 'ws-1': 1, 'surface:browser:a': 1 });

    // Stopping the workspace stops both.
    store.clearSshPreviewForwardState('ws-1', { keepStopped: true });
    expect(useDevServerPreviewStore.getState().remoteForwardByWorkspace).toMatchObject({
      'ws-1': { status: 'stopped' },
      'surface:browser:a': { status: 'stopped' },
    });
  });

  it('bumpReloadKey increments per-workspace counter', () => {
    useDevServerPreviewStore.getState().bumpReloadKey('ws-1');
    expect(useDevServerPreviewStore.getState().reloadKeyByWorkspace['ws-1']).toBe(1);
    useDevServerPreviewStore.getState().bumpReloadKey('ws-1');
    expect(useDevServerPreviewStore.getState().reloadKeyByWorkspace['ws-1']).toBe(2);
  });

  it('bumpProbeKey increments per-workspace counter', () => {
    useDevServerPreviewStore.getState().bumpProbeKey('ws-1');
    expect(useDevServerPreviewStore.getState().probeKeyByWorkspace['ws-1']).toBe(1);
    useDevServerPreviewStore.getState().bumpProbeKey('ws-1');
    expect(useDevServerPreviewStore.getState().probeKeyByWorkspace['ws-1']).toBe(2);
  });

  it('toggleAutoReload treats missing workspace state as enabled by default', () => {
    useDevServerPreviewStore.getState().toggleAutoReload('ws-1');
    expect(useDevServerPreviewStore.getState().autoReloadByWorkspace['ws-1']).toBe(false);

    useDevServerPreviewStore.getState().toggleAutoReload('ws-1');
    expect(useDevServerPreviewStore.getState().autoReloadByWorkspace['ws-1']).toBe(true);
  });

  it('toggleAutoReload can use a disabled configured default', () => {
    useDevServerPreviewStore.getState().toggleAutoReload('ws-1', false);
    expect(useDevServerPreviewStore.getState().autoReloadByWorkspace['ws-1']).toBe(true);
  });
});
