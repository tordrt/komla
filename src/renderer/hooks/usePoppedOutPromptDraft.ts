import { useEffect, useState } from 'react';

import { getFocusedPromptTerminalId } from '@/lib/focused-terminal';
import { createNote } from '@/lib/notes';
import { popInPromptDraft, PROMPT_DRAFT_ATTRIBUTE } from '@/lib/prompt-draft';
import { readRootTheme, watchRootTheme } from '@/lib/root-theme';
import { focusTerminalRenderer } from '@/lib/terminal-renderer-runtime';
import { selectPromptDraftWorkspace, usePromptDraftStore } from '@/stores/prompt-draft.store';
import { useToastStore } from '@/stores/toast.store';
import { selectViewedFile, useViewedFileStore } from '@/stores/viewed-file.store';

/** The file on screen in the workspace the draft would show over here. */
function viewedFile() {
  const workspaceId = selectPromptDraftWorkspace(usePromptDraftStore.getState());
  return workspaceId ? selectViewedFile(useViewedFileStore.getState(), workspaceId) : null;
}

/**
 * Serves the prompt draft while it's popped out into a window of its own: tells main which
 * workspace and file are on screen here, and Komla's theme, for when this is the window the draft
 * refers to, and does what the draft asks of it there. Takes the draft back as it pops in.
 */
export function usePoppedOutPromptDraft(): void {
  const poppedOut = usePromptDraftStore((s) => s.poppedOut.poppedOut);
  const workspaceId = usePromptDraftStore(selectPromptDraftWorkspace);
  const viewedFileName = useViewedFileStore((s) =>
    workspaceId ? (selectViewedFile(s, workspaceId)?.name ?? null) : null
  );
  const [theme, setTheme] = useState(readRootTheme);

  useEffect(() => {
    const store = usePromptDraftStore.getState();
    let current = true;
    void window.api.getPromptDraftWindowStatus().then((status) => {
      if (current) store.setPoppedOut(status);
    });
    const unsubscribers = [
      window.api.onPromptDraftWindowStatus((status) => store.setPoppedOut(status)),
      window.api.onPromptDraftPoppedIn(popInPromptDraft),
      window.api.onPromptDraftReferenceRequest(() =>
        window.api.sendPromptDraftReference(viewedFile()?.getReference() || null)
      ),
      window.api.onPromptDraftSaveAsNote((workspace, text) => {
        void createNote(workspace, text).then((saved) =>
          window.api.sendPromptDraftNoteSaved(saved)
        );
      }),
      window.api.onPromptDraftCopied(() => {
        useToastStore.getState().addToast('Copied the prompt', 'success');
        // To the workspace's terminal, unless a viewer covers the terminals or traps focus.
        const workspace = selectPromptDraftWorkspace(usePromptDraftStore.getState());
        // This window's own draft, open as the other popped out, doesn't count.
        const dialog = document.querySelector(`[role="dialog"]:not([${PROMPT_DRAFT_ATTRIBUTE}])`);
        if (!workspace || dialog) return;
        const terminalId = getFocusedPromptTerminalId(workspace);
        if (terminalId) focusTerminalRenderer(terminalId);
      }),
    ];
    return () => {
      current = false;
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    };
  }, []);

  useEffect(() => {
    if (!poppedOut) return;
    return watchRootTheme(setTheme);
  }, [poppedOut]);

  useEffect(() => {
    if (poppedOut) window.api.setPromptDraftContext({ theme, workspaceId, viewedFileName });
  }, [poppedOut, theme, workspaceId, viewedFileName]);
}
