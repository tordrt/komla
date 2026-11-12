// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAppLifecycle } from '../../../src/renderer/hooks/useAppLifecycle';
import { useConfigStore } from '../../../src/renderer/stores/config.store';
import { useProjectsStore } from '../../../src/renderer/stores/projects.store';
import { useToastStore } from '../../../src/renderer/stores/toast.store';
import { useWindowStore } from '../../../src/renderer/stores/window.store';
import { useWorkspacesStore } from '../../../src/renderer/stores/workspaces.store';

import type { Project, Workspace } from '../../../src/renderer/types';

const workspace = (id: string, title: string) =>
  ({
    id,
    projectId: 'p1',
    terminals: [{ id: `${id}-term`, status: 'running', dynamicTitle: title }],
  }) as unknown as Workspace;

describe('useAppLifecycle', () => {
  const listeners = new Map<string, number>();

  beforeEach(() => {
    listeners.clear();
    // Every `on…` subscribes and returns its cleanup; everything else resolves to nothing.
    const api = new Proxy(
      {},
      {
        get: (_target, key: string) =>
          key.startsWith('on')
            ? () => {
                listeners.set(key, (listeners.get(key) ?? 0) + 1);
                return () => {};
              }
            : vi.fn().mockResolvedValue(undefined),
      }
    );
    Object.defineProperty(window, 'api', { value: api, configurable: true });
    useWorkspacesStore.setState({
      workspaces: [workspace('ws-1', 'idle'), workspace('ws-2', 'idle')],
      selectedWorkspaceId: 'ws-1',
    });
  });

  // It runs in App, so a re-render here re-renders the whole window.
  it('neither re-renders nor resubscribes when a workspace changes', () => {
    let renders = 0;
    renderHook(() => {
      renders += 1;
      useAppLifecycle({
        sidebarElement: null,
        mainElement: null,
        setNewWorkspaceDialogOpen: () => {},
        setFeedbackOpen: () => {},
      });
    });
    const rendersBefore = renders;
    const subscriptionsBefore = listeners.get('onTerminalStatusChange');

    act(() => {
      useWorkspacesStore.getState().setTerminalDynamicTitle('ws-2-term', 'building');
      useWorkspacesStore.getState().setTerminalDynamicTitle('ws-1-term', 'testing');
      useWorkspacesStore.getState().updateTerminalStatus('ws-2-term', 'stopped');
    });

    expect(renders).toBe(rendersBefore);
    expect(listeners.get('onTerminalStatusChange')).toBe(subscriptionsBefore);
  });

  describe('the bottom row on the root', () => {
    const render = () =>
      renderHook(() =>
        useAppLifecycle({
          sidebarElement: null,
          mainElement: null,
          setNewWorkspaceDialogOpen: () => {},
          setFeedbackOpen: () => {},
        })
      );

    afterEach(() => {
      useConfigStore.setState({ config: null });
      delete document.documentElement.dataset.statusBarRow;
    });

    it('follows the status bar size, medium until config says otherwise', () => {
      render();
      expect(document.documentElement.dataset.statusBarRow).toBe('medium');

      act(() => useConfigStore.setState({ config: { statusBarSize: 'large' } }));

      expect(document.documentElement.dataset.statusBarRow).toBe('large');
    });

    it('is small while the bar is hidden, so the rows that share its height keep theirs', () => {
      useConfigStore.setState({ config: { statusBarSize: 'large', showStatusBar: false } });
      render();

      expect(document.documentElement.dataset.statusBarRow).toBe('small');
    });
  });

  describe('when the network comes back', () => {
    const reconnectAfterNetworkReturns = vi.fn().mockResolvedValue(undefined);
    const render = () =>
      renderHook(() =>
        useAppLifecycle({
          sidebarElement: null,
          mainElement: null,
          setNewWorkspaceDialogOpen: () => {},
          setFeedbackOpen: () => {},
        })
      );

    beforeEach(() => {
      vi.useFakeTimers();
      reconnectAfterNetworkReturns.mockClear();
      useWorkspacesStore.setState({ reconnectAfterNetworkReturns });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('reconnects the workspace on screen once DNS and routes have had a moment', () => {
      const { unmount } = render();

      window.dispatchEvent(new Event('online'));
      expect(reconnectAfterNetworkReturns).not.toHaveBeenCalled();
      vi.advanceTimersByTime(3000);
      expect(reconnectAfterNetworkReturns).toHaveBeenCalledOnce();

      unmount();
      window.dispatchEvent(new Event('online'));
      vi.advanceTimersByTime(3000);
      expect(reconnectAfterNetworkReturns).toHaveBeenCalledOnce();
    });

    it('waits again when the network goes away before then', () => {
      render();

      window.dispatchEvent(new Event('online'));
      vi.advanceTimersByTime(2000);
      window.dispatchEvent(new Event('offline'));
      vi.advanceTimersByTime(3000);

      expect(reconnectAfterNetworkReturns).not.toHaveBeenCalled();
    });
  });
  // Agents starting and stopping turns send these in bursts, and each reload fetches every
  // workspace over IPC.
  it('reloads the workspaces once more for a burst of changes, not once for each', async () => {
    const fetches: Array<(workspaces: Workspace[]) => void> = [];
    const handlers = new Map<string, (workspace?: Workspace) => void>();
    const api = new Proxy(
      {},
      {
        get: (_target, key: string) => {
          if (key === 'getWorkspaces') {
            return () => new Promise<Workspace[]>((resolve) => fetches.push(resolve));
          }
          if (key.startsWith('on')) {
            return (handler: (workspace?: Workspace) => void) => {
              handlers.set(key, handler);
              return () => {};
            };
          }
          return vi.fn().mockResolvedValue(undefined);
        },
      }
    );
    Object.defineProperty(window, 'api', { value: api, configurable: true });
    renderHook(() =>
      useAppLifecycle({
        sidebarElement: null,
        mainElement: null,
        setNewWorkspaceDialogOpen: () => {},
        setFeedbackOpen: () => {},
      })
    );
    // The load as it subscribes.
    await act(async () => {
      fetches.shift()?.([]);
    });
    expect(fetches).toHaveLength(0);

    act(() => {
      for (let i = 0; i < 4; i++) handlers.get('onWorkspacesChanged')?.();
      handlers.get('onWorkspaceCreated')?.(workspace('ws-3', 'idle'));
    });
    expect(fetches).toHaveLength(1);

    await act(async () => {
      fetches.shift()?.([]);
    });
    // One more, started after the burst, so nothing it changed is missed.
    expect(fetches).toHaveLength(1);
    await act(async () => {
      fetches.shift()?.([]);
    });
    expect(fetches).toHaveLength(0);
  });

  describe('a workspace created outside this window', () => {
    const windowId = useWindowStore.getState().windowId;
    const created = (fields: Partial<Workspace> = {}) =>
      ({
        id: 'ws-new',
        projectId: 'p-hidden',
        windowId,
        status: 'active',
        terminals: [],
        ...fields,
      }) as Workspace;
    const updateConfig = vi.fn().mockResolvedValue(undefined);
    const updateProject = vi.fn().mockResolvedValue(undefined);
    const create = async (
      workspace: Workspace,
      origin?: { scheduled?: boolean },
      grouping: 'project' | 'status' = 'project'
    ) => {
      const handlers = new Map<string, (...args: unknown[]) => void>();
      const api = new Proxy(
        {},
        {
          get: (_target, key: string) =>
            key.startsWith('on')
              ? (handler: (...args: unknown[]) => void) => {
                  handlers.set(key, handler);
                  return () => {};
                }
              : key === 'updateConfig'
                ? updateConfig
                : key === 'updateProject'
                  ? updateProject
                  : vi.fn().mockResolvedValue(key === 'getProjects' ? [] : undefined),
        }
      );
      Object.defineProperty(window, 'api', { value: api, configurable: true });
      renderHook(() =>
        useAppLifecycle({
          sidebarElement: null,
          mainElement: null,
          setNewWorkspaceDialogOpen: () => {},
          setFeedbackOpen: () => {},
        })
      );
      // After the loads it starts with, which set what the sidebar hides.
      await act(async () => {});
      useWorkspacesStore.setState({
        hasLoaded: true,
        grouping,
        hideStopped: false,
        hiddenProjectIds: new Set(['p-hidden', 'p-other']),
        workspaces: [created({ id: 'ws-shown', projectId: 'p-shown' })],
      });
      useProjectsStore.setState({
        expandedProjectIds: new Set(),
        projects: [
          { id: 'p-top', order: 0 },
          { id: 'p-hidden', order: 1 },
        ] as Project[],
      });
      updateConfig.mockClear();
      updateProject.mockClear();
      await act(async () => handlers.get('onWorkspaceCreated')?.(workspace, origin));
      return useWorkspacesStore.getState().hiddenProjectIds;
    };

    // As New Workspace does: `komla launch` into a project the sidebar hides would otherwise
    // start a workspace nobody sees.
    it('lists its hidden project again, expanded, at the top', async () => {
      expect(await create(created())).toEqual(new Set(['p-other']));
      expect(useProjectsStore.getState().expandedProjectIds).toEqual(new Set(['p-hidden']));
      expect(updateConfig).toHaveBeenCalledWith({ hiddenProjectIds: ['p-other'] });
      expect(updateProject).toHaveBeenCalledWith('p-hidden', { order: 0 });
    });

    // A group the user already sees stays where they put it.
    it('leaves a project in sight where it is', async () => {
      await create(created({ projectId: 'p-shown' }));
      expect(updateProject).not.toHaveBeenCalled();
    });

    // Its place among projects isn't in sight then, so it stays where the user put it.
    it('leaves the order of projects be in a sidebar grouped by status', async () => {
      expect(await create(created(), undefined, 'status')).toEqual(new Set(['p-other']));
      expect(updateProject).not.toHaveBeenCalled();
    });

    it('leaves the project hidden for a run its schedule started', async () => {
      expect(await create(created(), { scheduled: true })).toEqual(
        new Set(['p-hidden', 'p-other'])
      );
      expect(updateConfig).not.toHaveBeenCalled();
      expect(updateProject).not.toHaveBeenCalled();
    });

    it('leaves the project hidden in a window that does not list the workspace', async () => {
      expect(await create(created({ windowId: 'another-window' }))).toEqual(
        new Set(['p-hidden', 'p-other'])
      );
    });
  });

  describe('an SSH workspace that could not be created', () => {
    const update = (fields: Partial<Workspace>) => {
      const handlers = new Map<string, (workspace: Workspace) => void>();
      const api = new Proxy(
        {},
        {
          get: (_target, key: string) =>
            key.startsWith('on')
              ? (handler: (workspace: Workspace) => void) => {
                  handlers.set(key, handler);
                  return () => {};
                }
              : vi.fn().mockResolvedValue(undefined),
        }
      );
      Object.defineProperty(window, 'api', { value: api, configurable: true });
      useToastStore.setState({ toasts: [] });
      renderHook(() =>
        useAppLifecycle({
          sidebarElement: null,
          mainElement: null,
          setNewWorkspaceDialogOpen: () => {},
          setFeedbackOpen: () => {},
        })
      );
      act(() => {
        handlers.get('onWorkspaceUpdated')?.({
          ...workspace('ws-1', 'idle'),
          backend: { kind: 'ssh', hostId: 'host-1', remoteDirectory: '/srv/ws-1' },
          ...fields,
        } as Workspace);
      });
      return useToastStore.getState().toasts.map((toast) => toast.message);
    };

    it('says so', () => {
      expect(update({ provisionError: 'Branch "fix" already exists on the SSH host.' })).toEqual([
        'Failed to create SSH workspace: Branch "fix" already exists on the SSH host.',
      ]);
    });

    // Both keep their message on the workspace, which every later update of it carries.
    it('says nothing of a workspace missing from its host', () => {
      expect(
        update({
          provisionError: 'This workspace’s files are no longer on its SSH host.',
          provisionErrorReason: 'missing-from-host',
        })
      ).toEqual([]);
    });

    it('says nothing of a workspace whose host is no longer configured', () => {
      expect(
        update({
          provisionError: 'This workspace’s SSH host is no longer configured.',
          provisionErrorReason: 'host-not-configured',
        })
      ).toEqual([]);
    });
  });

  describe("what the window's first screen loaded", () => {
    // The first screen loads them before React subscribes to their changes, so a change main
    // sent in between would be missed without loading them again. Loading as it subscribes, in
    // the same task, misses nothing: the answers and events arrive in later ones.
    it('loads it again as it subscribes to its changes', () => {
      const calls: string[] = [];
      const api = new Proxy(
        {},
        {
          get: (_target, key: string) => {
            if (key === 'getConfig' || key === 'getWorkspaces' || key === 'getProjects') {
              return () => {
                calls.push(key);
                return Promise.resolve(key === 'getConfig' ? {} : []);
              };
            }
            if (key === 'hasProjects') return () => Promise.resolve(true);
            if (
              key === 'onConfigChanged' ||
              key === 'onWorkspacesChanged' ||
              key === 'onProjectsChange'
            ) {
              return () => {
                calls.push(key);
                return () => {};
              };
            }
            if (key.startsWith('on')) return () => () => {};
            return vi.fn().mockResolvedValue(undefined);
          },
        }
      );
      Object.defineProperty(window, 'api', { value: api, configurable: true });
      useConfigStore.setState({ config: {} as never, isLoading: false, hasProjects: true });
      useWorkspacesStore.setState({ hasLoaded: true });
      useProjectsStore.setState({ projects: [], hasLoaded: true });

      renderHook(() =>
        useAppLifecycle({
          sidebarElement: null,
          mainElement: null,
          setNewWorkspaceDialogOpen: () => {},
          setFeedbackOpen: () => {},
        })
      );

      expect(calls).toEqual(
        expect.arrayContaining([
          'onConfigChanged',
          'getConfig',
          'onWorkspacesChanged',
          'getWorkspaces',
          'onProjectsChange',
          'getProjects',
        ])
      );
    });
  });
});
