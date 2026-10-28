import { getTerminalRendererOutputSinceLastScan } from './terminal-renderer-runtime';
import { findFileLinksInText } from './xterm-url-links';

// Files are listed for as long as the terminal still shows them, as links are.
const MAX_FILE_LINES_PER_TERMINAL = 10_000;

export interface ScannedTerminalFile {
  terminalId: string;
  /** The path as printed, a folder's ending in a separator. */
  path: string;
  lineNumber?: number;
  /** When the line was written, to within a couple of seconds, when known. */
  printedAt?: number;
}

/**
 * The file and folder paths the workspace's terminals printed since the last scan, or show on
 * screen, as the terminals link them as text: newest line first, each line left to right.
 * Terminals `includes` leaves out keep what they printed for a later scan.
 */
export function scanWorkspaceTerminalsForFiles(
  workspaceId: string,
  includes?: (terminalId: string) => boolean
): ScannedTerminalFile[] {
  const files: ScannedTerminalFile[] = [];
  for (const { terminalId, logicalLines, printedAt } of getTerminalRendererOutputSinceLastScan(
    workspaceId,
    MAX_FILE_LINES_PER_TERMINAL,
    'files',
    includes
  )) {
    for (let i = logicalLines.length - 1; i >= 0; i--) {
      if (!logicalLines[i]) continue;
      for (const { path, lineNumber } of findFileLinksInText(logicalLines[i])) {
        files.push({
          terminalId,
          path,
          ...(lineNumber !== undefined ? { lineNumber } : {}),
          ...(printedAt?.[i] !== undefined ? { printedAt: printedAt[i] } : {}),
        });
      }
    }
  }
  return files;
}
