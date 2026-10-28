/** @vitest-environment jsdom */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TooltipProvider } from '../../../../../../src/renderer/components/ui/tooltip';
import { NoteEditor } from '../../../../../../src/renderer/components/workspaces/file-viewer/notes/NoteEditor';
import { useFileViewerStore } from '../../../../../../src/renderer/stores/file-viewer.store';
import { resetNotesStore } from '../../../../../../src/renderer/stores/notes.store';

import type { Workspace } from '../../../../../../src/renderer/types';

vi.mock('../../../../../../src/renderer/lib/monaco-loader', () => ({
  ensureMonacoInitialized: () => Promise.resolve(),
}));

// Typing the rich editor holds back in a batch, reported when its handle's getMarkdown() runs.
const editorMock = vi.hoisted(() => ({ unreported: null as string | null }));

// The editor itself is tested elsewhere; here it's a text box.
vi.mock(
  '../../../../../../src/renderer/components/workspaces/file-viewer/markdown/MarkdownContentArea',
  async () => {
    const { useLayoutEffect } = await import('react');
    return {
      MarkdownContentArea: function MockMarkdownContentArea({
        fileContent,
        onChange,
        onMarkdownEditorMount,
        actions,
      }: {
        fileContent: string | null;
        onChange: (content: string) => void;
        onMarkdownEditorMount: (handle: { getMarkdown: () => string } | null) => void;
        actions: React.ReactNode;
      }) {
        // Like the real editor's handle, this detaches after its parent's layout cleanup.
        useLayoutEffect(() => {
          onMarkdownEditorMount({
            getMarkdown: () => {
              if (editorMock.unreported !== null) onChange(editorMock.unreported);
              editorMock.unreported = null;
              return '';
            },
          });
          return () => onMarkdownEditorMount(null);
        });
        return (
          <div>
            {fileContent !== null && (
              <textarea
                aria-label="Note"
                value={fileContent}
                onChange={(event) => onChange(event.target.value)}
              />
            )}
            {actions}
          </div>
        );
      },
    };
  }
);

const SCOPE = 'w1';
const NAME = '2026-10-15-143210.md';
const WORKSPACE = {
  id: SCOPE,
  projectId: 'p1',
  name: 'repo',
  workingDirectory: '/repo',
} as Workspace;

function missingError(): Error {
  return new Error("Error invoking remote method 'notes:read': Error: ENOENT: no such file");
}

