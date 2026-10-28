/**
 * @vitest-environment jsdom
 */
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentLaunchDefaultsDialog } from '../../../../src/renderer/components/layout/AgentLaunchDefaultsDialog';
import {
  offerAgentLaunchDefaults,
  offerKomlaSkillInstall,
  useAgentLaunchDefaultsDialogStore,
} from '../../../../src/renderer/stores/agent-launch-defaults-dialog.store';
import { useAgentPresetsStore } from '../../../../src/renderer/stores/agent-presets.store';
import { useConfigStore } from '../../../../src/renderer/stores/config.store';
import { useSshHostsStore } from '../../../../src/renderer/stores/ssh-hosts.store';
import { useToastStore } from '../../../../src/renderer/stores/toast.store';

import type { AppConfig } from '../../../../src/renderer/types';

describe('AgentLaunchDefaultsDialog', () => {
  const updateConfig = vi.fn(async () => ({ ok: true, error: null }));

  const enableKomlaSkill = vi.fn<() => Promise<void>>();

  beforeEach(() => {
    updateConfig.mockClear();
    enableKomlaSkill.mockReset().mockResolvedValue(undefined);
    window.api = { enableKomlaSkill } as unknown as typeof window.api;
    useToastStore.setState({ toasts: [] });
    useAgentLaunchDefaultsDialogStore.setState({ open: false });
    useConfigStore.setState({ config: {} as AppConfig, updateConfig });
    useSshHostsStore.setState({ hosts: [] });
    useAgentPresetsStore.setState({
      presets: [
        {
          id: 'claude',
          name: 'Claude Code',
          launchModes: [{ id: 'skip', name: 'Skip', arguments: '--dangerously-skip-permissions' }],
        },
      ] as never,
      activePresets: [{ presetId: 'claude', lastUsedAt: 1 }] as never,
    });
  });

  it('shows the launch defaults the first time the Komla skill or MCP is turned on', async () => {
    const user = userEvent.setup();
    render(<AgentLaunchDefaultsDialog />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    act(() => {
      offerAgentLaunchDefaults();
    });
    const dialog = await screen.findByRole('dialog', { name: 'Komla CLI launch defaults' });
    expect(dialog).toHaveTextContent(/Settings → Integrations/);

    // Its choices save as they change, as in Settings.
    screen.getByRole('button', { name: 'Default agent' }).focus();
    await user.keyboard('{Enter}');
    await user.click(await screen.findByRole('menuitem', { name: 'Claude Code' }));
    expect(updateConfig).toHaveBeenCalledWith({
      agentLaunchDefaultPresetId: 'claude',
      agentLaunchDefaultLaunchModeId: undefined,
    });

    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(useAgentLaunchDefaultsDialogStore.getState().open).toBe(false);
  });

  it("doesn't say agents can start agents when the user turned that off", async () => {
    useConfigStore.setState({
      config: {
        agentDisabledCapabilities: ['agent.launch.workspace', 'agent.launch.tab'],
      } as unknown as AppConfig,
    });
    render(<AgentLaunchDefaultsDialog />);
    act(() => {
      offerAgentLaunchDefaults();
    });

    const dialog = await screen.findByRole('dialog', { name: 'Komla CLI launch defaults' });
    expect(dialog).not.toHaveTextContent(/can now start other agents/);
    expect(screen.getByRole('switch', { name: 'Let agents start other agents' })).not.toBeChecked();
  });

  it('hides Advanced again the next time it opens', async () => {
    const user = userEvent.setup();
    render(<AgentLaunchDefaultsDialog />);
    act(() => offerKomlaSkillInstall());
    await user.click(await screen.findByRole('button', { name: 'Show advanced' }));
    expect(screen.getByRole('switch', { name: 'MCP server' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    act(() => offerKomlaSkillInstall());
    expect(await screen.findByRole('button', { name: 'Show advanced' })).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'MCP server' })).not.toBeInTheDocument();
  });

  it('turns agent launches off and back on, leaving other capabilities alone', async () => {
    const user = userEvent.setup();
    useConfigStore.setState({
      config: { agentDisabledCapabilities: ['workspace.trash'] } as AppConfig,
      updateConfig: vi.fn(async (updates: Partial<AppConfig>) => {
        useConfigStore.setState({
          config: { ...useConfigStore.getState().config, ...updates } as AppConfig,
        });
        return { ok: true, error: null };
      }),
    });
    render(<AgentLaunchDefaultsDialog />);
    act(() => {
      useAgentLaunchDefaultsDialogStore.setState({ open: true });
    });

    const toggle = await screen.findByRole('switch', { name: 'Let agents start other agents' });
    expect(toggle).toBeChecked();
    await user.click(toggle);
    expect(useConfigStore.getState().config?.agentDisabledCapabilities).toEqual([
      'workspace.trash',
      'agent.launch.workspace',
      'agent.launch.tab',
    ]);
    // Nothing left to choose while agents can't start agents.
    expect(screen.queryByRole('button', { name: 'Default agent' })).not.toBeInTheDocument();

    await user.click(toggle);
    expect(useConfigStore.getState().config?.agentDisabledCapabilities).toEqual([
      'workspace.trash',
    ]);
    expect(screen.getByRole('button', { name: 'Default agent' })).toBeInTheDocument();
  });

  it('turns each agent action off on its own under Advanced', async () => {
    const user = userEvent.setup();
    useConfigStore.setState({
      config: { agentDisabledCapabilities: [] } as unknown as AppConfig,
      updateConfig: vi.fn(async (updates: Partial<AppConfig>) => {
        useConfigStore.setState({
          config: { ...useConfigStore.getState().config, ...updates } as AppConfig,
        });
        return { ok: true, error: null };
      }),
    });
    render(<AgentLaunchDefaultsDialog />);
    act(() => {
      useAgentLaunchDefaultsDialogStore.setState({ open: true });
    });

    expect(screen.queryByRole('switch', { name: 'komla launch --here' })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Show advanced' }));
    await user.click(screen.getByRole('switch', { name: 'komla launch --here' }));
    expect(useConfigStore.getState().config?.agentDisabledCapabilities).toEqual([
      'agent.launch.tab',
    ]);
    expect(screen.getByRole('switch', { name: 'komla launch' })).toBeChecked();
    // Agents can still start other agents, in new workspaces.
    expect(screen.getByRole('switch', { name: 'Let agents start other agents' })).toBeChecked();

    await user.click(screen.getByRole('switch', { name: 'komla launch' }));
    expect(screen.getByRole('switch', { name: 'Let agents start other agents' })).not.toBeChecked();
    await user.click(screen.getByRole('switch', { name: 'Let agents start other agents' }));
    expect(useConfigStore.getState().config?.agentDisabledCapabilities).toEqual([]);

    // The other actions under MCP and CLI access are here too.
    await user.click(screen.getByRole('switch', { name: 'komla snooze' }));
    expect(useConfigStore.getState().config?.agentDisabledCapabilities).toEqual([
      'workspace.snooze',
    ]);
    expect(screen.getByRole('switch', { name: 'MCP server' })).toBeChecked();
  });

  describe('from Tips', () => {
    it('installs the Komla skill only when asked to', async () => {
      const user = userEvent.setup();
      render(<AgentLaunchDefaultsDialog />);
      act(() => offerKomlaSkillInstall());

      const dialog = await screen.findByRole('dialog', { name: 'Install the Komla skill' });
      // The launch settings are there to set before agents can use them.
      expect(screen.getByRole('switch', { name: 'Let agents start other agents' })).toBeChecked();
      expect(screen.getByRole('button', { name: 'Default agent' })).toBeInTheDocument();
      expect(dialog).toHaveTextContent(/starting other agents/);

      await user.click(screen.getByRole('button', { name: 'Install skill' }));
      expect(enableKomlaSkill).toHaveBeenCalledOnce();
      expect(updateConfig).toHaveBeenCalledWith({ agentLaunchDefaultsShown: true });
      expect(useToastStore.getState().toasts.map((toast) => toast.message)).toEqual([
        'Komla skill added',
      ]);
      expect(useAgentLaunchDefaultsDialogStore.getState().open).toBe(false);
    });

    it('installs nothing when cancelled', async () => {
      const user = userEvent.setup();
      render(<AgentLaunchDefaultsDialog />);
      act(() => offerKomlaSkillInstall());

      await user.click(await screen.findByRole('button', { name: 'Cancel' }));
      expect(enableKomlaSkill).not.toHaveBeenCalled();
      expect(useAgentLaunchDefaultsDialogStore.getState().open).toBe(false);
    });

    it('stays open and says why the skill could not be installed', async () => {
      const user = userEvent.setup();
      enableKomlaSkill.mockRejectedValueOnce(
        new Error(
          "Error invoking remote method 'komla-skill:enable': Error: EACCES: permission denied"
        )
      );
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      render(<AgentLaunchDefaultsDialog />);
      act(() => offerKomlaSkillInstall());

      await user.click(await screen.findByRole('button', { name: 'Install skill' }));
      expect(useToastStore.getState().toasts.map((toast) => toast.message)).toEqual([
        'Couldn’t install the Komla skill: EACCES: permission denied',
      ]);
      expect(useAgentLaunchDefaultsDialogStore.getState().open).toBe(true);
      expect(screen.getByRole('button', { name: 'Install skill' })).toBeEnabled();
      consoleError.mockRestore();
    });
  });
});
