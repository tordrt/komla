/**
 * @vitest-environment jsdom
 */
import { FileTree } from '@pierre/trees';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useFileTreeFocusGuard } from '../../../../../src/renderer/components/workspaces/file-viewer/useFileTreeFocusGuard';

/**
 * Tests for the diff file tree auto-focus suppression in
 *   src/renderer/components/workspaces/file-viewer/useFileTreeFocusGuard.ts
 *
 * The bug: opening the diff file tree auto-focused a row, and the focus-
 * watching effect read that auto-focus as a keyboard nav and called
 * onFileSelect, opening a preview the user didn't ask for.
 *
 * The hook syncs `lastOpenedRef` to pierre's auto-focused path at three
 * sites — mount-time init, post-resetPaths, and the currentFile-sync
 * effect — so the focus effect's first guard
 * (`focusedPath === lastOpenedRef.current`) catches the auto-focus and
 * skips firing onFileSelect. The pierre characterization tests below
 * lock in the third-party behavior the fix relies on; the integration
 * tests drive the actual hook with a real pierre model and assert
 * onFileSelect call patterns.
 */

function makeTree(paths: readonly string[]): FileTree {
  return new FileTree({
    paths,
    flattenEmptyDirectories: true,
  });
}

describe('@pierre/trees auto-focus behavior (load-bearing for the focus guard)', () => {
  it('auto-focuses the first file on construction when no initial selection is provided', () => {
    const tree = makeTree(['a.ts', 'b.ts', 'c.ts']);

    expect(tree.getFocusedPath()).toBe('a.ts');

    tree.cleanUp();
  });

  it('keeps focus on the previously focused path after resetPaths if it still exists', () => {
    const tree = makeTree(['a.ts', 'b.ts']);
    tree.focusPath('b.ts');
    expect(tree.getFocusedPath()).toBe('b.ts');

    tree.resetPaths(['a.ts', 'b.ts', 'c.ts']);

    expect(tree.getFocusedPath()).toBe('b.ts');

    tree.cleanUp();
  });

  it('snaps focus to the first row after resetPaths when the previously focused path is removed', () => {
    const tree = makeTree(['a.ts', 'b.ts', 'c.ts']);
    tree.focusPath('b.ts');
    expect(tree.getFocusedPath()).toBe('b.ts');

    tree.resetPaths(['a.ts', 'c.ts']);

    expect(tree.getFocusedPath()).toBe('a.ts');

    tree.cleanUp();
  });

  it('exposes the post-reset focused path synchronously from getFocusedPath()', () => {
    // The hook reads model.getFocusedPath() immediately after
    // model.resetPaths(paths) inside an effect, before React commits the
    // new focusedPath state from useFileTreeSelector. This timing
    // assumption is what lets the hook sync lastOpenedRef before the
    // focus effect runs on the next render.
    const tree = makeTree(['a.ts', 'b.ts']);
    tree.focusPath('b.ts');

    tree.resetPaths(['x.ts', 'y.ts']);
    const observedFocus = tree.getFocusedPath();

    expect(observedFocus).toBe('x.ts');

    tree.cleanUp();
  });
});

