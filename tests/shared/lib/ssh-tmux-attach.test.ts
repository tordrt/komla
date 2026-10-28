import { describe, expect, it } from 'vitest';

import {
  buildManagedTmuxAttachCommand,
  managedTmuxSearchSupported,
} from '../../../src/shared/lib/ssh-tmux-attach';

describe('buildManagedTmuxAttachCommand', () => {
  it('attaches to the managed session on the Komla tmux socket', () => {
    expect(
      buildManagedTmuxAttachCommand({ hostname: '203.0.113.10', user: 'agent' }, 'terminal-1')
    ).toBe('ssh -t agent@203.0.113.10 tmux -L komla-v1 attach-session -t komla-terminal-1');
  });

  it('omits the user when the host relies on ssh config for it', () => {
    expect(buildManagedTmuxAttachCommand({ hostname: 'hetzner' }, 'terminal-1')).toBe(
      'ssh -t hetzner tmux -L komla-v1 attach-session -t komla-terminal-1'
    );
  });

  it('carries the connection options Komla uses to reach the host', () => {
    expect(
      buildManagedTmuxAttachCommand(
        {
          hostname: 'example.com',
          user: 'dev',
          port: 2222,
          identityFile: '~/.ssh/id_ed25519',
          extraSshArgs: ['-o', 'ProxyJump=bastion'],
        },
        'terminal-1'
      )
    ).toBe(
      'ssh -t -p 2222 -i ~/.ssh/id_ed25519 -o ProxyJump=bastion dev@example.com tmux -L komla-v1 attach-session -t komla-terminal-1'
    );
  });

  it('quotes connection values that the local shell would split or expand', () => {
    expect(
      buildManagedTmuxAttachCommand(
        { hostname: 'example.com', identityFile: '/Users/me/My Keys/id_rsa' },
        'terminal-1'
      )
    ).toBe(
      "ssh -t -i '/Users/me/My Keys/id_rsa' example.com tmux -L komla-v1 attach-session -t komla-terminal-1"
    );
  });
});

describe('managedTmuxSearchSupported', () => {
  it.each(['tmux 2.6', 'tmux 3.0a', 'tmux 3.5a', 'tmux next-3.6'])('accepts %s', (version) => {
    expect(managedTmuxSearchSupported(version)).toBe(true);
  });

  // tmux before 2.6 has no user-keys, so the search input would reach the program as text.
  it.each([undefined, 'tmux 1.8', 'tmux 2.5', 'tmux master'])('rejects %s', (version) => {
    expect(managedTmuxSearchSupported(version)).toBe(false);
  });
});
