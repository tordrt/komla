/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DiffPane } from '../../../../../src/renderer/components/workspaces/file-viewer/DiffPane';
import { useCustomizationStore } from '../../../../../src/renderer/stores/customization.store';
import { DEFAULT_TERMINAL_CONFIG } from '../../../../../src/shared/constants/terminal';

import type { FileDiffContent } from '../../../../../src/renderer/types';

vi.mock('@monaco-editor/react', () => ({
  DiffEditor: ({
    options,
  }: {
    options?: {
      readOnly?: boolean;
      renderSideBySideInlineBreakpoint?: number;
      fontSize?: number;
    };
  }) => (
    <div
      data-read-only={String(options?.readOnly)}
      data-font-size={String(options?.fontSize)}
      data-inline-breakpoint={String(options?.renderSideBySideInlineBreakpoint)}
    >
      Diff Editor
    </div>
  ),
}));

vi.mock('../../../../../src/renderer/hooks/useKomlaEditorTheme', () => ({
  useKomlaEditorTheme: () => ({ base: 'vs-dark', inherit: true, rules: [], colors: {} }),
  useMonacoThemeName: () => 'komla-dark',
}));

vi.mock('../../../../../src/renderer/components/workspaces/file-viewer/MediaPane', () => ({
  MediaPane: ({
    data,
    mimeType,
    kind,
    fileName,
    fileSize,
    loading,
    error,
    onLoadPreview,
  }: {
    data: string | null;
    mimeType: string;
    kind: 'audio' | 'video';
    fileName: string;
    fileSize?: number | null;
    loading?: boolean;
    error?: string | null;
    onLoadPreview?: () => void;
  }) => (
    <div>
      <div>Media Pane</div>
      <div>{fileName}</div>
      <div>{mimeType}</div>
      <div>{kind}</div>
      <div>{fileSize}</div>
      <div>{data}</div>
      <div>{error}</div>
      <button type="button" disabled={loading || !onLoadPreview} onClick={onLoadPreview}>
        Load Preview
      </button>
    </div>
  ),
}));

const baseProps = {
  workingDirectory: '/repo',
  viewMode: 'split' as const,
  selectedFile: 'demo.mp4',
  loading: false,
  loadingFile: false,
  error: null,
  forceLargeFile: false,
  largeFileBlock: null,
  hideUnchangedRegions: false,
  onRetry: vi.fn(),
  onLoadLargeFile: vi.fn(),
};

function binaryDiff(overrides: Partial<FileDiffContent> = {}): FileDiffContent {
  return {
    path: 'demo.mp4',
    oldContent: null,
    newContent: null,
    status: 'modified',
    isBinary: true,
    ...overrides,
  };
}

