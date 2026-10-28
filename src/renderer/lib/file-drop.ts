/** Whether a drag or drop carries files, from the OS or another app. */
export function hasFileDrop(dataTransfer: DataTransfer): boolean {
  if (dataTransfer.files.length > 0) return true;
  return Array.from(dataTransfer.types).includes('Files');
}
