import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/main/services/agent-preset.service', () => ({
  BUILTIN_PRESETS: [{ name: 'Claude Code' }],
}));

const { telemetryAgentName } = await import('../../../src/main/services/telemetry-dimensions');

describe('telemetryAgentName', () => {
  it('names a built-in preset', () => {
    expect(telemetryAgentName({ name: 'Claude Code' })).toBe('Claude Code');
  });

  it('sends any other preset as Custom, never by its name', () => {
    expect(telemetryAgentName({ name: 'acme-internal-bot' })).toBe('Custom');
  });

  it('reports a missing preset as unknown', () => {
    expect(telemetryAgentName(undefined)).toBe('unknown');
  });
});
