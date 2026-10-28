import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { TerminalPresentation } from '../../../src/main/lib/terminal-presentation';

const execFileAsync = promisify(execFile);

describe('TerminalPresentation', () => {
  it('loads through the native ESM loader used by Electron', async () => {
    const moduleUrl = pathToFileURL(resolve('src/main/lib/terminal-presentation.ts')).href;

    await expect(
      execFileAsync(process.execPath, [
        '--experimental-transform-types',
        '--input-type=module',
        '--eval',
        `await import(${JSON.stringify(moduleUrl)})`,
      ])
    ).resolves.toBeDefined();
  });

  it('keeps recent output so a reconnecting phone gets only what it missed', () => {
    const presentation = new TerminalPresentation({ cols: 20, rows: 3, generation: 1, seq: 4 });
    presentation.write('a', 5);
    presentation.write('b', 6);
    presentation.write('c', 7);

    expect(presentation.outputSince(5)).toEqual([
      { data: 'b', seq: 6 },
      { data: 'c', seq: 7 },
    ]);
    expect(presentation.outputSince(7)).toEqual([]);
    expect(presentation.outputSince(4)).toHaveLength(3);
    // Before this presentation started, or output it hasn't seen.
    expect(presentation.outputSince(3)).toBeNull();
    expect(presentation.outputSince(8)).toBeNull();
  });

  it('cannot replay output older than what it still keeps', () => {
    const presentation = new TerminalPresentation({ cols: 20, rows: 3, generation: 1, seq: 0 });
    for (let seq = 1; seq <= 5; seq++) presentation.write('x'.repeat(100 * 1024), seq);

    expect(presentation.outputSince(1)).toBeNull();
    expect(presentation.outputSince(4)).toEqual([{ data: 'x'.repeat(100 * 1024), seq: 5 }]);
  });

  it('cannot replay across a resize, since that output was laid out for another size', () => {
    const presentation = new TerminalPresentation({ cols: 20, rows: 3, generation: 1, seq: 0 });
    presentation.write('before', 1);
    presentation.resize(20, 3);
    presentation.write('same size', 2);

    expect(presentation.outputSince(0)).toHaveLength(2);
    presentation.resize(40, 10);
    presentation.write('after', 3);

    expect(presentation.outputSince(1)).toBeNull();
    expect(presentation.outputSince(2)).toEqual([{ data: 'after', seq: 3 }]);
  });

  it('serializes only the visible screen when asked for no scrollback', async () => {
    const presentation = new TerminalPresentation({ cols: 20, rows: 3, generation: 1, seq: 0 });
    presentation.write('line 1\r\nline 2\r\nline 3\r\nline 4\r\nline 5', 1);

    const full = await presentation.snapshot();
    const screen = await presentation.snapshot({ scrollback: 0 });

    expect(full.buffer).toContain('line 1');
    expect(screen.buffer).not.toContain('line 2');
    expect(screen.buffer).toContain('line 3');
    expect(screen.buffer).toContain('line 5');
    expect(screen.seq).toBe(1);
  });

  it('serializes authoritative screen state after queued output is parsed', async () => {
    const presentation = new TerminalPresentation({
      cols: 20,
      rows: 4,
      generation: 3,
      seq: 7,
    });

    presentation.write('\x1b[31mred\x1b[0m\r\nnext', 8);
    const snapshot = await presentation.snapshot();

    expect(snapshot).toMatchObject({
      cols: 20,
      rows: 4,
      generation: 3,
      seq: 8,
    });
    expect(snapshot.buffer).toContain('red');
    expect(snapshot.buffer).toContain('next');
    expect(snapshot.buffer).toContain('\x1b[31m');
    presentation.dispose();
  });

  it('restores the mouse encoding a program chose, which serializing leaves out', async () => {
    const presentation = new TerminalPresentation({ cols: 20, rows: 4, generation: 1, seq: 0 });

    presentation.write('\x1b[?1049h\x1b[?1002h\x1b[?1006hfullscreen', 1);
    const sgr = await presentation.snapshot();
    expect(sgr.buffer).toContain('\x1b[?1002h');
    expect(sgr.buffer.endsWith('\x1b[?1006h')).toBe(true);

    presentation.write('\x1b[?1016h', 2);
    expect((await presentation.snapshot()).buffer.endsWith('\x1b[?1016h')).toBe(true);

    presentation.write('\x1b[?1006l', 3);
    const reset = await presentation.snapshot();
    expect(reset.buffer).not.toContain('\x1b[?1006h');
    expect(reset.buffer).not.toContain('\x1b[?1016h');

    presentation.write('\x1b[?1006h\x1bc', 4);
    expect((await presentation.snapshot()).buffer).not.toContain('\x1b[?1006h');
    presentation.dispose();
  });

  it('captures output queued while an earlier parse is in flight exactly once', async () => {
    const presentation = new TerminalPresentation({
      cols: 20,
      rows: 4,
      generation: 1,
      seq: 0,
    });

    presentation.write('first', 1);
    presentation.write(' second', 2);
    const snapshot = await presentation.snapshot();

    expect(snapshot.seq).toBe(2);
    expect(snapshot.buffer.match(/first/g)).toHaveLength(1);
    expect(snapshot.buffer.match(/second/g)).toHaveLength(1);
    presentation.dispose();
  });

  it('parses queued output at the width it was written for before resizing', async () => {
    const presentation = new TerminalPresentation({
      cols: 10,
      rows: 4,
      generation: 1,
      seq: 0,
    });

    // Cursor to the right edge, then a marker: its column depends on the width
    // in effect when the output is parsed, and a later resize does not move it.
    presentation.write('\x1b[999CX', 1);
    presentation.resize(20, 4);
    const snapshot = await presentation.snapshot();

    expect(snapshot).toMatchObject({ cols: 20, rows: 4, seq: 1 });
    expect(snapshot.buffer).toBe('\x1b[9CX');
    presentation.dispose();
  });

  it('serializes using the current canonical dimensions', async () => {
    const presentation = new TerminalPresentation({
      cols: 80,
      rows: 24,
      generation: 1,
      seq: 0,
    });

    presentation.resize(48, 18);
    const snapshot = await presentation.snapshot();

    expect(snapshot).toMatchObject({ cols: 48, rows: 18 });
    presentation.dispose();
  });
});
