import { isSshWorkspace, type SshHost, type Workspace } from '@/types';

export const LOCAL_WORKSPACE_HOST_ID = 'local';

export function getWorkspaceHostId(workspace: Workspace): string {
  return isSshWorkspace(workspace) ? workspace.backend.hostId : LOCAL_WORKSPACE_HOST_ID;
}

export function getSshHostDisplayName(host: SshHost): string {
  return host.name.trim() || host.hostname;
}

/** The `user@host:port` Komla connects to, leaving out ssh's defaults. */
export function formatSshTarget(host: SshHost): string {
  const user = host.user ? `${host.user}@` : '';
  const port = host.port && host.port !== 22 ? `:${host.port}` : '';
  return `${user}${host.hostname}${port}`;
}

/** Only abbreviates homes Komla can infer from the configured user; anything else stays absolute. */
export function abbreviateRemoteHome(path: string, user: string | undefined): string {
  if (!user) return path;
  const homes = user === 'root' ? ['/root'] : [`/home/${user}`, `/Users/${user}`];
  const home = homes.find((candidate) => path === candidate || path.startsWith(`${candidate}/`));
  return home ? `~${path.slice(home.length)}` : path;
}

export function isWorkspaceHostVisible(
  workspace: Workspace,
  hiddenWorkspaceHostIds: ReadonlySet<string>
): boolean {
  return !hiddenWorkspaceHostIds.has(getWorkspaceHostId(workspace));
}
