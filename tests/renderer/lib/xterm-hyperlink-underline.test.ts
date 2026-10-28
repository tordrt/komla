/**
 * @vitest-environment jsdom
 */
import { Terminal as XtermTerminal } from '@xterm/xterm';
import { describe, expect, it, vi } from 'vitest';

import {
  findHyperlinkSegments,
  HyperlinkUnderlineAddon,
} from '../../../src/renderer/lib/xterm-hyperlink-underline';

import type { IBufferLine, IBufferRange, Terminal } from '@xterm/xterm';

type LinkRun = [start: number, end: number, linkId: number];
interface MockCell {
  hasExtendedAttrs?: () => number;
  extended?: { urlId: number };
  getChars?: () => string;
  getWidth?: () => number;
}

/**
 * A line whose cells carry OSC 8 link ids the way xterm's do, stale `extended` included.
 * Cells from `textEnd` on are empty.
 */
function lineWithLinks(cols: number, runs: LinkRun[] = [], textEnd = cols): IBufferLine {
  const linkIdAt = (x: number) => runs.find(([start, end]) => x >= start && x < end)?.[2] ?? 0;
  return {
    length: cols,
    getCell: (x: number, reused?: MockCell) => {
      if (x < 0 || x >= cols) return undefined;
      const cell: MockCell = reused ?? { extended: { urlId: 0 } };
      const linkId = linkIdAt(x);
      cell.hasExtendedAttrs = () => (linkId ? 1 : 0);
      if (linkId) cell.extended = { urlId: linkId };
      cell.getChars = () => (x < textEnd ? 'x' : '');
      cell.getWidth = () => 1;
      return cell;
    },
  } as unknown as IBufferLine;
}

function bufferOf(lines: IBufferLine[]) {
  return { viewportY: 0, getLine: (y: number) => lines[y] };
}

/** The range xterm's link handler reports for a link starting at a 0-based cell. */
function hoveredRange(y: number, x: number, width: number): IBufferRange {
  return { start: { x: x + 1, y: y + 1 }, end: { x: x + width, y: y + 1 } };
}

// Claude Code's attachment rows at 74 columns: the path wraps inside a column next to
// "›"/"[image]" and the size, and every row is tagged with the same link.
const attachmentRows = () => [
  lineWithLinks(74, [[10, 66, 7]]),
  lineWithLinks(74, [[8, 58, 7]]),
  lineWithLinks(74, [[10, 42, 7]]),
  lineWithLinks(74, [[10, 66, 8]]),
];

describe('findHyperlinkSegments', () => {
  it('finds the other rows of a link that an agent wrapped inside a column', () => {
    expect(findHyperlinkSegments(bufferOf(attachmentRows()), hoveredRange(1, 8, 50))).toEqual([
      { y: 0, x: 10, width: 56 },
      { y: 2, x: 10, width: 32 },
    ]);
  });

  it('returns nothing for a link on a single row', () => {
    const lines = [lineWithLinks(40), lineWithLinks(40, [[4, 20, 3]]), lineWithLinks(40)];

    expect(findHyperlinkSegments(bufferOf(lines), hoveredRange(1, 4, 16))).toEqual([]);
  });

  it('stops at the first row without the link', () => {
    const lines = [
      lineWithLinks(40, [[0, 10, 3]]),
      lineWithLinks(40),
      lineWithLinks(40, [[0, 10, 3]]),
      lineWithLinks(40, [[0, 6, 3]]),
    ];

    expect(findHyperlinkSegments(bufferOf(lines), hoveredRange(2, 0, 10))).toEqual([
      { y: 3, x: 0, width: 6 },
    ]);
  });

  it('includes other runs of the link on the hovered row', () => {
    const lines = [
      lineWithLinks(40, [
        [2, 8, 5],
        [20, 30, 5],
      ]),
    ];

    expect(findHyperlinkSegments(bufferOf(lines), hoveredRange(0, 20, 10))).toEqual([
      { y: 0, x: 2, width: 6 },
    ]);
  });

  it('ends a run at the last character, as xterm does', () => {
    const lines = [lineWithLinks(40, [[10, 40, 3]], 30), lineWithLinks(40, [[10, 30, 3]])];

    expect(findHyperlinkSegments(bufferOf(lines), hoveredRange(1, 10, 20))).toEqual([
      { y: 0, x: 10, width: 20 },
    ]);
  });

  it('reads the link of each row from a real xterm buffer', async () => {
    const terminal = new XtermTerminal({ cols: 40, rows: 6, allowProposedApi: true });
    const link = (text: string, uri = 'file:///tmp/shots/scene.png') =>
      `\x1b]8;id=a1;${uri}\x07${text}\x1b]8;;\x07`;
    await new Promise<void>((resolve) =>
      terminal.write(
        `  › ${link('/tmp/shots/')} (1K\r\n  [i] ${link('scene.png')}\r\n${link('next', 'https://example.com/')}`,
        resolve
      )
    );

    expect(findHyperlinkSegments(terminal.buffer.active, hoveredRange(0, 4, 11))).toEqual([
      { y: 1, x: 6, width: 9 },
    ]);
    terminal.dispose();
  });

  it('ignores cells without a link', () => {
    const lines = [lineWithLinks(40), lineWithLinks(40)];

    expect(findHyperlinkSegments(bufferOf(lines), hoveredRange(0, 2, 5))).toEqual([]);
  });
});

