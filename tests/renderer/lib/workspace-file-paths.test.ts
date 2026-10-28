import { describe, expect, it } from 'vitest';

import { isSameOrInside } from '../../../src/renderer/lib/workspace-file-paths';

describe('isSameOrInside', () => {
  it.each([
    ['the path itself', 'src/app.ts', true],
    ['a file inside it', 'src/app.ts/x', true],
    ['a sibling sharing its prefix', 'src/app.tsx', false],
    ['its folder', 'src', false],
  ])('matches %s', (_, filePath, expected) => {
    expect(isSameOrInside(filePath, ['src/app.ts'])).toBe(expected);
  });
});
