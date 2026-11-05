import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

import { BrowserWindow } from 'electron';

import { IPC } from '../../shared/constants/ipc-channels';
import { buildSkillFetchInstruction } from '../../shared/constants/skill-fetch-instruction';
import { DEFAULT_TERMINAL_CONFIG } from '../../shared/constants/terminal';
import {
  CUSTOM_PALETTE_ID,
  DEFAULT_ACCENT,
  DEFAULT_LIGHT_ACCENT,
  DEFAULT_PALETTE_ID,
  LIGHT_PALETTE_ID,
  themeChoice,
  themeMode,
} from '../../shared/lib/appearance';
import { writeFileAtomicSync } from '../lib/atomic-write';
import { migrate } from '../lib/migration';

import { MultiFileWatcher } from './file-watcher';
import { getKomlaBasePath } from './paths';
import { windowService } from './window.service';

import type {
  AppearanceSettings,
  ThemeConfig,
  TerminalColorConfig,
  TerminalConfig,
} from '../../shared/types';

export type { ThemeConfig, TerminalColorConfig, TerminalConfig };

/** An update whose nested objects merge key by key into the current config. */
export type ConfigUpdate<T> = {
  [K in keyof T]?: T[K] extends object ? Partial<T[K]> : T[K];
};

const THEME_VERSION = 1;
const THEME_MIGRATIONS: Record<number, (data: Record<string, unknown>) => Record<string, unknown>> =
  {};

const TERMINAL_VERSION = 1;
const TERMINAL_MIGRATIONS: Record<
  number,
  (data: Record<string, unknown>) => Record<string, unknown>
> = {};

// The custom theme's accent while the theme, or the light theme while following the system, is
// the custom theme.
function customThemeAccent(theme: ThemeConfig): string | undefined {
  if (theme.palette === CUSTOM_PALETTE_ID) return theme.colors.accent;
  if (theme.followSystem && theme.lightPalette === CUSTOM_PALETTE_ID) {
    return theme.colors.lightAccent;
  }
  return undefined;
}

// Removing or replacing the custom theme moves a slot still on it back to that slot's Komla theme,
// so neither the theme nor the light theme is left on a missing custom theme or one of the wrong
// mode.
function withoutStaleCustomTheme(theme: ThemeConfig): ThemeConfig {
  const mode = theme.customPalette?.mode;
  let next = theme;
  if (
    theme.palette === CUSTOM_PALETTE_ID &&
    (mode === undefined || (theme.followSystem && mode !== 'dark'))
  ) {
    next = {
      ...next,
      palette: DEFAULT_PALETTE_ID,
      colors: { ...next.colors, accent: DEFAULT_ACCENT },
    };
  }
  if (theme.lightPalette === CUSTOM_PALETTE_ID && mode !== 'light') {
    next = {
      ...next,
      lightPalette: LIGHT_PALETTE_ID,
      colors: { ...next.colors, lightAccent: DEFAULT_LIGHT_ACCENT },
    };
  }
  return next;
}

const DEFAULT_THEME: ThemeConfig = {
  mode: 'dark',
  palette: 'default',
  followSystem: false,
  lightPalette: LIGHT_PALETTE_ID,
  colors: {
    accent: DEFAULT_ACCENT,
    lightAccent: DEFAULT_LIGHT_ACCENT,
  },
  typography: {
    fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
    fontSize: 14,
    borderRadius: 10,
  },
};

function writeIfChanged(path: string, content: string): void {
  if (existsSync(path) && readFileSync(path, 'utf-8') === content) return;
  writeFileSync(path, content, 'utf-8');
}

// Komla owns these files, so an agent that finds its way here learns to use the CLI instead.
const AGENTS_CONTENT = `# Komla Settings

Komla keeps its settings in this folder. Don't edit, create or delete files here: Komla applies a
write here without the user seeing it first.

Change Komla's settings with the \`komla\` CLI instead, which shows the user each change before it
applies. ${buildSkillFetchInstruction('customize')} It explains \`komla settings get|apply|schema\`
for each part of Komla's settings.
`;

class CustomizationService {
  private settingsPath: string;
  private themePath: string;
  private terminalPath: string;
  private agentsMdPath: string;
  private geminiMdPath: string;
  private claudeMdPath: string;
  private defaultsPath: string;
  private defaultThemePath: string;
  private defaultTerminalPath: string;
  private watcher: MultiFileWatcher | null = null;
  private theme: ThemeConfig;
  private terminal: TerminalConfig;
  private initialized = false;
  private themeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private terminalDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly SAVE_DEBOUNCE_MS = 500;

