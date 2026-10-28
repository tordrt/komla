/**
 * @vitest-environment jsdom
 */
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AgentPresetIcon } from '../../../src/renderer/components/terminal/AgentPresetIcon';

describe('AgentPresetIcon', () => {
  it('recognizes Claude Code and Codex from their executable', () => {
    const { container, rerender } = render(
      <AgentPresetIcon preset={{ name: 'Renamed agent', openCommand: '/usr/local/bin/claude' }} />
    );
    expect(container.querySelector('[data-agent-preset-icon="claude"]')).toBeInTheDocument();

    rerender(<AgentPresetIcon preset={{ name: 'Renamed agent', openCommand: 'codex.exe' }} />);
    expect(container.querySelector('[data-agent-preset-icon="codex"]')).toBeInTheDocument();
  });

  it.each([
    ['C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd', 'claude'],
    ['"C:\\Program Files\\Codex\\codex.ps1" --verbose', 'codex'],
  ])('recognizes the Windows launcher %s', (openCommand, icon) => {
    const { container } = render(
      <AgentPresetIcon preset={{ name: 'Renamed agent', openCommand }} />
    );

    expect(container.querySelector(`[data-agent-preset-icon="${icon}"]`)).toBeInTheDocument();
  });

  it.each([
    ['agy', 'antigravity'],
    ['antigravity', 'antigravity'],
    ['gemini', 'gemini'],
    ['opencode', 'opencode'],
    ['copilot', 'copilot'],
    ['cursor-agent', 'cursor'],
    ['grok', 'grok'],
    ['hermes', 'hermes'],
    ['droid', 'factory'],
    ['amp', 'amp'],
    ['goose', 'goose'],
    ['auggie', 'augment'],
    ['devin', 'devin'],
    ['kiro-cli', 'kiro'],
    ['pi', 'pi'],
    ['qwen', 'qwen'],
    ['vibe', 'mistral'],
  ])('recognizes the %s executable', (executable, icon) => {
    const { container } = render(
      <AgentPresetIcon preset={{ name: 'Renamed agent', openCommand: executable }} />
    );

    expect(container.querySelector(`[data-agent-preset-icon="${icon}"]`)).toBeInTheDocument();
  });

  it('uses the preset name when the command is customized', () => {
    const { container } = render(
      <AgentPresetIcon preset={{ name: 'Claude Code', openCommand: 'mise exec claude' }} />
    );

    expect(container.querySelector('[data-agent-preset-icon="claude"]')).toBeInTheDocument();
  });

  it('uses the preset name when legacy data has no open command', () => {
    const { container } = render(<AgentPresetIcon preset={{ name: 'Codex' }} />);

    expect(container.querySelector('[data-agent-preset-icon="codex"]')).toBeInTheDocument();
  });

  it.each([
    ['Antigravity CLI', 'antigravity'],
    ['Gemini CLI', 'gemini'],
    ['OpenCode', 'opencode'],
    ['GitHub Copilot CLI', 'copilot'],
    ['Cursor CLI', 'cursor'],
    ['Grok Build', 'grok'],
    ['Hermes Agent', 'hermes'],
    ['Factory Droid', 'factory'],
    ['Amp', 'amp'],
    ['Goose', 'goose'],
    ['Auggie', 'augment'],
    ['Devin', 'devin'],
    ['Kiro CLI', 'kiro'],
    ['Pi', 'pi'],
    ['Qwen Code', 'qwen'],
    ['Mistral Vibe', 'mistral'],
  ])('recognizes the %s preset name', (name, icon) => {
    const { container } = render(
      <AgentPresetIcon preset={{ name, openCommand: 'custom-wrapper' }} />
    );

    expect(container.querySelector(`[data-agent-preset-icon="${icon}"]`)).toBeInTheDocument();
  });

  // Grok Build's installer also links `agent`, so it doesn't name Cursor.
  it('leaves a bare agent executable to the preset name', () => {
    const { container, rerender } = render(
      <AgentPresetIcon preset={{ name: 'Grok Build', openCommand: 'agent' }} />
    );
    expect(container.querySelector('[data-agent-preset-icon="grok"]')).toBeInTheDocument();

    rerender(<AgentPresetIcon preset={{ name: 'Cursor CLI', openCommand: 'agent' }} />);
    expect(container.querySelector('[data-agent-preset-icon="cursor"]')).toBeInTheDocument();
  });

  it('keeps the robot fallback for other presets', () => {
    const { container } = render(
      <AgentPresetIcon preset={{ name: 'Custom Agent', openCommand: 'custom-agent' }} />
    );

    expect(container.querySelector('[data-agent-preset-icon="fallback"]')).toBeInTheDocument();
  });

  // A menu mutes icons without a text color, which would turn a launch-mode pill's mark grey.
  it('gives single-colour marks the surrounding text color and keeps brand colors', () => {
    const { container, rerender } = render(
      <AgentPresetIcon preset={{ name: 'OpenCode', openCommand: 'opencode' }} />
    );
    expect(container.querySelector('svg')).toHaveClass('text-current');

    rerender(<AgentPresetIcon preset={{ name: 'Custom Agent', openCommand: 'custom-agent' }} />);
    expect(container.querySelector('svg')).toHaveClass('text-current');

    rerender(<AgentPresetIcon preset={{ name: 'Claude Code', openCommand: 'claude' }} />);
    expect(container.querySelector('svg')).not.toHaveClass('text-current');
  });

  it.each([
    ['agy', 'antigravity'],
    ['codex', 'codex'],
    ['devin', 'devin'],
    ['gemini', 'gemini'],
    ['kiro-cli', 'kiro'],
    ['qwen', 'qwen'],
    ['vibe', 'mistral'],
  ])('draws the %s mark in its brand colors', (executable, icon) => {
    const { container } = render(
      <AgentPresetIcon
        preset={{ name: 'Renamed agent', openCommand: executable }}
        className="size-4"
      />
    );

    const mark = container.querySelector(`[data-agent-preset-icon="${icon}"]`);
    expect(mark?.tagName).toBe('IMG');
    expect(mark).toHaveAttribute('src', expect.stringMatching(/\S/));
    expect(mark).toHaveAttribute('alt', '');
    expect(mark).toHaveClass('size-4');
  });

  it.each(['constructor', 'toString', '__proto__'])(
    'keeps the robot fallback for the object key %s',
    (key) => {
      const { container } = render(<AgentPresetIcon preset={{ name: key, openCommand: key }} />);

      expect(container.querySelector('[data-agent-preset-icon="fallback"]')).toBeInTheDocument();
    }
  );
});
