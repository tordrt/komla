/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { CommandInputs } from '../../../../../src/renderer/components/layout/settings/CommandInputs';
import { TooltipProvider } from '../../../../../src/renderer/components/ui/tooltip';

import type { LaunchMode } from '../../../../../src/shared/types/agent-preset';

const levels = [
  { id: 'low', name: 'Low', arguments: '--effort low' },
  { id: 'high', name: 'High', arguments: '--effort high' },
];

function renderInputs() {
  const onReasoningLevelsChange = vi.fn();
  render(
    <CommandInputs
      openCommand="agent"
      continueCommand=""
      promptCommand=""
      launchModes={[]}
      reasoningLevels={levels}
      onOpenCommandChange={vi.fn()}
      onContinueCommandChange={vi.fn()}
      onPromptCommandChange={vi.fn()}
      onLaunchModesChange={vi.fn()}
      onReasoningLevelsChange={onReasoningLevelsChange}
      alwaysExpanded
    />
  );
  const row = (name: string) => screen.getByDisplayValue(name).parentElement as HTMLElement;
  return { onReasoningLevelsChange, row };
}

const dataTransfer = () => ({ setData: vi.fn(), effectAllowed: '', dropEffect: '' });

describe('CommandInputs effort levels', () => {
  it('reorders levels by dragging a row by its grip', () => {
    const { onReasoningLevelsChange, row } = renderInputs();

    fireEvent.mouseDown(row('Low').querySelector('svg') as SVGElement);
    fireEvent.dragStart(row('Low'), { dataTransfer: dataTransfer() });
    fireEvent.dragOver(row('High'), { dataTransfer: dataTransfer(), clientY: 10 });
    fireEvent.drop(row('High'), { dataTransfer: dataTransfer() });

    expect(onReasoningLevelsChange).toHaveBeenCalledWith([levels[1], levels[0]]);
  });

  it('ignores text dragged out of a level input', () => {
    const { onReasoningLevelsChange, row } = renderInputs();

    fireEvent.dragStart(screen.getByDisplayValue('--effort low'), { dataTransfer: dataTransfer() });
    fireEvent.dragOver(row('High'), { dataTransfer: dataTransfer(), clientY: 10 });
    fireEvent.drop(row('High'), { dataTransfer: dataTransfer() });

    expect(onReasoningLevelsChange).not.toHaveBeenCalled();
  });

  it('keeps the order when a row is dropped back where it started', () => {
    const { onReasoningLevelsChange, row } = renderInputs();

    fireEvent.mouseDown(row('Low').querySelector('svg') as SVGElement);
    fireEvent.dragStart(row('Low'), { dataTransfer: dataTransfer() });
    fireEvent.dragOver(row('High'), { dataTransfer: dataTransfer(), clientY: 10 });
    fireEvent.dragOver(row('Low'), { dataTransfer: dataTransfer(), clientY: 10 });
    fireEvent.drop(row('Low'), { dataTransfer: dataTransfer() });

    expect(onReasoningLevelsChange).not.toHaveBeenCalled();
  });
});

describe('CommandInputs level picker', () => {
  const renderPicker = (levelPicker = {}) => {
    const onLevelPickerChange = vi.fn();
    render(
      <CommandInputs
        openCommand=""
        continueCommand=""
        promptCommand=""
        launchModes={[]}
        reasoningLevels={levels}
        onOpenCommandChange={vi.fn()}
        onContinueCommandChange={vi.fn()}
        onPromptCommandChange={vi.fn()}
        onLaunchModesChange={vi.fn()}
        onReasoningLevelsChange={vi.fn()}
        levelPicker={levelPicker}
        onLevelPickerChange={onLevelPickerChange}
        alwaysExpanded
      />
    );
    return onLevelPickerChange;
  };

  it('shows the effort defaults and changes the title', () => {
    const onLevelPickerChange = renderPicker();

    expect(screen.getByRole('button', { name: 'Icon: gauge' })).toBeInTheDocument();
    const title = screen.getByRole('textbox', { name: 'Picker title' });
    expect(title).toHaveAttribute('placeholder', 'Effort');
    fireEvent.change(title, { target: { value: 'Model' } });

    expect(onLevelPickerChange).toHaveBeenCalledWith({ title: 'Model' });
  });

  it('picks another icon, keeping the title', async () => {
    const user = userEvent.setup();
    const onLevelPickerChange = renderPicker({ title: 'Model' });

    await user.click(screen.getByRole('button', { name: 'Icon: gauge' }));
    expect(screen.getByRole('button', { name: 'gauge' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: 'cpu' }));

    expect(onLevelPickerChange).toHaveBeenCalledWith({ title: 'Model', icon: 'cpu' });
  });

  it('hides the picker in the new workspace dialog, keeping the title', async () => {
    const user = userEvent.setup();
    const onLevelPickerChange = renderPicker({ title: 'Model' });

    const shown = screen.getByRole('switch', { name: 'Show in the new workspace dialog' });
    expect(shown).toBeChecked();
    await user.click(shown);

    expect(onLevelPickerChange).toHaveBeenCalledWith({ title: 'Model', hidden: true });
  });

  it('leaves them out where no one can change them', () => {
    renderInputs();

    expect(screen.queryByRole('textbox', { name: 'Picker title' })).not.toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });
});

