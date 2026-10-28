import type {
  RemoteLaunchEnvironmentSummary,
  RemoteWorkspaceEnvironment,
} from '@komla/remote-protocol';

/** The `<select>` value for an environment the desktop offers. */
export function environmentValue(environment: RemoteLaunchEnvironmentSummary): string {
  if (environment.kind === 'local') return 'local';
  return `${environment.kind}:${environment.id}`;
}

export function parseEnvironmentValue(value: string): RemoteWorkspaceEnvironment | undefined {
  if (value === 'local') return { kind: 'local' };
  if (value.startsWith('ssh:')) {
    const hostId = value.slice('ssh:'.length);
    return hostId ? { kind: 'ssh', hostId } : undefined;
  }
  return undefined;
}

/**
 * Where a new workspace from the phone runs unless the user picks otherwise: the last choice made
 * here while it is still offered, else an SSH host, else this computer.
 */
export function defaultEnvironmentValue(
  environments: RemoteLaunchEnvironmentSummary[],
  storedValue: string | undefined
): string {
  const values = environments.map(environmentValue);
  if (storedValue && values.includes(storedValue)) return storedValue;
  const preferred =
    environments.find((environment) => environment.kind === 'ssh') ?? environments[0];
  return preferred ? environmentValue(preferred) : '';
}
