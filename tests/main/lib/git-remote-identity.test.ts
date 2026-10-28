import { describe, expect, it } from 'vitest';

import { gitRemoteIdentity } from '../../../src/main/lib/git-remote-identity';

describe('gitRemoteIdentity', () => {
  it.each([
    ['git@github.com:acme/app.git'],
    ['https://github.com/acme/app'],
    ['https://github.com/acme/app.git/'],
    ['ssh://git@github.com/acme/app.git'],
    ['ssh://git@GitHub.com:22/Acme/App.git'],
    ['  https://token@github.com/acme/app.git  '],
  ])('treats %s as github.com/acme/app', (url) => {
    expect(gitRemoteIdentity(url)).toBe('github.com/acme/app');
  });

  it('matches self-hosted remotes across HTTPS and SSH', () => {
    expect(gitRemoteIdentity('https://git.acme.dev/platform/api.git')).toBe(
      gitRemoteIdentity('ssh://git@git.acme.dev:2222/platform/api.git')
    );
    expect(gitRemoteIdentity('deploy@git.acme.dev:platform/api')).toBe('git.acme.dev/platform/api');
  });

  it('keeps different repositories apart', () => {
    expect(gitRemoteIdentity('git@github.com:acme/app.git')).not.toBe(
      gitRemoteIdentity('git@github.com:acme/app-fork.git')
    );
    expect(gitRemoteIdentity('git@github.com:acme/app.git')).not.toBe(
      gitRemoteIdentity('git@gitlab.com:acme/app.git')
    );
  });

  it('leaves local paths as they are', () => {
    expect(gitRemoteIdentity('/srv/git/App.git')).toBe('/srv/git/App.git');
    expect(gitRemoteIdentity('C:\\repos\\app')).toBe('C:\\repos\\app');
    expect(gitRemoteIdentity('file:///srv/git/app.git')).toBe('file:///srv/git/app.git');
    expect(gitRemoteIdentity('./relative/app')).toBe('./relative/app');
  });
});
