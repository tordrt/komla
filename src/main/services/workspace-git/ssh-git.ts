import { randomUUID } from 'crypto';
import { posix as pathPosix } from 'path';

import { z } from 'zod';

import { UNCOMMITTED_CHANGES_PREFIX } from '../../../shared/constants/git';
import { shellQuotePosix } from '../../../shared/lib/shell-quote';
import { createLogger } from '../../lib/logger';
import {
  CHECK_CONCURRENCY,
  type GitBatchCommand,
  type GitBatchResult,
  type GitBatchRunner,
} from '../git/git-branch-cleanup';
import { activeConflictMessage, NO_PROMPT_GIT_ENV, stripGitTransferNoise } from '../git/git-exec';
import { commitGraphLogArgs, toCommitGraph } from '../git/git-history';
import { remoteCompanionService } from '../remote-companion.service';
import { sshWorkspaceService } from '../ssh-workspace.service';

import type {
  CommitChangesResult,
  CommitDraftResult,
  CommitScope,
  CommitScopeResult,
  SshHost,
  SshWorkspaceBackend,
} from '../../../shared/types';
import type { CommitGraph, CommitGraphQuery } from '../../../shared/types/commit-graph';
import type { BranchInfo, GitBranchQuickStatus } from '../git.service';

const logger = createLogger('SshWorkspaceGit');

const remoteSnapshotSchema = z.object({
  observedAt: z.number().int().nonnegative().optional(),
  statusB64: z.string(),
  numstatB64: z.string(),
  statusTooLarge: z.boolean(),
  branch: z.object({
    currentBranch: z.string(),
    targetBranch: z.string(),
    defaultBranch: z.string().optional(),
    aheadTargetBranch: z.number().int().nonnegative(),
    behindTargetBranch: z.number().int().nonnegative(),
    hasRemote: z.boolean(),
    hasOriginRemote: z.boolean(),
    unpushedCommits: z.number().int().nonnegative(),
    behindRemote: z.number().int().nonnegative(),
    targetBranchHasRemote: z.boolean(),
    targetBranchAheadRemote: z.number().int().nonnegative(),
    targetBranchBehindRemote: z.number().int().nonnegative(),
  }),
});

export interface SshWorkspaceGitSnapshot {
  observedAt?: number;
  statusText: string;
  numstatText: string;
  statusTooLarge: boolean;
  branch: GitBranchQuickStatus;
}

// `message` comes last and runs to the end of the output, since it can carry Git's own lines.
function parseKeyValueOutput(output: string): Map<string, string> {
  const values = new Map<string, string>();
  const lines = output.split('\n');
  for (const [lineIndex, line] of lines.entries()) {
    const index = line.indexOf('=');
    if (index <= 0) continue;
    const key = line.slice(0, index);
    if (key === 'message') {
      values.set(key, [line.slice(index + 1), ...lines.slice(lineIndex + 1)].join('\n').trimEnd());
      break;
    }
    values.set(key, line.slice(index + 1));
  }
  return values;
}

function parseRemoteGitError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return message.trim() || fallback;
}

function getRemoteBasePath(backend: SshWorkspaceBackend): string {
  return pathPosix.dirname(pathPosix.dirname(backend.remoteProjectRoot));
}

function getRemoteCliPath(backend: SshWorkspaceBackend): string {
  return pathPosix.join(getRemoteBasePath(backend), 'helpers', 'komla');
}

// Like the snapshot's behind count, the companion names origin's target when the local one is
// strictly behind it, after fast-forwarding the local target when nothing else is using it. This
// app's own companion build answers; when it cannot be installed or answer, the ref stays as it is.
async function resolveTargetRefScript(
  host: SshHost,
  backend: SshWorkspaceBackend
): Promise<string[]> {
  const companionPath = await remoteCompanionService
    .ensureInstalled(host, getRemoteBasePath(backend))
    .catch((error: unknown) => {
      logger.warn('Updating from the target without the Remote Companion', {
        hostId: backend.hostId,
        error,
      });
      return undefined;
    });
  return companionPath
    ? [
        `if synced_ref=$(${shellQuotePosix(companionPath)} git target sync --target "$branch" 2>/dev/null) && [ -n "$synced_ref" ]; then ref="$synced_ref"; fi`,
      ]
    : [];
}

/**
 * Shell functions that auto-stash under a message unique to this run and restore by commit.
 * Every worktree of a project shares one stash stack, so the top entry may be another's.
 */
function autoStashScript(message: string): string[] {
  return [
    `stash_message=${shellQuotePosix(message)}-$$`,
    'stash_sha=',
    'stash_note=',
    'save_stash() {',
    '  stash_before=$(git rev-parse -q --verify refs/stash || true)',
    '  git stash push -u -m "$stash_message" >/dev/null || return 1',
    // Nothing was saved if the stash didn't change; an older entry can share the message.
    '  [ "$(git rev-parse -q --verify refs/stash || true)" != "$stash_before" ] || return 0',
    `  stash_sha=$(git stash list --format='%H %gs' | awk -v m=": $stash_message" 'substr($0, length($0) - length(m) + 1) == m { print $1; exit }')`,
    '}',
    'restore_stash() {',
    '  [ -n "$stash_sha" ] || return 0',
    '  git stash apply "$stash_sha" >/dev/null 2>&1 || return 1',
    `  stash_ref=$(git stash list --format='%gd %H' | awk -v h="$stash_sha" '$2 == h { print $1; exit }')`,
    '  if [ -n "$stash_ref" ]; then git stash drop "$stash_ref" >/dev/null 2>&1 || true; fi',
    '}',
  ];
}

