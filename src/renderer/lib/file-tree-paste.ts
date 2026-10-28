interface FileTreePaste {
  src: string;
  dest: string;
  isDirectory: boolean;
  isCut: boolean;
  /** The user confirmed replacing an existing `dest`. */
  overwrite: boolean;
}

/**
 * Paste a copied or cut file-tree node. A cut is a real rename so the original
 * isn't sent to the OS trash; only a confirmed overwrite falls back to copy +
 * delete, since a rename can't replace an existing directory.
 */
export async function pasteFileTreeNode(
  workingDirectory: string,
  { src, dest, isDirectory, isCut, overwrite }: FileTreePaste
): Promise<void> {
  if (isCut && !overwrite) {
    await window.api.renameFile(workingDirectory, src, dest);
    return;
  }
  if (isDirectory) {
    await window.api.copyDirectory(workingDirectory, src, dest);
  } else {
    await window.api.copyFile(workingDirectory, src, dest);
  }
  if (isCut) {
    await window.api.deleteFile(workingDirectory, src, 'modified');
  }
}
