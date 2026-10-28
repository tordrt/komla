export type SshWorkspaceMode = 'remote' | 'local-mirror-actions';

export function resolveSshWorkspaceMode(
  globalMode: SshWorkspaceMode | undefined,
  projectMode: SshWorkspaceMode | undefined
): SshWorkspaceMode {
  return projectMode ?? globalMode ?? 'remote';
}
