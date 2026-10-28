/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ActionRunList } from '../../../../src/renderer/components/actions/ActionRunList';
import { getActionMenuGroups } from '../../../../src/renderer/lib/action-menu-order';

import type { Action, AgentPreset } from '../../../../src/shared/types';

const dev: Action = { id: 'dev', title: 'Dev server', type: 'command', content: 'npm run dev' };
const tests: Action = { id: 'tests', title: 'Tests', type: 'command', content: 'npm test' };
const review: Action = {
  id: 'review',
  title: 'Review my changes',
  type: 'prompt',
  content: '# Review\nReview the diff.',
  presetId: 'claude',
};
const presets = [{ id: 'claude', name: 'Claude Code' }] as AgentPreset[];

const handlers = {
  onRun: vi.fn(),
  onNew: vi.fn(),
  onManage: vi.fn(),
};

function renderList(
  actions: Action[] = [dev, tests, review],
  initialActiveId: string | null = 'tests'
) {
  render(
    <ActionRunList
      groups={getActionMenuGroups(actions, null)}
      presets={presets}
      initialActiveId={initialActiveId}
      {...handlers}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  window.api = { copyToClipboard: vi.fn() } as unknown as typeof window.api;
});

describe('ActionRunList', () => {
  it("shows each Action's title, one type at a time, starting on the run button Action's", async () => {
    const user = userEvent.setup();
    renderList();

    expect(screen.getByRole('radio', { name: 'Commands' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Commands' })).toHaveTextContent('Commands2');
    const commands = screen.getByRole('group', { name: 'Terminal Commands' });
    const dev = within(commands).getByRole('option', { name: /Dev server/ });
    expect(dev).not.toHaveTextContent('npm run dev');
    expect(dev).toHaveAttribute('title', 'npm run dev');
    expect(screen.getByRole('option', { name: /Tests/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('option', { name: /Review my changes/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'Prompts' }));

    expect(screen.queryByRole('option', { name: /Dev server/ })).not.toBeInTheDocument();
    const review = screen.getByRole('option', { name: /Review my changes/ });
    expect(review).toHaveTextContent('Claude Code');
    expect(review).not.toHaveTextContent('Review the diff.');
    expect(screen.getByRole('option', { name: /Review my changes/ })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(screen.getByRole('combobox', { name: 'Search quick commands' })).toHaveFocus();
  });

  it('starts on Prompts without a run button Action, and switches with the side arrows', async () => {
    const user = userEvent.setup();
    renderList(undefined, null);

    expect(screen.getByRole('radio', { name: 'Prompts' })).toBeChecked();
    await user.click(screen.getByRole('combobox', { name: 'Search quick commands' }));
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'Commands' })).toBeChecked();
    expect(screen.getByRole('option', { name: /Dev server/ })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    await user.keyboard('{ArrowLeft}{Enter}');
    expect(handlers.onRun).toHaveBeenCalledWith(review);
  });

  it('leaves the side arrows to the search box while it has text', async () => {
    const user = userEvent.setup();
    renderList();

    await user.click(screen.getByRole('combobox', { name: 'Search quick commands' }));
    await user.keyboard('e{ArrowLeft}');

    expect(screen.getByRole('radio', { name: 'Commands' })).toBeChecked();
  });

  it('leaves out the tabs, keeping the group label, when Actions are all one type', () => {
    renderList([dev, tests]);

    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    expect(screen.getByText('Terminal Commands')).toBeInTheDocument();
  });

  it('filters as you type, showing the other type when the shown one has no match', async () => {
    const user = userEvent.setup();
    renderList();

    const search = screen.getByRole('combobox', { name: 'Search quick commands' });
    await user.click(search);
    await user.keyboard('review');

    expect(screen.getByRole('radio', { name: 'Prompts' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Commands' })).toBeDisabled();
    expect(screen.queryByRole('option', { name: /Dev server/ })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Review my changes/ })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    await user.keyboard('{Enter}');
    expect(handlers.onRun).toHaveBeenCalledWith(review);
  });

  it('moves the highlight with the arrow keys, wrapping around', async () => {
    const user = userEvent.setup();
    renderList();

    await user.click(screen.getByRole('combobox', { name: 'Search quick commands' }));
    await user.keyboard('{ArrowDown}{Enter}');

    expect(handlers.onRun).toHaveBeenCalledWith(dev);
  });

  it('leaves Enter and the arrows to an input method while it composes text', () => {
    renderList();

    const search = screen.getByRole('combobox', { name: 'Search quick commands' });
    fireEvent.keyDown(search, { key: 'ArrowDown', isComposing: true });
    fireEvent.keyDown(search, { key: 'Enter', isComposing: true });

    expect(handlers.onRun).not.toHaveBeenCalled();
    expect(screen.getByRole('option', { name: /Tests/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('says when nothing matches and clears the search with Escape', async () => {
    const user = userEvent.setup();
    renderList();

    const search = screen.getByRole('combobox', { name: 'Search quick commands' });
    await user.click(search);
    await user.keyboard('zzz');
    expect(screen.getByText('No quick commands match')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(search).toHaveValue('');
    expect(screen.getByRole('option', { name: /Tests/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('runs an Action on click, but not from its copy button, and leaves editing to Settings', async () => {
    const user = userEvent.setup();
    renderList();

    expect(screen.queryByRole('button', { name: /^(Edit|Delete) / })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Copy Dev server' }));
    expect(window.api.copyToClipboard).toHaveBeenCalledWith('npm run dev');
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
    expect(handlers.onRun).not.toHaveBeenCalled();

    await user.click(screen.getByText('Dev server'));
    expect(handlers.onRun).toHaveBeenCalledWith(dev);
  });

  it('offers New quick command and Manage below the list', async () => {
    const user = userEvent.setup();
    renderList();

    await user.click(screen.getByRole('button', { name: 'New quick command' }));
    await user.click(screen.getByRole('button', { name: 'Manage' }));

    expect(handlers.onNew).toHaveBeenCalled();
    expect(handlers.onManage).toHaveBeenCalled();
  });

  it('takes focus as it opens, so typing searches right away', async () => {
    renderList();
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Search quick commands' })).toHaveFocus()
    );
  });

  it('says when there are no Actions yet', () => {
    renderList([], null);
    expect(screen.getByText('No quick commands yet')).toBeInTheDocument();
  });

  it('leaves out the search box for a single Action and still runs it with Enter', async () => {
    const user = userEvent.setup();
    renderList([dev], 'dev');

    expect(
      screen.queryByRole('combobox', { name: 'Search quick commands' })
    ).not.toBeInTheDocument();
    screen.getByRole('listbox', { name: 'Quick commands' }).focus();
    await user.keyboard('{Enter}');

    expect(handlers.onRun).toHaveBeenCalledWith(dev);
  });
});
