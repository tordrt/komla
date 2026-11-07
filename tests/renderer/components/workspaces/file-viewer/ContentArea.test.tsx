/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ComponentProps, ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { TooltipProvider } from '../../../../../src/renderer/components/ui/tooltip';
import { ContentArea } from '../../../../../src/renderer/components/workspaces/file-viewer/ContentArea';
import {
  getHtmlDiffViewMode,
  setHtmlDiffViewMode,
  setHtmlViewMode,
} from '../../../../../src/renderer/components/workspaces/file-viewer/html-view-mode';
import { setMarkdownViewMode } from '../../../../../src/renderer/components/workspaces/file-viewer/markdown/markdown-view-mode';

import type { FileDiffContent } from '../../../../../src/renderer/types';

vi.mock('../../../../../src/renderer/components/workspaces/file-viewer/EditorPane', () => ({
  EditorPane: ({ missingOnDisk }: { missingOnDisk?: boolean }) => (
    <div>{missingOnDisk ? 'File deleted or moved' : 'Editor Pane'}</div>
  ),
}));

vi.mock('../../../../../src/renderer/components/workspaces/file-viewer/ImagePane', () => ({
  ImagePane: () => <div>Image Pane</div>,
}));

vi.mock('../../../../../src/renderer/components/workspaces/file-viewer/MediaPane', () => ({
  MediaPane: () => <div>Media Pane</div>,
}));

vi.mock('../../../../../src/renderer/components/workspaces/file-viewer/DiffPane', () => ({
  DiffPane: ({
    readOnly,
    onRefreshMissing,
  }: {
    readOnly?: boolean;
    onRefreshMissing?: () => void;
  }) => (
    <div data-read-only={String(readOnly)}>
      Diff Pane
      {onRefreshMissing && (
        <button type="button" onClick={onRefreshMissing}>
          Refresh changes
        </button>
      )}
    </div>
  ),
}));

vi.mock(
  '../../../../../src/renderer/components/workspaces/file-viewer/markdown/RichMarkdownEditor',
  () => ({
    RichMarkdownEditor: ({
      content,
      readOnly,
      toolbarEnd,
    }: {
      content: string;
      readOnly: boolean;
      toolbarEnd: React.ReactNode;
    }) => (
      <div>
        <div data-testid="rich" data-read-only={String(readOnly)}>
          {content}
        </div>
        {toolbarEnd}
      </div>
    ),
  })
);

function diffOf(path: string, status: FileDiffContent['status']): FileDiffContent {
  return {
    path,
    oldContent: status === 'modified' ? '# Old' : null,
    newContent: '# New',
    status,
    isBinary: false,
  };
}

function contentAreaNode(
  overrides: Partial<ComponentProps<typeof ContentArea>> = {}
): ReactElement {
  return (
    <ContentArea
      mode="browse"
      workingDirectory="/repo"
      filePath="asset.png"
      fileContent={null}
      loadingFile={false}
      fileError={null}
      diffContent={null}
      viewMode="split"
      selectedFile={null}
      diffLoading={false}
      diffLoadingFile={false}
      diffError={null}
      forceLargeFile={false}
      largeFileBlock={null}
      hideUnchangedRegions={false}
      onRetry={vi.fn()}
      onLoadLargeFile={vi.fn()}
      {...overrides}
    />
  );
}

function renderContentArea(overrides: Partial<ComponentProps<typeof ContentArea>> = {}) {
  return render(contentAreaNode(overrides), { wrapper: TooltipProvider });
}

