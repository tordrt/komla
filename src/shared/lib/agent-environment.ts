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

export type AgentLaunchPlacement =
  | { environment?: DesiredWorkspaceEnvironment }
  /** The pinned host isn't set up yet; the launch must not start anywhere else. */
  | { unreadyHostId: string };

/**
 * Placement for a workspace an agent launches. The SSH host pin applies only to
 * worktree launches from a non-SSH source; otherwise the source workspace's SSH
 * location decides. A pinned mode may start anywhere, so a pinned host that isn't
 * ready is reported rather than skipped, which could start that mode on this computer.
 * A launch from outside every workspace, as from a script, starts on this computer,
 * not wherever New Workspace last started one.
 */
export function agentLaunchWorkspacePlacement(
  config: AgentLaunchDefaultsConfig,
  target: { mode: 'worktree' | 'directory'; sourceIsSsh: boolean; fromWorkspace: boolean },
  isSshHostReady: (hostId: string) => boolean
): AgentLaunchPlacement {
  const hostId = config.agentLaunchDefaultSshHostId;
  if (hostId && target.mode === 'worktree' && !target.sourceIsSsh) {
    return isSshHostReady(hostId)
      ? { environment: { kind: 'ssh', hostId } }
      : { unreadyHostId: hostId };
  }
  return target.fromWorkspace ? {} : { environment: { kind: 'local' } };
}

/**
 * Why a launch the pinned SSH host refused didn't start, naming the host as Settings does,
 * or saying it's gone when the pin names a host this computer doesn't have.
 */
export function unreadyPinnedHostMessage(host: { name: string } | undefined): string {
  const where = 'Where agents start in Settings → Integrations & MCP';
  return host
    ? `Agents start new workspaces on ${host.name}, which isn't set up yet. Finish setting it up, or change ${where}.`
    : `Agents start new workspaces on an SSH host that isn't in Komla any more. Change ${where}.`;
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
