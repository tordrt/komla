import { describe, expect, it } from 'vitest';

import {
  agentLaunchWorkspacePlacement,
  plannedWorkspaceEnvironment,
  resolveWorkspaceCreationEnvironment,
} from '../../../src/shared/lib/agent-environment';

describe('workspace creation environment', () => {
  const config = { sshHosts: [{ id: 'build-host' }] };

  it('starts locally until an environment has been picked', () => {
    expect(resolveWorkspaceCreationEnvironment(config)).toEqual({
      environment: { kind: 'local' },
    });
  });

  it('starts on the last-used SSH host', () => {
    expect(
      resolveWorkspaceCreationEnvironment({
        ...config,
        lastWorkspaceEnvironment: { kind: 'ssh', hostId: 'build-host' },
      })
    ).toEqual({ environment: { kind: 'ssh', hostId: 'build-host' } });
  });

  it('reports stale environment references without silently falling back', () => {
    expect(
      resolveWorkspaceCreationEnvironment({
        ...config,
        lastWorkspaceEnvironment: { kind: 'ssh', hostId: 'deleted-host' },
      })
    ).toMatchObject({ issue: 'missing-ssh-host' });
  });
});

describe('agent launch placement', () => {
  const pinned = { agentLaunchDefaultSshHostId: 'box' };
  const worktree = { mode: 'worktree' as const, sourceIsSsh: false };

  it('starts a worktree from this computer on the pinned SSH host once it is ready', () => {
    expect(agentLaunchWorkspacePlacement(pinned, worktree, () => true)).toEqual({
      environment: { kind: 'ssh', hostId: 'box' },
    });
  });

  it('leaves placement to the calling workspace everywhere else', () => {
    expect(agentLaunchWorkspacePlacement({}, worktree, () => true)).toEqual({});
    expect(agentLaunchWorkspacePlacement(pinned, worktree, () => false)).toEqual({});
    expect(
      agentLaunchWorkspacePlacement(pinned, { ...worktree, sourceIsSsh: true }, () => true)
    ).toEqual({});
    expect(
      agentLaunchWorkspacePlacement(pinned, { ...worktree, mode: 'directory' }, () => true)
    ).toEqual({});
  });
});

describe('planned workspace environment', () => {
  const lastPicked = { kind: 'ssh' as const, hostId: 'box' };

  it('reads the placement fields in the order workspace creation does', () => {
    expect(
      plannedWorkspaceEnvironment(
        {
          mode: 'worktree',
          environment: { kind: 'local' },
          location: { kind: 'ssh', hostId: 'other' },
        },
        lastPicked
      )
    ).toEqual({ kind: 'local' });
    expect(
      plannedWorkspaceEnvironment(
        { mode: 'worktree', location: { kind: 'ssh', hostId: 'other' } },
        lastPicked
      )
    ).toEqual({ kind: 'ssh', hostId: 'other' });
    expect(
      plannedWorkspaceEnvironment({ mode: 'worktree', location: { kind: 'local' } }, lastPicked)
    ).toEqual({ kind: 'local' });
  });

  it('falls back to where new workspaces start, keeping folders off SSH hosts', () => {
    expect(plannedWorkspaceEnvironment({ mode: 'worktree' }, lastPicked)).toEqual(lastPicked);
    expect(plannedWorkspaceEnvironment({ mode: 'directory' }, lastPicked)).toEqual({
      kind: 'local',
    });
  });
});
