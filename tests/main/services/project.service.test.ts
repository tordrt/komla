import { describe, it, expect, vi, beforeEach } from 'vitest';

import { mockElectron } from '../../mocks/electron';
import { createVirtualFs, VirtualFilesystem } from '../../mocks/fs';

vi.mock('electron', () => mockElectron());

let vfs: VirtualFilesystem;
beforeEach(() => {
  vfs = createVirtualFs();
});

vi.mock('fs', () => ({
  existsSync: vi.fn((...args) => vfs.mock.existsSync(...args)),
  readFileSync: vi.fn((...args) => vfs.mock.readFileSync(...args)),
  writeFileSync: vi.fn((...args) => vfs.mock.writeFileSync(...args)),
  mkdirSync: vi.fn((...args) => vfs.mock.mkdirSync(...args)),
  rmSync: vi.fn((...args) => vfs.mock.rmSync(...args)),
  statSync: vi.fn((...args) => vfs.mock.statSync(...args)),
}));

const mockWriteFileAtomicSync = vi.fn();
vi.mock('../../../src/main/lib/atomic-write', () => ({
  writeFileAtomicSync: mockWriteFileAtomicSync,
}));

let uuidCounter = 0;
vi.mock('crypto', async (importOriginal) => ({
  ...(await importOriginal<typeof import('crypto')>()),
  randomUUID: vi.fn(() => `project-${++uuidCounter}`),
}));

const mockWatcherStart = vi.fn(() => Promise.resolve());
const mockWatcherStop = vi.fn(() => Promise.resolve());
const fileWatcherInstances: Array<{ onChange: () => void }> = [];
vi.mock('../../../src/main/services/file-watcher', () => ({
  FileWatcher: class {
    constructor(_path: string, onChange: () => void) {
      fileWatcherInstances.push({ onChange });
    }
    start = mockWatcherStart;
    stop = mockWatcherStop;
  },
}));

const mockGitService = {
  isGitRepo: vi.fn(),
  getRepoName: vi.fn(),
  getMainBranch: vi.fn().mockResolvedValue('main'),
  validateRemoteUrl: vi.fn(),
  initBareRepo: vi.fn(),
  getRepoRoot: vi.fn(),
  getCommonGitDir: vi.fn(),
};
vi.mock('../../../src/main/services/git.service', () => ({
  gitService: mockGitService,
}));

const mockManagedRepoService = {
  createManagedRepo: vi.fn(),
  deleteManagedRepo: vi.fn(),
  getProjectFolderPath: vi.fn(),
  createManagedRepoFromRemote: vi.fn(),
  getManagedRepoPath: vi.fn(),
};
vi.mock('../../../src/main/services/managed-repo.service', () => ({
  managedRepoService: mockManagedRepoService,
}));

vi.mock('../../../src/main/services/paths', () => ({
  getKomlaBasePath: vi.fn(() => '/mock/home/.komla'),
}));