function assertSafeRemoteRelativePath(filePath: string): void {
  if (filePath.includes('\0')) throw new Error('filePath contains invalid null byte');
  if (!filePath || filePath.startsWith('/')) throw new Error('filePath must be relative');
  const normalized = pathPosix.normalize(filePath);
  if (normalized === '.' || normalized.split('/').some((segment) => segment === '..')) {
    throw new Error('filePath escapes the workspace');
  }
}

// Git batches for branch cleanup can take a while on a large clone.
const GIT_BATCH_TIMEOUT_MS = 5 * 60_000;

/**
 * A script that runs each command in `repoPath` and prints its output, or its errors when it
 * failed, then `marker` and its exit status on a line of their own. It reads from stdin, so
 * the command lines can be long.
 */
function gitBatchScript(repoPath: string, marker: string, commands: GitBatchCommand[]): string {
  return [
    `marker=${shellQuotePosix(marker)}`,
    'tmp=$(mktemp -d) || exit 1',
    `trap 'rm -rf "$tmp"' EXIT`,
    `cd ${shellQuotePosix(repoPath)} || exit 1`,
    'run() {',
    '  mode=$1; shift',
    '  "$@" </dev/null >"$tmp/out" 2>"$tmp/err"; code=$?',
    '  if [ "$code" -eq 0 ] && [ "$mode" = patch-ids ]; then',
    '    git patch-id --stable <"$tmp/out" >"$tmp/ids" 2>"$tmp/err"; code=$?',
    '    mv "$tmp/ids" "$tmp/out"',
    '  fi',
    '  if [ "$code" -eq 0 ]; then cat "$tmp/out"; else cat "$tmp/err"; fi',
    `  printf '\\n%s %s\\n' "$marker" "$code"`,
    '}',
    // A login profile may print first, so the results start after the marker.
    `printf '%s\\n' "$marker"`,
    ...commands.map(({ args, patchIds }) =>
      [patchIds ? 'run patch-ids git' : 'run plain git', ...args.map(shellQuotePosix)].join(' ')
    ),
  ].join('\n');
}

const ORIGIN_REFS_CHANGED_MARKER = '__KOMLA_ORIGIN_REFS_CHANGED__';

/**
 * A script that fetches origin in `repoPath` without asking for anything, like the local
 * background fetch, and prints ORIGIN_REFS_CHANGED_MARKER when a remote-tracking ref moved.
 * It stops git itself after `timeoutSeconds`, so a slow remote doesn't look like a slow host.
 */
function backgroundFetchScript(repoPath: string, timeoutSeconds: number): string {
  const { set, unset, sshCommand } = NO_PROMPT_GIT_ENV;
  return [
    `cd ${shellQuotePosix(repoPath)} || exit 1`,
    'git remote get-url origin >/dev/null 2>&1 || exit 0',
    Object.entries(set)
      .map(([name, value]) => `${name}=${shellQuotePosix(value)}`)
      .join(' '),
    `export ${Object.keys(set).join(' ')}`,
    `unset ${unset.join(' ')}`,
    // GIT_SSH_COMMAND would replace a repository's own ssh command, so leave those alone.
    'if [ -z "${GIT_SSH_COMMAND:-}" ] && [ -z "${GIT_SSH:-}" ] && ! git config --get core.sshCommand >/dev/null; then',
    `  GIT_SSH_COMMAND=${shellQuotePosix(sshCommand)}`,
    '  export GIT_SSH_COMMAND',
    'fi',
    "refs() { git for-each-ref --format='%(objectname) %(refname)' refs/remotes/origin; }",
    // Stops a process and the ones it started, such as git's ssh. Not every host has
    // timeout(1), and a shell without a terminal can't give the fetch its own process group.
    // Each process is paused first, so it can't start another one that would get away.
    'stop() {',
    '  kill -STOP "$1" 2>/dev/null',
    // Minimal Linux images can lack ps; /proc has the same parent ids.
    '  if command -v ps >/dev/null 2>&1; then',
    `    children=$(ps -A -o pid= -o ppid= 2>/dev/null | awk -v parent="$1" '$2 == parent { print $1 }')`,
    '  else',
    `    children=$(cat /proc/[0-9]*/stat 2>/dev/null | awk -v parent="$1" '$4 == parent { print $1 }')`,
    '  fi',
    '  for child in $children; do stop "$child"; done',
    '  kill "$1" 2>/dev/null',
    '  kill -CONT "$1" 2>/dev/null',
    '}',
    'before=$(refs)',
    'git fetch --quiet --prune origin </dev/null &',
    'fetch=$!',
    // The watchdog writes nowhere, so ssh never waits for it.
    `(sleep ${timeoutSeconds}; stop "$fetch") >/dev/null 2>&1 &`,
    'watchdog=$!',
    'wait "$fetch"',
    'status=$?',
    'stop "$watchdog"',
    '[ "$status" -eq 0 ] || exit "$status"',
    `[ "$(refs)" = "$before" ] || printf '%s\\n' ${ORIGIN_REFS_CHANGED_MARKER}`,
  ].join('\n');
}

