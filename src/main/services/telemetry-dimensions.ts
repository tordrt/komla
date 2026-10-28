import { BUILTIN_PRESETS } from './agent-preset.service';
import { licenseService } from './license.service';

import type { AgentPreset } from '../../shared/types/agent-preset';

export interface TelemetryCohortDimensions {
  licenseCohort: 'free' | 'paid_monthly' | 'paid_yearly' | 'paid_lifetime';
  licenseType?: 'monthly' | 'yearly' | 'lifetime';
}

export function getTelemetryCohortDimensions(): TelemetryCohortDimensions {
  const status = licenseService.getStatus();
  if (!status.isLicensed || !status.licenseType) return { licenseCohort: 'free' };
  return { licenseCohort: `paid_${status.licenseType}`, licenseType: status.licenseType };
}

/**
 * The preset's name when it is a built-in one's; any other name, which the user
 * chose, is only ever sent as `Custom`. Stored presets never carry `isBuiltin`,
 * not even the stock ones, so the name is what tells them apart.
 */
export function telemetryAgentName(preset: Pick<AgentPreset, 'name'> | undefined): string {
  if (!preset) return 'unknown';
  return BUILTIN_PRESETS.some((builtin) => builtin.name === preset.name) ? preset.name : 'Custom';
}
