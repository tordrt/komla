/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SurfacePane } from '../../../../../src/renderer/components/terminal/surfaces/SurfacePane';
import { PANE_DRAG_MIME } from '../../../../../src/renderer/lib/pane-drag';
import { useLayoutStore } from '../../../../../src/renderer/stores/layout.store';
import { usePaneSurfacesStore } from '../../../../../src/renderer/stores/pane-surfaces.store';
import { useWorkspacesStore } from '../../../../../src/renderer/stores/workspaces.store';
import { createWorkspace } from '../../../../factories';

import type { SurfaceBodyProps } from '../../../../../src/renderer/components/terminal/surfaces/surface-props';

vi.mock('../../../../../src/renderer/components/terminal/surfaces/NoteSurface', async () => {
  const { usePaneDragBar } =
    await import('../../../../../src/renderer/components/terminal/PaneDragGrip');
  return {
    NoteSurface: function NoteSurface() {
      return <div data-testid="note-toolbar" {...usePaneDragBar()} />;
    },
  };
});
vi.mock('../../../../../src/renderer/components/terminal/surfaces/BrowserSurface', () => ({
  BrowserSurface: ({ header }: SurfaceBodyProps) => header('A page'),
}));
vi.mock('../../../../../src/renderer/components/ui/tooltip', () => {
  const Pass = ({ children }: React.PropsWithChildren) => <>{children}</>;
  return { Tooltip: Pass, TooltipTrigger: Pass, TooltipContent: () => null, TooltipProvider: Pass };
});
vi.mock('../../../../../src/renderer/components/ui/context-menu', () => {
  const Pass = ({ children }: React.PropsWithChildren) => <>{children}</>;
  return {
    ContextMenu: Pass,
    ContextMenuTrigger: Pass,
    ContextMenuContent: () => null,
    ContextMenuItem: Pass,
    ContextMenuSeparator: () => null,
    ContextMenuShortcut: Pass,
    ContextMenuSub: Pass,
    ContextMenuSubContent: Pass,
    ContextMenuSubTrigger: Pass,
  };
});

const WORKSPACE_ID = 'ws-1';
const SURFACE_ID = 'surface:note:n1';

function setUp(tabIds: string[]) {
  useWorkspacesStore.setState({ workspaces: [createWorkspace({ id: WORKSPACE_ID })] });
  usePaneSurfacesStore.setState({
    surfaces: { [SURFACE_ID]: { kind: 'note', workspaceId: WORKSPACE_ID, name: 'n1.md' } },
  });
  useLayoutStore.setState({ tabsByWorkspace: { [WORKSPACE_ID]: tabIds } });
}

function renderPane(props: { isOnlyPane?: boolean; isLayoutLocked?: boolean } = {}) {
  return render(
    <SurfacePane
      paneId="pane-1"
      surfaceId={SURFACE_ID}
      workspaceId={WORKSPACE_ID}
      isTabActive
      {...props}
    />
  );
}

describe('SurfacePane drag grip', () => {
  beforeEach(() => setUp(['tab-1']));

  it('moves a split pane by its grip, shown once the pointer nears the top', () => {
    const { container } = renderPane();
    const pane = container.querySelector('[data-pane-surface="note"]') as HTMLElement;
    const grip = screen.getByTestId('pane-drag-grip');

    fireEvent.mouseMove(pane, { clientY: 200 });
    expect(grip).toHaveClass('opacity-0');
    fireEvent.mouseMove(pane, { clientY: 10 });
    expect(grip).not.toHaveClass('opacity-0');

    const setData = vi.fn();
    fireEvent.dragStart(grip, { dataTransfer: { setData } });
    expect(setData).toHaveBeenCalledWith(PANE_DRAG_MIME, 'pane-1');
    fireEvent.dragEnd(grip);
  });

  it('keeps the grip shown while it is pressed, so the drag still starts once the pointer leaves the top', () => {
    const { container } = renderPane();
    const pane = container.querySelector('[data-pane-surface="note"]') as HTMLElement;
    const grip = screen.getByTestId('pane-drag-grip');

    fireEvent.mouseMove(pane, { clientY: 10 });
    fireEvent.mouseMove(pane, { clientY: 200, buttons: 1 });
    expect(grip).not.toHaveClass('opacity-0');
    fireEvent.mouseLeave(pane, { buttons: 1 });
    expect(grip).not.toHaveClass('opacity-0');

    fireEvent.mouseUp(window);
    expect(grip).toHaveClass('opacity-0');
  });

  it('shows the grip on a lone pane only when there is another tab to drag it to', () => {
    const { unmount } = renderPane({ isOnlyPane: true });
    expect(screen.queryByTestId('pane-drag-grip')).not.toBeInTheDocument();
    unmount();

    setUp(['tab-1', 'tab-2']);
    renderPane({ isOnlyPane: true });
    expect(screen.getByTestId('pane-drag-grip')).toBeInTheDocument();
  });

  it('hides the grip while the layout is locked', () => {
    renderPane({ isLayoutLocked: true });
    expect(screen.queryByTestId('pane-drag-grip')).not.toBeInTheDocument();
  });

  it("moves the pane from its note's toolbar too", () => {
    renderPane();
    const setData = vi.fn();
    fireEvent.dragStart(screen.getByTestId('note-toolbar'), { dataTransfer: { setData } });
    expect(setData).toHaveBeenCalledWith(PANE_DRAG_MIME, 'pane-1');
  });

  it("moves a browser pane from its header's empty space, not from a press on its buttons", () => {
    usePaneSurfacesStore.setState({
      surfaces: { [SURFACE_ID]: { kind: 'browser', workspaceId: WORKSPACE_ID } },
    } as never);
    renderPane();
    const header = screen.getByText('A page').closest('[draggable="true"]') as HTMLElement;
    const setData = vi.fn();

    // A browser fires dragstart at the draggable header, wherever the press began.
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Close pane' }));
    fireEvent.dragStart(header, { dataTransfer: { setData } });
    expect(setData).not.toHaveBeenCalled();

    fireEvent.pointerDown(header);
    fireEvent.dragStart(header, { dataTransfer: { setData } });
    expect(setData).toHaveBeenCalledWith(PANE_DRAG_MIME, 'pane-1');
  });

  it("leaves the note's toolbar still while the layout is locked", () => {
    renderPane({ isLayoutLocked: true });
    expect(screen.getByTestId('note-toolbar')).not.toHaveAttribute('draggable');
  });
});
