import { describe, expect, it } from 'vitest';

import { setupStepPane } from '../../../src/shared/lib/setup-panes';

describe('setupStepPane', () => {
  it('is the pane a browser or note step opens, and nothing for a terminal', () => {
    expect(setupStepPane({ kind: 'browser' })).toBe('browser');
    expect(setupStepPane({ kind: 'note' })).toBe('note');
    expect(setupStepPane({ kind: 'terminal' })).toBeUndefined();
    expect(setupStepPane({})).toBeUndefined();
  });
});
