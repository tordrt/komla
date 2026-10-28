/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSshWorkspace, createTerminal, createWorkspace } from '../../factories';
import {
  ShortcutProvider,
  SSH_STEP_COMMIT_DELAY_MS,
} from '../../../src/renderer/components/ShortcutProvider';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../../../src/renderer/components/ui/dialog';
import { closePaneBrowserTab } from '../../../src/renderer/lib/pane-surfaces';
import { executeShortcutAction } from '../../../src/renderer/lib/shortcut-actions';
import { useQuickLookStore } from '../../../src/renderer/stores/quick-look.store';

const {
  workspaceState,
  selectWorkspace,
  setWorkspaceState,
  shortcutActions,
  addToast,
  voiceState,
  layoutActions,
  layoutState,
  voiceInputOptions,
} = vi.hoisted(() => {
  const state = {
    workspaces: [],
    selectedWorkspaceId: null,
    hideStopped: false,
    hiddenProjectIds: new Set<string>(),
    keyboardNavigationWorkspaceId: null,
    selectWorkspace: vi.fn(),
    showDashboard: false,
    displayOrderedWorkspaceIds: null,
    hiddenWorkspaceHostIds: new Set<string>(),
    dashboardHiddenWorkspaceHostIds: new Set<string>(),
    selectionMode: false,
    selectedWorkspaceIds: new Set<string>(),
    addTerminal: vi.fn(),
    addAgentTab: vi.fn(),
    stopWorkspace: vi.fn(),
    trashWorkspaceWithUndo: vi.fn(),
    trashSelectedWorkspaces: vi.fn(),
    deleteSelectedWorkspaces: vi.fn(),
  };
  return {
    workspaceState: state,
    selectWorkspace: state.selectWorkspace,
    setWorkspaceState: vi.fn((updates) => Object.assign(state, updates)),
    shortcutActions: new Map<string, (event?: KeyboardEvent) => void>(),
    addToast: vi.fn(),
    voiceState: {
      modelStatus: 'not-downloaded' as string,
      loadModelStatus: vi.fn(),
    },
    layoutActions: {
      addTab: vi.fn(),
      showTabInFullPane: vi.fn(),
      selectNextTab: vi.fn(),
      selectPreviousTab: vi.fn(),
    },
    layoutState: {} as Record<string, unknown>,
    voiceInputOptions: {
      current: null as {
        captureTarget?: () => string | null;
        onTranscription: (text: string, target: string | null) => void;
      } | null,
    },
  };
});

vi.mock('../../../src/renderer/stores/workspaces.store', () => ({
  useWorkspacesStore: Object.assign(() => workspaceState, {
    getState: () => workspaceState,
    setState: setWorkspaceState,
  }),
}));

vi.mock('../../../src/renderer/stores/window.store', () => ({
  useWindowStore: (selector: (state: { windowId: string }) => unknown) =>
    selector({ windowId: 'window-1' }),
}));

vi.mock('../../../src/renderer/stores/layout.store', () => ({
  useLayoutStore: Object.assign(() => layoutActions, { getState: () => layoutState }),
}));

vi.mock('../../../src/renderer/stores/file-viewer.store', () => ({
  useFileViewerStore: Object.assign(
    () => ({
      openFileViewer: vi.fn(),
      requestInlineFilePreviewClose: vi.fn(),
      toggleInlineFileTree: vi.fn(),
      requestFileViewerTransition: vi.fn(),
      requestCloseViewer: vi.fn(),
    }),
    { getState: () => ({}) }
  ),
}));

vi.mock('../../../src/renderer/stores/agent-presets.store', () => ({
  useAgentPresetsStore: { getState: () => ({ presets: [], activePresets: [] }) },
}));
vi.mock('../../../src/renderer/stores/config.store', () => ({
  useConfigStore: { getState: () => ({ config: null }) },
}));
vi.mock('../../../src/renderer/stores/toast.store', () => ({
  useToastStore: { getState: () => ({ addToast, toasts: [] }) },
}));
vi.mock('../../../src/renderer/stores/voice.store', () => ({
  useVoiceStore: { getState: () => voiceState },
}));

