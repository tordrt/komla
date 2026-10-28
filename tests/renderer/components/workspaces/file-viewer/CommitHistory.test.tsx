/**
 * @vitest-environment jsdom
 */
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { CommitDetailsPanel } from '../../../../../src/renderer/components/workspaces/file-viewer/CommitDetailsPanel';
import { SidebarFileTree } from '../../../../../src/renderer/components/workspaces/file-viewer/SidebarFileTree';
import {
  CommitHistorySidebar,
  type CommitHistorySidebarProps,
} from '../../../../../src/renderer/components/workspaces/file-viewer/CommitHistorySidebar';
import { TooltipProvider } from '../../../../../src/renderer/components/ui/tooltip';
import { isShortcutEventClaimed } from '../../../../../src/renderer/lib/shortcut-claims';
import { useConfigStore } from '../../../../../src/renderer/stores/config.store';
import { useToastStore } from '../../../../../src/renderer/stores/toast.store';

import type { AppConfig, CommitDiff } from '../../../../../src/renderer/types';
import type { CommitGraphCommit } from '../../../../../src/shared/types/commit-graph';

// The tree's own menus are tested with it; here only what History hands it.
vi.mock('../../../../../src/renderer/components/workspaces/file-viewer/SidebarFileTree', () => ({
  SidebarFileTree: vi.fn(() => null),
}));

const MERGE = 'a'.repeat(40);
const MAIN = 'b'.repeat(40);
const SIDE = 'c'.repeat(40);

const merge: CommitGraphCommit = {
  hash: MERGE,
  parentHashes: [MAIN, SIDE],
  author: 'Ada',
  timestamp: 1_700_000_000,
  message: 'Merge side into main\n\nBrings the redirect fix\nfrom the side branch.',
  refs: [
    { kind: 'branch', name: 'main' },
    { kind: 'tag', name: 'v2' },
  ],
};

const diff: CommitDiff = {
  commit: {
    hash: MERGE,
    shortHash: 'aaaaaaa',
    message: 'Merge side into main',
    author: 'Ada',
    authorEmail: 'ada@example.com',
    timestamp: 1_700_000_000,
    parentHashes: [MAIN, SIDE],
    refs: [{ kind: 'tag', name: 'v2' }],
  },
  files: [],
  summary: { additions: 12, deletions: 3, filesChanged: 2 },
};

const roles = { currentBranch: 'main', upstream: null, targetBranch: 'main' };

