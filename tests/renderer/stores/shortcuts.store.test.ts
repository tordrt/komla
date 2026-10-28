import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  useShortcutsStore,
  isDoubleTapShortcut,
  getDoubleTapKey,
} from '../../../src/renderer/stores/shortcuts.store';

function resetStore(): void {
  useShortcutsStore.setState(useShortcutsStore.getInitialState(), true);
}

const mockShortcutsConfig = {
  shortcuts: {
    'terminal.copy': 'Ctrl+C',
    'terminal.paste': 'Ctrl+V',
    'terminal.find': 'Cmd+F',
    'terminal.doubleTap': 'DoubleTap+Shift',
  },
};

function mockApi(overrides: Record<string, any> = {}): Record<string, any> {
  const api = {
    getShortcuts: vi.fn().mockResolvedValue(mockShortcutsConfig),
    updateShortcuts: vi.fn().mockImplementation(async (updates: any) => ({
      shortcuts: { ...mockShortcutsConfig.shortcuts, ...updates },
    })),
    resetShortcuts: vi.fn().mockResolvedValue(mockShortcutsConfig),
    onShortcutsChange: vi.fn().mockReturnValue(vi.fn()),
    platform: 'darwin',
    ...overrides,
  };
  (globalThis as any).window = { api };
  return api;
}

describe('shortcuts.store', () => {
  beforeEach(() => {
    resetStore();
    mockApi();
  });

  it('loadShortcuts fetches config', async () => {
    await useShortcutsStore.getState().loadShortcuts();
    expect(useShortcutsStore.getState().config).toEqual(mockShortcutsConfig);
    expect(useShortcutsStore.getState().isLoading).toBe(false);
  });

  it('loadShortcuts handles errors', async () => {
    mockApi({ getShortcuts: vi.fn().mockRejectedValue(new Error('Failed')) });
    await useShortcutsStore.getState().loadShortcuts();
    expect(useShortcutsStore.getState().error).toBe('Failed');
  });

  it('updateShortcuts updates config', async () => {
    await useShortcutsStore.getState().updateShortcuts({ 'terminal.copy': 'Ctrl+Shift+C' } as any);
    expect(useShortcutsStore.getState().config?.shortcuts['terminal.copy']).toBe('Ctrl+Shift+C');
  });

  it('resetShortcuts resets to defaults', async () => {
    await useShortcutsStore.getState().resetShortcuts();
    expect(useShortcutsStore.getState().config).toEqual(mockShortcutsConfig);
  });

  it('getShortcut returns shortcut string or null', async () => {
    await useShortcutsStore.getState().loadShortcuts();
    expect(useShortcutsStore.getState().getShortcut('terminal.copy')).toBe('Ctrl+C');
    expect(useShortcutsStore.getState().getShortcut('nonexistent')).toBeNull();
  });

  it('getShortcut returns null when config not loaded', () => {
    expect(useShortcutsStore.getState().getShortcut('terminal.copy')).toBeNull();
  });

  it('getDisplayShortcut returns empty string when no shortcut', () => {
    expect(useShortcutsStore.getState().getDisplayShortcut('nonexistent')).toBe('');
  });

  it('matchesEvent returns false when config not loaded', () => {
    const event = {
      ctrlKey: true,
      altKey: false,
      shiftKey: false,
      metaKey: false,
      key: 'c',
    } as KeyboardEvent;
    expect(useShortcutsStore.getState().matchesEvent('terminal.copy', event)).toBe(false);
  });

  it('matchesEvent returns false for DoubleTap shortcuts', async () => {
    await useShortcutsStore.getState().loadShortcuts();
    const event = {
      ctrlKey: false,
      altKey: false,
      shiftKey: true,
      metaKey: false,
      key: 'Shift',
    } as KeyboardEvent;
    expect(useShortcutsStore.getState().matchesEvent('terminal.doubleTap', event)).toBe(false);
  });

  it('matchesEvent matches Ctrl+C shortcut', async () => {
    await useShortcutsStore.getState().loadShortcuts();
    const event = {
      ctrlKey: true,
      altKey: false,
      shiftKey: false,
      metaKey: false,
      key: 'c',
    } as KeyboardEvent;
    expect(useShortcutsStore.getState().matchesEvent('terminal.copy', event)).toBe(true);
  });

  it('matchesEvent does not match wrong key combo', async () => {
    await useShortcutsStore.getState().loadShortcuts();
    const event = {
      ctrlKey: true,
      altKey: false,
      shiftKey: false,
      metaKey: false,
      key: 'x',
    } as KeyboardEvent;
    expect(useShortcutsStore.getState().matchesEvent('terminal.copy', event)).toBe(false);
  });

  it('subscribeToChanges updates config from external events', () => {
    let callback: ((config: any) => void) | undefined;
    mockApi({
      onShortcutsChange: vi.fn((cb: any) => {
        callback = cb;
        return vi.fn();
      }),
    });
    useShortcutsStore.getState().subscribeToChanges();
    const newConfig = { shortcuts: { 'new.action': 'Ctrl+N' } };
    callback!(newConfig);
    expect(useShortcutsStore.getState().config).toEqual(newConfig);
  });
});