vi.mock('../../../src/renderer/hooks/useShortcuts', () => ({
  useShortcuts: vi.fn(),
  useDoubleTapShortcuts: vi.fn(),
}));
vi.mock('../../../src/renderer/hooks/useVoiceInput', () => ({
  useVoiceInput: (options: typeof voiceInputOptions.current) => {
    voiceInputOptions.current = options;
    return {
      isStarting: false,
      isRecording: false,
      isTranscribing: false,
      levels: [],
      duration: 0,
      remainingSeconds: null,
      startRecording: vi.fn(),
      stopAndTranscribe: vi.fn(),
      cancelRecording: vi.fn(),
      cancelTranscription: vi.fn(),
    };
  },
}));
vi.mock('../../../src/renderer/lib/pane-surfaces', () => ({
  closePaneBrowserTab: vi.fn(),
}));
vi.mock('../../../src/renderer/lib/shortcut-actions', () => ({
  registerShortcutAction: (id: string, handler: (event?: KeyboardEvent) => void) => {
    shortcutActions.set(id, handler);
    return () => shortcutActions.delete(id);
  },
  executeShortcutAction: vi.fn(),
}));
vi.mock('../../../src/renderer/components/workspaces/BulkDeleteDialog', () => ({
  BulkDeleteDialog: () => null,
}));
vi.mock('../../../src/renderer/components/workspaces/BulkTrashDialog', () => ({
  needsBulkTrashConfirmation: (count: number) => count > 1,
  BulkTrashDialog: ({ open }: { open: boolean }) => (open ? <div>Trash several</div> : null),
}));
vi.mock('../../../src/renderer/components/VoiceInputOverlay', () => ({
  VoiceInputOverlay: () => null,
}));