function parseGitBatchOutput(output: string, marker: string, count: number): GitBatchResult[] {
  const start = output.indexOf(`${marker}\n`);
  if (start < 0) throw new Error(output.trim() || 'The host did not run git');
  let rest = output.slice(start + marker.length + 1);
  const separator = `\n${marker} `;
  const results: GitBatchResult[] = [];
  for (let index = 0; index < count; index++) {
    const at = rest.indexOf(separator);
    if (at < 0) throw new Error('The host stopped before every git command ran');
    const lineEnd = rest.indexOf('\n', at + separator.length);
    const status = Number(rest.slice(at + separator.length, lineEnd));
    const text = rest.slice(0, at).trim();
    results.push(
      status === 0
        ? { ok: true, output: text }
        : { ok: false, error: text || `Git exited with code ${status}` }
    );
    rest = rest.slice(lineEnd + 1);
  }
  return results;
}

class SshWorkspaceGit {
  /**
   * Runs git in a repository on the host, each batch split into a few scripts that run at
   * once, or one script for a serial batch.
   */
  gitBatchRunner(hostId: string, repoPath: string): GitBatchRunner {
    return {
      label: `${hostId}:${repoPath}`,
      run: async (commands, { serial = false } = {}) => {
        if (commands.length === 0) return [];
        const host = sshWorkspaceService.getHost(hostId);
        const size = serial ? commands.length : Math.ceil(commands.length / CHECK_CONCURRENCY);
        const chunks: GitBatchCommand[][] = [];
        for (let i = 0; i < commands.length; i += size) chunks.push(commands.slice(i, i + size));
        const results = await Promise.all(
          chunks.map(async (chunk) => {
            const marker = `__KOMLA_GIT_${randomUUID()}__`;
            const output = await sshWorkspaceService.runWithInput(
              host,
              'sh -s',
              gitBatchScript(repoPath, marker, chunk),
              { timeout: GIT_BATCH_TIMEOUT_MS }
            );
            return parseGitBatchOutput(output, marker, chunk.length);
          })
        );
        return results.flat();
      },
    };
  }

  async getSnapshot(
    backend: SshWorkspaceBackend,
    targetBranch: string
  ): Promise<SshWorkspaceGitSnapshot> {
    const host = sshWorkspaceService.getHost(backend.hostId);
    const target = targetBranch.trim() || backend.baseBranch || 'main';
    const output = await sshWorkspaceService.run(
      host,
      [
        shellQuotePosix(getRemoteCliPath(backend)),
        'git snapshot',
        `-C ${shellQuotePosix(backend.remoteDirectory)}`,
        `--target ${shellQuotePosix(target)}`,
      ].join(' ')
    );
    const snapshot = remoteSnapshotSchema.parse(JSON.parse(output));
    const {
      targetBranch: observedTargetBranch,
      defaultBranch: observedDefaultBranch,
      ...branch
    } = snapshot.branch;
    return {
      observedAt: snapshot.observedAt,
      statusText: Buffer.from(snapshot.statusB64, 'base64').toString('utf8'),
      numstatText: Buffer.from(snapshot.numstatB64, 'base64').toString('utf8'),
      statusTooLarge: snapshot.statusTooLarge,
      branch: {
        ...branch,
        mainBranch: observedTargetBranch || target,
        defaultBranch:
          observedDefaultBranch || backend.defaultBranch || observedTargetBranch || target,
      },
    };
  }

  async getBranchQuickStatus(
    backend: SshWorkspaceBackend,
    targetBranch: string
  ): Promise<GitBranchQuickStatus> {
    return (await this.getSnapshot(backend, targetBranch)).branch;
  }

