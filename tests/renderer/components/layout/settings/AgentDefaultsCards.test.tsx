/**
 * @vitest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentLaunchDefaultsCard } from '../../../../../src/renderer/components/layout/settings/AgentLaunchDefaultsCard';
import { AgentNotificationsCard } from '../../../../../src/renderer/components/layout/settings/AgentNotificationsCard';
import { useAgentPresetsStore } from '../../../../../src/renderer/stores/agent-presets.store';
import { useConfigStore } from '../../../../../src/renderer/stores/config.store';
import { useSshHostsStore } from '../../../../../src/renderer/stores/ssh-hosts.store';

import type { AppConfig } from '../../../../../src/shared/types';

const updateConfig = vi.fn(async () => ({ ok: true, error: null }));

function setConfig(config: Partial<AppConfig>) {
  useConfigStore.setState({ config: config as AppConfig, updateConfig });
}

describe('AgentNotificationsCard', () => {
  beforeEach(() => {
    window.api = {
      platform: 'darwin',
      listCustomSounds: vi.fn().mockResolvedValue([]),
    } as unknown as typeof window.api;
  });

  it('keeps the spinner and sound switches while the hooks endpoint is off', () => {
    setConfig({ disableNotificationEndpoint: true });
    render(<AgentNotificationsCard />);

    const [endpoint, spinner, sounds] = screen.getAllByRole('switch');
    expect(endpoint).toHaveAccessibleName('Hooks endpoint');
    expect(endpoint).not.toBeChecked();
    expect(endpoint).toBeEnabled();
    // Agents that report their own status still drive the spinner and sounds.
    expect(spinner).toBeEnabled();
    expect(sounds).toBeEnabled();
  });

  it('disables them while the endpoint is off on Windows, where no status reports arrive', () => {
    window.api.platform = 'win32';
    setConfig({ disableNotificationEndpoint: true });
    render(<AgentNotificationsCard />);

    const [, spinner, sounds] = screen.getAllByRole('switch');
    expect(spinner).toBeDisabled();
    expect(sounds).toBeDisabled();
  });

  it('enables them while the endpoint is on', () => {
    setConfig({});
    render(<AgentNotificationsCard />);

    const [endpoint, spinner, sounds] = screen.getAllByRole('switch');
    expect(endpoint).toBeChecked();
    expect(spinner).toBeEnabled();
    expect(sounds).toBeEnabled();
  });
});

describe('AgentLaunchDefaultsCard', () => {
  beforeEach(() => {
    updateConfig.mockClear();
    useSshHostsStore.setState({ hosts: [] });
    useAgentPresetsStore.setState({
      presets: [
        {
          id: 'claude',
          name: 'Claude Code',
          launchModes: [
            { id: 'plan', name: 'Plan', arguments: '--permission-mode plan' },
            {
              id: 'skip',
              name: 'Dangerously skip permissions',
              arguments: '--dangerously-skip-permissions',
            },
          ],
        },
        {
          id: 'gemini',
          name: 'Gemini',
          launchModes: [{ id: 'yolo', name: 'YOLO', arguments: '--approval-mode yolo' }],
        },
      ] as never,
      activePresets: [
        { presetId: 'claude', lastUsedAt: 2 },
        { presetId: 'gemini', lastUsedAt: 1 },
      ] as never,
    });
  });

  const warnings = () => screen.queryAllByText(/anywhere, even on this computer/);

  it('shows no risk warning when no launch mode is pinned', () => {
    setConfig({ agentLaunchDefaultPresetId: 'claude' });
    render(<AgentLaunchDefaultsCard />);

    expect(warnings()).toHaveLength(0);
  });

  it('shows no risk warning for a launch mode that keeps permission prompts', () => {
    setConfig({ agentLaunchDefaultPresetId: 'claude', agentLaunchDefaultLaunchModeId: 'plan' });
    render(<AgentLaunchDefaultsCard />);

    expect(warnings()).toHaveLength(0);
  });

  it.each([
    ['claude', 'skip'],
    ['gemini', 'yolo'],
  ])('warns when the pinned %s launch mode skips permissions', (presetId, launchModeId) => {
    setConfig({
      agentLaunchDefaultPresetId: presetId,
      agentLaunchDefaultLaunchModeId: launchModeId,
    });
    render(<AgentLaunchDefaultsCard />);

    expect(warnings().length).toBeGreaterThan(0);
  });

  it('shows a pinned SSH host that is gone as unavailable', () => {
    useSshHostsStore.setState({ hosts: [{ id: 'laptop', name: 'Laptop' }] as never });
    setConfig({ agentLaunchDefaultSshHostId: 'deleted' });
    render(<AgentLaunchDefaultsCard />);

    expect(screen.getByRole('button', { name: 'Where agents start' })).toHaveTextContent(
      'Unavailable'
    );
  });

  it('names the isolated SSH hosts agents can be pinned to', async () => {
    const user = userEvent.setup();
    useSshHostsStore.setState({
      hosts: [
        { id: 'box', name: 'Box', isolated: true },
        { id: 'laptop', name: 'Laptop' },
      ] as never,
    });
    setConfig({});
    render(<AgentLaunchDefaultsCard />);

    screen.getByRole('button', { name: 'Where agents start' }).focus();
    await user.keyboard('{Enter}');
    expect((await screen.findAllByRole('menuitem')).map((item) => item.textContent)).toEqual([
      'Same as calling agent',
      'Boxisolated',
      'Laptop',
    ]);
    await user.click(screen.getByRole('menuitem', { name: 'Boxisolated' }));
    expect(updateConfig).toHaveBeenCalledWith({ agentLaunchDefaultSshHostId: 'box' });
  });

  it('pins an agent, then one of its launch modes', async () => {
    const user = userEvent.setup();
    setConfig({});
    const { rerender } = render(<AgentLaunchDefaultsCard />);

    const agent = screen.getByRole('button', { name: 'Default agent' });
    expect(agent).toHaveTextContent('Most recent');
    // Agents start Default until an agent is pinned with a mode.
    const unpinnedMode = screen.getByRole('button', { name: 'Default launch mode' });
    expect(unpinnedMode).toBeDisabled();
    expect(unpinnedMode).toHaveTextContent('Default');
    agent.focus();
    await user.keyboard('{Enter}');
    await user.click(await screen.findByRole('menuitem', { name: 'Claude Code' }));
    expect(updateConfig).toHaveBeenCalledWith({
      agentLaunchDefaultPresetId: 'claude',
      agentLaunchDefaultLaunchModeId: undefined,
    });

    setConfig({ agentLaunchDefaultPresetId: 'claude' });
    rerender(<AgentLaunchDefaultsCard />);
    const mode = screen.getByRole('button', { name: 'Default launch mode' });
    expect(mode).toHaveTextContent('Default');
    mode.focus();
    await user.keyboard('{Enter}');
    expect((await screen.findAllByRole('menuitem')).map((item) => item.textContent)).toEqual([
      'Default',
      'Plan',
      'Dangerously skip permissions',
    ]);
    await user.click(screen.getByRole('menuitem', { name: 'Plan' }));
    expect(updateConfig).toHaveBeenLastCalledWith({ agentLaunchDefaultLaunchModeId: 'plan' });
  });

  it('shows the pinned agent and launch mode', () => {
    setConfig({ agentLaunchDefaultPresetId: 'gemini', agentLaunchDefaultLaunchModeId: 'yolo' });
    render(<AgentLaunchDefaultsCard />);

    expect(screen.getByRole('button', { name: 'Default agent' })).toHaveTextContent('Gemini');
    expect(screen.getByRole('button', { name: 'Default launch mode' })).toHaveTextContent('YOLO');
  });
});
