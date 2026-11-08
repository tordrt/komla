/** Whether a drag or drop carries files, from the OS or another app. */
export function hasFileDrop(dataTransfer: DataTransfer): boolean {
  if (dataTransfer.files.length > 0) return true;
  return Array.from(dataTransfer.types).includes('Files');
}

/**
 * Copies a file from outside the workspace into its `.komla-files/` and returns the copy's path
 * in the workspace.
 */
export type ImportExternalFile = (sourcePath: string, preferredName?: string) => Promise<string>;

export function isDroppedRegularFile(filePath: string): boolean {
  return filePath.length > 0;
}

const LARGE_FILE_TRANSFER_BYTES = 100 * 1024 * 1024;

export async function getDroppedFileAtPathInput(
  files: readonly File[],
  getPathForFile: (file: File) => string,
  importExternalFile: ImportExternalFile | undefined,
  confirmLargeTransfer?: (files: readonly File[], totalBytes: number) => Promise<boolean>
): Promise<string | null> {
  if (!importExternalFile) return null;

  const importableFiles = files
    .map((file) => ({ file, sourcePath: getPathForFile(file) }))
    .filter(({ sourcePath }) => isDroppedRegularFile(sourcePath));

  const totalBytes = importableFiles.reduce((total, { file }) => total + file.size, 0);
  if (
    totalBytes >= LARGE_FILE_TRANSFER_BYTES &&
    confirmLargeTransfer &&
    !(await confirmLargeTransfer(
      importableFiles.map(({ file }) => file),
      totalBytes
    ))
  ) {
    return null;
  }

  const refs = await Promise.all(
    importableFiles.map(async ({ file, sourcePath }) => {
      try {
        const relativePath = await importExternalFile(sourcePath, file.name);
        return `@${relativePath} `;
      } catch (err) {
        console.warn('Failed to import dropped file:', err);
        return null;
      }
    })
  );

  const input = refs.filter((ref): ref is string => ref !== null).join('');
  return input || null;
}

/** What shows while dropped or pasted files are copied in. */
export function uploadingLabel(files: readonly File[]): string {
  return files.length === 1 ? `Uploading ${files[0].name}…` : `Uploading ${files.length} files…`;
}