describe('ShortcutProvider overview Escape behavior', () => {
  const remoteWorkspace = createWorkspace({
    id: 'remote',
    windowId: 'window-1',
    terminals: [createTerminal({ status: 'running' })],
    backend: {
      kind: 'ssh',
      hostId: 'ssh-devbox',
      remoteDirectory: '/home/dev/worktree',
      remoteRepoPath: '/home/dev/repo.git',
      remoteProjectRoot: '/home/dev',
      gitUrl: 'git@example.com:repo.git',
      projectName: 'Repo',
    },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(window, {
      api: {
        onPaneCloseShortcut: vi.fn(() => vi.fn()),
        onForwardedShortcut: vi.fn(() => vi.fn()),
      },
    });
    Object.assign(workspaceState, {
      workspaces: [remoteWorkspace],
      selectedWorkspaceId: 'remote',
      keyboardNavigationWorkspaceId: null,
      showDashboard: false,
      hiddenWorkspaceHostIds: new Set<string>(),
      dashboardHiddenWorkspaceHostIds: new Set<string>(),
      selectionMode: false,
      selectedWorkspaceIds: new Set<string>(),
    });
  });

  function enterOverview(rerender: (ui: React.ReactNode) => void) {
    Object.assign(workspaceState, { selectedWorkspaceId: null, showDashboard: true });
    rerender(
      <ShortcutProvider onOpenNewWorkspaceDialog={vi.fn()}>
        <div />
      </ShortcutProvider>
    );
  }

  it('returns to a workspace excluded only by the dashboard host filter', () => {
    const view = render(
      <ShortcutProvider onOpenNewWorkspaceDialog={vi.fn()}>
        <div />
      </ShortcutProvider>
    );
    workspaceState.dashboardHiddenWorkspaceHostIds = new Set(['ssh-devbox']);
    enterOverview(view.rerender);

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(selectWorkspace).toHaveBeenCalledWith('remote');
  });

  it('leaves the overview when the window has no workspaces', () => {
    workspaceState.workspaces = [];
    const view = render(
      <ShortcutProvider onOpenNewWorkspaceDialog={vi.fn()}>
        <div />
      </ShortcutProvider>
    );
    enterOverview(view.rerender);

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(setWorkspaceState).toHaveBeenCalledWith({ showDashboard: false });
  });

  it('stays in the overview when Escape closes a dialog on top of it', () => {
    const onOpenChange = vi.fn();
    const renderWithDialog = () => (
      <ShortcutProvider onOpenNewWorkspaceDialog={vi.fn()}>
        <Dialog open onOpenChange={onOpenChange}>
          <DialogContent>
            <DialogTitle>Rename workspace</DialogTitle>
            <DialogDescription>Give it a name.</DialogDescription>
          </DialogContent>
        </Dialog>
      </ShortcutProvider>
    );
    const view = render(renderWithDialog());
    Object.assign(workspaceState, { selectedWorkspaceId: null, showDashboard: true });
    view.rerender(renderWithDialog());

    fireEvent.keyDown(view.getByRole('dialog'), { key: 'Escape' });

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(selectWorkspace).not.toHaveBeenCalled();
  });

  it('returns to an SSH workspace running on its host but not attached here', () => {
    workspaceState.workspaces = [
      createWorkspace({
        id: 'local',
        windowId: 'window-1',
        terminals: [createTerminal({ status: 'running' })],
      }),
      {
        ...remoteWorkspace,
        terminals: [createTerminal({ status: 'stopped', remoteSessionOnHost: true })],
      },
    ];
    const view = renderProvider();
    enterOverview(view.rerender);

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(selectWorkspace).toHaveBeenCalledWith('remote');
  });

  it('does not return to a workspace hidden by the sidebar host filter', () => {
    const view = render(
      <ShortcutProvider onOpenNewWorkspaceDialog={vi.fn()}>
        <div />
      </ShortcutProvider>
    );
    workspaceState.hiddenWorkspaceHostIds = new Set(['ssh-devbox']);
    enterOverview(view.rerender);

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(selectWorkspace).not.toHaveBeenCalled();
  });
});

