import type { Project } from '../types/project';
import type { Workspace } from '../types/workspace';

/**
 * Workspace Provision State: whether a workspace's files are being created, are ready to
 * read, or can't be used, and why.
 *
 * This is the only module that reads a Workspace's `provisioning`, `provisionStatus`,
 * `provisionError` and `provisionErrorReason` fields. Callers ask the questions below, and
 * main's writers set the fields through `workspaceProvisionFieldsAfter`.
 */

export type WorkspaceProvisionFields = Pick<
  Workspace,
  'provisioning' | 'provisionStatus' | 'provisionError' | 'provisionErrorReason'
>;

/** A workspace whose files can't be used, and the message that says why. */
export type WorkspaceProvisionFailure =
  /** Creating its files failed, or was interrupted and couldn't be cleaned up. */
  | { kind: 'failed'; error: string }
  /** Workspace missing from its host: its files are gone without a deleting installation's tombstone. */
  | { kind: 'missing-from-host'; error: string }
  /** Its SSH host is no longer in this installation's settings. */
  | { kind: 'host-not-configured'; error: string };

export type WorkspaceProvisionState =
  /** Its files are being created: a worktree, or a directory on its SSH host. */
  | { kind: 'provisioning'; status?: string }
  /** Its files are ready to read, on this computer or on its SSH host. */
  | { kind: 'ready' }
  | WorkspaceProvisionFailure;

const MISSING_FROM_HOST_ERROR = 'This workspace’s files are no longer on its SSH host.';
const HOST_NOT_CONFIGURED_ERROR = 'This workspace’s SSH host is no longer configured.';

const READY: WorkspaceProvisionState = { kind: 'ready' };

export function workspaceProvisionState(
  workspace: WorkspaceProvisionFields
): WorkspaceProvisionState {
  // An attempt under way outranks an error left on the workspace: it ends by replacing it.
  if (workspace.provisioning) {
    return { kind: 'provisioning', status: workspace.provisionStatus };
  }
  if (!workspace.provisionError) return READY;
  return { kind: workspace.provisionErrorReason ?? 'failed', error: workspace.provisionError };
}

// --- Questions ---

/** Its files are being created. */
export function isProvisioning(workspace: WorkspaceProvisionFields | null | undefined): boolean {
  return !!workspace && workspaceProvisionState(workspace).kind === 'provisioning';
}

/** A workspace whose files are ready to read, on this computer or on its SSH host. */
export function hasWorkspaceFiles(workspace: WorkspaceProvisionFields): boolean {
  return workspaceProvisionState(workspace).kind === 'ready';
}

/** Why its files can't be used, unless they are ready or still being created. */
export function workspaceProvisionFailure(
  workspace: WorkspaceProvisionFields | null | undefined
): WorkspaceProvisionFailure | undefined {
  if (!workspace) return undefined;
  const state = workspaceProvisionState(workspace);
  return state.kind === 'provisioning' || state.kind === 'ready' ? undefined : state;
}

/** Workspace missing from its host: Komla keeps it, but does not reconnect or restart it. */
export function isMissingFromHost(workspace: WorkspaceProvisionFields | null | undefined): boolean {
  return workspaceProvisionFailure(workspace)?.kind === 'missing-from-host';
}

/** The workspace that asks for its project's icon, once its files are ready to read. */
export function canPromptForProjectIcon(
  project: Pick<Project, 'iconPromptWorkspaceId'>,
  workspace: Pick<Workspace, 'id'> & WorkspaceProvisionFields
): boolean {
  return project.iconPromptWorkspaceId === workspace.id && hasWorkspaceFiles(workspace);
}

// --- Writing (main only) ---

export type WorkspaceProvisionChange =
  /** Creating its files began. */
  | { kind: 'started'; status?: string }
  /** The attempt under way reached another step. */
  | { kind: 'progressed'; status: string }
  /** Its files are ready. */
  | { kind: 'completed' }
  /** Creating its files failed, or its cleanup did, which replaces the message. */
  | { kind: 'failed'; error: string }
  /** A sync found its files gone from its SSH host. */
  | { kind: 'went-missing-from-host' }
  /** A sync found the files of a workspace missing from its host there again. */
  | { kind: 'found-on-host' }
  /** Its SSH host is no longer in this installation's settings. */
  | { kind: 'host-not-configured' };

/** The change for an attempt that threw. */
export function provisioningFailed(error: unknown): WorkspaceProvisionChange {
  return {
    kind: 'failed',
    error: error instanceof Error ? error.message : 'Workspace setup failed',
  };
}

/**
 * The state a change leads to, or the same state when the change doesn't apply to it:
 * progress without an attempt under way, files found that were never missing, or a host's
 * report about a workspace whose files are still being created, which that attempt settles.
 */
export function nextWorkspaceProvisionState(
  state: WorkspaceProvisionState,
  change: WorkspaceProvisionChange
): WorkspaceProvisionState {
  switch (change.kind) {
    case 'started':
      return { kind: 'provisioning', status: change.status };
    case 'progressed':
      return state.kind === 'provisioning'
        ? { kind: 'provisioning', status: change.status }
        : state;
    case 'completed':
      return READY;
    case 'failed':
      return { kind: 'failed', error: change.error };
    case 'went-missing-from-host':
      return state.kind === 'provisioning'
        ? state
        : { kind: 'missing-from-host', error: MISSING_FROM_HOST_ERROR };
    case 'found-on-host':
      return state.kind === 'missing-from-host' ? READY : state;
    case 'host-not-configured':
      return state.kind === 'provisioning'
        ? state
        : { kind: 'host-not-configured', error: HOST_NOT_CONFIGURED_ERROR };
  }
}

/** The fields to assign for a state. Assign all of them: undefined values clear a field. */
export function encodeWorkspaceProvision(state: WorkspaceProvisionState): WorkspaceProvisionFields {
  switch (state.kind) {
    case 'provisioning':
      return {
        provisioning: true,
        provisionStatus: state.status,
        provisionError: undefined,
        provisionErrorReason: undefined,
      };
    case 'ready':
      return {
        provisioning: false,
        provisionStatus: undefined,
        provisionError: undefined,
        provisionErrorReason: undefined,
      };
    case 'failed':
      return {
        provisioning: false,
        provisionStatus: undefined,
        provisionError: state.error,
        provisionErrorReason: undefined,
      };
    case 'missing-from-host':
    case 'host-not-configured':
      return {
        provisioning: false,
        provisionStatus: undefined,
        provisionError: state.error,
        provisionErrorReason: state.kind,
      };
  }
}

/**
 * What workspaces.json keeps: only an attempt under way, which the next launch cleans up as
 * interrupted. A failure isn't saved.
 */
export function persistedWorkspaceProvision(
  workspace: WorkspaceProvisionFields
): Pick<WorkspaceProvisionFields, 'provisioning' | 'provisionStatus'> {
  const state = workspaceProvisionState(workspace);
  return state.kind === 'provisioning'
    ? { provisioning: true, provisionStatus: state.status }
    : { provisioning: undefined, provisionStatus: undefined };
}

/**
 * The fields to assign to a workspace for a change, or undefined when the change doesn't
 * apply to the state it is in.
 */
export function workspaceProvisionFieldsAfter(
  workspace: WorkspaceProvisionFields,
  change: WorkspaceProvisionChange
): WorkspaceProvisionFields | undefined {
  const state = workspaceProvisionState(workspace);
  const next = nextWorkspaceProvisionState(state, change);
  return next === state ? undefined : encodeWorkspaceProvision(next);
}
