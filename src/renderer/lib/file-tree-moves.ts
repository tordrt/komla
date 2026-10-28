import { useToastStore, type ToastAction } from '@/stores/toast.store';

export interface FileTreeMove {
  /** Where the path was before the move or rename. */
  from: string;
  /** Where it is now. */
  to: string;
}

interface FileTreeMoveOptions {
  /**
   * The open files with unsaved edits, read when a move or its undo runs.
   * Moving one would leave its buffer on the old path, so it's refused.
   */
  getUnsavedPaths: () => string[];
  /** Runs after the moves, and with the reverse moves after an undo. */
  onMoved: (moves: FileTreeMove[]) => void | Promise<void>;
}

/** Where `path` is after `move`, also inside a moved folder; null when the move didn't touch it. */
export function pathAfterMove(path: string, { from, to }: FileTreeMove): string | null {
  if (path === from) return to;
  return path.startsWith(`${from}/`) ? `${to}${path.slice(from.length)}` : null;
}

const fileName = (path: string) => path.split('/').pop() || path;

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : 'Unknown error');

/** Renames `move.from` to `move.to` unless that loses unsaved edits or replaces a path. */
async function renameIfFree(
  workingDirectory: string,
  move: FileTreeMove,
  getUnsavedPaths: () => string[],
  takenMessage: string
): Promise<boolean> {
  const { addToast } = useToastStore.getState();
  const unsavedPath = getUnsavedPaths().find((path) => pathAfterMove(path, move));
  if (unsavedPath) {
    addToast(`Save or discard your changes to ${fileName(unsavedPath)} first`, 'error');
    return false;
  }
  if (await window.api.fileExists(workingDirectory, move.to)) {
    addToast(takenMessage, 'error');
    return false;
  }
  await window.api.renameFile(workingDirectory, move.from, move.to);
  return true;
}

/**
 * The toast action that undoes file-tree moves by renaming each path back. A
 * drag moves files with no confirmation, so a stray drop needs a way back.
 * Leaves a path alone when something has taken its original place.
 */
function undoMovesAction(
  workingDirectory: string,
  moves: readonly FileTreeMove[],
  { getUnsavedPaths, onMoved }: FileTreeMoveOptions
): ToastAction {
  const undo = async () => {
    const undone: FileTreeMove[] = [];
    for (const { from, to } of moves.toReversed()) {
      const back = { from: to, to: from };
      try {
        if (
          await renameIfFree(
            workingDirectory,
            back,
            getUnsavedPaths,
            `Can't undo: "${from}" exists again`
          )
        ) {
          undone.push(back);
        }
      } catch (err) {
        useToastStore.getState().addToast(`Failed to undo: ${errorMessage(err)}`, 'error');
      }
    }
    if (undone.length > 0) await onMoved(undone);
  };
  return { label: 'Undo', onClick: () => void undo() };
}

/**
 * Moves dropped file-tree paths into `targetDir`, with one toast and one Undo
 * for all of them. Resolves false when any path stayed put, so the tree can
 * put back the rows it already moved.
 */
export async function moveFileTreePaths(
  workingDirectory: string,
  sourcePaths: readonly string[],
  targetDir: string,
  options: FileTreeMoveOptions
): Promise<boolean> {
  const { addToast } = useToastStore.getState();
  const where = targetDir || 'root';
  const moves: FileTreeMove[] = [];
  let allMoved = true;
  for (const from of sourcePaths) {
    const name = fileName(from);
    const to = targetDir ? `${targetDir}/${name}` : name;
    if (to === from) continue;
    try {
      const moved = await renameIfFree(
        workingDirectory,
        { from, to },
        options.getUnsavedPaths,
        `"${name}" already exists in ${where}`
      );
      if (moved) moves.push({ from, to });
      else allMoved = false;
    } catch (err) {
      addToast(`Failed to move: ${errorMessage(err)}`, 'error');
      allMoved = false;
    }
  }
  if (moves.length === 0) return allMoved;
  const message =
    moves.length === 1
      ? `Moved ${fileName(moves[0].from)} to ${where}`
      : `Moved ${moves.length} items to ${where}`;
  addToast(message, 'success', { action: undoMovesAction(workingDirectory, moves, options) });
  await options.onMoved(moves);
  return allMoved;
}

/** Renames a file-tree path, with an Undo on its toast. Resolves false when it wasn't renamed. */
export async function renameFileTreePath(
  workingDirectory: string,
  move: FileTreeMove,
  options: FileTreeMoveOptions
): Promise<boolean> {
  if (move.from === move.to) return true;
  const { addToast } = useToastStore.getState();
  const name = fileName(move.to);
  try {
    const renamed = await renameIfFree(
      workingDirectory,
      move,
      options.getUnsavedPaths,
      `A file or folder named "${name}" already exists`
    );
    if (!renamed) return false;
  } catch (err) {
    addToast(`Failed to rename: ${errorMessage(err)}`, 'error');
    return false;
  }
  addToast(`Renamed to ${name}`, 'success', {
    action: undoMovesAction(workingDirectory, [move], options),
  });
  await options.onMoved([move]);
  return true;
}
