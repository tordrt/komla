import { describe, expect, it } from 'vitest';

import {
  normalizeRecentProjectIds,
  orderByRecentUse,
  withRecentProject,
} from '../../../src/shared/lib/recent-projects';

describe('withRecentProject', () => {
  it('puts a new project first', () => {
    expect(withRecentProject(['a', 'b', 'c'], 'd')).toEqual(['d', 'a', 'b', 'c']);
  });

  it('moves a project already in the list to the front', () => {
    expect(withRecentProject(['a', 'b', 'c'], 'c')).toEqual(['c', 'a', 'b']);
  });
});

describe('normalizeRecentProjectIds', () => {
  it('keeps distinct ids', () => {
    expect(normalizeRecentProjectIds(['a', 'a', 'b'])).toEqual(['a', 'b']);
  });

  it('drops values that are not ids', () => {
    expect(normalizeRecentProjectIds(['a', 1, '', null, 'b'])).toEqual(['a', 'b']);
    expect(normalizeRecentProjectIds('a')).toEqual([]);
    expect(normalizeRecentProjectIds(undefined)).toEqual([]);
  });
});

describe('orderByRecentUse', () => {
  const projects = ['a', 'b', 'c', 'd'].map((id) => ({ id }));

  it('lists used projects most recent first, then the rest in their order', () => {
    expect(orderByRecentUse(projects, ['c', 'removed', 'a']).map(({ id }) => id)).toEqual([
      'c',
      'a',
      'b',
      'd',
    ]);
  });

  it('keeps the order when nothing was used', () => {
    expect(orderByRecentUse(projects, []).map(({ id }) => id)).toEqual(['a', 'b', 'c', 'd']);
  });
});