describe('useFileTreeFocusGuard', () => {
  it('does not call onFileSelect on mount when currentFile is null and pierre auto-focuses the first row', () => {
    // The mount-time half of the original bug. Pierre's constructor
    // lands focus on index 0; without the lastOpenedRef init fix, the
    // focus effect would fire onFileSelect on that auto-focus and open
    // a preview the user didn't ask for.
    const paths = ['a.ts', 'b.ts', 'c.ts'];
    const tree = makeTree(paths);
    const onFileSelect = vi.fn();

    renderHook(() =>
      useFileTreeFocusGuard({
        model: tree,
        currentFile: null,
        paths,
        onFileSelect,
      })
    );

    expect(onFileSelect).not.toHaveBeenCalled();
    expect(tree.getFocusedPath()).toBe('a.ts');

    tree.cleanUp();
  });

  it('does not call onFileSelect when paths change and pierre snaps focus to a different file', () => {
    // The post-resetPaths half of the bug. After the diff updates and
    // the previously focused file is no longer in the new path set,
    // pierre falls back to index 0. Without the post-resetPaths sync of
    // lastOpenedRef the focus effect would fire onFileSelect on the
    // snap target.
    const tree = makeTree(['a.ts', 'b.ts', 'c.ts']);
    tree.focusPath('b.ts');
    const onFileSelect = vi.fn();

    const { rerender } = renderHook(
      ({ paths }: { paths: readonly string[] }) =>
        useFileTreeFocusGuard({
          model: tree,
          currentFile: 'b.ts',
          paths,
          onFileSelect,
        }),
      { initialProps: { paths: ['a.ts', 'b.ts', 'c.ts'] as readonly string[] } }
    );

    // b.ts is removed from the diff. Pierre snaps focus to a.ts (index 0).
    act(() => {
      rerender({ paths: ['a.ts', 'c.ts'] });
    });

    expect(tree.getFocusedPath()).toBe('a.ts');
    expect(onFileSelect).not.toHaveBeenCalled();

    tree.cleanUp();
  });

  it('does not call onFileSelect when currentFile flips to null while pierre still has a row focused', () => {
    // The preview-closed case. Pierre keeps focus on the previously
    // open file even after currentFile flips to null (its DOM focusout
    // is the only way it loses focus, and that doesn't always fire).
    // Without the currentFile-null fallback in the sync effect,
    // lastOpenedRef would be set to null and the focus effect could
    // re-fire onFileSelect on pierre's stale focus.
    const paths = ['a.ts', 'b.ts'];
    const tree = makeTree(paths);
    tree.focusPath('a.ts');
    const onFileSelect = vi.fn();

    const { rerender } = renderHook(
      ({ currentFile }: { currentFile: string | null }) =>
        useFileTreeFocusGuard({
          model: tree,
          currentFile,
          paths,
          onFileSelect,
        }),
      { initialProps: { currentFile: 'a.ts' as string | null } }
    );

    act(() => {
      rerender({ currentFile: null });
    });

    expect(tree.getFocusedPath()).toBe('a.ts');
    expect(onFileSelect).not.toHaveBeenCalled();

    tree.cleanUp();
  });

  it('calls onFileSelect when the user moves focus to a different file (keyboard nav)', () => {
    // The negative case. Suppression must not swallow real user
    // navigation: after pierre auto-focuses at mount, an arrow-key
    // move to a different row should fire onFileSelect.
    const paths = ['a.ts', 'b.ts', 'c.ts'];
    const tree = makeTree(paths);
    const onFileSelect = vi.fn();

    renderHook(() =>
      useFileTreeFocusGuard({
        model: tree,
        currentFile: null,
        paths,
        onFileSelect,
      })
    );

    // Mount auto-focus is suppressed.
    expect(onFileSelect).not.toHaveBeenCalled();

    // Simulated arrow-key nav: pierre's focus moves to a different file.
    act(() => {
      tree.focusPath('c.ts');
    });

    expect(onFileSelect).toHaveBeenCalledTimes(1);
    expect(onFileSelect).toHaveBeenCalledWith('c.ts');

    tree.cleanUp();
  });

  it('does not call onFileSelect when focusOriginRef is set to mouse (click handler owns the preview)', () => {
    // Mouse clicks move pierre's focus on mousedown. The consumer's
    // capture-phase mousedown handler sets focusOriginRef='mouse' so
    // the focus effect stands down and the click handler routes the
    // preview itself (which lets drag gestures suppress the click).
    const paths = ['a.ts', 'b.ts'];
    const tree = makeTree(paths);
    const onFileSelect = vi.fn();

    const { result } = renderHook(() =>
      useFileTreeFocusGuard({
        model: tree,
        currentFile: null,
        paths,
        onFileSelect,
      })
    );

    act(() => {
      result.current.focusOriginRef.current = 'mouse';
      tree.focusPath('b.ts');
    });

    expect(onFileSelect).not.toHaveBeenCalled();
    expect(result.current.focusOriginRef.current).toBeNull();

    tree.cleanUp();
  });

  it('does not call onFileSelect when justDraggedRef is set (post-drag focus refresh)', () => {
    // After a drag moves a file, pierre re-focuses the moved row at
    // its new path. Without the drag flag the focus effect would read
    // that as a fresh keyboard-style focus change and open the preview.
    const paths = ['a.ts', 'b.ts'];
    const tree = makeTree(paths);
    const onFileSelect = vi.fn();

    const { result } = renderHook(() =>
      useFileTreeFocusGuard({
        model: tree,
        currentFile: null,
        paths,
        onFileSelect,
      })
    );

    act(() => {
      result.current.justDraggedRef.current = true;
      tree.focusPath('b.ts');
    });

    expect(onFileSelect).not.toHaveBeenCalled();
    expect(result.current.justDraggedRef.current).toBe(false);

    tree.cleanUp();
  });

  it('does not call onFileSelect while the search input is focused (search-driven focus refresh)', () => {
    // Search moves focus to the first match as the query narrows. The
    // searchInputFocusedRef gate suppresses auto-preview while the
    // user is typing — the user commits to a match explicitly via
    // click or Enter.
    const paths = ['a.ts', 'b.ts'];
    const tree = makeTree(paths);
    const onFileSelect = vi.fn();

    const { result } = renderHook(() =>
      useFileTreeFocusGuard({
        model: tree,
        currentFile: null,
        paths,
        onFileSelect,
      })
    );

    act(() => {
      result.current.searchInputFocusedRef.current = true;
      tree.focusPath('b.ts');
    });

    expect(onFileSelect).not.toHaveBeenCalled();

    tree.cleanUp();
  });

  it('preserves directory expansion across paths changes when a new file is added', () => {
    // Pierre's resetPaths rebuilds the path store keyed off
    // initialExpansion: 'closed', so without the expansion-preservation
    // step in the hook every paths change would collapse every folder.
    // The mode-expansion effect in the consumer only auto-expands
    // newly-appearing directories (by design — it preserves manual user
    // collapses), so existing folders would stay collapsed after the
    // reset. The hook captures pre-reset expansion and replays it via
    // initialExpandedPaths so the tree survives a paths change cleanly.
    const tree = makeTree(['src/a.ts', 'src/b.ts']);
    tree.getItem('src')?.expand();
    expect(tree.getItem('src')?.isExpanded()).toBe(true);

    const onFileSelect = vi.fn();
    const { rerender } = renderHook(
      ({ paths }: { paths: readonly string[] }) =>
        useFileTreeFocusGuard({
          model: tree,
          currentFile: null,
          paths,
          onFileSelect,
        }),
      { initialProps: { paths: ['src/a.ts', 'src/b.ts'] as readonly string[] } }
    );

    act(() => {
      rerender({ paths: ['src/a.ts', 'src/b.ts', 'src/c.ts'] });
    });

    expect(tree.getItem('src')?.isExpanded()).toBe(true);

    tree.cleanUp();
  });

  it('edits the tree in place for a small paths change instead of rebuilding it', () => {
    const tree = makeTree(['src/a.ts', 'src/b.ts']);
    const resetPaths = vi.spyOn(tree, 'resetPaths');
    const { rerender } = renderHook(
      ({ paths }: { paths: readonly string[] }) =>
        useFileTreeFocusGuard({ model: tree, currentFile: null, paths, onFileSelect: vi.fn() }),
      { initialProps: { paths: ['src/a.ts', 'src/b.ts'] as readonly string[] } }
    );

    act(() => {
      rerender({ paths: ['src/a.ts', 'src/c.ts'] });
    });

    expect(resetPaths).not.toHaveBeenCalled();
    expect(tree.getItem('src/c.ts')).not.toBeNull();
    expect(tree.getItem('src/b.ts')).toBeNull();

    tree.cleanUp();
  });

  it('rebuilds the tree when an edit does not fit it, as when a file becomes a folder', () => {
    const tree = makeTree(['a.ts', 'b.ts']);
    const { rerender } = renderHook(
      ({ paths }: { paths: readonly string[] }) =>
        useFileTreeFocusGuard({ model: tree, currentFile: null, paths, onFileSelect: vi.fn() }),
      { initialProps: { paths: ['a.ts', 'b.ts'] as readonly string[] } }
    );

    act(() => {
      rerender({ paths: ['a.ts/inner.ts', 'b.ts'] });
    });

    expect(tree.getItem('a.ts/inner.ts')).not.toBeNull();
    expect(tree.getItem('a.ts')?.isDirectory()).toBe(true);

    tree.cleanUp();
  });

  it('preserves user-collapsed directories across paths changes', () => {
    // Symmetric to the expansion test — directories the user (or some
    // other code path) explicitly collapsed must stay collapsed across
    // a paths change. The hook's expansion-preservation step replays
    // the *current* expansion bitmap; collapsed dirs simply don't end
    // up in initialExpandedPaths, so pierre's default-collapsed reset
    // leaves them collapsed and the mode-expansion effect's "skip
    // already-seen dirs" branch keeps them that way.
    const tree = makeTree(['src/a.ts', 'lib/x.ts']);
    tree.getItem('src')?.expand();
    tree.getItem('lib')?.expand();
    tree.getItem('lib')?.collapse();
    expect(tree.getItem('src')?.isExpanded()).toBe(true);
    expect(tree.getItem('lib')?.isExpanded()).toBe(false);

    const onFileSelect = vi.fn();
    const { rerender } = renderHook(
      ({ paths }: { paths: readonly string[] }) =>
        useFileTreeFocusGuard({
          model: tree,
          currentFile: null,
          paths,
          onFileSelect,
        }),
      { initialProps: { paths: ['src/a.ts', 'lib/x.ts'] as readonly string[] } }
    );

    act(() => {
      rerender({ paths: ['src/a.ts', 'src/b.ts', 'lib/x.ts'] });
    });

    expect(tree.getItem('src')?.isExpanded()).toBe(true);
    expect(tree.getItem('lib')?.isExpanded()).toBe(false);

    tree.cleanUp();
  });

  it('does not call onFileSelect when the focused row is a directory', () => {
    // The focus effect's last guard skips directories. In diff mode
    // SidebarFileTree feeds only files into pierre, but in browse mode
    // and when arrow-keying the cursor passes through directory rows.
    const paths = ['src/a.ts', 'src/b.ts'];
    const tree = makeTree(paths);
    tree.focusPath('src/');
    expect(tree.getItem('src/')?.isDirectory()).toBe(true);

    const onFileSelect = vi.fn();
    renderHook(() =>
      useFileTreeFocusGuard({
        model: tree,
        currentFile: null,
        paths,
        onFileSelect,
      })
    );

    // Simulated arrow-key onto a different directory or row would flow
    // through here; the directory-skip guard prevents preview opening.
    expect(onFileSelect).not.toHaveBeenCalled();

    tree.cleanUp();
  });
});
