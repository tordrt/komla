/**
 * @vitest-environment jsdom
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { WorkspaceSetupSection } from '../../../../../src/renderer/components/layout/settings/WorkspaceSetupSection';
import { TooltipProvider } from '../../../../../src/renderer/components/ui/tooltip';
import { useSshHostsStore } from '../../../../../src/renderer/stores/ssh-hosts.store';

import type { SetupStep, SshHost } from '../../../../../src/shared/types';

const sshHost: SshHost = {
  id: 'ssh-host',
  name: 'Development host',
  hostname: 'dev.example.com',
  basePath: '~/.komla',
};

function renderSection(steps: SetupStep[] = [], hasSshHosts = true) {
  const onStepsChange = vi.fn();
  useSshHostsStore.setState({ hasLoaded: true, hosts: hasSshHosts ? [sshHost] : [] });

  render(
    <WorkspaceSetupSection
      steps={steps}
      agentPlacement="tab"
      agentLayoutOrder={0}
      actions={[]}
      presets={[
        {
          id: 'codex',
          name: 'Codex',
          openCommand: 'codex',
          continueCommand: 'codex resume --last',
          promptCommand: 'codex {{prompt}}',
          launchModes: [{ id: 'yolo', name: 'YOLO', command: 'codex --yolo {{prompt}}' }],
          isBuiltin: true,
        },
      ]}
      onStepsChange={onStepsChange}
      onAgentPlacementChange={vi.fn()}
      onAgentLayoutOrderChange={vi.fn()}
    />,
    { wrapper: TooltipProvider }
  );

  return onStepsChange;
}

function StatefulSection() {
  const [steps, setSteps] = React.useState<SetupStep[]>([]);

  return (
    <WorkspaceSetupSection
      steps={steps}
      agentPlacement="tab"
      agentLayoutOrder={0}
      actions={[]}
      presets={[]}
      onStepsChange={setSteps}
      onAgentPlacementChange={vi.fn()}
      onAgentLayoutOrderChange={vi.fn()}
    />
  );
}

describe('WorkspaceSetupSection', () => {
  beforeEach(() => {
    Object.assign(window, { api: { platform: 'darwin' } });
    useSshHostsStore.setState(useSshHostsStore.getInitialState(), true);
    useSshHostsStore.setState({ hasLoaded: true, hosts: [sshHost] });
  });

  it('explains when setup steps run', () => {
    renderSection();

    expect(screen.getByText('Setup steps')).toBeInTheDocument();
    expect(screen.getByText(/Creation-only steps run once/)).toHaveTextContent(
      'Creation-only steps run once, when the workspace is first created.'
    );
  });

  it('offers to add a step from the empty setup order', async () => {
    const onStepsChange = renderSection();

    expect(screen.getByText('No setup steps yet')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Add step' })).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Add step' }));

    expect(onStepsChange).toHaveBeenCalledWith([
      expect.objectContaining({ name: '', placement: 'background' }),
    ]);
  });

  it('names the reorder and remove buttons of each row', async () => {
    const onStepsChange = renderSection([
      { id: 'install', name: 'Install', command: 'npm install', placement: 'background' },
    ]);

    expect(screen.getByRole('button', { name: 'Move agent up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move agent down' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Move Install up' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Move Install down' })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'Remove Install' }));
    expect(onStepsChange).toHaveBeenCalledWith([]);
  });

  it('quick-adds a blank terminal in a new tab', async () => {
    const onStepsChange = renderSection();

    await userEvent.click(screen.getByRole('button', { name: 'New terminal tab' }));

    expect(onStepsChange).toHaveBeenCalledWith([
      expect.objectContaining({
        name: 'Terminal',
        command: '',
        placement: 'tab',
        destination: 'workspace-repository',
        trigger: 'every-workspace-start',
      }),
    ]);
  });

  it('adds a custom step below the setup order', async () => {
    const existingStep: SetupStep = {
      id: 'install',
      name: 'Install',
      command: 'npm install',
      placement: 'background',
    };
    const onStepsChange = renderSection([existingStep]);

    await userEvent.click(screen.getByRole('button', { name: 'Add step' }));

    expect(onStepsChange).toHaveBeenCalledWith([
      existingStep,
      expect.objectContaining({
        name: '',
        command: '',
        placement: 'background',
        destination: 'workspace-repository',
        trigger: 'every-workspace-start',
      }),
    ]);
  });

  it('quick-adds local-copy dependency setup beside the other dependency presets', async () => {
    const onStepsChange = renderSection();

    await userEvent.click(screen.getByRole('button', { name: 'Install in local copy' }));

    expect(onStepsChange).toHaveBeenCalledWith([
      expect.objectContaining({
        command: 'npm install',
        placement: 'background',
        destination: 'ssh-local-copy',
        trigger: 'workspace-creation',
      }),
    ]);
  });

  it('quick-adds an SSH workspace upload from the local project folder', async () => {
    const onStepsChange = renderSection();

    await userEvent.click(screen.getByRole('button', { name: 'Upload .env to SSH' }));

    expect(onStepsChange).toHaveBeenCalledWith([
      expect.objectContaining({
        name: 'Upload .env to SSH workspace',
        command:
          'scp -P {{sshPort}} "{{localProjectPath}}/.env" "{{sshTarget}}:{{workspacePath}}/.env"',
        placement: 'background',
        destination: 'ssh-local-copy',
        trigger: 'workspace-creation',
      }),
    ]);
  });

  it('quick-adds a .env copy from the local project folder into local workspaces', async () => {
    const onStepsChange = renderSection();

    await userEvent.click(screen.getByRole('button', { name: 'Copy .env' }));

    expect(onStepsChange).toHaveBeenCalledWith([
      expect.objectContaining({
        command: 'cp "{{localProjectPath}}/.env" .env',
        destination: 'local-workspace-repository',
        trigger: 'workspace-creation',
      }),
    ]);
  });

  it('quick-adds a .env copy from the local project folder into the local copy', async () => {
    const onStepsChange = renderSection();

    await userEvent.click(screen.getByRole('button', { name: 'Copy .env to local copy' }));

    expect(onStepsChange).toHaveBeenCalledWith([
      expect.objectContaining({
        command: 'cp "{{localProjectPath}}/.env" .env',
        destination: 'ssh-local-copy',
      }),
    ]);
  });

  it('renders setup steps as standalone cards and edits destination and creation trigger', async () => {
    const onStepsChange = renderSection([
      {
        id: 'setup-step',
        name: 'Install',
        command: 'npm install',
        placement: 'background',
        destination: 'workspace-repository',
        trigger: 'every-workspace-start',
      },
    ]);

    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Run in for Install' }),
      'ssh-local-copy'
    );
    expect(onStepsChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ destination: 'ssh-local-copy' }),
    ]);

    expect(screen.getByRole('article', { name: 'Setup step Install' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Local copy of SSH workspace' })).toBeInTheDocument();

    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Run on for Install' }),
      'workspace-creation'
    );
    expect(onStepsChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ trigger: 'workspace-creation' }),
    ]);
  });

  it('runs a stop step in the background and offers stop only for commands', async () => {
    const onStepsChange = renderSection([
      {
        id: 'down',
        name: 'Down',
        command: 'docker compose down',
        placement: 'tab',
        trigger: 'every-workspace-start',
      },
      { id: 'agent', name: 'Reviewer', command: '', placement: 'split-right', agent: {} },
    ]);

    expect(
      within(screen.getByRole('combobox', { name: 'Run on for Reviewer' })).queryByRole('option', {
        name: 'Workspace stop',
      })
    ).not.toBeInTheDocument();
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Run on for Down' }),
      'workspace-stop'
    );
    expect(onStepsChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: 'down', trigger: 'workspace-stop', placement: 'background' }),
      expect.objectContaining({ id: 'agent' }),
    ]);
  });

  it('shows no placement for a stop step', () => {
    renderSection([
      {
        id: 'down',
        name: 'Down',
        command: 'docker compose down',
        placement: 'background',
        trigger: 'workspace-stop',
      },
    ]);

    expect(screen.queryByRole('combobox', { name: 'Show in for Down' })).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Run on for Down' })).toHaveValue('workspace-stop');
  });

  it('hides SSH destinations when no SSH host is configured', () => {
    renderSection(
      [
        {
          id: 'setup-step',
          name: 'Install',
          command: 'npm install',
          placement: 'background',
          destination: 'workspace-repository',
          trigger: 'workspace-creation',
        },
      ],
      false
    );

    expect(screen.queryByRole('combobox', { name: 'Run in for Install' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Install in local copy' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Upload .env to SSH' })).not.toBeInTheDocument();
  });

  it('hides the local-only destination when no SSH host is configured', () => {
    renderSection(
      [
        {
          id: 'setup-step',
          name: 'Copy .env',
          command: 'cp "{{localProjectPath}}/.env" .env',
          placement: 'background',
          destination: 'local-workspace-repository',
          trigger: 'workspace-creation',
        },
      ],
      false
    );

    expect(
      screen.queryByRole('combobox', { name: 'Run in for Copy .env' })
    ).not.toBeInTheDocument();
  });

  it('leaves out Local copy on Windows, where setup cannot prepare one', () => {
    Object.assign(window, { api: { platform: 'win32' } });
    renderSection([
      {
        id: 'install',
        name: 'Install',
        command: 'npm install',
        placement: 'background',
        destination: 'workspace-repository',
      },
      {
        id: 'mirror',
        name: 'Mirror install',
        command: 'npm install',
        placement: 'background',
        destination: 'ssh-local-copy',
      },
    ]);

    const installDestinations = within(
      screen.getByRole('combobox', { name: 'Run in for Install' })
    );
    expect(
      installDestinations.queryByRole('option', { name: 'Local copy of SSH workspace' })
    ).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Run in for Mirror install' })).toHaveValue(
      'ssh-local-copy'
    );
    expect(screen.queryByRole('button', { name: 'Install in local copy' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Copy .env to local copy' })
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Upload .env to SSH' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy .env' })).toBeInTheDocument();
  });

  it('keeps an existing SSH destination editable after the last SSH host is removed', () => {
    renderSection(
      [
        {
          id: 'setup-step',
          name: 'Install locally',
          command: 'npm install',
          placement: 'background',
          destination: 'ssh-local-copy',
          trigger: 'workspace-creation',
        },
      ],
      false
    );

    expect(screen.getByRole('combobox', { name: 'Run in for Install locally' })).toHaveValue(
      'ssh-local-copy'
    );
  });

  it('keeps destination path help in the expandable variable list', async () => {
    renderSection([
      {
        id: 'setup-step',
        name: 'Upload',
        command: 'scp -P {{sshPort}} /path/to/.env {{sshTarget}}:{{workspacePath}}/',
        placement: 'background',
        destination: 'ssh-local-copy',
        trigger: 'workspace-creation',
      },
    ]);

    expect(screen.queryByText(/inserts the selected working folder/i)).not.toBeInTheDocument();

    await userEvent.click(screen.getByText('Variables available for this destination'));

    expect(screen.getByText('{{destinationPath}}')).toBeInTheDocument();
    expect(screen.getByText(/Where this command runs/)).toBeInTheDocument();
    expect(screen.getByText('{{workspacePath}}')).toBeInTheDocument();
    expect(screen.getByText(/The workspace on the SSH host/)).toBeInTheDocument();
    expect(screen.getByText('{{localProjectPath}}')).toBeInTheDocument();
    expect(screen.getByText(/The original project folder on this computer/)).toBeInTheDocument();
    expect(screen.getByText('{{sshTarget}}')).toBeInTheDocument();
    expect(screen.getByText(/user@host/)).toBeInTheDocument();
    expect(screen.getByText('{{sshPort}}')).toBeInTheDocument();
    expect(screen.queryByText('{{remoteWorkspacePath}}')).not.toBeInTheDocument();
    expect(screen.queryByText('{{projectName}}')).not.toBeInTheDocument();
  });

  it('does not advertise desktop-only paths for the generic workspace destination', async () => {
    renderSection([
      {
        id: 'setup-step',
        name: 'Install',
        command: 'npm install',
        placement: 'background',
        destination: 'workspace-repository',
        trigger: 'workspace-creation',
      },
    ]);

    await userEvent.click(screen.getByText('Variables available for this destination'));

    expect(screen.queryByText('{{localProjectPath}}')).not.toBeInTheDocument();
  });

  it('keeps the terminal-tab preset available when a tab action already exists', () => {
    renderSection([
      {
        id: 'action-step',
        name: 'Action',
        command: '',
        placement: 'tab',
        actionId: '',
      },
    ]);

    expect(
      (screen.getByRole('button', { name: 'New terminal tab' }) as HTMLButtonElement).disabled
    ).toBe(false);
  });

  it('keeps Background in the Show in selector', async () => {
    const onStepsChange = renderSection([
      {
        id: 'prepare',
        name: 'Prepare',
        command: 'npm install',
        placement: 'background',
      },
    ]);

    const showIn = screen.getByRole('combobox', { name: 'Show in for Prepare' });
    expect(showIn).toHaveValue('background');
    expect(screen.queryByRole('checkbox', { name: 'Run in background' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Show agent in' })).not.toBeInTheDocument();

    await userEvent.selectOptions(showIn, 'tab');
    expect(onStepsChange).toHaveBeenLastCalledWith([expect.objectContaining({ placement: 'tab' })]);
  });

  it('warns only about background commands that look long-running', () => {
    renderSection([
      {
        id: 'install',
        name: 'Install',
        command: 'npm install > /dev/null',
        placement: 'background',
      },
      { id: 'dev', name: 'Dev', command: 'npm run dev', placement: 'background' },
      { id: 'up', name: 'Up', command: 'docker compose up', placement: 'background' },
      { id: 'build', name: 'Build', command: 'npm run build -- --watch', placement: 'background' },
      { id: 'tab', name: 'Tab', command: 'npm run dev', placement: 'tab' },
    ]);

    const warningIn = (name: string) =>
      within(screen.getByRole('article', { name: `Setup step ${name}` })).queryByText(
        /should run a command that exits on its own/
      );
    expect(warningIn('Install')).not.toBeInTheDocument();
    expect(warningIn('Dev')).toBeInTheDocument();
    expect(warningIn('Up')).toBeInTheDocument();
    expect(warningIn('Build')).toBeInTheDocument();
    expect(warningIn('Tab')).not.toBeInTheDocument();
  });

  it('warns when a step that can run over SSH reads a desktop path', () => {
    renderSection([
      {
        id: 'any',
        name: 'Any workspace',
        command: 'cp "{{localProjectPath}}/.env" .env',
        placement: 'background',
        destination: 'workspace-repository',
      },
      {
        id: 'ssh',
        name: 'SSH only',
        command: 'ls {{projectPath}}',
        placement: 'background',
        destination: 'ssh-workspace-repository',
      },
      {
        id: 'local',
        name: 'Local only',
        command: 'cp "{{localProjectPath}}/.env" .env',
        placement: 'background',
        destination: 'local-workspace-repository',
      },
    ]);

    const warningIn = (name: string) =>
      within(screen.getByRole('article', { name: `Setup step ${name}` })).queryByText(
        /is a folder on this computer/
      );
    expect(warningIn('Any workspace')).toHaveTextContent('{{localProjectPath}} is a folder');
    expect(warningIn('SSH only')).toHaveTextContent('{{projectPath}} is a folder');
    expect(warningIn('Local only')).not.toBeInTheDocument();
  });

  it('does not warn about desktop paths when no SSH host is configured', () => {
    renderSection(
      [
        {
          id: 'any',
          name: 'Any workspace',
          command: 'cp "{{localProjectPath}}/.env" .env',
          placement: 'background',
          destination: 'workspace-repository',
        },
      ],
      false
    );

    expect(screen.queryByText(/is a folder on this computer/)).not.toBeInTheDocument();
  });

  it('asks to choose an action for an action step without one', () => {
    renderSection([
      { id: 'action-step', name: 'Action', command: '', placement: 'tab', actionId: '' },
    ]);

    expect(screen.getByText(/Choose a quick command/)).toBeInTheDocument();
  });

  it('shows split options in Show in for a visible terminal', () => {
    renderSection([
      {
        id: 'terminal',
        name: 'Dev server',
        command: 'npm run dev',
        placement: 'split-right',
      },
    ]);

    expect(screen.getByRole('combobox', { name: 'Show in for Dev server' })).toHaveValue(
      'split-right'
    );
  });

  it('allows the same quick action to be added multiple times', async () => {
    render(<StatefulSection />, { wrapper: TooltipProvider });

    await userEvent.click(screen.getByRole('button', { name: 'Split bottom' }));
    await userEvent.click(screen.getByRole('button', { name: 'Split bottom' }));

    expect(screen.getAllByDisplayValue('Terminal')).toHaveLength(2);
    expect(
      (screen.getByRole('button', { name: 'Split bottom' }) as HTMLButtonElement).disabled
    ).toBe(false);
  });

  it('allows multiple agents to be quick-added', async () => {
    render(<StatefulSection />, { wrapper: TooltipProvider });

    await userEvent.click(screen.getByRole('button', { name: 'Add agent' }));
    await userEvent.click(screen.getByRole('button', { name: 'Add agent' }));

    expect(screen.getAllByRole('combobox', { name: 'Agent preset for Agent' })).toHaveLength(2);
  });

  it('quick-adds an agent that inherits the workspace launch mode', async () => {
    const onStepsChange = renderSection();

    await userEvent.click(screen.getByRole('button', { name: 'Add agent' }));

    expect(onStepsChange).toHaveBeenCalledWith([
      expect.objectContaining({
        name: 'Agent',
        command: '',
        placement: 'split-right',
        agent: {},
      }),
    ]);
  });

  it('can pin an agent setup step to a preset and launch mode', async () => {
    const onStepsChange = renderSection([
      {
        id: 'agent-step',
        name: 'Reviewer',
        command: '',
        placement: 'split-right',
        agent: { presetId: 'codex' },
      },
    ]);

    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Agent launch mode for Reviewer' }),
      'yolo'
    );

    expect(onStepsChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ agent: { presetId: 'codex', launchModeId: 'yolo' } }),
    ]);
  });

  it('shows a deleted pinned preset as the workspace default', () => {
    renderSection([
      {
        id: 'agent-step',
        name: 'Reviewer',
        command: '',
        placement: 'split-right',
        agent: { presetId: 'deleted-preset', launchModeId: 'deleted-mode' },
      },
    ]);

    expect(screen.getByRole('combobox', { name: 'Agent preset for Reviewer' })).toHaveValue('');
    expect(
      screen.queryByRole('combobox', { name: 'Agent launch mode for Reviewer' })
    ).not.toBeInTheDocument();
  });
});
