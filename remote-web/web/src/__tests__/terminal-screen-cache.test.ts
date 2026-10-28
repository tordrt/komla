import { Terminal } from '@xterm/headless';
import type { Terminal as BrowserTerminal } from '@xterm/xterm';
import { describe, expect, it } from 'vitest';

import { TerminalScreenCache, trackMouseEncoding } from '../terminal-screen-cache';

const screen = (seq: number) => ({ data: `screen ${seq}`, generation: 1, seq, cols: 40, rows: 12 });

describe('terminal screen cache', () => {
  it('keeps the most recently used screens up to its capacity', () => {
    const cache = new TerminalScreenCache(() => 0, 2);
    cache.remember('a', screen(1));
    cache.remember('b', screen(2));
    // Reading a screen makes it recent again.
    expect(cache.read('a')?.seq).toBe(1);
    cache.remember('c', screen(3));
    expect(cache.read('b')).toBeNull();
    expect(cache.read('a')?.seq).toBe(1);
    expect(cache.read('c')?.seq).toBe(3);
  });

  it('replaces a terminal’s screen and leaves it cached after a read', () => {
    const cache = new TerminalScreenCache();
    cache.remember('a', screen(1));
    cache.remember('a', screen(7));
    expect(cache.read('a')?.seq).toBe(7);
    expect(cache.read('a')?.seq).toBe(7);
    cache.delete('a');
    expect(cache.read('a')).toBeNull();
  });

  it('forgets screens left unused too long', () => {
    let now = 0;
    const cache = new TerminalScreenCache(() => now, 5, 1000);
    cache.remember('a', screen(1));
    now = 900;
    expect(cache.read('a')).not.toBeNull();
    now = 1800;
    expect(cache.read('a')).not.toBeNull();
    now = 2801;
    expect(cache.read('a')).toBeNull();
  });
});

describe('mouse encoding tracking', () => {
  async function encodingAfter(data: string): Promise<string> {
    const term = new Terminal({ cols: 20, rows: 4, allowProposedApi: true });
    const tracker = trackMouseEncoding(term as unknown as BrowserTerminal);
    await new Promise<void>((resolve) => term.write(data, resolve));
    return tracker.restoreSequence();
  }

  it('restores the SGR encoding a program turned on', async () => {
    expect(await encodingAfter('\x1b[?1002h\x1b[?1006h')).toBe('\x1b[?1006h');
    expect(await encodingAfter('\x1b[?1000;1016h')).toBe('\x1b[?1016h');
  });

  it('restores nothing once the program turned it off or reset the terminal', async () => {
    expect(await encodingAfter('')).toBe('');
    expect(await encodingAfter('\x1b[?1006h\x1b[?1006l')).toBe('');
    expect(await encodingAfter('\x1b[?1006h\x1bc')).toBe('');
  });

  it('restores nothing after forget, which a term.reset() call needs', async () => {
    const term = new Terminal({ cols: 20, rows: 4, allowProposedApi: true });
    const tracker = trackMouseEncoding(term as unknown as BrowserTerminal);
    await new Promise<void>((resolve) => term.write('\x1b[?1006h', resolve));
    tracker.forget();
    expect(tracker.restoreSequence()).toBe('');
  });
});
