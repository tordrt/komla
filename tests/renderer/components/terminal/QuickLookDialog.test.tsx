/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const editor = vi.hoisted(() => ({ revealLineInCenter: vi.fn(), setPosition: vi.fn() }));
// The files the files dropdown lists, which the sidebar lists first.
const terminalFiles = vi.hoisted(() => ({
  listed: { opened: [] as unknown[], mentioned: [] as unknown[] },
}));

vi.mock('../../../../src/renderer/components/terminal/terminal-files', () => ({
  rememberTerminalFiles: () => {},
  useTerminalFileViewerItems: () => terminalFiles.listed,
}));

// The Windows height, so the test fails if the viewer hard-codes the 36px one.
vi.mock('@/lib/monaco-loader', () => ({ ensureMonacoInitialized: () => Promise.resolve() }));
vi.mock('@/components/workspaces/file-viewer/EditorPane', async () => {
  const { useEffect } = await import('react');
  return {
    EditorPane: ({
      filePath,
      fileContent,
      onMount,
    }: {
      filePath: string;
      fileContent: string;
      onMount?: (instance: typeof editor) => void;
    }) => {
      useEffect(() => onMount?.(editor), [onMount]);
      return <pre aria-label={`Editor for ${filePath}`}>{fileContent}</pre>;
    },
  };
});

import { QuickLookDialog } from '../../../../src/renderer/components/terminal/QuickLookDialog';
import { TooltipProvider } from '../../../../src/renderer/components/ui/tooltip';
import { isShortcutEventClaimed } from '../../../../src/renderer/lib/shortcut-claims';
import { useFileViewerStore } from '../../../../src/renderer/stores/file-viewer.store';
import {
  useQuickLookStore,
  type QuickLookItem,
} from '../../../../src/renderer/stores/quick-look.store';

const api = {
  readViewerFile: vi.fn(),
  getViewerPreviewUrl: vi.fn(),
  listViewerFolder: vi.fn(),
  copyToClipboard: vi.fn(),
  openExternal: vi.fn(),
  openPath: vi.fn(),
  showItemInFolder: vi.fn(),
  updateWorkspace: vi.fn(async () => undefined),
  isWindowMaximized: vi.fn(async () => false),
  onWindowMaximizedChange: vi.fn(() => () => {}),
  platform: 'linux',
};

const terminalItem = (fullPath: string, hostPath?: string): QuickLookItem => ({
  path: fullPath,
  terminalId: 'term-1',
  source: { kind: 'terminal', fullPath },
  ...(hostPath ? { hostPath } : {}),
});
const workspaceItem = (filePath: string): QuickLookItem => ({
  path: filePath,
  terminalId: 'term-1',
  source: { kind: 'workspace', filePath },
});

const images = [terminalItem('/tmp/shots/a.png'), workspaceItem('out/b.png')];

/** A folder listing of these files, newest first: modified now, a minute ago, and so on. */
const listing = (...names: string[]) =>
  names.map((name, index) => ({ name, modifiedMs: Date.now() - index * 60_000 }));

const base64 = (text: string) => Buffer.from(text).toString('base64');

function renderViewer() {
  return render(
    <TooltipProvider>
      <QuickLookDialog />
    </TooltipProvider>
  );
}

/** Lists the files as opened from terminals, the latest first, and shows the first. */
function openViewer(items: QuickLookItem[]) {
  terminalFiles.listed = { opened: items, mentioned: [] };
  act(() => useQuickLookStore.getState().open('ws-1', items[0]));
}

const sidebarList = (name: string) =>
  within(screen.getByRole('navigation', { name: 'Files' })).getByRole('region', { name });

/** A sidebar folder's rows, top to bottom: a file's name, and when it was modified if listed. */
const sidebarRows = (name: string) =>
  within(within(sidebarList(name)).getByRole('list'))
    .getAllByRole('button')
    .map((button) => [...button.children].map((child) => child.textContent).filter(Boolean));

