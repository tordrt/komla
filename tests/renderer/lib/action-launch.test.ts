/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/renderer/lib/terminal-renderer-runtime', () => ({
  getTerminalRendererDimensions: () => ({ cols: 120, rows: 30 }),
  pasteIntoTerminalRenderer: vi.fn(() => true),
}));

import {
  launchAction,
  resolveActionText,
  type ActionPlace,
} from '../../../src/renderer/lib/action-launch';
import { findPaneByTerminalId, getAllLeaves } from '../../../src/renderer/lib/layout-utils';
import { openPaneSurface, registerPaneCloseConfirm } from '../../../src/renderer/lib/pane-surfaces';
import { pasteIntoTerminalRenderer } from '../../../src/renderer/lib/terminal-renderer-runtime';
import { useActionsStore } from '../../../src/renderer/stores/actions.store';
import { useAgentPresetsStore } from '../../../src/renderer/stores/agent-presets.store';
import { useConfigStore } from '../../../src/renderer/stores/config.store';
import { useLayoutStore } from '../../../src/renderer/stores/layout.store';
import { usePaneSurfacesStore } from '../../../src/renderer/stores/pane-surfaces.store';
import { useProjectsStore } from '../../../src/renderer/stores/projects.store';
import { useSshCommandExecutionLocationStore } from '../../../src/renderer/stores/ssh-command-execution-location.store';
import { useTerminalCloseStore } from '../../../src/renderer/stores/terminal-close.store';
import { useToastStore } from '../../../src/renderer/stores/toast.store';
import { useWorkspacesStore } from '../../../src/renderer/stores/workspaces.store';
import {
  createActivePresetEntry,
  createAgentPreset,
  createClaudePreset,
  createConfig,
  createProject,
  createSshWorkspace,
  createTerminal,
  createWorkspace,
} from '../../factories';

import type { Action, Terminal, Workspace } from '../../../src/renderer/types';

const runTests: Action = {
  id: 'run-tests',
  title: 'Run tests',
  type: 'command',
  content: 'npm test',
};
const review: Action = {
  id: 'review',
  title: 'Review',
  type: 'prompt',
  content: 'Review against {{target_branch}}',
};
const ask: Action = { id: 'ask', title: 'Ask', type: 'prompt', content: 'Explain {{user_input}}' };

const codex = createAgentPreset({ id: 'codex', name: 'Codex' });

let api: Record<string, ReturnType<typeof vi.fn>>;
let nextTerminal = 0;

function seed(workspace: Partial<Workspace> = {}, terminal: Partial<Terminal> = {}): Workspace {
  const seeded = createWorkspace({
    id: 'ws-1',
    projectId: 'project-1',
    terminals: [createTerminal({ id: 'term-1', status: 'running', ...terminal })],
    ...workspace,
  });
  useWorkspacesStore.setState({ workspaces: [seeded], selectedWorkspaceId: 'ws-1' });
  useLayoutStore.setState({ currentWorkspaceId: 'ws-1' });
  useLayoutStore.getState().addTab('ws-1', 'term-1');
  useLayoutStore.getState().setActiveTab('term-1');
  return seeded;
}

// Main adds each started terminal to its workspace, as the real IPC handlers do.
function startTerminal(): Terminal {
  const terminal = createTerminal({ id: `started-${++nextTerminal}` });
  useWorkspacesStore.setState((state) => ({
    workspaces: state.workspaces.map((w) => ({ ...w, terminals: [...w.terminals, terminal] })),
  }));
  return terminal;
}

function workspace(): Workspace {
  return useWorkspacesStore.getState().workspaces[0];
}

const launch = (action: Action, place: ActionPlace, input?: string) =>
  launchAction({ workspaceId: 'ws-1', action, place, input });

const replace = (confirm = vi.fn().mockResolvedValue(true)): ActionPlace => ({
  kind: 'replace',
  terminalId: 'term-1',
  confirm,
});
// Beside the pane of the seeded terminal, in its tab.
const split = (): ActionPlace => ({
  kind: 'split',
  paneId: useLayoutStore.getState().focusedPaneByTab['ws-1']['term-1'],
  terminalId: 'term-1',
  tabId: 'term-1',
  direction: 'horizontal',
});