describe('HyperlinkUnderlineAddon', () => {
  function terminalWith(lines: IBufferLine[]) {
    const element = document.createElement('div');
    const screen = document.createElement('div');
    screen.className = 'xterm-screen';
    // 74×45 cells of 10×10 CSS pixels.
    screen.style.width = '740px';
    screen.style.height = '450px';
    element.appendChild(screen);
    const renderListeners = new Set<() => void>();
    const buffer = bufferOf(lines);
    const terminal = {
      cols: 74,
      rows: 45,
      element,
      options: { theme: { foreground: '#e0e0e0' } },
      buffer: { active: buffer },
      onRender: vi.fn((listener: () => void) => {
        renderListeners.add(listener);
        return { dispose: () => renderListeners.delete(listener) };
      }),
    };
    const render = () => renderListeners.forEach((listener) => listener());
    return { terminal: terminal as unknown as Terminal, screen, buffer, render, renderListeners };
  }

  const underlines = (screen: HTMLElement) =>
    Array.from(screen.querySelectorAll<HTMLElement>(':scope > div > div')).map(({ style }) => ({
      left: style.left,
      top: style.top,
      width: style.width,
      color: style.backgroundColor,
    }));

  it("underlines the hovered link's other rows where xterm draws its own link underline", () => {
    const { terminal, screen } = terminalWith(attachmentRows());
    const addon = new HyperlinkUnderlineAddon();
    addon.activate(terminal);

    addon.show(hoveredRange(1, 8, 50));

    expect(underlines(screen)).toEqual([
      { left: '100px', top: '8px', width: '560px', color: 'rgb(224, 224, 224)' },
      { left: '100px', top: '28px', width: '320px', color: 'rgb(224, 224, 224)' },
    ]);
  });

  it('follows scrolling and clears the lines when the link is left', () => {
    const { terminal, screen, buffer, render, renderListeners } = terminalWith(attachmentRows());
    const addon = new HyperlinkUnderlineAddon();
    addon.activate(terminal);
    addon.show(hoveredRange(1, 8, 50));

    buffer.viewportY = 1;
    render();
    expect(underlines(screen).map(({ top }) => top)).toEqual(['18px']);

    addon.hide();
    expect(underlines(screen)).toEqual([]);
    expect(renderListeners.size).toBe(0);
  });

  it('does nothing before it is loaded into a terminal', () => {
    const addon = new HyperlinkUnderlineAddon();

    expect(() => addon.show(hoveredRange(1, 8, 50))).not.toThrow();
    expect(() => addon.hide()).not.toThrow();
  });
});