describe('QuickLookDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    useQuickLookStore.setState(useQuickLookStore.getInitialState(), true);
    terminalFiles.listed = { opened: [], mentioned: [] };
    api.readViewerFile.mockImplementation(
      async (_workspaceId: string, _terminalId: string, source: QuickLookItem['source']) => ({
        data: base64(source.kind === 'workspace' ? source.filePath : source.fullPath),
        mimeType: 'image/png',
      })
    );
    api.getViewerPreviewUrl.mockResolvedValue('komla-preview://token/report.html');
    api.listViewerFolder.mockResolvedValue([]);
    Object.defineProperty(window, 'api', { configurable: true, value: api });
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      }
    );
  });

  it('stays closed until a file is opened', () => {
    renderViewer();

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('covers the window, its header the top row, with Back and the window controls', () => {
    renderViewer();
    openViewer(images);

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveClass('!top-0', '!h-screen');
    expect(within(dialog).getByRole('button', { name: 'Minimize' })).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Back' }));
    expect(useQuickLookStore.getState().session).toBeNull();
  });

  it('shows the image from where the terminal runs, without copying it', async () => {
    renderViewer();
    openViewer(images);

    expect(await screen.findByRole('img', { name: 'a.png' })).toHaveAttribute(
      'src',
      `data:image/png;base64,${base64('/tmp/shots/a.png')}`
    );
    expect(screen.getByRole('dialog')).toHaveTextContent('/tmp/shots/a.png');
    expect(api.readViewerFile).toHaveBeenCalledWith('ws-1', 'term-1', images[0].source);
    expect(screen.getByRole('dialog')).toHaveFocus();
  });

  it('lists the opened files, then the rest of the folder on screen', async () => {
    api.listViewerFolder.mockResolvedValue(listing('c.png', 'a.png', 'notes.md'));
    renderViewer();
    openViewer(images);

    expect(
      await within(sidebarList('shots')).findByRole('button', { name: 'c.png' })
    ).toHaveAttribute('title', expect.stringMatching(/^\/tmp\/shots\/c\.png\nModified .+/));
    expect(api.listViewerFolder).toHaveBeenCalledWith('ws-1', 'term-1', images[0].source);
    const nav = screen.getByRole('navigation', { name: 'Files' });
    expect(
      within(nav)
        .getAllByRole('region')
        .map((region) => region.ariaLabel)
    ).toEqual(['Opened', 'shots']);
    // Each opened file with its folder, the latest first.
    expect(sidebarRows('Opened')).toEqual([
      ['a.png', '/tmp/shots/'],
      ['b.png', 'out/'],
    ]);
    expect(within(nav).getByRole('button', { name: 'a.png' })).toHaveAttribute(
      'aria-current',
      'true'
    );
    // The folder on screen lists its other files, newest first, each with when it was modified.
    expect(sidebarRows('shots')).toEqual([
      ['c.png', 'now'],
      ['notes.md', '2m'],
    ]);
  });

  it('steps down the opened files, then the folder of the file on screen', async () => {
    api.listViewerFolder.mockImplementation(
      async (_workspaceId: string, _terminalId: string, source: QuickLookItem['source']) =>
        source.kind === 'workspace' ? listing('d.png', 'b.png') : listing('c.png', 'a.png')
    );
    const user = userEvent.setup();
    renderViewer();
    openViewer(images);
    await screen.findByRole('img', { name: 'a.png' });
    await within(sidebarList('shots')).findByRole('button', { name: 'c.png' });
    expect(screen.queryByRole('button', { name: 'Previous file' })).not.toBeInTheDocument();

    // Into the next opened file, whose folder then lists its other files.
    await user.keyboard('{ArrowRight}');
    expect(await screen.findByRole('img', { name: 'b.png' })).toBeInTheDocument();
    expect(api.readViewerFile).toHaveBeenCalledWith('ws-1', 'term-1', images[1].source);
    expect(await within(sidebarList('out')).findByRole('button', { name: 'd.png' })).toBeVisible();
    expect(screen.queryByRole('region', { name: 'shots' })).not.toBeInTheDocument();

    await user.keyboard('{ArrowRight}');
    await screen.findByRole('img', { name: 'd.png' });
    expect(api.readViewerFile).toHaveBeenLastCalledWith('ws-1', 'term-1', {
      kind: 'workspace',
      filePath: 'out/d.png',
    });
    expect(screen.getByRole('dialog')).toHaveTextContent('out/d.png');
    expect(screen.queryByRole('button', { name: 'Next file' })).not.toBeInTheDocument();

    await user.keyboard('{ArrowLeft}');
    expect(await screen.findByRole('img', { name: 'b.png' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Previous file' }));
    expect(await screen.findByRole('img', { name: 'a.png' })).toBeInTheDocument();
    expect(
      await within(sidebarList('shots')).findByRole('button', { name: 'c.png' })
    ).toBeVisible();
  });

  it('steps up and down the sidebar with the up and down arrows', async () => {
    api.listViewerFolder.mockResolvedValue(listing('c.png', 'a.png'));
    const user = userEvent.setup();
    renderViewer();
    openViewer(images);
    const nav = screen.getByRole('navigation', { name: 'Files' });
    await within(sidebarList('shots')).findByRole('button', { name: 'c.png' });

    await user.keyboard('{ArrowDown}');
    expect(await screen.findByRole('img', { name: 'b.png' })).toBeInTheDocument();
    expect(within(nav).getByRole('button', { name: 'b.png' })).toHaveAttribute(
      'aria-current',
      'true'
    );
    await user.keyboard('{ArrowUp}');
    expect(await screen.findByRole('img', { name: 'a.png' })).toBeInTheDocument();

    // With a modifier, an arrow is another shortcut, such as Cmd+Up for the previous workspace.
    await user.keyboard(
      '{Meta>}{ArrowDown}{/Meta}{Control>}{ArrowDown}{/Control}{Alt>}{ArrowDown}{/Alt}{Shift>}{ArrowDown}{/Shift}'
    );
    expect(useQuickLookStore.getState().session?.item).toEqual(images[0]);
  });

  it('keeps its arrows from the file viewer behind it', async () => {
    // The file viewer's own listener, added before the viewer opened.
    const claimed: boolean[] = [];
    const behind = (event: KeyboardEvent) => claimed.push(isShortcutEventClaimed(event));
    window.addEventListener('keydown', behind);
    try {
      renderViewer();
      openViewer(images);
      await screen.findByRole('img', { name: 'a.png' });
      await userEvent.setup().keyboard('{ArrowDown}');
      expect(await screen.findByRole('img', { name: 'b.png' })).toBeInTheDocument();
    } finally {
      window.removeEventListener('keydown', behind);
    }
    expect(claimed).toEqual([true]);
  });

  it('leaves the arrows to menus and other layers over the viewer', async () => {
    const user = userEvent.setup();
    renderViewer();
    openViewer(images);
    const image = await screen.findByRole('img', { name: 'a.png' });

    await user.pointer({ keys: '[MouseRight]', target: image });
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Copy Image' })).toHaveFocus();
    expect(useQuickLookStore.getState().session?.item).toEqual(images[0]);

    // Such as a dialog opened over it.
    const layer = document.body.appendChild(document.createElement('button'));
    fireEvent.keyDown(layer, { key: 'ArrowDown' });
    layer.remove();
    expect(useQuickLookStore.getState().session?.item).toEqual(images[0]);
  });

  it('moves focus in the sidebar along with the file on screen', async () => {
    api.listViewerFolder.mockResolvedValue(listing('c.png', 'a.png', 'notes.md'));
    const user = userEvent.setup();
    renderViewer();
    openViewer(images);
    const row = (name: string) => within(sidebarList('shots')).getByRole('button', { name });
    await within(sidebarList('shots')).findByRole('button', { name: 'notes.md' });
    await screen.findByRole('img', { name: 'a.png' });

    // A click leaves focus on the viewer, not on the file clicked or a button that had it.
    screen.getByRole('button', { name: 'Copy path' }).focus();
    await user.click(row('c.png'));
    expect(await screen.findByRole('img', { name: 'c.png' })).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toHaveFocus();

    // Tabbed to, the file on screen keeps focus as the arrows move on from it.
    row('c.png').focus();
    await user.keyboard('{ArrowDown}');
    await vi.waitFor(() =>
      expect(useQuickLookStore.getState().session?.item.path).toBe('/tmp/shots/notes.md')
    );
    expect(row('notes.md')).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(row('c.png')).toHaveFocus();

    // Up into the opened files, and on into another folder, which no longer lists the file left.
    await user.keyboard('{ArrowUp}');
    expect(await screen.findByRole('img', { name: 'b.png' })).toBeInTheDocument();
    expect(within(sidebarList('Opened')).getByRole('button', { name: 'b.png' })).toHaveFocus();
  });

  it('shows 8 of a long folder, and more to reach the file on screen', async () => {
    const names = Array.from({ length: 12 }, (_, index) => `f${index}.png`);
    api.listViewerFolder.mockResolvedValue(listing(...names));
    const user = userEvent.setup();
    renderViewer();
    openViewer([terminalItem('/tmp/shots/f10.png')]);
    await within(sidebarList('shots')).findByRole('button', { name: 'f0.png' });

    expect(sidebarRows('shots')).toHaveLength(8);
    expect(
      within(sidebarList('shots')).getByRole('button', { name: 'Show 3 more…' })
    ).toBeVisible();

    // Stepped past the eighth, the folder shows as far as the file on screen.
    await user.keyboard('{ArrowDown}'.repeat(9));
    await vi.waitFor(() =>
      expect(useQuickLookStore.getState().session?.item.path).toBe('/tmp/shots/f8.png')
    );
    expect(sidebarRows('shots')).toHaveLength(9);

    await user.click(within(sidebarList('shots')).getByRole('button', { name: 'Show 2 more…' }));
    expect(sidebarRows('shots')).toHaveLength(11);
  });

  it('hides the sidebar with its button or Cmd+B, and remembers that', async () => {
    api.listViewerFolder.mockResolvedValue(listing('c.png', 'a.png'));
    const user = userEvent.setup();
    renderViewer();
    openViewer(images);
    await within(sidebarList('shots')).findByRole('button', { name: 'c.png' });

    await user.click(screen.getByRole('button', { name: 'Hide sidebar' }));
    expect(screen.queryByRole('navigation', { name: 'Files' })).not.toBeInTheDocument();
    expect(window.localStorage.getItem('komla.quickLookSidebarHidden')).toBe('true');
    // The arrows still step through its files.
    await user.keyboard('{ArrowRight}');
    expect(await screen.findByRole('img', { name: 'b.png' })).toBeInTheDocument();

    let claimed = false;
    const onWindowKeyDown = (event: KeyboardEvent) => {
      claimed = isShortcutEventClaimed(event);
    };
    window.addEventListener('keydown', onWindowKeyDown);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'b', ctrlKey: true });
    window.removeEventListener('keydown', onWindowKeyDown);

    expect(screen.getByRole('navigation', { name: 'Files' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hide sidebar' })).toBeInTheDocument();
    expect(window.localStorage.getItem('komla.quickLookSidebarHidden')).toBeNull();
    // The file panel's own Cmd+B behind the viewer leaves it alone.
    expect(claimed).toBe(true);
  });

  it('shows a file picked in the sidebar, read where its terminal runs', async () => {
    api.listViewerFolder.mockResolvedValue(listing('c.png', 'a.png'));
    const user = userEvent.setup();
    renderViewer();
    openViewer([terminalItem('/tmp/shots/a.png', '/tmp/shots/a.png')]);

    await user.click(await within(sidebarList('shots')).findByRole('button', { name: 'c.png' }));

    expect(await screen.findByRole('img', { name: 'c.png' })).toBeInTheDocument();
    expect(api.readViewerFile).toHaveBeenLastCalledWith('ws-1', 'term-1', {
      kind: 'terminal',
      fullPath: '/tmp/shots/c.png',
    });
    expect(useQuickLookStore.getState().session?.item.hostPath).toBe('/tmp/shots/c.png');
    // The folder was listed once for both of its files.
    expect(api.listViewerFolder).toHaveBeenCalledOnce();
  });

  it('says when the folder of the file on screen cannot be listed', async () => {
    api.listViewerFolder.mockRejectedValue(new Error('ENOENT'));
    renderViewer();
    openViewer([workspaceItem('notes.md')]);

    expect(
      await within(sidebarList('Workspace')).findByText("Couldn't list this folder")
    ).toBeVisible();
  });

  it('shows a folder from a link, and opens its subfolders and files', async () => {
    api.listViewerFolder.mockImplementation(
      async (_workspaceId: string, _terminalId: string, source: QuickLookItem['source']) =>
        source.kind === 'terminal' && source.fullPath === '/tmp/shots/'
          ? listing('before/', 'grid.png')
          : listing('a.png')
    );
    const user = userEvent.setup();
    renderViewer();
    openViewer([terminalItem('/tmp/shots/', '/tmp/shots/')]);

    const contents = await screen.findByRole('list', { name: 'Contents of shots' });
    expect(screen.getByRole('dialog', { name: 'shots' })).toHaveTextContent('/tmp/shots/');
    expect(
      (await within(contents).findAllByRole('button')).map((button) => button.textContent)
    ).toEqual(['beforenow', 'grid.png1m']);
    // The folder heads its section in the sidebar, which lists its files, its folders folded.
    expect(sidebarRows('shots')).toEqual([['grid.png', '1m']]);
    expect(screen.getByRole('button', { name: 'Show shots' })).toHaveAttribute(
      'aria-current',
      'true'
    );
    await user.click(within(sidebarList('shots')).getByRole('button', { name: '1 folder' }));
    expect(
      within(screen.getByRole('list', { name: 'Folders in shots' })).getByRole('button', {
        name: 'before',
      })
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Open in file panel' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show in File Manager' }));
    expect(api.showItemInFolder).toHaveBeenCalledWith('/tmp/shots/');

    await user.click(within(contents).getByRole('button', { name: 'before' }));
    expect(
      await within(screen.getByRole('list', { name: 'Contents of before' })).findByRole('button', {
        name: 'a.png',
      })
    ).toBeVisible();
    expect(api.listViewerFolder).toHaveBeenLastCalledWith('ws-1', 'term-1', {
      kind: 'terminal',
      fullPath: '/tmp/shots/before/',
    });

    // The folder opened from the link stays in the sidebar, to go back to.
    await user.click(within(sidebarList('Opened')).getByRole('button', { name: 'shots' }));
    expect(await screen.findByRole('list', { name: 'Contents of shots' })).toBeVisible();
    await user.keyboard('{ArrowRight}');
    expect(await screen.findByRole('img', { name: 'grid.png' })).toBeInTheDocument();
  });

  it('says when a folder has nothing the viewer can show', async () => {
    renderViewer();
    openViewer([terminalItem('/tmp/empty/')]);

    expect(await screen.findByText('No folders or viewable files')).toBeVisible();
  });

  it('shows a page in the locked-down preview frame, with its source a toggle away', async () => {
    const page = terminalItem('/tmp/report/index.html');
    api.readViewerFile.mockResolvedValue({
      data: base64('<h1>Report</h1>'),
      mimeType: 'text/html',
    });
    const user = userEvent.setup();
    renderViewer();
    openViewer([page, ...images]);

    const frame = await screen.findByTitle('/tmp/report/index.html browser preview');
    expect(frame.tagName).toBe('IFRAME');
    expect(frame).toHaveAttribute('src', 'komla-preview://token/report.html');
    expect(frame).toHaveAttribute('sandbox', 'allow-forms allow-scripts');
    expect(api.getViewerPreviewUrl).toHaveBeenCalledWith('ws-1', 'term-1', page.source);

    await user.click(screen.getByRole('radio', { name: 'Source' }));
    expect(await screen.findByLabelText('Editor for /tmp/report/index.html')).toHaveTextContent(
      '<h1>Report</h1>'
    );
    // A click leaves the arrows to the viewer.
    expect(screen.getByRole('dialog')).toHaveFocus();

    // Tabbed to, the toggle keeps its own arrows.
    screen.getByRole('radio', { name: 'Source' }).focus();
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('radio', { name: 'Preview' })).toBeChecked();
    expect(useQuickLookStore.getState().session?.item).toEqual(page);
  });

  it('shows a PDF in the browser PDF viewer', async () => {
    api.getViewerPreviewUrl.mockResolvedValue('komla-preview://token/paper.pdf');
    renderViewer();
    openViewer([workspaceItem('out/paper.pdf')]);

    const embed = await screen.findByTitle('out/paper.pdf browser preview');
    expect(embed.tagName).toBe('EMBED');
    expect(embed).toHaveAttribute('type', 'application/pdf');
    expect(embed).toHaveAttribute('src', 'komla-preview://token/paper.pdf');
  });

  it('renders Markdown without its scripts and opens its links in the browser', async () => {
    api.readViewerFile.mockResolvedValue({
      data: base64(
        '# Results\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n[docs](https://example.com/docs)\n\n<script>window.x = 1</script>'
      ),
      mimeType: 'application/octet-stream',
    });
    const user = userEvent.setup();
    renderViewer();
    openViewer([terminalItem('/tmp/NOTES.md')]);

    expect(await screen.findByRole('heading', { name: 'Results' })).toBeInTheDocument();
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(document.querySelector('.markdown-preview script')).toBeNull();

    await user.click(screen.getByRole('link', { name: 'docs' }));
    expect(api.openExternal).toHaveBeenCalledWith('https://example.com/docs');

    await user.click(screen.getByRole('radio', { name: 'Source' }));
    expect(await screen.findByLabelText('Editor for /tmp/NOTES.md')).toHaveTextContent('# Results');
  });

  it('goes back to the preview after a line link, but keeps a Source view chosen by hand', async () => {
    api.readViewerFile.mockResolvedValue({ data: base64('# Notes'), mimeType: 'text/markdown' });
    const user = userEvent.setup();
    renderViewer();
    const showLink = (item: QuickLookItem) =>
      act(() => useQuickLookStore.getState().open('ws-1', item));

    showLink({ ...terminalItem('/tmp/a.md'), lineNumber: 1 });
    expect(await screen.findByLabelText('Editor for /tmp/a.md')).toBeInTheDocument();
    showLink(terminalItem('/tmp/b.md'));
    expect(await screen.findByRole('heading', { name: 'Notes' })).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'Source' }));
    showLink(terminalItem('/tmp/c.md'));
    expect(await screen.findByLabelText('Editor for /tmp/c.md')).toBeInTheDocument();
  });

  it('shows text files, and files of other types that are text, read-only', async () => {
    api.readViewerFile.mockResolvedValue({
      data: base64('{"passed": 12}'),
      mimeType: 'application/octet-stream',
    });
    renderViewer();
    openViewer([terminalItem('/tmp/results.json'), terminalItem('/tmp/LICENSE')]);

    expect(await screen.findByLabelText('Editor for /tmp/results.json')).toHaveTextContent(
      '{"passed": 12}'
    );
    await userEvent.setup().keyboard('{ArrowRight}');
    expect(await screen.findByLabelText('Editor for /tmp/LICENSE')).toBeInTheDocument();
  });

  it('shows code from a link at the line it points to', async () => {
    api.readViewerFile.mockResolvedValue({ data: base64('a\nb\nc'), mimeType: 'text/plain' });
    renderViewer();
    openViewer([{ ...terminalItem('/tmp/migrate.py'), lineNumber: 2 }]);

    expect(await screen.findByLabelText('Editor for /tmp/migrate.py')).toHaveTextContent('a b c');
    // The editor mounts in an effect, which can run after the text shows.
    await waitFor(() =>
      expect(editor.setPosition).toHaveBeenCalledWith({ lineNumber: 2, column: 1 })
    );
    expect(editor.revealLineInCenter).toHaveBeenCalledWith(2);
  });

  it('shows the source of a Markdown file a link points into, at its line', async () => {
    api.readViewerFile.mockResolvedValue({ data: base64('# Notes'), mimeType: 'text/markdown' });
    renderViewer();
    openViewer([{ ...workspaceItem('docs/NOTES.md'), lineNumber: 1 }]);

    expect(await screen.findByLabelText('Editor for docs/NOTES.md')).toHaveTextContent('# Notes');
    await waitFor(() => expect(editor.revealLineInCenter).toHaveBeenCalledWith(1));
    expect(screen.getByRole('radio', { name: 'Source' })).toBeChecked();
  });

  it('hands a binary file of another type to the system when it is on this computer', async () => {
    api.readViewerFile.mockResolvedValue({
      data: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]).toString('base64'),
      mimeType: 'application/octet-stream',
    });
    const user = userEvent.setup();
    renderViewer();
    openViewer([terminalItem('/tmp/build.zip', '/tmp/build.zip')]);

    expect(await screen.findByText(/No preview for this type of file/)).toHaveTextContent('6 B');
    await user.click(screen.getByRole('button', { name: 'Open in default app' }));
    expect(api.openPath).toHaveBeenCalledWith('/tmp/build.zip');
    await user.click(screen.getByRole('button', { name: 'Show in File Manager' }));
    expect(api.showItemInFolder).toHaveBeenCalledWith('/tmp/build.zip');
  });

  it('explains a failed read and can still open a workspace file in the file panel', async () => {
    api.readViewerFile.mockRejectedValue(new Error('File is too large to view (9 bytes)'));
    const requestInlineFilePreviewNav = vi.fn();
    useFileViewerStore.setState({ requestInlineFilePreviewNav });
    const user = userEvent.setup();
    renderViewer();
    openViewer([images[1]]);

    expect(await screen.findByText(/too large to view/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open in default app' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open in file panel' }));

    expect(requestInlineFilePreviewNav).toHaveBeenCalledWith(
      'ws-1',
      'browse',
      'out/b.png',
      undefined,
      { browseTree: true }
    );
    expect(useQuickLookStore.getState().session).toBeNull();
  });

  it('opens a workspace file in the full viewer while that covers the file panel', async () => {
    const requestInlineFilePreviewNav = vi.fn();
    const requestFileViewerTransition = vi.fn();
    useFileViewerStore.setState({
      fileViewerWorkspaceId: 'ws-1',
      requestInlineFilePreviewNav,
      requestFileViewerTransition,
    });
    const user = userEvent.setup();
    renderViewer();
    openViewer([images[1]]);

    await user.click(await screen.findByRole('button', { name: 'Open in file panel' }));

    expect(requestInlineFilePreviewNav).not.toHaveBeenCalled();
    expect(requestFileViewerTransition).toHaveBeenCalledWith({
      kind: 'mode',
      workspaceId: 'ws-1',
      mode: 'browse',
      after: { kind: 'browse-file', filePath: 'out/b.png', lineNumber: undefined },
    });
    useFileViewerStore.setState({ fileViewerWorkspaceId: null });
  });

  it('offers the file panel only for files in the workspace', async () => {
    const user = userEvent.setup();
    renderViewer();
    openViewer(images);
    await screen.findByRole('img', { name: 'a.png' });

    // Opening it there would copy it into the workspace.
    expect(screen.queryByRole('button', { name: 'Open in file panel' })).not.toBeInTheDocument();
    await user.keyboard('{ArrowRight}');
    await screen.findByRole('img', { name: 'b.png' });
    expect(screen.getByRole('button', { name: 'Open in file panel' })).toBeInTheDocument();
  });

  it('copies the path and closes with Escape', async () => {
    const user = userEvent.setup();
    renderViewer();
    openViewer(images);
    await screen.findByRole('img', { name: 'a.png' });

    await user.click(screen.getByRole('button', { name: 'Copy path' }));
    expect(api.copyToClipboard).toHaveBeenCalledWith('/tmp/shots/a.png');

    await user.keyboard('{Escape}');
    expect(useQuickLookStore.getState().session).toBeNull();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
