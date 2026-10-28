/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { updateConfig, loadConfig, configState } = vi.hoisted(() => ({
  updateConfig: vi.fn(),
  loadConfig: vi.fn(),
  // Most tests start where usage analytics were already answered, so setup doesn't ask.
  configState: { config: { usageTelemetryConsentAnswered: true } as Record<string, unknown> },
}));

const claudeLevels = [
  { id: 'level-low', name: 'Low', arguments: '--effort low' },
  { id: 'level-high', name: 'High', arguments: '--effort high' },
];

const agentPresetsState = {
  templates: [
    {
      name: 'Claude Code',
      openCommand: 'claude',
      continueCommand: 'claude --continue',
      promptCommand: 'claude {{prompt}}',
      launchModes: [],
      reasoningLevels: claudeLevels,
    },
    {
      name: 'Cursor CLI',
      openCommand: 'cursor-agent',
      continueCommand: 'cursor-agent resume',
      promptCommand: 'cursor-agent {{prompt}}',
      launchModes: [],
    },
    {
      name: 'Amp',
      openCommand: 'amp',
      continueCommand: 'amp threads continue',
      promptCommand: 'amp {{prompt}}',
      launchModes: [],
    },
    {
      name: 'Custom',
      openCommand: '',
      continueCommand: '',
      promptCommand: '',
      launchModes: [],
    },
  ],
  loadTemplates: vi.fn(async () => {}),
  createActivePresets: vi.fn(async (presets: object[]) =>
    presets.map((preset, index) => ({ ...preset, id: `preset-${index}` }))
  ),
};

vi.mock('../../../../src/renderer/stores/agent-presets.store', () => ({
  useAgentPresetsStore: () => agentPresetsState,
}));
vi.mock('../../../../src/renderer/stores/config.store', () => ({
  useConfigStore: () => ({ config: configState.config, updateConfig, loadConfig }),
}));
vi.mock('../../../../src/renderer/components/projects/ProjectCreationForm', () => ({
  ProjectCreationForm: ({
    onSuccess,
    onSkip,
  }: {
    onSuccess: (project: { id: string }) => void;
    onSkip?: () => void;
  }) => (
    <>
      <button onClick={() => onSuccess({ id: 'project-1' })}>Create project</button>
      <button onClick={onSkip}>Skip project</button>
    </>
  ),
}));
vi.mock('../../../../src/renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipTrigger: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipContent: () => null,
}));

import { SetupWizard } from '../../../../src/renderer/components/layout/SetupWizard';
import { useSshHostDialogStore } from '../../../../src/renderer/stores/ssh-host-dialog.store';

// Leaves the Project step and waits for the agent picker Komla shows when it finds no agents.
async function toAgentStep(projectButton: 'Create project' | 'Skip project' = 'Skip project') {
  fireEvent.click(screen.getByRole('button', { name: projectButton }));
  await screen.findByText('Choose Your AI Agent');
}

// Continues from the agent step to the Connect step.
async function toConnectStep() {
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await screen.findByRole('heading', { name: /^Connect your agents?$/ });
}

// Continues from the agent step, connecting nothing, to where agents run.
async function toMachineStep() {
  await toConnectStep();
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await screen.findByRole('heading', { name: 'Where should agents run?' });
}

// Continues from the agent step and finishes with agents on this computer, connecting nothing.
async function finishSetup() {
  await toMachineStep();
  fireEvent.click(screen.getByRole('button', { name: 'Start working' }));
}

// Leaves the Project step for the list of agents Komla found.
async function toFoundAgents(projectButton: 'Create project' | 'Skip project' = 'Skip project') {
  fireEvent.click(screen.getByRole('button', { name: projectButton }));
  await screen.findByRole('heading', { name: 'Choose your agents' });
}

function stepLabels() {
  return ['Project', 'Agent', 'Connect', 'Machine', 'Analytics'].filter((label) =>
    screen.queryByText(label, { exact: true })
  );
}

