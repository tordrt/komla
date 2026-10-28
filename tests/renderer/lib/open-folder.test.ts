/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openFolder, pickFolder } from '../../../src/renderer/lib/open-folder';
import { NEW_WORKSPACE_DIALOG_EVENT } from '../../../src/renderer/stores/dialogs.store';
import { useOpenFolderStore } from '../../../src/renderer/stores/open-folder.store';
import { useWindowStore } from '../../../src/renderer/stores/window.store';
import { useWorkspacesStore } from '../../../src/renderer/stores/workspaces.store';
import { createWorkspace as workspaceFixture } from '../../factories';

import type { FolderProjectMatch, Project } from '../../../src/renderer/types';

const project = (overrides: Partial<Project>): Project => ({
  id: 'p1',
  name: 'app',
  repositoryPath: '/repos/app',
  defaultBranchPrefix: '',
  createdAt: 0,
  order: 0,
  managed: true,
  ...overrides,
});

const handlers = () => ({ onProject: vi.fn(), onAddProject: vi.fn(), onFolder: vi.fn() });

function mockPicker(path: string | null, match: Partial<FolderProjectMatch> = {}) {
  window.api = {
    selectAnyDirectory: vi.fn().mockResolvedValue(path),
    findProjectForFolder: vi.fn().mockResolvedValue({ project: null, repoRoot: null, ...match }),
    recordOpenedFolder: vi.fn().mockResolvedValue(undefined),
  } as never;
}

// Answers the Git repository question once it is asked.
function answerWhenAsked(choice: 'project' | 'folder' | null) {
  return useOpenFolderStore.subscribe((state) => {
    if (state.open) state.answer(choice);
  });
}

afterEach(() => {
  useOpenFolderStore.setState({ open: false, folder: '', repoRoot: '', resolve: null });
});

describe('pickFolder', () => {
  it('does nothing when the picker is cancelled', async () => {
    mockPicker(null);
    const h = handlers();
    await pickFolder(h);
    expect(window.api.findProjectForFolder).not.toHaveBeenCalled();
    expect(h.onProject).not.toHaveBeenCalled();
    expect(h.onFolder).not.toHaveBeenCalled();
  });

  it('hands over the project the folder already is, without asking', async () => {
    const existing = project({});
    mockPicker('/repos/app/packages/web', { project: existing });
    const h = handlers();
    await pickFolder(h);
    expect(window.api.findProjectForFolder).toHaveBeenCalledWith('/repos/app/packages/web');
    expect(h.onProject).toHaveBeenCalledWith(existing);
    expect(useOpenFolderStore.getState().open).toBe(false);
    expect(h.onFolder).not.toHaveBeenCalled();
    expect(window.api.recordOpenedFolder).toHaveBeenCalledWith('/repos/app/packages/web');
  });

  it('opens a folder outside any Git repository straight away', async () => {
    mockPicker('/notes');
    const h = handlers();
    await pickFolder(h);
    expect(useOpenFolderStore.getState().open).toBe(false);
    expect(h.onFolder).toHaveBeenCalledWith('/notes');
  });

  it('opens the folder when looking it up fails', async () => {
    mockPicker('/notes');
    vi.mocked(window.api.findProjectForFolder).mockRejectedValue(new Error('EACCES'));
    const h = handlers();
    await pickFolder(h);
    expect(h.onFolder).toHaveBeenCalledWith('/notes');
  });

  it.each([
    ['project', 'onAddProject', '/repos/new'],
    ['folder', 'onFolder', '/repos/new/docs'],
  ] as const)(
    'asks about the repository a folder is in and follows the %s answer',
    async (choice, handler, path) => {
      mockPicker('/repos/new/docs', { repoRoot: '/repos/new' });
      const h = handlers();
      const unsubscribe = answerWhenAsked(choice);
      await pickFolder(h);
      unsubscribe();
      expect(useOpenFolderStore.getState()).toMatchObject({
        folder: '/repos/new/docs',
        repoRoot: '/repos/new',
      });
      expect(h[handler]).toHaveBeenCalledWith(path);
      expect(window.api.recordOpenedFolder).toHaveBeenCalledWith('/repos/new/docs');
      expect(h.onProject).not.toHaveBeenCalled();
      expect(choice === 'project' ? h.onFolder : h.onAddProject).not.toHaveBeenCalled();
    }
  );

  it('does nothing when the Git repository question is dismissed', async () => {
    mockPicker('/repos/new', { repoRoot: '/repos/new' });
    const h = handlers();
    const unsubscribe = answerWhenAsked(null);
    await pickFolder(h);
    unsubscribe();
    expect(h.onAddProject).not.toHaveBeenCalled();
    expect(h.onFolder).not.toHaveBeenCalled();
    expect(window.api.recordOpenedFolder).not.toHaveBeenCalled();
  });

  it('opens the folder even when it cannot be remembered', async () => {
    mockPicker('/notes');
    vi.mocked(window.api.recordOpenedFolder).mockRejectedValue(new Error('gone'));
    const h = handlers();
    await pickFolder(h);
    expect(h.onFolder).toHaveBeenCalledWith('/notes');
  });
});