describe('ContentArea', () => {
  it('passes the diff-mode missing-file refresh handler to DiffPane', async () => {
    const onRefreshMissingDiff = vi.fn();
    renderContentArea({ mode: 'diff', onRefreshMissingDiff });

    (await screen.findByRole('button', { name: 'Refresh changes' })).click();

    expect(onRefreshMissingDiff).toHaveBeenCalledTimes(1);
  });

  it('shows missing-file state instead of a stale image preview', async () => {
    renderContentArea({
      missingOnDisk: true,
      isImage: true,
      imageData: 'data',
      imageMimeType: 'image/png',
    });

    expect(await screen.findByText('File deleted or moved')).toBeInTheDocument();
    expect(screen.queryByText('Image Pane')).not.toBeInTheDocument();
  });

  it('shows missing-file state instead of a stale media preview', async () => {
    renderContentArea({
      missingOnDisk: true,
      isMedia: true,
      mediaData: 'data',
      mediaMimeType: 'video/mp4',
      mediaKind: 'video',
    });

    expect(await screen.findByText('File deleted or moved')).toBeInTheDocument();
    expect(screen.queryByText('Media Pane')).not.toBeInTheDocument();
  });

  it('forwards read-only mode to the diff editor', async () => {
    renderContentArea({
      mode: 'diff',
      readOnly: true,
    });

    expect(await screen.findByText('Diff Pane')).toHaveAttribute('data-read-only', 'true');
  });

  it('shows an unsupported-binary state instead of Monaco for HEIC files', async () => {
    renderContentArea({
      filePath: 'photo.heic',
    });

    expect(await screen.findByText('Preview unavailable for this binary file')).toBeInTheDocument();
    expect(screen.queryByText('Editor Pane')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open in default app' })).toBeInTheDocument();
  });

  it('does not offer to open an SSH workspace binary file in a local app', async () => {
    renderContentArea({
      workingDirectory: 'ssh://host/home/dev/worktree',
      filePath: 'photo.heic',
    });

    expect(await screen.findByText('Preview unavailable for this binary file')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open in default app' })).not.toBeInTheDocument();
  });

  it('keeps PDFs in browser mode even when the workspace source view was selected', async () => {
    window.api = {
      ...window.api,
      getHtmlPreviewUrl: vi.fn().mockResolvedValue('komla-preview://token/document.pdf'),
    } as typeof window.api;
    setHtmlViewMode('/pdf-repo', 'source');

    renderContentArea({
      workingDirectory: '/pdf-repo',
      filePath: 'document.pdf',
      browserPreviewFilePath: 'document.pdf',
    });

    const preview = await screen.findByTitle('document.pdf browser preview');
    expect(preview.tagName).toBe('EMBED');
    expect(preview).toHaveAttribute('type', 'application/pdf');
    expect(screen.queryByText('Source')).not.toBeInTheDocument();
    expect(screen.queryByText('Editor Pane')).not.toBeInTheDocument();
  });

  it('switches an HTML preview between browser and source with the preview-mode toggle', async () => {
    window.api = {
      ...window.api,
      getHtmlPreviewUrl: vi.fn().mockResolvedValue('komla-preview://token/page.html'),
    } as typeof window.api;

    renderContentArea({
      workingDirectory: '/toggle-repo',
      filePath: 'page.html',
      browserPreviewFilePath: 'page.html',
    });

    const toggle = screen.getByRole('radiogroup', { name: 'Preview mode' });
    expect(within(toggle).getByRole('radio', { name: /Browser/ })).toBeChecked();
    expect(await screen.findByTitle('page.html browser preview')).toBeInTheDocument();

    fireEvent.click(within(toggle).getByRole('radio', { name: /Source/ }));

    expect(within(toggle).getByRole('radio', { name: /Source/ })).toBeChecked();
    expect(await screen.findByText('Editor Pane')).toBeInTheDocument();
    expect(screen.queryByTitle('page.html browser preview')).not.toBeInTheDocument();
  });

  it('keeps untrusted HTML previews sandboxed', async () => {
    window.api = {
      ...window.api,
      getHtmlPreviewUrl: vi.fn().mockResolvedValue('komla-preview://token/index.html'),
    } as typeof window.api;

    renderContentArea({
      filePath: 'index.html',
      browserPreviewFilePath: 'index.html',
    });

    expect(await screen.findByTitle('index.html browser preview')).toHaveAttribute(
      'sandbox',
      'allow-forms allow-scripts'
    );
  });

  it('creates SSH HTML previews from the already-loaded remote content', async () => {
    const getHtmlPreviewUrl = vi
      .fn()
      .mockResolvedValue('komla-preview://token/.komla-files/report.html');
    window.api = {
      ...window.api,
      getHtmlPreviewUrl,
    } as typeof window.api;
    const html = '<html><body>Remote report</body></html>';

    renderContentArea({
      workingDirectory: 'ssh://host/home/dev/worktree',
      filePath: '.komla-files/report.html',
      fileContent: html,
      browserPreviewFilePath: '.komla-files/report.html',
    });

    await waitFor(() =>
      expect(getHtmlPreviewUrl).toHaveBeenCalledWith(
        'ssh://host/home/dev/worktree',
        '.komla-files/report.html',
        html
      )
    );
    expect(
      await screen.findByTitle('.komla-files/report.html browser preview')
    ).toBeInTheDocument();
  });

  it('creates SSH SVG previews from the already-loaded remote content', async () => {
    const getHtmlPreviewUrl = vi.fn().mockResolvedValue('komla-preview://token/diagram.svg');
    window.api = {
      ...window.api,
      getHtmlPreviewUrl,
    } as typeof window.api;
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4" /></svg>';

    renderContentArea({
      workingDirectory: 'ssh://host/home/dev/worktree',
      filePath: 'diagram.svg',
      fileContent: svg,
      browserPreviewFilePath: 'diagram.svg',
    });

    await waitFor(() =>
      expect(getHtmlPreviewUrl).toHaveBeenCalledWith(
        'ssh://host/home/dev/worktree',
        'diagram.svg',
        svg
      )
    );
    expect(await screen.findByTitle('diagram.svg browser preview')).toBeInTheDocument();
  });

  it('isolates local HTML snapshots from neighboring workspace files', async () => {
    const getHtmlPreviewUrl = vi
      .fn()
      .mockResolvedValue('komla-preview://token/.komla-files/report.html');
    window.api = {
      ...window.api,
      getHtmlPreviewUrl,
    } as typeof window.api;
    const html = '<html><body>Local report</body></html>';

    renderContentArea({
      workingDirectory: '/repo',
      filePath: '.komla-files/report.html',
      fileContent: html,
      browserPreviewFilePath: '.komla-files/report.html',
    });

    await waitFor(() =>
      expect(getHtmlPreviewUrl).toHaveBeenCalledWith('/repo', '.komla-files/report.html', html)
    );
  });

  it('reloads a PDF browser preview when its metadata version changes', async () => {
    const getHtmlPreviewUrl = vi
      .fn()
      .mockResolvedValueOnce('komla-preview://first/document.pdf')
      .mockResolvedValueOnce('komla-preview://second/document.pdf');
    window.api = {
      ...window.api,
      getHtmlPreviewUrl,
    } as typeof window.api;

    const { rerender } = renderContentArea({
      workingDirectory: '/pdf-refresh-repo',
      filePath: 'document.pdf',
      browserPreviewFilePath: 'document.pdf',
      browserPreviewVersion: '10:100',
    });
    await waitFor(() => expect(getHtmlPreviewUrl).toHaveBeenCalledTimes(1));

    rerender(
      contentAreaNode({
        workingDirectory: '/pdf-refresh-repo',
        filePath: 'document.pdf',
        browserPreviewFilePath: 'document.pdf',
        browserPreviewVersion: '20:200',
      })
    );

    await waitFor(() => expect(getHtmlPreviewUrl).toHaveBeenCalledTimes(2));
  });

  it('reloads a PDF diff preview when its metadata version changes', async () => {
    const getHtmlPreviewUrl = vi
      .fn()
      .mockResolvedValueOnce('komla-preview://first/document.pdf')
      .mockResolvedValueOnce('komla-preview://second/document.pdf');
    window.api = {
      ...window.api,
      getHtmlPreviewUrl,
    } as typeof window.api;
    setHtmlDiffViewMode('/pdf-diff-repo', 'browser');

    const { rerender } = renderContentArea({
      mode: 'diff',
      workingDirectory: '/pdf-diff-repo',
      filePath: null,
      selectedFile: 'document.pdf',
      diffBrowserPreviewFilePath: 'document.pdf',
      diffBrowserPreviewVersion: '10:100',
    });
    await waitFor(() => expect(getHtmlPreviewUrl).toHaveBeenCalledTimes(1));

    rerender(
      contentAreaNode({
        mode: 'diff',
        workingDirectory: '/pdf-diff-repo',
        filePath: null,
        selectedFile: 'document.pdf',
        diffBrowserPreviewFilePath: 'document.pdf',
        diffBrowserPreviewVersion: '20:200',
      })
    );

    await waitFor(() => expect(getHtmlPreviewUrl).toHaveBeenCalledTimes(2));
  });

  it('previews the new side of an SSH diff from the loaded diff content', async () => {
    const getHtmlPreviewUrl = vi.fn().mockResolvedValue('komla-preview://token/diagram.svg');
    window.api = {
      ...window.api,
      getHtmlPreviewUrl,
    } as typeof window.api;
    setHtmlDiffViewMode('ssh://host/svg-diff', 'browser');
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4" /></svg>';

    renderContentArea({
      mode: 'diff',
      workingDirectory: 'ssh://host/svg-diff',
      filePath: null,
      selectedFile: 'diagram.svg',
      diffContent: {
        path: 'diagram.svg',
        oldContent: '<svg />',
        newContent: svg,
        status: 'modified',
        isBinary: false,
      },
      diffBrowserPreviewFilePath: 'diagram.svg',
    });

    await waitFor(() =>
      expect(getHtmlPreviewUrl).toHaveBeenCalledWith('ssh://host/svg-diff', 'diagram.svg', svg)
    );
    expect(await screen.findByTitle('diagram.svg browser preview')).toBeInTheDocument();
  });

  it('waits for the SSH diff content before previewing it', async () => {
    const getHtmlPreviewUrl = vi.fn().mockResolvedValue('komla-preview://token/page.html');
    window.api = {
      ...window.api,
      getHtmlPreviewUrl,
    } as typeof window.api;
    setHtmlDiffViewMode('ssh://host/html-diff', 'browser');

    renderContentArea({
      mode: 'diff',
      workingDirectory: 'ssh://host/html-diff',
      filePath: null,
      selectedFile: 'page.html',
      diffContent: null,
      diffLoadingFile: true,
      diffBrowserPreviewFilePath: 'page.html',
    });

    expect(await screen.findByText('Loading…')).toBeInTheDocument();
    expect(getHtmlPreviewUrl).not.toHaveBeenCalled();
  });

  it('reads an SSH PDF from the host for its browser preview', async () => {
    const getViewerPreviewUrl = vi.fn().mockResolvedValue('komla-preview://token/paper.pdf');
    window.api = {
      ...window.api,
      getViewerPreviewUrl,
    } as typeof window.api;

    renderContentArea({
      workingDirectory: 'ssh://host/pdf-browse',
      workspaceId: 'ws-ssh',
      filePath: 'docs/paper.pdf',
      browserPreviewFilePath: 'docs/paper.pdf',
    });

    expect(await screen.findByTitle('docs/paper.pdf browser preview')).toBeInTheDocument();
    expect(getViewerPreviewUrl).toHaveBeenCalledWith('ws-ssh', null, {
      kind: 'workspace',
      filePath: 'docs/paper.pdf',
    });
  });

  it('reads an SSH PDF diff preview from the host', async () => {
    const getViewerPreviewUrl = vi.fn().mockResolvedValue('komla-preview://token/paper.pdf');
    window.api = {
      ...window.api,
      getViewerPreviewUrl,
    } as typeof window.api;
    setHtmlDiffViewMode('ssh://host/pdf-diff', 'browser');

    renderContentArea({
      mode: 'diff',
      workingDirectory: 'ssh://host/pdf-diff',
      workspaceId: 'ws-ssh',
      filePath: null,
      selectedFile: 'paper.pdf',
      diffContent: {
        path: 'paper.pdf',
        oldContent: null,
        newContent: null,
        status: 'modified',
        isBinary: true,
      },
      diffBrowserPreviewFilePath: 'paper.pdf',
    });

    expect(await screen.findByTitle('paper.pdf browser preview')).toBeInTheDocument();
    expect(getViewerPreviewUrl).toHaveBeenCalledWith('ws-ssh', null, {
      kind: 'workspace',
      filePath: 'paper.pdf',
    });
  });

  it("previews a history diff from the commit's version, not the working tree", async () => {
    const getHtmlPreviewUrl = vi.fn().mockResolvedValue('komla-preview://token/diagram.svg');
    window.api = {
      ...window.api,
      getHtmlPreviewUrl,
    } as typeof window.api;
    setHtmlDiffViewMode('/history-repo', 'browser');
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" /></svg>';

    renderContentArea({
      mode: 'diff',
      workingDirectory: '/history-repo',
      filePath: null,
      selectedFile: 'diagram.svg',
      allowWorkingTreeMediaPreview: false,
      diffContent: {
        path: 'diagram.svg',
        oldContent: '<svg />',
        newContent: svg,
        status: 'modified',
        isBinary: false,
      },
      diffBrowserPreviewFilePath: 'diagram.svg',
    });

    await waitFor(() =>
      expect(getHtmlPreviewUrl).toHaveBeenCalledWith('/history-repo', 'diagram.svg', svg)
    );
  });

  describe('a file the diff adds', () => {
    it('shows a new Markdown file as read-only rich text, with its diff as the source', async () => {
      setMarkdownViewMode('rich');
      renderContentArea({
        mode: 'diff',
        filePath: null,
        selectedFile: 'docs/PLAN.md',
        diffFileStatus: 'untracked',
        diffContent: diffOf('docs/PLAN.md', 'untracked'),
      });

      const rich = await screen.findByTestId('rich');
      expect(rich).toHaveTextContent('# New');
      expect(rich).toHaveAttribute('data-read-only', 'true');
      expect(screen.queryByText('Diff Pane')).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('radio', { name: /Source/ }));
      expect(await screen.findByText('Diff Pane')).toBeInTheDocument();
      expect(screen.queryByTestId('rich')).not.toBeInTheDocument();
    });

    it('keeps the diff of a new Markdown file in front while it has unsaved edits', async () => {
      setMarkdownViewMode('rich');
      renderContentArea({
        mode: 'diff',
        filePath: null,
        selectedFile: 'NOTES.md',
        diffFileStatus: 'added',
        diffContent: diffOf('NOTES.md', 'added'),
        isDirty: true,
      });

      expect(await screen.findByText('Diff Pane')).toBeInTheDocument();
      expect(screen.queryByTestId('rich')).not.toBeInTheDocument();
      expect(screen.getByRole('radio', { name: /Rich text/ })).toBeDisabled();
    });

    it('shows the diff of a changed Markdown file', async () => {
      setMarkdownViewMode('rich');
      renderContentArea({
        mode: 'diff',
        filePath: null,
        selectedFile: 'README.md',
        diffFileStatus: 'modified',
        diffContent: diffOf('README.md', 'modified'),
      });

      expect(await screen.findByText('Diff Pane')).toBeInTheDocument();
      expect(screen.queryByTestId('rich')).not.toBeInTheDocument();
    });

    it('opens a new HTML file on its browser preview, and a changed one on its diff', async () => {
      window.api = {
        ...window.api,
        getHtmlPreviewUrl: vi.fn().mockResolvedValue('komla-preview://token/page.html'),
      } as typeof window.api;
      const props = {
        mode: 'diff',
        workingDirectory: '/new-html-repo',
        filePath: null,
        selectedFile: 'page.html',
        diffBrowserPreviewFilePath: 'page.html',
      } as const;

      const { rerender } = renderContentArea({
        ...props,
        diffFileStatus: 'untracked',
        diffContent: diffOf('page.html', 'untracked'),
      });
      expect(await screen.findByTitle('page.html browser preview')).toBeInTheDocument();
      expect(screen.queryByText('Diff Pane')).not.toBeInTheDocument();

      rerender(
        contentAreaNode({
          ...props,
          diffFileStatus: 'modified',
          diffContent: diffOf('page.html', 'modified'),
        })
      );
      expect(await screen.findByText('Diff Pane')).toBeInTheDocument();
      expect(screen.queryByTitle('page.html browser preview')).not.toBeInTheDocument();
    });

    it('opens a new HTML file on its preview before its diff loads', async () => {
      window.api = {
        ...window.api,
        getHtmlPreviewUrl: vi.fn().mockResolvedValue('komla-preview://token/new.html'),
      } as typeof window.api;
      renderContentArea({
        mode: 'diff',
        workingDirectory: '/new-html-loading',
        filePath: null,
        selectedFile: 'new.html',
        diffFileStatus: 'untracked',
        diffContent: diffOf('old.ts', 'modified'),
        diffLoadingFile: true,
        diffBrowserPreviewFilePath: 'new.html',
      });

      expect(await screen.findByTitle('new.html browser preview')).toBeInTheDocument();
      expect(screen.queryByText('Diff Pane')).not.toBeInTheDocument();
    });

    it("waits for a new Markdown file's own text before showing it as rich text", async () => {
      setMarkdownViewMode('rich');
      const props = {
        mode: 'diff',
        filePath: null,
        selectedFile: 'NEW.md',
        diffFileStatus: 'untracked',
      } as const;
      const { rerender } = renderContentArea({
        ...props,
        diffContent: diffOf('old.ts', 'modified'),
        diffLoadingFile: true,
      });

      // Not the last file's diff under this one's header.
      expect(await screen.findByText('Loading diff…')).toBeInTheDocument();
      expect(screen.queryByText('Diff Pane')).not.toBeInTheDocument();
      expect(screen.queryByTestId('rich')).not.toBeInTheDocument();

      rerender(contentAreaNode({ ...props, diffContent: diffOf('NEW.md', 'untracked') }));
      expect(await screen.findByTestId('rich')).toHaveTextContent('# New');
    });

    it('keeps the diff of an HTML file in front while it has unsaved edits', async () => {
      setHtmlDiffViewMode('/dirty-html', 'browser', true);
      renderContentArea({
        mode: 'diff',
        workingDirectory: '/dirty-html',
        filePath: null,
        selectedFile: 'page.html',
        diffBrowserPreviewFilePath: 'page.html',
        diffFileStatus: 'untracked',
        diffContent: diffOf('page.html', 'untracked'),
        isDirty: true,
      });

      expect(await screen.findByText('Diff Pane')).toBeInTheDocument();
      const toggle = screen.getByRole('radiogroup', { name: 'Preview mode' });
      expect(within(toggle).getByRole('radio', { name: /Browser/ })).toBeDisabled();
      expect(within(toggle).getByRole('radio', { name: /Diff/ })).toBeChecked();
    });

    it('remembers Diff for new HTML files apart from changed ones', async () => {
      window.api = {
        ...window.api,
        getHtmlPreviewUrl: vi.fn().mockResolvedValue('komla-preview://token/page.html'),
      } as typeof window.api;
      renderContentArea({
        mode: 'diff',
        workingDirectory: '/new-html-choice',
        filePath: null,
        selectedFile: 'page.html',
        diffBrowserPreviewFilePath: 'page.html',
        diffFileStatus: 'added',
        diffContent: diffOf('page.html', 'added'),
      });

      const toggle = screen.getByRole('radiogroup', { name: 'Preview mode' });
      fireEvent.click(within(toggle).getByRole('radio', { name: /Diff/ }));

      expect(await screen.findByText('Diff Pane')).toBeInTheDocument();
      expect(getHtmlDiffViewMode('/new-html-choice', true)).toBe('diff');
      setHtmlDiffViewMode('/new-html-choice', 'browser');
      expect(getHtmlDiffViewMode('/new-html-choice', true)).toBe('diff');
    });
  });

  it('shows a changed PDF as its preview, as its diff has nothing to show', async () => {
    window.api = {
      ...window.api,
      getHtmlPreviewUrl: vi.fn().mockResolvedValue('komla-preview://token/report.pdf'),
    } as typeof window.api;

    renderContentArea({
      mode: 'diff',
      workingDirectory: '/changed-pdf-repo',
      filePath: null,
      selectedFile: 'report.pdf',
      diffContent: {
        path: 'report.pdf',
        oldContent: null,
        newContent: null,
        status: 'modified',
        isBinary: true,
      },
      diffBrowserPreviewFilePath: 'report.pdf',
    });

    expect(await screen.findByTitle('report.pdf browser preview')).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup', { name: 'Preview mode' })).not.toBeInTheDocument();
    expect(screen.queryByText('Diff Pane')).not.toBeInTheDocument();
  });
});
