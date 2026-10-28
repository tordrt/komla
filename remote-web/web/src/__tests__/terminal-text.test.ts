import { Terminal } from '@xterm/headless';
import type { IBuffer } from '@xterm/xterm';
import { describe, expect, it } from 'vitest';

import {
  joinSoftWraps,
  readTerminalLogicalLine,
  terminalSelectionText,
  terminalUrls,
  terminalWordAt,
  trimTerminalUrl,
} from '../terminal-text';

async function bufferOf(cols: number, data: string): Promise<IBuffer> {
  const term = new Terminal({ cols, rows: 6, allowProposedApi: true });
  await new Promise<void>((resolve) => term.write(data, resolve));
  return term.buffer.active as unknown as IBuffer;
}

describe('terminal text', () => {
  it('trims what a sentence puts after a URL', () => {
    expect(trimTerminalUrl('https://example.com/a.')).toBe('https://example.com/a');
    expect(trimTerminalUrl('https://example.com/a),')).toBe('https://example.com/a');
    // A bracket the URL opened is part of it.
    expect(trimTerminalUrl('https://en.wikipedia.org/wiki/Tmux_(software)')).toBe(
      'https://en.wikipedia.org/wiki/Tmux_(software)'
    );
    expect(trimTerminalUrl('https://.')).toBeUndefined();
  });

  it('finds web addresses with where they start', () => {
    expect(terminalUrls('see (https://a.dev/x) and http://localhost:3000/.')).toEqual([
      { index: 5, url: 'https://a.dev/x' },
      { index: 26, url: 'http://localhost:3000/' },
    ]);
    expect(terminalUrls('ftp://a.dev file:///tmp/x')).toEqual([]);
  });

  it('reads a wrapped line as one, mapping each character back to its cell', async () => {
    const buffer = await bufferOf(10, 'go https://a.dev/long/path now');
    const line = readTerminalLogicalLine(buffer, 2);
    expect(line.text.trimEnd()).toBe('go https://a.dev/long/path now');
    const [url] = terminalUrls(line.text);
    expect(url?.url).toBe('https://a.dev/long/path');
    expect(line.cells[url!.index]).toEqual({ x: 4, y: 1 });
    expect(line.cells[url!.index + url!.url.length - 1]).toEqual({ x: 6, y: 3 });
  });

  it('gives wide characters one character and their first cell', async () => {
    const buffer = await bufferOf(20, '日本 https://a.dev');
    const line = readTerminalLogicalLine(buffer, 1);
    const [url] = terminalUrls(line.text);
    expect(line.cells[url!.index]).toEqual({ x: 6, y: 1 });
  });

  it('marks soft wraps so copied text joins wrapped rows back up', async () => {
    const buffer = await bufferOf(10, 'abcdefghijklm\r\nnext');
    const { text, softWraps } = terminalSelectionText(buffer);
    expect(text.split('\n').slice(0, 3)).toEqual(['abcdefghij', 'klm', 'next']);
    expect([...softWraps]).toEqual([10]);
    expect(joinSoftWraps(text.slice(0, 19), 0, softWraps)).toBe('abcdefghijklm\nnext');
  });

  it('selects the run under a finger, across a soft wrap, trimmed to a URL', async () => {
    const buffer = await bufferOf(12, 'open https://a.dev/xy). ok');
    const { text, softWraps } = terminalSelectionText(buffer);
    const range = terminalWordAt(text, text.indexOf('a.dev'), softWraps)!;
    expect(joinSoftWraps(text.slice(range.start, range.end), range.start, softWraps)).toBe(
      'https://a.dev/xy'
    );
    const word = terminalWordAt(text, 1, softWraps)!;
    expect(text.slice(word.start, word.end)).toBe('open');
    expect(terminalWordAt(text, 4, softWraps)).toBeUndefined();
  });
});
