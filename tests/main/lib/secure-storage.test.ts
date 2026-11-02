import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Electron's safeStorage, whose methods throw unless called on it, as native bindings do. */
const safeStorage = vi.hoisted(() => {
  const fake = {
    backend: 'gnome_libsecret',
    available: true,
    isEncryptionAvailable(this: unknown) {
      if (this !== fake) throw new TypeError('Illegal invocation');
      return fake.available;
    },
    async isAsyncEncryptionAvailable(this: unknown) {
      if (this !== fake) throw new TypeError('Illegal invocation');
      return fake.available;
    },
    getSelectedStorageBackend(this: unknown) {
      if (this !== fake) {
        throw new TypeError(
          'Illegal invocation: Function must be called on an object of type SafeStorage'
        );
      }
      return fake.backend;
    },
  };
  return fake;
});

vi.mock('electron', () => ({ safeStorage }));
vi.mock('../../../src/main/lib/logger', () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import {
  canUseSecureStorage,
  canUseSecureStorageAsync,
} from '../../../src/main/lib/secure-storage';

describe('secure storage', () => {
  beforeEach(() => {
    safeStorage.backend = 'gnome_libsecret';
    safeStorage.available = true;
  });

  it('protects data with a keyring', async () => {
    expect(canUseSecureStorage()).toBe(true);
    await expect(canUseSecureStorageAsync()).resolves.toBe(true);
  });

  it("doesn't count Linux's basic_text backend, whose password is hardcoded", async () => {
    safeStorage.backend = 'basic_text';

    expect(canUseSecureStorage()).toBe(false);
    await expect(canUseSecureStorageAsync()).resolves.toBe(false);
  });

  it('is unavailable when Electron says so', async () => {
    safeStorage.available = false;

    expect(canUseSecureStorage()).toBe(false);
    await expect(canUseSecureStorageAsync()).resolves.toBe(false);
  });
});
