import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useConfigStore } from '../../../src/renderer/stores/config.store';
import { useFileViewerStore } from '../../../src/renderer/stores/file-viewer.store';
import type { AppConfig } from '../../../src/renderer/types';

function resetStore(): void {
  useFileViewerStore.setState(useFileViewerStore.getInitialState(), true);
  // openInlineFilePreview reads useConfigStore for the saved layout
  // preference; reset it so leaked state from one test doesn't change the
  // default in another.
  useConfigStore.setState({ config: null });
}

function mockApi(): void {
  (globalThis as any).window = {
    ...globalThis.window,
    api: {
      updateWorkspace: vi.fn().mockResolvedValue(undefined),
    },
  };
}

describe('file-viewer.store', () => {
  beforeEach(() => {
    resetStore();
    mockApi();
  });

  it('revealInFileTree opens the tree on its files and asks it to show the folder', () => {
    const store = useFileViewerStore.getState();
    store.setInlineFileTreeOpen('ws-1', false);

    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    store.revealInFileTree('ws-1', 'src/lib');

    expect(useFileViewerStore.getState().inlineFileTreeByWorkspace['ws-1']).toMatchObject({
      open: true,
      mode: 'browse',
    });
    // Briefly: a folder the tree never lists mustn't move focus there later.
    expect(useFileViewerStore.getState().fileTreeRevealByWorkspace['ws-1']).toEqual({
      path: 'src/lib',
      expiresAt: 11_000,
    });

    // A tree that showed another folder in the meantime keeps that request.
    store.clearFileTreeReveal('ws-1', 'src/other');
    expect(useFileViewerStore.getState().fileTreeRevealByWorkspace['ws-1']?.path).toBe('src/lib');
    store.clearFileTreeReveal('ws-1', 'src/lib');
    expect(useFileViewerStore.getState().fileTreeRevealByWorkspace['ws-1']).toBeUndefined();
    now.mockRestore();
  });

  // File viewer actions
  it('openFileViewer sets all viewer properties', () => {
    useFileViewerStore
      .getState()
      .openFileViewer('ws-1', 'diff', '/path/file.ts', 'history', '/filter');
    const state = useFileViewerStore.getState();
    expect(state.fileViewerWorkspaceId).toBe('ws-1');
    expect(state.fileViewerMode).toBe('diff');
    expect(state.fileViewerInitialFilePath).toBe('/path/file.ts');
    expect(state.fileViewerDiffSubMode).toBe('history');
    expect(state.fileViewerHistoryFilterPath).toBe('/filter');
  });

  it('openFileViewer defaults optional params to null/changes', () => {
    useFileViewerStore.getState().openFileViewer('ws-1', 'browse');
    const state = useFileViewerStore.getState();
    expect(state.fileViewerInitialFilePath).toBeNull();
    expect(state.fileViewerDiffSubMode).toBe('changes');
    expect(state.fileViewerHistoryFilterPath).toBeNull();
  });

  it('openFileViewer seeds diff comparison from initialized inline target comparison', () => {
    const store = useFileViewerStore.getState();

    store.setInlineFileTreeComparisonBranch('ws-1', 'main', true);
    store.openFileViewer('ws-1', 'diff');

    expect(useFileViewerStore.getState().fileViewerDiffComparisonByWorkspace['ws-1']).toEqual({
      comparisonBranch: 'main',
      useMergeBase: true,
    });
  });

  it('openFileViewer preserves existing fullscreen diff comparison', () => {
    const store = useFileViewerStore.getState();

    store.setInlineFileTreeComparisonBranch('ws-1', 'main', true);
    store.setFileViewerDiffComparisonBranch('ws-1', 'feature-x');
    store.openFileViewer('ws-1', 'diff');

    expect(useFileViewerStore.getState().fileViewerDiffComparisonByWorkspace['ws-1']).toEqual({
      comparisonBranch: 'feature-x',
      useMergeBase: false,
    });
  });

  it('closeFileViewer clears open state and preserves diff sub-mode for reopen', () => {
    useFileViewerStore.getState().openFileViewer('ws-1', 'diff', '/path', 'history', '/filter');
    useFileViewerStore.getState().closeFileViewer();
    const state = useFileViewerStore.getState();
    expect(state.fileViewerWorkspaceId).toBeNull();
    expect(state.fileViewerInitialFilePath).toBeNull();
    expect(state.fileViewerDiffSubMode).toBe('history');
    expect(state.fileViewerHistoryFilterPath).toBeNull();
    expect(state.getDiffSubMode('ws-1')).toBe('history');
  });

  it('openFileViewer restores persisted diff sub-mode when one was saved', () => {
    useFileViewerStore.getState().openFileViewer('ws-1', 'diff');
    useFileViewerStore.getState().setDiffSubMode('history');
    useFileViewerStore.getState().closeFileViewer();

    useFileViewerStore.getState().openFileViewer('ws-1', 'diff');

    expect(useFileViewerStore.getState().fileViewerDiffSubMode).toBe('history');
  });

  it('setFileViewerMode changes mode', () => {
    useFileViewerStore.getState().setFileViewerMode('diff');
    expect(useFileViewerStore.getState().fileViewerMode).toBe('diff');
  });

  it('setDiffSubMode changes sub-mode', () => {
    useFileViewerStore.getState().setDiffSubMode('history');
    expect(useFileViewerStore.getState().fileViewerDiffSubMode).toBe('history');
  });

  it('saveDiffSelections and getDiffSelections persist per-workspace diff state', () => {
    useFileViewerStore.getState().saveDiffSelections('ws-1', {
      selectedFile: 'src/a.ts',
      selectedCommitHash: 'abc123',
      historySelectedFile: 'src/a.ts',
      historyBranch: 'feature/test',
      historyFilterPath: 'src/a.ts',
    });

    expect(useFileViewerStore.getState().getDiffSelections('ws-1')).toEqual({
      selectedFile: 'src/a.ts',
      selectedCommitHash: 'abc123',
      historySelectedFile: 'src/a.ts',
      historyBranch: 'feature/test',
      historyFilterPath: 'src/a.ts',
    });
    expect(useFileViewerStore.getState().getDiffSelections('ws-2')).toEqual({
      selectedFile: null,
      selectedCommitHash: null,
      historySelectedFile: null,
      historyBranch: null,
      historyFilterPath: null,
    });
  });

  // Last diff file persistence
  it('setLastDiffFile and getLastDiffFile work together', () => {
    useFileViewerStore.getState().setLastDiffFile('/repo', 'file.ts');
    expect(useFileViewerStore.getState().getLastDiffFile('/repo')).toBe('file.ts');
    expect(useFileViewerStore.getState().getLastDiffFile('/other')).toBeUndefined();
  });

  // Expanded diff folders
  it('setExpandedDiffFolders and getExpandedDiffFolders work together', () => {
    useFileViewerStore.getState().setExpandedDiffFolders('/repo', ['src', 'src/lib']);
    expect(useFileViewerStore.getState().getExpandedDiffFolders('/repo')).toEqual([
      'src',
      'src/lib',
    ]);
    expect(useFileViewerStore.getState().getExpandedDiffFolders('/other')).toBeUndefined();
  });

  // Inline file tree
  it('toggleInlineFileTree toggles open state', () => {
    // First toggle: initial open state defaults to true, so toggling sets to false
    useFileViewerStore.getState().toggleInlineFileTree('ws-1');
    expect(useFileViewerStore.getState().inlineFileTreeByWorkspace['ws-1']?.open).toBe(false);

    useFileViewerStore.getState().toggleInlineFileTree('ws-1');
    expect(useFileViewerStore.getState().inlineFileTreeByWorkspace['ws-1']?.open).toBe(true);
  });

  it('setInlineFileTreeOpen sets open state directly', () => {
    useFileViewerStore.getState().setInlineFileTreeOpen('ws-1', true);
    expect(useFileViewerStore.getState().inlineFileTreeByWorkspace['ws-1']?.open).toBe(true);
  });

  it('setInlineFileTreeMode sets mode', () => {
    useFileViewerStore.getState().setInlineFileTreeMode('ws-1', 'browse');
    expect(useFileViewerStore.getState().inlineFileTreeByWorkspace['ws-1']?.mode).toBe('browse');
  });

  it('setInlineFileTreeComparisonBranch sets branch', () => {
    useFileViewerStore.getState().setInlineFileTreeComparisonBranch('ws-1', 'develop');
    expect(useFileViewerStore.getState().inlineFileTreeByWorkspace['ws-1']?.comparisonBranch).toBe(
      'develop'
    );
  });

  it('setFileViewerDiffComparisonBranch keeps branch separate from inline file tree', () => {
    const store = useFileViewerStore.getState();

    store.setInlineFileTreeComparisonBranch('ws-1', 'main', true);
    store.setFileViewerDiffComparisonBranch('ws-1', 'feature-x');

    expect(useFileViewerStore.getState().inlineFileTreeByWorkspace['ws-1']).toMatchObject({
      comparisonBranch: 'main',
      useMergeBase: true,
    });
    expect(useFileViewerStore.getState().fileViewerDiffComparisonByWorkspace['ws-1']).toEqual({
      comparisonBranch: 'feature-x',
      useMergeBase: false,
    });
  });

  it('copyInlineFileTreeComparisonToFileViewerDiff preserves expand-from-inline scope', () => {
    const store = useFileViewerStore.getState();

    store.setInlineFileTreeComparisonBranch('ws-1', 'main', true);
    store.copyInlineFileTreeComparisonToFileViewerDiff('ws-1');

    expect(useFileViewerStore.getState().fileViewerDiffComparisonByWorkspace['ws-1']).toEqual({
      comparisonBranch: 'main',
      useMergeBase: true,
    });
  });

  it('copyInlineFileTreeComparisonToFileViewerDiff clears stale fullscreen comparison', () => {
    const store = useFileViewerStore.getState();

    store.setFileViewerDiffComparisonBranch('ws-1', 'feature-x');
    store.setInlineFileTreeComparisonBranch('ws-1', null);
    store.copyInlineFileTreeComparisonToFileViewerDiff('ws-1');

    expect(useFileViewerStore.getState().fileViewerDiffComparisonByWorkspace['ws-1']).toEqual({
      comparisonBranch: null,
      useMergeBase: false,
    });
  });

  it('preserves useMergeBase when toggling, opening, and changing inline file tree mode', () => {
    const store = useFileViewerStore.getState();

    store.setInlineFileTreeComparisonBranch('ws-1', 'main', true);
    store.toggleInlineFileTree('ws-1');
    expect(useFileViewerStore.getState().inlineFileTreeByWorkspace['ws-1']).toMatchObject({
      comparisonBranch: 'main',
      useMergeBase: true,
    });

    store.setInlineFileTreeOpen('ws-1', true);
    expect(useFileViewerStore.getState().inlineFileTreeByWorkspace['ws-1']).toMatchObject({
      comparisonBranch: 'main',
      useMergeBase: true,
    });

    store.setInlineFileTreeMode('ws-1', 'browse');
    expect(useFileViewerStore.getState().inlineFileTreeByWorkspace['ws-1']).toMatchObject({
      mode: 'browse',
      comparisonBranch: 'main',
      useMergeBase: true,
    });
  });

  it('setInlineFileTreeWidth clamps value', () => {
    useFileViewerStore.getState().setInlineFileTreeWidth('ws-1', 0.5);
    expect(useFileViewerStore.getState().inlineFileTreeWidthByWorkspace['ws-1']).toBe(0.5);

    useFileViewerStore.getState().setInlineFileTreeWidth('ws-1', -1);
    expect(useFileViewerStore.getState().inlineFileTreeWidthByWorkspace['ws-1']).toBe(0.05);

    useFileViewerStore.getState().setInlineFileTreeWidth('ws-1', 2);
    expect(useFileViewerStore.getState().inlineFileTreeWidthByWorkspace['ws-1']).toBe(0.9);
  });

  // Inline file preview
  it('openInlineFilePreview sets preview state', () => {
    useFileViewerStore.getState().openInlineFilePreview('ws-1', 'diff', '/path/file.ts');
    const preview = useFileViewerStore.getState().inlineFilePreviewByWorkspace['ws-1'];
    expect(preview?.open).toBe(true);
    expect(preview?.mode).toBe('diff');
    expect(preview?.filePath).toBe('/path/file.ts');
  });

  it('openInlineFilePreview stores lineNumber', () => {
    useFileViewerStore.getState().openInlineFilePreview('ws-1', 'browse', '/path/file.ts', 42);
    const preview = useFileViewerStore.getState().inlineFilePreviewByWorkspace['ws-1'];
    expect(preview?.open).toBe(true);
    expect(preview?.filePath).toBe('/path/file.ts');
    expect(preview?.lineNumber).toBe(42);
  });

  it('clearInlineFilePreviewLineNumber consumes only the pending line jump', () => {
    useFileViewerStore.getState().openInlineFilePreview('ws-1', 'browse', '/path/file.ts', 42);

    useFileViewerStore.getState().clearInlineFilePreviewLineNumber('ws-1');

    const preview = useFileViewerStore.getState().inlineFilePreviewByWorkspace['ws-1'];
    expect(preview?.open).toBe(true);
    expect(preview?.mode).toBe('browse');
    expect(preview?.filePath).toBe('/path/file.ts');
    expect(preview?.lineNumber).toBeUndefined();
  });

  it('openInlineFilePreview without lineNumber leaves it undefined', () => {
    useFileViewerStore.getState().openInlineFilePreview('ws-1', 'browse', '/path/file.ts');
    const preview = useFileViewerStore.getState().inlineFilePreviewByWorkspace['ws-1'];
    expect(preview?.lineNumber).toBeUndefined();
  });

  it('closeInlineFilePreview closes preview and clears filePath', () => {
    useFileViewerStore.getState().openInlineFilePreview('ws-1', 'diff', '/path/file.ts');
    useFileViewerStore.getState().closeInlineFilePreview('ws-1');
    const preview = useFileViewerStore.getState().inlineFilePreviewByWorkspace['ws-1'];
    expect(preview?.open).toBe(false);
    // filePath is cleared on close so the sidebar file tree can drop its
    // selection; otherwise the row stays highlighted and re-clicking becomes
    // a silent no-op in pierre/trees.
    expect(preview?.filePath).toBeNull();
    expect(preview?.mode).toBe('diff');
  });

  it('setInlineFilePreviewMode changes mode', () => {
    useFileViewerStore.getState().setInlineFilePreviewMode('ws-1', 'diff');
    expect(useFileViewerStore.getState().inlineFilePreviewByWorkspace['ws-1']?.mode).toBe('diff');
  });

  // Regression tests for the close → switch-mode reopen bug. The store must
  // not resurrect a cleared filePath when the mode changes, and must keep an
  // open preview on the same file across mode changes. Component-level
  // coverage for the tree's focus effect is tricky to write without jsdom
  // papering over pierre's native event ordering — these store tests pin
  // the preconditions the component layer relies on.
  it('setInlineFilePreviewMode does not resurrect filePath after close', () => {
    useFileViewerStore.getState().openInlineFilePreview('ws-1', 'diff', '/path/file.ts');
    useFileViewerStore.getState().closeInlineFilePreview('ws-1');
    useFileViewerStore.getState().setInlineFilePreviewMode('ws-1', 'browse');
    const preview = useFileViewerStore.getState().inlineFilePreviewByWorkspace['ws-1'];
    expect(preview?.open).toBe(false);
    expect(preview?.filePath).toBeNull();
    expect(preview?.mode).toBe('browse');
  });

  // Regression: opening a preview should seed its layout from the user's
  // saved config preference, not from the stale `current.layout` left behind
  // by closeInlineFilePreview or synthesized by setInlineFilePreviewMode.
  // Active previews keep their own layout so cross-file navigation within
  // an open preview doesn't yank the layout the user is looking at.
  describe('openInlineFilePreview layout seeding', () => {
    function setPreferredLayout(layout: 'full' | 'side-by-side' | undefined): void {
      useConfigStore.setState({
        config: { defaultInlinePreviewLayout: layout } as AppConfig,
      });
    }

    it('seeds layout from config preference when no preview entry exists', () => {
      setPreferredLayout('side-by-side');
      useFileViewerStore.getState().openInlineFilePreview('ws-1', 'diff', '/path/file.ts');
      const preview = useFileViewerStore.getState().inlineFilePreviewByWorkspace['ws-1'];
      expect(preview?.layout).toBe('side-by-side');
    });

    it('re-seeds layout from config when reopening a closed preview with stale layout', () => {
      // Workspace previously opened in full and was closed — entry remains
      // with layout: 'full'. The user has since toggled their preference to
      // side-by-side. Reopening must honor the new preference.
      setPreferredLayout('full');
      useFileViewerStore.getState().openInlineFilePreview('ws-1', 'diff', '/path/file.ts');
      useFileViewerStore.getState().closeInlineFilePreview('ws-1');
      setPreferredLayout('side-by-side');
      useFileViewerStore.getState().openInlineFilePreview('ws-1', 'diff', '/path/other.ts');
      const preview = useFileViewerStore.getState().inlineFilePreviewByWorkspace['ws-1'];
      expect(preview?.layout).toBe('side-by-side');
    });

    it('preserves layout of an already-open preview when navigating to a different file', () => {
      // While a preview is open, switching to another file must not yank the
      // active layout — only closed/uninitialized entries are re-seeded.
      setPreferredLayout('full');
      useFileViewerStore.getState().openInlineFilePreview('ws-1', 'diff', '/path/a.ts');
      // Simulate the user (or live-follow) flipping to side-by-side mid-session.
      useFileViewerStore.getState().setInlineFilePreviewLayout('ws-1', 'side-by-side');
      useFileViewerStore.getState().openInlineFilePreview('ws-1', 'diff', '/path/b.ts');
      const preview = useFileViewerStore.getState().inlineFilePreviewByWorkspace['ws-1'];
      expect(preview?.layout).toBe('side-by-side');
    });

    it('falls back to full when no preference is set', () => {
      setPreferredLayout(undefined);
      useFileViewerStore.getState().openInlineFilePreview('ws-1', 'diff', '/path/file.ts');
      const preview = useFileViewerStore.getState().inlineFilePreviewByWorkspace['ws-1'];
      expect(preview?.layout).toBe('full');
    });
  });

  describe('requestInlineFilePreviewNav', () => {
    it('ignores an async navigation completion after a newer navigation request', () => {
      const store = useFileViewerStore.getState();
      const snapshotRequestId = store.reserveInlineFilePreviewNav('ws-1');

      store.openInlineFilePreview('ws-1', 'browse', '/path/newer.ts');
      useFileViewerStore
        .getState()
        .requestInlineFilePreviewNav('ws-1', 'browse', '.komla-files/older.ts', undefined, {
          requestId: snapshotRequestId,
        });

      expect(useFileViewerStore.getState().inlineFilePreviewByWorkspace['ws-1']?.filePath).toBe(
        '/path/newer.ts'
      );
    });

    it('navigates directly when no preview is open', () => {
      useFileViewerStore.getState().requestInlineFilePreviewNav('ws-1', 'browse', '/path/a.ts');
      const preview = useFileViewerStore.getState().inlineFilePreviewByWorkspace['ws-1'];
      expect(preview?.filePath).toBe('/path/a.ts');
      expect(
        useFileViewerStore.getState().inlineFilePreviewPendingNavByWorkspace['ws-1']
      ).toBeFalsy();
    });

    it('navigates directly when preview is clean', () => {
      useFileViewerStore.getState().openInlineFilePreview('ws-1', 'browse', '/path/a.ts');
      useFileViewerStore.getState().setInlineFilePreviewDirty('ws-1', false);
      useFileViewerStore.getState().requestInlineFilePreviewNav('ws-1', 'browse', '/path/b.ts');
      const preview = useFileViewerStore.getState().inlineFilePreviewByWorkspace['ws-1'];
      expect(preview?.filePath).toBe('/path/b.ts');
      expect(
        useFileViewerStore.getState().inlineFilePreviewPendingNavByWorkspace['ws-1']
      ).toBeFalsy();
    });

    it('stages a pending nav when preview is dirty and target differs', () => {
      useFileViewerStore.getState().openInlineFilePreview('ws-1', 'browse', '/path/a.ts');
      useFileViewerStore.getState().setInlineFilePreviewDirty('ws-1', true);
      useFileViewerStore.getState().requestInlineFilePreviewNav('ws-1', 'browse', '/path/b.ts');
      // filePath stays on the current file — file tree highlight stays correct
      const preview = useFileViewerStore.getState().inlineFilePreviewByWorkspace['ws-1'];
      expect(preview?.filePath).toBe('/path/a.ts');
      // and the requested target is staged for the panel to surface a dialog
      expect(useFileViewerStore.getState().inlineFilePreviewPendingNavByWorkspace['ws-1']).toEqual({
        mode: 'browse',
        filePath: '/path/b.ts',
        lineNumber: undefined,
      });
    });

    it('switches the tree to its files with browseTree, but only once the nav lands', () => {
      const store = useFileViewerStore.getState();
      store.setInlineFileTreeMode('ws-1', 'diff');
      store.openInlineFilePreview('ws-1', 'diff', '/path/a.ts');
      store.setInlineFilePreviewDirty('ws-1', true);

      useFileViewerStore
        .getState()
        .requestInlineFilePreviewNav('ws-1', 'browse', '/path/b.ts', undefined, {
          browseTree: true,
        });

      expect(useFileViewerStore.getState().inlineFileTreeByWorkspace['ws-1']?.mode).toBe('diff');
      expect(
        useFileViewerStore.getState().inlineFilePreviewPendingNavByWorkspace['ws-1']
      ).toMatchObject({ filePath: '/path/b.ts', browseTree: true });

      useFileViewerStore.getState().setInlineFilePreviewDirty('ws-1', false);
      useFileViewerStore
        .getState()
        .requestInlineFilePreviewNav('ws-1', 'browse', '/path/b.ts', undefined, {
          browseTree: true,
        });

      expect(useFileViewerStore.getState().inlineFileTreeByWorkspace['ws-1']?.mode).toBe('browse');
      expect(useFileViewerStore.getState().inlineFilePreviewByWorkspace['ws-1']?.filePath).toBe(
        '/path/b.ts'
      );
    });

    it('navigates directly when dirty but target equals current file', () => {
      useFileViewerStore.getState().openInlineFilePreview('ws-1', 'browse', '/path/a.ts');
      useFileViewerStore.getState().setInlineFilePreviewDirty('ws-1', true);
      useFileViewerStore.getState().requestInlineFilePreviewNav('ws-1', 'browse', '/path/a.ts');
      // No-op nav (same file, same mode); no pending nav staged.
      expect(
        useFileViewerStore.getState().inlineFilePreviewPendingNavByWorkspace['ws-1']
      ).toBeFalsy();
    });

    it('stages a pending nav when dirty and only the mode differs for the same file', () => {
      useFileViewerStore.getState().openInlineFilePreview('ws-1', 'browse', '/path/a.ts');
      useFileViewerStore.getState().setInlineFilePreviewDirty('ws-1', true);
      // Same file, mode change — would unmount/reload Monaco, so it must prompt.
      useFileViewerStore.getState().requestInlineFilePreviewNav('ws-1', 'diff', '/path/a.ts');
      expect(useFileViewerStore.getState().inlineFilePreviewPendingNavByWorkspace['ws-1']).toEqual({
        mode: 'diff',
        filePath: '/path/a.ts',
        lineNumber: undefined,
      });
      // Editor was not reloaded.
      expect(useFileViewerStore.getState().inlineFilePreviewByWorkspace['ws-1']?.mode).toBe(
        'browse'
      );
    });

    it('clearInlineFilePreviewPendingNav drops a staged request', () => {
      useFileViewerStore.getState().openInlineFilePreview('ws-1', 'browse', '/path/a.ts');
      useFileViewerStore.getState().setInlineFilePreviewDirty('ws-1', true);
      useFileViewerStore.getState().requestInlineFilePreviewNav('ws-1', 'browse', '/path/b.ts');
      useFileViewerStore.getState().clearInlineFilePreviewPendingNav('ws-1');
      expect(
        useFileViewerStore.getState().inlineFilePreviewPendingNavByWorkspace['ws-1']
      ).toBeNull();
    });

    it('closeInlineFilePreview clears any staged pending nav', () => {
      useFileViewerStore.getState().openInlineFilePreview('ws-1', 'browse', '/path/a.ts');
      useFileViewerStore.getState().setInlineFilePreviewDirty('ws-1', true);
      useFileViewerStore.getState().requestInlineFilePreviewNav('ws-1', 'browse', '/path/b.ts');
      useFileViewerStore.getState().closeInlineFilePreview('ws-1');
      expect(
        useFileViewerStore.getState().inlineFilePreviewPendingNavByWorkspace['ws-1']
      ).toBeNull();
    });
  });

  describe('requestInlineFilePreviewClose', () => {
    it('closes immediately when preview is clean', () => {
      useFileViewerStore.getState().openInlineFilePreview('ws-1', 'browse', '/path/a.ts');
      useFileViewerStore.getState().setInlineFilePreviewDirty('ws-1', false);
      useFileViewerStore.getState().requestInlineFilePreviewClose('ws-1');
      const preview = useFileViewerStore.getState().inlineFilePreviewByWorkspace['ws-1'];
      expect(preview?.open).toBe(false);
      expect(
        useFileViewerStore.getState().inlineFilePreviewPendingCloseByWorkspace['ws-1']
      ).toBeFalsy();
    });

    it('stages a pending close when preview is dirty', () => {
      useFileViewerStore.getState().openInlineFilePreview('ws-1', 'browse', '/path/a.ts');
      useFileViewerStore.getState().setInlineFilePreviewDirty('ws-1', true);
      useFileViewerStore.getState().requestInlineFilePreviewClose('ws-1');
      // preview stays open — panel will surface the dialog
      const preview = useFileViewerStore.getState().inlineFilePreviewByWorkspace['ws-1'];
      expect(preview?.open).toBe(true);
      expect(preview?.filePath).toBe('/path/a.ts');
      expect(useFileViewerStore.getState().inlineFilePreviewPendingCloseByWorkspace['ws-1']).toBe(
        true
      );
    });

    it('is a no-op when preview is not open', () => {
      useFileViewerStore.getState().requestInlineFilePreviewClose('ws-1');
      expect(
        useFileViewerStore.getState().inlineFilePreviewPendingCloseByWorkspace['ws-1']
      ).toBeFalsy();
    });

    it('clearInlineFilePreviewPendingClose drops a staged request', () => {
      useFileViewerStore.getState().openInlineFilePreview('ws-1', 'browse', '/path/a.ts');
      useFileViewerStore.getState().setInlineFilePreviewDirty('ws-1', true);
      useFileViewerStore.getState().requestInlineFilePreviewClose('ws-1');
      useFileViewerStore.getState().clearInlineFilePreviewPendingClose('ws-1');
      expect(useFileViewerStore.getState().inlineFilePreviewPendingCloseByWorkspace['ws-1']).toBe(
        false
      );
    });

    it('closeInlineFilePreview clears any staged pending close', () => {
      useFileViewerStore.getState().openInlineFilePreview('ws-1', 'browse', '/path/a.ts');
      useFileViewerStore.getState().setInlineFilePreviewDirty('ws-1', true);
      useFileViewerStore.getState().requestInlineFilePreviewClose('ws-1');
      useFileViewerStore.getState().closeInlineFilePreview('ws-1');
      expect(useFileViewerStore.getState().inlineFilePreviewPendingCloseByWorkspace['ws-1']).toBe(
        false
      );
    });
  });

  describe('requestInlineFilePreviewModeChange', () => {
    it('applies tree+preview mode immediately when preview is closed', () => {
      useFileViewerStore.getState().requestInlineFilePreviewModeChange('ws-1', 'browse');
      expect(useFileViewerStore.getState().inlineFileTreeByWorkspace['ws-1']?.mode).toBe('browse');
      expect(useFileViewerStore.getState().inlineFilePreviewByWorkspace['ws-1']?.mode).toBe(
        'browse'
      );
      expect(
        useFileViewerStore.getState().inlineFilePreviewPendingModeChangeByWorkspace['ws-1']
      ).toBeFalsy();
    });

    it('applies immediately when preview is clean', () => {
      useFileViewerStore.getState().openInlineFilePreview('ws-1', 'diff', '/path/a.ts');
      useFileViewerStore.getState().setInlineFilePreviewDirty('ws-1', false);
      useFileViewerStore.getState().requestInlineFilePreviewModeChange('ws-1', 'browse');
      expect(useFileViewerStore.getState().inlineFileTreeByWorkspace['ws-1']?.mode).toBe('browse');
      expect(useFileViewerStore.getState().inlineFilePreviewByWorkspace['ws-1']?.mode).toBe(
        'browse'
      );
      expect(
        useFileViewerStore.getState().inlineFilePreviewPendingModeChangeByWorkspace['ws-1']
      ).toBeFalsy();
    });

    it('stages a pending change when dirty and mode would change', () => {
      useFileViewerStore.getState().openInlineFilePreview('ws-1', 'diff', '/path/a.ts');
      useFileViewerStore.getState().setInlineFilePreviewDirty('ws-1', true);
      useFileViewerStore.getState().requestInlineFilePreviewModeChange('ws-1', 'browse');
      // Mode stays at 'diff' — no silent reload
      expect(useFileViewerStore.getState().inlineFilePreviewByWorkspace['ws-1']?.mode).toBe('diff');
      expect(
        useFileViewerStore.getState().inlineFilePreviewPendingModeChangeByWorkspace['ws-1']
      ).toBe('browse');
    });

    it('applies immediately when dirty but already in target mode', () => {
      useFileViewerStore.getState().openInlineFilePreview('ws-1', 'browse', '/path/a.ts');
      useFileViewerStore.getState().setInlineFilePreviewDirty('ws-1', true);
      useFileViewerStore.getState().requestInlineFilePreviewModeChange('ws-1', 'browse');
      expect(
        useFileViewerStore.getState().inlineFilePreviewPendingModeChangeByWorkspace['ws-1']
      ).toBeFalsy();
    });

    it('clearInlineFilePreviewPendingModeChange drops a staged request', () => {
      useFileViewerStore.getState().openInlineFilePreview('ws-1', 'diff', '/path/a.ts');
      useFileViewerStore.getState().setInlineFilePreviewDirty('ws-1', true);
      useFileViewerStore.getState().requestInlineFilePreviewModeChange('ws-1', 'browse');
      useFileViewerStore.getState().clearInlineFilePreviewPendingModeChange('ws-1');
      expect(
        useFileViewerStore.getState().inlineFilePreviewPendingModeChangeByWorkspace['ws-1']
      ).toBeNull();
    });

    it('closeInlineFilePreview clears any staged mode change', () => {
      useFileViewerStore.getState().openInlineFilePreview('ws-1', 'diff', '/path/a.ts');
      useFileViewerStore.getState().setInlineFilePreviewDirty('ws-1', true);
      useFileViewerStore.getState().requestInlineFilePreviewModeChange('ws-1', 'browse');
      useFileViewerStore.getState().closeInlineFilePreview('ws-1');
      expect(
        useFileViewerStore.getState().inlineFilePreviewPendingModeChangeByWorkspace['ws-1']
      ).toBeNull();
    });
  });

  describe('inline-preview pending discard slot mutual exclusion', () => {
    it('requestInlineFilePreviewNav clears any prior pending close/mode-change', () => {
      const store = useFileViewerStore.getState();
      store.openInlineFilePreview('ws-1', 'browse', '/path/a.ts');
      store.setInlineFilePreviewDirty('ws-1', true);
      store.requestInlineFilePreviewClose('ws-1');
      store.requestInlineFilePreviewModeChange('ws-1', 'diff');
      // Now stage a nav — should win and drop the other two
      store.requestInlineFilePreviewNav('ws-1', 'browse', '/path/b.ts');
      const s = useFileViewerStore.getState();
      expect(s.inlineFilePreviewPendingNavByWorkspace['ws-1']).toEqual({
        mode: 'browse',
        filePath: '/path/b.ts',
        lineNumber: undefined,
      });
      expect(s.inlineFilePreviewPendingCloseByWorkspace['ws-1']).toBe(false);
      expect(s.inlineFilePreviewPendingModeChangeByWorkspace['ws-1']).toBeNull();
    });

    it('requestInlineFilePreviewClose clears any prior pending nav/mode-change', () => {
      const store = useFileViewerStore.getState();
      store.openInlineFilePreview('ws-1', 'browse', '/path/a.ts');
      store.setInlineFilePreviewDirty('ws-1', true);
      store.requestInlineFilePreviewNav('ws-1', 'browse', '/path/b.ts');
      store.requestInlineFilePreviewModeChange('ws-1', 'diff');
      store.requestInlineFilePreviewClose('ws-1');
      const s = useFileViewerStore.getState();
      expect(s.inlineFilePreviewPendingCloseByWorkspace['ws-1']).toBe(true);
      expect(s.inlineFilePreviewPendingNavByWorkspace['ws-1']).toBeNull();
      expect(s.inlineFilePreviewPendingModeChangeByWorkspace['ws-1']).toBeNull();
    });

    it('requestInlineFilePreviewModeChange clears any prior pending nav/close', () => {
      const store = useFileViewerStore.getState();
      store.openInlineFilePreview('ws-1', 'browse', '/path/a.ts');
      store.setInlineFilePreviewDirty('ws-1', true);
      store.requestInlineFilePreviewNav('ws-1', 'browse', '/path/b.ts');
      store.requestInlineFilePreviewClose('ws-1');
      store.requestInlineFilePreviewModeChange('ws-1', 'diff');
      const s = useFileViewerStore.getState();
      expect(s.inlineFilePreviewPendingModeChangeByWorkspace['ws-1']).toBe('diff');
      expect(s.inlineFilePreviewPendingNavByWorkspace['ws-1']).toBeNull();
      expect(s.inlineFilePreviewPendingCloseByWorkspace['ws-1']).toBe(false);
    });

    it('mutual-exclusion clears do not affect other workspaces', () => {
      const store = useFileViewerStore.getState();
      store.openInlineFilePreview('ws-1', 'browse', '/path/a.ts');
      store.setInlineFilePreviewDirty('ws-1', true);
      store.openInlineFilePreview('ws-2', 'browse', '/path/x.ts');
      store.setInlineFilePreviewDirty('ws-2', true);
      store.requestInlineFilePreviewClose('ws-2');
      // Staging on ws-1 must not clear ws-2's pending close
      store.requestInlineFilePreviewNav('ws-1', 'browse', '/path/b.ts');
      const s = useFileViewerStore.getState();
      expect(s.inlineFilePreviewPendingCloseByWorkspace['ws-2']).toBe(true);
      expect(s.inlineFilePreviewPendingNavByWorkspace['ws-1']).toEqual({
        mode: 'browse',
        filePath: '/path/b.ts',
        lineNumber: undefined,
      });
    });

    it('clearAllInlineFilePreviewPendingDiscardSlots wipes all three slots for one workspace', () => {
      const store = useFileViewerStore.getState();
      // Force all three slots populated using direct set to bypass mutual
      // exclusion (simulates the pre-fix race condition state).
      useFileViewerStore.setState({
        inlineFilePreviewPendingNavByWorkspace: {
          'ws-1': { mode: 'browse', filePath: '/path/b.ts' },
          'ws-2': { mode: 'browse', filePath: '/path/y.ts' },
        },
        inlineFilePreviewPendingCloseByWorkspace: { 'ws-1': true, 'ws-2': true },
        inlineFilePreviewPendingModeChangeByWorkspace: {
          'ws-1': 'diff',
          'ws-2': 'diff',
        },
      });
      store.clearAllInlineFilePreviewPendingDiscardSlots('ws-1');
      const s = useFileViewerStore.getState();
      expect(s.inlineFilePreviewPendingNavByWorkspace['ws-1']).toBeNull();
      expect(s.inlineFilePreviewPendingCloseByWorkspace['ws-1']).toBe(false);
      expect(s.inlineFilePreviewPendingModeChangeByWorkspace['ws-1']).toBeNull();
      // ws-2 untouched
      expect(s.inlineFilePreviewPendingNavByWorkspace['ws-2']).toEqual({
        mode: 'browse',
        filePath: '/path/y.ts',
      });
      expect(s.inlineFilePreviewPendingCloseByWorkspace['ws-2']).toBe(true);
      expect(s.inlineFilePreviewPendingModeChangeByWorkspace['ws-2']).toBe('diff');
    });
  });

  it('setInlineFilePreviewMode preserves open file across mode change', () => {
    useFileViewerStore.getState().openInlineFilePreview('ws-1', 'diff', '/path/file.ts');
    useFileViewerStore.getState().setInlineFilePreviewMode('ws-1', 'browse');
    const preview = useFileViewerStore.getState().inlineFilePreviewByWorkspace['ws-1'];
    expect(preview?.open).toBe(true);
    expect(preview?.filePath).toBe('/path/file.ts');
    expect(preview?.mode).toBe('browse');
  });

  it('setInlineFilePreviewLayout changes layout', () => {
    useFileViewerStore.getState().setInlineFilePreviewLayout('ws-1', 'side-by-side');
    expect(useFileViewerStore.getState().inlineFilePreviewByWorkspace['ws-1']?.layout).toBe(
      'side-by-side'
    );
  });

  it('setInlineFilePreviewWidth clamps value', () => {
    useFileViewerStore.getState().setInlineFilePreviewWidth('ws-1', 0.5);
    expect(useFileViewerStore.getState().inlineFilePreviewWidthByWorkspace['ws-1']).toBe(0.5);

    useFileViewerStore.getState().setInlineFilePreviewWidth('ws-1', -1);
    expect(useFileViewerStore.getState().inlineFilePreviewWidthByWorkspace['ws-1']).toBe(0.05);

    useFileViewerStore.getState().setInlineFilePreviewWidth('ws-1', 2);
    expect(useFileViewerStore.getState().inlineFilePreviewWidthByWorkspace['ws-1']).toBe(0.95);
  });

  // Live follow
  it('setLiveFollow sets follow state', () => {
    useFileViewerStore.getState().setLiveFollow('ws-1', true);
    expect(useFileViewerStore.getState().liveFollowByWorkspace['ws-1']).toBe(true);
  });

  it('toggleLiveFollow toggles follow state', () => {
    useFileViewerStore.getState().toggleLiveFollow('ws-1');
    expect(useFileViewerStore.getState().liveFollowByWorkspace['ws-1']).toBe(true);
    useFileViewerStore.getState().toggleLiveFollow('ws-1');
    expect(useFileViewerStore.getState().liveFollowByWorkspace['ws-1']).toBe(false);
  });

  it('browse tabs support preview, activation, close requests, and persistent promotion', () => {
    const store = useFileViewerStore.getState();

    store.setPreviewTab('ws-1', '/tmp/preview.ts');
    expect(store.getPreviewTab('ws-1')).toBe('/tmp/preview.ts');

    store.openTab('ws-1', '/tmp/persisted.ts');
    expect(store.getTabs('ws-1')).toEqual(['/tmp/persisted.ts']);
    expect(store.getActiveTab('ws-1')).toBe('/tmp/persisted.ts');
    expect(store.getPreviewTab('ws-1')).toBe('/tmp/preview.ts');

    store.openTab('ws-1', '/tmp/preview.ts');
    expect(store.getTabs('ws-1')).toEqual(['/tmp/persisted.ts', '/tmp/preview.ts']);
    expect(store.getActiveTab('ws-1')).toBe('/tmp/preview.ts');
    expect(store.getPreviewTab('ws-1')).toBeNull();

    const before = useFileViewerStore.getState().closeTabRequest;
    store.requestCloseTab();
    expect(useFileViewerStore.getState().closeTabRequest).toBe(before + 1);

    const viewerBefore = useFileViewerStore.getState().closeViewerRequest;
    store.requestCloseViewer();
    expect(useFileViewerStore.getState().closeViewerRequest).toBe(viewerBefore + 1);

    store.closeTab('ws-1', '/tmp/preview.ts');
    expect(store.getTabs('ws-1')).toEqual(['/tmp/persisted.ts']);
    expect(store.getActiveTab('ws-1')).toBe('/tmp/persisted.ts');
  });

  it('removes every persistent and preview tab beneath a deleted path', () => {
    const store = useFileViewerStore.getState();
    store.openTab('ws-1', 'src/keep.ts');
    store.openTab('ws-1', 'generated/a.ts');
    store.openTab('ws-1', 'generated/b.ts');
    store.setPreviewTab('ws-1', 'generated/preview.ts');
    store.openInlineFilePreview('ws-1', 'browse', 'generated/inline.ts');

    expect(store.removeDeletedPathFromViewers('ws-1', 'generated')).toBe('src/keep.ts');
    expect(store.getTabs('ws-1')).toEqual(['src/keep.ts']);
    expect(store.getActiveTab('ws-1')).toBe('src/keep.ts');
    expect(store.getPreviewTab('ws-1')).toBeNull();
    expect(useFileViewerStore.getState().inlineFilePreviewByWorkspace['ws-1']).toMatchObject({
      open: false,
      filePath: null,
    });
  });

  it('keeps an inline preview outside the deleted path open', () => {
    const store = useFileViewerStore.getState();
    store.openInlineFilePreview('ws-1', 'browse', 'src/keep.ts');

    store.removeDeletedPathFromViewers('ws-1', 'generated');

    expect(useFileViewerStore.getState().inlineFilePreviewByWorkspace['ws-1']).toMatchObject({
      open: true,
      filePath: 'src/keep.ts',
    });
  });

  it('moves every tab and the inline preview beneath a moved path along with it', () => {
    const store = useFileViewerStore.getState();
    store.openTab('ws-1', 'src/keep.ts');
    store.openTab('ws-1', 'src/foo/a.ts');
    store.setPreviewTab('ws-1', 'src/foo/preview.ts');
    store.openInlineFilePreview('ws-1', 'browse', 'src/foo/inline.ts');

    store.renamePathInViewers('ws-1', { from: 'src/foo', to: 'lib/foo' });

    expect(store.getTabs('ws-1')).toEqual(['src/keep.ts', 'lib/foo/a.ts']);
    expect(store.getActiveTab('ws-1')).toBe('lib/foo/preview.ts');
    expect(store.getPreviewTab('ws-1')).toBe('lib/foo/preview.ts');
    expect(useFileViewerStore.getState().inlineFilePreviewByWorkspace['ws-1']).toMatchObject({
      open: true,
      filePath: 'lib/foo/inline.ts',
    });
  });

  it('getTabs returns the same empty array for a workspace without tabs', () => {
    const store = useFileViewerStore.getState();

    // Selectors call getTabs on every store change; a fresh [] would make
    // zustand 5 re-render forever.
    expect(store.getTabs('ws-none')).toBe(store.getTabs('ws-none'));
  });

  // Locks in the contract FileViewerDialog.handleFileSelect relies on when
  // a re-click on the already-previewed file promotes it to persistent.
  it('openTab with preview=false on the current preview path promotes and clears preview', () => {
    const store = useFileViewerStore.getState();

    store.setPreviewTab('ws-1', '/tmp/a.ts');
    expect(store.getPreviewTab('ws-1')).toBe('/tmp/a.ts');
    expect(store.getTabs('ws-1')).toEqual([]);

    store.openTab('ws-1', '/tmp/a.ts', false);

    expect(store.getTabs('ws-1')).toEqual(['/tmp/a.ts']);
    expect(store.getActiveTab('ws-1')).toBe('/tmp/a.ts');
    expect(store.getPreviewTab('ws-1')).toBeNull();
  });

  // Cleanup
  it('clearWorkspaceFileViewerState removes all workspace-specific state', () => {
    useFileViewerStore.getState().setInlineFileTreeOpen('ws-1', true);
    useFileViewerStore.getState().setFileViewerDiffComparisonBranch('ws-1', 'feature-x');
    useFileViewerStore.getState().setInlineFileTreeWidth('ws-1', 0.3);
    useFileViewerStore.getState().openInlineFilePreview('ws-1', 'browse', '/file');
    useFileViewerStore.getState().setInlineFilePreviewWidth('ws-1', 0.4);
    useFileViewerStore.getState().setLiveFollow('ws-1', true);
    useFileViewerStore.getState().openFileViewer('ws-1', 'diff');
    useFileViewerStore.getState().saveDiffSelections('ws-1', {
      selectedFile: 'src/a.ts',
      selectedCommitHash: 'abc123',
      historySelectedFile: 'src/a.ts',
      historyBranch: 'feature/test',
      historyFilterPath: 'src/a.ts',
    });
    useFileViewerStore.getState().setDiffSubMode('history');
    useFileViewerStore.getState().closeFileViewer();
    useFileViewerStore.getState().openTab('ws-1', '/file');
    useFileViewerStore.getState().setPreviewTab('ws-1', '/preview');

    useFileViewerStore.getState().clearWorkspaceFileViewerState('ws-1');

    const state = useFileViewerStore.getState();
    expect(state.inlineFileTreeByWorkspace['ws-1']).toBeUndefined();
    expect(state.fileViewerDiffComparisonByWorkspace['ws-1']).toBeUndefined();
    expect(state.inlineFileTreeWidthByWorkspace['ws-1']).toBeUndefined();
    expect(state.inlineFilePreviewByWorkspace['ws-1']).toBeUndefined();
    expect(state.inlineFilePreviewWidthByWorkspace['ws-1']).toBeUndefined();
    expect(state.liveFollowByWorkspace['ws-1']).toBeUndefined();
    expect(state.getDiffSubMode('ws-1')).toBe('changes');
    expect(state.getDiffSelections('ws-1')).toEqual({
      selectedFile: null,
      selectedCommitHash: null,
      historySelectedFile: null,
      historyBranch: null,
      historyFilterPath: null,
    });
    expect(state.getTabs('ws-1')).toEqual([]);
    expect(state.getActiveTab('ws-1')).toBeNull();
    expect(state.getPreviewTab('ws-1')).toBeNull();
  });

  it('clearWorkspaceFileViewerState preserves other workspaces', () => {
    useFileViewerStore.getState().setLiveFollow('ws-1', true);
    useFileViewerStore.getState().setLiveFollow('ws-2', true);
    useFileViewerStore.getState().clearWorkspaceFileViewerState('ws-1');
    expect(useFileViewerStore.getState().liveFollowByWorkspace['ws-2']).toBe(true);
  });

  it('clearWorkspaceFileViewerState clears inline pending nav/close/mode-change maps', () => {
    // Stage one of each kind of pending inline action.
    useFileViewerStore.getState().openInlineFilePreview('ws-1', 'browse', '/path/a.ts');
    useFileViewerStore.getState().setInlineFilePreviewDirty('ws-1', true);
    useFileViewerStore.getState().requestInlineFilePreviewNav('ws-1', 'browse', '/path/b.ts');
    useFileViewerStore.getState().requestInlineFilePreviewClose('ws-1');
    useFileViewerStore.getState().requestInlineFilePreviewModeChange('ws-1', 'diff');

    useFileViewerStore.getState().clearWorkspaceFileViewerState('ws-1');

    const state = useFileViewerStore.getState();
    expect(state.inlineFilePreviewPendingNavByWorkspace['ws-1']).toBeUndefined();
    expect(state.inlineFilePreviewPendingCloseByWorkspace['ws-1']).toBeUndefined();
    expect(state.inlineFilePreviewPendingModeChangeByWorkspace['ws-1']).toBeUndefined();
  });

  it('clearWorkspaceFileViewerState clears a matching pending transition', () => {
    useFileViewerStore.getState().openFileViewer('ws-1', 'browse');
    useFileViewerStore.getState().requestFileViewerTransition({
      kind: 'mode',
      workspaceId: 'ws-1',
      mode: 'diff',
    });
    useFileViewerStore.getState().clearWorkspaceFileViewerState('ws-1');
    expect(useFileViewerStore.getState().pendingFileViewerTransition).toBeNull();
  });

  describe('requestFileViewerTransition', () => {
    it('opens a closed viewer immediately', () => {
      useFileViewerStore.getState().requestFileViewerTransition({
        kind: 'toggle',
        workspaceId: 'ws-1',
        mode: 'diff',
      });
      expect(useFileViewerStore.getState().fileViewerWorkspaceId).toBe('ws-1');
      expect(useFileViewerStore.getState().fileViewerMode).toBe('diff');
      expect(useFileViewerStore.getState().pendingFileViewerTransition).toBeNull();
    });

    it('opens a closed viewer on History and keeps the commit to select for it', () => {
      const request = {
        kind: 'mode',
        workspaceId: 'ws-1',
        mode: 'diff',
        diffSubMode: 'history',
        after: { kind: 'commit', commitHash: 'abc123' },
      } as const;
      useFileViewerStore.getState().requestFileViewerTransition(request);
      const state = useFileViewerStore.getState();
      expect(state.fileViewerWorkspaceId).toBe('ws-1');
      expect(state.fileViewerDiffSubMode).toBe('history');
      expect(state.pendingFileViewerTransition).toEqual(request);
    });

    it('turns a repeated toggle into one close intent', () => {
      const store = useFileViewerStore.getState();
      store.openFileViewer('ws-1', 'diff');
      store.requestFileViewerTransition({ kind: 'toggle', workspaceId: 'ws-1', mode: 'diff' });
      expect(useFileViewerStore.getState().pendingFileViewerTransition).toEqual({
        kind: 'close',
        workspaceId: 'ws-1',
      });
    });

    it('keeps only the latest intent', () => {
      const store = useFileViewerStore.getState();
      store.openFileViewer('ws-1', 'browse');
      store.requestFileViewerTransition({ kind: 'mode', workspaceId: 'ws-1', mode: 'diff' });
      store.requestFileViewerTransition({
        kind: 'file',
        workspaceId: 'ws-1',
        filePath: '/path/a.ts',
        browseAction: 'preview',
      });
      expect(useFileViewerStore.getState().pendingFileViewerTransition).toMatchObject({
        kind: 'file',
        filePath: '/path/a.ts',
      });
    });

    it('opens an inline preview directly when no matching viewer is mounted', () => {
      useFileViewerStore.getState().requestFileViewerTransition({
        kind: 'inline-preview',
        workspaceId: 'ws-1',
        filePath: '/path/a.ts',
        lineNumber: 5,
      });
      expect(useFileViewerStore.getState().inlineFilePreviewByWorkspace['ws-1']).toMatchObject({
        open: true,
        filePath: '/path/a.ts',
        lineNumber: 5,
      });
    });
  });
});

