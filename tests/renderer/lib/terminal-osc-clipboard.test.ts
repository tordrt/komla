import { describe, expect, it } from 'vitest';

import { decodeOsc52Clipboard } from '../../../src/renderer/lib/terminal-osc-clipboard';

describe('decodeOsc52Clipboard', () => {
  it('decodes UTF-8 clipboard content', () => {
    expect(decodeOsc52Clipboard('c;SGVsbG8sIOS4lueVjA==')).toBe('Hello, 世界');
  });

  it('ignores clipboard queries and malformed payloads', () => {
    expect(decodeOsc52Clipboard('c;?')).toBeNull();
    expect(decodeOsc52Clipboard('c;%%%')).toBeNull();
    expect(decodeOsc52Clipboard('missing-separator')).toBeNull();
  });
});
