import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  getContextLossAction,
  shouldProceedWithRetry,
  createRecoveryState,
  resetRecoveryState,
  MAX_WEBGL_RETRIES,
  type WebGLRecoveryState,
} from '../../../src/renderer/lib/webgl-recovery';

describe('WebGL context-loss recovery', () => {
  describe('getContextLossAction', () => {
    it('returns skip-hidden when tab is not active', () => {
      expect(getContextLossAction(false, 0)).toBe('skip-hidden');
    });

    it('returns skip-hidden regardless of retry count when tab is not active', () => {
      expect(getContextLossAction(false, 5)).toBe('skip-hidden');
    });

    it('returns schedule-retry when tab is active and under retry limit', () => {
      expect(getContextLossAction(true, 0)).toBe('schedule-retry');
    });

    it('returns max-retries-reached when tab is active but retries exhausted', () => {
      expect(getContextLossAction(true, MAX_WEBGL_RETRIES)).toBe('max-retries-reached');
    });

    it('returns max-retries-reached when retry count exceeds limit', () => {
      expect(getContextLossAction(true, MAX_WEBGL_RETRIES + 1)).toBe('max-retries-reached');
    });
  });

  describe('shouldProceedWithRetry', () => {
    it('proceeds when all conditions are met', () => {
      expect(shouldProceedWithRetry(true, true, true)).toBe(true);
    });

    it('skips when tab became hidden during delay', () => {
      expect(shouldProceedWithRetry(false, true, true)).toBe(false);
    });

    it('skips when terminal element is gone', () => {
      expect(shouldProceedWithRetry(true, false, true)).toBe(false);
    });

    it('skips when terminal is no longer cached', () => {
      expect(shouldProceedWithRetry(true, true, false)).toBe(false);
    });

    it('skips when multiple conditions fail', () => {
      expect(shouldProceedWithRetry(false, false, false)).toBe(false);
    });
  });

  describe('resetRecoveryState', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('resets retry count to zero', () => {
      const state: WebGLRecoveryState = { retryCount: 1, retryTimer: null };
      resetRecoveryState(state);
      expect(state.retryCount).toBe(0);
    });

    it('clears pending timer', () => {
      const callback = vi.fn();
      const state: WebGLRecoveryState = {
        retryCount: 1,
        retryTimer: setTimeout(callback, 2000),
      };

      resetRecoveryState(state);

      expect(state.retryTimer).toBeNull();
      expect(state.retryCount).toBe(0);

      // Advance past the timer — callback should NOT fire
      vi.advanceTimersByTime(3000);
      expect(callback).not.toHaveBeenCalled();
    });

    it('is safe to call when no timer is pending', () => {
      const state: WebGLRecoveryState = { retryCount: 0, retryTimer: null };
      expect(() => resetRecoveryState(state)).not.toThrow();
      expect(state.retryCount).toBe(0);
      expect(state.retryTimer).toBeNull();
    });
  });

  describe('recovery state machine integration', () => {
    it('models hide/show within retry window: reset cancels pending timer', () => {
      vi.useFakeTimers();
      try {
        const state = createRecoveryState();
        const retryCallback = vi.fn();

        // 1. Context loss while active → schedule retry
        expect(getContextLossAction(true, state.retryCount)).toBe('schedule-retry');
        state.retryCount++;
        state.retryTimer = setTimeout(retryCallback, 2000);

        // 2. Tab hidden → reset cancels the pending timer and restores retry budget
        resetRecoveryState(state);
        expect(state.retryTimer).toBeNull();
        expect(state.retryCount).toBe(0);

        // 3. Tab shown → visibility effect restores WebGL (simulated externally).
        //    The old timer must NOT fire.
        vi.advanceTimersByTime(3000);
        expect(retryCallback).not.toHaveBeenCalled();

        // 4. Retry budget is fresh for future context losses
        expect(getContextLossAction(true, state.retryCount)).toBe('schedule-retry');
      } finally {
        vi.useRealTimers();
      }
    });

    it('reset allows retries after dispose cycle', () => {
      const state = createRecoveryState();

      // Exhaust retries
      state.retryCount = MAX_WEBGL_RETRIES;
      expect(getContextLossAction(true, state.retryCount)).toBe('max-retries-reached');

      // Dispose (tab hidden → effect disposes WebGL)
      resetRecoveryState(state);

      // Re-init on tab activation — fresh retry budget
      expect(getContextLossAction(true, state.retryCount)).toBe('schedule-retry');
    });
  });
});
