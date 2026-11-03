/** @vitest-environment jsdom */
import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NoteSurface } from '../../../../../src/renderer/components/terminal/surfaces/NoteSurface';
import { usePaneSurfacesStore } from '../../../../../src/renderer/stores/pane-surfaces.store';
import { createWorkspace } from '../../../../factories';

import type { SurfaceBodyProps } from '../../../../../src/renderer/components/terminal/surfaces/surface-props';

const editor = vi.hoisted(() => ({
  props: null as null | { focusRequested?: boolean; onFocused?: () => void },
}));

vi.mock(
  '../../../../../src/renderer/components/workspaces/file-viewer/notes/NoteEditor',
  () => ({
    NoteEditor: (props: { focusRequested?: boolean; onFocused?: () => void }) => {
      editor.props = props;
      return null;
    },
  })
);

const SURFACE_ID = 'surface:note:n1';

function note(isTabActive: boolean) {
  const props = {
    surfaceId: SURFACE_ID,
    workspace: createWorkspace({ id: 'ws-1' }),
    isTabActive,
    isFocused: true,
    header: () => <div />,
    closeButton: <button type="button" />,
    onClose: vi.fn(),
  } satisfies SurfaceBodyProps;
  return <NoteSurface {...props} name="n1.md" />;
}

describe('NoteSurface', () => {
  beforeEach(() => {
    editor.props = null;
    usePaneSurfacesStore.setState({ editorFocusRequest: null });
  });

  it('focuses its editor on request once its tab shows, and only once', () => {
    usePaneSurfacesStore.getState().requestEditorFocus(SURFACE_ID);
    const { rerender } = render(note(false));
    expect(editor.props?.focusRequested).toBe(false);

    rerender(note(true));
    expect(editor.props?.focusRequested).toBe(true);

    act(() => editor.props?.onFocused?.());
    expect(usePaneSurfacesStore.getState().editorFocusRequest).toBeNull();
    expect(editor.props?.focusRequested).toBe(false);
  });

  it("leaves another pane's request alone", () => {
    usePaneSurfacesStore.getState().requestEditorFocus('surface:note:n2');
    render(note(true));

    expect(editor.props?.focusRequested).toBe(false);
    act(() => editor.props?.onFocused?.());
    expect(usePaneSurfacesStore.getState().editorFocusRequest).toBe('surface:note:n2');
  });
});