describe('CommitDetailsPanel', () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] });
    window.api = { ...window.api, copyToClipboard: vi.fn() } as typeof window.api;
  });

  it("shows the commit's title, body, author, refs and changes, and opens a parent", async () => {
    const user = userEvent.setup();
    const onSelectCommit = vi.fn();
    render(
      <CommitDetailsPanel
        commit={merge}
        commitDiff={diff}
        roles={roles}
        onSelectCommit={onSelectCommit}
      />
    );

    const panel = screen.getByRole('region', { name: 'Commit' });
    expect(within(panel).getByRole('heading')).toHaveTextContent('Merge side into main');
    expect(panel).toHaveTextContent('Brings the redirect fix from the side branch.');
    expect(panel).toHaveTextContent('Ada');
    expect(panel).toHaveTextContent('2 files');
    expect(within(panel).getByText('v2')).toBeInTheDocument();

    await user.click(within(panel).getByRole('button', { name: 'ccccccc' }));
    expect(onSelectCommit).toHaveBeenCalledWith(SIDE);

    await user.click(within(panel).getByRole('button', { name: `Copy commit hash ${MERGE}` }));
    expect(window.api.copyToClipboard).toHaveBeenCalledWith(MERGE);
    expect(useToastStore.getState().toasts[0].message).toBe('Copied commit aaaaaaa');
  });

  it('folds a long message to its first paragraph until asked for the rest', async () => {
    const user = userEvent.setup();
    const long = { ...merge, message: `${merge.message}\n\nKeeps the session.` };
    const { rerender } = render(
      <CommitDetailsPanel commit={long} commitDiff={diff} roles={roles} onSelectCommit={vi.fn()} />
    );

    const panel = screen.getByRole('region', { name: 'Commit' });
    expect(panel).toHaveTextContent('Brings the redirect fix from the side branch.');
    expect(panel).not.toHaveTextContent('Keeps the session.');
    await user.click(within(panel).getByRole('button', { name: 'Show more' }));
    expect(panel).toHaveTextContent('Keeps the session.');
    expect(within(panel).getByRole('button', { name: 'Show less' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );

    // Another commit starts folded.
    rerender(
      <CommitDetailsPanel
        commit={{ ...long, hash: SIDE }}
        commitDiff={null}
        roles={roles}
        onSelectCommit={vi.fn()}
      />
    );
    expect(panel).not.toHaveTextContent('Keeps the session.');
    expect(within(panel).getByRole('button', { name: 'Show more' })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
  });

  it('folds a first paragraph that runs past the lines it shows', () => {
    const heights = [
      vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(200),
      vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(60),
    ];
    onTestFinished(() => heights.forEach((spy) => spy.mockRestore()));
    render(
      <CommitDetailsPanel commit={merge} commitDiff={diff} roles={roles} onSelectCommit={vi.fn()} />
    );

    expect(screen.getByRole('button', { name: 'Show more' })).toBeInTheDocument();
  });

  it('offers no Show more when the message fits', () => {
    render(
      <CommitDetailsPanel commit={merge} commitDiff={diff} roles={roles} onSelectCommit={vi.fn()} />
    );

    expect(screen.getByRole('region', { name: 'Commit' })).toHaveTextContent(
      'Brings the redirect fix from the side branch.'
    );
    expect(screen.queryByRole('button', { name: /Show (more|less)/ })).not.toBeInTheDocument();
  });

  it('shows a commit opened from beyond the loaded list from its diff', () => {
    render(
      <CommitDetailsPanel
        commit={undefined}
        commitDiff={{ ...diff, commit: { ...diff.commit, message: merge.message } }}
        roles={roles}
        onSelectCommit={vi.fn()}
      />
    );

    const panel = screen.getByRole('region', { name: 'Commit' });
    expect(within(panel).getByRole('heading')).toHaveTextContent('Merge side into main');
    expect(panel).toHaveTextContent('Brings the redirect fix from the side branch.');
    expect(within(panel).getByText('v2')).toBeInTheDocument();
  });
});

describe('CommitHistorySidebar', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
    useConfigStore.setState({ config: { remoteBranchesExpanded: true } as AppConfig });
  });

  function renderSidebar(overrides: Partial<CommitHistorySidebarProps> = {}) {
    const props: CommitHistorySidebarProps = {
      workspaceId: 'ws',
      workingDirectory: '/repo',
      isRemoteWorkspace: false,
      commits: [merge],
      branchRoles: { currentBranch: 'main', upstream: null },
      targetBranch: 'main',
      loadingCommits: false,
      hasMoreCommits: false,
      selectedCommitHash: null,
      commitDiff: null,
      loadingCommitDiff: false,
      selectedFilePath: null,
      onSelectCommit: vi.fn(),
      onSelectFile: vi.fn(),
      onLoadMore: vi.fn(),
      onToggleHistory: vi.fn(),
      filterPath: null,
      onClearFilterPath: vi.fn(),
      historyBranch: null,
      onBranchChange: vi.fn(),
      availableBranches: [],
      loadingBranches: false,
      onLoadBranches: vi.fn(() => Promise.resolve()),
      ...overrides,
    };
    render(
      <TooltipProvider>
        <CommitHistorySidebar {...props} />
      </TooltipProvider>
    );
    return props;
  }

  it('lists commits on one line each with their refs, and selects one', async () => {
    const user = userEvent.setup();
    const { onSelectCommit } = renderSidebar();

    const row = screen.getByRole('button', { name: /Merge side into main/ });
    expect(within(row).getByText('main')).toBeInTheDocument();
    expect(within(row).getByText('+1')).toBeInTheDocument();
    await user.click(row);

    expect(onSelectCommit).toHaveBeenCalledWith(MERGE);
  });

  it('steps through the commits with the arrow keys while one has focus, and leaves them to the files elsewhere', async () => {
    const user = userEvent.setup();
    const older = { ...merge, hash: MAIN, parentHashes: [], message: 'Add the redirect', refs: [] };
    const { onSelectCommit } = renderSidebar({ commits: [merge, older] });
    // What reaches the file viewer's own shortcuts, which step through the files.
    const claimed: boolean[] = [];
    const listener = (event: KeyboardEvent) => claimed.push(isShortcutEventClaimed(event));
    window.addEventListener('keydown', listener);
    onTestFinished(() => window.removeEventListener('keydown', listener));

    await user.click(screen.getByRole('button', { name: /Merge side into main/ }));
    await user.keyboard('{ArrowDown}');
    expect(onSelectCommit).toHaveBeenLastCalledWith(MAIN);
    expect(screen.getByRole('button', { name: /Add the redirect/ })).toHaveFocus();
    // Past the oldest commit shown there is none to move to.
    await user.keyboard('{ArrowDown}');
    await user.keyboard('k');
    expect(onSelectCommit).toHaveBeenLastCalledWith(MERGE);
    expect(screen.getByRole('button', { name: /Merge side into main/ })).toHaveFocus();
    expect(onSelectCommit).toHaveBeenCalledTimes(3);
    expect(claimed).toEqual([true, true, true]);

    act(() => (document.activeElement as HTMLElement).blur());
    await user.keyboard('{ArrowDown}');
    expect(onSelectCommit).toHaveBeenCalledTimes(3);
    expect(claimed).toEqual([true, true, true, false]);
  });

  it("copies a commit's hash from its right-click menu", async () => {
    const user = userEvent.setup();
    useToastStore.setState({ toasts: [] });
    window.api = { ...window.api, copyToClipboard: vi.fn() } as typeof window.api;
    const { onSelectCommit } = renderSidebar();

    await user.pointer({
      keys: '[MouseRight]',
      target: screen.getByRole('button', { name: /Merge side into main/ }),
    });
    await user.click(await screen.findByRole('menuitem', { name: 'Copy Commit Hash' }));

    expect(window.api.copyToClipboard).toHaveBeenCalledWith(MERGE);
    expect(useToastStore.getState().toasts[0].message).toBe('Copied commit aaaaaaa');
    expect(onSelectCommit).not.toHaveBeenCalled();
  });

  it("offers no local-only actions on the files of a remote workspace's commit", () => {
    renderSidebar({
      isRemoteWorkspace: true,
      selectedCommitHash: MERGE,
      commitDiff: {
        ...diff,
        files: [{ path: 'a.ts', status: 'added', staged: false, additions: 1, deletions: 0 }],
      },
    });

    expect(vi.mocked(SidebarFileTree)).toHaveBeenLastCalledWith(
      expect.objectContaining({ isRemoteWorkspace: true, changedFilesOnly: true }),
      undefined
    );
  });

  it("says when a commit changes no files instead of the working tree's empty state", () => {
    renderSidebar({ selectedCommitHash: MERGE, commitDiff: diff });

    expect(screen.getByText('This commit changes no files')).toBeInTheDocument();
    expect(screen.queryByText('No changes yet')).not.toBeInTheDocument();
  });

  it("reads a remote branch's history from its own remote", async () => {
    const user = userEvent.setup();
    const { onBranchChange } = renderSidebar({
      availableBranches: [{ name: 'feature', isRemoteOnly: true, remoteRef: 'upstream/feature' }],
    });

    await user.click(screen.getByRole('button', { name: /HEAD/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'feature' }));

    expect(onBranchChange).toHaveBeenCalledWith('upstream/feature');
  });
});
