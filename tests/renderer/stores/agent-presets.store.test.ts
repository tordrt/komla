import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAgentPresetsStore } from '../../../src/renderer/stores/agent-presets.store';

function resetStore(): void {
  useAgentPresetsStore.setState(useAgentPresetsStore.getInitialState(), true);
}

const preset1 = { id: 'pr-1', name: 'Preset 1', order: 0 };
const preset2 = { id: 'pr-2', name: 'Preset 2', order: 1 };

const activePreset1 = { id: 'pr-1', order: 0 };

function mockApi(overrides: Record<string, any> = {}): Record<string, any> {
  const api = {
    getPresets: vi.fn().mockResolvedValue([preset1, preset2]),
    getActivePreset: vi.fn().mockResolvedValue(preset1),
    getActivePresets: vi.fn().mockResolvedValue([activePreset1]),
    getPreset: vi
      .fn()
      .mockImplementation(async (id: string) => [preset1, preset2].find((p) => p.id === id)),
    setActivePreset: vi.fn().mockResolvedValue(undefined),
    addActivePreset: vi.fn().mockResolvedValue(undefined),
    removeActivePreset: vi.fn().mockResolvedValue(undefined),
    createPreset: vi.fn().mockResolvedValue({ id: 'pr-new', name: 'New', order: 2 }),
    updatePreset: vi
      .fn()
      .mockImplementation(async (id: string, updates: any) => ({ ...preset1, id, ...updates })),
    deletePreset: vi.fn().mockResolvedValue(undefined),
    reorderPreset: vi.fn().mockResolvedValue(undefined),
    onAgentPresetsChange: vi.fn().mockReturnValue(vi.fn()),
    ...overrides,
  };
  (globalThis as any).window = { api };
  return api;
}

