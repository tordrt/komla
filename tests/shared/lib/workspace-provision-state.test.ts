import { describe, expect, it } from 'vitest';

import {
  canPromptForProjectIcon,
  encodeWorkspaceProvision,
  hasWorkspaceFiles,
  isMissingFromHost,
  isProvisioning,
  nextWorkspaceProvisionState,
  provisioningFailed,
  workspaceProvisionFailure,
  workspaceProvisionFieldsAfter,
  workspaceProvisionState,
  type WorkspaceProvisionChange,
  type WorkspaceProvisionFields,
  type WorkspaceProvisionState,
} from '../../../src/shared/lib/workspace-provision-state';

const MISSING = 'This workspace’s files are no longer on its SSH host.';
const NO_HOST = 'This workspace’s SSH host is no longer configured.';

const STATES: WorkspaceProvisionState[] = [
  { kind: 'provisioning', status: undefined },
  { kind: 'provisioning', status: 'Creating worktree' },
  { kind: 'ready' },
  { kind: 'failed', error: 'Branch already exists' },
  { kind: 'missing-from-host', error: MISSING },
  { kind: 'host-not-configured', error: NO_HOST },
];

describe('workspaceProvisionState', () => {
  it('reads a workspace that never stored anything as ready', () => {
    expect(workspaceProvisionState({})).toEqual({ kind: 'ready' });
    expect(workspaceProvisionState({ provisioning: false })).toEqual({ kind: 'ready' });
  });

  it('reads the stored fields of each state', () => {
    expect(
      workspaceProvisionState({ provisioning: true, provisionStatus: 'Creating worktree' })
    ).toEqual({ kind: 'provisioning', status: 'Creating worktree' });
    expect(workspaceProvisionState({ provisionError: 'Branch already exists' })).toEqual({
      kind: 'failed',
      error: 'Branch already exists',
    });
    expect(
      workspaceProvisionState({
        provisionError: MISSING,
        provisionErrorReason: 'missing-from-host',
      })
    ).toEqual({ kind: 'missing-from-host', error: MISSING });
    expect(
      workspaceProvisionState({
        provisionError: NO_HOST,
        provisionErrorReason: 'host-not-configured',
      })
    ).toEqual({ kind: 'host-not-configured', error: NO_HOST });
  });

  it('reads an attempt under way over an error left on the workspace', () => {
    expect(
      workspaceProvisionState({
        provisioning: true,
        provisionError: MISSING,
        provisionErrorReason: 'missing-from-host',
      })
    ).toEqual({ kind: 'provisioning', status: undefined });
  });

  it('ignores a reason without an error', () => {
    expect(workspaceProvisionState({ provisionErrorReason: 'missing-from-host' })).toEqual({
      kind: 'ready',
    });
  });

  it.each(STATES)('reads back what it stored for $kind', (state) => {
    expect(workspaceProvisionState(encodeWorkspaceProvision(state))).toEqual(state);
  });

  it.each(STATES)('clears every field another state stored when it stores $kind', (state) => {
    for (const previous of STATES) {
      const workspace = { ...encodeWorkspaceProvision(previous) };
      Object.assign(workspace, encodeWorkspaceProvision(state));
      expect(workspaceProvisionState(workspace)).toEqual(state);
    }
  });
});

describe('questions', () => {
  const answers = (state: WorkspaceProvisionState) => {
    const workspace = encodeWorkspaceProvision(state);
    return {
      provisioning: isProvisioning(workspace),
      files: hasWorkspaceFiles(workspace),
      failure: workspaceProvisionFailure(workspace)?.kind,
      missing: isMissingFromHost(workspace),
    };
  };

  it('answers for each state', () => {
    expect(answers({ kind: 'provisioning' })).toEqual({
      provisioning: true,
      files: false,
      failure: undefined,
      missing: false,
    });
    expect(answers({ kind: 'ready' })).toEqual({
      provisioning: false,
      files: true,
      failure: undefined,
      missing: false,
    });
    expect(answers({ kind: 'failed', error: 'nope' })).toEqual({
      provisioning: false,
      files: false,
      failure: 'failed',
      missing: false,
    });
    expect(answers({ kind: 'missing-from-host', error: MISSING })).toEqual({
      provisioning: false,
      files: false,
      failure: 'missing-from-host',
      missing: true,
    });
    expect(answers({ kind: 'host-not-configured', error: NO_HOST })).toEqual({
      provisioning: false,
      files: false,
      failure: 'host-not-configured',
      missing: false,
    });
  });

  it('answers for no workspace', () => {
    expect(isProvisioning(undefined)).toBe(false);
    expect(isProvisioning(null)).toBe(false);
    expect(workspaceProvisionFailure(undefined)).toBeUndefined();
    expect(isMissingFromHost(null)).toBe(false);
  });

  it('carries the message with a failure', () => {
    expect(workspaceProvisionFailure({ provisionError: 'Branch already exists' })).toEqual({
      kind: 'failed',
      error: 'Branch already exists',
    });
  });

  it('lets a workspace ask for its project’s icon only once its files are ready', () => {
    const project = { iconPromptWorkspaceId: 'ws-1' };
    expect(canPromptForProjectIcon(project, { id: 'ws-1' })).toBe(true);
    expect(canPromptForProjectIcon(project, { id: 'ws-2' })).toBe(false);
    expect(canPromptForProjectIcon(project, { id: 'ws-1', provisioning: true })).toBe(false);
    expect(canPromptForProjectIcon(project, { id: 'ws-1', provisionError: 'nope' })).toBe(false);
  });
});

