import { beforeEach, describe, expect, it, vi } from 'vitest';

const runLocalCommand = vi.hoisted(() => vi.fn());

vi.mock('../../../src/main/services/workspace-command', () => ({ runLocalCommand }));

import { checkGhAuth, createGithubRepo } from '../../../src/main/services/github-cli';

describe('github-cli', () => {
  beforeEach(() => {
    runLocalCommand.mockReset();
  });

  it("runs gh in the user's shell and reads the account it is signed in to", async () => {
    runLocalCommand.mockResolvedValue(
      'github.com\n  ✓ Logged in to github.com account octocat (keyring)\n'
    );

    await expect(checkGhAuth()).resolves.toEqual({
      authenticated: true,
      installed: true,
      username: 'octocat',
    });
    expect(runLocalCommand).toHaveBeenCalledWith(
      expect.any(String),
      'gh auth status --active',
      expect.objectContaining({ maxOutput: expect.any(Number) })
    );
  });

  it('reports gh missing when the shell has no such command', async () => {
    runLocalCommand.mockRejectedValue(new Error('zsh:1: command not found: gh'));

    await expect(checkGhAuth()).resolves.toEqual({ authenticated: false, installed: false });
  });

  it('reports gh signed out when it is installed', async () => {
    runLocalCommand.mockRejectedValue(
      new Error('You are not logged into any GitHub hosts. To log in, run: gh auth login')
    );

    await expect(checkGhAuth()).resolves.toEqual({ authenticated: false, installed: true });
  });

  it('creates the repository and returns the URL gh prints', async () => {
    runLocalCommand.mockResolvedValue('https://github.com/octocat/komla-services\n');

    await expect(createGithubRepo('komla-services', true)).resolves.toBe(
      'https://github.com/octocat/komla-services'
    );
    expect(runLocalCommand).toHaveBeenCalledWith(
      expect.any(String),
      'gh repo create komla-services --private',
      expect.anything()
    );
  });

  it.each(['my repo', 'a;rm -rf ~', '$(id)', '-flag', 'owner/-flag', ''])(
    'rejects %j as a repository name before reaching the shell',
    async (name) => {
      await expect(createGithubRepo(name, false)).rejects.toThrow('repository name');
      expect(runLocalCommand).not.toHaveBeenCalled();
    }
  );
});
