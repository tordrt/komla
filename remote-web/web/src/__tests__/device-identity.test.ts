import { describe, expect, it, vi } from 'vitest';

import {
  discardRejectedEnrollmentIdentity,
  loadOrCreateEnrollmentDeviceIdentity,
  stageEnrollmentDeviceIdentity,
  type PendingDeviceIdentity,
  type StoredDeviceIdentity,
} from '../device-identity';

const fingerprint = 'a'.repeat(64);
const pendingIdentity: PendingDeviceIdentity = {
  fingerprint,
  deviceId: 'b'.repeat(64),
  devicePublicKey: 'public-key',
  privateKey: {} as CryptoKey,
};

describe('enrollment device identity', () => {
  it('reuses the stored browser installation identity during re-enrollment', async () => {
    const storedIdentity: StoredDeviceIdentity = {
      ...pendingIdentity,
      credentialId: 'existing-credential',
    };
    const create = vi.fn();

    const result = await loadOrCreateEnrollmentDeviceIdentity(fingerprint, {
      load: vi.fn().mockResolvedValue(storedIdentity),
      create,
    });

    expect(result).toEqual({ identity: storedIdentity, previousIdentity: storedIdentity });
    expect(create).not.toHaveBeenCalled();
  });

  it('creates an installation identity only when none is stored', async () => {
    const result = await loadOrCreateEnrollmentDeviceIdentity(fingerprint, {
      load: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue(pendingIdentity),
    });

    expect(result).toEqual({ identity: pendingIdentity, previousIdentity: null });
  });

  it('persists the non-exportable key before registration can be sent', async () => {
    const events: string[] = [];
    let staged: StoredDeviceIdentity | null = null;

    const result = await stageEnrollmentDeviceIdentity(
      pendingIdentity,
      'new-credential',
      (identity) => {
        events.push('staged');
        staged = identity;
      },
      async () => {
        events.push('persisted');
      }
    );
    events.push('send');

    expect(events).toEqual(['persisted', 'staged', 'send']);
    expect(staged).toEqual(result);
    expect(result.credentialId).toBe('new-credential');
  });

  it('does not expose a staged identity when persistence fails', async () => {
    const onStaged = vi.fn();

    await expect(
      stageEnrollmentDeviceIdentity(pendingIdentity, 'new-credential', onStaged, async () => {
        throw new Error('IndexedDB unavailable');
      })
    ).rejects.toThrow('IndexedDB unavailable');
    expect(onStaged).not.toHaveBeenCalled();
  });

  it('removes a newly staged identity after explicit rejection', async () => {
    const removeIfMatches = vi.fn().mockResolvedValue(undefined);
    const stagedIdentity = { ...pendingIdentity, credentialId: 'new-credential' };

    await discardRejectedEnrollmentIdentity(stagedIdentity, null, removeIfMatches);

    expect(removeIfMatches).toHaveBeenCalledWith(
      stagedIdentity.fingerprint,
      stagedIdentity.deviceId,
      stagedIdentity.credentialId
    );
  });

  it('restores an existing identity when re-enrollment is rejected', async () => {
    const removeIfMatches = vi.fn().mockResolvedValue(undefined);
    const restore = vi.fn().mockResolvedValue(undefined);
    const previousIdentity = { ...pendingIdentity, credentialId: 'existing-credential' };

    await discardRejectedEnrollmentIdentity(
      { ...pendingIdentity, credentialId: 'new-credential' },
      previousIdentity,
      removeIfMatches,
      restore
    );

    expect(removeIfMatches).not.toHaveBeenCalled();
    expect(restore).toHaveBeenCalledWith(previousIdentity);
  });
});
