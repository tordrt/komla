/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useFileListStore } from '../../../../../src/renderer/stores/file-list.store';
import { useFileViewerStore } from '../../../../../src/renderer/stores/file-viewer.store';
import { useWorkspaceObservationStore } from '../../../../../src/renderer/stores/workspace-observation.store';
import { useWorkspacesStore } from '../../../../../src/renderer/stores/workspaces.store';
import { SidebarFileTree } from '../../../../../src/renderer/components/workspaces/file-viewer/SidebarFileTree';
import { isShortcutEventClaimed } from '../../../../../src/renderer/lib/shortcut-claims';
import { createSshWorkspace, createTerminal } from '../../../../factories';

import type React from 'react';
import type { TerminalStatus } from '../../../../../src/shared/types/terminal';
import type {
  WorkspaceObservationConfirmation,
  WorkspaceObservationProjection,
} from '../../../../../src/shared/types/workspace-observation';

class FakeFileTreeItem {
  constructor(
    readonly path: string,
    private readonly directory: boolean
  ) {}

  private expanded = false;

  isDirectory() {
    return this.directory;
  }

  isExpanded() {
    return this.expanded;
  }

  expand() {
    this.expanded = true;
  }

  collapse() {
    this.expanded = false;
  }

  isSelected() {
    return false;
  }

  isFocused() {
    return false;
  }

  select() {}

  deselect() {}
}

class FakeFileTreeModel {
  private items = new Map<string, FakeFileTreeItem>();

  constructor(paths: readonly string[]) {
    for (const path of paths) {
      this.items.set(path, new FakeFileTreeItem(path, false));

      let parent = parentOf(path);
      while (parent) {
        if (!this.items.has(parent)) {
          this.items.set(parent, new FakeFileTreeItem(parent, true));
        }
        parent = parentOf(parent);
      }
    }
  }

  getItem(path: string) {
    return this.items.get(path) ?? null;
  }

  getDirectory(path: string) {
    const item = this.items.get(path);
    if (!item?.isDirectory()) throw new Error(`Missing fake directory: ${path}`);
    return item;
  }

  batch(
    operation:
      | readonly unknown[]
      | ((store: { expand: (path: string) => void; collapse: (path: string) => void }) => void)
  ) {
    if (typeof operation !== 'function') return;
    operation({
      expand: (path) => this.getDirectory(path).expand(),
      collapse: (path) => this.getDirectory(path).collapse(),
    });
  }

  getFocusedPath() {
    return mockFocusedPath;
  }

  getSelectedPaths() {
    return [];
  }

  focusPath() {}

  scrollToPath = vi.fn();

  resetPaths = vi.fn();

  setGitStatus() {}

  setSearch() {}
}

function parentOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

let latestModel: FakeFileTreeModel | null = null;
let latestPaths: string[] = [];
let latestDragAndDrop:
  | false
  | {
      canDrag?: (paths: string[]) => boolean;
      canDrop?: (...args: unknown[]) => boolean;
      onDropComplete?: (event: {
        draggedPaths: string[];
        operation: 'batch' | 'move';
        target: {
          kind: 'directory' | 'root';
          directoryPath: string | null;
          flattenedSegmentPath: string | null;
          hoveredPath: string | null;
        };
      }) => void;
    } = false;
let renderMockRowMenu = false;
let renderMockFileRowMenu = false;
let renderMockRows = false;
let mockDirectoryMenuPath = 'src/';
let mockFileMenuPath = 'src/index.ts';
let mockRenderedRowPaths = ['src/a.ts', 'src/b.ts'];
let mockSearchValue: string | null = null;
let mockFocusedPath: string | null = null;
let mockSearchMatches: string[] = [];
let latestStickyFolders: boolean | undefined;
let latestTreeStyle: Record<string, unknown> | undefined;
let latestUnsafeCSS = '';
let mockSetSearchValue: ReturnType<typeof vi.fn> = vi.fn();

vi.mock('@pierre/trees', () => ({
  themeToTreeStyles: () => ({}),
}));

vi.mock('@pierre/trees/react', () => ({
  FileTree: ({
    header,
    renderContextMenu,
    style,
  }: {
    header?: React.ReactNode;
    style?: Record<string, unknown>;
    renderContextMenu?: (
      item: { kind: 'file' | 'directory'; name: string; path: string },
      ctx: {
        anchorElement: HTMLElement;
        anchorRect: DOMRect;
        close: () => void;
      }
    ) => React.ReactNode;
  }) => (
    <div data-testid="mock-file-tree" ref={() => (latestTreeStyle = style)}>
      {header}
      {renderMockRowMenu &&
        renderContextMenu?.(
          {
            kind: 'directory',
            name: mockDirectoryMenuPath.split('/').filter(Boolean).at(-1) ?? '',
            path: mockDirectoryMenuPath,
          },
          {
            anchorElement: document.body,
            anchorRect: new DOMRect(0, 0, 100, 20),
            close: vi.fn(),
          }
        )}
      {renderMockFileRowMenu &&
        renderContextMenu?.(
          {
            kind: 'file',
            name: mockFileMenuPath.split('/').at(-1) ?? '',
            path: mockFileMenuPath,
          },
          {
            anchorElement: document.body,
            anchorRect: new DOMRect(0, 0, 100, 20),
            close: vi.fn(),
          }
        )}
      {renderMockRows && (
        <>
          {mockRenderedRowPaths.map((path) => (
            <button
              key={path}
              type="button"
              data-type="item"
              data-item-type="file"
              data-item-path={path}
            >
              {path.slice(path.lastIndexOf('/') + 1)}
            </button>
          ))}
        </>
      )}
    </div>
  ),
  useFileTree: ({
    paths,
    dragAndDrop,
    unsafeCSS,
    stickyFolders,
  }: {
    paths: string[];
    dragAndDrop: typeof latestDragAndDrop;
    unsafeCSS?: string;
    stickyFolders?: boolean;
  }) => {
    latestPaths = paths;
    latestStickyFolders = stickyFolders;
    latestUnsafeCSS = unsafeCSS ?? '';
    latestDragAndDrop = dragAndDrop;
    latestModel = new FakeFileTreeModel(paths);
    return { model: latestModel };
  },
  useFileTreeSearch: () => ({
    isOpen: mockSearchValue != null,
    matchingPaths: mockSearchMatches,
    value: mockSearchValue,
    setValue: mockSetSearchValue,
    focusNextMatch: vi.fn(),
    focusPreviousMatch: vi.fn(),
  }),
  useFileTreeSelector: <T,>(model: FakeFileTreeModel, selector: (model: FakeFileTreeModel) => T) =>
    selector(model),
}));

