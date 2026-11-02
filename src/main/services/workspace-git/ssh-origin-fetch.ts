import { posix as pathPosix } from 'path';

import { shellQuotePosix } from '../../../shared/lib/shell-quote';
import { RECENT_ORIGIN_FETCH_MS } from '../git/git-branch';

/**
 * How an SSH host's clone of a project tracks its fetches of origin: workspace setup and the
 * background fetch share one lock, and both record when the last fetch finished and which
 * branches it brought, so a workspace created soon after from one of them starts without
 * fetching again.
 */

export const ORIGIN_FETCH_REFSPEC = '+refs/heads/*:refs/remotes/origin/*';

/** The folder that holds a host clone's setup lock and the project it belongs to. */
export function remoteProjectRepoRoot(remoteRepoPath: string): string {
  return ['.git', 'repo.git'].includes(pathPosix.basename(remoteRepoPath))
    ? pathPosix.dirname(remoteRepoPath)
    : `${remoteRepoPath}.komla`;
}

/** The lock a host clone's setup holds, and its background fetch while it fetches. */
export function remoteSetupLockPath(remoteRepoPath: string): string {
  return `${remoteProjectRepoRoot(remoteRepoPath)}/.setup-lock`;
}

/**
 * Shell lines defining `setup_lock_is_stale LOCK`: the process that holds the lock has exited. A
 * lock without an owner yet belongs to a holder that has just taken it.
 */
export function staleSetupLockLines(): string[] {
  return [
    'setup_lock_is_stale() {',
    '  lock_owner=$(cat "$1/pid" 2>/dev/null || true)',
    '  [ -n "$lock_owner" ] && ! kill -0 "$lock_owner" 2>/dev/null',
    '}',
  ];
}

// Beside the lock rather than in the clone, which may have files of its own checked out.
function originFetchedAtPath(remoteRepoPath: string): string {
  return `${remoteProjectRepoRoot(remoteRepoPath)}/.origin-fetched-at`;
}

const RECENT_SECONDS = RECENT_ORIGIN_FETCH_MS / 1000;

/** Shell lines that forget the clone's fetches, for a clone made afresh in its place. */
export function forgetOriginFetchLines(remoteRepoPath: string): string[] {
  return [`rm -f ${shellQuotePosix(originFetchedAtPath(remoteRepoPath))}`];
}

/**
 * Shell lines that record, in the host's own clock, that a fetch into the clone just finished:
 * one `<seconds> <branch>` line for each of `branches`, or `*` when the clone fetches every
 * branch. Lines for other branches stay while they're recent.
 */
export function recordOriginFetchLines(
  remoteRepoPath: string,
  branches?: readonly string[]
): string[] {
  const markerPath = shellQuotePosix(originFetchedAtPath(remoteRepoPath));
  const names = branches ?? ['*'];
  // Branch names have no spaces, so a space-separated list is safe to match whole names in.
  const record = [
    'fetched_at=$(date +%s)',
    '{',
    `  for fetched_branch in ${names.map(shellQuotePosix).join(' ')}; do printf '%s %s\\n' "$fetched_at" "$fetched_branch"; done`,
    `  awk -v now="$fetched_at" -v window=${RECENT_SECONDS} -v fetched=${shellQuotePosix(` ${names.join(' ')} `)} '$1 ~ /^[0-9]+$/ && $1 <= now && now - $1 < window && index(fetched, " " $2 " ") == 0' ${markerPath} 2>/dev/null || true`,
    `} > ${markerPath}.new 2>/dev/null && mv -f ${markerPath}.new ${markerPath} 2>/dev/null || true`,
  ];
  if (branches) return record;
  return [
    `if git -C ${shellQuotePosix(remoteRepoPath)} config --get-all remote.origin.fetch 2>/dev/null | grep -qxF ${shellQuotePosix(ORIGIN_FETCH_REFSPEC)}; then`,
    ...record.map((line) => `  ${line}`),
    'fi',
  ];
}

/**
 * Shell lines defining `origin_fetched_recently [BRANCH]`, which succeeds when a fetch that
 * brought BRANCH, or any fetch without one, finished within RECENT_ORIGIN_FETCH_MS by the host's
 * clock; and `origin_fetched_before`, when origin has been fetched into the clone at all. Neither
 * does once setup has just pointed origin at another URL.
 */
export function originFetchedRecentlyLines(remoteRepoPath: string): string[] {
  const markerPath = shellQuotePosix(originFetchedAtPath(remoteRepoPath));
  return [
    'origin_fetched_recently() {',
    '  [ -z "${origin_url_changed:-}" ] || return 1',
    `  awk -v now="$(date +%s)" -v window=${RECENT_SECONDS} -v branch="\${1:-}" '$1 ~ /^[0-9]+$/ && $1 <= now && now - $1 < window && ($2 == "*" || branch == "" || $2 == branch) { found = 1 } END { exit !found }' ${markerPath} 2>/dev/null`,
    '}',
    'origin_fetched_before() {',
    `  [ -z "\${origin_url_changed:-}" ] && [ -s ${markerPath} ]`,
    '}',
  ];
}
