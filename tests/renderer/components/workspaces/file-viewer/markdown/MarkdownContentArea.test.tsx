/** @vitest-environment jsdom */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TooltipProvider } from '../../../../../../src/renderer/components/ui/tooltip';
import { MarkdownContentArea } from '../../../../../../src/renderer/components/workspaces/file-viewer/markdown/MarkdownContentArea';
import {
  getMarkdownViewMode,
  RICH_MARKDOWN_MAX_LENGTH,
  setMarkdownViewMode,
} from '../../../../../../src/renderer/components/workspaces/file-viewer/markdown/markdown-view-mode';

const richEditorMock = vi.hoisted(() => ({ crash: false }));

vi.mock('../../../../../../src/renderer/lib/error-reporting', () => ({ reportError: vi.fn() }));

vi.mock(
  '../../../../../../src/renderer/components/workspaces/file-viewer/markdown/RichMarkdownEditor',
  () => ({
    RichMarkdownEditor: ({
      content,
      toolbarEnd,
    }: {
      content: string;
      toolbarEnd: React.ReactNode;
    }) => {
      if (richEditorMock.crash) throw new Error('bad table');
      return (
        <div>
          <div data-testid="rich">{content}</div>
          {toolbarEnd}
        </div>
      );
    },
  })
);

function area(props: Partial<React.ComponentProps<typeof MarkdownContentArea>> = {}) {
  return (
    <MarkdownContentArea
      filePath="PLAN.md"
      fileContent="# Plan"
      loadingFile={false}
      fileError={null}
      readOnly={false}
      sourceOnly={false}
      readImage={vi.fn()}
      sourceEditor={<div data-testid="source">Monaco</div>}
      {...props}
    />
  );
}

function renderArea(props: Partial<React.ComponentProps<typeof MarkdownContentArea>> = {}) {
  return render(area(props), { wrapper: TooltipProvider });
}

describe('MarkdownContentArea', () => {
  beforeEach(() => {
    setMarkdownViewMode('rich');
    richEditorMock.crash = false;
  });

  it('shows rich text by default and switches to the source', async () => {
    renderArea();
    expect(await screen.findByTestId('rich')).toHaveTextContent('# Plan');

    fireEvent.click(screen.getByRole('radio', { name: /Source/ }));
    expect(screen.getByTestId('source')).toBeInTheDocument();
    expect(screen.queryByTestId('rich')).toBeNull();
    expect(getMarkdownViewMode()).toBe('source');
  });

  it('toggles with Cmd/Ctrl+/ from inside the area', async () => {
    renderArea();
    fireEvent.keyDown(await screen.findByTestId('rich'), { key: '/', ctrlKey: true });
    expect(screen.getByTestId('source')).toBeInTheDocument();
    // Where / needs Shift, as on a German keyboard.
    fireEvent.keyDown(screen.getByTestId('source'), { key: '/', ctrlKey: true, shiftKey: true });
    expect(await screen.findByTestId('rich')).toBeInTheDocument();
  });

  it('shows extra buttons before the toggle in both views', async () => {
    renderArea({ actions: <button type="button">Save to project</button> });
    await screen.findByTestId('rich');
    expect(screen.getByRole('button', { name: 'Save to project' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: /Source/ }));
    expect(screen.getByRole('button', { name: 'Save to project' })).toBeInTheDocument();
  });

  it('keeps its buttons and the way to the source when the rich editor fails', async () => {
    richEditorMock.crash = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    renderArea({ trailingActions: <button type="button">Close pane</button> });

    expect(
      await screen.findByText("Couldn't show this file as rich text: bad table")
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close pane' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: /Source/ }));
    expect(screen.getByTestId('source')).toBeInTheDocument();
    vi.mocked(console.error).mockRestore();
  });

  it('shows the source of a file too large for rich text', () => {
    renderArea({ fileContent: 'x'.repeat(RICH_MARKDOWN_MAX_LENGTH + 1) });
    expect(screen.getByTestId('source')).toBeInTheDocument();
    expect(screen.getByText('Too large to edit as rich text')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Rich text/ })).toBeDisabled();
    // The preference is kept for the next file.
    expect(getMarkdownViewMode()).toBe('rich');
  });

  it('shows the source while blame is on', () => {
    renderArea({ sourceOnly: true });
    expect(screen.getByTestId('source')).toBeInTheDocument();
    expect(screen.getByText('Rich text is off while blame is shown')).toBeInTheDocument();
  });

  it('stays open while the file reloads from disk, so an agent edit updates it in place', async () => {
    const { rerender } = renderArea();
    const editor = await screen.findByTestId('rich');

    rerender(area({ loadingFile: true }));
    rerender(area({ fileContent: '# Plan\n\nAn agent added this.' }));

    expect(screen.getByTestId('rich')).toBe(editor);
    expect(editor).toHaveTextContent('An agent added this.');
  });

  it("waits for a file's first load, rather than showing what was open before", () => {
    renderArea({ fileContent: '# The previous file', loadingFile: true });
    expect(screen.queryByTestId('rich')).toBeNull();
  });

  it('lets the source editor show loading and errors', () => {
    renderArea({ fileContent: null, loadingFile: true });
    expect(screen.getByTestId('source')).toBeInTheDocument();
  });
});
