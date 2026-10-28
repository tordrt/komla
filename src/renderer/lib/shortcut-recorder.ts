import { isDoubleTapShortcut } from '@/stores/shortcuts.store';

import { shortcutsShareScope } from '../../shared/constants/shortcut-scopes';

const MODIFIER_KEYS = new Set(['Meta', 'Control', 'Alt', 'Shift']);

/** Map from KeyboardEvent.key to the modifier name used in DoubleTap config format. */
const DOUBLE_TAP_KEY_MAP: Record<string, string> = {
  Shift: 'Shift',
  Control: 'Ctrl',
  Alt: 'Alt',
  Meta: 'Meta',
};

/** Returns true if the key is a modifier-only press (no non-modifier key). */
export function isModifierOnly(key: string): boolean {
  return MODIFIER_KEYS.has(key);
}

/**
 * Tracks modifier key taps during recording to detect double-tap patterns.
 * A "tap" is a keydown→keyup cycle where no other key was pressed.
 * Two taps of the same modifier within maxGap ms triggers detection.
 */
export class DoubleTapRecorder {
  private maxGap: number;
  private minTap: number;

  private currentKey: string | null = null;
  private isDown = false;
  private wasModifierOnly = false;
  private downTimestamp = 0;
  private lastTapKey: string | null = null;
  private lastTapTimestamp = 0;

  constructor({ maxGap = 300, minTap = 50 } = {}) {
    this.maxGap = maxGap;
    this.minTap = minTap;
  }

  /**
   * Feed a keydown event. Returns a DoubleTap config string (e.g., "DoubleTap+Shift")
   * if a double-tap was detected, or null otherwise.
   */
  handleKeyDown(event: KeyboardEvent): string | null {
    const key = event.key;

    if (isModifierOnly(key)) {
      if (!this.isDown) {
        this.isDown = true;
        this.currentKey = key;
        this.wasModifierOnly = true;
        this.downTimestamp = event.timeStamp;
      }
    } else {
      // A non-modifier key was pressed while modifier was held — not a bare tap
      if (this.isDown) {
        this.wasModifierOnly = false;
      }
    }

    return null;
  }

  /**
   * Feed a keyup event. Returns a DoubleTap config string (e.g., "DoubleTap+Shift")
   * if a double-tap was completed, or null otherwise.
   */
  handleKeyUp(event: KeyboardEvent): string | null {
    const key = event.key;
    if (!isModifierOnly(key) || key !== this.currentKey) return null;
    if (!this.isDown) return null;

    this.isDown = false;

    if (!this.wasModifierOnly) return null;

    const tapDuration = event.timeStamp - this.downTimestamp;
    if (tapDuration < this.minTap) return null;

    const now = event.timeStamp;
    const gap = now - this.lastTapTimestamp;

    if (this.lastTapKey === key && this.lastTapTimestamp > 0 && gap <= this.maxGap) {
      // Double-tap detected
      this.reset();
      const modName = DOUBLE_TAP_KEY_MAP[key] || key;
      return `DoubleTap+${modName}`;
    }

    // Record as first tap
    this.lastTapKey = key;
    this.lastTapTimestamp = now;
    return null;
  }

  reset(): void {
    this.currentKey = null;
    this.isDown = false;
    this.wasModifierOnly = false;
    this.downTimestamp = 0;
    this.lastTapKey = null;
    this.lastTapTimestamp = 0;
  }
}

const MOD_ORDER = ['Ctrl', 'Alt', 'Cmd', 'Shift', 'Meta'];

function collectModifiers(event: KeyboardEvent, platform: string): string[] {
  // On Mac, Meta = Cmd and Ctrl stays as Ctrl (rare).
  // On Win/Linux, Ctrl = Cmd in config and Meta stays as Meta.
  const isMac = platform === 'darwin';
  const mods: string[] = [];
  if (event.ctrlKey) mods.push(isMac ? 'Ctrl' : 'Cmd');
  if (event.altKey) mods.push('Alt');
  if (event.metaKey) mods.push(isMac ? 'Cmd' : 'Meta');
  if (event.shiftKey) mods.push('Shift');
  mods.sort((a, b) => MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b));
  return mods;
}

function normalizeKey(event: KeyboardEvent): string {
  let key = event.key;
  // Handle Shift+\\ producing | — map back to physical key
  if (key === '|' && event.shiftKey) key = '\\';
  // Capitalize single letter keys, keep special keys as-is
  if (key.length === 1 && key.match(/[a-z]/i)) key = key.toUpperCase();
  return key;
}

/**
 * Convert a KeyboardEvent to the config format string (e.g., "Cmd+Shift+K").
 * Uses "Cmd" as the platform-agnostic modifier — Meta on Mac, Ctrl on Win/Linux.
 */
export function keyEventToConfigFormat(event: KeyboardEvent, platform: string): string {
  return [...collectModifiers(event, platform), normalizeKey(event)].join('+');
}

function normalizeShortcutForConflict(shortcut: string): string {
  if (isDoubleTapShortcut(shortcut)) return shortcut.toLowerCase();

  const parts = shortcut.split('+');
  const key = parts[parts.length - 1];
  const modifiers = parts.slice(0, -1);
  modifiers.sort((a, b) => MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b));
  return [...modifiers, key].join('+').toLowerCase();
}

/**
 * Check if a combo string conflicts with any existing shortcut binding.
 * Returns the conflicting action and label, or null if no conflict.
 * DoubleTap combos only conflict with other DoubleTap combos (separate namespace).
 * Regular combos only conflict with other regular combos.
 * Actions that are never pressed in the same place, such as one in the new
 * workspace dialog and one in a terminal, don't conflict.
 * Skips the action being edited (editingAction).
 */
export function findConflict(
  combo: string,
  editingAction: string,
  shortcuts: Record<string, string>,
  labels: Record<string, string>
): { action: string; label: string } | null {
  const normalizedCombo = normalizeShortcutForConflict(combo);
  const comboIsDoubleTap = isDoubleTapShortcut(combo);

  for (const [action, binding] of Object.entries(shortcuts)) {
    if (action === editingAction || !shortcutsShareScope(action, editingAction)) continue;
    const bindingIsDoubleTap = isDoubleTapShortcut(binding);
    // Only compare within the same namespace
    if (comboIsDoubleTap !== bindingIsDoubleTap) continue;
    if (normalizeShortcutForConflict(binding) === normalizedCombo) {
      return { action, label: labels[action] || action };
    }
  }

  return null;
}

/**
 * Extract the modifier prefix from a range shortcut (e.g., "Cmd+1" → "Cmd").
 * Returns null if the shortcut doesn't end with a single digit.
 */
export function extractRangeModifier(shortcut: string): string | null {
  const parts = shortcut.split('+');
  const lastPart = parts[parts.length - 1];
  if (lastPart.length === 1 && lastPart >= '1' && lastPart <= '9') {
    return parts.slice(0, -1).join('+');
  }
  return null;
}
