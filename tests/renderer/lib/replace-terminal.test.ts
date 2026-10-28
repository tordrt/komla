/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/renderer/lib/terminal-renderer-runtime', () => ({
  getTerminalRendererDimensions: () => ({ cols: 120, rows: 30 }),
}));

import { findPaneByTerminalId, getAllLeaves } from '../../../src/renderer/lib/layout-utils';
import {
  replaceTerminal,
  replaceTerminalWithPaneSurface,
  type TerminalReplacement,
} from '../../../src/renderer/lib/replace-terminal';
import { useAgentPresetsStore } from '../../../src/renderer/stores/agent-presets.store';
import { useLayoutStore } from '../../../src/renderer/stores/layout.store';
import { useNotesStore } from '../../../src/renderer/stores/notes.store';
import { usePaneSurfacesStore } from '../../../src/renderer/stores/pane-surfaces.store';
import {
  claimTerminal,
  useTerminalBusyStore,
} from '../../../src/renderer/stores/terminal-busy.store';
import {
  setTerminalClosing,
  useTerminalCloseStore,
} from '../../../src/renderer/stores/terminal-close.store';
import { useToastStore } from '../../../src/renderer/stores/toast.store';
import { useWorkspacesStore } from '../../../src/renderer/stores/workspaces.store';
import { createTerminal, createWorkspace } from '../../factories';
import { createDeferred } from '../../setup';

import type { Terminal, Workspace } from '../../../src/renderer/types';

const sshBackend = {
  kind: 'ssh',
  hostId: 'ssh-devbox',
  remoteDirectory: '/remote/worktree',
  remoteRepoPath: '/remote/repo.git',
  remoteProjectRoot: '/remote',
  gitUrl: 'git@github.com:example/repo.git',
} as const;

const agent: TerminalReplacement = {
  kind: 'agent',
  name: 'Claude Code',
  presetId: 'claude',
  launchModeId: null,
};
const savedPrompt: TerminalReplacement = {
  kind: 'saved-prompt',
  name: 'Review',
  command: 'claude Review',
  presetId: 'claude',
  launchModeId: 'plan',
};
const terminalCommand: TerminalReplacement = {
  kind: 'terminal-command',
  name: 'Run tests',
  command: 'npm test',
  commandKind: 'host',
};

let restartTerminal: ReturnType<typeof vi.fn>;
let setActivePreset: ReturnType<typeof vi.fn>;

function seed(terminal: Partial<Terminal> = {}, workspace: Partial<Workspace> = {}): void {
  useWorkspacesStore.setState({
    workspaces: [
      createWorkspace({
        id: 'ws-1',
        terminals: [createTerminal({ id: 'term-1', status: 'running', ...terminal })],
        ...workspace,
      }),
    ],
    selectedWorkspaceId: 'ws-1',
  });
}

const answer = (confirmed: boolean) => vi.fn().mockResolvedValue(confirmed);