function textDiff(overrides: Partial<FileDiffContent> = {}): FileDiffContent {
  return {
    path: 'demo.ts',
    oldContent: 'before',
    newContent: 'after',
    status: 'modified',
    isBinary: false,
    ...overrides,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

describe('DiffPane', () => {
  it('shows editor initialization errors even while Monaco is not ready', () => {
    const { container } = render(
      <DiffPane
        {...baseProps}
        fileContent={null}
        loading
        error="Failed to initialize editor: Outdated Optimize Dep"
      />
    );
    expect(screen.getByText('Failed to initialize editor: Outdated Optimize Dep')).toBeTruthy();
    expect(container.querySelector('.animate-pulse')).toBeNull();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getMediaFileMetadata: vi.fn().mockResolvedValue({
          mimeType: 'video/mp4',
          kind: 'video',
          size: 1234,
          mtimeMs: 1,
        }),
        readMediaFile: vi.fn().mockResolvedValue({
          data: 'video-data',
          mimeType: 'video/mp4',
          kind: 'video',
        }),
      },
    });
  });

  it('shows the current video file for binary video diffs', async () => {
    render(<DiffPane {...baseProps} fileContent={binaryDiff()} />);

    expect(await screen.findByText('Media Pane')).toBeInTheDocument();
    expect(screen.getByText('demo.mp4')).toBeInTheDocument();
    expect(await screen.findByText('video/mp4')).toBeInTheDocument();

    const loadButton = screen.getByRole('button', { name: 'Load Preview' });
    await waitFor(() => expect(loadButton).not.toBeDisabled());
    fireEvent.click(loadButton);

    expect(await screen.findByText('video-data')).toBeInTheDocument();
    expect(window.api.getMediaFileMetadata).toHaveBeenCalledWith('/repo', 'demo.mp4');
    expect(window.api.readMediaFile).toHaveBeenCalledWith('/repo', 'demo.mp4');
    expect(screen.queryByText('Binary file changed')).not.toBeInTheDocument();
  });

  it('keeps the binary placeholder for deleted video files', () => {
    render(<DiffPane {...baseProps} fileContent={binaryDiff({ status: 'deleted' })} />);

    expect(screen.getByText('Binary file changed')).toBeInTheDocument();
    expect(window.api.getMediaFileMetadata).not.toHaveBeenCalled();
  });

  it('keeps the binary placeholder when working-tree media previews are disabled', () => {
    render(
      <DiffPane
        {...baseProps}
        allowWorkingTreeMediaPreview={false}
        fileContent={binaryDiff()}
      />
    );

    expect(screen.getByText('Binary file changed')).toBeInTheDocument();
    expect(window.api.getMediaFileMetadata).not.toHaveBeenCalled();
  });

  it('makes text diffs read-only only when requested', () => {
    const { rerender } = render(
      <DiffPane {...baseProps} selectedFile="demo.ts" fileContent={textDiff()} readOnly />
    );

    expect(screen.getByText('Diff Editor')).toHaveAttribute('data-read-only', 'true');

    rerender(<DiffPane {...baseProps} selectedFile="demo.ts" fileContent={textDiff()} />);

    expect(screen.getByText('Diff Editor')).toHaveAttribute('data-read-only', 'false');
  });

  it('sizes its text a pixel under the terminal font', () => {
    render(<DiffPane {...baseProps} selectedFile="demo.ts" fileContent={textDiff()} />);
    expect(screen.getByText('Diff Editor')).toHaveAttribute('data-font-size', '13');

    act(() => {
      useCustomizationStore.setState({
        terminalConfig: {
          ...DEFAULT_TERMINAL_CONFIG,
          font: { ...DEFAULT_TERMINAL_CONFIG.font, size: 18 },
        },
      });
    });
    expect(screen.getByText('Diff Editor')).toHaveAttribute('data-font-size', '17');
    useCustomizationStore.setState({ terminalConfig: null });
  });

  // Monaco draws split as unified at or below this editor width.
  it("uses Monaco's 900px narrow breakpoint unless told otherwise", () => {
    const { rerender } = render(
      <DiffPane {...baseProps} selectedFile="demo.ts" fileContent={textDiff()} />
    );

    expect(screen.getByText('Diff Editor')).toHaveAttribute('data-inline-breakpoint', '900');

    rerender(
      <DiffPane
        {...baseProps}
        selectedFile="demo.ts"
        fileContent={textDiff()}
        inlineBreakpointPx={500}
      />
    );

    expect(screen.getByText('Diff Editor')).toHaveAttribute('data-inline-breakpoint', '500');
  });

  it('ignores stale preview loads after switching media files', async () => {
    const preview = deferred<{ data: string; mimeType: string; kind: 'video' }>();
    vi.mocked(window.api.readMediaFile).mockReturnValue(preview.promise);

    const { rerender } = render(<DiffPane {...baseProps} fileContent={binaryDiff()} />);

    const loadButton = screen.getByRole('button', { name: 'Load Preview' });
    await waitFor(() => expect(loadButton).not.toBeDisabled());
    fireEvent.click(loadButton);

    rerender(
      <DiffPane
        {...baseProps}
        selectedFile="other.webm"
        fileContent={binaryDiff({ path: 'other.webm' })}
      />
    );

    await act(async () => {
      preview.resolve({ data: 'stale-video-data', mimeType: 'video/mp4', kind: 'video' });
      await preview.promise;
    });

    expect(screen.getByText('other.webm')).toBeInTheDocument();
    expect(screen.queryByText('stale-video-data')).not.toBeInTheDocument();
  });
});
