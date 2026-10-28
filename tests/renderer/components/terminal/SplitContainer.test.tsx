/**
 * @vitest-environment jsdom
 */
import { act, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SplitContainer } from '../../../../src/renderer/components/terminal/SplitContainer';
import { useCustomizationStore } from '../../../../src/renderer/stores/customization.store';
import { useTerminalCloseStore } from '../../../../src/renderer/stores/terminal-close.store';
import { useToastStore } from '../../../../src/renderer/stores/toast.store';

const LEAF = { id: 'pane-1', type: 'leaf', terminalId: 'terminal-1' };
const SPLIT = {
  id: 'split-1',
  type: 'split',
  direction: 'horizontal',
  sizes: [50, 50],
  children: [LEAF, { id: 'pane-2', type: 'leaf', terminalId: 'terminal-2' }],
};

const mocks = vi.hoisted(() => ({
  addTerminal: vi.fn(),
  closeTerminalPane: vi.fn(),
  closingPanesStopsWorkspace: vi.fn(),
  confirmStoppingWorkspace: vi.fn(),
  focusTerminalRenderer: vi.fn(),
  shortcutHandlers: {} as Record<string, () => void>,
  root: null as unknown,
}));

vi.mock('../../../../src/renderer/components/terminal/PaneRenderer', () => ({
  PaneRenderer: ({ isLayoutLocked }: { isLayoutLocked: boolean }) => (
    <div data-testid="pane-renderer" data-layout-locked={isLayoutLocked} />
  ),
}));

vi.mock('../../../../src/renderer/hooks/useShortcuts', () => ({
  useShortcuts: (handlers: Record<string, () => void>) => {
    mocks.shortcutHandlers = handlers;
  },
}));

vi.mock('../../../../src/renderer/lib/shortcut-actions', () => ({
  registerShortcutAction: vi.fn(() => vi.fn()),
}));

vi.mock('../../../../src/renderer/lib/close-terminal-pane', () => ({
  closeTerminalPane: mocks.closeTerminalPane,
}));

vi.mock('../../../../src/renderer/lib/pane-surfaces', () => ({
  closingPanesStopsWorkspace: mocks.closingPanesStopsWorkspace,
  confirmStoppingWorkspace: mocks.confirmStoppingWorkspace,
  requestClosePaneSurface: vi.fn(),
}));

vi.mock('../../../../src/renderer/lib/terminal-renderer-runtime', () => ({
  focusTerminalRenderer: mocks.focusTerminalRenderer,
}));

vi.mock('../../../../src/renderer/stores/layout.store', () => {
  const state = () => ({
    currentWorkspaceId: 'workspace-1',
    layoutsByTab: { 'workspace-1': { 'terminal-1': mocks.root } },
    activeTabByWorkspace: { 'workspace-1': 'terminal-1' },
    focusedPaneByTab: { 'workspace-1': { 'terminal-1': 'pane-1' } },
    splitPane: vi.fn(),
    setFocusedPane: vi.fn(),
  });
  return {
    useLayoutStore: Object.assign(
      (selector: (current: ReturnType<typeof state>) => unknown) => selector(state()),
      { getState: state }
    ),
  };
});

vi.mock('../../../../src/renderer/stores/workspaces.store', () => {
  const state = () => ({
    selectedWorkspaceId: 'workspace-1',
    workspaces: [
      {
        id: 'workspace-1',
        terminals: [{ id: 'terminal-1', executionLocation: 'local-mirror' as const }],
      },
    ],
    addTerminal: mocks.addTerminal,
  });
  return {
    useWorkspacesStore: Object.assign(
      (selector: (current: ReturnType<typeof state>) => unknown) => selector(state()),
      { getState: state }
    ),
  };
});

