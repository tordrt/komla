import { describe, expect, it, vi } from 'vitest';

import {
  SettingsManagementError,
  SettingsManagementService,
  type SettingsFileAdapter,
} from '../../../src/main/services/settings-management.service';
import { themeChoice, themeMode } from '../../../src/shared/lib/appearance';

import type { DesiredWorkspaceEnvironment } from '../../../src/shared/lib/agent-environment';
import type { Automation, AutomationTarget } from '../../../src/shared/types/automation';
import type {
  Action,
  ActivePresetEntry,
  AgentPreset,
  AppearanceSettings,
  Project,
  ThemeConfig,
  Workspace,
} from '../../../src/shared/types';

type SettingsDeps = ConstructorParameters<typeof SettingsManagementService>[0];

function fixture() {
  let revision = 'actions-1';
  let actionsStorageCurrent = true;
  let actionsStorageReadable = true;
  let projectsStorageCurrent = true;
  let actions: Action[] = [
    { id: 'global', title: 'Global', content: 'review' },
    { id: 'local', title: 'Local', content: 'npm test', projectIds: ['project-1'] },
    { id: 'shared', title: 'Shared', content: 'lint', projectIds: ['project-1', 'project-2'] },
    { id: 'other', title: 'Other', content: 'build', projectIds: ['project-2'] },
  ];
  const projects: Project[] = [
    {
      id: 'project-1',
      name: 'Komla',
      repositoryPath: '/repo',
      defaultBranchPrefix: '',
      createdAt: 1,
      order: 0,
      managed: false,
      setupSteps: [],
    },
    {
      id: 'project-2',
      name: 'Other',
      repositoryPath: '/other',
      defaultBranchPrefix: '',
      createdAt: 2,
      order: 1,
      managed: false,
    },
  ];
  const workspace = {
    id: 'workspace-1',
    projectId: 'project-1',
    windowId: 'window-1',
    terminals: [{ id: 'terminal-1' }],
  } as Workspace;
  const environmentConfiguration = {
    lastWorkspaceEnvironment: undefined as DesiredWorkspaceEnvironment | undefined,
    defaultSshWorkspaceMode: 'remote' as const,
    sshHosts: [] as Array<{ id: string }>,
  };
  let theme: ThemeConfig = {
    mode: 'dark',
    palette: 'default',
    followSystem: false,
    lightPalette: 'frost',
    colors: { accent: 'oklch(0.65 0.15 250)', lightAccent: 'oklch(0.205 0 0)' },
    typography: { fontFamily: 'Inter', fontSize: 14, borderRadius: 6 },
  };
  let systemIsDark = true;
  const setAppearance = vi.fn((settings: AppearanceSettings) => {
    const { customPalette: _previous, ...rest } = theme;
    const mode = themeMode(settings.palette, settings.customPalette);
    theme = {
      ...rest,
      ...themeChoice(rest, settings.palette, mode, settings.accent),
      ...(settings.customPalette && { customPalette: settings.customPalette }),
      typography: { ...rest.typography, borderRadius: settings.borderRadius },
    };
  });
  const approve = vi.fn().mockResolvedValue(true);
  const feedback = vi.fn();
  let hooksRevision = 1;
  let hooks: Record<string, unknown> = { _version: 1, hooks: [] };
  const hooksFile = {
    name: 'Hooks',
    read: () => hooks,
    revision: () => String(hooksRevision),
    prepare: vi.fn<SettingsFileAdapter['prepare']>((desired) =>
      Array.isArray(desired.hooks)
        ? {
            next: desired,
            changes: desired.hooks.map((hook: { id: string; command: string }) => ({
              operation: 'add' as const,
              kind: 'hook' as const,
              title: hook.id,
              contentLabel: 'Command' as const,
              content: hook.command,
              details: [],
            })),
            warning: 'Komla runs these commands without asking again.',
          }
        : { problems: ['hooks: expected an array'] }
    ),
    write: vi.fn((next: unknown) => {
      hooks = next as Record<string, unknown>;
      hooksRevision += 1;
    }),
  } satisfies SettingsFileAdapter;
  let automations: Automation[] = [
    {
      id: 'nightly',
      name: 'Nightly deps',
      prompt: 'Update dependencies',
      projectId: 'project-1',
      target: { kind: 'local' },
      presetId: 'preset-1',
      schedule: { cron: '0 2 * * *', timeZone: 'Europe/Oslo' },
      enabled: true,
      missedRunGraceMinutes: 720,
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: 'triage',
      name: 'Triage',
      prompt: 'Triage new issues',
      projectId: 'project-1',
      target: { kind: 'ssh', hostId: 'ssh-1' },
      agentName: 'Claude Code',
      schedule: { cron: '30 8 * * 1-5', timeZone: 'UTC' },
      enabled: true,
      missedRunGraceMinutes: 180,
      createdAt: 2,
      updatedAt: 2,
    },
    {
      id: 'elsewhere',
      name: 'Other project',
      prompt: 'Build',
      projectId: 'project-2',
      target: { kind: 'local' },
      schedule: { cron: '0 9 * * *', timeZone: 'UTC' },
      enabled: true,
      missedRunGraceMinutes: 720,
      createdAt: 3,
      updatedAt: 3,
    },
  ];
  const onTarget = (target: AutomationTarget) =>
    automations.filter((automation) =>
      target.kind === 'local'
        ? automation.target.kind === 'local'
        : automation.target.kind === 'ssh' && automation.target.hostId === target.hostId
    );
  const automationSnapshots = async () => [
    {
      target: { kind: 'local' as const },
      automations: onTarget({ kind: 'local' }),
      runs: {},
      scheduler: { available: true },
    },
    {
      target: { kind: 'ssh' as const, hostId: 'ssh-1' },
      automations: onTarget({ kind: 'ssh', hostId: 'ssh-1' }),
      runs: {},
      scheduler: { available: false, message: 'cron isn’t installed on this host.' },
    },
  ];
  const automationDeps = {
    list: vi.fn(automationSnapshots),
    listCurrent: vi.fn(automationSnapshots),
    save: vi.fn(async (params: Parameters<SettingsDeps['automations']['save']>[0]) => {
      const saved: Automation = {
        ...params,
        id: params.id ?? 'automation-new',
        createdAt: 10,
        updatedAt: 10,
      };
      automations = [...automations.filter((candidate) => candidate.id !== saved.id), saved];
    }),
    setEnabled: vi.fn(async (_target: AutomationTarget, id: string, enabled: boolean) => {
      automations = automations.map((candidate) =>
        candidate.id === id ? { ...candidate, enabled } : candidate
      );
    }),
    delete: vi.fn(async (_target: AutomationTarget, id: string) => {
      automations = automations.filter((candidate) => candidate.id !== id);
    }),
    hostProblem: vi.fn(async (_project: Project): Promise<string | undefined> => undefined),
    agentProblem: vi.fn(
      (_target: AutomationTarget, _presetId?: string, _launchModeId?: string): string | undefined =>
        undefined
    ),
    hostName: (hostId: string) => (hostId === 'ssh-1' ? 'devbox' : undefined),
    timeZone: () => 'America/New_York',
  };
  const presets: AgentPreset[] = [
    {
      id: 'preset-1',
      name: 'Codex',
      openCommand: 'codex',
      continueCommand: 'codex resume --last',
      promptCommand: 'codex {{prompt}}',
      launchModes: [{ id: 'mode-1', name: 'Full auto', command: 'codex --full-auto' }],
      isBuiltin: false,
    },
  ];
  const activePresets: ActivePresetEntry[] = [];
  const service = new SettingsManagementService({
    actions: {
      list: () => actions,
      getStorageRevisionState: () =>
        !actionsStorageReadable
          ? { status: 'unreadable' as const }
          : actionsStorageCurrent
            ? { status: 'current' as const, revision }
            : { status: 'changed' as const },
      replaceAll: (expected, desired) => {
        if (expected !== revision) throw new Error('Actions revision changed');
        actions = desired;
        revision = 'actions-2';
        return revision;
      },
    },
    projects: {
      list: () => projects,
      get: (id) => projects.find((project) => project.id === id),
      getStorageRevisionState: () =>
        projectsStorageCurrent
          ? { status: 'current' as const, revision: 'projects-1' }
          : { status: 'changed' as const },
      replaceWorkspaceSetup: vi.fn((_expected, id, setup) => {
        Object.assign(projects.find((project) => project.id === id)!, setup);
        return 'projects-2';
      }),
    },
    workspaces: {
      get: (id) => (id === workspace.id ? workspace : undefined),
      findWorkspaceByTerminalId: (id) => (id === 'terminal-1' ? workspace : undefined),
    },
    resolveProjectByCwd: (cwd) =>
      cwd.startsWith('/repo')
        ? { project: projects[0], workspace }
        : cwd.startsWith('/other')
          ? { project: projects[1] }
          : {},
    presets: { list: () => presets, getActivePresets: () => activePresets },
    appearance: { get: () => theme, systemIsDark: () => systemIsDark, set: setAppearance },
    environmentConfiguration: () => environmentConfiguration,
    files: {
      'status-items': hooksFile,
      hooks: hooksFile,
      shortcuts: hooksFile,
      terminal: hooksFile,
    },
    automations: automationDeps,
    approve,
    feedback,
    generateId: () => 'generated-id',
  });
  return {
    service,
    approve,
    feedback,
    setAppearance,
    setTheme: (next: ThemeConfig) => {
      theme = next;
    },
    setSystemIsDark: (dark: boolean) => {
      systemIsDark = dark;
    },
    getTheme: () => theme,
    getActions: () => actions,
    presets,
    activePresets,
    automationDeps,
    automationSnapshots,
    getAutomations: () => automations,
    setAutomations: (next: Automation[]) => {
      automations = next;
    },
    hooksFile,
    changeHooksFile: () => {
      hooksRevision += 1;
    },
    projects,
    environmentConfiguration,
    workspace,
    setActionsStorageCurrent: (value: boolean) => {
      actionsStorageCurrent = value;
    },
    setActionsStorageReadable: (value: boolean) => {
      actionsStorageReadable = value;
    },
    setProjectsStorageCurrent: (value: boolean) => {
      projectsStorageCurrent = value;
    },
  };
}

