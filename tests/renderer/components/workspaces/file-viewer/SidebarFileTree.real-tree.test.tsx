/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SidebarFileTree } from '../../../../../src/renderer/components/workspaces/file-viewer/SidebarFileTree';
import { useFileListStore } from '../../../../../src/renderer/stores/file-list.store';
import { useFileViewerStore } from '../../../../../src/renderer/stores/file-viewer.store';
import { useWorkspaceObservationStore } from '../../../../../src/renderer/stores/workspace-observation.store';
import { useWorkspacesStore } from '../../../../../src/renderer/stores/workspaces.store';

import type { FileTree } from '@pierre/trees';
import type React from 'react';

// Drives SidebarFileTree against the real @pierre/trees model, for behavior
// that depends on the model surviving re-renders.
let latestModel: FileTree | null = null;
vi.mock('@pierre/trees/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pierre/trees/react')>();
  return {
    ...actual,
    useFileTree: (options: Parameters<typeof actual.useFileTree>[0]) => {
      const result = actual.useFileTree(options);
      latestModel = result.model;
      return result;
    },
  };
});

vi.mock('@pierre/trees', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pierre/trees')>()),
  themeToTreeStyles: () => ({}),
}));

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/hooks/useKomlaEditorTheme', () => ({
  useKomlaEditorTheme: () => 'dark',
}));

function setFiles(files: string[]) {
  act(() => {
    useFileListStore.setState({
      cache: new Map([['/repo', { files, gitIgnoredFiles: [], emptyDirs: [], isLoading: false }]]),
    });
  });
}

