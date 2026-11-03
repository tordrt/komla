/**
 * @vitest-environment jsdom
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PanesSettingsCard } from '../../../../../src/renderer/components/layout/settings/PanesSettingsCard';
import { showPaneMenuHintOnce } from '../../../../../src/renderer/lib/pane-menu-hint';
import { useCustomizationStore } from '../../../../../src/renderer/stores/customization.store';
import { useToastStore } from '../../../../../src/renderer/stores/toast.store';

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

describe('PanesSettingsCard', () => {
  let updateTerminalConfig: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    updateTerminalConfig = vi.fn().mockImplementation(async (updates) => ({
      ...useCustomizationStore.getState().terminalConfig,
      ...updates,
    }));
    window.api = { platform: 'darwin', updateTerminalConfig } as unknown as typeof window.api;
    useCustomizationStore.setState({ terminalConfig: structuredClone(terminalConfig) as never });
  });

  it('turns pane headers off and disables the settings that only style them', async () => {
    const user = userEvent.setup();
    render(<PanesSettingsCard />);

    await user.click(screen.getByRole('switch', { name: 'Show pane headers' }));

    expect(updateTerminalConfig).toHaveBeenCalledWith({ showPaneHeaders: false });
    useCustomizationStore.setState({
      terminalConfig: { ...structuredClone(terminalConfig), showPaneHeaders: false } as never,
    });
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Show pane buttons on focus' })).toBeDisabled()
    );
    // The border outlines the whole pane, so it works without a header.
    expect(screen.getByRole('switch', { name: 'Focused pane border' })).toBeEnabled();
    expect(screen.getByRole('switch', { name: 'Notification pane border' })).toBeEnabled();
  });

  it('shows the pane borders on before the terminal config has loaded, as they ship', () => {
    useCustomizationStore.setState({ terminalConfig: null });
    render(<PanesSettingsCard />);

    expect(screen.getByRole('switch', { name: 'Focused pane border' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'Notification pane border' })).toBeChecked();
  });

  it('dims unfocused panes by the chosen amount', async () => {
    const user = userEvent.setup();
    render(<PanesSettingsCard />);

    await user.selectOptions(screen.getByRole('combobox', { name: 'Dim unfocused panes' }), '30%');

    expect(updateTerminalConfig).toHaveBeenCalledWith({ unfocusedPaneDimOpacity: 0.7 });
  });

  it('skips the pane menu hint for someone who changed the pane header setting', async () => {
    window.localStorage.clear();
    useToastStore.setState(useToastStore.getInitialState(), true);
    const user = userEvent.setup();
    render(<PanesSettingsCard />);

    await user.click(screen.getByRole('switch', { name: 'Show pane headers' }));
    showPaneMenuHintOnce();

    expect(useToastStore.getState().toasts).toEqual([]);
  });
});
