import type {
  IBuffer,
  IBufferCell,
  IBufferLine,
  IBufferRange,
  IDisposable,
  ITerminalAddon,
  Terminal,
} from '@xterm/xterm';

/** How many rows above and below a hovered hyperlink are searched for the rest of it. */
const MAX_HYPERLINK_ROWS = 50;

/** Cells of one hyperlink on one buffer line, 0-based. */
export interface HyperlinkSegment {
  y: number;
  x: number;
  width: number;
}

/**
 * The fields where xterm keeps a cell's OSC 8 link, which its public API doesn't expose.
 * `getCell` reuses cells, so `extended` is stale unless `hasExtendedAttrs()` is set.
 */
interface CellWithHyperlink {
  hasExtendedAttrs?: () => number;
  extended?: { urlId?: number };
}

function hyperlinkId(cell: IBufferCell): number {
  const internals = cell as unknown as CellWithHyperlink;
  return internals.hasExtendedAttrs?.() ? (internals.extended?.urlId ?? 0) : 0;
}

/** Cells up to the end of the line's last character, as xterm's `getTrimmedLength` counts them. */
function trimmedLength(line: IBufferLine): number {
  let cell: IBufferCell | undefined;
  for (let x = line.length - 1; x >= 0; x--) {
    cell = line.getCell(x, cell);
    if (cell?.getChars()) return x + cell.getWidth();
  }
  return 0;
}

/** Runs of one link on a line, split where xterm's own link scan splits them. */
function hyperlinkRuns(line: IBufferLine, y: number, linkId: number): HyperlinkSegment[] {
  const runs: HyperlinkSegment[] = [];
  const length = trimmedLength(line);
  let cell: IBufferCell | undefined;
  let start = -1;
  for (let x = 0; x <= length; x++) {
    cell = x < length ? line.getCell(x, cell) : undefined;
    // Like xterm, a run starts on a character, not on an empty cell.
    const inLink =
      cell !== undefined &&
      hyperlinkId(cell) === linkId &&
      (start !== -1 || cell.getChars() !== '');
    if (inLink && start === -1) start = x;
    if (!inLink && start !== -1) {
      runs.push({ y, x: start, width: x - start });
      start = -1;
    }
  }
  return runs;
}

/**
 * The rest of the OSC 8 hyperlink at `range` (1-based, as xterm's link handler reports it)
 * on the hovered row and the rows next to it.
 */
export function findHyperlinkSegments(
  buffer: Pick<IBuffer, 'getLine'>,
  range: IBufferRange
): HyperlinkSegment[] {
  const y = range.start.y - 1;
  const x = range.start.x - 1;
  const line = buffer.getLine(y);
  const cell = line?.getCell(x);
  const linkId = cell ? hyperlinkId(cell) : 0;
  if (!line || !linkId) return [];

  // xterm underlines the hovered run itself.
  const segments = hyperlinkRuns(line, y, linkId).filter(
    (run) => run.x >= range.end.x || run.x + run.width <= x
  );
  for (const step of [-1, 1]) {
    for (let row = y + step; Math.abs(row - y) <= MAX_HYPERLINK_ROWS; row += step) {
      const other = buffer.getLine(row);
      const runs = other ? hyperlinkRuns(other, row, linkId) : [];
      if (runs.length === 0) break;
      segments.push(...runs);
    }
  }
  return segments;
}

/**
 * Underlines every row of a hovered OSC 8 hyperlink. Agents like Claude Code wrap a long
 * path inside a column and tag each row as the same link, but xterm underlines only the
 * row under the mouse. xterm decorations can't draw these lines: adding one repaints every
 * row, which makes xterm drop the hovered link.
 */
export class HyperlinkUnderlineAddon implements ITerminalAddon {
  private terminal: Terminal | undefined;
  private range: IBufferRange | null = null;
  private layer: HTMLDivElement | null = null;
  private renderListener: IDisposable | null = null;
  /** What the layer shows, so redraws that change nothing leave the DOM alone. */
  private drawnKey = '';

  activate(terminal: Terminal): void {
    this.terminal = terminal;
  }

  show(range: IBufferRange): void {
    this.range = range;
    // Redraw with the terminal so the lines follow scrolling and new output.
    this.renderListener ??= this.terminal?.onRender(() => this.draw()) ?? null;
    this.draw();
  }

  hide(): void {
    this.range = null;
    this.renderListener?.dispose();
    this.renderListener = null;
    this.layer?.replaceChildren();
    this.drawnKey = '';
  }

  dispose(): void {
    this.hide();
    this.layer?.remove();
    this.layer = null;
    this.terminal = undefined;
  }

  private draw(): void {
    const terminal = this.terminal;
    const screen = terminal?.element?.querySelector<HTMLElement>('.xterm-screen');
    if (!terminal || !screen || !this.range) return;
    // Both renderers size the screen to exactly cols × rows cells.
    const cellWidth = parseFloat(screen.style.width) / terminal.cols;
    const cellHeight = parseFloat(screen.style.height) / terminal.rows;
    if (!(cellWidth > 0 && cellHeight > 0)) return;

    if (!this.layer) {
      this.layer = document.createElement('div');
      Object.assign(this.layer.style, {
        position: 'absolute',
        inset: '0',
        pointerEvents: 'none',
        zIndex: '7',
      });
    }
    if (this.layer.parentElement !== screen) screen.appendChild(this.layer);

    const buffer = terminal.buffer.active;
    const color = terminal.options.theme?.foreground ?? '#ffffff';
    // xterm draws its link underline one CSS pixel thick, one device pixel above the cell's bottom.
    const bottomOffset = 1 + 1 / window.devicePixelRatio;
    const boxes = findHyperlinkSegments(buffer, this.range)
      .map((segment) => ({ ...segment, row: segment.y - buffer.viewportY }))
      .filter(({ row }) => row >= 0 && row < terminal.rows)
      .map(({ x, width, row }) => ({
        left: `${x * cellWidth}px`,
        top: `${(row + 1) * cellHeight - bottomOffset}px`,
        width: `${width * cellWidth}px`,
      }));
    const key = JSON.stringify([color, boxes]);
    if (key === this.drawnKey) return;
    this.drawnKey = key;
    this.layer.replaceChildren(
      ...boxes.map((box) => {
        const line = document.createElement('div');
        Object.assign(line.style, {
          ...box,
          position: 'absolute',
          height: '1px',
          backgroundColor: color,
        });
        return line;
      })
    );
  }
}