describe('SidebarFileTree with the real tree model', () => {
  beforeEach(() => {
    latestModel = null;
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    useFileListStore.setState({ cache: new Map(), statusCache: new Map() });
    useFileViewerStore.setState({ showGitIgnoredByWorkspace: {} });
    useWorkspacesStore.setState({ workspaces: [] });
    useWorkspaceObservationStore.setState({ projections: new Map() });
    window.api = {
      ...window.api,
      listWorkspaceFiles: vi.fn().mockReturnValue(new Promise(() => {})),
      getChangedFilesWithSummary: vi.fn().mockReturnValue(new Promise(() => {})),
    } as typeof window.api;
  });

  it('leaves a folder the user collapsed around the open file collapsed while files change', () => {
    setFiles(['src/components/Button.tsx', 'src/index.ts']);
    render(
      <SidebarFileTree
        workspaceId="workspace-1"
        workingDirectory="/repo"
        currentFile="src/components/Button.tsx"
        onFileSelect={vi.fn()}
      />
    );
    const model = latestModel!;
    const components = () => model.getItem('src/components');
    expect(components()?.isDirectory() && components()?.isExpanded()).toBe(true);

    act(() => {
      if (components()?.isDirectory()) (components() as { collapse: () => void }).collapse();
    });
    setFiles(['src/components/Button.tsx', 'src/index.ts', 'src/new-by-agent.ts']);

    expect(model.getItem('src/new-by-agent.ts')).not.toBeNull();
    expect(components()?.isDirectory() && components()?.isExpanded()).toBe(false);
  });

  it('shows a file that replaced a folder of the same name', () => {
    setFiles(['foo/a.ts', 'b.ts']);
    render(
      <SidebarFileTree
        workspaceId="workspace-1"
        workingDirectory="/repo"
        currentFile={null}
        onFileSelect={vi.fn()}
      />
    );

    setFiles(['foo', 'b.ts']);

    expect(latestModel!.getItem('foo')?.isDirectory()).toBe(false);
    expect(latestModel!.getItem('foo/a.ts')).toBeNull();
  });

  it('leaves the tree alone when a refresh lists the same files, or only the diff changed', () => {
    setFiles(['src/index.ts', 'README.md']);
    const tree = (changedFiles: { path: string }[]) => (
      <SidebarFileTree
        workspaceId="workspace-1"
        workingDirectory="/repo"
        currentFile={null}
        onFileSelect={vi.fn()}
        changedFiles={changedFiles}
      />
    );
    const { rerender } = render(tree([{ path: 'src/index.ts' }]));
    const batch = vi.spyOn(latestModel!, 'batch');

    setFiles(['src/index.ts', 'README.md']);
    rerender(tree([{ path: 'src/index.ts' }]));

    expect(batch).not.toHaveBeenCalled();
  });

  it('auto-focuses the focused row, so arrow keys move through the tree right away', async () => {
    vi.useFakeTimers();
    try {
      setFiles(['src/components/Button.tsx', 'src/index.ts']);
      const { container } = render(
        <SidebarFileTree
          workspaceId="workspace-1"
          workingDirectory="/repo"
          currentFile={null}
          onFileSelect={vi.fn()}
          autoFocus
        />
      );

      await act(async () => {
        vi.advanceTimersByTime(100);
      });

      const shadowRoot = container.querySelector('file-tree-container')?.shadowRoot;
      expect(shadowRoot?.activeElement?.getAttribute('data-item-path')).toBe(
        latestModel!.getFocusedPath()
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('colors file icons by type in both views', () => {
    setFiles(['src/index.ts']);
    const tree = (changedFilesOnly: boolean) => (
      <SidebarFileTree
        workspaceId="workspace-1"
        workingDirectory="/repo"
        currentFile={null}
        onFileSelect={vi.fn()}
        changedFilesOnly={changedFilesOnly}
        changedFiles={[{ path: 'src/index.ts' }]}
      />
    );
    const { container, rerender } = render(tree(true));
    const iconsColored = () =>
      container
        .querySelector('file-tree-container')
        ?.shadowRoot?.querySelector('[data-file-tree-virtualized-wrapper]')
        ?.hasAttribute('data-file-tree-colored-icons');

    expect(iconsColored()).toBe(true);
    rerender(tree(false));
    expect(iconsColored()).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['holding a query', 'src'],
  ])('claims Escape in the search box while it is %s, leaving search', (_name, query) => {
    setFiles(['src/index.ts', 'README.md']);
    const { getByPlaceholderText } = render(
      <SidebarFileTree
        workspaceId="workspace-1"
        workingDirectory="/repo"
        currentFile={null}
        onFileSelect={vi.fn()}
      />
    );
    const input = getByPlaceholderText('Search');
    act(() => input.focus());
    if (query) fireEvent.change(input, { target: { value: query } });

    // Unclaimed, the Escape would reach the file preview beside the tree and close it.
    expect(fireEvent.keyDown(input, { key: 'Escape' })).toBe(false);
    expect(latestModel!.isSearchOpen()).toBe(false);
    expect(document.activeElement).not.toBe(input);
  });

  it("leaves letters typed in the changes view to the file viewer's shortcuts", () => {
    const { container } = render(
      <SidebarFileTree
        workspaceId="workspace-1"
        workingDirectory="/repo"
        currentFile={null}
        onFileSelect={vi.fn()}
        changedFilesOnly
        changedFiles={[{ path: 'a.ts' }, { path: 'b.ts' }]}
      />
    );
    const row = container
      .querySelector('file-tree-container')
      ?.shadowRoot?.querySelector<HTMLElement>('[data-item-path="a.ts"]');
    const reached: string[] = [];
    const listener = (e: KeyboardEvent) => reached.push(e.key);
    window.addEventListener('keydown', listener);

    act(() => {
      fireEvent.keyDown(row!, { key: 'j' });
      fireEvent.keyDown(row!, { key: 'n' });
    });
    window.removeEventListener('keydown', listener);

    expect(reached).toEqual(['j', 'n']);
    expect(latestModel!.isSearchOpen()).toBe(false);
  });

  it('moves to a file chosen outside the tree, from a parent handing a new callback each render', () => {
    // History's arrow keys choose the next file while the tree's focus is still on the last one.
    const chosen: string[] = [];
    let choose: (path: string) => void = () => {};
    function History() {
      const [current, setCurrent] = useState<string | null>('a.ts');
      choose = setCurrent;
      return (
        <SidebarFileTree
          workspaceId="workspace-1"
          workingDirectory="/repo"
          currentFile={current}
          onFileSelect={(path) => {
            chosen.push(path);
            // Stops a swap back and forth from running forever.
            if (chosen.length < 5) setCurrent(path);
          }}
          changedFilesOnly
          changedFiles={[{ path: 'a.ts' }, { path: 'b.ts' }]}
        />
      );
    }
    render(<History />);

    act(() => choose('b.ts'));

    expect(chosen).toEqual([]);
    expect(latestModel!.getFocusedPath()).toBe('b.ts');
  });

  it('stays on the file a parent opens with the tree when it is not the first row', () => {
    // History opens a commit on Git's first file; the tree lists diagram.svg first and focuses it.
    const chosen: string[] = [];
    function History() {
      const [current, setCurrent] = useState<string | null>('README.md');
      return (
        <SidebarFileTree
          workspaceId="workspace-1"
          workingDirectory="/repo"
          currentFile={current}
          onFileSelect={(path) => {
            chosen.push(path);
            // Stops a swap back and forth from running forever.
            if (chosen.length < 5) setCurrent(path);
          }}
          changedFilesOnly
          changedFiles={[{ path: 'README.md' }, { path: 'diagram.svg' }]}
        />
      );
    }
    render(<History />);

    expect(chosen).toEqual([]);
    expect(latestModel!.getFocusedPath()).toBe('README.md');
  });

  it('lands on a file opened before the file list loaded, once its row appears', () => {
    render(
      <SidebarFileTree
        workspaceId="workspace-1"
        workingDirectory="/repo"
        currentFile="src/components/Button.tsx"
        onFileSelect={vi.fn()}
      />
    );

    setFiles(['src/components/Button.tsx', 'src/index.ts']);

    expect(latestModel!.getSelectedPaths()).toEqual(['src/components/Button.tsx']);
    expect(latestModel!.getFocusedPath()).toBe('src/components/Button.tsx');
  });
  it('shows and focuses a folder a terminal link asked for once its row appears, opening nothing', async () => {
    vi.useFakeTimers();
    try {
      const onFileSelect = vi.fn();
      const reveal = { path: 'src/components/ui', expiresAt: Date.now() + 10_000 };
      useFileViewerStore.setState({
        fileTreeRevealByWorkspace: { 'workspace-1': reveal },
      });
      const { container } = render(
        <SidebarFileTree
          workspaceId="workspace-1"
          workingDirectory="/repo"
          currentFile={null}
          onFileSelect={onFileSelect}
          reveal={reveal}
        />
      );

      setFiles(['src/components/ui/Button.tsx', 'src/index.ts']);

      const folder = latestModel!.getItem('src/components/ui');
      expect(folder?.isDirectory() && (folder as { isExpanded(): boolean }).isExpanded()).toBe(
        true
      );
      expect(latestModel!.getSelectedPaths().map((path) => path.replace(/\/$/, ''))).toEqual([
        'src/components/ui',
      ]);
      expect(latestModel!.getFocusedPath()?.replace(/\/$/, '')).toBe('src/components/ui');
      expect(useFileViewerStore.getState().fileTreeRevealByWorkspace['workspace-1']).toBe(reveal);

      // Rows render a moment later; the tree waits for the folder's.
      for (let step = 0; step < 10; step++) {
        await act(async () => {
          vi.advanceTimersByTime(50);
        });
      }

      // The row has DOM focus, so it shows the focus ring and the arrow keys move on from it.
      const shadowRoot = container.querySelector('file-tree-container')?.shadowRoot;
      expect(shadowRoot?.activeElement?.getAttribute('data-item-path')?.replace(/\/$/, '')).toBe(
        'src/components/ui'
      );
      // Which draws the focus outline, a folder's only highlight.
      expect(shadowRoot?.activeElement?.getAttribute('data-item-focused')).toBe('true');
      // Shown once: the request is done.
      expect(
        useFileViewerStore.getState().fileTreeRevealByWorkspace['workspace-1']
      ).toBeUndefined();
      expect(onFileSelect).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops a folder request that expired before its row appeared, leaving focus alone', () => {
    const reveal = { path: 'src/components/ui', expiresAt: Date.now() - 1 };
    useFileViewerStore.setState({ fileTreeRevealByWorkspace: { 'workspace-1': reveal } });
    render(
      <SidebarFileTree
        workspaceId="workspace-1"
        workingDirectory="/repo"
        currentFile={null}
        onFileSelect={vi.fn()}
        reveal={reveal}
      />
    );

    // Such as an agent writing the first file into it minutes later.
    setFiles(['src/components/ui/Button.tsx', 'src/index.ts']);

    expect(latestModel!.getSelectedPaths()).toEqual([]);
    expect(useFileViewerStore.getState().fileTreeRevealByWorkspace['workspace-1']).toBeUndefined();
  });
});
