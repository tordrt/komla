import { ArrowSquareIn } from '@phosphor-icons/react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { TooltipProvider } from '@/components/ui/tooltip';
import { useShortcutsStore } from '@/stores/shortcuts.store';

import { insertReference, PromptDraftPanel } from './PromptDraftPanel';

import type { PromptDraftText, PromptDraftWindowContext } from '../../../shared/types';

/**
 * The prompt draft popped out into a window of its own, which stays over other apps, as a browser
 * showing what an agent built. It refers to the Komla window used last, as main tells it: the file
 * on screen there, and the workspace it's saved to as a note. Main keeps its text as it changes,
 * shows the window once it has drawn, and brings Komla forward once the prompt is copied.
 */
export function PoppedOutPromptDraft() {
  const [text, setText] = useState<string | null>(null);
  // Undefined until main says; null for no Komla window to refer to.
  const [context, setContext] = useState<PromptDraftWindowContext | null | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const selection = useRef<{ start: number; end: number } | null>(null);
  // Counts the drafts main sends, each with its own cursor, as one popping out joins this one.
  const [drafts, setDrafts] = useState(0);
  const theme = context?.theme;
  const loaded = text !== null && context !== undefined;

  /** Tells main the text, and where the cursor is in it, for a window that shows it next. */
  const report = () => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const draft: PromptDraftText = {
      text: textarea.value,
      selectionStart: textarea.selectionStart,
      selectionEnd: textarea.selectionEnd,
    };
    window.api.setPromptDraftWindowText(draft);
  };

  const onTextChange = (value: string) => {
    setText(value);
    report();
  };

  useEffect(() => {
    const unsubscribers = [
      window.api.onPromptDraftWindowDraft((draft) => {
        selection.current = { start: draft.selectionStart, end: draft.selectionEnd };
        setText(draft.text);
        setDrafts((count) => count + 1);
      }),
      window.api.onPromptDraftWindowContext(setContext),
      window.api.onPromptDraftWindowInsert((reference) => {
        const textarea = textareaRef.current;
        if (textarea) insertReference(textarea, reference, onTextChange);
      }),
      window.api.onPromptDraftWindowNoteSaved((saved) => {
        setSaving(false);
        if (!saved) return;
        setText('');
        window.api.setPromptDraftWindowText({ text: '', selectionStart: 0, selectionEnd: 0 });
      }),
    ];
    // Main sends it as the page loads, which can be before this listens.
    window.api.requestPromptDraftWindowState();
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, []);

  // Whatever the toggle shortcut is bound to closes it here, as in Komla's windows.
  useEffect(() => {
    void useShortcutsStore.getState().loadShortcuts();
  }, []);

  useLayoutEffect(() => {
    if (!theme) return;
    document.documentElement.className = theme.className;
    document.documentElement.style.cssText = theme.style;
  }, [theme]);

  // Where the cursor was, with focus, and the window shows once this has drawn.
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!loaded || !textarea) return;
    const { start, end } = selection.current ?? {
      start: textarea.value.length,
      end: textarea.value.length,
    };
    selection.current = null;
    textarea.setSelectionRange(start, end);
    textarea.focus();
    requestAnimationFrame(() => window.api.promptDraftWindowReady());
  }, [loaded, drafts]);

  // Shown again, the window gives focus back to the text.
  useEffect(() => {
    const onFocus = () => {
      if (document.activeElement === document.body) textareaRef.current?.focus();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  if (!loaded) return null;

  const close = () => {
    report();
    window.api.closePromptDraftWindow({ copied: false });
  };

  /** Copies the whole prompt and closes, for it to be pasted in Komla, which comes forward. */
  const copyAndClose = () => {
    const textarea = textareaRef.current;
    const prompt = (textarea?.value ?? text).trimEnd();
    if (!prompt.trim()) return;
    window.api.copyToClipboard(prompt);
    // Selected, for the next prompt to replace as it's typed.
    textarea?.select();
    report();
    window.api.closePromptDraftWindow({ copied: true });
  };

  const saveAsNote = () => {
    const content = textareaRef.current?.value ?? text;
    if (saving || !content.trim()) return;
    setSaving(true);
    window.api.savePromptDraftWindowAsNote(content);
  };

  const popIn = () => {
    const textarea = textareaRef.current;
    window.api.popInPromptDraft({
      text: textarea?.value ?? text,
      selectionStart: textarea?.selectionStart ?? text.length,
      selectionEnd: textarea?.selectionEnd ?? text.length,
    });
  };

  return (
    <TooltipProvider delayDuration={400}>
      <section
        aria-label="Prompt draft"
        className="floating-surface flex h-screen flex-col border text-popover-foreground"
      >
        <PromptDraftPanel
          textareaRef={textareaRef}
          text={text}
          onTextChange={onTextChange}
          viewedFileName={context?.viewedFileName ?? null}
          noFileLabel="Open a file in Komla to refer to it"
          fileWhere=" in Komla"
          saving={saving}
          canSaveAsNote={!!context?.workspaceId}
          onInsertReference={() => {
            textareaRef.current?.focus();
            window.api.requestPromptDraftWindowReference();
          }}
          onSaveAsNote={saveAsNote}
          onCopy={copyAndClose}
          onClose={close}
          popButton={{
            label: 'Put back in Komla',
            icon: <ArrowSquareIn className="size-3.5" />,
            onClick: popIn,
          }}
          // Moves the window, as a title bar does; its buttons still take clicks.
          headerProps={{ className: 'drag-region' }}
        />
      </section>
    </TooltipProvider>
  );
}