describe('ShortcutProvider repeated workspace navigation', () => {
  const workspaces = ['one', 'two', 'three'].map((id) =>
    createWorkspace({
      id,
      windowId: 'window-1',
      status: 'active',
      terminals: [createTerminal({ status: 'running' })],
    })
  );

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    shortcutActions.clear();
    Object.assign(window, {
      api: {
        onPaneCloseShortcut: vi.fn(() => vi.fn()),
        onForwardedShortcut: vi.fn(() => vi.fn()),
      },
    });
    Object.assign(workspaceState, {
      workspaces,
      selectedWorkspaceId: 'one',
      keyboardNavigationWorkspaceId: null,
      showDashboard: false,
      displayOrderedWorkspaceIds: ['one', 'two', 'three'],
      hiddenWorkspaceHostIds: new Set<string>(),
      selectionMode: false,
      selectedWorkspaceIds: new Set<string>(),
    });
  });

  afterEach(() => vi.useRealTimers());

  it('previews repeated steps and commits only the final workspace after the burst', () => {
    render(
      <ShortcutProvider onOpenNewWorkspaceDialog={vi.fn()}>
        <div />
      </ShortcutProvider>
    );

    const next = shortcutActions.get('workspace.next');
    next?.(new KeyboardEvent('keydown', { key: 'ArrowDown', repeat: true }));
    next?.(new KeyboardEvent('keydown', { key: 'ArrowDown', repeat: true }));

    expect(selectWorkspace).not.toHaveBeenCalled();
    expect(workspaceState.keyboardNavigationWorkspaceId).toBe('three');

    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowDown' }));

    expect(selectWorkspace).toHaveBeenCalledTimes(1);
    expect(selectWorkspace).toHaveBeenCalledWith('three');
    expect(workspaceState.keyboardNavigationWorkspaceId).toBeNull();
  });

  it('does not commit between slow repeated keydown events', () => {
    render(
      <ShortcutProvider onOpenNewWorkspaceDialog={vi.fn()}>
        <div />
      </ShortcutProvider>
    );

    const next = shortcutActions.get('workspace.next');
    next?.(new KeyboardEvent('keydown', { key: 'ArrowDown', repeat: true }));

    vi.advanceTimersByTime(1_000);

    expect(selectWorkspace).not.toHaveBeenCalled();

    next?.(new KeyboardEvent('keydown', { key: 'ArrowDown', repeat: true }));
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowDown' }));

    expect(selectWorkspace).toHaveBeenCalledTimes(1);
    expect(selectWorkspace).toHaveBeenCalledWith('three');
  });

  it('commits when modifiers change the released key value', () => {
    render(
      <ShortcutProvider onOpenNewWorkspaceDialog={vi.fn()}>
        <div />
      </ShortcutProvider>
    );

    shortcutActions.get('workspace.next')?.(
      new KeyboardEvent('keydown', { key: 'J', code: 'KeyJ', shiftKey: true, repeat: true })
    );

    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'j', code: 'KeyJ' }));

    expect(selectWorkspace).toHaveBeenCalledTimes(1);
    expect(selectWorkspace).toHaveBeenCalledWith('two');
    expect(workspaceState.keyboardNavigationWorkspaceId).toBeNull();
  });

  it('commits when the modifier is released first, since macOS sends no keyup for the arrow', () => {
    render(
      <ShortcutProvider onOpenNewWorkspaceDialog={vi.fn()}>
        <div />
      </ShortcutProvider>
    );

    const next = shortcutActions.get('workspace.next');
    const repeat = { key: 'ArrowDown', code: 'ArrowDown', metaKey: true, repeat: true };
    next?.(new KeyboardEvent('keydown', repeat));
    next?.(new KeyboardEvent('keydown', repeat));

    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Meta', code: 'MetaLeft' }));

    expect(selectWorkspace).toHaveBeenCalledTimes(1);
    expect(selectWorkspace).toHaveBeenCalledWith('three');
    expect(workspaceState.keyboardNavigationWorkspaceId).toBeNull();
  });

  it('cancels a pending preview when the active workspace is explicitly reselected', async () => {
    render(
      <ShortcutProvider onOpenNewWorkspaceDialog={vi.fn()}>
        <div />
      </ShortcutProvider>
    );

    shortcutActions.get('workspace.next')?.(
      new KeyboardEvent('keydown', { key: 'ArrowDown', repeat: true })
    );
    expect(workspaceState.keyboardNavigationWorkspaceId).toBe('two');

    selectWorkspace.mockImplementationOnce(async () => {
      workspaceState.keyboardNavigationWorkspaceId = null;
    });
    await workspaceState.selectWorkspace('one');
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowDown' }));

    expect(selectWorkspace).toHaveBeenCalledTimes(1);
    expect(selectWorkspace).toHaveBeenCalledWith('one');
  });

  it('moves the sidebar highlight on a single press, and loads the workspace a frame later', () => {
    render(
      <ShortcutProvider onOpenNewWorkspaceDialog={vi.fn()}>
        <div />
      </ShortcutProvider>
    );

    shortcutActions.get('workspace.next')?.(new KeyboardEvent('keydown'));

    expect(workspaceState.keyboardNavigationWorkspaceId).toBe('two');
    expect(selectWorkspace).not.toHaveBeenCalled();

    vi.runAllTimers();

    expect(selectWorkspace).toHaveBeenCalledTimes(1);
    expect(selectWorkspace).toHaveBeenCalledWith('two');
    expect(workspaceState.keyboardNavigationWorkspaceId).toBeNull();
  });

  it('loads only the last workspace of presses that land within one frame', () => {
    render(
      <ShortcutProvider onOpenNewWorkspaceDialog={vi.fn()}>
        <div />
      </ShortcutProvider>
    );

    const next = shortcutActions.get('workspace.next');
    next?.(new KeyboardEvent('keydown'));
    next?.(new KeyboardEvent('keydown'));
    vi.runAllTimers();

    expect(selectWorkspace).toHaveBeenCalledTimes(1);
    expect(selectWorkspace).toHaveBeenCalledWith('three');
  });

  it('leaves a press that turns into a held key to commit on release', () => {
    render(
      <ShortcutProvider onOpenNewWorkspaceDialog={vi.fn()}>
        <div />
      </ShortcutProvider>
    );

    const next = shortcutActions.get('workspace.next');
    next?.(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown' }));
    next?.(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', repeat: true }));
    vi.runAllTimers();

    expect(selectWorkspace).not.toHaveBeenCalled();

    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowDown', code: 'ArrowDown' }));

    expect(selectWorkspace).toHaveBeenCalledTimes(1);
    expect(selectWorkspace).toHaveBeenCalledWith('three');
  });

  it('steps onto an SSH workspace running on its host but not attached here, past stopped ones', () => {
    workspaceState.workspaces = [
      workspaces[0],
      createSshWorkspace({
        id: 'stopped',
        windowId: 'window-1',
        status: 'active',
        terminals: [createTerminal({ status: 'stopped', remoteSessionActive: false })],
      }),
      createSshWorkspace({
        id: 'remote',
        windowId: 'window-1',
        status: 'active',
        terminals: [createTerminal({ status: 'stopped', remoteSessionOnHost: true })],
      }),
    ];
    workspaceState.displayOrderedWorkspaceIds = ['one', 'stopped', 'remote'];
    renderProvider();

    shortcutActions.get('workspace.next')?.(new KeyboardEvent('keydown'));

    expect(workspaceState.keyboardNavigationWorkspaceId).toBe('remote');
  });

  describe('onto an SSH workspace that selecting connects', () => {
    beforeEach(() => {
      workspaceState.workspaces = [
        workspaces[0],
        createSshWorkspace({
          id: 'remote',
          windowId: 'window-1',
          status: 'active',
          terminals: [createTerminal({ status: 'stopped', remoteSessionOnHost: true })],
        }),
        workspaces[1],
      ];
      workspaceState.displayOrderedWorkspaceIds = ['one', 'remote', 'two'];
    });

    it('connects only once presses stop, even after the key is released', () => {
      renderProvider();

      shortcutActions.get('workspace.next')?.(
        new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown' })
      );
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowDown', code: 'ArrowDown' }));
      vi.advanceTimersByTime(SSH_STEP_COMMIT_DELAY_MS - 1);

      expect(workspaceState.keyboardNavigationWorkspaceId).toBe('remote');
      expect(selectWorkspace).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);

      expect(selectWorkspace).toHaveBeenCalledTimes(1);
      expect(selectWorkspace).toHaveBeenCalledWith('remote');
    });

    it('never connects to one it only steps past', () => {
      renderProvider();
      const next = shortcutActions.get('workspace.next');

      next?.(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown' }));
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowDown', code: 'ArrowDown' }));
      vi.advanceTimersByTime(SSH_STEP_COMMIT_DELAY_MS / 2);
      next?.(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown' }));
      vi.runAllTimers();

      expect(selectWorkspace).toHaveBeenCalledTimes(1);
      expect(selectWorkspace).toHaveBeenCalledWith('two');
    });
  });
});

function renderProvider() {
  return render(
    <ShortcutProvider onOpenNewWorkspaceDialog={vi.fn()}>
      <div />
    </ShortcutProvider>
  );
}

describe('ShortcutProvider stop workspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    shortcutActions.clear();
    Object.assign(window, {
      api: {
        onPaneCloseShortcut: vi.fn(() => vi.fn()),
        onForwardedShortcut: vi.fn(() => vi.fn()),
      },
    });
    Object.assign(workspaceState, {
      selectedWorkspaceId: 'remote',
      showDashboard: false,
      selectionMode: false,
      selectedWorkspaceIds: new Set<string>(),
    });
  });

  it('stops a workspace whose tmux session runs on its host, e.g. on another device', () => {
    workspaceState.workspaces = [
      createSshWorkspace({
        id: 'remote',
        windowId: 'window-1',
        terminals: [createTerminal({ status: 'stopped', remoteSessionOnHost: true })],
      }),
    ];
    renderProvider();

    shortcutActions.get('workspace.stop')?.();

    expect(workspaceState.stopWorkspace).toHaveBeenCalledWith('remote');
  });

  it('ignores a stopped workspace', () => {
    workspaceState.workspaces = [
      createSshWorkspace({
        id: 'remote',
        windowId: 'window-1',
        terminals: [createTerminal({ status: 'stopped', remoteSessionActive: false })],
      }),
    ];
    renderProvider();

    shortcutActions.get('workspace.stop')?.();

    expect(workspaceState.stopWorkspace).not.toHaveBeenCalled();
  });
});

