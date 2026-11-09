import { describe, expect, it } from 'vitest';

import { parseHookJournalEntry } from '../../../src/main/services/terminal-attention/hook-journal';

describe('a Hook Journal entry', () => {
  it('is taken as a copy, as a relayed interrupt has to be', () => {
    // As the companion journals an interrupt it relays.
    const entry = parseHookJournalEntry(
      '{"owner":"a","copiedTo":["b"],"writtenAtMs":1794062730999,"hook":{"deliveryId":"34b4","terminalId":"t1","cwd":"/repo","kind":"interrupted","source":"claude-code","message":"","hookInput":{}}}'
    );

    expect(entry).toEqual({
      owner: 'a',
      copiedTo: ['b'],
      writtenAt: 1794062730999,
      hook: expect.objectContaining({ kind: 'interrupted', terminalId: 't1', copy: true }),
    });
  });

  it('names the done the user saw, as the companion journals word of one it relays', () => {
    const entry = parseHookJournalEntry(
      '{"owner":"a","copiedTo":[],"writtenAtMs":1794062730999,"hook":{"deliveryId":"34b5","terminalId":"t1","cwd":"/repo","kind":"seen","source":"claude-code","message":"","hookInput":{"seen_delivery_id":"34b4"}}}'
    );

    expect(entry?.hook).toEqual(
      expect.objectContaining({
        kind: 'seen',
        copy: true,
        hookInput: { seen_delivery_id: '34b4' },
      })
    );
  });

  it('is none for what the companion wouldn’t write', () => {
    const hook = { terminalId: 't1', cwd: '/repo', kind: 'activity', source: 'claude-code' };

    for (const text of [
      '{',
      JSON.stringify({ owner: 'a', writtenAtMs: 1, hook: { ...hook, kind: 'bogus' } }),
      JSON.stringify({ owner: 'a', writtenAtMs: 1, hook: { ...hook, cwd: '' } }),
      JSON.stringify({ owner: 'a', writtenAtMs: -1, hook }),
      JSON.stringify({ owner: '', writtenAtMs: 1, hook }),
      JSON.stringify({ owner: 'a', writtenAtMs: 1, hook: [hook] }),
    ]) {
      expect(parseHookJournalEntry(text)).toBeUndefined();
    }
    // Written before the journal said who got copies.
    expect(
      parseHookJournalEntry(JSON.stringify({ owner: 'a', writtenAtMs: 1, hook }))?.copiedTo
    ).toEqual([]);
  });
});
