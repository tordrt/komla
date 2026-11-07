/** @vitest-environment jsdom */
import { act, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ImportedFilesSection } from '../../../../../src/renderer/components/workspaces/file-viewer/ImportedFilesSection';
import { AT_PATH_MIME, isTreeDragActive } from '../../../../../src/renderer/lib/tree-drag-token';
import { useFileViewerStore } from '../../../../../src/renderer/stores/file-viewer.store';
import { useToastStore } from '../../../../../src/renderer/stores/toast.store';

const DESIGN = '.komla-files/design.png';
const NESTED = '.komla-files/logs/run.txt';

const onFileSelect = vi.fn();
const onDeleteFile = vi.fn();
const onRenameComplete = vi.fn(async () => true);
const onCopyNode = vi.fn();
const onCutNode = vi.fn();
const onOpenInPane = vi.fn();
const onOpenHtmlInBrowser = vi.fn();
const copyToClipboard = vi.fn();
const showItemInFolder = vi.fn();
const openPath = vi.fn(async () => undefined);

type SectionProps = React.ComponentProps<typeof ImportedFilesSection>;

function renderSection(overrides: Partial<SectionProps> = {}) {
  const props: SectionProps = {
    workspaceId: 'ws-1',
    workingDirectory: '/repo',
    files: [DESIGN, NESTED],
    isSearching: false,
    currentFile: null,
    isRemoteWorkspace: false,
    onFileSelect,
    onDeleteFile,
    onRenameComplete,
    onCopyNode,
    onCutNode,
    onOpenInPane,
    onOpenHtmlInBrowser,
    ...overrides,
  };
  return render(<ImportedFilesSection {...props} />);
}

const row = (name: string) => screen.getByRole('button', { name });

function openMenu(name: string) {
  fireEvent.contextMenu(row(name));
}

const menuItem = (name: string) => screen.getByRole('menuitem', { name });
const queryMenuItem = (name: string) => screen.queryByRole('menuitem', { name });