// These tests run with the module imported at node-env default (window undefined
// at import time), so `isMac` resolves to false and exercises non-Mac branches.
describe('normalizeShortcut display formatting (non-Mac default)', () => {
  beforeEach(() => {
    resetStore();
  });

  async function loadWith(shortcuts: Record<string, string>): Promise<void> {
    mockApi({ getShortcuts: vi.fn().mockResolvedValue({ shortcuts }) });
    await useShortcutsStore.getState().loadShortcuts();
  }

  it('formats a single-modifier shortcut', async () => {
    await loadWith({ a: 'Ctrl+C' });
    expect(useShortcutsStore.getState().getDisplayShortcut('a')).toBe('Ctrl+C');
  });

  it('maps Cmd to Ctrl in display form', async () => {
    await loadWith({ a: 'Cmd+K' });
    expect(useShortcutsStore.getState().getDisplayShortcut('a')).toBe('Ctrl+K');
  });

  it('joins all modifiers in canonical order with +', async () => {
    await loadWith({ a: 'Ctrl+Alt+Shift+Cmd+K' });
    expect(useShortcutsStore.getState().getDisplayShortcut('a')).toBe('Ctrl+Alt+Shift+K');
  });

  it('renders arrow keys as unicode arrows', async () => {
    await loadWith({ a: 'Cmd+ArrowLeft', b: 'Cmd+ArrowRight' });
    expect(useShortcutsStore.getState().getDisplayShortcut('a')).toBe('Ctrl+←');
    expect(useShortcutsStore.getState().getDisplayShortcut('b')).toBe('Ctrl+→');
  });

  it('preserves backslash, comma, and bracket keys', async () => {
    await loadWith({ bs: 'Ctrl+\\', cm: 'Ctrl+,', lb: 'Ctrl+[' });
    expect(useShortcutsStore.getState().getDisplayShortcut('bs')).toBe('Ctrl+\\');
    expect(useShortcutsStore.getState().getDisplayShortcut('cm')).toBe('Ctrl+,');
    expect(useShortcutsStore.getState().getDisplayShortcut('lb')).toBe('Ctrl+[');
  });

  it('DoubleTap+Meta renders as "Meta Meta"', async () => {
    await loadWith({ a: 'DoubleTap+Meta' });
    expect(useShortcutsStore.getState().getDisplayShortcut('a')).toBe('Meta Meta');
  });

  it('DoubleTap+Ctrl renders as "Ctrl Ctrl"', async () => {
    await loadWith({ a: 'DoubleTap+Ctrl' });
    expect(useShortcutsStore.getState().getDisplayShortcut('a')).toBe('Ctrl Ctrl');
  });

  it('DoubleTap+<arbitrary key> renders as "K K"', async () => {
    await loadWith({ a: 'DoubleTap+K' });
    expect(useShortcutsStore.getState().getDisplayShortcut('a')).toBe('K K');
  });
});

