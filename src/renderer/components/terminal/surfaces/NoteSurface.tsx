import React, { useCallback } from 'react';

import { NoteEditor } from '@/components/workspaces/file-viewer/notes/NoteEditor';
import { isPaneSurfaceClosed } from '@/lib/pane-surfaces';

import type { SurfaceBodyProps } from './surface-props';

// No header: the tab shows the note's title, and the editor's toolbar holds the close button.
export function NoteSurface({
  surfaceId,
  workspace,
  closeButton,
  onClose,
  name,
}: SurfaceBodyProps & { name: string }) {
  // The pane remounts its note when the layout around it changes or its
  // workspace moves to another window; only a closed pane closes the note.
  const isClosing = useCallback(() => isPaneSurfaceClosed(surfaceId), [surfaceId]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <NoteEditor
        workspace={workspace}
        name={name}
        onClose={onClose}
        isClosing={isClosing}
        // The saved file opens in the file panel, and the note is gone.
        onSavedToProject={onClose}
        trailingActions={closeButton}
      />
    </div>
  );
}
