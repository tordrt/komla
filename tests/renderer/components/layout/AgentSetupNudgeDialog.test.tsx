/**
 * @vitest-environment jsdom
 */
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentSetupNudgeDialog } from '../../../../src/renderer/components/layout/AgentSetupNudgeDialog';
import { useAgentPresetsStore } from '../../../../src/renderer/stores/agent-presets.store';
import {
  _resetNotifyingAgents,
  nudgeAgentSetup,
  useAgentSetupNudgeStore,
} from '../../../../src/renderer/stores/agent-setup-nudge.store';
import { useConfigStore } from '../../../../src/renderer/stores/config.store';
import { useSettingsDialogStore } from '../../../../src/renderer/stores/settings-dialog.store';
import { createAgentPreset, createSshWorkspace, createWorkspace } from '../../../factories';

import type { AppConfig } from '../../../../src/renderer/types';

const claude = createAgentPreset({ id: 'claude', name: 'Claude Code', openCommand: 'claude' });
const codex = createAgentPreset({ id: 'codex', name: 'Codex', openCommand: 'codex' });
const amp = createAgentPreset({ id: 'amp', name: 'Amp', openCommand: 'amp' });
const renamedClaude = createAgentPreset({
  id: 'renamed',
  name: 'Opus',
  openCommand: 'claude --model opus',
});
const shell = createAgentPreset({ id: 'shell', name: 'Shell Only', openCommand: '' });

const api = {
  platform: 'darwin' as NodeJS.Platform,
  updateConfig: vi.fn(),
  getNotificationHookDetails: vi.fn(),
  getCodexNotificationHookDetails: vi.fn(),
  getAntigravityNotificationHookDetails: vi.fn(),
  getOpenCodeNotificationHookDetails: vi.fn(),
};

function setConfig(config: Partial<AppConfig>) {
  useConfigStore.setState({ config: { agentSetupComplete: true, ...config } as AppConfig });
}

const launch = (presetId: string, overrides = {}) =>
  act(() => nudgeAgentSetup([createWorkspace({ presetId, ...overrides })]));