describe('NoteEditor', () => {
  let api: Record<string, ReturnType<typeof vi.fn>>;
  let notifyChanged: (scopeId: string) => void;

  beforeEach(() => {
    vi.useFakeTimers();
    resetNotesStore();
    editorMock.unreported = null;
    api = {
      readNote: vi.fn().mockResolvedValue('# Draft\n'),
      writeNote: vi.fn().mockResolvedValue(undefined),
      deleteNote: vi.fn().mockResolvedValue(true),
      onNotesChanged: vi.fn((callback: (scopeId: string) => void) => {
        notifyChanged = callback;
        return () => {};
      }),
      fileExists: vi.fn().mockResolvedValue(false),
      writeFile: vi.fn().mockResolvedValue(undefined),
      readWorkspaceFile: vi.fn(),
      writeWorkspaceFile: vi.fn().mockResolvedValue(undefined),
      readWorkspaceImageFile: vi.fn(),
      // Saving into the project refreshes the file tree and the note list.
      listFiles: vi.fn().mockResolvedValue({ files: [], gitIgnoredFiles: [], emptyDirs: [] }),
      getChangedFilesWithSummary: vi.fn().mockResolvedValue({ files: [] }),
      listNotes: vi.fn().mockResolvedValue([]),
    };
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { ...api, platform: 'linux' },
    });
    useFileViewerStore.setState({ inlineFilePreviewByWorkspace: {} });
  });

  afterEach(() => {
    vi.useRealTimers();
    useFileViewerStore.setState({ inlineFilePreviewByWorkspace: {} });
  });

  async function renderNote(workspace: Workspace = WORKSPACE) {
    const onClose = vi.fn();
    const view = render(<NoteEditor workspace={workspace} name={NAME} onClose={onClose} />, {
      wrapper: TooltipProvider,
    });
    await act(async () => {});
    return { ...view, onClose };
  }

  function type(text: string) {
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: text } });
  }

  it('shows the note and saves what is typed once typing pauses', async () => {
    await renderNote();
    expect(screen.getByLabelText('Note')).toHaveValue('# Draft\n');

    type('# Draft\nmore');
    type('# Draft\nmore text');
    expect(api.writeNote).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(400);
    });

    expect(api.writeNote).toHaveBeenCalledTimes(1);
    expect(api.writeNote).toHaveBeenCalledWith(SCOPE, NAME, '# Draft\nmore text');
  });

  it('keeps the buttons at the end of its toolbar while the note loads', async () => {
    api.readNote.mockReturnValue(new Promise(() => {}));
    render(
      <NoteEditor
        workspace={WORKSPACE}
        name={NAME}
        onClose={vi.fn()}
        trailingActions={<button type="button">Close pane</button>}
      />,
      { wrapper: TooltipProvider }
    );
    await act(async () => {});

    expect(screen.queryByLabelText('Note')).toBeNull();
    expect(screen.getByRole('button', { name: 'Close pane' })).toBeInTheDocument();
  });

  it('saves typing still waiting when the note closes', async () => {
    const { unmount } = await renderNote();
    type('Last words');

    unmount();
    await act(async () => {});

    expect(api.writeNote).toHaveBeenCalledWith(SCOPE, NAME, 'Last words');
    expect(api.deleteNote).not.toHaveBeenCalled();
  });

  it('saves what the rich editor had not reported yet when the note closes', async () => {
    api.readNote.mockResolvedValue('');
    const { unmount } = await renderNote();
    type('F');
    editorMock.unreported = 'First words';

    unmount();
    await act(async () => {});

    expect(api.writeNote).toHaveBeenLastCalledWith(SCOPE, NAME, 'First words');
    expect(api.deleteNote).not.toHaveBeenCalled();
  });

  it('deletes a note closed without text', async () => {
    api.readNote.mockResolvedValue('');
    const { unmount } = await renderNote();

    unmount();
    await act(async () => {});

    expect(api.writeNote).not.toHaveBeenCalled();
    expect(api.deleteNote).toHaveBeenCalledWith(SCOPE, NAME, true);
  });

  it('never writes over a note it could not read', async () => {
    api.readNote.mockRejectedValue(new Error('EACCES: permission denied'));
    const { unmount } = await renderNote();
    expect(screen.getByText("Couldn't open this note")).toBeInTheDocument();

    unmount();
    await act(async () => {});

    expect(api.writeNote).not.toHaveBeenCalled();
    expect(api.deleteNote).not.toHaveBeenCalled();
  });

  it('shows text an agent wrote to the note', async () => {
    await renderNote();
    api.readNote.mockResolvedValue('# Draft\n\nAdded by an agent\n');

    await act(async () => notifyChanged(SCOPE));

    expect(screen.getByLabelText('Note')).toHaveValue('# Draft\n\nAdded by an agent\n');
  });

  it('keeps typing not yet saved over a change on disk', async () => {
    await renderNote();
    type('Mine');
    api.readNote.mockResolvedValue('Theirs');

    await act(async () => notifyChanged(SCOPE));

    expect(screen.getByLabelText('Note')).toHaveValue('Mine');
  });

  it('says so when the note was deleted', async () => {
    api.readNote.mockRejectedValue(missingError());
    const { onClose } = await renderNote();

    expect(screen.getByText('This note was deleted')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });

  describe('Save to project', () => {
    async function openSaveDialog(workspace?: Workspace) {
      await renderNote(workspace);
      type('# Fix the login bug\n\nSteps');
      await act(async () => {
        fireEvent.keyDown(screen.getByLabelText('Note'), { key: 's', ctrlKey: true });
      });
      return screen.getByRole('textbox', { name: 'Path in the project' });
    }

    it('opens from the toolbar button too', async () => {
      await renderNote();
      type('# Fix the login bug');

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Save to project' }));
      });

      expect(screen.getByRole('textbox', { name: 'Path in the project' })).toHaveValue(
        'fix-the-login-bug.md'
      );
    });

    it('names the file after the note and saves it into the workspace', async () => {
      const input = await openSaveDialog();
      expect(input).toHaveValue('fix-the-login-bug.md');

      fireEvent.change(input, { target: { value: 'docs/fix-login.md' } });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      });

      expect(api.writeFile).toHaveBeenCalledWith(
        '/repo',
        'docs/fix-login.md',
        '# Fix the login bug\n\nSteps'
      );
      expect(api.deleteNote).toHaveBeenCalledWith(SCOPE, NAME, false);
      // The saved file takes the note's place.
      expect(useFileViewerStore.getState().inlineFilePreviewByWorkspace.w1).toMatchObject({
        open: true,
        filePath: 'docs/fix-login.md',
      });
    });

    it('does not overwrite a file', async () => {
      api.fileExists.mockResolvedValue(true);
      await openSaveDialog();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      });

      expect(screen.getByRole('alert')).toHaveTextContent('fix-the-login-bug.md already exists.');
      expect(api.writeFile).not.toHaveBeenCalled();
      expect(api.deleteNote).not.toHaveBeenCalled();
    });

    describe('on an SSH host', () => {
      const SSH_WORKSPACE = { ...WORKSPACE, backend: { kind: 'ssh' } } as Workspace;

      it('saves when the file is not there', async () => {
        api.readWorkspaceFile.mockRejectedValue(
          new Error(
            "Error invoking remote method 'workspace:read-file': Error: ENOENT: no such file"
          )
        );
        await openSaveDialog(SSH_WORKSPACE);

        await act(async () => {
          fireEvent.click(screen.getByRole('button', { name: 'Save' }));
        });

        expect(api.writeWorkspaceFile).toHaveBeenCalledWith(
          'w1',
          'fix-the-login-bug.md',
          '# Fix the login bug\n\nSteps'
        );
      });

      it("doesn't write over a file it couldn't read", async () => {
        api.readWorkspaceFile.mockRejectedValue(
          new Error(
            "Error invoking remote method 'workspace:read-file': Error: Remote file is too large to view"
          )
        );
        await openSaveDialog(SSH_WORKSPACE);

        await act(async () => {
          fireEvent.click(screen.getByRole('button', { name: 'Save' }));
        });

        expect(screen.getByRole('alert')).toHaveTextContent('too large to view');
        expect(api.writeWorkspaceFile).not.toHaveBeenCalled();
        expect(api.deleteNote).not.toHaveBeenCalled();
      });
    });

    it.each(['../outside.md', '/etc/motd', 'docs//x.md'])(
      'keeps the note inside the project: %s',
      async (path) => {
        const input = await openSaveDialog();
        fireEvent.change(input, { target: { value: path } });

        await act(async () => {
          fireEvent.click(screen.getByRole('button', { name: 'Save' }));
        });

        expect(screen.getByRole('alert')).toHaveTextContent('Enter a path inside the project');
        expect(api.fileExists).not.toHaveBeenCalled();
        expect(api.writeFile).not.toHaveBeenCalled();
      }
    );
  });
});
