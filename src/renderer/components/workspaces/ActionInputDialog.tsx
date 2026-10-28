import { CaretRight } from '@phosphor-icons/react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Kbd } from '@/components/ui/kbd';
import { ACTION_TARGET_BRANCH_TOKEN, ACTION_USER_INPUT_TOKEN } from '@/lib/action-injection';
import { cn } from '@/lib/utils';
import { formatShortcutForDisplay } from '@/stores/shortcuts.store';

interface ActionInputDialogProps {
  open: boolean;
  actionTitle: string;
  actionContent: string;
  /** Offered as a suggestion (click or ↑), never prefilled: Enter must not rerun it by habit. */
  lastInput?: string;
  onCancel: () => void;
  onConfirm: (input: string) => void;
  confirmLabel?: string;
}

// ACTION_USER_INPUT_TOKEN and ACTION_TARGET_BRANCH_TOKEN, captured so split() keeps them.
const TOKEN_PATTERN = /(\{\{user_input\}\}|\{\{target_branch\}\})/;

const CONTEXT_MAX_LENGTH = 160;
const CONTEXT_RADIUS = 60;

/**
 * The line that holds the input token, without Markdown markers, when it says more than the
 * token itself ("Investigate issue {{user_input}}"); a long line is cut to the words around the
 * token. Null for a token on its own.
 */
