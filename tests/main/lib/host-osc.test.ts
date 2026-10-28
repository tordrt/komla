import { describe, it, expect } from 'vitest';

import { extractHostOsc, isLocalHost, splitPendingOsc } from '../../../src/main/lib/host-osc';

describe('extractHostOsc', () => {
  it('returns null hostname and unchanged data when no OSC is present', () => {
    const input = 'user@host:~/repo$ ls\r\nfile.txt\r\n';
    const { hostname, cleaned } = extractHostOsc(input);
    expect(hostname).toBeNull();
    expect(cleaned).toBe(input);
  });

  it('extracts hostname and strips the OSC terminated by BEL', () => {
    const input = `\x1b]7337;host=komla-vm\x07user@komla-vm:~$ `;
    const { hostname, cleaned } = extractHostOsc(input);
    expect(hostname).toBe('komla-vm');
    expect(cleaned).toBe('user@komla-vm:~$ ');
  });

  it('extracts hostname when OSC is terminated by ST (ESC \\)', () => {
    const input = `prefix\x1b]7337;host=remote\x1b\\suffix`;
    const { hostname, cleaned } = extractHostOsc(input);
    expect(hostname).toBe('remote');
    expect(cleaned).toBe('prefixsuffix');
  });

  it('returns the last hostname when multiple OSCs appear in one chunk', () => {
    const input = `\x1b]7337;host=first\x07mid\x1b]7337;host=second\x07`;
    const { hostname, cleaned } = extractHostOsc(input);
    expect(hostname).toBe('second');
    expect(cleaned).toBe('mid');
  });

  it('strips OSC cleanly when it is the entire chunk', () => {
    const input = `\x1b]7337;host=lima-komla-vm\x07`;
    const { hostname, cleaned } = extractHostOsc(input);
    expect(hostname).toBe('lima-komla-vm');
    expect(cleaned).toBe('');
  });
});

describe('splitPendingOsc', () => {
  it('passes data through unchanged when no OSC prefix is present', () => {
    const input = 'user@host:~$ ls\r\nfile.txt\r\n';
    expect(splitPendingOsc(input)).toEqual({ ready: input, carry: '' });
  });

  it('returns no carry when every OSC is terminated by BEL', () => {
    const input = `\x1b]7337;host=one\x07middle\x1b]7337;host=two\x07`;
    expect(splitPendingOsc(input)).toEqual({ ready: input, carry: '' });
  });

  it('returns no carry when the last OSC is terminated by ST (ESC \\)', () => {
    const input = `\x1b]7337;host=remote\x1b\\tail`;
    expect(splitPendingOsc(input)).toEqual({ ready: input, carry: '' });
  });

  it('carries an unterminated trailing OSC 7337 prefix', () => {
    const input = `foo\x1b]7337;host=komla-v`;
    expect(splitPendingOsc(input)).toEqual({
      ready: 'foo',
      carry: '\x1b]7337;host=komla-v',
    });
  });

  it('carries even a bare ESC-] at end of chunk (could be the start of 7337)', () => {
    const input = `trailing\x1b]`;
    expect(splitPendingOsc(input)).toEqual({ ready: 'trailing', carry: '\x1b]' });
  });

  it('carries a trailing ESC that could begin an OSC in the next chunk', () => {
    const input = `trailing\x1b`;
    expect(splitPendingOsc(input)).toEqual({ ready: 'trailing', carry: '\x1b' });
  });

  it('rejoins a split OSC 7337 when combined across two chunks', () => {
    const chunk1 = `prefix\x1b]7337;host=komla-s`;
    const { ready: r1, carry } = splitPendingOsc(chunk1);
    expect(r1).toBe('prefix');

    const chunk2 = `taging\x07suffix`;
    const { ready: r2, carry: carry2 } = splitPendingOsc(carry + chunk2);
    expect(carry2).toBe('');
    const { hostname, cleaned } = extractHostOsc(r2);
    expect(hostname).toBe('komla-staging');
    expect(cleaned).toBe('suffix');
  });

  it('flushes carry instead of hoarding when it would exceed the cap', () => {
    const input = '\x1b]' + 'x'.repeat(5000);
    const { ready, carry } = splitPendingOsc(input);
    expect(carry).toBe('');
    expect(ready).toBe(input);
  });
});

describe('isLocalHost', () => {
  it('treats an SSH terminal pool marker as another host', () => {
    expect(isLocalHost('ssh:host-1')).toBe(false);
  });

  it('treats any other marker as this machine', () => {
    expect(isLocalHost('my-laptop')).toBe(true);
  });
});
