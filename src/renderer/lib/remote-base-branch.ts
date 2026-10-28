/** A remote-only branch has no local ref, so it only resolves as a base through origin/. */
export function qualifyBaseBranch(name: string, isRemoteOnly: boolean): string {
  return isRemoteOnly ? `origin/${name}` : name;
}

/**
 * When forking off a remote-only base, refresh refs first so the worktree
 * starts from tip-of-remote rather than a stale remote-tracking ref.
 */
export async function refreshIfBaseIsRemoteOnly(
  repoPath: string,
  isRemoteOnly: boolean
): Promise<void> {
  if (!isRemoteOnly) return;
  try {
    await window.api.fetchFromRemote(repoPath);
  } catch {
    // Best-effort; proceed even if offline
  }
}
