/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import {
  FileViewerToolbar,
  type FileViewerToolbarProps,
} from '@/components/workspaces/file-viewer/FileViewerToolbar';
import { useFileViewerStore } from '@/stores/file-viewer.store';

vi.mock('@/components/workspaces/file-viewer/CommitComposer', () => ({
  CommitComposer: ({
    workingDirectory,
    isRemoteWorkspace,
  }: {
    workingDirectory: string;
    isRemoteWorkspace?: boolean;
  }) => (
    <div data-testid="commit-composer" data-remote={String(isRemoteWorkspace)}>
      {workingDirectory}
    </div>
  ),
}));

vi.mock('@/components/workspaces/file-viewer/BranchCompareSelect', () => ({
  BranchCompareSelect: () => <div data-testid="branch-compare-select" />,
}));

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

// The toolbar is the window's top row, shaped for the window controls of the platform.
window.api = { platform: 'linux' } as typeof window.api;

const props = {
  mode: 'diff',
  isGitWorkspace: true,
  diffSubMode: 'changes',
  sidebarOpen: true,
  onToggleSidebar: vi.fn(),
  onClose: vi.fn(),
  browseTabs: {
    tabs: [],
    previewTab: null,
    activeFilePath: null,
    isDirty: false,
    onSwitchTab: vi.fn(),
    onCloseTab: vi.fn(),
    onDoubleClickTab: vi.fn(),
  },
  selectedFile: null,
  isDirty: false,
  hasExternalChange: false,
  groupedFiles: [],
  diffFilesLength: 1,
  comparisonBranch: null,
  selectedCommitHash: null,
  commitDiff: null,
  historySelectedFile: null,
  useMergeBase: false,
  availableBranches: [],
  loadingBranches: false,
  onBranchChange: vi.fn(),
  onLoadBranches: vi.fn().mockResolvedValue(undefined),
  onCompareSinceTarget: vi.fn(),
  targetBranch: 'main',
  workingDirectory: '/repo/worktree',
  workspaceId: 'workspace-1',
  isRemoteWorkspace: false,
  onCommitted: vi.fn(),
  hideUnchangedRegions: false,
  onToggleHideUnchanged: vi.fn(),
  viewMode: 'split',
  splitViewAvailable: true,
  onViewModeChange: vi.fn(),
  totalChanges: 1,
  currentChangeIndex: -1,
  goToPreviousChange: vi.fn(),
  goToNextChange: vi.fn(),
} satisfies FileViewerToolbarProps;

