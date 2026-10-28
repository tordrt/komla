/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SettingsHistoryCard } from '../../../../../src/renderer/components/layout/settings/SettingsHistoryCard';
import { useToastStore } from '../../../../../src/renderer/stores/toast.store';

import type { SettingsHistoryEntry } from '../../../../../src/shared/types/settings-history';

const entry = (overrides: Partial<SettingsHistoryEntry> = {}): SettingsHistoryEntry => ({
  id: 'change-1',
  file: 'theme.json',
  at: Date.now() - 5 * 60_000,
  changedKeys: ['palette', 'colors.accent'],
  laterChanges: 0,
  ...overrides,
});

describe('SettingsHistoryCard', () => {
  let historyListener: (() => void) | null;
  const api = {
    listSettingsHistory: vi.fn(),
    revertSettingsChange: vi.fn(),
    onSettingsHistoryChange: vi.fn((listener: () => void) => {
      historyListener = listener;
      return () => {
        historyListener = null;
      };
    }),
  };

  beforeEach(() => {
    historyListener = null;
    vi.clearAllMocks();
    useToastStore.setState({ toasts: [] });
    Object.assign(window as any, { api });
  });

  it('lists recorded changes by setting and says when there are none', async () => {
    api.listSettingsHistory.mockResolvedValue([]);
    render(<SettingsHistoryCard />);
    expect(await screen.findByText('No changes yet.')).toBeInTheDocument();

    api.listSettingsHistory.mockResolvedValue([
      entry(),
      entry({ id: 'items', file: 'status-items.json', changedKeys: [] }),
    ]);
    historyListener?.();

    expect(await screen.findByText('Appearance')).toBeInTheDocument();
    expect(screen.getByText('palette, colors.accent')).toBeInTheDocument();
    expect(screen.getAllByText('5m ago')).toHaveLength(2);
    // Changes Komla can't name by setting, as to a file that isn't JSON, name the file.
    expect(screen.getByText('Changed status-items.json')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Revert/ })).toHaveLength(2);
  });

  it('reverts a change and offers to undo the revert', async () => {
    api.listSettingsHistory.mockResolvedValue([entry({ laterChanges: 2 })]);
    api.revertSettingsChange.mockResolvedValue(entry({ id: 'revert-1', revertOf: 'change-1' }));
    render(<SettingsHistoryCard />);

    const button = await screen.findByRole('button', { name: /Revert Appearance change/ });
    expect(button).toHaveAttribute('title', 'Also undoes 2 later changes to Appearance');
    fireEvent.click(button);

    await waitFor(() => expect(api.revertSettingsChange).toHaveBeenCalledWith('change-1'));
    await waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1));
    const [toast] = useToastStore.getState().toasts;
    expect(toast.message).toBe('Reverted the Appearance change.');
    toast.action?.onClick();
    expect(api.revertSettingsChange).toHaveBeenLastCalledWith('revert-1');
  });

  it('shows why a revert failed', async () => {
    api.listSettingsHistory.mockResolvedValue([entry()]);
    api.revertSettingsChange.mockRejectedValue(new Error('disk full'));
    render(<SettingsHistoryCard />);

    fireEvent.click(await screen.findByRole('button', { name: /Revert Appearance change/ }));

    await waitFor(() =>
      expect(useToastStore.getState().toasts).toEqual([
        expect.objectContaining({ type: 'error', message: expect.stringContaining('disk full') }),
      ])
    );
  });

  it('shows the latest changes until asked for all of them', async () => {
    api.listSettingsHistory.mockResolvedValue(
      Array.from({ length: 8 }, (_, index) => entry({ id: `change-${index}` }))
    );
    render(<SettingsHistoryCard />);

    expect(await screen.findAllByRole('button', { name: /^Revert/ })).toHaveLength(6);
    fireEvent.click(screen.getByRole('button', { name: 'Show all 8 changes' }));
    expect(screen.getAllByRole('button', { name: /^Revert/ })).toHaveLength(8);
  });
});
