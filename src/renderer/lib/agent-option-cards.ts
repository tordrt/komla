import { levelPickerOf, modelPickerOf } from '../../shared/lib/level-picker';

import type { AgentPreset } from '@/types';

/** The element ids of an agent's launch mode, models and effort sections in Settings → Agents, to scroll to. */
export type AgentOption = keyof typeof AGENT_OPTION_CARD_IDS;

export const AGENT_OPTION_CARD_IDS = {
  launchModes: 'agent-launch-modes',
  models: 'agent-models',
  effort: 'agent-effort',
} as const;

/** The pickers an agent can add from the new workspace dialog. */
export type AddableAgentOption = Exclude<AgentOption, 'launchModes'>;

/**
 * The model and effort pickers an agent that starts a command doesn't have yet, effort first as the
 * composer's pills are ordered. A picker the user hid counts as there.
 */
export function missingPickersOf(
  preset: Pick<
    AgentPreset,
    'openCommand' | 'models' | 'modelPicker' | 'reasoningLevels' | 'levelPicker'
  >
): AddableAgentOption[] {
  if (!preset.openCommand.trim()) return [];
  return (['effort', 'models'] as const).filter((option) =>
    option === 'models'
      ? !preset.models?.length && !modelPickerOf(preset).hidden
      : !preset.reasoningLevels?.length && !levelPickerOf(preset).hidden
  );
}