describe('SettingsManagementService', () => {
  it('reads supported Global and current-project Action views', () => {
    const { service } = fixture();

    expect(service.readActions({}, 'global')).toEqual({
      scope: 'global',
      actions: [{ id: 'global', title: 'Global', content: 'review', type: 'prompt' }],
    });
    expect(service.readActions({ terminalId: 'terminal-1' }, 'current-project')).toEqual({
      scope: 'current-project',
      project: { id: 'project-1', name: 'Komla' },
      actions: [
        { id: 'local', title: 'Local', content: 'npm test', type: 'prompt', projectCount: 1 },
        { id: 'shared', title: 'Shared', content: 'lint', type: 'prompt', projectCount: 2 },
      ],
    });
  });

  it('reports available environments and marks where new workspaces start', () => {
    const { service, environmentConfiguration } = fixture();
    environmentConfiguration.sshHosts.push({ id: 'ssh-1' });

    expect(service.readWorkspaceSetup({ terminalId: 'terminal-1' }).setupCapabilities).toEqual({
      currentEnvironment: { kind: 'local' },
      ssh: {
        configured: true,
        selectedForNewWorkspaces: false,
        actionsRunInLocalCopy: false,
      },
    });

    environmentConfiguration.lastWorkspaceEnvironment = { kind: 'ssh', hostId: 'ssh-1' };
    const capabilities = service.readWorkspaceSetup({ terminalId: 'terminal-1' }).setupCapabilities;
    expect(capabilities.ssh.selectedForNewWorkspaces).toBe(true);
  });

  it('reports when project command Actions run in the SSH Local copy', () => {
    const { service, projects } = fixture();
    projects[0].sshWorkspaceMode = 'local-mirror-actions';

    expect(
      service.readWorkspaceSetup({ terminalId: 'terminal-1' }).setupCapabilities.ssh
    ).toMatchObject({ actionsRunInLocalCopy: true });
  });

  it('distinguishes an SSH repository terminal from its desktop Local copy', () => {
    const { service, workspace } = fixture();
    workspace.backend = {
      kind: 'ssh',
      hostId: 'ssh-1',
      remoteDirectory: '/remote/worktree',
      remoteRepoPath: '/remote/repo.git',
      remoteProjectRoot: '/remote',
      gitUrl: 'git@example.com:repo.git',
    };

    expect(
      service.readWorkspaceSetup({ terminalId: 'terminal-1' }).setupCapabilities.currentEnvironment
    ).toEqual({ kind: 'ssh' });

    workspace.terminals[0]!.executionLocation = 'local-mirror';
    expect(
      service.readWorkspaceSetup({ terminalId: 'terminal-1' }).setupCapabilities.currentEnvironment
    ).toEqual({ kind: 'ssh-local-copy' });
  });

  it('round-trips a legacy Global Action with an empty project association list', () => {
    const { service, getActions } = fixture();
    getActions().push({
      id: 'legacy-global',
      title: 'Legacy Global',
      content: 'review',
      projectIds: [],
    });

    expect(service.readActions({}, 'global').actions.at(-1)).toEqual({
      id: 'legacy-global',
      title: 'Legacy Global',
      content: 'review',
      type: 'prompt',
    });
  });

  it('applies an approved complete Global Actions proposal and generates IDs', async () => {
    const { service, approve, getActions } = fixture();
    const result = await service.proposeActions({}, 'global', {
      actions: [{ title: 'New', content: 'new prompt', type: 'prompt' }],
    });

    expect(result.status).toBe('applied');
    expect(approve).toHaveBeenCalledWith(
      expect.objectContaining({ changes: expect.any(Array) }),
      undefined
    );
    expect(getActions()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'generated-id', title: 'New' }),
        expect.objectContaining({ id: 'local' }),
      ])
    );
  });

  it('round-trips the SSH execution location of a command Action', async () => {
    const { service, approve, getActions } = fixture();
    await service.proposeActions({}, 'global', {
      actions: [
        ...service.readActions({}, 'global').actions,
        {
          title: 'Linux desktop',
          content: 'komla desktop run -- npm run dev',
          type: 'command',
          sshExecutionLocation: 'remote',
        },
      ],
    });

    expect(getActions()).toContainEqual(
      expect.objectContaining({ title: 'Linux desktop', sshExecutionLocation: 'remote' })
    );
    expect(service.readActions({}, 'global').actions).toContainEqual(
      expect.objectContaining({ title: 'Linux desktop', sshExecutionLocation: 'remote' })
    );
    expect(approve).toHaveBeenCalledWith(
      expect.objectContaining({
        changes: expect.arrayContaining([
          expect.objectContaining({
            title: 'Linux desktop',
            details: expect.arrayContaining([
              { label: 'SSH workspaces', value: 'Runs on the remote machine' },
            ]),
          }),
        ]),
      }),
      undefined
    );
  });

  it('rejects an SSH execution location supplied for a prompt Action', async () => {
    const { service } = fixture();
    await expect(
      service.proposeActions({}, 'global', {
        actions: [
          {
            id: 'global',
            title: 'Global',
            content: 'review',
            type: 'prompt',
            sshExecutionLocation: 'local-mirror',
          },
        ],
      })
    ).rejects.toMatchObject({ code: 'INVALID_SSH_EXECUTION_LOCATION', status: 422 });
  });

  it('round-trips a background command Action', async () => {
    const { service, approve, getActions } = fixture();
    await service.proposeActions({}, 'global', {
      actions: [
        ...service.readActions({}, 'global').actions,
        { title: 'Watch CI', content: 'gh pr checks --watch', type: 'command', background: true },
      ],
    });

    expect(getActions()).toContainEqual(
      expect.objectContaining({ title: 'Watch CI', background: true })
    );
    expect(service.readActions({}, 'global').actions).toContainEqual(
      expect.objectContaining({ title: 'Watch CI', background: true })
    );
    expect(approve).toHaveBeenCalledWith(
      expect.objectContaining({
        changes: expect.arrayContaining([
          expect.objectContaining({
            title: 'Watch CI',
            details: expect.arrayContaining([
              { label: 'Runs', value: 'In the background, with a notification when done' },
            ]),
          }),
        ]),
      }),
      undefined
    );
  });

  it('rejects running a prompt Action in the background', async () => {
    const { service } = fixture();
    await expect(
      service.proposeActions({}, 'global', {
        actions: [{ title: 'Review', content: 'review', type: 'prompt', background: true }],
      })
    ).rejects.toMatchObject({ code: 'INVALID_BACKGROUND', status: 422 });
  });

  it('preserves Action ordering outside an updated project scope', async () => {
    const { service, getActions } = fixture();
    const read = service.readActions({ terminalId: 'terminal-1' }, 'current-project');

    await service.proposeActions({ terminalId: 'terminal-1' }, 'current-project', {
      actions: read.actions.map((action) =>
        action.id === 'local' ? { ...action, title: 'Updated Local' } : action
      ),
    });

    expect(getActions().map((action) => action.id)).toEqual(['global', 'local', 'shared', 'other']);
  });

  it('applies the requested Action order within a project scope', async () => {
    const { service, getActions } = fixture();
    const read = service.readActions({ terminalId: 'terminal-1' }, 'current-project');
    const [local, shared] = read.actions;

    await service.proposeActions({ terminalId: 'terminal-1' }, 'current-project', {
      actions: [shared, { title: 'New between', content: 'npm run check', type: 'command' }, local],
    });

    expect(getActions().map((action) => action.id)).toEqual([
      'global',
      'shared',
      'generated-id',
      'local',
      'other',
    ]);
  });

  it('rejects omitted multi-project Actions and conflicting identity hints', async () => {
    const { service } = fixture();
    await expect(
      service.proposeActions({ terminalId: 'terminal-1' }, 'current-project', {
        actions: [
          { id: 'local', title: 'Local', content: 'npm test', type: 'prompt', projectCount: 1 },
        ],
      })
    ).rejects.toMatchObject({ code: 'MULTI_PROJECT_ACTION_REQUIRED', status: 422 });

    expect(() => service.readWorkspaceSetup({ terminalId: 'terminal-1', cwd: '/other' })).toThrow(
      SettingsManagementError
    );
  });

  it('generates setup-step IDs and returns the applied Workspace Setup view', async () => {
    const { service, approve } = fixture();
    const result = await service.proposeWorkspaceSetup({ terminalId: 'terminal-1' }, {
      setupSteps: [
        {
          name: 'Install',
          command: 'npm install',
          placement: 'background',
          destination: 'ssh-workspace-repository',
          trigger: 'workspace-creation',
        },
      ],
      agentPlacement: 'tab',
      agentLayoutOrder: 0,
      trashCleanupScript: 'rm -rf node_modules',
    });

    expect(result).toMatchObject({ status: 'applied', applied: true });
    expect(result.value?.setupSteps[0]).toMatchObject({
      id: 'generated-id',
      name: 'Install',
      destination: 'ssh-workspace-repository',
      trigger: 'workspace-creation',
    });
    expect(approve).toHaveBeenCalledWith(
      expect.objectContaining({
        changes: expect.arrayContaining([
          expect.objectContaining({
            details: expect.arrayContaining([
              { label: 'Run in', value: 'SSH workspace repository' },
              { label: 'Run on', value: 'Workspace creation' },
            ]),
          }),
        ]),
      }),
      undefined
    );
  });

  it('rejects a workspace-stop step that would launch an agent', async () => {
    const { service, approve } = fixture();

    await expect(
      service.proposeWorkspaceSetup({ terminalId: 'terminal-1' }, {
        setupSteps: [
          {
            name: 'Reviewer',
            command: '',
            placement: 'background',
            destination: 'workspace-repository',
            trigger: 'workspace-stop',
            agent: {},
          },
        ],
        agentPlacement: 'tab',
        agentLayoutOrder: 0,
        trashCleanupScript: '',
      })
    ).rejects.toMatchObject({ code: 'INVALID_STOP_STEP', status: 422 });
    expect(approve).not.toHaveBeenCalled();
  });

  it('rejects Workspace Setup writes for directory projects', async () => {
    const { service, projects, approve } = fixture();
    projects[0].kind = 'directory';

    await expect(
      service.proposeWorkspaceSetup({ terminalId: 'terminal-1' }, {
        setupSteps: [
          {
            name: 'Install',
            command: 'npm install',
            placement: 'background',
            destination: 'workspace-repository',
            trigger: 'workspace-creation',
          },
        ],
        agentPlacement: 'tab',
        agentLayoutOrder: 0,
        trashCleanupScript: '',
      })
    ).rejects.toMatchObject({ code: 'WORKSPACE_SETUP_UNSUPPORTED', status: 422 });
    expect(approve).not.toHaveBeenCalled();
  });

  it('rejects deletion of Actions referenced by Workspace Setup', async () => {
    const { service, projects } = fixture();
    projects[0].setupSteps = [
      {
        id: 'review-step',
        name: 'Review',
        command: '',
        placement: 'tab',
        actionId: 'global',
      },
    ];
    await expect(service.proposeActions({}, 'global', { actions: [] })).rejects.toMatchObject({
      code: 'ACTION_STILL_REFERENCED',
      details: [expect.objectContaining({ project: { id: 'project-1', name: 'Komla' } })],
    });
  });

  it('rejects competing proposals while approval is pending', async () => {
    const { service, approve } = fixture();
    let resolveApproval!: (approved: boolean) => void;
    approve.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveApproval = resolve;
        })
    );
    const desired = { actions: [{ title: 'New', content: 'new prompt', type: 'prompt' as const }] };
    const first = service.proposeActions({}, 'global', desired);
    await vi.waitFor(() => expect(approve).toHaveBeenCalled());

    await expect(service.proposeActions({}, 'global', desired)).rejects.toMatchObject({
      code: 'APPROVAL_PENDING',
      status: 409,
    });
    resolveApproval(false);
    await expect(first).resolves.toMatchObject({ status: 'cancelled', applied: false });
  });

  it('uses one pending approval lock across all Actions scopes', async () => {
    const { service, approve } = fixture();
    let resolveApproval!: (approved: boolean) => void;
    approve.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveApproval = resolve;
        })
    );
    const first = service.proposeActions({}, 'global', {
      actions: [{ title: 'New', content: 'new prompt', type: 'prompt' }],
    });
    await vi.waitFor(() => expect(approve).toHaveBeenCalled());
    const project = service.readActions({ terminalId: 'terminal-1' }, 'current-project');
    const editedProjectActions = project.actions.map((action) =>
      action.id === 'local' ? { ...action, title: 'Edited Local' } : action
    );

    await expect(
      service.proposeActions({ terminalId: 'terminal-1' }, 'current-project', {
        actions: editedProjectActions,
      })
    ).rejects.toMatchObject({ code: 'APPROVAL_PENDING', status: 409 });
    resolveApproval(false);
    await first;
  });

  it('rejects a direct-file race before showing approval', async () => {
    const { service, approve, feedback, setActionsStorageCurrent, setProjectsStorageCurrent } =
      fixture();
    setActionsStorageCurrent(false);
    await expect(
      service.proposeActions({}, 'global', {
        actions: [{ title: 'New', content: 'new prompt', type: 'prompt' }],
      })
    ).rejects.toMatchObject({ code: 'STALE_VERSION', status: 412 });

    const setup = service.readWorkspaceSetup({ terminalId: 'terminal-1' });
    setProjectsStorageCurrent(false);
    await expect(
      service.proposeWorkspaceSetup({ terminalId: 'terminal-1' }, {
        setupSteps: [],
        agentPlacement: setup.agentPlacement,
        agentLayoutOrder: setup.agentLayoutOrder,
        trashCleanupScript: setup.trashCleanupScript,
      })
    ).rejects.toMatchObject({ code: 'STALE_VERSION', status: 412 });
    expect(approve).not.toHaveBeenCalled();
    expect(feedback).toHaveBeenCalledTimes(2);
  });

  it('rejects an Actions deletion when Workspace Setup storage changes during approval', async () => {
    const { service, approve, getActions, setProjectsStorageCurrent } = fixture();
    approve.mockImplementationOnce(async () => {
      setProjectsStorageCurrent(false);
      return true;
    });

    await expect(
      service.proposeActions({}, 'global', { actions: [] })
    ).rejects.toMatchObject({ code: 'STALE_VERSION', status: 412 });
    expect(getActions()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'global' })])
    );
  });

  it('rejects Workspace Setup when Actions storage changes during approval', async () => {
    const { service, approve, projects, setActionsStorageCurrent } = fixture();
    const read = service.readWorkspaceSetup({ terminalId: 'terminal-1' });
    approve.mockImplementationOnce(async () => {
      setActionsStorageCurrent(false);
      return true;
    });

    await expect(
      service.proposeWorkspaceSetup({ terminalId: 'terminal-1' }, {
        ...read,
        setupSteps: [
          {
            name: 'Test',
            command: '',
            placement: 'tab',
            actionId: 'local',
          },
        ],
      })
    ).rejects.toMatchObject({ code: 'STALE_VERSION', status: 412 });
    expect(projects[0].setupSteps).toEqual([]);
  });

  it('does not emit rejected-write feedback when settings storage cannot be read', async () => {
    const { service, feedback, setActionsStorageReadable } = fixture();
    setActionsStorageReadable(false);

    await expect(
      service.proposeActions({}, 'global', {
        actions: [{ title: 'New', content: 'new prompt', type: 'prompt' }],
      })
    ).rejects.toMatchObject({ code: 'SETTINGS_READ_FAILED', status: 500 });
    expect(feedback).not.toHaveBeenCalled();
  });

  it('targets cwd-resolved rejected-write feedback to its workspace', async () => {
    const { service, feedback } = fixture();
    await expect(
      service.proposeActions({ cwd: '/repo' }, 'current-project', {
        actions: [{ id: 'local', title: '', content: 'npm test', type: 'prompt', projectCount: 1 }],
      })
    ).rejects.toMatchObject({ code: 'INVALID_ACTION' });
    expect(feedback).toHaveBeenCalledWith(
      'Quick Command title and content are required.',
      expect.objectContaining({ id: 'workspace-1' })
    );
  });

  it('describes setup-step additions, edits, and deletions', async () => {
    const { service, approve, projects } = fixture();
    projects[0].setupSteps = [
      { id: 'edit', name: 'Old', command: 'old', placement: 'background' },
      { id: 'delete', name: 'Delete', command: 'delete', placement: 'background' },
    ];
    const read = service.readWorkspaceSetup({ terminalId: 'terminal-1' });
    await service.proposeWorkspaceSetup({ terminalId: 'terminal-1' }, {
      ...read,
      setupSteps: [
        { id: 'edit', name: 'Edited', command: 'new', placement: 'background' },
        { name: 'Added', command: 'add', placement: 'background' },
      ],
    });

    expect(approve).toHaveBeenCalledWith(
      expect.objectContaining({
        changes: expect.arrayContaining([
          expect.objectContaining({
            operation: 'edit',
            kind: 'setup-step',
            title: 'Edited',
            content: 'new',
            details: expect.arrayContaining([
              { label: 'Show in', value: 'Background' },
              { label: 'Run in', value: 'Workspace repository' },
              { label: 'Run on', value: 'Every workspace start' },
            ]),
          }),
          expect.objectContaining({
            operation: 'add',
            kind: 'setup-step',
            title: 'Added',
            content: 'add',
          }),
          expect.objectContaining({
            operation: 'delete',
            kind: 'setup-step',
            title: 'Delete',
            content: 'delete',
          }),
        ]),
      }),
      undefined
    );
  });

  it('shows the referenced Action title and effective command in Setup approval', async () => {
    const { service, approve, getActions } = fixture();
    getActions().find((action) => action.id === 'local')!.type = 'command';
    const read = service.readWorkspaceSetup({ terminalId: 'terminal-1' });

    await service.proposeWorkspaceSetup({ terminalId: 'terminal-1' }, {
      ...read,
      setupSteps: [
        {
          name: 'Run tests',
          command: '',
          placement: 'tab',
          actionId: 'local',
        },
      ],
    });

    expect(approve).toHaveBeenCalledWith(
      expect.objectContaining({
        changes: [
          expect.objectContaining({
            title: 'Run tests',
            contentLabel: 'Command',
            content: 'npm test',
            details: expect.arrayContaining([{ label: 'Quick command', value: 'Local' }]),
          }),
        ],
      }),
      undefined
    );
  });

  it('includes exact Action content and launch details in the approval review', async () => {
    const { service, approve } = fixture();
    await service.proposeActions({}, 'global', {
      actions: [
        {
          title: 'Run checks',
          content: 'npm test -- --runInBand',
          type: 'command',
          presetId: 'preset-1',
          launchModeId: 'mode-1',
        },
      ],
    });

    expect(approve).toHaveBeenCalledWith(
      expect.objectContaining({
        changes: expect.arrayContaining([
          expect.objectContaining({
            operation: 'add',
            kind: 'action',
            title: 'Run checks',
            contentLabel: 'Command',
            content: 'npm test -- --runInBand',
            details: expect.arrayContaining([
              { label: 'Preset', value: 'Codex' },
              { label: 'Launch mode', value: 'Full auto' },
            ]),
          }),
        ]),
      }),
      undefined
    );
  });

  describe('settings files', () => {
    const desired = { hooks: [{ id: 'lint', event: 'agent.done', command: 'npm run lint' }] };

    it("asks in the caller's window with each command, and writes the file once kept", async () => {
      const { service, approve, hooksFile, workspace } = fixture();

      const result = await service.proposeSettingsFile(
        { terminalId: 'terminal-1' },
        'hooks',
        desired
      );

      expect(approve).toHaveBeenCalledWith(
        {
          resource: 'hooks',
          workspace,
          changes: [
            {
              operation: 'add',
              kind: 'hook',
              title: 'lint',
              contentLabel: 'Command',
              content: 'npm run lint',
              details: [],
            },
          ],
          warning: 'Komla runs these commands without asking again.',
        },
        undefined
      );
      expect(hooksFile.write).toHaveBeenCalledWith(desired);
      expect(result).toEqual({ status: 'applied', applied: true, value: desired });
    });

    it('writes nothing when the user cancels', async () => {
      const { service, approve, hooksFile } = fixture();
      approve.mockResolvedValueOnce(false);

      await expect(service.proposeSettingsFile({}, 'hooks', desired)).resolves.toEqual({
        status: 'cancelled',
        applied: false,
      });
      expect(hooksFile.write).not.toHaveBeenCalled();
    });

    it('asks nothing when the settings would not change', async () => {
      const { service, approve, hooksFile } = fixture();

      await expect(service.proposeSettingsFile({}, 'hooks', { hooks: [] })).resolves.toEqual({
        status: 'unchanged',
        applied: false,
      });
      expect(approve).not.toHaveBeenCalled();
      expect(hooksFile.write).not.toHaveBeenCalled();
    });

    it('names what is wrong before asking, and tells the user', async () => {
      const { service, approve, feedback } = fixture();

      await expect(
        service.proposeSettingsFile({}, 'hooks', { hooks: 'lint' })
      ).rejects.toMatchObject({
        code: 'INVALID_SETTINGS',
        status: 422,
        details: [{ message: 'hooks: expected an array' }],
      });
      expect(approve).not.toHaveBeenCalled();
      expect(feedback).toHaveBeenCalledWith(
        'Fix the Hooks settings and apply them again.',
        undefined
      );
    });

    it('keeps a change made to the file while the user decided', async () => {
      const { service, approve, hooksFile, changeHooksFile } = fixture();
      approve.mockImplementationOnce(async () => {
        changeHooksFile();
        return true;
      });

      await expect(service.proposeSettingsFile({}, 'hooks', desired)).rejects.toMatchObject({
        code: 'STALE_VERSION',
        status: 412,
      });
      expect(hooksFile.write).not.toHaveBeenCalled();
    });

    it('asks about one change to a file at a time', async () => {
      const { service, approve } = fixture();
      let decide: (approved: boolean) => void = () => {};
      approve.mockImplementationOnce(() => new Promise<boolean>((resolve) => (decide = resolve)));

      const first = service.proposeSettingsFile({}, 'hooks', desired);
      await expect(service.proposeSettingsFile({}, 'hooks', desired)).rejects.toMatchObject({
        code: 'APPROVAL_PENDING',
      });
      decide(false);
      await expect(first).resolves.toMatchObject({ status: 'cancelled' });
    });
  });

  describe('appearance', () => {
    const moss = {
      name: 'Moss',
      mode: 'dark' as const,
      surfaces: {
        background: '#0f1410',
        card: '#18201a',
        muted: '#222c24',
        highlight: '#2a362d',
        border: '#3a4a3e',
      },
      terminal: { background: '#0f1410', foreground: '#c8d8c0' },
    };
    const desired: AppearanceSettings = {
      palette: 'custom',
      customPalette: moss,
      accent: 'oklch(0.65 0.15 145)',
      borderRadius: 8,
    };

    it('reads the current appearance with the built-in themes', () => {
      const { service } = fixture();

      expect(service.readAppearance()).toMatchObject({
        palette: 'default',
        accent: 'oklch(0.65 0.15 250)',
        borderRadius: 6,
        themes: expect.arrayContaining([
          { id: 'frost', name: 'Komla Light', mode: 'light', accent: 'oklch(0.205 0 0)' },
        ]),
        problems: [],
      });
    });

    it("previews the change in the caller's window and applies it once kept", async () => {
      const { service, approve, getTheme, workspace } = fixture();

      const result = await service.proposeAppearance({ terminalId: 'terminal-1' }, desired);

      expect(approve).toHaveBeenCalledWith(
        {
          resource: 'appearance',
          workspace,
          preview: desired,
          changes: [
            {
              operation: 'change',
              kind: 'theme',
              title: 'Moss (custom)',
              details: [{ label: 'From', value: 'Komla Dark' }],
            },
            {
              operation: 'add',
              kind: 'custom-theme',
              title: 'Moss',
              details: [{ label: 'Mode', value: 'Dark' }],
            },
            {
              operation: 'change',
              kind: 'accent-color',
              title: 'oklch(0.65 0.15 145)',
              details: [{ label: 'From', value: 'oklch(0.65 0.15 250)' }],
            },
            {
              operation: 'change',
              kind: 'corner-radius',
              title: '8px',
              details: [{ label: 'From', value: '6px' }],
            },
          ],
        },
        undefined
      );
      expect(result).toMatchObject({ status: 'applied', value: { palette: 'custom' } });
      expect(getTheme()).toMatchObject({ palette: 'custom', customPalette: moss });
    });

    it('treats the same settings with keys in another order as unchanged', async () => {
      const { service, approve, setAppearance } = fixture();
      await service.proposeAppearance({}, desired);
      approve.mockClear();

      const reordered = {
        borderRadius: 8,
        accent: 'oklch(0.65 0.15 145)',
        customPalette: { ...moss, terminal: { foreground: '#c8d8c0', background: '#0f1410' } },
        palette: 'custom',
      };
      const result = await service.proposeAppearance({}, reordered);

      expect(result).toEqual({ status: 'unchanged', applied: false });
      expect(approve).not.toHaveBeenCalled();
      expect(setAppearance).toHaveBeenCalledTimes(1);
    });

    it('lists every problem to fix without asking the user', async () => {
      const { service, approve, feedback } = fixture();
      const unreadable = { ...moss, surfaces: { ...moss.surfaces, card: '#8a8a8a' } };

      const error = await service
        .proposeAppearance({}, { ...desired, customPalette: unreadable, accent: 'blue' })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(SettingsManagementError);
      expect(error).toMatchObject({
        code: 'INVALID_APPEARANCE',
        status: 422,
        details: [
          { message: expect.stringMatching(/^Text on surfaces\.card /) },
          { message: expect.stringMatching(/^Secondary text on surfaces\.card /) },
          { message: 'accent must look like "oklch(0.65 0.15 250)".' },
        ],
      });
      expect(approve).not.toHaveBeenCalled();
      expect(feedback).toHaveBeenCalled();
    });

    it('keeps theme.json as it was when the user reverts', async () => {
      const { service, approve, setAppearance } = fixture();
      approve.mockResolvedValue(false);

      const result = await service.proposeAppearance({}, desired);

      expect(result).toEqual({ status: 'cancelled', applied: false });
      expect(setAppearance).not.toHaveBeenCalled();
    });

    it('rejects the change when theme.json changes while the user decides', async () => {
      const { service, approve, setAppearance, getTheme, setTheme } = fixture();
      approve.mockImplementation(async () => {
        setTheme({ ...getTheme(), palette: 'nord' });
        return true;
      });

      await expect(service.proposeAppearance({}, desired)).rejects.toMatchObject({
        code: 'STALE_VERSION',
      });
      expect(setAppearance).not.toHaveBeenCalled();
    });

    it('removes a custom theme left out of the desired settings', async () => {
      const { service, approve, getTheme } = fixture();
      await service.proposeAppearance({}, desired);
      approve.mockClear();

      await service.proposeAppearance(
        {},
        { ...desired, palette: 'nord', customPalette: undefined }
      );

      expect(approve.mock.calls[0][0].changes).toContainEqual({
        operation: 'delete',
        kind: 'custom-theme',
        title: 'Moss',
        details: [{ label: 'Mode', value: 'Dark' }],
      });
      expect(getTheme().customPalette).toBeUndefined();
    });

    describe('following the system appearance', () => {
      const following = (base: ThemeConfig): ThemeConfig => ({
        ...base,
        palette: 'dracula',
        followSystem: true,
        lightPalette: 'one-light',
        colors: { accent: 'oklch(0.74 0.15 302)', lightAccent: 'oklch(0.5 0.2 270)' },
      });
      const nord = { palette: 'nord', accent: 'oklch(0.77 0.06 217)', borderRadius: 6 };

      it('reads the light theme and its accent while the system is light', () => {
        const { service, getTheme, setTheme, setSystemIsDark } = fixture();
        setTheme(following(getTheme()));
        setSystemIsDark(false);

        expect(service.readAppearance()).toMatchObject({
          palette: 'one-light',
          accent: 'oklch(0.5 0.2 270)',
        });
      });

      it('describes the theme an apply replaces and when it shows, whichever shows now', async () => {
        const { service, approve, getTheme, setTheme, setSystemIsDark } = fixture();
        setTheme(following(getTheme()));
        setSystemIsDark(false);

        const result = await service.proposeAppearance({}, nord);

        const shows = { label: 'Shows', value: 'While your system is dark' };
        expect(approve.mock.calls[0][0].changes).toEqual([
          {
            operation: 'change',
            kind: 'theme',
            title: 'Nord',
            details: [{ label: 'From', value: 'Dracula' }, shows],
          },
          {
            operation: 'change',
            kind: 'accent-color',
            title: nord.accent,
            details: [{ label: 'From', value: 'oklch(0.74 0.15 302)' }, shows],
          },
        ]);
        expect(result).toMatchObject({ status: 'applied', value: nord });
        expect(getTheme()).toMatchObject({ palette: 'nord', lightPalette: 'one-light' });
      });

      it('applies the change when the system appearance switches while the user decides', async () => {
        const { service, approve, getTheme, setTheme, setSystemIsDark } = fixture();
        setTheme(following(getTheme()));
        approve.mockImplementation(async () => {
          setSystemIsDark(false);
          return true;
        });

        const result = await service.proposeAppearance({}, nord);

        expect(result).toMatchObject({ status: 'applied' });
      });
    });
  });

  describe('automations', () => {
    const withHost = () => {
      const result = fixture();
      result.environmentConfiguration.sshHosts.push({ id: 'ssh-1' });
      return result;
    };

    it("reads the current project's automations and where they can run", async () => {
      const { service } = withHost();

      expect(await service.readAutomations({ terminalId: 'terminal-1' })).toEqual({
        project: { id: 'project-1', name: 'Komla' },
        targets: [
          { target: { kind: 'local' }, name: 'This computer' },
          {
            target: { kind: 'ssh', hostId: 'ssh-1' },
            name: 'devbox',
            problem: 'cron isn’t installed on this host.',
          },
        ],
        automations: [
          {
            id: 'nightly',
            name: 'Nightly deps',
            prompt: 'Update dependencies',
            target: { kind: 'local' },
            presetId: 'preset-1',
            schedule: { cron: '0 2 * * *', timeZone: 'Europe/Oslo' },
            enabled: true,
            missedRunGraceMinutes: 720,
          },
          {
            id: 'triage',
            name: 'Triage',
            prompt: 'Triage new issues',
            target: { kind: 'ssh', hostId: 'ssh-1' },
            agentName: 'Claude Code',
            schedule: { cron: '30 8 * * 1-5', timeZone: 'UTC' },
            enabled: true,
            missedRunGraceMinutes: 180,
          },
        ],
        agents: [{ id: 'preset-1', name: 'Codex', modes: [{ id: 'mode-1', name: 'Full auto' }] }],
      });
    });

    it('offers every mode of the agents the user turned on, marking those that skip permission prompts', async () => {
      const { service, presets, activePresets, automationDeps } = withHost();
      automationDeps.agentProblem.mockImplementation((_target, presetId) =>
        presetId === 'shell' ? 'Shell only can’t start with a prompt.' : undefined
      );
      presets.push(
        {
          id: 'claude',
          name: 'Claude Code',
          openCommand: 'claude',
          continueCommand: 'claude --resume',
          promptCommand: 'claude {{launchMode}} {{prompt}}',
          launchModes: [
            { id: 'auto', name: 'Auto', arguments: '--permission-mode auto' },
            {
              id: 'skip',
              name: 'Dangerously skip permissions',
              arguments: '--dangerously-skip-permissions',
            },
          ],
          isBuiltin: true,
        },
        {
          id: 'shell',
          name: 'Shell only',
          openCommand: 'bash',
          continueCommand: 'bash',
          launchModes: [],
          isBuiltin: false,
        }
      );
      // Most recently used first, as AgentPresetService returns them.
      activePresets.push(
        { presetId: 'shell', lastUsedAt: 3 },
        { presetId: 'claude', lastUsedAt: 2 },
        { presetId: 'preset-1', lastUsedAt: 1 }
      );

      const read = await service.readAutomations({ terminalId: 'terminal-1' });

      // Agents can't launch the skipping mode themselves, but the user approves each automation.
      expect(read.agents).toEqual([
        {
          id: 'claude',
          name: 'Claude Code',
          modes: [
            { id: 'auto', name: 'Auto' },
            { id: 'skip', name: 'Dangerously skip permissions', skipsPermissionPrompts: true },
          ],
        },
        { id: 'preset-1', name: 'Codex', modes: [{ id: 'mode-1', name: 'Full auto' }] },
      ]);
    });

    it('keeps the agent an automation uses after the user turned it off', async () => {
      const { service, presets, activePresets } = withHost();
      presets.push({
        id: 'claude',
        name: 'Claude Code',
        openCommand: 'claude',
        continueCommand: 'claude --resume',
        promptCommand: 'claude {{prompt}}',
        launchModes: [],
        isBuiltin: true,
      });
      activePresets.push({ presetId: 'claude', lastUsedAt: 1 });

      const read = await service.readAutomations({ terminalId: 'terminal-1' });

      // Nightly deps uses Codex, which is no longer turned on.
      expect(read.agents.map(({ id }) => id)).toEqual(['claude', 'preset-1']);
    });

    it('warns when an automation it starts skips permission prompts', async () => {
      const { service, approve, presets } = withHost();
      presets[0].launchModes.push({
        id: 'yolo',
        name: 'Fast',
        arguments: '--dangerously-bypass-approvals-and-sandbox',
      });
      const read = await service.readAutomations({ terminalId: 'terminal-1' });

      await service.proposeAutomations(
        { terminalId: 'terminal-1' },
        {
          automations: [
            ...read.automations,
            {
              name: 'CI check',
              prompt: 'Fix CI',
              target: { kind: 'local' },
              presetId: 'preset-1',
              launchModeId: 'yolo',
              schedule: { cron: '0 8 * * 1-5' },
            },
          ],
        }
      );

      const prompt = approve.mock.calls[0][0];
      expect(prompt.changes[0].details).toContainEqual({
        label: 'Permission prompts',
        value: 'Skipped',
      });
      expect(prompt.warning).toBe(
        'Komla starts these agents with their prompts on schedule, without asking. “CI check” skips permission prompts, so its agent acts without asking for permission.'
      );
    });

    it('leaves SSH hosts out of the targets of a folder project, without reading them', async () => {
      const { service, projects, automationDeps } = withHost();
      projects[0].kind = 'directory';

      const read = await service.readAutomations({ terminalId: 'terminal-1' });

      expect(read.targets).toEqual([{ target: { kind: 'local' }, name: 'This computer' }]);
      expect(automationDeps.listCurrent).toHaveBeenCalledWith({ hostIds: [], waitMs: 6000 });
      expect(automationDeps.hostProblem).not.toHaveBeenCalled();
    });

    it('says when a host is still being read, or the project can’t run on hosts', async () => {
      const { service, automationDeps, automationSnapshots } = withHost();
      automationDeps.hostProblem.mockResolvedValue(
        'Add a Git remote to Komla to run it on an SSH host.'
      );
      const read = await service.readAutomations({ terminalId: 'terminal-1' });
      expect(read.targets[1]?.problem).toBe('Add a Git remote to Komla to run it on an SSH host.');

      automationDeps.listCurrent.mockImplementationOnce(async () =>
        (await automationSnapshots()).map((snapshot) =>
          snapshot.target.kind === 'ssh' ? { ...snapshot, loading: true } : snapshot
        )
      );
      const loading = await service.readAutomations({ terminalId: 'terminal-1' });
      expect(automationDeps.listCurrent).toHaveBeenLastCalledWith({ waitMs: 6000 });
      expect(loading.targets[1]?.problem).toMatch(/^Still reading this host’s automations/);
    });

    it('reports unchanged when the read automations come back as they were', async () => {
      const { service, approve, automationDeps } = withHost();
      const read = await service.readAutomations({ terminalId: 'terminal-1' });

      const result = await service.proposeAutomations(
        { terminalId: 'terminal-1' },
        { automations: read.automations }
      );

      expect(result).toEqual({ status: 'unchanged', applied: false });
      expect(approve).not.toHaveBeenCalled();
      expect(automationDeps.save).not.toHaveBeenCalled();
    });

    it('adds, edits, switches off and deletes automations once the user applies them', async () => {
      const { service, approve, automationDeps, getAutomations, workspace } = withHost();

      const result = await service.proposeAutomations(
        { terminalId: 'terminal-1' },
        {
          automations: [
            {
              id: 'triage',
              name: 'Triage',
              prompt: 'Triage new issues',
              target: { kind: 'ssh', hostId: 'ssh-1' },
              agentName: 'Claude Code',
              schedule: { cron: '30 8 * * 1-5', timeZone: 'UTC' },
              enabled: false,
            },
            {
              name: 'CI check',
              prompt: 'Fix CI',
              target: { kind: 'ssh', hostId: 'ssh-1' },
              presetId: 'preset-1',
              launchModeId: 'mode-1',
              schedule: { cron: '0 8 * * 1-5' },
            },
          ],
        }
      );

      expect(approve).toHaveBeenCalledWith(
        {
          resource: 'automations',
          project: { id: 'project-1', name: 'Komla' },
          workspace,
          changes: [
            {
              operation: 'change',
              kind: 'automation',
              title: 'Triage',
              details: [{ label: 'Runs on schedule', value: 'Off' }],
            },
            {
              operation: 'add',
              kind: 'automation',
              title: 'CI check',
              contentLabel: 'Prompt',
              content: 'Fix CI',
              details: [
                { label: 'Schedule', value: '0 8 * * 1-5 (America/New_York)' },
                { label: 'Runs on', value: 'devbox' },
                { label: 'Agent', value: 'Codex (Full auto)' },
                { label: 'Runs on schedule', value: 'On' },
              ],
            },
            {
              operation: 'delete',
              kind: 'automation',
              title: 'Nightly deps',
              contentLabel: 'Prompt',
              content: 'Update dependencies',
              details: [
                { label: 'Schedule', value: '0 2 * * * (Europe/Oslo)' },
                { label: 'Runs on', value: 'This computer' },
                { label: 'Agent', value: 'Codex' },
              ],
            },
          ],
          warning: 'Komla starts these agents with their prompts on schedule, without asking.',
        },
        undefined
      );
      // A switch alone doesn't resave, so the host keeps an agent this computer doesn't have.
      expect(automationDeps.setEnabled).toHaveBeenCalledWith(
        { kind: 'ssh', hostId: 'ssh-1' },
        'triage',
        false
      );
      expect(automationDeps.save).toHaveBeenCalledTimes(1);
      expect(automationDeps.save).toHaveBeenCalledWith({
        name: 'CI check',
        prompt: 'Fix CI',
        projectId: 'project-1',
        target: { kind: 'ssh', hostId: 'ssh-1' },
        presetId: 'preset-1',
        launchModeId: 'mode-1',
        schedule: { cron: '0 8 * * 1-5', timeZone: 'America/New_York' },
        enabled: true,
        missedRunGraceMinutes: 720,
      });
      expect(getAutomations().map(({ id }) => id)).toEqual([
        'triage',
        'elsewhere',
        'automation-new',
      ]);
      expect(result.status).toBe('applied');
      expect(result.value?.automations.map(({ name, enabled }) => ({ name, enabled }))).toEqual([
        { name: 'Triage', enabled: false },
        { name: 'CI check', enabled: true },
      ]);
    });

    it('moves an edited automation to another target and keeps its time zone', async () => {
      const { service, automationDeps } = withHost();

      await service.proposeAutomations(
        { terminalId: 'terminal-1' },
        {
          automations: [
            {
              id: 'nightly',
              name: 'Nightly deps',
              prompt: 'Update dependencies and run the tests',
              target: { kind: 'ssh', hostId: 'ssh-1' },
              presetId: 'preset-1',
              schedule: { cron: '0 3 * * *' },
            },
            {
              id: 'triage',
              name: 'Triage',
              prompt: 'Triage new issues',
              target: { kind: 'ssh', hostId: 'ssh-1' },
              schedule: { cron: '30 8 * * 1-5' },
            },
          ],
        }
      );

      expect(automationDeps.save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'nightly',
          previousTarget: { kind: 'local' },
          target: { kind: 'ssh', hostId: 'ssh-1' },
          schedule: { cron: '0 3 * * *', timeZone: 'Europe/Oslo' },
          enabled: true,
          missedRunGraceMinutes: 720,
        })
      );
    });

    it('keeps the branch an automation starts from until it is set to empty', async () => {
      const { service, automationDeps } = withHost();
      const nightly = {
        id: 'nightly',
        name: 'Nightly deps',
        prompt: 'Update dependencies',
        target: { kind: 'local' as const },
        presetId: 'preset-1',
        schedule: { cron: '0 2 * * *' },
      };
      const triage = {
        id: 'triage',
        name: 'Triage',
        prompt: 'Triage new issues',
        target: { kind: 'ssh' as const, hostId: 'ssh-1' },
        schedule: { cron: '30 8 * * 1-5' },
      };
      const apply = (edited: Record<string, unknown>) =>
        service.proposeAutomations(
          { terminalId: 'terminal-1' },
          { automations: [{ ...nightly, ...edited }, triage] }
        );

      await apply({ startBranch: 'release/1.x' });
      const read = await service.readAutomations({ terminalId: 'terminal-1' });
      expect(read.automations.find(({ id }) => id === 'nightly')?.startBranch).toBe('release/1.x');

      await apply({ prompt: 'Update dependencies and run the tests' });
      expect(automationDeps.save).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: 'nightly', startBranch: 'release/1.x' })
      );

      await apply({ startBranch: '' });
      expect(automationDeps.save).toHaveBeenLastCalledWith(
        expect.not.objectContaining({ startBranch: expect.anything() })
      );
    });

    it.each([
      ['an unknown id', { id: 'missing' }, 'UNKNOWN_AUTOMATION_ID'],
      ['an invalid schedule', { schedule: { cron: '61 * * * *' } }, 'INVALID_AUTOMATION'],
      [
        'an unknown time zone',
        { schedule: { cron: '0 9 * * *', timeZone: 'Mars/Base' } },
        'INVALID_AUTOMATION',
      ],
      ['an unknown SSH host', { target: { kind: 'ssh', hostId: 'gone' } }, 'INVALID_AUTOMATION'],
      ['an unknown preset', { presetId: 'missing' }, 'INVALID_PRESET'],
      ['a grace period the editor lacks', { missedRunGraceMinutes: 45 }, 'INVALID_AUTOMATION'],
      ['a blank prompt', { prompt: '   ' }, 'INVALID_AUTOMATION'],
    ] as const)('rejects %s before asking', async (_label, overrides, code) => {
      const { service, approve, getAutomations } = withHost();
      const read = await service.readAutomations({ terminalId: 'terminal-1' });
      const added = {
        name: 'New',
        prompt: 'Do it',
        target: { kind: 'local' as const },
        schedule: { cron: '0 9 * * *' },
        ...overrides,
      };

      await expect(
        service.proposeAutomations(
          { terminalId: 'terminal-1' },
          { automations: [...read.automations, added] }
        )
      ).rejects.toMatchObject({ code });
      expect(approve).not.toHaveBeenCalled();
      expect(getAutomations()).toHaveLength(3);
    });

    it('rejects editing an SSH automation whose agent is not on this computer without a preset', async () => {
      const { service, approve } = withHost();
      const read = await service.readAutomations({ terminalId: 'terminal-1' });

      await expect(
        service.proposeAutomations(
          { terminalId: 'terminal-1' },
          {
            automations: read.automations.map((automation) =>
              automation.id === 'triage'
                ? { ...automation, prompt: 'Triage everything' }
                : automation
            ),
          }
        )
      ).rejects.toMatchObject({ code: 'INVALID_PRESET' });
      expect(approve).not.toHaveBeenCalled();
    });

    it('keeps an unchanged automation whose preset was removed while changing others', async () => {
      const { service, approve, getAutomations, setAutomations } = withHost();
      setAutomations(
        getAutomations().map((automation) =>
          automation.id === 'nightly' ? { ...automation, presetId: 'removed' } : automation
        )
      );
      const read = await service.readAutomations({ terminalId: 'terminal-1' });

      const result = await service.proposeAutomations(
        { terminalId: 'terminal-1' },
        {
          automations: [
            ...read.automations,
            {
              name: 'New',
              prompt: 'Do it',
              target: { kind: 'local' },
              schedule: { cron: '0 9 * * *' },
            },
          ],
        }
      );

      expect(approve).toHaveBeenCalledTimes(1);
      expect(result.status).toBe('applied');
    });

    it('rejects an agent that can’t start with a prompt where it runs before asking', async () => {
      const { service, approve, automationDeps } = withHost();
      automationDeps.agentProblem.mockReturnValue('Shell can’t start with a prompt.');

      await expect(
        service.proposeAutomations(
          { terminalId: 'terminal-1' },
          {
            automations: [
              {
                name: 'New',
                prompt: 'Do it',
                target: { kind: 'local' },
                schedule: { cron: '0 9 * * *' },
              },
            ],
          }
        )
      ).rejects.toMatchObject({
        code: 'INVALID_AUTOMATION',
        message: '“New”: Shell can’t start with a prompt.',
      });
      expect(approve).not.toHaveBeenCalled();
    });

    it('rejects a new SSH automation when the project can’t run on hosts before asking', async () => {
      const { service, approve, automationDeps } = withHost();
      automationDeps.hostProblem.mockResolvedValue(
        'Add a Git remote to Komla to run it on an SSH host.'
      );
      const read = await service.readAutomations({ terminalId: 'terminal-1' });

      await expect(
        service.proposeAutomations(
          { terminalId: 'terminal-1' },
          {
            automations: [
              ...read.automations,
              {
                name: 'Remote',
                prompt: 'Do it',
                target: { kind: 'ssh', hostId: 'ssh-1' },
                presetId: 'preset-1',
                schedule: { cron: '0 9 * * *' },
              },
            ],
          }
        )
      ).rejects.toMatchObject({
        code: 'INVALID_AUTOMATION',
        message: '“Remote”: Add a Git remote to Komla to run it on an SSH host.',
      });
      expect(approve).not.toHaveBeenCalled();
    });

    it('rejects SSH automations for folder projects', async () => {
      const { service, projects } = withHost();
      projects[0].kind = 'directory';

      await expect(
        service.proposeAutomations(
          { terminalId: 'terminal-1' },
          {
            automations: [
              {
                name: 'Remote',
                prompt: 'Do it',
                target: { kind: 'ssh', hostId: 'ssh-1' },
                schedule: { cron: '0 9 * * *' },
              },
            ],
          }
        )
      ).rejects.toMatchObject({ code: 'INVALID_AUTOMATION' });
    });

    it('changes nothing when the automations changed while the user decided', async () => {
      const { service, approve, automationDeps, getAutomations, setAutomations } = withHost();
      approve.mockImplementation(async () => {
        setAutomations(getAutomations().filter(({ id }) => id !== 'triage'));
        return true;
      });

      await expect(
        service.proposeAutomations({ terminalId: 'terminal-1' }, { automations: [] })
      ).rejects.toMatchObject({ code: 'STALE_VERSION', status: 412 });
      expect(automationDeps.delete).not.toHaveBeenCalled();
    });

    it('reads the hosts again after the user decides, not what was last read', async () => {
      const {
        service,
        approve,
        automationDeps,
        automationSnapshots,
        getAutomations,
        setAutomations,
      } = withHost();
      const lastRead = await automationSnapshots();
      automationDeps.list.mockResolvedValue(lastRead);
      approve.mockImplementation(async () => {
        setAutomations(getAutomations().filter(({ id }) => id !== 'triage'));
        return true;
      });

      await expect(
        service.proposeAutomations({ terminalId: 'terminal-1' }, { automations: [] })
      ).rejects.toMatchObject({ code: 'STALE_VERSION', status: 412 });
    });

    it('says which automation failed and that the changes before it were applied', async () => {
      const { service, automationDeps, feedback } = withHost();
      automationDeps.delete.mockRejectedValueOnce(new Error('ssh: connect timed out'));

      await expect(
        service.proposeAutomations({ terminalId: 'terminal-1' }, { automations: [] })
      ).rejects.toMatchObject({
        code: 'AUTOMATION_CHANGE_FAILED',
        message:
          'Couldn’t change the automation “Nightly deps”: ssh: connect timed out. Changes listed before it were applied.',
      });
      expect(feedback).toHaveBeenCalled();
    });

    it('saves before deleting, so a failed save keeps what it was replacing', async () => {
      const { service, automationDeps, getAutomations } = withHost();
      automationDeps.save.mockRejectedValueOnce(new Error('The host is unreachable.'));
      const read = await service.readAutomations({ terminalId: 'terminal-1' });

      await expect(
        service.proposeAutomations(
          { terminalId: 'terminal-1' },
          {
            automations: [
              ...read.automations.filter(({ id }) => id !== 'nightly'),
              {
                name: 'Nightly deps',
                prompt: 'Update dependencies',
                target: { kind: 'ssh', hostId: 'ssh-1' },
                presetId: 'preset-1',
                schedule: { cron: '0 2 * * *' },
              },
            ],
          }
        )
      ).rejects.toMatchObject({ code: 'AUTOMATION_CHANGE_FAILED' });
      expect(automationDeps.delete).not.toHaveBeenCalled();
      expect(getAutomations().map(({ id }) => id)).toContain('nightly');
    });

    it('applies nothing when the user cancels', async () => {
      const { service, approve, automationDeps } = withHost();
      approve.mockResolvedValue(false);

      const result = await service.proposeAutomations(
        { terminalId: 'terminal-1' },
        { automations: [] }
      );

      expect(result).toEqual({ status: 'cancelled', applied: false });
      expect(automationDeps.delete).not.toHaveBeenCalled();
    });
  });
});
