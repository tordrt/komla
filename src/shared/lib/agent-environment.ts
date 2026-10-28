/** Sentinel launch-mode ID for launching a preset without a selected mode. */
export const DEFAULT_LAUNCH_MODE_ID = '__default__';

export type DesiredWorkspaceEnvironment = { kind: 'local' } | { kind: 'ssh'; hostId: string };

export interface EnvironmentDecision {
  environment: DesiredWorkspaceEnvironment;
  issue?: 'missing-ssh-host';
}

interface WorkspaceEnvironmentConfig {
  lastWorkspaceEnvironment?: DesiredWorkspaceEnvironment;
  sshHosts?: Array<{ id: string }>;
}

interface AgentLaunchDefaultsConfig {
  agentLaunchDefaultSshHostId?: string;
}

/**
 * Placement for a workspace an agent launches. The SSH host pin applies only to
 * worktree launches from a non-SSH source onto a ready host; otherwise the
 * source workspace's SSH location decides.
 */
export function agentLaunchWorkspacePlacement(
  config: AgentLaunchDefaultsConfig,
  target: { mode: 'worktree' | 'directory'; sourceIsSsh: boolean },
  isSshHostReady: (hostId: string) => boolean
): { environment?: { kind: 'ssh'; hostId: string } } {
  const hostId = config.agentLaunchDefaultSshHostId;
  if (hostId && target.mode === 'worktree' && !target.sourceIsSsh && isSshHostReady(hostId)) {
    return { environment: { kind: 'ssh', hostId } };
  }
  return {};
}

interface WorkspacePlacementParams {
  mode: 'worktree' | 'directory';
  environment?: DesiredWorkspaceEnvironment;
  location?: { kind: 'local' } | { kind: 'ssh'; hostId: string };
}

/**
 * The environment a new workspace's placement fields name, or none. Workspace creation
 * and the agent launch gate both read placement through this.
 */
export function requestedWorkspaceEnvironment(
  params: WorkspacePlacementParams
): DesiredWorkspaceEnvironment | undefined {
  if (params.environment) return params.environment;
  if (params.location?.kind === 'ssh') return { kind: 'ssh', hostId: params.location.hostId };
  if (params.location?.kind === 'local') return { kind: 'local' };
  return undefined;
}

/**
 * Where workspace creation puts a workspace with these placement fields. `fallback` is
 * where new workspaces start when they name none; SSH hosts only run worktrees, so a
 * folder then starts locally.
 */
export function plannedWorkspaceEnvironment(
  params: WorkspacePlacementParams,
  fallback: DesiredWorkspaceEnvironment
): DesiredWorkspaceEnvironment {
  return (
    requestedWorkspaceEnvironment(params) ??
    (params.mode === 'directory' && fallback.kind === 'ssh' ? { kind: 'local' } : fallback)
  );
}

/**
 * Resolve where a new workspace starts: the environment last picked in the new
 * workspace dialog, or local. Main performs contextual SSH validation.
 */
export function resolveWorkspaceCreationEnvironment(
  config: WorkspaceEnvironmentConfig
): EnvironmentDecision {
  const requested = config.lastWorkspaceEnvironment ?? { kind: 'local' as const };

  if (
    requested.kind === 'ssh' &&
    config.sshHosts &&
    !config.sshHosts.some((host) => host.id === requested.hostId)
  ) {
    return { environment: requested, issue: 'missing-ssh-host' };
  }

  return { environment: requested };
}
