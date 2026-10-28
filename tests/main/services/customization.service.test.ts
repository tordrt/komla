import { join } from 'path';

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { createMockBrowserWindow, mockElectron } from '../../mocks/electron';
import { createVirtualFs, VirtualFilesystem } from '../../mocks/fs';

const electronMock = mockElectron();
vi.mock('electron', () => electronMock);

let vfs: VirtualFilesystem;

const mockWriteFileAtomicSync = vi.fn();
vi.mock('../../../src/main/lib/atomic-write', () => ({
  writeFileAtomicSync: mockWriteFileAtomicSync,
}));

interface MultiFileWatcherInstance {
  paths: string[];
  onChange: (path: string) => void;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}

let watcherInstance: MultiFileWatcherInstance | null = null;
vi.mock('../../../src/main/services/file-watcher', () => ({
  MultiFileWatcher: class {
    paths: string[];
    onChange: (path: string) => void;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;

    constructor(paths: string[], onChange: (path: string) => void) {
      this.paths = paths;
      this.onChange = onChange;
      this.start = vi.fn(() => Promise.resolve());
      this.stop = vi.fn(() => Promise.resolve());
      watcherInstance = {
        paths: this.paths,
        onChange: this.onChange,
        start: this.start,
        stop: this.stop,
      };
    }
  },
}));

const mockWindowService = {
  updateTitleBarOverlay: vi.fn(),
};
vi.mock('../../../src/main/services/window.service', () => ({
  windowService: mockWindowService,
}));

vi.mock('../../../src/main/services/paths', () => ({
  getKomlaBasePath: vi.fn(() => '/mock/home/.komla'),
}));

beforeEach(() => {
  vfs = createVirtualFs({
    '/mock/home/.komla/settings/theme.json': JSON.stringify({
      mode: 'dark',
      colors: {
        accent: 'oklch(0.62 0.15 250)',
        background: 'oklch(0.16 0.004 265)',
        foreground: 'oklch(0.91 0.006 265)',
        muted: 'oklch(0.24 0.005 265)',
        border: 'oklch(0.28 0.005 265)',
        destructive: 'oklch(0.52 0.18 25)',
      },
      typography: {
        fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
        fontSize: 14,
        borderRadius: 8,
      },
    }),
    '/mock/home/.komla/settings/terminal.json': JSON.stringify({
      font: { family: 'Menlo', size: 14, lineHeight: 1.2 },
      cursor: { style: 'block', blink: true },
      scrollback: 5000,
      colors: {
        background: '#131519',
        foreground: '#d4d4d8',
        cursor: '#60a5fa',
        selection: '#264f78',
        ansi: {
          black: '#131519',
          red: '#f87171',
          green: '#4ade80',
          yellow: '#fbbf24',
          blue: '#60a5fa',
          magenta: '#c084fc',
          cyan: '#22d3ee',
          white: '#d4d4d8',
          brightBlack: '#52525b',
          brightRed: '#fca5a5',
          brightGreen: '#86efac',
          brightYellow: '#fde68a',
          brightBlue: '#93c5fd',
          brightMagenta: '#d8b4fe',
          brightCyan: '#67e8f9',
          brightWhite: '#f4f4f5',
        },
      },
    }),
  });
});

vi.mock('fs', () => ({
  existsSync: vi.fn((...args) => vfs.mock.existsSync(...args)),
  readFileSync: vi.fn((...args) => vfs.mock.readFileSync(...args)),
  writeFileSync: vi.fn((...args) => vfs.mock.writeFileSync(...args)),
  mkdirSync: vi.fn((...args) => vfs.mock.mkdirSync(...args)),
}));

