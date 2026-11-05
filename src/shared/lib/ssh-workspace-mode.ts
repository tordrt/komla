// `local-copy-actions` runs commands in the Local copy.
export type SshWorkspaceMode = 'remote' | 'local-copy-actions';

export function resolveSshWorkspaceMode(
  globalMode: SshWorkspaceMode | undefined,
  projectMode: SshWorkspaceMode | undefined
): SshWorkspaceMode {
  return projectMode ?? globalMode ?? 'remote';
}