describe('ImportedFilesSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useFileViewerStore.setState(useFileViewerStore.getInitialState(), true);
    useToastStore.setState({ toasts: [] });
    (window as unknown as { api: unknown }).api = {
      platform: 'linux',
      copyToClipboard,
      showItemInFolder,
      openPath,
      updateWorkspace: vi.fn(async () => undefined),
    };
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('shows nothing while the workspace has no imported files', () => {
    const { container } = renderSection({ files: [] });

    expect(container).toBeEmptyDOMElement();
  });

  it('counts the files and names each by its path inside the folder', () => {
    renderSection();

    expect(screen.getByRole('region', { name: 'Imported files' })).toHaveTextContent('2');
    expect(row('design.png')).toBeInTheDocument();
    expect(row('logs/run.txt')).toBeInTheDocument();
  });

  it('opens a file by its workspace path and marks the open one', () => {
    renderSection({ currentFile: DESIGN });

    fireEvent.click(row('logs/run.txt'));

    expect(onFileSelect).toHaveBeenCalledWith(NESTED);
    expect(row('design.png')).toHaveAttribute('aria-current', 'true');
    expect(row('logs/run.txt')).not.toHaveAttribute('aria-current');
  });

  it('keeps its collapsed state per workspace, across remounts', () => {
    const { unmount } = renderSection();

    fireEvent.click(screen.getByRole('button', { name: 'Imported files' }));
    expect(screen.queryByRole('button', { name: 'design.png' })).not.toBeInTheDocument();

    unmount();
    const { unmount: unmountAgain } = renderSection();
    expect(screen.queryByRole('button', { name: 'design.png' })).not.toBeInTheDocument();

    unmountAgain();
    renderSection({ workspaceId: 'ws-2' });
    expect(row('design.png')).toBeInTheDocument();
  });

  it('shows search matches even while collapsed', () => {
    useFileViewerStore.getState().setImportedFilesCollapsed('ws-1', true);

    renderSection({ isSearching: true, files: [DESIGN] });

    expect(row('design.png')).toBeInTheDocument();
  });

  it("doesn't change its collapsed state while searching, when the rows show anyway", () => {
    renderSection({ isSearching: true, files: [DESIGN] });

    fireEvent.click(screen.getByRole('button', { name: 'Imported files' }));

    expect(useFileViewerStore.getState().importedFilesCollapsedByWorkspace['ws-1']).toBeUndefined();
    expect(row('design.png')).toBeInTheDocument();
  });

  it('acts on the focused row from the keyboard, as a tree row does', () => {
    renderSection();

    fireEvent.keyDown(row('design.png'), { key: 'Delete' });
    expect(onDeleteFile).toHaveBeenLastCalledWith(DESIGN);
    fireEvent.keyDown(row('logs/run.txt'), { key: 'Backspace', metaKey: true });
    expect(onDeleteFile).toHaveBeenLastCalledWith(NESTED);
    fireEvent.keyDown(row('design.png'), { key: 'c', ctrlKey: true });
    expect(onCopyNode).toHaveBeenCalledWith(DESIGN, false);
    fireEvent.keyDown(row('design.png'), { key: 'x', metaKey: true });
    expect(onCutNode).toHaveBeenCalledWith(DESIGN, false);
  });

  it('leaves Cmd+Shift+X, Toggle prompt draft, to the app instead of cutting', () => {
    renderSection();

    // macOS reports a lowercase key while Cmd is held, Shift or not.
    fireEvent.keyDown(row('design.png'), { key: 'x', metaKey: true, shiftKey: true });

    expect(onCutNode).not.toHaveBeenCalled();
  });

  it('leaves copying and cutting out of an SSH workspace, as its menu and the tree do', () => {
    renderSection({ isRemoteWorkspace: true });

    fireEvent.keyDown(row('design.png'), { key: 'c', ctrlKey: true });
    fireEvent.keyDown(row('design.png'), { key: 'x', ctrlKey: true });

    expect(onCopyNode).not.toHaveBeenCalled();
    expect(onCutNode).not.toHaveBeenCalled();
  });

  it('swallows a held Enter or Escape that repeats onto the row after a rename', () => {
    renderSection();
    const notPrevented = (key: string) =>
      fireEvent.keyDown(row('design.png'), { key, repeat: true });

    expect(notPrevented('Enter')).toBe(false);
    expect(notPrevented('Escape')).toBe(false);
    expect(fireEvent.keyDown(row('design.png'), { key: 'Enter' })).toBe(true);
  });

  it('leaves other keys and modified deletes alone', () => {
    renderSection();

    fireEvent.keyDown(row('design.png'), { key: 'c' });
    fireEvent.keyDown(row('design.png'), { key: 'Delete', altKey: true });
    fireEvent.keyDown(row('design.png'), { key: 'Delete', ctrlKey: true });

    expect(onCopyNode).not.toHaveBeenCalled();
    expect(onDeleteFile).not.toHaveBeenCalled();
  });

  it('drags a file into a terminal as its @path', () => {
    renderSection();
    const setData = vi.fn();
    const dragStart = createEvent.dragStart(row('design.png'));
    Object.defineProperty(dragStart, 'dataTransfer', { value: { setData } });

    fireEvent(row('design.png'), dragStart);

    expect(setData).toHaveBeenCalledWith(AT_PATH_MIME, `@${DESIGN} `);
    expect(isTreeDragActive()).toBe(true);

    fireEvent.dragEnd(row('design.png'));
    expect(isTreeDragActive()).toBe(false);
  });

  it('opens a file in a tab or a split from its menu', () => {
    renderSection();

    openMenu('design.png');
    fireEvent.click(menuItem('Open in New Tab'));
    expect(onOpenInPane).toHaveBeenLastCalledWith(DESIGN, { kind: 'tab' });

    openMenu('design.png');
    fireEvent.click(menuItem('Open in Split Right'));
    expect(onOpenInPane).toHaveBeenLastCalledWith(DESIGN, {
      kind: 'split',
      direction: 'vertical',
    });

    openMenu('design.png');
    fireEvent.click(menuItem('Open in Split Down'));
    expect(onOpenInPane).toHaveBeenLastCalledWith(DESIGN, {
      kind: 'split',
      direction: 'horizontal',
    });
  });

  it('copies, cuts, deletes and reveals a file from its menu', () => {
    renderSection();

    openMenu('design.png');
    fireEvent.click(menuItem('Copy @path'));
    expect(copyToClipboard).toHaveBeenCalledWith(`@${DESIGN} `);

    openMenu('design.png');
    fireEvent.click(menuItem('Copy'));
    expect(onCopyNode).toHaveBeenCalledWith(DESIGN, false);

    openMenu('design.png');
    fireEvent.click(menuItem('Cut'));
    expect(onCutNode).toHaveBeenCalledWith(DESIGN, false);

    openMenu('design.png');
    fireEvent.click(screen.getByRole('menuitem', { name: /file manager|finder|explorer/i }));
    expect(showItemInFolder).toHaveBeenCalledWith(`/repo/${DESIGN}`);

    openMenu('design.png');
    fireEvent.click(menuItem('Open in Default App'));
    expect(openPath).toHaveBeenCalledWith(`/repo/${DESIGN}`);

    openMenu('design.png');
    fireEvent.click(menuItem('Delete File'));
    expect(onDeleteFile).toHaveBeenCalledWith(DESIGN);
  });

  it('offers a browser preview only for a file a browser can show', () => {
    renderSection({ files: ['.komla-files/report.html', '.komla-files/run.log'] });

    openMenu('report.html');
    fireEvent.click(menuItem('Open Browser Preview'));
    expect(onOpenHtmlInBrowser).toHaveBeenCalledWith('.komla-files/report.html');

    openMenu('run.log');
    expect(queryMenuItem('Open Browser Preview')).not.toBeInTheDocument();
  });

  it('leaves out what an SSH workspace cannot do', () => {
    renderSection({
      isRemoteWorkspace: true,
      onRenameComplete: undefined,
      onCopyNode: undefined,
      onCutNode: undefined,
      onOpenHtmlInBrowser: undefined,
    });

    openMenu('design.png');

    expect(menuItem('Copy @path')).toBeInTheDocument();
    expect(menuItem('Delete File')).toBeInTheDocument();
    expect(queryMenuItem('Rename')).not.toBeInTheDocument();
    expect(queryMenuItem('Copy')).not.toBeInTheDocument();
    expect(queryMenuItem('Cut')).not.toBeInTheDocument();
    expect(queryMenuItem('Open in Default App')).not.toBeInTheDocument();
  });

  async function startRenaming(name: string, fileName: string): Promise<HTMLInputElement> {
    openMenu(name);
    fireEvent.click(menuItem('Rename'));
    return (await screen.findByRole('textbox', { name: `Rename ${fileName}` })) as HTMLInputElement;
  }

  it('renames in place, keeping the file in its folder', async () => {
    renderSection();
    const input = await startRenaming('logs/run.txt', 'run.txt');
    await waitFor(() => expect(input).toHaveFocus());
    expect(input.value).toBe('run.txt');

    fireEvent.change(input, { target: { value: 'first-run.txt' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() =>
      expect(onRenameComplete).toHaveBeenCalledWith(
        NESTED,
        '.komla-files/logs/first-run.txt',
        false
      )
    );
    expect(onRenameComplete).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('button', { name: 'logs/run.txt' })).toBeInTheDocument();
  });

  it('hands focus back to the row when a key ends the rename', async () => {
    renderSection();

    let input = await startRenaming('design.png', 'design.png');
    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => expect(row('design.png')).toHaveFocus());

    input = await startRenaming('design.png', 'design.png');
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(row('design.png')).toHaveFocus());
  });

  it('focuses the renamed row once the list shows it under its new name', async () => {
    const view = renderSection();
    const input = await startRenaming('design.png', 'design.png');
    fireEvent.change(input, { target: { value: 'mock.png' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onRenameComplete).toHaveBeenCalled());

    view.rerender(
      <ImportedFilesSection
        workspaceId="ws-1"
        workingDirectory="/repo"
        files={['.komla-files/mock.png', NESTED]}
        isSearching={false}
        currentFile={null}
        isRemoteWorkspace={false}
        onFileSelect={onFileSelect}
        onRenameComplete={onRenameComplete}
      />
    );

    await waitFor(() => expect(row('mock.png')).toHaveFocus());
  });

  it("doesn't take focus for a renamed row when the user has moved on", async () => {
    const view = renderSection();
    const input = await startRenaming('design.png', 'design.png');
    fireEvent.change(input, { target: { value: 'mock.png' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onRenameComplete).toHaveBeenCalled());

    const elsewhere = document.body.appendChild(document.createElement('input'));
    elsewhere.focus();
    view.rerender(
      <ImportedFilesSection
        workspaceId="ws-1"
        workingDirectory="/repo"
        files={['.komla-files/mock.png', NESTED]}
        isSearching={false}
        currentFile={null}
        isRemoteWorkspace={false}
        onFileSelect={onFileSelect}
        onRenameComplete={onRenameComplete}
      />
    );

    await act(async () => {});
    expect(elsewhere).toHaveFocus();
    elsewhere.remove();
  });

  it('focuses the row again when a rename by key is refused', async () => {
    const refused = vi.fn(async () => false);
    renderSection({ onRenameComplete: refused });
    const input = await startRenaming('design.png', 'design.png');
    fireEvent.change(input, { target: { value: 'taken.png' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(row('design.png')).toHaveFocus());
  });

  it('reports a rename that fails outright, instead of leaving it unhandled', async () => {
    const failing = vi.fn(async () => {
      throw new Error('disk full');
    });
    renderSection({ onRenameComplete: failing });
    const input = await startRenaming('design.png', 'design.png');
    fireEvent.change(input, { target: { value: 'mock.png' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() =>
      expect(useToastStore.getState().toasts.at(-1)?.message).toBe('Failed to rename: disk full')
    );
    expect(row('design.png')).toHaveFocus();
  });

  it('ignores a held Enter repeating into the rename input', async () => {
    renderSection();
    const input = await startRenaming('design.png', 'design.png');

    fireEvent.keyDown(input, { key: 'Enter', repeat: true });

    expect(screen.getByRole('textbox', { name: 'Rename design.png' })).toBeInTheDocument();
  });

  it("doesn't take focus back when the rename ended by clicking elsewhere", async () => {
    renderSection();
    const input = await startRenaming('design.png', 'design.png');

    fireEvent.blur(input);
    await act(async () => {});

    expect(row('design.png')).not.toHaveFocus();
  });

  it('commits a rename when the input loses focus', async () => {
    renderSection();
    const input = await startRenaming('design.png', 'design.png');

    fireEvent.change(input, { target: { value: 'mock.png' } });
    fireEvent.blur(input);

    await waitFor(() =>
      expect(onRenameComplete).toHaveBeenCalledWith(DESIGN, '.komla-files/mock.png', false)
    );
  });

  it('leaves the name alone on Escape, an unchanged name or an empty one', async () => {
    renderSection();

    let input = await startRenaming('design.png', 'design.png');
    fireEvent.change(input, { target: { value: 'mock.png' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(row('design.png')).toBeInTheDocument();

    input = await startRenaming('design.png', 'design.png');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(row('design.png')).toBeInTheDocument();

    input = await startRenaming('design.png', 'design.png');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(row('design.png')).toBeInTheDocument();

    expect(onRenameComplete).not.toHaveBeenCalled();
  });

  it.each(['../escape.png', 'sub/name.png', 'sub\\name.png', '..', '.'])(
    'refuses to rename a file to %s, which is not a name in its folder',
    async (name) => {
      renderSection();
      const input = await startRenaming('design.png', 'design.png');

      fireEvent.change(input, { target: { value: name } });
      fireEvent.keyDown(input, { key: 'Enter' });

      expect(onRenameComplete).not.toHaveBeenCalled();
      expect(useToastStore.getState().toasts.at(-1)?.type).toBe('error');
    }
  );

  it('shows the imported folder when a terminal link asks the tree to reveal it', async () => {
    useFileViewerStore.getState().setImportedFilesCollapsed('ws-1', true);
    useFileViewerStore.getState().revealInFileTree('ws-1', '.komla-files');
    const reveal = useFileViewerStore.getState().fileTreeRevealByWorkspace['ws-1'];

    renderSection({ reveal });

    await waitFor(() => expect(row('design.png')).toHaveFocus());
    expect(useFileViewerStore.getState().importedFilesCollapsedByWorkspace['ws-1']).toBe(false);
    expect(useFileViewerStore.getState().fileTreeRevealByWorkspace['ws-1']).toBeUndefined();
  });

  it('focuses the first file inside a revealed subfolder', async () => {
    useFileViewerStore.getState().revealInFileTree('ws-1', '.komla-files/logs');
    const reveal = useFileViewerStore.getState().fileTreeRevealByWorkspace['ws-1'];

    renderSection({ reveal });

    await waitFor(() => expect(row('logs/run.txt')).toHaveFocus());
  });

  it('drops a reveal that expired before its row appeared, without taking focus', async () => {
    useFileViewerStore.getState().revealInFileTree('ws-1', '.komla-files');
    const reveal = {
      ...useFileViewerStore.getState().fileTreeRevealByWorkspace['ws-1'],
      expiresAt: Date.now() - 1,
    };

    renderSection({ reveal });

    await waitFor(() =>
      expect(useFileViewerStore.getState().fileTreeRevealByWorkspace['ws-1']).toBeUndefined()
    );
    expect(row('design.png')).not.toHaveFocus();
  });

  it('leaves a reveal of a project folder to the tree', async () => {
    useFileViewerStore.getState().revealInFileTree('ws-1', 'src');
    const reveal = useFileViewerStore.getState().fileTreeRevealByWorkspace['ws-1'];

    renderSection({ reveal });
    await act(async () => {});

    expect(useFileViewerStore.getState().fileTreeRevealByWorkspace['ws-1']?.path).toBe('src');
  });

  it('forgets its collapsed state with the workspace', () => {
    const store = useFileViewerStore.getState();
    store.setImportedFilesCollapsed('ws-1', true);

    store.clearWorkspaceFileViewerState('ws-1');

    expect(useFileViewerStore.getState().importedFilesCollapsedByWorkspace['ws-1']).toBeUndefined();
  });
});
