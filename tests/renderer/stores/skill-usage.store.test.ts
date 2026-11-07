/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const STORAGE_KEY = 'komla.skillLastUsedAt';

async function loadStore() {
  vi.resetModules();
  return (await import('../../../src/renderer/stores/skill-usage.store')).useSkillUsageStore;
}

describe('useSkillUsageStore', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it('remembers when each skill was last used, across restarts', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(5);
    (await loadStore()).getState().recordSkillUse('skill:claude:review');

    const reloaded = await loadStore();

    expect(reloaded.getState().lastUsed).toEqual({ 'skill:claude:review': 5 });
  });

  it('keeps only the most recently used skills', async () => {
    const store = await loadStore();
    const now = vi.spyOn(Date, 'now');
    for (let index = 0; index < 205; index++) {
      now.mockReturnValue(index);
      store.getState().recordSkillUse(`skill:claude:s${index}`);
    }

    const kept = Object.keys((await loadStore()).getState().lastUsed);

    expect(kept).toHaveLength(200);
    expect(kept).not.toContain('skill:claude:s4');
    expect(kept).toContain('skill:claude:s5');
  });

  it("keeps another window's uses, and shows them as they're stored", async () => {
    const store = await loadStore();
    // Another window records /lint after this one loaded.
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ 'skill:claude:lint': 3 }));
    window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY }));
    expect(store.getState().lastUsed).toEqual({ 'skill:claude:lint': 3 });

    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ 'skill:claude:lint': 3, 'skill:claude:test': 4 })
    );
    vi.spyOn(Date, 'now').mockReturnValue(5);
    store.getState().recordSkillUse('skill:claude:review');

    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY)!)).toEqual({
      'skill:claude:review': 5,
      'skill:claude:test': 4,
      'skill:claude:lint': 3,
    });
  });

  it("keeps this window's later uses over another window's older ones", async () => {
    const store = await loadStore();
    vi.spyOn(Date, 'now').mockReturnValue(9);
    store.getState().recordSkillUse('skill:claude:review');

    // Another window, loaded earlier, stores its stale map.
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ 'skill:claude:review': 2, 'skill:claude:lint': 3 })
    );
    window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY }));

    expect(store.getState().lastUsed).toEqual({
      'skill:claude:review': 9,
      'skill:claude:lint': 3,
    });
  });

  it('starts empty from storage it cannot read', async () => {
    window.localStorage.setItem(STORAGE_KEY, '{not json');
    expect((await loadStore()).getState().lastUsed).toEqual({});

    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ a: 'soon', b: 3 }));
    expect((await loadStore()).getState().lastUsed).toEqual({ b: 3 });
  });
});
