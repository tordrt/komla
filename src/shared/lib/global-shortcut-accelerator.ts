// Electron accelerators for keys in the shortcuts config, for global shortcuts. Shared so the
// Settings recorder can refuse keys the main process could never register.

const MODIFIERS: Record<string, (platform: string) => string> = {
  cmd: () => 'CommandOrControl',
  ctrl: () => 'Control',
  alt: () => 'Alt',
  shift: () => 'Shift',
  // The recorder names the Windows and Super keys Meta off macOS.
  meta: (platform) => (platform === 'darwin' ? 'Command' : 'Super'),
};

// One order whatever the config's, so the same keys always make the same accelerator.
const MODIFIER_ORDER = ['CommandOrControl', 'Command', 'Control', 'Super', 'Alt', 'Shift'];

// KeyboardEvent.key names that Electron spells differently.
const KEYS: Record<string, string> = {
  ' ': 'Space',
  '+': 'Plus',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
};

const NAMED_KEYS = new Set([
  'Backspace',
  'Delete',
  'Insert',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Tab',
  'Enter',
  'Escape',
]);

const FUNCTION_KEY = /^F([1-9]|1\d|2[0-4])$/;
const PRINTABLE_ASCII = /^[!-~]$/;

/**
 * Electron's accelerator for keys in the shortcuts config, e.g. "Cmd+Shift+Space" for
 * "Cmd+Shift+ ". Null for keys no app outside Komla can be given: a double tap, keys without
 * Cmd, Ctrl, Alt or Meta, or a character only the keyboard layout makes, such as Option+B's ∫.
 */
export function toAccelerator(shortcut: string, platform: string): string | null {
  if (!shortcut || shortcut.startsWith('DoubleTap+')) return null;
  // "Cmd++" is Cmd and the plus key.
  const endsInPlus = shortcut.endsWith('++');
  const parts = (endsInPlus ? shortcut.slice(0, -2) : shortcut).split('+');
  const key = endsInPlus ? '+' : parts.pop();
  if (!key) return null;

  const modifiers: string[] = [];
  for (const part of parts) {
    const modifier = MODIFIERS[part.toLowerCase()];
    if (!modifier) return null;
    modifiers.push(modifier(platform));
  }
  if (!modifiers.some((modifier) => modifier !== 'Shift')) return null;

  let electronKey = KEYS[key];
  if (!electronKey && (NAMED_KEYS.has(key) || FUNCTION_KEY.test(key))) electronKey = key;
  if (!electronKey && PRINTABLE_ASCII.test(key)) electronKey = key.toUpperCase();
  if (!electronKey) return null;
  modifiers.sort((a, b) => MODIFIER_ORDER.indexOf(a) - MODIFIER_ORDER.indexOf(b));
  return [...modifiers, electronKey].join('+');
}
