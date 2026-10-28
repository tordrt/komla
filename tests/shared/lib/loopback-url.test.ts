import { describe, expect, it } from 'vitest';

import {
  isLoopbackUrl,
  normalizeLocalDevServerUrl,
  parseLoopbackUrl,
} from '../../../src/shared/lib/loopback-url';

describe('loopback-url', () => {
  describe('normalizeLocalDevServerUrl', () => {
    it('rewrites an all-interfaces host to localhost', () => {
      expect(normalizeLocalDevServerUrl('http://0.0.0.0:3000/path?q=1#section')).toBe(
        'http://localhost:3000/path?q=1#section'
      );
      expect(normalizeLocalDevServerUrl('http://[::]:8000/')).toBe('http://localhost:8000/');
    });

    it('leaves other and malformed URLs unchanged', () => {
      expect(normalizeLocalDevServerUrl('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000');
      expect(normalizeLocalDevServerUrl('https://example.com')).toBe('https://example.com');
      expect(normalizeLocalDevServerUrl('not a url')).toBe('not a url');
    });
  });

  describe('isLoopbackUrl', () => {
    it('accepts http://localhost variants', () => {
      expect(isLoopbackUrl('http://localhost')).toBe(true);
      expect(isLoopbackUrl('http://localhost:3000')).toBe(true);
      expect(isLoopbackUrl('http://localhost:5173/')).toBe(true);
      expect(isLoopbackUrl('http://localhost:5173/path?q=1')).toBe(true);
    });

    it('accepts 127.0.0.1', () => {
      expect(isLoopbackUrl('http://127.0.0.1')).toBe(true);
      expect(isLoopbackUrl('http://127.0.0.1:8080')).toBe(true);
    });

    it('accepts https on loopback', () => {
      expect(isLoopbackUrl('https://localhost:8443')).toBe(true);
    });

    it('rejects non-loopback hostnames', () => {
      expect(isLoopbackUrl('http://example.com')).toBe(false);
      expect(isLoopbackUrl('http://github.com')).toBe(false);
      // 127.x is not all loopback for our purposes — keep the allowlist tight.
      expect(isLoopbackUrl('http://127.0.0.2')).toBe(false);
      expect(isLoopbackUrl('http://0.0.0.0:3000')).toBe(false);
      expect(isLoopbackUrl('http://[::1]:8080')).toBe(false);
    });

    it('rejects non-http(s) protocols', () => {
      expect(isLoopbackUrl('file://localhost/etc/passwd')).toBe(false);
      expect(isLoopbackUrl('ftp://localhost')).toBe(false);
      expect(isLoopbackUrl('javascript:alert(1)')).toBe(false);
    });

    it('rejects malformed input', () => {
      expect(isLoopbackUrl('')).toBe(false);
      expect(isLoopbackUrl('localhost:3000')).toBe(false); // no protocol — not a valid URL
      expect(isLoopbackUrl('not a url')).toBe(false);
    });
  });

  describe('parseLoopbackUrl', () => {
    it('returns the URL object on success', () => {
      const url = parseLoopbackUrl('http://localhost:5173/path');
      expect(url).not.toBeNull();
      expect(url?.hostname).toBe('localhost');
      expect(url?.port).toBe('5173');
      expect(url?.pathname).toBe('/path');
    });

    it('returns null on rejection', () => {
      expect(parseLoopbackUrl('http://evil.com')).toBeNull();
    });
  });
});
