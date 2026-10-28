import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getSystemIdleState } = vi.hoisted(() => ({
  getSystemIdleState: vi.fn<(threshold: number) => string>(),
}));
vi.mock('electron', () => ({ powerMonitor: { getSystemIdleState } }));

import { AWAY_IDLE_SECONDS, isUserAway } from '../../../src/main/lib/user-presence';

describe('isUserAway', () => {
  beforeEach(() => {
    getSystemIdleState.mockReset();
  });

  it.each([
    ['locked', true],
    ['idle', true],
    ['active', false],
    ['unknown', false],
  ])('counts a %s system as away: %s', (state, away) => {
    getSystemIdleState.mockReturnValue(state);
    expect(isUserAway()).toBe(away);
    expect(getSystemIdleState).toHaveBeenCalledWith(AWAY_IDLE_SECONDS);
  });

  it('counts the user as present when the system cannot tell', () => {
    getSystemIdleState.mockImplementation(() => {
      throw new Error('not supported');
    });
    expect(isUserAway()).toBe(false);
  });
});
