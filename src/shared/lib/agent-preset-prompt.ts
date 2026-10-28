import type { AgentPreset } from '../types/agent-preset';

/**
 * Whether an agent can start with a prompt: it has a prompt command. Agents without
 * one, such as Kimi Code and Crush, open without the prompt.
 */
export function canStartWithPrompt(preset: Pick<AgentPreset, 'promptCommand'>): boolean {
  return Boolean(preset.promptCommand?.trim());
}
