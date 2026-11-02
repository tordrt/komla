import { afterEach, describe, expect, it, vi } from 'vitest';

const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }));

vi.mock('child_process', () => ({ execFile }));
vi.mock('../../../../src/main/services/git/git-exec', () => ({
  buildGitEnv: () => ({}),
  extractGitError: (error: { stderr?: string }, fallback: string) => error.stderr || fallback,
}));

import { gitIdentityService } from '../../../../src/main/services/git/git-identity';

type Callback = (error: Error | null, result?: { stdout: string; stderr: string }) => void;

describe('gitIdentityService', () => {
  afterEach(() => {
    execFile.mockReset();
  });

  // A git still running holds the global config open, and Windows can't delete an open file.
  it("waits for every git it started before reporting git's reason", async () => {
    let finishCommitterCheck: (() => void) | undefined;
    execFile.mockImplementation(
      (_file: string, args: string[], _options: unknown, callback: Callback) => {
        if (args[1] === 'GIT_AUTHOR_IDENT') {
          callback(Object.assign(new Error('git var failed'), { stderr: 'bad name' }));
        } else if (args[1] === 'GIT_COMMITTER_IDENT') {
          finishCommitterCheck = () => callback(null, { stdout: '', stderr: '' });
        } else {
          callback(null, { stdout: '', stderr: '' });
        }
      }
    );
    const settled = vi.fn();

    const saving = gitIdentityService.setGlobal('Ada', 'ada@example.com').catch(settled);
    await vi.waitFor(() => expect(finishCommitterCheck).toBeDefined());
    await new Promise((resolve) => setImmediate(resolve));

    expect(settled).not.toHaveBeenCalled();
    finishCommitterCheck?.();
    await saving;
    expect(settled).toHaveBeenCalledWith(new Error('bad name'));
  });
});
