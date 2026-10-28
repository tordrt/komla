import { describe, expect, it } from 'vitest';

import type { RemoteLaunchEnvironmentSummary } from '@komla/remote-protocol';

import {
  defaultEnvironmentValue,
  environmentValue,
  parseEnvironmentValue,
} from '../launch-environment';

const local: RemoteLaunchEnvironmentSummary = { kind: 'local', name: 'This computer' };
const host: RemoteLaunchEnvironmentSummary = { kind: 'ssh', id: 'h1', name: 'devbox' };

describe('launch environment', () => {
  it('starts new workspaces on an SSH host, then this computer', () => {
    expect(defaultEnvironmentValue([local, host], undefined)).toBe('ssh:h1');
    expect(defaultEnvironmentValue([local], undefined)).toBe('local');
    expect(defaultEnvironmentValue([], undefined)).toBe('');
  });

  it('keeps the last choice made on the phone while the desktop still offers it', () => {
    expect(defaultEnvironmentValue([local, host], 'local')).toBe('local');
    expect(defaultEnvironmentValue([local], 'ssh:gone')).toBe('local');
  });

  it('round-trips select values to the environment sent to the desktop', () => {
    expect(parseEnvironmentValue(environmentValue(local))).toEqual({ kind: 'local' });
    expect(parseEnvironmentValue(environmentValue(host))).toEqual({ kind: 'ssh', hostId: 'h1' });
    expect(parseEnvironmentValue('')).toBeUndefined();
    expect(parseEnvironmentValue('ssh:')).toBeUndefined();
    expect(parseEnvironmentValue('sandbox:lima')).toBeUndefined();
  });
});
