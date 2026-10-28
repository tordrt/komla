import { resolve } from 'path';

import { describe, expect, it, vi } from 'vitest';

import {
  TRASH_TURN_LIMIT_MS,
  TRASH_WITHOUT_TURN_DELAY_MS,
  KomlaOperationService,
  type KomlaOperationDependencies,
  type KomlaOperationWorkspace,
} from '../../../src/main/services/komla-operation/operation';
import {
  DEFAULT_WORKSPACE_TAGS,
  MAX_WORKSPACE_TAGS,
  type WorkspaceTagDefinition,
} from '../../../src/shared/lib/workspace-tags';

function createDependencies(
  overrides: Partial<KomlaOperationDependencies> = {}
): KomlaOperationDependencies {
  return {
    getConfig: () => ({}),
    listPresets: () => [],
    getActivePresets: () => [],
    listProjects: () => [],
    getWorkspace: () => undefined,
    listWorkspaces: () => [],
    workspaceTags: () => DEFAULT_WORKSPACE_TAGS,
    saveWorkspaceTags: () => {},
    findWorkspaceByTerminalId: () => undefined,
    getProject: () => undefined,
    getProjectRemoteUrl: async () => 'git@example/repository.git',
    resolveWorkspaceByCwd: () => ({}),
    resolveProjectByCwd: () => ({}),
    resolveEnvironment: () => ({ kind: 'local' }),
    isSshHostReady: () => true,
    listSshHosts: () => [],
    getCheckedOutBranch: async (workspace) => workspace.branchName,
    isBranchOnOrigin: async () => true,
    createWorkspace: vi.fn(),
    addAgentTab: vi.fn(),
    updateWorkspace: vi.fn(),
    setStatusItem: vi.fn(() => true),
    clearStatusItems: vi.fn(() => 0),
    refreshStatusCommand: vi.fn(async () => undefined),
    publish: vi.fn(),
    getMainWindowId: () => undefined,
    getVncAppName: () => '',
    isAgentTurnActive: () => false,
    watchAgentTurnEnd: vi.fn(() => () => {}),
    requestTrash: vi.fn(),
    requestOpenFolder: vi.fn(() => true),
    openInVncApp: vi.fn(),
    ...overrides,
  };
}

