import { describe, expect, it } from 'vitest';

import {
  opensshMarksServerPrompts,
  sshKeyPathFromPrompt,
} from '../../../src/main/lib/ssh-askpass-prompt';

describe('sshKeyPathFromPrompt', () => {
  it('returns the key file ssh is loading', () => {
    expect(sshKeyPathFromPrompt("Enter passphrase for key '/home/me/.ssh/id_ed25519': ")).toBe(
      '/home/me/.ssh/id_ed25519'
    );
    expect(sshKeyPathFromPrompt("Enter passphrase for key '/home/me/my key's/id_rsa': ")).toBe(
      "/home/me/my key's/id_rsa"
    );
  });

  it('rejects keyboard-interactive prompts, which the server writes', () => {
    expect(
      sshKeyPathFromPrompt(
        "(git@example.com) Enter passphrase for key '/home/me/.ssh/id_ed25519': "
      )
    ).toBeNull();
  });

  it('rejects host passwords and other prompts', () => {
    expect(sshKeyPathFromPrompt("me@example.com's password: ")).toBeNull();
    expect(sshKeyPathFromPrompt('Password: ')).toBeNull();
    expect(sshKeyPathFromPrompt('Enter passphrase for /home/me/.ssh/id_ed25519: ')).toBeNull();
    expect(
      sshKeyPathFromPrompt("Enter passphrase for key '/home/me/.ssh/id_ed25519':\nPassword: ")
    ).toBeNull();
  });

  it('rejects paths Komla cannot find the same way ssh did', () => {
    expect(sshKeyPathFromPrompt("Enter passphrase for key 'keys/id_ed25519': ")).toBeNull();
    const cutByssh = `/home/me/${'k'.repeat(91)}`;
    expect(sshKeyPathFromPrompt(`Enter passphrase for key '${cutByssh}': `)).toBeNull();
  });

  it('measures the length ssh cuts in bytes', () => {
    // 70 characters, but 130 bytes in UTF-8
    const cutByssh = `/home/${'ø'.repeat(60)}/id_rsa`;
    expect(sshKeyPathFromPrompt(`Enter passphrase for key '${cutByssh}': `)).toBeNull();
  });

  it('accepts only drive-letter paths on Windows', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    try {
      expect(
        sshKeyPathFromPrompt("Enter passphrase for key 'C:\\Users\\me/.ssh/id_ed25519': ")
      ).toBe('C:\\Users\\me/.ssh/id_ed25519');
      expect(
        sshKeyPathFromPrompt("Enter passphrase for key '/c/Users/me/.ssh/id_ed25519': ")
      ).toBeNull();
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });
});

describe('opensshMarksServerPrompts', () => {
  it('accepts OpenSSH 8.4 and later', () => {
    expect(opensshMarksServerPrompts('OpenSSH_8.4p1 Debian-5, OpenSSL 1.1.1n')).toBe(true);
    expect(opensshMarksServerPrompts('OpenSSH_10.0p2 Debian-7, OpenSSL 3.5.7')).toBe(true);
    expect(opensshMarksServerPrompts('OpenSSH_for_Windows_9.5p1, LibreSSL 3.8.2')).toBe(true);
  });

  it('rejects older or unrecognized clients', () => {
    expect(opensshMarksServerPrompts('OpenSSH_8.2p1 Ubuntu-4ubuntu0.5, OpenSSL 1.1.1f')).toBe(
      false
    );
    expect(opensshMarksServerPrompts('OpenSSH_for_Windows_8.1p1, LibreSSL 3.0.2')).toBe(false);
    expect(opensshMarksServerPrompts('ssh: command not found')).toBe(false);
  });
});