vi.mock('@/components/ui/context-menu', async () => {
  const React = await import('react');

  const Passthrough = ({ children }: { children: React.ReactNode }) => <>{children}</>;
  const Item = ({ children, onSelect }: { children: React.ReactNode; onSelect?: () => void }) => (
    <button type="button" onClick={onSelect}>
      {children}
    </button>
  );

  return {
    ContextMenu: Passthrough,
    ContextMenuContent: Passthrough,
    ContextMenuItem: Item,
    ContextMenuSeparator: () => <hr />,
    ContextMenuTrigger: Passthrough,
  };
});

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const mockCreateNote = vi.hoisted(() => vi.fn());
vi.mock('@/lib/notes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../../src/renderer/lib/notes')>()),
  createNote: mockCreateNote,
}));

vi.mock('@/hooks/useKomlaEditorTheme', () => ({
  useKomlaEditorTheme: () => 'dark',
}));

describe('SidebarFileTree context menu actions', () => {
  beforeEach(() => {
    latestModel = null;
    latestPaths = [];
    latestDragAndDrop = false;
    renderMockRowMenu = false;
    renderMockFileRowMenu = false;
    renderMockRows = false;
    mockDirectoryMenuPath = 'src/';
    mockFileMenuPath = 'src/index.ts';
    mockRenderedRowPaths = ['src/a.ts', 'src/b.ts'];
    mockSearchValue = null;
    mockFocusedPath = null;
    mockSearchMatches = [];
    latestTreeStyle = undefined;
    latestUnsafeCSS = '';
    mockSetSearchValue = vi.fn((value: string | null) => {
      mockSearchValue = value;
    });
    globalThis.ResizeObserver = class {
      observe() {}
      disconnect() {}
    } as typeof ResizeObserver;

    useFileListStore.setState({
      cache: new Map([
        [
          '/repo',
          {
            files: ['src/components/Button.tsx', 'src/index.ts'],
            gitIgnoredFiles: [],
            emptyDirs: [],
            isLoading: false,
          },
        ],
      ]),
      statusCache: new Map(),
    });
    useFileViewerStore.setState({ showGitIgnoredByWorkspace: {} });
    useWorkspacesStore.setState({ workspaces: [] });
    useWorkspaceObservationStore.setState({ projections: new Map() });

    window.api = {
      ...(window.api ?? {}),
      showItemInFolder: vi.fn(),
      openPath: vi.fn().mockResolvedValue(''),
      listWorkspaceFiles: vi.fn().mockResolvedValue({
        files: ['src/components/Button.tsx', 'src/index.ts'],
        gitIgnoredFiles: [],
        emptyDirs: [],
      }),
    } as typeof window.api;
  });

  it('allows dragging files out of remote trees without accepting moves', () => {
    render(
      <SidebarFileTree
        workspaceId="workspace-1"
        workingDirectory="ssh://ssh-dev/home/dev/repo"
        isRemoteWorkspace
        currentFile={null}
        onFileSelect={vi.fn()}
      />
    );

    expect(latestDragAndDrop).not.toBe(false);
    expect(latestDragAndDrop && latestDragAndDrop.canDrag?.(['src/index.ts'])).toBe(true);
    expect(latestDragAndDrop && latestDragAndDrop.canDrop?.()).toBe(false);
  });

  it('refreshes a mounted remote browse tree periodically', async () => {
    vi.useFakeTimers();
    const workingDirectory = 'ssh://ssh-dev/home/dev/repo';
    useFileListStore.setState({
      cache: new Map([
        [
          workingDirectory,
          {
            files: ['src/index.ts'],
            gitIgnoredFiles: [],
            emptyDirs: [],
            isLoading: false,
          },
        ],
      ]),
    });

    const view = render(
      <SidebarFileTree
        workspaceId="workspace-1"
        workingDirectory={workingDirectory}
        isRemoteWorkspace
        currentFile={null}
        onFileSelect={vi.fn()}
      />
    );
    await act(async () => {});
    vi.mocked(window.api.listWorkspaceFiles).mockClear();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_999);
    });
    expect(window.api.listWorkspaceFiles).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(window.api.listWorkspaceFiles).toHaveBeenCalledWith('workspace-1', false);
    view.unmount();
    vi.useRealTimers();
  });

  it('re-lists a remote tree when it comes on screen', async () => {
    const workingDirectory = 'ssh://ssh-dev/home/dev/repo';
    useFileListStore.setState({
      cache: new Map([
        [
          workingDirectory,
          { files: ['src/index.ts'], gitIgnoredFiles: [], emptyDirs: [], isLoading: false },
        ],
      ]),
    });
    const tree = (isVisible: boolean) => (
      <SidebarFileTree
        workspaceId="workspace-1"
        workingDirectory={workingDirectory}
        isRemoteWorkspace
        isVisible={isVisible}
        currentFile={null}
        onFileSelect={vi.fn()}
      />
    );

    const view = render(tree(false));
    await act(async () => {});
    expect(window.api.listWorkspaceFiles).not.toHaveBeenCalled();
    view.rerender(tree(true));
    await act(async () => {});

    expect(window.api.listWorkspaceFiles).toHaveBeenCalledTimes(1);
    expect(window.api.listWorkspaceFiles).toHaveBeenCalledWith('workspace-1', false);
    view.unmount();
  });

  it('re-lists a shown remote tree whose list goes stale, but leaves a hidden one for later', async () => {
    const workingDirectory = 'ssh://ssh-dev/home/dev/repo';
    useFileListStore.setState({
      cache: new Map([
        [
          workingDirectory,
          { files: ['src/index.ts'], gitIgnoredFiles: [], emptyDirs: [], isLoading: false },
        ],
      ]),
    });
    const tree = (isVisible: boolean) => (
      <SidebarFileTree
        workspaceId="workspace-1"
        workingDirectory={workingDirectory}
        isRemoteWorkspace
        isVisible={isVisible}
        currentFile={null}
        onFileSelect={vi.fn()}
      />
    );

    const view = render(tree(false));
    await act(async () => {
      useFileListStore.getState().markFileListStale(workingDirectory);
    });
    expect(window.api.listWorkspaceFiles).not.toHaveBeenCalled();

    view.rerender(tree(true));
    await act(async () => {});
    expect(window.api.listWorkspaceFiles).toHaveBeenCalledTimes(1);
    expect(useFileListStore.getState().getFileList(workingDirectory)?.isStale).toBeUndefined();

    await act(async () => {
      useFileListStore.getState().markFileListStale(workingDirectory);
    });
    expect(window.api.listWorkspaceFiles).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it('does not poll a hidden remote browse tree', async () => {
    vi.useFakeTimers();
    const workingDirectory = 'ssh://ssh-dev/home/dev/repo';
    useFileListStore.setState({
      cache: new Map([
        [
          workingDirectory,
          {
            files: ['src/index.ts'],
            gitIgnoredFiles: [],
            emptyDirs: [],
            isLoading: false,
          },
        ],
      ]),
    });

    const view = render(
      <SidebarFileTree
        workspaceId="workspace-1"
        workingDirectory={workingDirectory}
        isRemoteWorkspace
        isVisible={false}
        currentFile={null}
        onFileSelect={vi.fn()}
      />
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    expect(window.api.listWorkspaceFiles).not.toHaveBeenCalled();
    view.unmount();
    vi.useRealTimers();
  });

  describe('when the Remote Companion watches the workspace', () => {
    const workingDirectory = 'ssh://ssh-dev/home/dev/repo';

    function prepareRemoteWorkspace({
      terminalStatus = 'running',
      confirmation = { kind: 'current', confirmedAt: 1 },
      managedLinkPaths,
    }: {
      terminalStatus?: TerminalStatus;
      confirmation?: WorkspaceObservationConfirmation;
      managedLinkPaths?: string[];
    } = {}) {
      vi.mocked(window.api.listWorkspaceFiles).mockResolvedValue({
        files: ['src/index.ts'],
        gitIgnoredFiles: [],
        emptyDirs: [],
        ...(managedLinkPaths ? { managedLinkPaths } : {}),
      });
      useFileListStore.setState({
        cache: new Map([
          [
            workingDirectory,
            {
              files: ['src/index.ts'],
              gitIgnoredFiles: [],
              emptyDirs: [],
              ...(managedLinkPaths ? { managedLinkPaths } : {}),
              isLoading: false,
            },
          ],
        ]),
      });
      useWorkspacesStore.setState({
        workspaces: [
          createSshWorkspace({
            id: 'workspace-1',
            workingDirectory,
            terminals: [createTerminal({ status: terminalStatus })],
          }),
        ],
      });
      useWorkspaceObservationStore.setState({
        projections: new Map([
          [
            'workspace-1',
            {
              workspaceId: 'workspace-1',
              revision: 1,
              confirmation,
            } as WorkspaceObservationProjection,
          ],
        ]),
      });
    }

    // Leaves out the re-list a tree makes when it comes on screen.
    async function renderRemoteTree() {
      vi.useFakeTimers();
      const view = render(
        <SidebarFileTree
          workspaceId="workspace-1"
          workingDirectory={workingDirectory}
          isRemoteWorkspace
          currentFile={null}
          onFileSelect={vi.fn()}
        />
      );
      await act(async () => {});
      vi.mocked(window.api.listWorkspaceFiles).mockClear();
      return view;
    }

    async function listingsDuring(ms: number) {
      const view = await renderRemoteTree();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
      const calls = vi.mocked(window.api.listWorkspaceFiles).mock.calls;
      view.unmount();
      vi.useRealTimers();
      return calls;
    }

    it('checks only once a minute, since its file-change reports re-list the tree', async () => {
      prepareRemoteWorkspace();
      const view = await renderRemoteTree();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(59_999);
      });
      expect(window.api.listWorkspaceFiles).not.toHaveBeenCalled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(window.api.listWorkspaceFiles).toHaveBeenCalledWith('workspace-1', false);
      view.unmount();
      vi.useRealTimers();
    });

    it('polls while the companion is not confirming the workspace status', async () => {
      prepareRemoteWorkspace({
        confirmation: {
          kind: 'stale',
          staleSince: 2,
          lastConfirmedAt: 1,
          reason: 'source-unreachable',
        },
      });

      expect(await listingsDuring(5_000)).toContainEqual(['workspace-1', false]);
    });

    it('polls when no terminal runs in the workspace, since the companion skips it', async () => {
      prepareRemoteWorkspace({ terminalStatus: 'stopped' });

      expect(await listingsDuring(5_000)).toContainEqual(['workspace-1', false]);
    });

    it('polls while the tree shows ignored files, which the companion does not watch', async () => {
      prepareRemoteWorkspace();
      useFileViewerStore.setState({ showGitIgnoredByWorkspace: { 'workspace-1': true } });

      expect(await listingsDuring(5_000)).toContainEqual(['workspace-1', true]);
    });

    it('polls when the tree includes linked workspaces, which the companion does not watch', async () => {
      prepareRemoteWorkspace({ managedLinkPaths: ['linked-workspaces/other'] });

      expect(await listingsDuring(5_000)).toContainEqual(['workspace-1', false]);
    });
  });

  it('offers deletion for files in remote trees', () => {
    renderMockFileRowMenu = true;
    const onDeleteFile = vi.fn();
    useFileListStore.setState({
      cache: new Map([
        [
          'ssh://ssh-dev/home/dev/repo',
          {
            files: ['src/components/Button.tsx', 'src/index.ts'],
            gitIgnoredFiles: [],
            emptyDirs: [],
            isLoading: false,
          },
        ],
      ]),
    });

    render(
      <SidebarFileTree
        workspaceId="workspace-1"
        workingDirectory="ssh://ssh-dev/home/dev/repo"
        isRemoteWorkspace
        currentFile={null}
        onFileSelect={vi.fn()}
        onDeleteFile={onDeleteFile}
      />
    );

    fireEvent.click(screen.getByRole('menuitem', { name: /delete file/i }));

    expect(onDeleteFile).toHaveBeenCalledWith('src/index.ts');
  });

  it('opens a file in a new tab or split beside the focused pane', () => {
    renderMockFileRowMenu = true;
    const onOpenInPane = vi.fn();
    useFileListStore.setState({
      cache: new Map([
        [
          'ssh://ssh-dev/home/dev/repo',
          { files: ['src/index.ts'], gitIgnoredFiles: [], emptyDirs: [], isLoading: false },
        ],
      ]),
    });

    const { rerender } = render(
      <SidebarFileTree
        workspaceId="workspace-1"
        workingDirectory="ssh://ssh-dev/home/dev/repo"
        isRemoteWorkspace
        currentFile={null}
        onFileSelect={vi.fn()}
        onOpenInPane={onOpenInPane}
      />
    );
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open in New Tab' }));
    expect(onOpenInPane).toHaveBeenLastCalledWith('src/index.ts', { kind: 'tab' });

    rerender(
      <SidebarFileTree
        workspaceId="workspace-1"
        workingDirectory="ssh://ssh-dev/home/dev/repo"
        isRemoteWorkspace
        currentFile={null}
        onFileSelect={vi.fn()}
        onOpenInPane={onOpenInPane}
      />
    );
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open in Split Down' }));
    expect(onOpenInPane).toHaveBeenLastCalledWith('src/index.ts', {
      kind: 'split',
      direction: 'horizontal',
    });
  });

  it('renders one divider before remote file destructive actions when no middle actions exist', () => {
    renderMockFileRowMenu = true;
    useFileListStore.setState({
      cache: new Map([
        [
          'ssh://ssh-dev/home/dev/repo',
          {
            files: ['src/index.ts'],
            gitIgnoredFiles: [],
            emptyDirs: [],
            isLoading: false,
          },
        ],
      ]),
    });

    render(
      <SidebarFileTree
        workspaceId="workspace-1"
        workingDirectory="ssh://ssh-dev/home/dev/repo"
        isRemoteWorkspace
        currentFile={null}
        onFileSelect={vi.fn()}
        onRollbackAll={vi.fn()}
        onDeleteFile={vi.fn()}
      />
    );

    const menu = screen.getByRole('menu');
    expect(within(menu).getAllByRole('separator')).toHaveLength(1);
  });

  it('offers recursive deletion for folders in remote trees', () => {
    renderMockRowMenu = true;
    const onDeleteFile = vi.fn();
    useFileListStore.setState({
      cache: new Map([
        [
          'ssh://ssh-dev/home/dev/repo',
          {
            files: ['src/components/Button.tsx', 'src/index.ts'],
            gitIgnoredFiles: [],
            emptyDirs: [],
            isLoading: false,
          },
        ],
      ]),
    });

    render(
      <SidebarFileTree
        workspaceId="workspace-1"
        workingDirectory="ssh://ssh-dev/home/dev/repo"
        isRemoteWorkspace
        currentFile={null}
        onFileSelect={vi.fn()}
        onDeleteFile={onDeleteFile}
      />
    );

    fireEvent.click(screen.getByRole('menuitem', { name: /^delete$/i }));

    expect(onDeleteFile).toHaveBeenCalledWith('src', true);
  });

  it.each(['linked-workspaces/', 'linked-workspaces/peer/'])(
    'does not offer direct deletion for the managed link path %s',
    (path) => {
      renderMockRowMenu = true;
      mockDirectoryMenuPath = path;
      useFileListStore.setState({
        cache: new Map([
          [
            'ssh://ssh-dev/home/dev/repo',
            {
              files: ['linked-workspaces/peer/file.ts'],
              gitIgnoredFiles: [],
              emptyDirs: [],
              managedLinkPaths: ['linked-workspaces/peer'],
              isLoading: false,
            },
          ],
        ]),
      });

      render(
        <SidebarFileTree
          workspaceId="workspace-1"
          workingDirectory="ssh://ssh-dev/home/dev/repo"
          isRemoteWorkspace
          currentFile={null}
          onFileSelect={vi.fn()}
          onDeleteFile={vi.fn()}
        />
      );

      expect(screen.queryByRole('menuitem', { name: /^delete$/i })).not.toBeInTheDocument();
    }
  );

  it('offers deletion for ordinary content directly under linked-workspaces', () => {
    renderMockFileRowMenu = true;
    mockFileMenuPath = 'linked-workspaces/notes.txt';
    useFileListStore.setState({
      cache: new Map([
        [
          'ssh://ssh-dev/home/dev/repo',
          {
            files: ['linked-workspaces/notes.txt'],
            gitIgnoredFiles: [],
            emptyDirs: [],
            isLoading: false,
          },
        ],
      ]),
    });

    render(
      <SidebarFileTree
        workspaceId="workspace-1"
        workingDirectory="ssh://ssh-dev/home/dev/repo"
        isRemoteWorkspace
        currentFile={null}
        onFileSelect={vi.fn()}
        onDeleteFile={vi.fn()}
      />
    );

    expect(screen.getByRole('menuitem', { name: /^delete file$/i })).toBeInTheDocument();
  });

  it('expands and collapses all directories from the root context menu', () => {
    render(
      <SidebarFileTree
        workspaceId="workspace-1"
        workingDirectory="/repo"
        currentFile={null}
        onFileSelect={vi.fn()}
      />
    );

    expect(screen.getByTestId('mock-file-tree')).toBeInTheDocument();
    expect(latestModel?.getDirectory('src').isExpanded()).toBe(false);
    expect(latestModel?.getDirectory('src/components').isExpanded()).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: /expand all/i }));

    expect(latestModel?.getDirectory('src').isExpanded()).toBe(true);
    expect(latestModel?.getDirectory('src/components').isExpanded()).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: /^collapse all$/i }));

    expect(latestModel?.getDirectory('src').isExpanded()).toBe(false);
    expect(latestModel?.getDirectory('src/components').isExpanded()).toBe(false);
  });

  it('keeps the tree paths when a status push changes nothing but statuses', () => {
    const setStatuses = (statuses: [string, 'modified' | 'deleted'][]) =>
      act(() => {
        useFileListStore.setState({
          statusCache: new Map([['/repo', { statuses: new Map(statuses), isLoading: false }]]),
        });
      });
    window.api.getChangedFilesWithSummary = vi.fn().mockReturnValue(new Promise(() => {}));
    render(
      <SidebarFileTree
        workspaceId="workspace-1"
        workingDirectory="/repo"
        currentFile={null}
        onFileSelect={vi.fn()}
      />
    );
    setStatuses([['src/index.ts', 'modified']]);
    const pathsBefore = latestPaths;

    setStatuses([['src/index.ts', 'modified']]);
    setStatuses([
      ['src/index.ts', 'modified'],
      ['src', 'modified'],
    ]);
    expect(latestPaths).toBe(pathsBefore);

    setStatuses([['src/index.ts', 'deleted']]);
    expect(latestPaths).toEqual(['src/components/Button.tsx']);
  });

  describe('keyboard shortcuts', () => {
    function renderTree(props: Partial<React.ComponentProps<typeof SidebarFileTree>> = {}) {
      renderMockRows = true;
      mockRenderedRowPaths = ['src/index.ts'];
      render(
        <SidebarFileTree
          workspaceId="workspace-1"
          workingDirectory="/repo"
          currentFile={null}
          onFileSelect={vi.fn()}
          {...props}
        />
      );
      return screen.getByRole('button', { name: 'index.ts' });
    }

    it('deletes the focused folder, as its row menu does', () => {
      mockFocusedPath = 'src/';
      const onDeleteFile = vi.fn();
      const row = renderTree({ onDeleteFile });

      fireEvent.keyDown(row, { key: 'Delete' });

      expect(onDeleteFile).toHaveBeenCalledWith('src', true);
    });

    it('deletes with Cmd+Backspace, the macOS convention', () => {
      mockFocusedPath = 'src/index.ts';
      const onDeleteFile = vi.fn();
      const row = renderTree({ onDeleteFile });

      fireEvent.keyDown(row, { key: 'Backspace', metaKey: true });

      expect(onDeleteFile).toHaveBeenCalledWith('src/index.ts');
    });

    it('ignores keys pressed on other controls in the panel', () => {
      mockFocusedPath = 'src/index.ts';
      const onDeleteFile = vi.fn();
      const onFileDoubleClick = vi.fn();
      renderTree({ onDeleteFile, onFileDoubleClick });
      const toggle = screen.getByRole('button', { name: /show ignored files/i });

      fireEvent.keyDown(toggle, { key: 'Delete' });
      fireEvent.keyDown(toggle, { key: 'Enter' });

      expect(onDeleteFile).not.toHaveBeenCalled();
      expect(onFileDoubleClick).not.toHaveBeenCalled();
    });

    it('handles keys pressed on the panel itself, which has focus before the rows load', () => {
      mockFocusedPath = null;
      const onPasteInto = vi.fn();
      renderTree({ onPasteInto, hasCopiedFile: true });
      const panel = screen.getByTestId('mock-file-tree').closest<HTMLElement>('[tabindex="-1"]')!;

      fireEvent.keyDown(panel, { key: 'v', metaKey: true });

      expect(onPasteInto).toHaveBeenCalledWith('');
    });

    it('adds a letter typed on a row to the open search', () => {
      mockSearchValue = 'but';
      mockSearchMatches = ['src/index.ts'];
      const row = renderTree();
      const input = screen.getByPlaceholderText('Search');
      fireEvent.blur(input);

      fireEvent.keyDown(row, { key: 't' });

      expect(mockSetSearchValue).toHaveBeenCalledWith('butt');
      expect(input).toHaveFocus();
    });

    it('claims the keys it handles, so the file viewer does not act on them too', () => {
      mockFocusedPath = 'src/index.ts';
      const onCopyNode = vi.fn();
      const row = renderTree({ onCopyNode });
      const claimed: boolean[] = [];
      const listener = (e: KeyboardEvent) => claimed.push(isShortcutEventClaimed(e));
      window.addEventListener('keydown', listener);

      fireEvent.keyDown(row, { key: 'c', metaKey: true });
      fireEvent.keyDown(row, { key: 'ArrowDown' });
      window.removeEventListener('keydown', listener);

      expect(onCopyNode).toHaveBeenCalledWith('src/index.ts', false);
      expect(claimed).toEqual([true, false]);
    });
  });

  describe('search', () => {
    function renderTree(props: Partial<React.ComponentProps<typeof SidebarFileTree>> = {}) {
      const onFileSelect = vi.fn();
      const tree = () => (
        <SidebarFileTree
          workspaceId="workspace-1"
          workingDirectory="/repo"
          currentFile={null}
          onFileSelect={onFileSelect}
          {...props}
        />
      );
      const view = render(tree());
      return () => view.rerender(tree());
    }

    it('moves focus to the search box when typing on a row opens the tree search', () => {
      const rerender = renderTree();

      mockSearchValue = 'b';
      mockSearchMatches = ['src/components/Button.tsx'];
      rerender();

      const input = screen.getByPlaceholderText('Search');
      expect(input).toHaveFocus();
      expect(input).toHaveValue('b');
    });

    it('opens nothing on Enter when no file matches the search', () => {
      mockSearchValue = 'zzz';
      mockFocusedPath = 'src/index.ts';
      const onFileSelect = vi.fn();
      renderTree({ onFileSelect });

      fireEvent.keyDown(screen.getByPlaceholderText('Search'), { key: 'Enter' });

      expect(onFileSelect).not.toHaveBeenCalled();
    });

    it('says when no file matches the search, instead of showing the whole tree', () => {
      mockSearchValue = 'zzz';
      renderTree();

      expect(screen.getByText(/no files match/i)).toBeInTheDocument();
    });
  });

  it('moves through the row menu with the arrow keys', async () => {
    renderMockFileRowMenu = true;
    render(
      <SidebarFileTree
        workspaceId="workspace-1"
        workingDirectory="/repo"
        currentFile={null}
        onFileSelect={vi.fn()}
      />
    );
    const menu = screen.getByRole('menu');
    await waitFor(() => expect(menu).toHaveFocus());
    const items = within(menu).getAllByRole('menuitem');
    const claimed: boolean[] = [];
    const listener = (e: KeyboardEvent) => claimed.push(isShortcutEventClaimed(e));
    window.addEventListener('keydown', listener);

    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(items[0]).toHaveFocus();
    fireEvent.keyDown(items[0], { key: 'ArrowDown' });
    expect(items[1]).toHaveFocus();
    fireEvent.keyDown(items[1], { key: 'ArrowUp' });
    fireEvent.keyDown(items[0], { key: 'ArrowUp' });
    expect(items.at(-1)).toHaveFocus();
    window.removeEventListener('keydown', listener);

    expect(claimed).toEqual([true, true, true, true]);
  });

  it("keeps letters typed in a changes-view row menu from the file viewer's shortcuts", async () => {
    renderMockFileRowMenu = true;
    render(
      <SidebarFileTree
        workspaceId="workspace-1"
        workingDirectory="/repo"
        currentFile={null}
        onFileSelect={vi.fn()}
        changedFilesOnly
        changedFiles={[{ path: mockFileMenuPath }]}
      />
    );
    const menu = screen.getByRole('menu');
    await waitFor(() => expect(menu).toHaveFocus());
    const claimed: boolean[] = [];
    const listener = (e: KeyboardEvent) => claimed.push(isShortcutEventClaimed(e));
    window.addEventListener('keydown', listener);

    fireEvent.keyDown(menu, { key: 'j' });
    window.removeEventListener('keydown', listener);

    expect(claimed).toEqual([true]);
  });

  it('opens no empty menu for a deleted page, which has nothing to preview', () => {
    renderMockFileRowMenu = true;
    mockFileMenuPath = 'site/index.html';

    render(
      <SidebarFileTree
        workspaceId="workspace-1"
        workingDirectory="ssh://ssh-dev/home/dev/repo"
        isRemoteWorkspace
        currentFile={null}
        onFileSelect={vi.fn()}
        changedFilesOnly
        changedFiles={[{ path: 'site/index.html' }]}
        diffFileStatuses={new Map([['site/index.html', 'deleted']])}
        onOpenHtmlInBrowser={vi.fn()}
      />
    );

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('keeps collapse and search buttons out of the header, in both views', () => {
    const tree = (changedFilesOnly: boolean) => (
      <SidebarFileTree
        workspaceId="workspace-1"
        workingDirectory="/repo"
        currentFile={null}
        onFileSelect={vi.fn()}
        changedFilesOnly={changedFilesOnly}
        changedFiles={[]}
      />
    );
    const { rerender } = render(tree(false));
    expect(screen.queryByRole('button', { name: /collapse all folders/i })).toBeNull();

    rerender(tree(true));
    expect(screen.queryByRole('button', { name: /collapse all folders/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /search changed files/i })).toBeNull();
  });

  it('creates a file at the root from the header, in local workspaces only', () => {
    const onCreateFile = vi.fn();
    const { unmount } = render(
      <SidebarFileTree
        workspaceId="workspace-1"
        workingDirectory="/repo"
        currentFile={null}
        onFileSelect={vi.fn()}
        onCreateFile={onCreateFile}
      />
    );

    // The empty-area menu's "New File" renders as a button in this mock too.
    const header = screen.getByRole('button', { name: /show ignored files/i }).parentElement!;
    fireEvent.click(within(header).getByRole('button', { name: /^new file$/i }));
    expect(onCreateFile).toHaveBeenCalledWith('');
    unmount();

    render(
      <SidebarFileTree
        workspaceId="workspace-1"
        workingDirectory="ssh://ssh-dev/home/dev/repo"
        isRemoteWorkspace
        currentFile={null}
        onFileSelect={vi.fn()}
        onCreateFile={onCreateFile}
      />
    );
    const remoteHeader = screen.getByRole('button', { name: /show ignored files/i }).parentElement!;
    expect(within(remoteHeader).queryByRole('button', { name: /^new file$/i })).toBeNull();
  });

  it('pins the folders of rows scrolled past, on an opaque band', () => {
    render(
      <SidebarFileTree
        workspaceId="workspace-1"
        workingDirectory="/repo"
        currentFile={null}
        onFileSelect={vi.fn()}
      />
    );

    expect(latestStickyFolders).toBe(true);
    // The tree's own background is transparent, which would let rows show
    // through the pinned folders.
    expect(latestUnsafeCSS).toMatch(
      /\[data-file-tree-sticky-overlay-content='true'\]\s*\{[^}]*background-color: oklch\(var\(--card\)\)/
    );
  });

  it('removes duplicate paths before constructing the tree', () => {
    render(
      <SidebarFileTree
        workspaceId="workspace-1"
        workingDirectory="/repo"
        currentFile={null}
        onFileSelect={vi.fn()}
        changedFilesOnly
        changedFiles={[
          { path: 'internal/db/sqlite_extractor.go' },
          { path: 'internal/db/sqlite_extractor.go' },
        ]}
      />
    );

    expect(latestPaths).toEqual(['internal/db/sqlite_extractor.go']);
  });

  it('pins Komla-managed folders without adding a fake folder', () => {
    useFileListStore.setState({
      cache: new Map([
        [
          '/repo',
          {
            files: ['.komla-files/design.png', 'linked-workspaces/peer/src/index.ts', 'src/app.ts'],
            gitIgnoredFiles: [],
            emptyDirs: [],
            isLoading: false,
          },
        ],
      ]),
    });

    render(
      <SidebarFileTree
        workspaceId="workspace-1"
        workingDirectory="/repo"
        currentFile={null}
        onFileSelect={vi.fn()}
      />
    );

    expect(latestPaths).toEqual([
      '.komla-files/design.png',
      'linked-workspaces/peer/src/index.ts',
      'src/app.ts',
    ]);
  });

  it('keeps the normal project tree when no Komla-managed folder exists', () => {
    render(
      <SidebarFileTree
        workspaceId="workspace-1"
        workingDirectory="/repo"
        currentFile={null}
        onFileSelect={vi.fn()}
      />
    );

    expect(latestPaths).toEqual(['src/components/Button.tsx', 'src/index.ts']);
  });

  it('shows the Komla section for an existing empty managed folder', () => {
    useFileListStore.setState({
      cache: new Map([
        [
          '/repo',
          {
            files: ['src/app.ts'],
            gitIgnoredFiles: [],
            emptyDirs: ['.komla-files'],
            isLoading: false,
          },
        ],
      ]),
    });

    render(
      <SidebarFileTree
        workspaceId="workspace-1"
        workingDirectory="/repo"
        currentFile={null}
        onFileSelect={vi.fn()}
      />
    );

    expect(latestPaths).toEqual(['.komla-files/', 'src/app.ts']);
  });

  it('shows Komla imports without exposing ignored project files', () => {
    useFileListStore.setState({
      cache: new Map([
        [
          '/repo',
          {
            files: ['src/app.ts', '.komla-files/design.png'],
            gitIgnoredFiles: ['dist/app.js'],
            emptyDirs: [],
            isLoading: false,
          },
        ],
      ]),
    });

    render(
      <SidebarFileTree
        workspaceId="workspace-1"
        workingDirectory="/repo"
        currentFile={null}
        onFileSelect={vi.fn()}
      />
    );

    expect(latestPaths).toEqual(['.komla-files/design.png', 'src/app.ts']);
  });

  it('re-hides cached ignored linked files while retaining their managed directory', () => {
    useFileListStore.setState({
      cache: new Map([
        [
          '/repo',
          {
            files: [],
            gitIgnoredFiles: ['linked-workspaces/peer/.env'],
            emptyDirs: [],
            managedLinkPaths: ['linked-workspaces/peer'],
            isLoading: false,
          },
        ],
      ]),
    });
    useFileViewerStore.setState({ showGitIgnoredByWorkspace: { 'workspace-1': true } });

    render(
      <SidebarFileTree
        workspaceId="workspace-1"
        workingDirectory="/repo"
        currentFile={null}
        onFileSelect={vi.fn()}
      />
    );

    expect(latestPaths).toContain('linked-workspaces/peer/.env');

    act(() => useFileViewerStore.getState().toggleShowGitIgnored('workspace-1'));

    expect(latestPaths).toEqual(['linked-workspaces/peer/']);
  });

  it('opens files by their real workspace paths from the managed section', () => {
    renderMockRows = true;
    mockRenderedRowPaths = ['.komla-files/design.png', 'src/app.ts'];
    useFileListStore.setState({
      cache: new Map([
        [
          '/repo',
          {
            files: ['.komla-files/design.png', 'src/app.ts'],
            gitIgnoredFiles: [],
            emptyDirs: [],
            isLoading: false,
          },
        ],
      ]),
    });
    const onFileSelect = vi.fn();

    render(
      <SidebarFileTree
        workspaceId="workspace-1"
        workingDirectory="/repo"
        currentFile={null}
        onFileSelect={onFileSelect}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'design.png' }));
    fireEvent.click(screen.getByRole('button', { name: 'app.ts' }));

    expect(onFileSelect).toHaveBeenNthCalledWith(1, '.komla-files/design.png');
    expect(onFileSelect).toHaveBeenNthCalledWith(2, 'src/app.ts');
  });

  it('shows a spinner while branch comparison stats are loading', () => {
    render(
      <SidebarFileTree
        workspaceId="workspace-1"
        workingDirectory="/repo"
        currentFile={null}
        onFileSelect={vi.fn()}
        changedFilesOnly
        changedFiles={[]}
        onToggleBranchComparison={vi.fn()}
        diffLoading
      />
    );

    const button = screen.getByRole('button', { name: 'Loading changes' });
    expect(button).toBeDisabled();
    expect(button.querySelector('svg')).toHaveClass('animate-spin');
  });

  it('expands and collapses a directory row when Pierre provides a canonical trailing slash path', () => {
    renderMockRowMenu = true;

    render(
      <SidebarFileTree
        workspaceId="workspace-1"
        workingDirectory="/repo"
        currentFile={null}
        onFileSelect={vi.fn()}
      />
    );

    expect(latestModel?.getDirectory('src').isExpanded()).toBe(false);
    expect(latestModel?.getDirectory('src/components').isExpanded()).toBe(false);

    const rowMenu = screen.getByRole('menu');
    fireEvent.click(within(rowMenu).getByRole('menuitem', { name: /expand all/i }));

    expect(latestModel?.getDirectory('src').isExpanded()).toBe(true);
    expect(latestModel?.getDirectory('src/components').isExpanded()).toBe(true);

    fireEvent.click(within(rowMenu).getByRole('menuitem', { name: /collapse all/i }));

    expect(latestModel?.getDirectory('src').isExpanded()).toBe(false);
    expect(latestModel?.getDirectory('src/components').isExpanded()).toBe(false);
  });

  it('hands folder actions the plain folder path, not the canonical trailing slash', () => {
    renderMockRowMenu = true;
    mockDirectoryMenuPath = 'src/components/';
    const onCopyNode = vi.fn();
    const onCutNode = vi.fn();
    const onPasteInto = vi.fn();
    const onCreateFile = vi.fn();
    const onAddToGitignore = vi.fn();
    window.api.copyToClipboard = vi.fn();

    render(
      <SidebarFileTree
        workspaceId="workspace-1"
        workingDirectory="/repo"
        currentFile={null}
        onFileSelect={vi.fn()}
        onCopyNode={onCopyNode}
        onCutNode={onCutNode}
        onPasteInto={onPasteInto}
        hasCopiedFile
        onCreateFile={onCreateFile}
        onAddToGitignore={onAddToGitignore}
      />
    );

    const menu = screen.getByRole('menu');
    fireEvent.click(within(menu).getByRole('menuitem', { name: /^copy$/i }));
    fireEvent.click(within(menu).getByRole('menuitem', { name: /^cut$/i }));
    fireEvent.click(within(menu).getByRole('menuitem', { name: /^paste$/i }));
    fireEvent.click(within(menu).getByRole('menuitem', { name: /new file/i }));
    fireEvent.click(within(menu).getByRole('menuitem', { name: /add to \.gitignore/i }));
    fireEvent.click(within(menu).getByRole('menuitem', { name: /copy @path/i }));

    expect(onCopyNode).toHaveBeenCalledWith('src/components', true);
    expect(onCutNode).toHaveBeenCalledWith('src/components', true);
    expect(onPasteInto).toHaveBeenCalledWith('src/components');
    expect(onCreateFile).toHaveBeenCalledWith('src/components');
    expect(onAddToGitignore).toHaveBeenCalledWith('src/components', true);
    expect(window.api.copyToClipboard).toHaveBeenCalledWith('@src/components/ ');
  });

  function dropOnLib(draggedPaths: string[]) {
    if (!latestDragAndDrop) throw new Error('The tree accepts no drops');
    latestDragAndDrop.onDropComplete?.({
      draggedPaths,
      operation: 'batch',
      target: {
        kind: 'directory',
        directoryPath: 'lib/',
        flattenedSegmentPath: null,
        hoveredPath: 'lib/',
      },
    });
  }

  it('moves a dropped folder by its plain path into the plain target folder', async () => {
    const onMoveNodes = vi.fn().mockResolvedValue(true);

    render(
      <SidebarFileTree
        workspaceId="workspace-1"
        workingDirectory="/repo"
        currentFile={null}
        onFileSelect={vi.fn()}
        onMoveNodes={onMoveNodes}
      />
    );

    const model = latestModel!;
    const resetsBeforeDrop = model.resetPaths.mock.calls.length;
    await act(async () => dropOnLib(['src/components/', 'src/index.ts']));

    expect(onMoveNodes.mock.calls).toEqual([[['src/components', 'src/index.ts'], 'lib']]);
    expect(model.resetPaths).toHaveBeenCalledTimes(resetsBeforeDrop);
  });

  it('puts a refused drop back, since the tree already showed the move', async () => {
    const onMoveNodes = vi.fn().mockResolvedValue(false);

    render(
      <SidebarFileTree
        workspaceId="workspace-1"
        workingDirectory="/repo"
        currentFile={null}
        onFileSelect={vi.fn()}
        onMoveNodes={onMoveNodes}
      />
    );

    const model = latestModel!;
    const resetsBeforeDrop = model.resetPaths.mock.calls.length;
    await act(async () => dropOnLib(['src/components/', 'src/index.ts']));

    expect(model.resetPaths).toHaveBeenCalledTimes(resetsBeforeDrop + 1);
    expect(model.resetPaths).toHaveBeenLastCalledWith(latestPaths, expect.anything());
  });

  it('scrolls to a file opened from outside the tree', () => {
    const { rerender } = render(
      <SidebarFileTree
        workspaceId="workspace-1"
        workingDirectory="/repo"
        currentFile={null}
        onFileSelect={vi.fn()}
      />
    );
    rerender(
      <SidebarFileTree
        workspaceId="workspace-1"
        workingDirectory="/repo"
        currentFile="src/components/Button.tsx"
        onFileSelect={vi.fn()}
      />
    );

    expect(latestModel?.getDirectory('src/components').isExpanded()).toBe(true);
    expect(latestModel?.scrollToPath).toHaveBeenCalledWith('src/components/Button.tsx');
  });

  it('opens a file in the default app via its full path from the file row menu', () => {
    renderMockFileRowMenu = true;

    render(
      <SidebarFileTree
        workspaceId="workspace-1"
        workingDirectory="/repo"
        currentFile={null}
        onFileSelect={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('menuitem', { name: /open in default app/i }));

    expect(window.api.openPath).toHaveBeenCalledWith('/repo/src/index.ts');
  });

  it('opens the clicked file row while tree search is focused', () => {
    renderMockRows = true;
    const onFileSelect = vi.fn();

    render(
      <SidebarFileTree
        workspaceId="workspace-1"
        workingDirectory="/repo"
        currentFile={null}
        onFileSelect={onFileSelect}
      />
    );

    const searchInput = screen.getByPlaceholderText('Search');
    fireEvent.focus(searchInput);
    fireEvent.change(searchInput, { target: { value: 'b' } });
    const resultRow = screen.getByRole('button', { name: 'b.ts' });
    fireEvent.mouseDown(resultRow);
    fireEvent.click(resultRow);

    expect(mockSetSearchValue).toHaveBeenCalledWith('b');
    expect(onFileSelect).toHaveBeenCalledTimes(1);
    expect(onFileSelect).toHaveBeenCalledWith('src/b.ts');
  });

  it('opens the pressed search result after a rerender before click', () => {
    renderMockRows = true;
    const onFileSelect = vi.fn();
    const onFileSelectAfterRerender = vi.fn();

    const { rerender } = render(
      <SidebarFileTree
        workspaceId="workspace-1"
        workingDirectory="/repo"
        currentFile={null}
        onFileSelect={onFileSelect}
      />
    );

    const searchInput = screen.getByPlaceholderText('Search');
    fireEvent.focus(searchInput);
    fireEvent.change(searchInput, { target: { value: 'b' } });
    const resultRow = screen.getByRole('button', { name: 'b.ts' });
    fireEvent.mouseDown(resultRow);
    rerender(
      <SidebarFileTree
        workspaceId="workspace-1"
        workingDirectory="/repo"
        currentFile={null}
        onFileSelect={onFileSelectAfterRerender}
      />
    );
    fireEvent.click(resultRow);

    expect(onFileSelect).not.toHaveBeenCalled();
    expect(onFileSelectAfterRerender).toHaveBeenCalledTimes(1);
    expect(onFileSelectAfterRerender).toHaveBeenCalledWith('src/b.ts');
  });

  it('does not open search results on non-primary mousedown', () => {
    renderMockRows = true;
    const onFileSelect = vi.fn();

    render(
      <SidebarFileTree
        workspaceId="workspace-1"
        workingDirectory="/repo"
        currentFile={null}
        onFileSelect={onFileSelect}
      />
    );

    const searchInput = screen.getByPlaceholderText('Search');
    fireEvent.focus(searchInput);
    fireEvent.change(searchInput, { target: { value: 'b' } });
    const resultRow = screen.getByRole('button', { name: 'b.ts' });
    fireEvent.mouseDown(resultRow, { button: 2 });
    fireEvent.mouseDown(resultRow, { button: 1 });

    expect(onFileSelect).not.toHaveBeenCalled();
  });

  it('does not open search results when a dragstart is emitted', () => {
    renderMockRows = true;
    const onFileSelect = vi.fn();

    render(
      <SidebarFileTree
        workspaceId="workspace-1"
        workingDirectory="/repo"
        currentFile={null}
        onFileSelect={onFileSelect}
      />
    );

    const searchInput = screen.getByPlaceholderText('Search');
    fireEvent.focus(searchInput);
    fireEvent.change(searchInput, { target: { value: 'b' } });
    const resultRow = screen.getByRole('button', { name: 'b.ts' });
    fireEvent.mouseDown(resultRow);
    fireEvent.dragStart(resultRow, { dataTransfer: { setData: vi.fn() } });
    fireEvent.dragEnd(resultRow);
    fireEvent.click(resultRow);

    expect(onFileSelect).not.toHaveBeenCalled();
  });

  it('keeps Rollback All Changes off row menus and on the empty-area menu', () => {
    renderMockRowMenu = true;
    renderMockFileRowMenu = true;

    render(
      <SidebarFileTree
        workspaceId="workspace-1"
        workingDirectory="/repo"
        currentFile={null}
        onFileSelect={vi.fn()}
        onRollbackAll={vi.fn()}
        onDeleteFile={vi.fn()}
      />
    );

    // Row menus are role="menuitem"; the mocked Radix empty-area menu renders buttons.
    expect(screen.getAllByRole('menuitem', { name: /^delete( file)?$/i })).toHaveLength(2);
    expect(screen.queryByRole('menuitem', { name: /rollback all changes/i })).toBeNull();
    expect(screen.getByRole('button', { name: /rollback all changes/i })).toBeInTheDocument();
  });

  it('starts a note from the empty-area menu and folder menus', () => {
    renderMockRowMenu = true;
    mockCreateNote.mockClear();

    render(
      <SidebarFileTree
        workspaceId="workspace-1"
        workingDirectory="/repo"
        currentFile={null}
        onFileSelect={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'New Note' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'New Note' }));

    expect(mockCreateNote.mock.calls).toEqual([['workspace-1'], ['workspace-1']]);
  });

  it('labels reveal actions for the platform file manager', () => {
    renderMockRowMenu = true;
    renderMockFileRowMenu = true;

    render(
      <SidebarFileTree
        workspaceId="workspace-1"
        workingDirectory="/repo"
        currentFile={null}
        onFileSelect={vi.fn()}
      />
    );

    // window.api.platform is unset in jsdom, so the non-macOS label applies.
    expect(screen.queryByText('Reveal in Finder')).toBeNull();
    expect(screen.getAllByRole('menuitem', { name: 'Show in File Manager' })).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Show in File Manager' })).toBeInTheDocument();
  });

  it('hides git status letters, since the file name color shows the status', () => {
    render(
      <SidebarFileTree
        workspaceId="workspace-1"
        workingDirectory="/repo"
        currentFile={null}
        onFileSelect={vi.fn()}
        changedFilesOnly
        changedFiles={[{ path: 'src/index.ts' }]}
        diffFileStatuses={new Map([['src/index.ts', 'modified']])}
        diffSummary={{ additions: 1, deletions: 0, filesChanged: 1 }}
      />
    );

    expect(latestTreeStyle?.['--trees-git-lane-width-override']).toBe('0px');
    expect(latestUnsafeCSS).toMatch(/\[data-item-section='git'\],[^{]*\{\s*display: none/);
  });

  it('strikes through deleted files', () => {
    render(
      <SidebarFileTree
        workspaceId="workspace-1"
        workingDirectory="/repo"
        currentFile={null}
        onFileSelect={vi.fn()}
        changedFilesOnly
        changedFiles={[{ path: 'src/old.ts' }]}
        diffFileStatuses={new Map([['src/old.ts', 'deleted']])}
      />
    );

    expect(latestUnsafeCSS).toMatch(
      /\[data-item-git-status='deleted'\] > \[data-item-section='content'\]\s*\{[^}]*line-through/
    );
  });

  it('shows an empty state instead of zero stats when nothing has changed', () => {
    render(
      <SidebarFileTree
        workspaceId="workspace-1"
        workingDirectory="/repo"
        currentFile={null}
        onFileSelect={vi.fn()}
        changedFilesOnly
        changedFiles={[]}
        diffSummary={{ additions: 0, deletions: 0, filesChanged: 0 }}
      />
    );

    expect(screen.getByText('No changes yet')).toBeInTheDocument();
    expect(screen.queryByText('+0')).not.toBeInTheDocument();
    expect(screen.queryByText('-0')).not.toBeInTheDocument();
    expect(screen.queryByTestId('mock-file-tree')).not.toBeInTheDocument();
  });

  it('names the branch when a comparison finds no differences', () => {
    render(
      <SidebarFileTree
        workspaceId="workspace-1"
        workingDirectory="/repo"
        currentFile={null}
        onFileSelect={vi.fn()}
        changedFilesOnly
        changedFiles={[]}
        comparisonBranch="main"
        useMergeBase
        diffSummary={{ additions: 0, deletions: 0, filesChanged: 0 }}
      />
    );

    expect(screen.getByText('No changes since main')).toBeInTheDocument();
  });

  it('waits for the diff before saying nothing changed', () => {
    render(
      <SidebarFileTree
        workspaceId="workspace-1"
        workingDirectory="/repo"
        currentFile={null}
        onFileSelect={vi.fn()}
        changedFilesOnly
        changedFiles={[]}
      />
    );

    expect(screen.queryByText('No changes yet')).not.toBeInTheDocument();
  });

  it('hides a zero count in the diff stats', () => {
    render(
      <SidebarFileTree
        workspaceId="workspace-1"
        workingDirectory="/repo"
        currentFile={null}
        onFileSelect={vi.fn()}
        changedFilesOnly
        changedFiles={[{ path: 'src/index.ts' }]}
        diffSummary={{ additions: 4, deletions: 0, filesChanged: 1 }}
      />
    );

    expect(screen.getByText('+4')).toBeInTheDocument();
    expect(screen.queryByText('-0')).not.toBeInTheDocument();
  });
});
