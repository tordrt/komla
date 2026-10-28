/**
 * @vitest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Badge, badgeVariants } from '../../../../src/renderer/components/ui/badge';
import { Callout } from '../../../../src/renderer/components/ui/callout';
import { EmptyState } from '../../../../src/renderer/components/ui/empty-state';
import { compactShortcut, ShortcutHint } from '../../../../src/renderer/components/ui/kbd';
import { Spinner } from '../../../../src/renderer/components/ui/spinner';

vi.mock('../../../../src/renderer/stores/shortcuts.store', () => ({
  useShortcutsStore: () => ({
    getDisplayShortcut: (action: string) =>
      ({ 'workspace.new': 'Ctrl+N', 'commandCenter.open': 'Ctrl+Shift+P' })[action] ?? '',
    getDisplayKeys: (action: string) =>
      action === 'commandCenter.open' ? { keys: ['Ctrl', 'Shift', 'P'], separator: '+' } : null,
  }),
}));

describe('Badge', () => {
  it('uses the status token for its tone', () => {
    render(<Badge tone="success">Done</Badge>);

    const badge = screen.getByText('Done');
    expect(badge.className).toContain('bg-success/15');
    expect(badge.className).toContain('text-success');
  });

  it('lets a caller override classes', () => {
    expect(badgeVariants({ tone: 'error', variant: 'solid' })).toContain('text-error-foreground');
    render(
      <Badge tone="warning" className="text-ui">
        Wait
      </Badge>
    );
    expect(screen.getByText('Wait').className).toContain('text-ui');
    expect(screen.getByText('Wait').className).not.toContain('text-2xs');
  });
});

describe('ShortcutHint', () => {
  it('renders the configured shortcut as a key chip', () => {
    render(<ShortcutHint action="workspace.new" />);

    const chip = screen.getByText('Ctrl+N');
    expect(chip.tagName).toBe('KBD');
  });

  it('can show Shift as its symbol', () => {
    render(<ShortcutHint action="commandCenter.open" compact />);

    expect(screen.getByText('Ctrl⇧P').tagName).toBe('KBD');
  });

  it('renders nothing for an action without a shortcut', () => {
    const { container } = render(<ShortcutHint action="unbound.action" />);

    expect(container.innerHTML).toBe('');
  });
});

describe('compactShortcut', () => {
  it.each([
    [['Ctrl', 'Shift', 'P'], '+', 'Ctrl⇧P'],
    [['Shift', 'F5'], '+', '⇧F5'],
    [['Ctrl', 'Alt', 'Shift', 'N'], '+', 'Ctrl+Alt⇧N'],
    [['Ctrl', 'N'], '+', 'Ctrl+N'],
    [['⇧', '⌘', 'P'], '', '⇧⌘P'],
    [['Shift', 'Shift'], ' ', 'Shift Shift'],
  ] as const)('shows %j joined by "%s" as %s', (keys, separator, compact) => {
    expect(compactShortcut({ keys: [...keys], separator })).toBe(compact);
  });
});

describe('Spinner', () => {
  it('is hidden from assistive tech unless labelled', () => {
    const { container, rerender } = render(<Spinner />);
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');

    rerender(<Spinner label="Loading changes" />);
    expect(screen.getByRole('status', { name: 'Loading changes' })).toBeTruthy();
  });

  it('forwards its ref to the svg', () => {
    const ref = React.createRef<SVGSVGElement>();
    render(<Spinner ref={ref} />);

    expect(ref.current?.tagName.toLowerCase()).toBe('svg');
  });
});

describe('Callout', () => {
  it('shows a title, body and tone icon', () => {
    const { container } = render(
      <Callout tone="warning" title="Uncommitted changes">
        Commit or stash them first.
      </Callout>
    );

    expect(screen.getByText('Uncommitted changes')).toBeTruthy();
    expect(screen.getByText('Commit or stash them first.')).toBeTruthy();
    expect(container.querySelector('svg')).toBeTruthy();
  });

  it('shows an action at the end', () => {
    render(
      <Callout tone="warning" action={<button type="button">Sync</button>}>
        Behind remote
      </Callout>
    );

    expect(screen.getByRole('button', { name: 'Sync' })).toBeTruthy();
  });

  it('can drop the icon', () => {
    const { container } = render(<Callout icon={false}>Plain note</Callout>);

    expect(container.querySelector('svg')).toBeNull();
  });
});

describe('EmptyState', () => {
  it('renders the title, description and action', () => {
    render(
      <EmptyState
        title="No workspaces"
        description="Create one to get started"
        action={<button type="button">New Workspace</button>}
      />
    );

    expect(screen.getByText('No workspaces')).toBeTruthy();
    expect(screen.getByText('Create one to get started')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New Workspace' })).toBeTruthy();
  });
});
