import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockBrowserWindow, mockElectron } from '../../mocks/electron';
import { createVirtualFs } from '../../mocks/fs';

import type { ActionService as ActionServiceType } from '../../../src/main/services/action.service';

const electronMock = mockElectron();
vi.mock('electron', () => electronMock);

const vfs = createVirtualFs();
vi.mock('fs', () => vfs.mock);

vi.mock('@electron-toolkit/utils', () => ({
  is: { dev: true },
}));

vi.mock('../../../src/main/services/paths', () => ({
  getKomlaBasePath: () => '/mock/home/.komla',
}));

vi.mock('../../../src/main/lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const mockAtomicWrite = vi.fn(
  (path: string, content: string, _mode?: number, beforeCommit?: () => void) => {
    beforeCommit?.();
    vfs.mock.writeFileSync(path, content);
  }
);
vi.mock('../../../src/main/lib/atomic-write', () => ({ writeFileAtomicSync: mockAtomicWrite }));

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

describe('ActionService', () => {
  let actionService: ActionServiceType;
  let ActionService: new () => ActionServiceType;
  let trackActionUsage: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    vfs.clear();

    const mod = await import('../../../src/main/services/action.service');
    trackActionUsage = vi.fn();
    mod.registerActionUsageTracker(trackActionUsage);
    ActionService = mod.ActionService;
    actionService = new ActionService();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('initializes with default actions', () => {
    expect(vfs.hasFile('/mock/home/.komla/settings/actions.json')).toBe(true);
    const actions = actionService.list();
    expect(actions.length).toBeGreaterThan(0);
    expect(actions[0].title).toBeTypeOf('string');
    const titles = actions.map((action) => action.title);
    expect(titles).not.toContain('Boost test coverage');
    // People paste errors into an agent, and agents find `komla title` through the CLI.
    expect(titles).not.toContain('Investigate error/bug');
    expect(titles).not.toContain('Set workspace title');
  });

  it('lists the project setup prompt first, so the run button starts on it', () => {
    expect(actionService.list()[0].title).toBe('Set up project in Komla');
  });

  it('loads actions.json when it starts with a UTF-8 BOM', () => {
    const action = {
      id: 'action-1',
      title: 'BOM action',
      content: '# Prompt',
      type: 'prompt' as const,
      createdAt: 1234567890,
    };
    vfs.mock.writeFileSync(
      '/mock/home/.komla/settings/actions.json',
      `\ufeff${JSON.stringify({ _version: 1, actions: [action] })}`
    );

    actionService = new ActionService();

    expect(actionService.list()).toEqual([action]);
  });

  it('creates, updates, and deletes actions', () => {
    const created = actionService.create({
      title: 'New action',
      content: '# Prompt',
    });
    expect(created.title).toBe('New action');

    const updated = actionService.update(created.id, {
      title: 'Updated action',
      content: 'Updated content',
    });
    expect(updated.title).toBe('Updated action');
    expect(updated.content).toBe('Updated content');

    actionService.delete(created.id);
    expect(actionService.list().some((action) => action.id === created.id)).toBe(false);
  });

  it('replaces all actions only at the expected persisted revision', () => {
    const before = actionService.getStorageRevision();
    const replacement = [{ id: 'replacement', title: 'Replacement', content: 'npm test' }];
    const window = createMockBrowserWindow();
    electronMock.BrowserWindow.getAllWindows.mockReturnValue([window]);

    const after = actionService.replaceAll(before, replacement);

    expect(after).not.toBe(before);
    expect(actionService.list()).toEqual(replacement);
    expect(window.webContents.send).toHaveBeenCalledTimes(1);
    expect(() => actionService.replaceAll(before, replacement)).toThrow('revision changed');
  });

  it('does not accept the persisted revision when disk state is ahead of memory', () => {
    expect(actionService.getStorageRevisionState()).toEqual({
      status: 'current',
      revision: actionService.getStorageRevision(),
    });
    vfs.mock.writeFileSync(
      '/mock/home/.komla/settings/actions.json',
      JSON.stringify({ actions: [{ id: 'external', title: 'External', content: 'changed' }] })
    );

    expect(actionService.getStorageRevisionState()).toEqual({ status: 'changed' });
    vfs.mock.writeFileSync('/mock/home/.komla/settings/actions.json', '{');
    expect(actionService.getStorageRevisionState()).toEqual({ status: 'unreadable' });
  });

  it('rolls back a whole-state replacement when persistence fails', () => {
    const before = actionService.list();
    const revision = actionService.getStorageRevision();
    mockAtomicWrite.mockImplementationOnce(() => {
      throw new Error('disk full');
    });

    expect(() =>
      actionService.replaceAll(revision, [
        { id: 'replacement', title: 'Replacement', content: 'npm test' },
      ])
    ).toThrow('disk full');
    expect(actionService.list()).toEqual(before);
    expect(electronMock.BrowserWindow.getAllWindows).not.toHaveBeenCalled();
  });

  it('preserves a direct edit that lands while a replacement is being staged', () => {
    const revision = actionService.getStorageRevision();
    const external = JSON.stringify({
      actions: [{ id: 'external', title: 'External', content: 'changed during write' }],
    });
    mockAtomicWrite.mockImplementationOnce((path, content, _mode, beforeCommit) => {
      vfs.mock.writeFileSync(path, external);
      beforeCommit?.();
      vfs.mock.writeFileSync(path, content);
    });

    expect(() =>
      actionService.replaceAll(revision, [
        { id: 'replacement', title: 'Replacement', content: 'npm test' },
      ])
    ).toThrow('revision changed');
    expect(vfs.mock.readFileSync('/mock/home/.komla/settings/actions.json', 'utf8')).toBe(external);
  });

  it('records usage without reordering actions', () => {
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValueOnce(1000);
    nowSpy.mockReturnValueOnce(2000);

    const first = actionService.create({
      title: 'First',
      content: 'first',
    });
    const second = actionService.create({
      title: 'Second',
      content: 'second',
    });

    actionService.recordUsage(first.id);
    actionService.recordUsage(second.id, 'remember me');

    const actions = actionService.list();
    expect(actions.findIndex((action) => action.id === first.id)).toBeLessThan(
      actions.findIndex((action) => action.id === second.id)
    );
    const secondInList = actions.find((action) => action.id === second.id);
    expect(secondInList?.lastUsedAt).toBeTypeOf('number');
    expect(secondInList?.lastUserInput).toBe('remember me');

    nowSpy.mockRestore();
  });

  it("remembers a pasted prompt's input but not when it was used", () => {
    const prompt = actionService.create({ title: 'Review', content: 'Review {{user_input}}' });
    actionService.recordUsage(prompt.id, 'the build');

    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Number.MAX_SAFE_INTEGER);
    actionService.recordUsage(prompt.id, 'the tests', true);
    nowSpy.mockRestore();

    const saved = actionService.list().find((action) => action.id === prompt.id);
    // The last use picks the run button's Action, which a paste leaves as it was.
    expect(saved?.lastUsedAt).not.toBe(Number.MAX_SAFE_INTEGER);
    expect(saved?.lastUserInput).toBe('the tests');
  });

  it('reorders actions and persists the configured order', () => {
    const first = actionService.create({
      title: 'First',
      content: 'first',
    });
    const second = actionService.create({
      title: 'Second',
      content: 'second',
    });
    const third = actionService.create({
      title: 'Third',
      content: 'third',
    });

    actionService.reorder(third.id, 0);

    const actionIds = actionService.list().map((action) => action.id);
    expect(actionIds[0]).toBe(third.id);
    expect(actionIds.indexOf(first.id)).toBeLessThan(actionIds.indexOf(second.id));

    const saved = JSON.parse(
      vfs.mock.readFileSync('/mock/home/.komla/settings/actions.json', 'utf-8') as string
    ) as { actions: Array<{ id: string }> };
    const savedIds = saved.actions.map((action) => action.id);
    expect(savedIds[0]).toBe(third.id);
    expect(savedIds.indexOf(first.id)).toBeLessThan(savedIds.indexOf(second.id));
  });

  it('throws when reordering a missing action', () => {
    expect(() => actionService.reorder('missing-action', 0)).toThrow(
      'Action with id "missing-action" not found'
    );
  });

  it('tracks action usage only when actions are run', () => {
    const prompt = actionService.create({
      title: 'Prompt',
      content: 'summarize this',
    });
    const command = actionService.create({
      title: 'Command',
      content: 'npm test',
      type: 'command',
    });

    actionService.update(prompt.id, { title: 'Updated prompt' });
    expect(trackActionUsage).not.toHaveBeenCalled();

    actionService.recordUsage(prompt.id);
    actionService.recordUsage(command.id);

    expect(trackActionUsage).toHaveBeenNthCalledWith(1, 'prompt');
    expect(trackActionUsage).toHaveBeenNthCalledWith(2, 'command');
  });

  it('creates and updates actions with presetId and launchModeId', () => {
    const created = actionService.create({
      title: 'Preset action',
      content: '# Test',
      presetId: 'preset-1',
      launchModeId: 'mode-1',
    });
    expect(created.presetId).toBe('preset-1');
    expect(created.launchModeId).toBe('mode-1');

    const updated = actionService.update(created.id, {
      presetId: 'preset-2',
    });
    expect(updated.presetId).toBe('preset-2');
    expect(updated.launchModeId).toBe('mode-1');

    const cleared = actionService.update(created.id, {
      presetId: null,
      launchModeId: null,
    });
    expect(cleared.presetId).toBeUndefined();
    expect(cleared.launchModeId).toBeUndefined();
  });

  it('keeps an SSH execution location only on command-type actions', () => {
    const created = actionService.create({
      title: 'Linux desktop',
      content: 'komla desktop run -- npm run dev',
      type: 'command',
      sshExecutionLocation: 'remote',
    });
    expect(created.sshExecutionLocation).toBe('remote');

    const updated = actionService.update(created.id, { sshExecutionLocation: 'local-mirror' });
    expect(updated.sshExecutionLocation).toBe('local-mirror');

    expect(
      actionService.update(created.id, { sshExecutionLocation: null }).sshExecutionLocation
    ).toBeUndefined();
    actionService.update(created.id, { sshExecutionLocation: 'remote' });
    expect(
      actionService.update(created.id, { type: 'prompt' }).sshExecutionLocation
    ).toBeUndefined();
    expect(
      actionService.create({
        title: 'Prompt',
        content: 'Review',
        sshExecutionLocation: 'remote',
      }).sshExecutionLocation
    ).toBeUndefined();
  });

  it('runs only command-type actions in the background', () => {
    const created = actionService.create({
      title: 'Watch CI',
      content: 'gh pr checks --watch',
      type: 'command',
      background: true,
    });
    expect(created.background).toBe(true);

    expect(actionService.update(created.id, { background: false }).background).toBeUndefined();
    actionService.update(created.id, { background: true });
    expect(actionService.update(created.id, { background: null }).background).toBeUndefined();
    actionService.update(created.id, { background: true });
    expect(actionService.update(created.id, { type: 'prompt' }).background).toBeUndefined();
    expect(
      actionService.create({ title: 'Prompt', content: 'Review', background: true }).background
    ).toBeUndefined();
  });

  it('strips orphaned launchModeId when created or updated without presetId', () => {
    const created = actionService.create({
      title: 'Orphaned mode',
      content: '# Test',
      launchModeId: 'mode-1',
    });
    expect(created.launchModeId).toBeUndefined();

    const withPreset = actionService.create({
      title: 'With preset',
      content: '# Test',
      presetId: 'preset-1',
      launchModeId: 'mode-1',
    });
    const cleared = actionService.update(withPreset.id, { presetId: null });
    expect(cleared.presetId).toBeUndefined();
    expect(cleared.launchModeId).toBeUndefined();
  });

  it('clearPresetReferences strips presetId and launchModeId for matching preset', () => {
    const a1 = actionService.create({
      title: 'A1',
      content: 'c1',
      presetId: 'preset-1',
      launchModeId: 'mode-1',
    });
    const a2 = actionService.create({
      title: 'A2',
      content: 'c2',
      presetId: 'preset-2',
    });

    actionService.clearPresetReferences('preset-1');

    const actions = actionService.list();
    const updated1 = actions.find((a) => a.id === a1.id)!;
    const updated2 = actions.find((a) => a.id === a2.id)!;

    expect(updated1.presetId).toBeUndefined();
    expect(updated1.launchModeId).toBeUndefined();
    expect(updated2.presetId).toBe('preset-2');
  });

  it('clearLaunchModeReferences strips launchModeId for matching preset and modes', () => {
    const a1 = actionService.create({
      title: 'A1',
      content: 'c1',
      presetId: 'preset-1',
      launchModeId: 'mode-1',
    });
    const a2 = actionService.create({
      title: 'A2',
      content: 'c2',
      presetId: 'preset-1',
      launchModeId: 'mode-2',
    });

    actionService.clearLaunchModeReferences('preset-1', ['mode-1']);

    const actions = actionService.list();
    const updated1 = actions.find((a) => a.id === a1.id)!;
    const updated2 = actions.find((a) => a.id === a2.id)!;

    expect(updated1.launchModeId).toBeUndefined();
    expect(updated1.presetId).toBe('preset-1');
    expect(updated2.launchModeId).toBe('mode-2');
  });

  it('notifies renderer on file changes', async () => {
    const window = createMockBrowserWindow();
    (
      electronMock.BrowserWindow as unknown as { getAllWindows: ReturnType<typeof vi.fn> }
    ).getAllWindows.mockReturnValue([window]);

    await actionService.init();

    vfs.mock.writeFileSync(
      '/mock/home/.komla/settings/actions.json',
      JSON.stringify({
        actions: [{ id: '1', title: 'External', content: 'External update' }],
      })
    );

    if (mockWatcherCallback) mockWatcherCallback();

    expect(window.webContents.send).toHaveBeenCalledWith('actions:changed', [
      { id: '1', title: 'External', content: 'External update' },
    ]);
  });

  it('keeps the current actions when a watched revision is temporarily unreadable', async () => {
    const before = actionService.list();
    await actionService.init();
    vfs.mock.rmSync('/mock/home/.komla/settings/actions.json');

    expect(() => mockWatcherCallback?.()).not.toThrow();
    expect(actionService.list()).toEqual(before);
    expect(electronMock.BrowserWindow.getAllWindows).not.toHaveBeenCalled();
  });
});