describe('ShortcutProvider trash workspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    shortcutActions.clear();
    Object.assign(window, {
      api: {
        onPaneCloseShortcut: vi.fn(() => vi.fn()),
        onForwardedShortcut: vi.fn(() => vi.fn()),
      },
    });
    Object.assign(workspaceState, {
      workspaces: [
        createWorkspace({ id: 'ws-1', windowId: 'window-1' }),
        createWorkspace({ id: 'ws-2', windowId: 'window-1' }),
      ],
      selectedWorkspaceId: 'ws-1',
      showDashboard: false,
      selectionMode: false,
      selectedWorkspaceIds: new Set<string>(),
    });
  });

  it('trashes the open workspace, offering to undo it', () => {
    renderProvider();

    act(() => shortcutActions.get('workspace.trash')?.());

    expect(workspaceState.trashWorkspaceWithUndo).toHaveBeenCalledWith('ws-1');
  });

  it('asks before trashing several selected workspaces', () => {
    Object.assign(workspaceState, {
      selectionMode: true,
      selectedWorkspaceIds: new Set(['ws-1', 'ws-2']),
    });
    renderProvider();

    act(() => shortcutActions.get('workspace.trash')?.());

    expect(screen.getByText('Trash several')).toBeInTheDocument();
    expect(workspaceState.trashSelectedWorkspaces).not.toHaveBeenCalled();
    expect(workspaceState.trashWorkspaceWithUndo).not.toHaveBeenCalled();
  });

  it('trashes a single selected workspace right away', () => {
    Object.assign(workspaceState, {
      selectionMode: true,
      selectedWorkspaceIds: new Set(['ws-2']),
    });
    renderProvider();

    act(() => shortcutActions.get('workspace.trash')?.());

    expect(workspaceState.trashSelectedWorkspaces).toHaveBeenCalled();
    expect(screen.queryByText('Trash several')).not.toBeInTheDocument();
  });
});

