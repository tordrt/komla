import { describe, expect, it } from 'vitest';

import { notifiesCiFinished } from '../../../src/shared/lib/pull-request-ci';

describe('notifiesCiFinished', () => {
  it('notifies while the Pull request item shows and its switch is on, as both are by default', () => {
    expect(notifiesCiFinished({})).toBe(true);
    expect(notifiesCiFinished({ pullRequestCiNotifications: false })).toBe(false);
    expect(notifiesCiFinished({ statusBarHiddenItems: ['notes'] })).toBe(true);
    expect(notifiesCiFinished({ statusBarHiddenItems: ['pull-request'] })).toBe(false);
    // The whole status bar hidden hides the item too.
    expect(notifiesCiFinished({ showStatusBar: false })).toBe(false);
  });
});