describe('agent-presets.store', () => {
  beforeEach(() => {
    resetStore();
    mockApi();
  });

  it('loadPresets fetches presets and active preset', async () => {
    await useAgentPresetsStore.getState().loadPresets();
    const state = useAgentPresetsStore.getState();
    expect(state.presets).toEqual([preset1, preset2]);
    expect(state.activePreset).toEqual(preset1);
    expect(state.isLoading).toBe(false);
  });

  it('loadPresets sets activePreset to null when no active preset', async () => {
    mockApi({ getActivePreset: vi.fn().mockResolvedValue(null) });
    await useAgentPresetsStore.getState().loadPresets();
    expect(useAgentPresetsStore.getState().activePreset).toBeNull();
  });

  it('loadPresets handles errors', async () => {
    mockApi({ getPresets: vi.fn().mockRejectedValue(new Error('Load failed')) });
    await useAgentPresetsStore.getState().loadPresets();
    expect(useAgentPresetsStore.getState().error).toBe('Load failed');
    expect(useAgentPresetsStore.getState().isLoading).toBe(false);
  });

  it('getPreset fetches a single preset', async () => {
    const result = await useAgentPresetsStore.getState().getPreset('pr-1');
    expect(result).toEqual(preset1);
  });

  it('getPreset returns undefined on error', async () => {
    mockApi({ getPreset: vi.fn().mockRejectedValue(new Error('Not found')) });
    const result = await useAgentPresetsStore.getState().getPreset('missing');
    expect(result).toBeUndefined();
    expect(useAgentPresetsStore.getState().error).toBe('Not found');
  });

  it('setActivePreset updates active preset from existing presets list', async () => {
    useAgentPresetsStore.setState({ presets: [preset1, preset2] as any });
    await useAgentPresetsStore.getState().setActivePreset('pr-2');
    expect(useAgentPresetsStore.getState().activePreset).toEqual(preset2);
  });

  it('setActivePreset records usage in active presets state', async () => {
    useAgentPresetsStore.setState({
      presets: [preset1, preset2] as any,
      activePresets: [
        { presetId: 'pr-1', lastUsedAt: 100 },
        { presetId: 'pr-2', lastUsedAt: 200 },
      ],
    });

    await useAgentPresetsStore.getState().setActivePreset('pr-1');

    const entry = useAgentPresetsStore
      .getState()
      .activePresets.find((active) => active.presetId === 'pr-1');
    expect(entry?.lastUsedAt).toBeGreaterThan(100);
  });

  it('setActivePreset records last launch mode when provided', async () => {
    const api = mockApi();
    useAgentPresetsStore.setState({
      presets: [preset1, preset2] as any,
      activePresets: [{ presetId: 'pr-1', lastUsedAt: 100, lastLaunchModeId: null }],
    });

    await useAgentPresetsStore.getState().setActivePreset('pr-1', 'mode-1');

    expect(api.setActivePreset).toHaveBeenCalledWith('pr-1', 'mode-1');
    const entry = useAgentPresetsStore.getState().activePresets[0];
    expect(entry.lastLaunchModeId).toBe('mode-1');
  });

  it('setActivePreset preserves last launch mode when omitted', async () => {
    useAgentPresetsStore.setState({
      presets: [preset1, preset2] as any,
      activePresets: [{ presetId: 'pr-1', lastUsedAt: 100, lastLaunchModeId: 'mode-1' }],
    });

    await useAgentPresetsStore.getState().setActivePreset('pr-1');

    const entry = useAgentPresetsStore.getState().activePresets[0];
    expect(entry.lastLaunchModeId).toBe('mode-1');
  });

  it('setActivePreset sets null when preset not in list', async () => {
    useAgentPresetsStore.setState({ presets: [preset1] as any });
    await useAgentPresetsStore.getState().setActivePreset('missing');
    expect(useAgentPresetsStore.getState().activePreset).toBeNull();
  });

  it('createPreset adds preset to list', async () => {
    const result = await useAgentPresetsStore.getState().createPreset({ name: 'New' } as any);
    expect(result.id).toBe('pr-new');
    expect(useAgentPresetsStore.getState().presets).toHaveLength(1);
  });

  it('updatePreset updates preset in list and active preset if matching', async () => {
    useAgentPresetsStore.setState({
      presets: [preset1, preset2] as any,
      activePreset: preset1 as any,
    });
    await useAgentPresetsStore.getState().updatePreset('pr-1', { name: 'Updated' });
    expect(useAgentPresetsStore.getState().presets[0].name).toBe('Updated');
    expect(useAgentPresetsStore.getState().activePreset?.name).toBe('Updated');
  });

  it('updatePreset does not touch activePreset when different id', async () => {
    useAgentPresetsStore.setState({
      presets: [preset1, preset2] as any,
      activePreset: preset1 as any,
    });
    await useAgentPresetsStore.getState().updatePreset('pr-2', { name: 'Updated' });
    expect(useAgentPresetsStore.getState().activePreset).toEqual(preset1);
  });

  it('deletePreset removes preset from list', async () => {
    useAgentPresetsStore.setState({
      presets: [preset1, preset2] as any,
      activePreset: preset1 as any,
      activePresets: [
        { presetId: 'pr-1', lastUsedAt: 200 },
        { presetId: 'pr-2', lastUsedAt: 100 },
      ],
    });
    await useAgentPresetsStore.getState().deletePreset('pr-1');
    const state = useAgentPresetsStore.getState();
    expect(state.presets.map((p) => p.id)).toEqual(['pr-2']);
    expect(state.activePresets).toEqual([{ presetId: 'pr-2', lastUsedAt: 100 }]);
    expect(state.activePreset).toEqual(preset2);
  });

  it('reorderPreset reorders optimistically', async () => {
    const api = mockApi();
    useAgentPresetsStore.setState({ presets: [preset1, preset2] as any });

    await useAgentPresetsStore.getState().reorderPreset('pr-2', 0);

    expect(useAgentPresetsStore.getState().presets.map((p) => p.id)).toEqual(['pr-2', 'pr-1']);
    expect(api.reorderPreset).toHaveBeenCalledWith('pr-2', 0);
  });

  it('reorderPreset rolls back on failure', async () => {
    mockApi({ reorderPreset: vi.fn().mockRejectedValue(new Error('nope')) });
    useAgentPresetsStore.setState({ presets: [preset1, preset2] as any });

    await expect(useAgentPresetsStore.getState().reorderPreset('pr-2', 0)).rejects.toThrow('nope');

    expect(useAgentPresetsStore.getState().presets.map((p) => p.id)).toEqual(['pr-1', 'pr-2']);
    expect(useAgentPresetsStore.getState().error).toBe('nope');
  });

  it('subscribeToChanges updates from external events', () => {
    let callback: ((data: any) => void) | undefined;
    mockApi({
      onAgentPresetsChange: vi.fn((cb: any) => {
        callback = cb;
        return vi.fn();
      }),
    });
    useAgentPresetsStore.getState().subscribeToChanges();
    callback!({
      presets: [preset2],
      activePreset: preset2,
      activePresets: [{ id: 'pr-2', order: 0 }],
    });
    const state = useAgentPresetsStore.getState();
    expect(state.presets).toEqual([preset2]);
    expect(state.activePreset).toEqual(preset2);
    expect(state.activePresets).toEqual([{ id: 'pr-2', order: 0 }]);
  });

  describe('active presets', () => {
    it('should add preset to active list', async () => {
      const api = mockApi();
      const store = useAgentPresetsStore.getState();
      await store.addActivePreset('test-id');
      expect(api.addActivePreset).toHaveBeenCalledWith('test-id');
    });

    it('should remove preset from active list', async () => {
      const api = mockApi();
      const store = useAgentPresetsStore.getState();
      await store.removeActivePreset('test-id');
      expect(api.removeActivePreset).toHaveBeenCalledWith('test-id');
    });
  });
});
