// `local-mirror-actions` runs commands in the Local copy. Saved settings hold this value, so it
// keeps the old name.
export type SshWorkspaceMode = 'remote' | 'local-mirror-actions';

export function resolveSshWorkspaceMode(
  globalMode: SshWorkspaceMode | undefined,
  projectMode: SshWorkspaceMode | undefined
): SshWorkspaceMode {
  return projectMode ?? globalMode ?? 'remote';
}
