/**
 * @vitest-environment jsdom
 */
import { render, screen, within } from '@testing-library/react';
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
});
