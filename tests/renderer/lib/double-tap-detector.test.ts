import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  DoubleTapDetector,
  getOrCreateDetector,
  getDetector,
  removeDetector,
  configKeyToEventKey,
} from '../../../src/renderer/lib/double-tap-detector';

function makeKeyEvent(key: string, timeStamp: number): KeyboardEvent {
  return { key, timeStamp } as KeyboardEvent;
}

describe('DoubleTapDetector', () => {
  let callback: ReturnType<typeof vi.fn>;
  let detector: DoubleTapDetector;

  beforeEach(() => {
    callback = vi.fn();
    detector = new DoubleTapDetector('Shift', callback);
  });

  describe('valid double-tap', () => {
    it('fires callback on double-tap with proper timing', () => {
      // First tap: down at 100, up at 200
      detector.handleKeyDown(makeKeyEvent('Shift', 100));
      detector.handleKeyUp(makeKeyEvent('Shift', 200));
      // Second tap: down at 300, up at 400
      detector.handleKeyDown(makeKeyEvent('Shift', 300));
      const result = detector.handleKeyUp(makeKeyEvent('Shift', 400));

      expect(result).toBe(true);
      expect(callback).toHaveBeenCalledOnce();
    });

    it('allows a new double-tap after a successful one', () => {
      // First double-tap
      detector.handleKeyDown(makeKeyEvent('Shift', 100));
      detector.handleKeyUp(makeKeyEvent('Shift', 200));
      detector.handleKeyDown(makeKeyEvent('Shift', 300));
      detector.handleKeyUp(makeKeyEvent('Shift', 400));
      // Second double-tap
      detector.handleKeyDown(makeKeyEvent('Shift', 500));
      detector.handleKeyUp(makeKeyEvent('Shift', 600));
      detector.handleKeyDown(makeKeyEvent('Shift', 700));
      detector.handleKeyUp(makeKeyEvent('Shift', 800));

      expect(callback).toHaveBeenCalledTimes(2);
    });
  });

  describe('rejection cases', () => {
    it('does not fire when another key is pressed during hold', () => {
      detector.handleKeyDown(makeKeyEvent('Shift', 100));
      detector.handleKeyDown(makeKeyEvent('a', 150)); // Other key during hold
      detector.handleKeyUp(makeKeyEvent('Shift', 200));

      detector.handleKeyDown(makeKeyEvent('Shift', 300));
      detector.handleKeyUp(makeKeyEvent('Shift', 400));

      expect(callback).not.toHaveBeenCalled();
    });

    it('does not fire when tap is too short (< minTap)', () => {
      detector = new DoubleTapDetector('Shift', callback, { minTap: 50 });

      detector.handleKeyDown(makeKeyEvent('Shift', 100));
      detector.handleKeyUp(makeKeyEvent('Shift', 130)); // 30ms < 50ms
      detector.handleKeyDown(makeKeyEvent('Shift', 200));
      detector.handleKeyUp(makeKeyEvent('Shift', 230));

      expect(callback).not.toHaveBeenCalled();
    });

    it('does not fire when gap between taps is too long', () => {
      detector = new DoubleTapDetector('Shift', callback, { maxGap: 300 });

      detector.handleKeyDown(makeKeyEvent('Shift', 100));
      detector.handleKeyUp(makeKeyEvent('Shift', 200));
      // Gap: 500 - 200 = 300ms but the gap is measured from keyup to keyup
      detector.handleKeyDown(makeKeyEvent('Shift', 600));
      detector.handleKeyUp(makeKeyEvent('Shift', 700)); // 700 - 200 = 500ms gap > 300ms

      expect(callback).not.toHaveBeenCalled();
    });

    it('does not fire for a single tap', () => {
      detector.handleKeyDown(makeKeyEvent('Shift', 100));
      detector.handleKeyUp(makeKeyEvent('Shift', 200));

      expect(callback).not.toHaveBeenCalled();
    });

    it('does not fire for wrong key', () => {
      detector.handleKeyDown(makeKeyEvent('Control', 100));
      detector.handleKeyUp(makeKeyEvent('Control', 200));
      detector.handleKeyDown(makeKeyEvent('Control', 300));
      detector.handleKeyUp(makeKeyEvent('Control', 400));

      expect(callback).not.toHaveBeenCalled();
    });

    it('ignores keyup without prior keydown', () => {
      const result = detector.handleKeyUp(makeKeyEvent('Shift', 100));
      expect(result).toBe(false);
    });

    it('ignores keyup for other keys', () => {
      detector.handleKeyDown(makeKeyEvent('Shift', 100));
      const result = detector.handleKeyUp(makeKeyEvent('Control', 200));
      expect(result).toBe(false);
    });
  });

  describe('boundary conditions', () => {
    it('accepts tap exactly at minTap threshold (50ms)', () => {
      detector = new DoubleTapDetector('Shift', callback, { minTap: 50 });

      detector.handleKeyDown(makeKeyEvent('Shift', 100));
      detector.handleKeyUp(makeKeyEvent('Shift', 150)); // Exactly 50ms
      detector.handleKeyDown(makeKeyEvent('Shift', 200));
      detector.handleKeyUp(makeKeyEvent('Shift', 250));

      expect(callback).toHaveBeenCalledOnce();
    });

    it('accepts double-tap exactly at maxGap threshold (300ms)', () => {
      detector = new DoubleTapDetector('Shift', callback, { maxGap: 300 });

      detector.handleKeyDown(makeKeyEvent('Shift', 100));
      detector.handleKeyUp(makeKeyEvent('Shift', 200));
      detector.handleKeyDown(makeKeyEvent('Shift', 400));
      detector.handleKeyUp(makeKeyEvent('Shift', 500)); // 500 - 200 = 300ms = maxGap

      expect(callback).toHaveBeenCalledOnce();
    });

    it('rejects double-tap just beyond maxGap (301ms)', () => {
      detector = new DoubleTapDetector('Shift', callback, { maxGap: 300 });

      detector.handleKeyDown(makeKeyEvent('Shift', 100));
      detector.handleKeyUp(makeKeyEvent('Shift', 200));
      detector.handleKeyDown(makeKeyEvent('Shift', 401));
      detector.handleKeyUp(makeKeyEvent('Shift', 501)); // 501 - 200 = 301ms > 300ms

      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe('handleKeyDown return value', () => {
    it('returns true for the monitored key', () => {
      expect(detector.handleKeyDown(makeKeyEvent('Shift', 100))).toBe(true);
    });

    it('returns false for other keys', () => {
      expect(detector.handleKeyDown(makeKeyEvent('a', 100))).toBe(false);
    });
  });

  describe('reset', () => {
    it('clears state so next taps start fresh', () => {
      detector.handleKeyDown(makeKeyEvent('Shift', 100));
      detector.handleKeyUp(makeKeyEvent('Shift', 200));
      detector.reset();

      // This should be treated as a first tap, not a second
      detector.handleKeyDown(makeKeyEvent('Shift', 300));
      detector.handleKeyUp(makeKeyEvent('Shift', 400));

      expect(callback).not.toHaveBeenCalled();
    });
  });
});

describe('singleton registry', () => {
  beforeEach(() => {
    // Clean up any registered detectors
    removeDetector('Shift');
    removeDetector('Control');
  });

  it('getOrCreateDetector returns the same instance for the same key', () => {
    const cb = vi.fn();
    const d1 = getOrCreateDetector('Shift', cb);
    const d2 = getOrCreateDetector('Shift', cb);
    expect(d1).toBe(d2);
  });

  it('getDetector returns undefined for unregistered key', () => {
    expect(getDetector('Control')).toBeUndefined();
  });

  it('getDetector returns registered detector', () => {
    const cb = vi.fn();
    const created = getOrCreateDetector('Shift', cb);
    expect(getDetector('Shift')).toBe(created);
  });

  it('removeDetector removes the detector', () => {
    const cb = vi.fn();
    getOrCreateDetector('Shift', cb);
    removeDetector('Shift');
    expect(getDetector('Shift')).toBeUndefined();
  });
});

describe('configKeyToEventKey', () => {
  it('maps Ctrl to Control', () => {
    expect(configKeyToEventKey('Ctrl')).toBe('Control');
  });

  it('passes through Shift unchanged', () => {
    expect(configKeyToEventKey('Shift')).toBe('Shift');
  });

  it('passes through Meta unchanged', () => {
    expect(configKeyToEventKey('Meta')).toBe('Meta');
  });

  it('passes through Alt unchanged', () => {
    expect(configKeyToEventKey('Alt')).toBe('Alt');
  });
});

describe('DoubleTapDetector with Control key (Win/Linux voice shortcut)', () => {
  it('fires when registered with event.key "Control" and fed Control events', () => {
    const cb = vi.fn();
    // Register with the event.key value (what configKeyToEventKey produces from "Ctrl")
    const detector = new DoubleTapDetector('Control', cb);

    detector.handleKeyDown(makeKeyEvent('Control', 100));
    detector.handleKeyUp(makeKeyEvent('Control', 200));
    detector.handleKeyDown(makeKeyEvent('Control', 300));
    detector.handleKeyUp(makeKeyEvent('Control', 400));

    expect(cb).toHaveBeenCalledOnce();
  });

  it('does not fire when registered with config name "Ctrl" (the bug this mapping fixes)', () => {
    const cb = vi.fn();
    // Without configKeyToEventKey, "Ctrl" would be passed directly — won't match "Control" events
    const detector = new DoubleTapDetector('Ctrl', cb);

    detector.handleKeyDown(makeKeyEvent('Control', 100));
    detector.handleKeyUp(makeKeyEvent('Control', 200));
    detector.handleKeyDown(makeKeyEvent('Control', 300));
    detector.handleKeyUp(makeKeyEvent('Control', 400));

    expect(cb).not.toHaveBeenCalled();
  });
});
