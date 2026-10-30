/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { createPortal } from 'react-dom';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { WorkspaceCard } from '../../../../src/renderer/components/workspaces/WorkspaceCard';
import { useAutomationsStore } from '../../../../src/renderer/stores/automations.store';
import {
  dismissLaunchUndo,
  LAUNCH_UNDO_MS,
  offerLaunchUndo,
} from '../../../../src/renderer/stores/launch-undo.store';
import { useSshHostsStore } from '../../../../src/renderer/stores/ssh-hosts.store';
import {
  createDirectoryWorkspace,
  createSshWorkspace,
  createTerminal,
  createWorktreeWorkspace,
} from '../../../factories';

import type { WorkspaceTagDefinition } from '../../../../src/shared/lib/workspace-tags';
import type { Workspace, WorkspaceAttention } from '../../../../src/shared/types';

vi.mock('@phosphor-icons/react', async (importOriginal) => {
  const icons = await importOriginal<typeof import('@phosphor-icons/react')>();
  return {
    ...icons,
    Cloud: (props: React.SVGProps<SVGSVGElement>) => <svg data-testid="cloud-icon" {...props} />,
    GitBranch: (props: React.SVGProps<SVGSVGElement>) => (
      <svg data-testid="branch-icon" {...props} />
    ),
  };
});

const configState = {
  config: {
    alwaysShowBranchNameInWorkspaceCards: true,
    compactWorkspaceList: false,
    showAgentSpinner: true,
    statusBarHiddenItems: [] as string[],
    workspaceTags: undefined as WorkspaceTagDefinition[] | undefined,
  },
};

vi.mock('../../../../src/renderer/stores/config.store', () => ({
  useConfigStore: Object.assign(
    <T,>(selector: (state: typeof configState) => T) => selector(configState),
    { getState: () => configState }
  ),
}));

const workspacesState = {
  workspaces: [] as Workspace[],
  selectedWorkspaceId: null as string | null,
  keyboardNavigationWorkspaceId: null as string | null,
  selectWorkspace: vi.fn(),
  stopWorkspace: vi.fn(),
  restartWorkspace: vi.fn(),
  deleteWorkspace: vi.fn(),
  setWorkspaceTrashed: vi.fn(),
  trashWorkspaceWithUndo: vi.fn(),
  updateWorkspace: vi.fn(),
  moveWorkspaceToWindow: vi.fn(),
  markUnread: vi.fn(),
  setPinned: vi.fn(),
  setTag: vi.fn(),
  snoozeWorkspace: vi.fn(),
  selectionMode: false,
  selectedWorkspaceIds: new Set<string>(),
  enterSelectionMode: vi.fn(),
  toggleWorkspaceSelection: vi.fn(),
  shiftSelectWorkspaces: vi.fn(),
};

// Subscribed like the real store, so a test can change state and see which cards re-render.
const workspacesListeners = new Set<() => void>();
const notifyWorkspacesStore = () => workspacesListeners.forEach((listener) => listener());

vi.mock('../../../../src/renderer/stores/workspaces.store', () => ({
  useWorkspacesStore: Object.assign(
    <T,>(selector?: (state: typeof workspacesState) => T) =>
      React.useSyncExternalStore(
        (listener) => {
          workspacesListeners.add(listener);
          return () => workspacesListeners.delete(listener);
        },
        () => (selector ? selector(workspacesState) : workspacesState)
      ),
    { getState: () => workspacesState }
  ),
}));

const fileViewerState = {
  fileViewerWorkspaceId: null as string | null,
  fileViewerMode: 'browse',
  fileViewerInitialFilePath: null,
  fileViewerHistoryFilterPath: null,
  inlineFilePreviewByWorkspace: {},
  inlineFileTreeByWorkspace: {} as Record<
    string,
    { comparisonBranch: string | null; useMergeBase: boolean }
  >,
  openFileViewer: vi.fn(),
  closeFileViewer: vi.fn(),
  openInlineFilePreview: vi.fn(),
};

vi.mock('../../../../src/renderer/stores/file-viewer.store', () => ({
  useFileViewerStore: Object.assign(
    <T,>(selector?: (state: typeof fileViewerState) => T) =>
      selector ? selector(fileViewerState) : fileViewerState,
    { getState: () => fileViewerState }
  ),
}));

const layoutState = {
  activeTabByWorkspace: {},
  layoutsByTab: {},
};

vi.mock('../../../../src/renderer/stores/layout.store', () => ({
  useLayoutStore: <T,>(selector?: (state: typeof layoutState) => T) =>
    selector ? selector(layoutState) : layoutState,
}));

const windowState = {
  windowId: 'window-1',
  availableWindows: [],
};

vi.mock('../../../../src/renderer/stores/window.store', () => ({
  useWindowStore: <T,>(selector?: (state: typeof windowState) => T) =>
    selector ? selector(windowState) : windowState,
}));

const gitStatusState = {
  statusMap: new Map<string, unknown>(),
  getStatus: (workspaceId: string) => gitStatusState.statusMap.get(workspaceId),
  invalidateStatus: vi.fn(),
  fetchStatus: vi.fn().mockResolvedValue({ currentBranch: 'feature' }),
};

vi.mock('../../../../src/renderer/stores/git-status.store', () => {
  const useGitStatusStore = Object.assign(
    <T,>(selector: (state: typeof gitStatusState) => T) => selector(gitStatusState),
    { getState: () => gitStatusState }
  );
  return { useGitStatusStore };
});

const fileListState = {
  invalidate: vi.fn(),
  invalidateBranchComparisonDiffs: vi.fn(),
  fetchDiff: vi.fn().mockResolvedValue({
    files: [],
    summary: { additions: 0, deletions: 0, filesChanged: 0 },
  }),
  getDiff:
    vi.fn<
      (
        ...args: unknown[]
      ) =>
        | { data: { files: unknown[]; summary: { additions: number; deletions: number } } }
        | undefined
    >(),
};

vi.mock('../../../../src/renderer/stores/file-list.store', () => ({
  useFileListStore: Object.assign(
    <T,>(selector: (state: typeof fileListState) => T) => selector(fileListState),
    { getState: () => fileListState }
  ),
}));

const toastState = { addToast: vi.fn() };

vi.mock('../../../../src/renderer/stores/toast.store', () => ({
  useToastStore: {
    getState: () => toastState,
  },
}));

vi.mock('../../../../src/renderer/components/workspaces/BulkContextMenu', () => ({
  BulkContextMenuContent: () => null,
}));

vi.mock('../../../../src/renderer/components/workspaces/ColorPickerSubmenu', () => ({
  ColorPickerSubmenu: () => null,
}));

vi.mock('../../../../src/renderer/components/workspaces/file-viewer/FileViewerDialog', () => ({
  FileViewerDialog: ({ open }: { open: boolean }) => (
    <div data-testid="file-viewer-dialog" data-open={String(open)} />
  ),
}));

vi.mock('../../../../src/renderer/components/workspaces/GitStatusIndicator', () => ({
  GitStatusIndicator: ({ muteDiffStats }: { muteDiffStats?: boolean }) => (
    <>
      <button type="button" data-own-tooltip data-mute-diff-stats={String(!!muteDiffStats)}>
        Git status action
      </button>
      {/* Portalled like its dialogs, so clicks on it bubble through React only. */}
      {createPortal(<div data-testid="git-status-dialog-backdrop" />, document.body)}
    </>
  ),
}));

vi.mock('../../../../src/renderer/components/workspaces/LinkWorkspacesDialog', () => ({
  LinkWorkspacesDialog: ({ open }: { open: boolean }) => (
    <div data-testid="link-workspaces-dialog" data-open={String(open)} />
  ),
}));

vi.mock('../../../../src/renderer/components/ui/button', () => ({
  Button: React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement>>(
    ({ children, ...props }, ref) => (
      <button ref={ref} {...props}>
        {children}
      </button>
    )
  ),
}));

vi.mock('../../../../src/renderer/components/ui/context-menu', () => ({
  ContextMenuCheckboxItem: ({
    children,
    checked,
    onClick,
  }: {
    children: React.ReactNode;
    checked?: boolean;
    onClick?: () => void;
  }) => (
    <div role="menuitemcheckbox" aria-checked={checked} onClick={onClick}>
      {children}
    </div>
  ),
  ContextMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ContextMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ContextMenuItem: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
  ContextMenuSeparator: () => <div />,
  ContextMenuShortcut: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  ContextMenuSub: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="context-submenu">{children}</div>
  ),
  ContextMenuSubContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ContextMenuSubTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('../../../../src/renderer/components/ui/dialog', () => {
  const DialogOpenContext = React.createContext(false);
  return {
    Dialog: ({ children, open }: { children: React.ReactNode; open: boolean }) => (
      <DialogOpenContext.Provider value={open}>{children}</DialogOpenContext.Provider>
    ),
    // Like Radix: mounted only while open, and runs onOpenAutoFocus once on open.
    DialogContent: ({
      children,
      onOpenAutoFocus,
    }: {
      children: React.ReactNode;
      onOpenAutoFocus?: (event: Event) => void;
    }) => {
      const open = React.useContext(DialogOpenContext);
      const onOpenAutoFocusRef = React.useRef(onOpenAutoFocus);
      onOpenAutoFocusRef.current = onOpenAutoFocus;
      React.useEffect(() => {
        if (open) onOpenAutoFocusRef.current?.(new Event('focus', { cancelable: true }));
      }, [open]);
      return open ? <div role="dialog">{children}</div> : null;
    },
    DialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  };
});

vi.mock('../../../../src/renderer/components/ui/input', () => ({
  Input: React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
    (props, ref) => <input ref={ref} {...props} />
  ),
}));

vi.mock('../../../../src/renderer/components/ui/switch', () => ({
  Switch: ({
    onCheckedChange,
    checked,
  }: {
    checked?: boolean;
    onCheckedChange?: (checked: boolean) => void;
  }) => (
    <input
      type="checkbox"
      checked={checked}
      onChange={(event) => onCheckedChange?.(event.target.checked)}
      readOnly={!onCheckedChange}
    />
  ),
}));

vi.mock('../../../../src/renderer/components/ui/popover', () => {
  const PopoverContext = React.createContext<{
    open: boolean;
    onOpenChange: (open: boolean) => void;
  } | null>(null);

  return {
    Popover: ({
      children,
      open,
      onOpenChange,
    }: {
      children: React.ReactNode;
      open: boolean;
      onOpenChange: (open: boolean) => void;
    }) => (
      <PopoverContext.Provider value={{ open, onOpenChange }}>{children}</PopoverContext.Provider>
    ),
    PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    PopoverContent: React.forwardRef<
      HTMLDivElement,
      React.HTMLAttributes<HTMLDivElement> & {
        onCloseAutoFocus?: (event: { preventDefault: () => void }) => void;
        onEscapeKeyDown?: (event: KeyboardEvent) => void;
        onOpenAutoFocus?: (event: { preventDefault: () => void }) => void;
      }
    >(
      (
        {
          children,
          onCloseAutoFocus,
          onEscapeKeyDown,
          onOpenAutoFocus: _onOpenAutoFocus,
          onKeyDown,
          ...props
        },
        ref
      ) => {
        const context = React.useContext(PopoverContext);
        if (!context?.open) return null;
        return createPortal(
          <div
            ref={ref}
            data-testid="workspace-info-content"
            {...props}
            onKeyDown={(event) => {
              onKeyDown?.(event);
              if (event.key !== 'Escape') return;
              onEscapeKeyDown?.(event.nativeEvent);
              context.onOpenChange(false);
              onCloseAutoFocus?.({ preventDefault: vi.fn() });
            }}
          >
            {children}
          </div>,
          document.body
        );
      }
    ),
  };
});

vi.mock('../../../../src/renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  // Portalled like the real tooltip, so pointer events from it bubble through React only.
  TooltipContent: ({ children }: { children: React.ReactNode }) =>
    createPortal(<div data-testid="tooltip-content">{children}</div>, document.body),
}));

function setGitStatus(
  workspaceId: string,
  status: {
    hasRemote?: boolean;
    unpushedCommits?: number;
    aheadTargetBranch?: number;
    behindTargetBranch?: number;
    rebaseInProgress?: boolean;
  }
) {
  gitStatusState.statusMap.set(workspaceId, {
    status: {
      behindTargetBranch: 0,
      aheadTargetBranch: 0,
      mainBranch: 'main',
      defaultBranch: 'main',
      hasRemote: false,
      hasOriginRemote: true,
      unpushedCommits: 0,
      behindRemote: 0,
      currentBranch: 'feature/login',
      targetBranchHasRemote: true,
      targetBranchAheadRemote: 0,
      targetBranchBehindRemote: 0,
      ...status,
    },
    lastFetched: 0,
    isLoading: false,
  });
}

