/**
 * @vitest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { BranchCompareSelect } from '../../../../../src/renderer/components/workspaces/file-viewer/BranchCompareSelect';
import { FileViewerToolbar } from '../../../../../src/renderer/components/workspaces/file-viewer/FileViewerToolbar';
import { TooltipProvider } from '../../../../../src/renderer/components/ui/tooltip';

function renderWithTooltips(ui: ReactNode) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

const branches = [
  { name: 'main', isRemoteOnly: false },
  { name: 'develop', isRemoteOnly: false },
];

describe('BranchCompareSelect', () => {
  it('disables branch comparison controls while a comparison is loading', () => {
    renderWithTooltips(
      <BranchCompareSelect
        value="develop"
        branches={[]}
        loading={false}
        disabled
        onBranchChange={vi.fn()}
        onLoadBranches={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: /develop/i })).toBeDisabled();
  });

  it.each([
    { value: null, useMergeBase: false, label: 'Compare: Uncommitted' },
    { value: 'main', useMergeBase: true, label: 'Compare: Since main' },
    { value: 'develop', useMergeBase: false, label: 'Compare: develop' },
  ])('names the current comparison ($label)', ({ value, useMergeBase, label }) => {
    renderWithTooltips(
      <BranchCompareSelect
        value={value}
        useMergeBase={useMergeBase}
        targetBranch="main"
        branches={[]}
        loading={false}
        onBranchChange={vi.fn()}
        onCompareSinceTarget={vi.fn()}
        onLoadBranches={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
  });

  it('offers uncommitted, since-target and branch comparisons in one menu', async () => {
    const user = userEvent.setup();
    const onBranchChange = vi.fn();
    const onCompareSinceTarget = vi.fn();
    const onLoadBranches = vi.fn().mockResolvedValue(undefined);
    renderWithTooltips(
      <BranchCompareSelect
        value={null}
        targetBranch="main"
        branches={branches}
        loading={false}
        onBranchChange={onBranchChange}
        onCompareSinceTarget={onCompareSinceTarget}
        onLoadBranches={onLoadBranches}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Compare: Uncommitted' }));
    expect(onLoadBranches).toHaveBeenCalled();
    expect(screen.getByRole('menuitemradio', { name: /Uncommitted changes/ })).toBeChecked();
    await user.click(screen.getByRole('menuitemradio', { name: /All changes since main/ }));
    expect(onCompareSinceTarget).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Compare: Uncommitted' }));
    await user.click(screen.getByRole('menuitemradio', { name: 'develop' }));
    expect(onBranchChange).toHaveBeenCalledWith('develop');
  });

  it('goes back to uncommitted changes from a merge-base comparison', async () => {
    const user = userEvent.setup();
    const onBranchChange = vi.fn();
    renderWithTooltips(
      <BranchCompareSelect
        value="main"
        useMergeBase
        targetBranch="main"
        branches={branches}
        loading={false}
        onBranchChange={onBranchChange}
        onCompareSinceTarget={vi.fn()}
        onLoadBranches={vi.fn().mockResolvedValue(undefined)}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Compare: Since main' }));
    expect(screen.getByRole('menuitemradio', { name: /All changes since main/ })).toBeChecked();
    expect(screen.getByRole('menuitemradio', { name: 'main' })).not.toBeChecked();
    await user.click(screen.getByRole('menuitemradio', { name: /Uncommitted changes/ }));

    expect(onBranchChange).toHaveBeenCalledWith(null);
  });

  it('disables the compare control in the toolbar while a comparison is loading', () => {
    window.api = { ...window.api, platform: 'linux' } as typeof window.api;
    renderWithTooltips(
      <FileViewerToolbar
        mode="diff"
        isGitWorkspace
        diffSubMode="changes"
        sidebarOpen
        onToggleSidebar={vi.fn()}
        onClose={vi.fn()}
        browseTabs={{
          tabs: [],
          previewTab: null,
          activeFilePath: null,
          isDirty: false,
          onSwitchTab: vi.fn(),
          onCloseTab: vi.fn(),
          onDoubleClickTab: vi.fn(),
        }}
        selectedFile={null}
        isDirty={false}
        hasExternalChange={false}
        groupedFiles={[]}
        diffFilesLength={0}
        comparisonBranch="main"
        selectedCommitHash={null}
        commitDiff={null}
        historySelectedFile={null}
        useMergeBase
        availableBranches={[]}
        loadingBranches={false}
        comparisonLoading
        onBranchChange={vi.fn()}
        onLoadBranches={vi.fn()}
        onCompareSinceTarget={vi.fn()}
        targetBranch="main"
        workingDirectory="/repo"
        workspaceId="workspace"
        isRemoteWorkspace={false}
        onCommitted={vi.fn()}
        hideUnchangedRegions
        onToggleHideUnchanged={vi.fn()}
        viewMode="split"
        splitViewAvailable
        onViewModeChange={vi.fn()}
        totalChanges={0}
        currentChangeIndex={-1}
        goToPreviousChange={vi.fn()}
        goToNextChange={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: 'Compare: Since main' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /all changes since main/i })).toBeNull();
  });
});