function renderLaunchModeInputs(
  launchModes: LaunchMode[],
  onLaunchModesChange = vi.fn(),
  pinnedLaunchModeId?: string
) {
  render(
    <TooltipProvider>
      <CommandInputs
        openCommand=""
        continueCommand=""
        promptCommand=""
        launchModes={launchModes}
        reasoningLevels={[]}
        onOpenCommandChange={vi.fn()}
        onContinueCommandChange={vi.fn()}
        onPromptCommandChange={vi.fn()}
        onLaunchModesChange={onLaunchModesChange}
        onReasoningLevelsChange={vi.fn()}
        alwaysExpanded
        pinnedLaunchModeId={pinnedLaunchModeId}
      />
    </TooltipProvider>
  );
  return onLaunchModesChange;
}

const modes = (count: number): LaunchMode[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `m${index}`,
    name: `Mode ${index}`,
    arguments: '',
  }));

describe('CommandInputs launch mode colors', () => {
  it('names each swatch and marks the selected one as pressed', async () => {
    const user = userEvent.setup();
    const onLaunchModesChange = renderLaunchModeInputs([{ ...modes(1)[0], color: 'purple' }]);

    const trigger = screen.getByRole('button', { name: 'Color: purple' });
    trigger.focus();
    await user.keyboard('{Enter}');

    const purple = await screen.findByRole('button', { name: 'purple' });
    expect(purple).toHaveAttribute('aria-pressed', 'true');
    expect(purple.className).toContain('border-foreground');
    expect(purple.className).not.toContain('border-white');
    expect(screen.getByRole('button', { name: 'emerald' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );

    await user.click(screen.getByRole('button', { name: 'emerald' }));
    expect(onLaunchModesChange).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'm0', color: 'emerald' }),
    ]);
  });

  it('gives modes without a saved color the same default as the rest of the app', () => {
    renderLaunchModeInputs(modes(5));

    // The fifth mode wraps back to the first fallback color, as in the launch picker.
    expect(
      screen.getAllByRole('button', { name: /^Color: / }).map((b) => b.getAttribute('aria-label'))
    ).toEqual(['Color: blue', 'Color: purple', 'Color: amber', 'Color: emerald', 'Color: blue']);
  });

  it('names the remove button for each mode', async () => {
    const user = userEvent.setup();
    const onLaunchModesChange = renderLaunchModeInputs(modes(2));

    await user.click(screen.getAllByRole('button', { name: 'Remove mode' })[0]);
    expect(onLaunchModesChange).toHaveBeenCalledWith([expect.objectContaining({ id: 'm1' })]);
  });
});

describe('CommandInputs agent launch choice', () => {
  it('starts from whether the mode skips permission prompts', () => {
    renderLaunchModeInputs([
      { id: 'plan', name: 'Plan', arguments: '--permission-mode plan' },
      { id: 'yolo', name: 'YOLO', arguments: '--yolo' },
      { id: 'off', name: 'Off', arguments: '', agentLaunch: 'never' },
    ]);

    expect(
      screen
        .getAllByRole('button', { name: /^Agents can/ })
        .map((b) => b.getAttribute('aria-label'))
    ).toEqual([
      'Agents can start this mode anywhere',
      'Agents can start this mode only on an isolated SSH host',
      "Agents can't start this mode",
    ]);
  });

  it('saves where agents may start the mode', async () => {
    const user = userEvent.setup();
    const onLaunchModesChange = renderLaunchModeInputs([
      { id: 'yolo', name: 'YOLO', arguments: '--yolo' },
    ]);

    screen.getByRole('button', { name: /^Agents can/ }).focus();
    await user.keyboard('{Enter}');
    expect(
      await screen.findByRole('menuitemradio', {
        name: 'Only on an isolated SSH host',
      })
    ).toHaveAttribute('aria-checked', 'true');
    await user.click(screen.getByRole('menuitemradio', { name: 'Anywhere' }));
    expect(onLaunchModesChange).toHaveBeenCalledWith([
      { id: 'yolo', name: 'YOLO', arguments: '--yolo', agentLaunch: 'always' },
    ]);
  });

  it('shows the pinned agent launch default as always allowed', async () => {
    const user = userEvent.setup();
    const onLaunchModesChange = renderLaunchModeInputs(
      [{ id: 'yolo', name: 'YOLO', arguments: '--yolo' }],
      vi.fn(),
      'yolo'
    );

    const robot = screen.getByRole('button', {
      name: 'Agents can always start the agent launch default',
    });
    expect(robot).toHaveAttribute('aria-disabled', 'true');
    await user.click(robot);
    expect(screen.queryByRole('menuitemradio')).not.toBeInTheDocument();
    expect(onLaunchModesChange).not.toHaveBeenCalled();
  });
});
