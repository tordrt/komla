/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { output } = vi.hoisted(() => ({ output: vi.fn() }));

// The files scan reads `output`; the links scans read nothing.
vi.mock('@/lib/terminal-renderer-runtime', () => ({
  getRecentTerminalRendererOutput: () => [],
  getTerminalRendererOutputSinceLastScan: (...args: unknown[]) =>
    args[2] === 'files' ? output(...args) : [],
}));

import { BrowserLinksPopover } from '@/components/terminal/BrowserLinksPopover';
import { useTerminalFiles } from '@/components/terminal/terminal-files';
import { openTerminalFileLink } from '@/components/terminal/TerminalView';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useFileListStore } from '@/stores/file-list.store';
import { useFileViewerStore } from '@/stores/file-viewer.store';
import { useQuickLookStore } from '@/stores/quick-look.store';
import {
  queuePrintedFileHyperlink,
  setTerminalFileLinkContext,
  useTerminalFilesStore,
} from '@/stores/terminal-files.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';

import type { Workspace } from '../../../../src/shared/types';

const NOW = 1_800_000_000_000;
const context = {
  workspaceId: 'ws-1',
  workspaceRoot: '/repo',
  workingDirectory: '/repo',
  workspaceBackendKind: 'local' as const,
};
const listViewerFolder = vi.fn();
const readViewerFile = vi.fn();
const getViewerPreviewUrl = vi.fn();

function renderButton() {
  return render(
    <TooltipProvider>
      <BrowserLinksPopover workspaceId="ws-1">
        <button type="button">Links</button>
      </BrowserLinksPopover>
    </TooltipProvider>
  );
}

function openList() {
  const button = screen.getByRole('button', { name: 'Links' });
  fireEvent.pointerEnter(button);
  fireEvent.click(button);
}

/** The Files section's rows, by path. */
function shownFiles(): string[] {
  const list = screen.getByRole('toolbar', { name: 'Servers and links' });
  return [...list.querySelectorAll<HTMLButtonElement>('button[title]')].map(
    (button) => button.title
  );
}

function print(lines: string[], printedAt?: number[], terminalId = 't1') {
  output.mockReturnValue([
    { terminalId, executionLocation: 'workspace', logicalLines: lines, printedAt },
  ]);
}

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  listViewerFolder.mockResolvedValue([]);
  output.mockReturnValue([]);
  useWorkspacesStore.setState({
    workspaces: [
      {
        id: 'ws-1',
        workingDirectory: '/repo',
        backend: { kind: 'local' },
        terminals: [{ id: 't1' }],
      },
    ] as unknown as Workspace[],
  });
  useFileListStore.setState({
    cache: new Map([
      [
        '/repo',
        {
          files: ['docs/plan.txt', 'src/app.ts', 'src/old.ts'],
          gitIgnoredFiles: [],
          emptyDirs: [],
          isLoading: false,
        },
      ],
    ]),
  });
  setTerminalFileLinkContext('t1', context);
  (window as unknown as { api: unknown }).api = {
    platform: 'linux',
    listViewerFolder,
    readViewerFile,
    getViewerPreviewUrl,
    updateWorkspace: vi.fn(async () => undefined),
    detectDevPreviewServices: vi.fn(async () => ({
      services: [],
      openPorts: [],
      otherServers: [],
    })),
    getLinkPreview: vi.fn(async () => null),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  setTerminalFileLinkContext('t1', undefined);
  useTerminalFilesStore.setState(useTerminalFilesStore.getInitialState(), true);
  useQuickLookStore.setState(useQuickLookStore.getInitialState(), true);
  useFileViewerStore.setState({ showGitIgnoredByWorkspace: {} });
});

