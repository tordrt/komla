/**
 * @vitest-environment jsdom
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../../src/renderer/components/layout/settings/StatusBarSettingsCard', () => ({
  StatusBarSettingsCard: () => null,
}));
vi.mock('../../../../../src/renderer/components/ui/font-family-picker', () => ({
  FontFamilyPicker: () => null,
}));
vi.mock('../../../../../src/renderer/lib/monaco-loader', () => ({}));
vi.mock('../../../../../src/renderer/lib/terminal-renderer-runtime', () => ({}));
vi.mock('../../../../../src/renderer/lib/palette-runtime', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  applyPalette: vi.fn(),
  getActivePalette: vi.fn(),
  getActivePaletteId: vi.fn(),
  subscribePalette: () => () => {},
}));

import { AppearanceTab } from '../../../../../src/renderer/components/layout/settings/AppearanceTab';
import { TooltipProvider } from '../../../../../src/renderer/components/ui/tooltip';
import {
  applyPalette,
  getActivePalette,
  getActivePaletteId,
} from '../../../../../src/renderer/lib/palette-runtime';
import { buildCustomPalette } from '../../../../../src/renderer/lib/theme-palette';
import { useConfigStore } from '../../../../../src/renderer/stores/config.store';
import { useCustomizationStore } from '../../../../../src/renderer/stores/customization.store';
import { useDialogsStore } from '../../../../../src/renderer/stores/dialogs.store';
import { DEFAULT_TERMINAL_CONFIG } from '../../../../../src/shared/constants/terminal';

const theme = { colors: { accent: '0.6 0.2 260' } };
const customPalette = {
  name: 'Moss',
  mode: 'dark',
  surfaces: {
    background: '#0f1410',
    card: '#18201a',
    muted: '#222c24',
    highlight: '#2a362d',
    border: '#3a4a3e',
  },
  terminal: { background: '#0f1410', foreground: '#c8d8c0' },
};
const terminalConfig = {
  font: { family: 'Fira Code', size: 18, lineHeight: 1.5 },
  cursor: { style: 'bar', blink: true },
  scrollback: 50000,
  colors: { ...DEFAULT_TERMINAL_CONFIG.colors, background: '#000000' },
};

describe('AppearanceTab', () => {
  beforeEach(() => {
    window.api = {
      platform: 'darwin',
      resetTheme: vi.fn().mockResolvedValue(theme),
      updateTerminalConfig: vi.fn().mockImplementation(async (updates) => ({
        ...terminalConfig,
        ...updates,
      })),
      updateTheme: vi.fn().mockImplementation(async (updates) => ({ ...theme, ...updates })),
      getServerPort: vi.fn().mockResolvedValue(52863),
      getBasePath: vi.fn().mockResolvedValue('/home/me/.komla'),
      showItemInFolder: vi.fn(),
      updateConfig: vi.fn().mockImplementation(async (updates) => ({ zoomLevel: 1, ...updates })),
    } as unknown as typeof window.api;
    useCustomizationStore.setState({
      theme: theme as never,
      terminalConfig: terminalConfig as never,
    });
    useConfigStore.setState({ config: { zoomLevel: 1 } as never });
    vi.mocked(getActivePaletteId).mockReturnValue('default');
  });

  it('resets the theme, zoom, and terminal look, leaving scrollback and panes alone', async () => {
    const user = userEvent.setup();
    render(<AppearanceTab />, { wrapper: TooltipProvider });

    await user.click(screen.getByRole('button', { name: /Reset theme, fonts and zoom/ }));
    const confirm = screen.getByRole('dialog', { name: 'Reset appearance' });
    expect(confirm).toHaveTextContent(/terminal colors, font, and cursor/);
    await user.click(within(confirm).getByRole('button', { name: 'Reset' }));

    await waitFor(() => expect(applyPalette).toHaveBeenCalledWith('default'));
    expect(window.api.resetTheme).toHaveBeenCalled();
    expect(window.api.updateConfig).toHaveBeenCalledWith({ zoomLevel: 0 });
    const { font, cursor, colors } = DEFAULT_TERMINAL_CONFIG;
    expect(window.api.updateTerminalConfig).toHaveBeenCalledExactlyOnceWith({
      font,
      cursor,
      colors,
    });
  });

  it('offers zoom in the half steps Cmd+/− use', async () => {
    const user = userEvent.setup();
    render(<AppearanceTab />, { wrapper: TooltipProvider });

    const zoom = screen.getByDisplayValue('120%');
    expect(
      within(zoom)
        .getAllByRole('option')
        .map((option) => option.textContent)
    ).toEqual([
      '58%',
      '63%',
      '69%',
      '76%',
      '83%',
      '91%',
      'Default (100%)',
      '110%',
      '120%',
      '131%',
      '144%',
      '158%',
      '173%',
    ]);
    await user.selectOptions(zoom, '110%');
    expect(window.api.updateConfig).toHaveBeenCalledWith({ zoomLevel: 0.5 });
  });

  it('starts the activity spinner on Arc and saves another style', async () => {
    const user = userEvent.setup();
    render(<AppearanceTab />, { wrapper: TooltipProvider });

    const styles = screen.getByRole('radiogroup', { name: 'Activity spinner style' });
    expect(within(styles).getByRole('radio', { name: 'Arc' })).toBeChecked();
    await user.click(within(styles).getByRole('radio', { name: 'Braille' }));
    expect(window.api.updateConfig).toHaveBeenCalledWith({ activitySpinner: 'braille' });
  });

  it('turns off the spinner style while the spinner is hidden', () => {
    useConfigStore.setState({ config: { zoomLevel: 1, showAgentSpinner: false } as never });
    render(<AppearanceTab />, { wrapper: TooltipProvider });

    const row = screen.getByRole('radiogroup', { name: 'Activity spinner style' });
    expect(within(row).getByRole('radio', { name: 'Arc' })).toBeDisabled();
    expect(screen.getByText(/Turn on the activity spinner/)).toBeInTheDocument();
  });

  it('keeps the spinner style while the hooks endpoint is off, as agents report status without it', () => {
    useConfigStore.setState({
      config: { zoomLevel: 1, disableNotificationEndpoint: true } as never,
    });
    render(<AppearanceTab />, { wrapper: TooltipProvider });

    const row = screen.getByRole('radiogroup', { name: 'Activity spinner style' });
    expect(within(row).getByRole('radio', { name: 'Arc' })).toBeEnabled();
  });

  it('turns off the spinner style while the hooks endpoint is off on Windows', () => {
    window.api.platform = 'win32';
    useConfigStore.setState({
      config: { zoomLevel: 1, disableNotificationEndpoint: true } as never,
    });
    render(<AppearanceTab />, { wrapper: TooltipProvider });

    const row = screen.getByRole('radiogroup', { name: 'Activity spinner style' });
    expect(within(row).getByRole('radio', { name: 'Arc' })).toBeDisabled();
  });

  it('saves Reduce effects, off unless turned on', async () => {
    const user = userEvent.setup();
    render(<AppearanceTab />, { wrapper: TooltipProvider });

    const toggle = screen.getByRole('switch', { name: 'Reduce effects' });
    expect(toggle).not.toBeChecked();
    await user.click(toggle);
    expect(window.api.updateConfig).toHaveBeenCalledWith({ reduceEffects: true });
  });

  it('shows the terminal colors, font, and cursor beside the theme', () => {
    render(<AppearanceTab />, { wrapper: TooltipProvider });

    const card = screen.getByRole('heading', { name: 'Terminal' }).closest('section')!;
    expect(within(card).getByRole('textbox', { name: 'Background color' })).toBeInTheDocument();
    expect(within(card).getByRole('spinbutton', { name: 'Font size' })).toHaveValue(18);
    expect(within(card).getByRole('radiogroup', { name: 'Cursor style' })).toBeInTheDocument();
  });

  it('groups the themes into dark and light', () => {
    render(<AppearanceTab />, { wrapper: TooltipProvider });

    const names = (group: string) =>
      within(screen.getByRole('group', { name: group }))
        .getAllByRole('button')
        .map((button) => button.textContent);
    expect(names('Dark')).toEqual([
      'Komla Dark',
      'Komla Slate',
      'Catppuccin Mocha',
      'Dracula',
      'GitHub Dark',
      'Gruvbox Dark',
      'Kanagawa',
      'Monokai',
      'Nord',
      'One Dark',
      'Rosé Pine',
      'Solarized Dark',
      'Tokyo Night',
    ]);
    expect(names('Light')).toEqual([
      'Komla Light',
      'Komla Slate Light',
      'Catppuccin Latte',
      'GitHub Light',
      'One Light',
      'Rosé Pine Dawn',
      'Solarized Light',
    ]);
  });

  it('shows the custom theme from theme.json first among the themes of its mode', () => {
    useCustomizationStore.setState({ theme: { ...theme, customPalette } as never });
    render(<AppearanceTab />, { wrapper: TooltipProvider });

    const dark = within(screen.getByRole('group', { name: 'Dark' })).getAllByRole('button');
    expect(dark[0]).toHaveTextContent('Moss');
  });

  describe('matching the system appearance', () => {
    const following = {
      palette: 'nord',
      followSystem: true,
      lightPalette: 'frost',
      colors: { accent: '0.6 0.2 260', lightAccent: 'oklch(0.5 0.2 270)' },
    };

    function systemIsLight() {
      window.matchMedia = vi.fn(() => ({ matches: false })) as unknown as typeof window.matchMedia;
    }

    afterEach(() => {
      Reflect.deleteProperty(window, 'matchMedia');
    });

    it('is off unless turned on', async () => {
      const user = userEvent.setup();
      render(<AppearanceTab />, { wrapper: TooltipProvider });

      const toggle = screen.getByRole('switch', { name: 'Match system appearance' });
      expect(toggle).not.toBeChecked();
      await user.click(toggle);

      expect(window.api.updateTheme).toHaveBeenCalledWith({ followSystem: true });
    });

    it('makes a light theme in use, with its accent, the light theme beside Komla Dark', async () => {
      useCustomizationStore.setState({ theme: { ...theme, palette: 'one-light' } as never });
      const user = userEvent.setup();
      render(<AppearanceTab />, { wrapper: TooltipProvider });

      await user.click(screen.getByRole('switch', { name: 'Match system appearance' }));

      expect(window.api.updateTheme).toHaveBeenCalledWith({
        followSystem: true,
        palette: 'default',
        lightPalette: 'one-light',
        colors: { accent: 'oklch(0.922 0 0)', lightAccent: '0.6 0.2 260' },
      });
    });

    it('keeps the theme showing, with its accent, when turned off', async () => {
      systemIsLight();
      vi.mocked(getActivePaletteId).mockReturnValue('frost');
      useCustomizationStore.setState({ theme: following as never });
      const user = userEvent.setup();
      render(<AppearanceTab />, { wrapper: TooltipProvider });

      await user.click(screen.getByRole('switch', { name: 'Match system appearance' }));

      expect(window.api.updateTheme).toHaveBeenCalledWith({
        followSystem: false,
        palette: 'frost',
        colors: { accent: 'oklch(0.5 0.2 270)', lightAccent: 'oklch(0.5 0.2 270)' },
      });
    });

    it('changes the accent of the theme showing', async () => {
      systemIsLight();
      vi.mocked(getActivePaletteId).mockReturnValue('frost');
      useCustomizationStore.setState({ theme: following as never });
      const user = userEvent.setup();
      render(<AppearanceTab />, { wrapper: TooltipProvider });

      const swatches = within(
        screen.getByText('Accent color').parentElement!.parentElement!
      ).getAllByRole('button');
      await user.click(swatches[1]);

      expect(window.api.updateTheme).toHaveBeenCalledWith({
        colors: { accent: '0.6 0.2 260', lightAccent: 'oklch(0.62 0.20 25)' },
      });
    });

    it('says when theme.json names a light theme Komla does not have', () => {
      useCustomizationStore.setState({ theme: { ...following, lightPalette: 'paper' } as never });
      render(<AppearanceTab />, { wrapper: TooltipProvider });

      expect(screen.getByText(/lightPalette to "paper"/)).toHaveTextContent(
        /light themes, so Komla is using Komla Light/
      );
    });

    it('marks the dark and the light theme', () => {
      vi.mocked(getActivePaletteId).mockReturnValue('nord');
      useCustomizationStore.setState({ theme: following as never });
      render(<AppearanceTab />, { wrapper: TooltipProvider });

      const pressed = screen
        .getAllByRole('button', { pressed: true })
        .map((button) => button.textContent);
      expect(pressed).toEqual(['Nord', 'Komla Light']);
    });

    it('saves a light theme and its accent as the light theme, until a light system shows it', async () => {
      vi.mocked(getActivePaletteId).mockReturnValue('nord');
      useCustomizationStore.setState({ theme: following as never });
      const user = userEvent.setup();
      render(<AppearanceTab />, { wrapper: TooltipProvider });

      await user.click(screen.getByRole('button', { name: 'GitHub Light' }));

      expect(window.api.updateTheme).toHaveBeenCalledWith({
        lightPalette: 'github-light',
        colors: { accent: '0.6 0.2 260', lightAccent: 'oklch(0.5 0.19 257)' },
      });
      expect(applyPalette).not.toHaveBeenCalled();
    });

    it('saves a dark theme as the dark theme and shows it while the system is dark', async () => {
      vi.mocked(getActivePaletteId).mockReturnValue('nord');
      useCustomizationStore.setState({ theme: following as never });
      const user = userEvent.setup();
      render(<AppearanceTab />, { wrapper: TooltipProvider });

      await user.click(screen.getByRole('button', { name: 'Dracula' }));

      expect(applyPalette).toHaveBeenCalledWith('dracula');
      expect(window.api.updateTheme).toHaveBeenCalledWith({
        palette: 'dracula',
        colors: { accent: 'oklch(0.74 0.15 302)', lightAccent: 'oklch(0.5 0.2 270)' },
      });
    });
  });

  it('saves the chosen theme and its accent to theme.json', async () => {
    const user = userEvent.setup();
    render(<AppearanceTab />, { wrapper: TooltipProvider });

    await user.click(screen.getByRole('button', { name: /^Nord/ }));

    expect(applyPalette).toHaveBeenCalledWith('nord');
    expect(window.api.updateTheme).toHaveBeenCalledWith({
      palette: 'nord',
      colors: { accent: 'oklch(0.77 0.06 217)' },
    });
  });

  it('leaves the accent alone when the active theme is chosen again', async () => {
    vi.mocked(getActivePaletteId).mockReturnValue('nord');
    const user = userEvent.setup();
    render(<AppearanceTab />, { wrapper: TooltipProvider });

    await user.click(screen.getByRole('button', { name: /^Nord/ }));

    expect(applyPalette).not.toHaveBeenCalled();
    expect(window.api.updateTheme).not.toHaveBeenCalled();
  });

  it('brings back the accent saved with the custom theme', async () => {
    useCustomizationStore.setState({
      theme: {
        ...theme,
        customPalette: { ...customPalette, accent: 'oklch(0.7 0.15 145)' },
      } as never,
    });
    const user = userEvent.setup();
    render(<AppearanceTab />, { wrapper: TooltipProvider });

    await user.click(screen.getByRole('button', { name: /^Moss/ }));

    expect(window.api.updateTheme).toHaveBeenCalledWith({
      palette: 'custom',
      colors: { accent: 'oklch(0.7 0.15 145)' },
    });
  });

  it('keeps the accent when choosing a custom theme without one', async () => {
    useCustomizationStore.setState({ theme: { ...theme, customPalette } as never });
    const user = userEvent.setup();
    render(<AppearanceTab />, { wrapper: TooltipProvider });

    await user.click(screen.getByRole('button', { name: /^Moss/ }));

    expect(window.api.updateTheme).toHaveBeenCalledWith({
      palette: 'custom',
      colors: { accent: '0.6 0.2 260' },
    });
    expect(screen.queryByText('Custom theme not applied')).not.toBeInTheDocument();
  });

  it('lists what to fix in a custom theme it cannot use', () => {
    useCustomizationStore.setState({
      theme: {
        ...theme,
        customPalette: {
          ...customPalette,
          surfaces: { ...customPalette.surfaces, card: '#8a8a8a' },
        },
      } as never,
    });
    render(<AppearanceTab />, { wrapper: TooltipProvider });

    expect(screen.getByText('Custom theme not applied')).toBeInTheDocument();
    expect(screen.getByText(/^Text on surfaces\.card has/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Moss/ })).not.toBeInTheDocument();
  });

  it('keeps showing the custom theme still applied after an edit with problems', () => {
    vi.mocked(getActivePaletteId).mockReturnValue('custom');
    vi.mocked(getActivePalette).mockReturnValue(buildCustomPalette(customPalette).palette!);
    useCustomizationStore.setState({
      theme: {
        ...theme,
        customPalette: {
          ...customPalette,
          surfaces: { ...customPalette.surfaces, card: '#8a8a8a' },
        },
      } as never,
    });
    render(<AppearanceTab />, { wrapper: TooltipProvider });

    expect(screen.getByText('Custom theme not applied')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Moss/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('says when theme.json names a theme Komla does not have', () => {
    useCustomizationStore.setState({ theme: { ...theme, palette: 'Dracula' } as never });
    render(<AppearanceTab />, { wrapper: TooltipProvider });

    expect(screen.getByText('Unknown theme')).toBeInTheDocument();
    expect(screen.getByText(/palette to "Dracula"/)).toBeInTheDocument();
  });

  it('launches the appearance skill and shows where the theme file is', async () => {
    const user = userEvent.setup();
    render(<AppearanceTab />, { wrapper: TooltipProvider });

    expect(await screen.findByTitle('Show /home/me/.komla/settings/theme.json')).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Customize with an agent' }));
    expect(useDialogsStore.getState().newWorkspaceDialogPrompt).toContain('komla skill appearance');

    await user.click(screen.getByRole('button', { name: 'Show file' }));
    expect(window.api.showItemInFolder).toHaveBeenCalledWith('/home/me/.komla/settings/theme.json');
  });
});
