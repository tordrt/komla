import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { createRequire } from 'module';
import { join } from 'path';

import { BrowserWindow } from 'electron';

import { IPC } from '../../shared/constants/ipc-channels';
import { isUSLayout, UNIVERSAL_SHORTCUT_OVERRIDES } from '../../shared/constants/keyboard-layouts';
import {
  shortcutsShareScope,
  type NewWorkspaceDialogAction,
} from '../../shared/constants/shortcut-scopes';
import { writeFileAtomicSync } from '../lib/atomic-write';
import { migrate } from '../lib/migration';

import { FileWatcher } from './file-watcher';
import { getKomlaBasePath } from './paths';

// keyboard-layout is a native module compiled for the host platform.
// On cross-compiled builds (e.g. Windows built from macOS) it may not load.
// Lazy-loaded and memoized: only needed on first run to detect layout.
let _keyboardLayoutModule: { getCurrentKeyboardLayout(): string } | null | undefined;
const requireModule = createRequire(import.meta.url);

function requireKeyboardLayout(): { getCurrentKeyboardLayout(): string } | null {
  if (_keyboardLayoutModule !== undefined) return _keyboardLayoutModule;
  try {
    _keyboardLayoutModule = requireModule('keyboard-layout') as {
      getCurrentKeyboardLayout(): string;
    };
  } catch {
    _keyboardLayoutModule = null;
  }
  return _keyboardLayoutModule;
}

const SHORTCUTS_VERSION = 1;
const SHORTCUTS_MIGRATIONS: Record<
  number,
  (data: Record<string, unknown>) => Record<string, unknown>
> = {};

// The same keys whatever the case or modifier order, e.g. "Shift+Cmd+p" and "Cmd+Shift+P",
// and whichever name the platform's Cmd goes by, e.g. "Cmd+." and "Ctrl+." on Linux.
function toChord(shortcut: string, platform: NodeJS.Platform): string {
  const cmd = platform === 'darwin' ? 'meta' : 'ctrl';
  const parts = shortcut
    .toLowerCase()
    .split('+')
    .map((part) => (part === cmd ? 'cmd' : part));
  const key = parts.pop();
  return [...parts.sort(), key].join('+');
}

export interface ShortcutsConfig {
  _version?: number;
  shortcuts: Record<string, string>;
  isUSKeyboardLayout?: boolean;
}

// Only while the new workspace dialog is open. An empty string is unbound.
const NEW_WORKSPACE_DIALOG_DEFAULTS: Record<NewWorkspaceDialogAction, string> = {
  cycleAgent: 'Cmd+.',
  cycleLaunchMode: 'Shift+Tab',
  cycleEffort: '',
  cycleProject: '',
  cycleEnvironment: '',
  agentMenu: '',
  effortMenu: '',
  environmentMenu: '',
  branchMenu: '',
  projectSearch: '',
};

// Default shortcuts use "Cmd" as a platform-agnostic modifier.
// At runtime, "Cmd" becomes Meta (Mac) or Ctrl (Windows/Linux).
const DEFAULT_SHORTCUTS: ShortcutsConfig = {
  shortcuts: {
    'workspace.next': 'Cmd+ArrowDown',
    'workspace.previous': 'Cmd+ArrowUp',
    'workspace.select.1': 'Cmd+1',
    'workspace.select.2': 'Cmd+2',
    'workspace.select.3': 'Cmd+3',
    'workspace.select.4': 'Cmd+4',
    'workspace.select.5': 'Cmd+5',
    'workspace.select.6': 'Cmd+6',
    'workspace.select.7': 'Cmd+7',
    'workspace.select.8': 'Cmd+8',
    'workspace.select.9': 'Cmd+9',
    // Not Cmd+Shift+J: Windows/Linux use it for pane.focusPrev.
    'workspace.nextAttention': 'Cmd+Shift+A',
    'workspace.new': 'Cmd+N',
    'workspace.overview': 'Cmd+Shift+O',
    'commandCenter.open': 'Cmd+P',
    // Not Cmd+B, the file tree panel's on macOS, nor Cmd+Alt+B: Option+B types ∫ on macOS and
    // Ctrl+Alt is AltGr on some Windows layouts.
    'sidebar.toggle': 'Cmd+Shift+S',
    'workspace.stop': 'Cmd+Shift+W',
    // Not Cmd+Backspace, which deletes to the line's start, so a stray press is too easy. The
    // Trash keeps the workspace and offers Undo; deleting it for good has no default.
    'workspace.trash': 'Cmd+Shift+Backspace',
    'workspace.delete': '',
    'diff.toggle': 'Cmd+Shift+D',
    'history.toggle': 'Cmd+Shift+H',
    'pane.close': 'Cmd+W',
    'pane.splitRight': 'Cmd+\\',
    'pane.splitDown': 'Cmd+Shift+\\',
    'pane.focusNext': 'Cmd+K',
    'pane.focusPrev': 'Cmd+J',

    'tab.newAgent': 'Cmd+Shift+T',
    'terminal.new': 'Cmd+T',
    'file.open': 'DoubleTap+Shift',
    'file.tree': 'Cmd+Shift+E',
    'inline.file.tree': 'Cmd+B',
    // As in Orca. Not Cmd+Shift+N, which opens a new window.
    'note.new': 'Cmd+Shift+M',
    'tab.next': 'Cmd+]',
    'tab.previous': 'Cmd+[',
    'terminal.scrollToBottom': 'Cmd+Shift+ArrowDown',
    'terminal.search': 'Cmd+F',
    'voice.record': 'DoubleTap+Meta',

    ...Object.fromEntries(
      Object.entries(NEW_WORKSPACE_DIALOG_DEFAULTS).map(([action, keys]) => [
        `newWorkspace.${action}`,
        keys,
      ])
    ),
  },
};

