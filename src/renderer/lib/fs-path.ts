// Renderer-side path helpers. Kept here rather than going through IPC to the
// main process's node:path because these are all sync, pure-string operations.

// Join a workspace-relative path (always forward slashes, as emitted by
// @pierre/trees and git) onto an absolute working directory, and return a
// path using the platform-native separator. On Windows the concat would
// otherwise produce mixed separators like `C:\repo/foo.ts`, which some
// Windows tools tolerate but which looks broken when pasted into a terminal.
export function joinAbsPath(workingDirectory: string, relativePath: string): string {
  const trimmed = workingDirectory.replace(/[\\/]+$/, '');
  const raw = `${trimmed}/${relativePath}`;
  return window.api.platform === 'win32' ? raw.replace(/\//g, '\\') : raw;
}
