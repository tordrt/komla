import { describe, expect, it } from 'vitest';

import {
  endpointHref,
  hasLastEndpoint,
  rememberDesktop,
  rememberedDesktopFingerprint,
  rememberedHosts,
  rememberHosts,
  rememberLastEndpoint,
  selectedHostId,
  startingHostId,
  type KeyValueStore,
} from '../endpoints';

class MemoryStore implements KeyValueStore {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
}

const DESKTOP = 'a'.repeat(64);
const devbox = {
  id: 'host-1',
  name: 'devbox',
  url: 'wss://devbox.tail1.ts.net:48123/remote/ws',
  fingerprint: 'b'.repeat(64),
};

describe('phone endpoints', () => {
  it('remembers the hosts a desktop vouched for, for that desktop only', () => {
    const store = new MemoryStore();

    rememberHosts(store, DESKTOP, [devbox]);

    expect(rememberedHosts(store, DESKTOP)).toEqual([devbox]);
    expect(rememberedHosts(store, 'c'.repeat(64))).toEqual([]);
  });

  it('drops hosts that are not pinned wss endpoints', () => {
    const store = new MemoryStore();

    rememberHosts(store, DESKTOP, [
      devbox,
      { ...devbox, id: 'plain', url: 'ws://devbox:48123/remote/ws' },
      { ...devbox, id: 'local', url: 'ws://127.0.0.1:48123/remote/ws' },
      { ...devbox, id: 'unpinned', fingerprint: 'short' },
      { ...devbox, id: 'bad id!' },
    ]);
    store.setItem('komla.remote.desktop', '{');

    expect(rememberedHosts(store, DESKTOP).map((host) => host.id)).toEqual(['host-1', 'local']);
    expect(rememberedDesktopFingerprint(store)).toBeNull();
    rememberDesktop(store, DESKTOP);
    expect(rememberedDesktopFingerprint(store)).toBe(DESKTOP);
  });

  it('selects a host from the page address and builds links between endpoints', () => {
    const page = 'https://mac.tail1.ts.net/remote/?workspace=ws-1&terminal=t-1';

    expect(selectedHostId(page)).toBeNull();
    expect(selectedHostId('https://mac.tail1.ts.net/remote/?host=host-1')).toBe('host-1');
    expect(selectedHostId('https://mac.tail1.ts.net/remote/?host=../x')).toBeNull();
    expect(endpointHref(page, 'host-1')).toBe('https://mac.tail1.ts.net/remote/?host=host-1');
    expect(endpointHref('https://mac.tail1.ts.net/remote/?host=host-1#x', null)).toBe(
      'https://mac.tail1.ts.net/remote/'
    );
  });

  it('starts on a host until the desktop is picked', () => {
    const store = new MemoryStore();
    const buildbox = { ...devbox, id: 'host-2', name: 'buildbox' };
    expect(startingHostId(store, DESKTOP)).toBeNull();
    expect(hasLastEndpoint(store)).toBe(false);

    rememberHosts(store, DESKTOP, [devbox, buildbox]);
    expect(startingHostId(store, DESKTOP)).toBe('host-1');
    expect(startingHostId(store, null)).toBeNull();
    expect(startingHostId(store, 'c'.repeat(64))).toBeNull();

    rememberLastEndpoint(store, 'host-2');
    expect(hasLastEndpoint(store)).toBe(true);
    expect(startingHostId(store, DESKTOP)).toBe('host-2');

    // A host the desktop stopped vouching for gives way to another one.
    rememberHosts(store, DESKTOP, [devbox]);
    expect(startingHostId(store, DESKTOP)).toBe('host-1');
    rememberHosts(store, DESKTOP, []);
    expect(startingHostId(store, DESKTOP)).toBeNull();

    rememberHosts(store, DESKTOP, [devbox]);
    rememberLastEndpoint(store, null);
    expect(hasLastEndpoint(store)).toBe(true);
    expect(startingHostId(store, DESKTOP)).toBeNull();
  });
});
