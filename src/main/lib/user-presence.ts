import { powerMonitor } from 'electron';

/** How long without keyboard or mouse input before the user counts as away. */
export const AWAY_IDLE_SECONDS = 180;

/**
 * Whether the user is away from this computer: the screen is locked, or nothing was typed or
 * clicked for a few minutes. When the system can't tell, the user counts as present.
 */
export function isUserAway(): boolean {
  try {
    const state = powerMonitor.getSystemIdleState(AWAY_IDLE_SECONDS);
    return state === 'idle' || state === 'locked';
  } catch {
    return false;
  }
}