describe("the globe's Files section", () => {
  it('shows with nothing to list yet', async () => {
    renderButton();
    openList();

    expect(await screen.findByText('No running servers, links or files yet.')).toBeInTheDocument();
    expect(screen.queryByText('Files')).toBeNull();
  });

  it('reads the terminals once the pointer reaches the button', () => {
    renderButton();
    print(['Wrote docs/plan.txt']);
    fireEvent.pointerEnter(screen.getByRole('button', { name: 'Links' }));

    expect(output).toHaveBeenCalledWith('ws-1', expect.any(Number), 'files', expect.any(Function));
    expect(useTerminalFilesStore.getState().byWorkspace['ws-1']).toHaveLength(1);
  });

  it('lists opened files, then the printed ones, each the latest first', () => {
    act(() => {
      openTerminalFileLink(
        '/tmp/shots/a.log',
        undefined,
        {
          type: 'external',
          fullPath: '/tmp/shots/a.log',
        },
        't1',
        context
      );
    });
    vi.mocked(Date.now).mockReturnValue(NOW + 1_000);
    act(() => {
      openTerminalFileLink(
        '/tmp/b.log',
        undefined,
        { type: 'external', fullPath: '/tmp/b.log' },
        't1',
        context
      );
    });
    // Newest line first, as the scan reads them.
    print(
      [
        'Edited src/app.ts:12',
        'Removed src/gone.ts',
        'Wrote /repo/docs/plan.txt',
        'Saw /tmp/b.log',
      ],
      [NOW - 40_000, NOW - 30_000, NOW - 10_000, NOW - 5_000]
    );
    renderButton();
    openList();

    // src/gone.ts isn't in the file tree, and /tmp/b.log is already opened.
    expect(shownFiles()).toEqual([
      '/tmp/b.log',
      '/tmp/shots/a.log',
      '/repo/docs/plan.txt',
      'src/app.ts',
    ]);
  });

  it('lists files outside the workspace before its own', () => {
    act(() => {
      openTerminalFileLink(
        '/tmp/mock.txt',
        undefined,
        { type: 'external', fullPath: '/tmp/mock.txt' },
        't1',
        context
      );
    });
    vi.mocked(Date.now).mockReturnValue(NOW + 1_000);
    act(() => {
      openTerminalFileLink(
        'src/old.ts',
        undefined,
        { type: 'workspace', filePath: 'src/old.ts' },
        't1',
        context
      );
    });
    print(['Edited src/app.ts', 'Saved /tmp/out.log'], [NOW - 1_000, NOW - 60_000]);
    renderButton();
    openList();

    expect(shownFiles()).toEqual(['/tmp/mock.txt', 'src/old.ts', '/tmp/out.log', 'src/app.ts']);
  });

  it('lists printed ignored files only while the file tree shows ignored files', () => {
    // An SSH workspace's list always has its ignored files.
    useFileListStore.setState({
      cache: new Map([
        [
          '/repo',
          {
            files: ['src/app.ts'],
            gitIgnoredFiles: ['node_modules/foo/index.js'],
            emptyDirs: [],
            isLoading: false,
          },
        ],
      ]),
    });
    print(['at run (node_modules/foo/index.js:10)', 'Edited src/app.ts'], [NOW, NOW - 1_000]);
    renderButton();
    openList();
    expect(shownFiles()).toEqual(['src/app.ts']);

    act(() => useFileViewerStore.setState({ showGitIgnoredByWorkspace: { 'ws-1': true } }));
    expect(shownFiles()).toEqual(['node_modules/foo/index.js', 'src/app.ts']);
  });

  it('lists printed files in linked workspaces, which the file list leaves out', () => {
    print(
      ['Edited linked-workspaces/api/src/server.ts:42', 'Edited src/app.ts'],
      [NOW, NOW - 1_000]
    );
    renderButton();
    openList();

    expect(shownFiles()).toEqual(['linked-workspaces/api/src/server.ts', 'src/app.ts']);
  });

  it('keeps its lists while terminals change only their state', () => {
    print(['Saved /tmp/out.log'], [NOW]);
    renderButton();
    openList();
    const { result } = renderHook(() => useTerminalFiles('ws-1'));
    const before = result.current;

    // As an agent's status update replaces the workspace's terminals.
    act(() =>
      useWorkspacesStore.setState(({ workspaces }) => ({
        workspaces: workspaces.map((workspace) => ({
          ...workspace,
          terminals: workspace.terminals.map((terminal) => ({ ...terminal })),
        })),
      }))
    );
    expect(result.current).toBe(before);
  });

  it('counts file hyperlinks the terminals printed', () => {
    queuePrintedFileHyperlink('ws-1', {
      path: '/repo/src/old.ts',
      terminalId: 't1',
      target: { type: 'workspace', filePath: 'src/old.ts' },
      context,
      printedAt: NOW - 1_000,
    });
    print(['Wrote docs/plan.txt'], [NOW - 60_000]);
    renderButton();
    openList();

    expect(shownFiles()).toEqual(['/repo/src/old.ts', 'docs/plan.txt']);
  });

  it('drops files outside the workspace once their terminal closes', async () => {
    print(['Saved /tmp/out.log'], [NOW]);
    renderButton();
    openList();
    expect(shownFiles()).toEqual(['/tmp/out.log']);

    act(() =>
      useWorkspacesStore.setState((state) => ({
        workspaces: state.workspaces.map((w) => ({ ...w, terminals: [] })),
      }))
    );
    expect(await screen.findByText('No running servers, links or files yet.')).toBeInTheDocument();
  });

  it('opens a pick as its link would, and lists it as opened', () => {
    print(['Saved /tmp/out.log'], [NOW]);
    renderButton();
    openList();
    fireEvent.click(screen.getByTitle('/tmp/out.log'));

    expect(useQuickLookStore.getState().session?.item.path).toBe('/tmp/out.log');
    expect(useTerminalFilesStore.getState().byWorkspace['ws-1']?.[0].openedAt).toBe(NOW);
  });

  it('offers a new tab or split for workspace files, not folders', async () => {
    act(() => {
      openTerminalFileLink(
        'src/',
        undefined,
        { type: 'workspace', filePath: 'src/' },
        't1',
        context
      );
    });
    print(['Edited src/app.ts'], [NOW]);
    renderButton();
    openList();

    fireEvent.contextMenu(screen.getByTitle('src/app.ts'));
    expect(await screen.findByRole('menuitem', { name: 'Open in New Tab' })).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());

    fireEvent.contextMenu(screen.getByTitle('src/'));
    expect(screen.queryByRole('menuitem', { name: 'Open in New Tab' })).toBeNull();
  });

  it('opens the viewer on the first file without counting it as opened', () => {
    print(['Saved /tmp/out.log'], [NOW]);
    renderButton();
    openList();
    fireEvent.click(screen.getByRole('button', { name: 'Open all in viewer' }));

    expect(useQuickLookStore.getState().session?.item.path).toBe('/tmp/out.log');
    expect(useTerminalFilesStore.getState().byWorkspace['ws-1']?.[0].openedAt).toBeUndefined();
  });

  it('previews an image beside its row, read where its link would read it', async () => {
    readViewerFile.mockResolvedValue({ data: 'iVBO', mimeType: 'image/png' });
    print(['Saved /tmp/shot.png'], [NOW]);
    renderButton();
    openList();
    const row = screen.getByText('shot.png').closest('button');
    if (!row) throw new Error('no row');
    fireEvent.focus(row);

    await waitFor(() =>
      expect(document.querySelector('img[src="data:image/png;base64,iVBO"]')).not.toBeNull()
    );
    expect(readViewerFile).toHaveBeenCalledWith('ws-1', 't1', {
      kind: 'terminal',
      fullPath: '/tmp/shot.png',
    });
  });

  it('renders the start of a Markdown file beside its row', async () => {
    readViewerFile.mockResolvedValue({
      data: btoa('# Release notes\n\nShipped.'),
      mimeType: 'text/markdown',
    });
    print(['Wrote /tmp/notes.md'], [NOW]);
    renderButton();
    openList();
    const row = screen.getByText('notes.md').closest('button');
    if (!row) throw new Error('no row');
    fireEvent.focus(row);

    expect(await screen.findByRole('heading', { name: 'Release notes' })).toBeInTheDocument();
  });

  it('leaves a terminal without a link context for a later scan', () => {
    setTerminalFileLinkContext('t1', undefined);
    renderButton();
    openList();

    const includes = output.mock.calls.at(-1)?.[3] as (terminalId: string) => boolean;
    expect(includes('t1')).toBe(false);
  });

  it('shows a page beside its row without running its scripts, read once for repeat hovers', async () => {
    getViewerPreviewUrl.mockResolvedValue('komla-preview://token/mock.html');
    print(['Built /tmp/mock.html'], [NOW]);
    const { unmount } = renderButton();
    openList();
    const hover = () => {
      const row = screen.getByText('mock.html').closest('button');
      if (!row) throw new Error('no row');
      fireEvent.focus(row);
    };
    hover();

    const frame = await screen.findByTitle('/tmp/mock.html browser preview');
    expect(frame).toHaveAttribute('src', 'komla-preview://token/mock.html');
    expect(frame).toHaveAttribute('sandbox', '');

    unmount();
    renderButton();
    openList();
    hover();
    await screen.findByTitle('/tmp/mock.html browser preview');
    expect(getViewerPreviewUrl).toHaveBeenCalledOnce();
    // Each card's preview replaces its last one, which no other view of the file uses.
    expect(getViewerPreviewUrl).toHaveBeenCalledWith(
      'ws-1',
      't1',
      { kind: 'terminal', fullPath: '/tmp/mock.html' },
      { replacesPrevious: true }
    );
  });
});