  async listBranches(backend: SshWorkspaceBackend, includeRemote = false): Promise<BranchInfo[]> {
    const host = sshWorkspaceService.getHost(backend.hostId);
    const output = await sshWorkspaceService.run(
      host,
      [
        `cd ${shellQuotePosix(backend.remoteDirectory)}`,
        'git branch --sort=-committerdate --format="%(refname:short)"',
        'printf "__KOMLA_REMOTE_BRANCHES__\\n"',
        includeRemote ? 'git branch -r --sort=-committerdate --format="%(refname:short)"' : 'true',
      ].join('\n')
    );
    const [localOutput = '', remoteOutput = ''] = output.split('__KOMLA_REMOTE_BRANCHES__\n');
    const localBranches: BranchInfo[] = localOutput
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((name) => ({ name, isRemoteOnly: false }));

    if (!includeRemote) return localBranches;

    const remoteBranches: BranchInfo[] = remoteOutput
      .split('\n')
      .map((line) => line.trim())
      .filter((remoteRef) => remoteRef.includes('/'))
      .map((remoteRef) => ({
        name: remoteRef.replace(/^[^/]+\//, ''),
        isRemoteOnly: true,
        remoteRef,
      }))
      .filter((branch) => branch.name && branch.name !== 'HEAD');

    return [...localBranches, ...remoteBranches];
  }

  async getCommitGraph(
    backend: SshWorkspaceBackend,
    query: CommitGraphQuery
  ): Promise<CommitGraph> {
    if (query.path) assertSafeRemoteRelativePath(query.path);
    const host = sshWorkspaceService.getHost(backend.hostId);
    const log = `git ${commitGraphLogArgs(query).map(shellQuotePosix).join(' ')}`;
    // The upstream's ref on the first line, then the history once HEAD has a commit.
    const output = await sshWorkspaceService.run(
      host,
      [
        `cd ${shellQuotePosix(backend.remoteDirectory)} || exit $?`,
        `printf '%s\\n' "$(git rev-parse --symbolic-full-name '@{upstream}' 2>/dev/null)"`,
        `if git rev-parse --verify --quiet HEAD >/dev/null; then ${log}; fi`,
      ].join('\n')
    );
    const newline = output.indexOf('\n');
    return toCommitGraph(output.slice(newline + 1), output.slice(0, newline) || null, query);
  }

  async inspectCommitScope(backend: SshWorkspaceBackend): Promise<CommitScopeResult> {
    const host = sshWorkspaceService.getHost(backend.hostId);
    const output = await sshWorkspaceService.run(
      host,
      [
        `cd ${shellQuotePosix(backend.remoteDirectory)}`,
        'status=$(git status --porcelain=v1 --untracked-files=all)',
        '[ -n "$status" ] || { printf "none\n"; exit 0; }',
        'file_count=$(printf "%s\n" "$status" | awk "NF { count++ } END { print count+0 }")',
        'staged_count=$(printf "%s\\n" "$status" | awk \'substr($0,1,1) != " " && substr($0,1,1) != "?" { count++ } END { print count+0 }\')',
        'if [ "$staged_count" -gt 0 ]; then printf "staged %s\n" "$staged_count"; else printf "all %s\n" "$file_count"; fi',
      ].join('\n')
    );
    const [scope, count] = output.trim().split(/\s+/);
    if (scope === 'none') throw new Error('There are no changes to commit');
    return { scope: scope === 'staged' ? 'staged' : 'all', fileCount: Number(count) || 0 };
  }

  async generateCommitDraft(backend: SshWorkspaceBackend): Promise<CommitDraftResult> {
    const { scope, fileCount } = await this.inspectCommitScope(backend);
    const host = sshWorkspaceService.getHost(backend.hostId);
    let diff = await sshWorkspaceService.run(
      host,
      [
        `cd ${shellQuotePosix(backend.remoteDirectory)}`,
        scope === 'staged'
          ? 'git diff --cached --no-ext-diff --no-textconv --no-color --find-renames -- 2>/dev/null | head -c 300000'
          : 'git diff HEAD --no-ext-diff --no-textconv --no-color --find-renames -- 2>/dev/null | head -c 300000',
      ].join('\n')
    );
    if (scope === 'all') {
      const untrackedOutput = await sshWorkspaceService.run(
        host,
        [
          `cd ${shellQuotePosix(backend.remoteDirectory)}`,
          'git ls-files --others --exclude-standard -z',
        ].join('\n')
      );
      for (const filePath of untrackedOutput.split('\0').filter(Boolean)) {
        if (diff.length >= 300_000) break;
        const description = `\n--- untracked file: ${filePath}\n[content omitted for safety]\n`;
        diff += description.slice(0, 300_000 - diff.length);
      }
    }
    if (!diff.trim()) {
      return {
        subject: '',
        body: null,
        scope,
        fileCount,
        generationError: 'The selected commit scope has no readable changes',
      };
    }
    try {
      const { utilityInferenceService } = await import('../utility-inference.service');
      const draft = await utilityInferenceService.generateCommitMessage(diff.slice(0, 300_000));
      return { ...draft, scope, fileCount };
    } catch (cause) {
      return {
        subject: '',
        body: null,
        scope,
        fileCount,
        generationError:
          cause instanceof Error ? cause.message : 'Could not generate a commit message',
      };
    }
  }

  async commitChanges(
    backend: SshWorkspaceBackend,
    input: { subject: string; body?: string | null; scope: CommitScope }
  ): Promise<CommitChangesResult> {
    const subject = input.subject.trim();
    if (!subject) throw new Error('Commit subject is required');
    const message = input.body?.trim() ? `${subject}\n\n${input.body.trim()}` : subject;
    const host = sshWorkspaceService.getHost(backend.hostId);
    const output = await sshWorkspaceService.run(
      host,
      [
        `cd ${shellQuotePosix(backend.remoteDirectory)}`,
        input.scope === 'all'
          ? 'git add --all'
          : 'git diff --cached --quiet -- && { printf "There are no staged changes to commit" >&2; exit 1; }',
        'message_file=$(mktemp)',
        'trap \'rm -f "$message_file"\' EXIT',
        `printf %s ${shellQuotePosix(message)} > "$message_file"`,
        'git commit -F "$message_file" >/dev/null',
        'git rev-parse HEAD',
      ].join('\n')
    );
    return { commitHash: output.trim(), subject };
  }

  async switchBranch(
    backend: SshWorkspaceBackend,
    branchName: string
  ): Promise<{ success: boolean; message: string }> {
    const host = sshWorkspaceService.getHost(backend.hostId);
    try {
      await sshWorkspaceService.run(
        host,
        [
          `cd ${shellQuotePosix(backend.remoteDirectory)}`,
          `branch=${shellQuotePosix(branchName)}`,
          'if git show-ref --verify --quiet "refs/heads/$branch"; then git switch "$branch"; exit $?; fi',
          'if git show-ref --verify --quiet "refs/remotes/origin/$branch"; then remote_ref="origin/$branch"; else remote_ref=$(git for-each-ref --format="%(refname:short)" "refs/remotes/*/$branch" | head -n 1); fi',
          '[ -n "$remote_ref" ] || { printf "Remote branch not found: %s\\n" "$branch" >&2; exit 1; }',
          'git switch --track "$remote_ref"',
        ].join('\n')
      );
      return { success: true, message: `Switched to branch ${branchName}` };
    } catch (error) {
      return { success: false, message: parseRemoteGitError(error, 'Switch branch failed') };
    }
  }

  /**
   * Creates a branch without switching to it, at HEAD or at a start point. Like updating from the
   * target, the start point is origin's when the host has no branch of that name or its own is
   * behind origin's.
   */
  async createBranch(
    backend: SshWorkspaceBackend,
    branchName: string,
    startPoint?: string
  ): Promise<void> {
    const host = sshWorkspaceService.getHost(backend.hostId);
    try {
      const startScript = startPoint
        ? [
            `branch=${shellQuotePosix(startPoint)}`,
            'ref="$branch"',
            // The companion's answer below wins; this covers hosts without it.
            'if git rev-parse --verify --quiet "origin/$branch^{commit}" >/dev/null; then',
            '  if ! git rev-parse --verify --quiet "$branch^{commit}" >/dev/null || git merge-base --is-ancestor "$branch" "origin/$branch"; then ref="origin/$branch"; fi',
            'fi',
            ...(await resolveTargetRefScript(host, backend)),
            `git branch --no-track -- ${shellQuotePosix(branchName)} "$ref"`,
          ]
        : [`git branch -- ${shellQuotePosix(branchName)}`];
      await sshWorkspaceService.run(
        host,
        [`cd ${shellQuotePosix(backend.remoteDirectory)} || exit 1`, ...startScript].join('\n')
      );
    } catch (error) {
      throw new Error(parseRemoteGitError(error, 'Create branch failed'));
    }
  }

  async fetchFromRemote(
    backend: SshWorkspaceBackend
  ): Promise<{ success: boolean; message: string }> {
    const host = sshWorkspaceService.getHost(backend.hostId);
    try {
      await sshWorkspaceService.run(
        host,
        [`cd ${shellQuotePosix(backend.remoteDirectory)}`, 'git fetch --all --prune'].join('\n')
      );
      return { success: true, message: 'Fetched remote branches' };
    } catch (error) {
      return { success: false, message: parseRemoteGitError(error, 'Fetch failed') };
    }
  }

  /**
   * Fetches origin for a repository on the host, never asking for a login, password or
   * passphrase. Resolves whether any of origin's remote-tracking refs moved.
   */
  async fetchOriginWithoutPrompts(
    hostId: string,
    repoPath: string,
    timeoutMs: number
  ): Promise<boolean> {
    const host = sshWorkspaceService.getHost(hostId);
    const output = await sshWorkspaceService.run(
      host,
      backgroundFetchScript(repoPath, Math.ceil(timeoutMs / 1000)),
      // Room past git's own timeout, so a host that answers isn't taken for one that doesn't.
      { timeout: timeoutMs + 10_000, purpose: { kind: 'background' }, prompt: false }
    );
    return output.split('\n').some((line) => line.trim() === ORIGIN_REFS_CHANGED_MARKER);
  }

  async mergeFrom(
    backend: SshWorkspaceBackend,
    branchName: string,
    options?: { stash?: boolean; targetBranch?: string }
  ): Promise<{ success: boolean; message: string }> {
    const host = sshWorkspaceService.getHost(backend.hostId);
    try {
      const targetRefScript =
        branchName === options?.targetBranch ? await resolveTargetRefScript(host, backend) : [];
      const output = await sshWorkspaceService.run(
        host,
        [
          `cd ${shellQuotePosix(backend.remoteDirectory)}`,
          `branch=${shellQuotePosix(branchName)}`,
          options?.stash ? 'use_stash=true' : 'use_stash=false',
          'ref="$branch"',
          'if ! git rev-parse --verify "$ref" >/dev/null 2>&1 && git rev-parse --verify "origin/$branch" >/dev/null 2>&1; then ref="origin/$branch"; fi',
          'has_changes=false',
          'if ! git diff --quiet HEAD -- 2>/dev/null || [ -n "$(git ls-files --others --exclude-standard)" ]; then has_changes=true; fi',
          'if [ "$has_changes" = true ] && [ "$use_stash" != true ]; then',
          `  printf "status=uncommitted\\nmessage=%s merging\\n" ${shellQuotePosix(UNCOMMITTED_CHANGES_PREFIX)}`,
          '  exit 0',
          'fi',
          ...targetRefScript,
          ...autoStashScript('komla-auto-stash-before-merge'),
          'if [ "$has_changes" = true ]; then save_stash; fi',
          'if ! merge_output=$(git merge "$ref" 2>&1); then',
          `  conflict_files=$(git diff --name-only --diff-filter=U | awk 'BEGIN { ORS="" } { if (NR > 1) printf ", "; printf "%s", $0 }')`,
          '  if [ -n "$conflict_files" ]; then',
          '    if ! git merge --abort >/dev/null 2>&1; then',
          '      printf "status=failed\\nmessage=Merge from %s encountered conflicts in %s, and Git could not abort the merge. The merge is still active; resolve or abort it manually.\\n" "$branch" "$conflict_files"',
          '      exit 0',
          '    fi',
          '    restore_stash || stash_note=" Your saved local changes could not be re-applied; they are kept in git stash."',
          '    printf "status=failed\\nmessage=Merge from %s encountered conflicts in %s. The merge was aborted.%s\\n" "$branch" "$conflict_files" "$stash_note"',
          '    exit 0',
          '  fi',
          '  merge_head=$(git rev-parse --git-path MERGE_HEAD)',
          '  if [ -f "$merge_head" ] && ! git merge --abort >/dev/null 2>&1; then',
          '    printf "status=failed\\nmessage=Merge from %s failed, and Git could not abort the merge. The merge is still active; resolve or abort it manually.\\n" "$branch"',
          '    exit 0',
          '  fi',
          '  restore_stash || stash_note=" Your saved local changes could not be re-applied; they are kept in git stash."',
          '  printf "status=failed\\nmessage=%s%s\\n" "$merge_output" "$stash_note"',
          '  exit 0',
          'fi',
          'if ! restore_stash; then stash_note=", but stash could not be re-applied cleanly - resolve conflicts manually"; fi',
          'if printf "%s" "$merge_output" | grep -q "Already up to date"; then',
          '  printf "status=success\\nmessage=Already up to date%s\\n" "$stash_note"',
          'else',
          '  printf "status=success\\nmessage=Merged %s successfully%s\\n" "$branch" "$stash_note"',
          'fi',
        ].join('\n')
      );
      const values = parseKeyValueOutput(output);
      return {
        success: values.get('status') === 'success',
        message: values.get('message') || 'Merge failed',
      };
    } catch (error) {
      return { success: false, message: parseRemoteGitError(error, 'Merge failed') };
    }
  }

  async rebaseOnBranch(
    backend: SshWorkspaceBackend,
    branchName: string,
    options?: { stash?: boolean; targetBranch?: string }
  ): Promise<{ success: boolean; message: string }> {
    const host = sshWorkspaceService.getHost(backend.hostId);
    try {
      const targetRefScript =
        branchName === options?.targetBranch ? await resolveTargetRefScript(host, backend) : [];
      const output = await sshWorkspaceService.run(
        host,
        [
          `cd ${shellQuotePosix(backend.remoteDirectory)}`,
          `branch=${shellQuotePosix(branchName)}`,
          options?.stash ? 'use_stash=true' : 'use_stash=false',
          'current=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || printf "")',
          'if [ "$current" = "$branch" ]; then printf "status=failed\\nmessage=Cannot rebase onto the current branch\\n"; exit 0; fi',
          'ref="$branch"',
          'if ! git rev-parse --verify "$ref" >/dev/null 2>&1 && git rev-parse --verify "origin/$branch" >/dev/null 2>&1; then ref="origin/$branch"; fi',
          'has_changes=false',
          'if ! git diff --quiet HEAD -- 2>/dev/null || [ -n "$(git ls-files --others --exclude-standard)" ]; then has_changes=true; fi',
          'if [ "$has_changes" = true ] && [ "$use_stash" != true ]; then',
          `  printf "status=uncommitted\\nmessage=%s rebasing\\n" ${shellQuotePosix(UNCOMMITTED_CHANGES_PREFIX)}`,
          '  exit 0',
          'fi',
          ...targetRefScript,
          ...autoStashScript('komla-auto-stash-before-rebase'),
          'if [ "$has_changes" = true ]; then save_stash; fi',
          'if ! rebase_output=$(git rebase "$ref" 2>&1); then',
          `  conflict_files=$(git diff --name-only --diff-filter=U | awk 'BEGIN { ORS="" } { if (NR > 1) printf ", "; printf "%s", $0 }')`,
          '  if [ -n "$conflict_files" ]; then',
          '    if ! git rebase --abort >/dev/null 2>&1; then',
          '      printf "status=failed\\nmessage=Rebase onto %s encountered conflicts in %s, and Git could not abort the rebase. The rebase is still active; resolve or abort it manually.\\n" "$branch" "$conflict_files"',
          '      exit 0',
          '    fi',
          '    restore_stash || stash_note=" Your saved local changes could not be re-applied; they are kept in git stash."',
          '    printf "status=failed\\nmessage=Rebase onto %s encountered conflicts in %s. The rebase was aborted.%s\\n" "$branch" "$conflict_files" "$stash_note"',
          '    exit 0',
          '  fi',
          '  rebase_merge=$(git rev-parse --git-path rebase-merge)',
          '  rebase_apply=$(git rev-parse --git-path rebase-apply)',
          '  if { [ -d "$rebase_merge" ] || [ -d "$rebase_apply" ]; } && ! git rebase --abort >/dev/null 2>&1; then',
          '    printf "status=failed\\nmessage=Rebase onto %s failed, and Git could not abort the rebase. The rebase is still active; resolve or abort it manually.\\n" "$branch"',
          '    exit 0',
          '  fi',
          '  restore_stash || stash_note=" Your saved local changes could not be re-applied; they are kept in git stash."',
          '  printf "status=failed\\nmessage=%s%s\\n" "$rebase_output" "$stash_note"',
          '  exit 0',
          'fi',
          'if ! restore_stash; then stash_note=", but stash could not be re-applied cleanly - resolve conflicts manually"; fi',
          'if printf "%s" "$rebase_output" | grep -q "is up to date"; then',
          '  printf "status=success\\nmessage=Already up to date%s\\n" "$stash_note"',
          'else',
          '  printf "status=success\\nmessage=Rebased on %s successfully%s\\n" "$branch" "$stash_note"',
          'fi',
        ].join('\n'),
        { purpose: { kind: 'interactive' } }
      );
      const values = parseKeyValueOutput(output);
      return {
        success: values.get('status') === 'success',
        message: values.get('message') || 'Rebase failed',
      };
    } catch (error) {
      return { success: false, message: parseRemoteGitError(error, 'Rebase failed') };
    }
  }

  async push(
    backend: SshWorkspaceBackend
  ): Promise<{ success: boolean; message: string; errorCode?: 'rejected' }> {
    const host = sshWorkspaceService.getHost(backend.hostId);
    try {
      const output = await sshWorkspaceService.run(
        host,
        [
          `cd ${shellQuotePosix(backend.remoteDirectory)}`,
          'branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || printf "")',
          'if [ -z "$branch" ] || [ "$branch" = HEAD ]; then printf "status=failed\\nmessage=No current branch\\n"; exit 0; fi',
          'if upstream=$(git rev-parse --abbrev-ref "${branch}@{upstream}" 2>/dev/null); then has_remote=true; else has_remote=false; fi',
          'unpushed=0',
          'if [ "$has_remote" = true ]; then unpushed=$(git rev-list --count "$upstream..$branch" 2>/dev/null || printf "0"); fi',
          'if ! push_output=$(git push -u origin "$branch" 2>&1); then',
          '  if printf "%s" "$push_output" | grep -Eq "non-fast-forward|fetch first|\\[rejected\\]"; then',
          '    printf "status=rejected\\nmessage=Remote has new commits\\n"',
          '  else',
          '    printf "status=failed\\nmessage=%s\\n" "$push_output"',
          '  fi',
          '  exit 0',
          'fi',
          'if [ "$has_remote" != true ]; then',
          '  printf "status=success\\nmessage=Published %s to origin\\n" "$branch"',
          'elif [ "$unpushed" = 0 ]; then',
          '  printf "status=success\\nmessage=Already up to date\\n"',
          'else',
          '  printf "status=success\\nmessage=Pushed %s commit(s) to origin\\n" "$unpushed"',
          'fi',
        ].join('\n')
      );
      const values = parseKeyValueOutput(output);
      const status = values.get('status');
      return {
        success: status === 'success',
        message: values.get('message') || 'Push failed',
        ...(status === 'rejected' ? { errorCode: 'rejected' as const } : {}),
      };
    } catch (error) {
      return { success: false, message: parseRemoteGitError(error, 'Push failed') };
    }
  }

  async pull(backend: SshWorkspaceBackend): Promise<{ success: boolean; message: string }> {
    const host = sshWorkspaceService.getHost(backend.hostId);
    try {
      const output = await sshWorkspaceService.run(
        host,
        [
          `cd ${shellQuotePosix(backend.remoteDirectory)}`,
          'has_changes=false',
          'if ! git diff --quiet HEAD -- 2>/dev/null || [ -n "$(git ls-files --others --exclude-standard)" ]; then has_changes=true; fi',
          'if [ "$has_changes" = true ]; then',
          `  printf "status=uncommitted\\nmessage=%s pulling\\n" ${shellQuotePosix(UNCOMMITTED_CHANGES_PREFIX)}`,
          '  exit 0',
          'fi',
          'branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || printf "")',
          'if [ -z "$branch" ] || [ "$branch" = HEAD ]; then printf "status=failed\\nmessage=No current branch\\n"; exit 0; fi',
          'if ! git rev-parse --verify "refs/remotes/origin/$branch" >/dev/null 2>&1; then printf "status=failed\\nmessage=No remote tracking branch configured\\n"; exit 0; fi',
          'if ! pull_output=$(git pull --no-rebase origin "$branch" 2>&1); then',
          '  conflict_files=$(git diff --name-only --diff-filter=U)',
          '  if [ -n "$conflict_files" ]; then printf "status=conflicted\\nmessage=%s\\n" "$conflict_files"; exit 0; fi',
          '  printf "status=failed\\nmessage=%s\\n" "$pull_output"',
          '  exit 0',
          'fi',
          'if printf "%s" "$pull_output" | grep -q "Already up to date"; then',
          '  printf "status=success\\nmessage=Already up to date\\n"',
          'else',
          '  printf "status=success\\nmessage=Pulled from origin\\n"',
          'fi',
        ].join('\n')
      );
      const values = parseKeyValueOutput(output);
      const message = values.get('message') ?? '';
      if (values.get('status') === 'conflicted') {
        return {
          success: false,
          message: activeConflictMessage(
            'Pull',
            message.split('\n').filter(Boolean),
            'complete the merge'
          ),
        };
      }
      return {
        success: values.get('status') === 'success',
        message: stripGitTransferNoise(message) || 'Pull failed',
      };
    } catch (error) {
      return { success: false, message: parseRemoteGitError(error, 'Pull failed') };
    }
  }

  pushTargetBranch(backend: SshWorkspaceBackend) {
    return this.runTargetOperation(backend, 'push');
  }

  pullTargetBranch(backend: SshWorkspaceBackend) {
    return this.runTargetOperation(backend, 'pull');
  }

  mergeTargetBranchFromRemote(backend: SshWorkspaceBackend) {
    return this.runTargetOperation(backend, 'merge-remote');
  }

  mergeToTargetBranch(backend: SshWorkspaceBackend) {
    return this.runTargetOperation(backend, 'merge-source');
  }

  private async runTargetOperation(
    backend: SshWorkspaceBackend,
    action: 'push' | 'pull' | 'merge-remote' | 'merge-source'
  ): Promise<{ success: boolean; message: string; errorCode?: 'rejected' }> {
    const host = sshWorkspaceService.getHost(backend.hostId);
    try {
      const output = await sshWorkspaceService.run(
        host,
        [
          shellQuotePosix(getRemoteCliPath(backend)),
          `git target ${action}`,
          `-C ${shellQuotePosix(backend.remoteDirectory)}`,
          `--target ${shellQuotePosix(backend.baseBranch || 'main')}`,
        ].join(' ')
      );
      return z
        .object({
          success: z.boolean(),
          message: z.string(),
          errorCode: z.literal('rejected').optional(),
        })
        .parse(JSON.parse(output));
    } catch (error) {
      return {
        success: false,
        message: parseRemoteGitError(error, 'Target branch operation failed'),
      };
    }
  }

  async restoreFile(
    backend: SshWorkspaceBackend,
    filePath: string,
    status: string,
    oldPath?: string
  ): Promise<void> {
    assertSafeRemoteRelativePath(filePath);
    if (oldPath) assertSafeRemoteRelativePath(oldPath);

    const host = sshWorkspaceService.getHost(backend.hostId);
    const lines = [
      `cd ${shellQuotePosix(backend.remoteDirectory)}`,
      `file=${shellQuotePosix(filePath)}`,
      oldPath ? `old_file=${shellQuotePosix(oldPath)}` : 'old_file=',
      `status=${shellQuotePosix(status)}`,
      // Literal pathspecs, so a name like app/[id]/page.tsx isn't a pattern matching others.
      'case "$status" in',
      '  modified|deleted)',
      '    git checkout HEAD -- ":(literal)$file"',
      '    ;;',
      '  added)',
      '    git rm -f -- ":(literal)$file" 2>/dev/null || rm -rf -- "$file"',
      '    ;;',
      '  untracked)',
      '    rm -rf -- "$file"',
      '    ;;',
      '  renamed)',
      // Only undo a rename whose previous path is still gone from disk.
      '    if [ -n "$old_file" ] && [ ! -e "$old_file" ]; then',
      '      git checkout HEAD -- ":(literal)$old_file" &&',
      '        { git rm -f --quiet -- ":(literal)$file" 2>/dev/null || rm -rf -- "$file"; }',
      '    else',
      '      git checkout HEAD -- ":(literal)$file"',
      '    fi',
      '    ;;',
      '  *)',
      '    git checkout HEAD -- ":(literal)$file"',
      '    ;;',
      'esac',
    ];
    await sshWorkspaceService.run(host, lines.join('\n'));
  }

  async discardAllChanges(
    backend: SshWorkspaceBackend
  ): Promise<{ success: boolean; message: string }> {
    const host = sshWorkspaceService.getHost(backend.hostId);
    try {
      await sshWorkspaceService.run(
        host,
        [
          `cd ${shellQuotePosix(backend.remoteDirectory)}`,
          'if ! git diff --quiet HEAD -- 2>/dev/null || [ -n "$(git ls-files --others --exclude-standard)" ]; then',
          '  git reset --hard HEAD',
          '  git clean -fd',
          'fi',
        ].join('\n')
      );
      return { success: true, message: 'Discarded all changes' };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to discard changes',
      };
    }
  }
}

export const sshWorkspaceGit = new SshWorkspaceGit();
