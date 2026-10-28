import { describe, expect, it } from 'vitest';

import { buildTerminalApiUrl } from '../../../src/shared/lib/komla-api-url';

describe('buildTerminalApiUrl', () => {
  it('appends an encoded terminal context to an origin', () => {
    expect(buildTerminalApiUrl('http://127.0.0.1:52863/', 'term/value')).toBe(
      'http://127.0.0.1:52863/terminals/term%2Fvalue'
    );
  });
});
