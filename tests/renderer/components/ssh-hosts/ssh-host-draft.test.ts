/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';

import {
  applySshHostInput,
  EMPTY_DRAFT,
  draftToHost,
  formatExtraSshArgs,
  parseExtraSshArgs,
  parseSshHostInput,
  tmuxUpgradeRecommended,
  validateDraft,
} from '../../../../src/renderer/components/ssh-hosts/ssh-host-draft';

describe('SSH extra argument formatting', () => {
  it('round-trips arguments containing spaces, quotes, and backslashes', () => {
    const args = [
      '-o',
      'ProxyCommand="ssh -W %h:%p bastion"',
      '-o',
      String.raw`ControlPath=C:\ssh sockets\%r@%h:%p`,
    ];

    expect(parseExtraSshArgs(formatExtraSshArgs(args))).toEqual(args);
  });

  it('ignores empty lines while preserving spaces within an argument', () => {
    expect(parseExtraSshArgs('-o\n\nProxyCommand=ssh -W %h:%p bastion\n')).toEqual([
      '-o',
      'ProxyCommand=ssh -W %h:%p bastion',
    ]);
  });
});

describe('tmux upgrade recommendation', () => {
  it.each(['tmux 3.3a', 'tmux 3.2', 'tmux 2.9a', 'tmux 1.8'])(
    'recommends 3.4 over %s',
    (version) => {
      expect(tmuxUpgradeRecommended(version)).toBe(true);
    }
  );

  it.each(['tmux 3.4', 'tmux 3.5a', 'tmux next-3.6', 'tmux 10.0', 'tmux master', undefined])(
    'does not recommend an upgrade for %s',
    (version) => {
      expect(tmuxUpgradeRecommended(version)).toBe(false);
    }
  );
});

describe('SSH host input', () => {
  it.each([
    ['deploy@server:2222', { hostname: 'server', user: 'deploy', port: '2222' }],
    ['deploy@server', { hostname: 'server', user: 'deploy' }],
    ['server:2222', { hostname: 'server', port: '2222' }],
    ['ssh://deploy@server:2222/', { hostname: 'server', user: 'deploy', port: '2222' }],
    ['ssh://server', { hostname: 'server' }],
    ['[fe80::1]:2222', { hostname: 'fe80::1', port: '2222' }],
    ['deploy@fe80::1', { hostname: 'fe80::1', user: 'deploy' }],
  ])('splits %s', (input, expected) => {
    expect(parseSshHostInput(input)).toEqual(expected);
  });

  it.each(['server', 'fe80::1', 'server:ssh', ''])('leaves %j alone', (input) => {
    expect(parseSshHostInput(input)).toBeNull();
  });

  it('moves the user and port into their fields', () => {
    expect(
      applySshHostInput({ ...EMPTY_DRAFT, hostname: ' deploy@server:2222 ', user: 'old' })
    ).toMatchObject({ hostname: 'server', user: 'deploy', port: '2222' });
    expect(applySshHostInput({ ...EMPTY_DRAFT, hostname: 'server', user: 'kept' })).toMatchObject({
      hostname: 'server',
      user: 'kept',
    });
  });
});

describe('SSH host drafts', () => {
  it('names an unnamed host after its address', () => {
    const draft = { ...EMPTY_DRAFT, hostname: 'devbox' };

    expect(validateDraft(draft, 'ssh-1')).toBeNull();
    expect(draftToHost(draft, 'ssh-1')).toMatchObject({ id: 'ssh-1', name: 'devbox' });
  });

  it('asks for a host', () => {
    expect(validateDraft({ ...EMPTY_DRAFT, name: 'Devbox' }, 'ssh-1')).toBe('Host is required.');
    expect(validateDraft({ ...EMPTY_DRAFT, hostname: 'deploy@server' }, 'ssh-1')).toBe(
      'Host must not include a username, port, URL, or path.'
    );
  });
});
