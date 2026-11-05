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

  describe('editing an agent', () => {
    const codex: AgentPreset = { ...claude, id: 'codex', name: 'Codex', launchModes: [] };
    const renderWith = (presets: AgentPreset[], inspectedPresetId: string) => {
      const onEditAgent = vi.fn();
      render(
        <DropdownMenu open>
          <DropdownMenuContent>
            <AgentLaunchPickerMatrix
              presets={presets}
              inspectedPresetId={inspectedPresetId}
              onInspectPreset={vi.fn()}
              selectedTarget={{ presetId: presets[0].id, launchModeId: null }}
              onSelectTarget={vi.fn()}
              getPreferredLaunchModeId={() => null}
              onManageAgents={vi.fn()}
              onEditAgent={onEditAgent}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      );
      return { onEditAgent };
    };

    it('leaves editing to "Manage agents…" when there are several', () => {
      const { onEditAgent } = renderWith([claude, codex], 'codex');

      expect(screen.queryByRole('button', { name: /^Edit / })).toBeNull();
      expect(screen.queryByRole('menuitem', { name: /^Edit / })).toBeNull();
      expect(screen.getByRole('menuitem', { name: 'Manage agents…' })).toBeInTheDocument();
      expect(onEditAgent).not.toHaveBeenCalled();
    });

    it("offers the only agent's editor in place of the agent list", () => {
      const { onEditAgent } = renderWith([claude], 'claude');

      expect(screen.queryByRole('menuitem', { name: 'Manage agents…' })).toBeNull();
      fireEvent.click(screen.getByRole('menuitem', { name: 'Edit Claude Code…' }));
      expect(onEditAgent).toHaveBeenCalledWith('claude');
    });

    it('keeps one height across agents, counting the agent column and its "Manage agents…"', () => {
      render(
        <DropdownMenu open>
          <DropdownMenuContent>
            <AgentLaunchPickerMatrix
              presets={[claude, codex]}
              inspectedPresetId="codex"
              onInspectPreset={vi.fn()}
              onManageAgents={vi.fn()}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      );

      // Claude Code's Default and two launch modes match two agents and "Manage agents…".
      expect(document.querySelector('[data-agent-launch-matrix]')).toHaveStyle({
        minHeight: '5.5rem',
      });
    });

    it('keeps that height when multi-select lists fewer agents and no "Manage agents…"', () => {
      const plain = { ...codex, launchModes: [] };
      const others = [plain, { ...plain, id: 'b', name: 'B' }, { ...plain, id: 'c', name: 'C' }];
      render(
        <DropdownMenu open>
          <DropdownMenuContent>
            <AgentLaunchPickerMatrix
              presets={[plain]}
              heightPresets={others}
              inspectedPresetId={plain.id}
              onInspectPreset={vi.fn()}
              selectedTargets={[]}
              onManageAgents={vi.fn()}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      );

      // Three agents and "Manage agents…", as the single-select menu shows them.
      expect(document.querySelector('[data-agent-launch-matrix]')).toHaveStyle({
        minHeight: '7.375rem',
      });
      expect(screen.queryByRole('menuitem', { name: 'Manage agents…' })).toBeNull();
    });
  });
});