export function getActionInputContextLine(content: string): string | null {
  const line = content.split('\n').find((l) => l.includes(ACTION_USER_INPUT_TOKEN));
  if (!line) return null;
  const text = line
    .replace(/^\s*(?:(?:#+|[-*+>]|\d+[.)])\s+)+/, '')
    .replace(/\*\*|__|`/g, '')
    .trim();
  const rest = text.replaceAll(ACTION_USER_INPUT_TOKEN, '').replace(/[^\p{L}\p{N}]/gu, '');
  if (rest.length < 3) return null;
  if (text.length <= CONTEXT_MAX_LENGTH) return text;

  const tokenStart = text.indexOf(ACTION_USER_INPUT_TOKEN);
  const tokenEnd = tokenStart + ACTION_USER_INPUT_TOKEN.length;
  let start = Math.max(0, tokenStart - CONTEXT_RADIUS);
  let end = Math.min(text.length, tokenEnd + CONTEXT_RADIUS);
  // Cut at word boundaries, never into the token.
  if (start > 0) {
    const space = text.indexOf(' ', start);
    if (space !== -1 && space < tokenStart) start = space + 1;
  }
  if (end < text.length) {
    const space = text.lastIndexOf(' ', end);
    if (space > tokenEnd) end = space;
  }
  const excerpt = text
    .slice(start, end)
    .trim()
    .replace(/[.,;:]$/, '');
  return `${start > 0 ? '…' : ''}${excerpt}${end < text.length ? '…' : ''}`;
}

function TokenChip({ children }: { children: ReactNode }) {
  return (
    <span className="rounded border border-dashed border-foreground/25 px-1 text-muted-foreground">
      {children}
    </span>
  );
}

/** Prompt text with its tokens drawn as chips, or the input in place once there is some. */
function PromptTemplate({ text, input }: { text: string; input: string }) {
  let offset = 0;
  return text.split(TOKEN_PATTERN).map((part) => {
    const start = offset;
    offset += part.length;
    if (!part) return null;
    if (part === ACTION_USER_INPUT_TOKEN) {
      return input ? (
        <span key={start} className="rounded bg-primary/15 px-0.5 text-foreground">
          {input}
        </span>
      ) : (
        <TokenChip key={start}>your input</TokenChip>
      );
    }
    if (part === ACTION_TARGET_BRANCH_TOKEN) {
      return <TokenChip key={start}>target branch</TokenChip>;
    }
    return <span key={start}>{part}</span>;
  });
}

export function ActionInputDialog({
  open,
  actionTitle,
  actionContent,
  lastInput,
  onCancel,
  onConfirm,
  confirmLabel = 'Run quick command',
}: ActionInputDialogProps) {
  const [input, setInput] = useState('');
  const [wasOpen, setWasOpen] = useState(open);
  const [showPrompt, setShowPrompt] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  // Each open starts empty and collapsed, even where the caller keeps this mounted.
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setInput('');
      setShowPrompt(false);
    }
  }

  useEffect(() => {
    if (!open) return;

    const timer = setTimeout(() => {
      const el = inputRef.current;
      if (el && document.activeElement !== el) {
        el.focus();
        el.select();
      }
    }, 50);

    return () => clearTimeout(timer);
  }, [open]);

  const trimmedInput = input.trim();
  const suggestion = lastInput?.trim() && !input ? lastInput.trim() : null;

  const applySuggestion = () => {
    if (!suggestion) return;
    setInput(suggestion);
    // After React writes the value, so the caret lands at its end.
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(suggestion.length, suggestion.length);
    });
  };
  const contextLine = useMemo(() => getActionInputContextLine(actionContent), [actionContent]);

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) {
          onCancel();
        }
      }}
    >
      <DialogContent
        className="top-[max(3rem,calc(50vh-14rem))] max-h-[calc(100dvh-max(3rem,calc(50vh-14rem))-1rem)] max-w-xl translate-y-0"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          returnFocusRef.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null;
          const el = inputRef.current;
          if (!el) return;
          el.focus();
          el.select();
        }}
        onCloseAutoFocus={(event) => {
          // No DialogTrigger, so Radix would leave focus on the body.
          event.preventDefault();
          const el = returnFocusRef.current;
          returnFocusRef.current = null;
          const active = document.activeElement;
          if (el?.isConnected && (!active || active === document.body)) el.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{actionTitle}</DialogTitle>
          <DialogDescription className="line-clamp-2">
            {contextLine ? (
              <PromptTemplate text={contextLine} input="" />
            ) : (
              'Your text is added to this prompt.'
            )}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-3">
          {/* The input and its prompt toggle share one box, as in a chat composer. */}
          <div className="rounded-md border border-input transition-colors focus-within:border-foreground/30">
            <textarea
              ref={inputRef}
              aria-label={`Text for ${actionTitle}`}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === 'ArrowUp' && suggestion) {
                  e.preventDefault();
                  applySuggestion();
                  return;
                }
                if (e.key !== 'Enter' || e.shiftKey) return;
                e.preventDefault();
                if (trimmedInput) onConfirm(trimmedInput);
              }}
              placeholder="Type or paste here..."
              className="block field-sizing-content max-h-72 min-h-20 w-full resize-none bg-transparent px-3 pt-2.5 text-sm leading-relaxed outline-hidden placeholder:text-muted-foreground/60"
            />
            <div className="flex items-center gap-1 px-2 pt-1 pb-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs text-muted-foreground"
                aria-expanded={showPrompt}
                onClick={() => setShowPrompt((value) => !value)}
              >
                <CaretRight
                  className={cn('mr-1.5 size-3 transition-transform', showPrompt && 'rotate-90')}
                />
                {showPrompt ? 'Hide prompt' : 'Show prompt'}
              </Button>
              {suggestion && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 min-w-0 gap-1.5 px-2 text-xs text-muted-foreground"
                  aria-label={`Use last input: ${suggestion}`}
                  onClick={applySuggestion}
                >
                  <span className="shrink-0">Last:</span>
                  <span className="max-w-48 truncate text-foreground">{suggestion}</span>
                  <Kbd aria-hidden>↑</Kbd>
                </Button>
              )}
              <span className="ml-auto shrink-0 pr-1 text-xs text-muted-foreground/70">
                {formatShortcutForDisplay('Shift+Enter')} for a new line
              </span>
            </div>
          </div>

          {showPrompt && (
            <div className="max-h-56 overflow-auto rounded-md border border-input px-3 py-2.5 text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
              <PromptTemplate text={actionContent} input={trimmedInput} />
            </div>
          )}
        </DialogBody>

        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button disabled={!trimmedInput} onClick={() => onConfirm(trimmedInput)}>
            {confirmLabel}
            <Kbd
              aria-hidden
              className="ml-2 border-primary-foreground/30 bg-primary-foreground/15 text-primary-foreground"
            >
              {formatShortcutForDisplay('Enter')}
            </Kbd>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
