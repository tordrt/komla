// Layout categories based on keyboard layout identifiers
export type LayoutCategory = 'us' | 'international';

/**
 * Determines if a keyboard layout ID represents a US/QWERTY layout.
 * These layouts have brackets and backslash in easily accessible positions.
 *
 * @param layoutId - The keyboard layout identifier from the OS
 * @returns true if the layout is US-style with easy bracket/backslash access
 */
export function isUSLayout(layoutId: string): boolean {
  const lower = layoutId.toLowerCase();

  // US layouts - brackets and backslash are easily accessible
  // macOS: com.apple.keylayout.US, com.apple.keylayout.ABC
  // Windows: 00000409 (US), various US International codes
  // Linux: us, us(intl), etc.
  return (
    lower.includes('us') ||
    lower.includes('abc') ||
    // UK layout also has accessible brackets (same positions as US)
    lower.includes('british') ||
    lower.includes('uk') ||
    // Australian English uses US layout
    lower.includes('australian')
  );
}

/**
 * Universal shortcuts that work across all keyboard layouts.
 * These replace shortcuts using brackets ([, ]) and backslash (\) which are
 * difficult to access on international keyboards (AZERTY, QWERTZ, Nordic, etc.).
 * macOS split-pane defaults use D, so those are restored after these overrides.
 *
 * Key mappings:
 * - Cmd+[ / Cmd+] (tab nav) -> Cmd+Shift+, / Cmd+Shift+. (avoids Cmd+, macOS Preferences conflict)
 * - Cmd+\ (split right) -> Cmd+/ (forward slash is universal)
 * - Cmd+Shift+\ (split down) -> Cmd+Shift+/
 *
 * Note: workspace nav (Cmd+ArrowUp/Down) and scroll-to-bottom (Cmd+Shift+ArrowDown)
 * use universal keys and don't need overrides.
 */
export const UNIVERSAL_SHORTCUT_OVERRIDES: Record<string, string> = {
  'tab.next': 'Cmd+Shift+.',
  'tab.previous': 'Cmd+Shift+,',
  'pane.splitRight': 'Cmd+/',
  'pane.splitDown': 'Cmd+Shift+/',
};
