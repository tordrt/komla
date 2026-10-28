import { randomUUID } from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

import { BrowserWindow } from 'electron';

import { IPC } from '../../shared/constants/ipc-channels';
import { writeFileAtomicSync } from '../lib/atomic-write';
import { migrate } from '../lib/migration';

import { FileWatcher } from './file-watcher';
import { getKomlaBasePath } from './paths';

export interface Category {
  id: string;
  name: string;
  parentId: string | null;
  order: number;
}

const CATEGORY_VERSION = 1;
const CATEGORY_MIGRATIONS: Record<
  number,
  (data: Record<string, unknown>) => Record<string, unknown>
> = {};

// Empty categories file for fresh installs
const DEFAULT_CATEGORIES_FILE = { _version: CATEGORY_VERSION, categories: [] as Category[] };

class CategoryService {
  private settingsPath: string;
  private categoriesPath: string;
  private defaultsPath: string;
  private defaultCategoriesPath: string;
  private watcher: FileWatcher | null = null;
  private categories: Map<string, Category> = new Map();
  private initialized = false;

  constructor() {
    const komlaPath = getKomlaBasePath();
    this.settingsPath = join(komlaPath, 'settings');
    this.categoriesPath = join(this.settingsPath, 'categories.json');
    this.defaultsPath = join(this.settingsPath, 'defaults');
    this.defaultCategoriesPath = join(this.defaultsPath, 'categories.json');

    this.ensureSettingsDirectory();
    this.loadCategories();
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    await this.startWatcher();
  }

  private ensureSettingsDirectory(): void {
    // Create settings directory
    if (!existsSync(this.settingsPath)) {
      mkdirSync(this.settingsPath, { recursive: true });
    }

    // Create defaults directory if needed
    if (!existsSync(this.defaultsPath)) {
      mkdirSync(this.defaultsPath, { recursive: true });
    }

    // Write defaults file for reference on first run
    if (!existsSync(this.defaultCategoriesPath)) {
      writeFileSync(
        this.defaultCategoriesPath,
        JSON.stringify(DEFAULT_CATEGORIES_FILE, null, 2),
        'utf-8'
      );
    }

    // Write user config if not exists
    if (!existsSync(this.categoriesPath)) {
      writeFileSync(this.categoriesPath, JSON.stringify(DEFAULT_CATEGORIES_FILE, null, 2), 'utf-8');
    }
  }

  private loadCategories(): void {
    try {
      if (existsSync(this.categoriesPath)) {
        const data = readFileSync(this.categoriesPath, 'utf-8');
        const parsed: unknown = JSON.parse(data);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          console.error('Categories file has unexpected format, resetting to empty list');
          return;
        }

        const migrated = migrate(
          parsed as Record<string, unknown>,
          CATEGORY_VERSION,
          CATEGORY_MIGRATIONS
        );
        const categoriesList = Array.isArray(migrated['categories']) ? migrated['categories'] : [];

        this.categories.clear();
        for (const category of categoriesList as Category[]) {
          this.categories.set(category.id, category);
        }
      }
    } catch (error) {
      console.error('Failed to load categories:', error);
    }
  }

  private saveCategories(): void {
    try {
      const categoriesData = {
        _version: CATEGORY_VERSION,
        categories: Array.from(this.categories.values()),
      };
      writeFileAtomicSync(this.categoriesPath, JSON.stringify(categoriesData, null, 2));
    } catch (error) {
      console.error('Failed to save categories:', error);
    }
  }

  private async startWatcher(): Promise<void> {
    this.watcher = new FileWatcher(this.categoriesPath, () => {
      this.loadCategories();
      this.notifyRenderer();
    });
    await this.watcher.start();
  }

  private notifyRenderer(): void {
    const categories = this.list();
    const windows = BrowserWindow.getAllWindows();
    for (const window of windows) {
      if (!window.isDestroyed()) {
        window.webContents.send(IPC.CATEGORIES_CHANGED, categories);
      }
    }
  }

  // Public API

  create(name: string, parentId?: string): Category {
    // Get max order for siblings
    const siblings = Array.from(this.categories.values()).filter(
      (c) => c.parentId === (parentId || null)
    );
    const maxOrder = siblings.reduce((max, c) => Math.max(max, c.order), -1);

    const category: Category = {
      id: randomUUID(),
      name,
      parentId: parentId || null,
      order: maxOrder + 1,
    };

    this.categories.set(category.id, category);
    this.saveCategories();
    return category;
  }

  update(id: string, updates: Partial<Omit<Category, 'id'>>): Category {
    const category = this.categories.get(id);
    if (!category) {
      throw new Error(`Category ${id} not found`);
    }

    Object.assign(category, updates);
    this.saveCategories();
    return category;
  }

  delete(id: string): void {
    const category = this.categories.get(id);
    if (!category) {
      throw new Error(`Category ${id} not found`);
    }

    // Check for children
    const children = Array.from(this.categories.values()).filter((c) => c.parentId === id);
    if (children.length > 0) {
      // Move children to parent's parent
      for (const child of children) {
        child.parentId = category.parentId;
      }
    }

    this.categories.delete(id);
    this.saveCategories();
  }

  list(): Category[] {
    return Array.from(this.categories.values()).sort((a, b) => a.order - b.order);
  }

  get(id: string): Category | undefined {
    return this.categories.get(id);
  }

  reorder(id: string, newOrder: number, newParentId?: string | null): void {
    const category = this.categories.get(id);
    if (!category) {
      throw new Error(`Category ${id} not found`);
    }

    const oldParentId = category.parentId;
    const targetParentId = newParentId !== undefined ? newParentId : oldParentId;

    // Get siblings in target parent
    const siblings = Array.from(this.categories.values())
      .filter((c) => c.parentId === targetParentId && c.id !== id)
      .sort((a, b) => a.order - b.order);

    // Update order for siblings
    let order = 0;
    for (const sibling of siblings) {
      if (order === newOrder) {
        order++;
      }
      sibling.order = order;
      order++;
    }

    category.parentId = targetParentId;
    category.order = newOrder;

    this.saveCategories();
  }

  getSettingsPath(): string {
    return this.categoriesPath;
  }

  async dispose(): Promise<void> {
    if (this.watcher) {
      await this.watcher.stop();
      this.watcher = null;
    }
  }
}

export const categoryService = new CategoryService();
