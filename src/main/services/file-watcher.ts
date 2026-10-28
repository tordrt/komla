import { realpathSync } from 'fs';
import { dirname } from 'path';

import * as watcher from '@parcel/watcher';

/**
 * FileWatcher provides a simple API for watching single files with debouncing.
 * This is a lightweight wrapper around @parcel/watcher for config file hot-reload.
 */
export class FileWatcher {
  private subscription: watcher.AsyncSubscription | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private readonly debounceMs: number;
  private readonly filePath: string;
  private readonly onChange: () => void;

  constructor(filePath: string, onChange: () => void, debounceMs = 100) {
    this.filePath = filePath;
    this.onChange = onChange;
    this.debounceMs = debounceMs;
  }

  async start(): Promise<void> {
    if (this.subscription) {
      return; // Already watching
    }

    const dir = realpathSync(dirname(this.filePath));
    const fileName = this.filePath.split('/').pop() || this.filePath.split('\\').pop();

    this.subscription = await watcher.subscribe(dir, (err, events) => {
      if (err) {
        console.error(`File watcher error for ${this.filePath}:`, err);
        return;
      }

      // Filter for events on our specific file
      const relevant = events.some(
        (event) =>
          (event.type === 'update' || event.type === 'create') &&
          (event.path === this.filePath ||
            event.path.endsWith(`/${fileName}`) ||
            event.path.endsWith(`\\${fileName}`))
      );

      if (relevant) {
        this.debouncedNotify();
      }
    });
  }

  private debouncedNotify(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.onChange();
    }, this.debounceMs);
  }

  async stop(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.subscription) {
      await this.subscription.unsubscribe();
      this.subscription = null;
    }
  }
}

/**
 * MultiFileWatcher watches multiple files in the same directory with debouncing.
 * Useful for services that need to watch several config files.
 */
export class MultiFileWatcher {
  private subscription: watcher.AsyncSubscription | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private readonly debounceMs: number;
  private readonly filePaths: string[];
  private readonly onChange: (filePath: string) => void;
  private readonly directory: string;

  constructor(filePaths: string[], onChange: (filePath: string) => void, debounceMs = 100) {
    this.filePaths = filePaths;
    this.onChange = onChange;
    this.debounceMs = debounceMs;

    // All files should be in the same directory
    const dirs = [...new Set(filePaths.map((p) => dirname(p)))];
    if (dirs.length !== 1) {
      throw new Error('MultiFileWatcher requires all files to be in the same directory');
    }
    this.directory = realpathSync(dirs[0]);
  }

  async start(): Promise<void> {
    if (this.subscription) {
      return;
    }

    // Extract just the file names for quick matching
    const fileNames = new Set(
      this.filePaths.map((p) => {
        const parts = p.split(/[/\\]/);
        return parts[parts.length - 1];
      })
    );

    this.subscription = await watcher.subscribe(this.directory, (err, events) => {
      if (err) {
        console.error(`MultiFileWatcher error:`, err);
        return;
      }

      for (const event of events) {
        if (event.type !== 'update' && event.type !== 'create') {
          continue;
        }

        // Check if this event is for one of our watched files
        const eventFileName = event.path.split(/[/\\]/).pop();
        if (eventFileName && fileNames.has(eventFileName)) {
          this.debouncedNotify(event.path);
        }
      }
    });
  }

  private pendingPaths: Set<string> = new Set();

  private debouncedNotify(filePath: string): void {
    this.pendingPaths.add(filePath);

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      const paths = [...this.pendingPaths];
      this.pendingPaths.clear();
      for (const path of paths) {
        this.onChange(path);
      }
    }, this.debounceMs);
  }

  async stop(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.pendingPaths.clear();
    if (this.subscription) {
      await this.subscription.unsubscribe();
      this.subscription = null;
    }
  }
}
