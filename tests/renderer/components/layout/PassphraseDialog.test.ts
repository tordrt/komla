import { describe, it, expect } from 'vitest';
import { parsePrompt } from '@/components/layout/PassphraseDialog';

describe('parsePrompt', () => {
  describe('host-verification', () => {
    it('parses a full SSH host verification prompt', () => {
      const prompt =
        "The authenticity of host 'github.com (140.82.121.4)' can't be established.\n" +
        'ED25519 key fingerprint is SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU.\n' +
        'Are you sure you want to continue connecting (yes/no/[fingerprint])?';

      const result = parsePrompt(prompt);

      expect(result).toEqual({
        kind: 'host-verification',
        host: 'github.com (140.82.121.4)',
        fingerprint: 'SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU',
        fullMessage: prompt,
      });
    });

    it('handles missing host info', () => {
      const prompt = 'Are you sure you want to continue connecting (yes/no)?';
      const result = parsePrompt(prompt);

      expect(result.kind).toBe('host-verification');
      if (result.kind === 'host-verification') {
        expect(result.host).toBeNull();
        expect(result.fingerprint).toBeNull();
      }
    });

    it('parses prompt with only authenticity line (no "Are you sure" text)', () => {
      const prompt =
        "The authenticity of host 'github.com (20.205.243.166)' can't be established.\n" +
        'ED25519 key fingerprint is SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU.';

      const result = parsePrompt(prompt);

      expect(result).toEqual({
        kind: 'host-verification',
        host: 'github.com (20.205.243.166)',
        fingerprint: 'SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU',
        fullMessage: prompt,
      });
    });

    it('extracts host without fingerprint', () => {
      const prompt =
        "The authenticity of host 'example.com (1.2.3.4)' can't be established.\n" +
        'Are you sure you want to continue connecting (yes/no)?';
      const result = parsePrompt(prompt);

      if (result.kind === 'host-verification') {
        expect(result.host).toBe('example.com (1.2.3.4)');
        expect(result.fingerprint).toBeNull();
      }
    });
  });

  describe('passphrase', () => {
    it('parses a standard SSH passphrase prompt', () => {
      const result = parsePrompt('Enter passphrase for /home/user/.ssh/id_rsa: ');

      expect(result).toEqual({
        kind: 'passphrase',
        keyPath: '/home/user/.ssh/id_rsa',
      });
    });

    it('handles paths with spaces', () => {
      const result = parsePrompt('Enter passphrase for /home/my user/.ssh/id_ed25519: ');

      expect(result).toEqual({
        kind: 'passphrase',
        keyPath: '/home/my user/.ssh/id_ed25519',
      });
    });

    it('shows the key path from ssh without its quotes', () => {
      const result = parsePrompt("Enter passphrase for key '/home/user/.ssh/id_ed25519': ");

      expect(result).toEqual({
        kind: 'passphrase',
        keyPath: '/home/user/.ssh/id_ed25519',
      });
    });

    it('does not show a prompt from the server as a local key', () => {
      const prompt = "(git@example.com) Enter passphrase for key '/home/user/.ssh/id_ed25519': ";

      expect(parsePrompt(prompt)).toEqual({ kind: 'unknown', displayPrompt: prompt });
    });

    it('handles Windows-style paths', () => {
      const result = parsePrompt('Enter passphrase for C:\\Users\\me\\.ssh\\id_rsa: ');

      expect(result).toEqual({
        kind: 'passphrase',
        keyPath: 'C:\\Users\\me\\.ssh\\id_rsa',
      });
    });
  });

  describe('unknown', () => {
    it('returns unknown for unrecognized prompts', () => {
      const result = parsePrompt('Password: ');

      expect(result).toEqual({
        kind: 'unknown',
        displayPrompt: 'Password: ',
      });
    });

    it('returns unknown for empty string', () => {
      const result = parsePrompt('');

      expect(result).toEqual({
        kind: 'unknown',
        displayPrompt: '',
      });
    });
  });
});
