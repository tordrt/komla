import { describe, expect, it } from 'vitest';

import { skipTerminalOutput } from '../../../src/shared/lib/terminal-mode-tracker';

describe('skipTerminalOutput', () => {
  it('returns output that fits unchanged', () => {
    expect(skipTerminalOutput('\x1b[?2004hready\r\n', 100)).toBe('\x1b[?2004hready\r\n');
  });

  it('keeps the last characters, starting past an escape sequence the cut fell inside', () => {
    const output = `${'x'.repeat(200)}\x1b[38;2;53;120;200mred\x1b[0m`;

    expect(skipTerminalOutput(output, 12)).toBe('red\x1b[0m');
  });

  it('applies modes the skipped output turned on', () => {
    const output = `\x1b[?1049h\x1b[?2004h\x1b[?1002h\x1b[?1006h${'x'.repeat(200)}tail`;

    expect(skipTerminalOutput(output, 4)).toBe('\x1b[?1049h\x1b[?2004h\x1b[?1002h\x1b[?1006htail');
  });

  // The terminal already has modes from output it parsed before, so turning one off counts too.
  it('applies modes the skipped output turned off', () => {
    const output = `\x1b[?2004l\x1b[?1000l\x1b[?1006l\x1b[?1049l${'x'.repeat(200)}tail`;

    // 1047 leaves the alternate screen without restoring a saved cursor, as 1049 would.
    expect(skipTerminalOutput(output, 4)).toBe('\x1b[?1047l\x1b[?2004l\x1b[?1000l\x1b[?1006ltail');
  });

  it('leaves modes the skipped output never changed to the terminal', () => {
    expect(skipTerminalOutput(`\x1b[31m${'x'.repeat(200)}tail`, 4)).toBe('tail');
  });

  it('applies the last mode set in each group', () => {
    const output = `\x1b[?1049h\x1b[?1000h\x1b[?1003h\x1b[?1049l${'x'.repeat(200)}tail`;

    expect(skipTerminalOutput(output, 4)).toBe('\x1b[?1047l\x1b[?1003htail');
  });

  it('repeats a full reset, then the modes set after it', () => {
    const output = `\x1b[?2004h\x1b[?1049h\x1bc\x1b[?1000h${'x'.repeat(200)}tail`;

    expect(skipTerminalOutput(output, 4)).toBe('\x1bc\x1b[?1000htail');
  });

  it('repeats a soft reset, then the modes set after it', () => {
    const output = `\x1b[?2004h\x1b[!p\x1b[?25l${'x'.repeat(200)}tail`;

    expect(skipTerminalOutput(output, 4)).toBe('\x1b[!p\x1b[?25ltail');
  });

  it('skips the rest of a string sequence the cut fell inside', () => {
    const output = `\x1b]0;${'t'.repeat(200)}\x07done`;

    expect(skipTerminalOutput(output, 10)).toBe('done');
  });
});
