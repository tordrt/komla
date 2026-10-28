/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DiffPane } from '../../../../../src/renderer/components/workspaces/file-viewer/DiffPane';
import { FileViewerMainPane } from '../../../../../src/renderer/components/workspaces/file-viewer/FileViewerMainPane';

import type { FileDiffContent } from '../../../../../src/renderer/types';

// Diff mode has no tabs: when the diffed file disappears, the recovery action
// must refresh the changes list rather than "Close Tab" (which used to close
// the whole viewer).

vi.mock('@monaco-editor/react', () => ({
  DiffEditor: () => <div>Diff Editor</div>,
}));

vi.mock('../../../../../src/renderer/hooks/useKomlaEditorTheme', () => ({
  useKomlaEditorTheme: () => ({ base: 'vs-dark', inherit: true, rules: [], colors: {} }),
  useMonacoThemeName: () => 'komla-dark',
}));

let contentAreaProps: Record<string, unknown> = {};
vi.mock('../../../../../src/renderer/components/workspaces/file-viewer/ContentArea', () => ({
  ContentArea: (props: Record<string, unknown>) => {
    contentAreaProps = props;
    return <div>Content Area</div>;
  },
}));
vi.mock('../../../../../src/renderer/components/workspaces/file-viewer/FileViewerToolbar', () => ({
  FileViewerToolbar: () => <div>Toolbar</div>,
}));
vi.mock('../../../../../src/renderer/components/workspaces/file-viewer/FileViewerSidebar', () => ({
  FileViewerSidebar: () => <div>Sidebar</div>,
}));

const missingDiff: FileDiffContent = {
  path: 'src/gone.ts',
  oldContent: null,
  newContent: null,
  status: 'modified',
  isBinary: false,
};

describe('DiffPane missing file', () => {
  it('offers "Refresh changes" instead of "Close Tab" when a refresh handler is given', () => {
    const onRefreshMissing = vi.fn();
    const onCloseMissing = vi.fn();
    render(
      <DiffPane
        workingDirectory="/repo"
        fileContent={missingDiff}
        viewMode="split"
        selectedFile="src/gone.ts"
        loading={false}
        loadingFile={false}
        error={null}
        forceLargeFile={false}
        largeFileBlock={null}
        hideUnchangedRegions={false}
        onRetry={vi.fn()}
        onLoadLargeFile={vi.fn()}
        onCloseMissing={onCloseMissing}
        onRefreshMissing={onRefreshMissing}
      />
    );

    expect(screen.getByText('File deleted or moved')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close Tab' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh changes' }));

    expect(onRefreshMissing).toHaveBeenCalledTimes(1);
    expect(onCloseMissing).not.toHaveBeenCalled();
  });
});

describe('FileViewerMainPane missing diff file', () => {
  beforeEach(() => {
    contentAreaProps = {};
  });

  function renderMainPane(diffSubMode: 'changes' | 'history') {
    const diff = {
      refresh: vi.fn().mockResolvedValue(undefined),
      refreshHistory: vi.fn().mockResolvedValue(undefined),
      comparisonBranch: null,
      selectedFile: null,
      grouped: { files: [] },
      error: null,
    };
    const onClose = vi.fn();
    render(
      <FileViewerMainPane
        {...({
          workspace: { id: 'workspace-1', workingDirectory: '/repo' },
          isGitWorkspace: true,
          isRemoteWorkspace: false,
          state: { mode: 'diff', diff, editor: { error: null } },
          blame: {},
          diffSubMode,
          sidebarOpen: false,
          onClose,
        } as never)}
      />
    );
    return { diff, onClose };
  }

  it('refreshes the changes list instead of closing the viewer', () => {
    const { diff, onClose } = renderMainPane('changes');

    expect(contentAreaProps.onRefreshMissingDiff).toEqual(expect.any(Function));
    (contentAreaProps.onRefreshMissingDiff as () => void)();

    expect(diff.refresh).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('refreshes history in the History sub-mode', () => {
    const { diff, onClose } = renderMainPane('history');

    (contentAreaProps.onRefreshMissingDiff as () => void)();

    expect(diff.refreshHistory).toHaveBeenCalledTimes(1);
    expect(diff.refresh).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  // Monaco's 900px default drew Split as unified in a viewer with its file
  // list open, so the toolbar's Split toggle looked like it did nothing.
  it.each(['changes', 'history'] as const)(
    'lets Split stay split down to 500px in %s',
    (subMode) => {
      renderMainPane(subMode);

      expect(contentAreaProps.inlineBreakpointPx).toBe(500);
    }
  );
});
