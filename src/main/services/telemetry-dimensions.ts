import { BUILTIN_PRESETS } from './agent-preset.service';

import type { AgentPreset } from '../../shared/types/agent-preset';

/**
 * The preset's name when it is a built-in one's; any other name, which the user
 * chose, is only ever sent as `Custom`. Stored presets never carry `isBuiltin`,
 * not even the stock ones, so the name is what tells them apart.
 */
export function telemetryAgentName(preset: Pick<AgentPreset, 'name'> | undefined): string {
  if (!preset) return 'unknown';
  return BUILTIN_PRESETS.some((builtin) => builtin.name === preset.name) ? preset.name : 'Custom';
}
