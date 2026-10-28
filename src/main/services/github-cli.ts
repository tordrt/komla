import { homedir } from 'os';

import { MISSING_COMMAND_ERROR } from '../lib/missing-command';

import { runLocalCommand } from './workspace-command';

// gh runs in the user's shell, as for the pull request status item: an app opened from the Dock
// or Finder doesn't have the PATH that finds it.
const CHECK_TIMEOUT_MS = 10_000;
const CREATE_TIMEOUT_MS = 30_000;
const MAX_OUTPUT = 64 * 1024;
/** A GitHub repository name, optionally after its owner, that every shell reads literally. */
const REPO_NAME = /^(?:[\w.][\w.-]*\/)?[\w.][\w.-]*$/;

export interface GhAuthStatus {
  authenticated: boolean;
  installed: boolean;
  username?: string;
}

export async function checkGhAuth(): Promise<GhAuthStatus> {
  try {
    const output = await runLocalCommand(homedir(), 'gh auth status --active', {
      timeoutMs: CHECK_TIMEOUT_MS,
      maxOutput: MAX_OUTPUT,
    });
    // "Logged in to github.com account <username>"
    return { authenticated: true, installed: true, username: output.match(/account\s+(\S+)/)?.[1] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { authenticated: false, installed: !MISSING_COMMAND_ERROR.test(message) };
  }
}

/** Creates an empty repository on GitHub and returns its URL. */
export async function createGithubRepo(name: string, isPrivate: boolean): Promise<string> {
  if (!REPO_NAME.test(name)) {
    throw new Error('Use only letters, numbers, ".", "-" and "_" in the repository name.');
  }
  const visibility = isPrivate ? '--private' : '--public';
  const output = await runLocalCommand(homedir(), `gh repo create ${name} ${visibility}`, {
    timeoutMs: CREATE_TIMEOUT_MS,
    maxOutput: MAX_OUTPUT,
  });
  const url = output.trim().split(/\s+/).pop();
  if (!url) throw new Error('gh created the repository but printed no URL');
  return url;
}
