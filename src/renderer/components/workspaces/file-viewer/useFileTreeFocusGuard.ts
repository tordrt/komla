import { useFileTreeSelector } from '@pierre/trees/react';
import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';

import { planFileTreePathUpdate } from './file-tree-path-update';
import { getAncestorPaths } from './file-viewer-utils';

import type { FileTree } from '@pierre/trees';

interface UseFileTreeFocusGuardOptions {
  model: FileTree;
  currentFile: string | null;
  paths: readonly string[];
  onFileSelect: (path: string) => void;
}

interface UseFileTreeFocusGuardResult {
  searchInputFocusedRef: MutableRefObject<boolean>;
  focusOriginRef: MutableRefObject<'mouse' | null>;
  justDraggedRef: MutableRefObject<boolean>;
  lastOpenedRef: MutableRefObject<string | null>;
  /** Rebuilds the tree from the current paths, undoing a move pierre showed but disk refused. */
  resyncPaths: () => void;
}

/**
 * Wires up focus-driven preview opening for a @pierre/trees model and
 * suppresses the auto-preview bug class.
 *
 * Pierre's controller lands focus on the first visible row in its
 * constructor, and removing the focused path (by `resetPaths` or a
 * batch) moves focus to another row. Without suppression, those
 * self-initiated focus moves would be observed by the focus-watching
 * effect and routed to onFileSelect, opening a preview the user didn't
 * ask for. The fix syncs `lastOpenedRef` to pierre's focused path at
 * three sites — mount-time init, after a paths update, and
 * currentFile-null sync — so the focus effect's first guard
 * short-circuits the auto-focus.
 *
 * The hook also owns applying `paths` to the model (a batch, or
 * resetPaths when most of the tree changed) so the post-update sync
 * happens in the same effect as the update itself, before any React
 * commit. The returned refs are written to by the consumer's event
 * handlers (mouse, drag, search input focus) and by the realignment
 * effect (which moves pierre's focus to currentFile after an external
 * nav and must update lastOpenedRef to keep the focus effect quiet).
 */
