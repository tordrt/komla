import { describe, expect, it } from 'vitest';

import {
  attentionWakesSnooze,
  canDeleteWorkspaceBranch,
  getBranchesInUse,
  isWorkspaceCreateError,
  resolveWorkspaceTargetBranch,
  toLocalBranchName,
} from '../../src/shared/types/workspace';

import type { WorkspaceAttention } from '../../src/shared/types/workspace';

describe('attentionWakesSnooze', () => {
  const attention = (kind: WorkspaceAttention['kind']): WorkspaceAttention => ({
    kind,
    source: 'codex',
    updatedAt: 1,
  });

  it('wakes any snooze for a prompt or an error', () => {
    for (const kind of ['input-required', 'error'] as const) {
      expect(attentionWakesSnooze({ snoozedUntil: 5 }, attention(kind))).toBe(true);
    }
    expect(attentionWakesSnooze({ snoozedUntil: 5 }, attention('turn-complete'))).toBe(false);
  });

  it('wakes a snooze until notified for any notification but an idle reminder', () => {
    const snooze = { snoozedUntil: 5, wakesOnNotification: true };
    for (const kind of ['turn-complete', 'generic', 'error'] as const) {
      expect(attentionWakesSnooze(snooze, attention(kind))).toBe(true);
    }
    expect(attentionWakesSnooze(snooze, attention('idle'))).toBe(false);
  });

  it('wakes a snooze until notified that has no time', () => {
    expect(attentionWakesSnooze({ wakesOnNotification: true }, attention('turn-complete'))).toBe(
      true
    );
  });

  it("does not wake for the end of the turn of the agent that snoozed it, but for others' news", () => {
    const snooze = { wakesOnNotification: true, snoozeOutlastsTurnOf: 'term-1' };
    const from = (terminalId: string, overrides: Partial<WorkspaceAttention> = {}) => ({
      ...attention('turn-complete'),
      terminalId,
      ...overrides,
    });

    expect(attentionWakesSnooze(snooze, from('term-1'))).toBe(false);
    expect(attentionWakesSnooze(snooze, from('term-2'))).toBe(true);
    // A command's report from that same Terminal, as `<command>; komla notify` gives, wakes it.
    expect(attentionWakesSnooze(snooze, from('term-1', { source: 'command' }))).toBe(true);
    expect(attentionWakesSnooze(snooze, from('term-1', { kind: 'error' }))).toBe(true);
  });

  it('leaves a workspace that is not snoozed alone', () => {
    expect(attentionWakesSnooze({}, attention('error'))).toBe(false);
  });
});

describe('isWorkspaceCreateError', () => {
  it('returns true for a WorkspaceCreateError', () => {
    expect(isWorkspaceCreateError({ __workspaceCreateError: true, message: 'oops' })).toBe(true);
  });

  it('returns false for a Workspace object', () => {
    const workspace = { id: 'ws-1', name: 'Test', terminals: [] };
    expect(isWorkspaceCreateError(workspace as never)).toBe(false);
  });
});

describe('resolveWorkspaceTargetBranch', () => {
  const sshWorkspace = {
    isWorktree: true,
    branchName: 'trunk',
    backend: { kind: 'ssh', baseBranch: 'trunk' },
  } as never;

  it('uses the concrete SSH backend target before status fallbacks', () => {
    expect(resolveWorkspaceTargetBranch(sshWorkspace, undefined, 'main')).toBe('trunk');
  });

  it('prevents deletion of the concrete SSH backend target', () => {
    expect(canDeleteWorkspaceBranch(sshWorkspace)).toBe(false);
  });
});

describe('toLocalBranchName', () => {
  it.each([
    ['origin/release', 'release'],
    ['refs/remotes/origin/release', 'release'],
    ['refs/heads/feature/x', 'feature/x'],
    [' develop ', 'develop'],
    ['upstream/x', 'upstream/x'],
  ])('reads %s as %s', (ref, name) => {
    expect(toLocalBranchName(ref)).toBe(name);
  });
});

describe('getBranchesInUse', () => {
  it("protects main, master, the project's branches and every branch a workspace relies on", () => {
    const inUse = getBranchesInUse(
      ['trunk'],
      [
        { branchName: 'feature', baseBranch: 'origin/release', branchedFrom: 'refs/heads/stack' },
        {
          branchName: 'remote-work',
          backend: {
            kind: 'ssh',
            hostId: 'host-1',
            remoteDirectory: '/repo',
            remoteRepoPath: '/repo.git',
            remoteProjectRoot: '/repo',
            gitUrl: 'git@example.com:repo.git',
            baseBranch: 'refs/remotes/origin/staging',
          },
        },
      ]
    );

    for (const name of ['main', 'master', 'trunk', 'feature', 'release', 'stack', 'staging']) {
      expect(inUse).toContain(name);
    }
    expect(inUse).toContain('remote-work');
    // The name as written, in case a local branch is really called that.
    expect(inUse).toContain('origin/release');
    expect(inUse).not.toContain('');
  });
});
