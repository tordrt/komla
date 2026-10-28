/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { AutomationEditorDialog } from '../../../../../src/renderer/components/layout/settings/AutomationEditorDialog';
import { AUTOMATION_TEMPLATES } from '../../../../../src/renderer/lib/automation-templates';

import type { AgentPreset, Project, SshHost } from '../../../../../src/shared/types';
import type { Automation } from '../../../../../src/shared/types/automation';

const projects = [
  { id: 'alpha', name: 'Alpha', repositoryPath: '/alpha' } as Project,
  { id: 'beta', name: 'Beta', repositoryPath: '/beta' } as Project,
];

const presets: AgentPreset[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    openCommand: 'claude',
    continueCommand: 'claude --continue',
    promptCommand: 'claude {{prompt}}',
    launchModes: [{ id: 'auto', name: 'Auto', command: 'claude --auto {{prompt}}' }],
    isBuiltin: true,
  },
];

const hosts = [{ id: 'h1', name: 'devbox' } as SshHost];

const automation: Automation = {
  id: 'triage',
  name: 'Morning triage',
  prompt: 'Label new issues',
  projectId: 'beta',
  target: { kind: 'ssh', hostId: 'h1' },
  presetId: 'claude',
  schedule: { cron: '30 8 * * 1-5', timeZone: 'Europe/Oslo' },
  enabled: false,
  missedRunGraceMinutes: 180,
  createdAt: 1,
  updatedAt: 1,
};

const dependencyTemplate = AUTOMATION_TEMPLATES.find(
  (template) => template.id === 'dependency-updates'
)!;

