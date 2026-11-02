import headless from '@xterm/headless';

import type { IBufferCell, IBufferLine } from '@xterm/headless';

const { Terminal } = headless;

/** Most history lines `komla read` returns above the screen. */
export const MAX_TERMINAL_TEXT_HISTORY = 2000;

export interface TerminalText {
  /** The screen, below `history` lines above it, without trailing blank lines. */
  text: string;
  /** The program asked for pasted text to be bracketed, as agents' prompts do. */
  bracketedPaste: boolean;
}

/**
 * What a terminal shows as plain text, parsed from its retained output at its size, with up to
 * `history` lines that scrolled off above the screen. A full-screen program's alternate screen has
 * no history of its own, so only its screen shows.
 */
export async function terminalText(
  output: string,
  size: { cols: number; rows: number },
  history: number
): Promise<TerminalText> {
  const terminal = new Terminal({
    cols: Math.max(1, size.cols),
    rows: Math.max(1, size.rows),
    scrollback: MAX_TERMINAL_TEXT_HISTORY,
    allowProposedApi: true,
  });
  try {
    await new Promise<void>((resolve) => terminal.write(output, resolve));
    const buffer = terminal.buffer.active;
    const screenStart = buffer.baseY;
    const start = Math.max(0, screenStart - Math.max(0, history));
    const lines: string[] = [];
    for (let row = start; row < buffer.length; row += 1) {
      const line = buffer.getLine(row);
      if (!line) continue;
      // A wrapped row continues the one above it, as the program printed one line, so a row the
      // next one continues keeps its trailing spaces.
      const text = buffer.getLine(row + 1)?.isWrapped
        ? line.translateToString(false, 0, lastWrittenColumn(line) + 1)
        : line.translateToString(true);
      if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
      else lines.push(text);
    }
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return { text: lines.join('\n'), bracketedPaste: terminal.modes.bracketedPasteMode };
  } finally {
    terminal.dispose();
  }
}

/**
 * The last column a character was written to. Trailing spaces the program printed count, but not
 * the cell a wide character left empty when it wrapped to the next row.
 */
function lastWrittenColumn(line: IBufferLine): number {
  let cell: IBufferCell | undefined;
  for (let column = line.length - 1; column >= 0; column -= 1) {
    // One cell reused for the whole row.
    cell = line.getCell(column, cell);
    if (cell && (cell.getChars() !== '' || cell.getWidth() === 0)) return column;
  }
  return -1;
}
