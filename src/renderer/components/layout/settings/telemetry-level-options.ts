import type { TelemetryLevel } from '../../../../shared/lib/telemetry-level';

/** Telemetry levels, least first, as Settings lists them. */
export const TELEMETRY_LEVEL_OPTIONS: ReadonlyArray<{
  value: TelemetryLevel;
  label: string;
  description: string;
}> = [
  {
    value: 'off',
    label: 'Off',
    description: 'No usage data at all.',
  },
  {
    value: 'anonymous',
    label: 'Anonymous counts',
    description: 'A daily ping with the app version, OS, agent and license tier. No install ID.',
  },
  {
    value: 'usage',
    label: 'Usage analytics',
    description:
      'Also feature usage counts tied to a random install ID. Never code, prompts, file paths or project names.',
  },
];
