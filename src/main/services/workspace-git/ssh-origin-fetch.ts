import { posix as pathPosix } from 'path';

import { shellQuotePosix } from '../../../shared/lib/shell-quote';
import { RECENT_ORIGIN_FETCH_MS } from '../git/git-branch';

/**
 * How an SSH host's clone of a project tracks its fetches of origin: workspace setup and the
 * background fetch share one lock, and both record when they last fetched every origin branch,
 * so a workspace created soon after starts without fetching again.
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

/**
 * Shell lines that record, in the host's own clock, that a fetch into the clone just finished,
 * when the clone fetches every origin branch.
 */
export function recordOriginFetchLines(remoteRepoPath: string): string[] {
  return [
    `if git -C ${shellQuotePosix(remoteRepoPath)} config --get-all remote.origin.fetch 2>/dev/null | grep -qxF ${shellQuotePosix(ORIGIN_FETCH_REFSPEC)}; then`,
    `  date +%s > ${shellQuotePosix(originFetchedAtPath(remoteRepoPath))} 2>/dev/null || true`,
    'fi',
  ];
}

/**
 * Shell lines defining `origin_fetched_recently`, which succeeds when the clone's last fetch of
 * every origin branch finished within RECENT_ORIGIN_FETCH_MS by the host's clock, and setup
 * didn't just point origin at another URL.
 */
export function originFetchedRecentlyLines(remoteRepoPath: string): string[] {
  return [
    'origin_fetched_recently() {',
    '  [ -z "${origin_url_changed:-}" ] || return 1',
    `  fetched_at=$(cat ${shellQuotePosix(originFetchedAtPath(remoteRepoPath))} 2>/dev/null) || return 1`,
    '  case "$fetched_at" in',
    "    ''|*[!0-9]*) return 1 ;;",
    '  esac',
    '  now=$(date +%s)',
    `  [ "$fetched_at" -le "$now" ] && [ $((now - fetched_at)) -lt ${RECENT_ORIGIN_FETCH_MS / 1000} ]`,
    '}',
  ];
}
