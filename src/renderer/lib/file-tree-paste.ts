interface FileTreePaste {
  src: string;
  dest: string;
  isDirectory: boolean;
  /** Also removes `src`. A cut to a free destination is a move: see moveFileTreePaths. */
  isCut: boolean;
}

/**
 * Paste a copied file-tree node, or a cut one over a `dest` the user confirmed
 * replacing, which is copy + delete since a rename can't replace a directory.
 */
export async function pasteFileTreeNode(
  workingDirectory: string,
  { src, dest, isDirectory, isCut }: FileTreePaste
): Promise<void> {
  if (isDirectory) {
    await window.api.copyDirectory(workingDirectory, src, dest);
  } else {
    await window.api.copyFile(workingDirectory, src, dest);
  }
  if (isCut) {
    await window.api.deleteFile(workingDirectory, src, 'modified');
  }
}
