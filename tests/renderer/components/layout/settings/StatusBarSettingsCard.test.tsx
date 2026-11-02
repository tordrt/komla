/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { StatusBarSettingsCard } from '../../../../../src/renderer/components/layout/settings/StatusBarSettingsCard';

const mockState = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
  updateConfig: vi.fn(),
}));

vi.mock('../../../../../src/renderer/stores/config.store', () => ({
  useConfigStore: (selector: (state: typeof mockState) => unknown) => selector(mockState),
}));

describe('StatusBarSettingsCard', () => {
  beforeEach(() => {
    Object.assign(window, { api: { platform: 'linux' } });
    mockState.config = {};
    mockState.updateConfig = vi.fn();
  });

  it('shows the status bar by default and hides it when switched off', () => {
    render(<StatusBarSettingsCard />);

    const statusBarSwitch = screen.getByRole('switch', { name: 'Show status bar' });
    expect(statusBarSwitch).toBeChecked();

    fireEvent.click(statusBarSwitch);

    expect(mockState.updateConfig).toHaveBeenCalledWith({ showStatusBar: false });
  });

  it('turns a hidden status bar back on', () => {
    mockState.config = { showStatusBar: false };
    render(<StatusBarSettingsCard />);

    const statusBarSwitch = screen.getByRole('switch', { name: 'Show status bar' });
    expect(statusBarSwitch).not.toBeChecked();

    fireEvent.click(statusBarSwitch);

    expect(mockState.updateConfig).toHaveBeenCalledWith({ showStatusBar: true });
  });

  it('shows agents in the macOS menu bar when switched on', () => {
    Object.assign(window, { api: { platform: 'darwin' } });
    render(<StatusBarSettingsCard />);

    const menuBarSwitch = screen.getByRole('switch', { name: 'Show agents in the menu bar' });
    expect(menuBarSwitch).not.toBeChecked();

    fireEvent.click(menuBarSwitch);

    expect(mockState.updateConfig).toHaveBeenCalledWith({ showAgentsInMenuBar: true });
  });

  it('hides the menu bar item while Komla is in front by default, once it shows', () => {
    Object.assign(window, { api: { platform: 'darwin' } });
    const { rerender } = render(<StatusBarSettingsCard />);
    const name = 'Only while Komla is in the background';
    expect(screen.getByRole('switch', { name })).toBeDisabled();
    expect(screen.getByRole('switch', { name })).toBeChecked();

    mockState.config = { showAgentsInMenuBar: true };
    rerender(<StatusBarSettingsCard />);
    fireEvent.click(screen.getByRole('switch', { name }));

    expect(mockState.updateConfig).toHaveBeenCalledWith({ agentsMenuBarInBackgroundOnly: false });
  });

  it('leaves the other bar items, such as the open button and Tips, to the status bar', () => {
    render(<StatusBarSettingsCard />);

    expect(screen.getAllByRole('switch')).toEqual([
      screen.getByRole('switch', { name: 'Show status bar' }),
      screen.getByRole('switch', { name: 'Resource usage' }),
    ]);
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('shows resource usage in the status bar, then picks whose it counts', () => {
    const { rerender } = render(<StatusBarSettingsCard />);

    fireEvent.click(screen.getByRole('switch', { name: 'Resource usage' }));
    expect(mockState.updateConfig).toHaveBeenCalledWith({ showSystemMetrics: true });

    mockState.config = { showSystemMetrics: true };
    rerender(<StatusBarSettingsCard />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Status bar shows' }), {
      target: { value: 'computer' },
    });

    expect(mockState.updateConfig).toHaveBeenCalledWith(
      expect.objectContaining({ statusBarResourceUsage: 'computer' })
    );
  });

  it('turns off resource usage while the status bar is hidden', () => {
    mockState.config = { showStatusBar: false, showSystemMetrics: true };
    render(<StatusBarSettingsCard />);

    expect(screen.getByRole('switch', { name: 'Resource usage' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Status bar shows' })).toBeDisabled();
  });
});
