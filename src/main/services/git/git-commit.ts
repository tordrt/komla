import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { gitExec } from './git-exec';

import type {
  CommitChangesResult,
  CommitDraftResult,
  CommitScope,
  CommitScopeResult,
} from '../../../shared/types';

const MAX_DIFF_CHARS = 300_000;
const TRUNCATED_MARKER = '\n[...diff truncated...]';

function parseStatus(status: string): {
  hasChanges: boolean;
  hasStaged: boolean;
  fileCount: number;
  stagedFileCount: number;
  untracked: string[];
} {
  const records = status.split('\0').filter(Boolean);
  let hasStaged = false;
  let fileCount = 0;
  let stagedFileCount = 0;
  const untracked: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.length < 3) continue;
    const code = record.slice(0, 2);
    const path = record.slice(3);
    fileCount += 1;
    if (code[0] !== ' ' && code[0] !== '?') {
      hasStaged = true;
      stagedFileCount += 1;
    }
    if (code === '??') untracked.push(path);
    if (code[0] === 'R' || code[0] === 'C') index += 1;
  }
  return { hasChanges: fileCount > 0, hasStaged, fileCount, stagedFileCount, untracked };
}

function appendLimited(current: string, next: string): string {
  if (current.length >= MAX_DIFF_CHARS) return current;
  const remaining = MAX_DIFF_CHARS - current.length;
  return next.length <= remaining
    ? current + next
    : current + next.slice(0, remaining) + TRUNCATED_MARKER;
}

function describeUntrackedFile(filePath: string): string {
  return `\n--- untracked file: ${filePath}\n[content omitted for safety]\n`;
}

export class GitCommitService {
  private async inspectScopeDetails(
    worktreePath: string,
    requestedScope?: CommitScope
  ): Promise<
    Required<CommitScopeResult> & {
      untracked: string[];
    }
  > {
    const rawStatus = await gitExec.execGitAsyncRaw(worktreePath, [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
    ]);
    const status = parseStatus(rawStatus);
    if (!status.hasChanges) throw new Error('There are no changes to commit');

    if (requestedScope === 'staged' && !status.hasStaged) {
      throw new Error('There are no staged changes to commit');
    }

    const scope: CommitScope = requestedScope ?? (status.hasStaged ? 'staged' : 'all');
    const fileCount = scope === 'staged' ? status.stagedFileCount : status.fileCount;
    return {
      scope,
      fileCount,
      stagedFileCount: status.stagedFileCount,
      allFileCount: status.fileCount,
      untracked: status.untracked,
    };
  }

  async inspectScope(worktreePath: string): Promise<CommitScopeResult> {
    const { scope, fileCount, stagedFileCount, allFileCount } =
      await this.inspectScopeDetails(worktreePath);
    return { scope, fileCount, stagedFileCount, allFileCount };
  }

  /** Drafts a message for `scope`, or for the default scope (staged if anything is) when omitted. */
  async generateDraft(
    worktreePath: string,
    requestedScope?: CommitScope
  ): Promise<CommitDraftResult> {
    const { scope, fileCount, untracked } = await this.inspectScopeDetails(
      worktreePath,
      requestedScope
    );
    const args = scope === 'staged' ? ['diff', '--cached'] : ['diff', 'HEAD'];
    let diff: string;
    try {
      const result = await gitExec.execGitAsyncRawLimited(
        worktreePath,
        [...args, '--no-ext-diff', '--no-textconv', '--no-color', '--find-renames', '--'],
        MAX_DIFF_CHARS - TRUNCATED_MARKER.length
      );
      diff = result.output + (result.truncated ? TRUNCATED_MARKER : '');
    } catch {
      diff = '';
    }
    if (scope === 'all') {
      for (const filePath of untracked) {
        if (diff.length >= MAX_DIFF_CHARS) break;
        diff = appendLimited(diff, describeUntrackedFile(filePath));
      }
    }
    if (!diff.trim()) throw new Error('The selected commit scope has no readable changes');

    // Keep utility inference lazy so importing the Git facade has no keychain/config side effects.
    try {
      const { utilityInferenceService } = await import('../utility-inference.service');
      const draft = await utilityInferenceService.generateCommitMessage(diff);
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

  async commit(
    worktreePath: string,
    input: { subject: string; body?: string | null; scope: CommitScope }
  ): Promise<CommitChangesResult> {
    const subject = input.subject.trim();
    if (!subject) throw new Error('Commit subject is required');
    if (input.scope === 'staged') {
      const staged = await gitExec.execGitAsyncRaw(worktreePath, [
        'diff',
        '--cached',
        '--name-only',
      ]);
      if (!staged.trim()) throw new Error('There are no staged changes to commit');
    }

    const body = input.body?.trim();
    const message = body ? `${subject}\n\n${body}` : subject;
    const tempDirectory = await mkdtemp(join(tmpdir(), 'komla-commit-message-'));
    const messagePath = join(tempDirectory, 'COMMIT_EDITMSG');
    try {
      await writeFile(messagePath, message, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      const commands = [
        ['commit', '-F', messagePath],
        ['rev-parse', 'HEAD'],
      ];
      if (input.scope === 'all') commands.unshift(['add', '--all']);
      const outputs = await gitExec.execGitWriteSequence(worktreePath, commands);
      const commitHash = outputs.at(-1) ?? '';
      gitExec.invalidateCache(`hasUncommittedChanges:${worktreePath}`);
      return { commitHash, subject };
    } finally {
      await rm(tempDirectory, { recursive: true, force: true }).catch(() => {});
    }
  }
}

export const gitCommitService = new GitCommitService();
