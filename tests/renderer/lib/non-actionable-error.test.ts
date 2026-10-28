import { describe, expect, it } from 'vitest';

import { shouldSuppressRendererError } from '../../../src/renderer/lib/non-actionable-error';

describe('shouldSuppressRendererError', () => {
  it('suppresses Monaco disposal errors that are already known to be harmless', () => {
    expect(shouldSuppressRendererError(new Error('TextModel got disposed'))).toBe(true);
    expect(shouldSuppressRendererError(new Error('no diff result available'))).toBe(true);
    expect(
      shouldSuppressRendererError(new Error('AbstractContextKeyService has been disposed'))
    ).toBe(true);
  });

  it('suppresses Monaco cancellation errors emitted during editor teardown', () => {
    const error = new Error('Canceled');
    error.name = 'Canceled';

    expect(shouldSuppressRendererError(error)).toBe(true);
  });

  it('does not suppress unrelated errors', () => {
    expect(shouldSuppressRendererError(new Error('Something actually broke'))).toBe(false);
  });
});