describe('formatShortcutForDisplay', () => {
  it('joins modifiers with "+" off Mac', async () => {
    mockApi({ platform: 'linux' });
    vi.resetModules();
    const { formatShortcutForDisplay } =
      await import('../../../src/renderer/stores/shortcuts.store');
    expect(formatShortcutForDisplay('Cmd+Shift+N')).toBe('Ctrl+Shift+N');
  });

  it('keeps named keys readable instead of upper-casing them', async () => {
    mockApi({ platform: 'linux' });
    vi.resetModules();
    const { formatShortcutForDisplay } =
      await import('../../../src/renderer/stores/shortcuts.store');
    expect(formatShortcutForDisplay('Cmd+Shift+Delete')).toBe('Ctrl+Shift+Delete');
    expect(formatShortcutForDisplay('Cmd+k')).toBe('Ctrl+K');
  });

  it('uses canonical Mac glyph order', async () => {
    mockApi({ platform: 'darwin' });
    vi.resetModules();
    const { formatShortcutForDisplay } =
      await import('../../../src/renderer/stores/shortcuts.store');
    expect(formatShortcutForDisplay('Cmd+Shift+N')).toBe('⇧⌘N');
  });

  it('formats for an explicitly given platform', async () => {
    mockApi({ platform: 'linux' });
    vi.resetModules();
    const { formatShortcutForDisplay } =
      await import('../../../src/renderer/stores/shortcuts.store');
    expect(formatShortcutForDisplay('Cmd+B', 'darwin')).toBe('⌘B');
    expect(formatShortcutForDisplay('Cmd+B', 'win32')).toBe('Ctrl+B');
  });

  it('spells out mouse clicks', async () => {
    mockApi({ platform: 'linux' });
    vi.resetModules();
    const { formatShortcutForDisplay } =
      await import('../../../src/renderer/stores/shortcuts.store');
    expect(formatShortcutForDisplay('Cmd+Click', 'darwin')).toBe('⌘Click');
    expect(formatShortcutForDisplay('Cmd+Click', 'linux')).toBe('Ctrl+Click');
  });
});

describe('formatShortcutKeys', () => {
  async function load(platform: string): Promise<any> {
    mockApi({ platform });
    vi.resetModules();
    return import('../../../src/renderer/stores/shortcuts.store');
  }

  it('lists each key with the separator the display form uses', async () => {
    const linux = await load('linux');
    expect(linux.formatShortcutKeys('Cmd+Shift+N')).toEqual({
      keys: ['Ctrl', 'Shift', 'N'],
      separator: '+',
    });
    const mac = await load('darwin');
    expect(mac.formatShortcutKeys('Cmd+Shift+N')).toEqual({
      keys: ['⇧', '⌘', 'N'],
      separator: '',
    });
  });

  it('lists a double tap as the same key twice', async () => {
    const linux = await load('linux');
    expect(linux.formatShortcutKeys('DoubleTap+Shift')).toEqual({
      keys: ['Shift', 'Shift'],
      separator: ' ',
    });
    const mac = await load('darwin');
    expect(mac.formatShortcutKeys('DoubleTap+Shift')).toEqual({
      keys: ['⇧', '⇧'],
      separator: '',
    });
  });

  it('names the space key', async () => {
    const { formatShortcutKeys, formatShortcutForDisplay } = await load('linux');
    expect(formatShortcutKeys('Cmd+ ').keys).toEqual(['Ctrl', 'Space']);
    expect(formatShortcutForDisplay('Cmd+ ')).toBe('Ctrl+Space');
  });

  it('keeps the plus key', async () => {
    const { formatShortcutKeys, formatShortcutForDisplay } = await load('linux');
    expect(formatShortcutKeys('Cmd++').keys).toEqual(['Ctrl', '+']);
    expect(formatShortcutForDisplay('Cmd++')).toBe('Ctrl++');
  });

  it('matches the plus key', async () => {
    mockApi({
      platform: 'linux',
      getShortcuts: vi.fn().mockResolvedValue({ shortcuts: { zoom: 'Cmd++' } }),
    });
    vi.resetModules();
    const { useShortcutsStore: store } =
      await import('../../../src/renderer/stores/shortcuts.store');
    await store.getState().loadShortcuts();
    const event = { ctrlKey: true, altKey: false, shiftKey: false, metaKey: false, key: '+' };
    expect(store.getState().matchesEvent('zoom', event as KeyboardEvent)).toBe(true);
  });
});