describe('AgentSetupNudgeDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetNotifyingAgents();
    api.platform = 'darwin';
    (window as unknown as { api: typeof api }).api = api;
    api.updateConfig.mockImplementation(async (updates: Partial<AppConfig>) => ({
      ...useConfigStore.getState().config,
      ...updates,
    }));
    api.getNotificationHookDetails.mockResolvedValue({ isConfigured: false });
    api.getCodexNotificationHookDetails.mockResolvedValue({ isConfigured: true });
    useAgentPresetsStore.setState({ presets: [claude, codex, amp, renamedClaude, shell] });
    useAgentSetupNudgeStore.setState({ open: false, nudge: null });
    useSettingsDialogStore.setState({ open: false, target: {} });
    setConfig({ notificationsNudgePending: true, selfSetupNudgePending: true });
  });

  it('points a one-click agent without hooks at its Integrations section, once', async () => {
    const user = userEvent.setup();
    render(<AgentSetupNudgeDialog />);

    await launch('claude');

    expect(screen.getByRole('dialog')).toHaveTextContent('Turn on Claude Code hooks');
    // Claude reports its own status, so hooks only add titles and an exact done.
    expect(screen.getByRole('dialog')).toHaveTextContent(
      'see done only once Claude Code has really finished'
    );
    expect(api.updateConfig).toHaveBeenCalledWith({ notificationsNudgePending: false });

    await user.click(screen.getByRole('button', { name: 'Open Integrations' }));
    expect(useAgentSetupNudgeStore.getState().open).toBe(false);
    expect(useSettingsDialogStore.getState()).toMatchObject({
      open: true,
      target: { tab: 'integrations', integrationSection: 'claude' },
    });

    await launch('claude');
    expect(useAgentSetupNudgeStore.getState().open).toBe(false);
  });

  it('says notifications need hooks on Windows, where Komla gets no status reports', async () => {
    api.platform = 'win32';
    render(<AgentSetupNudgeDialog />);

    await launch('claude');

    expect(screen.getByRole('dialog')).toHaveTextContent(
      'Know when Claude Code finishes or needs you'
    );
  });

  it('leaves a one-click agent alone when its hooks are on, and stops checking it', async () => {
    render(<AgentSetupNudgeDialog />);

    await launch('codex');
    await launch('codex');

    // Checking can start a login shell, so an agent found notifying is checked once.
    expect(api.getCodexNotificationHookDetails).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.updateConfig).not.toHaveBeenCalled();
  });

  it('recognizes a renamed one-click agent by its command', async () => {
    render(<AgentSetupNudgeDialog />);

    await launch('renamed');

    expect(screen.getByRole('dialog')).toHaveTextContent('Turn on Opus hooks');
    expect(useAgentSetupNudgeStore.getState().nudge?.section).toBe('claude');
    expect(useConfigStore.getState().config?.selfSetupNudgePending).toBe(true);
  });

  it('waits for New Workspace to close', async () => {
    const { rerender } = render(<AgentSetupNudgeDialog blocked />);

    await launch('claude');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    rerender(<AgentSetupNudgeDialog blocked={false} />);
    expect(screen.getByRole('dialog')).toHaveTextContent('Turn on Claude Code hooks');
  });

  it('points an agent without one-click setup at the self-integration skill', async () => {
    const user = userEvent.setup();
    render(<AgentSetupNudgeDialog />);

    await launch('amp');

    expect(screen.getByRole('dialog')).toHaveTextContent('Let Amp connect itself to Komla');
    expect(screen.getByRole('dialog')).toHaveTextContent('launch the self-integration skill');
    expect(api.updateConfig).toHaveBeenCalledWith({ selfSetupNudgePending: false });
    // The one-click nudge is still to come.
    expect(useConfigStore.getState().config?.notificationsNudgePending).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Open Integrations' }));
    // Its launch button starts Amp rather than New Workspace's default agent.
    expect(useSettingsDialogStore.getState()).toMatchObject({
      open: true,
      target: { tab: 'integrations', integrationSection: 'generic', selfSetupPresetId: 'amp' },
    });
  });

  it('closes on Not now without opening Settings', async () => {
    const user = userEvent.setup();
    render(<AgentSetupNudgeDialog />);
    await launch('amp');

    await user.click(screen.getByRole('button', { name: 'Not now' }));

    expect(useAgentSetupNudgeStore.getState().open).toBe(false);
    expect(useSettingsDialogStore.getState().open).toBe(false);
  });

  it('skips self-setup once a self-integration skill was launched', async () => {
    setConfig({ notificationsNudgePending: true, selfSetupNudgePending: false });
    render(<AgentSetupNudgeDialog />);

    await launch('amp');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('never nudges users who finished onboarding before the flags existed', async () => {
    setConfig({});
    render(<AgentSetupNudgeDialog />);

    await launch('claude');
    await launch('amp');

    expect(api.getNotificationHookDetails).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it.each([
    ['an SSH workspace', () => createSshWorkspace({ presetId: 'claude' })],
    ['a failed launch', () => createWorkspace({ presetId: 'claude', provisionError: 'boom' })],
    ['a terminal-only workspace', () => createWorkspace({ presetId: 'shell' })],
  ])('skips %s', async (_case, workspace) => {
    render(<AgentSetupNudgeDialog />);

    await act(() => nudgeAgentSetup([workspace()]));

    expect(api.getNotificationHookDetails).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('nudges the first of several workspaces that needs it', async () => {
    render(<AgentSetupNudgeDialog />);

    await act(() =>
      nudgeAgentSetup([
        createWorkspace({ presetId: 'codex' }),
        createWorkspace({ presetId: 'amp' }),
        createWorkspace({ presetId: 'claude' }),
      ])
    );

    expect(screen.getByRole('dialog')).toHaveTextContent('Let Amp connect itself to Komla');
    expect(api.getNotificationHookDetails).not.toHaveBeenCalled();
    expect(useConfigStore.getState().config?.notificationsNudgePending).toBe(true);
  });
});