describe('nextWorkspaceProvisionState', () => {
  const provisioning: WorkspaceProvisionState = { kind: 'provisioning', status: 'Creating' };
  const ready: WorkspaceProvisionState = { kind: 'ready' };
  const failed: WorkspaceProvisionState = { kind: 'failed', error: 'nope' };
  const missing: WorkspaceProvisionState = { kind: 'missing-from-host', error: MISSING };
  const noHost: WorkspaceProvisionState = { kind: 'host-not-configured', error: NO_HOST };

  const cases: Array<[WorkspaceProvisionState, WorkspaceProvisionChange, WorkspaceProvisionState]> =
    [
      [ready, { kind: 'started', status: 'Naming' }, { kind: 'provisioning', status: 'Naming' }],
      [failed, { kind: 'started' }, { kind: 'provisioning', status: undefined }],
      [
        provisioning,
        { kind: 'progressed', status: 'Next' },
        { kind: 'provisioning', status: 'Next' },
      ],
      [provisioning, { kind: 'completed' }, ready],
      [failed, { kind: 'completed' }, ready],
      [provisioning, { kind: 'failed', error: 'nope' }, failed],
      [ready, { kind: 'failed', error: 'nope' }, failed],
      [failed, { kind: 'failed', error: 'worse' }, { kind: 'failed', error: 'worse' }],
      [missing, { kind: 'failed', error: 'nope' }, failed],
      [ready, { kind: 'went-missing-from-host' }, missing],
      [failed, { kind: 'went-missing-from-host' }, missing],
      [noHost, { kind: 'went-missing-from-host' }, missing],
      [missing, { kind: 'found-on-host' }, ready],
      [ready, { kind: 'host-not-configured' }, noHost],
      [failed, { kind: 'host-not-configured' }, noHost],
      [missing, { kind: 'host-not-configured' }, noHost],
    ];

  it.each(cases)('moves %j on %j to %j', (state, change, next) => {
    expect(nextWorkspaceProvisionState(state, change)).toEqual(next);
  });

  const ignored: Array<[WorkspaceProvisionState, WorkspaceProvisionChange]> = [
    // Progress reported after the attempt ended, such as after a cancel.
    [ready, { kind: 'progressed', status: 'Late' }],
    [failed, { kind: 'progressed', status: 'Late' }],
    [missing, { kind: 'progressed', status: 'Late' }],
    // Only files that were missing are found again: a failed creation stays failed.
    [ready, { kind: 'found-on-host' }],
    [failed, { kind: 'found-on-host' }],
    [noHost, { kind: 'found-on-host' }],
    [provisioning, { kind: 'found-on-host' }],
    // The attempt under way settles what a host says meanwhile.
    [provisioning, { kind: 'went-missing-from-host' }],
    [provisioning, { kind: 'host-not-configured' }],
  ];

  it.each(ignored)('leaves %j alone on %j', (state, change) => {
    expect(nextWorkspaceProvisionState(state, change)).toBe(state);
  });
});

describe('workspaceProvisionFieldsAfter', () => {
  it('returns every stored field for a change that applies', () => {
    const workspace: WorkspaceProvisionFields = {
      provisioning: true,
      provisionStatus: 'Creating worktree',
    };
    expect(workspaceProvisionFieldsAfter(workspace, { kind: 'failed', error: 'nope' })).toEqual({
      provisioning: false,
      provisionStatus: undefined,
      provisionError: 'nope',
      provisionErrorReason: undefined,
    });
  });

  it('returns nothing for a change that does not apply', () => {
    expect(
      workspaceProvisionFieldsAfter({ provisionError: 'nope' }, { kind: 'found-on-host' })
    ).toBeUndefined();
    expect(
      workspaceProvisionFieldsAfter({}, { kind: 'progressed', status: 'Late' })
    ).toBeUndefined();
    expect(workspaceProvisionFieldsAfter({}, { kind: 'completed' })).toBeUndefined();
  });

  it('marks a workspace missing and found again without leaving a trace', () => {
    const workspace: WorkspaceProvisionFields = {};
    Object.assign(
      workspace,
      workspaceProvisionFieldsAfter(workspace, { kind: 'went-missing-from-host' })
    );
    expect(workspaceProvisionFailure(workspace)).toEqual({
      kind: 'missing-from-host',
      error: MISSING,
    });
    Object.assign(workspace, workspaceProvisionFieldsAfter(workspace, { kind: 'found-on-host' }));
    expect(hasWorkspaceFiles(workspace)).toBe(true);
    expect(workspace.provisionError).toBeUndefined();
    expect(workspace.provisionErrorReason).toBeUndefined();
  });
});

describe('provisioningFailed', () => {
  it('takes the message of an error', () => {
    expect(provisioningFailed(new Error('Branch already exists'))).toEqual({
      kind: 'failed',
      error: 'Branch already exists',
    });
  });

  it('falls back for anything else thrown', () => {
    expect(provisioningFailed('boom')).toEqual({ kind: 'failed', error: 'Workspace setup failed' });
  });
});
