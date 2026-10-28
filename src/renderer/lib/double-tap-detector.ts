/**
 * Detects double-tap of a modifier key (e.g., Shift).
 *
 * A "tap" is a keydown→keyup cycle where no other key was pressed while
 * the modifier was held. Two taps within the threshold window trigger
 * the callback.
 *
 * Safety:
 * - 300 ms max gap between taps (configurable)
 * - 50 ms min tap duration floor to reject bounces
 * - `wasModifierOnly` flag ensures holding Shift + typing doesn't count
 */

export type DoubleTapCallback = () => void;

export class DoubleTapDetector {
  private key: string;
  private callback: DoubleTapCallback;
  private maxGap: number;
  private minTap: number;

  // State
  private isDown = false;
  private wasModifierOnly = false;
  private downTimestamp = 0;
  private lastTapTimestamp = 0;

  constructor(key: string, callback: DoubleTapCallback, { maxGap = 300, minTap = 50 } = {}) {
    this.key = key;
    this.callback = callback;
    this.maxGap = maxGap;
    this.minTap = minTap;
  }

  /**
   * Call on every keydown event (window-level or xterm).
   * Returns true if this event was consumed (the monitored modifier went down).
   */
  handleKeyDown(event: KeyboardEvent): boolean {
    if (event.key === this.key) {
      if (!this.isDown) {
        this.isDown = true;
        this.wasModifierOnly = true;
        this.downTimestamp = event.timeStamp;
      }
      return true;
    }

    // Any other key pressed while modifier is held → not a bare tap
    if (this.isDown) {
      this.wasModifierOnly = false;
    }
    return false;
  }

  /**
   * Call on every keyup event.
   * Returns true if a double-tap was detected and the callback fired.
   */
  handleKeyUp(event: KeyboardEvent): boolean {
    if (event.key !== this.key) return false;
    if (!this.isDown) return false;

    this.isDown = false;

    if (!this.wasModifierOnly) return false;

    const tapDuration = event.timeStamp - this.downTimestamp;
    if (tapDuration < this.minTap) return false;

    const now = event.timeStamp;
    const gap = now - this.lastTapTimestamp;

    if (this.lastTapTimestamp > 0 && gap <= this.maxGap) {
      // Double-tap detected
      this.lastTapTimestamp = 0;
      this.callback();
      return true;
    }

    // Record as first tap
    this.lastTapTimestamp = now;
    return false;
  }

  /** Reset all state (e.g., on blur / workspace switch). */
  reset(): void {
    this.isDown = false;
    this.wasModifierOnly = false;
    this.downTimestamp = 0;
    this.lastTapTimestamp = 0;
  }
}

// --------------- Singleton registry ---------------

const registry = new Map<string, DoubleTapDetector>();

export function getOrCreateDetector(
  key: string,
  callback: DoubleTapCallback,
  opts?: { maxGap?: number; minTap?: number }
): DoubleTapDetector {
  let detector = registry.get(key);
  if (!detector) {
    detector = new DoubleTapDetector(key, callback, opts);
    registry.set(key, detector);
  }
  return detector;
}

export function getDetector(key: string): DoubleTapDetector | undefined {
  return registry.get(key);
}

export function removeDetector(key: string): void {
  registry.delete(key);
}

/**
 * Convert a DoubleTap config key name (e.g., "Ctrl") to the corresponding
 * KeyboardEvent.key value (e.g., "Control"). Most names are identical —
 * only "Ctrl" differs from its event.key counterpart.
 */
const CONFIG_TO_EVENT_KEY: Record<string, string> = { Ctrl: 'Control' };
export function configKeyToEventKey(configKey: string): string {
  return CONFIG_TO_EVENT_KEY[configKey] ?? configKey;
}
