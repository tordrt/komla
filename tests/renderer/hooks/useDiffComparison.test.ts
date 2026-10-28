// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  getDiffComparison,
  useDiffComparison,
} from '../../../src/renderer/hooks/useDiffComparison';
import { useFileViewerStore } from '../../../src/renderer/stores/file-viewer.store';
import { useWorkspacesStore } from '../../../src/renderer/stores/workspaces.store';
import type { Workspace } from '../../../src/shared/types';

describe('useDiffComparison', () => {
  beforeEach(() => {
    useFileViewerStore.setState(useFileViewerStore.getInitialState(), true);
    useWorkspacesStore.setState({ workspaces: [] });
  });

  it('compares against the working tree until a branch is chosen', () => {
    const { result } = renderHook(() => useDiffComparison('ws-1', 'inline'));

    expect(result.current).toEqual({ comparisonBranch: null, useMergeBase: false });
  });

  it('keeps the inline and full-screen comparisons apart', () => {
    const inline = renderHook(() => useDiffComparison('ws-1', 'inline'));
    const fileViewer = renderHook(() => useDiffComparison('ws-1', 'file-viewer'));

    act(() => {
      useFileViewerStore.getState().setInlineFileTreeComparisonBranch('ws-1', 'main', true);
      useFileViewerStore.getState().setFileViewerDiffComparisonBranch('ws-1', 'develop', false);
    });

    expect(inline.result.current).toEqual({ comparisonBranch: 'main', useMergeBase: true });
    expect(fileViewer.result.current).toEqual({
      comparisonBranch: 'develop',
      useMergeBase: false,
    });
  });

  it('has no comparison without a workspace', () => {
    act(() => {
      useFileViewerStore.getState().setInlineFileTreeComparisonBranch('ws-1', 'main', true);
    });

    const { result } = renderHook(() => useDiffComparison(null, 'inline'));

    expect(result.current).toEqual({ comparisonBranch: null, useMergeBase: false });
  });

  describe('since the target branch', () => {
    function setTarget(baseBranch: string | undefined) {
      useWorkspacesStore.setState({
        workspaces: [{ id: 'ws-1', baseBranch } as Workspace],
      });
    }

    it('follows the workspace to a new target branch', () => {
      setTarget('main');
      act(() => {
        useFileViewerStore.getState().setInlineFileTreeComparisonBranch('ws-1', 'main', true);
      });
      const { result } = renderHook(() => useDiffComparison('ws-1', 'inline'));

      act(() => setTarget('develop'));

      expect(result.current).toEqual({ comparisonBranch: 'develop', useMergeBase: true });
      expect(getDiffComparison('ws-1', 'inline')).toEqual(result.current);
    });

    it('follows in the full-screen scope too', () => {
      setTarget('develop');
      act(() => {
        useFileViewerStore.getState().setFileViewerDiffComparisonBranch('ws-1', 'main', true);
      });

      const { result } = renderHook(() => useDiffComparison('ws-1', 'file-viewer'));

      expect(result.current).toEqual({ comparisonBranch: 'develop', useMergeBase: true });
    });

    it('leaves an explicit branch comparison alone', () => {
      setTarget('develop');
      act(() => {
        useFileViewerStore.getState().setInlineFileTreeComparisonBranch('ws-1', 'release', false);
      });

      const { result } = renderHook(() => useDiffComparison('ws-1', 'inline'));

      expect(result.current).toEqual({ comparisonBranch: 'release', useMergeBase: false });
    });

    it('keeps the stored branch until a target resolves', () => {
      setTarget(undefined);
      act(() => {
        useFileViewerStore.getState().setInlineFileTreeComparisonBranch('ws-1', 'trunk', true);
      });

      const { result } = renderHook(() => useDiffComparison('ws-1', 'inline'));

      expect(result.current).toEqual({ comparisonBranch: 'trunk', useMergeBase: true });
    });
  });
});
