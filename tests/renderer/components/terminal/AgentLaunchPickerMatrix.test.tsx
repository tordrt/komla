/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AgentLaunchPickerMatrix } from '../../../../src/renderer/components/terminal/AgentLaunchPickerMatrix';
import {
  DropdownMenu,
  DropdownMenuContent,
} from '../../../../src/renderer/components/ui/dropdown-menu';

import type { AgentPreset } from '../../../../src/renderer/types';

const claude: AgentPreset = {
  id: 'claude',
  name: 'Claude Code',
  openCommand: 'claude',
  continueCommand: 'claude --continue',
  promptCommand: 'claude',
  isBuiltin: true,
  launchModes: [
    { id: 'plan', name: 'Plan', arguments: '--permission-mode plan', color: 'blue' },
    { id: 'yolo', name: 'Dangerously skip permissions', arguments: '--yolo', color: 'red' },
  ],
};

function renderPicker() {
  render(
    <DropdownMenu open>
      <DropdownMenuContent>
        <AgentLaunchPickerMatrix
          presets={[claude]}
          inspectedPresetId="claude"
          onInspectPreset={vi.fn()}
          selectedTarget={{ presetId: 'claude', launchModeId: 'plan' }}
          onSelectTarget={vi.fn()}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

describe('AgentLaunchPickerMatrix', () => {
  it('shows each launch mode by a bar and a name in its color', () => {
    renderPicker();

    const plan = screen.getByRole('menuitem', { name: 'Claude Code, Plan' });
    expect(plan.querySelector('[data-launch-mode-color]')).toHaveAttribute(
      'data-launch-mode-color',
      'blue'
    );
    expect(plan.querySelector('[data-launch-mode-color]')).toHaveClass('text-blue-700');
    expect(
      screen
        .getByRole('menuitem', { name: 'Claude Code, Dangerously skip permissions' })
        .querySelector('[data-launch-mode-color]')
    ).toHaveClass('text-red-700');
    expect(
      screen
        .getByRole('menuitem', { name: 'Claude Code, Default' })
        .querySelector('[data-launch-mode-color]')
    ).toHaveAttribute('data-launch-mode-color', 'default');
  });

  it('marks the selected launch mode with a check', () => {
    renderPicker();

    expect(
      within(screen.getByRole('menuitem', { name: 'Claude Code, Plan' })).getByTestId(
        'launch-mode-check'
      )
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('menuitem', { name: 'Claude Code, Default' })).queryByTestId(
        'launch-mode-check'
      )
    ).toBeNull();
  });

  describe('adding model and effort options', () => {
    const renderWith = (preset: AgentPreset, onAddAgentOption = vi.fn()) => {
      render(
        <DropdownMenu open>
          <DropdownMenuContent>
            <AgentLaunchPickerMatrix
              presets={[preset]}
              inspectedPresetId={preset.id}
              onInspectPreset={vi.fn()}
              selectedTarget={{ presetId: preset.id, launchModeId: null }}
              onSelectTarget={vi.fn()}
              onAddAgentOption={onAddAgentOption}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      );
      return onAddAgentOption;
    };

    it('offers both for an agent that has neither, and opens the one picked', () => {
      const onAdd = renderWith(claude);

      expect(screen.getByRole('menuitem', { name: 'Add effort picker…' })).toBeInTheDocument();
      fireEvent.click(screen.getByRole('menuitem', { name: 'Add model picker…' }));
      expect(onAdd).toHaveBeenCalledWith('claude', 'models');
      fireEvent.click(screen.getByRole('menuitem', { name: 'Edit launch modes…' }));
      expect(onAdd).toHaveBeenCalledWith('claude', 'launchModes');
    });

    it('offers to edit a picker the agent already has, by its title', () => {
      const onAdd = renderWith({
        ...claude,
        models: [{ id: 'm', name: 'Opus', arguments: '--model opus' }],
        reasoningLevels: [{ id: 'l', name: 'High', arguments: '--effort high' }],
        levelPicker: { title: 'Speed' },
      });

      expect(screen.queryByRole('menuitem', { name: 'Add model picker…' })).toBeNull();
      expect(screen.queryByRole('menuitem', { name: 'Add effort picker…' })).toBeNull();
      expect(screen.getByRole('menuitem', { name: 'Edit speed picker…' })).toBeInTheDocument();
      fireEvent.click(screen.getByRole('menuitem', { name: 'Edit model picker…' }));
      expect(onAdd).toHaveBeenCalledWith('claude', 'models');
      // Launch modes can always be edited.
      expect(screen.getByRole('menuitem', { name: 'Edit launch modes…' })).toBeInTheDocument();
    });

    it('offers nothing for an agent that starts no command', () => {
      renderWith({ ...claude, openCommand: '' });

      expect(screen.queryByRole('menuitem', { name: 'Add model picker…' })).toBeNull();
      expect(screen.queryByRole('menuitem', { name: 'Edit launch modes…' })).toBeNull();
    });
  });
});
