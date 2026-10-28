/** A start point for a new SSH workspace, without the remote's symbolic HEAD. */
export function normalizeSshStartPoint(branch: string | undefined): string | undefined {
  const normalized = branch?.trim();
  return normalized && !/^(?:HEAD|origin\/HEAD|refs\/remotes\/origin\/HEAD)$/.test(normalized)
    ? normalized
    : undefined;
}

/** The branch name an SSH workspace targets, without an `origin/` prefix. */
export function normalizeSshTargetBranch(branch: string | undefined): string | undefined {
  return normalizeSshStartPoint(branch)
    ?.replace(/^refs\/remotes\/origin\//, '')
    .replace(/^origin\//, '');
}
