import { execFileSync } from 'child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import * as watcher from '@parcel/watcher';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NotesService } from '../../../src/main/services/notes.service';

const mocks = vi.hoisted(() => ({ trashItem: vi.fn() }));

vi.mock('electron', () => ({ shell: { trashItem: mocks.trashItem } }));
vi.mock('../../../src/main/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@parcel/watcher');

const SCOPE = '0b3e6f9a-2c41-4f3e-9a8b-1d2c3e4f5a6b';

describe('NotesService', () => {
  let root: string;
  let now: Date;
  let service: NotesService;

  const notePath = (name: string) => join(root, SCOPE, name);
  const writeNote = (name: string, content: string, mtime?: Date) => {
    mkdirSync(join(root, SCOPE), { recursive: true });
    writeFileSync(notePath(name), content);
    if (mtime) utimesSync(notePath(name), mtime, mtime);
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'komla-notes-'));
    now = new Date(2026, 9, 15, 14, 32, 10);
    service = new NotesService(
      () => root,
      () => now
    );
    mocks.trashItem.mockReset().mockImplementation(async (path: string) => rmSync(path));
  });

  afterEach(async () => {
    await service.stopWatching();
    rmSync(root, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it('lists notes newest first, titled by their first line of text', async () => {
    writeNote('2026-10-14-090000.md', '---\nstatus: draft\n---\n\n# Older plan\n', new Date(1000));
    writeNote('2026-10-15-100000.md', '- [ ] **Refactor** the `codec`\n', new Date(2000));
    writeNote('notes.txt', 'not a note');

    const notes = await service.list(SCOPE);

    expect(notes.map(({ name, title }) => ({ name, title }))).toEqual([
      { name: '2026-10-15-100000.md', title: 'Refactor the codec' },
      { name: '2026-10-14-090000.md', title: 'Older plan' },
    ]);
    expect(notes[0].path).toBe(notePath('2026-10-15-100000.md'));
  });

  it('lists nothing for a workspace without notes', async () => {
    await expect(service.list(SCOPE)).resolves.toEqual([]);
  });

  it('makes a blank note named for when it was made', async () => {
    const note = await service.create(SCOPE);

    expect(note).toMatchObject({ name: '2026-10-15-143210.md', title: '' });
    expect(readFileSync(notePath(note.name), 'utf-8')).toBe('');
  });

  it('reuses the blank note rather than piling up empty ones', async () => {
    const first = await service.create(SCOPE);
    now = new Date(2026, 9, 15, 15, 0, 0);
    const second = await service.create(SCOPE);

    expect(second.name).toBe(first.name);
    expect(await service.list(SCOPE)).toHaveLength(1);
  });

  it('never hands out a blank note that a close is deleting', async () => {
    for (let round = 0; round < 20; round++) {
      const blank = await service.create(SCOPE);
      // The note editor deletes a blank note it closes, perhaps while New note runs.
      const [, note] = await Promise.all([
        service.delete(SCOPE, blank.name, { onlyIfBlank: true }),
        service.create(SCOPE),
      ]);
      expect(existsSync(notePath(note.name))).toBe(true);
      now = new Date(now.getTime() + 1000);
    }
  });

  it('hands out one blank note to creates that overlap', async () => {
    const notes = await Promise.all([service.create(SCOPE), service.create(SCOPE)]);

    expect(notes[1].name).toBe(notes[0].name);
    expect(await service.list(SCOPE)).toHaveLength(1);
  });

  it.skipIf(process.platform === 'win32')(
    'skips anything in the folder that is not a file',
    async () => {
      writeNote('2026-10-15-100000.md', 'A note');
      // Opening a FIFO blocks until a writer comes, which would stall listing.
      execFileSync('mkfifo', [notePath('2026-10-15-110000.md')]);
      mkdirSync(notePath('2026-10-15-120000.md'));

      const notes = await service.list(SCOPE);

      expect(notes.map((note) => note.name)).toEqual(['2026-10-15-100000.md']);
      await expect(service.read(SCOPE, '2026-10-15-110000.md')).rejects.toThrow(/Not a note/);
    }
  );

  it('names a second note made in the same second apart from the first', async () => {
    const first = await service.create(SCOPE);
    await service.write(SCOPE, first.name, 'Draft');
    const second = await service.create(SCOPE);

    expect(second.name).toBe('2026-10-15-143210-2.md');
  });

  it('writes and reads a note', async () => {
    const { name } = await service.create(SCOPE);
    await service.write(SCOPE, name, '# Prompt\n\nFix the login bug.\n');

    await expect(service.read(SCOPE, name)).resolves.toBe('# Prompt\n\nFix the login bug.\n');
  });

  it("won't bring back a note deleted while it was open", async () => {
    const { name } = await service.create(SCOPE);
    rmSync(join(root, SCOPE), { recursive: true });

    await expect(service.write(SCOPE, name, 'A late save')).rejects.toThrow(
      'This note was deleted'
    );
    expect(existsSync(join(root, SCOPE))).toBe(false);
  });

  it('keeps a blank-only delete from removing a note an agent wrote to', async () => {
    writeNote('2026-10-15-100000.md', 'Written by an agent');

    await expect(
      service.delete(SCOPE, '2026-10-15-100000.md', { onlyIfBlank: true })
    ).resolves.toBe(false);
    expect(existsSync(notePath('2026-10-15-100000.md'))).toBe(true);
  });

  it('deletes a blank note, and any note when asked to', async () => {
    writeNote('2026-10-15-100000.md', '  \n');
    writeNote('2026-10-15-110000.md', 'Saved into the project');

    await expect(
      service.delete(SCOPE, '2026-10-15-100000.md', { onlyIfBlank: true })
    ).resolves.toBe(true);
    await expect(service.delete(SCOPE, '2026-10-15-110000.md')).resolves.toBe(true);
    await expect(service.delete(SCOPE, '2026-10-15-110000.md')).resolves.toBe(false);
    expect(await service.list(SCOPE)).toEqual([]);
  });

  it('moves a deleted note to the trash', async () => {
    writeNote('2026-10-15-100000.md', 'Old idea');

    await service.trash(SCOPE, '2026-10-15-100000.md');

    expect(mocks.trashItem).toHaveBeenCalledWith(notePath('2026-10-15-100000.md'));
  });

  it('lets a save in progress finish before moving its note to the trash', async () => {
    const { name } = await service.create(SCOPE);

    const saving = service.write(SCOPE, name, 'Last words');
    const trashing = service.trash(SCOPE, name);
    // A save finishing after the move would bring the note back.
    expect(mocks.trashItem).not.toHaveBeenCalled();
    await Promise.all([saving, trashing]);

    expect(mocks.trashItem).toHaveBeenCalledWith(notePath(name));
    expect(existsSync(notePath(name))).toBe(false);
  });

  describe('when the workspace is deleted', () => {
    beforeEach(() => {
      mocks.trashItem.mockImplementation(async (path: string) => rmSync(path, { recursive: true }));
    });

    it('moves its notes to the trash', async () => {
      writeNote('2026-10-15-100000.md', 'Old idea');

      await service.trashAll(SCOPE);

      expect(mocks.trashItem).toHaveBeenCalledWith(join(root, SCOPE));
      expect(existsSync(join(root, SCOPE))).toBe(false);
    });

    it('removes a folder without notes instead of trashing it', async () => {
      mkdirSync(join(root, SCOPE));

      await service.trashAll(SCOPE);

      expect(mocks.trashItem).not.toHaveBeenCalled();
      expect(existsSync(join(root, SCOPE))).toBe(false);
    });

    it('does nothing when the workspace never had notes', async () => {
      await service.trashAll(SCOPE);

      expect(mocks.trashItem).not.toHaveBeenCalled();
    });

    it('lets a save in progress finish first, and refuses saves after', async () => {
      const { name } = await service.create(SCOPE);

      const saving = service.write(SCOPE, name, 'Last words');
      await service.trashAll(SCOPE);
      await saving;

      expect(mocks.trashItem).toHaveBeenCalledWith(join(root, SCOPE));
      await expect(service.write(SCOPE, name, 'Too late')).rejects.toThrow('This note was deleted');
      expect(existsSync(join(root, SCOPE))).toBe(false);
    });
  });

  it.each([
    ['a scope outside the notes folder', '..', '2026-10-15-100000.md'],
    ['a scope with a separator', 'a/b', '2026-10-15-100000.md'],
    ['a name outside the scope', SCOPE, '../escape.md'],
    ['a name that is not a note', SCOPE, 'notes.txt'],
  ])('refuses %s', async (_case, scopeId, name) => {
    await expect(service.read(scopeId, name)).rejects.toThrow(/Invalid/);
    await expect(service.write(scopeId, name, 'x')).rejects.toThrow(/Invalid/);
  });

  it('reports which workspace changed once a burst of changes settles', async () => {
    vi.useFakeTimers();
    const unsubscribe = vi.fn().mockResolvedValue(undefined);
    vi.mocked(watcher.subscribe).mockResolvedValue({ unsubscribe } as never);
    const onChange = vi.fn();

    service.watch(onChange);
    service.watch(onChange);
    await vi.waitFor(() => expect(watcher.subscribe).toHaveBeenCalledTimes(1));
    const [watchedRoot, callback] = vi.mocked(watcher.subscribe).mock.calls[0];

    callback(null, [
      { type: 'create', path: join(watchedRoot, SCOPE, '2026-10-15-100000.md.1a2b3c.tmp') },
      { type: 'create', path: join(watchedRoot, SCOPE, '2026-10-15-100000.md') },
      { type: 'update', path: join(watchedRoot, SCOPE, '2026-10-15-100000.md') },
    ]);
    callback(null, [{ type: 'create', path: join(watchedRoot, 'not a scope!', 'x.md') }]);
    vi.runAllTimers();

    expect(onChange.mock.calls).toEqual([[SCOPE]]);
    await service.stopWatching();
    expect(unsubscribe).toHaveBeenCalled();
  });

  it('tries watching again after a failed start', async () => {
    vi.mocked(watcher.subscribe)
      .mockRejectedValueOnce(new Error('inotify limit reached'))
      .mockResolvedValue({ unsubscribe: vi.fn().mockResolvedValue(undefined) } as never);

    service.watch(vi.fn());
    await vi.waitFor(() => expect(watcher.subscribe).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    service.watch(vi.fn());

    await vi.waitFor(() => expect(watcher.subscribe).toHaveBeenCalledTimes(2));
  });
});