const MACOS_OVERRIDES: Record<string, string> = {
  // Unbound on Windows/Linux: Ctrl+O belongs to terminal programs, Ctrl+Shift+O is the
  // overview, and Ctrl+Alt+O types ó on some layouts.
  'workspace.openFolder': 'Cmd+O',
  'diff.toggle': 'Cmd+Shift+G',
  'pane.splitRight': 'Cmd+D',
  'pane.splitDown': 'Cmd+Shift+D',
  'newWorkspace.cycleAgent': 'Ctrl+Tab',
};

// On Windows/Linux, "Cmd" maps to Ctrl, which conflicts with terminal
// control sequences (readline bindings). These overrides add Shift to
// free up the plain Ctrl variants for terminal use.
const WINDOWS_LINUX_OVERRIDES: Record<string, string> = {
  'diff.toggle': 'Cmd+Shift+D', // frees Ctrl+D (EOF / exit)
  'pane.splitRight': 'Cmd+\\', // frees Ctrl+D (EOF / exit)
  'pane.splitDown': 'Cmd+Shift+\\',
  'pane.focusNext': 'Cmd+Shift+K', // frees Ctrl+K (kill to end of line)
  'pane.focusPrev': 'Cmd+Shift+J', // frees Ctrl+J (newline / accept line)
  'pane.close': 'Cmd+Alt+W', // frees Ctrl+W (delete previous word)
  'file.tree': 'Cmd+Shift+E', // frees Ctrl+E (move to end of line)
  'inline.file.tree': 'Cmd+Shift+B', // frees Ctrl+B (move cursor back)
  'workspace.trash': 'Cmd+Shift+Delete', // frees Ctrl+Shift+Backspace
  'voice.record': 'DoubleTap+Ctrl', // Meta maps to Super/Win key, use Ctrl instead
  'commandCenter.open': 'Cmd+Shift+P', // frees Ctrl+P (previous history)
  'workspace.openFolder': '',
};

export class ShortcutsService {
  private settingsPath: string;
  private shortcutsPath: string;
  private defaultsPath: string;
  private defaultShortcutsPath: string;
  private layoutCachePath: string;
  private watcher: FileWatcher | null = null;
  private config: ShortcutsConfig;
  private initialized = false;
  private cachedIsUS: boolean | undefined;
  private forceRedetect = false;
  private saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly SAVE_DEBOUNCE_MS = 500;

  constructor(
    private layoutProvider?: { getCurrentKeyboardLayout: () => string },
    private platform: NodeJS.Platform = process.platform
  ) {
    this.settingsPath = join(getKomlaBasePath(), 'settings');
    this.shortcutsPath = join(this.settingsPath, 'shortcuts.json');
    this.defaultsPath = join(this.settingsPath, 'defaults');
    this.defaultShortcutsPath = join(this.defaultsPath, 'shortcuts.json');
    this.layoutCachePath = join(this.settingsPath, 'keyboard-layout.json');

    this.ensureSettingsDirectory();
    this.config = this.loadConfig();
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    await this.startWatcher();
  }

