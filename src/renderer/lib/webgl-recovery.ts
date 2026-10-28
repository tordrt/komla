/**
 * WebGL context-loss recovery state machine.
 *
 * Manages retry logic for terminals that lose their WebGL context,
 * gating recovery attempts on tab visibility to prevent unbounded
 * context creation for hidden terminals.
 */

export const MAX_WEBGL_RETRIES = 1;
export const WEBGL_RETRY_DELAY_MS = 2000;

export type ContextLossAction = 'skip-hidden' | 'schedule-retry' | 'max-retries-reached';

export interface WebGLRecoveryState {
  retryCount: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Determine what action to take when a WebGL context is lost.
 *
 * - `skip-hidden`: tab is not visible — don't schedule recovery
 *   (the visibility-based WebGL lifecycle effect will re-init on tab activation)
 * - `schedule-retry`: tab is visible and retries remain — schedule a delayed recovery
 * - `max-retries-reached`: tab is visible but retry budget exhausted — stay on DOM renderer
 */
export function getContextLossAction(isTabActive: boolean, retryCount: number): ContextLossAction {
  if (!isTabActive) return 'skip-hidden';
  if (retryCount < MAX_WEBGL_RETRIES) return 'schedule-retry';
  return 'max-retries-reached';
}

/**
 * Check whether a pending retry should proceed when the timer fires.
 * The tab may have become hidden during the delay.
 */
export function shouldProceedWithRetry(
  isTabActive: boolean,
  hasTerminalElement: boolean,
  hasCachedTerminal: boolean
): boolean {
  return isTabActive && hasTerminalElement && hasCachedTerminal;
}

export function createRecoveryState(): WebGLRecoveryState {
  return { retryCount: 0, retryTimer: null };
}

export function resetRecoveryState(state: WebGLRecoveryState): void {
  if (state.retryTimer) {
    clearTimeout(state.retryTimer);
    state.retryTimer = null;
  }
  state.retryCount = 0;
}
