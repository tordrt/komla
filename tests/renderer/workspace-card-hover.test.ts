import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const globalsCss = readFileSync(
  new URL('../../src/renderer/styles/globals.css', import.meta.url),
  'utf8'
);

/** The declarations of the top-level rule with exactly this selector. */
function declarations(selector: string): string | undefined {
  const escaped = selector.replace(/[.:]/g, '\\$&');
  return new RegExp(`^${escaped} \\{([^}]*)\\}`, 'm').exec(globalsCss)?.[1];
}

describe('workspace card highlight', () => {
  // A keyboard switch shows the new workspace at once, so a fading highlight trails behind it.
  it('moves the selected background at once and fades it in only on hover', () => {
    expect(declarations('.workspace-card-hover')).toContain('transform 120ms');
    expect(declarations('.workspace-card-hover')).not.toContain('background-color');
    expect(declarations('.workspace-card-hover:hover')).toContain('background-color 150ms');
  });
});