/** The agents' lines in the open details, each as its state, its terminal, its words and since when. */
function detailsAgentTexts(): string[] {
  return within(screen.getByRole('list', { name: 'Agents' }))
    .getAllByRole('listitem')
    .map((agent) => agent.textContent ?? '');
}

function openDeleteDialog(workspaceId: string) {
  act(() => {
    window.dispatchEvent(new CustomEvent('delete-workspace', { detail: workspaceId }));
  });
  return screen.getByRole('dialog');
}

describe('WorkspaceCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configState.config.alwaysShowBranchNameInWorkspaceCards = true;
    configState.config.compactWorkspaceList = false;
    configState.config.workspaceTags = undefined;
    configState.config.showAgentSpinner = true;
    configState.config.statusBarHiddenItems = [];
    workspacesState.selectedWorkspaceId = null;
    workspacesState.keyboardNavigationWorkspaceId = null;
    workspacesState.selectedWorkspaceIds = new Set<string>();
    fileViewerState.inlineFilePreviewByWorkspace = {};
    fileViewerState.inlineFileTreeByWorkspace = {};
    fileViewerState.fileViewerWorkspaceId = null;
    layoutState.activeTabByWorkspace = {};
    layoutState.layoutsByTab = {};
    useSshHostsStore.setState({ hosts: [] });
    gitStatusState.statusMap = new Map();
    fileListState.getDiff.mockReturnValue(undefined);
    Element.prototype.scrollIntoView = vi.fn();
    window.api = {
      updateWorkspace: vi.fn(),
      refreshGitStatus: vi.fn().mockResolvedValue(undefined),
      copyToClipboard: vi.fn(),
      getWorkspacePullRequestStatus: vi.fn().mockResolvedValue({ kind: 'none' }),
    } as any;
  });

  it('re-renders only the cards whose selection changes when switching workspaces', () => {
    const [first, second, third] = ['One', 'Two', 'Three'].map((name) =>
      createWorktreeWorkspace({ name })
    );
    workspacesState.selectedWorkspaceId = first.id;
    const renders = new Map<string, number>();
    render(
      <>
        {[first, second, third].map((workspace) => (
          <React.Profiler
            key={workspace.id}
            id={workspace.id}
            onRender={() => renders.set(workspace.id, (renders.get(workspace.id) ?? 0) + 1)}
          >
            <WorkspaceCard workspace={workspace} />
          </React.Profiler>
        ))}
      </>
    );
    const switchTo = (change: () => void) => {
      renders.clear();
      act(() => {
        change();
        notifyWorkspacesStore();
      });
    };

    switchTo(() => (workspacesState.selectedWorkspaceId = second.id));
    expect([...renders.keys()].sort()).toEqual([first.id, second.id].sort());

    // Holding the shortcut moves only the highlight.
    switchTo(() => (workspacesState.keyboardNavigationWorkspaceId = third.id));
    expect([...renders.keys()].sort()).toEqual([second.id, third.id].sort());
  });

  it('mounts the file viewer only once it has been opened for this workspace', async () => {
    const workspace = createWorktreeWorkspace({ name: 'Feature Workspace' });

    const { rerender } = render(<WorkspaceCard workspace={workspace} />);
    expect(screen.queryByTestId('file-viewer-dialog')).toBeNull();

    fileViewerState.fileViewerWorkspaceId = workspace.id;
    rerender(<WorkspaceCard workspace={{ ...workspace }} />);
    expect(await screen.findByTestId('file-viewer-dialog')).toHaveAttribute('data-open', 'true');

    fileViewerState.fileViewerWorkspaceId = null;
    rerender(<WorkspaceCard workspace={{ ...workspace }} />);
    expect(screen.getByTestId('file-viewer-dialog')).toHaveAttribute('data-open', 'false');
  });

  // A closed dialog on every card re-rendered the whole sidebar's worth on each workspace update.
  it('mounts the link dialog only once it has been opened', () => {
    render(<WorkspaceCard workspace={createWorktreeWorkspace()} />);
    expect(screen.queryByTestId('link-workspaces-dialog')).toBeNull();

    fireEvent.click(screen.getByText('Link Workspaces...'));
    expect(screen.getByTestId('link-workspaces-dialog')).toHaveAttribute('data-open', 'true');
  });

  describe('branch name, always shown', () => {
    const branchName = 'agent/card-test';
    const cardText = () => screen.getByRole('button', { name: /^Workspace details for / });

    it('has a line under the title, even beside git status and links', () => {
      const workspace = createWorktreeWorkspace({ branchName, linkedWorkspaceIds: ['other'] });
      setGitStatus(workspace.id, { aheadTargetBranch: 2 });
      fileListState.getDiff.mockReturnValue({
        data: { files: [], summary: { additions: 3, deletions: 1 } },
      });

      render(<WorkspaceCard workspace={workspace} />);

      expect(within(cardText()).getByText(branchName)).toBeInTheDocument();
      fireEvent.focus(cardText());
      expect(screen.getAllByText(branchName)).toHaveLength(1);
    });

    it.each([
      ['Setting up...', { provisioning: true }],
      ['Setup failed', { provisionError: 'It broke' }],
    ])('gives its line to "%s"', (status, overrides) => {
      render(<WorkspaceCard workspace={createWorktreeWorkspace({ branchName, ...overrides })} />);

      expect(within(cardText()).getByText(status)).toBeInTheDocument();
      expect(screen.queryByText(branchName)).toBeNull();
    });

    it('keeps a setup failure beside a notification body, which takes the line', () => {
      render(
        <WorkspaceCard
          workspace={createWorktreeWorkspace({
            branchName,
            provisionError: 'It broke',
            attention: {
              kind: 'generic',
              source: 'custom-hook',
              updatedAt: 1000,
              title: 'Review ready',
              body: 'Authentication changes are waiting.',
            },
          })}
        />
      );

      expect(within(cardText()).getByText('Authentication changes are waiting.')).toBeVisible();
      expect(within(cardText()).queryByText('Setup failed')).toBeNull();
      expect(screen.getByText('Setup failed')).toBeInTheDocument();
    });
  });

  describe('branch name, shown when there is room', () => {
    const branchName = 'agent/card-test';

    beforeEach(() => {
      configState.config.alwaysShowBranchNameInWorkspaceCards = false;
    });

    /** How many times the branch shows: on the card, and in the details once they're opened. */
    function branchShownOn(workspace: Workspace) {
      render(<WorkspaceCard workspace={workspace} />);
      const onCard = screen.queryAllByText(branchName).length;
      fireEvent.focus(screen.getByRole('button', { name: /^Workspace details for / }));
      return { onCard, inDetails: screen.getAllByText(branchName).length - onCard };
    }

    it('fills the activity row of a clean workspace, leaving it out of the details', () => {
      const workspace = createWorktreeWorkspace({ branchName, lastActivityAt: Date.now() });
      setGitStatus(workspace.id, {});

      expect(branchShownOn(workspace)).toEqual({ onCard: 1, inDetails: 0 });
    });

    it('shows while the git status has yet to load', () => {
      expect(branchShownOn(createWorktreeWorkspace({ branchName }))).toEqual({
        onCard: 1,
        inDetails: 0,
      });
    });

    it.each([
      ['commits ahead', { aheadTargetBranch: 2 }],
      ['commits behind', { behindTargetBranch: 1 }],
      ['a paused rebase', { rebaseInProgress: true }],
    ])('moves to the details beside %s', (_label, status) => {
      const workspace = createWorktreeWorkspace({ branchName });
      setGitStatus(workspace.id, status);

      expect(branchShownOn(workspace)).toEqual({ onCard: 0, inDetails: 1 });
    });

    it('moves to the details beside diff stats', () => {
      const workspace = createWorktreeWorkspace({ branchName });
      setGitStatus(workspace.id, {});
      fileListState.getDiff.mockReturnValue({
        data: { files: [], summary: { additions: 3, deletions: 1 } },
      });

      expect(branchShownOn(workspace)).toEqual({ onCard: 0, inDetails: 1 });
    });

    it('moves to the details beside a linked workspaces count', () => {
      const workspace = createWorktreeWorkspace({ branchName, linkedWorkspaceIds: ['other'] });

      expect(branchShownOn(workspace)).toEqual({ onCard: 0, inDetails: 1 });
    });

    it('takes the row beside a notification body, as nothing else wants it', () => {
      const workspace = createWorktreeWorkspace({
        branchName,
        attention: {
          kind: 'generic',
          source: 'custom-hook',
          updatedAt: 1000,
          title: 'Review ready',
          body: 'Authentication changes are waiting.',
        },
      });
      setGitStatus(workspace.id, {});

      expect(branchShownOn(workspace)).toEqual({ onCard: 1, inDetails: 0 });
    });

    it('gives way beside a notification body when the row is in use', () => {
      const workspace = createWorktreeWorkspace({
        branchName,
        attention: {
          kind: 'generic',
          source: 'custom-hook',
          updatedAt: 1000,
          title: 'Review ready',
          body: 'Authentication changes are waiting.',
        },
      });
      setGitStatus(workspace.id, { aheadTargetBranch: 2 });

      expect(branchShownOn(workspace)).toEqual({ onCard: 0, inDetails: 1 });
    });

    it('takes the row of a workspace in the Trash, which shows no git status', () => {
      const workspace = createWorktreeWorkspace({ branchName, status: 'trashed' });
      setGitStatus(workspace.id, { aheadTargetBranch: 2 });

      expect(branchShownOn(workspace)).toEqual({ onCard: 1, inDetails: 0 });
    });

    // Under the title it would take a row of its own, and the card would shrink as setup finished.
    it.each([
      ['Setting up...', { provisioning: true }],
      ['Setup failed', { provisionError: 'It broke' }],
    ])('gives the row to "%s"', (status, overrides) => {
      render(<WorkspaceCard workspace={createWorktreeWorkspace({ branchName, ...overrides })} />);

      expect(screen.queryByText(branchName)).toBeNull();
      expect(screen.getByText(status)).toBeInTheDocument();
      expect(
        within(screen.getByRole('button', { name: /^Workspace details for / })).queryByText(status)
      ).toBeNull();
    });

    it.each([
      ['Setting up...', { provisioning: true }],
      ['Setup failed', { provisionError: 'It broke' }],
    ])('keeps "%s" in the row beside a notification body', (status, overrides) => {
      render(
        <WorkspaceCard
          workspace={createWorktreeWorkspace({
            branchName,
            ...overrides,
            attention: {
              kind: 'generic',
              source: 'custom-hook',
              updatedAt: 1000,
              title: 'Review ready',
              body: 'Authentication changes are waiting.',
            },
          })}
        />
      );

      const trigger = screen.getByRole('button', { name: /^Workspace details for / });
      expect(within(trigger).getByText('Authentication changes are waiting.')).toBeInTheDocument();
      expect(within(trigger).queryByText(status)).toBeNull();
      expect(screen.getByText(status)).toBeInTheDocument();
    });

    it('reads an SSH workspace diff by its workspace, as the git status indicator does', () => {
      const workspace = createSshWorkspace({ branchName, isWorktree: true });
      setGitStatus(workspace.id, {});
      const diff = { data: { files: [], summary: { additions: 3, deletions: 1 } } };

      fileListState.getDiff.mockImplementation((...args) => (args[3] ? undefined : diff));
      const { unmount } = render(<WorkspaceCard workspace={workspace} />);
      expect(screen.getByText(branchName)).toBeInTheDocument();
      unmount();

      fileListState.getDiff.mockImplementation((...args) =>
        args[3] === workspace.id ? diff : undefined
      );
      render(<WorkspaceCard workspace={workspace} />);
      expect(screen.queryByText(branchName)).toBeNull();
    });
  });

  it('gives cards room by default and tightens them in the compact workspace list', () => {
    const { container, rerender } = render(<WorkspaceCard workspace={createWorktreeWorkspace()} />);
    expect(container.querySelector('.workspace-card-hover')).toHaveClass('py-2.5');

    configState.config.compactWorkspaceList = true;
    rerender(<WorkspaceCard workspace={createWorktreeWorkspace()} />);
    expect(container.querySelector('.workspace-card-hover')).toHaveClass('py-2');
    expect(container.querySelector('.workspace-card-hover')).not.toHaveClass('py-2.5');
  });

  it('says a workspace is missing from its host rather than that setup failed', () => {
    render(
      <WorkspaceCard
        workspace={createWorktreeWorkspace({
          provisionError: 'This workspace’s files are no longer on its SSH host.',
          removedFromHost: true,
        })}
      />
    );

    expect(screen.getByText('Missing from host')).toBeInTheDocument();
    expect(screen.queryByText('Setup failed')).not.toBeInTheDocument();
  });

  it('uses a branch icon for an SSH workspace branch in the tooltip', () => {
    configState.config.alwaysShowBranchNameInWorkspaceCards = false;
    useSshHostsStore.setState({
      hosts: [
        {
          id: 'ssh-dev',
          name: 'Dev box',
          hostname: 'dev.example.com',
          user: 'dev',
          basePath: '/home/dev',
        },
      ],
    });
    const workspace = createWorktreeWorkspace({
      branchName: 'agent/remote-card-test',
      linkedWorkspaceIds: ['other'],
      backend: {
        kind: 'ssh',
        hostId: 'ssh-dev',
        remoteDirectory: '/home/dev/.komla/worktrees/test-project/remote-card-test',
        remoteRepoPath: '/home/dev/.komla/repos/test-project/repo.git',
        remoteProjectRoot: '/home/dev/.komla/worktrees/test-project',
        gitUrl: 'git@example.com:team/project.git',
        projectName: 'Test Project',
        branchName: 'agent/remote-card-test',
      },
    });

    render(<WorkspaceCard workspace={workspace} />);

    fireEvent.focus(screen.getByRole('button', { name: 'Workspace details for Test Workspace' }));
    const tooltip = screen.getByTestId('workspace-info-content');
    expect(tooltip).toHaveTextContent('agent/remote-card-test');
    expect(tooltip.querySelectorAll('[data-testid="cloud-icon"]')).toHaveLength(1);
    expect(tooltip.querySelectorAll('[data-testid="branch-icon"]')).toHaveLength(1);
    // The host goes by its name; the full target is a hover away.
    expect(within(tooltip).getByText('Dev box')).toBeVisible();
    expect(within(tooltip).getByTitle('dev@dev.example.com')).toHaveTextContent('Dev box');
    // The path moved to the context menu's Copy submenu.
    expect(tooltip).not.toHaveTextContent('remote-card-test/');
    expect(tooltip).not.toHaveTextContent('.komla/worktrees');
  });

  it('spells out the SSH target when the host has the tooltip line to itself', () => {
    useSshHostsStore.setState({
      hosts: [
        {
          id: 'ssh-dev',
          name: 'Dev box',
          hostname: 'dev.example.com',
          user: 'dev',
          basePath: '/home/dev',
        },
      ],
    });
    const workspace = createWorktreeWorkspace({
      branchName: 'agent/remote-card-test',
      backend: {
        kind: 'ssh',
        hostId: 'ssh-dev',
        remoteDirectory: '/home/dev/.komla/worktrees/test-project/remote-card-test',
        remoteRepoPath: '/home/dev/.komla/repos/test-project/repo.git',
        remoteProjectRoot: '/home/dev/.komla/worktrees/test-project',
        gitUrl: 'git@example.com:team/project.git',
        projectName: 'Test Project',
        branchName: 'agent/remote-card-test',
      },
    });

    render(<WorkspaceCard workspace={workspace} />);

    fireEvent.focus(screen.getByRole('button', { name: 'Workspace details for Test Workspace' }));
    const tooltip = within(screen.getByTestId('workspace-info-content'));
    expect(tooltip.getByText('Dev box')).toBeVisible();
    expect(tooltip.getByText('dev@dev.example.com')).toBeVisible();
  });

  it('leaves the path, and a branch the card already shows, out of the tooltip', () => {
    const workspace = createWorktreeWorkspace({
      name: 'Visible Branch',
      branchName: 'feature/visible',
      workingDirectory: '/Users/dev/.komla/worktrees/app/feature-visible',
    });

    render(<WorkspaceCard workspace={workspace} />);

    fireEvent.focus(screen.getByRole('button', { name: 'Workspace details for Visible Branch' }));
    const tooltip = screen.getByTestId('workspace-info-content');
    expect(tooltip).not.toHaveTextContent('feature/visible');
    expect(tooltip).not.toHaveTextContent('/Users/dev/.komla/worktrees/app/feature-visible');
    expect(screen.getAllByText('feature/visible')).toHaveLength(1);
    // A long branch truncates on the card, so pointing at it shows it whole.
    expect(screen.getByTitle('feature/visible')).toHaveTextContent('feature/visible');
  });

  it('names an SSH host by its hostname when it has no name', () => {
    useSshHostsStore.setState({
      hosts: [{ id: 'ssh-dev', name: '', hostname: 'dev.example.com', basePath: '/home/dev' }],
    });
    const workspace = createWorktreeWorkspace({
      branchName: 'agent/unnamed-host',
      branchedFrom: 'main',
      backend: {
        kind: 'ssh',
        hostId: 'ssh-dev',
        remoteDirectory: '/home/dev/.komla/worktrees/test-project/unnamed-host',
        remoteRepoPath: '/home/dev/.komla/repos/test-project/repo.git',
        remoteProjectRoot: '/home/dev/.komla/worktrees/test-project',
        gitUrl: 'git@example.com:team/project.git',
        projectName: 'Test Project',
        branchName: 'agent/unnamed-host',
      },
    });

    render(<WorkspaceCard workspace={workspace} />);

    fireEvent.focus(screen.getByRole('button', { name: 'Workspace details for Test Workspace' }));
    const tooltip = within(screen.getByTestId('workspace-info-content'));
    expect(tooltip.getByText('dev.example.com')).toBeVisible();
  });

  it('copies the workspace path and branch name from the context menu', () => {
    const remoteWorkspace = createWorktreeWorkspace({
      branchName: 'agent/remote-copy',
      workingDirectory: '/Users/dev/.komla/ssh/remote-copy',
      backend: {
        kind: 'ssh',
        hostId: 'ssh-dev',
        remoteDirectory: '/home/dev/.komla/worktrees/test-project/remote-copy',
        remoteRepoPath: '/home/dev/.komla/repos/test-project/repo.git',
        remoteProjectRoot: '/home/dev/.komla/worktrees/test-project',
        gitUrl: 'git@example.com:team/project.git',
        projectName: 'Test Project',
        branchName: 'agent/remote-copy',
      },
    });

    render(<WorkspaceCard workspace={remoteWorkspace} />);

    const copyMenu = screen.getByText('Copy').closest('[data-testid="context-submenu"]');
    expect(copyMenu).not.toBeNull();
    fireEvent.click(within(copyMenu as HTMLElement).getByText('Path'));
    // A remote workspace's path is where it lives on its host.
    expect(window.api.copyToClipboard).toHaveBeenCalledWith(
      '/home/dev/.komla/worktrees/test-project/remote-copy'
    );
    fireEvent.click(within(copyMenu as HTMLElement).getByText('Branch Name'));
    expect(window.api.copyToClipboard).toHaveBeenCalledWith('agent/remote-copy');
  });

  it('offers only the path to copy for a directory workspace', () => {
    render(
      <WorkspaceCard
        workspace={createDirectoryWorkspace({ workingDirectory: '/Users/dev/notes' })}
      />
    );

    const copyMenu = screen.getByText('Copy').closest('[data-testid="context-submenu"]');
    fireEvent.click(within(copyMenu as HTMLElement).getByText('Path'));
    expect(window.api.copyToClipboard).toHaveBeenCalledWith('/Users/dev/notes');
    expect(within(copyMenu as HTMLElement).queryByText('Branch Name')).toBeNull();
  });

  it('shows the live terminal title under a custom name and where the branch was cut from', () => {
    const workspace = createWorktreeWorkspace({
      customName: 'Tooltip polish',
      lastDynamicTitle: 'Fixing tab tooltips',
      branchName: 'feature/tooltips',
      branchedFrom: 'release/2.0',
    });

    render(<WorkspaceCard workspace={workspace} />);

    fireEvent.focus(screen.getByRole('button', { name: 'Workspace details for Tooltip polish' }));
    const tooltip = within(screen.getByTestId('workspace-info-content'));
    expect(tooltip.getByText('Fixing tab tooltips')).toBeVisible();
    expect(tooltip.getByText('release/2.0')).toHaveTextContent('from release/2.0');
    // The card shows the branch itself, so the tooltip only says where it came from.
    expect(tooltip.queryByText('feature/tooltips')).toBeNull();
  });

  it('shows the agent spinner immediately while an unselected workspace is active', () => {
    const workspace = createWorktreeWorkspace({
      agentActive: true,
      terminalCount: 1,
    });

    render(<WorkspaceCard workspace={workspace} />);

    expect(screen.getByLabelText('Agent processing')).toBeInTheDocument();
  });

  it('says which of the working terminals run commands rather than agents', () => {
    const workspace = createWorktreeWorkspace({
      agentActive: true,
      terminals: [
        createTerminal({ id: 'agent', status: 'running', agentActive: true }),
        createTerminal({ id: 'build', status: 'running', agentActive: true, commandActive: true }),
      ],
    });

    const { rerender } = render(<WorkspaceCard workspace={workspace} />);
    expect(
      screen.getByRole('status', { name: '1 agent processing, 1 command running' })
    ).toBeInTheDocument();

    rerender(<WorkspaceCard workspace={{ ...workspace, terminals: [workspace.terminals[1]] }} />);
    expect(screen.getByRole('status', { name: 'Command running' })).toBeInTheDocument();
  });

  it('lets the spinner of an agent running on another device be stopped here', () => {
    const workspace = createSshWorkspace({
      agentActive: true,
      terminals: [createTerminal({ status: 'stopped', remoteSessionOnHost: true })],
    });

    render(<WorkspaceCard workspace={workspace} />);

    expect(screen.getByLabelText('Agent processing')).toBeInTheDocument();
    expect(screen.getByText('Stop Spinner')).toBeInTheDocument();
  });

  it('offers Stop Spinner in the top level of the menu, and Start Spinner under More', () => {
    const workspace = createWorktreeWorkspace({ agentActive: true, terminalCount: 1 });

    const moreMenu = () => screen.getByText('More').closest('[data-testid="context-submenu"]');

    const { rerender } = render(<WorkspaceCard workspace={workspace} />);
    expect(screen.getByText('Stop Spinner').closest('[data-testid="context-submenu"]')).toBeNull();

    rerender(<WorkspaceCard workspace={{ ...workspace, agentActive: false }} />);
    expect(moreMenu()).toContainElement(screen.getByText('Start Spinner'));
  });

  it('renders the SVG spinner turning on the compositor, stilled by reduced motion', () => {
    const workspace = createWorktreeWorkspace({
      agentActive: true,
      terminalCount: 1,
    });

    render(<WorkspaceCard workspace={workspace} />);

    const spinner = screen.getByRole('status', { name: 'Agent processing' });
    expect(spinner.tagName).toBe('SPAN');
    expect(spinner).toHaveClass('size-3.5');
    // globals.css stops an .activity-glyph's animations under reduced motion.
    expect(spinner.querySelector('svg')).toHaveClass(
      'size-full',
      'text-muted-foreground',
      'animate-spin',
      'will-change-transform',
      'activity-glyph'
    );
  });

  it('shows how long the agent has been working in place of the last activity', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    try {
      vi.setSystemTime(100_000);
      const workspace = createWorktreeWorkspace({
        agentActive: true,
        lastActivityAt: 100_000,
        terminals: [createTerminal({ agentActive: true, agentActiveSince: 100_000 - 175_000 })],
      });

      render(<WorkspaceCard workspace={workspace} />);

      expect(screen.getByText('2m')).toHaveAttribute('title', 'Working for 2m');
      expect(screen.queryByText('now')).not.toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(5000);
      });

      expect(screen.getByText('3m')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the last activity while the agent waits for input', () => {
    const workspace = createWorktreeWorkspace({
      agentActive: true,
      lastActivityAt: Date.now(),
      terminals: [
        createTerminal({
          agentActive: true,
          agentActiveSince: Date.now() - 175_000,
          attention: { kind: 'input-required', source: 'claude-code', updatedAt: Date.now() },
        }),
      ],
    });

    render(<WorkspaceCard workspace={workspace} />);

    expect(screen.getByText('now')).toBeInTheDocument();
    expect(screen.queryByText('2m')).not.toBeInTheDocument();
  });

  it('synchronizes workspace card spinners to the document timeline', () => {
    const originalGetAnimationsDescriptor = Object.getOwnPropertyDescriptor(
      Element.prototype,
      'getAnimations'
    );
    const firstAnimation = { startTime: 250 } as Animation;
    const secondAnimation = { startTime: 750 } as Animation;
    const getAnimations = vi
      .fn()
      .mockReturnValueOnce([firstAnimation])
      .mockReturnValueOnce([secondAnimation]);
    Object.defineProperty(Element.prototype, 'getAnimations', {
      configurable: true,
      value: getAnimations,
    });

    try {
      render(
        <>
          <WorkspaceCard
            workspace={createWorktreeWorkspace({
              id: 'ws-1',
              agentActive: true,
              terminalCount: 1,
            })}
          />
          <WorkspaceCard
            workspace={createWorktreeWorkspace({
              id: 'ws-2',
              agentActive: true,
              terminalCount: 1,
            })}
          />
        </>
      );

      expect(getAnimations).toHaveBeenCalledTimes(2);
      expect(firstAnimation.startTime).toBe(0);
      expect(secondAnimation.startTime).toBe(0);
    } finally {
      if (originalGetAnimationsDescriptor) {
        Object.defineProperty(Element.prototype, 'getAnimations', originalGetAnimationsDescriptor);
      } else {
        Reflect.deleteProperty(Element.prototype, 'getAnimations');
      }
    }

    expect(Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations')).toEqual(
      originalGetAnimationsDescriptor
    );
  });

  it('keeps Setup execution state out of the workspace navigation card', () => {
    const attention: WorkspaceAttention = {
      kind: 'turn-complete',
      source: 'claude-code',
      updatedAt: 1000,
      terminalId: 'term-1',
    };
    const workspace = createWorktreeWorkspace({
      attention,
      terminals: [createTerminal({ id: 'term-1', attention })],
      setupActivities: [
        {
          id: 'setup-1',
          workspaceId: 'ws-1',
          setupRunId: 'run-1',
          stepId: 'install',
          stepName: 'Install',
          retryable: true,
          state: 'failed',
          startedAt: 900,
          completedAt: 950,
          output: '',
          error: 'install failed',
        },
      ],
    });

    render(<WorkspaceCard workspace={workspace} />);

    expect(screen.getAllByText('Done').length).toBeGreaterThan(0);
    expect(screen.queryByText('Setup')).not.toBeInTheDocument();
  });

  it('shows custom notification presentation instead of the branch secondary line', () => {
    const workspace = createWorktreeWorkspace({
      branchName: 'feature/test',
      attention: {
        kind: 'generic',
        source: 'custom-hook',
        updatedAt: 1000,
        title: 'Review ready',
        body: 'Authentication changes are waiting.',
        color: '#8b5cf6',
      },
    });

    render(<WorkspaceCard workspace={workspace} />);

    const badge = screen
      .getAllByText('Review ready')
      .find((element) => element.tagName === 'SPAN')
      ?.closest('[style]');
    expect(badge).toHaveStyle({ backgroundColor: '#8b5cf6' });
    expect(screen.getAllByText('Authentication changes are waiting.').length).toBeGreaterThan(0);
    expect(screen.queryByText('feature/test')).not.toBeInTheDocument();
  });

  it('shows a workspace marked unread as done, until it is opened', () => {
    const workspace = createWorktreeWorkspace({ unread: { reason: 'marked', at: 1000 } });

    const { rerender } = render(<WorkspaceCard workspace={workspace} />);
    expect(screen.getByText('Done')).toBeInTheDocument();
    expect(screen.queryByText('Mark as Unread')).not.toBeInTheDocument();

    workspacesState.selectedWorkspaceId = workspace.id;
    rerender(<WorkspaceCard workspace={{ ...workspace }} />);
    expect(screen.queryByText('Done')).not.toBeInTheDocument();
  });

  it('shows a workspace back from a snooze as woke', () => {
    render(
      <WorkspaceCard
        workspace={createWorktreeWorkspace({ unread: { reason: 'snooze-ended', at: 1000 } })}
      />
    );

    expect(screen.getByText('Woke')).toBeInTheDocument();
  });

  it('keeps an unread mark its own badge beside a working agent', () => {
    render(
      <WorkspaceCard
        workspace={createWorktreeWorkspace({
          unread: { reason: 'marked', at: 1000 },
          agentActive: true,
          terminals: [createTerminal({ id: 't1', agentActive: true })],
        })}
      />
    );

    expect(screen.getByText('Done')).toBeInTheDocument();
    expect(screen.queryByText(/1 done/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Agent processing')).toBeInTheDocument();
  });

  it('lets an agent that needs input outrank an unread mark', () => {
    render(
      <WorkspaceCard
        workspace={createWorktreeWorkspace({
          unread: { reason: 'marked', at: 1000 },
          attention: { kind: 'input-required', source: 'claude-code', updatedAt: 2000 },
        })}
      />
    );

    expect(screen.getByText('Input')).toBeInTheDocument();
    expect(screen.queryByText('Done')).not.toBeInTheDocument();
  });

  it('shows its tag in the badge place while no agent has anything to show', () => {
    const workspace = createWorktreeWorkspace({ tag: 'Waiting for review' });
    const { rerender } = render(<WorkspaceCard workspace={workspace} />);
    expect(
      screen.getByText('Waiting for review', { selector: '[data-workspace-tag] *' })
    ).toBeInTheDocument();

    rerender(
      <WorkspaceCard
        workspace={{
          ...workspace,
          attention: { kind: 'input-required', source: 'claude-code', updatedAt: 2000 },
        }}
      />
    );
    expect(document.querySelector('[data-workspace-tag]')).toBeNull();

    rerender(
      <WorkspaceCard
        workspace={{
          ...workspace,
          agentActive: true,
          terminals: [createTerminal({ id: 't1', agentActive: true })],
        }}
      />
    );
    expect(document.querySelector('[data-workspace-tag]')).toBeNull();
    expect(screen.getByLabelText('Agent processing')).toBeInTheDocument();
  });

  it('leads a tag with its spinner or icon, and says what a script added on hover', () => {
    configState.config.workspaceTags = [
      { name: 'CI running', tone: 'info', spinner: true },
      { name: 'Deployed', tone: 'success', icon: 'data:image/svg+xml;base64,PHN2Zy8+' },
    ];
    const workspace = createWorktreeWorkspace({ tag: 'CI running', tagTooltip: 'build 7 of 9' });
    const { rerender } = render(<WorkspaceCard workspace={workspace} />);
    const pill = document.querySelector('[data-workspace-tag]') as HTMLElement;
    expect(pill.querySelector('.activity-glyph')).not.toBeNull();
    expect(
      screen
        .getAllByTestId('tooltip-content')
        .some((tooltip) => tooltip.textContent === 'Tagged CI running · build 7 of 9')
    ).toBe(true);

    rerender(
      <WorkspaceCard workspace={{ ...workspace, tag: 'Deployed', tagTooltip: undefined }} />
    );
    expect(document.querySelector('[data-workspace-tag] [data-tag-icon]')).not.toBeNull();
  });

  it("keeps the tag and a script's note in the hover card while a notification has its place", () => {
    const workspace = createWorktreeWorkspace({
      tag: 'CI failed',
      tagTooltip: '2 of 9 jobs failed',
      attention: { kind: 'turn-complete', source: 'claude-code', updatedAt: 2000 },
    });
    const { rerender } = render(<WorkspaceCard workspace={workspace} />);
    expect(document.querySelector('[data-workspace-tag]')).toBeNull();
    fireEvent.focus(screen.getByRole('button', { name: /^Workspace details for/ }));
    const tag = document.querySelector('[data-workspace-info-tag]');
    expect(tag).toHaveTextContent('CI failed');
    expect(tag?.parentElement).toHaveTextContent('CI failed2 of 9 jobs failed');

    rerender(
      <WorkspaceCard
        workspace={{ ...workspace, tagTooltip: undefined, tagSource: 'pull-request' }}
      />
    );
    expect(document.querySelector('[data-workspace-info-tag]')?.parentElement).toHaveTextContent(
      'From the pull request'
    );
  });

  it('tags and untags from the context menu', () => {
    const workspace = createWorktreeWorkspace({ tag: 'Blocked' });
    render(<WorkspaceCard workspace={workspace} />);

    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'In review' }));
    expect(workspacesState.setTag).toHaveBeenCalledWith([workspace.id], 'In review');
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Blocked' }));
    expect(workspacesState.setTag).toHaveBeenLastCalledWith([workspace.id], undefined);
  });

  it('pins, marks unread and snoozes from the context menu', () => {
    const workspace = createWorktreeWorkspace();
    render(<WorkspaceCard workspace={workspace} />);

    fireEvent.click(screen.getByText('Pin'));
    expect(workspacesState.setPinned).toHaveBeenCalledWith(workspace.id, true);
    fireEvent.click(screen.getByText('Mark as Unread'));
    expect(workspacesState.markUnread).toHaveBeenCalledWith(workspace.id);
    fireEvent.click(screen.getByText('Tomorrow'));
    expect(workspacesState.snoozeWorkspace).toHaveBeenCalledWith(workspace.id, expect.any(Number));
  });

  it('offers snoozing until notified only while something there will notify', () => {
    const { rerender } = render(<WorkspaceCard workspace={createWorktreeWorkspace()} />);
    expect(screen.queryByText('Until Notified')).not.toBeInTheDocument();
    expect(screen.getByText('Tomorrow')).toBeInTheDocument();

    rerender(
      <WorkspaceCard workspace={createWorktreeWorkspace({ agentActive: true, terminalCount: 1 })} />
    );
    expect(screen.getByText('Until Notified')).toBeInTheDocument();
  });

  it('snoozes until notified from the context menu, shown with a bell and no countdown', () => {
    const workspace = createWorktreeWorkspace({ agentActive: true, terminalCount: 1 });
    const { rerender } = render(<WorkspaceCard workspace={workspace} />);

    fireEvent.click(screen.getByText('Until Notified'));
    expect(workspacesState.snoozeWorkspace).toHaveBeenCalledWith(workspace.id, undefined, true);

    rerender(<WorkspaceCard workspace={{ ...workspace, wakesOnNotification: true }} />);
    expect(screen.getByText('snoozed until notified')).toBeInTheDocument();
    expect(screen.queryByText(/^\d+[mhd]$/)).not.toBeInTheDocument();
    // Snoozed, it offers waking instead.
    expect(screen.getByText('Wake Now')).toBeInTheDocument();
  });

  describe('snoozing until CI finishes', () => {
    const pullRequestStatus = (ci: string) => ({
      kind: 'pull-request',
      pullRequest: { number: 12, title: 'Add search', url: 'u', state: 'open', ci, checks: [] },
    });

    it("snoozes while the pull request's checks run, waking at the latest when they stop being watched", async () => {
      window.api.getWorkspacePullRequestStatus = vi
        .fn()
        .mockResolvedValue(pullRequestStatus('pending'));
      const workspace = createWorktreeWorkspace();
      render(<WorkspaceCard workspace={workspace} />);

      fireEvent.click(await screen.findByText('Until CI Finishes'));
      expect(window.api.getWorkspacePullRequestStatus).toHaveBeenCalledWith(workspace.id);
      expect(workspacesState.snoozeWorkspace).toHaveBeenCalledWith(
        workspace.id,
        expect.any(Number),
        true
      );
      const until = vi.mocked(workspacesState.snoozeWorkspace).mock.calls[0][1] as number;
      expect(until - Date.now()).toBeGreaterThan(2.9 * 60 * 60_000);
      expect(until - Date.now()).toBeLessThanOrEqual(3 * 60 * 60_000);
    });

    it('offers it only while checks run', async () => {
      window.api.getWorkspacePullRequestStatus = vi
        .fn()
        .mockResolvedValue(pullRequestStatus('passed'));
      render(<WorkspaceCard workspace={createWorktreeWorkspace()} />);
      await act(async () => {});

      expect(window.api.getWorkspacePullRequestStatus).toHaveBeenCalled();
      expect(screen.queryByText('Until CI Finishes')).not.toBeInTheDocument();
    });

    it("doesn't offer it while CI's end notifies nothing, without the Pull request item", async () => {
      configState.config.statusBarHiddenItems = ['pull-request'];
      window.api.getWorkspacePullRequestStatus = vi
        .fn()
        .mockResolvedValue(pullRequestStatus('pending'));
      render(<WorkspaceCard workspace={createWorktreeWorkspace()} />);
      await act(async () => {});

      expect(window.api.getWorkspacePullRequestStatus).not.toHaveBeenCalled();
      expect(screen.queryByText('Until CI Finishes')).not.toBeInTheDocument();
    });
  });

  it('leaves the pin off a pinned card, which sits under the Pinned heading', () => {
    render(<WorkspaceCard workspace={createWorktreeWorkspace({ pinned: true })} />);

    expect(screen.queryByRole('img', { name: 'Pinned' })).toBeNull();
  });

  it('keeps the pin on a pinned card snoozed until notified, which sits on the Snoozed shelf', () => {
    render(
      <WorkspaceCard
        workspace={createWorktreeWorkspace({ pinned: true, wakesOnNotification: true })}
      />
    );

    expect(screen.getByRole('img', { name: 'Pinned' })).toBeInTheDocument();
  });

  it('unpins and wakes a pinned, snoozed workspace from the context menu', () => {
    const workspace = createWorktreeWorkspace({
      pinned: true,
      snoozedUntil: Date.now() + 90 * 60_000,
    });
    render(<WorkspaceCard workspace={workspace} />);

    expect(screen.getByText('1h')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Pinned' })).toBeInTheDocument();
    fireEvent.click(screen.getByText('Unpin'));
    expect(workspacesState.setPinned).toHaveBeenCalledWith(workspace.id, false);
    fireEvent.click(screen.getByText('Wake Now'));
    expect(workspacesState.snoozeWorkspace).toHaveBeenCalledWith(workspace.id, undefined);
  });

  it('marks a workspace an automation started', () => {
    const workspace = createWorktreeWorkspace({ customName: 'Nightly deps' });
    const other = createWorktreeWorkspace({ customName: 'By hand' });
    useAutomationsStore.setState({
      automationNameByWorkspace: { [workspace.id]: 'Nightly deps' },
    });
    onTestFinished(() => useAutomationsStore.setState({ automationNameByWorkspace: {} }));

    render(
      <>
        <WorkspaceCard workspace={workspace} />
        <WorkspaceCard workspace={other} />
      </>
    );

    expect(
      screen.getAllByRole('img', { name: 'Started by the Nightly deps automation' })
    ).toHaveLength(1);
  });

  it('shows active tab attention on the selected workspace card while file preview is fullscreen', () => {
    const attention = {
      kind: 'turn-complete' as const,
      source: 'claude-code' as const,
      updatedAt: 1000,
      terminalId: 'term-1',
    };
    const terminal = createTerminal({ id: 'term-1', attention });
    const workspace = createWorktreeWorkspace({
      id: 'ws-file-fullscreen',
      terminals: [terminal],
    });
    workspacesState.selectedWorkspaceId = workspace.id;
    fileViewerState.inlineFilePreviewByWorkspace = {
      [workspace.id]: { open: true, layout: 'full', mode: 'diff', filePath: '/mock/file.ts' },
    };
    layoutState.activeTabByWorkspace = { [workspace.id]: terminal.id };

    render(<WorkspaceCard workspace={workspace} />);

    expect(screen.getAllByText('Done').length).toBeGreaterThan(0);
  });

  it.each([
    ['no preview', false],
    ['a fullscreen file preview', true],
  ])(
    'shows the spinner of a background tab on the selected workspace card with %s',
    (_label, fullscreen) => {
      const activeTerminal = createTerminal({ id: 'term-1', agentActive: false });
      const backgroundTerminal = createTerminal({ id: 'term-2', agentActive: true });
      const workspace = createWorktreeWorkspace({
        id: 'ws-background-tab',
        terminals: [activeTerminal, backgroundTerminal],
        agentActive: true,
      });
      workspacesState.selectedWorkspaceId = workspace.id;
      if (fullscreen) {
        fileViewerState.inlineFilePreviewByWorkspace = {
          [workspace.id]: { open: true, layout: 'full', mode: 'diff', filePath: '/mock/file.ts' },
        };
      }
      layoutState.activeTabByWorkspace = { [workspace.id]: activeTerminal.id };

      render(<WorkspaceCard workspace={workspace} />);

      expect(screen.getByLabelText('Agent processing')).toBeInTheDocument();
    }
  );

  it('keeps the spinner on the selected workspace card when no preview is fullscreen', () => {
    // Selecting a working workspace doesn't make its card look idle.
    const terminal = createTerminal({ id: 'term-1', agentActive: true });
    const workspace = createWorktreeWorkspace({
      id: 'ws-selected-no-preview',
      terminals: [terminal],
      agentActive: true,
    });
    workspacesState.selectedWorkspaceId = workspace.id;
    layoutState.activeTabByWorkspace = { [workspace.id]: terminal.id };

    render(<WorkspaceCard workspace={workspace} />);

    expect(screen.getByLabelText('Agent processing')).toBeInTheDocument();
  });

  it('surfaces a background tab notification on the selected workspace card while a preview is fullscreen, with actionable attention first', () => {
    // One tab merely finished a turn (Done); a background tab needs input.
    // With the tab strip hidden, the card must surface the background tab's
    // notification — and actionable attention (Input) must win over Done
    // even though the Done terminal comes first.
    const doneTerminal = createTerminal({
      id: 'term-1',
      attention: {
        kind: 'turn-complete' as const,
        source: 'claude-code' as const,
        updatedAt: 1000,
        terminalId: 'term-1',
      },
    });
    const inputTerminal = createTerminal({
      id: 'term-2',
      attention: {
        kind: 'input-required' as const,
        source: 'claude-code' as const,
        updatedAt: 2000,
        terminalId: 'term-2',
      },
    });
    const workspace = createWorktreeWorkspace({
      id: 'ws-background-attention',
      terminals: [doneTerminal, inputTerminal],
    });
    workspacesState.selectedWorkspaceId = workspace.id;
    fileViewerState.inlineFilePreviewByWorkspace = {
      [workspace.id]: { open: true, layout: 'full', mode: 'diff', filePath: '/mock/file.ts' },
    };

    render(<WorkspaceCard workspace={workspace} />);

    expect(screen.getAllByText(/^1 (needs input|done)$/).map((state) => state.textContent)).toEqual(
      ['1 needs input', '1 done']
    );
  });

  describe('several agents in one workspace', () => {
    const doneOn = (terminalId: string, seen?: boolean): WorkspaceAttention => ({
      kind: 'turn-complete',
      source: 'codex',
      updatedAt: 1000,
      terminalId,
      ...(seen ? { seen } : {}),
    });

    it("shows one agent's done next to another's spinner", () => {
      const workspace = createWorktreeWorkspace({
        agentActive: true,
        terminals: [
          createTerminal({ id: 't1', agentActive: true }),
          createTerminal({ id: 't2', attention: doneOn('t2') }),
        ],
      });

      render(<WorkspaceCard workspace={workspace} />);

      expect(screen.getByText('1 done')).toBeInTheDocument();
      expect(screen.getByLabelText('Agent processing')).toBeInTheDocument();
      // Next to another agent, the badge shrinks to a glyph so the title keeps its room.
      expect(screen.queryByText('Done')).not.toBeInTheDocument();
    });

    it('keeps the badge, with their count, for agents that all share its state', () => {
      const workspace = createWorktreeWorkspace({
        terminals: [
          createTerminal({ id: 't1', name: 'Claude', attention: doneOn('t1') }),
          createTerminal({
            id: 't2',
            name: 'Codex',
            attention: { ...doneOn('t2'), updatedAt: 2000, message: 'Tests pass' },
          }),
        ],
      });

      render(<WorkspaceCard workspace={workspace} />);

      const pill = screen.getByText('2 done').closest('.rounded-full');
      expect(pill).toHaveClass('bg-success/15', 'text-success');
      expect(pill?.querySelector('svg')).not.toBeNull();
      fireEvent.focus(screen.getByRole('button', { name: /^Workspace details for/ }));
      const agents = detailsAgentTexts();
      expect(agents).toHaveLength(2);
      expect(agents[0]).toMatch(/^Done:CodexTests pass\d/);
      expect(agents[1]).toMatch(/^Done:Claude\d/);
    });

    it('shows a done the workspace no longer carries until its pane is seen', () => {
      // Opening the workspace took the done off its card; its Terminal still has it.
      const workspace = createWorktreeWorkspace({
        terminals: [
          createTerminal({ id: 't1' }),
          createTerminal({ id: 't2', attention: doneOn('t2') }),
        ],
      });

      const { rerender } = render(<WorkspaceCard workspace={workspace} />);
      expect(screen.getByText('Done')).toBeInTheDocument();

      rerender(
        <WorkspaceCard
          workspace={{
            ...workspace,
            terminals: [
              createTerminal({ id: 't1' }),
              createTerminal({ id: 't2', attention: doneOn('t2', true) }),
            ],
          }}
        />
      );
      expect(screen.queryByText('Done')).not.toBeInTheDocument();
    });

    it('shows each state as a glyph, most urgent first, counting agents that share one', () => {
      const workspace = createWorktreeWorkspace({
        agentActive: true,
        terminals: [
          createTerminal({ id: 't1', name: 'Claude', agentActive: true }),
          createTerminal({ id: 't2', name: 'Codex', agentActive: true }),
          createTerminal({ id: 't3', name: 'Gemini', attention: doneOn('t3') }),
          createTerminal({
            id: 't4',
            name: 'OpenCode',
            attention: {
              kind: 'input-required',
              source: 'opencode',
              updatedAt: 500,
              terminalId: 't4',
              message: 'Allow git push?',
            },
          }),
        ],
      });

      render(<WorkspaceCard workspace={workspace} />);

      expect(screen.queryByText('Input')).not.toBeInTheDocument();
      expect(
        screen.getAllByText(/^1 (needs input|done)$/).map((state) => state.textContent)
      ).toEqual(['1 needs input', '1 done']);
      expect(
        screen.getByRole('status', { name: '2 agents processing' }).nextSibling
      ).toHaveTextContent('2');
      fireEvent.focus(screen.getByRole('button', { name: /^Workspace details for/ }));
      const agents = detailsAgentTexts();
      expect(agents).toHaveLength(4);
      expect(agents[0]).toMatch(/^Needs input:OpenCodeAllow git push\?\d/);
      expect(agents[1]).toMatch(/^Done:Gemini\d/);
      // Working agents show too, as in the agents overview, with nothing said yet.
      expect(agents[2]).toBe('Working:Claude');
      expect(agents[3]).toBe('Working:Codex');
    });

    it("keeps a working agent's notice as its badge, and its spinner", () => {
      const noticeOn = (terminalId: string): WorkspaceAttention => ({
        kind: 'generic',
        source: 'claude-code',
        updatedAt: 1000,
        terminalId,
      });
      const workspace = createWorktreeWorkspace({
        agentActive: true,
        terminals: [createTerminal({ id: 't1', agentActive: true, attention: noticeOn('t1') })],
      });

      const { rerender } = render(<WorkspaceCard workspace={workspace} />);
      expect(screen.getByText('Notice')).toBeInTheDocument();
      expect(screen.getByLabelText('Agent processing')).toBeInTheDocument();

      rerender(
        <WorkspaceCard
          workspace={{
            ...workspace,
            terminals: [...workspace.terminals, createTerminal({ id: 't2', agentActive: true })],
          }}
        />
      );
      expect(screen.getByRole('status', { name: '2 agents processing' })).toBeInTheDocument();
    });

    it("keeps the selected card's dones quiet, but not its spinner", () => {
      const workspace = createWorktreeWorkspace({
        agentActive: true,
        terminals: [
          createTerminal({ id: 't1', agentActive: true }),
          createTerminal({ id: 't2', attention: doneOn('t2') }),
        ],
      });
      workspacesState.selectedWorkspaceId = workspace.id;

      render(<WorkspaceCard workspace={workspace} />);

      expect(screen.queryByText('Done')).not.toBeInTheDocument();
      expect(screen.queryByText('1 done')).not.toBeInTheDocument();
      expect(screen.getByLabelText('Agent processing')).toBeInTheDocument();
    });

    it("shows the selected card's input it still carries as a glyph beside its spinner", () => {
      const input: WorkspaceAttention = {
        kind: 'input-required',
        source: 'claude-code',
        updatedAt: 1000,
        terminalId: 't2',
      };
      const workspace = createWorktreeWorkspace({
        agentActive: true,
        attention: input,
        terminals: [
          createTerminal({ id: 't1', agentActive: true }),
          createTerminal({ id: 't2', attention: input }),
          createTerminal({ id: 't3', attention: doneOn('t3') }),
        ],
      });
      workspacesState.selectedWorkspaceId = workspace.id;

      render(<WorkspaceCard workspace={workspace} />);

      expect(screen.getByText('1 needs input')).toBeInTheDocument();
      expect(screen.getByLabelText('Agent processing')).toBeInTheDocument();
      expect(screen.queryByText('1 done')).not.toBeInTheDocument();
    });
  });

  it('restarts a running workspace from the context menu', async () => {
    workspacesState.restartWorkspace.mockRejectedValueOnce(new Error('restart failed'));
    const workspace = createWorktreeWorkspace({
      terminalCount: 1,
    });

    render(<WorkspaceCard workspace={workspace} />);

    fireEvent.click(screen.getByText('Restart Workspace'));
    await Promise.resolve();

    expect(workspacesState.restartWorkspace).toHaveBeenCalledWith(workspace.id);
  });

  it('stops, but does not restart, a workspace whose tmux session runs on its host', () => {
    const workspace = createSshWorkspace({
      terminals: [createTerminal({ status: 'stopped', remoteSessionOnHost: true })],
    });

    render(<WorkspaceCard workspace={workspace} />);

    expect(screen.queryByText('Restart Workspace')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Stop Workspace'));

    expect(workspacesState.stopWorkspace).toHaveBeenCalledWith(workspace.id);
  });

  it('offers no Stop while the tmux sessions of a stopped workspace are unchecked', () => {
    const workspace = createSshWorkspace({
      terminals: [createTerminal({ status: 'stopped', remoteSessionResumable: true })],
    });

    render(<WorkspaceCard workspace={workspace} />);

    expect(screen.queryByText('Stop Workspace')).not.toBeInTheDocument();
  });

  it('resets the workspace title and prompt history when the title is cleared', async () => {
    const workspace = createWorktreeWorkspace({
      customName: 'Old Task',
      promptSubmits: [{ prompt: 'Old prompt', submittedAt: 1 }],
      autoNaming: true,
    });
    const resetWorkspace = {
      ...workspace,
      customName: undefined,
      promptSubmits: undefined,
      autoNaming: false,
      lastDynamicTitle: 'Stale persisted title',
      terminals: [],
    };
    vi.mocked(window.api.updateWorkspace).mockResolvedValue(resetWorkspace);

    render(<WorkspaceCard workspace={workspace} />);

    expect(screen.queryByText('reset')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('edit'));
    fireEvent.change(screen.getByPlaceholderText('Custom workspace name'), {
      target: { value: '  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));

    await waitFor(() => {
      expect(workspacesState.updateWorkspace).toHaveBeenCalledWith(workspace.id, {
        customName: undefined,
        promptSubmits: undefined,
      });
    });
    expect(window.api.updateWorkspace).toHaveBeenCalledWith(workspace.id, {
      customName: undefined,
    });
    expect(workspacesState.updateWorkspace).toHaveBeenLastCalledWith(workspace.id, {
      customName: undefined,
      customNameSource: resetWorkspace.customNameSource,
      customNameGeneratedAt: resetWorkspace.customNameGeneratedAt,
      promptSubmitsSinceCustomNameGeneration: resetWorkspace.promptSubmitsSinceCustomNameGeneration,
      promptSubmits: undefined,
      autoNaming: false,
    });
  });

  it('closes without a reset when an untitled workspace saves an empty title', async () => {
    const workspace = createWorktreeWorkspace({
      promptSubmits: [{ prompt: 'Old prompt', submittedAt: 1 }],
    });

    render(<WorkspaceCard workspace={workspace} />);

    fireEvent.click(screen.getByText('set'));
    expect(screen.queryByText(/Leave it empty/)).not.toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('Custom workspace name'), {
      target: { value: '' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(screen.queryByPlaceholderText('Custom workspace name')).not.toBeInTheDocument();
    });
    expect(window.api.updateWorkspace).not.toHaveBeenCalled();
  });

  it('directly refreshes branch and diff status for an SSH workspace', async () => {
    const workspace = createWorktreeWorkspace({
      id: 'ssh-refresh',
      workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
      branchName: 'feature/remote',
      backend: {
        kind: 'ssh',
        hostId: 'ssh-dev',
        remoteDirectory: '/home/dev/worktree',
        remoteRepoPath: '/home/dev/repo.git',
        remoteProjectRoot: '/home/dev',
        gitUrl: 'git@example.com:repo.git',
      },
    });

    render(<WorkspaceCard workspace={workspace} />);
    fireEvent.click(screen.getByText('Refresh Git Status'));

    await waitFor(() => expect(window.api.refreshGitStatus).toHaveBeenCalledWith(workspace.id));
    expect(gitStatusState.invalidateStatus).toHaveBeenCalledWith(workspace.id);
    expect(fileListState.invalidate).toHaveBeenCalledWith(workspace.workingDirectory);
    expect(gitStatusState.fetchStatus).toHaveBeenCalledWith(
      workspace.id,
      workspace.workingDirectory,
      workspace.projectId
    );
    expect(fileListState.fetchDiff).toHaveBeenCalledWith(
      workspace.workingDirectory,
      undefined,
      false,
      workspace.id
    );
    await waitFor(() =>
      expect(workspacesState.updateWorkspace).toHaveBeenCalledWith(workspace.id, {
        branchName: 'feature',
      })
    );
    expect(toastState.addToast).not.toHaveBeenCalled();
    expect(window.api.updateWorkspace).toHaveBeenCalledWith(workspace.id, {
      branchName: 'feature',
    });
  });

  it('refreshes the branch comparison the inline file tree shows', async () => {
    const workspace = createWorktreeWorkspace({ id: 'compare-refresh' });
    fileViewerState.inlineFileTreeByWorkspace = {
      [workspace.id]: { comparisonBranch: 'main', useMergeBase: true },
    };

    render(<WorkspaceCard workspace={workspace} />);
    fireEvent.click(screen.getByText('Refresh Git Status'));

    await waitFor(() =>
      expect(fileListState.fetchDiff).toHaveBeenCalledWith(
        workspace.workingDirectory,
        'main',
        true,
        workspace.id
      )
    );
    // Other cached comparisons refetch the next time they're shown.
    expect(fileListState.invalidateBranchComparisonDiffs).toHaveBeenCalledWith(
      workspace.workingDirectory,
      workspace.id
    );
  });

  it('preserves SSH source context when creating a workspace from here', () => {
    const workspace = createWorktreeWorkspace({
      id: 'ssh-source',
      branchName: 'feature/host-only',
      backend: {
        kind: 'ssh',
        hostId: 'ssh-dev',
        remoteDirectory: '/home/dev/.komla/worktrees/test-project/feature-host-only',
        remoteRepoPath: '/home/dev/.komla/repos/test-project/repo.git',
        remoteProjectRoot: '/home/dev/.komla/worktrees/test-project',
        gitUrl: 'git@example.com:team/project.git',
        projectName: 'Test Project',
        branchName: 'feature/host-only',
      },
    });
    const listener = vi.fn();
    window.addEventListener('open-new-workspace-dialog', listener);

    render(<WorkspaceCard workspace={workspace} />);
    fireEvent.click(screen.getByText('New Workspace from Here'));

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: {
          baseBranch: 'feature/host-only',
          projectId: 'project-1',
          sshHostId: 'ssh-dev',
          sourceWorkspaceId: 'ssh-source',
        },
      })
    );
    window.removeEventListener('open-new-workspace-dialog', listener);
  });

  it('prioritizes the title and description while keeping technical details compact', () => {
    const workspace = createWorktreeWorkspace({
      customName: 'Workspace hover cards',
      customDescription: 'Make workspace details easier to scan and copy.',
      branchName: 'feature/workspace-hover-cards',
      workingDirectory: '/Users/developer/projects/komla/.worktrees/workspace-hover-cards',
    });

    render(<WorkspaceCard workspace={workspace} />);

    fireEvent.focus(
      screen.getByRole('button', { name: 'Workspace details for Workspace hover cards' })
    );
    const tooltip = within(screen.getByTestId('workspace-info-content'));
    expect(tooltip.getByText('Workspace hover cards')).toBeVisible();
    expect(tooltip.getByText('Make workspace details easier to scan and copy.')).toBeVisible();
    expect(tooltip.queryByText('Workspace')).not.toBeInTheDocument();
    expect(tooltip.queryByText('Branch')).not.toBeInTheDocument();
    expect(tooltip.queryByText('Path')).not.toBeInTheDocument();
    expect(tooltip.queryByRole('button')).not.toBeInTheDocument();
  });

  it('lets keyboard users open the details', () => {
    const workspace = createWorktreeWorkspace({ name: 'Keyboard accessible workspace' });

    render(<WorkspaceCard workspace={workspace} />);

    const detailsTrigger = screen.getByRole('button', {
      name: 'Workspace details for Keyboard accessible workspace',
    });
    act(() => detailsTrigger.focus());

    expect(detailsTrigger).toHaveFocus();
    expect(screen.getByTestId('workspace-info-content')).toBeVisible();

    fireEvent.keyDown(detailsTrigger, { key: 'Enter' });
    expect(screen.getByTestId('workspace-info-content')).toBeVisible();
  });

  it('keeps git status actions outside the details trigger and in the keyboard tab order', async () => {
    const user = userEvent.setup();
    const workspace = createWorktreeWorkspace({
      name: 'Workspace with git actions',
      status: 'active',
      branchName: 'feature/git-actions',
    });

    render(<WorkspaceCard workspace={workspace} />);

    const detailsTrigger = screen.getByRole('button', {
      name: 'Workspace details for Workspace with git actions',
    });
    const gitAction = screen.getByRole('button', { name: 'Git status action' });
    expect(detailsTrigger).not.toContainElement(gitAction);

    act(() => detailsTrigger.focus());
    await user.tab();
    expect(gitAction).toHaveFocus();
  });

  it('keeps the details popover dismissed when Escape restores focus to its trigger', () => {
    const workspace = createWorktreeWorkspace({
      name: 'Escape dismissible workspace',
      workingDirectory: '/Users/developer/projects/komla/escape-dismissible-workspace',
    });

    render(<WorkspaceCard workspace={workspace} />);

    const detailsTrigger = screen.getByRole('button', {
      name: 'Workspace details for Escape dismissible workspace',
    });
    act(() => detailsTrigger.focus());
    const popover = screen.getByTestId('workspace-info-content');

    fireEvent.keyDown(popover, { key: 'Escape' });
    fireEvent.focus(detailsTrigger);

    expect(screen.queryByTestId('workspace-info-content')).not.toBeInTheDocument();
  });

  describe('delete dialog', () => {
    it('names the workspace by the title the card shows, with its branch', () => {
      const workspace = createWorktreeWorkspace({
        name: 'swift-fox',
        customName: 'Fix login redirect',
        branchName: 'feature/login',
      });

      render(<WorkspaceCard workspace={workspace} />);
      const dialog = openDeleteDialog(workspace.id);

      expect(dialog).toHaveTextContent(
        'Delete workspace "Fix login redirect" on branch "feature/login"?'
      );
      expect(dialog).not.toHaveTextContent('swift-fox');
    });

    it('focuses Delete when nothing would be lost', () => {
      const workspace = createWorktreeWorkspace({ branchName: 'feature/login' });
      setGitStatus(workspace.id, { hasRemote: true, aheadTargetBranch: 2 });

      render(<WorkspaceCard workspace={workspace} />);
      const dialog = openDeleteDialog(workspace.id);

      expect(within(dialog).getByRole('button', { name: 'Delete' })).toHaveFocus();
      expect(dialog).not.toHaveTextContent('will be lost');
    });

    it('warns but still focuses Delete when the worktree has uncommitted changes', () => {
      const workspace = createWorktreeWorkspace({ branchName: 'feature/login' });
      fileListState.getDiff.mockReturnValue({
        data: { files: [{}, {}], summary: { additions: 0, deletions: 0 } },
      });

      render(<WorkspaceCard workspace={workspace} />);
      const dialog = openDeleteDialog(workspace.id);

      expect(dialog).toHaveTextContent('Uncommitted changes in 2 files will be lost.');
      expect(within(dialog).getByRole('button', { name: 'Delete' })).toHaveFocus();
    });

    it('warns about unpushed commits only while the branch will be deleted', () => {
      const workspace = createWorktreeWorkspace({ branchName: 'feature/login' });
      setGitStatus(workspace.id, { hasRemote: true, unpushedCommits: 3, aheadTargetBranch: 3 });

      render(<WorkspaceCard workspace={workspace} />);
      const dialog = openDeleteDialog(workspace.id);

      expect(dialog).toHaveTextContent('3 unpushed commits will be lost with the branch.');
      expect(within(dialog).getByRole('button', { name: 'Delete' })).toHaveFocus();

      fireEvent.click(within(dialog).getByRole('checkbox'));
      expect(dialog).not.toHaveTextContent('will be lost');
    });

    it('warns about unmerged commits on a branch that was never pushed', () => {
      const workspace = createWorktreeWorkspace({ branchName: 'feature/login' });
      setGitStatus(workspace.id, { hasRemote: false, aheadTargetBranch: 1 });

      render(<WorkspaceCard workspace={workspace} />);
      const dialog = openDeleteDialog(workspace.id);

      expect(dialog).toHaveTextContent('1 unpushed commit will be lost with the branch.');
    });
  });

  it('keeps the leading slash of a left-truncated directory path at the start', () => {
    const workspace = createDirectoryWorkspace({ workingDirectory: '/Users/dev/.config/app' });

    render(<WorkspaceCard workspace={workspace} />);

    const path = screen.getByText('/Users/dev/.config/app');
    expect(path.tagName).toBe('BDI');
    expect(path.parentElement).toHaveAttribute('dir', 'rtl');
  });

  it('gives actionable status a soft pill in its own hue with a glyph, distinct from diff stats', () => {
    const workspace = createWorktreeWorkspace({
      attention: { kind: 'input-required', source: 'claude-code', updatedAt: 1000 },
    });

    render(<WorkspaceCard workspace={workspace} />);

    const pill = screen.getByText('Input').closest('.rounded-full');
    expect(pill).toHaveClass('bg-attention/15', 'text-attention');
    expect(pill?.querySelector('svg')).not.toBeNull();
  });

  it("puts an agent's message on one line in the details, and all of it a hover further", () => {
    const message =
      'Refactored the session store.\n\nTests pass; the staging secret is still missing.';
    const workspace = createWorktreeWorkspace({
      attention: { kind: 'turn-complete', source: 'claude-code', updatedAt: 1000, message },
    });

    render(<WorkspaceCard workspace={workspace} />);
    expect(screen.queryByTestId('tooltip-content')).not.toBeInTheDocument();
    fireEvent.focus(screen.getByRole('button', { name: /^Workspace details for/ }));

    const line = within(screen.getByRole('list', { name: 'Agents' })).getByRole('listitem');
    expect(within(line).getByText((_, element) => element?.textContent === message)).toHaveClass(
      'truncate'
    );
    const card = screen
      .getAllByTestId('tooltip-content')
      .find((tooltip) => tooltip.querySelector('p')?.textContent === message);
    expect(card).toHaveTextContent('Done');
  });

  it('shows a working agent in the details, with how long it has worked', () => {
    vi.useFakeTimers({ now: 10 * 60_000 });
    try {
      const workspace = createWorktreeWorkspace({
        agentActive: true,
        terminals: [
          createTerminal({
            id: 't1',
            name: 'Claude',
            agentActive: true,
            agentActiveSince: 7 * 60_000,
          }),
        ],
      });
      render(<WorkspaceCard workspace={workspace} />);
      fireEvent.focus(screen.getByRole('button', { name: /^Workspace details for/ }));

      expect(detailsAgentTexts()).toEqual(['Working:Claude3m']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the title an agent gave its notification, over what it said', () => {
    const workspace = createWorktreeWorkspace({
      attention: {
        kind: 'input-required',
        source: 'claude-code',
        updatedAt: 1000,
        title: 'Approve deploy to prod?',
        message: 'Staging is green.',
      },
    });
    render(<WorkspaceCard workspace={workspace} />);
    fireEvent.focus(screen.getByRole('button', { name: /^Workspace details for/ }));

    expect(detailsAgentTexts()).toEqual([
      expect.stringMatching(/^Needs inputApprove deploy to prod\?\d/),
    ]);
    const card = screen
      .getAllByTestId('tooltip-content')
      .find((tooltip) => tooltip.textContent?.includes('Staging is green.'));
    expect(card).toHaveTextContent('Approve deploy to prod?Staging is green.');
  });

  it('says a title once when the message repeats it', () => {
    const workspace = createWorktreeWorkspace({
      attention: {
        kind: 'error',
        source: 'claude-code',
        updatedAt: 1000,
        title: 'Build failed',
        message: 'Build failed',
      },
    });
    render(<WorkspaceCard workspace={workspace} />);
    fireEvent.focus(screen.getByRole('button', { name: /^Workspace details for/ }));

    const card = screen
      .getAllByTestId('tooltip-content')
      .find((tooltip) => tooltip.textContent?.includes('Build failed'))!;
    expect(within(card).getAllByText('Build failed')).toHaveLength(1);
  });

  it("names the workspace's own agent beside its terminals' agents", () => {
    const workspace = createWorktreeWorkspace({
      agentActive: true,
      attention: { kind: 'input-required', source: 'claude-code', updatedAt: 1000 },
      terminals: [createTerminal({ id: 't1', name: 'Codex', agentActive: true })],
    });
    render(<WorkspaceCard workspace={workspace} />);
    fireEvent.focus(screen.getByRole('button', { name: /^Workspace details for/ }));

    expect(detailsAgentTexts()).toEqual([
      expect.stringMatching(/^Needs input:This workspace\d/),
      'Working:Codex',
    ]);
  });

  it("keeps a notice that is no agent's as its notification, above the working agents", () => {
    const workspace = createWorktreeWorkspace({
      agentActive: true,
      terminals: [
        createTerminal({
          id: 't1',
          name: 'Claude',
          agentActive: true,
          attention: {
            kind: 'generic',
            source: 'claude-code',
            updatedAt: 1000,
            terminalId: 't1',
            title: 'Deploy preview ready',
            message: 'https://preview.example.com',
          },
        }),
      ],
    });
    render(<WorkspaceCard workspace={workspace} />);
    fireEvent.focus(screen.getByRole('button', { name: /^Workspace details for/ }));

    const details = within(screen.getByTestId('workspace-info-content'));
    expect(details.getByText('Deploy preview ready')).toBeInTheDocument();
    expect(details.getByText('https://preview.example.com')).toBeInTheDocument();
    // Beside agents, the notice says whose it is.
    expect(document.querySelector('[data-attention-sender]')).toHaveTextContent('from Claude');
    expect(detailsAgentTexts()).toEqual(['Working:Claude']);
  });

  it('leaves a workspace with no notification without one in its details', () => {
    render(<WorkspaceCard workspace={createWorktreeWorkspace()} />);
    fireEvent.focus(screen.getByRole('button', { name: /^Workspace details for/ }));

    expect(screen.queryByText('Agent finished a turn')).not.toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Agents' })).not.toBeInTheDocument();
  });

  it('keeps informational status soft, but still marks it with a glyph', () => {
    const workspace = createWorktreeWorkspace({
      attention: { kind: 'turn-complete', source: 'claude-code', updatedAt: 1000 },
    });

    render(<WorkspaceCard workspace={workspace} />);

    const pill = screen.getByText('Done').closest('.rounded-full');
    expect(pill).toHaveClass('bg-success/15', 'text-success');
    expect(pill?.querySelector('svg')).not.toBeNull();
  });

  it('shows the branch line when the title is the branch, as on a new workspace', () => {
    const workspace = createWorktreeWorkspace({
      name: 'Royal Brush',
      branchName: 'royal-brush',
    });

    render(<WorkspaceCard workspace={workspace} />);

    expect(screen.getByText('royal-brush')).toBeInTheDocument();
  });

  it.each([
    ['metaKey', { metaKey: true }],
    ['ctrlKey', { ctrlKey: true }],
  ])('starts a selection with %s+click instead of opening the workspace', (_name, modifier) => {
    const workspace = createWorktreeWorkspace({ name: 'Modifier workspace' });
    const { container } = render(<WorkspaceCard workspace={workspace} />);

    fireEvent.click(container.querySelector('.workspace-card-hover')!, modifier);

    expect(workspacesState.enterSelectionMode).toHaveBeenCalledWith(workspace.id);
    expect(workspacesState.selectWorkspace).not.toHaveBeenCalled();
  });

  it('toggles a card with Cmd/Ctrl+click while already selecting', () => {
    workspacesState.selectionMode = true;
    try {
      const workspace = createWorktreeWorkspace({ name: 'Toggle workspace' });
      const { container } = render(<WorkspaceCard workspace={workspace} />);

      fireEvent.click(container.querySelector('.workspace-card-hover')!, { metaKey: true });

      expect(workspacesState.toggleWorkspaceSelection).toHaveBeenCalledWith(workspace.id);
      expect(workspacesState.enterSelectionMode).not.toHaveBeenCalled();
      expect(workspacesState.selectWorkspace).not.toHaveBeenCalled();
    } finally {
      workspacesState.selectionMode = false;
    }
  });

  it('makes multi-selected cards clearly visible', () => {
    const workspace = createWorktreeWorkspace({ name: 'Picked workspace' });
    workspacesState.selectionMode = true;
    workspacesState.selectedWorkspaceIds = new Set([workspace.id]);
    try {
      const { container } = render(<WorkspaceCard workspace={workspace} />);

      expect(container.querySelector('.workspace-card-hover')).toHaveClass(
        'bg-primary/10',
        'ring-1',
        'ring-primary/40'
      );
    } finally {
      workspacesState.selectionMode = false;
    }
  });

  it('greys out a stopped card without fading it out, and restores its opacity on hover', () => {
    const workspace = createWorktreeWorkspace({ name: 'Stopped workspace', terminals: [] });

    const { container } = render(<WorkspaceCard workspace={workspace} />);

    const card = container.querySelector('.workspace-card-hover');
    expect(card).toHaveClass('opacity-60', 'hover:opacity-100', 'text-muted-foreground');
    expect(card).not.toHaveClass('opacity-35');
    expect(screen.getByRole('button', { name: 'Git status action' })).toHaveAttribute(
      'data-mute-diff-stats',
      'true'
    );
  });

  it('greys a stopped card without a filter, so its badges, errors and selection keep their color', () => {
    const workspace = createWorktreeWorkspace({ name: 'Stopped workspace', terminals: [] });

    const { container } = render(<WorkspaceCard workspace={workspace} />);

    expect(container.querySelector('.workspace-card-hover')?.className).not.toMatch(
      /\b(grayscale|saturate)/
    );
  });

  it('keeps a running card in full color', () => {
    const workspace = createWorktreeWorkspace({ name: 'Running workspace', terminalCount: 1 });

    const { container } = render(<WorkspaceCard workspace={workspace} />);

    const card = container.querySelector('.workspace-card-hover');
    expect(card).not.toHaveClass('opacity-60');
    expect(card).not.toHaveClass('text-muted-foreground');
    expect(screen.getByRole('button', { name: 'Git status action' })).toHaveAttribute(
      'data-mute-diff-stats',
      'false'
    );
  });

  it('does not mute a card whose tmux session runs on its host, e.g. on another device', () => {
    const workspace = createSshWorkspace({
      name: 'Running elsewhere',
      terminals: [createTerminal({ status: 'stopped', remoteSessionOnHost: true })],
    });

    const { container } = render(<WorkspaceCard workspace={workspace} />);

    const card = container.querySelector('.workspace-card-hover');
    expect(card).not.toHaveClass('opacity-60');
    expect(card).not.toHaveClass('text-muted-foreground');
  });

  it("ignores clicks from content portalled out of the card, such as a dialog's backdrop", () => {
    const workspace = createWorktreeWorkspace({ name: 'Portalled click workspace' });
    render(<WorkspaceCard workspace={workspace} />);

    fireEvent.click(screen.getByTestId('git-status-dialog-backdrop'));

    expect(workspacesState.selectWorkspace).not.toHaveBeenCalled();
  });

  it.each([{}, { metaKey: true }, { shiftKey: true }])(
    'restores a trashed workspace on any click, never picking it for a bulk action (%o)',
    (modifier) => {
      const workspace = createWorktreeWorkspace({ name: 'Trashed', status: 'trashed' });
      const { container } = render(<WorkspaceCard workspace={workspace} />);

      fireEvent.click(container.querySelector('.workspace-card-hover')!, modifier);

      expect(workspacesState.setWorkspaceTrashed).toHaveBeenCalledWith(workspace.id, false);
      expect(workspacesState.enterSelectionMode).not.toHaveBeenCalled();
    }
  );

  it('keeps a trashed card out of a selection in progress', () => {
    workspacesState.selectionMode = true;
    onTestFinished(() => {
      workspacesState.selectionMode = false;
    });
    const workspace = createWorktreeWorkspace({ status: 'trashed' });
    const { container } = render(<WorkspaceCard workspace={workspace} />);

    fireEvent.contextMenu(container.querySelector('.workspace-card-hover')!);

    expect(workspacesState.toggleWorkspaceSelection).not.toHaveBeenCalled();
    expect(screen.getByText('Restore Workspace')).toBeInTheDocument();
  });

  it('leaves Move to Trash to the menu, with no button on the card', () => {
    render(<WorkspaceCard workspace={createWorktreeWorkspace({ lastActivityAt: Date.now() })} />);

    expect(screen.queryByRole('button', { name: 'Move to Trash' })).not.toBeInTheDocument();
  });

  it('offers to undo trashing from the card menu', () => {
    const workspace = createWorktreeWorkspace();
    render(<WorkspaceCard workspace={workspace} />);

    fireEvent.click(screen.getByText('Move to Trash'));

    expect(workspacesState.trashWorkspaceWithUndo).toHaveBeenCalledWith(workspace.id);
  });

  it.each([
    [0, '6d left'],
    [1.5 * 24, '5d left'],
    [6.4 * 24, '14h left'],
    [7 * 24 - 0.5, '<1h left'],
    [7 * 24 + 1, '<1h left'],
  ])('says how long a trashed card has left, %s hours in', (hoursIn, left) => {
    const trashedAt = Date.now() - hoursIn * 3_600_000;
    render(
      <WorkspaceCard
        workspace={createWorktreeWorkspace({
          status: 'trashed',
          trashedAt,
          lastActivityAt: Date.now() - 3_600_000,
        })}
      />
    );

    expect(screen.getByText(left)).toBeInTheDocument();
  });

  it('counts down while the trashed card stays open', () => {
    vi.useFakeTimers();
    try {
      const trashedAt = Date.now() - 6 * 24 * 3_600_000 + 2_000;
      render(
        <WorkspaceCard workspace={createWorktreeWorkspace({ status: 'trashed', trashedAt })} />
      );
      expect(screen.getByText('1d left')).toBeInTheDocument();

      act(() => vi.advanceTimersByTime(3_000));
      expect(screen.getByText('23h left')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('offers only restoring and deleting on a trashed card', () => {
    const workspace = createWorktreeWorkspace({ status: 'trashed' });
    render(<WorkspaceCard workspace={workspace} />);

    expect(screen.queryByText('Pin')).not.toBeInTheDocument();
    expect(screen.queryByText('Link Workspaces...')).not.toBeInTheDocument();
    expect(screen.getByText('Delete Permanently...')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Restore Workspace'));
    expect(workspacesState.setWorkspaceTrashed).toHaveBeenCalledWith(workspace.id, false);
  });

  it('does not open the details popover when the card is clicked', async () => {
    const user = userEvent.setup();
    const workspace = createWorktreeWorkspace({ name: 'Clicked workspace' });

    render(<WorkspaceCard workspace={workspace} />);
    await user.click(
      screen.getByRole('button', { name: 'Workspace details for Clicked workspace' })
    );

    expect(workspacesState.selectWorkspace).toHaveBeenCalledWith(workspace.id);
    expect(screen.queryByTestId('workspace-info-content')).not.toBeInTheDocument();
  });

  it('does not pop the details open after a click that lands within the hover delay', () => {
    vi.useFakeTimers();
    try {
      const workspace = createWorktreeWorkspace({ name: 'Switched-to workspace' });
      render(<WorkspaceCard workspace={workspace} />);
      const trigger = screen.getByRole('button', {
        name: 'Workspace details for Switched-to workspace',
      });

      fireEvent.pointerEnter(trigger);
      fireEvent.pointerDown(trigger);
      act(() => trigger.focus());
      fireEvent.click(trigger);
      act(() => {
        vi.advanceTimersByTime(400);
      });

      expect(screen.queryByTestId('workspace-info-content')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  describe('scrolling while the details are shown', () => {
    const renderInList = () => {
      const workspace = createWorktreeWorkspace({ name: 'Scrolled workspace' });
      render(
        <>
          <div data-testid="workspace-list" style={{ overflowY: 'auto' }}>
            <WorkspaceCard workspace={workspace} />
            <div data-testid="other-card" />
          </div>
          <div data-testid="terminal-viewport" style={{ overflowY: 'auto' }} />
        </>
      );
      return screen.getByRole('button', { name: 'Workspace details for Scrolled workspace' });
    };

    const hover = (trigger: HTMLElement) => {
      fireEvent.pointerEnter(trigger);
      act(() => {
        vi.advanceTimersByTime(400);
      });
    };

    it('closes the details when the list is scrolled over the card', () => {
      vi.useFakeTimers();
      try {
        const trigger = renderInList();
        hover(trigger);
        expect(screen.getByTestId('workspace-info-content')).toBeVisible();

        fireEvent.wheel(trigger, { deltaY: 60 });

        expect(screen.queryByTestId('workspace-info-content')).not.toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not open the details a scroll interrupted the hover delay of', () => {
      vi.useFakeTimers();
      try {
        const trigger = renderInList();
        fireEvent.pointerEnter(trigger);
        fireEvent.wheel(trigger, { deltaY: 60 });
        act(() => {
          vi.advanceTimersByTime(400);
        });

        expect(screen.queryByTestId('workspace-info-content')).not.toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });

    it('closes keyboard-opened details when the list is scrolled elsewhere', () => {
      const trigger = renderInList();
      act(() => trigger.focus());
      // Focusing a card scrolls it into view, which isn't the user scrolling.
      fireEvent.scroll(screen.getByTestId('workspace-list'));
      expect(screen.getByTestId('workspace-info-content')).toBeVisible();

      fireEvent.wheel(screen.getByTestId('other-card'), { deltaY: 60 });

      expect(screen.queryByTestId('workspace-info-content')).not.toBeInTheDocument();
    });

    it('keeps the details open while they or a terminal scroll', () => {
      vi.useFakeTimers();
      try {
        hover(renderInList());

        fireEvent.wheel(screen.getByTestId('workspace-info-content'), { deltaY: 60 });
        fireEvent.wheel(screen.getByTestId('terminal-viewport'), { deltaY: 60 });

        expect(screen.getByTestId('workspace-info-content')).toBeVisible();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('opens the details, notification and all, from a hovered status badge', () => {
    vi.useFakeTimers();
    try {
      const workspace = createWorktreeWorkspace({
        name: 'Notified workspace',
        attention: {
          kind: 'turn-complete',
          source: 'claude-code',
          updatedAt: 1000,
          message: 'Refactored the session store.',
        },
      });
      render(<WorkspaceCard workspace={workspace} />);
      const badge = screen.getByText('Done');

      fireEvent.pointerEnter(badge);
      fireEvent.pointerMove(badge);
      act(() => {
        vi.advanceTimersByTime(400);
      });

      const details = within(screen.getByTestId('workspace-info-content'));
      expect(details.getByText('Done')).toBeInTheDocument();
      expect(details.getByText('Refactored the session store.')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves the hovered commit counts to their own tooltips', () => {
    vi.useFakeTimers();
    try {
      const workspace = createWorktreeWorkspace({ name: 'Ahead workspace' });
      render(<WorkspaceCard workspace={workspace} />);

      const counts = screen.getByRole('button', { name: 'Git status action' });
      fireEvent.pointerEnter(counts);
      fireEvent.pointerMove(counts);
      act(() => {
        vi.advanceTimersByTime(400);
      });

      expect(screen.queryByTestId('workspace-info-content')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the details closed while the pointer is on a tooltip portalled out of the card', () => {
    vi.useFakeTimers();
    try {
      const workspace = createWorktreeWorkspace({
        name: 'Tagged workspace',
        tag: 'CI running',
        tagTooltip: 'build 7 of 9',
      });
      render(<WorkspaceCard workspace={workspace} />);
      const tooltip = screen
        .getAllByTestId('tooltip-content')
        .find((element) => element.textContent?.includes('build 7 of 9'))!;

      fireEvent.pointerEnter(tooltip);
      fireEvent.pointerMove(tooltip);
      act(() => {
        vi.advanceTimersByTime(400);
      });

      expect(screen.queryByTestId('workspace-info-content')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not pop the details open when the pointer moves on after a click', () => {
    vi.useFakeTimers();
    try {
      const workspace = createWorktreeWorkspace({ name: 'Clicked then moved workspace' });
      render(<WorkspaceCard workspace={workspace} />);
      const trigger = screen.getByRole('button', {
        name: 'Workspace details for Clicked then moved workspace',
      });

      fireEvent.pointerEnter(trigger);
      fireEvent.pointerDown(trigger);
      act(() => trigger.focus());
      fireEvent.click(trigger);
      fireEvent.pointerMove(trigger);
      act(() => {
        vi.advanceTimersByTime(400);
      });

      expect(screen.queryByTestId('workspace-info-content')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes the hover details once the pointer leaves, even after a click focused the card', () => {
    vi.useFakeTimers();
    try {
      const workspace = createWorktreeWorkspace({ name: 'Hovered workspace' });
      render(<WorkspaceCard workspace={workspace} />);
      const trigger = screen.getByRole('button', {
        name: 'Workspace details for Hovered workspace',
      });

      fireEvent.pointerEnter(trigger);
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(screen.getByTestId('workspace-info-content')).toBeInTheDocument();

      fireEvent.pointerDown(trigger);
      act(() => trigger.focus());
      fireEvent.click(trigger);
      fireEvent.pointerLeave(trigger);
      act(() => {
        vi.advanceTimersByTime(100);
      });

      expect(screen.queryByTestId('workspace-info-content')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('WorkspaceCard launch Undo', () => {
  // Rows report whether they are in sight through an IntersectionObserver, which jsdom lacks.
  const observed = new Map<Element, (entries: Array<{ isIntersecting: boolean }>) => void>();
  const setInSight = (element: Element, isIntersecting: boolean) =>
    act(() => observed.get(element)?.([{ isIntersecting }]));
  const cardOf = (element: HTMLElement) => [...observed.keys()].find((c) => c.contains(element))!;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    observed.clear();
    workspacesState.selectedWorkspaceId = null;
    workspacesState.keyboardNavigationWorkspaceId = null;
    workspacesState.selectedWorkspaceIds = new Set<string>();
    Element.prototype.scrollIntoView = vi.fn();
    window.api = {
      updateWorkspace: vi.fn(),
      refreshGitStatus: vi.fn().mockResolvedValue(undefined),
      copyToClipboard: vi.fn(),
      getWorkspacePullRequestStatus: vi.fn().mockResolvedValue({ kind: 'none' }),
    } as any;
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(private callback: (entries: Array<{ isIntersecting: boolean }>) => void) {}
        observe(element: Element) {
          observed.set(element, this.callback);
        }
        disconnect() {}
      }
    );
  });

  afterEach(() => {
    act(() => dismissLaunchUndo());
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const offerOnCard = (fallback = vi.fn(), undo = vi.fn()) => {
    const workspace = createWorktreeWorkspace({
      name: 'New workspace',
      lastActivityAt: Date.now(),
    });
    render(<WorkspaceCard workspace={workspace} />);
    act(() => offerLaunchUndo([workspace.id], undo, fallback));
    const card = cardOf(screen.getByRole('button', { name: 'Undo' }));
    return { workspace, card, fallback, undo };
  };

  it('offers Undo on the new row instead of a toast, and keeps it while hovered', () => {
    const { card, fallback, undo } = offerOnCard();
    setInSight(card, true);
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(fallback).not.toHaveBeenCalled();

    fireEvent.pointerEnter(card);
    act(() => {
      vi.advanceTimersByTime(LAUNCH_UNDO_MS * 2);
    });
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(undo).toHaveBeenCalledOnce();
    expect(fallback).not.toHaveBeenCalled();
    expect(workspacesState.selectWorkspace).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  });

  it('keeps Undo while it has keyboard focus', async () => {
    const { card } = offerOnCard();
    setInSight(card, true);

    act(() => screen.getByRole('button', { name: 'Undo' }).focus());
    act(() => {
      vi.advanceTimersByTime(LAUNCH_UNDO_MS * 2);
    });
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();

    // The card lets go once focus has landed elsewhere, a microtask after focusout.
    await act(async () => screen.getByRole('button', { name: 'Undo' }).blur());
    act(() => {
      vi.advanceTimersByTime(LAUNCH_UNDO_MS);
    });
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  });

  it('hands the offer to the toast when the row is out of sight', () => {
    const { card, fallback } = offerOnCard();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(fallback).not.toHaveBeenCalled();

    setInSight(card, false);

    expect(fallback).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  });

  it('hands the offer to the toast when the row leaves sight later, as the sidebar collapses', () => {
    const { card, fallback } = offerOnCard();
    setInSight(card, true);
    act(() => {
      vi.advanceTimersByTime(2000);
    });

    setInSight(card, false);

    expect(fallback).toHaveBeenCalledOnce();
  });

  it("stands Undo in the last activity time's place, leaving the spinner's spot alone", () => {
    const workspace = createWorktreeWorkspace({
      name: 'New workspace',
      lastActivityAt: Date.now(),
    });
    render(<WorkspaceCard workspace={workspace} />);
    // The row's time and its trash button sit in a span of their own.
    const activityRow = screen.getByText('now').closest('div');

    act(() => offerLaunchUndo([workspace.id], vi.fn(), vi.fn()));
    const undoButton = screen.getByRole('button', { name: 'Undo' });
    setInSight(cardOf(undoButton), true);
    expect(screen.queryByText('now')).not.toBeInTheDocument();
    expect(undoButton.parentElement).toBe(activityRow);

    act(() => {
      vi.advanceTimersByTime(LAUNCH_UNDO_MS);
    });
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
    expect(screen.getByText('now')).toBeInTheDocument();
  });

  it('shows nothing on rows the launch did not make', () => {
    const workspace = createWorktreeWorkspace({ name: 'Older workspace' });
    render(<WorkspaceCard workspace={workspace} />);

    act(() => offerLaunchUndo(['someone-else'], vi.fn(), vi.fn()));

    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  });
});
