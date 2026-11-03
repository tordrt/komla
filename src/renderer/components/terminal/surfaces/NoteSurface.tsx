import React, { useCallback } from 'react';

import { NoteEditor } from '@/components/workspaces/file-viewer/notes/NoteEditor';
import { isPaneSurfaceClosed } from '@/lib/pane-surfaces';
import { usePaneSurfacesStore } from '@/stores/pane-surfaces.store';

import type { SurfaceBodyProps } from './surface-props';

// No header: the tab shows the note's title, and the editor's toolbar holds the close button.
export function NoteSurface({
  surfaceId,
  workspace,
  isTabActive,
  closeButton,
  onClose,
  name,
}: SurfaceBodyProps & { name: string }) {
  // The pane remounts its note when the layout around it changes or its
  // workspace moves to another window; only a closed pane closes the note.
  const isClosing = useCallback(() => isPaneSurfaceClosed(surfaceId), [surfaceId]);
  // A hidden tab's editor can't take focus, so a request waits for the tab to show.
  const focusRequested = usePaneSurfacesStore(
    (s) => isTabActive && s.editorFocusRequest === surfaceId
  );
  const onFocused = useCallback(
    () => usePaneSurfacesStore.getState().clearEditorFocusRequest(surfaceId),
    [surfaceId]
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <NoteEditor
        workspace={workspace}
        name={name}
        onClose={onClose}
        isClosing={isClosing}
        focusRequested={focusRequested}
        onFocused={onFocused}
        // The saved file opens in the file panel, and the note is gone.
        onSavedToProject={onClose}
        trailingActions={closeButton}
      />
    </div>
  );
}