describe('replaceTerminal', () => {
  beforeEach(() => {
    useWorkspacesStore.setState(useWorkspacesStore.getInitialState(), true);
    useAgentPresetsStore.setState(useAgentPresetsStore.getInitialState(), true);
    useTerminalBusyStore.setState(useTerminalBusyStore.getInitialState(), true);
    useTerminalCloseStore.setState(useTerminalCloseStore.getInitialState(), true);
    useToastStore.setState(useToastStore.getInitialState(), true);
    restartTerminal = vi.fn().mockResolvedValue({});
    setActivePreset = vi.fn().mockResolvedValue(undefined);
    Object.assign(window, {
      api: {
        restartTerminal,
        setActivePreset,
        getWorkspaces: vi.fn(async () => useWorkspacesStore.getState().workspaces),
        getWorkspaceQuota: vi
          .fn()
          .mockResolvedValue({ allowed: true, count: 0, limit: 4, isLicensed: false }),
      },
    });
  });

  describe('a Terminal whose agent is working', () => {
    it('replaces an idle Terminal without asking', async () => {
      seed();
      const confirm = answer(true);

      await expect(replaceTerminal('term-1', agent, confirm)).resolves.toBe('replaced');

      expect(confirm).not.toHaveBeenCalled();
      expect(restartTerminal).toHaveBeenCalledWith('term-1', 'claude', null, 120, 30, {
        replaceSession: true,
      });
      expect(setActivePreset).toHaveBeenCalledWith('claude', null);
    });

    it('asks before replacing an agent that is still working', async () => {
      seed({ agentActive: true });
      const confirm = answer(true);

      await expect(replaceTerminal('term-1', agent, confirm)).resolves.toBe('replaced');

      expect(confirm).toHaveBeenCalledWith({
        title: 'Replace with Claude Code?',
        description:
          'The agent in this pane is still working. Replacing it stops its current turn and starts Claude Code in its place.',
        confirmLabel: 'Replace',
      });
      expect(restartTerminal).toHaveBeenCalledOnce();
    });

    it('asks before replacing a command run with `komla notify --` that is still running', async () => {
      seed({ agentActive: true, commandActive: true });
      const confirm = answer(true);

      await replaceTerminal('term-1', agent, confirm);

      expect(confirm).toHaveBeenCalledWith(
        expect.objectContaining({
          description:
            'The command in this pane is still running. Replacing it stops the command and starts Claude Code in its place.',
        })
      );
    });

    it('keeps the working agent when the replacement is declined', async () => {
      seed({ agentActive: true });

      await expect(replaceTerminal('term-1', agent, answer(false))).resolves.toBe('declined');

      expect(restartTerminal).not.toHaveBeenCalled();
      expect(setActivePreset).not.toHaveBeenCalled();
    });

    it.each([
      [savedPrompt, 'Review'],
      [terminalCommand, 'Run tests'],
      [{ kind: 'local-copy-shell' } as const, 'Local Terminal'],
      [{ kind: 'ssh-shell' } as const, 'SSH Terminal'],
      [{ kind: 'remote-retry', plainShell: false } as const, 'a new agent session'],
      [{ kind: 'remote-retry', plainShell: true } as const, 'a remote shell'],
    ])('asks before a %o replacement', async (replacement, name) => {
      seed({ agentActive: true }, { backend: sshBackend });
      const confirm = answer(false);

      await expect(replaceTerminal('term-1', replacement, confirm)).resolves.toBe('declined');

      expect(confirm).toHaveBeenCalledWith(
        expect.objectContaining({ title: `Replace with ${name}?` })
      );
      expect(restartTerminal).not.toHaveBeenCalled();
    });

    it('finds the Terminal in a workspace that is not selected', async () => {
      seed({ agentActive: true });
      useWorkspacesStore.setState((state) => ({
        workspaces: [...state.workspaces, createWorkspace({ id: 'ws-2', terminals: [] })],
        selectedWorkspaceId: 'ws-2',
      }));
      const confirm = answer(false);

      await replaceTerminal('term-1', agent, confirm);

      expect(confirm).toHaveBeenCalledOnce();
    });
  });

  describe('what it starts', () => {
    it('starts a Saved Prompt with its agent preset and launch mode', async () => {
      seed();

      await replaceTerminal('term-1', savedPrompt, answer(true));

      expect(restartTerminal).toHaveBeenCalledWith('term-1', 'claude', 'plan', 120, 30, {
        command: 'claude Review',
        commandKind: 'agent',
        replaceSession: true,
      });
      expect(setActivePreset).not.toHaveBeenCalled();
    });

    it.each([
      ['an SSH Workspace repository', 'workspace'],
      ['a Local copy', 'local-mirror'],
    ] as const)(
      'replaces the remote session when an agent starts from %s',
      async (_label, executionLocation) => {
        seed({ executionLocation }, { backend: sshBackend });

        await replaceTerminal('term-1', agent, answer(true));
        await replaceTerminal('term-1', savedPrompt, answer(true));

        expect(restartTerminal).toHaveBeenNthCalledWith(1, 'term-1', 'claude', null, 120, 30, {
          replaceSession: true,
        });
        expect(restartTerminal).toHaveBeenNthCalledWith(2, 'term-1', 'claude', 'plan', 120, 30, {
          command: 'claude Review',
          commandKind: 'agent',
          replaceSession: true,
        });
      }
    );

    it.each([
      ['an SSH Workspace repository', sshBackend, 'workspace', true],
      ['a Local copy', sshBackend, 'local-mirror', false],
      ['a local workspace', undefined, 'workspace', false],
    ] as const)(
      'replaces the remote session for a Terminal Command in %s: %s',
      async (_label, backend, executionLocation, replaceSession) => {
        seed({ executionLocation }, { backend });

        await replaceTerminal('term-1', terminalCommand, answer(true));

        expect(restartTerminal).toHaveBeenCalledWith('term-1', undefined, undefined, 120, 30, {
          command: 'npm test',
          commandKind: 'host',
          replaceSession,
        });
      }
    );

    it('opens a Local copy shell', async () => {
      seed({}, { backend: sshBackend });

      await replaceTerminal('term-1', { kind: 'local-copy-shell' }, answer(true));

      expect(restartTerminal).toHaveBeenCalledWith('term-1', undefined, undefined, 120, 30, {
        executionLocation: 'local-mirror',
      });
    });

    it('moves a Local copy terminal back to a shell on the SSH host', async () => {
      seed({ executionLocation: 'local-mirror' }, { backend: sshBackend });

      await replaceTerminal('term-1', { kind: 'ssh-shell' }, answer(true));

      expect(restartTerminal).toHaveBeenCalledWith('term-1', undefined, undefined, 120, 30, {
        plainShell: true,
        replaceSession: true,
        executionLocation: 'workspace',
      });
    });

    it('retries a remote agent or opens a remote shell, replacing the remote session', async () => {
      seed({ status: 'stopped' }, { backend: sshBackend });

      await replaceTerminal('term-1', { kind: 'remote-retry', plainShell: false }, answer(true));
      await replaceTerminal('term-1', { kind: 'remote-retry', plainShell: true }, answer(true));

      expect(restartTerminal).toHaveBeenNthCalledWith(1, 'term-1', undefined, undefined, 120, 30, {
        replaceSession: true,
      });
      expect(restartTerminal).toHaveBeenNthCalledWith(2, 'term-1', undefined, undefined, 120, 30, {
        plainShell: true,
        replaceSession: true,
      });
    });
  });

  describe('a Terminal that is still reconnecting or starting', () => {
    it('marks a remote retry busy until it finishes', async () => {
      seed({ status: 'stopped' }, { backend: sshBackend });
      const restart = createDeferred<unknown>();
      restartTerminal.mockReturnValueOnce(restart.promise);

      const first = replaceTerminal(
        'term-1',
        { kind: 'remote-retry', plainShell: false },
        answer(true)
      );

      expect(useTerminalBusyStore.getState().busyTerminals.get('term-1')).toBe('remote-agent');
      restart.resolve({});
      await expect(first).resolves.toBe('replaced');
      expect(useTerminalBusyStore.getState().busyTerminals.has('term-1')).toBe(false);
    });

    it.each([
      [
        'reconnect',
        'This pane is still reconnecting. Replacing it stops the reconnect and starts Claude Code in its place.',
      ],
      [
        'remote-agent',
        'This pane is still starting. Replacing it stops that and starts Claude Code in its place.',
      ],
    ] as const)('asks before replacing a Terminal busy with %s', async (reason, description) => {
      seed({}, { backend: sshBackend });
      claimTerminal('term-1', reason);
      const confirm = answer(false);

      await expect(replaceTerminal('term-1', agent, confirm)).resolves.toBe('declined');

      expect(confirm).toHaveBeenCalledWith({
        title: 'Replace with Claude Code?',
        description,
        confirmLabel: 'Replace',
      });
      expect(restartTerminal).not.toHaveBeenCalled();
      expect(useTerminalBusyStore.getState().busyTerminals.get('term-1')).toBe(reason);
    });

    it.each([
      agent,
      savedPrompt,
      terminalCommand,
      { kind: 'local-copy-shell' } as const,
      { kind: 'remote-retry', plainShell: true } as const,
    ])('replaces a reconnecting Terminal with a %o once the user confirms', async (replacement) => {
      seed({}, { backend: sshBackend });
      claimTerminal('term-1', 'reconnect');
      const confirm = answer(true);

      await expect(replaceTerminal('term-1', replacement, confirm)).resolves.toBe('replaced');

      expect(confirm).toHaveBeenCalledOnce();
      expect(restartTerminal).toHaveBeenCalledOnce();
    });

    it('lets another replacement take over one that is still starting', async () => {
      seed({ executionLocation: 'local-mirror' }, { backend: sshBackend });
      const restart = createDeferred<unknown>();
      restartTerminal.mockReturnValueOnce(restart.promise);

      const first = replaceTerminal('term-1', terminalCommand, answer(true));

      expect(useTerminalBusyStore.getState().busyTerminals.has('term-1')).toBe(false);
      await expect(replaceTerminal('term-1', agent, answer(true))).resolves.toBe('replaced');
      expect(restartTerminal).toHaveBeenCalledTimes(2);

      restart.resolve({});
      await expect(first).resolves.toBe('replaced');
    });

    it('leaves a Terminal that is closing alone', async () => {
      seed();
      setTerminalClosing('term-1', true);
      const confirm = answer(true);

      await expect(replaceTerminal('term-1', agent, confirm)).resolves.toBe('closing');

      expect(confirm).not.toHaveBeenCalled();
      expect(restartTerminal).not.toHaveBeenCalled();
    });
  });

  describe('a replacement that fails', () => {
    it.each([
      [agent, 'Claude Code'],
      [savedPrompt, 'Review'],
      [terminalCommand, 'Run tests'],
      [{ kind: 'local-copy-shell' } as const, 'Local Terminal'],
      [{ kind: 'remote-retry', plainShell: false } as const, 'a new agent session'],
    ])('reports a failed %o replacement instead of throwing', async (replacement, name) => {
      seed({}, { backend: sshBackend });
      restartTerminal.mockRejectedValueOnce(new Error('host unreachable'));

      await expect(replaceTerminal('term-1', replacement, answer(true))).resolves.toBe('failed');

      expect(useToastStore.getState().toasts).toEqual([
        expect.objectContaining({
          message: `Couldn't start ${name} in this pane: host unreachable`,
          type: 'error',
        }),
      ]);
      expect(useTerminalBusyStore.getState().busyTerminals.size).toBe(0);
    });
  });
});