describe('ShortcutProvider jump to the next workspace needing input', () => {
  const needsInput = { kind: 'input-required' as const, source: 'claude-code', updatedAt: 1 };
  const failed = { kind: 'error' as const, source: 'claude-code', updatedAt: 1 };
  const ws = (id: string, overrides: Partial<Parameters<typeof createWorkspace>[0]> = {}) =>
    createWorkspace({
      id,
      windowId: 'window-1',
      status: 'active',
      terminals: [createTerminal({ status: 'running' })],
      ...overrides,
    });

  beforeEach(() => {
    vi.clearAllMocks();
    shortcutActions.clear();
    Object.assign(window, {
      api: {
        onPaneCloseShortcut: vi.fn(() => vi.fn()),
        onForwardedShortcut: vi.fn(() => vi.fn()),
      },
    });
    Object.assign(workspaceState, {
      selectedWorkspaceId: 'one',
      keyboardNavigationWorkspaceId: null,
      showDashboard: false,
      hideStopped: false,
      hiddenProjectIds: new Set<string>(),
      hiddenWorkspaceHostIds: new Set<string>(),
      selectionMode: false,
      selectedWorkspaceIds: new Set<string>(),
    });
  });

  it('selects the next workspace that needs input, ahead of one with an error', () => {
    workspaceState.workspaces = [
      ws('one'),
      ws('two', { attention: failed }),
      ws('three', { attention: needsInput }),
    ];
    workspaceState.displayOrderedWorkspaceIds = ['one', 'two', 'three'];
    renderProvider();

    shortcutActions.get('workspace.nextAttention')?.();

    expect(selectWorkspace).toHaveBeenCalledWith('three');
  });

  it('reaches workspaces inside collapsed groups, but not hidden projects', () => {
    workspaceState.workspaces = [
      ws('one'),
      ws('hidden', { attention: needsInput, projectId: 'hidden-project' }),
      ws('collapsed', { attention: needsInput }),
    ];
    workspaceState.hiddenProjectIds = new Set(['hidden-project']);
    // Collapsed groups are left out of the sidebar's display order.
    workspaceState.displayOrderedWorkspaceIds = ['one'];
    renderProvider();

    shortcutActions.get('workspace.nextAttention')?.();

    expect(selectWorkspace).toHaveBeenCalledWith('collapsed');
  });

  it('says so when no workspace needs input', () => {
    workspaceState.workspaces = [ws('one'), ws('two')];
    workspaceState.displayOrderedWorkspaceIds = ['one', 'two'];
    renderProvider();

    shortcutActions.get('workspace.nextAttention')?.();

    expect(selectWorkspace).not.toHaveBeenCalled();
    expect(addToast).toHaveBeenCalledWith('No workspaces need input', 'info');
  });
});

