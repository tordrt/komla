import { describe, expect, it } from 'vitest';

import { terminalText } from '../../../src/main/lib/terminal-text';

describe('terminalText', () => {
  it('returns the screen as plain text, without colors or trailing blank lines', async () => {
    const result = await terminalText(
      '\x1b[31mred\x1b[0m line\r\nsecond\r\n',
      { cols: 20, rows: 5 },
      0
    );

    expect(result).toEqual({ text: 'red line\nsecond', bracketedPaste: false });
  });

  it('adds only the history lines asked for above the screen', async () => {
    const output = Array.from({ length: 10 }, (_, index) => `line ${index}`).join('\r\n');

    await expect(terminalText(output, { cols: 20, rows: 3 }, 0)).resolves.toMatchObject({
      text: 'line 7\nline 8\nline 9',
    });
    await expect(terminalText(output, { cols: 20, rows: 3 }, 2)).resolves.toMatchObject({
      text: 'line 5\nline 6\nline 7\nline 8\nline 9',
    });
  });

  it('joins a line the terminal wrapped back into one', async () => {
    await expect(terminalText('abcdefgh', { cols: 5, rows: 3 }, 0)).resolves.toMatchObject({
      text: 'abcdefgh',
    });
  });

  it('keeps a space that falls where the terminal wrapped the line', async () => {
    await expect(terminalText('the error path', { cols: 10, rows: 3 }, 0)).resolves.toMatchObject({
      text: 'the error path',
    });
  });

  it('leaves out the cell a wide character left empty when it wrapped', async () => {
    await expect(terminalText('abcd漢字', { cols: 5, rows: 3 }, 0)).resolves.toMatchObject({
      text: 'abcd漢字',
    });
  });

  it('shows what a full-screen program drew last', async () => {
    const result = await terminalText(
      'shell prompt\r\n\x1b[?1049h\x1b[?2004h\x1b[2J\x1b[H> agent input',
      { cols: 20, rows: 3 },
      10
    );

    expect(result).toEqual({ text: '> agent input', bracketedPaste: true });
  });
});
