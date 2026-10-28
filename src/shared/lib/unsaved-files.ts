/** Asks whether to throw away the unsaved edits to the named files. */
export function describeUnsavedFiles(names: readonly string[]): string {
  return names.length === 1
    ? `${names[0]} has unsaved changes. Discard them?`
    : `${names.join(', ')} have unsaved changes. Discard them?`;
}
