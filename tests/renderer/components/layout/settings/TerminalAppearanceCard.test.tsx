/**
 * @vitest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../../src/renderer/components/ui/font-family-picker', () => ({
  FontFamilyPicker: () => null,
}));

import { TerminalAppearanceCard } from '../../../../../src/renderer/components/layout/settings/TerminalAppearanceCard';
import { useCustomizationStore } from '../../../../../src/renderer/stores/customization.store';

const terminalConfig = {
  font: { family: 'Fira Code', size: 14, lineHeight: 1.2 },
  cursor: { style: 'block', blink: false },
  scrollback: 5000,
  colors: { background: '#0d0f18' },
  showButtonsOnFocus: true,
  unfocusedPaneDimOpacity: 0.85,
  focusedPaneBorder: false,
  notificationPaneBorder: true,
};

describe('TerminalAppearanceCard', () => {
  let updateTerminalConfig: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    updateTerminalConfig = vi.fn().mockImplementation(async (updates) => ({
      ...useCustomizationStore.getState().terminalConfig,
      ...updates,
    }));
    window.api = { updateTerminalConfig } as unknown as typeof window.api;
    useCustomizationStore.setState({ terminalConfig: structuredClone(terminalConfig) as never });
  });

  describe('font size', () => {
    it('lets you replace the value by typing, passing through values out of range', async () => {
      const user = userEvent.setup();
      render(<TerminalAppearanceCard activePaletteId="default" />);

      const fontSize = screen.getByRole('spinbutton', { name: 'Font size' });
      await user.tripleClick(fontSize);
      await user.keyboard('16');

      expect(fontSize).toHaveValue(16);
      await user.tab();
      expect(updateTerminalConfig).toHaveBeenLastCalledWith({
        font: { ...terminalConfig.font, size: 16 },
      });
      expect(fontSize).toHaveValue(16);
    });

    it('clamps an out-of-range value when the field loses focus', async () => {
      const user = userEvent.setup();
      render(<TerminalAppearanceCard activePaletteId="default" />);

      const fontSize = screen.getByRole('spinbutton', { name: 'Font size' });
      await user.tripleClick(fontSize);
      await user.keyboard('40');
      await user.tab();

      expect(updateTerminalConfig).toHaveBeenLastCalledWith({
        font: { ...terminalConfig.font, size: 32 },
      });
      expect(fontSize).toHaveValue(32);
    });

    it('commits on Enter', async () => {
      const user = userEvent.setup();
      render(<TerminalAppearanceCard activePaletteId="default" />);

      const fontSize = screen.getByRole('spinbutton', { name: 'Font size' });
      await user.tripleClick(fontSize);
      await user.keyboard('3{Enter}');

      expect(updateTerminalConfig).toHaveBeenLastCalledWith({
        font: { ...terminalConfig.font, size: 8 },
      });
      expect(fontSize).toHaveValue(8);
    });

    it('restores the saved size when the field is left empty', async () => {
      const user = userEvent.setup();
      render(<TerminalAppearanceCard activePaletteId="default" />);

      const fontSize = screen.getByRole('spinbutton', { name: 'Font size' });
      await user.clear(fontSize);
      await user.tab();

      expect(updateTerminalConfig).not.toHaveBeenCalled();
      expect(fontSize).toHaveValue(14);
    });
  });

  it('picks the cursor style from a radio group', async () => {
    const user = userEvent.setup();
    render(<TerminalAppearanceCard activePaletteId="default" />);

    const cursorStyle = screen.getByRole('radiogroup', { name: 'Cursor style' });
    expect(screen.getByRole('radio', { name: 'Block' })).toBeChecked();

    await user.click(screen.getByRole('radio', { name: 'Bar' }));

    expect(cursorStyle).toBeInTheDocument();
    expect(updateTerminalConfig).toHaveBeenCalledWith({
      cursor: { ...terminalConfig.cursor, style: 'bar' },
    });
  });

  it('names its controls with their row labels', () => {
    render(<TerminalAppearanceCard activePaletteId="default" />);

    expect(screen.getByRole('textbox', { name: 'Background color' })).toBeEnabled();
    expect(screen.getByRole('combobox', { name: 'Line height' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Cursor blink' })).toBeInTheDocument();
  });

  it('leaves the background to a theme that brings its own', () => {
    render(<TerminalAppearanceCard activePaletteId="nord" />);

    expect(screen.getByRole('textbox', { name: 'Background color' })).toBeDisabled();
  });

  describe('following the system appearance', () => {
    const following = (palette: string) =>
      useCustomizationStore.setState({
        theme: { palette, followSystem: true, lightPalette: 'frost' } as never,
      });

    afterEach(() => {
      useCustomizationStore.setState({ theme: null });
    });

    it("picks Komla Dark's background while the light theme shows", () => {
      following('default');
      render(<TerminalAppearanceCard activePaletteId="frost" />);

      expect(screen.getByRole('textbox', { name: 'Background color' })).toBeEnabled();
      expect(
        screen.getByText(/for Komla Dark, which shows while your system is dark/)
      ).toBeVisible();
    });

    it('says to choose Komla Dark as the dark theme to pick a background', () => {
      following('nord');
      render(<TerminalAppearanceCard activePaletteId="frost" />);

      expect(screen.getByRole('textbox', { name: 'Background color' })).toBeDisabled();
      expect(screen.getByText(/Choose Komla Dark as your dark theme/)).toBeVisible();
    });
  });
});
