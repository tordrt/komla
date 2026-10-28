import { create } from 'zustand';

import type { ShortcutsConfig } from '../types';

// Detect platform
const isMac = typeof window !== 'undefined' && window.api?.platform === 'darwin';

interface ShortcutsState {
  config: ShortcutsConfig | null;
  isLoading: boolean;
  error: string | null;

  // Actions
  loadShortcuts: () => Promise<void>;
  updateShortcuts: (updates: Partial<ShortcutsConfig>) => Promise<void>;
  resetShortcuts: () => Promise<void>;
  subscribeToChanges: () => () => void;

  // Helpers
  getShortcut: (action: string) => string | null;
  getDisplayShortcut: (action: string) => string;
  getDisplayKeys: (action: string) => ShortcutKeys | null;
  matchesEvent: (action: string, event: KeyboardEvent) => boolean;
}

/** Check if a shortcut uses the DoubleTap+ prefix (e.g., "DoubleTap+Shift"). */
export function isDoubleTapShortcut(shortcut: string): boolean {
  return shortcut.startsWith('DoubleTap+');
}

/** Extract the key from a DoubleTap+ shortcut, or null if not a double-tap shortcut. */
export function getDoubleTapKey(shortcut: string): string | null {
  if (!isDoubleTapShortcut(shortcut)) return null;
  return shortcut.slice('DoubleTap+'.length);
}

interface ModifierFlags {
  hasCmd: boolean;
  hasCtrl: boolean;
  hasAlt: boolean;
  hasShift: boolean;
  hasMeta: boolean;
}

function parseModifierFlags(modifiers: string[]): ModifierFlags {
  return {
    hasCmd: modifiers.includes('cmd'),
    hasCtrl: modifiers.includes('ctrl'),
    hasAlt: modifiers.includes('alt'),
    hasShift: modifiers.includes('shift'),
    hasMeta: modifiers.includes('meta'),
  };
}

/** A shortcut's keys as displayed, and what joins them in its display form. */
export interface ShortcutKeys {
  keys: string[];
  separator: '' | '+' | ' ';
}

const DOUBLE_TAP_MAC_GLYPHS: Record<string, string> = { Shift: '⇧', Meta: '⌘', Ctrl: '⌃' };

function doubleTapKeys(key: string, mac: boolean): ShortcutKeys {
  const glyph = mac ? DOUBLE_TAP_MAC_GLYPHS[key] : undefined;
  // Mac glyphs read as one gesture ("⇧⇧"); words need a space ("Shift Shift").
  return glyph ? { keys: [glyph, glyph], separator: '' } : { keys: [key, key], separator: ' ' };
}

const DISPLAY_KEY_MAP: Record<string, string> = {
  ' ': 'Space',
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  '\\': '\\',
  ',': ',',
  '[': '[',
  ']': ']',
  Click: 'Click',
};

function formatDisplayKey(key: string): string {
  if (DISPLAY_KEY_MAP[key]) return DISPLAY_KEY_MAP[key];
  // Single characters read as keycaps ("N"); named keys stay readable ("Delete").
  return key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1);
}

function buildDisplayKeys(flags: ModifierFlags, key: string, mac: boolean): ShortcutKeys {
  const mods: string[] = [];
  if (mac) {
    if (flags.hasCtrl) mods.push('⌃'); // Control symbol
    if (flags.hasAlt) mods.push('⌥'); // Option symbol
    if (flags.hasShift) mods.push('⇧'); // Shift symbol
    if (flags.hasCmd || flags.hasMeta) mods.push('⌘'); // Command symbol
  } else {
    if (flags.hasCmd || flags.hasCtrl || flags.hasMeta) mods.push('Ctrl');
    if (flags.hasAlt) mods.push('Alt');
    if (flags.hasShift) mods.push('Shift');
  }
  // Mac glyphs read as one chord ("⇧⌘N"); spelled-out modifiers need "+" ("Ctrl+Shift+K").
  return { keys: [...mods, formatDisplayKey(key)], separator: mac ? '' : '+' };
}

function buildInternalForm(flags: ModifierFlags, key: string): string {
  const normCtrl = flags.hasCtrl || (!isMac && flags.hasCmd);
  const normMeta = flags.hasMeta || (isMac && flags.hasCmd);
  const mods: string[] = [];
  if (normCtrl) mods.push('ctrl');
  if (flags.hasAlt) mods.push('alt');
  if (flags.hasShift) mods.push('shift');
  if (normMeta) mods.push('meta');
  return mods.join('+') + '+' + key.toLowerCase();
}