describe('CustomizationService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.useFakeTimers();
    watcherInstance = null;
    mockWriteFileAtomicSync.mockImplementation((path: string, data: string) => {
      vfs.mock.writeFileSync(path, data);
    });

    const win = createMockBrowserWindow();
    (
      electronMock.BrowserWindow as unknown as { getAllWindows: ReturnType<typeof vi.fn> }
    ).getAllWindows.mockReturnValue([win]);
  });

  it('debounces theme writes and persists only latest update', async () => {
    const { customizationService } =
      await import('../../../src/main/services/customization.service');

    customizationService.updateTheme({
      colors: {
        accent: 'red',
        background: '',
        foreground: '',
        muted: '',
        border: '',
        destructive: '',
      },
    });
    customizationService.updateTheme({
      colors: {
        accent: 'blue',
        background: '',
        foreground: '',
        muted: '',
        border: '',
        destructive: '',
      },
    });

    vi.advanceTimersByTime(499);
    expect(mockWriteFileAtomicSync).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(mockWriteFileAtomicSync).toHaveBeenCalledTimes(1);
    expect(mockWriteFileAtomicSync).toHaveBeenCalledWith(
      join('/mock/home/.komla/settings/theme.json'),
      expect.stringContaining('"accent": "blue"')
    );
  });

  it('reloads theme from watcher and notifies renderer + titlebar sync', async () => {
    const win = createMockBrowserWindow();
    (
      electronMock.BrowserWindow as unknown as { getAllWindows: ReturnType<typeof vi.fn> }
    ).getAllWindows.mockReturnValue([win]);
    const { customizationService } =
      await import('../../../src/main/services/customization.service');
    await customizationService.init();

    vfs.mock.writeFileSync(
      '/mock/home/.komla/settings/theme.json',
      JSON.stringify({ mode: 'dark' })
    );
    watcherInstance?.onChange('/mock/home/.komla/settings/theme.json');

    expect(win.webContents.send).toHaveBeenCalledWith(
      'customization:theme-changed',
      expect.objectContaining({ mode: 'dark' })
    );
    expect(mockWindowService.updateTitleBarOverlay).toHaveBeenCalledWith(true);
  });

  it('reloads terminal from watcher and emits terminal change event', async () => {
    const win = createMockBrowserWindow();
    (
      electronMock.BrowserWindow as unknown as { getAllWindows: ReturnType<typeof vi.fn> }
    ).getAllWindows.mockReturnValue([win]);
    const { customizationService } =
      await import('../../../src/main/services/customization.service');
    await customizationService.init();

    vfs.mock.writeFileSync(
      '/mock/home/.komla/settings/terminal.json',
      JSON.stringify({ font: { size: 18 } })
    );
    watcherInstance?.onChange('/mock/home/.komla/settings/terminal.json');

    expect(win.webContents.send).toHaveBeenCalledWith(
      'customization:terminal-changed',
      expect.objectContaining({ font: expect.objectContaining({ size: 18 }) })
    );
  });

  it('falls back to defaults when theme file cannot be parsed', async () => {
    vfs = createVirtualFs({
      '/mock/home/.komla/settings/theme.json': '{ bad json',
      '/mock/home/.komla/settings/terminal.json': JSON.stringify({}),
    });

    const { customizationService } =
      await import('../../../src/main/services/customization.service');

    expect(customizationService.getTheme().mode).toBe('dark');
  });

  it('reads the palette from theme.json and defaults it when the file has none', async () => {
    vfs = createVirtualFs({
      '/mock/home/.komla/settings/theme.json': JSON.stringify({ mode: 'dark' }),
      '/mock/home/.komla/settings/terminal.json': JSON.stringify({}),
    });
    const { customizationService } =
      await import('../../../src/main/services/customization.service');
    expect(customizationService.getTheme().palette).toBe('default');

    vfs.mock.writeFileSync(
      '/mock/home/.komla/settings/theme.json',
      JSON.stringify({ palette: 'nord' })
    );
    await customizationService.init();
    watcherInstance?.onChange('/mock/home/.komla/settings/theme.json');
    expect(customizationService.getTheme().palette).toBe('nord');
  });

  it('replaces the appearance settings, removing a custom theme left out', async () => {
    vfs = createVirtualFs({
      '/mock/home/.komla/settings/theme.json': JSON.stringify({
        palette: 'custom',
        customPalette: { mode: 'dark', surfaces: { popover: '#111111' } },
      }),
      '/mock/home/.komla/settings/terminal.json': JSON.stringify({}),
    });
    const { customizationService } =
      await import('../../../src/main/services/customization.service');

    const theme = customizationService.setAppearance({
      palette: 'nord',
      accent: 'oklch(0.65 0.15 145)',
      borderRadius: 8,
    });

    expect(theme).toMatchObject({
      palette: 'nord',
      colors: { accent: 'oklch(0.65 0.15 145)' },
      typography: { fontSize: 14, borderRadius: 8 },
    });
    expect(theme.customPalette).toBeUndefined();
    vi.advanceTimersByTime(500);
    expect(mockWriteFileAtomicSync).toHaveBeenCalledWith(
      join('/mock/home/.komla/settings/theme.json'),
      expect.not.stringContaining('customPalette')
    );
  });

  it('switches back to the default palette on reset but keeps a custom theme', async () => {
    const customPalette = { mode: 'dark', surfaces: { background: '#000000' } };
    vfs = createVirtualFs({
      '/mock/home/.komla/settings/theme.json': JSON.stringify({
        palette: 'custom',
        customPalette,
        colors: { accent: 'oklch(0.7 0.15 145)' },
      }),
      '/mock/home/.komla/settings/terminal.json': JSON.stringify({}),
    });
    const { customizationService } =
      await import('../../../src/main/services/customization.service');

    const theme = customizationService.resetTheme();

    expect(theme.palette).toBe('default');
    expect(theme.colors.accent).toBe('oklch(0.922 0 0)');
    expect(theme.customPalette).toEqual({ ...customPalette, accent: 'oklch(0.7 0.15 145)' });
  });

  it('saves the accent with the custom theme when switching away from it', async () => {
    const customPalette = { mode: 'dark', surfaces: { background: '#000000' } };
    vfs = createVirtualFs({
      '/mock/home/.komla/settings/theme.json': JSON.stringify({
        palette: 'custom',
        customPalette,
        colors: { accent: 'oklch(0.7 0.15 145)' },
      }),
      '/mock/home/.komla/settings/terminal.json': JSON.stringify({}),
    });
    const { customizationService } =
      await import('../../../src/main/services/customization.service');

    const theme = customizationService.updateTheme({
      palette: 'nord',
      colors: { accent: 'oklch(0.77 0.06 217)' },
    });

    expect(theme.colors.accent).toBe('oklch(0.77 0.06 217)');
    expect(theme.customPalette).toEqual({ ...customPalette, accent: 'oklch(0.7 0.15 145)' });
  });

  it('saves the accent with a kept custom theme when an apply switches away from it', async () => {
    const customPalette = { mode: 'dark', surfaces: { background: '#000000' } };
    vfs = createVirtualFs({
      '/mock/home/.komla/settings/theme.json': JSON.stringify({
        palette: 'custom',
        customPalette,
        colors: { accent: 'oklch(0.7 0.15 145)' },
      }),
      '/mock/home/.komla/settings/terminal.json': JSON.stringify({}),
    });
    const { customizationService } =
      await import('../../../src/main/services/customization.service');

    const theme = customizationService.setAppearance({
      palette: 'nord',
      customPalette: customPalette as never,
      accent: 'oklch(0.77 0.06 217)',
      borderRadius: 6,
    });

    expect(theme.customPalette).toEqual({ ...customPalette, accent: 'oklch(0.7 0.15 145)' });
  });

  describe('following the system appearance', () => {
    const following = { palette: 'nord', followSystem: true, lightPalette: 'github-light' };

    it('is off by default, with Komla Light as the light theme', async () => {
      vfs = createVirtualFs({
        '/mock/home/.komla/settings/theme.json': JSON.stringify({ palette: 'nord' }),
        '/mock/home/.komla/settings/terminal.json': JSON.stringify({}),
      });
      const { customizationService } =
        await import('../../../src/main/services/customization.service');

      expect(customizationService.getTheme()).toMatchObject({
        palette: 'nord',
        followSystem: false,
        lightPalette: 'frost',
      });
    });

    const applied = 'oklch(0.65 0.15 145)';

    it.each([
      [
        'a light theme and its accent as the light theme',
        'one-light',
        undefined,
        {
          palette: 'nord',
          lightPalette: 'one-light',
          colors: { accent: 'oklch(0.922 0 0)', lightAccent: applied },
        },
      ],
      [
        'a dark theme and its accent as the dark theme',
        'dracula',
        undefined,
        {
          palette: 'dracula',
          lightPalette: 'github-light',
          colors: { accent: applied, lightAccent: 'oklch(0.205 0 0)' },
        },
      ],
      [
        'a light custom theme as the light theme',
        'custom',
        { mode: 'light' },
        { palette: 'nord', lightPalette: 'custom', colors: { lightAccent: applied } },
      ],
    ])('applies %s', async (_case, palette, customPalette, expected) => {
      vfs = createVirtualFs({
        '/mock/home/.komla/settings/theme.json': JSON.stringify(following),
        '/mock/home/.komla/settings/terminal.json': JSON.stringify({}),
      });
      const { customizationService } =
        await import('../../../src/main/services/customization.service');

      const theme = customizationService.setAppearance({
        palette,
        ...(customPalette && { customPalette: customPalette as never }),
        accent: applied,
        borderRadius: 6,
      });

      expect(theme).toMatchObject({ followSystem: true, ...expected });
    });

    it('moves the dark theme to Komla Dark when an apply removes its custom theme', async () => {
      vfs = createVirtualFs({
        '/mock/home/.komla/settings/theme.json': JSON.stringify({
          ...following,
          palette: 'custom',
          customPalette: { mode: 'dark' },
          colors: { accent: 'oklch(0.7 0.15 145)' },
        }),
        '/mock/home/.komla/settings/terminal.json': JSON.stringify({}),
      });
      const { customizationService } =
        await import('../../../src/main/services/customization.service');

      const theme = customizationService.setAppearance({
        palette: 'one-light',
        accent: applied,
        borderRadius: 6,
      });

      expect(theme).toMatchObject({
        palette: 'default',
        lightPalette: 'one-light',
        colors: { accent: 'oklch(0.922 0 0)', lightAccent: applied },
      });
      expect(theme.customPalette).toBeUndefined();
    });

    it('moves the light theme to Komla Light when its custom theme turns dark', async () => {
      vfs = createVirtualFs({
        '/mock/home/.komla/settings/theme.json': JSON.stringify({
          ...following,
          lightPalette: 'custom',
          customPalette: { mode: 'light' },
          colors: { accent: 'oklch(0.77 0.06 217)', lightAccent: 'oklch(0.5 0.15 145)' },
        }),
        '/mock/home/.komla/settings/terminal.json': JSON.stringify({}),
      });
      const { customizationService } =
        await import('../../../src/main/services/customization.service');

      const theme = customizationService.setAppearance({
        palette: 'custom',
        customPalette: { mode: 'dark' } as never,
        accent: applied,
        borderRadius: 6,
      });

      expect(theme).toMatchObject({
        palette: 'custom',
        lightPalette: 'frost',
        colors: { accent: applied, lightAccent: 'oklch(0.205 0 0)' },
      });
    });

    it('saves the accent with a custom light theme when switching away from it', async () => {
      const customPalette = { mode: 'light', surfaces: { background: '#ffffff' } };
      vfs = createVirtualFs({
        '/mock/home/.komla/settings/theme.json': JSON.stringify({
          ...following,
          lightPalette: 'custom',
          customPalette,
          // The dark theme's accent stays out of the custom light theme.
          colors: { accent: 'oklch(0.77 0.06 217)', lightAccent: 'oklch(0.5 0.15 145)' },
        }),
        '/mock/home/.komla/settings/terminal.json': JSON.stringify({}),
      });
      const { customizationService } =
        await import('../../../src/main/services/customization.service');

      const theme = customizationService.updateTheme({ lightPalette: 'one-light' });

      expect(theme.customPalette).toEqual({ ...customPalette, accent: 'oklch(0.5 0.15 145)' });
    });
  });

  it('defaults pane buttons on focus to enabled unless explicitly disabled', async () => {
    const { customizationService } =
      await import('../../../src/main/services/customization.service');

    expect(customizationService.getTerminal().showButtonsOnFocus).toBe(true);

    customizationService.updateTerminal({ showButtonsOnFocus: false });

    expect(customizationService.getTerminal().showButtonsOnFocus).toBe(false);
  });

  it('keeps right-clicks for the terminal menu by default', async () => {
    const { customizationService } =
      await import('../../../src/main/services/customization.service');

    expect(customizationService.getTerminal().sendRightClickToPrograms).toBe(false);

    customizationService.updateTerminal({ sendRightClickToPrograms: true });

    expect(customizationService.getTerminal().sendRightClickToPrograms).toBe(true);
  });

  it('hides pane headers by default unless turned on', async () => {
    const { customizationService } =
      await import('../../../src/main/services/customization.service');

    expect(customizationService.getTerminal().showPaneHeaders).toBe(false);

    customizationService.updateTerminal({ showPaneHeaders: true });

    expect(customizationService.getTerminal().showPaneHeaders).toBe(true);
  });

  it('dims unfocused panes by 15% by default, marking the focused one without headers', async () => {
    const { customizationService } =
      await import('../../../src/main/services/customization.service');

    expect(customizationService.getTerminal().unfocusedPaneDimOpacity).toBe(0.85);
  });

  it('stops underlying watcher on dispose()', async () => {
    const { customizationService } =
      await import('../../../src/main/services/customization.service');
    await customizationService.init();

    await customizationService.dispose();

    expect(watcherInstance?.stop).toHaveBeenCalledTimes(1);
  });

  it('writes onboarding docs with Open Workspace guidance', async () => {
    await import('../../../src/main/services/customization.service');

    const readme = vfs.mock.readFileSync('/mock/home/.komla/settings/README.md', 'utf-8');
    expect(readme).toContain('Open Workspace from Komla Settings');
    expect(readme).not.toContain('Edit with AI');
    expect(readme).toContain('| workspace.next | Cmd+ArrowDown |');
    expect(readme).toContain('| workspace.previous | Cmd+ArrowUp |');
    expect(readme).toContain('| terminal.scrollToBottom | Cmd+Shift+ArrowDown |');
    expect(readme).toContain('| terminal.search | Cmd+F |');
    expect(readme).not.toContain('| workspace.next | Cmd+] |');
    expect(readme).toContain(
      '`type` — `"prompt"` for a Saved Prompt or `"command"` for a Terminal Command'
    );

    const welcome = vfs.mock.readFileSync('/mock/home/.komla/settings/WELCOME', 'utf-8');
    expect(welcome).toContain('Edit the files directly or describe what you want.');
    expect(welcome).toContain("Terminal Command that runs 'npm test'");
    expect(welcome).not.toMatch(/\b(?:command|prompt|terminal)[ -]actions?\b/i);
    expect(welcome).toContain('Changes apply immediately');
  });

  it('writes AGENTS.md, GEMINI.md, and CLAUDE.md with AI context on first run', async () => {
    await import('../../../src/main/services/customization.service');

    const agents = vfs.mock.readFileSync('/mock/home/.komla/settings/AGENTS.md', 'utf-8');
    const gemini = vfs.mock.readFileSync('/mock/home/.komla/settings/GEMINI.md', 'utf-8');
    const claude = vfs.mock.readFileSync('/mock/home/.komla/settings/CLAUDE.md', 'utf-8');

    // All three should exist and contain the same AI context content
    expect(agents).toContain('Komla Settings — AI Context');
    expect(agents).toContain('Never delete files');
    expect(gemini).toBe(agents);
    expect(claude).toBe(agents);
  });
});
