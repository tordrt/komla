import { randomUUID } from 'crypto';
import { existsSync, readFileSync, realpathSync } from 'fs';
import { basename, dirname, join } from 'path';

import * as watcher from '@parcel/watcher';

import { writeFileAtomicSync } from '../lib/atomic-write';
import { createLogger } from '../lib/logger';

import { getKomlaBasePath } from './paths';

import type {
  SettingsHistoryEntry,
  SettingsHistoryFile,
} from '../../shared/types/settings-history';

const logger = createLogger('SettingsHistoryService');

/** The settings files Komla reloads when they change on disk, so a revert applies at once. */
export const SETTINGS_HISTORY_FILES: readonly SettingsHistoryFile[] = [
  'theme.json',
  'terminal.json',
  'shortcuts.json',
  'actions.json',
  'categories.json',
  'agent-presets.json',
  'projects.json',
  'status-items.json',
  'hooks.json',
];

const STATE_VERSION = 1;
const MAX_ENTRIES = 100;
// Settings saved while a slider moves, or an agent's edits in a row, are one change.
const COALESCE_MS = 3000;
const WATCH_DEBOUNCE_MS = 200;
// Deeper changes are named by their parent, as `colors.accent` rather than its components.
const MAX_KEY_DEPTH = 2;

interface StoredEntry {
  id: string;
  file: SettingsHistoryFile;
  at: number;
  before: string | null;
  after: string | null;
  revertOf?: string;
}

interface StoredState {
  version: number;
  /** Each file's content when last seen, null while it doesn't exist. */
  known: Partial<Record<SettingsHistoryFile, string | null>>;
  /** Newest first. */
  entries: StoredEntry[];
}

export interface SettingsHistoryOptions {
  settingsDir: string;
  statePath: string;
  now?: () => number;
  /** Calls `onChange` whenever a file in `settingsDir` may have changed; returns a stop function. */
  watch?: (settingsDir: string, onChange: () => void) => Promise<() => Promise<void>>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]))
    );
  }
  return false;
}

// What Komla records about use, such as when an Action or agent last ran; launching an agent
// rewrites them, which isn't a change to the settings.
const USAGE_KEYS = new Set([
  'lastUsedAt',
  'lastUserInput',
  'lastLaunchModeId',
  'lastReasoningLevelId',
]);

function withoutUsage(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutUsage);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !USAGE_KEYS.has(key))
      .map(([key, item]) => [key, withoutUsage(item)])
  );
}

function parse(content: string | null): { ok: true; value: unknown } | { ok: false } {
  if (content === null) return { ok: true, value: undefined };
  try {
    return { ok: true, value: withoutUsage(JSON.parse(content.replace(/^﻿/, ''))) };
  } catch {
    return { ok: false };
  }
}

// Items such as actions and presets carry ids, so a change names the item instead of its index.
function itemLabel(item: unknown): string | undefined {
  if (!isPlainObject(item) || typeof item.id !== 'string') return undefined;
  for (const key of ['name', 'title', 'label']) {
    if (typeof item[key] === 'string' && item[key]) return item[key];
  }
  return item.id;
}

function itemsById(items: unknown[]): Map<string, unknown> | undefined {
  const byId = new Map<string, unknown>();
  for (const item of items) {
    if (!isPlainObject(item) || typeof item.id !== 'string') return undefined;
    byId.set(item.id, item);
  }
  return byId.size === items.length ? byId : undefined;
}

// Names the items of two id-keyed lists that differ; none when only their order changed.
function changedItems(a: unknown[], b: unknown[], path: string): string[] {
  const before = itemsById(a);
  const after = itemsById(b);
  if (!before || !after) return [];
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((id) => !deepEqual(before.get(id), after.get(id)))
    .map((id) => `${path}[${itemLabel(after.get(id)) ?? itemLabel(before.get(id))}]`);
}

function collectChanges(a: unknown, b: unknown, path: string, depth: number, out: string[]): void {
  if (deepEqual(a, b)) return;
  if (depth < MAX_KEY_DEPTH && isPlainObject(a) && isPlainObject(b)) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (key === '_version') continue;
      collectChanges(a[key], b[key], path ? `${path}.${key}` : key, depth + 1, out);
    }
    return;
  }
  const items = Array.isArray(a) && Array.isArray(b) ? changedItems(a, b, path) : [];
  out.push(...(items.length > 0 ? items : [path]));
}

/** The settings that differ between two versions of a file; empty when either isn't JSON. */
export function changedSettingKeys(before: string | null, after: string | null): string[] {
  const a = parse(before);
  const b = parse(after);
  if (!a.ok || !b.ok) return [];
  const out: string[] = [];
  collectChanges(a.value, b.value, '', 0, out);
  return out.filter(Boolean);
}

function sameSettings(before: string | null, after: string | null): boolean {
  if (before === after) return true;
  const a = parse(before);
  const b = parse(after);
  return a.ok && b.ok && deepEqual(a.value, b.value);
}

async function watchDirectory(
  settingsDir: string,
  onChange: () => void
): Promise<() => Promise<void>> {
  const directory = realpathSync(settingsDir);
  const tracked = new Set<string>(SETTINGS_HISTORY_FILES);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const subscription = await watcher.subscribe(directory, (error, events) => {
    if (error) {
      logger.warn('Settings history watcher error', error);
      return;
    }
    const relevant = events.some(
      (event) => dirname(event.path) === directory && tracked.has(basename(event.path))
    );
    if (!relevant) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onChange();
    }, WATCH_DEBOUNCE_MS);
  });
  return async () => {
    if (timer) clearTimeout(timer);
    await subscription.unsubscribe();
  };
}

