import { describe, expect, it } from 'vitest';

import {
  cloneUrlFor,
  switchCloneProtocol,
  urlProtocol,
} from '../../../../src/renderer/components/projects/clone-url';

describe('cloneUrlFor', () => {
  it.each([
    ['https://github.com/acme/widgets', 'git@github.com:acme/widgets.git'],
    ['https://github.com/acme/widgets.git', 'git@github.com:acme/widgets.git'],
    ['http://www.GitHub.com/acme/widgets/', 'git@github.com:acme/widgets.git'],
    ['https://github.com/acme/widgets/tree/main/src', 'git@github.com:acme/widgets.git'],
    ['https://github.com/acme/widgets?tab=readme-ov-file#setup', 'git@github.com:acme/widgets.git'],
    ['https://github.com/acme/next.js', 'git@github.com:acme/next.js.git'],
    ['https://gitlab.com/group/sub/widgets', 'git@gitlab.com:group/sub/widgets.git'],
    ['https://gitlab.com/group/sub/widgets/-/tree/main', 'git@gitlab.com:group/sub/widgets.git'],
    ['https://devuser@bitbucket.org/acme/widgets.git', 'git@bitbucket.org:acme/widgets.git'],
    ['https://bitbucket.org/acme/widgets/src/main/', 'git@bitbucket.org:acme/widgets.git'],
    ['  git@github.com:acme/widgets.git  ', 'git@github.com:acme/widgets.git'],
  ])('clones %s over SSH as %s', (input, expected) => {
    expect(cloneUrlFor(input, 'ssh')).toBe(expected);
  });

  it.each([
    ['git@github.com:acme/widgets.git', 'https://github.com/acme/widgets.git'],
    ['https://github.com/acme/widgets/pull/12', 'https://github.com/acme/widgets.git'],
    ['https://devuser@bitbucket.org/acme/widgets.git', 'https://devuser@bitbucket.org/acme/widgets.git'],
    ['git@gitlab.com:group/sub/widgets.git', 'https://gitlab.com/group/sub/widgets.git'],
  ])('clones %s over HTTPS as %s', (input, expected) => {
    expect(cloneUrlFor(input, 'https')).toBe(expected);
  });

  it.each([
    // Self-hosted servers may use another SSH user or port.
    'https://git.example.com/acme/widgets.git',
    'git@git.example.com:acme/widgets.git',
    'https://github.com:8443/acme/widgets.git',
    'deploy@github.com:acme/widgets.git',
    // Not a repo page.
    'https://github.com/acme',
    'https://github.com/',
    'https://gitlab.com/group/-/issues',
    'ftp://github.com/acme/widgets.git',
    // Validation rejects an uppercase scheme.
    'HTTPS://github.com/acme/widgets',
    // A token is neither dropped nor shown in the hint.
    'https://x-access-token:ghp_abc@github.com/acme/widgets.git',
  ])('clones %s as entered', (input) => {
    expect(cloneUrlFor(input, 'ssh')).toBe(input);
    expect(cloneUrlFor(input, 'https')).toBe(input);
  });
});

describe('switchCloneProtocol', () => {
  it('rewrites a self-hosted URL the user switches explicitly', () => {
    expect(switchCloneProtocol('https://git.example.com/acme/widgets', 'ssh')).toBe(
      'git@git.example.com:acme/widgets.git'
    );
    expect(switchCloneProtocol('git@git.example.com:acme/widgets.git', 'https')).toBe(
      'https://git.example.com/acme/widgets.git'
    );
  });

  it('cleans up a browser link to a known host', () => {
    expect(switchCloneProtocol('git@github.com:acme/widgets.git', 'https')).toBe(
      'https://github.com/acme/widgets.git'
    );
    expect(switchCloneProtocol('https://github.com/acme/widgets/tree/main', 'ssh')).toBe(
      'git@github.com:acme/widgets.git'
    );
  });

  it('leaves a URL already in that protocol, or not a URL, unchanged', () => {
    expect(switchCloneProtocol('git@git.example.com:acme/widgets.git', 'ssh')).toBe(
      'git@git.example.com:acme/widgets.git'
    );
    expect(switchCloneProtocol('not a url', 'https')).toBe('not a url');
    expect(switchCloneProtocol('https://bob:secret@git.example.com/acme/widgets', 'ssh')).toBe(
      'https://bob:secret@git.example.com/acme/widgets'
    );
  });
});

describe('urlProtocol', () => {
  it('reads the protocol a URL clones over', () => {
    expect(urlProtocol('https://git.example.com/a/b.git')).toBe('https');
    expect(urlProtocol('http://git.example.com/a/b.git')).toBe('https');
    expect(urlProtocol('HTTPS://git.example.com/a/b.git')).toBeNull();
    expect(urlProtocol('git@git.example.com:a/b.git')).toBe('ssh');
    expect(urlProtocol('ftp://git.example.com/a/b.git')).toBeNull();
  });
});