  constructor() {
    this.settingsPath = join(getKomlaBasePath(), 'settings');
    this.themePath = join(this.settingsPath, 'theme.json');
    this.terminalPath = join(this.settingsPath, 'terminal.json');
    this.agentsMdPath = join(this.settingsPath, 'AGENTS.md');
    this.geminiMdPath = join(this.settingsPath, 'GEMINI.md');
    this.claudeMdPath = join(this.settingsPath, 'CLAUDE.md');
    this.defaultsPath = join(this.settingsPath, 'defaults');
    this.defaultThemePath = join(this.defaultsPath, 'theme.json');
    this.defaultTerminalPath = join(this.defaultsPath, 'terminal.json');

    this.ensureSettingsDirectory();
    this.theme = this.loadTheme();
    this.terminal = this.loadTerminal();
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    await this.startWatcher();
  }

  private ensureSettingsDirectory(): void {
    // Create settings directory
    if (!existsSync(this.settingsPath)) {
      mkdirSync(this.settingsPath, { recursive: true });
    }

    // Create presets directory
    const presetsPath = join(this.settingsPath, 'presets');
    if (!existsSync(presetsPath)) {
      mkdirSync(presetsPath, { recursive: true });
    }

    // Create defaults directory
    if (!existsSync(this.defaultsPath)) {
      mkdirSync(this.defaultsPath, { recursive: true });
    }
    if (!existsSync(this.defaultThemePath)) {
      writeFileSync(this.defaultThemePath, JSON.stringify(DEFAULT_THEME, null, 2), 'utf-8');
    }
    if (!existsSync(this.defaultTerminalPath)) {
      writeFileSync(
        this.defaultTerminalPath,
        JSON.stringify(DEFAULT_TERMINAL_CONFIG, null, 2),
        'utf-8'
      );
    }

    // Write default theme if not exists
    if (!existsSync(this.themePath)) {
      this.writeTheme(DEFAULT_THEME);
    }

    // Write default terminal config if not exists
    if (!existsSync(this.terminalPath)) {
      this.writeTerminal(DEFAULT_TERMINAL_CONFIG);
    }

    // Rewritten on every start, so a folder from an earlier version gets the current guidance.
    for (const path of [this.agentsMdPath, this.geminiMdPath, this.claudeMdPath]) {
      writeIfChanged(path, AGENTS_CONTENT);
    }
  }

  private loadTheme(): ThemeConfig {
    try {
      if (existsSync(this.themePath)) {
        const data = readFileSync(this.themePath, 'utf-8');
        const { _version: _v, ...rest } = migrate(
          JSON.parse(data) as Record<string, unknown>,
          THEME_VERSION,
          THEME_MIGRATIONS
        );
        return this.mergeWithDefaults(rest, DEFAULT_THEME);
      }
    } catch (error) {
      console.error('Failed to load theme config:', error);
    }
    return { ...DEFAULT_THEME };
  }

  private loadTerminal(): TerminalConfig {
    try {
      if (existsSync(this.terminalPath)) {
        const data = readFileSync(this.terminalPath, 'utf-8');
        const { _version: _v, ...rest } = migrate(
          JSON.parse(data) as Record<string, unknown>,
          TERMINAL_VERSION,
          TERMINAL_MIGRATIONS
        );
        return this.mergeWithDefaults(rest, DEFAULT_TERMINAL_CONFIG);
      }
    } catch (error) {
      console.error('Failed to load terminal config:', error);
    }
    return { ...DEFAULT_TERMINAL_CONFIG };
  }

  private mergeWithDefaults<T extends object>(partial: ConfigUpdate<T>, defaults: T): T {
    const result = { ...defaults };
    for (const key in partial) {
      if (partial[key] !== undefined) {
        const defaultVal = defaults[key];
        if (
          typeof partial[key] === 'object' &&
          partial[key] !== null &&
          !Array.isArray(partial[key]) &&
          typeof defaultVal === 'object' &&
          defaultVal !== null &&
          !Array.isArray(defaultVal)
        ) {
          result[key] = this.mergeWithDefaults(partial[key], defaultVal);
        } else {
          result[key] = partial[key] as T[Extract<keyof T, string>];
        }
      }
    }
    return result;
  }