describe('diff view mode preference', () => {
  function stubLocalStorage(initial: Record<string, string> = {}) {
    const values = new Map(Object.entries(initial));
    const storage = {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        values.set(key, value);
      }),
    };
    (globalThis as any).window = { ...globalThis.window, localStorage: storage };
    return storage;
  }

  it('defaults to split and remembers the chosen mode', () => {
    const storage = stubLocalStorage();
    resetStore();
    expect(useFileViewerStore.getState().diffViewMode).toBe('split');

    useFileViewerStore.getState().setDiffViewMode('unified');

    expect(useFileViewerStore.getState().diffViewMode).toBe('unified');
    expect(storage.setItem).toHaveBeenCalledWith('komla.diffViewMode', 'unified');
  });

  it('restores the remembered mode when the app starts', async () => {
    stubLocalStorage({ 'komla.diffViewMode': 'unified' });
    vi.resetModules();

    const { useFileViewerStore: freshStore } =
      await import('../../../src/renderer/stores/file-viewer.store');

    expect(freshStore.getState().diffViewMode).toBe('unified');
  });

  it('falls back to split when storage is unavailable', async () => {
    (globalThis as any).window = {
      ...globalThis.window,
      get localStorage(): Storage {
        throw new Error('blocked');
      },
    };
    vi.resetModules();

    const { useFileViewerStore: freshStore } =
      await import('../../../src/renderer/stores/file-viewer.store');

    expect(freshStore.getState().diffViewMode).toBe('split');
    expect(() => freshStore.getState().setDiffViewMode('unified')).not.toThrow();
    expect(freshStore.getState().diffViewMode).toBe('unified');
  });
});
