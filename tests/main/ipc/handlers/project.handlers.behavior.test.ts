import { join } from 'path';

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { mockElectron } from '../../../mocks/electron';

vi.mock('electron', () => mockElectron());

const mockProjectService = {
  create: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  update: vi.fn(async (_id: string, updates: Record<string, unknown>) => ({
    id: 'p1',
    ...updates,
  })),
  setSshWorkspaceModeIfUnset: vi.fn(),
  delete: vi.fn(),
  validateRepository: vi.fn(),
  findForFolder: vi.fn(),
  hasProjects: vi.fn(),
  getSettingsPath: vi.fn(),
  createFromRemote: vi.fn(),
  createFromNew: vi.fn(),
  clearPresetReferences: vi.fn(),
  clearLaunchModeReferences: vi.fn(),
  takeIconPrompt: vi.fn(),
  markIconPromptAsked: vi.fn(),
};

const mockWorkspaceService = {
  get: vi.fn(),
  propagateProjectBaseBranch: vi.fn(),
  getWorkspacesByProjectId: vi.fn().mockReturnValue([]),
  delete: vi.fn().mockResolvedValue(undefined),
  assignSshWorkspaceProjects: vi.fn().mockResolvedValue(undefined),
};

const mockAgentPresetService = {
  list: vi.fn(),
  get: vi.fn(),
  getActive: vi.fn(),
  setActive: vi.fn(),
  create: vi.fn(),
  createActive: vi.fn(),
  listTemplates: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  reorder: vi.fn(),
  getSettingsPath: vi.fn(),
  resolveCommand: vi.fn(),
  resolvePresetCommand: vi.fn(),
  getPresetForWorkspace: vi.fn(),
  getActivePresets: vi.fn(),
  addActivePreset: vi.fn(),
  removeActivePreset: vi.fn(),
};

const mockActionService = {
  clearPresetReferences: vi.fn(),
  clearLaunchModeReferences: vi.fn(),
};

vi.mock('../../../../src/main/services/project.service', () => ({
  projectService: mockProjectService,
}));

const { mockScanProjectIcons, mockScanWorkspaceIcons, mockChooseProjectIconFile } = vi.hoisted(() => ({
  mockScanProjectIcons: vi.fn(),
  mockScanWorkspaceIcons: vi.fn(),
  mockChooseProjectIconFile: vi.fn(),
}));
vi.mock('../../../../src/main/services/project-icon.service', () => ({
  scanProjectIcons: mockScanProjectIcons,
  scanWorkspaceIcons: mockScanWorkspaceIcons,
  chooseProjectIconFile: mockChooseProjectIconFile,
}));

vi.mock('../../../../src/main/services/workspace.service', () => ({
  workspaceService: mockWorkspaceService,
}));

vi.mock('../../../../src/main/services/agent-preset.service', () => ({
  agentPresetService: mockAgentPresetService,
}));

const { mockDetectInstalledAgents } = vi.hoisted(() => ({ mockDetectInstalledAgents: vi.fn() }));
const { mockClearProjectData } = vi.hoisted(() => ({
  mockClearProjectData: vi.fn(async () => undefined),
}));
vi.mock('../../../../src/main/services/recent-folders.service', () => ({
  recordOpenedFolder: vi.fn(),
  refreshRecentFolders: vi.fn(async () => ['/notes']),
}));
vi.mock('../../../../src/main/services/dev-preview.service', () => ({
  devPreviewService: { clearProjectData: mockClearProjectData },
}));
vi.mock('../../../../src/main/services/agent-detection.service', () => ({
  detectInstalledAgents: mockDetectInstalledAgents,
}));

vi.mock('../../../../src/main/services/action.service', () => ({
  actionService: mockActionService,
}));

