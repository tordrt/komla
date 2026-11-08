import { ChatText, Copy, NotePencil, X } from '@phosphor-icons/react';
import {
  type ClipboardEvent as ReactClipboardEvent,
  type HTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from 'react';

import { Button } from '@/components/ui/button';
import { IconButton, ignoreFocusAfterPointer } from '@/components/ui/icon-button';
import { Kbd } from '@/components/ui/kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { spaceReference } from '@/lib/prompt-draft';
import { cn } from '@/lib/utils';
import { formatShortcutForDisplay, useShortcutsStore } from '@/stores/shortcuts.store';

const MODIFIER_KEYS = new Set(['Meta', 'Control', 'Shift', 'Alt']);

/** Keeps focus where it is, such as in the draft or on the lines selected in a file. */
export function keepFocus(event: ReactMouseEvent) {
  event.preventDefault();
}

/**
 * Replaces the selection of the textarea, which has focus. execCommand is deprecated, but it is
 * the only edit the textarea's own undo can take back; the fallback can't be undone, and calls
 * `onChange` with the text, as typing would.
 */
export function replaceSelection(
  textarea: HTMLTextAreaElement,
  value: string,
  onChange: (text: string) => void
) {
  const inserted =
    typeof document.execCommand === 'function' &&
    document.execCommand(value ? 'insertText' : 'delete', false, value);
  if (inserted) return;
  textarea.setRangeText(value, textarea.selectionStart, textarea.selectionEnd, 'end');
  onChange(textarea.value);
}

/** Puts a reference to a file in at the cursor, spaced from the words beside it. */
export function insertReference(
  textarea: HTMLTextAreaElement,
  reference: string,
  onChange: (text: string) => void
) {
  textarea.focus();
  replaceSelection(
    textarea,
    spaceReference(textarea.value, textarea.selectionStart, textarea.selectionEnd, reference),
    onChange
  );
}

/** Whether Cmd+C takes the whole prompt: with nothing, or all of it, selected. */
function copiesWhole(textarea: HTMLTextAreaElement) {
  const { selectionStart: start, selectionEnd: end, value } = textarea;
  return start === end || (start === 0 && end === value.length);
}

export interface PromptDraftPanelProps {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  text: string;
  onTextChange: (text: string) => void;
  onPaste?: (event: ReactClipboardEvent<HTMLTextAreaElement>) => void;
  /** The name of the file on screen, which the draft can refer to; null for none. */
  viewedFileName: string | null;
  /** What the reference button says without a file to refer to. */
  noFileLabel: string;
  /** Where the file to refer to is, for the placeholder: "the file you're looking at…". */
  fileWhere?: string;
  saving: boolean;
  /**
   * Whether files are still copying in, whose references the prompt would miss: it's copied,
   * saved or popped out once they're in.
   */
  uploading?: boolean;
  canSaveAsNote: boolean;
  onInsertReference: () => void;
  onSaveAsNote: () => void;
  onCopy: () => void;
  onClose: () => void;
  /** The button that pops the draft out of the window, or back in. */
  popButton: { label: string; icon: ReactNode; onClick: () => void };
  /** The header, which moves the draft. */
  headerProps?: HTMLAttributes<HTMLDivElement>;
  /** Handles a key with Cmd the draft doesn't take, returning whether it did. */
  onOtherShortcut?: (event: KeyboardEvent) => boolean;
}

/**
 * What the prompt draft shows, in a Komla window or popped out of it: its header, with the
 * buttons, and the text, with the keys that edit, copy and close it.
 */
export function PromptDraftPanel({
  textareaRef,
  text,
  onTextChange,
  onPaste,
  viewedFileName,
  noFileLabel,
  fileWhere = '',
  saving,
  uploading = false,
  canSaveAsNote,
  onInsertReference,
  onSaveAsNote,
  onCopy,
  onClose,
  popButton,
  headerProps,
  onOtherShortcut,
}: PromptDraftPanelProps) {
  const platform = window.api?.platform;
  const copyShortcut = formatShortcutForDisplay('Cmd+Enter', platform);
  const insertShortcut = formatShortcutForDisplay('Cmd+Shift+C', platform);

  const onKeyDown = (event: ReactKeyboardEvent) => {
    const native = event.nativeEvent;
    if (native.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (MODIFIER_KEYS.has(event.key)) return;
    // Whatever it is bound to, as the window's shortcuts pass over a textarea.
    if (useShortcutsStore.getState().matchesEvent('promptDraft.toggle', native)) {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    // Other keys without Cmd are typing, such as Option+N starting an ñ.
    if (!(event.metaKey || event.ctrlKey)) return;
    // The viewers behind take keys like these for their own shortcuts, such as Cmd+C copying a
    // file's @path; here they edit the draft.
    event.stopPropagation();
    const plain = !event.shiftKey && !event.altKey;
    const textarea = textareaRef.current;
    // Cmd+C as the platform has it, in the text: on a button it's no copy.
    const copyKey = platform === 'darwin' ? event.metaKey && !event.ctrlKey : event.ctrlKey;
    if (
      (event.key === 'Enter' && plain) ||
      (plain &&
        copyKey &&
        event.key.toLowerCase() === 'c' &&
        textarea &&
        event.target === textarea &&
        copiesWhole(textarea))
    ) {
      event.preventDefault();
      onCopy();
    } else if (event.shiftKey && !event.altKey && event.key.toLowerCase() === 'c') {
      event.preventDefault();
      onInsertReference();
    } else if (onOtherShortcut?.(native)) {
      event.preventDefault();
    }
  };

  return (
    // Clipped to the rounded corners; a draft's resize handles reach outside them.
    <div
      className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[calc(var(--radius-lg)-1px)]"
      onKeyDown={onKeyDown}
    >
      <div
        {...headerProps}
        className={cn(
          'flex h-8 shrink-0 items-center gap-0.5 border-b pr-1 pl-2.5 select-none',
          headerProps?.className
        )}
      >
        <ChatText aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
        <h2 className="mr-1 ml-1.5 min-w-0 flex-1 truncate text-xs font-medium">Prompt draft</h2>
        <ReferenceButton
          viewedFileName={viewedFileName}
          noFileLabel={noFileLabel}
          shortcut={insertShortcut}
          onInsert={onInsertReference}
        />
        <IconButton
          label="Save as note"
          size="xs"
          disabled={saving || uploading || !canSaveAsNote || !text.trim()}
          onMouseDown={keepFocus}
          onClick={onSaveAsNote}
        >
          <NotePencil className="size-3.5" />
        </IconButton>
        <IconButton
          label="Copy and close"
          shortcut={copyShortcut}
          size="xs"
          disabled={uploading || !text.trim()}
          onMouseDown={keepFocus}
          onClick={onCopy}
        >
          <Copy className="size-3.5" />
        </IconButton>
        <IconButton
          label={popButton.label}
          size="xs"
          disabled={uploading}
          onMouseDown={keepFocus}
          onClick={popButton.onClick}
        >
          {popButton.icon}
        </IconButton>
        <IconButton
          label="Close"
          shortcut="Esc"
          size="xs"
          onMouseDown={keepFocus}
          onClick={onClose}
        >
          <X className="size-3.5" />
        </IconButton>
      </div>
      <textarea
        ref={textareaRef}
        aria-label="Prompt"
        value={text}
        readOnly={saving}
        onChange={(event) => onTextChange(event.target.value)}
        onPaste={onPaste}
        // Paths and code would be underlined as misspelled.
        spellCheck={false}
        placeholder={`Draft a prompt to paste into an agent. ${insertShortcut} puts in the file you're looking at${fileWhere}.`}
        className="thin-scrollbar min-h-0 flex-1 resize-none bg-transparent px-3 py-2 font-mono text-[13px] leading-5 text-foreground outline-hidden placeholder:text-muted-foreground"
      />
    </div>
  );
}

/**
 * Puts in a reference to the file the user is looking at, with its selected lines. A short
 * "@path", with the file named in its tooltip, as a long name would leave little to drag by.
 */
function ReferenceButton({
  viewedFileName,
  noFileLabel,
  shortcut,
  onInsert,
}: {
  viewedFileName: string | null;
  noFileLabel: string;
  shortcut: string;
  onInsert: () => void;
}) {
  const label = viewedFileName ? `Insert @path to ${viewedFileName}` : noFileLabel;
  return (
    <Tooltip>
      <TooltipTrigger asChild onFocus={ignoreFocusAfterPointer}>
        {/* A disabled button gets no pointer events, so its tooltip goes on a wrapper. */}
        <span className="shrink-0">
          <Button
            type="button"
            variant="ghost"
            aria-label={label}
            disabled={!viewedFileName}
            onMouseDown={keepFocus}
            onClick={onInsert}
            className="h-6 px-1.5 text-xs font-normal text-muted-foreground hover:text-foreground"
          >
            @path
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent>
        <span className="flex items-center gap-2">
          {label}
          {viewedFileName && <Kbd>{shortcut}</Kbd>}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}
