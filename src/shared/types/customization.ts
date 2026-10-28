/**
 * Customization types shared between main and renderer processes.
 */

/**
 * A theme defined in theme.json. Colors are 6-digit hex. Users and agents edit it by hand,
 * so the renderer validates it before applying it.
 */
export interface CustomPaletteConfig {
  name?: string;
  mode: 'dark' | 'light';
  surfaces: {
    background: string;
    card: string;
    popover?: string;
    muted: string;
    /** Background of hovered and selected items. */
    highlight: string;
    border: string;
    /** The workspace sidebar and the window around the work area card. */
    sidebar?: string;
  };
  terminal: {
    background: string;
    foreground: string;
    cursor?: string;
    selection?: string;
    ansi?: Partial<TerminalColorConfig['ansi']>;
  };
  /** "oklch(L C H)". Saved on switching away so choosing the theme again brings it back. */
  accent?: string;
}

/** The part of theme.json that `komla settings apply appearance` replaces. */
export interface AppearanceSettings {
  palette: string;
  customPalette?: CustomPaletteConfig;
  /** "oklch(L C H)" */
  accent: string;
  borderRadius: number;
}

export interface ThemeConfig {
  mode: 'dark';
  /** A built-in palette id, or "custom" for customPalette. With followSystem, the dark theme. */
  palette: string;
  /** Show lightPalette while the system appearance is light. Off by default. */
  followSystem: boolean;
  /** The theme shown while the system is light, when followSystem is on. */
  lightPalette: string;
  customPalette?: CustomPaletteConfig;
  colors: {
    /** The accent of palette. */
    accent: string;
    /** The accent of lightPalette, shown with it while the system is light. */
    lightAccent: string;
  };
  typography: {
    fontFamily: string;
    fontSize: number;
    borderRadius: number;
  };
}

export interface TerminalColorConfig {
  background: string;
  foreground: string;
  cursor: string;
  selection: string;
  ansi: {
    black: string;
    red: string;
    green: string;
    yellow: string;
    blue: string;
    magenta: string;
    cyan: string;
    white: string;
    brightBlack: string;
    brightRed: string;
    brightGreen: string;
    brightYellow: string;
    brightBlue: string;
    brightMagenta: string;
    brightCyan: string;
    brightWhite: string;
  };
}

export interface TerminalConfig {
  font: {
    family: string;
    size: number;
    lineHeight: number;
  };
  cursor: {
    style: 'block' | 'underline' | 'bar';
    blink: boolean;
  };
  scrollback: number;
  showPaneHeaders: boolean;
  showButtonsOnFocus: boolean;
  unfocusedPaneDimOpacity: number;
  focusedPaneBorder: boolean;
  notificationPaneBorder: boolean;
  /** Right-clicks go to a program tracking the mouse instead of the pane menu. */
  sendRightClickToPrograms: boolean;
  colors: TerminalColorConfig;
}
