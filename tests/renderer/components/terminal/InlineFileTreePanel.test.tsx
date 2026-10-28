// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../src/renderer/stores/window.store', () => ({
  useWindowStore: {
    getState: () => ({ windowId: 'window-1' }),
  },
}));
vi.mock('../../../../src/renderer/lib/terminal-renderer-runtime', () => ({
  disposeTerminalRenderers: vi.fn(),
  getTerminalRendererDimensions: vi.fn(() => undefined),
}));
vi.mock('../../../../src/renderer/components/workspaces/file-viewer/SidebarFileTree', async () => {
  const React = await import('react');
  return {
    SidebarFileTree: (props: {
      diffLoading?: boolean;
      isVisible?: boolean;
      onToggleBranchComparison?: () => void;
      onCutNode?: (path: string, isDirectory: boolean) => void;
      onPasteInto?: (targetDir: string) => void;
      onMoveNodes?: (sourcePaths: string[], targetDir: string) => Promise<boolean>;
      onDeleteFile?: (path: string, isDirectory?: boolean) => void;
      onRestoreFile?: (path: string, status: 'modified' | 'renamed') => void;
      onRollbackAll?: () => void;
    }) =>
      React.createElement(
        React.Fragment,
        null,
        React.createElement(
          'button',
          {
            disabled: props.diffLoading,
            'data-visible': String(props.isVisible),
            onClick: props.onToggleBranchComparison,
            type: 'button',
          },
          'toggle comparison'
        ),
        React.createElement(
          'button',
          { onClick: () => props.onCutNode?.('src/a.ts', false), type: 'button' },
          'cut src/a.ts'
        ),
        React.createElement(
          'button',
          { onClick: () => props.onPasteInto?.('lib'), type: 'button' },
          'paste into lib'
        ),
        React.createElement(
          'button',
          { onClick: () => props.onPasteInto?.('src'), type: 'button' },
          'paste into src'
        ),
        React.createElement(
          'button',
          { onClick: () => void props.onMoveNodes?.(['src/a.ts'], 'lib'), type: 'button' },
          'move src/a.ts to lib'
        ),
        React.createElement(
          'button',
          { onClick: () => props.onDeleteFile?.('src/a.ts'), type: 'button' },
          'delete src/a.ts'
        ),
        React.createElement(
          'button',
          { onClick: () => props.onDeleteFile?.('src', true), type: 'button' },
          'delete src'
        ),
        React.createElement(
          'button',
          { onClick: () => props.onRestoreFile?.('src/a.ts', 'modified'), type: 'button' },
          'rollback src/a.ts'
        ),
        React.createElement(
          'button',
          { onClick: () => props.onRestoreFile?.('new.ts', 'renamed'), type: 'button' },
          'rollback new.ts'
        ),
        React.createElement(
          'button',
          { onClick: () => props.onRollbackAll?.(), type: 'button' },
          'rollback all'
        )
      ),
  };
});

import { InlineFileTreePanel } from '../../../../src/renderer/components/terminal/InlineFileTreePanel';
import { useFileListStore } from '../../../../src/renderer/stores/file-list.store';
import { useFileViewerStore } from '../../../../src/renderer/stores/file-viewer.store';
import { useToastStore } from '../../../../src/renderer/stores/toast.store';
import { useWorkspacesStore } from '../../../../src/renderer/stores/workspaces.store';
import { createSshWorkspace, createWorkspace } from '../../../factories';

const emptyDiff = {
  files: [],
  summary: { additions: 0, deletions: 0, filesChanged: 0 },
};