describe('FileViewerToolbar', () => {
  it('passes the working directory to the commit composer', () => {
    render(<FileViewerToolbar {...props} />);

    expect(screen.getByTestId('commit-composer')).toHaveTextContent('/repo/worktree');
  });

  it('uses workspace-aware commit logic for remote workspaces', () => {
    render(<FileViewerToolbar {...props} isRemoteWorkspace />);

    expect(screen.getByTestId('commit-composer')).toHaveAttribute('data-remote', 'true');
  });

  it('goes back with Back and switches between Files and Diff, as the top row', () => {
    const requestFileViewerTransition = vi.fn();
    useFileViewerStore.setState({ requestFileViewerTransition });
    const onClose = vi.fn();
    render(<FileViewerToolbar {...props} onClose={onClose} trailing={<span>Branch menus</span>} />);

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(onClose).toHaveBeenCalledTimes(1);

    // The mode on screen stays; only the other one switches.
    fireEvent.click(screen.getByRole('radio', { name: 'Diff' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Files' }));
    expect(requestFileViewerTransition.mock.calls).toEqual([
      [{ kind: 'toggle', workspaceId: 'workspace-1', mode: 'browse' }],
    ]);
    expect(screen.getByText('Branch menus')).toBeInTheDocument();
  });

  it('has no Files and Diff switch in a folder that is not a git worktree', () => {
    render(<FileViewerToolbar {...props} mode="browse" isGitWorkspace={false} />);

    expect(screen.queryByRole('radiogroup', { name: 'View' })).not.toBeInTheDocument();
  });
});

describe('FileViewerToolbar path truncation', () => {
  // The path spans use `direction: rtl` so long paths truncate on the left.
  // Without a bidi isolate the leading "." is treated as RTL punctuation and
  // rendered at the end (".github/x.yml" shows as "github/x.yml.").
  it('isolates the diff path so a leading dot stays in front', () => {
    render(<FileViewerToolbar {...props} selectedFile=".github/workflows/ci.yml" />);

    expect(screen.getByText('.github/workflows/ci.yml').tagName).toBe('BDI');
  });

  it('isolates the history path so a leading dot stays in front', () => {
    render(
      <FileViewerToolbar
        {...props}
        diffSubMode="history"
        selectedCommitHash="abc123"
        historySelectedFile=".github/workflows/ci.yml"
      />
    );

    expect(screen.getByText('.github/workflows/ci.yml').tagName).toBe('BDI');
  });
});

describe('FileViewerToolbar sidebar shortcut label', () => {
  function renderWithPlatform(platform: string) {
    window.api = { ...window.api, platform } as typeof window.api;
    return render(<FileViewerToolbar {...props} />);
  }

  it('shows ⌘B on macOS', () => {
    renderWithPlatform('darwin');
    expect(screen.getByRole('button', { name: 'Hide sidebar' })).toBeInTheDocument();
    expect(screen.getByText('⌘B').tagName).toBe('KBD');
  });

  it.each(['linux', 'win32'])('shows Ctrl+B on %s', (platform) => {
    renderWithPlatform(platform);
    expect(screen.getByRole('button', { name: 'Hide sidebar' })).toBeInTheDocument();
    expect(screen.getByText('Ctrl+B').tagName).toBe('KBD');
  });
});

describe('FileViewerToolbar diff layout control', () => {
  it('shows the chosen layout and reports a new choice', () => {
    const onViewModeChange = vi.fn();
    render(<FileViewerToolbar {...props} onViewModeChange={onViewModeChange} />);

    expect(screen.getByRole('radiogroup', { name: 'Diff layout' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Split' })).toBeChecked();

    fireEvent.click(screen.getByRole('radio', { name: 'Unified' }));

    expect(onViewModeChange).toHaveBeenCalledWith('unified');
  });

  it('offers only unified for files that have one side', () => {
    render(<FileViewerToolbar {...props} viewMode="unified" splitViewAvailable={false} />);

    expect(screen.getByRole('radio', { name: 'Unified' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Split' })).toBeDisabled();
  });

  it('shows the layout control for a selected commit in history', () => {
    render(<FileViewerToolbar {...props} diffSubMode="history" selectedCommitHash="abc123" />);

    expect(screen.getByRole('radiogroup', { name: 'Diff layout' })).toBeInTheDocument();
  });
});

describe('FileViewerToolbar change position', () => {
  it('shows which change is focused out of the total', () => {
    render(<FileViewerToolbar {...props} totalChanges={5} currentChangeIndex={1} />);

    expect(screen.getByText('2 / 5')).toBeInTheDocument();
    expect(screen.getByText('Change 2 of 5')).toBeInTheDocument();
  });

  it('shows the total before any change is focused', () => {
    render(<FileViewerToolbar {...props} totalChanges={5} currentChangeIndex={-1} />);

    expect(screen.getByText('– / 5')).toBeInTheDocument();
  });

  it('hides the position when the file has no changes', () => {
    render(<FileViewerToolbar {...props} totalChanges={0} currentChangeIndex={-1} />);

    expect(screen.queryByText(/\/ 0/)).not.toBeInTheDocument();
  });
});

describe('FileViewerToolbar browse tabs', () => {
  it('adds the parent folder to tabs that share a file name', () => {
    render(
      <FileViewerToolbar
        {...props}
        mode="browse"
        browseTabs={{
          ...props.browseTabs,
          tabs: ['src/utils/index.ts', 'src/app/index.ts', 'README.md'],
          activeFilePath: 'README.md',
        }}
      />
    );

    expect(screen.getByRole('button', { name: 'index.ts — utils' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'index.ts — app' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'README.md' })).toBeInTheDocument();
  });

  it('uses enough of the path to tell same-named tabs apart', () => {
    render(
      <FileViewerToolbar
        {...props}
        mode="browse"
        browseTabs={{
          ...props.browseTabs,
          tabs: ['web/src/index.ts'],
          previewTab: 'api/src/index.ts',
        }}
      />
    );

    expect(screen.getByRole('button', { name: 'index.ts — web/src' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'index.ts — api/src' })).toBeInTheDocument();
  });
});
