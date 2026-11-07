/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../../src/renderer/components/ui/dropdown-menu', () => ({
  DropdownMenuSub: ({ children }: React.PropsWithChildren) => (
    <div data-testid="branch-sub">{children}</div>
  ),
  DropdownMenuSubTrigger: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DropdownMenuSubContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    disabled,
    onClick,
    title,
    'aria-expanded': ariaExpanded,
  }: React.PropsWithChildren<{
    disabled?: boolean;
    onClick?: (e: React.MouseEvent) => void;
    title?: string;
    'aria-expanded'?: boolean;
  }>) => (
    <button
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      title={title}
      aria-expanded={ariaExpanded}
    >
      {children}
    </button>
  ),
}));

import {
  BranchActionPicker,
  type BranchActionPickerProps,
} from '../../../../src/renderer/components/layout/BranchActionPicker';

function renderPicker(overrides: Partial<BranchActionPickerProps> = {}) {
  const props: BranchActionPickerProps = {
    branches: [
      { name: 'main', isRemoteOnly: false },
      { name: 'develop', isRemoteOnly: false },
      { name: 'feature', isRemoteOnly: false },
      { name: 'old-topic', isRemoteOnly: false },
    ],
    isLoading: false,
    currentBranch: 'feature',
    mainBranch: 'develop',
    defaultBranch: 'main',
    behindTargetBranch: 3,
    remoteExpanded: false,
    onRemoteExpandedChange: vi.fn(),
    onLoadBranches: vi.fn(),
    onFetch: vi.fn(),
    isFetching: false,
    hasOriginRemote: false,
    onSwitch: vi.fn(),
    onMerge: vi.fn(),
    onRebase: vi.fn(),
    onDelete: vi.fn(),
    onCompare: vi.fn(),
    onCreate: vi.fn(),
    isCreating: false,
    isSwitching: false,
    isMerging: false,
    isRebasing: false,
    isDeleting: false,
    ...overrides,
  };
  return render(<BranchActionPicker {...props} />);
}

function branchRow(name: string): HTMLElement {
  const row = screen.getByText(name).closest<HTMLElement>('[data-testid="branch-sub"]');
  if (!row) throw new Error(`row for ${name} not found`);
  return row;
}

describe('BranchActionPicker', () => {
  it('shows the behind count only on the actual target branch', () => {
    renderPicker();

    expect(within(branchRow('develop')).getByText('↓3')).toBeInTheDocument();
    expect(within(branchRow('main')).queryByText('↓3')).toBeNull();
  });

  it('labels the checked-out branch and the target branch explicitly', () => {
    renderPicker();

    expect(within(branchRow('feature')).getByText('checked out')).toBeInTheDocument();
    expect(screen.queryByText(/current/)).toBeNull();
    expect(within(branchRow('develop')).getByText('target')).toBeInTheDocument();
    expect(within(branchRow('main')).queryByText('target')).toBeNull();
  });

  it('does not offer deleting the target branch or the repository default branch', () => {
    renderPicker();

    expect(within(branchRow('develop')).queryByRole('menuitem', { name: /Delete/ })).toBeNull();
    expect(within(branchRow('main')).queryByRole('menuitem', { name: /Delete/ })).toBeNull();
    expect(
      within(branchRow('old-topic')).getByRole('menuitem', { name: /Delete/ })
    ).toBeInTheDocument();
  });
  it('merges and rebases onto the remote ref when the row is a remote branch', () => {
    const onMerge = vi.fn();
    const onRebase = vi.fn();
    renderPicker({
      branches: [
        { name: 'feature', isRemoteOnly: false },
        { name: 'topic', isRemoteOnly: false },
        { name: 'topic', isRemoteOnly: true, remoteRef: 'origin/topic' },
      ],
      hasOriginRemote: true,
      remoteExpanded: true,
      onMerge,
      onRebase,
    });

    const [remoteRow, localRow] = screen
      .getAllByTestId('branch-sub')
      .filter((row) => row.textContent?.startsWith('topic'));
    fireEvent.click(within(remoteRow).getByRole('menuitem', { name: /Merge/ }));
    fireEvent.click(within(remoteRow).getByRole('menuitem', { name: /Rebase/ }));
    fireEvent.click(within(localRow).getByRole('menuitem', { name: /Merge/ }));

    expect(onMerge.mock.calls).toEqual([['origin/topic'], ['topic']]);
    expect(onRebase).toHaveBeenCalledWith('origin/topic');
  });

  it('lists the same branch on two remotes without a key collision', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderPicker({
      branches: [
        { name: 'feature', isRemoteOnly: false },
        { name: 'topic', isRemoteOnly: true, remoteRef: 'origin/topic' },
        { name: 'topic', isRemoteOnly: true, remoteRef: 'upstream/topic' },
      ],
      hasOriginRemote: true,
      remoteExpanded: true,
    });

    const keyWarnings = consoleError.mock.calls.filter((args) =>
      args.some((arg) => String(arg).includes('same key'))
    );
    consoleError.mockRestore();
    expect(keyWarnings).toEqual([]);
  });
  it('lets the keyboard reach the Remote toggle and Fetch, as menu items', () => {
    const onRemoteExpandedChange = vi.fn();
    const onFetch = vi.fn().mockResolvedValue(undefined);
    renderPicker({ hasOriginRemote: true, onRemoteExpandedChange, onFetch });

    fireEvent.click(screen.getByRole('menuitem', { name: /Remote \(0\)/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Fetch/ }));

    expect(onRemoteExpandedChange).toHaveBeenCalledWith(true);
    expect(onFetch).toHaveBeenCalledOnce();
  });

  it('shows remote branches matching the filter while the Remote section is collapsed', () => {
    renderPicker({
      branches: [
        { name: 'feature', isRemoteOnly: false },
        { name: 'topic', isRemoteOnly: true, remoteRef: 'origin/topic' },
        { name: 'other', isRemoteOnly: true, remoteRef: 'origin/other' },
      ],
      hasOriginRemote: true,
      remoteExpanded: false,
    });
    expect(screen.queryByText('topic')).toBeNull();

    fireEvent.change(screen.getByPlaceholderText('Filter or create branch...'), {
      target: { value: 'top' },
    });

    expect(screen.getByText('topic')).toBeInTheDocument();
    expect(screen.queryByText('other')).toBeNull();
    // Collapsing does nothing while a filter shows the matches, so it waits for the filter.
    expect(screen.getByRole('menuitem', { name: /Remote \(1\)/ })).toBeDisabled();
  });
});
