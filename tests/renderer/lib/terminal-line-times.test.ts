/**
 * @vitest-environment jsdom
 */
import { Terminal } from '@xterm/xterm';
import { describe, expect, it } from 'vitest';

import { createTerminalLineTimes } from '../../../src/renderer/lib/terminal-line-times';

function setup(scrollback = 100, paused = () => false) {
  let time = 0;
  const terminal = new Terminal({ cols: 40, rows: 5, scrollback, allowProposedApi: true });
  const lineTimes = createTerminalLineTimes(terminal, { now: () => time, paused });
  const write = (at: number, data: string) => {
    time = at;
    lineTimes.noteWrite();
    return new Promise<void>((resolve) => terminal.write(data, resolve));
  };
  const times = () => lineTimes.timesOf(0, terminal.buffer.active.length);
  return { terminal, write, times };
}

describe('createTerminalLineTimes', () => {
  it('times each line by the write that printed it, to within two seconds', async () => {
    const { write, times } = setup();

    await write(10_000, 'one\r\ntwo\r\n');
    await write(11_000, 'three\r\n');
    await write(60_000, 'four\r\n');

    expect(times().slice(0, 5)).toEqual([10_000, 10_000, 10_000, 60_000, 60_000]);
  });

  it('gives no time to lines written while paused, as replayed output', async () => {
    let replaying = true;
    const { write, times } = setup(100, () => replaying);

    await write(10_000, 'old\r\n\x1b[1Aolder\r\n');
    replaying = false;
    await write(20_000, 'new\r\n');

    expect(times().slice(0, 3)).toEqual([undefined, 20_000, 20_000]);
  });

  it('keeps replayed lines untimed after many writes, timing the oldest kept lines too early', async () => {
    let replaying = true;
    const { write, times } = setup(500, () => replaying);

    await write(0, 'old\r\n');
    replaying = false;
    for (let i = 1; i <= 101; i++) await write(i * 10_000, `${i}\r\n`);

    const all = times();
    expect(all[0]).toBeUndefined();
    // The first two writes share a time: the older's.
    expect(all.slice(1, 4)).toEqual([10_000, 10_000, 30_000]);
    expect(all[101]).toBe(1_010_000);
  });

  it('forgets the times of lines a program rewrites', async () => {
    const { write, times } = setup();

    await write(10_000, 'one\r\ntwo\r\nthree\r\n');
    // Moves the cursor up two lines and rewrites them.
    await write(20_000, '\x1b[2Aagain\r\n');

    expect(times().slice(0, 3)).toEqual([10_000, 20_000, 20_000]);
  });

  it('keeps the lines above the screen when a program moves past its top', async () => {
    const { write, times } = setup();

    await write(10_000, '1\r\n2\r\n3\r\n4\r\n5\r\n6\r\n7');
    await write(20_000, '\x1b[99Aagain');

    // Five rows show 3 to 7, so 1 and 2 are scrollback.
    expect(times().slice(0, 7)).toEqual([10_000, 10_000, 20_000, 20_000, 20_000, 20_000, 20_000]);
  });

  it('keeps times as lines leave the scrollback', async () => {
    // c and d stay of the first write; a and b leave the two lines of scrollback.
    const { write, times } = setup(2);

    await write(10_000, 'a\r\nb\r\nc\r\nd\r\n');
    await write(20_000, 'e\r\nf\r\ng\r\nh\r\n');

    expect(times()).toEqual([10_000, 10_000, 20_000, 20_000, 20_000, 20_000, 20_000]);
  });

  it('has no times on the alternate screen', async () => {
    const { write, times } = setup();

    await write(10_000, '\x1b[?1049hfull screen\r\n');

    expect(times()).toEqual([]);
  });
});