describe('ShortcutProvider failure feedback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    shortcutActions.clear();
    Object.assign(window, {
      api: {
        onPaneCloseShortcut: vi.fn(() => vi.fn()),
        onForwardedShortcut: vi.fn(() => vi.fn()),
      },
    });
    Object.assign(workspaceState, {
      workspaces: [createWorkspace({ id: 'one', windowId: 'window-1' })],
      selectedWorkspaceId: 'one',
      displayOrderedWorkspaceIds: ['one'],
    });
    voiceState.modelStatus = 'not-downloaded';
    for (const key of Object.keys(layoutState)) delete layoutState[key];
  });

  it('points to voice setup when the voice shortcut fires without a model', () => {
    const openSettings = vi.fn();
    window.addEventListener('open-settings', openSettings);
    try {
      renderProvider();

      shortcutActions.get('voice.record')?.();

      expect(addToast).toHaveBeenCalledWith(
        expect.stringMatching(/voice input needs a transcription model/i),
        'info',
        expect.objectContaining({
          action: expect.objectContaining({ label: 'Set up' }),
          progress: false,
        })
      );
      addToast.mock.calls[0][2].action.onClick();
      expect(openSettings).toHaveBeenCalledWith(expect.objectContaining({ detail: 'voice' }));
    } finally {
      window.removeEventListener('open-settings', openSettings);
    }
  });

  it('types dictation into the terminal that was focused when recording stopped', () => {
    const sendInput = vi.fn();
    Object.assign(window.api, { sendInput });
    const focus = (workspaceId: string, terminalId: string) =>
      Object.assign(layoutState, {
        currentWorkspaceId: workspaceId,
        activeTabByWorkspace: { [workspaceId]: 'tab' },
        focusedPaneByTab: { [workspaceId]: { tab: 'pane' } },
        layoutsByTab: { [workspaceId]: { tab: { type: 'leaf', id: 'pane', terminalId } } },
      });
    renderProvider();
    const voice = voiceInputOptions.current!;

    focus('one', 'term-a');
    const target = voice.captureTarget!();
    focus('two', 'term-b');
    voice.onTranscription('fix the tests', target);

    expect(target).toBe('term-a');
    // The trailing space keeps the next dictation or typed word apart.
    expect(sendInput).toHaveBeenCalledWith('term-a', 'fix the tests ');

    voice.onTranscription('hello', null);
    expect(addToast).toHaveBeenCalledWith(expect.stringMatching(/no active terminal/i), 'error');

    // A focused browser or note pane has no terminal to type into.
    focus('one', 'surface:note:a');
    expect(voice.captureTarget!()).toBeNull();
  });

  it('says the voice model is still downloading instead of ignoring the shortcut', () => {
    voiceState.modelStatus = 'downloading';
    renderProvider();

    shortcutActions.get('voice.record')?.();

    expect(addToast).toHaveBeenCalledWith(
      expect.stringMatching(/still downloading/i),
      'info',
      expect.objectContaining({ action: expect.any(Object), progress: true })
    );
  });

  it('reports a failed terminal and retries it from the toast', async () => {
    workspaceState.addTerminal
      .mockRejectedValueOnce(new Error('spawn failed'))
      .mockResolvedValueOnce({ id: 'term-2' });
    renderProvider();

    shortcutActions.get('terminal.new')?.();

    await vi.waitFor(() =>
      expect(addToast).toHaveBeenCalledWith(
        'Failed to open a terminal: spawn failed',
        'error',
        expect.objectContaining({ action: expect.objectContaining({ label: 'Retry' }) })
      )
    );
    addToast.mock.calls[0][2].action.onClick();
    await vi.waitFor(() => expect(layoutActions.addTab).toHaveBeenCalledWith('one', 'term-2'));
    expect(workspaceState.addTerminal).toHaveBeenCalledTimes(2);
  });
});

