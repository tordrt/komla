import { describe, expect, it } from 'vitest';

import { compareSemver } from '../../../src/main/lib/semver';

describe('compareSemver', () => {
  it.each([
    ['3.7.0', '3.6.9', 1],
    ['3.7.0', '3.7.0', 0],
    ['2.0.0', '1.99.99', 1],
    ['1.0', '1.0.0', 0],
    ['1.0', '1.0.1', -1],
    ['3.7.0-staging.3', '3.6.0-staging.1', 1],
    ['3.7.0-staging.10', '3.7.0-staging.9', 1],
    ['3.7.0', '3.7.0-staging.3', 1],
    ['3.7.0-staging.3', '3.7.0', -1],
    ['3.10.0', '3.9.0', 1],
    ['3.7.0-alpha', '3.7.0-beta', -1],
    ['3.7.0-staging', '3.7.0-staging.1', -1],
  ])('compares %s with %s', (a, b, sign) => {
    expect(Math.sign(compareSemver(a, b))).toBe(sign);
  });
});
