import { lstat, mkdir, open, readdir, readFile, realpath, rmdir, unlink } from 'fs/promises';
import { join, relative, sep } from 'path';

import * as watcher from '@parcel/watcher';
import { shell } from 'electron';

import { getNoteTitle, NOTE_NAME_PATTERN, NOTES_SCOPE_PATTERN } from '../../shared/lib/notes';
import { writeFileAtomic } from '../lib/atomic-write';
import { createLogger } from '../lib/logger';

import { getKomlaBasePath } from './paths';

import type { NoteSummary } from '../../shared/types/notes';

const logger = createLogger('NotesService');

// The start of a note is enough for its title.
const TITLE_READ_BYTES = 4096;
const CHANGE_DEBOUNCE_MS = 150;

function isBlank(content: string): boolean {
  return content.trim() === '';
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** A new note's file name, from when it was made: 2026-10-15-143210.md. */
function timestampName(now: Date): string {
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${date}-${time}`;
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

/** Reads a note, refusing anything but a file: opening a FIFO would wait forever for a writer. */
async function readNoteFile(path: string): Promise<string> {
  if (!(await lstat(path)).isFile()) throw new Error('Not a note');
  return readFile(path, 'utf-8');
}

/**
 * Markdown notes kept in Komla's data folder rather than in a project, one
 * folder per workspace, so drafting a prompt never touches the repository.
 */
export class NotesService {
  private subscription: Promise<watcher.AsyncSubscription | null> | null = null;
  private readonly pendingChanges = new Map<string, ReturnType<typeof setTimeout>>();
  // Changes to one workspace's notes run one at a time, so New note can't hand
  // out the blank note a closing editor is deleting, or make two at once.
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly getRoot: () => string = () => join(getKomlaBasePath(), 'notes'),
    private readonly now: () => Date = () => new Date()
  ) {}

  /** A workspace's notes, most recently changed first. */
  async list(scopeId: string): Promise<NoteSummary[]> {
    const dir = this.scopeDir(scopeId);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (error) {
      if (isErrorCode(error, 'ENOENT')) return [];
      throw error;
    }
    const notes = await Promise.all(
      names
        .filter((name) => NOTE_NAME_PATTERN.test(name))
        .map((name) => this.summarize(dir, name).catch(() => null))
    );
    return notes
      .filter((note): note is NoteSummary => note !== null)
      .sort((a, b) => b.modifiedMs - a.modifiedMs || b.name.localeCompare(a.name));
  }

  /** Makes a blank note, or returns the workspace's blank note if it already has one. */
  async create(scopeId: string): Promise<NoteSummary> {
    return this.inOrder(scopeId, () => this.createNow(scopeId));
  }

  private async createNow(scopeId: string): Promise<NoteSummary> {
    const dir = this.scopeDir(scopeId);
    const blank = (await this.list(scopeId)).find((note) => note.title === '');
    // Something else may have deleted it since the listing.
    const blankText = blank ? await readNoteFile(blank.path).catch(() => null) : null;
    if (blank && blankText !== null && isBlank(blankText)) return blank;

    await mkdir(dir, { recursive: true });
    const base = timestampName(this.now());
    for (let attempt = 1; attempt <= 100; attempt++) {
      const name = attempt === 1 ? `${base}.md` : `${base}-${attempt}.md`;
      try {
        // 'wx' fails rather than reuse a note made at the same second.
        const handle = await open(join(dir, name), 'wx');
        await handle.close();
        return this.summarize(dir, name);
      } catch (error) {
        if (!isErrorCode(error, 'EEXIST')) throw error;
      }
    }
    throw new Error('Could not name a new note');
  }

  async read(scopeId: string, name: string): Promise<string> {
    return readNoteFile(this.notePath(scopeId, name));
  }

  async write(scopeId: string, name: string, content: string): Promise<void> {
    const path = this.notePath(scopeId, name);
    return this.inOrder(scopeId, async () => {
      // Writing would bring back a deleted note, and with it a deleted workspace's folder.
      const stats = await lstat(path).catch((error: unknown) => {
        if (isErrorCode(error, 'ENOENT')) return null;
        throw error;
      });
      if (!stats) throw new Error('This note was deleted');
      if (!stats.isFile()) throw new Error('Not a note');
      await writeFileAtomic(path, content);
    });
  }

  /** Moves a note to the trash, so a mistaken delete can be undone. */
  async trash(scopeId: string, name: string): Promise<void> {
    const path = this.notePath(scopeId, name);
    return this.inOrder(scopeId, () => shell.trashItem(path));
  }

  /** Moves a deleted workspace's notes to the trash, where a note still wanted can be found. */
  async trashAll(scopeId: string): Promise<void> {
    const dir = this.scopeDir(scopeId);
    return this.inOrder(scopeId, async () => {
      try {
        // A folder without notes isn't worth a place in the trash.
        await rmdir(dir);
      } catch (error) {
        if (isErrorCode(error, 'ENOENT')) return;
        if (!isErrorCode(error, 'ENOTEMPTY') && !isErrorCode(error, 'EEXIST')) throw error;
        await shell.trashItem(dir);
      }
    });
  }

  /**
   * Deletes a note for good, as when it was saved into the project. With
   * onlyIfBlank, deletes it only if the file itself has no text, so text an
   * agent wrote after the editor last read it is kept. Returns whether it did.
   */
  async delete(
    scopeId: string,
    name: string,
    { onlyIfBlank = false }: { onlyIfBlank?: boolean } = {}
  ): Promise<boolean> {
    const path = this.notePath(scopeId, name);
    return this.inOrder(scopeId, async () => {
      try {
        if (onlyIfBlank && !isBlank(await readNoteFile(path))) return false;
        await unlink(path);
        return true;
      } catch (error) {
        if (isErrorCode(error, 'ENOENT')) return false;
        throw error;
      }
    });
  }

  /** Calls onChange with a workspace's id when its notes change on disk, from Komla or anything else. */
  watch(onChange: (scopeId: string) => void): void {
    this.subscription ??= this.subscribe(onChange);
  }

  async stopWatching(): Promise<void> {
    const subscription = await this.subscription;
    this.subscription = null;
    for (const timer of this.pendingChanges.values()) clearTimeout(timer);
    this.pendingChanges.clear();
    await subscription?.unsubscribe();
  }

  private async subscribe(
    onChange: (scopeId: string) => void
  ): Promise<watcher.AsyncSubscription | null> {
    try {
      await mkdir(this.getRoot(), { recursive: true });
      // Events carry real paths (/private/var on macOS), so compare against the real root.
      const root = await realpath(this.getRoot());
      return await watcher.subscribe(root, (error, events) => {
        if (error) {
          logger.debug('Notes watcher error', { error });
          return;
        }
        for (const event of events) {
          const [scopeId, name] = relative(root, event.path).split(sep);
          if (!scopeId || !NOTES_SCOPE_PATTERN.test(scopeId)) continue;
          // Atomic writes pass through a temporary file first.
          if (name !== undefined && !NOTE_NAME_PATTERN.test(name)) continue;
          this.notifyChange(scopeId, onChange);
        }
      });
    } catch (error) {
      logger.warn('Could not watch notes', { error });
      // Try again on the next listing.
      this.subscription = null;
      return null;
    }
  }

  private inOrder<T>(scopeId: string, task: () => Promise<T>): Promise<T> {
    const result = (this.queues.get(scopeId) ?? Promise.resolve()).then(task, task);
    const settled = result.then(
      () => {},
      () => {}
    );
    this.queues.set(scopeId, settled);
    void settled.then(() => {
      if (this.queues.get(scopeId) === settled) this.queues.delete(scopeId);
    });
    return result;
  }

  private notifyChange(scopeId: string, onChange: (scopeId: string) => void): void {
    clearTimeout(this.pendingChanges.get(scopeId));
    this.pendingChanges.set(
      scopeId,
      setTimeout(() => {
        this.pendingChanges.delete(scopeId);
        onChange(scopeId);
      }, CHANGE_DEBOUNCE_MS)
    );
  }

  private async summarize(dir: string, name: string): Promise<NoteSummary> {
    const path = join(dir, name);
    const stats = await lstat(path);
    if (!stats.isFile()) throw new Error('Not a note');
    const handle = await open(path, 'r');
    try {
      const buffer = Buffer.alloc(TITLE_READ_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, TITLE_READ_BYTES, 0);
      const { mtimeMs } = stats;
      return {
        name,
        title: getNoteTitle(buffer.subarray(0, bytesRead).toString('utf-8')),
        path,
        modifiedMs: mtimeMs,
      };
    } finally {
      await handle.close();
    }
  }

  private scopeDir(scopeId: string): string {
    if (!NOTES_SCOPE_PATTERN.test(scopeId)) throw new Error('Invalid notes folder');
    return join(this.getRoot(), scopeId);
  }

  private notePath(scopeId: string, name: string): string {
    if (!NOTE_NAME_PATTERN.test(name)) throw new Error('Invalid note name');
    return join(this.scopeDir(scopeId), name);
  }
}

export const notesService = new NotesService();
