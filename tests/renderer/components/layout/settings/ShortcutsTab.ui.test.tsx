/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  (globalThis as unknown as { window: Window }).window.api = {
    platform: 'darwin',
  } as unknown as typeof window.api;
});

import { ShortcutsTab } from '../../../../../src/renderer/components/layout/settings/ShortcutsTab';
import { TooltipProvider } from '../../../../../src/renderer/components/ui/tooltip';
import { useShortcutsStore } from '../../../../../src/renderer/stores/shortcuts.store';

const renderTab = () =>
  render(
    <TooltipProvider>
      <ShortcutsTab onDirtyChange={vi.fn()} />
    </TooltipProvider>
  );

describe('ShortcutsTab', () => {
  beforeEach(() => {
    useShortcutsStore.setState({
      config: { shortcuts: { 'pane.splitRight': 'Cmd+\\', 'terminal.new': 'Cmd+T' } },
    });
  });

  it('offers Retry as a keyboard-reachable button when a recorded shortcut conflicts', async () => {
    const user = userEvent.setup();
    renderTab();

    await user.click(screen.getByRole('button', { name: /Change shortcut for Split right/ }));
    fireEvent.keyDown(document, { key: 't', code: 'KeyT', metaKey: true });

    expect(screen.getByText(/Already used by/)).toHaveTextContent('New terminal tab');
    const retry = screen.getByRole('button', { name: 'Retry' });
    retry.focus();
    expect(retry).toHaveFocus();

    // While recording, keys go to the recorder, so the button is for the mouse...
    await user.click(retry);
    expect(screen.queryByText(/Already used by/)).not.toBeInTheDocument();
    expect(screen.getByText('Press keys or double-tap a modifier...')).toBeInTheDocument();
  });

  it('records a new combo straight after a conflict', () => {
    renderTab();

    fireEvent.click(screen.getByRole('button', { name: /Change shortcut for Split right/ }));
    fireEvent.keyDown(document, { key: 't', code: 'KeyT', metaKey: true });
    expect(screen.getByText(/Already used by/)).toBeInTheDocument();

    // ...and the keyboard retries by pressing another combo.
    fireEvent.keyDown(document, { key: 'y', code: 'KeyY', metaKey: true });

    expect(screen.queryByText(/Already used by/)).not.toBeInTheDocument();
  });

  it('clears the search on Escape', async () => {
    const user = userEvent.setup();
    renderTab();

    const search = screen.getByRole('textbox', { name: 'Search shortcuts' });
    await user.type(search, 'split');
    expect(screen.queryByText('New terminal tab')).not.toBeInTheDocument();

    await user.keyboard('{Escape}');

    expect(search).toHaveValue('');
    expect(screen.getByText('New terminal tab')).toBeInTheDocument();
  });

  describe('new workspace dialog shortcuts', () => {
    const updateShortcuts = vi.fn();
    const record = (label: string, keys: Parameters<typeof fireEvent.keyDown>[1]) => {
      fireEvent.click(
        screen.getByRole('button', { name: new RegExp(`Change shortcut for ${label}`) })
      );
      fireEvent.keyDown(document, keys);
    };

    beforeEach(() => {
      updateShortcuts.mockReset();
      useShortcutsStore.setState({
        updateShortcuts,
        config: {
          shortcuts: {
            'workspace.new': 'Cmd+N',
            'terminal.new': 'Cmd+T',
            'newWorkspace.cycleLaunchMode': 'Shift+Tab',
            'newWorkspace.cycleEffort': 'Cmd+E',
            'newWorkspace.effortMenu': '',
          },
        },
      });
    });

    it('lists an unset action, which can take Shift+Tab', () => {
      renderTab();

      record('Open effort menu \\(not set\\)', { key: 'Tab', shiftKey: true });

      // Recorded, though another dialog action has it.
      expect(screen.getByText(/Already used by/)).toHaveTextContent('Next launch mode');
    });

    it('keeps Shift+Tab for focus outside the dialog', () => {
      renderTab();

      record('New terminal tab', { key: 'Tab', shiftKey: true });

      expect(updateShortcuts).not.toHaveBeenCalled();
      expect(screen.getByText('Press keys or double-tap a modifier...')).toBeInTheDocument();
    });

    it('swaps keys with the dialog action that had them', () => {
      renderTab();

      record('Next effort level', { key: 'Tab', shiftKey: true });
      fireEvent.click(screen.getByRole('button', { name: 'Swap' }));

      expect(updateShortcuts).toHaveBeenCalledWith({
        shortcuts: {
          'newWorkspace.cycleEffort': 'Shift+Tab',
          'newWorkspace.cycleLaunchMode': 'Cmd+E',
        },
      });
    });

    it('takes keys from the dialog action that had them, leaving it unset', () => {
      renderTab();

      record('Next effort level', { key: 'Tab', shiftKey: true });
      fireEvent.click(screen.getByRole('button', { name: 'Replace' }));

      expect(updateShortcuts).toHaveBeenCalledWith({
        shortcuts: { 'newWorkspace.cycleEffort': 'Shift+Tab', 'newWorkspace.cycleLaunchMode': '' },
      });
    });

    it('reuses keys from outside the dialog, but never takes New workspace', () => {
      renderTab();

      record('Next effort level', { key: 't', metaKey: true });
      expect(updateShortcuts).toHaveBeenCalledWith({
        shortcuts: { 'newWorkspace.cycleEffort': 'Cmd+T' },
      });

      record('Next effort level', { key: 'n', metaKey: true });
      expect(screen.getByText(/Already used by/)).toHaveTextContent('New workspace');
      expect(screen.queryByRole('button', { name: 'Swap' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Replace' })).not.toBeInTheDocument();
    });

    it('removes a shortcut', () => {
      renderTab();

      fireEvent.click(
        screen.getByRole('button', { name: 'Remove shortcut for Next effort level' })
      );

      expect(updateShortcuts).toHaveBeenCalledWith({
        shortcuts: { 'newWorkspace.cycleEffort': '' },
      });
    });
  });
});
