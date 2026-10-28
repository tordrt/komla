import { describe, expect, it } from 'vitest';

import { getProjectMoveIndex } from '../../../src/renderer/lib/project-order';

import type { Project } from '../../../src/renderer/types';

const projects = [
  { id: 'c', order: 2 },
  { id: 'a', order: 0 },
  { id: 'b', order: 1 },
] as Project[];

describe('getProjectMoveIndex', () => {
  it('moves a project before or after another in project order', () => {
    expect(getProjectMoveIndex(projects, 'c', 'a', 'before')).toBe(0);
    expect(getProjectMoveIndex(projects, 'a', 'c', 'after')).toBe(2);
    expect(getProjectMoveIndex(projects, 'a', 'c', 'before')).toBe(1);
  });

  it('returns null when the project is already there', () => {
    expect(getProjectMoveIndex(projects, 'a', 'b', 'before')).toBeNull();
    expect(getProjectMoveIndex(projects, 'b', 'a', 'after')).toBeNull();
  });

  it('returns null for unknown projects', () => {
    expect(getProjectMoveIndex(projects, 'x', 'a', 'before')).toBeNull();
    expect(getProjectMoveIndex(projects, 'a', 'x', 'after')).toBeNull();
  });
});
