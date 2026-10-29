import { describe, expect, it } from 'vitest';

import { createWorkspaceId } from '../../../src/main/lib/workspace-id';

describe('createWorkspaceId', () => {
  it('makes ids of ten lowercase letters and digits, starting with a letter', () => {
    for (let i = 0; i < 1000; i++) {
      expect(createWorkspaceId()).toMatch(/^[a-z][0-9a-z]{9}$/);
    }
  });

  it('makes a different id each time', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => createWorkspaceId()));
    expect(ids.size).toBe(1000);
  });
});
