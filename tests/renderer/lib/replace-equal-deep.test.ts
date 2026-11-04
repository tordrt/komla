import { describe, expect, it } from 'vitest';

import { replaceEqualDeep } from '../../../src/renderer/lib/replace-equal-deep';

describe('replaceEqualDeep', () => {
  it('returns the previous value when the next one is deeply equal', () => {
    const prev = [{ id: 'a', terminals: [{ id: 't1', title: 'x' }], backend: { kind: 'local' } }];
    const next = JSON.parse(JSON.stringify(prev));
    expect(replaceEqualDeep(prev, next)).toBe(prev);
  });

  it('keeps unchanged parts and replaces changed ones', () => {
    const prev = [
      {
        id: 'a',
        terminals: [{ id: 't1' }, { id: 't2', title: 'old' }],
        backend: { kind: 'local' },
      },
      { id: 'b', terminals: [], backend: { kind: 'local' } },
    ];
    const next = JSON.parse(JSON.stringify(prev));
    next[0].terminals[1].title = 'new';

    const result = replaceEqualDeep(prev, next);

    expect(result).not.toBe(prev);
    expect(result).toEqual(next);
    expect(result[1]).toBe(prev[1]);
    expect(result[0]).not.toBe(prev[0]);
    expect(result[0].backend).toBe(prev[0].backend);
    expect(result[0].terminals[0]).toBe(prev[0].terminals[0]);
    expect(result[0].terminals[1]).not.toBe(prev[0].terminals[1]);
  });

  it('notices added, removed and reordered entries', () => {
    const a = { id: 'a' };
    const b = { id: 'b' };
    expect(replaceEqualDeep([a, b], [{ id: 'a' }])).toEqual([{ id: 'a' }]);
    expect(replaceEqualDeep([a], [{ id: 'a' }, { id: 'b' }])).toHaveLength(2);
    const reordered = replaceEqualDeep([a, b], [{ id: 'b' }, { id: 'a' }]);
    expect(reordered).toEqual([{ id: 'b' }, { id: 'a' }]);
    const { x: _x, ...withoutX } = { x: 1, y: 2 };
    expect(replaceEqualDeep({ x: 1, y: 2 }, withoutX)).toEqual({ y: 2 });
    expect(replaceEqualDeep({ y: 2 }, { y: 2, x: undefined })).toEqual({ y: 2, x: undefined });
  });

  it('takes the next value for anything that is not a plain object or array', () => {
    const date = new Date(0);
    expect(replaceEqualDeep(new Date(0), date)).toBe(date);
    const set = new Set([1]);
    expect(replaceEqualDeep(new Set([1]), set)).toBe(set);
    expect(replaceEqualDeep(1, 2)).toBe(2);
    expect(replaceEqualDeep('a', 'a')).toBe('a');
    expect(replaceEqualDeep(null, { a: 1 })).toEqual({ a: 1 });
    expect(Number.isNaN(replaceEqualDeep(NaN, NaN))).toBe(true);
  });
});
