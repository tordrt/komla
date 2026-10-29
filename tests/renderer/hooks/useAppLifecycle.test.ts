// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAppLifecycle } from '../../../src/renderer/hooks/useAppLifecycle';
import { useConfigStore } from '../../../src/renderer/stores/config.store';
import { useWorkspacesStore } from '../../../src/renderer/stores/workspaces.store';

import type { Workspace } from '../../../src/renderer/types';

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
});
