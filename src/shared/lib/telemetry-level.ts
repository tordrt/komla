/**
 * How much telemetry the app sends. `anonymous` is the install ping and daily
 * heartbeat with no install ID; `usage` adds the opt-in usage analytics tied to
 * a random install ID. Crash reports have their own switch.
 */
export type TelemetryLevel = 'off' | 'anonymous' | 'usage';

interface TelemetryConfig {
  anonymousTelemetryEnabled?: boolean;
  usageTelemetryEnabled?: boolean;
}

export function getTelemetryLevel(config: TelemetryConfig | null | undefined): TelemetryLevel {
  if (config?.usageTelemetryEnabled === true) return 'usage';
  return config?.anonymousTelemetryEnabled === false ? 'off' : 'anonymous';
}

/** The config fields that select `level`. */
export function telemetryLevelUpdates(level: TelemetryLevel): Required<TelemetryConfig> {
  return {
    anonymousTelemetryEnabled: level !== 'off',
    usageTelemetryEnabled: level === 'usage',
  };
}