describe('openFolder', () => {
  const createWorkspace = vi.fn();
  const selectWorkspace = vi.fn();
  const dialogRequests = vi.fn();
  const onDialogRequest = (e: Event) => dialogRequests((e as CustomEvent).detail);

  beforeEach(() => {
    createWorkspace.mockReset().mockResolvedValue({ id: 'w1', name: 'notes' });
    selectWorkspace.mockReset();
    dialogRequests.mockReset();
    useWindowStore.setState({ windowId: 'here' });
    useWorkspacesStore.setState({
      createWorkspace,
      selectWorkspace,
      workspaces: [],
      hasLoaded: true,
    });
    window.addEventListener(NEW_WORKSPACE_DIALOG_EVENT, onDialogRequest);
  });

  afterEach(() => {
    window.removeEventListener(NEW_WORKSPACE_DIALOG_EVENT, onDialogRequest);
  });

  it('creates a workspace for a plain folder, which main puts in a folder project', async () => {
    mockPicker('/notes');
    await openFolder();
    expect(createWorkspace).toHaveBeenCalledWith({ mode: 'directory', directoryPath: '/notes' });
    expect(dialogRequests).not.toHaveBeenCalled();
  });

  it('opens a folder given without asking for one', async () => {
    mockPicker(null);
    await openFolder('/notes');
    expect(window.api.selectAnyDirectory).not.toHaveBeenCalled();
    expect(createWorkspace).toHaveBeenCalledWith({ mode: 'directory', directoryPath: '/notes' });
  });

  it('creates a workspace in a folder project that has none open', async () => {
    mockPicker('/notes', { project: project({ id: 'dir', kind: 'directory' }) });
    useWorkspacesStore.setState({
      workspaces: [
        workspaceFixture({ id: 'trashed', projectId: 'dir', status: 'trashed' }),
        workspaceFixture({ id: 'other', projectId: 'other', status: 'active' }),
      ],
    });
    await openFolder();
    expect(createWorkspace).toHaveBeenCalledWith({ mode: 'directory', projectId: 'dir' });
    expect(selectWorkspace).not.toHaveBeenCalled();
  });

  it("shows a folder project's open workspace instead of adding another", async () => {
    mockPicker('/notes', { project: project({ id: 'dir', kind: 'directory' }) });
    useWorkspacesStore.setState({
      workspaces: [
        workspaceFixture({ id: 'used-last', projectId: 'dir', windowId: 'there', lastActivityAt: 9 }),
        workspaceFixture({ id: 'older', projectId: 'dir', windowId: 'here', lastActivityAt: 2 }),
        workspaceFixture({ id: 'newer', projectId: 'dir', windowId: 'here', lastActivityAt: 5 }),
      ],
    });
    await openFolder();
    expect(selectWorkspace).toHaveBeenCalledWith('newer');
    expect(createWorkspace).not.toHaveBeenCalled();
  });

  it('opens New Workspace on the Git project the folder already is', async () => {
    mockPicker('/repos/app', { project: project({ id: 'git' }) });
    await openFolder();
    expect(dialogRequests).toHaveBeenCalledWith({ projectId: 'git' });
    expect(createWorkspace).not.toHaveBeenCalled();
  });

  it('opens the add-project form on the repository to add as a project', async () => {
    mockPicker('/repos/new/docs', { repoRoot: '/repos/new' });
    const unsubscribe = answerWhenAsked('project');
    await openFolder();
    unsubscribe();
    expect(dialogRequests).toHaveBeenCalledWith({ addProjectPath: '/repos/new' });
    expect(createWorkspace).not.toHaveBeenCalled();
  });

  it('joins an Open Folder still in progress instead of starting another', async () => {
    mockPicker('/notes');
    let pick = (_path: string) => {};
    vi.mocked(window.api.selectAnyDirectory).mockReturnValueOnce(
      new Promise((resolve) => (pick = resolve))
    );

    const first = openFolder();
    const second = openFolder();
    pick('/notes');
    await Promise.all([first, second]);

    expect(window.api.selectAnyDirectory).toHaveBeenCalledOnce();
    expect(createWorkspace).toHaveBeenCalledOnce();

    await openFolder();
    expect(window.api.selectAnyDirectory).toHaveBeenCalledTimes(2);
  });

  it('waits for the workspaces to load, so it finds the one a folder has', async () => {
    mockPicker(null, { project: project({ id: 'dir', kind: 'directory' }) });
    useWorkspacesStore.setState({ hasLoaded: false });
    const opening = openFolder('/notes');
    await new Promise((settle) => setTimeout(settle, 0));
    expect(window.api.findProjectForFolder).not.toHaveBeenCalled();

    useWorkspacesStore.setState({
      hasLoaded: true,
      workspaces: [workspaceFixture({ id: 'open', projectId: 'dir', windowId: 'here' })],
    });
    await opening;
    expect(selectWorkspace).toHaveBeenCalledWith('open');
    expect(createWorkspace).not.toHaveBeenCalled();
  });

  it('opens folders one at a time, so a second Git repository waits for its answer', async () => {
    mockPicker(null, { repoRoot: '/repos/new' });
    const settle = () => new Promise((done) => setTimeout(done, 0));
    const opening = Promise.all([openFolder('/repos/new/a'), openFolder('/repos/new/b')]);
    await settle();
    useOpenFolderStore.getState().answer('folder');
    await settle();
    useOpenFolderStore.getState().answer('folder');
    await opening;
    expect(createWorkspace.mock.calls).toEqual([
      [{ mode: 'directory', directoryPath: '/repos/new/a' }],
      [{ mode: 'directory', directoryPath: '/repos/new/b' }],
    ]);
  });

  it('remembers a folder only once it opened', async () => {
    mockPicker(null);
    createWorkspace.mockRejectedValue(new Error('Selected path is not a valid directory'));
    await openFolder('/gone');
    expect(window.api.recordOpenedFolder).not.toHaveBeenCalled();
  });

  it('opens each folder given, even while the picker is open', async () => {
    mockPicker('/picked');
    let pick = (_path: string | null) => {};
    vi.mocked(window.api.selectAnyDirectory).mockReturnValueOnce(
      new Promise((resolve) => (pick = resolve))
    );

    const picking = openFolder();
    await Promise.all([openFolder('/a'), openFolder('/b')]);
    pick(null);
    await picking;

    expect(createWorkspace.mock.calls).toEqual([
      [{ mode: 'directory', directoryPath: '/a' }],
      [{ mode: 'directory', directoryPath: '/b' }],
    ]);
  });
});
