import { describe, expect, it } from 'vitest';

import { lastUsedIntegrationTarget } from '../../../src/renderer/lib/integration-target';

const sshBackend = (hostId: string) => ({
  kind: 'ssh' as const,
  hostId,
  remoteDirectory: '/r',
  remoteRepoPath: '/r',
  remoteProjectRoot: '/r',
  gitUrl: 'git@example.com:repo.git',
});

describe('lastUsedIntegrationTarget', () => {
  it('opens on where the most recently created workspace runs', () => {
    expect(lastUsedIntegrationTarget([])).toBe('local');
    expect(
      lastUsedIntegrationTarget([
        { createdAt: 3, backend: sshBackend('devbox') },
        { createdAt: 1, backend: { kind: 'local' } },
      ])
    ).toBe('ssh:devbox');
    expect(
      lastUsedIntegrationTarget([
        { createdAt: 1, backend: sshBackend('devbox') },
        { createdAt: 2, backend: { kind: 'local' } },
      ])
    ).toBe('local');
    expect(lastUsedIntegrationTarget([{ createdAt: 5, backend: { kind: 'local' } }])).toBe('local');
  });
});
