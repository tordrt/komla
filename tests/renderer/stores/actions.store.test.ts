import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useActionsStore } from '../../../src/renderer/stores/actions.store';

function resetStore(): void {
  useActionsStore.setState(useActionsStore.getInitialState(), true);
}

const action1 = { id: 't-1', title: 'Action 1', content: 'Content 1', lastUsedAt: 2000 };
const action2 = { id: 't-2', title: 'Action 2', content: 'Content 2', lastUsedAt: 1000 };

function mockApi(overrides: Record<string, any> = {}): Record<string, any> {
  const api = {
    listActions: vi.fn().mockResolvedValue([action1, action2]),
    createAction: vi
      .fn()
      .mockResolvedValue({ id: 't-new', title: 'New', content: 'C', lastUsedAt: null }),
    updateAction: vi.fn().mockImplementation(async (id: string, updates: any) => ({
      ...action1,
      id,
      ...updates,
    })),
    deleteAction: vi.fn().mockResolvedValue(undefined),
    reorderAction: vi.fn().mockResolvedValue(undefined),
    recordActionUsage: vi.fn().mockImplementation(async (id: string) => ({
      ...action1,
      id,
      lastUsedAt: Date.now(),
    })),
    onActionsChange: vi.fn().mockReturnValue(vi.fn()),
    ...overrides,
  };
  (globalThis as any).window = { api };
  return api;
}

describe('actions.store', () => {
  beforeEach(() => {
    resetStore();
    mockApi();
  });

  it('loadActions fetches actions in configured order', async () => {
    await useActionsStore.getState().loadActions();
    const state = useActionsStore.getState();
    expect(state.actions).toHaveLength(2);
    expect(state.actions[0].id).toBe('t-1');
    expect(state.actions[1].id).toBe('t-2');
    expect(state.isLoading).toBe(false);
  });

  it('loadActions handles errors', async () => {
    mockApi({ listActions: vi.fn().mockRejectedValue(new Error('Failed')) });
    await useActionsStore.getState().loadActions();
    expect(useActionsStore.getState().error).toBe('Failed');
  });

  it('createAction adds action to sorted list', async () => {
    const result = await useActionsStore.getState().createAction({ title: 'New', content: 'C' });
    expect(result.id).toBe('t-new');
    expect(useActionsStore.getState().actions).toHaveLength(1);
  });

  it('createAction propagates errors', async () => {
    mockApi({ createAction: vi.fn().mockRejectedValue(new Error('Create failed')) });
    await expect(
      useActionsStore.getState().createAction({ title: 'Fail', content: '' })
    ).rejects.toThrow();
  });

  it('updateAction replaces action in list', async () => {
    useActionsStore.setState({ actions: [action1, action2] as any });
    await useActionsStore.getState().updateAction('t-1', { title: 'Updated' });
    const updated = useActionsStore.getState().actions.find((t) => t.id === 't-1');
    expect(updated?.title).toBe('Updated');
  });

  it('deleteAction removes action from list', async () => {
    useActionsStore.setState({ actions: [action1, action2] as any });
    await useActionsStore.getState().deleteAction('t-1');
    expect(useActionsStore.getState().actions.map((t) => t.id)).toEqual(['t-2']);
  });

  it('reorderAction reorders optimistically', async () => {
    const api = mockApi();
    useActionsStore.setState({ actions: [action1, action2] as any });

    await useActionsStore.getState().reorderAction('t-2', 0);

    expect(useActionsStore.getState().actions.map((t) => t.id)).toEqual(['t-2', 't-1']);
    expect(api.reorderAction).toHaveBeenCalledWith('t-2', 0);
  });

  it('reorderAction rolls back on failure', async () => {
    mockApi({ reorderAction: vi.fn().mockRejectedValue(new Error('nope')) });
    useActionsStore.setState({ actions: [action1, action2] as any });

    await expect(useActionsStore.getState().reorderAction('t-2', 0)).rejects.toThrow('nope');

    expect(useActionsStore.getState().actions.map((t) => t.id)).toEqual(['t-1', 't-2']);
    expect(useActionsStore.getState().error).toBe('nope');
  });

  it('subscribeToChanges updates actions from external events', () => {
    let callback: ((actions: any[]) => void) | undefined;
    mockApi({
      onActionsChange: vi.fn((cb: any) => {
        callback = cb;
        return vi.fn();
      }),
    });
    useActionsStore.getState().subscribeToChanges();
    callback!([{ id: 't-3', title: 'External', content: 'E', lastUsedAt: null }]);
    expect(useActionsStore.getState().actions).toHaveLength(1);
    expect(useActionsStore.getState().actions[0].id).toBe('t-3');
  });
});