describe('normalizeShortcut display formatting (Mac)', () => {
  async function loadMacWith(shortcuts: Record<string, string>): Promise<any> {
    mockApi({ platform: 'darwin', getShortcuts: vi.fn().mockResolvedValue({ shortcuts }) });
    vi.resetModules();
    const { useShortcutsStore: macStore } =
      await import('../../../src/renderer/stores/shortcuts.store');
    await macStore.getState().loadShortcuts();
    return macStore;
  }

  it('renders all modifier symbols in canonical order', async () => {
    const store = await loadMacWith({ a: 'Ctrl+Alt+Shift+Cmd+K' });
    expect(store.getState().getDisplayShortcut('a')).toBe('⌃⌥⇧⌘K');
  });

  it('maps Cmd to command symbol', async () => {
    const store = await loadMacWith({ a: 'Cmd+K' });
    expect(store.getState().getDisplayShortcut('a')).toBe('⌘K');
  });

  it('DoubleTap+Shift renders as double shift symbol', async () => {
    const store = await loadMacWith({ a: 'DoubleTap+Shift' });
    expect(store.getState().getDisplayShortcut('a')).toBe('⇧⇧');
  });

  it('DoubleTap+Meta renders as double command symbol', async () => {
    const store = await loadMacWith({ a: 'DoubleTap+Meta' });
    expect(store.getState().getDisplayShortcut('a')).toBe('⌘⌘');
  });

  it('DoubleTap+Ctrl renders as double control symbol', async () => {
    const store = await loadMacWith({ a: 'DoubleTap+Ctrl' });
    expect(store.getState().getDisplayShortcut('a')).toBe('⌃⌃');
  });

  it('DoubleTap+<arbitrary key> renders as "K K" on Mac too', async () => {
    const store = await loadMacWith({ a: 'DoubleTap+K' });
    expect(store.getState().getDisplayShortcut('a')).toBe('K K');
  });
});

describe('normalizeShortcut internal form (via matchesEvent)', () => {
  beforeEach(() => {
    resetStore();
  });

  async function loadWith(shortcuts: Record<string, string>): Promise<void> {
    mockApi({ getShortcuts: vi.fn().mockResolvedValue({ shortcuts }) });
    await useShortcutsStore.getState().loadShortcuts();
  }

  it('matches all four modifiers together', async () => {
    await loadWith({ a: 'Ctrl+Alt+Shift+Meta+K' });
    const event = {
      ctrlKey: true,
      altKey: true,
      shiftKey: true,
      metaKey: true,
      key: 'K',
    } as KeyboardEvent;
    expect(useShortcutsStore.getState().matchesEvent('a', event)).toBe(true);
  });

  it('does not match when a modifier is missing', async () => {
    await loadWith({ a: 'Ctrl+Alt+K' });
    const event = {
      ctrlKey: true,
      altKey: false,
      shiftKey: false,
      metaKey: false,
      key: 'k',
    } as KeyboardEvent;
    expect(useShortcutsStore.getState().matchesEvent('a', event)).toBe(false);
  });

  it('matches Shift+| as the physical backslash key', async () => {
    await loadWith({ a: 'Ctrl+Shift+\\' });
    const event = {
      ctrlKey: true,
      altKey: false,
      shiftKey: true,
      metaKey: false,
      key: '|',
    } as KeyboardEvent;
    expect(useShortcutsStore.getState().matchesEvent('a', event)).toBe(true);
  });
});

