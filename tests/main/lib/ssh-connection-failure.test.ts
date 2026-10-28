import { describe, expect, it } from 'vitest';

import { sshConnectionFailure } from '../../../src/main/lib/ssh-connection-failure';

describe('sshConnectionFailure', () => {
  it('reads ssh’s own error from the last line it printed', () => {
    expect(
      sshConnectionFailure(
        255,
        'ssh: Could not resolve hostname devbox: Temporary failure in name resolution\r\n'
      )
    ).toBe('ssh: Could not resolve hostname devbox: Temporary failure in name resolution');
  });

  it('skips the session output above a dropped connection and its escape sequences', () => {
    expect(
      sshConnectionFailure(
        255,
        '\x1b[?1049h\x1b[32m$ npm test\x1b[0m\r\n\x1b]0;title\x07\x1b[?1049l\r\nclient_loop: send disconnect: Broken pipe\r\n\r\n'
      )
    ).toBe('client_loop: send disconnect: Broken pipe');
  });

  it('finds the error under a tmux screen drawn with cursor moves', () => {
    const rows = Array.from(
      { length: 5 },
      (_, row) => `\x1b[${row + 1};1H\x1b(B\x1b[m$ npm test row ${row} ${'.'.repeat(60)}`
    ).join('');
    const status = '\x1b[24;1H\x1b[42m[0] 0:claude*  "devbox" 14:02\x1b[0m';

    expect(
      sshConnectionFailure(
        255,
        `${rows}${status}\x1b[23;1Hclient_loop: send disconnect: Broken pipe\r\n`
      )
    ).toBe('client_loop: send disconnect: Broken pipe');
  });

  it('strips two-byte escapes such as a character set or saved cursor', () => {
    expect(
      sshConnectionFailure(255, '\x1b(B\x1b7\x1b=Timeout, server devbox not responding.\x1b8\r\n')
    ).toBe('Timeout, server devbox not responding.');
  });

  it('says the connection failed when ssh printed nothing', () => {
    expect(sshConnectionFailure(255, '\x1b[?25h\r\n')).toBe('The SSH connection failed.');
  });

  it('ignores exits of the remote command, which ssh passes through', () => {
    expect(sshConnectionFailure(0, 'logout\r\n')).toBeUndefined();
    expect(sshConnectionFailure(1, 'error: something\r\n')).toBeUndefined();
  });

  it('caps a long line, keeping its end, where ssh’s error is', () => {
    const message = sshConnectionFailure(255, `${'x'.repeat(1000)} Broken pipe\n`);
    expect(message?.length).toBeLessThanOrEqual(300);
    expect(message?.startsWith('…')).toBe(true);
    expect(message?.endsWith('Broken pipe')).toBe(true);
  });
});
