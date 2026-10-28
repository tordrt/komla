// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/renderer/lib/terminal-renderer-runtime', () => ({
  disposeTerminalRenderers: vi.fn(),
  getTerminalRendererDimensions: vi.fn(() => undefined),
}));

vi.mock('../../../src/renderer/stores/window.store', () => ({
  useWindowStore: {
    getState: () => ({ windowId: 'window-1' }),
  },
}));

import { useWorkspaceLayoutPersistence } from '../../../src/renderer/hooks/useWorkspaceLayoutPersistence';
import { useLayoutStore } from '../../../src/renderer/stores/layout.store';
import {
  setTerminalClosing,
  useTerminalCloseStore,
} from '../../../src/renderer/stores/terminal-close.store';
import { useWorkspacesStore } from '../../../src/renderer/stores/workspaces.store';
import { createWorkspace } from '../../factories';

describe('useWorkspaceLayoutPersistence', () => {
  const saveWorkspaceLayouts = vi.fn();
  const saveWorkspaceLayoutsSync = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { saveWorkspaceLayouts, saveWorkspaceLayoutsSync },
    });
    useLayoutStore.setState(useLayoutStore.getInitialState(), true);
    useTerminalCloseStore.setState(useTerminalCloseStore.getInitialState(), true);
    useWorkspacesStore.setState({
      workspaces: [createWorkspace({ id: 'ssh-ws', windowId: 'window-1' })],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('saves structural changes after a debounce without waiting for window close', () => {
    renderHook(() => useWorkspaceLayoutPersistence());

    act(() => {
      useLayoutStore.getState().initializeWorkspaceLayout('ssh-ws', 'terminal-1');
      vi.advanceTimersByTime(499);
    });
    expect(saveWorkspaceLayouts).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1));

    expect(saveWorkspaceLayoutsSync).not.toHaveBeenCalled();
    expect(saveWorkspaceLayouts).toHaveBeenCalledWith('window-1', {
      'ssh-ws': expect.objectContaining({
        tabs: ['terminal-1'],
        layouts: {
          'terminal-1': expect.objectContaining({ terminalId: 'terminal-1' }),
        },
      }),
    });
  });

  it('saves active-tab changes but not focused-pane-only changes', () => {
    renderHook(() => useWorkspaceLayoutPersistence());
    act(() => {
      useLayoutStore.getState().initializeWorkspaceLayout('ssh-ws', 'terminal-1');
      useLayoutStore.getState().setCurrentWorkspace('ssh-ws');
      useLayoutStore.getState().addTab('ssh-ws', 'terminal-2');
      vi.advanceTimersByTime(500);
    });
    saveWorkspaceLayouts.mockClear();

    act(() => {
      useLayoutStore.getState().setActiveTab('terminal-1');
      vi.advanceTimersByTime(500);
    });
    expect(saveWorkspaceLayouts).toHaveBeenCalledWith('window-1', {
      'ssh-ws': expect.objectContaining({ activeTab: 'terminal-1' }),
    });
    saveWorkspaceLayouts.mockClear();

    act(() => {
      const paneId = useLayoutStore.getState().focusedPaneByTab['ssh-ws']?.['terminal-2'];
      if (paneId) useLayoutStore.getState().setFocusedPane(paneId);
      vi.advanceTimersByTime(1000);
    });

    expect(saveWorkspaceLayouts).not.toHaveBeenCalled();
  });

  it('flushes a pending structural change synchronously when the window closes', () => {
    renderHook(() => useWorkspaceLayoutPersistence());
    act(() => {
      useLayoutStore.getState().initializeWorkspaceLayout('ssh-ws', 'terminal-1');
      window.dispatchEvent(new Event('beforeunload'));
    });

    expect(saveWorkspaceLayoutsSync).toHaveBeenCalledTimes(1);
    expect(saveWorkspaceLayouts).not.toHaveBeenCalled();
  });

  it('does not persist an optimistic terminal close until the close settles', () => {
    renderHook(() => useWorkspaceLayoutPersistence());
    act(() => {
      useLayoutStore.getState().initializeWorkspaceLayout('ssh-ws', 'terminal-1');
      vi.advanceTimersByTime(500);
    });
    saveWorkspaceLayouts.mockClear();

    act(() => {
      setTerminalClosing('terminal-1', true);
      useLayoutStore.getState().removeTerminalPane('ssh-ws', 'terminal-1');
      vi.advanceTimersByTime(500);
      window.dispatchEvent(new Event('beforeunload'));
    });

    expect(saveWorkspaceLayouts).not.toHaveBeenCalled();
    expect(saveWorkspaceLayoutsSync).not.toHaveBeenCalled();

    act(() => {
      setTerminalClosing('terminal-1', false);
      vi.advanceTimersByTime(500);
    });

    expect(saveWorkspaceLayouts).toHaveBeenCalledWith('window-1', {
      'ssh-ws': expect.objectContaining({ tabs: [] }),
    });
  });
});
