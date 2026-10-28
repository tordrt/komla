import type { Workspace } from '@/types';

export type IntegrationTarget = 'local' | `ssh:${string}`;

/** Where the most recently created workspace runs, so agent settings open on that place. */
export function lastUsedIntegrationTarget(
  workspaces: Pick<Workspace, 'createdAt' | 'backend'>[]
): IntegrationTarget {
  const latest = workspaces.reduce<(typeof workspaces)[number] | undefined>(
    (newest, workspace) => (!newest || workspace.createdAt > newest.createdAt ? workspace : newest),
    undefined
  );
  if (latest?.backend?.kind === 'ssh') return `ssh:${latest.backend.hostId}`;
  return 'local';
}

/** The SSH host a target names, or nothing for this computer. */
export function sshHostIdFromTarget(target: IntegrationTarget | null): string | undefined {
  return target?.startsWith('ssh:') ? target.slice('ssh:'.length) : undefined;
}
