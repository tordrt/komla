/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { InlinePreviewHeader } from '../../../../src/renderer/components/terminal/TerminalTabs';
import { TooltipProvider } from '../../../../src/renderer/components/ui/tooltip';

vi.mock('../../../../src/renderer/components/dashboard', () => ({
  DashboardView: () => null,
}));

vi.mock('../../../../src/renderer/components/workspaces/SetupActivityPanel', () => ({
  SetupActivityNotificationCenter: () => null,
  WorkspaceSetupActivity: ({ workspaceId }: { workspaceId: string }) => (
    <span>setup of {workspaceId}</span>
  ),
}));

function renderHeader(
  previewFilePath: string | null = '.github/workflows/ci.yml',
  setInlineFilePreviewLayout = vi.fn(),
  previewNoteTitle: string | null = null,
  fullscreen = true
) {
  return render(
    <TooltipProvider>
      <InlinePreviewHeader
        isInlinePreviewOpen={true}
        isInlinePreviewFullscreen={fullscreen}
        isFileTreeOpen={true}
        contentWidth={0}
        resolvedPreviewWidthPx={0}
        previewFilePath={previewFilePath}
        previewNoteTitle={previewNoteTitle}
        previewFileStats={null}
        previewIsDirty={false}
        previewMode="browse"
        previewHideUnchanged={false}
        setDiffHideUnchangedRegions={vi.fn()}
        previewTotalChanges={0}
        changeNavRef={{ current: null }}
        inlinePreviewLayout="full"
        selectedWorkspaceId="ws-1"
        setInlineFilePreviewLayout={setInlineFilePreviewLayout}
        handleOpenPreviewFullscreen={vi.fn()}
        previewCloseRef={{ current: null }}
      />
    </TooltipProvider>
  );
}

describe('InlinePreviewHeader', () => {
  beforeAll(() => {
    globalThis.ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  });

  it('shows setup progress while it covers the tab row, full screen', () => {
    const { unmount } = renderHeader();
    expect(screen.getByText('setup of ws-1')).toBeInTheDocument();
    unmount();

    renderHeader(undefined, undefined, null, false);
    expect(screen.queryByText('setup of ws-1')).toBeNull();
  });

  it('isolates the left-truncated file path so a leading dot stays at the start', () => {
    renderHeader('.github/workflows/ci.yml');

    const pathText = screen.getByText('.github/workflows/ci.yml');
    // The RTL container truncates from the left; the path itself must render LTR
    // inside a bidi isolate, otherwise `.github/x` displays as `github/x.`.
    expect(pathText.tagName).toBe('BDI');
    expect(pathText.parentElement).toHaveStyle({ direction: 'rtl' });
  });

  it('names a note by its title and offers no full-screen file viewer for it', () => {
    renderHeader('\0note:2026-10-15-143210.md', vi.fn(), '');

    expect(screen.getByText('Untitled note')).toBeInTheDocument();
    expect(screen.queryByText(/2026-10-15/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open full screen' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Close preview' })).toBeInTheDocument();
  });

  it('keeps the close-preview button muted at rest and destructive only on hover', () => {
    renderHeader();

    const closeButton = screen.getByRole('button', { name: 'Close preview' });
    expect(closeButton).toHaveClass('text-muted-foreground', 'hover:text-destructive');
    expect(closeButton).not.toHaveClass('text-destructive');
  });

  it('switches the preview layout from a Split/Full radio group', () => {
    const setInlineFilePreviewLayout = vi.fn();
    renderHeader(undefined, setInlineFilePreviewLayout);

    expect(screen.getByRole('radiogroup', { name: 'Preview layout' })).toBeInTheDocument();
    const full = screen.getByRole('radio', { name: 'Full' });
    expect(full).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(screen.getByRole('radio', { name: 'Split' }));
    expect(setInlineFilePreviewLayout).toHaveBeenCalledWith('ws-1', 'side-by-side');

    setInlineFilePreviewLayout.mockClear();
    fireEvent.keyDown(full, { key: 'ArrowRight' });
    expect(setInlineFilePreviewLayout).toHaveBeenCalledWith('ws-1', 'side-by-side');
  });

  it("marks the header as part of its workspace's inline file preview for Escape handling", () => {
    const { container } = renderHeader();

    expect(container.querySelector('[data-inline-file-preview-scope="ws-1"]')).not.toBeNull();
  });
});