vi.mock('../../../../src/main/lib/logger', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

type IpcMainWithInvoke = { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };

async function setup() {
  const { registerProjectHandlers } =
    await import('../../../../src/main/ipc/handlers/project.handlers');
  const { ipcMain } = (await import('electron')) as unknown as { ipcMain: IpcMainWithInvoke };
  registerProjectHandlers();
  return ipcMain;
}

describe('project IPC behavior', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  const presetDraft = {
    name: 'Custom',
    openCommand: 'claude',
    continueCommand: 'claude --continue',
    promptCommand: 'claude {{prompt}}',
    launchModes: [],
    isBuiltin: false,
  };

  // Channels whose handler only validates its arguments and hands them to one service method.
  it.each<{
    channel: string;
    args: unknown[];
    method: Mock;
    calledWith?: unknown[];
    returns?: unknown;
  }>([
    { channel: 'project:list', args: [], method: mockProjectService.list, returns: [{ id: 'p1' }] },
    { channel: 'project:get', args: ['p1'], method: mockProjectService.get, returns: { id: 'p1' } },
    {
      channel: 'project:validate-repo',
      args: ['/tmp/repo'],
      method: mockProjectService.validateRepository,
      returns: true,
    },
    {
      channel: 'project:find-for-folder',
      args: ['/tmp/repo/src'],
      method: mockProjectService.findForFolder,
      returns: { project: null, repoRoot: '/tmp/repo' },
    },
    {
      channel: 'project:has-projects',
      args: [],
      method: mockProjectService.hasProjects,
      returns: true,
    },
    {
      channel: 'project:get-settings-path',
      args: [],
      method: mockProjectService.getSettingsPath,
      returns: '/tmp/settings.json',
    },
    {
      channel: 'project:create-from-new',
      args: [{ name: 'New Project' }],
      method: mockProjectService.createFromNew,
      returns: { id: 'p1', name: 'New Project' },
    },
    {
      channel: 'preset:list',
      args: [],
      method: mockAgentPresetService.list,
      returns: [{ id: 'pr1' }],
    },
    {
      channel: 'preset:get',
      args: ['pr1'],
      method: mockAgentPresetService.get,
      returns: { id: 'pr1' },
    },
    {
      channel: 'preset:get-active',
      args: [],
      method: mockAgentPresetService.getActive,
      returns: { id: 'pr1' },
    },
    {
      channel: 'preset:set-active',
      args: ['pr1'],
      method: mockAgentPresetService.setActive,
      calledWith: ['pr1', undefined],
    },
    {
      channel: 'preset:set-active',
      args: ['pr1', 'mode-1'],
      method: mockAgentPresetService.setActive,
    },
    // Preload sends an explicit undefined when no launch mode is picked.
    {
      channel: 'preset:set-active',
      args: ['pr1', undefined],
      method: mockAgentPresetService.setActive,
    },
    {
      channel: 'preset:create',
      args: [presetDraft],
      method: mockAgentPresetService.create,
      returns: { id: 'pr1', ...presetDraft },
    },
    {
      channel: 'preset:create-active',
      args: [[presetDraft]],
      method: mockAgentPresetService.createActive,
      returns: [{ id: 'pr1', ...presetDraft }],
    },
    {
      channel: 'preset:update',
      args: ['pr1', { name: 'Updated' }],
      method: mockAgentPresetService.update,
      returns: { id: 'pr1', name: 'Updated' },
    },
    { channel: 'preset:delete', args: ['pr1'], method: mockAgentPresetService.delete },
    { channel: 'preset:reorder', args: ['pr1', 1], method: mockAgentPresetService.reorder },
    {
      channel: 'preset:get-settings-path',
      args: [],
      method: mockAgentPresetService.getSettingsPath,
      returns: '/tmp/presets.json',
    },
  ])(
    '$channel hands $args to its service',
    async ({ channel, args, method, calledWith = args, returns }) => {
      const ipcMain = await setup();
      method.mockReturnValue(returns);

      const result = await ipcMain._invoke(channel, ...args);

      expect(method).toHaveBeenCalledWith(...calledWith);
      expect(result).toEqual(returns);
    }
  );

  it('project:recent-folders returns the recent folders still there', async () => {
    const ipcMain = await setup();
    await expect(ipcMain._invoke('project:recent-folders')).resolves.toEqual(['/notes']);
  });

  describe('project:create', () => {
    it('delegates to projectService.create', async () => {
      const ipcMain = await setup();
      const params = { repositoryPath: '/tmp/repo' };
      const created = { id: 'p1', ...params };
      mockProjectService.create.mockResolvedValue(created);

      const result = await ipcMain._invoke('project:create', params);

      expect(mockProjectService.create).toHaveBeenCalledWith(params);
      expect(result).toEqual(created);
      // SSH workspaces added from other devices may belong to the new project.
      expect(mockWorkspaceService.assignSshWorkspaceProjects).toHaveBeenCalled();
    });
  });

  describe('project:find-icons', () => {
    const icons = [{ path: 'favicon.ico', dataUrl: 'data:image/x-icon;base64,AA==' }];

    it('scans a folder not yet added', async () => {
      const ipcMain = await setup();
      mockScanProjectIcons.mockResolvedValue(icons);

      await expect(ipcMain._invoke('project:find-icons', { folder: '/repo' })).resolves.toBe(icons);
      expect(mockScanProjectIcons).toHaveBeenCalledWith('/repo');
    });

    it("scans a project's newest local workspace when its folder has no icons", async () => {
      const ipcMain = await setup();
      mockProjectService.get.mockReturnValue({ id: 'p1', repositoryPath: '/projects/p1' });
      const newest = { workingDirectory: '/new', createdAt: 2 };
      mockWorkspaceService.getWorkspacesByProjectId.mockReturnValue([
        { workingDirectory: '/old', createdAt: 1 },
        { workingDirectory: '/newest-ssh', createdAt: 3, backend: { kind: 'ssh' } },
        { workingDirectory: '/provisioning', createdAt: 3, provisioning: true },
        newest,
      ]);
      mockScanProjectIcons.mockResolvedValue([]);
      mockScanWorkspaceIcons.mockResolvedValue(icons);

      await expect(ipcMain._invoke('project:find-icons', { projectId: 'p1' })).resolves.toBe(icons);
      expect(mockScanProjectIcons.mock.calls).toEqual([['/projects/p1']]);
      expect(mockScanWorkspaceIcons.mock.calls).toEqual([[newest]]);
    });

    it('scans its newest SSH workspace when it has no local one', async () => {
      const ipcMain = await setup();
      mockProjectService.get.mockReturnValue({ id: 'p1', repositoryPath: '/projects/p1' });
      const newest = { workingDirectory: '/new', createdAt: 2, backend: { kind: 'ssh' } };
      mockWorkspaceService.getWorkspacesByProjectId.mockReturnValue([
        { workingDirectory: '/old', createdAt: 1, backend: { kind: 'ssh' } },
        { workingDirectory: '/failed', createdAt: 3, backend: { kind: 'ssh' }, provisionError: 'x' },
        newest,
      ]);
      mockScanProjectIcons.mockResolvedValue([]);
      mockScanWorkspaceIcons.mockResolvedValue(icons);

      await expect(ipcMain._invoke('project:find-icons', { projectId: 'p1' })).resolves.toBe(icons);
      expect(mockScanWorkspaceIcons.mock.calls).toEqual([[newest]]);
    });

    it("skips a cloned project's folder, which holds only its bare repository", async () => {
      const ipcMain = await setup();
      const folder = join('/komla', 'repos', 'p1');
      mockProjectService.get.mockReturnValue({
        id: 'p1',
        repositoryPath: folder,
        managedRepoPath: join(folder, 'repo.git'),
      });
      const workspace = { workingDirectory: '/wt', createdAt: 1 };
      mockWorkspaceService.getWorkspacesByProjectId.mockReturnValue([workspace]);
      mockScanWorkspaceIcons.mockResolvedValue(icons);

      await expect(ipcMain._invoke('project:find-icons', { projectId: 'p1' })).resolves.toBe(icons);
      expect(mockScanProjectIcons).not.toHaveBeenCalled();
      expect(mockScanWorkspaceIcons.mock.calls).toEqual([[workspace]]);
    });
  });

  describe('project:choose-icon-file', () => {
    it("opens the picker over the asking window and returns the file's icon", async () => {
      const ipcMain = await setup();
      const { BrowserWindow } = await import('electron');
      const window = { id: 7 };
      vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(window as never);
      const icon = { path: 'brand.svg', dataUrl: 'data:image/svg+xml;base64,AA==' };
      mockChooseProjectIconFile.mockResolvedValue(icon);

      await expect(ipcMain._invoke('project:choose-icon-file')).resolves.toBe(icon);
      expect(mockChooseProjectIconFile).toHaveBeenCalledWith(window);
    });
  });

  describe('project:take-icon-prompt', () => {
    it.each([
      ['local', undefined],
      ['SSH', { kind: 'ssh' }],
    ])("scans a %s workspace once its project's prompt is taken", async (_, backend) => {
      const ipcMain = await setup();
      const icons = [{ path: 'logo.svg', dataUrl: 'data:image/svg+xml;base64,AA==' }];
      const workspace = { id: 'w1', projectId: 'p1', workingDirectory: '/wt', backend };
      mockWorkspaceService.get.mockReturnValue(workspace);
      mockProjectService.get.mockReturnValue({ id: 'p1', iconPromptWorkspaceId: 'w1' });
      mockProjectService.takeIconPrompt.mockReturnValueOnce(true).mockReturnValueOnce(false);
      mockScanWorkspaceIcons.mockResolvedValue(icons);

      await expect(ipcMain._invoke('project:take-icon-prompt', 'w1')).resolves.toBe(icons);
      await expect(ipcMain._invoke('project:take-icon-prompt', 'w1')).resolves.toEqual([]);
      expect(mockProjectService.takeIconPrompt).toHaveBeenCalledWith('p1', 'w1');
      expect(mockScanWorkspaceIcons.mock.calls).toEqual([[workspace]]);
      expect(mockProjectService.markIconPromptAsked).toHaveBeenCalledWith('p1');
    });

    it('lets a later workspace look again when this one has no icons', async () => {
      const ipcMain = await setup();
      mockWorkspaceService.get.mockReturnValue({
        id: 'w1',
        projectId: 'p1',
        workingDirectory: '/wt',
      });
      mockProjectService.get.mockReturnValue({ id: 'p1', iconPromptWorkspaceId: 'w1' });
      mockProjectService.takeIconPrompt.mockReturnValue(true);
      mockScanWorkspaceIcons.mockResolvedValue([]);

      await expect(ipcMain._invoke('project:take-icon-prompt', 'w1')).resolves.toEqual([]);
      expect(mockProjectService.markIconPromptAsked).not.toHaveBeenCalled();
    });

    it('leaves the prompt for the workspace it was armed for, once its files are ready', async () => {
      const ipcMain = await setup();
      mockProjectService.get.mockReturnValue({ id: 'p1', iconPromptWorkspaceId: 'w1' });
      for (const workspace of [
        { id: 'w1', projectId: 'p1', workingDirectory: '/remote', backend: { kind: 'ssh' }, provisioning: true },
        { id: 'w1', projectId: 'p1', workingDirectory: '/wt', provisioning: true },
        { id: 'w1', projectId: 'p1', workingDirectory: '/wt', provisionError: 'failed' },
        { id: 'w1', projectId: null, workingDirectory: '/folder' },
        { id: 'older', projectId: 'p1', workingDirectory: '/wt' },
      ]) {
        mockWorkspaceService.get.mockReturnValue(workspace);
        await expect(ipcMain._invoke('project:take-icon-prompt', 'w1')).resolves.toEqual([]);
      }
      expect(mockProjectService.takeIconPrompt).not.toHaveBeenCalled();
    });
  });

  describe('project:update', () => {
    it('delegates to projectService.update and propagates baseBranch changes', async () => {
      const ipcMain = await setup();

      await ipcMain._invoke('project:update', 'p1', { baseBranch: 'main' });

      expect(mockProjectService.update).toHaveBeenCalledWith('p1', { baseBranch: 'main' });
      expect(mockWorkspaceService.propagateProjectBaseBranch).toHaveBeenCalledWith('p1');
    });

    it('does not propagate when baseBranch is not in updates', async () => {
      const ipcMain = await setup();

      await ipcMain._invoke('project:update', 'p1', { name: 'Renamed' });

      expect(mockProjectService.update).toHaveBeenCalledWith('p1', { name: 'Renamed' });
      expect(mockWorkspaceService.propagateProjectBaseBranch).not.toHaveBeenCalled();
    });
  });

  describe('project:set-ssh-workspace-mode-if-unset', () => {
    it('atomically returns the SSH command mode selected by the main process', async () => {
      const ipcMain = await setup();
      const project = { id: 'p1', sshWorkspaceMode: 'remote' };
      mockProjectService.setSshWorkspaceModeIfUnset.mockReturnValue(project);

      const result = await ipcMain._invoke(
        'project:set-ssh-workspace-mode-if-unset',
        'p1',
        'local-mirror-actions'
      );

      expect(mockProjectService.setSshWorkspaceModeIfUnset).toHaveBeenCalledWith(
        'p1',
        'local-mirror-actions'
      );
      expect(result).toEqual(project);
    });
  });

  describe('project:delete', () => {
    it('deletes workspaces before deleting the project', async () => {
      const ipcMain = await setup();
      mockWorkspaceService.getWorkspacesByProjectId.mockReturnValue([
        { id: 'ws-1' },
        { id: 'ws-2' },
      ]);
      mockProjectService.delete.mockResolvedValue(undefined);

      const result = await ipcMain._invoke('project:delete', 'p1');

      expect(mockWorkspaceService.getWorkspacesByProjectId).toHaveBeenCalledWith('p1');
      expect(mockWorkspaceService.delete).toHaveBeenCalledWith('ws-1', true);
      expect(mockWorkspaceService.delete).toHaveBeenCalledWith('ws-2', true);
      expect(mockProjectService.delete).toHaveBeenCalledWith('p1');
      expect(mockClearProjectData).toHaveBeenCalledWith('p1');
      expect(result).toEqual({ deletedWorkspaceIds: ['ws-1', 'ws-2'] });
    });

    it('continues deleting project even if workspace deletion fails', async () => {
      const ipcMain = await setup();
      mockWorkspaceService.getWorkspacesByProjectId.mockReturnValue([
        { id: 'ws-1' },
        { id: 'ws-2' },
      ]);
      mockWorkspaceService.delete.mockRejectedValueOnce(new Error('locked'));
      mockWorkspaceService.delete.mockResolvedValueOnce(undefined);
      mockProjectService.delete.mockResolvedValue(undefined);

      const result = await ipcMain._invoke('project:delete', 'p1');

      expect(mockProjectService.delete).toHaveBeenCalledWith('p1');
      expect(result).toEqual({ deletedWorkspaceIds: ['ws-2'] });
    });

    it('returns empty array when project has no workspaces', async () => {
      const ipcMain = await setup();
      mockWorkspaceService.getWorkspacesByProjectId.mockReturnValue([]);
      mockProjectService.delete.mockResolvedValue(undefined);

      const result = await ipcMain._invoke('project:delete', 'p1');

      expect(mockProjectService.delete).toHaveBeenCalledWith('p1');
      expect(result).toEqual({ deletedWorkspaceIds: [] });
    });
  });

  describe('preset:detect-installed', () => {
    it('looks for the CLIs of the agent templates', async () => {
      const ipcMain = await setup();
      const templates = [{ name: 'Codex', openCommand: 'codex' }];
      mockAgentPresetService.listTemplates.mockReturnValue(templates);
      mockDetectInstalledAgents.mockResolvedValue(['Codex']);

      const result = await ipcMain._invoke('preset:detect-installed');

      expect(mockDetectInstalledAgents).toHaveBeenCalledWith(templates);
      expect(result).toEqual(['Codex']);
    });
  });

  describe('preset:delete', () => {
    it('clears action preset references when a preset is deleted', async () => {
      const ipcMain = await setup();

      await ipcMain._invoke('preset:delete', 'preset-1');

      expect(mockActionService.clearPresetReferences).toHaveBeenCalledWith('preset-1');
    });

    it('clears setup-step preset references when a preset is deleted', async () => {
      const ipcMain = await setup();

      await ipcMain._invoke('preset:delete', 'preset-1');

      expect(mockProjectService.clearPresetReferences).toHaveBeenCalledWith('preset-1');
    });
  });

  describe('preset:update cascade', () => {
    it('clears launch mode references when modes are removed from a preset', async () => {
      const ipcMain = await setup();
      mockAgentPresetService.get.mockReturnValue({
        id: 'pr1',
        launchModes: [
          { id: 'm1', name: 'Mode1', command: 'cmd1' },
          { id: 'm2', name: 'Mode2', command: 'cmd2' },
        ],
      });
      mockAgentPresetService.update.mockReturnValue({
        id: 'pr1',
        launchModes: [{ id: 'm2', name: 'Mode2', command: 'cmd2' }],
      });

      await ipcMain._invoke('preset:update', 'pr1', {
        launchModes: [{ id: 'm2', name: 'Mode2', command: 'cmd2' }],
      });

      expect(mockActionService.clearLaunchModeReferences).toHaveBeenCalledWith('pr1', ['m1']);
      expect(mockProjectService.clearLaunchModeReferences).toHaveBeenCalledWith('pr1', ['m1']);
    });

    it('does not cascade when no launch modes are removed', async () => {
      const ipcMain = await setup();
      mockAgentPresetService.get.mockReturnValue({
        id: 'pr1',
        launchModes: [{ id: 'm1', name: 'Mode1', command: 'cmd1' }],
      });
      mockAgentPresetService.update.mockReturnValue({
        id: 'pr1',
        launchModes: [{ id: 'm1', name: 'Mode1', command: 'cmd1 --updated' }],
      });

      await ipcMain._invoke('preset:update', 'pr1', {
        launchModes: [{ id: 'm1', name: 'Mode1', command: 'cmd1 --updated' }],
      });

      expect(mockActionService.clearLaunchModeReferences).not.toHaveBeenCalled();
    });
  });

  describe('preset:build-prompt-command', () => {
    it('returns null when no active preset', async () => {
      const ipcMain = await setup();
      mockAgentPresetService.getPresetForWorkspace.mockReturnValue(undefined);

      const result = await ipcMain._invoke('preset:build-prompt-command', 'hello');

      expect(result).toBeNull();
      expect(mockAgentPresetService.resolvePresetCommand).not.toHaveBeenCalled();
    });

    it('returns null when active preset has no promptCommand', async () => {
      const ipcMain = await setup();
      mockAgentPresetService.getPresetForWorkspace.mockReturnValue({
        id: 'pr1',
        name: 'Shell Only',
        openCommand: '',
        promptCommand: '',
        launchModes: [],
      });
      mockAgentPresetService.resolvePresetCommand.mockReturnValue('');

      const result = await ipcMain._invoke('preset:build-prompt-command', 'hello');

      expect(result).toBeNull();
      expect(mockAgentPresetService.resolvePresetCommand).toHaveBeenCalled();
    });

    it('builds command when active preset has promptCommand', async () => {
      const ipcMain = await setup();
      const activePreset = {
        id: 'pr1',
        name: 'Claude',
        openCommand: 'claude',
        promptCommand: 'claude {{prompt}}',
      };
      mockAgentPresetService.getPresetForWorkspace.mockReturnValue(activePreset);
      mockAgentPresetService.resolvePresetCommand.mockReturnValue('claude "hello"');

      const result = await ipcMain._invoke('preset:build-prompt-command', 'hello');

      expect(mockAgentPresetService.resolvePresetCommand).toHaveBeenCalledWith(
        activePreset,
        'prompt',
        undefined,
        'hello'
      );
      expect(result).toBe('claude "hello"');
    });

    it('handles undefined presetId and launchModeId gracefully', async () => {
      const ipcMain = await setup();
      const activePreset = {
        id: 'pr1',
        name: 'Claude',
        openCommand: 'claude',
        promptCommand: 'claude {{prompt}}',
      };
      mockAgentPresetService.getPresetForWorkspace.mockReturnValue(activePreset);
      mockAgentPresetService.resolvePresetCommand.mockReturnValue('claude "hello"');

      const result = await ipcMain._invoke(
        'preset:build-prompt-command',
        'hello',
        undefined,
        undefined
      );

      expect(mockAgentPresetService.resolvePresetCommand).toHaveBeenCalledWith(
        activePreset,
        'prompt',
        undefined,
        'hello'
      );
      expect(result).toBe('claude "hello"');
    });

    it('uses launch mode command when launchModeId is provided', async () => {
      const ipcMain = await setup();
      const preset = {
        id: 'pr1',
        name: 'Claude',
        openCommand: 'claude',
        promptCommand: 'claude {{prompt}}',
        launchModes: [
          { id: 'plan', name: 'Plan', command: 'claude --permission-mode plan {{prompt}}' },
        ],
      };
      mockAgentPresetService.get.mockReturnValue(preset);
      mockAgentPresetService.resolvePresetCommand.mockReturnValue(
        'claude --permission-mode plan "hello"'
      );

      const result = await ipcMain._invoke('preset:build-prompt-command', 'hello', 'pr1', 'plan');

      expect(mockAgentPresetService.resolvePresetCommand).toHaveBeenCalledWith(
        preset,
        'prompt',
        'plan',
        'hello'
      );
      expect(result).toBe('claude --permission-mode plan "hello"');
    });

    it('falls back to promptCommand when launchModeId is not found in preset', async () => {
      const ipcMain = await setup();
      const preset = {
        id: 'pr1',
        name: 'Claude',
        openCommand: 'claude',
        promptCommand: 'claude {{prompt}}',
        launchModes: [],
      };
      mockAgentPresetService.get.mockReturnValue(preset);
      mockAgentPresetService.resolvePresetCommand.mockReturnValue('claude "hello"');

      const result = await ipcMain._invoke(
        'preset:build-prompt-command',
        'hello',
        'pr1',
        'nonexistent'
      );

      expect(mockAgentPresetService.resolvePresetCommand).toHaveBeenCalledWith(
        preset,
        'prompt',
        'nonexistent',
        'hello'
      );
      expect(result).toBe('claude "hello"');
    });

    it('returns null when pinned preset no longer exists', async () => {
      const ipcMain = await setup();
      mockAgentPresetService.get.mockReturnValue(undefined);

      const result = await ipcMain._invoke(
        'preset:build-prompt-command',
        'hello',
        'deleted-preset-id',
        'some-mode'
      );

      expect(result).toBeNull();
      expect(mockAgentPresetService.getPresetForWorkspace).not.toHaveBeenCalled();
      expect(mockAgentPresetService.resolvePresetCommand).not.toHaveBeenCalled();
    });

    it('returns command when preset has empty promptCommand but valid launch mode', async () => {
      const ipcMain = await setup();
      const preset = {
        id: 'pr1',
        name: 'Custom',
        openCommand: 'custom',
        promptCommand: '',
        launchModes: [{ id: 'mode1', name: 'Mode 1', command: 'custom --mode1 {{prompt}}' }],
      };
      mockAgentPresetService.get.mockReturnValue(preset);
      mockAgentPresetService.resolvePresetCommand.mockReturnValue('custom --mode1 "hello"');

      const result = await ipcMain._invoke('preset:build-prompt-command', 'hello', 'pr1', 'mode1');

      expect(result).toBe('custom --mode1 "hello"');
    });
  });
});