/**
 * Normalize a shortcut string to a canonical form for comparison.
 * Converts modifiers to a consistent order: Ctrl+Alt+Shift+Meta+Key
 */
function normalizeShortcut(shortcut: string, forDisplay = false, mac = isMac): string {
  if (forDisplay) {
    const { keys, separator } = displayKeys(shortcut, mac);
    return keys.join(separator);
  }
  if (isDoubleTapShortcut(shortcut)) return shortcut;
  const { flags, key } = parseShortcut(shortcut);
  return buildInternalForm(flags, key);
}

function parseShortcut(shortcut: string): { flags: ModifierFlags; key: string } {
  const parts = shortcut.split('+');
  // "Cmd++" splits into ["Cmd", "", ""]: its key is the plus key itself.
  const plusKey = shortcut.endsWith('++');
  const key = plusKey ? '+' : parts[parts.length - 1];
  const modifiers = parts.slice(0, plusKey ? -2 : -1).map((m) => m.toLowerCase());
  return { flags: parseModifierFlags(modifiers), key };
}

function displayKeys(shortcut: string, mac: boolean): ShortcutKeys {
  const doubleTapKey = getDoubleTapKey(shortcut);
  if (doubleTapKey) return doubleTapKeys(doubleTapKey, mac);
  const { flags, key } = parseShortcut(shortcut);
  return buildDisplayKeys(flags, key, mac);
}

/**
 * Format a shortcut string (e.g. "Cmd+Shift+N", "Cmd+Click") for display on this
 * platform, or on `platform` (a `process.platform` value) when given.
 */
export function formatShortcutForDisplay(shortcut: string, platform?: string): string {
  return normalizeShortcut(shortcut, true, platform ? platform === 'darwin' : isMac);
}

/** The keys `formatShortcutForDisplay` shows, one entry per key, for drawing keycaps. */
export function formatShortcutKeys(shortcut: string, platform?: string): ShortcutKeys {
  return displayKeys(shortcut, platform ? platform === 'darwin' : isMac);
}

/**
 * Convert a keyboard event to a normalized shortcut string
 */
function eventToShortcut(event: KeyboardEvent): string {
  const mods: string[] = [];
  if (event.ctrlKey) mods.push('ctrl');
  if (event.altKey) mods.push('alt');
  if (event.shiftKey) mods.push('shift');
  if (event.metaKey) mods.push('meta');

  // Get the key, handling special cases
  let key = event.key;
  if (key === '|' && event.shiftKey) {
    // Shift+\ produces |, but we want to match the physical key
    key = '\\';
  }

  return mods.join('+') + '+' + key.toLowerCase();
}

export const useShortcutsStore = create<ShortcutsState>((set, get) => ({
  config: null,
  isLoading: false,
  error: null,

  loadShortcuts: async () => {
    set({ isLoading: true, error: null });
    try {
      const config = await window.api.getShortcuts();
      set({ config, isLoading: false });
    } catch (error) {
      set({
        error: (error as Error).message,
        isLoading: false,
      });
    }
  },

  updateShortcuts: async (updates) => {
    try {
      const config = await window.api.updateShortcuts(updates);
      set({ config });
    } catch (error) {
      set({ error: (error as Error).message });
    }
  },

  resetShortcuts: async () => {
    try {
      const config = await window.api.resetShortcuts();
      set({ config });
    } catch (error) {
      set({ error: (error as Error).message });
    }
  },

  subscribeToChanges: () => {
    const unsub = window.api.onShortcutsChange((config) => {
      set({ config });
    });
    return unsub;
  },

  getShortcut: (action: string) => {
    const { config } = get();
    if (!config) return null;
    return config.shortcuts[action] || null;
  },

  getDisplayShortcut: (action: string) => {
    const shortcut = get().getShortcut(action);
    if (!shortcut) return '';
    return normalizeShortcut(shortcut, true);
  },

  getDisplayKeys: (action: string) => {
    const shortcut = get().getShortcut(action);
    return shortcut ? displayKeys(shortcut, isMac) : null;
  },

  matchesEvent: (action: string, event: KeyboardEvent) => {
    const shortcut = get().getShortcut(action);
    if (!shortcut) return false;

    // DoubleTap+ shortcuts can't match a single KeyboardEvent
    if (isDoubleTapShortcut(shortcut)) return false;

    const normalizedConfig = normalizeShortcut(shortcut);
    const normalizedEvent = eventToShortcut(event);

    return normalizedConfig === normalizedEvent;
  },
}));