  /**
   * Detects if the current keyboard layout is US/QWERTY-style.
   * Result is cached in memory and persisted to disk so the native
   * keyboard-layout module is only loaded once (on first run).
   */
  private isUSKeyboardLayout(): boolean {
    // In-memory cache (covers multiple calls within the same process)
    if (this.cachedIsUS !== undefined) return this.cachedIsUS;

    // Persisted cache (covers subsequent app starts without native module)
    if (!this.forceRedetect) {
      try {
        if (existsSync(this.layoutCachePath)) {
          const data = JSON.parse(readFileSync(this.layoutCachePath, 'utf-8'));
          if (typeof data.isUS === 'boolean') {
            this.cachedIsUS = data.isUS;
            return data.isUS;
          }
        }
      } catch {
        // Corrupted cache — fall through to detection
      }
    }
    this.forceRedetect = false;

    // Detect via injected provider or native module
    const result = this.detectKeyboardLayout();

    // Only cache and persist when detection actually succeeded.
    // Fallback (null) defaults to US but is not persisted, so a
    // transient failure won't poison the cache for international users.
    if (result !== null) {
      this.cachedIsUS = result;
      try {
        writeFileSync(this.layoutCachePath, JSON.stringify({ isUS: result }), 'utf-8');
      } catch {
        // Non-fatal — will re-detect next time
      }
      return result;
    }

    // Detection failed — remove any stale disk cache so next startup re-detects
    try {
      if (existsSync(this.layoutCachePath)) unlinkSync(this.layoutCachePath);
    } catch {
      // Best-effort cleanup
    }

    // Default to US without caching
    return true;
  }

  /**
   * Performs actual keyboard layout detection via provider or native module.
   * Returns null when detection fails (module unavailable, exception, etc.).
   */
  private detectKeyboardLayout(): boolean | null {
    if (this.layoutProvider) {
      try {
        const layoutId = this.layoutProvider.getCurrentKeyboardLayout();
        console.log(`[ShortcutsService] Detected keyboard layout (via provider): ${layoutId}`);
        return isUSLayout(layoutId);
      } catch (error) {
        console.warn('[ShortcutsService] Failed to detect keyboard layout via provider:', error);
      }
    }

    const keyboardLayout = requireKeyboardLayout();
    if (!keyboardLayout) {
      console.warn(
        '[ShortcutsService] keyboard-layout native module not available, defaulting to US'
      );
      return null;
    }
    try {
      const layoutId = keyboardLayout.getCurrentKeyboardLayout();
      console.log(`[ShortcutsService] Detected keyboard layout: ${layoutId}`);
      return isUSLayout(layoutId);
    } catch (error) {
      console.warn('[ShortcutsService] Failed to detect keyboard layout, defaulting to US:', error);
      return null;
    }
  }

  /**
   * Returns defaults adjusted for the current platform and keyboard layout.
   * - Windows/Linux: adds Shift to shortcuts that conflict with terminal readline bindings
   * - International layouts: remaps bracket/backslash shortcuts to universally accessible keys
   */
  private getDefaults(): ShortcutsConfig {
    let shortcuts = { ...DEFAULT_SHORTCUTS.shortcuts };

    // Apply Windows/Linux overrides to avoid Ctrl+<key> conflicts with terminal
    if (this.platform === 'darwin') {
      shortcuts = { ...shortcuts, ...MACOS_OVERRIDES };
    } else {
      shortcuts = { ...shortcuts, ...WINDOWS_LINUX_OVERRIDES };
    }

    // Apply international keyboard layout overrides
    if (!this.isUSKeyboardLayout()) {
      console.log('[ShortcutsService] Using international keyboard layout defaults');
      shortcuts = {
        ...shortcuts,
        ...UNIVERSAL_SHORTCUT_OVERRIDES,
        ...(this.platform === 'darwin'
          ? {
              'pane.splitRight': MACOS_OVERRIDES['pane.splitRight'],
              'pane.splitDown': MACOS_OVERRIDES['pane.splitDown'],
            }
          : {}),
      };
    } else {
      console.log('[ShortcutsService] Using US keyboard layout defaults');
    }

    return { shortcuts };
  }

