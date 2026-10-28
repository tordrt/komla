import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

type MockButtonProps = {
  children: React.ReactNode;
  onClick?: () => void;
};

const mockStore = vi.hoisted(() => ({
  state: {
    conflict: null as {
      message: string;
      options: { allowRebase?: boolean };
      settle: ReturnType<typeof vi.fn>;
    } | null,
    resolve: vi.fn(),
  },
}));

const renderedButtons: MockButtonProps[] = [];

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick }: MockButtonProps) => {
    renderedButtons.push({ children, onClick });
    return React.createElement('button', { onClick }, children);
  },
}));

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => React.createElement('div', {}, children),
  DialogContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', {}, children),
  DialogDescription: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', {}, children),
  DialogFooter: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', {}, children),
  DialogHeader: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', {}, children),
  DialogTitle: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', {}, children),
}));

vi.mock('@/stores/push-conflict.store', () => ({
  usePushConflictStore: (selector: (state: typeof mockStore.state) => unknown) =>
    selector(mockStore.state),
}));

import { PushConflictDialog } from '@/components/layout/PushConflictDialog';

describe('PushConflictDialog', () => {
  afterEach(() => {
    mockStore.state.conflict = null;
    mockStore.state.resolve.mockReset();
    renderedButtons.length = 0;
  });

  it('shows the rebase action when allowRebase is true', () => {
    mockStore.state.conflict = {
      message: 'Remote has new commits',
      options: { allowRebase: true },
      settle: vi.fn(),
    };

    const markup = renderToStaticMarkup(React.createElement(PushConflictDialog));

    expect(markup).toContain('Pull (Rebase) &amp; Push');
    expect(markup).toContain('Pull (Merge) &amp; Push');
  });

  it('hides the rebase action when allowRebase is false', () => {
    mockStore.state.conflict = {
      message: 'Remote has new commits',
      options: {},
      settle: vi.fn(),
    };

    const markup = renderToStaticMarkup(React.createElement(PushConflictDialog));

    expect(markup).not.toContain('Pull (Rebase) &amp; Push');
    expect(markup).toContain('Pull (Merge) &amp; Push');
  });

  it('wires the rebase action to resolve with rebase-and-push', () => {
    mockStore.state.conflict = {
      message: 'Remote has new commits',
      options: { allowRebase: true },
      settle: vi.fn(),
    };

    renderToStaticMarkup(React.createElement(PushConflictDialog));

    const rebaseButton = renderedButtons.find(
      (button) => button.children === 'Pull (Rebase) & Push'
    );
    expect(rebaseButton).toBeDefined();

    rebaseButton?.onClick?.();

    expect(mockStore.state.resolve).toHaveBeenCalledWith('rebase-and-push');
  });

  it('wires the merge action to resolve with pull-and-push', () => {
    mockStore.state.conflict = {
      message: 'Remote has new commits',
      options: { allowRebase: true },
      settle: vi.fn(),
    };

    renderToStaticMarkup(React.createElement(PushConflictDialog));

    const mergeButton = renderedButtons.find((button) => button.children === 'Pull (Merge) & Push');
    expect(mergeButton).toBeDefined();

    mergeButton?.onClick?.();

    expect(mockStore.state.resolve).toHaveBeenCalledWith('pull-and-push');
  });
});