describe('ShortcutProvider shortcuts forwarded from a browser preview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs the forwarded action through the shortcut dispatcher', () => {
    let forward: ((actionId: string) => void) | undefined;
    Object.assign(window, {
      api: {
        onPaneCloseShortcut: vi.fn(() => vi.fn()),
        onForwardedShortcut: vi.fn((callback: (actionId: string) => void) => {
          forward = callback;
          return vi.fn();
        }),
      },
    });
    renderProvider();

    forward?.('workspace.new');

    expect(executeShortcutAction).toHaveBeenCalledWith('workspace.new');
  });
});

describe('ShortcutProvider pane close', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useQuickLookStore.setState(useQuickLookStore.getInitialState(), true);
  });

  it('closes the file viewer rather than the pane behind it', () => {
    let closePane: (() => void) | undefined;
    Object.assign(window, {
      api: {
        onPaneCloseShortcut: vi.fn((callback: () => void) => {
          closePane = callback;
          return vi.fn();
        }),
        onForwardedShortcut: vi.fn(() => vi.fn()),
        listViewerFolder: vi.fn(async () => []),
      },
    });
    renderProvider();
    useQuickLookStore.getState().open('workspace-1', {
      path: '/tmp/report.html',
      terminalId: 'terminal-1',
      source: { kind: 'terminal', fullPath: '/tmp/report.html' },
    });

    closePane?.();
    expect(useQuickLookStore.getState().session).toBeNull();
    expect(executeShortcutAction).not.toHaveBeenCalled();

    closePane?.();
    expect(executeShortcutAction).toHaveBeenCalledWith('pane.close');
  });

  it('closes the browser pane tab the shortcut was pressed in', () => {
    let closePane: ((page?: { workspaceId: string; tabId: string }) => void) | undefined;
    Object.assign(window, {
      api: {
        onPaneCloseShortcut: vi.fn((callback: typeof closePane) => {
          closePane = callback;
          return vi.fn();
        }),
        onForwardedShortcut: vi.fn(() => vi.fn()),
      },
    });
    renderProvider();

    closePane?.({ workspaceId: 'workspace-1', tabId: 'surface:browser:a/browser-1' });

    expect(closePaneBrowserTab).toHaveBeenCalledWith('workspace-1', 'surface:browser:a/browser-1');
    expect(executeShortcutAction).not.toHaveBeenCalled();
  });
});