/**
 * Records every change to Komla's settings files, whoever made it, with the content before it, so
 * any change can be reverted from Settings. Agents edit these files directly or through
 * `komla settings apply`; this is how a user takes such a change back.
 */
export class SettingsHistoryService {
  private readonly settingsDir: string;
  private readonly statePath: string;
  private readonly now: () => number;
  private readonly watch: NonNullable<SettingsHistoryOptions['watch']>;
  private state: StoredState = { version: STATE_VERSION, known: {}, entries: [] };
  private stopWatching: (() => Promise<void>) | null = null;
  private started = false;
  private readonly listeners = new Set<() => void>();

  constructor(options: SettingsHistoryOptions) {
    this.settingsDir = options.settingsDir;
    this.statePath = options.statePath;
    this.now = options.now ?? Date.now;
    this.watch = options.watch ?? watchDirectory;
  }

  /** Records changes made while Komla was closed, then follows changes as they happen. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const firstRun = !this.loadState();
    if (firstRun) {
      for (const file of SETTINGS_HISTORY_FILES) this.state.known[file] = this.read(file);
      this.saveState();
    } else {
      this.scan();
    }
    this.stopWatching = await this.watch(this.settingsDir, () => this.scan());
  }

  async dispose(): Promise<void> {
    await this.stopWatching?.();
    this.stopWatching = null;
    this.started = false;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list(): SettingsHistoryEntry[] {
    const seen = new Map<SettingsHistoryFile, number>();
    return this.state.entries.map((entry) => {
      const laterChanges = seen.get(entry.file) ?? 0;
      seen.set(entry.file, laterChanges + 1);
      return {
        id: entry.id,
        file: entry.file,
        at: entry.at,
        changedKeys: changedSettingKeys(entry.before, entry.after),
        ...(entry.revertOf && { revertOf: entry.revertOf }),
        laterChanges,
      };
    });
  }

  /**
   * Puts the file back as it was before the change, which also undoes later changes to the file.
   * The revert is itself recorded, so it can be undone the same way.
   */
  revert(id: string): SettingsHistoryEntry {
    const entry = this.state.entries.find((candidate) => candidate.id === id);
    if (!entry) throw new Error('That change is no longer in the settings history.');
    // Only a revert made while the file was missing has nothing to put back.
    if (entry.before === null) {
      throw new Error(`${entry.file} didn't exist before this change, so it can't be reverted.`);
    }
    this.scan();
    const current = this.state.known[entry.file] ?? null;
    if (sameSettings(current, entry.before)) {
      return this.list().find((candidate) => candidate.id === id)!;
    }
    writeFileAtomicSync(join(this.settingsDir, entry.file), entry.before);
    const revert: StoredEntry = {
      id: randomUUID(),
      file: entry.file,
      at: this.now(),
      before: current,
      after: entry.before,
      revertOf: entry.id,
    };
    this.state.known[entry.file] = entry.before;
    this.state.entries.unshift(revert);
    this.commit();
    return this.list()[0];
  }

  /** Compares each file with its last seen content and records what changed. */
  scan(): void {
    let changed = false;
    for (const file of SETTINGS_HISTORY_FILES) {
      let content: string | null;
      try {
        content = this.read(file);
      } catch (error) {
        logger.warn(`Could not read ${file} for the settings history`, error);
        continue;
      }
      // A file the history didn't follow yet, as after an update adds one, starts from here.
      const followed = file in this.state.known;
      const before = this.state.known[file] ?? null;
      if (followed && content === before) continue;
      this.state.known[file] = content;
      changed = true;
      // Komla writes the files it creates on first run after the history starts, so a new file is
      // setup rather than a change to undo.
      if (!followed || before === null || sameSettings(before, content)) continue;
      this.record(file, before, content);
    }
    if (changed) this.commit();
  }

  private record(file: SettingsHistoryFile, before: string | null, after: string | null): void {
    const now = this.now();
    const latest = this.state.entries[0];
    if (latest && latest.file === file && !latest.revertOf && now - latest.at <= COALESCE_MS) {
      latest.after = after;
      latest.at = now;
      if (sameSettings(latest.before, latest.after)) this.state.entries.shift();
      return;
    }
    this.state.entries.unshift({ id: randomUUID(), file, at: now, before, after });
  }

  private read(file: SettingsHistoryFile): string | null {
    const path = join(this.settingsDir, file);
    try {
      return readFileSync(path, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private loadState(): boolean {
    if (!existsSync(this.statePath)) return false;
    try {
      const parsed = JSON.parse(readFileSync(this.statePath, 'utf-8')) as Partial<StoredState>;
      if (parsed.version !== STATE_VERSION || !isPlainObject(parsed.known)) return false;
      this.state = {
        version: STATE_VERSION,
        known: parsed.known,
        entries: Array.isArray(parsed.entries) ? parsed.entries : [],
      };
      return true;
    } catch (error) {
      logger.warn('Could not read the settings history; starting a new one', error);
      return false;
    }
  }

  private commit(): void {
    this.state.entries.splice(MAX_ENTRIES);
    this.saveState();
    for (const listener of this.listeners) listener();
  }

  private saveState(): void {
    try {
      writeFileAtomicSync(this.statePath, JSON.stringify(this.state));
    } catch (error) {
      logger.warn('Could not save the settings history', error);
    }
  }
}

export const settingsHistoryService = new SettingsHistoryService({
  settingsDir: join(getKomlaBasePath(), 'settings'),
  statePath: join(getKomlaBasePath(), 'settings-history.json'),
});
