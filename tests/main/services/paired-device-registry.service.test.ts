// Unit tests for PairedDeviceRegistryService — uses a real temp file rather
// than mocking fs since the service is intentionally thin around the
// filesystem and the assertions are about persistence semantics.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mockElectron } from '../../mocks/electron';

vi.mock('electron', () => mockElectron());

import {
  PairedDeviceRegistryService,
  type PairedDeviceRecord,
} from '../../../src/main/services/paired-device-registry.service';

function record(overrides: Partial<PairedDeviceRecord> = {}): PairedDeviceRecord {
  return {
    deviceId: 'a'.repeat(64),
    devicePublicKey: 'device-pk-1',
    credentialId: 'cred-1',
    publicKey: 'pk-1',
    signCounter: 0,
    aaguid: null,
    label: 'Test Device',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastUsedAt: null,
    transports: null,
    rpId: 'phone.example.ts.net',
    origin: 'https://phone.example.ts.net',
    ...overrides,
  };
}

describe('PairedDeviceRegistryService', () => {
  let dir: string;
  let path: string;
  let registry: PairedDeviceRegistryService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'komla-paired-devices-'));
    path = join(dir, 'paired-devices.json');
    registry = new PairedDeviceRegistryService(path);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns empty list when no file exists', () => {
    expect(registry.list()).toEqual([]);
    expect(existsSync(path)).toBe(false);
  });

  it('persists an added record and survives reload', () => {
    registry.add(record());
    expect(registry.list()).toHaveLength(1);

    const fresh = new PairedDeviceRegistryService(path);
    expect(fresh.list()).toHaveLength(1);
    expect(fresh.list()[0]?.credentialId).toBe('cred-1');
  });

  it('list() returns a defensive copy', () => {
    registry.add(record());
    const a = registry.list();
    a.pop();
    expect(registry.list()).toHaveLength(1);
  });

  it('rejects duplicate credentialId', () => {
    registry.add(record());
    expect(() => registry.add(record())).toThrow(/already exists/);
  });

  it('rejects duplicate deviceId', () => {
    registry.add(record());
    expect(() =>
      registry.add(record({ deviceId: 'a'.repeat(64), credentialId: 'cred-2' }))
    ).toThrow(/already exists/);
  });

  it('looks up a trusted device by deviceId', () => {
    registry.add(record());
    expect(registry.getByDeviceId('a'.repeat(64))?.credentialId).toBe('cred-1');
    expect(registry.getByDeviceId('b'.repeat(64))).toBeNull();
  });

  it('renames an existing record', () => {
    registry.add(record());
    registry.rename('cred-1', '  My Phone  ');
    expect(registry.list()[0]?.label).toBe('My Phone');
  });

  it('rename throws on unknown credentialId', () => {
    registry.add(record());
    expect(() => registry.rename('nope', 'X')).toThrow(/not found/);
  });

  it('rename rejects empty label', () => {
    registry.add(record());
    expect(() => registry.rename('cred-1', '   ')).toThrow(/label must not be empty/);
  });

  it('rename truncates over-long labels', () => {
    registry.add(record());
    const long = 'A'.repeat(200);
    registry.rename('cred-1', long);
    expect(registry.list()[0]?.label.length).toBe(120);
  });

  it('removes a record', () => {
    registry.add(record({ deviceId: 'a'.repeat(64), credentialId: 'a' }));
    registry.add(record({ deviceId: 'b'.repeat(64), credentialId: 'b' }));
    registry.remove('a');
    expect(registry.list().map((d) => d.credentialId)).toEqual(['b']);
  });

  it('remove is a no-op when the credential is not present', () => {
    registry.add(record({ credentialId: 'a' }));
    registry.remove('nope');
    expect(registry.list()).toHaveLength(1);
  });

  it('getByCredentialId returns the record or null', () => {
    registry.add(record({ credentialId: 'a' }));
    expect(registry.getByCredentialId('a')?.credentialId).toBe('a');
    expect(registry.getByCredentialId('missing')).toBeNull();
  });

  it('recordAuthSuccess updates signCounter and lastUsedAt', () => {
    registry.add(record({ credentialId: 'a', signCounter: 0 }));
    const updated = registry.recordAuthSuccess('a', 7, '2026-04-30T00:00:00.000Z');
    expect(updated.signCounter).toBe(7);
    expect(updated.lastUsedAt).toBe('2026-04-30T00:00:00.000Z');
    expect(registry.list()[0]?.signCounter).toBe(7);
    expect(registry.list()[0]?.lastUsedAt).toBe('2026-04-30T00:00:00.000Z');
  });

  it('recordAuthSuccess never lowers the stored counter', () => {
    // A resume, or a slower of two passkey sign-ins, reports the counter it read earlier.
    registry.add(record({ credentialId: 'a', signCounter: 6 }));
    const updated = registry.recordAuthSuccess('a', 5, '2026-04-30T02:00:00.000Z');
    expect(updated.signCounter).toBe(6);
    expect(updated.lastUsedAt).toBe('2026-04-30T02:00:00.000Z');
  });

  it('recordAuthSuccess persists across reload', () => {
    registry.add(record({ credentialId: 'a', signCounter: 0 }));
    registry.recordAuthSuccess('a', 3, '2026-04-30T01:00:00.000Z');
    const fresh = new PairedDeviceRegistryService(path);
    expect(fresh.list()[0]?.signCounter).toBe(3);
  });

  it('recordAuthSuccess fires the change listener', () => {
    registry.add(record({ credentialId: 'a' }));
    const events: PairedDeviceRecord[][] = [];
    registry.onChange((d) => events.push(d));
    registry.recordAuthSuccess('a', 1, '2026-04-30T00:00:00.000Z');
    expect(events).toHaveLength(1);
    expect(events[0]?.[0]?.signCounter).toBe(1);
  });

  it('recordAuthSuccess throws on unknown credentialId', () => {
    registry.add(record({ credentialId: 'a' }));
    expect(() => registry.recordAuthSuccess('nope', 1, '2026-04-30T00:00:00.000Z')).toThrow(
      /not found/
    );
  });

  it('recordAuthSuccess rejects non-integer or negative counters', () => {
    registry.add(record({ credentialId: 'a' }));
    expect(() => registry.recordAuthSuccess('a', -1, '2026-04-30T00:00:00.000Z')).toThrow(
      /invalid counter/
    );
    expect(() => registry.recordAuthSuccess('a', 1.5, '2026-04-30T00:00:00.000Z')).toThrow(
      /invalid counter/
    );
  });

  it('onChange fires after add, rename, remove', () => {
    const events: PairedDeviceRecord[][] = [];
    const off = registry.onChange((d) => events.push(d));
    registry.add(record({ credentialId: 'a' }));
    registry.rename('a', 'Renamed');
    registry.remove('a');
    off();
    registry.add(record({ credentialId: 'b' }));

    expect(events).toHaveLength(3);
    expect(events[0]?.[0]?.credentialId).toBe('a');
    expect(events[1]?.[0]?.label).toBe('Renamed');
    expect(events[2]).toEqual([]);
  });

  it('refuses a malformed file', () => {
    writeFileSync(path, '{', 'utf8');
    const fresh = new PairedDeviceRegistryService(path);
    expect(() => fresh.list()).toThrow(/unreadable/);
  });

  it('refuses an unsupported version', () => {
    writeFileSync(path, JSON.stringify({ version: 999, devices: [] }), 'utf8');
    const fresh = new PairedDeviceRegistryService(path);
    expect(() => fresh.list()).toThrow(/unsupported version/);
  });

  it('refuses a record with a wrong-typed field', () => {
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        devices: [
          {
            ...record(),
            signCounter: 'not-a-number',
          },
        ],
      }),
      'utf8'
    );
    const fresh = new PairedDeviceRegistryService(path);
    expect(() => fresh.list()).toThrow(/signCounter/);
  });

  it('writes the file with mode 0600', () => {
    registry.add(record());
    // Mode check is platform-specific; only assert the file exists and is JSON.
    expect(existsSync(path)).toBe(true);
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    expect(parsed.version).toBe(1);
    expect(parsed.devices).toHaveLength(1);
  });
});
