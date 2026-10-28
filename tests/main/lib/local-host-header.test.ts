import { describe, expect, it } from 'vitest';

import { isLocalHostHeader } from '../../../src/main/lib/local-host-header';

describe('isLocalHostHeader', () => {
  it.each([
    '127.0.0.1:52863',
    'localhost:52863',
    'LOCALHOST:52863',
    'localhost',
    'app.localhost:3000',
    '[::1]:52863',
    // SSH tunnels arrive on another port.
    '127.0.0.1:61234',
    '192.168.5.2:52863',
  ])('accepts %s', (host) => {
    expect(isLocalHostHeader(host)).toBe(true);
  });

  it('accepts requests without a Host, which browsers always send', () => {
    expect(isLocalHostHeader(undefined)).toBe(true);
    expect(isLocalHostHeader('')).toBe(true);
  });

  it.each([
    'evil.example:52863',
    'evil.example',
    'localhost.evil.example:52863',
    'host.docker.internal:52863',
    'host.lima.internal:52863',
    'evil.example@127.0.0.1',
    '127.0.0.1/evil',
    'local host',
  ])('rejects %s', (host) => {
    expect(isLocalHostHeader(host)).toBe(false);
  });
});
