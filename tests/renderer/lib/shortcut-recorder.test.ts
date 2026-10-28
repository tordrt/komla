import { describe, expect, it } from 'vitest';

import {
  keyEventToConfigFormat,
  findConflict,
  isModifierOnly,
  extractRangeModifier,
  DoubleTapRecorder,
} from '../../../src/renderer/lib/shortcut-recorder';

// Helper to create a partial KeyboardEvent-like object
function makeKeyEvent(overrides: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    key: '',
    code: '',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides,
  } as KeyboardEvent;
}

describe('shortcut-recorder', () => {
  describe('isModifierOnly', () => {
    it('returns true for modifier keys', () => {
      expect(isModifierOnly('Meta')).toBe(true);
      expect(isModifierOnly('Control')).toBe(true);
      expect(isModifierOnly('Alt')).toBe(true);
      expect(isModifierOnly('Shift')).toBe(true);
    });

    it('returns false for non-modifier keys', () => {
      expect(isModifierOnly('k')).toBe(false);
      expect(isModifierOnly('Enter')).toBe(false);
      expect(isModifierOnly('ArrowDown')).toBe(false);
    });
  });

  describe('keyEventToConfigFormat (macOS)', () => {
    it('converts Cmd+K', () => {
      const event = makeKeyEvent({ key: 'k', metaKey: true });
      expect(keyEventToConfigFormat(event, 'darwin')).toBe('Cmd+K');
    });

    it('converts Cmd+Shift+T', () => {
      const event = makeKeyEvent({ key: 't', metaKey: true, shiftKey: true });
      expect(keyEventToConfigFormat(event, 'darwin')).toBe('Cmd+Shift+T');
    });

    it('converts Cmd+ArrowDown', () => {
      const event = makeKeyEvent({ key: 'ArrowDown', metaKey: true });
      expect(keyEventToConfigFormat(event, 'darwin')).toBe('Cmd+ArrowDown');
    });

    it('converts Cmd+\\', () => {
      const event = makeKeyEvent({ key: '\\', metaKey: true });
      expect(keyEventToConfigFormat(event, 'darwin')).toBe('Cmd+\\');
    });

    it('handles Shift+\\ producing | by using the physical key', () => {
      const event = makeKeyEvent({ key: '|', metaKey: true, shiftKey: true });
      expect(keyEventToConfigFormat(event, 'darwin')).toBe('Cmd+Shift+\\');
    });

    it('keeps Ctrl and Meta separate when both are held (Meta→Cmd, Ctrl stays Ctrl)', () => {
      const event = makeKeyEvent({ key: 'k', ctrlKey: true, metaKey: true });
      expect(keyEventToConfigFormat(event, 'darwin')).toBe('Ctrl+Cmd+K');
    });
  });

  describe('keyEventToConfigFormat (windows/linux)', () => {
    it('converts Ctrl to Cmd in config format', () => {
      const event = makeKeyEvent({ key: 'k', ctrlKey: true });
      expect(keyEventToConfigFormat(event, 'win32')).toBe('Cmd+K');
    });

    it('converts Ctrl+Shift+H', () => {
      const event = makeKeyEvent({ key: 'h', ctrlKey: true, shiftKey: true });
      expect(keyEventToConfigFormat(event, 'win32')).toBe('Cmd+Shift+H');
    });

    it('keeps Ctrl and Meta separate when both are held (Ctrl→Cmd, Meta stays Meta)', () => {
      const event = makeKeyEvent({ key: 'k', ctrlKey: true, metaKey: true });
      expect(keyEventToConfigFormat(event, 'win32')).toBe('Cmd+Meta+K');
    });
  });

  describe('findConflict', () => {
    const shortcuts: Record<string, string> = {
      'workspace.new': 'Cmd+N',
      'pane.close': 'Cmd+W',
      'file.open': 'DoubleTap+Shift',
      'terminal.new': 'Cmd+T',
    };

    const labels: Record<string, string> = {
      'workspace.new': 'New workspace',
      'pane.close': 'Close pane',
      'file.open': 'Search files',
      'terminal.new': 'New terminal tab',
    };

    it('returns null when no conflict', () => {
      expect(findConflict('Cmd+X', 'workspace.new', shortcuts, labels)).toBeNull();
    });

    it('finds a conflict with another action', () => {
      const result = findConflict('Cmd+W', 'workspace.new', shortcuts, labels);
      expect(result).toEqual({ action: 'pane.close', label: 'Close pane' });
    });

    it('lets a new workspace dialog action reuse keys used outside the dialog', () => {
      expect(findConflict('Cmd+T', 'newWorkspace.cycleEffort', shortcuts, labels)).toBeNull();
      expect(
        findConflict('Cmd+E', 'terminal.new', { 'newWorkspace.cycleEffort': 'Cmd+E' }, labels)
      ).toBeNull();
    });

    it('finds a conflict between dialog actions, and with keys the dialog also answers to', () => {
      const dialogShortcuts = { ...shortcuts, 'newWorkspace.cycleLaunchMode': 'Shift+Tab' };
      expect(
        findConflict('Shift+Tab', 'newWorkspace.cycleEffort', dialogShortcuts, labels)
      ).toEqual({ action: 'newWorkspace.cycleLaunchMode', label: 'newWorkspace.cycleLaunchMode' });
      expect(findConflict('Cmd+N', 'newWorkspace.cycleEffort', shortcuts, labels)).toEqual({
        action: 'workspace.new',
        label: 'New workspace',
      });
    });

    it('finds a conflict between a dialog action and Close pane, which acts everywhere', () => {
      expect(findConflict('Cmd+W', 'newWorkspace.cycleProject', shortcuts, labels)).toEqual({
        action: 'pane.close',
        label: 'Close pane',
      });
    });

    it('finds a conflict when modifiers are ordered differently', () => {
      const result = findConflict(
        'Alt+Cmd+W',
        'workspace.new',
        { ...shortcuts, 'pane.close': 'Cmd+Alt+W' },
        labels
      );
      expect(result).toEqual({ action: 'pane.close', label: 'Close pane' });
    });

    it('does not conflict with itself', () => {
      expect(findConflict('Cmd+N', 'workspace.new', shortcuts, labels)).toBeNull();
    });

    it('DoubleTap combo does not conflict with regular shortcuts', () => {
      // DoubleTap+Alt should not conflict with any regular shortcut (different namespace)
      expect(findConflict('DoubleTap+Alt', 'file.open', shortcuts, labels)).toBeNull();
    });

    it('DoubleTap combo conflicts with another DoubleTap shortcut', () => {
      // DoubleTap+Shift conflicts with file.open (also DoubleTap+Shift), when editing a different action
      const result = findConflict('DoubleTap+Shift', 'terminal.new', shortcuts, labels);
      expect(result).toEqual({ action: 'file.open', label: 'Search files' });
    });
  });

  describe('DoubleTapRecorder', () => {
    function tap(
      recorder: DoubleTapRecorder,
      key: string,
      baseTime: number,
      tapDuration = 80
    ): string | null {
      recorder.handleKeyDown(makeKeyEvent({ key, timeStamp: baseTime }));
      return recorder.handleKeyUp(makeKeyEvent({ key, timeStamp: baseTime + tapDuration }));
    }

    it('detects double-tap of Shift', () => {
      const recorder = new DoubleTapRecorder();
      tap(recorder, 'Shift', 100);
      const result = tap(recorder, 'Shift', 250);
      expect(result).toBe('DoubleTap+Shift');
    });

    it('detects double-tap of Control', () => {
      const recorder = new DoubleTapRecorder();
      tap(recorder, 'Control', 100);
      const result = tap(recorder, 'Control', 250);
      expect(result).toBe('DoubleTap+Ctrl');
    });

    it('returns null for single tap', () => {
      const recorder = new DoubleTapRecorder();
      const result = tap(recorder, 'Shift', 100);
      expect(result).toBeNull();
    });

    it('returns null when taps are too far apart', () => {
      const recorder = new DoubleTapRecorder();
      tap(recorder, 'Shift', 100);
      const result = tap(recorder, 'Shift', 500); // 400ms gap > 300ms maxGap
      expect(result).toBeNull();
    });

    it('returns null when tap is too short (bounce)', () => {
      const recorder = new DoubleTapRecorder({ minTap: 50 });
      // Tap duration of 10ms < 50ms minTap
      tap(recorder, 'Shift', 100, 10);
      const result = tap(recorder, 'Shift', 200, 10);
      expect(result).toBeNull();
    });

    it('returns null when another key is pressed during modifier hold', () => {
      const recorder = new DoubleTapRecorder();
      // First tap is clean
      tap(recorder, 'Shift', 100);
      // Second tap: press Shift, then press 'k' while Shift is held
      recorder.handleKeyDown(makeKeyEvent({ key: 'Shift', timeStamp: 250 }));
      recorder.handleKeyDown(makeKeyEvent({ key: 'k', timeStamp: 260 }));
      const result = recorder.handleKeyUp(makeKeyEvent({ key: 'Shift', timeStamp: 330 }));
      expect(result).toBeNull();
    });

    it('returns null for different modifier keys', () => {
      const recorder = new DoubleTapRecorder();
      tap(recorder, 'Shift', 100);
      const result = tap(recorder, 'Alt', 250);
      expect(result).toBeNull();
    });

    it('resets state after detection', () => {
      const recorder = new DoubleTapRecorder();
      tap(recorder, 'Shift', 100);
      const result = tap(recorder, 'Shift', 250);
      expect(result).toBe('DoubleTap+Shift');
      // After detection, a single tap should return null
      const result2 = tap(recorder, 'Shift', 400);
      expect(result2).toBeNull();
    });

    it('does not detect non-modifier keys', () => {
      const recorder = new DoubleTapRecorder();
      tap(recorder, 'k', 100);
      const result = tap(recorder, 'k', 250);
      expect(result).toBeNull();
    });
  });

  describe('extractRangeModifier', () => {
    it('extracts modifier from Cmd+1', () => {
      expect(extractRangeModifier('Cmd+1')).toBe('Cmd');
    });

    it('extracts modifier from Cmd+Shift+1', () => {
      expect(extractRangeModifier('Cmd+Shift+1')).toBe('Cmd+Shift');
    });

    it('returns null for shortcuts without a digit suffix', () => {
      expect(extractRangeModifier('Cmd+K')).toBeNull();
    });
  });
});
