import { describe, expect, it } from 'vitest';

import { TerminalReplayTail } from '../../../src/main/lib/terminal-replay-tail';

const filler = (lines: number): string =>
  Array.from({ length: lines }, (_, i) => `line ${i}\r\n`).join('');

describe('TerminalReplayTail', () => {
  it('replays everything unchanged while nothing has been dropped', () => {
    const tail = new TerminalReplayTail(1000);
    tail.append('\x1b[?2004h$ ');
    tail.append('\x1b[38;2;53;120;200mready\x1b[0m\r\n');

    expect(tail.toString()).toBe('\x1b[?2004h$ \x1b[38;2;53;120;200mready\x1b[0m\r\n');
  });

  it('starts the replay after an escape sequence the cut fell inside', () => {
    const tail = new TerminalReplayTail(12);
    tail.append('x'.repeat(200));
    tail.append('\x1b[38;2;53;120;200mred\x1b[0m');

    expect(tail.toString()).toBe('red\x1b[0m');
  });

  it('finds an escape sequence the cut fell inside even when it began in dropped output', () => {
    const tail = new TerminalReplayTail(12);
    tail.append('x'.repeat(200));
    tail.append('\x1b[38;2;53;1');
    tail.append('20;200mred\x1b[0m');
    tail.append('!');

    expect(tail.toString()).toBe('red\x1b[0m!');
  });

  it('starts at the cut in plain text, keeping the end of a long line', () => {
    const tail = new TerminalReplayTail(100);
    tail.append(filler(5));
    tail.append(`${'a'.repeat(300)}\r\n$ `);

    expect(tail.toString()).toBe(`${'a'.repeat(96)}\r\n$ `);
  });

  it('restores the modes the program set before the cut, and only those still on', () => {
    const tail = new TerminalReplayTail(100);
    tail.append('\x1b[?2004h\x1b[?1004h\x1b[?1000;1006h\x1b=\x1b[?25l');
    tail.append('\x1b[?1h\x1b[?1l');
    tail.append(filler(50));

    const snapshot = tail.toString();
    const restored = snapshot.slice(0, snapshot.indexOf('line'));
    for (const mode of ['\x1b[?2004h', '\x1b[?1004h', '\x1b[?1000h', '\x1b[?1006h', '\x1b[?25l']) {
      expect(restored).toContain(mode);
    }
    expect(restored).toContain('\x1b[?66h');
    expect(restored).not.toContain('\x1b[?1h');
  });

  it('enters the alternate screen first when the cut falls while it is active', () => {
    const tail = new TerminalReplayTail(100);
    tail.append('$ codex\r\n\x1b[?1049h\x1b[?2004h');
    tail.append(filler(50));

    expect(tail.toString().startsWith('\x1b[?1049h')).toBe(true);
  });

  it('follows a mode change split across chunks', () => {
    const tail = new TerminalReplayTail(100);
    tail.append('prompt \x1b[?20');
    tail.append('04h');
    tail.append(filler(50));

    expect(tail.toString()).toContain('\x1b[?2004h');
  });

  it('skips the rest of a string sequence the cut fell inside', () => {
    const tail = new TerminalReplayTail(100);
    tail.append(filler(5));
    tail.append(`\x1b]52;c;${'QUJD'.repeat(100)}\x07after\r\n`);

    expect(tail.toString()).toBe('after\r\n');
  });

  it('forgets earlier modes after a full reset', () => {
    const tail = new TerminalReplayTail(100);
    tail.append('\x1b[?2004h\x1b[?1049h');
    tail.append('\x1bc');
    tail.append(filler(50));

    expect(tail.toString()).toBe(filler(50).slice(-100));
  });

  it('forgets cursor, keypad and paste modes after a soft reset, but keeps the mouse', () => {
    const tail = new TerminalReplayTail(100);
    tail.append('\x1b[?25l\x1b[?1h\x1b=\x1b[?2004h\x1b[?1000h\x1b[!');
    tail.append('p');
    tail.append(filler(50));

    expect(tail.toString()).toBe(`\x1b[?1000h${filler(50).slice(-100)}`);
  });
});
