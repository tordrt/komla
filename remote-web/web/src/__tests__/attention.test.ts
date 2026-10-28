import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { attentionLabel, attentionMessageIsLabel } from '../attention';

describe('remote workspace attention', () => {
  it('uses marked custom titles as the badge label for every kind', () => {
    const attention = {
      kind: 'error' as const,
      source: 'komla:custom-title:custom-hook',
      updatedAt: 123,
      message: 'Tests failed',
    };

    expect(attentionLabel(attention)).toBe('Tests failed');
    expect(attentionMessageIsLabel(attention)).toBe(true);
  });

  it('keeps ordinary lifecycle detail out of non-generic labels', () => {
    const attention = {
      kind: 'error' as const,
      source: 'custom-hook',
      updatedAt: 123,
      message: 'Three tests failed',
    };

    expect(attentionLabel(attention)).toBe('Error');
    expect(attentionMessageIsLabel(attention)).toBe(false);
  });

  it('bounds long badge labels with an ellipsis', () => {
    const styles = readFileSync(fileURLToPath(new URL('../styles.css', import.meta.url)), 'utf8');
    const badgeRule = styles.match(/\.workspace-badge\s*\{([^}]*)\}/)?.[1] ?? '';

    expect(badgeRule).toContain('max-width: 128px');
    expect(badgeRule).toContain('overflow: hidden');
    expect(badgeRule).toContain('text-overflow: ellipsis');
    expect(badgeRule).toContain('white-space: nowrap');
  });
});
