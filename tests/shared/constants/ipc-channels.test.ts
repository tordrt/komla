import { describe, it, expect } from 'vitest';

import { IPC } from '../../../src/shared/constants/ipc-channels';

describe('IPC channels', () => {
  it('has no duplicate channel values', () => {
    const values = Object.values(IPC);
    const unique = new Set(values);
    const duplicates = values.filter((v, i) => values.indexOf(v) !== i);
    expect(duplicates).toEqual([]);
    expect(unique.size).toBe(values.length);
  });

  it('all channel values follow domain:action pattern', () => {
    for (const [key, value] of Object.entries(IPC)) {
      expect(value, `IPC.${key} = '${value}'`).toMatch(/^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/);
    }
  });
});