describe('replaceTerminalWithPaneSurface', () => {
  let removeTerminal: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    useWorkspacesStore.setState(useWorkspacesStore.getInitialState(), true);
    useTerminalCloseStore.setState(useTerminalCloseStore.getInitialState(), true);
    useLayoutStore.setState(useLayoutStore.getInitialState(), true);
    usePaneSurfacesStore.setState({ surfaces: {} });
    seed();
    useWorkspacesStore.setState((state) => ({
      workspaces: state.workspaces.map((workspace) => ({
        ...workspace,
        terminals: [...workspace.terminals, createTerminal({ id: 'term-2', status: 'running' })],
      })),
    }));
    removeTerminal = vi.fn().mockResolvedValue(undefined);
    useWorkspacesStore.setState({ removeTerminal });
    useLayoutStore.getState().setCurrentWorkspace('ws-1', 'term-1');
    useLayoutStore.getState().splitPane('vertical', 'term-2');
  });

  function leafIds(): string[] {
    const { layoutsByTab, getActiveTabId } = useLayoutStore.getState();
    return getAllLeaves(layoutsByTab['ws-1'][getActiveTabId()!]).map((leaf) => leaf.terminalId);
  }

  function paneOf(terminalId: string): string {
    const { layoutsByTab, getActiveTabId } = useLayoutStore.getState();
    return findPaneByTerminalId(layoutsByTab['ws-1'][getActiveTabId()!], terminalId)!.id;
  }

  it("opens a browser in the Terminal's place and closes the Terminal", async () => {
    await replaceTerminalWithPaneSurface(
      'ws-1',
      'term-1',
      paneOf('term-1'),
      'browser',
      answer(true)
    );

    const [surfaceId, neighbour] = leafIds();
    expect(neighbour).toBe('term-2');
    expect(usePaneSurfacesStore.getState().surfaces[surfaceId]?.kind).toBe('browser');
    expect(removeTerminal).toHaveBeenCalledWith('ws-1', 'term-1');
  });

  it('asks first when the agent is working, and keeps the Terminal when declined', async () => {
    useWorkspacesStore.setState((state) => ({
      workspaces: state.workspaces.map((workspace) => ({
        ...workspace,
        terminals: workspace.terminals.map((terminal) =>
          terminal.id === 'term-1' ? { ...terminal, agentActive: true } : terminal
        ),
      })),
    }));
    const confirm = answer(false);

    await replaceTerminalWithPaneSurface('ws-1', 'term-1', paneOf('term-1'), 'browser', confirm);

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Replace with a browser?' })
    );
    expect(leafIds()).toEqual(['term-1', 'term-2']);
    expect(removeTerminal).not.toHaveBeenCalled();
  });

  it("keeps the Terminal when the note can't start", async () => {
    useNotesStore.setState({ create: vi.fn().mockRejectedValue(new Error('disk full')) });

    await replaceTerminalWithPaneSurface('ws-1', 'term-1', paneOf('term-1'), 'note', answer(true));

    expect(leafIds()).toEqual(['term-1', 'term-2']);
    expect(removeTerminal).not.toHaveBeenCalled();
  });
});
