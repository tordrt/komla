import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useCategoriesStore } from '../../../src/renderer/stores/categories.store';

function resetStore(): void {
  useCategoriesStore.setState(useCategoriesStore.getInitialState(), true);
}

const cat1 = { id: 'c-1', name: 'Category 1' };
const cat2 = { id: 'c-2', name: 'Category 2' };

function mockApi(overrides: Record<string, any> = {}): Record<string, any> {
  const api = {
    getCategories: vi.fn().mockResolvedValue([cat1, cat2]),
    createCategory: vi.fn().mockResolvedValue({ id: 'c-new', name: 'New' }),
    updateCategory: vi
      .fn()
      .mockImplementation(async (id: string, updates: any) => ({ id, ...updates })),
    deleteCategory: vi.fn().mockResolvedValue(undefined),
    onCategoriesChange: vi.fn().mockReturnValue(vi.fn()),
    ...overrides,
  };
  (globalThis as any).window = { api };
  return api;
}

describe('categories.store', () => {
  beforeEach(() => {
    resetStore();
    mockApi();
  });

  it('loadCategories fetches categories', async () => {
    await useCategoriesStore.getState().loadCategories();
    const state = useCategoriesStore.getState();
    expect(state.categories).toEqual([cat1, cat2]);
    expect(state.isLoading).toBe(false);
  });

  it('loadCategories handles errors', async () => {
    mockApi({ getCategories: vi.fn().mockRejectedValue(new Error('Failed')) });
    await useCategoriesStore.getState().loadCategories();
    expect(useCategoriesStore.getState().error).toBe('Failed');
    expect(useCategoriesStore.getState().isLoading).toBe(false);
  });

  it('createCategory adds category to list', async () => {
    const result = await useCategoriesStore.getState().createCategory('New');
    expect(result).toEqual({ id: 'c-new', name: 'New' });
    expect(useCategoriesStore.getState().categories).toHaveLength(1);
  });

  it('createCategory with parentId', async () => {
    const api = mockApi();
    await useCategoriesStore.getState().createCategory('Sub', 'c-1');
    expect(api.createCategory).toHaveBeenCalledWith('Sub', 'c-1');
  });

  it('createCategory propagates errors', async () => {
    mockApi({ createCategory: vi.fn().mockRejectedValue(new Error('Create failed')) });
    await expect(useCategoriesStore.getState().createCategory('Fail')).rejects.toThrow(
      'Create failed'
    );
  });

  it('updateCategory replaces category in list', async () => {
    useCategoriesStore.setState({ categories: [cat1, cat2] as any });
    await useCategoriesStore.getState().updateCategory('c-1', { name: 'Updated' });
    expect(useCategoriesStore.getState().categories[0].name).toBe('Updated');
  });

  it('deleteCategory removes category from list', async () => {
    useCategoriesStore.setState({ categories: [cat1, cat2] as any });
    await useCategoriesStore.getState().deleteCategory('c-1');
    expect(useCategoriesStore.getState().categories.map((c) => c.id)).toEqual(['c-2']);
  });

  it('toggleExpanded toggles expansion state', () => {
    useCategoriesStore.getState().toggleExpanded('c-1');
    expect(useCategoriesStore.getState().expandedIds.has('c-1')).toBe(true);
    useCategoriesStore.getState().toggleExpanded('c-1');
    expect(useCategoriesStore.getState().expandedIds.has('c-1')).toBe(false);
  });

  it('setExpanded explicitly sets expansion', () => {
    useCategoriesStore.getState().setExpanded('c-1', true);
    expect(useCategoriesStore.getState().expandedIds.has('c-1')).toBe(true);
    useCategoriesStore.getState().setExpanded('c-1', false);
    expect(useCategoriesStore.getState().expandedIds.has('c-1')).toBe(false);
  });

  it('subscribeToChanges updates categories from external changes', () => {
    let callback: ((categories: any[]) => void) | undefined;
    mockApi({
      onCategoriesChange: vi.fn((cb: any) => {
        callback = cb;
        return vi.fn();
      }),
    });

    useCategoriesStore.getState().subscribeToChanges();
    callback!([{ id: 'c-3', name: 'External' }]);
    expect(useCategoriesStore.getState().categories).toEqual([{ id: 'c-3', name: 'External' }]);
  });
});