describe('SplitContainer', () => {
  beforeEach(() => {
    mocks.addTerminal.mockReset();
    mocks.closeTerminalPane.mockReset().mockResolvedValue(undefined);
    mocks.closingPanesStopsWorkspace.mockReset().mockReturnValue(false);
    mocks.confirmStoppingWorkspace.mockReset();
    mocks.focusTerminalRenderer.mockReset();
    mocks.shortcutHandlers = {};
    mocks.root = LEAF;
    useTerminalCloseStore.setState({ closingTerminalIds: new Set(['terminal-1']) });
  });

  it('locks the layout and ignores split shortcuts while a terminal close is pending', async () => {
    render(<SplitContainer tabId="terminal-1" isActive workspaceId="workspace-1" />);

    expect(screen.getByTestId('pane-renderer')).toHaveAttribute('data-layout-locked', 'true');

    await act(async () => {
      mocks.shortcutHandlers['pane.splitRight']();
      mocks.shortcutHandlers['pane.splitDown']();
    });

    expect(mocks.addTerminal).not.toHaveBeenCalled();
  });

  it('inherits the focused local-copy terminal location for split shortcuts', async () => {
    useTerminalCloseStore.setState({ closingTerminalIds: new Set() });
    mocks.addTerminal.mockResolvedValue({ id: 'terminal-2' });

    render(<SplitContainer tabId="terminal-1" isActive workspaceId="workspace-1" />);

    await act(async () => {
      await mocks.shortcutHandlers['pane.splitRight']();
    });

    expect(mocks.addTerminal).toHaveBeenCalledWith(
      'workspace-1',
      'Local terminal',
      null,
      undefined,
      'host-shell',
      'local-mirror'
    );
  });
  describe('closing the focused pane', () => {
    beforeEach(() => {
      useTerminalCloseStore.setState({ closingTerminalIds: new Set() });
    });

    async function closePane(): Promise<void> {
      render(<SplitContainer tabId="terminal-1" isActive workspaceId="workspace-1" />);
      await act(async () => {
        await mocks.shortcutHandlers['pane.close']();
      });
    }

    it('closes a pane that leaves the workspace running without asking', async () => {
      await closePane();

      expect(mocks.confirmStoppingWorkspace).not.toHaveBeenCalled();
      expect(mocks.closeTerminalPane).toHaveBeenCalledWith('terminal-1');
    });

    it('asks before closing the last pane stops the workspace', async () => {
      mocks.closingPanesStopsWorkspace.mockReturnValue(true);
      mocks.confirmStoppingWorkspace.mockResolvedValue(true);

      await closePane();

      expect(mocks.closingPanesStopsWorkspace).toHaveBeenCalledWith('workspace-1', ['terminal-1']);
      expect(mocks.confirmStoppingWorkspace).toHaveBeenCalledWith('workspace-1');
      expect(mocks.closeTerminalPane).toHaveBeenCalledWith('terminal-1');
    });

    it('keeps the last pane open and focused when the stop is cancelled', async () => {
      mocks.closingPanesStopsWorkspace.mockReturnValue(true);
      mocks.confirmStoppingWorkspace.mockResolvedValue(false);

      await closePane();

      expect(mocks.closeTerminalPane).not.toHaveBeenCalled();
      expect(mocks.focusTerminalRenderer).toHaveBeenCalledWith('terminal-1');
    });
  });

  describe('the pane menu hint', () => {
    const updateTerminalConfig = vi.fn();
    const hint = 'Right-click a pane to split or close it, or drag the grip at its top to move it.';
    const toastMessages = () => useToastStore.getState().toasts.map((toast) => toast.message);

    beforeEach(() => {
      window.localStorage.clear();
      updateTerminalConfig.mockReset();
      useToastStore.setState(useToastStore.getInitialState(), true);
      useTerminalCloseStore.setState({ closingTerminalIds: new Set() });
      useCustomizationStore.setState({
        terminalConfig: { showPaneHeaders: false } as never,
        updateTerminalConfig,
      });
      mocks.root = SPLIT;
    });

    afterEach(() => {
      useCustomizationStore.setState(useCustomizationStore.getInitialState(), true);
    });

    it('says once that panes split and close from the right-click menu', () => {
      const { unmount } = render(
        <SplitContainer tabId="terminal-1" isActive workspaceId="workspace-1" />
      );
      expect(toastMessages()).toEqual([hint]);
      // It stays until closed, so a hint shown in a background window isn't lost.
      expect(useToastStore.getState().toasts[0].dismissOnTimeout).toBe(false);

      unmount();
      render(<SplitContainer tabId="terminal-1" isActive workspaceId="workspace-1" />);
      expect(toastMessages()).toEqual([hint]);
    });

    it('offers no button to turn pane headers back on, which people would press out of curiosity', () => {
      render(<SplitContainer tabId="terminal-1" isActive workspaceId="workspace-1" />);

      expect(useToastStore.getState().toasts[0].action).toBeUndefined();
    });

    it('stays quiet for a single pane, a hidden tab, or with pane headers on', () => {
      mocks.root = LEAF;
      const { unmount } = render(
        <SplitContainer tabId="terminal-1" isActive workspaceId="workspace-1" />
      );
      unmount();

      mocks.root = SPLIT;
      const hidden = render(
        <SplitContainer tabId="terminal-1" isActive={false} workspaceId="workspace-1" />
      );
      hidden.unmount();

      useCustomizationStore.setState({ terminalConfig: { showPaneHeaders: true } as never });
      render(<SplitContainer tabId="terminal-1" isActive workspaceId="workspace-1" />);

      expect(toastMessages()).toEqual([]);
    });
  });
});