function renderEditor(
  overrides: Partial<React.ComponentProps<typeof AutomationEditorDialog>> = {}
) {
  const props = {
    automation: null,
    projects,
    presets,
    activePresets: [],
    hosts,
    defaultTarget: { kind: 'local' as const },
    isSaving: false,
    onSave: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  return { ...render(<AutomationEditorDialog {...props} />), props };
}

describe('AutomationEditorDialog', () => {
  it('starts from a template, so only the project is left to choose', async () => {
    const user = userEvent.setup();
    const { props } = renderEditor({ template: dependencyTemplate });

    expect(screen.getByRole('heading', { name: 'New automation' })).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('Dependency updates');
    expect(screen.getByLabelText('Name')).toHaveFocus();
    expect(screen.getByLabelText('Prompt')).toHaveValue(dependencyTemplate.prompt);
    expect(screen.getByRole('radio', { name: 'Weekly' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('button', { name: 'Mon' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('Time')).toHaveValue('07:00');

    await user.click(screen.getByRole('button', { name: /Create automation/ }));
    expect(props.onSave).not.toHaveBeenCalled();
    expect(screen.getByText('Add a project to save this automation.')).toBeInTheDocument();

    await user.click(screen.getByLabelText('Project'));
    await user.click(await screen.findByRole('menuitem', { name: 'Alpha' }));
    expect(screen.getByLabelText('Project')).toHaveTextContent('Alpha');
    await user.click(screen.getByRole('button', { name: /Create automation/ }));

    expect(props.onSave).toHaveBeenCalledWith({
      name: 'Dependency updates',
      prompt: dependencyTemplate.prompt,
      projectId: 'alpha',
      target: { kind: 'local' },
      schedule: { cron: '0 7 * * 1', timeZone: expect.any(String) },
      enabled: true,
      missedRunGraceMinutes: 1440,
    });
  });

  it('replaces the name, prompt, and schedule with a template from the menu', async () => {
    const user = userEvent.setup();
    renderEditor();

    await user.type(screen.getByLabelText('Name'), 'Draft');
    await user.click(screen.getByRole('button', { name: /Use a template/ }));
    await user.click(await screen.findByRole('menuitem', { name: /Flaky test hunt/ }));

    expect(screen.getByLabelText('Name')).toHaveValue('Flaky test hunt');
    expect(screen.getByLabelText('Prompt')).toHaveValue(
      AUTOMATION_TEMPLATES.find((template) => template.id === 'flaky-tests')!.prompt
    );
    expect(screen.getByRole('radio', { name: 'Daily' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByLabelText('Time')).toHaveValue('02:00');
  });

  it('lists what is missing instead of saving an empty automation', async () => {
    const user = userEvent.setup();
    const { props } = renderEditor();

    await user.click(screen.getByRole('button', { name: /Create automation/ }));

    expect(props.onSave).not.toHaveBeenCalled();
    expect(
      screen.getByText('Add a name, a prompt and a project to save this automation.')
    ).toBeInTheDocument();
  });

  it('edits an automation in place and saves it with the keyboard shortcut', async () => {
    const user = userEvent.setup();
    const onRequestDelete = vi.fn();
    const { props } = renderEditor({ automation, onRequestDelete });

    expect(screen.getByRole('heading', { name: 'Edit automation' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Use a template/ })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Run on')).toHaveTextContent('devbox');
    expect(screen.getByRole('radio', { name: 'Weekdays' })).toHaveAttribute('aria-checked', 'true');

    await user.clear(screen.getByLabelText('Name'));
    await user.type(screen.getByLabelText('Name'), 'Issue triage');
    await user.click(screen.getByLabelText('Agent'));
    await user.click(await screen.findByRole('menuitem', { name: 'Claude Code, Auto' }));
    expect(screen.getByLabelText('Agent')).toHaveTextContent('Claude CodeAuto');
    fireEvent.keyDown(screen.getByLabelText('Name'), { key: 'Enter', ctrlKey: true });

    expect(props.onSave).toHaveBeenCalledWith({
      id: 'triage',
      previousTarget: { kind: 'ssh', hostId: 'h1' },
      name: 'Issue triage',
      prompt: 'Label new issues',
      projectId: 'beta',
      target: { kind: 'ssh', hostId: 'h1' },
      presetId: 'claude',
      launchModeId: 'auto',
      schedule: { cron: '30 8 * * 1-5', timeZone: 'Europe/Oslo' },
      enabled: false,
      missedRunGraceMinutes: 180,
    });

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onRequestDelete).toHaveBeenCalled();
  });

  it('starts a new automation with the agent used last, and runs it on the chosen host', async () => {
    const user = userEvent.setup();
    const codex: AgentPreset = {
      id: 'codex',
      name: 'Codex',
      openCommand: 'codex',
      continueCommand: 'codex resume --last',
      promptCommand: 'codex {{prompt}}',
      launchModes: [{ id: 'full-auto', name: 'Full auto', command: 'codex --full-auto' }],
      isBuiltin: true,
    };
    const { props } = renderEditor({
      template: dependencyTemplate,
      presets: [...presets, codex],
      activePresets: [
        { presetId: 'claude', lastUsedAt: 1 },
        { presetId: 'codex', lastUsedAt: 2, lastLaunchModeId: 'full-auto' },
      ],
    });

    expect(screen.getByLabelText('Agent')).toHaveTextContent('CodexFull auto');

    await user.click(screen.getByLabelText('Run on'));
    expect(await screen.findByRole('menuitem', { name: 'This computer' })).toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: 'devbox' }));
    await user.click(screen.getByLabelText('Project'));
    await user.click(await screen.findByRole('menuitem', { name: 'Beta' }));
    await user.click(screen.getByRole('button', { name: /Create automation/ }));

    expect(props.onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'beta',
        target: { kind: 'ssh', hostId: 'h1' },
        presetId: 'codex',
        launchModeId: 'full-auto',
      })
    );
  });

  it('starts with the default launch mode when the agent has no last-used one', () => {
    renderEditor({
      template: dependencyTemplate,
      activePresets: [{ presetId: 'claude', lastUsedAt: 1 }],
      defaultLaunchModeId: 'auto',
    });

    expect(screen.getByLabelText('Agent')).toHaveTextContent('Claude CodeAuto');
  });

  it('goes back to following the active preset', async () => {
    const user = userEvent.setup();
    const { props } = renderEditor({ automation });

    await user.click(screen.getByLabelText('Agent'));
    await user.click(await screen.findByRole('menuitem', { name: 'Active preset (default)' }));
    await user.click(screen.getByRole('button', { name: /Save/ }));

    expect(props.onSave).toHaveBeenCalledWith(
      expect.not.objectContaining({ presetId: expect.anything() })
    );
  });

  it('keeps the missed-run choice under Advanced', async () => {
    const user = userEvent.setup();
    renderEditor({ automation });

    expect(screen.queryByLabelText('When a run is missed')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Missed runs start up to 3 hours late/ }));
    expect(screen.getByLabelText('When a run is missed')).toHaveValue('180');
  });

  it('asks before closing with unsaved changes', async () => {
    const user = userEvent.setup();
    const { props } = renderEditor({ automation });

    await user.type(screen.getByLabelText('Prompt'), ' and close duplicates');
    await user.keyboard('{Escape}');

    expect(props.onClose).not.toHaveBeenCalled();
    expect(screen.getByText('Discard your changes to this automation?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(props.onClose).toHaveBeenCalled();
  });

  it('closes without asking when nothing changed', async () => {
    const user = userEvent.setup();
    const { props } = renderEditor({ automation });

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(props.onClose).toHaveBeenCalled();
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();
  });
});
