/**
 * @vitest-environment jsdom
 */
import { act, createEvent, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SurfacePane } from '../../../../../src/renderer/components/terminal/surfaces/SurfacePane';
import {
  PANE_DRAG_MIME,
  setDraggedPaneId,
  TAB_PANE_DRAG_MIME,
} from '../../../../../src/renderer/lib/pane-drag';
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
      return (
        <>
          <div data-testid="note-toolbar" {...usePaneDragBar()} />
          <div data-testid="note-editor" onDragOver={noteEditorDragOver} onDrop={noteEditorDrop} />
        </>
      );
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

// An editor in the pane, which would take a drop of its own.
const noteEditorDragOver = vi.fn();
const noteEditorDrop = vi.fn();

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

describe('SurfacePane as a drop target', () => {
  const swapPanes = vi.fn();
  const movePaneToEdge = vi.fn();
  const moveTabToEdge = vi.fn();

  beforeEach(() => {
    setUp(['tab-1']);
    useLayoutStore.setState({ swapPanes, movePaneToEdge, moveTabToEdge });
    swapPanes.mockClear();
    movePaneToEdge.mockClear();
    moveTabToEdge.mockClear();
    noteEditorDragOver.mockClear();
    noteEditorDrop.mockClear();
  });

  afterEach(() => {
    act(() => setDraggedPaneId(null));
  });

  /** Renders the pane while `draggedPaneId`, if any, is being dragged, and returns its root. */
  function renderDuringDrag(
    draggedPaneId: string | null,
    props: { isLayoutLocked?: boolean } = {}
  ) {
    setDraggedPaneId(draggedPaneId);
    const { container } = renderPane(props);
    const pane = container.querySelector('[data-pane-surface="note"]') as HTMLElement;
    vi.spyOn(pane, 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ x: 0, y: 0, width: 100, height: 100 })
    );
    return pane;
  }

  function dropCatcher(pane: HTMLElement) {
    return pane.querySelector<HTMLElement>('[data-pane-drop-catcher]');
  }

  /** Fires a drag event at `target` and returns whether something accepted it. */
  function drag(
    type: 'dragOver' | 'drop',
    target: HTMLElement,
    { x, y }: { x: number; y: number },
    data: Record<string, string>
  ): boolean {
    const event = createEvent[type](target, {
      dataTransfer: { types: Object.keys(data), getData: (key: string) => data[key] ?? '' },
    });
    // jsdom has no DragEvent, so the pointer is set by hand.
    Object.defineProperties(event, { clientX: { value: x }, clientY: { value: y } });
    return !fireEvent(target, event);
  }

  it('covers its content while another pane is dragged, and only then', () => {
    const pane = renderDuringDrag('pane-2');
    expect(dropCatcher(pane)).toBeInTheDocument();

    act(() => setDraggedPaneId(null));
    expect(dropCatcher(pane)).not.toBeInTheDocument();
  });

  it('swaps with a pane dropped on its middle', () => {
    const pane = renderDuringDrag('pane-2');
    drag('drop', dropCatcher(pane)!, { x: 50, y: 50 }, { [PANE_DRAG_MIME]: 'pane-2' });
    expect(swapPanes).toHaveBeenCalledWith('pane-2', 'pane-1');
  });

  it('moves a pane dropped near an edge to that side', () => {
    const pane = renderDuringDrag('pane-2');
    drag('drop', dropCatcher(pane)!, { x: 95, y: 50 }, { [PANE_DRAG_MIME]: 'pane-2' });
    expect(movePaneToEdge).toHaveBeenCalledWith('pane-2', 'pane-1', 'right');
  });

  it('moves a single-pane tab dropped on it beside it', () => {
    useLayoutStore.setState({
      currentWorkspaceId: WORKSPACE_ID,
      layoutsByTab: {
        [WORKSPACE_ID]: { 'tab-2': { type: 'leaf', id: 'pane-2', terminalId: 'terminal-2' } },
      },
    });
    const pane = renderDuringDrag('pane-2');
    drag(
      'drop',
      dropCatcher(pane)!,
      { x: 45, y: 50 },
      { [PANE_DRAG_MIME]: 'pane-2', [TAB_PANE_DRAG_MIME]: 'tab-2' }
    );
    expect(moveTabToEdge).toHaveBeenCalledWith('tab-2', 'pane-1', 'left');
  });

  // The tab row ends a tab's drag on a drop anywhere in the window, as the tab may be gone by
  // its dragend.
  it('lets the drop reach the window', () => {
    const pane = renderDuringDrag('pane-2');
    const onWindowDrop = vi.fn();
    window.addEventListener('drop', onWindowDrop);
    drag('drop', dropCatcher(pane)!, { x: 50, y: 50 }, { [PANE_DRAG_MIME]: 'pane-2' });
    window.removeEventListener('drop', onWindowDrop);
    expect(onWindowDrop).toHaveBeenCalled();
  });

  it('accepts a dragged pane and shows where it would land', () => {
    const pane = renderDuringDrag('pane-2');
    const catcher = dropCatcher(pane)!;
    expect(drag('dragOver', catcher, { x: 50, y: 50 }, { [PANE_DRAG_MIME]: 'pane-2' })).toBe(true);
    expect(pane.querySelector('[data-pane-drop-indicator="center"]')).toBeInTheDocument();

    drag('dragOver', catcher, { x: 50, y: 5 }, { [PANE_DRAG_MIME]: 'pane-2' });
    expect(pane.querySelector('[data-pane-drop-indicator="top"]')).toBeInTheDocument();

    fireEvent.dragLeave(catcher, { relatedTarget: document.body });
    expect(pane.querySelector('[data-pane-drop-indicator]')).not.toBeInTheDocument();
  });

  it('leaves its content uncovered while it is the pane dragged', () => {
    expect(dropCatcher(renderDuringDrag('pane-1'))).not.toBeInTheDocument();
  });

  it('leaves other drags, such as files, to its content', () => {
    const pane = renderDuringDrag(null);
    expect(dropCatcher(pane)).not.toBeInTheDocument();
    drag('drop', screen.getByTestId('note-editor'), { x: 50, y: 50 }, { Files: '' });
    expect(noteEditorDrop).toHaveBeenCalled();
  });

  it('refuses a dropped pane while the layout is locked, without its content offering to take it', () => {
    const pane = renderDuringDrag('pane-2', { isLayoutLocked: true });
    const catcher = dropCatcher(pane)!;
    expect(drag('dragOver', catcher, { x: 50, y: 50 }, { [PANE_DRAG_MIME]: 'pane-2' })).toBe(false);
    drag('drop', catcher, { x: 50, y: 50 }, { [PANE_DRAG_MIME]: 'pane-2' });
    expect(swapPanes).not.toHaveBeenCalled();
    expect(noteEditorDragOver).not.toHaveBeenCalled();
    expect(noteEditorDrop).not.toHaveBeenCalled();
  });

  it('takes its drop indicator away with the drag', () => {
    const pane = renderDuringDrag('pane-2');
    drag('dragOver', dropCatcher(pane)!, { x: 50, y: 50 }, { [PANE_DRAG_MIME]: 'pane-2' });
    expect(pane.querySelector('[data-pane-drop-indicator]')).toBeInTheDocument();

    act(() => setDraggedPaneId(null));
    expect(pane.querySelector('[data-pane-drop-indicator]')).not.toBeInTheDocument();
  });
});

describe('SurfacePane outline', () => {
  beforeEach(() => setUp(['tab-1']));

  it('outlines a note pane, but not a browser pane, whose page is a native view over the window', () => {
    const { unmount } = renderPane();
    expect(screen.getByTestId('pane-outline')).toBeInTheDocument();
    unmount();

    usePaneSurfacesStore.setState({
      surfaces: { [SURFACE_ID]: { kind: 'browser', workspaceId: WORKSPACE_ID } },
    } as never);
    renderPane();
    // It would show only along the tab strip, the native page hiding its sides and bottom.
    expect(screen.queryByTestId('pane-outline')).not.toBeInTheDocument();
  });
});
