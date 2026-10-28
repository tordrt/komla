import { encodedJsonBytes, MAX_ENCRYPTED_BODY_BYTES } from '@komla/remote-protocol';
import { describe, expect, it } from 'vitest';

import { splitTerminalInput, TerminalStreamCursor, WorkspacePages } from '../terminal-stream';

describe('terminal stream cursor', () => {
  it('applies newer output once and skips what the snapshot already covered', () => {
    const cursor = new TerminalStreamCursor();
    cursor.reset(1, 7);

    expect(cursor.accept({ generation: 1, seq: 7 })).toBe(false);
    expect(cursor.accept({ generation: 1, seq: 8 })).toBe(true);
    expect(cursor.accept({ generation: 1, seq: 8 })).toBe(false);
    expect(cursor.accept({ generation: 2, seq: 9 })).toBe(false);
  });

  it('applies every piece of a split read, then nothing more for that seq', () => {
    const cursor = new TerminalStreamCursor();
    cursor.reset(1, 7);

    expect(cursor.accept({ generation: 1, seq: 8, more: true })).toBe(true);
    expect(cursor.accept({ generation: 1, seq: 8, more: true })).toBe(true);
    expect(cursor.accept({ generation: 1, seq: 8 })).toBe(true);
    expect(cursor.accept({ generation: 1, seq: 8 })).toBe(false);
    expect(cursor.accept({ generation: 1, seq: 9 })).toBe(true);
  });

  it('reports what the screen shows so a reconnect can resume from there', () => {
    const cursor = new TerminalStreamCursor();
    expect(cursor.resumePoint()).toBeNull();

    cursor.reset(2, 7);
    expect(cursor.resumePoint()).toEqual({ generation: 2, seq: 7 });
    cursor.accept({ generation: 2, seq: 8, more: true });
    // Half of a split read is on screen; only a snapshot can repair that.
    expect(cursor.resumePoint()).toBeNull();
    cursor.accept({ generation: 2, seq: 8 });
    expect(cursor.resumePoint()).toEqual({ generation: 2, seq: 8 });
    cursor.clear();
    expect(cursor.resumePoint()).toBeNull();
  });

  it('starts over after a reset to a new generation', () => {
    const cursor = new TerminalStreamCursor();
    cursor.reset(1, 7);
    cursor.accept({ generation: 1, seq: 8, more: true });
    cursor.reset(2, 3);

    expect(cursor.accept({ generation: 1, seq: 8 })).toBe(false);
    expect(cursor.accept({ generation: 2, seq: 3 })).toBe(false);
    expect(cursor.accept({ generation: 2, seq: 4 })).toBe(true);
  });
});

describe('workspace pages', () => {
  it('returns the list once its last page arrives', () => {
    const pages = new WorkspacePages<string>();

    expect(pages.add({ requestId: 'r1', workspaces: ['a', 'b'], more: true })).toBeNull();
    expect(pages.add({ requestId: 'push', workspaces: ['x'] })).toEqual(['x']);
    expect(pages.add({ requestId: 'r1', workspaces: ['c'], more: true })).toBeNull();
    expect(pages.add({ requestId: 'r1', workspaces: ['d'] })).toEqual(['a', 'b', 'c', 'd']);
    expect(pages.add({ requestId: 'r1', workspaces: [] })).toEqual([]);
  });
});

describe('terminal input', () => {
  it('splits a paste too large for one frame', () => {
    const paste = '貼り付け'.repeat(10_000);
    const pieces = splitTerminalInput('terminal-1', paste, MAX_ENCRYPTED_BODY_BYTES);

    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.join('')).toBe(paste);
    for (const data of pieces) {
      const frame = { type: 'app:terminal:input', terminalId: 'terminal-1', data };
      expect(encodedJsonBytes(frame)).toBeLessThanOrEqual(MAX_ENCRYPTED_BODY_BYTES);
    }
  });

  it('keeps ordinary input in one frame', () => {
    expect(splitTerminalInput('terminal-1', 'ls -la\r', MAX_ENCRYPTED_BODY_BYTES)).toEqual([
      'ls -la\r',
    ]);
  });
});