  private writeTheme(theme: ThemeConfig): void {
    // Debounce writes to prevent cascading freezes during rapid updates
    if (this.themeDebounceTimer) {
      clearTimeout(this.themeDebounceTimer);
    }
    this.themeDebounceTimer = setTimeout(() => {
      try {
        writeFileAtomicSync(
          this.themePath,
          JSON.stringify({ _version: THEME_VERSION, ...theme }, null, 2)
        );
      } catch (error) {
        console.error('Failed to write theme config:', error);
      }
    }, this.SAVE_DEBOUNCE_MS);
  }

  private writeTerminal(terminal: TerminalConfig): void {
    // Debounce writes to prevent cascading freezes during rapid updates
    if (this.terminalDebounceTimer) {
      clearTimeout(this.terminalDebounceTimer);
    }
    this.terminalDebounceTimer = setTimeout(() => {
      try {
        writeFileAtomicSync(
          this.terminalPath,
          JSON.stringify({ _version: TERMINAL_VERSION, ...terminal }, null, 2)
        );
      } catch (error) {
        console.error('Failed to write terminal config:', error);
      }
    }, this.SAVE_DEBOUNCE_MS);
  }

  private async startWatcher(): Promise<void> {
    this.watcher = new MultiFileWatcher([this.themePath, this.terminalPath], (path) => {
      if (
        path === this.themePath ||
        path.endsWith('/theme.json') ||
        path.endsWith('\\theme.json')
      ) {
        const newTheme = this.loadTheme();
        this.theme = newTheme;
        this.notifyRenderer(IPC.CUSTOMIZATION_THEME_CHANGED, newTheme);
        this.syncTitleBarOverlay();
      } else if (
        path === this.terminalPath ||
        path.endsWith('/terminal.json') ||
        path.endsWith('\\terminal.json')
      ) {
        const newTerminal = this.loadTerminal();
        this.terminal = newTerminal;
        this.notifyRenderer(IPC.CUSTOMIZATION_TERMINAL_CHANGED, newTerminal);
      }
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

  getTheme(): ThemeConfig {
    return { ...this.theme };
  }

  getTerminal(): TerminalConfig {
    return JSON.parse(JSON.stringify(this.terminal));
  }

  updateTheme(updates: ConfigUpdate<ThemeConfig>): ThemeConfig {
    this.theme = this.withCustomAccentSaved(this.mergeWithDefaults(updates, this.theme));
    this.writeTheme(this.theme);
    return this.getTheme();
  }

  /**
   * Replaces the theme, accent and corner radius. A customPalette left out is removed. With
   * followSystem, a light theme and its accent replace the light theme, and any other the dark one.
   */
  setAppearance({ palette, customPalette, accent, borderRadius }: AppearanceSettings): ThemeConfig {
    const { customPalette: _previous, ...theme } = this.theme;
    this.theme = this.withCustomAccentSaved(
      withoutStaleCustomTheme({
        ...theme,
        ...themeChoice(theme, palette, themeMode(palette, customPalette), accent),
        ...(customPalette && { customPalette }),
        typography: { ...theme.typography, borderRadius },
      })
    );
    this.writeTheme(this.theme);
    return this.getTheme();
  }

  // Switching away from the custom theme saves its accent with it, so choosing it again brings
  // the accent back the way a built-in theme does.
  private withCustomAccentSaved(next: ThemeConfig): ThemeConfig {
    const accent = customThemeAccent(this.theme);
    if (
      accent === undefined ||
      customThemeAccent(next) !== undefined ||
      next.customPalette === undefined
    ) {
      return next;
    }
    return { ...next, customPalette: { ...next.customPalette, accent } };
  }

  updateTerminal(updates: ConfigUpdate<TerminalConfig>): TerminalConfig {
    this.terminal = this.mergeWithDefaults(updates, this.terminal);
    this.writeTerminal(this.terminal);
    return this.getTerminal();
  }

  resetTheme(): ThemeConfig {
    // A custom theme is the user's own work, so a reset switches away from it but keeps it.
    const { customPalette } = this.theme;
    this.theme = this.withCustomAccentSaved({
      ...DEFAULT_THEME,
      ...(customPalette && { customPalette }),
    });
    this.writeTheme(this.theme);
    return this.getTheme();
  }

  syncTitleBarOverlay(): void {
    windowService.updateTitleBarOverlay(true);
  }

  async dispose(): Promise<void> {
    if (this.watcher) {
      await this.watcher.stop();
      this.watcher = null;
    }
  }
}

export const customizationService = new CustomizationService();