beforeEach(() => {
  for (const store of [
    useWorkspacesStore,
    useLayoutStore,
    useActionsStore,
    useAgentPresetsStore,
    useConfigStore,
    useProjectsStore,
    useTerminalCloseStore,
    useToastStore,
  ]) {
    store.setState(store.getInitialState(), true);
  }
  useSshCommandExecutionLocationStore.setState({
    requestExecutionLocation: vi.fn().mockResolvedValue('workspace'),
  });
  useProjectsStore.setState({
    projects: [createProject({ id: 'project-1', baseBranch: 'develop' })],
  });
  useAgentPresetsStore.setState({
    presets: [createClaudePreset(), codex],
    activePresets: [
      createActivePresetEntry({ presetId: 'claude-code', lastUsedAt: 2 }),
      createActivePresetEntry({ presetId: 'codex', lastUsedAt: 1 }),
    ],
  });
  useConfigStore.setState({ config: createConfig() });
  vi.mocked(pasteIntoTerminalRenderer).mockClear().mockReturnValue(true);
  nextTerminal = 0;

  api = {
    getWorkspaces: vi.fn(async () => useWorkspacesStore.getState().workspaces),
    getWorkspaceQuota: vi
      .fn()
      .mockResolvedValue({ allowed: true, count: 0, limit: 4, isLicensed: false }),
    updateWorkspace: vi.fn().mockResolvedValue(undefined),
    addTerminal: vi.fn(async () => startTerminal()),
    addAgentTab: vi.fn(async () => startTerminal()),
    restartTerminal: vi.fn().mockResolvedValue(undefined),
    buildPromptCommand: vi.fn(async (prompt: string, presetId?: string) => `${presetId} ${prompt}`),
    recordActionUsage: vi.fn(async (id: string) => ({ id })),
    setActivePreset: vi.fn().mockResolvedValue(undefined),
    runBackgroundAction: vi.fn().mockResolvedValue(undefined),
  };
  Object.assign(window, { api });
});