describe('KomlaOperationService', () => {
  it('rejects direct workspace identities outside the trusted SSH host', async () => {
    const otherHostWorkspace = {
      id: 'workspace-other',
      workingDirectory: '/same/path',
      backend: { kind: 'ssh' as const, hostId: 'ssh-other' },
    };
    const service = new KomlaOperationService(
      createDependencies({
        findWorkspaceByTerminalId: () => otherHostWorkspace,
        getWorkspace: () => otherHostWorkspace,
      })
    );

    await expect(
      service.execute(
        { terminalId: 'terminal-other', sshHostId: 'ssh-trusted' },
        { type: 'workspace.title', title: 'Wrong host' }
      )
    ).rejects.toMatchObject({ code: 'WORKSPACE_CONTEXT_CONFLICT', statusCode: 403 });
    await expect(
      service.execute(
        { workspaceId: 'workspace-other', sshHostId: 'ssh-trusted' },
        { type: 'workspace.title', title: 'Wrong host' }
      )
    ).rejects.toMatchObject({ code: 'WORKSPACE_CONTEXT_CONFLICT', statusCode: 403 });
  });

  it('reports authoritative managed-terminal context', async () => {
    const workspace = {
      id: 'workspace-1',
      projectId: 'project-1',
      workingDirectory: '/repo',
      presetId: 'codex',
      launchModeId: 'plan',
      backend: { kind: 'local' as const },
    };
    const service = new KomlaOperationService(
      createDependencies({
        findWorkspaceByTerminalId: (id) => (id === 'terminal-1' ? workspace : undefined),
        getProject: (id) =>
          id === 'project-1' ? { id: 'project-1', name: 'Komla', kind: 'git' } : undefined,
      })
    );

    await expect(
      service.execute(
        { terminalId: 'terminal-1', cwd: '/incorrect/fallback' },
        { type: 'context.get' }
      )
    ).resolves.toEqual({
      context: {
        connected: true,
        project: { id: 'project-1', name: 'Komla' },
        workspace: { id: 'workspace-1', path: '/repo', environment: { kind: 'local' } },
        terminalId: 'terminal-1',
        agent: { presetId: 'codex', modeId: 'plan' },
      },
    });
  });

  it('lists active presets with nested modes without exposing shell commands', async () => {
    const service = new KomlaOperationService(
      createDependencies({
        getConfig: () => ({
          agentLaunchDefaultPresetId: 'codex',
          agentLaunchDefaultLaunchModeId: 'plan',
        }),
        listPresets: () => [
          {
            id: 'codex',
            name: 'Codex',
            openCommand: 'codex',
            continueCommand: 'codex resume',
            promptCommand: 'codex {{prompt}}',
            launchModes: [
              { id: 'plan', name: 'Plan', command: 'codex --sandbox read-only {{prompt}}' },
            ],
            isBuiltin: true,
          },
          {
            id: 'inactive',
            name: 'Inactive',
            openCommand: 'secret-agent',
            continueCommand: 'secret-agent resume',
            promptCommand: 'secret-agent {{prompt}}',
            launchModes: [],
            isBuiltin: false,
          },
        ],
        getActivePresets: () => [{ presetId: 'codex', lastUsedAt: 100, lastLaunchModeId: 'plan' }],
        resolveEnvironment: () => ({ kind: 'ssh', hostId: 'box' }),
      })
    );

    const result = await service.execute({}, { type: 'agent.presets' });

    expect(result).toEqual({
      default: { presetId: 'codex', modeId: 'plan' },
      presets: [
        {
          id: 'codex',
          name: 'Codex',
          active: true,
          launchable: true,
          environment: { kind: 'ssh', hostId: 'box' },
          modes: [
            {
              id: 'plan',
              name: 'Plan',
              environment: { kind: 'ssh', hostId: 'box' },
              launchable: true,
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('command');
  });

  it("launches a tab with the workspace's agent in Default when no mode is named", async () => {
    const addAgentTab = vi.fn().mockResolvedValue({ id: 'terminal-2' });
    const publish = vi.fn();
    const workspace = {
      id: 'workspace-1',
      projectId: 'project-1',
      workingDirectory: '/repo',
      presetId: 'codex',
      launchModeId: 'plan',
      backend: { kind: 'local' as const },
    };
    const service = new KomlaOperationService(
      createDependencies({
        findWorkspaceByTerminalId: () => workspace,
        listPresets: () => [
          {
            id: 'codex',
            name: 'Codex',
            openCommand: 'codex',
            continueCommand: 'codex resume',
            promptCommand: 'codex {{prompt}}',
            launchModes: [{ id: 'plan', name: 'Plan', command: 'codex plan' }],
            isBuiltin: true,
          },
        ],
        getActivePresets: () => [{ presetId: 'codex', lastUsedAt: 100 }],
        addAgentTab,
        publish,
      })
    );

    await expect(
      service.execute(
        { terminalId: 'terminal-1' },
        { type: 'agent.launch', destination: 'tab', prompt: 'Review this' }
      )
    ).resolves.toEqual({
      state: 'started',
      destination: { kind: 'tab', workspaceId: 'workspace-1', terminalId: 'terminal-2' },
      agent: { preset: { id: 'codex', name: 'Codex' } },
    });
    // Without replacing the workspace's mode.
    expect(addAgentTab).toHaveBeenCalledWith('workspace-1', 'Review this', undefined, 'codex', {
      keepWorkspaceAgent: true,
    });
    expect(publish).toHaveBeenCalledOnce();
  });

  it("refuses a prompt the agent can't start with, but launches it without one", async () => {
    const addAgentTab = vi.fn().mockResolvedValue({ id: 'terminal-2' });
    const createWorkspace = vi.fn();
    const service = new KomlaOperationService(
      createDependencies({
        findWorkspaceByTerminalId: () => ({
          id: 'workspace-1',
          projectId: 'project-1',
          workingDirectory: '/repo',
          presetId: 'kimi',
          backend: { kind: 'local' as const },
        }),
        listPresets: () => [
          {
            id: 'kimi',
            name: 'Kimi Code',
            openCommand: 'kimi',
            continueCommand: 'kimi --continue',
            promptCommand: '',
            launchModes: [],
            isBuiltin: true,
          },
        ],
        getActivePresets: () => [{ presetId: 'kimi', lastUsedAt: 100 }],
        getProject: () => ({ id: 'project-1', name: 'Komla', kind: 'git' }),
        addAgentTab,
        createWorkspace,
      })
    );

    for (const destination of ['tab', 'workspace'] as const) {
      await expect(
        service.execute(
          { terminalId: 'terminal-1' },
          { type: 'agent.launch', destination, prompt: 'Fix the tests' }
        )
      ).rejects.toMatchObject({
        code: 'AGENT_PRESET_PROMPT_UNSUPPORTED',
        statusCode: 409,
        message:
          "Kimi Code can't start with a prompt. Launch it without one, or pick another agent.",
      });
    }
    expect(addAgentTab).not.toHaveBeenCalled();
    expect(createWorkspace).not.toHaveBeenCalled();

    await service.execute(
      { terminalId: 'terminal-1' },
      { type: 'agent.launch', destination: 'tab' }
    );
    expect(addAgentTab).toHaveBeenCalledOnce();
  });

  describe('launch modes that skip permission prompts', () => {
    const claude = {
      id: 'claude',
      name: 'Claude Code',
      openCommand: 'claude',
      continueCommand: 'claude --continue',
      promptCommand: 'claude {{prompt}}',
      launchModes: [
        { id: 'plan', name: 'Plan', arguments: '--permission-mode plan' },
        {
          id: 'skip',
          name: 'Dangerously skip permissions',
          arguments: '--dangerously-skip-permissions',
        },
      ],
      isBuiltin: true,
    };
    const workspace = {
      id: 'workspace-1',
      projectId: 'project-1',
      workingDirectory: '/repo',
      presetId: 'claude',
      launchModeId: 'skip',
      backend: { kind: 'local' as const },
    };

    function launchService({
      getConfig = () => ({}),
      ...overrides
    }: Partial<KomlaOperationDependencies> = {}) {
      const addAgentTab = vi.fn().mockResolvedValue({ id: 'terminal-2' });
      const service = new KomlaOperationService(
        createDependencies({
          findWorkspaceByTerminalId: () => workspace,
          listPresets: () => [claude],
          getActivePresets: () => [
            { presetId: 'claude', lastUsedAt: 100, lastLaunchModeId: 'skip' },
          ],
          addAgentTab,
          getConfig,
          ...overrides,
        })
      );
      return { service, addAgentTab };
    }

    it('refuses one an agent asks for by name on this computer', async () => {
      const createWorkspace = vi.fn();
      const { service, addAgentTab } = launchService({
        listProjects: () => [{ id: 'project-1', name: 'Komla', kind: 'git' }],
        createWorkspace,
      });

      await expect(
        service.execute(
          { terminalId: 'terminal-1' },
          { type: 'agent.launch', destination: 'tab', mode: 'dangerously skip permissions' }
        )
      ).rejects.toMatchObject({
        code: 'AGENT_MODE_REQUIRES_ISOLATION',
        statusCode: 403,
        message:
          'Agents may start launch mode "Dangerously skip permissions" only on an SSH host marked isolated, and this agent would start on this computer. To allow it here, they can edit Claude Code in Settings → Agents, pick "Anywhere" from the robot button beside the mode and save.',
        details: { presetId: 'claude', modeId: 'skip', environment: { kind: 'local' } },
      });
      await expect(
        service.execute(
          {},
          {
            type: 'agent.launch',
            destination: 'workspace',
            project: 'project-1',
            preset: 'claude',
            mode: 'skip',
          }
        )
      ).rejects.toMatchObject({ code: 'AGENT_MODE_REQUIRES_ISOLATION', statusCode: 403 });
      expect(addAgentTab).not.toHaveBeenCalled();
      expect(createWorkspace).not.toHaveBeenCalled();
    });

    it('starts one in a tab that runs on an isolated SSH host', async () => {
      const { service, addAgentTab } = launchService({
        findWorkspaceByTerminalId: () => ({
          ...workspace,
          backend: { kind: 'ssh' as const, hostId: 'box' },
        }),
        listSshHosts: () => [{ id: 'box', isolated: true }],
      });

      await service.execute(
        { terminalId: 'terminal-1' },
        { type: 'agent.launch', destination: 'tab', mode: 'skip' }
      );
      expect(addAgentTab.mock.calls.map((call) => call[2])).toEqual(['skip']);
    });

    it('refuses one on an SSH host not marked isolated', async () => {
      const { service } = launchService({
        findWorkspaceByTerminalId: () => ({
          ...workspace,
          backend: { kind: 'ssh' as const, hostId: 'box' },
        }),
        listSshHosts: () => [{ id: 'box' }],
      });

      await expect(
        service.execute(
          { terminalId: 'terminal-1' },
          { type: 'agent.launch', destination: 'tab', mode: 'skip' }
        )
      ).rejects.toMatchObject({
        code: 'AGENT_MODE_REQUIRES_ISOLATION',
        message:
          'Agents may start launch mode "Dangerously skip permissions" only on an SSH host marked isolated, and this agent would start on one that isn\'t. To allow it, they can mark the host isolated in Settings → SSH Hosts, or edit Claude Code in Settings → Agents, pick "Anywhere" from the robot button beside the mode and save.',
      });
    });

    it('judges a new workspace by where it will start', async () => {
      const created = { id: 'workspace-2', provisioning: true };
      const cases = [
        // The pinned SSH host, marked isolated.
        { calling: workspace, config: { agentLaunchDefaultSshHostId: 'box' }, allowed: true },
        // Where new workspaces start, from the new workspace dialog.
        { calling: workspace, config: {}, environment: 'ssh', allowed: true },
        { calling: workspace, config: {}, allowed: false },
      ];
      for (const { calling, config, environment, allowed } of cases) {
        const createWorkspace = vi.fn().mockResolvedValue(created);
        const { service } = launchService({
          findWorkspaceByTerminalId: () => calling,
          getProject: () => ({ id: 'project-1', name: 'Komla', kind: 'git' }),
          getConfig: () => config,
          listSshHosts: () => [{ id: 'box', isolated: true }],
          resolveEnvironment: () =>
            environment === 'ssh' ? { kind: 'ssh', hostId: 'box' } : { kind: 'local' },
          createWorkspace,
        });

        const launch = service.execute(
          { terminalId: 'terminal-1' },
          { type: 'agent.launch', destination: 'workspace', mode: 'skip' }
        );
        if (allowed) {
          await launch;
          expect(createWorkspace).toHaveBeenCalledWith(
            expect.objectContaining({ presetId: 'claude', launchModeId: 'skip' })
          );
        } else {
          await expect(launch).rejects.toMatchObject({ code: 'AGENT_MODE_REQUIRES_ISOLATION' });
        }
      }
    });

    it('does not inherit one from the calling workspace or the last launch', async () => {
      const createWorkspace = vi.fn().mockResolvedValue({ id: 'workspace-2' });
      const { service, addAgentTab } = launchService({
        findWorkspaceByTerminalId: () => ({
          ...workspace,
          backend: { kind: 'ssh' as const, hostId: 'box' },
        }),
        listSshHosts: () => [{ id: 'box', isolated: true }],
        getProject: () => ({ id: 'project-1', name: 'Komla', kind: 'git' }),
        createWorkspace,
      });

      // Not even where agents may start it.
      await service.execute(
        { terminalId: 'terminal-1' },
        { type: 'agent.launch', destination: 'workspace' }
      );
      expect(createWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({ presetId: 'claude', launchModeId: undefined })
      );

      await expect(
        service.execute(
          { terminalId: 'terminal-1' },
          { type: 'agent.launch', destination: 'tab', prompt: 'Review this' }
        )
      ).resolves.toMatchObject({ agent: { preset: { id: 'claude' } } });
      // Without replacing the mode the user picked for the workspace.
      expect(addAgentTab).toHaveBeenCalledWith('workspace-1', 'Review this', undefined, 'claude', {
        keepWorkspaceAgent: true,
      });
    });

    it('lets agents start the mode the user pinned as the agent launch default anywhere', async () => {
      const { service, addAgentTab } = launchService({
        getConfig: () => ({
          agentLaunchDefaultPresetId: 'claude',
          agentLaunchDefaultLaunchModeId: 'skip',
        }),
        listPresets: () => [
          {
            ...claude,
            launchModes: [
              claude.launchModes[0],
              { ...claude.launchModes[1], agentLaunch: 'never' as const },
            ],
          },
        ],
      });

      await service.execute(
        { terminalId: 'terminal-1' },
        { type: 'agent.launch', destination: 'tab', prompt: 'Review this' }
      );
      await service.execute(
        { terminalId: 'terminal-1' },
        { type: 'agent.launch', destination: 'tab', prompt: 'Again', mode: 'skip' }
      );
      expect(addAgentTab.mock.calls.map((call) => call[2])).toEqual(['skip', 'skip']);
    });

    it('starts the pinned agent in its pinned mode when an agent names only the agent', async () => {
      const { service, addAgentTab } = launchService({
        getConfig: () => ({
          agentLaunchDefaultPresetId: 'claude',
          agentLaunchDefaultLaunchModeId: 'plan',
        }),
        listPresets: () => [
          claude,
          { ...claude, id: 'codex', name: 'Codex', launchModes: claude.launchModes },
        ],
        getActivePresets: () => [
          { presetId: 'claude', lastUsedAt: 100 },
          { presetId: 'codex', lastUsedAt: 50, lastLaunchModeId: 'plan' },
        ],
      });

      await service.execute(
        { terminalId: 'terminal-1' },
        { type: 'agent.launch', destination: 'tab', preset: 'claude' }
      );
      await service.execute(
        { terminalId: 'terminal-1' },
        { type: 'agent.launch', destination: 'tab', preset: 'codex' }
      );
      expect(addAgentTab.mock.calls.map((call) => [call[3], call[2]])).toEqual([
        ['claude', 'plan'],
        ['codex', undefined],
      ]);
    });

    it('follows where the user lets agents start a mode', async () => {
      const { service, addAgentTab } = launchService({
        listPresets: () => [
          {
            ...claude,
            launchModes: [
              { ...claude.launchModes[0], agentLaunch: 'never' as const },
              { ...claude.launchModes[1], agentLaunch: 'always' as const },
            ],
          },
        ],
      });

      await expect(
        service.execute(
          { terminalId: 'terminal-1' },
          { type: 'agent.launch', destination: 'tab', mode: 'Plan' }
        )
      ).rejects.toMatchObject({
        code: 'AGENT_MODE_REQUIRES_USER',
        statusCode: 403,
        message:
          'Launch mode "Plan" can only be started by the user. To let agents start it, they can edit Claude Code in Settings → Agents, pick where agents may start it from the robot button beside the mode and save.',
      });
      await service.execute(
        { terminalId: 'terminal-1' },
        { type: 'agent.launch', destination: 'tab', mode: 'skip' }
      );
      expect(addAgentTab.mock.calls.map((call) => call[2])).toEqual(['skip']);
    });

    it('marks the modes agents may start only isolated, and those they may not start', async () => {
      const { service } = launchService({
        listPresets: () => [
          {
            ...claude,
            launchModes: [
              ...claude.launchModes,
              { id: 'auto', name: 'Auto', arguments: '--auto', agentLaunch: 'never' as const },
            ],
          },
        ],
      });

      const result = (await service.execute({}, { type: 'agent.presets' })) as {
        presets: Array<{ modes: Array<{ id: string; launchable?: boolean }> }>;
      };
      expect(result.presets[0].modes).toEqual([
        { id: 'plan', name: 'Plan', environment: expect.anything(), launchable: true },
        {
          id: 'skip',
          name: 'Dangerously skip permissions',
          environment: expect.anything(),
          launchable: true,
          isolatedOnly: true,
        },
        {
          id: 'auto',
          name: 'Auto',
          environment: expect.anything(),
          launchable: false,
          unavailableReason:
            'Only the user can start this mode. To let agents start it, they can edit Claude Code in Settings → Agents, pick where agents may start it from the robot button beside the mode and save.',
        },
      ]);
    });

    it('names the pinned mode as the default and lists it as one agents may start', async () => {
      const { service } = launchService({
        getConfig: () => ({
          agentLaunchDefaultPresetId: 'claude',
          agentLaunchDefaultLaunchModeId: 'skip',
        }),
      });

      const result = (await service.execute({}, { type: 'agent.presets' })) as {
        default: object;
        presets: Array<{ modes: object[] }>;
      };
      expect(result.default).toEqual({ presetId: 'claude', modeId: 'skip' });
      expect(result.presets[0].modes[1]).toEqual({
        id: 'skip',
        name: 'Dangerously skip permissions',
        environment: expect.anything(),
        launchable: true,
      });
    });

    it('names no default mode unless one is pinned, whatever was last used', async () => {
      const { service } = launchService({
        getActivePresets: () => [{ presetId: 'claude', lastUsedAt: 100, lastLaunchModeId: 'plan' }],
      });

      const result = (await service.execute({}, { type: 'agent.presets' })) as {
        default?: { presetId: string; modeId?: string };
      };
      expect(result.default).toEqual({ presetId: 'claude' });
    });

    it('still allows other modes by name', async () => {
      const { service, addAgentTab } = launchService();

      await service.execute(
        { terminalId: 'terminal-1' },
        { type: 'agent.launch', destination: 'tab', mode: 'Plan' }
      );
      expect(addAgentTab.mock.calls[0][2]).toBe('plan');
      expect(addAgentTab.mock.calls[0][4]).toEqual({ keepWorkspaceAgent: true });
    });
  });

  it('launches an agent in a new workspace with an explicit preset and mode', async () => {
    const createWorkspace = vi.fn().mockResolvedValue({
      id: 'workspace-2',
      workingDirectory: '/worktrees/cache',
      branchName: 'investigate-cache',
      provisioning: true,
    });
    const publish = vi.fn();
    const service = new KomlaOperationService(
      createDependencies({
        findWorkspaceByTerminalId: () => ({
          id: 'workspace-1',
          projectId: 'project-1',
          workingDirectory: '/repo',
          windowId: 'window-1',
          presetId: 'claude',
          backend: { kind: 'local' },
        }),
        getProject: () => ({ id: 'project-1', name: 'Komla', kind: 'git' }),
        listPresets: () => [
          {
            id: 'codex',
            name: 'Codex',
            openCommand: 'codex',
            continueCommand: 'codex resume',
            promptCommand: 'codex {{prompt}}',
            launchModes: [{ id: 'plan', name: 'Plan', command: 'codex plan' }],
            isBuiltin: true,
          },
        ],
        getActivePresets: () => [{ presetId: 'codex', lastUsedAt: 100 }],
        createWorkspace,
        publish,
      })
    );

    await expect(
      service.execute(
        { terminalId: 'terminal-1' },
        {
          type: 'agent.launch',
          destination: 'workspace',
          preset: 'Codex',
          mode: 'Plan',
          prompt: 'Investigate cache invalidation',
          name: 'Cache investigation',
          description: 'Trace stale reads.',
          branch: 'investigate-cache',
        }
      )
    ).resolves.toEqual({
      state: 'provisioning',
      destination: {
        kind: 'workspace',
        workspaceId: 'workspace-2',
        path: '/worktrees/cache',
        branch: 'investigate-cache',
      },
      agent: { preset: { id: 'codex', name: 'Codex' }, mode: { id: 'plan', name: 'Plan' } },
    });
    expect(createWorkspace).toHaveBeenCalledWith({
      mode: 'worktree',
      projectId: 'project-1',
      customName: 'Cache investigation',
      customDescription: 'Trace stale reads.',
      initialPrompt: 'Investigate cache invalidation',
      branchName: 'investigate-cache',
      windowId: 'window-1',
      presetId: 'codex',
      launchModeId: 'plan',
      deferBranchNaming: true,
      skipRecordUsage: true,
    });
    expect(publish).toHaveBeenCalledOnce();
  });

  it('launches in an explicitly selected project without ambient workspace context', async () => {
    const createWorkspace = vi.fn().mockResolvedValue({
      id: 'workspace-2',
      workingDirectory: '/worktrees/cache',
      branchName: 'cache-review',
    });
    const service = new KomlaOperationService(
      createDependencies({
        listProjects: () => [{ id: 'project-1', name: 'Komla', kind: 'git' }],
        createWorkspace,
      })
    );

    await expect(
      service.execute(
        {},
        {
          type: 'agent.launch',
          destination: 'workspace',
          project: 'Komla',
          branch: 'cache-review',
        }
      )
    ).resolves.toMatchObject({
      state: 'started',
      destination: { kind: 'workspace', workspaceId: 'workspace-2' },
    });
    expect(createWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'project-1', branchName: 'cache-review' })
    );
  });

  it('places agent-launched workspaces on the pinned SSH host', async () => {
    const createWorkspace = vi.fn().mockResolvedValue({ id: 'workspace-2' });
    const addAgentTab = vi.fn().mockResolvedValue({ id: 'terminal-2' });
    const workspace = {
      id: 'workspace-1',
      projectId: 'project-1',
      backend: { kind: 'local' as const },
    };
    const service = new KomlaOperationService(
      createDependencies({
        getConfig: () => ({ agentLaunchDefaultSshHostId: 'ssh-1' }),
        listProjects: () => [{ id: 'project-1', name: 'Komla', kind: 'git' }],
        getWorkspace: () => workspace,
        createWorkspace,
        addAgentTab,
      })
    );

    await service.execute({}, { type: 'agent.launch', destination: 'workspace', project: 'Komla' });
    expect(createWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ environment: { kind: 'ssh', hostId: 'ssh-1' } })
    );

    // A tab stays in its existing workspace, so the SSH pin does not apply.
    await service.execute(
      { workspaceId: 'workspace-1' },
      { type: 'agent.launch', destination: 'tab' }
    );
    expect(addAgentTab).toHaveBeenCalledWith('workspace-1', undefined, undefined, undefined, {
      keepWorkspaceAgent: true,
    });
  });

  it('ignores the SSH host pin where it cannot place the workspace', async () => {
    const createWorkspace = vi.fn().mockResolvedValue({ id: 'workspace-new' });
    const sourceBackend = { kind: 'ssh' as const, hostId: 'ssh-b', gitUrl: 'git@example/a.git' };
    let hostReady = true;
    let source: { id: string; projectId: string | null; backend: typeof sourceBackend } | undefined;
    const service = new KomlaOperationService(
      createDependencies({
        getConfig: () => ({ agentLaunchDefaultSshHostId: 'ssh-a' }),
        listProjects: () => [
          { id: 'git-project', name: 'Git', kind: 'git' },
          { id: 'dir-project', name: 'Dir', kind: 'directory' },
        ],
        getWorkspace: () => source,
        isSshHostReady: () => hostReady,
        createWorkspace,
      })
    );
    const lastParams = () => createWorkspace.mock.calls.at(-1)![0];

    // Directory projects cannot live on SSH hosts.
    await service.execute({}, { type: 'agent.launch', destination: 'workspace', project: 'Dir' });
    expect(lastParams()).toMatchObject({ mode: 'directory' });
    expect(lastParams()).not.toHaveProperty('environment');

    // A sibling of an SSH workspace stays on its source host.
    source = { id: 'source', projectId: null, backend: sourceBackend };
    await service.execute(
      { workspaceId: 'source' },
      { type: 'agent.launch', destination: 'workspace' }
    );
    expect(lastParams()).toMatchObject({
      location: { kind: 'ssh', hostId: 'ssh-b', gitUrl: 'git@example/a.git' },
    });
    expect(lastParams()).not.toHaveProperty('environment');

    // A pinned host that was removed or is still in setup falls back to the rules.
    source = undefined;
    hostReady = false;
    await service.execute({}, { type: 'agent.launch', destination: 'workspace', project: 'Git' });
    expect(lastParams()).not.toHaveProperty('environment');
  });

  it('places a different project from an SSH workspace on the same host', async () => {
    const createWorkspace = vi.fn().mockResolvedValue({ id: 'workspace-new' });
    const service = new KomlaOperationService(
      createDependencies({
        findWorkspaceByTerminalId: () => ({
          id: 'workspace-a',
          projectId: 'project-a',
          windowId: 'window-1',
          backend: { kind: 'ssh', hostId: 'ssh-dev', gitUrl: 'git@example/a.git' },
        }),
        listProjects: () => [{ id: 'project-b', name: 'Project B', kind: 'git' }],
        getProject: (id) =>
          id === 'project-a' ? { id, name: 'Project A', kind: 'git' } : undefined,
        createWorkspace,
      })
    );

    await service.execute(
      { terminalId: 'terminal-a', sshHostId: 'ssh-dev' },
      { type: 'agent.launch', destination: 'workspace', project: 'Project B' }
    );

    expect(createWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'worktree',
        projectId: 'project-b',
        windowId: 'window-1',
        environment: { kind: 'ssh', hostId: 'ssh-dev' },
      })
    );
    // Project A's clone must not be reused for Project B.
    expect(createWorkspace.mock.calls[0][0]).not.toHaveProperty('location');
    expect(createWorkspace.mock.calls[0][0]).not.toHaveProperty('sourceWorkspaceId');
  });

  it('keeps workspace launches that arrive through an SSH tunnel on that host', async () => {
    const createWorkspace = vi.fn();
    const service = new KomlaOperationService(
      createDependencies({
        findWorkspaceByTerminalId: (id) =>
          id === 'terminal-a'
            ? {
                id: 'workspace-a',
                projectId: 'project-a',
                backend: { kind: 'ssh', hostId: 'ssh-dev', gitUrl: 'git@example/a.git' },
              }
            : undefined,
        listProjects: () => [
          { id: 'project-a', name: 'Project A', kind: 'git' },
          { id: 'folder', name: 'Folder', kind: 'directory' },
        ],
        createWorkspace,
      })
    );

    // The caller has to be in one of the host's workspaces.
    await expect(
      service.execute(
        { sshHostId: 'ssh-dev' },
        { type: 'agent.launch', destination: 'workspace', project: 'Project A' }
      )
    ).rejects.toMatchObject({ code: 'SSH_WORKSPACE_CONTEXT_REQUIRED', statusCode: 403 });
    await expect(
      service.execute(
        { terminalId: 'unknown-terminal', cwd: '/elsewhere', sshHostId: 'ssh-dev' },
        { type: 'agent.launch', destination: 'workspace', project: 'Project A' }
      )
    ).rejects.toMatchObject({ code: 'SSH_WORKSPACE_CONTEXT_REQUIRED', statusCode: 403 });

    // Folder projects can't live on an SSH host.
    await expect(
      service.execute(
        { terminalId: 'terminal-a', sshHostId: 'ssh-dev' },
        { type: 'agent.launch', destination: 'workspace', project: 'Folder' }
      )
    ).rejects.toMatchObject({ code: 'SSH_HOST_PROJECT_UNSUPPORTED', statusCode: 400 });

    expect(createWorkspace).not.toHaveBeenCalled();
  });

  it('explains when a project needs a Git remote to start on an SSH host', async () => {
    const createWorkspace = vi.fn();
    const service = new KomlaOperationService(
      createDependencies({
        findWorkspaceByTerminalId: () => ({
          id: 'workspace-a',
          projectId: 'project-a',
          backend: { kind: 'ssh', hostId: 'ssh-dev', gitUrl: 'git@example/a.git' },
        }),
        listProjects: () => [{ id: 'local-only', name: 'Local Only', kind: 'git' }],
        getProjectRemoteUrl: async () => null,
        createWorkspace,
      })
    );

    await expect(
      service.execute(
        { terminalId: 'terminal-a', sshHostId: 'ssh-dev' },
        { type: 'agent.launch', destination: 'workspace', project: 'Local Only' }
      )
    ).rejects.toMatchObject({
      code: 'SSH_HOST_PROJECT_NEEDS_REMOTE',
      statusCode: 400,
      message: 'Add a Git remote to Local Only to start it on an SSH host.',
    });
    expect(createWorkspace).not.toHaveBeenCalled();
  });

  it('places a tunnel launch on the host when the project is known but no single workspace is', async () => {
    const createWorkspace = vi.fn().mockResolvedValue({ id: 'workspace-new' });
    const service = new KomlaOperationService(
      createDependencies({
        // Two synced copies share the path, so only the project resolves.
        resolveProjectByCwd: (_cwd, sshHostId) =>
          sshHostId === 'ssh-dev' ? { project: { id: 'project-a', name: 'A', kind: 'git' } } : {},
        createWorkspace,
      })
    );

    await service.execute(
      { cwd: '/srv/worktrees/a', sshHostId: 'ssh-dev' },
      { type: 'agent.launch', destination: 'workspace' }
    );

    expect(createWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-a',
        environment: { kind: 'ssh', hostId: 'ssh-dev' },
      })
    );
  });

  it('launches a sibling from a URL-only SSH workspace without requiring a project', async () => {
    const sourceBackend = {
      kind: 'ssh' as const,
      hostId: 'ssh-dev',
      gitUrl: 'git@example/repository.git',
    };
    const createWorkspace = vi.fn().mockResolvedValue({ id: 'workspace-new' });
    const service = new KomlaOperationService(
      createDependencies({
        findWorkspaceByTerminalId: () => ({
          id: 'workspace-source',
          projectId: null,
          windowId: 'window-1',
          workingDirectory: '/srv/worktrees/source',
          backend: sourceBackend,
        }),
        createWorkspace,
      })
    );

    await expect(
      service.execute(
        { terminalId: 'terminal-source', sshHostId: 'ssh-dev' },
        { type: 'agent.launch', destination: 'workspace', branch: 'agent/sibling' }
      )
    ).resolves.toMatchObject({
      state: 'started',
      destination: { kind: 'workspace', workspaceId: 'workspace-new' },
    });
    expect(createWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'worktree',
        branchName: 'agent/sibling',
        windowId: 'window-1',
        sourceWorkspaceId: 'workspace-source',
        location: {
          kind: 'ssh',
          hostId: 'ssh-dev',
          gitUrl: 'git@example/repository.git',
          sourceBackend,
        },
      })
    );
    expect(createWorkspace.mock.calls[0][0]).not.toHaveProperty('projectId');
  });

  it('starts a new workspace from the branch checked out in the calling workspace', async () => {
    const createWorkspace = vi.fn().mockResolvedValue({
      id: 'workspace-2',
      branchName: 'agent/follow-up',
    });
    const getCheckedOutBranch = vi.fn().mockResolvedValue('feature/search-v2');
    const isBranchOnOrigin = vi.fn();
    const service = new KomlaOperationService(
      createDependencies({
        findWorkspaceByTerminalId: () => ({
          id: 'workspace-1',
          projectId: 'project-1',
          workingDirectory: '/worktrees/search',
          branchName: 'feature/search',
          backend: { kind: 'local' },
        }),
        getProject: () => ({ id: 'project-1', name: 'Komla', kind: 'git', baseBranch: 'main' }),
        getCheckedOutBranch,
        isBranchOnOrigin,
        createWorkspace,
      })
    );

    await expect(
      service.execute(
        { terminalId: 'terminal-1' },
        { type: 'agent.launch', destination: 'workspace', fromCurrentBranch: true }
      )
    ).resolves.toMatchObject({
      destination: {
        kind: 'workspace',
        branch: 'agent/follow-up',
        branchedFrom: 'feature/search-v2',
      },
    });
    // The agent may have switched branches since the workspace was created.
    expect(getCheckedOutBranch).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'workspace-1' })
    );
    expect(createWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'project-1', baseBranch: 'feature/search-v2' })
    );
    // A local worktree shares the repository, so unpushed commits are available.
    expect(isBranchOnOrigin).not.toHaveBeenCalled();
  });

  it('starts from the current branch of an SSH workspace on the same host', async () => {
    const sourceBackend = { kind: 'ssh' as const, hostId: 'ssh-dev', gitUrl: 'git@example/a.git' };
    const createWorkspace = vi.fn().mockResolvedValue({ id: 'workspace-new' });
    const isBranchOnOrigin = vi.fn();
    const service = new KomlaOperationService(
      createDependencies({
        findWorkspaceByTerminalId: () => ({
          id: 'workspace-a',
          projectId: 'project-a',
          branchName: 'feature/remote',
          backend: sourceBackend,
        }),
        getProject: () => ({ id: 'project-a', name: 'A', kind: 'git' }),
        isBranchOnOrigin,
        createWorkspace,
      })
    );

    await service.execute(
      { terminalId: 'terminal-a', sshHostId: 'ssh-dev' },
      { type: 'agent.launch', destination: 'workspace', fromCurrentBranch: true }
    );

    expect(createWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        baseBranch: 'feature/remote',
        sourceWorkspaceId: 'workspace-a',
        location: expect.objectContaining({ kind: 'ssh', hostId: 'ssh-dev' }),
      })
    );
    // The new worktree comes from the same clone on the host.
    expect(isBranchOnOrigin).not.toHaveBeenCalled();
  });

  it('requires the current branch on origin before starting it on an SSH host', async () => {
    const createWorkspace = vi.fn().mockResolvedValue({ id: 'workspace-new' });
    let onOrigin = false;
    const isBranchOnOrigin = vi.fn(async () => onOrigin);
    let config: { agentLaunchDefaultSshHostId?: string } = { agentLaunchDefaultSshHostId: 'ssh-1' };
    let defaultEnvironment: { kind: 'local' } | { kind: 'ssh'; hostId: string } = { kind: 'local' };
    const service = new KomlaOperationService(
      createDependencies({
        getConfig: () => config,
        findWorkspaceByTerminalId: () => ({
          id: 'workspace-1',
          projectId: 'project-1',
          workingDirectory: '/worktrees/search',
          branchName: 'feature/search',
          backend: { kind: 'local' },
        }),
        getProject: () => ({ id: 'project-1', name: 'Komla', kind: 'git' }),
        resolveEnvironment: () => defaultEnvironment,
        isBranchOnOrigin,
        createWorkspace,
      })
    );
    const launch = () =>
      service.execute(
        { terminalId: 'terminal-1' },
        { type: 'agent.launch', destination: 'workspace', fromCurrentBranch: true }
      );

    // The agent launch defaults pin an SSH host.
    await expect(launch()).rejects.toMatchObject({
      code: 'CURRENT_BRANCH_NOT_PUSHED',
      statusCode: 400,
      message: expect.stringContaining('origin has every commit on feature/search'),
    });
    expect(isBranchOnOrigin).toHaveBeenCalledWith('project-1', 'feature/search');

    // New workspaces default to an SSH host.
    config = {};
    defaultEnvironment = { kind: 'ssh', hostId: 'ssh-2' };
    await expect(launch()).rejects.toMatchObject({ code: 'CURRENT_BRANCH_NOT_PUSHED' });
    expect(createWorkspace).not.toHaveBeenCalled();

    onOrigin = true;
    await launch();
    expect(createWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ baseBranch: 'feature/search' })
    );
  });

  it('rejects starting from the current branch without a branch to start from', async () => {
    const createWorkspace = vi.fn();
    let checkedOutBranch: string | undefined = 'feature/search';
    let source:
      | { id: string; projectId: string; workingDirectory: string; backend: { kind: 'local' } }
      | undefined;
    const service = new KomlaOperationService(
      createDependencies({
        findWorkspaceByTerminalId: () => source,
        listProjects: () => [
          { id: 'project-1', name: 'Komla', kind: 'git' },
          { id: 'project-2', name: 'Other', kind: 'git' },
          { id: 'folder', name: 'Folder', kind: 'directory' },
        ],
        getProject: (id) =>
          [
            { id: 'project-1', name: 'Komla', kind: 'git' },
            { id: 'folder', name: 'Folder', kind: 'directory' },
          ].find((project) => project.id === id),
        getCheckedOutBranch: async () => checkedOutBranch,
        createWorkspace,
      })
    );
    const launch = (project?: string) =>
      service.execute(
        { terminalId: 'terminal-1' },
        {
          type: 'agent.launch',
          destination: 'workspace',
          fromCurrentBranch: true,
          ...(project ? { project } : {}),
        }
      );
    const unavailable = { code: 'CURRENT_BRANCH_UNAVAILABLE', statusCode: 400 };

    // No calling workspace.
    await expect(launch('Komla')).rejects.toMatchObject(unavailable);

    // The calling workspace belongs to another project.
    source = {
      id: 'workspace-1',
      projectId: 'project-1',
      workingDirectory: '/w',
      backend: { kind: 'local' },
    };
    await expect(launch('Other')).rejects.toMatchObject(unavailable);

    // A folder project has no worktree to branch.
    source = { ...source, projectId: 'folder' };
    await expect(launch()).rejects.toMatchObject(unavailable);

    // Detached HEAD.
    source = { ...source, projectId: 'project-1' };
    checkedOutBranch = undefined;
    await expect(launch()).rejects.toMatchObject({
      ...unavailable,
      message: expect.stringContaining('no branch checked out'),
    });

    // An SSH status snapshot reports a detached HEAD by name.
    checkedOutBranch = 'HEAD';
    await expect(launch()).rejects.toMatchObject(unavailable);

    expect(createWorkspace).not.toHaveBeenCalled();
  });

  it('updates the current workspace title through the operation interface', async () => {
    const updateWorkspace = vi.fn().mockReturnValue({ id: 'workspace-1' });
    const publish = vi.fn();
    const service = new KomlaOperationService(
      createDependencies({
        findWorkspaceByTerminalId: () => ({ id: 'workspace-1' }),
        updateWorkspace,
        publish,
      })
    );

    await expect(
      service.execute(
        { terminalId: 'terminal-1' },
        {
          type: 'workspace.title',
          title: 'Cache investigation',
          description: 'Trace stale cache reads.',
        }
      )
    ).resolves.toEqual({
      workspace: {
        id: 'workspace-1',
        title: 'Cache investigation',
        description: 'Trace stale cache reads.',
      },
    });
    expect(updateWorkspace).toHaveBeenCalledWith('workspace-1', {
      customName: 'Cache investigation',
      customDescription: 'Trace stale cache reads.',
    });
    expect(publish).toHaveBeenCalledOnce();
  });

  it('tags the current workspace and takes the tag off', async () => {
    const updateWorkspace = vi.fn((id: string, updates: Record<string, unknown>) => ({
      id,
      ...updates,
    }));
    const publish = vi.fn();
    const service = new KomlaOperationService(
      createDependencies({
        findWorkspaceByTerminalId: () => ({ id: 'workspace-1' }),
        updateWorkspace,
        publish,
      })
    );

    await expect(
      service.execute(
        { terminalId: 'terminal-1' },
        { type: 'workspace.tag', tag: '  Waiting   for review ' }
      )
    ).resolves.toEqual({
      tag: { workspaceId: 'workspace-1', tag: 'Waiting for review', changed: true, added: true },
    });
    expect(updateWorkspace).toHaveBeenLastCalledWith('workspace-1', {
      tag: 'Waiting for review',
      tagSource: undefined,
      tagTooltip: undefined,
    });

    await expect(
      service.execute({ terminalId: 'terminal-1' }, { type: 'workspace.tag' })
    ).resolves.toEqual({ tag: { workspaceId: 'workspace-1', tag: null, changed: true } });
    expect(updateWorkspace).toHaveBeenLastCalledWith('workspace-1', {
      tag: undefined,
      tagSource: undefined,
    });
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it("adds a tag it doesn't have to the list with the look asked for, and keeps the user's", async () => {
    let tags: readonly WorkspaceTagDefinition[] = DEFAULT_WORKSPACE_TAGS;
    const saveWorkspaceTags = vi.fn((next: readonly WorkspaceTagDefinition[]) => {
      tags = next;
    });
    const updateWorkspace = vi.fn((id: string, updates: Record<string, unknown>) => ({
      id,
      ...updates,
    }));
    const service = new KomlaOperationService(
      createDependencies({
        findWorkspaceByTerminalId: () => ({ id: 'workspace-1' }),
        workspaceTags: () => tags,
        saveWorkspaceTags,
        updateWorkspace,
      })
    );
    const icon = 'data:image/svg+xml;base64,PHN2Zy8+';

    await service.execute(
      { terminalId: 'terminal-1' },
      {
        type: 'workspace.tag',
        tag: 'CI running',
        tone: 'info',
        icon,
        spinner: true,
        tooltip: 'build 7 of 9',
      }
    );
    expect(tags.at(-1)).toEqual({ name: 'CI running', tone: 'info', icon, spinner: true });
    expect(updateWorkspace).toHaveBeenLastCalledWith('workspace-1', {
      tag: 'CI running',
      tagSource: undefined,
      tagTooltip: 'build 7 of 9',
    });

    // A tag in the list, in any case, keeps its name and the user's look.
    await expect(
      service.execute(
        { terminalId: 'terminal-1' },
        { type: 'workspace.tag', tag: 'blocked', tone: 'success', spinner: true }
      )
    ).resolves.toEqual({
      tag: { workspaceId: 'workspace-1', tag: 'Blocked', changed: true, added: false },
    });
    expect(saveWorkspaceTags).toHaveBeenCalledOnce();
    expect(tags.find((tag) => tag.name === 'Blocked')).toEqual({ name: 'Blocked', tone: 'error' });
  });

  it('refuses a new tag once the list is full, but uses one it has', async () => {
    const tags = Array.from({ length: MAX_WORKSPACE_TAGS }, (_, index) => ({
      name: `Tag ${index}`,
      tone: 'neutral' as const,
    }));
    const updateWorkspace = vi.fn((id: string) => ({ id }));
    const service = new KomlaOperationService(
      createDependencies({
        findWorkspaceByTerminalId: () => ({ id: 'workspace-1' }),
        workspaceTags: () => tags,
        updateWorkspace,
      })
    );

    await expect(
      service.execute({ terminalId: 'terminal-1' }, { type: 'workspace.tag', tag: 'CI running' })
    ).rejects.toMatchObject({ code: 'TAG_LIST_FULL', statusCode: 409 });
    expect(updateWorkspace).not.toHaveBeenCalled();
    await service.execute({ terminalId: 'terminal-1' }, { type: 'workspace.tag', tag: 'Tag 3' });
    expect(updateWorkspace).toHaveBeenCalledOnce();
  });

  it('changes only a workspace with the tag --if names, so a late script leaves a new one be', async () => {
    let workspace: KomlaOperationWorkspace = { id: 'workspace-1', tag: 'In review' };
    const updateWorkspace = vi.fn((_id: string, updates: Record<string, unknown>) => {
      workspace = { ...workspace, ...updates };
      return workspace;
    });
    const service = new KomlaOperationService(
      createDependencies({ findWorkspaceByTerminalId: () => workspace, updateWorkspace })
    );

    await expect(
      service.execute({ terminalId: 'terminal-1' }, { type: 'workspace.tag', ifTag: 'CI running' })
    ).resolves.toEqual({ tag: { workspaceId: 'workspace-1', tag: 'In review', changed: false } });
    await service.execute(
      { terminalId: 'terminal-1' },
      { type: 'workspace.tag', tag: 'CI failed', ifTag: 'CI running' }
    );
    expect(updateWorkspace).not.toHaveBeenCalled();

    await service.execute(
      { terminalId: 'terminal-1' },
      { type: 'workspace.tag', tag: 'Blocked', ifTag: 'in review' }
    );
    expect(workspace.tag).toBe('Blocked');
    await service.execute({ terminalId: 'terminal-1' }, { type: 'workspace.tag', ifTag: 'Blocked' });
    expect(workspace.tag).toBeUndefined();
  });

  it('acts on the workspace --workspace names, but never trashes it', async () => {
    const workspaces: Record<string, KomlaOperationWorkspace> = {
      'workspace-2': { id: 'workspace-2' },
      'ssh-workspace': { id: 'ssh-workspace', backend: { kind: 'ssh', hostId: 'host-1' } },
    };
    const updateWorkspace = vi.fn((id: string) => workspaces[id]);
    const service = new KomlaOperationService(
      createDependencies({ getWorkspace: (id) => workspaces[id], updateWorkspace })
    );

    await service.execute(
      { workspaceId: 'workspace-2', targeted: true },
      { type: 'workspace.tag', tag: 'Blocked' }
    );
    expect(updateWorkspace).toHaveBeenCalledWith('workspace-2', expect.anything());
    await expect(
      service.execute({ workspaceId: 'missing', targeted: true }, { type: 'workspace.tag' })
    ).rejects.toMatchObject({
      code: 'WORKSPACE_NOT_FOUND',
      message: expect.stringContaining('No workspace has the id missing'),
    });
    await expect(
      service.execute({ workspaceId: 'workspace-2', targeted: true }, { type: 'workspace.trash' })
    ).rejects.toMatchObject({ code: 'WORKSPACE_TARGET_NOT_ALLOWED', statusCode: 403 });
    // An SSH host's tunnel still reaches only that host's workspaces.
    await expect(
      service.execute(
        { workspaceId: 'workspace-2', sshHostId: 'host-1', targeted: true },
        { type: 'workspace.tag' }
      )
    ).rejects.toMatchObject({ code: 'WORKSPACE_CONTEXT_CONFLICT' });
  });

  it('lists workspaces, leaving out the Trash and other SSH hosts', async () => {
    const service = new KomlaOperationService(
      createDependencies({
        getProject: (id) => (id === 'p1' ? { id: 'p1', name: 'App' } : undefined),
        listWorkspaces: () => [
          {
            id: 'w1',
            name: 'swift-otter',
            customName: 'Add search',
            projectId: 'p1',
            branchName: 'add-search',
            workingDirectory: '/w/add-search',
            agentActive: true,
            tag: 'In review',
            attention: { kind: 'turn-complete', source: 'claude-code', updatedAt: 0 },
          },
          { id: 'w2', name: 'trashed', status: 'trashed' },
          { id: 'w3', name: 'remote', backend: { kind: 'ssh', hostId: 'host-1' } },
        ],
      })
    );

    await expect(service.execute({}, { type: 'workspace.list' })).resolves.toEqual({
      workspaces: [
        {
          id: 'w1',
          name: 'Add search',
          project: { id: 'p1', name: 'App' },
          branch: 'add-search',
          path: '/w/add-search',
          environment: { kind: 'local' },
          agentActive: true,
          attention: 'turn-complete',
          tag: 'In review',
        },
        {
          id: 'w3',
          name: 'remote',
          environment: { kind: 'ssh', hostId: 'host-1' },
          agentActive: false,
        },
      ],
    });
    const all = (await service.execute({}, { type: 'workspace.list', includeTrashed: true })) as {
      workspaces: { id: string; trashed?: boolean }[];
    };
    expect(all.workspaces.find((workspace) => workspace.id === 'w2')).toMatchObject({
      trashed: true,
    });
    const fromHost = (await service.execute(
      { sshHostId: 'host-1' },
      { type: 'workspace.list' }
    )) as { workspaces: { id: string }[] };
    expect(fromHost.workspaces.map((workspace) => workspace.id)).toEqual(['w3']);
  });

  it('lists the tags for komla tag, marking an icon in place of its image and hidden ones', async () => {
    const service = new KomlaOperationService(
      createDependencies({
        workspaceTags: () => [
          { name: 'In review', tone: 'info', pullRequestState: 'in-review' },
          {
            name: 'CI running',
            tone: 'info',
            icon: 'data:image/svg+xml;base64,PHN2Zy8+',
            spinner: true,
          },
          { name: 'Blocked', tone: 'error' },
        ],
        // Tags belong to the user, not to a workspace, so turning tagging off leaves them listed.
        getConfig: () => ({
          agentDisabledCapabilities: ['workspace.tag'],
          hiddenWorkspaceTags: ['blocked'],
        }),
      })
    );

    for (const context of [{}, { sshHostId: 'host-1' }]) {
      await expect(service.execute(context, { type: 'tag.list' })).resolves.toEqual({
        tags: [
          { name: 'In review', tone: 'info', pullRequestState: 'in-review' },
          { name: 'CI running', tone: 'info', hasIcon: true, spinner: true },
          { name: 'Blocked', tone: 'error', hidden: true },
        ],
      });
    }
  });

  it('refuses to tag when the user turned it off', async () => {
    const updateWorkspace = vi.fn();
    const service = new KomlaOperationService(
      createDependencies({
        findWorkspaceByTerminalId: () => ({ id: 'workspace-1' }),
        updateWorkspace,
        getConfig: () => ({ agentDisabledCapabilities: ['workspace.tag'] }),
      })
    );

    await expect(
      service.execute({ terminalId: 'terminal-1' }, { type: 'workspace.tag', tag: 'Blocked' })
    ).rejects.toMatchObject({ code: 'CAPABILITY_DISABLED', statusCode: 403 });
    expect(updateWorkspace).not.toHaveBeenCalled();
  });

  it('snoozes the current workspace and wakes it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 20, 15, 30));
    let workspace: { id: string; snoozedUntil?: number } = { id: 'workspace-1' };
    const updateWorkspace = vi.fn((_id: string, updates: Record<string, unknown>) => {
      workspace = { ...workspace, ...updates };
      return workspace;
    });
    const publish = vi.fn();
    const service = new KomlaOperationService(
      createDependencies({
        findWorkspaceByTerminalId: () => workspace,
        updateWorkspace,
        publish,
      })
    );
    const until = new Date(2026, 9, 20, 17, 30).getTime();

    await expect(
      service.execute({ terminalId: 'terminal-1' }, { type: 'workspace.snooze', until: '2h' })
    ).resolves.toEqual({
      snooze: { workspaceId: 'workspace-1', until, untilText: expect.any(String) },
    });
    expect(updateWorkspace).toHaveBeenLastCalledWith('workspace-1', {
      snoozedUntil: until,
      unread: undefined,
    });
    expect(publish).toHaveBeenCalledTimes(1);

    await expect(
      service.execute({ terminalId: 'terminal-1' }, { type: 'workspace.wake' })
    ).resolves.toEqual({ snooze: { workspaceId: 'workspace-1', woke: true } });
    expect(updateWorkspace).toHaveBeenLastCalledWith('workspace-1', {
      snoozedUntil: undefined,
      unread: { reason: 'snooze-ended', at: Date.now() },
    });
    expect(publish).toHaveBeenCalledTimes(2);

    // Waking a workspace that isn't snoozed changes nothing.
    await expect(
      service.execute({ terminalId: 'terminal-1' }, { type: 'workspace.wake' })
    ).resolves.toEqual({ snooze: { workspaceId: 'workspace-1', woke: false } });
    expect(updateWorkspace).toHaveBeenCalledTimes(2);
  });

  it('refuses to snooze when the user turned it off, but still wakes', async () => {
    const updateWorkspace = vi.fn((id: string, updates: Record<string, unknown>) => ({
      id,
      ...updates,
    }));
    const service = new KomlaOperationService(
      createDependencies({
        findWorkspaceByTerminalId: () => ({ id: 'workspace-1', snoozedUntil: Date.now() + 60_000 }),
        updateWorkspace,
        getConfig: () => ({ agentDisabledCapabilities: ['workspace.snooze'] }),
      })
    );

    await expect(
      service.execute({ terminalId: 'terminal-1' }, { type: 'workspace.snooze', until: '2h' })
    ).rejects.toMatchObject({ code: 'CAPABILITY_DISABLED', statusCode: 403 });
    expect(updateWorkspace).not.toHaveBeenCalled();
    await expect(
      service.execute({ terminalId: 'terminal-1' }, { type: 'workspace.wake' })
    ).resolves.toEqual({ snooze: { workspaceId: 'workspace-1', woke: true } });
  });

  it('snoozes until the next notification, or a time if that comes first', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 20, 15, 30));
    const updateWorkspace = vi.fn((id: string, updates: Record<string, unknown>) => ({
      id,
      ...updates,
    }));
    const service = new KomlaOperationService(
      createDependencies({
        findWorkspaceByTerminalId: () => ({ id: 'workspace-1' }),
        updateWorkspace,
      })
    );

    await expect(
      service.execute(
        { terminalId: 'terminal-1' },
        { type: 'workspace.snooze', untilNotified: true }
      )
    ).resolves.toEqual({ snooze: { workspaceId: 'workspace-1', untilNotified: true } });
    expect(updateWorkspace).toHaveBeenLastCalledWith('workspace-1', {
      snoozedUntil: undefined,
      wakesOnNotification: true,
      snoozeOutlastsTurnOf: undefined,
      unread: undefined,
    });

    await expect(
      service.execute(
        { terminalId: 'terminal-1' },
        { type: 'workspace.snooze', until: '2h', untilNotified: true }
      )
    ).resolves.toEqual({
      snooze: {
        workspaceId: 'workspace-1',
        until: new Date(2026, 9, 20, 17, 30).getTime(),
        untilText: expect.any(String),
        untilNotified: true,
      },
    });
    expect(updateWorkspace).toHaveBeenLastCalledWith('workspace-1', {
      snoozedUntil: new Date(2026, 9, 20, 17, 30).getTime(),
      wakesOnNotification: true,
      unread: undefined,
    });

    await expect(
      service.execute({ terminalId: 'terminal-1' }, { type: 'workspace.snooze' })
    ).rejects.toMatchObject({ code: 'INVALID_SNOOZE_TIME' });
  });

  it("lets an agent's snooze until notified outlast the turn it was set in", async () => {
    const updateWorkspace = vi.fn((id: string, updates: Record<string, unknown>) => ({
      id,
      ...updates,
    }));
    const service = new KomlaOperationService(
      createDependencies({
        findWorkspaceByTerminalId: () => ({
          id: 'workspace-1',
          terminals: [{ id: 'terminal-1', agentActive: true }],
        }),
        updateWorkspace,
      })
    );

    await service.execute(
      { terminalId: 'terminal-1' },
      { type: 'workspace.snooze', untilNotified: true }
    );

    expect(updateWorkspace).toHaveBeenLastCalledWith(
      'workspace-1',
      expect.objectContaining({ wakesOnNotification: true, snoozeOutlastsTurnOf: 'terminal-1' })
    );
  });

  it('wakes a workspace snoozed only until notified', async () => {
    const updateWorkspace = vi.fn((id: string, updates: Record<string, unknown>) => ({
      id,
      ...updates,
    }));
    const service = new KomlaOperationService(
      createDependencies({
        findWorkspaceByTerminalId: () => ({ id: 'workspace-1', wakesOnNotification: true }),
        updateWorkspace,
      })
    );

    await expect(
      service.execute({ terminalId: 'terminal-1' }, { type: 'workspace.wake' })
    ).resolves.toEqual({ snooze: { workspaceId: 'workspace-1', woke: true } });
    expect(updateWorkspace).toHaveBeenLastCalledWith(
      'workspace-1',
      expect.objectContaining({ wakesOnNotification: undefined })
    );
  });

  it('refuses to snooze a workspace whose agent is waiting for input', async () => {
    const updateWorkspace = vi.fn();
    const service = new KomlaOperationService(
      createDependencies({
        findWorkspaceByTerminalId: () => ({
          id: 'workspace-1',
          attention: { kind: 'input-required', source: 'codex', updatedAt: 1 },
        }),
        updateWorkspace,
      })
    );

    await expect(
      service.execute({ terminalId: 'terminal-1' }, { type: 'workspace.snooze', until: '2h' })
    ).rejects.toMatchObject({ code: 'WORKSPACE_NEEDS_ATTENTION', statusCode: 409 });
    expect(updateWorkspace).not.toHaveBeenCalled();
  });

  it('refuses a snooze it cannot read or that has already ended', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 20, 15, 30));
    const updateWorkspace = vi.fn();
    const service = new KomlaOperationService(
      createDependencies({
        findWorkspaceByTerminalId: () => ({ id: 'workspace-1' }),
        updateWorkspace,
      })
    );
    const snooze = (until: string) =>
      service.execute({ terminalId: 'terminal-1' }, { type: 'workspace.snooze', until });

    await expect(snooze('soon')).rejects.toMatchObject({
      code: 'INVALID_SNOOZE_TIME',
      statusCode: 400,
    });
    await expect(snooze('2026-10-19 09:00')).rejects.toMatchObject({
      code: 'INVALID_SNOOZE_TIME',
      message: expect.stringContaining('passed'),
    });
    for (const tooFar of ['999999999d', '366d', '2027-10-21 09:00']) {
      await expect(snooze(tooFar)).rejects.toMatchObject({
        code: 'INVALID_SNOOZE_TIME',
        message: expect.stringContaining('a year'),
      });
    }
    expect(updateWorkspace).not.toHaveBeenCalled();
  });

  describe('workspace.trash', () => {
    type TrashTerminal = {
      id: string;
      agentActive?: boolean;
      attention?: {
        kind: 'turn-complete' | 'input-required' | 'error';
        source: string;
        updatedAt: number;
      };
    };
    type TrashWorkspace = {
      id: string;
      status: 'active' | 'trashed';
      agentActive?: boolean;
      terminals: TrashTerminal[];
    };

    /** A service whose calling agent in terminal-1 is mid-turn until `endTurn` is called. */
    function trashSetup(terminals: TrashTerminal[] = [{ id: 'terminal-1', agentActive: true }]) {
      const workspace: TrashWorkspace = { id: 'workspace-1', status: 'active', terminals };
      const turnEnds = new Map<string, (end: 'done' | 'stopped') => void>();
      const stopWatching = vi.fn();
      const requestTrash = vi.fn();
      const watchAgentTurnEnd = vi.fn(
        (_workspaceId: string, terminalId: string, ended: (end: 'done' | 'stopped') => void) => {
          turnEnds.set(terminalId, ended);
          return stopWatching;
        }
      );
      const service = new KomlaOperationService(
        createDependencies({
          findWorkspaceByTerminalId: () => workspace,
          getWorkspace: () => workspace,
          isAgentTurnActive: (terminalId) =>
            workspace.terminals.some((t) => t.id === terminalId && t.agentActive),
          watchAgentTurnEnd,
          requestTrash,
        })
      );
      return {
        workspace,
        watchAgentTurnEnd,
        stopWatching,
        requestTrash,
        trash: (terminalId = 'terminal-1') =>
          service.execute({ terminalId }, { type: 'workspace.trash' }),
        endTurn: (end: 'done' | 'stopped' = 'done', terminalId = 'terminal-1') => {
          const terminal = workspace.terminals.find((t) => t.id === terminalId);
          if (terminal) terminal.agentActive = false;
          turnEnds.get(terminalId)!(end);
        },
      };
    }

    it('trashes the current workspace once the calling agent finishes its turn', async () => {
      const setup = trashSetup([{ id: 'terminal-1', agentActive: true }, { id: 'terminal-2' }]);

      await expect(setup.trash()).resolves.toEqual({
        trash: { workspaceId: 'workspace-1', afterTurn: true },
      });
      // Asking again while it waits doesn't trash twice.
      await setup.trash();
      expect(setup.watchAgentTurnEnd).toHaveBeenCalledExactlyOnceWith(
        'workspace-1',
        'terminal-1',
        expect.any(Function)
      );
      expect(setup.requestTrash).not.toHaveBeenCalled();

      setup.endTurn('done');
      expect(setup.requestTrash).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'workspace-1' });
    });

    it('keeps the workspace when the turn is interrupted', async () => {
      const setup = trashSetup();

      await setup.trash();
      setup.endTurn('stopped');

      expect(setup.requestTrash).toHaveBeenCalledExactlyOnceWith({
        workspaceId: 'workspace-1',
        refusal: 'Its turn was interrupted before it finished.',
      });
    });

    it('keeps the workspace when the turn ends in a failure or a question', async () => {
      for (const kind of ['error', 'input-required'] as const) {
        const setup = trashSetup();
        await setup.trash();
        setup.workspace.terminals[0].attention = { kind, source: 'claude-code', updatedAt: 1 };
        setup.endTurn('stopped');

        expect(setup.requestTrash).toHaveBeenCalledExactlyOnceWith({
          workspaceId: 'workspace-1',
          refusal: 'Its turn ended with an error or a question for you.',
        });
      }
    });

    it('gives up on a turn that runs longer than the limit', async () => {
      vi.useFakeTimers();
      const setup = trashSetup();

      await setup.trash();
      vi.advanceTimersByTime(TRASH_TURN_LIMIT_MS);

      expect(setup.stopWatching).toHaveBeenCalledOnce();
      expect(setup.requestTrash).toHaveBeenCalledExactlyOnceWith({
        workspaceId: 'workspace-1',
        refusal: 'Its turn ran longer than 30 minutes.',
      });
      // A pending trash no longer folds in the next request.
      await setup.trash();
      expect(setup.watchAgentTurnEnd).toHaveBeenCalledTimes(2);
    });

    it('trashes once the last of several agents that asked finishes', async () => {
      const setup = trashSetup([
        { id: 'terminal-1', agentActive: true },
        { id: 'terminal-2', agentActive: true },
      ]);
      // Each agent asks while the other works; neither refuses, as both asked.
      setup.workspace.terminals[1].agentActive = false;
      await setup.trash('terminal-1');
      setup.workspace.terminals[1].agentActive = true;
      setup.workspace.terminals[0].agentActive = false;
      await setup.trash('terminal-2');
      setup.workspace.terminals[0].agentActive = true;

      setup.endTurn('done', 'terminal-1');
      expect(setup.requestTrash).not.toHaveBeenCalled();
      setup.endTurn('done', 'terminal-2');
      expect(setup.requestTrash).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'workspace-1' });
    });

    it('trashes a little later when no agent turn runs in the calling terminal', async () => {
      vi.useFakeTimers();
      const setup = trashSetup([{ id: 'terminal-1' }]);

      await expect(setup.trash()).resolves.toEqual({
        trash: { workspaceId: 'workspace-1', afterTurn: false },
      });
      // The command's reply reaches it before its terminal stops.
      expect(setup.requestTrash).not.toHaveBeenCalled();
      vi.advanceTimersByTime(TRASH_WITHOUT_TURN_DELAY_MS);
      expect(setup.watchAgentTurnEnd).not.toHaveBeenCalled();
      expect(setup.requestTrash).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'workspace-1' });
    });

    it('refuses to trash while another tab works or waits for input', async () => {
      const busy = trashSetup([
        { id: 'terminal-1', agentActive: true },
        { id: 'terminal-2', agentActive: true },
      ]);
      await expect(busy.trash()).rejects.toMatchObject({
        code: 'WORKSPACE_BUSY',
        statusCode: 409,
        message: expect.stringContaining('still working'),
      });

      const waiting = trashSetup([
        { id: 'terminal-1', agentActive: true },
        {
          id: 'terminal-2',
          attention: { kind: 'input-required', source: 'codex', updatedAt: 1 },
        },
      ]);
      await expect(waiting.trash()).rejects.toMatchObject({
        code: 'WORKSPACE_BUSY',
        message: expect.stringContaining('input'),
      });
      expect(busy.watchAgentTurnEnd).not.toHaveBeenCalled();
      expect(waiting.watchAgentTurnEnd).not.toHaveBeenCalled();
    });

    it('keeps the workspace when work no tab owns runs as the turn ends', async () => {
      const setup = trashSetup();

      await setup.trash();
      setup.workspace.agentActive = true;
      setup.endTurn('done');

      expect(setup.requestTrash).toHaveBeenCalledExactlyOnceWith({
        workspaceId: 'workspace-1',
        refusal: expect.stringContaining('still working'),
      });
    });

    it('says why it keeps a workspace whose other tab started working during the turn', async () => {
      const setup = trashSetup([{ id: 'terminal-1', agentActive: true }, { id: 'terminal-2' }]);

      await setup.trash();
      setup.workspace.terminals[1].agentActive = true;
      setup.endTurn('done');

      expect(setup.requestTrash).toHaveBeenCalledExactlyOnceWith({
        workspaceId: 'workspace-1',
        refusal: expect.stringContaining('still working'),
      });
    });

    it('drops the request when the user trashed the workspace during the turn', async () => {
      const setup = trashSetup();

      await setup.trash();
      setup.workspace.status = 'trashed';
      setup.endTurn('done');
      expect(setup.requestTrash).not.toHaveBeenCalled();

      await expect(setup.trash()).rejects.toMatchObject({
        code: 'WORKSPACE_NOT_ACTIVE',
        statusCode: 409,
      });
    });

    it('refuses when the user turned the capability off', async () => {
      const setup = trashSetup();
      const service = new KomlaOperationService(
        createDependencies({
          getConfig: () => ({ agentDisabledCapabilities: ['workspace.trash'] }),
          findWorkspaceByTerminalId: () => setup.workspace,
        })
      );

      await expect(
        service.execute({ terminalId: 'terminal-1' }, { type: 'workspace.trash' })
      ).rejects.toMatchObject({ code: 'CAPABILITY_DISABLED', statusCode: 403 });
    });
  });

  describe('folder.open', () => {
    const open = (service: KomlaOperationService, context = {}, path = '/notes') =>
      service.execute(context, { type: 'folder.open', path });

    it("opens the folder in the calling workspace's window", async () => {
      const requestOpenFolder = vi.fn(() => true);
      const service = new KomlaOperationService(
        createDependencies({
          requestOpenFolder,
          findWorkspaceByTerminalId: () => ({ id: 'workspace-1', windowId: 'window-2' }),
        })
      );

      await expect(open(service, { terminalId: 'terminal-1' })).resolves.toEqual({
        folder: { path: resolve('/notes') },
      });
      expect(requestOpenFolder).toHaveBeenCalledExactlyOnceWith(resolve('/notes'), 'window-2');
    });

    it('opens it in any window from outside a workspace', async () => {
      const requestOpenFolder = vi.fn(() => true);
      const service = new KomlaOperationService(createDependencies({ requestOpenFolder }));

      await open(service);
      expect(requestOpenFolder).toHaveBeenCalledExactlyOnceWith(resolve('/notes'), undefined);
    });

    it.each([
      ['a folder on an SSH host', { sshHostId: 'ssh-1' }, '/notes', 'UNSUPPORTED_LOCATION', 400],
      ['a relative path', {}, 'notes', 'INVALID_PATH', 400],
    ])('refuses %s', async (_name, context, path, code, statusCode) => {
      const requestOpenFolder = vi.fn(() => true);
      const service = new KomlaOperationService(createDependencies({ requestOpenFolder }));

      await expect(open(service, context, path)).rejects.toMatchObject({ code, statusCode });
      expect(requestOpenFolder).not.toHaveBeenCalled();
    });

    it('says when the path is not a folder', async () => {
      const service = new KomlaOperationService(
        createDependencies({ requestOpenFolder: () => false })
      );

      await expect(open(service)).rejects.toMatchObject({
        code: 'FOLDER_NOT_FOUND',
        statusCode: 404,
      });
    });

    it('refuses when the user turned the capability off', async () => {
      const requestOpenFolder = vi.fn(() => true);
      const service = new KomlaOperationService(
        createDependencies({
          requestOpenFolder,
          getConfig: () => ({ agentDisabledCapabilities: ['folder.open'] }),
        })
      );

      await expect(open(service)).rejects.toMatchObject({ code: 'CAPABILITY_DISABLED' });
      expect(requestOpenFolder).not.toHaveBeenCalled();
    });
  });

  it('sets and clears a status item for the calling workspace', async () => {
    const setStatusItem = vi.fn(() => true);
    const clearStatusItems = vi.fn(() => 1);
    const service = new KomlaOperationService(
      createDependencies({
        findWorkspaceByTerminalId: () => ({ id: 'workspace-1' }),
        setStatusItem,
        clearStatusItems,
      })
    );

    await expect(
      service.execute(
        { terminalId: 'terminal-1' },
        {
          type: 'status.set',
          id: 'tests',
          text: '142/150 passing',
          tone: 'warning',
          color: 'warning',
          link: 'https://github.com/org/repo/pull/1',
          popover: '- 8 failing in auth',
        }
      )
    ).resolves.toEqual({
      status: {
        workspaceId: 'workspace-1',
        id: 'tests',
        text: '142/150 passing',
        tone: 'warning',
        color: 'warning',
        link: 'https://github.com/org/repo/pull/1',
        popover: '- 8 failing in auth',
      },
    });
    expect(setStatusItem).toHaveBeenCalledWith('workspace-1', 'tests', {
      text: '142/150 passing',
      tone: 'warning',
      color: 'warning',
      link: 'https://github.com/org/repo/pull/1',
      popover: '- 8 failing in auth',
    });

    await expect(
      service.execute({ terminalId: 'terminal-1' }, { type: 'status.clear', id: 'tests' })
    ).resolves.toEqual({ status: { workspaceId: 'workspace-1', id: 'tests', cleared: 1 } });
    expect(clearStatusItems).toHaveBeenCalledWith('workspace-1', 'tests');
  });

  it('refreshes a status-items.json item for the calling workspace, saying how it went', async () => {
    const refreshStatusCommand = vi.fn(async (_workspaceId: string, id: string) =>
      id === 'ci'
        ? { content: { text: 'CI passing' } }
        : id === 'pr'
          ? { content: null, error: 'gh: not logged in' }
          : id === 'remote'
            ? ('unavailable' as const)
            : undefined
    );
    const service = new KomlaOperationService(
      createDependencies({
        findWorkspaceByTerminalId: () => ({ id: 'workspace-1' }),
        refreshStatusCommand,
      })
    );
    const refresh = (id: string) =>
      service.execute({ terminalId: 'terminal-1' }, { type: 'status.refresh', id });

    await expect(refresh('ci')).resolves.toEqual({
      status: { workspaceId: 'workspace-1', id: 'ci', refreshed: true, text: 'CI passing' },
    });
    expect(refreshStatusCommand).toHaveBeenCalledWith('workspace-1', 'ci');
    await expect(refresh('pr')).resolves.toEqual({
      status: { workspaceId: 'workspace-1', id: 'pr', refreshed: true, error: 'gh: not logged in' },
    });
    await expect(refresh('tests')).rejects.toMatchObject({
      code: 'STATUS_ITEM_NOT_FOUND',
      statusCode: 404,
    });
    await expect(refresh('remote')).rejects.toMatchObject({
      code: 'WORKSPACE_UNAVAILABLE',
      message: expect.stringContaining("can't run commands right now"),
    });
  });

  it('refreshes status-items.json items while agents may not set status items', async () => {
    const refreshStatusCommand = vi.fn(async () => ({ content: { text: 'CI passing' } }));
    const service = new KomlaOperationService(
      createDependencies({
        getConfig: () => ({ agentDisabledCapabilities: ['status.set'] }),
        findWorkspaceByTerminalId: () => ({ id: 'workspace-1' }),
        refreshStatusCommand,
      })
    );

    await expect(
      service.execute({ terminalId: 'terminal-1' }, { type: 'status.refresh', id: 'ci' })
    ).resolves.toMatchObject({ status: { refreshed: true } });
  });

  it('colors parts of a status item by the terminal colors in its text or by segments', async () => {
    const setStatusItem = vi.fn(() => true);
    const service = new KomlaOperationService(
      createDependencies({
        findWorkspaceByTerminalId: () => ({ id: 'workspace-1' }),
        setStatusItem,
      })
    );

    await service.execute(
      { terminalId: 'terminal-1' },
      { type: 'status.set', id: 'ci', text: '\u001b[32m\uf00c\u001b[0m CI' }
    );
    expect(setStatusItem).toHaveBeenLastCalledWith('workspace-1', 'ci', {
      text: '\uf00c CI',
      segments: [{ text: '\uf00c', color: 'success' }, { text: ' CI' }],
    });

    await service.execute(
      { terminalId: 'terminal-1' },
      {
        type: 'status.set',
        id: 'ci',
        segments: [{ text: '\uf071 2', color: 'warning', bold: true }, { text: ' lint' }],
      }
    );
    expect(setStatusItem).toHaveBeenLastCalledWith('workspace-1', 'ci', {
      text: '\uf071 2 lint',
      segments: [{ text: '\uf071 2', color: 'warning', bold: true }, { text: ' lint' }],
    });

    await expect(
      service.execute({ terminalId: 'terminal-1' }, { type: 'status.set', id: 'ci' })
    ).rejects.toMatchObject({ code: 'INVALID_STATUS_TEXT', statusCode: 400 });
  });

  it('shows icons before the text or where segments put them', async () => {
    const setStatusItem = vi.fn(() => true);
    const service = new KomlaOperationService(
      createDependencies({
        findWorkspaceByTerminalId: () => ({ id: 'workspace-1' }),
        setStatusItem,
      })
    );
    const svg = '<svg viewBox="0 0 1 1"/>';
    const svgUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;

    await service.execute(
      { terminalId: 'terminal-1' },
      { type: 'status.set', id: 'deploy', text: 'live', icon: svg, iconColor: 'foreground' }
    );
    expect(setStatusItem).toHaveBeenLastCalledWith('workspace-1', 'deploy', {
      text: 'live',
      segments: [{ icon: svgUrl, color: 'foreground' }, { text: ' ' }, { text: 'live' }],
    });

    await service.execute(
      { terminalId: 'terminal-1' },
      {
        type: 'status.set',
        id: 'deploy',
        segments: [{ text: 'live ' }, { icon: svg, color: 'success' }],
      }
    );
    expect(setStatusItem).toHaveBeenLastCalledWith('workspace-1', 'deploy', {
      text: 'live',
      segments: [{ text: 'live ' }, { icon: svgUrl, color: 'success' }],
    });

    await expect(
      service.execute(
        { terminalId: 'terminal-1' },
        { type: 'status.set', id: 'deploy', text: 'live', icon: 'https://example.com/a.svg' }
      )
    ).rejects.toMatchObject({ code: 'INVALID_STATUS_ICON', statusCode: 400 });

    await expect(
      service.execute(
        { terminalId: 'terminal-1' },
        {
          type: 'status.set',
          id: 'deploy',
          icon: svg,
          segments: [...Array<{ icon: string }>(4).fill({ icon: svg }), { text: 'live' }],
        }
      )
    ).rejects.toMatchObject({ code: 'INVALID_STATUS_ICON', statusCode: 400 });
  });

  it('rejects a status item link that is not a web page', async () => {
    const setStatusItem = vi.fn(() => true);
    const service = new KomlaOperationService(
      createDependencies({
        findWorkspaceByTerminalId: () => ({ id: 'workspace-1' }),
        setStatusItem,
      })
    );

    await expect(
      service.execute(
        { terminalId: 'terminal-1' },
        { type: 'status.set', id: 'pr', text: 'PR', link: 'file:///etc/passwd' }
      )
    ).rejects.toMatchObject({ code: 'INVALID_STATUS_LINK' });
    expect(setStatusItem).not.toHaveBeenCalled();
  });

  it('says how to make room when a workspace has too many status items', async () => {
    const service = new KomlaOperationService(
      createDependencies({
        findWorkspaceByTerminalId: () => ({ id: 'workspace-1' }),
        setStatusItem: () => false,
      })
    );

    await expect(
      service.execute({ terminalId: 'terminal-1' }, { type: 'status.set', id: 'x', text: 'x' })
    ).rejects.toMatchObject({ code: 'STATUS_ITEM_LIMIT', statusCode: 409 });
  });

  it('refuses status items when the capability is turned off', async () => {
    const service = new KomlaOperationService(
      createDependencies({
        getConfig: () => ({ agentDisabledCapabilities: ['status.set'] }),
        findWorkspaceByTerminalId: () => ({ id: 'workspace-1' }),
      })
    );

    await expect(
      service.execute({ terminalId: 'terminal-1' }, { type: 'status.clear' })
    ).rejects.toMatchObject({ code: 'CAPABILITY_DISABLED' });
  });

  it('rejects preview URLs that are not web pages', async () => {
    const publish = vi.fn();
    const service = new KomlaOperationService(
      createDependencies({
        findWorkspaceByTerminalId: () => ({ id: 'workspace-1' }),
        publish,
      })
    );

    await expect(
      service.execute(
        { terminalId: 'terminal-1' },
        { type: 'preview.open', url: 'file:///etc/passwd' }
      )
    ).rejects.toMatchObject({ code: 'INVALID_PREVIEW_URL', statusCode: 400 });
    expect(publish).not.toHaveBeenCalled();
  });

  it("sends the page to the workspace's window, without saving it to the workspace", async () => {
    const updateWorkspace = vi.fn();
    const publish = vi.fn();
    const service = new KomlaOperationService(
      createDependencies({
        findWorkspaceByTerminalId: () => ({ id: 'workspace-1' }),
        updateWorkspace,
        publish,
      })
    );

    await expect(
      service.execute(
        { terminalId: 'terminal-1' },
        { type: 'preview.open', url: 'http://127.0.0.1:3000' }
      )
    ).resolves.toEqual({
      preview: { workspaceId: 'workspace-1', url: 'http://127.0.0.1:3000', opened: true },
    });
    expect(publish).toHaveBeenLastCalledWith('workspace:open-dev-preview', {
      workspaceId: 'workspace-1',
      url: 'http://127.0.0.1:3000',
      urlExecutionLocation: 'workspace',
    });

    await service.execute({ terminalId: 'terminal-1' }, { type: 'preview.open' });

    expect(publish).toHaveBeenLastCalledWith('workspace:open-dev-preview', {
      workspaceId: 'workspace-1',
    });
    expect(updateWorkspace).not.toHaveBeenCalled();
  });

  describe('desktop.open', () => {
    const sshWorkspace = { id: 'workspace-1', backend: { kind: 'ssh' as const, hostId: 'host-1' } };
    const viewerUrl = 'http://127.0.0.1:6081/vnc.html?autoconnect=1&password=pa55word';
    /** Dependencies whose workspace updates succeed, as saving a desktop needs. */
    const desktopDependencies = (overrides: Partial<KomlaOperationDependencies> = {}) =>
      createDependencies({ updateWorkspace: vi.fn((id: string) => ({ id })), ...overrides });

    it('lists the desktop without opening it, and has the window say it started', async () => {
      const updated = { id: 'workspace-1' };
      const updateWorkspace = vi.fn().mockReturnValue(updated);
      const publish = vi.fn();
      const openInVncApp = vi.fn();
      const service = new KomlaOperationService(
        desktopDependencies({
          findWorkspaceByTerminalId: () => ({
            ...sshWorkspace,
            virtualDesktops: [
              { vncPort: 5903, app: 'gedit', shownAt: 1 },
              { vncPort: 5901, shownAt: 2 },
            ],
          }),
          getVncAppName: () => 'Screen Sharing',
          openInVncApp,
          updateWorkspace,
          publish,
        })
      );

      await expect(
        service.execute(
          { terminalId: 'terminal-1' },
          {
            type: 'desktop.open',
            vncPort: 5901,
            url: viewerUrl,
            vncPassword: 'pa55word',
            vncPorts: [5901, 5903],
            app: 'xterm',
          }
        )
      ).resolves.toEqual({ desktop: { workspaceId: 'workspace-1', vncApp: 'Screen Sharing' } });

      const desktop = {
        vncPort: 5901,
        shownAt: expect.any(Number),
        vncPassword: 'pa55word',
        url: viewerUrl,
        app: 'xterm',
        vncApp: 'Screen Sharing',
      };
      expect(updateWorkspace).toHaveBeenCalledWith('workspace-1', {
        virtualDesktops: [desktop, { vncPort: 5903, app: 'gedit', shownAt: 1 }],
      });
      expect(publish).toHaveBeenCalledWith('workspace:updated', updated);
      expect(publish).toHaveBeenCalledWith('virtual-desktop:started', {
        workspaceId: 'workspace-1',
        desktop,
      });
      expect(publish).not.toHaveBeenCalledWith('workspace:open-dev-preview', expect.anything());
      expect(openInVncApp).not.toHaveBeenCalled();
    });

    it('lists a desktop it can show only in the VNC app, as on a host without noVNC', async () => {
      const publish = vi.fn();
      const service = new KomlaOperationService(
        desktopDependencies({
          findWorkspaceByTerminalId: () => sshWorkspace,
          getVncAppName: () => 'Screen Sharing',
          publish,
        })
      );

      await expect(
        service.execute({ terminalId: 'terminal-1' }, { type: 'desktop.open', vncPort: 5901 })
      ).resolves.toEqual({ desktop: { workspaceId: 'workspace-1', vncApp: 'Screen Sharing' } });
      expect(publish).toHaveBeenCalledWith('virtual-desktop:started', expect.anything());
    });

    it('opens the desktop in the VNC app right away for --app', async () => {
      const openInVncApp = vi.fn().mockResolvedValue(undefined);
      const publish = vi.fn();
      const updateWorkspace = vi.fn((id: string) => ({ id }));
      const service = new KomlaOperationService(
        desktopDependencies({
          findWorkspaceByTerminalId: () => sshWorkspace,
          getVncAppName: () => 'Screen Sharing',
          openInVncApp,
          publish,
          updateWorkspace,
        })
      );

      await expect(
        service.execute(
          { terminalId: 'terminal-1' },
          {
            type: 'desktop.open',
            vncPort: 5901,
            url: viewerUrl,
            vncPassword: 'pa55word',
            vncPorts: [5901, 5903],
            viewer: 'vnc-app',
          }
        )
      ).resolves.toEqual({
        desktop: { workspaceId: 'workspace-1', viewer: 'vnc-app', vncApp: 'Screen Sharing' },
      });
      expect(openInVncApp).toHaveBeenCalledWith(sshWorkspace, 5901, 'pa55word', [5901, 5903]);
      expect(updateWorkspace).toHaveBeenCalledWith('workspace-1', {
        virtualDesktops: [expect.objectContaining({ vncPort: 5901, vncApp: 'Screen Sharing' })],
      });
      expect(publish).not.toHaveBeenCalledWith('virtual-desktop:started', expect.anything());
    });

    it("opens the desktop in Komla's browser right away for --browser", async () => {
      const publish = vi.fn();
      const openInVncApp = vi.fn();
      const service = new KomlaOperationService(
        desktopDependencies({
          findWorkspaceByTerminalId: () => sshWorkspace,
          getVncAppName: () => 'Screen Sharing',
          openInVncApp,
          publish,
        })
      );

      await expect(
        service.execute(
          { terminalId: 'terminal-1' },
          { type: 'desktop.open', vncPort: 5901, url: viewerUrl, viewer: 'preview' }
        )
      ).resolves.toEqual({
        desktop: { workspaceId: 'workspace-1', viewer: 'preview', vncApp: 'Screen Sharing' },
      });
      expect(publish).toHaveBeenCalledWith('workspace:open-dev-preview', {
        workspaceId: 'workspace-1',
        url: viewerUrl,
        urlExecutionLocation: 'workspace',
      });
      expect(publish).not.toHaveBeenCalledWith('virtual-desktop:started', expect.anything());
      expect(openInVncApp).not.toHaveBeenCalled();
    });

    it("opens the desktop in Komla's browser for --app where this computer has no VNC app", async () => {
      const publish = vi.fn();
      const service = new KomlaOperationService(
        desktopDependencies({ findWorkspaceByTerminalId: () => sshWorkspace, publish })
      );

      await expect(
        service.execute(
          { terminalId: 'terminal-1' },
          { type: 'desktop.open', vncPort: 5901, url: viewerUrl, viewer: 'vnc-app' }
        )
      ).resolves.toEqual({ desktop: { workspaceId: 'workspace-1', viewer: 'preview' } });
      expect(publish).toHaveBeenCalledWith(
        'workspace:open-dev-preview',
        expect.objectContaining({ url: viewerUrl })
      );
    });

    it.each([
      ['for --app', 'vnc-app' as const, 'no app that opens vnc:// links'],
      ['without a flag', undefined, 'Install novnc and websockify'],
    ])(
      'explains what is missing when neither viewer can show the desktop, %s',
      async (_case, viewer, message) => {
        const updateWorkspace = vi.fn((id: string) => ({ id }));
        const service = new KomlaOperationService(
          desktopDependencies({ findWorkspaceByTerminalId: () => sshWorkspace, updateWorkspace })
        );

        await expect(
          service.execute(
            { terminalId: 'terminal-1' },
            { type: 'desktop.open', vncPort: 5901, ...(viewer ? { viewer } : {}) }
          )
        ).rejects.toMatchObject({
          code: 'DESKTOP_VIEWER_UNAVAILABLE',
          message: expect.stringContaining(message),
        });
        expect(updateWorkspace).not.toHaveBeenCalled();
      }
    );

    it('explains what to install for --browser on a host without noVNC', async () => {
      const service = new KomlaOperationService(
        desktopDependencies({
          findWorkspaceByTerminalId: () => sshWorkspace,
          getVncAppName: () => 'Screen Sharing',
        })
      );

      await expect(
        service.execute(
          { terminalId: 'terminal-1' },
          { type: 'desktop.open', vncPort: 5901, viewer: 'preview' }
        )
      ).rejects.toMatchObject({
        code: 'DESKTOP_VIEWER_UNAVAILABLE',
        message: expect.stringContaining('or use --app to show it in Screen Sharing'),
      });
    });

    it('keeps the desktop listed when the VNC app fails to open', async () => {
      const updateWorkspace = vi.fn((id: string) => ({ id }));
      const service = new KomlaOperationService(
        desktopDependencies({
          findWorkspaceByTerminalId: () => sshWorkspace,
          getVncAppName: () => 'Screen Sharing',
          openInVncApp: vi.fn().mockRejectedValue(new Error('no route')),
          updateWorkspace,
        })
      );

      await expect(
        service.execute(
          { terminalId: 'terminal-1' },
          { type: 'desktop.open', vncPort: 5901, viewer: 'vnc-app' }
        )
      ).rejects.toMatchObject({ code: 'DESKTOP_VIEWER_FAILED' });
      expect(updateWorkspace).toHaveBeenCalledWith('workspace-1', {
        virtualDesktops: [expect.objectContaining({ vncPort: 5901 })],
      });
    });

    it('forgets the desktops that stopped on that host, in every workspace there', async () => {
      const updateWorkspace = vi.fn((id: string) => ({ id }));
      const service = new KomlaOperationService(
        desktopDependencies({
          findWorkspaceByTerminalId: () => sshWorkspace,
          listWorkspaces: () => [
            sshWorkspace,
            // Its display now serves the new desktop.
            {
              id: 'same-host',
              backend: { kind: 'ssh', hostId: 'host-1' },
              virtualDesktops: [
                { vncPort: 5902, shownAt: 1 },
                { vncPort: 5903, shownAt: 1 },
                { vncPort: 5904, shownAt: 1 },
              ],
            },
            {
              id: 'other-host',
              backend: { kind: 'ssh', hostId: 'host-2' },
              virtualDesktops: [{ vncPort: 5902, shownAt: 1 }],
            },
            {
              id: 'local',
              backend: { kind: 'local' },
              virtualDesktops: [{ vncPort: 5902, shownAt: 1 }],
            },
          ],
          updateWorkspace,
        })
      );

      await service.execute(
        { terminalId: 'terminal-1' },
        { type: 'desktop.open', vncPort: 5902, url: viewerUrl, vncPorts: [5902, 5903] }
      );

      expect(updateWorkspace).toHaveBeenCalledWith('same-host', {
        virtualDesktops: [{ vncPort: 5903, shownAt: 1 }],
      });
      expect(updateWorkspace).toHaveBeenCalledWith('workspace-1', {
        virtualDesktops: [{ vncPort: 5902, shownAt: expect.any(Number), url: viewerUrl }],
      });
      expect(updateWorkspace).toHaveBeenCalledTimes(2);
    });
  });

  it('rejects disabled agent capabilities independently of MCP transport', async () => {
    const service = new KomlaOperationService(
      createDependencies({
        getConfig: () => ({ agentDisabledCapabilities: ['agent.launch.tab'] }),
        findWorkspaceByTerminalId: () => ({ id: 'workspace-1' }),
      })
    );

    await expect(
      service.execute({ terminalId: 'terminal-1' }, { type: 'agent.launch', destination: 'tab' })
    ).rejects.toMatchObject({ code: 'CAPABILITY_DISABLED', statusCode: 403 });
  });

  it('rejects workspace-only options for tab launches', async () => {
    const service = new KomlaOperationService(createDependencies());

    await expect(
      service.execute(
        { workspaceId: 'workspace-1' },
        { type: 'agent.launch', destination: 'tab', branch: 'not-valid-for-a-tab' }
      )
    ).rejects.toMatchObject({ code: 'INVALID_AGENT_DESTINATION_OPTIONS', statusCode: 400 });
    await expect(
      service.execute(
        { workspaceId: 'workspace-1' },
        { type: 'agent.launch', destination: 'tab', fromCurrentBranch: true }
      )
    ).rejects.toMatchObject({ code: 'INVALID_AGENT_DESTINATION_OPTIONS', statusCode: 400 });
  });

  it('includes inactive non-launchable presets only when requested', async () => {
    const service = new KomlaOperationService(
      createDependencies({
        listPresets: () => [
          {
            id: 'shell',
            name: 'Shell Only',
            openCommand: '',
            continueCommand: '',
            promptCommand: '',
            launchModes: [],
            isBuiltin: true,
          },
        ],
      })
    );

    await expect(service.execute({}, { type: 'agent.presets' })).resolves.toEqual({ presets: [] });
    await expect(
      service.execute({}, { type: 'agent.presets', includeInactive: true })
    ).resolves.toEqual({
      presets: [
        {
          id: 'shell',
          name: 'Shell Only',
          active: false,
          launchable: false,
          unavailableReason: 'This preset does not define an agent command.',
          environment: { kind: 'local' },
          modes: [],
        },
      ],
    });
  });
});
