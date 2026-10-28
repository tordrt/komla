import { describe, expect, it } from 'vitest';

import { resolveSshWorkspaceMode } from '../../src/shared/lib/ssh-workspace-mode';

describe('resolveSshWorkspaceMode', () => {
  it('defaults to remote', () => {
    expect(resolveSshWorkspaceMode(undefined, undefined)).toBe('remote');
  });

  it('uses the global mode when the project inherits', () => {
    expect(resolveSshWorkspaceMode('local-mirror-actions', undefined)).toBe(
      'local-mirror-actions'
    );
  });

  it('lets the project override the global mode', () => {
    expect(resolveSshWorkspaceMode('local-mirror-actions', 'remote')).toBe('remote');
  });
});
