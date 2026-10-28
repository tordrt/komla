import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockBrowserWindow, mockElectron } from '../../mocks/electron';
import { createVirtualFs } from '../../mocks/fs';

const electronMock = mockElectron();
vi.mock('electron', () => electronMock);

const vfs = createVirtualFs();
vi.mock('fs', () => vfs.mock);

vi.mock('../../../src/main/services/paths', () => ({
  getKomlaBasePath: () => '/mock/home/.komla',
}));

vi.mock('../../../src/main/lib/atomic-write', () => ({
  writeFileAtomicSync: (path: string, content: string) => vfs.mock.writeFileSync(path, content),
}));

const mockWatcherStart = vi.fn().mockResolvedValue(undefined);
const mockWatcherStop = vi.fn().mockResolvedValue(undefined);
let mockWatcherCallback: (() => void) | null = null;

vi.mock('../../../src/main/services/file-watcher', () => {
  return {
    FileWatcher: class {
      constructor(
        public path: string,
        public callback: () => void
      ) {
        mockWatcherCallback = callback;
      }
      start = mockWatcherStart;
      stop = mockWatcherStop;
    },
  };
});

vi.mock('crypto', async (importOriginal) => ({
  ...(await importOriginal<typeof import('crypto')>()),
  randomUUID: (() => {
    let count = 0;
    return () => `uuid-${++count}`;
  })(),
}));

describe('CategoryService', () => {
  let categoryService: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    vfs.clear();

    // Ensure base directories exist so mkdirSync doesn't fail if recursive=false logic is tricky,
    // but recursive=true is used in the service.
    // However, vfs.clear() wipes everything.

    // Reset module to get a fresh singleton
    vi.resetModules();
    const mod = await import('../../../src/main/services/category.service');
    categoryService = mod.categoryService;
  });

  it('initializes with default categories', () => {
    expect(vfs.hasFile('/mock/home/.komla/settings/categories.json')).toBe(true);
    const content = JSON.parse(vfs.getFile('/mock/home/.komla/settings/categories.json') as string);
    expect(content).toEqual({ _version: 1, categories: [] });
  });

  it('loads a categories file this version wrote', async () => {
    vfs.mock.mkdirSync('/mock/home/.komla/settings', { recursive: true });
    const categories = [{ id: '1', name: 'Saved Category', parentId: null, order: 0 }];
    vfs.mock.writeFileSync(
      '/mock/home/.komla/settings/categories.json',
      JSON.stringify({ _version: 1, categories })
    );

    vi.resetModules();
    const mod = await import('../../../src/main/services/category.service');

    expect(mod.categoryService.list()).toEqual(categories);
  });

  it('creates a category', () => {
    const cat = categoryService.create('My Category');

    expect(cat).toEqual({
      id: expect.stringMatching(/^uuid-\d+$/),
      name: 'My Category',
      parentId: null,
      order: 0,
    });

    const stored = JSON.parse(vfs.getFile('/mock/home/.komla/settings/categories.json') as string);
    expect(stored.categories).toHaveLength(1);
    expect(stored.categories[0]).toEqual(cat);
  });

  it('creates a child category with correct order', () => {
    const parent = categoryService.create('Parent');
    const child1 = categoryService.create('Child 1', parent.id);
    const child2 = categoryService.create('Child 2', parent.id);

    expect(child1.parentId).toBe(parent.id);
    expect(child1.order).toBe(0);
    expect(child2.parentId).toBe(parent.id);
    expect(child2.order).toBe(1);
  });

  it('updates a category', () => {
    const cat = categoryService.create('Original');
    const updated = categoryService.update(cat.id, { name: 'Updated' });

    expect(updated.name).toBe('Updated');
    expect(categoryService.get(cat.id)?.name).toBe('Updated');

    const stored = JSON.parse(vfs.getFile('/mock/home/.komla/settings/categories.json') as string);
    expect(stored.categories[0].name).toBe('Updated');
  });

  it('throws when updating non-existent category', () => {
    expect(() => categoryService.update('fake', { name: 'Updated' })).toThrow(
      'Category fake not found'
    );
  });

  it('deletes a category', () => {
    const cat = categoryService.create('To Delete');
    categoryService.delete(cat.id);

    expect(categoryService.get(cat.id)).toBeUndefined();
    const stored = JSON.parse(vfs.getFile('/mock/home/.komla/settings/categories.json') as string);
    expect(stored.categories).toHaveLength(0);
  });

  it('moves children to grandparent when parent is deleted', () => {
    const grandParent = categoryService.create('Grandparent');
    const parent = categoryService.create('Parent', grandParent.id);
    const child = categoryService.create('Child', parent.id);

    categoryService.delete(parent.id);

    const updatedChild = categoryService.get(child.id);
    expect(updatedChild?.parentId).toBe(grandParent.id);
  });

  it('reorders categories', () => {
    const cat1 = categoryService.create('1');
    const cat2 = categoryService.create('2');
    const cat3 = categoryService.create('3');

    // Move 3 to position 0
    categoryService.reorder(cat3.id, 0);

    const list = categoryService.list();
    expect(list[0].id).toBe(cat3.id);
    expect(list[0].order).toBe(0);

    expect(list[1].id).toBe(cat1.id);
    expect(list[1].order).toBe(1);

    expect(list[2].id).toBe(cat2.id);
    expect(list[2].order).toBe(2);
  });

  it('reorders and reparents category', () => {
    const parent = categoryService.create('Parent');
    const cat1 = categoryService.create('1');

    categoryService.reorder(cat1.id, 0, parent.id);

    const updated = categoryService.get(cat1.id);
    expect(updated?.parentId).toBe(parent.id);
    expect(updated?.order).toBe(0);
  });

  it('starts watcher on init and notifies renderer on change', async () => {
    const window = createMockBrowserWindow();
    (
      electronMock.BrowserWindow as unknown as { getAllWindows: ReturnType<typeof vi.fn> }
    ).getAllWindows.mockReturnValue([window]);

    await categoryService.init();
    expect(mockWatcherStart).toHaveBeenCalled();

    // Simulate external change
    vfs.mock.writeFileSync(
      '/mock/home/.komla/settings/categories.json',
      JSON.stringify({
        _version: 1,
        categories: [{ id: 'ext', name: 'External', parentId: null, order: 0 }],
      })
    );

    if (mockWatcherCallback) mockWatcherCallback();

    expect(window.webContents.send).toHaveBeenCalledWith(
      'categories:changed',
      expect.arrayContaining([expect.objectContaining({ id: 'ext' })])
    );
  });
});