describe('launchAction', () => {
  describe('an Action that asks for input', () => {
    it('asks first, without starting anything or becoming the default', async () => {
      seed();

      await expect(launch(ask, { kind: 'type', terminalId: 'term-1' })).resolves.toBe(
        'needs-input'
      );

      expect(pasteIntoTerminalRenderer).not.toHaveBeenCalled();
      expect(workspace().paneDefaultActionId).toBeUndefined();
      expect(api.recordActionUsage).not.toHaveBeenCalled();
    });

    it('fills in the input once given, and remembers it with the usage', async () => {
      seed();

      await expect(launch(ask, { kind: 'type', terminalId: 'term-1' }, 'the build')).resolves.toBe(
        'launched'
      );

      expect(pasteIntoTerminalRenderer).toHaveBeenCalledWith('term-1', 'Explain the build');
      expect(workspace().paneDefaultActionId).toBe('ask');
      // Pasted, so the run button's fallback to the last used Action stays as it was.
      expect(api.recordActionUsage).toHaveBeenCalledWith('ask', 'the build', true);
    });
  });

  describe('typed into a Terminal', () => {
    it("fills in the workspace's target branch from its project", async () => {
      seed();

      await launch(review, { kind: 'type', terminalId: 'term-1' });

      expect(pasteIntoTerminalRenderer).toHaveBeenCalledWith('term-1', 'Review against develop');
      expect(api.restartTerminal).not.toHaveBeenCalled();
    });

    it("fills in the workspace's path, branch and project, but not in the user's input", async () => {
      seed({ workingDirectory: '/repo/wt', branchName: 'feature/login' });
      useProjectsStore.setState({ projects: [createProject({ id: 'project-1', name: 'Komla' })] });
      const handOff = {
        ...ask,
        content: 'In {{projectName}} at {{worktreePath}} on {{branchName}}: {{user_input}}',
      };

      await launch(handOff, { kind: 'type', terminalId: 'term-1' }, 'keep {{branchName}}');

      expect(pasteIntoTerminalRenderer).toHaveBeenCalledWith(
        'term-1',
        'In Komla at /repo/wt on feature/login: keep {{branchName}}'
      );
    });

    it("fills in the workspace's values as they are, dollar signs included", async () => {
      seed({ workingDirectory: '/repo/$$', branchName: "fix/$&-$'" });
      useProjectsStore.setState({
        projects: [createProject({ id: 'project-1', name: 'Cost $1' })],
      });

      await launch(
        { ...runTests, content: '{{projectName}} {{worktreePath}} {{branchName}}' },
        { kind: 'type', terminalId: 'term-1' }
      );

      expect(pasteIntoTerminalRenderer).toHaveBeenCalledWith(
        'term-1',
        "Cost $1 /repo/$$ fix/$&-$'"
      );
    });

    it('records no usage when the terminal is gone', async () => {
      seed();
      vi.mocked(pasteIntoTerminalRenderer).mockReturnValue(false);

      await expect(launch(review, { kind: 'type', terminalId: 'term-1' })).resolves.toBe('failed');

      expect(api.recordActionUsage).not.toHaveBeenCalled();
    });
  });

  describe('in place of a Terminal', () => {
    it('restarts it with a Terminal Command', async () => {
      seed();

      await expect(launch(runTests, replace())).resolves.toBe('launched');

      expect(api.restartTerminal).toHaveBeenCalledWith('term-1', undefined, undefined, 120, 30, {
        command: 'npm test',
        commandKind: 'host',
        replaceSession: false,
      });
      // Like a new tab, it becomes the run button's; Paste Prompt keeps its own.
      expect(workspace().defaultActionId).toBe('run-tests');
      expect(workspace().paneDefaultActionId).toBeUndefined();
      expect(api.recordActionUsage).toHaveBeenCalledWith('run-tests', undefined, false);
    });

    it("restarts it with a Saved Prompt for the workspace's agent", async () => {
      seed({ presetId: 'codex' });

      await launch(review, replace());

      expect(api.buildPromptCommand).toHaveBeenCalledWith(
        'Review against develop',
        'codex',
        undefined
      );
      expect(api.restartTerminal).toHaveBeenCalledWith('term-1', 'codex', null, 120, 30, {
        command: 'codex Review against develop',
        commandKind: 'agent',
        replaceSession: true,
      });
    });

    it('starts the most recently used agent when the workspace has none', async () => {
      seed();

      await launch(review, replace());

      expect(api.buildPromptCommand).toHaveBeenCalledWith(
        'Review against develop',
        'claude-code',
        undefined
      );
    });

    it('keeps the agent a Saved Prompt names', async () => {
      seed({ presetId: 'claude-code' });

      await launch({ ...review, presetId: 'codex', launchModeId: 'plan' }, replace());

      expect(api.buildPromptCommand).toHaveBeenCalledWith(
        'Review against develop',
        'codex',
        'plan'
      );
    });

    it('is not replaced when the user keeps the working agent', async () => {
      seed({}, { agentActive: true });
      const confirm = vi.fn().mockResolvedValue(false);

      await expect(launch(runTests, replace(confirm))).resolves.toBe('not-replaced');

      expect(confirm).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Replace with Run tests?' })
      );
      expect(api.restartTerminal).not.toHaveBeenCalled();
      expect(api.recordActionUsage).not.toHaveBeenCalled();
    });

    it('is not replaced when the restart fails, and says why', async () => {
      seed();
      api.restartTerminal.mockRejectedValueOnce(new Error('host unreachable'));

      await expect(launch(ask, replace(), 'the build')).resolves.toBe('not-replaced');

      expect(useToastStore.getState().toasts).toEqual([
        expect.objectContaining({ message: "Couldn't start Ask in this pane: host unreachable" }),
      ]);
    });

    describe('in an SSH workspace', () => {
      beforeEach(() => {
        seed({ backend: createSshWorkspace().backend }, { executionLocation: 'workspace' });
      });

      it('restarts it with a Terminal Command that runs where it does', async () => {
        // The project would send its commands to the other side, but this pane was picked.
        const requestExecutionLocation = vi.mocked(
          useSshCommandExecutionLocationStore.getState().requestExecutionLocation
        );
        requestExecutionLocation.mockResolvedValue('local-mirror');

        await expect(launch(runTests, replace())).resolves.toBe('launched');

        expect(requestExecutionLocation).not.toHaveBeenCalled();
        expect(api.restartTerminal).toHaveBeenCalledWith(
          'term-1',
          undefined,
          undefined,
          120,
          30,
          expect.objectContaining({ command: 'npm test', replaceSession: true })
        );
        expect(api.addTerminal).not.toHaveBeenCalled();
      });

      it('restarts its Local copy with a Terminal Command that runs where it does', async () => {
        seed({ backend: createSshWorkspace().backend }, { executionLocation: 'local-mirror' });
        vi.mocked(
          useSshCommandExecutionLocationStore.getState().requestExecutionLocation
        ).mockResolvedValue('remote');

        await expect(launch(runTests, replace())).resolves.toBe('launched');

        expect(api.restartTerminal).toHaveBeenCalledWith(
          'term-1',
          undefined,
          undefined,
          120,
          30,
          expect.objectContaining({ command: 'npm test', replaceSession: false })
        );
        expect(api.addTerminal).not.toHaveBeenCalled();
      });

      it('opens a tab of its own for a Terminal Command bound for the Local copy, and says so', async () => {
        const requestExecutionLocation = vi.mocked(
          useSshCommandExecutionLocationStore.getState().requestExecutionLocation
        );
        requestExecutionLocation.mockResolvedValue('local-mirror');
        const action = { ...runTests, sshExecutionLocation: 'local-mirror' as const };

        await expect(launch(action, replace())).resolves.toBe('launched');

        expect(requestExecutionLocation).toHaveBeenCalledWith(
          expect.objectContaining({ id: 'ws-1' }),
          'local-mirror'
        );
        expect(api.addTerminal).toHaveBeenCalledWith(
          'ws-1',
          'Run tests',
          'npm test',
          undefined,
          'host',
          'local-mirror'
        );
        expect(useLayoutStore.getState().tabsByWorkspace['ws-1']).toEqual(['term-1', 'started-1']);
        expect(useLayoutStore.getState().activeTabByWorkspace['ws-1']).toBe('started-1');
        expect(api.restartTerminal).not.toHaveBeenCalled();
        expect(useToastStore.getState().toasts).toEqual([
          expect.objectContaining({
            message: 'Run tests runs in the Local copy, so it opened in a new tab',
          }),
        ]);
      });
    });
  });

  describe('beside a pane', () => {
    function splitTerminalIds(): string[] {
      const layout = useLayoutStore.getState().layoutsByTab['ws-1']['term-1'];
      return ['term-1', 'started-1'].filter((id) => findPaneByTerminalId(layout, id));
    }

    it('splits off a Terminal Command with its tokens filled in', async () => {
      seed();

      await expect(
        launch({ ...runTests, content: 'git diff {{target_branch}}' }, split())
      ).resolves.toBe('launched');

      expect(api.addTerminal).toHaveBeenCalledWith(
        'ws-1',
        'Run tests',
        'git diff develop',
        undefined,
        'host',
        'workspace'
      );
      expect(splitTerminalIds()).toEqual(['term-1', 'started-1']);
      expect(workspace().defaultActionId).toBe('run-tests');
      expect(workspace().paneDefaultActionId).toBeUndefined();
    });

    describe('in an SSH workspace', () => {
      it("splits off a Terminal Command where the pane runs, over the project's choice", async () => {
        seed({ backend: createSshWorkspace().backend }, { executionLocation: 'local-mirror' });
        const requestExecutionLocation = vi.mocked(
          useSshCommandExecutionLocationStore.getState().requestExecutionLocation
        );
        requestExecutionLocation.mockResolvedValue('local-mirror');

        await expect(launch(runTests, split())).resolves.toBe('launched');

        expect(requestExecutionLocation).toHaveBeenCalledWith(
          expect.objectContaining({ id: 'ws-1' }),
          'local-mirror'
        );
      });

      it('splits off a Terminal Command where it names, wherever the pane runs', async () => {
        seed({ backend: createSshWorkspace().backend }, { executionLocation: 'local-mirror' });
        const requestExecutionLocation = vi.mocked(
          useSshCommandExecutionLocationStore.getState().requestExecutionLocation
        );
        requestExecutionLocation.mockResolvedValue('remote');

        await launch({ ...runTests, sshExecutionLocation: 'remote' }, split());

        expect(requestExecutionLocation).toHaveBeenCalledWith(
          expect.objectContaining({ id: 'ws-1' }),
          'remote'
        );
      });
    });

    it("splits off a Saved Prompt as the workspace's agent, which stays the workspace's", async () => {
      seed({ presetId: 'codex' });

      await launch(review, split());

      expect(api.addAgentTab).toHaveBeenCalledWith(
        'ws-1',
        'Review against develop',
        undefined,
        'codex',
        { keepWorkspaceAgent: true }
      );
      expect(splitTerminalIds()).toEqual(['term-1', 'started-1']);
    });

    it('says so when no agent can take a Saved Prompt', async () => {
      seed();
      useAgentPresetsStore.setState({ activePresets: [] });

      await expect(launch(review, split())).resolves.toBe('failed');

      expect(api.addAgentTab).not.toHaveBeenCalled();
      expect(useToastStore.getState().toasts).toEqual([
        expect.objectContaining({ message: 'No agent preset configured for prompt commands' }),
      ]);
    });
  });

  describe('in place of a browser, note or file pane', () => {
    // A note split off the seeded terminal, and the place that takes the note's pane.
    function openNote(): { surfaceId: string; place: ActionPlace } {
      const surfaceId = openPaneSurface(
        'ws-1',
        { kind: 'note', workspaceId: 'ws-1', name: 'a.md' },
        { kind: 'split', direction: 'vertical' }
      );
      const layout = useLayoutStore.getState().layoutsByTab['ws-1']['term-1'];
      const paneId = findPaneByTerminalId(layout, surfaceId)!.id;
      return { surfaceId, place: { kind: 'replace-surface', surfaceId, paneId, tabId: 'term-1' } };
    }

    function leafIds(): string[] {
      const layout = useLayoutStore.getState().layoutsByTab['ws-1']['term-1'];
      return getAllLeaves(layout).map((leaf) => leaf.terminalId);
    }

    beforeEach(() => usePaneSurfacesStore.setState({ surfaces: {} }));

    it('opens a Terminal Command where the pane was and closes the pane', async () => {
      seed();
      const { surfaceId, place } = openNote();

      await expect(launch(runTests, place)).resolves.toBe('launched');

      expect(leafIds()).toEqual(['term-1', 'started-1']);
      expect(usePaneSurfacesStore.getState().surfaces[surfaceId]).toBeUndefined();
      expect(workspace().defaultActionId).toBe('run-tests');
    });

    it('keeps the pane when nothing starts', async () => {
      seed();
      useAgentPresetsStore.setState({ activePresets: [] });
      const { surfaceId, place } = openNote();

      await expect(launch(review, place)).resolves.toBe('failed');

      expect(leafIds()).toEqual(['term-1', surfaceId]);
    });

    describe('with unsaved edits', () => {
      const watchCi: Action = { ...runTests, id: 'watch-ci', background: true };
      let confirmDiscard: ReturnType<typeof vi.fn>;
      let unregister: () => void;

      function openEditedFile(): { surfaceId: string; place: ActionPlace } {
        const { surfaceId, place } = openNote();
        usePaneSurfacesStore.setState((state) => ({
          surfaces: {
            ...state.surfaces,
            [surfaceId]: { kind: 'file', workspaceId: 'ws-1', path: 'a.ts', dirty: true },
          },
        }));
        return { surfaceId, place };
      }

      beforeEach(() => {
        confirmDiscard = vi.fn().mockResolvedValue(false);
        unregister = registerPaneCloseConfirm(confirmDiscard);
      });
      afterEach(() => unregister());

      it('asks before replacing the pane, and keeps it when declined', async () => {
        seed();
        const { surfaceId, place } = openEditedFile();

        await expect(launch(runTests, place)).resolves.toBe('not-replaced');

        expect(confirmDiscard).toHaveBeenCalledTimes(1);
        expect(api.addTerminal).not.toHaveBeenCalled();
        expect(leafIds()).toEqual(['term-1', surfaceId]);
      });

      it('asks only once the input has been given', async () => {
        seed();
        const { place } = openEditedFile();

        await expect(launch(ask, place)).resolves.toBe('needs-input');

        expect(confirmDiscard).not.toHaveBeenCalled();
      });

      it("doesn't ask for a background command, which leaves the pane", async () => {
        seed();
        const { surfaceId, place } = openEditedFile();

        await expect(launch(watchCi, place)).resolves.toBe('launched');

        expect(confirmDiscard).not.toHaveBeenCalled();
        expect(leafIds()).toEqual(['term-1', surfaceId]);
      });
    });
  });

  describe('in a new tab', () => {
    it("opens a Terminal Command and makes it the workspace's default", async () => {
      seed();

      await expect(launch(runTests, { kind: 'tab' })).resolves.toBe('launched');

      expect(api.addTerminal).toHaveBeenCalledWith(
        'ws-1',
        'Run tests',
        'npm test',
        undefined,
        'host',
        'workspace'
      );
      expect(useLayoutStore.getState().tabsByWorkspace['ws-1']).toEqual(['term-1', 'started-1']);
      expect(workspace().defaultActionId).toBe('run-tests');
      expect(workspace().paneDefaultActionId).toBeUndefined();
    });

    it("opens a Saved Prompt as the workspace's agent and shows its tab", async () => {
      seed({ presetId: 'codex' });

      await launch(review, { kind: 'tab' });

      expect(api.addAgentTab).toHaveBeenCalledWith(
        'ws-1',
        'Review against develop',
        undefined,
        'codex',
        { keepWorkspaceAgent: true }
      );
      expect(useLayoutStore.getState().activeTabByWorkspace['ws-1']).toBe('started-1');
    });

    it('starts the agent a Saved Prompt names', async () => {
      seed({ presetId: 'claude-code' });

      await launch({ ...review, presetId: 'codex', launchModeId: 'plan' }, { kind: 'tab' });

      expect(api.addAgentTab).toHaveBeenCalledWith(
        'ws-1',
        'Review against develop',
        'plan',
        'codex',
        { keepWorkspaceAgent: true }
      );
    });

    it('fills in the tokens of a Terminal Command, asking for its input first', async () => {
      seed();
      const deploy = { ...runTests, content: 'deploy {{user_input}} --base {{target_branch}}' };

      await expect(launch(deploy, { kind: 'tab' })).resolves.toBe('needs-input');
      await launch(deploy, { kind: 'tab' }, 'staging');

      expect(api.addTerminal).toHaveBeenCalledTimes(1);
      expect(api.addTerminal).toHaveBeenCalledWith(
        'ws-1',
        'Run tests',
        'deploy staging --base develop',
        undefined,
        'host',
        'workspace'
      );
    });

    it("can leave the workspace's default as it was", async () => {
      seed({ defaultActionId: 'review' });

      await launch(runTests, { kind: 'tab', setsDefault: false });

      expect(workspace().defaultActionId).toBe('review');
      expect(api.recordActionUsage).toHaveBeenCalledWith('run-tests', undefined, false);
    });

    it('opens the tab in its own workspace when another is on screen', async () => {
      seed();
      const other = createWorkspace({
        id: 'ws-2',
        projectId: 'project-1',
        terminals: [createTerminal({ id: 'term-2', status: 'running' })],
      });
      useWorkspacesStore.setState((state) => ({ workspaces: [...state.workspaces, other] }));

      await launchAction({ workspaceId: 'ws-2', action: review, place: { kind: 'tab' } });

      const layout = useLayoutStore.getState();
      expect(layout.currentWorkspaceId).toBe('ws-1');
      expect(layout.tabsByWorkspace).toEqual({
        'ws-1': ['term-1'],
        'ws-2': ['term-2', 'started-1'],
      });
      expect(layout.activeTabByWorkspace).toEqual({ 'ws-1': 'term-1', 'ws-2': 'started-1' });
    });

    it("opens a Terminal Command's tab behind the others unless asked to bring it to the front", async () => {
      seed();

      await launch(runTests, { kind: 'tab' });
      expect(useLayoutStore.getState().activeTabByWorkspace['ws-1']).toBe('term-1');

      await launch(runTests, { kind: 'tab', front: true });
      expect(useLayoutStore.getState().activeTabByWorkspace['ws-1']).toBe('started-2');
    });

    it('says so when the terminal does not start', async () => {
      seed();
      api.addTerminal.mockRejectedValueOnce(new Error('spawn failed'));

      await expect(launch(runTests, { kind: 'tab' })).resolves.toBe('failed');

      expect(useToastStore.getState().toasts).toEqual([
        expect.objectContaining({ message: 'Failed to create terminal: spawn failed' }),
      ]);
      expect(api.recordActionUsage).not.toHaveBeenCalled();
    });
  });

  describe('a background Terminal Command', () => {
    const watchCi: Action = {
      id: 'watch-ci',
      title: 'Watch CI',
      type: 'command',
      content: 'gh pr checks --watch {{target_branch}}',
      background: true,
    };

    it('runs without a Terminal wherever it is launched, its tokens filled in', async () => {
      for (const place of [(): ActionPlace => ({ kind: 'tab' }), split, () => replace()]) {
        seed();
        api.runBackgroundAction.mockClear();
        api.recordActionUsage.mockClear();

        await expect(launch(watchCi, place())).resolves.toBe('launched');

        expect(api.runBackgroundAction).toHaveBeenCalledWith('ws-1', 'watch-ci', {
          command: 'gh pr checks --watch develop',
          executionLocation: 'workspace',
        });
        expect(api.recordActionUsage).toHaveBeenCalledWith('watch-ci', undefined, false);
      }
      expect(api.addTerminal).not.toHaveBeenCalled();
      expect(api.restartTerminal).not.toHaveBeenCalled();
      expect(useLayoutStore.getState().tabsByWorkspace['ws-1']).toEqual(['term-1']);
    });

    it('is only text typed into a Terminal', async () => {
      seed();

      await launch(watchCi, { kind: 'type', terminalId: 'term-1' });

      expect(pasteIntoTerminalRenderer).toHaveBeenCalledWith(
        'term-1',
        'gh pr checks --watch develop'
      );
      expect(api.runBackgroundAction).not.toHaveBeenCalled();
    });

    it('starts nothing when the user picks no place to run it', async () => {
      seed();
      useSshCommandExecutionLocationStore.setState({
        requestExecutionLocation: vi.fn().mockResolvedValue(null),
      });

      await expect(launch(watchCi, { kind: 'tab' })).resolves.toBe('failed');

      expect(api.runBackgroundAction).not.toHaveBeenCalled();
      expect(api.recordActionUsage).not.toHaveBeenCalled();
    });
  });

  it("gives a new workspace's command its tokens, leaving input it never asked for", () => {
    const created = seed({ branchName: 'feature/login' });

    expect(
      resolveActionText(
        { ...runTests, content: 'git log {{target_branch}}..{{branchName}} {{user_input}}' },
        created
      )
    ).toBe('git log develop..feature/login {{user_input}}');
  });

  it('says so when the launch fails before anything starts', async () => {
    seed();
    api.buildPromptCommand.mockRejectedValueOnce(new Error('no preset'));

    await expect(launch(review, replace())).resolves.toBe('failed');

    expect(useToastStore.getState().toasts).toEqual([
      expect.objectContaining({ message: 'Failed to run quick command' }),
    ]);
    expect(api.recordActionUsage).not.toHaveBeenCalled();
  });

  it('starts nothing in a workspace that is gone', async () => {
    seed();

    await expect(
      launchAction({ workspaceId: 'gone', action: runTests, place: { kind: 'tab' } })
    ).resolves.toBe('failed');

    expect(api.addTerminal).not.toHaveBeenCalled();
  });
});