export function useFileTreeFocusGuard({
  model,
  currentFile,
  paths,
  onFileSelect,
}: UseFileTreeFocusGuardOptions): UseFileTreeFocusGuardResult {
  // Tracks the last path we opened a preview for. Read by the focus
  // effect (to suppress re-firing onFileSelect for a focus change that's
  // just the realignment) and written by the realignment effect, the
  // click handler, and the search Enter handler in the consumer.
  // Initialized to whatever pierre auto-focused on mount (its constructor
  // lands focus on index 0), so the focus effect doesn't read that
  // auto-focus as a keyboard nav and open a file the user didn't ask for.
  // That holds when currentFile is another row too: the realignment
  // effect then moves focus to currentFile and syncs this ref itself.
  const lastOpenedRef = useRef<string | null>(model.getFocusedPath());

  // Set to true by the consumer when the search input gains DOM focus,
  // false when it loses focus. Suppresses auto-preview while typing —
  // search moves focus to the first match as the query narrows, and
  // opening a file per keystroke feels noisy.
  const searchInputFocusedRef = useRef(false);

  // Set to 'mouse' on capture-phase mousedown by the consumer's click
  // handler. Consumed and reset by the focus effect, so a subsequent
  // arrow-key nav isn't silently gated by a stale mouse interaction.
  const focusOriginRef = useRef<'mouse' | null>(null);

  // Set to true on dragend. When a drag moves a file, pierre re-focuses
  // the moved row at its new path — without this flag, the focus effect
  // would read that as a fresh keyboard-style focus change and open the
  // preview. Consumed by the focus effect or the click handler (belt-
  // and-suspenders in case the platform fires click after a drag) and
  // cleared on the next mousedown so the flag never leaks across
  // gestures.
  const justDraggedRef = useRef(false);

  // Keep library paths in sync with props.
  const lastPathsRef = useRef(paths);
  const resetPaths = useCallback(
    (prevPaths: readonly string[], nextPaths: readonly string[]) => {
      // Pierre's resetPaths builds a fresh path store keyed off the
      // mount-time `initialExpansion` ('closed' for SidebarFileTree), so
      // every directory in the new tree starts collapsed. The mode-
      // expansion effect in the consumer only auto-expands *newly-
      // appearing* directories (by design — it preserves user-driven
      // collapses), so without intervention every paths change collapses
      // every existing folder. Capture the current expansion of every
      // known directory and replay it via initialExpandedPaths so user
      // and auto-expansion state survives the reset; new directories
      // (those not in the old tree) fall through to the consumer's mode-
      // expansion effect as intended.
      const expandedAncestors: string[] = [];
      const seen = new Set<string>();
      for (const p of prevPaths) {
        for (const ancestor of getAncestorPaths(p)) {
          if (seen.has(ancestor)) continue;
          seen.add(ancestor);
          const item = model.getItem(ancestor);
          if (item?.isDirectory() && 'isExpanded' in item && item.isExpanded()) {
            expandedAncestors.push(ancestor);
          }
        }
      }
      model.resetPaths(nextPaths, { initialExpandedPaths: expandedAncestors });
      // Pierre may auto-snap focus when the previously focused path is no
      // longer in the new path set — its #rebuildVisibleProjection falls
      // back to index 0. Sync lastOpenedRef with the post-reset focused
      // path so the focus effect below doesn't read that snap as a
      // keyboard nav and open the preview to a file the user didn't ask
      // for.
      lastOpenedRef.current = model.getFocusedPath();
    },
    [model]
  );
  useEffect(() => {
    if (lastPathsRef.current === paths) return;
    const prevPaths = lastPathsRef.current;
    lastPathsRef.current = paths;
    // Apply a watcher refresh as an edit, which keeps expansion and costs
    // only the change; rebuild only when most of the tree changed.
    const operations = planFileTreePathUpdate(prevPaths, paths, (path) => !!model.getItem(path));
    if (operations) {
      // An empty batch still re-renders every row.
      if (operations.length === 0) return;
      const focusedBefore = model.getFocusedPath();
      try {
        model.batch(operations);
        // Removing the focused row moves pierre's focus; don't let the focus
        // effect read that as a keyboard nav.
        const focusedAfter = model.getFocusedPath();
        if (focusedAfter !== focusedBefore) lastOpenedRef.current = focusedAfter;
        return;
      } catch {
        // The tree no longer matches prevPaths; rebuild it below.
      }
    }
    resetPaths(prevPaths, paths);
  }, [paths, model, resetPaths]);
  // Pierre moves rows itself on a drop or rename, before the disk has the
  // change. When the disk refuses it, the paths never change to match, so
  // rebuild from the paths we have.
  const resyncPaths = useCallback(
    () => resetPaths(lastPathsRef.current, lastPathsRef.current),
    [resetPaths]
  );

  // When currentFile is null (preview closed, or never opened), sync to
  // pierre's currently focused path so its lingering or auto-snapped focus
  // doesn't trigger onFileSelect. A set currentFile is left to the
  // realignment effect, which syncs this ref as it moves focus there.
  // Syncing to it here too would overwrite the realignment's sync before
  // the focus effect sees that move, so the focus effect would open the
  // row focus left, and the two files would swap forever.
  useEffect(() => {
    if (currentFile === null) lastOpenedRef.current = model.getFocusedPath();
  }, [currentFile, model]);

  // Preview the focused file as the user arrow-keys through the tree.
  // Mouse clicks also move focus, but we route mouse-driven preview
  // through the click handler in the consumer — pierre moves focus on
  // mousedown, before the browser knows whether the gesture is a click
  // or a drag, so firing preview from focus changes opens files the
  // user was only trying to drag. focusOriginRef tells this effect to
  // stand down while the focus move was mouse-driven.
  //
  // Directories are skipped; deleted files are allowed through — in
  // diff mode, selecting a deleted row should show its deletion diff.
  // The lastOpenedRef guard keeps the realignment effect (which calls
  // model.focusPath) from bouncing back into onFileSelect.
  //
  // onFileSelect is read through a ref, so the effect runs only when focus
  // moves. A caller handing a new function each render (History does) would
  // otherwise re-run it after a selection made outside the tree, while focus
  // still sits on the old row: it would select that row again, the
  // realignment would focus the new one, and the two would swap forever.
  const onFileSelectRef = useRef(onFileSelect);
  useEffect(() => {
    onFileSelectRef.current = onFileSelect;
  }, [onFileSelect]);
  const focusedPath = useFileTreeSelector(model, (m) => m.getFocusedPath());
  useEffect(() => {
    if (!focusedPath) return;
    if (focusedPath === lastOpenedRef.current) return;
    if (searchInputFocusedRef.current) return;
    if (focusOriginRef.current === 'mouse') {
      focusOriginRef.current = null;
      return;
    }
    if (justDraggedRef.current) {
      justDraggedRef.current = false;
      return;
    }
    const item = model.getItem(focusedPath);
    if (!item || item.isDirectory()) return;
    lastOpenedRef.current = focusedPath;
    onFileSelectRef.current(focusedPath);
  }, [focusedPath, model]);

  return {
    searchInputFocusedRef,
    focusOriginRef,
    justDraggedRef,
    lastOpenedRef,
    resyncPaths,
  };
}
