import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMockBrowserWindow, mockElectron } from '../../mocks/electron';
import { createVirtualFs } from '../../mocks/fs';
import type { ShortcutsService as ShortcutsServiceType } from '../../../src/main/services/shortcuts.service';

const electronMock = mockElectron();
vi.mock('electron', () => electronMock);

const vfs = createVirtualFs();
vi.mock('fs', () => vfs.mock);

vi.mock('../../../src/main/services/paths', () => ({
  getKomlaBasePath: () => '/mock/home/.komla',
}));

vi.mock('../../../src/main/lib/atomic-write', () => ({
  writeFileAtomicSync: (path: string, content: string) => vfs.mock.writeFileSync(path, content),
}));

const mockWatcherStart = vi.fn().mockResolvedValue(undefined);
const mockWatcherStop = vi.fn().mockResolvedValue(undefined);
let mockWatcherCallback: (() => void) | null = null;

vi.mock('../../../src/main/services/file-watcher', () => {
  return {
    FileWatcher: class {
      constructor(
        public path: string,
        public callback: () => void
      ) {
        mockWatcherCallback = callback;
      }
      start = mockWatcherStart;
      stop = mockWatcherStop;
    },
  };
});

describe('ShortcutsService', () => {
  let shortcutsService: ShortcutsServiceType;
  let ShortcutsService: new (provider?: any, platform?: NodeJS.Platform) => ShortcutsServiceType;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vfs.clear();

    // Dynamic import to avoid hoisting issues with fs mock
    const mod = await import('../../../src/main/services/shortcuts.service');
    ShortcutsService = mod.ShortcutsService;

    // Instantiate with default mock provider (US) on macOS
    shortcutsService = new ShortcutsService(
      {
        getCurrentKeyboardLayout: () => 'com.apple.keylayout.US',
      },
      'darwin'
    );

    // Ensure initial file write (debounced)
    vi.advanceTimersByTime(1000);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  it('initializes with default shortcuts for US layout', () => {
    expect(vfs.hasFile('/mock/home/.komla/settings/shortcuts.json')).toBe(true);
    const content = JSON.parse(vfs.getFile('/mock/home/.komla/settings/shortcuts.json') as string);
    expect(content.shortcuts['tab.next']).toBe('Cmd+]');
    expect(content.shortcuts['workspace.overview']).toBe('Cmd+Shift+O');
    expect(content.shortcuts['pane.splitRight']).toBe('Cmd+D');
    expect(content.shortcuts['pane.splitDown']).toBe('Cmd+Shift+D');
    expect(content.shortcuts['diff.toggle']).toBe('Cmd+Shift+G');
  });

  it('includes workspace lifecycle shortcuts in defaults', () => {
    const config = shortcutsService.getConfig();
    expect(config.shortcuts['workspace.stop']).toBe('Cmd+Shift+W');
    expect(config.shortcuts['workspace.trash']).toBe('Cmd+Shift+Backspace');
    // Deleting for good can't be undone, so it waits for the user to bind it.
    expect(config.shortcuts['workspace.delete']).toBe('');
  });

  it.each(['darwin', 'win32', 'linux'] as const)(
    'binds the next-workspace-needing-input jump without clashing on %s',
    (platform) => {
      vfs.clear();
      const service = new ShortcutsService({ getCurrentKeyboardLayout: () => 'us' }, platform);
      vi.advanceTimersByTime(1000);

      const { shortcuts } = service.getConfig();
      expect(shortcuts['workspace.nextAttention']).toBe('Cmd+Shift+A');
      const clashes = Object.entries(shortcuts).filter(
        ([action, binding]) =>
          action !== 'workspace.nextAttention' && binding === shortcuts['workspace.nextAttention']
      );
      expect(clashes).toEqual([]);
    }
  );

  it.each([
    ['darwin', 'Cmd+P'],
    // Plain Ctrl+P is the shell's previous-history key.
    ['win32', 'Cmd+Shift+P'],
    ['linux', 'Cmd+Shift+P'],
  ] as const)('binds the command center without clashing on %s', (platform, binding) => {
    vfs.clear();
    const service = new ShortcutsService({ getCurrentKeyboardLayout: () => 'us' }, platform);
    vi.advanceTimersByTime(1000);

    const { shortcuts } = service.getConfig();
    expect(shortcuts['commandCenter.open']).toBe(binding);
    const clashes = Object.entries(shortcuts).filter(
      ([action, shortcut]) => action !== 'commandCenter.open' && shortcut === binding
    );
    expect(clashes).toEqual([]);
  });

  it.each(['darwin', 'win32', 'linux'] as const)(
    'binds New note as Orca does, without clashing on %s',
    (platform) => {
      vfs.clear();
      const service = new ShortcutsService({ getCurrentKeyboardLayout: () => 'us' }, platform);
      vi.advanceTimersByTime(1000);

      const { shortcuts } = service.getConfig();
      expect(shortcuts['note.new']).toBe('Cmd+Shift+M');
      const clashes = Object.entries(shortcuts).filter(
        ([action, shortcut]) => action !== 'note.new' && shortcut === 'Cmd+Shift+M'
      );
      expect(clashes).toEqual([]);
    }
  );

  it.each(['darwin', 'win32', 'linux'] as const)(
    'binds Toggle sidebar apart from the file tree panel, without clashing on %s',
    (platform) => {
      vfs.clear();
      const service = new ShortcutsService({ getCurrentKeyboardLayout: () => 'us' }, platform);
      vi.advanceTimersByTime(1000);

      const { shortcuts } = service.getConfig();
      expect(shortcuts['sidebar.toggle']).toBe('Cmd+Shift+S');
      const clashes = Object.entries(shortcuts).filter(
        ([action, shortcut]) => action !== 'sidebar.toggle' && shortcut === 'Cmd+Shift+S'
      );
      expect(clashes).toEqual([]);
    }
  );

  it('binds Open folder to Cmd+O on macOS only, without clashing', () => {
    vfs.clear();
    const mac = new ShortcutsService({ getCurrentKeyboardLayout: () => 'us' }, 'darwin');
    vi.advanceTimersByTime(1000);
    const { shortcuts } = mac.getConfig();
    expect(shortcuts['workspace.openFolder']).toBe('Cmd+O');
    expect(
      Object.entries(shortcuts).filter(
        ([action, shortcut]) => action !== 'workspace.openFolder' && shortcut === 'Cmd+O'
      )
    ).toEqual([]);

    // Ctrl+O belongs to programs in the terminal there.
    for (const platform of ['win32', 'linux'] as const) {
      vfs.clear();
      const service = new ShortcutsService({ getCurrentKeyboardLayout: () => 'us' }, platform);
      vi.advanceTimersByTime(1000);
      expect(service.getConfig().shortcuts['workspace.openFolder']).toBe('');
    }
  });

  it('leaves the command center unbound when an upgrading user already uses its keys', () => {
    vfs.mock.mkdirSync('/mock/home/.komla/settings', { recursive: true });
    vfs.mock.writeFileSync(
      '/mock/home/.komla/settings/shortcuts.json',
      JSON.stringify({ _version: 1, shortcuts: { 'file.open': 'Cmd+P' } })
    );

    const { shortcuts } = new ShortcutsService(
      { getCurrentKeyboardLayout: () => 'com.apple.keylayout.US' },
      'darwin'
    ).getConfig();

    expect(shortcuts['file.open']).toBe('Cmd+P');
    expect(shortcuts['commandCenter.open']).toBe('');
    expect(shortcuts['tab.next']).toBe('Cmd+]');
  });

  it('binds the command center for an upgrading user whose keys are free', () => {
    vfs.mock.mkdirSync('/mock/home/.komla/settings', { recursive: true });
    vfs.mock.writeFileSync(
      '/mock/home/.komla/settings/shortcuts.json',
      JSON.stringify({ _version: 1, shortcuts: { 'file.open': 'Cmd+Shift+F' } })
    );

    const { shortcuts } = new ShortcutsService(
      { getCurrentKeyboardLayout: () => 'com.apple.keylayout.US' },
      'darwin'
    ).getConfig();

    expect(shortcuts['commandCenter.open']).toBe('Cmd+P');
  });

  it('binds the new workspace dialog cycles per platform and leaves the rest unbound', () => {
    const expected = { darwin: 'Ctrl+Tab', win32: 'Cmd+.', linux: 'Cmd+.' } as const;
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      vfs.clear();
      const service = new ShortcutsService({ getCurrentKeyboardLayout: () => 'us' }, platform);
      vi.advanceTimersByTime(1000);
      const { shortcuts } = service.getConfig();
      expect(shortcuts['newWorkspace.cycleAgent']).toBe(expected[platform]);
      expect(shortcuts['newWorkspace.cycleLaunchMode']).toBe('Shift+Tab');
      expect(shortcuts['newWorkspace.cycleEffort']).toBe('');
      expect(shortcuts['newWorkspace.branchMenu']).toBe('');
    }
  });

  it('keeps a new dialog default whose keys an upgrading user bound outside the dialog', () => {
    vfs.mock.mkdirSync('/mock/home/.komla/settings', { recursive: true });
    vfs.mock.writeFileSync(
      '/mock/home/.komla/settings/shortcuts.json',
      JSON.stringify({ _version: 1, shortcuts: { 'file.open': 'Ctrl+Tab' } })
    );

    const { shortcuts } = new ShortcutsService(
      { getCurrentKeyboardLayout: () => 'us' },
      'darwin'
    ).getConfig();

    expect(shortcuts['file.open']).toBe('Ctrl+Tab');
    expect(shortcuts['newWorkspace.cycleAgent']).toBe('Ctrl+Tab');
  });

  it('leaves a new dialog default unbound when its keys pick a project in the dialog', () => {
    vfs.mock.mkdirSync('/mock/home/.komla/settings', { recursive: true });
    vfs.mock.writeFileSync(
      '/mock/home/.komla/settings/shortcuts.json',
      JSON.stringify({ _version: 1, shortcuts: { 'workspace.select.1': 'Ctrl+Tab' } })
    );

    const { shortcuts } = new ShortcutsService(
      { getCurrentKeyboardLayout: () => 'us' },
      'darwin'
    ).getConfig();

    expect(shortcuts['newWorkspace.cycleAgent']).toBe('');
  });

  it('treats Cmd and Ctrl as the same keys on Linux when an upgrading user has them', () => {
    vfs.mock.mkdirSync('/mock/home/.komla/settings', { recursive: true });
    vfs.mock.writeFileSync(
      '/mock/home/.komla/settings/shortcuts.json',
      JSON.stringify({ _version: 1, shortcuts: { 'workspace.new': 'Ctrl+.' } })
    );

    const { shortcuts } = new ShortcutsService(
      { getCurrentKeyboardLayout: () => 'us' },
      'linux'
    ).getConfig();

    expect(shortcuts['newWorkspace.cycleAgent']).toBe('');
  });

  it('leaves a new dialog default unbound when Close pane has its keys', () => {
    vfs.mock.mkdirSync('/mock/home/.komla/settings', { recursive: true });
    vfs.mock.writeFileSync(
      '/mock/home/.komla/settings/shortcuts.json',
      JSON.stringify({ _version: 1, shortcuts: { 'pane.close': 'Ctrl+Tab' } })
    );

    const { shortcuts } = new ShortcutsService(
      { getCurrentKeyboardLayout: () => 'us' },
      'darwin'
    ).getConfig();

    expect(shortcuts['newWorkspace.cycleAgent']).toBe('');
  });

  it('includes isUSKeyboardLayout in getConfig for US layout', () => {
    const config = shortcutsService.getConfig();
    expect(config.isUSKeyboardLayout).toBe(true);
  });

  it('includes isUSKeyboardLayout false for non-US layout', () => {
    vfs.clear();
    const service = new ShortcutsService(
      { getCurrentKeyboardLayout: () => 'com.apple.keylayout.Norwegian' },
      'darwin'
    );
    vi.advanceTimersByTime(1000);
    const config = service.getConfig();
    expect(config.isUSKeyboardLayout).toBe(false);
  });

  it('initializes with international shortcuts when layout is non-US', async () => {
    vfs.clear();

    shortcutsService = new ShortcutsService(
      { getCurrentKeyboardLayout: () => 'com.apple.keylayout.German' },
      'darwin'
    );
    vi.advanceTimersByTime(1000);

    const content = JSON.parse(vfs.getFile('/mock/home/.komla/settings/shortcuts.json') as string);
    expect(content.shortcuts['tab.next']).toBe('Cmd+Shift+.');
    expect(content.shortcuts['tab.previous']).toBe('Cmd+Shift+,');
    expect(content.shortcuts['pane.splitRight']).toBe('Cmd+D');
    expect(content.shortcuts['pane.splitDown']).toBe('Cmd+Shift+D');
  });

  it('merges existing config with defaults', async () => {
    vfs.mock.mkdirSync('/mock/home/.komla/settings', { recursive: true });
    const existing = {
      shortcuts: {
        'custom.action': 'Cmd+X',
        'pane.splitRight': 'Cmd+\\',
        'pane.splitDown': 'Cmd+Shift+\\',
      },
    };
    vfs.mock.writeFileSync('/mock/home/.komla/settings/shortcuts.json', JSON.stringify(existing));

    shortcutsService = new ShortcutsService(
      { getCurrentKeyboardLayout: () => 'com.apple.keylayout.US' },
      'darwin'
    );

    // Load config happens in constructor
    const config = shortcutsService.getConfig();
    expect(config.shortcuts['custom.action']).toBe('Cmd+X');
    expect(config.shortcuts['tab.next']).toBe('Cmd+]'); // Merged default
    expect(config.shortcuts['pane.splitRight']).toBe('Cmd+\\');
    expect(config.shortcuts['pane.splitDown']).toBe('Cmd+Shift+\\');
  });

  it('does not overwrite shortcut configs from a newer app version', () => {
    vfs.mock.mkdirSync('/mock/home/.komla/settings', { recursive: true });
    const futureConfig = JSON.stringify({
      _version: 2,
      shortcuts: { 'diff.toggle': 'Cmd+Ctrl+D' },
      futureSetting: { enabled: true },
    });
    vfs.mock.writeFileSync('/mock/home/.komla/settings/shortcuts.json', futureConfig);

    const service = new ShortcutsService(
      { getCurrentKeyboardLayout: () => 'com.apple.keylayout.US' },
      'darwin'
    );

    expect(service.getConfig().shortcuts['diff.toggle']).toBe('Cmd+Ctrl+D');

    vi.advanceTimersByTime(1000);
    expect(vfs.getFile('/mock/home/.komla/settings/shortcuts.json')).toBe(futureConfig);
  });

  it('updates config and persists with debounce', () => {
    shortcutsService.updateConfig({ shortcuts: { 'tab.next': 'Ctrl+Tab' } });

    const config = shortcutsService.getConfig();
    expect(config.shortcuts['tab.next']).toBe('Ctrl+Tab');

    // Advance time to trigger debounce
    vi.advanceTimersByTime(600);

    const content = JSON.parse(vfs.getFile('/mock/home/.komla/settings/shortcuts.json') as string);
    expect(content.shortcuts['tab.next']).toBe('Ctrl+Tab');
  });

  it('resets config to defaults', () => {
    shortcutsService.updateConfig({ shortcuts: { 'tab.next': 'Ctrl+Tab' } });
    vi.advanceTimersByTime(1000);

    shortcutsService.resetConfig();
    vi.advanceTimersByTime(1000);

    const config = shortcutsService.getConfig();
    expect(config.shortcuts['tab.next']).toBe('Cmd+]');

    const content = JSON.parse(vfs.getFile('/mock/home/.komla/settings/shortcuts.json') as string);
    expect(content.shortcuts['tab.next']).toBe('Cmd+]');
  });

  it('uses Cmd+Shift overrides on Windows to avoid terminal conflicts', async () => {
    vfs.clear();

    shortcutsService = new ShortcutsService({ getCurrentKeyboardLayout: () => 'us' }, 'win32');
    vi.advanceTimersByTime(1000);

    const config = shortcutsService.getConfig();
    // These should have Shift added to avoid Ctrl+<key> terminal conflicts
    expect(config.shortcuts['diff.toggle']).toBe('Cmd+Shift+D');
    expect(config.shortcuts['pane.splitRight']).toBe('Cmd+\\');
    expect(config.shortcuts['pane.splitDown']).toBe('Cmd+Shift+\\');
    expect(config.shortcuts['pane.focusNext']).toBe('Cmd+Shift+K');
    expect(config.shortcuts['pane.focusPrev']).toBe('Cmd+Shift+J');
    expect(config.shortcuts['file.tree']).toBe('Cmd+Shift+E');
    expect(config.shortcuts['inline.file.tree']).toBe('Cmd+Shift+B');
    // Backspace shortcuts remap to Delete key to free Ctrl+Backspace (delete previous word)
    expect(config.shortcuts['workspace.trash']).toBe('Cmd+Shift+Delete');

    // These should remain unchanged (standard Windows conventions)
    expect(config.shortcuts['terminal.new']).toBe('Cmd+T');
    expect(config.shortcuts['terminal.search']).toBe('Cmd+F');
    expect(config.shortcuts['workspace.new']).toBe('Cmd+N');
    expect(config.shortcuts['pane.close']).toBe('Cmd+Alt+W');
  });

  it('uses Cmd+Shift overrides on Linux to avoid terminal conflicts', async () => {
    vfs.clear();

    shortcutsService = new ShortcutsService({ getCurrentKeyboardLayout: () => 'us' }, 'linux');
    vi.advanceTimersByTime(1000);

    const config = shortcutsService.getConfig();
    // These should have Shift added to avoid Ctrl+<key> terminal conflicts
    expect(config.shortcuts['diff.toggle']).toBe('Cmd+Shift+D');
    expect(config.shortcuts['pane.splitRight']).toBe('Cmd+\\');
    expect(config.shortcuts['pane.splitDown']).toBe('Cmd+Shift+\\');
    expect(config.shortcuts['pane.focusNext']).toBe('Cmd+Shift+K');
    expect(config.shortcuts['pane.focusPrev']).toBe('Cmd+Shift+J');
    expect(config.shortcuts['file.tree']).toBe('Cmd+Shift+E');
    expect(config.shortcuts['inline.file.tree']).toBe('Cmd+Shift+B');
    // Backspace shortcuts remap to Delete key to free Ctrl+Backspace (delete previous word)
    expect(config.shortcuts['workspace.trash']).toBe('Cmd+Shift+Delete');

    // These should remain unchanged
    expect(config.shortcuts['terminal.new']).toBe('Cmd+T');
    expect(config.shortcuts['terminal.search']).toBe('Cmd+F');
    expect(config.shortcuts['workspace.new']).toBe('Cmd+N');
    expect(config.shortcuts['pane.close']).toBe('Cmd+Alt+W');
  });

  it('does not apply Windows/Linux overrides on macOS', () => {
    const config = shortcutsService.getConfig();
    // macOS uses Cmd (Meta), so no conflict with terminal Ctrl sequences
    expect(config.shortcuts['diff.toggle']).toBe('Cmd+Shift+G');
    expect(config.shortcuts['pane.splitRight']).toBe('Cmd+D');
    expect(config.shortcuts['pane.splitDown']).toBe('Cmd+Shift+D');
    expect(config.shortcuts['pane.focusNext']).toBe('Cmd+K');
    expect(config.shortcuts['pane.focusPrev']).toBe('Cmd+J');
    expect(config.shortcuts['file.tree']).toBe('Cmd+Shift+E');
    expect(config.shortcuts['inline.file.tree']).toBe('Cmd+B');
    expect(config.shortcuts['pane.close']).toBe('Cmd+W');
    expect(config.shortcuts['workspace.trash']).toBe('Cmd+Shift+Backspace');
    expect(config.shortcuts['voice.record']).toBe('DoubleTap+Meta');
  });

  it('applies both platform and layout overrides on Windows with international keyboard', async () => {
    vfs.clear();

    shortcutsService = new ShortcutsService(
      { getCurrentKeyboardLayout: () => 'com.apple.keylayout.German' },
      'win32'
    );
    vi.advanceTimersByTime(1000);

    const config = shortcutsService.getConfig();
    // Platform override
    expect(config.shortcuts['diff.toggle']).toBe('Cmd+Shift+D');
    // Layout override
    expect(config.shortcuts['tab.next']).toBe('Cmd+Shift+.');
    expect(config.shortcuts['pane.splitRight']).toBe('Cmd+/');
    expect(config.shortcuts['pane.splitDown']).toBe('Cmd+Shift+/');
  });

  it('resets to platform-aware defaults', async () => {
    vfs.clear();

    shortcutsService = new ShortcutsService({ getCurrentKeyboardLayout: () => 'us' }, 'win32');
    vi.advanceTimersByTime(1000);

    // Customize a shortcut
    shortcutsService.updateConfig({ shortcuts: { 'diff.toggle': 'Cmd+X' } });
    expect(shortcutsService.getConfig().shortcuts['diff.toggle']).toBe('Cmd+X');

    // Reset should restore Windows-aware defaults (with Shift)
    shortcutsService.resetConfig();
    expect(shortcutsService.getConfig().shortcuts['diff.toggle']).toBe('Cmd+Shift+D');
  });

  it('skips layout detection on subsequent starts when cache exists', async () => {
    // First start: layout is detected and cached
    vfs.clear();
    const layoutProvider = vi.fn().mockReturnValue('com.apple.keylayout.German');
    shortcutsService = new ShortcutsService({ getCurrentKeyboardLayout: layoutProvider }, 'darwin');
    vi.advanceTimersByTime(1000);
    expect(layoutProvider).toHaveBeenCalled();

    // Verify cache was written
    expect(vfs.hasFile('/mock/home/.komla/settings/keyboard-layout.json')).toBe(true);
    const cache = JSON.parse(
      vfs.getFile('/mock/home/.komla/settings/keyboard-layout.json') as string
    );
    expect(cache.isUS).toBe(false);

    // Second start: layout provider should NOT be called (cache hit)
    const layoutProvider2 = vi.fn().mockReturnValue('com.apple.keylayout.US');
    shortcutsService = new ShortcutsService(
      { getCurrentKeyboardLayout: layoutProvider2 },
      'darwin'
    );
    vi.advanceTimersByTime(1000);
    expect(layoutProvider2).not.toHaveBeenCalled();

    // Should still use international defaults from cached result
    const config = shortcutsService.getConfig();
    expect(config.shortcuts['tab.next']).toBe('Cmd+Shift+.');
  });

  it('re-detects keyboard layout on resetConfig when layout has changed', async () => {
    // First start with German layout — caches isUS=false
    vfs.clear();
    const layoutProvider = vi.fn().mockReturnValue('com.apple.keylayout.German');
    shortcutsService = new ShortcutsService({ getCurrentKeyboardLayout: layoutProvider }, 'darwin');
    vi.advanceTimersByTime(1000);
    expect(shortcutsService.getConfig().shortcuts['tab.next']).toBe('Cmd+Shift+.'); // international

    // User switches to US layout
    layoutProvider.mockReturnValue('com.apple.keylayout.US');

    // Reset should re-detect and use US defaults
    shortcutsService.resetConfig();
    vi.advanceTimersByTime(1000);
    expect(shortcutsService.getConfig().shortcuts['tab.next']).toBe('Cmd+]'); // US

    // Cache file should be updated
    const cache = JSON.parse(
      vfs.getFile('/mock/home/.komla/settings/keyboard-layout.json') as string
    );
    expect(cache.isUS).toBe(true);
  });

  it('notifies renderer on file change', async () => {
    const window = createMockBrowserWindow();
    (
      electronMock.BrowserWindow as unknown as { getAllWindows: ReturnType<typeof vi.fn> }
    ).getAllWindows.mockReturnValue([window]);

    await shortcutsService.init();

    // Simulate external change
    vfs.mock.writeFileSync(
      '/mock/home/.komla/settings/shortcuts.json',
      JSON.stringify({
        shortcuts: { 'tab.next': 'Cmd+Shift+]' },
      })
    );

    if (mockWatcherCallback) mockWatcherCallback();

    expect(window.webContents.send).toHaveBeenCalledWith(
      'shortcuts:changed',
      expect.objectContaining({
        shortcuts: expect.objectContaining({ 'tab.next': 'Cmd+Shift+]' }),
      })
    );
  });
});
