/**
 * @vitest-environment jsdom
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The shortcut formatter reads the platform when its module loads.
vi.hoisted(() => {
  (window as unknown as { api: { platform: string } }).api = { platform: 'darwin' };
});

import { ShortcutsDialog } from '../../../../src/renderer/components/layout/ShortcutsDialog';
import { useShortcutsStore } from '../../../../src/renderer/stores/shortcuts.store';

function setShortcuts(shortcuts: Record<string, string>) {
  useShortcutsStore.setState({ config: { shortcuts } });
}

describe('ShortcutsDialog', () => {
  beforeEach(() => {
    setShortcuts({ 'pane.splitRight': 'Cmd+D', 'pane.splitDown': 'Cmd+Shift+D' });
  });

  it('formats the fixed New window shortcut with the shared formatter', () => {
    render(<ShortcutsDialog open onOpenChange={vi.fn()} />);

    const row = screen.getByText('New window').parentElement!;
    expect(row).toHaveTextContent('⇧⌘N');
  });

  it('shows the space key as its own keycap', () => {
    setShortcuts({ 'terminal.search': 'Cmd+ ' });
    render(<ShortcutsDialog open onOpenChange={vi.fn()} />);

    const row = screen.getByText('Find in terminal').parentElement!;
    const caps = within(row)
      .getAllByText(/./, { selector: 'kbd' })
      .map((cap) => cap.textContent);
    expect(caps).toEqual(['⌘', 'Space']);
  });

  it('leaves out groups with no bound shortcuts', async () => {
    render(<ShortcutsDialog open onOpenChange={vi.fn()} />);

    await userEvent.type(screen.getByLabelText('Search keyboard shortcuts'), 'voice');

    expect(screen.queryByRole('heading', { name: 'Voice' })).not.toBeInTheDocument();
    expect(screen.getByText('No shortcuts match “voice”')).toBeInTheDocument();
  });

  it('clears the search on the first Escape and closes on the next', async () => {
    const onOpenChange = vi.fn();
    render(<ShortcutsDialog open onOpenChange={onOpenChange} />);
    const search = screen.getByLabelText('Search keyboard shortcuts');

    await userEvent.type(search, 'split');
    await userEvent.keyboard('{Escape}');

    expect(search).toHaveValue('');
    expect(onOpenChange).not.toHaveBeenCalled();

    await userEvent.keyboard('{Escape}');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('opens with an empty search', async () => {
    const { rerender } = render(<ShortcutsDialog open onOpenChange={vi.fn()} />);
    await userEvent.type(screen.getByLabelText('Search keyboard shortcuts'), 'split');

    rerender(<ShortcutsDialog open={false} onOpenChange={vi.fn()} />);
    rerender(<ShortcutsDialog open onOpenChange={vi.fn()} />);

    expect(screen.getByLabelText('Search keyboard shortcuts')).toHaveValue('');
  });
});
