import type { IMarker, Terminal } from '@xterm/xterm';

// Lines written within this long of each other share a time.
const LINE_TIME_RESOLUTION_MS = 2_000;
// Each marker moves on every line trimmed from the scrollback, so few are kept;
// older lines share the oldest time kept.
const MAX_LINE_TIME_MARKS = 100;

/** When a terminal's lines were written, to within a couple of seconds, for the normal screen. */
export interface TerminalLineTimes {
  /** Call before writing output: the lines from the cursor on are written from now. */
  noteWrite(): void;
  /** The time each of the buffer lines `startY` to `endY - 1` was written; undefined when unknown. */
  timesOf(startY: number, endY: number): Array<number | undefined>;
}

/**
 * Times `terminal`'s lines, watching its output for a cursor moving up to rewrite lines.
 * While `paused`, as for output printed earlier and replayed, lines get no time.
 */
export function createTerminalLineTimes(
  terminal: Pick<Terminal, 'buffer' | 'parser' | 'registerMarker'>,
  { now = Date.now, paused = () => false }: { now?: () => number; paused?: () => boolean } = {}
): TerminalLineTimes {
  // Each mark times the lines from its own down to the next; they stay in line order.
  const marks: Array<{ marker: IMarker; at: number }> = [];
  // The time of lines above every mark, once the first mark's line left the scrollback.
  let trimmedTime: number | undefined;

  function mark(requestedOffset: number): void {
    // A full-screen program redraws the alternate screen in place, so its lines have no history.
    const buffer = terminal.buffer.active;
    if (buffer.type !== 'normal' || paused()) return;
    // The cursor stops at the top of the screen.
    const cursorYOffset = Math.max(requestedOffset, -buffer.cursorY);
    const line = buffer.baseY + buffer.cursorY + cursorYOffset;
    while (marks.length > 0 && marks[marks.length - 1].marker.line >= line) {
      marks.pop()!.marker.dispose();
    }
    const at = now();
    const last = marks.at(-1);
    if (last && at - last.at < LINE_TIME_RESOLUTION_MS) return;
    const marker = terminal.registerMarker(cursorYOffset);
    if (!marker) return;
    const entry = { marker, at };
    marks.push(entry);
    // Marks Komla drops are out of the list already; xterm drops one whose line went away.
    marker.onDispose(() => {
      const index = marks.indexOf(entry);
      if (index === -1) return;
      marks.splice(index, 1);
      if (index === 0) trimmedTime = entry.at;
    });
    // Past the limit, the second mark's lines join the first's and take its older time,
    // so lines above the first, untimed as replayed output, stay so.
    if (marks.length > MAX_LINE_TIME_MARKS) marks.splice(1, 1)[0].marker.dispose();
  }

  // Cursor up, previous line, cursor position, line position and reverse index.
  const count = (params: (number | number[])[]): number =>
    typeof params[0] === 'number' && params[0] > 0 ? params[0] : 1;
  const moveUp = (lines: number): boolean => {
    mark(-lines);
    return false;
  };
  const moveToRow = (params: (number | number[])[]): boolean => {
    const offset = count(params) - 1 - terminal.buffer.active.cursorY;
    if (offset < 0) mark(offset);
    return false;
  };
  terminal.parser.registerCsiHandler({ final: 'A' }, (params) => moveUp(count(params)));
  terminal.parser.registerCsiHandler({ final: 'F' }, (params) => moveUp(count(params)));
  terminal.parser.registerCsiHandler({ final: 'H' }, moveToRow);
  terminal.parser.registerCsiHandler({ final: 'f' }, moveToRow);
  terminal.parser.registerCsiHandler({ final: 'd' }, moveToRow);
  terminal.parser.registerEscHandler({ final: 'M' }, () => moveUp(1));

  return {
    noteWrite: () => mark(0),

    timesOf(startY, endY) {
      const times: Array<number | undefined> = [];
      if (terminal.buffer.active.type !== 'normal') return times;
      let next = 0;
      let current = trimmedTime;
      for (let y = startY; y < endY; y++) {
        while (next < marks.length && marks[next].marker.line <= y) current = marks[next++].at;
        times.push(current);
      }
      return times;
    },
  };
}
