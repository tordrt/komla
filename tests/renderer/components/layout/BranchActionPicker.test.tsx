/**
 * @vitest-environment jsdom
 */
import { render, screen, within } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../../src/renderer/components/ui/dropdown-menu', () => ({
  DropdownMenuSub: ({ children }: React.PropsWithChildren) => (
    <div data-testid="branch-sub">{children}</div>
  ),
  DropdownMenuSubTrigger: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DropdownMenuSubContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DropdownMenuItem: ({ children }: React.PropsWithChildren) => (
    <button role="menuitem">{children}</button>
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
});
