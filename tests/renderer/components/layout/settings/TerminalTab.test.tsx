/**
 * @vitest-environment jsdom
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { TerminalTab } from '../../../../../src/renderer/components/layout/settings/TerminalTab';
import { useConfigStore } from '../../../../../src/renderer/stores/config.store';
import { useCustomizationStore } from '../../../../../src/renderer/stores/customization.store';
import { DEFAULT_TERMINAL_CONFIG } from '../../../../../src/shared/constants/terminal';

const terminalConfig = {
  font: { family: 'Fira Code', size: 14, lineHeight: 1.2 },
  cursor: { style: 'block', blink: false },
  scrollback: 5000,
  colors: { background: '#0d0f18' },
  showPaneHeaders: true,
  showButtonsOnFocus: true,
  unfocusedPaneDimOpacity: 0.85,
  focusedPaneBorder: false,
  notificationPaneBorder: true,
  sendRightClickToPrograms: false,
};

describe('TerminalTab', () => {
  let updateTerminalConfig: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    updateTerminalConfig = vi.fn().mockImplementation(async (updates) => ({
      ...useCustomizationStore.getState().terminalConfig,
      ...updates,
    }));
    window.api = {
      platform: 'darwin',
      updateTerminalConfig,
    } as unknown as typeof window.api;
    useCustomizationStore.setState({ terminalConfig: structuredClone(terminalConfig) as never });
    useConfigStore.setState({ config: {} as never });
  });

  it('leaves colors, font, cursor, and panes to the Appearance page', () => {
    render(<TerminalTab />);

    expect(screen.getByRole('combobox', { name: 'Scrollback lines' })).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'Show pane headers' })).not.toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'Focused pane border' })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Background color' })).not.toBeInTheDocument();
    expect(screen.queryByRole('spinbutton', { name: 'Font size' })).not.toBeInTheDocument();
    expect(screen.queryByRole('radiogroup', { name: 'Cursor style' })).not.toBeInTheDocument();
  });

  it('sends right-clicks to programs only once turned on', async () => {
    const user = userEvent.setup();
    render(<TerminalTab />);

    const toggle = screen.getByRole('switch', { name: 'Send right-clicks to programs' });
    expect(toggle).not.toBeChecked();
    await user.click(toggle);

    expect(updateTerminalConfig).toHaveBeenCalledWith({ sendRightClickToPrograms: true });
  });

  it('resets scrollback and right-clicks, leaving the look and panes to Appearance', async () => {
    const user = userEvent.setup();
    render(<TerminalTab />);

    await user.click(screen.getByRole('button', { name: /Reset scrollback and mouse/ }));
    const confirm = screen.getByRole('dialog', { name: 'Reset terminal settings' });
    expect(confirm).not.toHaveTextContent(/font|color|cursor|pane/i);
    await user.click(within(confirm).getByRole('button', { name: 'Reset' }));

    await waitFor(() =>
      expect(updateTerminalConfig).toHaveBeenCalledExactlyOnceWith({
        scrollback: DEFAULT_TERMINAL_CONFIG.scrollback,
        sendRightClickToPrograms: DEFAULT_TERMINAL_CONFIG.sendRightClickToPrograms,
      })
    );
  });

  it('sets where links open, in the default browser by default', async () => {
    const updateConfig = vi
      .spyOn(useConfigStore.getState(), 'updateConfig')
      .mockImplementation(async () => ({ ok: true, error: null }));
    onTestFinished(() => updateConfig.mockRestore());
    const user = userEvent.setup();
    render(<TerminalTab />);

    const target = screen.getByRole('radiogroup', { name: 'Open links in' });
    expect(within(target).getByRole('radio', { name: 'Default browser' })).toBeChecked();
    await user.click(within(target).getByRole('radio', { name: 'Automatic' }));

    expect(updateConfig).toHaveBeenCalledWith({ webLinkOpenTarget: 'auto' });
  });

  it("offers Komla's ConPTY on Windows only, on until turned off", async () => {
    const updateConfig = vi
      .spyOn(useConfigStore.getState(), 'updateConfig')
      .mockImplementation(async () => ({ ok: true, error: null }));
    onTestFinished(() => updateConfig.mockRestore());
    const { unmount } = render(<TerminalTab />);
    expect(screen.queryByRole('switch', { name: "Use Komla's ConPTY" })).not.toBeInTheDocument();
    unmount();

    window.api = {
      ...window.api,
      platform: 'win32',
      getWslDistros: vi.fn(async () => []),
    } as unknown as typeof window.api;
    const user = userEvent.setup();
    render(<TerminalTab />);

    // On unless turned off.
    const toggle = screen.getByRole('switch', { name: "Use Komla's ConPTY" });
    expect(toggle).toBeChecked();
    await user.click(toggle);

    expect(updateConfig).toHaveBeenCalledWith({ windowsUseConptyDll: false });
  });
});