describe('matchesEvent Cmd mapping (Mac)', () => {
  it('Cmd+F matches metaKey on Mac and does not match ctrlKey', async () => {
    mockApi({
      platform: 'darwin',
      getShortcuts: vi.fn().mockResolvedValue({ shortcuts: { a: 'Cmd+F' } }),
    });
    vi.resetModules();
    const { useShortcutsStore: macStore } =
      await import('../../../src/renderer/stores/shortcuts.store');
    await macStore.getState().loadShortcuts();

    const metaEvent = {
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      metaKey: true,
      key: 'f',
    } as KeyboardEvent;
    expect(macStore.getState().matchesEvent('a', metaEvent)).toBe(true);

    const ctrlEvent = {
      ctrlKey: true,
      altKey: false,
      shiftKey: false,
      metaKey: false,
      key: 'f',
    } as KeyboardEvent;
    expect(macStore.getState().matchesEvent('a', ctrlEvent)).toBe(false);
  });
});

describe('shortcuts.store (non-Mac platform)', () => {
  it('maps Cmd to Ctrl display and matching on non-Mac', async () => {
    // isMac is evaluated at module scope, so we need to re-import with a different platform
    mockApi({ platform: 'win32' });
    vi.resetModules();
    const { useShortcutsStore: winStore } =
      await import('../../../src/renderer/stores/shortcuts.store');
    await winStore.getState().loadShortcuts();

    // Cmd+F should display as Ctrl+F on Windows (not ⌘F)
    const display = winStore.getState().getDisplayShortcut('terminal.find');
    expect(display).toContain('Ctrl');
    expect(display).not.toContain('⌘');

    // Cmd+F should match ctrlKey (not metaKey) on Windows
    const ctrlEvent = {
      ctrlKey: true,
      altKey: false,
      shiftKey: false,
      metaKey: false,
      key: 'f',
    } as KeyboardEvent;
    expect(winStore.getState().matchesEvent('terminal.find', ctrlEvent)).toBe(true);

    const metaEvent = {
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      metaKey: true,
      key: 'f',
    } as KeyboardEvent;
    expect(winStore.getState().matchesEvent('terminal.find', metaEvent)).toBe(false);
  });

  it('shows DoubleTap+Shift as text instead of symbols on non-Mac', async () => {
    mockApi({ platform: 'linux' });
    vi.resetModules();
    const { useShortcutsStore: linuxStore } =
      await import('../../../src/renderer/stores/shortcuts.store');
    await linuxStore.getState().loadShortcuts();

    const display = linuxStore.getState().getDisplayShortcut('terminal.doubleTap');
    expect(display).toBe('Shift Shift');
  });
});

describe('isDoubleTapShortcut', () => {
  it('returns true for DoubleTap+ prefixed shortcuts', () => {
    expect(isDoubleTapShortcut('DoubleTap+Shift')).toBe(true);
    expect(isDoubleTapShortcut('DoubleTap+Ctrl')).toBe(true);
  });

  it('returns false for non-DoubleTap shortcuts', () => {
    expect(isDoubleTapShortcut('Ctrl+C')).toBe(false);
    expect(isDoubleTapShortcut('')).toBe(false);
  });
});

describe('getDoubleTapKey', () => {
  it('extracts key from DoubleTap+ shortcuts', () => {
    expect(getDoubleTapKey('DoubleTap+Shift')).toBe('Shift');
    expect(getDoubleTapKey('DoubleTap+Ctrl')).toBe('Ctrl');
  });

  it('returns null for non-DoubleTap shortcuts', () => {
    expect(getDoubleTapKey('Ctrl+C')).toBeNull();
  });
});