describe('InlineFileTreePanel', () => {
  beforeEach(() => {
    useFileListStore.setState(useFileListStore.getInitialState(), true);
    useFileViewerStore.setState(useFileViewerStore.getInitialState(), true);
    useWorkspacesStore.setState({
      workspaces: [
        createWorkspace({
          id: 'ws-1',
          workingDirectory: '/repo',
          baseBranch: 'main',
          isWorktree: true,
        }),
      ],
      selectedWorkspaceId: 'ws-1',
    });

    useFileListStore.setState({
      diffCache: new Map([
        ['workspace:ws-1', { data: emptyDiff, isLoading: false, hasFullDiff: true }],
      ]),
    });

    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        onWorktreeChanged: vi.fn(() => vi.fn()),
        getWorkspaceDiff: vi.fn().mockResolvedValue(emptyDiff),
        getWorkspaceDiffAgainstBranch: vi.fn().mockResolvedValue(emptyDiff),
        listWorkspaceFiles: vi
          .fn()
          .mockResolvedValue({ files: [], gitIgnoredFiles: [], emptyDirs: [] }),
        updateWorkspace: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  it('loads each comparison before switching and disables repeated toggles', async () => {
    let resolveBranchDiff: ((value: typeof emptyDiff) => void) | undefined;
    window.api.getWorkspaceDiffAgainstBranch = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveBranchDiff = resolve;
        })
    );

    render(<InlineFileTreePanel workspaceId="ws-1" workingDirectory="/repo" isGitWorkspace />);

    const toggle = await screen.findByRole('button', { name: 'toggle comparison' });
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(window.api.getWorkspaceDiffAgainstBranch).toHaveBeenCalledWith('ws-1', 'main', true);
      expect(toggle).toBeDisabled();
    });
    expect(
      useFileViewerStore.getState().inlineFileTreeByWorkspace['ws-1']?.comparisonBranch
    ).toBeUndefined();

    fireEvent.click(toggle);
    expect(window.api.getWorkspaceDiffAgainstBranch).toHaveBeenCalledTimes(1);

    resolveBranchDiff?.(emptyDiff);
    await waitFor(() => {
      expect(
        useFileViewerStore.getState().inlineFileTreeByWorkspace['ws-1']?.comparisonBranch
      ).toBe('main');
      expect(toggle).not.toBeDisabled();
    });

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(window.api.getWorkspaceDiff).toHaveBeenCalledWith('ws-1');
    });
  });

  it('marks the file tree hidden while its workspace panel is inactive', async () => {
    render(
      <InlineFileTreePanel
        workspaceId="ws-1"
        workingDirectory="/repo"
        isGitWorkspace
        isActive={false}
      />
    );

    expect(await screen.findByRole('button', { name: 'toggle comparison' })).toHaveAttribute(
      'data-visible',
      'false'
    );
  });

  it('defers remote file data until terminal reconnection finishes', async () => {
    useWorkspacesStore.setState({
      workspaces: [
        createWorkspace({
          id: 'ws-1',
          workingDirectory: 'ssh://ssh-dev/repo',
          baseBranch: 'main',
          isWorktree: true,
          backend: {
            kind: 'ssh',
            hostId: 'ssh-dev',
            remoteDirectory: '/repo',
            remoteRepoPath: '/repos/repo.git',
            remoteProjectRoot: '/repos',
            gitUrl: 'git@example.com:repo.git',
            branchName: 'feature/test',
            baseBranch: 'main',
          },
        }),
      ],
      selectedWorkspaceId: 'ws-1',
      reconnectingSshWorkspaceIds: new Set(['ws-1']),
    });
    useFileListStore.setState({ diffCache: new Map() });

    render(
      <InlineFileTreePanel
        workspaceId="ws-1"
        workingDirectory="ssh://ssh-dev/repo"
        isGitWorkspace
      />
    );

    await Promise.resolve();
    expect(window.api.getWorkspaceDiff).not.toHaveBeenCalled();
    expect(window.api.listWorkspaceFiles).not.toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: 'toggle comparison' })).toHaveAttribute(
      'data-visible',
      'false'
    );

    act(() => {
      useWorkspacesStore.setState({ reconnectingSshWorkspaceIds: new Set() });
    });

    await waitFor(() => expect(window.api.getWorkspaceDiff).toHaveBeenCalledWith('ws-1'));
    expect(window.api.listWorkspaceFiles).toHaveBeenCalledWith('ws-1', false);
    expect(screen.getByRole('button', { name: 'toggle comparison' })).toHaveAttribute(
      'data-visible',
      'true'
    );
  });

  describe('cut and paste', () => {
    beforeEach(() => {
      Object.assign(window.api, {
        copyToClipboard: vi.fn(),
        fileExists: vi.fn().mockResolvedValue(false),
        renameFile: vi.fn().mockResolvedValue(undefined),
        copyFile: vi.fn().mockResolvedValue(undefined),
        copyDirectory: vi.fn().mockResolvedValue(undefined),
        deleteFile: vi.fn().mockResolvedValue(undefined),
      });
    });

    it('moves a cut file with a rename instead of copying and trashing the original', async () => {
      render(<InlineFileTreePanel workspaceId="ws-1" workingDirectory="/repo" isGitWorkspace />);

      fireEvent.click(await screen.findByRole('button', { name: 'cut src/a.ts' }));
      fireEvent.click(screen.getByRole('button', { name: 'paste into lib' }));

      await waitFor(() =>
        expect(window.api.renameFile).toHaveBeenCalledWith('/repo', 'src/a.ts', 'lib/a.ts')
      );
      expect(window.api.copyFile).not.toHaveBeenCalled();
      expect(window.api.deleteFile).not.toHaveBeenCalled();
    });

    it('leaves a cut file alone when it is pasted back into its own folder', async () => {
      window.api.fileExists = vi.fn().mockResolvedValue(true);
      render(<InlineFileTreePanel workspaceId="ws-1" workingDirectory="/repo" isGitWorkspace />);

      fireEvent.click(await screen.findByRole('button', { name: 'cut src/a.ts' }));
      fireEvent.click(screen.getByRole('button', { name: 'paste into src' }));
      await act(async () => {});

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(window.api.copyFile).not.toHaveBeenCalled();
      expect(window.api.deleteFile).not.toHaveBeenCalled();
    });

    it('asks before overwriting an existing file', async () => {
      window.api.fileExists = vi.fn().mockResolvedValue(true);
      render(<InlineFileTreePanel workspaceId="ws-1" workingDirectory="/repo" isGitWorkspace />);

      fireEvent.click(await screen.findByRole('button', { name: 'cut src/a.ts' }));
      fireEvent.click(screen.getByRole('button', { name: 'paste into lib' }));

      const dialog = await screen.findByRole('dialog', { name: 'File Already Exists' });
      expect(window.api.copyFile).not.toHaveBeenCalled();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Overwrite' }));

      await waitFor(() =>
        expect(window.api.copyFile).toHaveBeenCalledWith('/repo', 'src/a.ts', 'lib/a.ts')
      );
    });
  });

  describe('moves', () => {
    beforeEach(() => {
      Object.assign(window.api, {
        fileExists: vi.fn().mockResolvedValue(false),
        renameFile: vi.fn().mockResolvedValue(undefined),
        listFiles: vi.fn().mockResolvedValue({ files: [], gitIgnoredFiles: [], emptyDirs: [] }),
        getFileStatuses: vi.fn().mockResolvedValue({}),
      });
      useToastStore.setState({ toasts: [] });
    });

    it('offers to undo a move, since a drag moves a file without asking', async () => {
      render(<InlineFileTreePanel workspaceId="ws-1" workingDirectory="/repo" isGitWorkspace />);

      fireEvent.click(await screen.findByRole('button', { name: 'move src/a.ts to lib' }));
      await waitFor(() =>
        expect(window.api.renameFile).toHaveBeenCalledWith('/repo', 'src/a.ts', 'lib/a.ts')
      );
      const toast = useToastStore.getState().toasts.at(-1);
      expect(toast?.action?.label).toBe('Undo');

      act(() => toast?.action?.onClick());

      await waitFor(() =>
        expect(window.api.renameFile).toHaveBeenLastCalledWith('/repo', 'lib/a.ts', 'src/a.ts')
      );
    });

    it('moves the open preview along with its file', async () => {
      useFileViewerStore.getState().openInlineFilePreview('ws-1', 'browse', 'src/a.ts');
      render(<InlineFileTreePanel workspaceId="ws-1" workingDirectory="/repo" isGitWorkspace />);

      fireEvent.click(await screen.findByRole('button', { name: 'move src/a.ts to lib' }));

      await waitFor(() =>
        expect(useFileViewerStore.getState().inlineFilePreviewByWorkspace['ws-1']).toMatchObject({
          open: true,
          filePath: 'lib/a.ts',
        })
      );
    });

    it('leaves a previewed file with unsaved edits where it is', async () => {
      const viewer = useFileViewerStore.getState();
      viewer.openInlineFilePreview('ws-1', 'browse', 'src/a.ts');
      viewer.setInlineFilePreviewDirty('ws-1', true);
      render(<InlineFileTreePanel workspaceId="ws-1" workingDirectory="/repo" isGitWorkspace />);

      fireEvent.click(await screen.findByRole('button', { name: 'move src/a.ts to lib' }));

      await waitFor(() =>
        expect(useToastStore.getState().toasts.at(-1)?.message).toBe(
          'Save or discard your changes to a.ts first'
        )
      );
      expect(window.api.renameFile).not.toHaveBeenCalled();
    });
  });

  describe('destructive confirmations', () => {
    let confirmSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      Object.assign(window.api, {
        deleteFile: vi.fn().mockResolvedValue(undefined),
        restoreFile: vi.fn().mockResolvedValue(undefined),
        discardAllChanges: vi.fn().mockResolvedValue({ success: true }),
        listFiles: vi.fn().mockResolvedValue({ files: [], gitIgnoredFiles: [], emptyDirs: [] }),
        getFileStatuses: vi.fn().mockResolvedValue({}),
      });
    });

    afterEach(() => {
      confirmSpy.mockRestore();
    });

    it('confirms a delete in a styled dialog with Delete focused', async () => {
      render(<InlineFileTreePanel workspaceId="ws-1" workingDirectory="/repo" isGitWorkspace />);

      fireEvent.click(await screen.findByRole('button', { name: 'delete src/a.ts' }));

      const dialog = await screen.findByRole('dialog', { name: 'Delete' });
      expect(within(dialog).getByText('src/a.ts')).toBeInTheDocument();
      // A local delete goes to the trash, so Enter may confirm it.
      expect(within(dialog).getByRole('button', { name: 'Delete' })).toHaveFocus();
      expect(within(dialog).getByRole('button', { name: 'Delete' })).toHaveClass('bg-destructive');
      expect(confirmSpy).not.toHaveBeenCalled();
      expect(window.api.deleteFile).not.toHaveBeenCalled();

      await userEvent.keyboard('{Enter}');

      await waitFor(() =>
        expect(window.api.deleteFile).toHaveBeenCalledWith('/repo', 'src/a.ts', 'modified')
      );
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('focuses Cancel when a remote delete is permanent', async () => {
      Object.assign(window.api, { deleteWorkspacePath: vi.fn().mockResolvedValue(undefined) });
      useWorkspacesStore.setState({
        workspaces: [
          createSshWorkspace({
            id: 'ws-1',
            workingDirectory: 'ssh://ssh-dev/repo',
            isWorktree: true,
          }),
        ],
      });
      render(
        <InlineFileTreePanel
          workspaceId="ws-1"
          workingDirectory="ssh://ssh-dev/repo"
          isGitWorkspace
        />
      );

      fireEvent.click(await screen.findByRole('button', { name: 'delete src/a.ts' }));

      const dialog = await screen.findByRole('dialog', { name: 'Delete' });
      expect(dialog).toHaveTextContent('deleted permanently');
      expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();

      await userEvent.keyboard('{Enter}');
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(window.api.deleteWorkspacePath).not.toHaveBeenCalled();
    });

    it('names folders in the delete confirmation', async () => {
      render(<InlineFileTreePanel workspaceId="ws-1" workingDirectory="/repo" isGitWorkspace />);

      fireEvent.click(await screen.findByRole('button', { name: 'delete src' }));

      expect(await screen.findByRole('dialog', { name: 'Delete Folder' })).toHaveTextContent(
        'all of its contents'
      );
    });

    it('keeps the file when the delete is cancelled', async () => {
      render(<InlineFileTreePanel workspaceId="ws-1" workingDirectory="/repo" isGitWorkspace />);

      fireEvent.click(await screen.findByRole('button', { name: 'delete src/a.ts' }));
      const dialog = await screen.findByRole('dialog', { name: 'Delete' });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      await act(async () => {});

      expect(window.api.deleteFile).not.toHaveBeenCalled();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('confirms a single-file rollback', async () => {
      render(<InlineFileTreePanel workspaceId="ws-1" workingDirectory="/repo" isGitWorkspace />);

      fireEvent.click(await screen.findByRole('button', { name: 'rollback src/a.ts' }));

      const dialog = await screen.findByRole('dialog', { name: 'Rollback Changes' });
      expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Rollback' }));

      await waitFor(() =>
        expect(window.api.restoreFile).toHaveBeenCalledWith(
          '/repo',
          'src/a.ts',
          'modified',
          undefined
        )
      );
      expect(confirmSpy).not.toHaveBeenCalled();
    });

    it('rolls a renamed file back to the path it came from', async () => {
      useFileListStore.setState({
        diffCache: new Map([
          [
            'workspace:ws-1',
            {
              data: {
                files: [
                  {
                    path: 'new.ts',
                    originalPath: 'old.ts',
                    status: 'renamed',
                    staged: false,
                    additions: 1,
                    deletions: 0,
                  },
                ],
                summary: { additions: 1, deletions: 0, filesChanged: 1 },
              },
              isLoading: false,
              hasFullDiff: true,
            },
          ],
        ]),
      });
      render(<InlineFileTreePanel workspaceId="ws-1" workingDirectory="/repo" isGitWorkspace />);

      fireEvent.click(await screen.findByRole('button', { name: 'rollback new.ts' }));
      const dialog = await screen.findByRole('dialog', { name: 'Rollback Changes' });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Rollback' }));

      await waitFor(() =>
        expect(window.api.restoreFile).toHaveBeenCalledWith('/repo', 'new.ts', 'renamed', 'old.ts')
      );
    });

    it('confirms rolling back all changes', async () => {
      render(<InlineFileTreePanel workspaceId="ws-1" workingDirectory="/repo" isGitWorkspace />);

      fireEvent.click(await screen.findByRole('button', { name: 'rollback all' }));

      const dialog = await screen.findByRole('dialog', { name: 'Rollback All Changes' });
      expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
      expect(window.api.discardAllChanges).not.toHaveBeenCalled();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Rollback All' }));

      await waitFor(() => expect(window.api.discardAllChanges).toHaveBeenCalledWith('/repo'));
      expect(confirmSpy).not.toHaveBeenCalled();
    });
  });
});
