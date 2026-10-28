import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useConfigStore } from '../../../src/renderer/stores/config.store';

function resetStore(): void {
  useConfigStore.setState(useConfigStore.getInitialState(), true);
}

function mockApi(overrides: Record<string, any> = {}): Record<string, any> {
  const api = {
    getConfig: vi.fn().mockResolvedValue({ theme: 'dark', scrollbackLines: 5000 }),
    hasProjects: vi.fn().mockResolvedValue(true),
    updateConfig: vi
      .fn()
      .mockImplementation(async (updates: any) => ({ theme: 'dark', ...updates })),
    selectDirectory: vi.fn().mockResolvedValue('/selected/path'),
    getOpenRouterKeyStatus: vi
      .fn()
      .mockResolvedValue({ hasOpenRouterKey: false, isUsingFallbackStorage: false }),
    saveOpenRouterApiKey: vi.fn().mockResolvedValue(undefined),
    clearOpenRouterApiKey: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  (globalThis as any).window = { api };
  return api;
}

describe('config.store', () => {
  beforeEach(() => {
    resetStore();
    mockApi();
  });

  it('starts loading before the first render so onboarding waits for config', () => {
    const state = useConfigStore.getState();
    expect(state.config).toBeNull();
    expect(state.isLoading).toBe(true);
    expect(state.error).toBeNull();
    expect(state.hasProjects).toBe(false);
  });

  it('loadConfig fetches config and hasProjects', async () => {
    await useConfigStore.getState().loadConfig();
    const state = useConfigStore.getState();
    expect(state.config).toEqual({ theme: 'dark', scrollbackLines: 5000 });
    expect(state.hasProjects).toBe(true);
    expect(state.isLoading).toBe(false);
    expect(state.error).toBeNull();
    expect(state.openRouterKeyStatus).toEqual({
      hasOpenRouterKey: false,
      isUsingFallbackStorage: false,
    });
    expect(state.openRouterKeyStatusLoading).toBe(false);
    expect(state.openRouterKeyStatusError).toBeNull();
  });

  it('loadConfig sets isLoading only on initial load', async () => {
    // First load (config is null) → isLoading = true
    const loadPromise = useConfigStore.getState().loadConfig();
    expect(useConfigStore.getState().isLoading).toBe(true);
    await loadPromise;

    // Second load (config is not null) → isLoading = false
    const loadPromise2 = useConfigStore.getState().loadConfig();
    expect(useConfigStore.getState().isLoading).toBe(false);
    await loadPromise2;
  });

  it('loadConfig handles errors with default config', async () => {
    mockApi({
      getConfig: vi.fn().mockRejectedValue(new Error('Network error')),
      hasProjects: vi.fn().mockRejectedValue(new Error('Network error')),
    });
    await useConfigStore.getState().loadConfig();
    const state = useConfigStore.getState();
    expect(state.error).toBe('Network error');
    expect(state.isLoading).toBe(false);
    expect(state.config).toBeDefined();
    // Should have default config values
    expect(state.config?.theme).toBe('system');
  });

  it('updateConfig updates config state', async () => {
    await useConfigStore.getState().loadConfig();
    await useConfigStore.getState().updateConfig({ theme: 'light' });
    expect(useConfigStore.getState().config?.theme).toBe('light');
  });

  it('updateConfig returns { ok: true, error: null } on success', async () => {
    await useConfigStore.getState().loadConfig();
    const result = await useConfigStore.getState().updateConfig({ theme: 'light' });
    expect(result).toEqual({ ok: true, error: null });
  });

  it('updateConfig clears a stale error on success', async () => {
    // First call fails and sets the store error.
    mockApi({
      getConfig: vi.fn().mockResolvedValue({ theme: 'dark' }),
      hasProjects: vi.fn().mockResolvedValue(false),
      updateConfig: vi.fn().mockRejectedValueOnce(new Error('Save failed')).mockResolvedValue({
        theme: 'light',
      }),
    });
    await useConfigStore.getState().loadConfig();
    await useConfigStore.getState().updateConfig({ theme: 'light' });
    expect(useConfigStore.getState().error).toBe('Save failed');

    // Second call succeeds — store.error must be reset so future readers
    // don't see a carry-over from the prior failure.
    const result = await useConfigStore.getState().updateConfig({ theme: 'light' });
    expect(result).toEqual({ ok: true, error: null });
    expect(useConfigStore.getState().error).toBeNull();
  });

  it('updateConfig handles errors', async () => {
    mockApi({
      getConfig: vi.fn().mockResolvedValue({ theme: 'dark' }),
      hasProjects: vi.fn().mockResolvedValue(false),
      updateConfig: vi.fn().mockRejectedValue(new Error('Save failed')),
    });
    await useConfigStore.getState().loadConfig();
    const result = await useConfigStore.getState().updateConfig({ theme: 'light' });
    expect(result).toEqual({ ok: false, error: 'Save failed' });
    expect(useConfigStore.getState().error).toBe('Save failed');
  });

  it('takes the config another window saved', () => {
    let deliver: (config: unknown) => void = () => {};
    const unsubscribe = vi.fn();
    mockApi({
      onConfigChanged: vi.fn((callback) => {
        deliver = callback;
        return unsubscribe;
      }),
    });

    const stop = useConfigStore.getState().subscribeToChanges();
    deliver({ theme: 'light', scrollbackLines: 5000 });

    expect(useConfigStore.getState().config).toEqual({ theme: 'light', scrollbackLines: 5000 });
    stop();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('setDiffHideUnchangedRegions calls updateConfig', async () => {
    const api = mockApi();
    await useConfigStore.getState().setDiffHideUnchangedRegions(false);
    expect(api.updateConfig).toHaveBeenCalledWith({ diffHideUnchangedRegions: false });
  });

  it('selectDirectory returns path from API', async () => {
    const result = await useConfigStore.getState().selectDirectory();
    expect(result).toBe('/selected/path');
  });

  it('selectDirectory propagates errors so callers can surface them', async () => {
    mockApi({
      getConfig: vi.fn().mockResolvedValue({}),
      hasProjects: vi.fn().mockResolvedValue(false),
      selectDirectory: vi.fn().mockRejectedValue(new Error('Cancelled')),
    });
    await expect(useConfigStore.getState().selectDirectory()).rejects.toThrow('Cancelled');
  });

  it('selectDirectory strips the Electron IPC wrapper from thrown errors', async () => {
    mockApi({
      getConfig: vi.fn().mockResolvedValue({}),
      hasProjects: vi.fn().mockResolvedValue(false),
      selectDirectory: vi
        .fn()
        .mockRejectedValue(
          new Error(
            "Error invoking remote method 'config:select-directory': Error: Selected directory is not a git repository"
          )
        ),
    });
    await expect(useConfigStore.getState().selectDirectory()).rejects.toThrow(
      /^Selected directory is not a git repository$/
    );
  });
});