describe('SetupWizard', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
    useSshHostDialogStore.setState({ open: false, request: null });
    updateConfig.mockResolvedValue({ ok: true, error: null });
    configState.config = { usageTelemetryConsentAnswered: true };
    loadConfig.mockResolvedValue(undefined);
    window.api = {
      detectInstalledAgents: vi.fn().mockResolvedValue([]),
      getNotificationHookDetails: vi.fn().mockResolvedValue({
        isConfigured: false,
        settingsPath: '/home/me/.claude/settings.json',
      }),
      getMcpStatus: vi.fn().mockResolvedValue({
        isConfigured: false,
        cliCommand: 'claude mcp add komla',
        generic: { integrationPrompt: '# Integrate this agent with Komla' },
      }),
      getKomlaSkillStatus: vi.fn(),
      enableNotifications: vi.fn().mockResolvedValue(undefined),
      enableKomlaSkill: vi.fn(),
      trackAgentSelected: vi.fn(),
      listSshConfigHosts: vi.fn().mockResolvedValue([]),
      listSshHosts: vi.fn().mockResolvedValue([]),
      websiteUrl: 'https://komla.dev',
    } as unknown as typeof window.api;
  });

  it('reads "Welcome to Komla" with the logo in the heading', () => {
    render(<SetupWizard onComplete={vi.fn()} />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/^Welcome to Komla$/);
  });

  it.each(['Claude Code', 'Cursor CLI'])('finishes setup with %s picked', async (agent) => {
    const onComplete = vi.fn();
    render(<SetupWizard onComplete={onComplete} />);
    await toAgentStep('Create project');
    fireEvent.click(screen.getByRole('button', { name: new RegExp(agent) }));

    await finishSetup();

    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(updateConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        agentSetupComplete: true,
        defaultProjectId: 'project-1',
        tipsIntroPending: true,
      })
    );
    expect(window.api.trackAgentSelected).toHaveBeenCalledWith(agent);
  });

  it.each([
    ['Share usage analytics', true],
    ['Don’t share', false],
  ])('asks about usage analytics on a last step: "%s"', async (answer, enabled) => {
    configState.config = { usageTelemetryConsentAnswered: false };
    render(<SetupWizard onComplete={vi.fn()} />);
    await toAgentStep();
    expect(stepLabels()).toEqual(['Project', 'Agent', 'Connect', 'Machine', 'Analytics']);
    await toMachineStep();
    expect(screen.queryByRole('button', { name: 'Start working' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByRole('heading', { name: 'Help improve Komla?' });
    expect(screen.getByRole('button', { name: 'Start working' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${answer}`) }));
    fireEvent.click(screen.getByRole('button', { name: 'Start working' }));

    await waitFor(() =>
      expect(updateConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          agentSetupComplete: true,
          usageTelemetryEnabled: enabled,
          errorReportingEnabled: true,
        })
      )
    );
    // The anonymous heartbeat stays as it is; only Settings turns it off.
    expect(updateConfig.mock.calls[0][0]).not.toHaveProperty('anonymousTelemetryEnabled');
  });

  it('keeps crash reports off when they were turned off before setup', async () => {
    configState.config = { usageTelemetryConsentAnswered: false, errorReportingEnabled: false };
    render(<SetupWizard onComplete={vi.fn()} />);
    await toAgentStep();
    await toMachineStep();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Don’t share/ }));

    expect(screen.getByRole('checkbox', { name: 'Send crash reports' })).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Start working' }));
    await waitFor(() =>
      expect(updateConfig).toHaveBeenCalledWith(
        expect.objectContaining({ agentSetupComplete: true, errorReportingEnabled: false })
      )
    );
  });

  it('turns crash reports off when unticked on the Analytics step', async () => {
    configState.config = { usageTelemetryConsentAnswered: false };
    render(<SetupWizard onComplete={vi.fn()} />);
    await toAgentStep();
    await toMachineStep();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Don’t share/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Send crash reports' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start working' }));

    await waitFor(() =>
      expect(updateConfig).toHaveBeenCalledWith(
        expect.objectContaining({ agentSetupComplete: true, errorReportingEnabled: false })
      )
    );
  });

  it('keeps the Analytics step when finishing fails after the answer was saved', async () => {
    configState.config = { usageTelemetryConsentAnswered: false };
    updateConfig.mockImplementation(async () => {
      configState.config = { usageTelemetryConsentAnswered: true };
      return { ok: true, error: null };
    });
    loadConfig.mockRejectedValue(new Error('Config failed to load'));
    render(<SetupWizard onComplete={vi.fn()} />);
    await toAgentStep();
    await toMachineStep();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Don’t share/ }));

    fireEvent.click(screen.getByRole('button', { name: 'Start working' }));

    expect(await screen.findByText('Config failed to load')).toBeVisible();
    expect(stepLabels()).toEqual(['Project', 'Agent', 'Connect', 'Machine', 'Analytics']);
    expect(screen.getByRole('heading', { name: 'Help improve Komla?' })).toBeVisible();
  });

  it('doesn’t ask about usage analytics again once answered', async () => {
    render(<SetupWizard onComplete={vi.fn()} />);
    await toAgentStep();

    await toMachineStep();
    expect(screen.queryByText('Analytics', { exact: true })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Start working' }));

    await waitFor(() => expect(updateConfig).toHaveBeenCalled());
    expect(updateConfig.mock.calls[0][0]).not.toHaveProperty('usageTelemetryEnabled');
    expect(updateConfig.mock.calls[0][0]).not.toHaveProperty('errorReportingEnabled');
  });

  it('keeps the template effort levels on the agent it creates', async () => {
    render(<SetupWizard onComplete={vi.fn()} />);
    await toAgentStep();

    await finishSetup();

    await waitFor(() =>
      expect(agentPresetsState.createActivePresets).toHaveBeenCalledWith([
        expect.objectContaining({ name: 'Claude Code', reasoningLevels: claudeLevels }),
      ])
    );
  });

  it('saves effort levels edited under "Customize commands"', async () => {
    render(<SetupWizard onComplete={vi.fn()} />);
    await toAgentStep();
    fireEvent.click(screen.getByRole('button', { name: 'Customize commands' }));

    fireEvent.click(screen.getByRole('button', { name: 'Remove effort level Low' }));
    fireEvent.change(screen.getByDisplayValue('High'), { target: { value: 'Max' } });
    fireEvent.change(screen.getByDisplayValue('--effort high'), {
      target: { value: '--effort max' },
    });
    await finishSetup();

    await waitFor(() =>
      expect(agentPresetsState.createActivePresets).toHaveBeenCalledWith([
        expect.objectContaining({
          name: 'Claude Code',
          reasoningLevels: [{ id: 'level-high', name: 'Max', arguments: '--effort max' }],
        }),
      ])
    );
  });

  it('adds effort levels to a custom agent', async () => {
    render(<SetupWizard onComplete={vi.fn()} />);
    await toAgentStep();
    fireEvent.click(screen.getByRole('button', { name: /Custom agent/ }));
    fireEvent.change(screen.getByPlaceholderText('e.g., claude {{launchMode}}'), {
      target: { value: 'aider' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Add level' }));
    fireEvent.change(screen.getByPlaceholderText('e.g., High'), { target: { value: ' High ' } });
    fireEvent.change(screen.getByPlaceholderText('e.g., --effort high'), {
      target: { value: ' --reasoning-effort high ' },
    });
    await finishSetup();

    await waitFor(() =>
      expect(agentPresetsState.createActivePresets).toHaveBeenCalledWith([
        expect.objectContaining({
          name: 'aider',
          reasoningLevels: [
            expect.objectContaining({ name: 'High', arguments: '--reasoning-effort high' }),
          ],
        }),
      ])
    );
  });

  it('saves an empty list when every template effort level is removed', async () => {
    render(<SetupWizard onComplete={vi.fn()} />);
    await toAgentStep();
    fireEvent.click(screen.getByRole('button', { name: 'Customize commands' }));

    fireEvent.click(screen.getByRole('button', { name: 'Remove effort level Low' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove effort level High' }));
    await finishSetup();

    await waitFor(() =>
      expect(agentPresetsState.createActivePresets).toHaveBeenCalledWith([
        expect.objectContaining({ name: 'Claude Code', reasoningLevels: [] }),
      ])
    );
  });

  it('leaves effort levels unset for an agent whose template has none', async () => {
    render(<SetupWizard onComplete={vi.fn()} />);
    await toAgentStep();
    fireEvent.click(screen.getByRole('button', { name: /Cursor CLI/ }));

    await finishSetup();

    await waitFor(() => expect(agentPresetsState.createActivePresets).toHaveBeenCalled());
    const [created] = agentPresetsState.createActivePresets.mock.calls[0][0] as {
      name: string;
      reasoningLevels?: unknown;
    }[];
    expect(created).toMatchObject({ name: 'Cursor CLI' });
    expect(created.reasoningLevels).toBeUndefined();
  });

  it.each([
    ['a name without arguments', 'High', ''],
    ['arguments without a name', '', '--reasoning-effort high'],
    ['a blank name', '   ', '--reasoning-effort high'],
  ])('rejects an effort level with %s', async (_case, name, args) => {
    render(<SetupWizard />);
    await toAgentStep();
    fireEvent.click(screen.getByRole('button', { name: /Custom agent/ }));
    fireEvent.change(screen.getByPlaceholderText('e.g., claude {{launchMode}}'), {
      target: { value: 'aider' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add level' }));
    fireEvent.change(screen.getByPlaceholderText('e.g., High'), { target: { value: name } });
    fireEvent.change(screen.getByPlaceholderText('e.g., --effort high'), {
      target: { value: args },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(screen.getByText('Every effort level needs a name and arguments')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start working' })).not.toBeInTheDocument();
  });

  it('opens "Customize commands" to show an incomplete effort level', async () => {
    render(<SetupWizard />);
    await toAgentStep();
    const toggle = screen.getByRole('button', { name: 'Customize commands' });
    fireEvent.click(toggle);
    fireEvent.change(screen.getByDisplayValue('--effort low'), { target: { value: '' } });
    fireEvent.click(toggle);

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(screen.getByText('Every effort level needs a name and arguments')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Low').closest('.wizard-collapsible')).toHaveAttribute(
      'data-open',
      'true'
    );
  });

  it('keeps collapsed "Customize commands" fields out of the tab order', async () => {
    render(<SetupWizard />);
    await toAgentStep();
    expect(screen.getByDisplayValue('Low').closest('[inert]')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Customize commands' }));

    expect(screen.getByDisplayValue('Low').closest('[inert]')).toBeNull();
  });

  it('keeps edits when the selected agent is clicked again', async () => {
    render(<SetupWizard />);
    await toAgentStep();
    fireEvent.click(screen.getByRole('button', { name: 'Customize commands' }));
    fireEvent.change(screen.getByDisplayValue('High'), { target: { value: 'Max' } });

    fireEvent.click(screen.getByRole('button', { name: /Claude Code/ }));

    expect(screen.getByDisplayValue('Max')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Max').closest('.wizard-collapsible')).toHaveAttribute(
      'data-open',
      'true'
    );
  });

  it('marks the selected agent card or chip as pressed', async () => {
    render(<SetupWizard />);
    await toAgentStep();

    const claude = screen.getByRole('button', { name: /Claude Code/ });
    const cursor = screen.getByRole('button', { name: /Cursor CLI/ });
    const custom = screen.getByRole('button', { name: /Custom agent/ });
    expect(claude).toHaveAttribute('aria-pressed', 'true');
    expect(cursor).toHaveAttribute('aria-pressed', 'false');
    expect(custom).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(cursor);
    expect(claude).toHaveAttribute('aria-pressed', 'false');
    expect(cursor).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(custom);
    expect(cursor).toHaveAttribute('aria-pressed', 'false');
    expect(custom).toHaveAttribute('aria-pressed', 'true');
  });

  it('centres Continue without an empty spacer beside it', async () => {
    render(<SetupWizard />);
    await toAgentStep('Create project');

    const nav = screen.getByRole('button', { name: 'Continue' }).parentElement!;
    expect(nav.children).toHaveLength(1);
  });

  it('goes back to a skipped Project step, but not to one that added a project', async () => {
    render(<SetupWizard />);
    await toAgentStep();

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await toAgentStep('Create project');

    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
  });

  it('keeps the Connect and Machine step navs outside the scrolling step content', async () => {
    render(<SetupWizard />);
    await toAgentStep('Create project');
    await toConnectStep();

    const heading = screen.getByRole('heading', { name: 'Connect your agent' });
    const scroller = heading.closest('.overflow-y-auto');
    expect(scroller).not.toBeNull();
    expect(scroller).not.toContainElement(screen.getByRole('button', { name: 'Continue' }));

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    const machineHeading = await screen.findByRole('heading', { name: 'Where should agents run?' });
    expect(machineHeading.closest('.overflow-y-auto')).not.toContainElement(
      screen.getByRole('button', { name: 'Start working' })
    );
  });

  describe('where agents run', () => {
    it('keeps agents on this computer unless asked', async () => {
      const onComplete = vi.fn();
      render(<SetupWizard onComplete={onComplete} />);
      await toAgentStep();
      await toMachineStep();

      expect(screen.getByRole('button', { name: /This computer/ })).toHaveAttribute(
        'aria-pressed',
        'true'
      );
      fireEvent.click(screen.getByRole('button', { name: 'Start working' }));

      await waitFor(() => expect(onComplete).toHaveBeenCalled());
      expect(useSshHostDialogStore.getState().open).toBe(false);
    });

    it('opens Add SSH host once setup is done when an SSH machine is picked', async () => {
      const onComplete = vi.fn();
      render(<SetupWizard onComplete={onComplete} />);
      await toAgentStep();
      await toMachineStep();

      fireEvent.click(screen.getByRole('button', { name: /A machine I can SSH into/ }));
      expect(screen.getByRole('link', { name: /Setup guide/ })).toHaveAttribute(
        'href',
        'https://komla.dev/remote-workspaces'
      );
      expect(screen.getByRole('link', { name: /No machine yet/ })).toHaveAttribute(
        'href',
        'https://komla.dev/remote-workspaces#no-machine'
      );
      expect(screen.getByText(/You connect the agents on it then/)).toBeVisible();
      expect(useSshHostDialogStore.getState().open).toBe(false);
      fireEvent.click(screen.getByRole('button', { name: 'Start working' }));

      await waitFor(() => expect(onComplete).toHaveBeenCalled());
      expect(useSshHostDialogStore.getState()).toMatchObject({
        open: true,
        request: { kind: 'add', source: 'onboarding', configHost: undefined },
      });
    });

    it('reads ~/.ssh/config only once an SSH machine is picked', async () => {
      render(<SetupWizard />);
      await toAgentStep();
      await toMachineStep();
      expect(window.api.listSshConfigHosts).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: /A machine I can SSH into/ }));
      fireEvent.click(screen.getByRole('button', { name: /This computer/ }));
      fireEvent.click(screen.getByRole('button', { name: /A machine I can SSH into/ }));

      await waitFor(() => expect(window.api.listSshConfigHosts).toHaveBeenCalledOnce());
    });

    it('leaves out the ~/.ssh/config hosts Komla already has', async () => {
      vi.mocked(window.api.listSshConfigHosts).mockResolvedValue([
        { alias: 'gpu', hostname: '10.0.0.5' },
        { alias: 'build' },
      ]);
      vi.mocked(window.api.listSshHosts).mockResolvedValue([
        { id: 'ssh-1', name: 'GPU', hostname: '10.0.0.5' },
      ] as Awaited<ReturnType<typeof window.api.listSshHosts>>);
      render(<SetupWizard />);
      await toAgentStep();
      await toMachineStep();

      fireEvent.click(screen.getByRole('button', { name: /A machine I can SSH into/ }));

      const list = await screen.findByRole('list', { name: 'Hosts in ~/.ssh/config' });
      expect(
        within(list)
          .getAllByRole('button')
          .map((chip) => chip.textContent)
      ).toEqual(['build']);
    });

    it('offers the hosts in ~/.ssh/config to start from', async () => {
      const gpu = { alias: 'gpu', hostname: '10.0.0.5', user: 'devuser' };
      vi.mocked(window.api.listSshConfigHosts).mockResolvedValue([gpu, { alias: 'build' }]);
      render(<SetupWizard onComplete={vi.fn()} />);
      await toAgentStep();
      await toMachineStep();
      expect(screen.queryByRole('list', { name: 'Hosts in ~/.ssh/config' })).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: /A machine I can SSH into/ }));
      const list = await screen.findByRole('list', { name: 'Hosts in ~/.ssh/config' });
      fireEvent.click(within(list).getByRole('button', { name: 'build' }));
      fireEvent.click(within(list).getByRole('button', { name: 'gpu' }));
      expect(within(list).getByRole('button', { name: 'gpu' })).toHaveAttribute(
        'aria-pressed',
        'true'
      );
      expect(within(list).getByRole('button', { name: 'build' })).toHaveAttribute(
        'aria-pressed',
        'false'
      );
      fireEvent.click(screen.getByRole('button', { name: 'Start working' }));

      await waitFor(() =>
        expect(useSshHostDialogStore.getState().request).toMatchObject({ configHost: gpu })
      );
    });
  });

  describe('with agents installed', () => {
    beforeEach(() => {
      vi.mocked(window.api.detectInstalledAgents).mockResolvedValue(['Claude Code', 'Cursor CLI']);
    });

    it('lists the agents it found to choose from, and greys out the rest', async () => {
      render(<SetupWizard />);
      expect(stepLabels()).toEqual(['Project', 'Agent', 'Connect', 'Machine']);
      await toFoundAgents();

      expect(screen.queryByText('Choose Your AI Agent')).toBeNull();
      const installed = screen.getByRole('list', { name: 'Installed agents' });
      expect(within(installed).getByRole('checkbox', { name: 'Claude Code' })).toBeChecked();
      expect(within(installed).getByRole('checkbox', { name: 'Cursor CLI' })).toBeChecked();
      expect(
        within(screen.getByRole('list', { name: 'Not installed' }))
          .getAllByRole('listitem')
          .map((item) => item.textContent)
      ).toEqual(['Amp']);
      expect(screen.getByText(/added as a custom agent later in Settings → Agents/)).toBeVisible();
    });

    it('adds only the agents left ticked, the first as the default', async () => {
      const onComplete = vi.fn();
      render(<SetupWizard onComplete={onComplete} />);
      await toFoundAgents();
      fireEvent.click(screen.getByRole('checkbox', { name: 'Claude Code' }));

      await finishSetup();

      await waitFor(() => expect(onComplete).toHaveBeenCalled());
      expect(agentPresetsState.createActivePresets).toHaveBeenCalledWith([
        expect.objectContaining({
          name: 'Cursor CLI',
          openCommand: 'cursor-agent',
          isBuiltin: false,
        }),
      ]);
      expect(window.api.trackAgentSelected).toHaveBeenCalledWith('Cursor CLI');
      expect(window.api.enableNotifications).not.toHaveBeenCalled();
      expect(updateConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          agentSetupComplete: true,
          selfIntegrationTipCreated: true,
        })
      );
    });

    it('needs at least one agent ticked', async () => {
      render(<SetupWizard />);
      await toFoundAgents();

      fireEvent.click(screen.getByRole('checkbox', { name: 'Claude Code' }));
      fireEvent.click(screen.getByRole('checkbox', { name: 'Cursor CLI' }));

      expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
      expect(screen.getByText(/Tick at least one agent to continue/)).toBeVisible();
    });

    it('offers the agent picker once every agent it found is unticked', async () => {
      const onComplete = vi.fn();
      render(<SetupWizard onComplete={onComplete} />);
      await toFoundAgents();
      fireEvent.click(screen.getByRole('checkbox', { name: 'Claude Code' }));
      fireEvent.click(screen.getByRole('checkbox', { name: 'Cursor CLI' }));

      fireEvent.click(screen.getByRole('button', { name: 'pick another agent' }));

      expect(await screen.findByText('Choose Your AI Agent')).toBeVisible();
      expect(screen.queryByText(/Komla didn’t find an agent CLI/)).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: /^Amp/ }));
      await finishSetup();

      await waitFor(() => expect(onComplete).toHaveBeenCalled());
      expect(agentPresetsState.createActivePresets).toHaveBeenCalledWith([
        expect.objectContaining({ name: 'Amp', openCommand: 'amp' }),
      ]);
    });

    it('goes back from the agent picker to the agents it found', async () => {
      render(<SetupWizard />);
      await toFoundAgents();
      fireEvent.click(screen.getByRole('checkbox', { name: 'Claude Code' }));
      fireEvent.click(screen.getByRole('checkbox', { name: 'Cursor CLI' }));
      fireEvent.click(screen.getByRole('button', { name: 'pick another agent' }));

      fireEvent.click(await screen.findByRole('button', { name: 'Show found agents' }));

      expect(await screen.findByRole('heading', { name: 'Choose your agents' })).toBeVisible();
    });

    it('leaves an error from the agent picker behind with it', async () => {
      render(<SetupWizard />);
      await toFoundAgents();
      fireEvent.click(screen.getByRole('checkbox', { name: 'Claude Code' }));
      fireEvent.click(screen.getByRole('checkbox', { name: 'Cursor CLI' }));
      fireEvent.click(screen.getByRole('button', { name: 'pick another agent' }));
      fireEvent.click(await screen.findByRole('button', { name: /Custom agent/ }));
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
      expect(await screen.findByText('Please enter the open command')).toBeVisible();

      fireEvent.click(screen.getByRole('button', { name: 'Show found agents' }));
      fireEvent.click(await screen.findByRole('checkbox', { name: 'Cursor CLI' }));
      await toMachineStep();

      expect(screen.queryByText('Please enter the open command')).toBeNull();
    });

    it('adds the agents once when Start working is clicked again after a failure', async () => {
      loadConfig.mockRejectedValueOnce(new Error('Config failed to load'));
      const onComplete = vi.fn();
      render(<SetupWizard onComplete={onComplete} />);
      await toFoundAgents();

      await finishSetup();
      expect(await screen.findByText('Config failed to load')).toBeVisible();
      fireEvent.click(screen.getByRole('button', { name: 'Start working' }));

      await waitFor(() => expect(onComplete).toHaveBeenCalled());
      expect(agentPresetsState.createActivePresets).toHaveBeenCalledOnce();
    });

    it('keeps the choice when going back from where agents run', async () => {
      render(<SetupWizard />);
      await toFoundAgents();
      fireEvent.click(screen.getByRole('checkbox', { name: 'Cursor CLI' }));
      await toMachineStep();

      fireEvent.click(screen.getByRole('button', { name: 'Back' }));
      await screen.findByRole('heading', { name: 'Connect your agent' });
      fireEvent.click(screen.getByRole('button', { name: 'Back' }));

      expect(await screen.findByRole('checkbox', { name: 'Cursor CLI' })).not.toBeChecked();
      expect(screen.getByRole('checkbox', { name: 'Claude Code' })).toBeChecked();
    });

    it('turns an integration on from its switch without finishing', async () => {
      const onComplete = vi.fn();
      render(<SetupWizard onComplete={onComplete} />);
      await toFoundAgents();
      await toConnectStep();
      const notifications = await screen.findByRole('switch', {
        name: 'Claude Code Hooks',
      });
      await waitFor(() => expect(notifications).toBeEnabled());
      vi.mocked(window.api.getNotificationHookDetails).mockResolvedValue({
        isConfigured: true,
        settingsPath: '/home/me/.claude/settings.json',
      } as Awaited<ReturnType<typeof window.api.getNotificationHookDetails>>);

      fireEvent.click(notifications);

      await waitFor(() => expect(notifications).toBeChecked());
      expect(window.api.enableNotifications).toHaveBeenCalledOnce();
      expect(onComplete).not.toHaveBeenCalled();
    });

    it('shows a failed change on its row', async () => {
      vi.mocked(window.api.enableNotifications).mockRejectedValue(
        new Error('EACCES: permission denied')
      );
      render(<SetupWizard />);
      await toFoundAgents();
      await toConnectStep();
      const notifications = await screen.findByRole('switch', {
        name: 'Claude Code Hooks',
      });
      await waitFor(() => expect(notifications).toBeEnabled());

      fireEvent.click(notifications);

      expect(
        await screen.findByText('Couldn’t turn on hooks: EACCES: permission denied.')
      ).toBeVisible();
      expect(notifications).not.toBeChecked();
    });

    it('leaves the Komla skill to Tips', async () => {
      render(<SetupWizard />);
      await toFoundAgents();
      await toConnectStep();
      await screen.findByRole('switch', { name: 'Claude Code Hooks' });

      expect(screen.queryByRole('switch', { name: /Komla skill/ })).toBeNull();
      expect(window.api.getKomlaSkillStatus).not.toHaveBeenCalled();
    });

    it('leaves agents that set themselves up to Tips', async () => {
      vi.mocked(window.api.detectInstalledAgents).mockResolvedValue([
        'Claude Code',
        'Cursor CLI',
        'Amp',
      ]);
      const onComplete = vi.fn();
      render(<SetupWizard onComplete={onComplete} />);
      await toFoundAgents();
      await toConnectStep();

      expect(
        await screen.findByRole('note', { name: 'Cursor CLI and Amp can set themselves up' })
      ).toHaveTextContent(/open Tips/);
      expect(screen.queryByRole('button', { name: /^Set up/ })).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Start working' }));

      await waitFor(() => expect(onComplete).toHaveBeenCalled());
      const saved = updateConfig.mock.calls[0][0];
      expect(saved).toMatchObject({
        selfIntegrationTipCreated: true,
        notificationsNudgePending: true,
        selfSetupNudgePending: true,
      });
      expect(saved).not.toHaveProperty('selfIntegrationTipCompleted');
    });

    it('waits for the search when the Project step is done first', async () => {
      let finishSearch: (names: string[]) => void = () => {};
      vi.mocked(window.api.detectInstalledAgents).mockReturnValue(
        new Promise((resolve) => {
          finishSearch = resolve;
        })
      );
      render(<SetupWizard />);
      fireEvent.click(screen.getByRole('button', { name: 'Skip project' }));

      expect(screen.getByRole('status')).toHaveTextContent('Looking for agents on this computer…');
      expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();

      finishSearch(['Claude Code']);

      expect(await screen.findByRole('heading', { name: 'Choose your agents' })).toBeVisible();
    });
  });

  it('offers the agent picker, and a new search, when no agent is found', async () => {
    render(<SetupWizard />);
    await toAgentStep();
    expect(stepLabels()).toEqual(['Project', 'Agent', 'Connect', 'Machine']);
    expect(screen.getByText(/Komla didn’t find an agent CLI on this computer/)).toBeVisible();

    vi.mocked(window.api.detectInstalledAgents).mockResolvedValue(['Claude Code']);
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));

    expect(await screen.findByRole('checkbox', { name: 'Claude Code' })).toBeChecked();
    expect(window.api.detectInstalledAgents).toHaveBeenCalledTimes(2);
  });

  it('offers to try again when the agent list fails to load', async () => {
    const templates = agentPresetsState.templates;
    agentPresetsState.templates = [];
    try {
      render(<SetupWizard />);
      fireEvent.click(screen.getByRole('button', { name: 'Skip project' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Komla couldn’t load its list of agents.'
      );
      expect(screen.queryByRole('status')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      expect(agentPresetsState.loadTemplates).toHaveBeenCalledTimes(2);
    } finally {
      agentPresetsState.templates = templates;
    }
  });

  it('shows the agent picker when the search fails', async () => {
    vi.mocked(window.api.detectInstalledAgents).mockRejectedValue(new Error('no shell'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<SetupWizard />);

    await toAgentStep();
    expect(screen.getByRole('button', { name: 'Check again' })).toBeVisible();
  });
});