describe('ProjectService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    uuidCounter = 0;
    fileWatcherInstances.length = 0;

    mockGitService.isGitRepo.mockResolvedValue(true);
    mockGitService.getRepoName.mockResolvedValue('repo-name');
    mockGitService.validateRemoteUrl.mockResolvedValue({ valid: true });
    mockGitService.initBareRepo.mockResolvedValue(undefined);

    mockManagedRepoService.createManagedRepo.mockImplementation(
      async (_sourcePath: string, name: string) => `/mock/home/.komla/repos/${name}/.git`
    );
    mockManagedRepoService.deleteManagedRepo.mockResolvedValue(undefined);
    mockManagedRepoService.getProjectFolderPath.mockImplementation(
      (name: string) => `/mock/home/.komla/repos/${name}`
    );
    mockManagedRepoService.createManagedRepoFromRemote.mockResolvedValue(
      '/mock/home/.komla/repos/repo/.git'
    );
    mockManagedRepoService.getManagedRepoPath.mockImplementation(
      (name: string) => `/mock/home/.komla/repos/${name}/.git`
    );

    mockWriteFileAtomicSync.mockImplementation(
      (path: string, data: string, _mode?: number, beforeCommit?: () => void) => {
        beforeCommit?.();
        vfs.mock.writeFileSync(path, data);
      }
    );
  });

  it('writes an empty versioned projects file on first run and keeps the format on save', async () => {
    const { projectService } = await import('../../../src/main/services/project.service');
    const read = () =>
      JSON.parse(
        vfs.mock.readFileSync('/mock/home/.komla/settings/projects.json', 'utf-8') as string
      );
    expect(read()).toEqual({ _version: 1, projects: [] });

    await projectService.create({ repositoryPath: '/repo/one' });

    expect(read()._version).toBe(1);
    expect(read().projects).toHaveLength(1);
  });

  it('loads projects.json when it starts with a UTF-8 BOM', async () => {
    vfs.mock.mkdirSync('/mock/home/.komla/settings', { recursive: true });
    const project = {
      id: 'project-1',
      name: 'BOM Project',
      repositoryPath: '/repo/with-bom',
      defaultBranchPrefix: '',
      createdAt: 1234567890,
      order: 0,
      managed: false,
      aheadTargetAction: 'auto-default',
    };
    vfs.mock.writeFileSync(
      '/mock/home/.komla/settings/projects.json',
      `\ufeff${JSON.stringify({ _version: 1, projects: [project] })}`
    );

    const { projectService } = await import('../../../src/main/services/project.service');

    expect(projectService.list()).toEqual([project]);
  });

  it('keeps the first SSH command mode chosen across app windows', async () => {
    vfs.mock.mkdirSync('/mock/home/.komla/settings', { recursive: true });
    vfs.mock.writeFileSync(
      '/mock/home/.komla/settings/projects.json',
      JSON.stringify({
        _version: 1,
        projects: [
          {
            id: 'project-1',
            name: 'Project',
            repositoryPath: '/repo/project',
            defaultBranchPrefix: '',
            createdAt: 1234567890,
            order: 0,
            managed: false,
          },
        ],
      })
    );
    const { projectService } = await import('../../../src/main/services/project.service');

    const first = projectService.setSshWorkspaceModeIfUnset('project-1', 'local-mirror-actions');
    const second = projectService.setSshWorkspaceModeIfUnset('project-1', 'remote');

    expect(first.sshWorkspaceMode).toBe('local-mirror-actions');
    expect(second.sshWorkspaceMode).toBe('local-mirror-actions');
    expect(projectService.get('project-1')?.sshWorkspaceMode).toBe('local-mirror-actions');
  });

  it('rolls back the first SSH command mode when persistence fails', async () => {
    vfs.mock.mkdirSync('/mock/home/.komla/settings', { recursive: true });
    vfs.mock.writeFileSync(
      '/mock/home/.komla/settings/projects.json',
      JSON.stringify({
        _version: 1,
        projects: [
          {
            id: 'project-1',
            name: 'Project',
            repositoryPath: '/repo/project',
            defaultBranchPrefix: '',
            createdAt: 1234567890,
            order: 0,
            managed: false,
          },
        ],
      })
    );
    const { projectService } = await import('../../../src/main/services/project.service');
    const writeError = new Error('disk full');
    mockWriteFileAtomicSync.mockImplementationOnce(() => {
      throw writeError;
    });

    expect(() =>
      projectService.setSshWorkspaceModeIfUnset('project-1', 'local-mirror-actions')
    ).toThrow(writeError);
    expect(projectService.get('project-1')?.sshWorkspaceMode).toBeUndefined();
  });

  it('fills in setup step defaults when loading projects', async () => {
    vfs.mock.mkdirSync('/mock/home/.komla/settings', { recursive: true });
    const project = {
      id: 'project-1',
      name: 'Setup',
      repositoryPath: '/repo/setup',
      defaultBranchPrefix: '',
      createdAt: 1234567890,
      order: 0,
      managed: false,
      setupSteps: [
        {
          id: 'create-step',
          name: 'Install',
          command: 'npm install',
          placement: 'background',
          destination: 'ssh-local-copy',
          trigger: 'workspace-creation',
        },
        {
          id: 'start-step',
          name: 'Dev server',
          command: 'npm run dev',
          placement: 'tab',
        },
      ],
    };
    vfs.mock.writeFileSync(
      '/mock/home/.komla/settings/projects.json',
      JSON.stringify({ _version: 1, projects: [project] })
    );

    const { projectService } = await import('../../../src/main/services/project.service');

    expect(projectService.get('project-1')?.setupSteps).toEqual([
      expect.objectContaining({
        id: 'create-step',
        destination: 'ssh-local-copy',
        trigger: 'workspace-creation',
      }),
      expect.objectContaining({
        id: 'start-step',
        destination: 'workspace-repository',
        trigger: 'every-workspace-start',
      }),
    ]);
    expect(projectService.getStorageRevisionState()).toEqual({
      status: 'current',
      revision: projectService.getStorageRevision(),
    });
  });

  it('rejects persisted projects with an unknown Setup destination', async () => {
    vfs.mock.mkdirSync('/mock/home/.komla/settings', { recursive: true });
    vfs.mock.writeFileSync(
      '/mock/home/.komla/settings/projects.json',
      JSON.stringify({
        _version: 1,
        projects: [
          {
            id: 'project-1',
            name: 'Invalid Setup',
            repositoryPath: '/repo/invalid',
            defaultBranchPrefix: '',
            createdAt: 1234567890,
            order: 0,
            managed: false,
            setupSteps: [
              {
                id: 'bad-step',
                name: 'Bad destination',
                command: 'npm install',
                placement: 'background',
                destination: 'ssh-local-projet',
              },
            ],
          },
        ],
      })
    );

    const { projectService } = await import('../../../src/main/services/project.service');

    expect(projectService.list()).toEqual([]);
  });

  it('replaces workspace setup only at the expected persisted revision', async () => {
    vfs.mock.mkdirSync('/mock/home/.komla/settings', { recursive: true });
    vfs.mock.writeFileSync(
      '/mock/home/.komla/settings/projects.json',
      JSON.stringify({
        _version: 1,
        projects: [
          {
            id: 'project-1',
            name: 'Komla',
            repositoryPath: '/repo/komla',
            defaultBranchPrefix: '',
            createdAt: 1,
            order: 0,
            managed: false,
          },
        ],
      })
    );
    const { projectService } = await import('../../../src/main/services/project.service');
    const before = projectService.getStorageRevision();

    const after = projectService.replaceWorkspaceSetup(before, 'project-1', {
      setupSteps: [],
      agentPlacement: 'split-right',
      agentLayoutOrder: 1,
      trashCleanupScript: 'npm run clean',
    });

    expect(after).not.toBe(before);
    expect(projectService.get('project-1')).toMatchObject({
      agentPlacement: 'split-right',
      trashCleanupScript: 'npm run clean',
    });
    expect(() =>
      projectService.replaceWorkspaceSetup(before, 'project-1', {
        setupSteps: [],
        agentPlacement: 'tab',
        agentLayoutOrder: 0,
        trashCleanupScript: '',
      })
    ).toThrow('revision changed');
  });

  it('preserves a direct project edit that lands while setup replacement is staged', async () => {
    vfs.mock.mkdirSync('/mock/home/.komla/settings', { recursive: true });
    const initial = {
      _version: 1,
      projects: [
        {
          id: 'project-1',
          name: 'Komla',
          repositoryPath: '/repo/komla',
          defaultBranchPrefix: '',
          createdAt: 1,
          order: 0,
          managed: false,
        },
      ],
    };
    vfs.mock.writeFileSync('/mock/home/.komla/settings/projects.json', JSON.stringify(initial));
    const { projectService } = await import('../../../src/main/services/project.service');
    const revision = projectService.getStorageRevision();
    const external = JSON.stringify({
      ...initial,
      projects: [{ ...initial.projects[0], name: 'Externally renamed' }],
    });
    mockWriteFileAtomicSync.mockImplementationOnce((path, data, _mode, beforeCommit) => {
      vfs.mock.writeFileSync(path, external);
      beforeCommit?.();
      vfs.mock.writeFileSync(path, data);
    });

    expect(() =>
      projectService.replaceWorkspaceSetup(revision, 'project-1', {
        setupSteps: [],
        agentPlacement: 'tab',
        agentLayoutOrder: 0,
        trashCleanupScript: '',
      })
    ).toThrow('revision changed');
    expect(vfs.mock.readFileSync('/mock/home/.komla/settings/projects.json', 'utf8')).toBe(
      external
    );
  });

  it('does not accept the persisted revision when projects on disk are ahead of memory', async () => {
    vfs.mock.mkdirSync('/mock/home/.komla/settings', { recursive: true });
    vfs.mock.writeFileSync(
      '/mock/home/.komla/settings/projects.json',
      JSON.stringify({ _version: 1, projects: [] })
    );
    const { projectService } = await import('../../../src/main/services/project.service');
    expect(projectService.getStorageRevisionState()).toEqual({
      status: 'current',
      revision: projectService.getStorageRevision(),
    });

    vfs.mock.writeFileSync(
      '/mock/home/.komla/settings/projects.json',
      JSON.stringify({
        _version: 1,
        projects: [
          {
            id: 'external',
            name: 'External',
            repositoryPath: '/external',
            defaultBranchPrefix: '',
            createdAt: 1,
            order: 0,
            managed: false,
          },
        ],
      })
    );

    expect(projectService.getStorageRevisionState()).toEqual({ status: 'changed' });
    vfs.mock.writeFileSync('/mock/home/.komla/settings/projects.json', '{');
    expect(projectService.getStorageRevisionState()).toEqual({ status: 'unreadable' });
  });

  it('keeps the current projects when a watched revision is temporarily unreadable', async () => {
    vfs.mock.mkdirSync('/mock/home/.komla/settings', { recursive: true });
    const stored = [
      {
        id: 'project-1',
        name: 'Komla',
        repositoryPath: '/repo/komla',
        defaultBranchPrefix: '',
        createdAt: 1,
        order: 0,
        managed: false,
        aheadTargetAction: 'auto-default',
      },
    ];
    vfs.mock.writeFileSync(
      '/mock/home/.komla/settings/projects.json',
      JSON.stringify({ _version: 1, projects: stored })
    );
    const { projectService } = await import('../../../src/main/services/project.service');
    await projectService.init();
    vfs.mock.rmSync('/mock/home/.komla/settings/projects.json');

    expect(() => fileWatcherInstances[0].onChange()).not.toThrow();
    expect(projectService.list()).toEqual(stored);
  });

  it('clears deleted agent preset references from setup steps', async () => {
    vfs.mock.mkdirSync('/mock/home/.komla/settings', { recursive: true });
    const project = {
      id: 'project-1',
      name: 'Pinned Project',
      repositoryPath: '/repo/pinned',
      defaultBranchPrefix: '',
      createdAt: 1234567890,
      order: 0,
      managed: false,
      setupSteps: [
        {
          id: 'agent-step',
          name: 'Reviewer',
          command: '',
          placement: 'tab',
          agent: { presetId: 'deleted-preset', launchModeId: 'plan' },
        },
      ],
    };
    vfs.mock.writeFileSync(
      '/mock/home/.komla/settings/projects.json',
      JSON.stringify({ _version: 1, projects: [project] })
    );

    const { projectService } = await import('../../../src/main/services/project.service');
    projectService.clearPresetReferences('deleted-preset');

    expect(projectService.get('project-1')?.setupSteps?.[0]?.agent).toEqual({});
    const saved = JSON.parse(
      vfs.mock.readFileSync('/mock/home/.komla/settings/projects.json', 'utf-8')
    );
    expect(saved.projects[0].setupSteps[0].agent).toEqual({});
  });

  it('clears removed launch mode references from setup steps', async () => {
    vfs.mock.mkdirSync('/mock/home/.komla/settings', { recursive: true });
    const project = {
      id: 'project-1',
      name: 'Pinned Project',
      repositoryPath: '/repo/pinned',
      defaultBranchPrefix: '',
      createdAt: 1234567890,
      order: 0,
      managed: false,
      setupSteps: [
        {
          id: 'agent-step',
          name: 'Reviewer',
          command: '',
          placement: 'tab',
          agent: { presetId: 'codex', launchModeId: 'removed-mode' },
        },
      ],
    };
    vfs.mock.writeFileSync(
      '/mock/home/.komla/settings/projects.json',
      JSON.stringify({ _version: 1, projects: [project] })
    );

    const { projectService } = await import('../../../src/main/services/project.service');
    projectService.clearLaunchModeReferences('codex', ['removed-mode']);

    expect(projectService.get('project-1')?.setupSteps?.[0]?.agent).toEqual({
      presetId: 'codex',
    });
  });

  it('creates a directory project from a non-git folder', async () => {
    mockGitService.isGitRepo.mockResolvedValue(false);
    vfs.mock.mkdirSync('/not-a-repo', { recursive: true });
    const { projectService } = await import('../../../src/main/services/project.service');

    const project = await projectService.create({ repositoryPath: '/not-a-repo' });

    expect(project).toMatchObject({
      kind: 'directory',
      name: 'not-a-repo',
      repositoryPath: '/not-a-repo',
      managed: false,
    });
    expect(mockManagedRepoService.createManagedRepo).not.toHaveBeenCalled();
  });

  it('defaults defaultBranchPrefix to empty string when not provided', async () => {
    const { projectService } = await import('../../../src/main/services/project.service');

    const project = await projectService.create({ repositoryPath: '/repo/one' });

    expect(project.defaultBranchPrefix).toBe('');
  });

  it('preserves explicit empty string defaultBranchPrefix', async () => {
    const { projectService } = await import('../../../src/main/services/project.service');

    const project = await projectService.create({
      repositoryPath: '/repo/one',
      defaultBranchPrefix: '',
    });

    expect(project.defaultBranchPrefix).toBe('');
  });

  it('preserves explicit non-empty defaultBranchPrefix', async () => {
    const { projectService } = await import('../../../src/main/services/project.service');

    const project = await projectService.create({
      repositoryPath: '/repo/one',
      defaultBranchPrefix: 'custom/',
    });

    expect(project.defaultBranchPrefix).toBe('custom/');
  });

  it('assigns stable ordering/colors and persists on create()', async () => {
    const { projectService } = await import('../../../src/main/services/project.service');

    mockGitService.getRepoName.mockResolvedValueOnce('first').mockResolvedValueOnce('second');

    mockManagedRepoService.createManagedRepo
      .mockResolvedValueOnce('/mock/home/.komla/repos/first/.git')
      .mockResolvedValueOnce('/mock/home/.komla/repos/second/.git');

    const first = await projectService.create({
      repositoryPath: '/repo/one',
      color: 'hsl(340, 70%, 55%)',
    });
    const second = await projectService.create({ repositoryPath: '/repo/two' });

    expect(first.order).toBe(0);
    expect(second.order).toBe(1);
    expect(second.color).toBe('hsl(200, 75%, 50%)');
    expect(mockWriteFileAtomicSync).toHaveBeenCalled();
  });

  it('suffixes duplicate derived project names on create()', async () => {
    const { projectService } = await import('../../../src/main/services/project.service');

    mockGitService.getRepoName.mockResolvedValue('repo-name');
    mockManagedRepoService.createManagedRepo
      .mockResolvedValueOnce('/mock/home/.komla/repos/repo-name/.git')
      .mockResolvedValueOnce('/mock/home/.komla/repos/repo-name-2/.git');

    const first = await projectService.create({ repositoryPath: '/repo/one' });
    const second = await projectService.create({ repositoryPath: '/repo/two' });

    expect(first.name).toBe('repo-name');
    expect(second.name).toBe('repo-name-2');
    expect(mockManagedRepoService.createManagedRepo).toHaveBeenNthCalledWith(
      2,
      '/repo/two',
      'repo-name-2'
    );
  });

  it('names a directory project after its parent folder too when the name is taken', async () => {
    for (const path of ['/repo/app', '/tmp/app', '/other/tmp/app']) {
      vfs.mock.mkdirSync(path, { recursive: true });
    }

    const { projectService } = await import('../../../src/main/services/project.service');

    const names = [];
    for (const repositoryPath of ['/repo/app', '/tmp/app', '/other/tmp/app']) {
      names.push((await projectService.create({ kind: 'directory', repositoryPath })).name);
    }

    expect(names).toEqual(['app', 'app (tmp)', 'app (tmp)-2']);
  });

  describe('findOrCreateDirectoryProject', () => {
    it('adds a folder project for a folder, in the color given, and tells windows', async () => {
      vfs.mock.mkdirSync('/notes', { recursive: true });
      const { projectService } = await import('../../../src/main/services/project.service');
      const { BrowserWindow } = await import('electron');
      const send = vi.fn();
      vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([
        { isDestroyed: () => false, webContents: { send } },
      ] as never);

      const project = projectService.findOrCreateDirectoryProject('/notes/', 'hsl(1, 2%, 3%)');

      expect(project).toMatchObject({
        kind: 'directory',
        name: 'notes',
        repositoryPath: '/notes',
        color: 'hsl(1, 2%, 3%)',
      });
      expect(projectService.list()).toEqual([project]);
      expect(send).toHaveBeenCalledWith(expect.any(String), [project]);
    });

    it('finds the folder project a folder already is instead of adding another', async () => {
      vfs.mock.mkdirSync('/notes', { recursive: true });
      const { projectService } = await import('../../../src/main/services/project.service');

      const first = projectService.findOrCreateDirectoryProject('/notes');
      const again = projectService.findOrCreateDirectoryProject('/notes/');

      expect(again).toBe(first);
      expect(projectService.list()).toHaveLength(1);
    });

    it('throws for a folder that is gone', async () => {
      const { projectService } = await import('../../../src/main/services/project.service');

      expect(() => projectService.findOrCreateDirectoryProject('/gone')).toThrow(
        'Selected path is not a valid directory'
      );
      expect(projectService.list()).toEqual([]);
    });
  });

  it('rejects explicit duplicate project names on create()', async () => {
    const { projectService } = await import('../../../src/main/services/project.service');

    await projectService.create({ repositoryPath: '/repo/one', name: 'Shared Name' });

    await expect(
      projectService.create({ repositoryPath: '/repo/two', name: 'shared name' })
    ).rejects.toThrow('A project named "shared name" already exists');
  });

  it('rejects duplicate project names on update()', async () => {
    const { projectService } = await import('../../../src/main/services/project.service');

    const first = await projectService.create({ repositoryPath: '/repo/one', name: 'First' });
    await projectService.create({ repositoryPath: '/repo/two', name: 'Second' });

    await expect(projectService.update(first.id, { name: 'second' })).rejects.toThrow(
      'A project named "second" already exists'
    );
  });

  it('tells listeners when a project’s target branch or branch prefix changes', async () => {
    const { projectService } = await import('../../../src/main/services/project.service');
    const project = await projectService.create({ repositoryPath: '/repo/one', name: 'First' });
    const listener = vi.fn();
    projectService.onGitSettingsChange(listener);

    // The settings page sends the target with every Git field.
    await projectService.update(project.id, { baseBranch: project.baseBranch, name: 'Renamed' });
    expect(listener).not.toHaveBeenCalled();

    await projectService.update(project.id, { baseBranch: 'develop' });
    await projectService.update(project.id, { defaultBranchPrefix: 'me/' });
    expect(listener.mock.calls).toEqual([[project.id], [project.id]]);
  });

  it('uses stored project folder ownership after a managed project is renamed', async () => {
    const { projectService } = await import('../../../src/main/services/project.service');

    const first = await projectService.create({ repositoryPath: '/repo/one', name: 'First' });
    await projectService.update(first.id, { name: 'Renamed' });
    vfs.mock.mkdirSync('/mock/home/.komla/repos/First');

    await expect(
      projectService.create({ repositoryPath: '/repo/two', name: 'First' })
    ).rejects.toThrow('Project already exists: First');
    expect(vfs.mock.rmSync).not.toHaveBeenCalledWith('/mock/home/.komla/repos/First', {
      recursive: true,
      force: true,
    });
  });

  it('deletes managed repository when deleting a managed project', async () => {
    const { projectService } = await import('../../../src/main/services/project.service');
    const created = await projectService.create({ repositoryPath: '/repo/original' });

    await projectService.delete(created.id);

    expect(mockManagedRepoService.deleteManagedRepo).toHaveBeenCalledWith(
      '/mock/home/.komla/repos/repo-name/.git'
    );
    expect(projectService.get(created.id)).toBeUndefined();
  });

  it('defaults defaultBranchPrefix to empty string in createFromRemote()', async () => {
    mockManagedRepoService.getProjectFolderPath.mockReturnValue('/mock/home/.komla/repos/repo');
    mockManagedRepoService.createManagedRepoFromRemote.mockResolvedValue(
      '/mock/home/.komla/repos/repo/.git'
    );

    const { projectService } = await import('../../../src/main/services/project.service');

    const project = await projectService.createFromRemote({
      remoteUrl: 'https://github.com/org/repo.git',
    });

    expect(project.defaultBranchPrefix).toBe('');
  });

  it('does not call validateRemoteUrl before cloning (avoids redundant auth prompt)', async () => {
    mockManagedRepoService.getProjectFolderPath.mockReturnValue('/mock/home/.komla/repos/repo');
    mockManagedRepoService.createManagedRepoFromRemote.mockResolvedValue(
      '/mock/home/.komla/repos/repo/.git'
    );

    const { projectService } = await import('../../../src/main/services/project.service');

    await projectService.createFromRemote({ remoteUrl: 'https://github.com/org/repo.git' });

    expect(mockGitService.validateRemoteUrl).not.toHaveBeenCalled();
  });

  it('cleans up project folder if createFromRemote() clone fails', async () => {
    mockManagedRepoService.createManagedRepoFromRemote.mockImplementation(async () => {
      vfs.mock.mkdirSync('/mock/home/.komla/repos/repo');
      throw new Error('clone failed');
    });
    mockManagedRepoService.getProjectFolderPath.mockReturnValue('/mock/home/.komla/repos/repo');

    const { projectService } = await import('../../../src/main/services/project.service');

    await expect(
      projectService.createFromRemote({ remoteUrl: 'https://github.com/org/repo.git' })
    ).rejects.toThrow('clone failed');

    expect(vfs.mock.rmSync).toHaveBeenCalledWith('/mock/home/.komla/repos/repo', {
      recursive: true,
      force: true,
    });
  });

  it('leaves git settings to the app-wide defaults when createFromRemote() succeeds', async () => {
    mockManagedRepoService.getProjectFolderPath.mockReturnValue('/mock/home/.komla/repos/repo');
    mockManagedRepoService.createManagedRepoFromRemote.mockResolvedValue(
      '/mock/home/.komla/repos/repo/.git'
    );

    const { projectService } = await import('../../../src/main/services/project.service');

    const project = await projectService.createFromRemote({
      remoteUrl: 'https://github.com/org/repo.git',
    });

    expect(project.autoPushAfterMerge).toBeUndefined();
    expect(project.aheadTargetAction).toBeUndefined();
  });

  it('stores the icon picked when adding a folder, and clears it on update', async () => {
    const icon = 'data:image/svg+xml;base64,PHN2Zy8+';
    mockGitService.isGitRepo.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    vfs.mock.mkdirSync('/not-a-repo', { recursive: true });
    const { projectService } = await import('../../../src/main/services/project.service');

    const gitProject = await projectService.create({ repositoryPath: '/repo/one', icon });
    const directoryProject = await projectService.create({ repositoryPath: '/not-a-repo', icon });
    expect(gitProject.icon).toBe(icon);
    expect(directoryProject.icon).toBe(icon);

    const updated = await projectService.update(gitProject.id, { icon: '' });
    expect(updated).not.toHaveProperty('icon');
  });

  it('offers icons at a new workspace until they were offered once', async () => {
    const { projectService } = await import('../../../src/main/services/project.service');
    const project = await projectService.createFromRemote({
      remoteUrl: 'https://github.com/org/repo.git',
    });
    expect(project).not.toHaveProperty('iconPromptWorkspaceId');

    projectService.armIconPrompt(project.id, 'w1');
    expect(projectService.takeIconPrompt(project.id, 'other')).toBe(false);
    expect(projectService.takeIconPrompt(project.id, 'w1')).toBe(true);
    expect(projectService.takeIconPrompt(project.id, 'w1')).toBe(false);
    expect(projectService.get(project.id)).not.toHaveProperty('iconPromptWorkspaceId');
    expect(projectService.takeIconPrompt('missing', 'w1')).toBe(false);

    // None were found, so the next workspace looks again; once offered, none asks.
    projectService.armIconPrompt(project.id, 'w2');
    expect(projectService.get(project.id)?.iconPromptWorkspaceId).toBe('w2');
    expect(projectService.takeIconPrompt(project.id, 'w2')).toBe(true);
    projectService.markIconPromptAsked(project.id);
    projectService.armIconPrompt(project.id, 'w3');
    expect(projectService.get(project.id)).not.toHaveProperty('iconPromptWorkspaceId');
  });

  it('drops a prompt armed while an earlier scan was still offering icons', async () => {
    const { projectService } = await import('../../../src/main/services/project.service');
    const project = await projectService.createFromRemote({
      remoteUrl: 'https://github.com/org/repo.git',
    });
    projectService.armIconPrompt(project.id, 'w1');
    expect(projectService.takeIconPrompt(project.id, 'w1')).toBe(true);
    // A slow SSH scan: a second workspace arms the prompt before the first offers icons.
    projectService.armIconPrompt(project.id, 'w2');
    projectService.markIconPromptAsked(project.id);

    expect(projectService.takeIconPrompt(project.id, 'w2')).toBe(false);
    expect(projectService.get(project.id)).not.toHaveProperty('iconPromptWorkspaceId');
  });

  it('drops the prompt once the user sets an icon, and never asks after', async () => {
    const { projectService } = await import('../../../src/main/services/project.service');
    const project = await projectService.createFromRemote({
      remoteUrl: 'https://github.com/org/repo.git',
    });
    projectService.armIconPrompt(project.id, 'w1');

    await projectService.update(project.id, { name: 'renamed' });
    expect(projectService.get(project.id)?.iconPromptWorkspaceId).toBe('w1');

    await projectService.update(project.id, { icon: 'data:image/png;base64,iVBORw0KGgo=' });
    expect(projectService.get(project.id)).not.toHaveProperty('iconPromptWorkspaceId');
    await projectService.update(project.id, { icon: '' });
    projectService.armIconPrompt(project.id, 'w2');
    expect(projectService.get(project.id)).not.toHaveProperty('iconPromptWorkspaceId');
  });

  it("doesn't ask again for a folder whose icons the add-project form offered", async () => {
    mockGitService.isGitRepo.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    vfs.mock.mkdirSync('/not-a-repo', { recursive: true });
    const { projectService } = await import('../../../src/main/services/project.service');

    const offered = await projectService.create({
      repositoryPath: '/repo/one',
      iconPromptAsked: true,
    });
    const directory = await projectService.create({
      repositoryPath: '/not-a-repo',
      iconPromptAsked: true,
    });
    const notOffered = await projectService.create({ repositoryPath: '/repo/two' });
    for (const project of [offered, directory, notOffered]) {
      projectService.armIconPrompt(project.id, `w-${project.id}`);
    }

    expect(projectService.get(offered.id)).not.toHaveProperty('iconPromptWorkspaceId');
    expect(projectService.get(directory.id)).not.toHaveProperty('iconPromptWorkspaceId');
    expect(projectService.get(notOffered.id)?.iconPromptWorkspaceId).toBe(`w-${notOffered.id}`);
  });

  it('skips the first-workspace prompt for a project cloned or created with an icon', async () => {
    const icon = 'data:image/png;base64,iVBORw0KGgo=';
    const { projectService } = await import('../../../src/main/services/project.service');

    const cloned = await projectService.createFromRemote({
      remoteUrl: 'https://github.com/org/repo.git',
      icon,
    });
    const created = await projectService.createFromNew({ name: 'fresh', icon });

    expect(cloned).toMatchObject({ icon });
    expect(created).toMatchObject({ icon });
    for (const project of [cloned, created]) projectService.armIconPrompt(project.id, 'w1');
    expect(projectService.get(cloned.id)).not.toHaveProperty('iconPromptWorkspaceId');
    expect(projectService.get(created.id)).not.toHaveProperty('iconPromptWorkspaceId');
  });

  it('validates non-empty name and cleans up when createFromNew() init fails', async () => {
    const { projectService } = await import('../../../src/main/services/project.service');

    await expect(projectService.createFromNew({ name: '   ' })).rejects.toThrow(
      'Project name is required'
    );

    mockGitService.initBareRepo.mockRejectedValue(new Error('init failed'));
    mockManagedRepoService.getProjectFolderPath.mockReturnValue('/mock/home/.komla/repos/newproj');
    mockManagedRepoService.getManagedRepoPath.mockReturnValue(
      '/mock/home/.komla/repos/newproj/.git'
    );

    await expect(projectService.createFromNew({ name: 'newproj' })).rejects.toThrow('init failed');

    expect(vfs.mock.rmSync).toHaveBeenCalledWith('/mock/home/.komla/repos/newproj', {
      recursive: true,
      force: true,
    });
  });

  it('persists autoPushAfterMerge when createFromNew() succeeds', async () => {
    mockManagedRepoService.getProjectFolderPath.mockReturnValue('/mock/home/.komla/repos/newproj');
    mockManagedRepoService.getManagedRepoPath.mockReturnValue(
      '/mock/home/.komla/repos/newproj/.git'
    );

    const { projectService } = await import('../../../src/main/services/project.service');

    const project = await projectService.createFromNew({
      name: 'newproj',
      autoPushAfterMerge: false,
    });

    expect(project.autoPushAfterMerge).toBe(false);
  });

  it('cleans up orphaned folder and allows create() to proceed', async () => {
    // Simulate an orphaned folder on disk (no project references it)
    vfs.mock.mkdirSync('/mock/home/.komla/repos/repo-name');

    const { projectService } = await import('../../../src/main/services/project.service');

    const project = await projectService.create({ repositoryPath: '/repo/path' });

    // Orphaned folder should have been cleaned up
    expect(vfs.mock.rmSync).toHaveBeenCalledWith('/mock/home/.komla/repos/repo-name', {
      recursive: true,
      force: true,
    });
    expect(project.name).toBe('repo-name');
  });

  it('throws when create() targets a folder owned by an active project', async () => {
    const { projectService } = await import('../../../src/main/services/project.service');

    // Create a project first so its folder is "owned"
    await projectService.create({ repositoryPath: '/repo/path' });

    // Simulate the folder existing on disk for the second attempt
    vfs.mock.mkdirSync('/mock/home/.komla/repos/repo-name');

    // Second create with same name should throw
    await expect(projectService.create({ repositoryPath: '/repo/path' })).rejects.toThrow(
      'Project already exists: repo-name'
    );
  });

  it('cleans up project folder if create() clone fails', async () => {
    mockManagedRepoService.createManagedRepo.mockImplementation(async () => {
      vfs.mock.mkdirSync('/mock/home/.komla/repos/repo-name');
      throw new Error('clone failed');
    });

    const { projectService } = await import('../../../src/main/services/project.service');

    await expect(projectService.create({ repositoryPath: '/repo/path' })).rejects.toThrow(
      'clone failed'
    );

    expect(vfs.mock.rmSync).toHaveBeenCalledWith('/mock/home/.komla/repos/repo-name', {
      recursive: true,
      force: true,
    });
  });

  it('leaves the target unconfigured when create() does not provide one', async () => {
    mockGitService.getMainBranch.mockResolvedValue('develop');

    const { projectService } = await import('../../../src/main/services/project.service');
    const project = await projectService.create({ repositoryPath: '/repo/path' });

    expect(project.baseBranch).toBeUndefined();
    expect(mockGitService.getMainBranch).not.toHaveBeenCalled();
  });

  it('stores an explicit target in create()', async () => {
    mockGitService.getMainBranch.mockResolvedValue('develop');

    const { projectService } = await import('../../../src/main/services/project.service');
    const project = await projectService.create({
      repositoryPath: '/repo/path',
      baseBranch: 'trunk',
    });

    expect(project.baseBranch).toBe('trunk');
    expect(mockGitService.getMainBranch).not.toHaveBeenCalled();
  });

  it('stores an explicitly configured project target', async () => {
    const { projectService } = await import('../../../src/main/services/project.service');
    const project = await projectService.create({ repositoryPath: '/repo/path' });

    await projectService.update(project.id, { baseBranch: 'release' });

    expect(project.baseBranch).toBe('release');
  });

  it('leaves the target unconfigured when createFromRemote() does not provide one', async () => {
    mockGitService.getMainBranch.mockResolvedValue('master');
    mockManagedRepoService.getProjectFolderPath.mockReturnValue('/mock/home/.komla/repos/repo');
    mockManagedRepoService.createManagedRepoFromRemote.mockResolvedValue(
      '/mock/home/.komla/repos/repo/.git'
    );

    const { projectService } = await import('../../../src/main/services/project.service');
    const project = await projectService.createFromRemote({
      remoteUrl: 'https://github.com/org/repo.git',
    });

    expect(project.baseBranch).toBeUndefined();
    expect(mockGitService.getMainBranch).not.toHaveBeenCalled();
  });

  it('stores an explicit target in createFromRemote()', async () => {
    mockGitService.getMainBranch.mockResolvedValue('master');
    mockManagedRepoService.getProjectFolderPath.mockReturnValue('/mock/home/.komla/repos/repo');
    mockManagedRepoService.createManagedRepoFromRemote.mockResolvedValue(
      '/mock/home/.komla/repos/repo/.git'
    );

    const { projectService } = await import('../../../src/main/services/project.service');
    const project = await projectService.createFromRemote({
      remoteUrl: 'https://github.com/org/repo.git',
      baseBranch: 'production',
    });

    expect(project.baseBranch).toBe('production');
    expect(mockGitService.getMainBranch).not.toHaveBeenCalled();
  });

  it('prevents concurrent create() calls for the same project folder', async () => {
    // Make createManagedRepo hang so we can trigger concurrency
    let resolveClone!: (value: string) => void;
    mockManagedRepoService.createManagedRepo.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveClone = resolve;
        })
    );

    const { projectService } = await import('../../../src/main/services/project.service');

    const first = projectService.create({ repositoryPath: '/repo/path' });
    const second = projectService.create({ repositoryPath: '/repo/path' });

    await expect(second).rejects.toThrow(
      'A project creation is already in progress for this repository'
    );

    // Resolve first so it completes cleanly
    resolveClone('/mock/home/.komla/repos/repo-name/.git');
    await first;
  });

  describe('findForFolder', () => {
    const seed = (projects: Array<Record<string, unknown>>) => {
      vfs.mock.mkdirSync('/mock/home/.komla/settings', { recursive: true });
      vfs.mock.writeFileSync(
        '/mock/home/.komla/settings/projects.json',
        JSON.stringify({
          _version: 1,
          projects: projects.map((project, order) => ({
            defaultBranchPrefix: '',
            createdAt: 0,
            order,
            managed: false,
            ...project,
          })),
        })
      );
    };
    const load = async () =>
      (await import('../../../src/main/services/project.service')).projectService;
    const inRepo = (root: string, commonGitDir = `${root}/.git`) => {
      mockGitService.isGitRepo.mockResolvedValue(true);
      mockGitService.getRepoRoot.mockResolvedValue(root);
      mockGitService.getCommonGitDir.mockResolvedValue(commonGitDir);
    };

    it('finds the project a folder is, trailing separators and dot segments aside', async () => {
      seed([{ id: 'app', name: 'app', repositoryPath: '/code/app' }]);
      const service = await load();

      for (const path of ['/code/app', '/code/app/', '/code/tools/../app']) {
        expect((await service.findForFolder(path)).project?.id).toBe('app');
      }
      expect(mockGitService.isGitRepo).not.toHaveBeenCalled();
    });

    it('prefers the Git project when a folder project shares its path', async () => {
      seed([
        { id: 'dir', name: 'app folder', kind: 'directory', repositoryPath: '/code/app' },
        { id: 'git', name: 'app', kind: 'git', repositoryPath: '/code/app' },
      ]);
      const service = await load();

      expect((await service.findForFolder('/code/app')).project?.id).toBe('git');
    });

    it('finds the Git project of the repository a subfolder is in', async () => {
      seed([
        { id: 'docs', name: 'docs', kind: 'directory', repositoryPath: '/code/app/docs/old' },
        { id: 'app', name: 'app', repositoryPath: '/code/app' },
      ]);
      inRepo('/code/app');
      const service = await load();

      expect(await service.findForFolder('/code/app/packages/web')).toEqual({
        project: expect.objectContaining({ id: 'app' }),
        repoRoot: null,
      });
    });

    it.each([
      ['a Komla workspace', '/mock/home/.komla/repos/app/.git'],
      ['a worktree of the repository', '/code/app/.git'],
    ])('finds the project of %s', async (_, commonGitDir) => {
      seed([
        {
          id: 'app',
          name: 'app',
          repositoryPath: '/code/app',
          managed: true,
          managedRepoPath: '/mock/home/.komla/repos/app/.git',
        },
      ]);
      inRepo('/mock/home/.komla/worktrees/app/swift-fox', commonGitDir);
      const service = await load();

      expect(
        (await service.findForFolder('/mock/home/.komla/worktrees/app/swift-fox')).project?.id
      ).toBe('app');
    });

    it('offers the root of a repository that is not a project yet', async () => {
      seed([{ id: 'app', name: 'app', kind: 'directory', repositoryPath: '/code/other' }]);
      inRepo('/code/new');
      const service = await load();

      expect(await service.findForFolder('/code/new/src')).toEqual({
        project: null,
        repoRoot: '/code/new',
      });
    });

    it('finds nothing for a folder outside any repository, or where Git fails', async () => {
      seed([]);
      const service = await load();
      mockGitService.isGitRepo.mockResolvedValue(false);
      expect(await service.findForFolder('/notes')).toEqual({ project: null, repoRoot: null });

      inRepo('/code/new');
      mockGitService.getRepoRoot.mockRejectedValue(new Error('not a work tree'));
      expect(await service.findForFolder('/code/new/.git')).toEqual({
        project: null,
        repoRoot: null,
      });
    });

    it.each([
      ['darwin', 'app'],
      ['win32', 'app'],
      ['linux', undefined],
    ] as const)(
      'ignores case in paths only on macOS and Windows (%s)',
      async (platform, expected) => {
        const original = process.platform;
        Object.defineProperty(process, 'platform', { value: platform });
        try {
          seed([{ id: 'app', name: 'app', repositoryPath: '/Code/App' }]);
          mockGitService.isGitRepo.mockResolvedValue(false);
          const service = await load();
          expect((await service.findForFolder('/code/app')).project?.id).toBe(expected);
        } finally {
          Object.defineProperty(process, 'platform', { value: original });
        }
      }
    );
  });
});
