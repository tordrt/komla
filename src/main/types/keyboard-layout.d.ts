declare module 'keyboard-layout' {
  /**
   * Get the current keyboard layout identifier.
   * Examples:
   * - macOS: "com.apple.keylayout.US", "com.apple.keylayout.German"
   * - Windows: "00000409" (US), "00000407" (German)
   * - Linux: "us", "de", etc.
   */
  export function getCurrentKeyboardLayout(): string;

  /**
   * Get the current keyboard language code.
   */
  export function getCurrentKeyboardLanguage(): string;

  /**
   * Get a list of installed keyboard languages.
   */
  export function getInstalledKeyboardLanguages(): string[];

  /**
   * Get the current keymap (key code to character mappings).
   */
  export function getCurrentKeymap(): Record<string, string>;

  /**
   * Subscribe to keyboard layout changes.
   * @param callback - Called with the new layout ID when it changes
   * @returns Disposable subscription
   */
  export function onDidChangeCurrentKeyboardLayout(callback: (layoutId: string) => void): {
    dispose: () => void;
  };

  /**
   * Subscribe to keyboard layout changes and immediately call with current layout.
   * @param callback - Called with the layout ID
   * @returns Disposable subscription
   */
  export function observeCurrentKeyboardLayout(callback: (layoutId: string) => void): {
    dispose: () => void;
  };
}