  private ensureSettingsDirectory(): void {
    // Create settings directory
    if (!existsSync(this.settingsPath)) {
      mkdirSync(this.settingsPath, { recursive: true });
    }

    // Create defaults directory if needed
    if (!existsSync(this.defaultsPath)) {
      mkdirSync(this.defaultsPath, { recursive: true });
    }

    // Write defaults file for reference on first run
    if (!existsSync(this.defaultShortcutsPath)) {
      writeFileSync(
        this.defaultShortcutsPath,
        JSON.stringify(this.getDefaults(), null, 2),
        'utf-8'
      );
    }

    // Write user config if not exists - use platform/layout-aware defaults on first run
    if (!existsSync(this.shortcutsPath)) {
      this.writeConfig(this.getDefaults());
    }
  }

  private loadConfig(): ShortcutsConfig {
    try {
      if (existsSync(this.shortcutsPath)) {
        const data = readFileSync(this.shortcutsPath, 'utf-8');
        const parsed = migrate(
          JSON.parse(data) as Record<string, unknown>,
          SHORTCUTS_VERSION,
          SHORTCUTS_MIGRATIONS
        ) as unknown as ShortcutsConfig;
        return this.mergeWithDefaults(parsed);
      }
    } catch (error) {
      console.error('Failed to load shortcuts config:', error);
    }
    const defaults = this.getDefaults();
    return { shortcuts: { ...defaults.shortcuts } };
  }

  private mergeWithDefaults(partial: Partial<ShortcutsConfig>): ShortcutsConfig {
    const defaults = this.getDefaults();
    const saved = partial.shortcuts ?? {};
    // A default added after the config was saved gives way to keys the user already
    // bound where both can be pressed, and is then left unbound.
    const taken = Object.entries(saved).flatMap(([action, keys]) =>
      keys ? [{ action, chord: toChord(keys, this.platform) }] : []
    );
    const shortcuts: Record<string, string> = {};
    for (const [action, shortcut] of Object.entries(defaults.shortcuts)) {
      if (action in saved) {
        shortcuts[action] = saved[action];
        continue;
      }
      const chord = shortcut && toChord(shortcut, this.platform);
      const isTaken = taken.some(
        (other) => other.chord === chord && shortcutsShareScope(action, other.action)
      );
      shortcuts[action] = isTaken ? '' : shortcut;
    }
    return { shortcuts: { ...shortcuts, ...saved } };
  }

  private writeConfig(config: ShortcutsConfig): void {
    // Debounce writes to prevent cascading freezes during rapid updates
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
    }
    this.saveDebounceTimer = setTimeout(() => {
      try {
        writeFileAtomicSync(
          this.shortcutsPath,
          JSON.stringify({ ...config, _version: SHORTCUTS_VERSION }, null, 2)
        );
      } catch (error) {
        console.error('Failed to write shortcuts config:', error);
      }
    }, this.SAVE_DEBOUNCE_MS);
  }

  private async startWatcher(): Promise<void> {
    this.watcher = new FileWatcher(this.shortcutsPath, () => {
      const newConfig = this.loadConfig();
      this.config = newConfig;
      this.notifyRenderer(IPC.SHORTCUTS_CHANGED, this.getConfig());
    });
    await this.watcher.start();
  }

  private notifyRenderer(channel: string, data: unknown): void {
    const windows = BrowserWindow.getAllWindows();
    for (const window of windows) {
      if (!window.isDestroyed()) {
        window.webContents.send(channel, data);
      }
    }
  }

  // Public API

  getConfig(): ShortcutsConfig {
    return {
      shortcuts: { ...this.config.shortcuts },
      isUSKeyboardLayout: this.isUSKeyboardLayout(),
    };
  }

  getShortcut(action: string): string | undefined {
    return this.config.shortcuts[action];
  }

  updateConfig(updates: Partial<ShortcutsConfig>): ShortcutsConfig {
    if (updates.shortcuts) {
      this.config.shortcuts = {
        ...this.config.shortcuts,
        ...updates.shortcuts,
      };
    }
    this.writeConfig(this.config);
    return this.getConfig();
  }

  resetConfig(): ShortcutsConfig {
    // Clear cached layout so reset re-detects the current keyboard layout
    this.cachedIsUS = undefined;
    this.forceRedetect = true;

    const defaults = this.getDefaults();
    this.config = { shortcuts: { ...defaults.shortcuts } };
    this.writeConfig(this.config);
    return this.getConfig();
  }

  async dispose(): Promise<void> {
    if (this.watcher) {
      await this.watcher.stop();
      this.watcher = null;
    }
  }
}

export const shortcutsService = new ShortcutsService();
