import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef } from 'react';
import { create } from 'zustand';

/** A file on screen, which a prompt can refer to. */
export interface ViewedFile {
  workspaceId: string;
  /** The file's name, to show. */
  name: string;
  /** How a prompt refers to the file now: `@` and its path, with the lines selected in it. */
  getReference: () => string;
}

interface ViewedFileState {
  /** The files viewers show, by viewer, the one the user turned to last first. */
  viewed: { viewer: string; file: ViewedFile }[];
  /** Puts a viewer's file first: it just showed it, or the user turned to it. */
  show: (viewer: string, file: ViewedFile) => void;
  hide: (viewer: string) => void;
}

export const useViewedFileStore = create<ViewedFileState>((set, get) => ({
  viewed: [],
  show: (viewer, file) => {
    const first = get().viewed[0];
    if (first?.viewer === viewer && first.file === file) return;
    set((state) => ({
      viewed: [{ viewer, file }, ...state.viewed.filter((entry) => entry.viewer !== viewer)],
    }));
  },
  hide: (viewer) => {
    if (!get().viewed.some((entry) => entry.viewer === viewer)) return;
    set((state) => ({ viewed: state.viewed.filter((entry) => entry.viewer !== viewer) }));
  },
}));

/** The file in the workspace the user looked at last, among those on screen. */
export function selectViewedFile(state: ViewedFileState, workspaceId: string): ViewedFile | null {
  return state.viewed.find((entry) => entry.file.workspaceId === workspaceId)?.file ?? null;
}

function fileName(path: string): string {
  return (
    path
      .replace(/[/\\]+$/, '')
      .split(/[/\\]/)
      .pop() || path
  );
}

/**
 * Tells the prompt draft which file a viewer shows, while it shows one: null `path` for none,
 * such as while hidden. Spread the returned handlers on the viewer, so turning to it, by a click
 * or focus, makes its file the one the draft refers to.
 */
export function useViewedFile(
  workspaceId: string | null | undefined,
  path: string | null | undefined,
  getReference: () => string
): { onFocusCapture: () => void; onPointerDownCapture: () => void } {
  const viewer = useId();
  const referenceRef = useRef(getReference);
  useLayoutEffect(() => {
    referenceRef.current = getReference;
  });
  const file = useMemo<ViewedFile | null>(
    () =>
      workspaceId && path
        ? { workspaceId, name: fileName(path), getReference: () => referenceRef.current() }
        : null,
    [workspaceId, path]
  );

  useEffect(() => {
    if (!file) return;
    useViewedFileStore.getState().show(viewer, file);
    return () => useViewedFileStore.getState().hide(viewer);
  }, [file, viewer]);

  const bringForward = useCallback(() => {
    if (file) useViewedFileStore.getState().show(viewer, file);
  }, [file, viewer]);
  return useMemo(
    () => ({ onFocusCapture: bringForward, onPointerDownCapture: bringForward }),
    [bringForward]
  );
}
