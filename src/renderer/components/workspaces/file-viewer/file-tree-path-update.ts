import type { FileTreeBatchOperation } from '@pierre/trees';

// Measured on @pierre/trees 1.0.0-beta.6: a batch costs about 10 µs per
// operation, while resetPaths rebuilds and re-sorts the whole tree at about
// 3 µs per path (0.6 s for 200k paths).
const ALWAYS_INCREMENTAL_CHANGES = 100;
const MAX_INCREMENTAL_CHANGE_RATIO = 0.25;

/**
 * Plans the batch that turns a tree built from `prevPaths` into one built from
 * `nextPaths`, so a watcher refresh edits the tree instead of rebuilding it and
 * keeps its expansion. Returns null when so much changed that resetPaths is
 * cheaper. `hasPath` reports what the tree holds, so a change it already shows
 * (its own drop or rename moves rows before the disk does) is skipped.
 */
export function planFileTreePathUpdate(
  prevPaths: readonly string[],
  nextPaths: readonly string[],
  hasPath: (path: string) => boolean
): FileTreeBatchOperation[] | null {
  const prev = new Set(prevPaths);
  const next = new Set(nextPaths);
  const added = nextPaths.filter((path) => !prev.has(path));
  const removed = prevPaths.filter((path) => !next.has(path));
  if (added.length + removed.length === 0) return [];
  if (prefersRebuild(added, removed, nextPaths.length)) return null;

  // Adds go first, so a folder whose files are only renamed keeps its row
  // (and its expansion) instead of emptying out and being recreated.
  const operations: FileTreeBatchOperation[] = [];
  for (const path of added) {
    if (!hasPath(path)) operations.push({ type: 'add', path });
  }

  // Pierre keeps a folder whose last file is removed as an empty row, so
  // collect the folders a removal may have emptied. A trailing slash marks an
  // explicitly listed empty folder.
  const maybeEmptied = new Set<string>();
  for (const path of removed) {
    const isFolder = path.endsWith('/');
    if (isFolder) maybeEmptied.add(path.slice(0, -1));
    else if (hasPath(path)) operations.push({ type: 'remove', path });
    for (let i = path.lastIndexOf('/', path.length - 2); i > 0; i = path.lastIndexOf('/', i - 1)) {
      maybeEmptied.add(path.slice(0, i));
    }
  }
  const emptied = new Set(maybeEmptied);
  for (const path of nextPaths) {
    if (emptied.size === 0) break;
    for (let i = path.indexOf('/'); i !== -1; i = path.indexOf('/', i + 1)) {
      emptied.delete(path.slice(0, i));
    }
  }
  for (const folder of emptied) {
    if (hasEmptiedAncestor(folder, emptied) || !hasPath(folder)) continue;
    operations.push({ type: 'remove', path: `${folder}/`, recursive: true });
  }
  return operations;
}

/**
 * Whether resetPaths beats a batch: when most of the tree changed, or when a
 * file became a folder of the same name or the reverse. Pierre refuses an add
 * whose name the tree still holds, and adds go first.
 */
function prefersRebuild(
  added: readonly string[],
  removed: readonly string[],
  nextCount: number
): boolean {
  const changes = added.length + removed.length;
  if (changes > ALWAYS_INCREMENTAL_CHANGES && changes > nextCount * MAX_INCREMENTAL_CHANGE_RATIO) {
    return true;
  }
  const addedFolders = folderNames(added);
  const removedFolders = folderNames(removed);
  return (
    removed.some((path) => addedFolders.has(path)) || added.some((path) => removedFolders.has(path))
  );
}

function folderNames(paths: readonly string[]): Set<string> {
  const folders = new Set<string>();
  for (const path of paths) {
    for (let i = path.indexOf('/'); i !== -1; i = path.indexOf('/', i + 1)) {
      folders.add(path.slice(0, i));
    }
  }
  return folders;
}

function hasEmptiedAncestor(folder: string, emptied: ReadonlySet<string>): boolean {
  for (let i = folder.lastIndexOf('/'); i > 0; i = folder.lastIndexOf('/', i - 1)) {
    if (emptied.has(folder.slice(0, i))) return true;
  }
  return false;
}
