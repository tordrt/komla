import { execFile } from 'child_process';
import { tmpdir } from 'os';
import { dirname } from 'path';
import { promisify } from 'util';

import { buildGitEnv, extractGitError } from './git-exec';

import type { GitIdentityStatus } from '../../../shared/types/git-identity';

const execFileAsync = promisify(execFile);

/**
 * Runs git outside any repository, so a repo-local identity can't hide a missing global
 * one. git doesn't search above the temp folder, which on Windows sits inside the home
 * folder (sometimes a repository). Called directly rather than through gitExec, whose
 * per-folder lock would run these unrelated commands one at a time.
 */
async function runGitOutsideRepo(args: string[]): Promise<string> {
  const cwd = tmpdir();
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      encoding: 'utf-8',
      env: buildGitEnv({ GIT_CEILING_DIRECTORIES: dirname(cwd) }),
    });
    return stdout.trim();
  } catch (error: unknown) {
    throw new Error(extractGitError(error, 'Git command failed'));
  }
}

// `git var` fails exactly when a commit would fail with "Author identity unknown".
async function assertCanCommit(): Promise<void> {
  await Promise.all([
    runGitOutsideRepo(['var', 'GIT_AUTHOR_IDENT']),
    runGitOutsideRepo(['var', 'GIT_COMMITTER_IDENT']),
  ]);
}

/**
 * The name and email git puts on commits. A fresh git install (common on Windows)
 * has neither and often cannot guess an email, so every commit fails until they are set.
 */
class GitIdentityService {
  async getStatus(): Promise<GitIdentityStatus> {
    const readGlobal = (key: string) =>
      runGitOutsideRepo(['config', '--global', '--includes', '--get', key]).then(
        (value) => value || undefined,
        () => undefined
      );

    const [canCommit, userName, userEmail] = await Promise.all([
      assertCanCommit().then(
        () => true,
        () => false
      ),
      readGlobal('user.name'),
      readGlobal('user.email'),
    ]);
    return {
      canCommit,
      ...(userName ? { userName } : {}),
      ...(userEmail ? { userEmail } : {}),
    };
  }

  /** Saves the identity, then fails with git's reason if git still can't commit with it. */
  async setGlobal(userName: string, userEmail: string): Promise<void> {
    await runGitOutsideRepo(['config', '--global', 'user.name', userName]);
    await runGitOutsideRepo(['config', '--global', 'user.email', userEmail]);
    await assertCanCommit();
  }
}

export const gitIdentityService = new GitIdentityService();
