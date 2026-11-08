import { describe, expect, it } from 'vitest';

import { toAccelerator } from '../../../src/shared/lib/global-shortcut-accelerator';

describe('toAccelerator', () => {
  it('turns Cmd into Cmd on macOS and Ctrl elsewhere', () => {
    expect(toAccelerator('Cmd+Shift+K', 'darwin')).toBe('CommandOrControl+Shift+K');
    expect(toAccelerator('Cmd+Shift+K', 'linux')).toBe('CommandOrControl+Shift+K');
  });

  it('names the Meta key Command on macOS and Super elsewhere', () => {
    expect(toAccelerator('Ctrl+Meta+K', 'darwin')).toBe('Command+Control+K');
    expect(toAccelerator('Alt+Meta+K', 'win32')).toBe('Super+Alt+K');
  });

  it('makes the same accelerator whatever order the modifiers come in', () => {
    expect(toAccelerator('Shift+Alt+Cmd+K', 'darwin')).toBe('CommandOrControl+Alt+Shift+K');
  });

  it('spells keys the way Electron does', () => {
    expect(toAccelerator('Cmd+Shift+ ', 'darwin')).toBe('CommandOrControl+Shift+Space');
    expect(toAccelerator('Alt+ArrowUp', 'linux')).toBe('Alt+Up');
    expect(toAccelerator('Cmd++', 'darwin')).toBe('CommandOrControl+Plus');
    expect(toAccelerator('Cmd+k', 'darwin')).toBe('CommandOrControl+K');
    expect(toAccelerator('Cmd+\\', 'darwin')).toBe('CommandOrControl+\\');
    expect(toAccelerator('Ctrl+F12', 'linux')).toBe('Control+F12');
    expect(toAccelerator('Cmd+Enter', 'darwin')).toBe('CommandOrControl+Enter');
  });

  it('gives none for keys that no other app can be asked for', () => {
    expect(toAccelerator('', 'darwin')).toBeNull();
    expect(toAccelerator('DoubleTap+Shift', 'darwin')).toBeNull();
    expect(toAccelerator('Shift+K', 'darwin')).toBeNull();
    expect(toAccelerator('K', 'darwin')).toBeNull();
    // Option+B on a US Mac
    expect(toAccelerator('Alt+∫', 'darwin')).toBeNull();
    expect(toAccelerator('Hyper+K', 'darwin')).toBeNull();
  });
});
