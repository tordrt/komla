import {
  ArrowBendDownLeft,
  CaretDown,
  CaretRight,
  CaretUp,
  Checks,
  X,
} from '@phosphor-icons/react';
import { useEditorState } from '@tiptap/react';
import { useEffect, useRef, useState } from 'react';

import { IconButton } from '@/components/ui/icon-button';
import { cn } from '@/lib/utils';
import { formatShortcutForDisplay } from '@/stores/shortcuts.store';

import {
  closeMarkdownSearch,
  getMarkdownSearch,
  replaceAllMarkdownMatches,
  replaceMarkdownMatch,
  searchMarkdown,
  stepMarkdownSearch,
} from './markdown-search';

import type { Editor } from '@tiptap/core';

/** Each Cmd+F makes a new request, so the bar takes focus again. */
export interface FindRequest {
  id: number;
  /** The selected text to search for, or '' to keep the last search. */
  seed: string;
}

interface MarkdownFindBarProps {
  editor: Editor;
  readOnly: boolean;
  request: FindRequest;
  onClose: () => void;
}

/** Find, and replace, in the rich Markdown editor, like the Source view's Monaco find widget. */
export function MarkdownFindBar({ editor, readOnly, request, onClose }: MarkdownFindBarProps) {
  const barRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState(() => request.seed || getMarkdownSearch(editor)?.query || '');
  const [caseSensitive, setCaseSensitive] = useState(
    () => getMarkdownSearch(editor)?.caseSensitive ?? false
  );
  const [replacing, setReplacing] = useState(false);
  const [replacement, setReplacement] = useState('');
  const [requestId, setRequestId] = useState(request.id);
  if (request.id !== requestId) {
    setRequestId(request.id);
    if (request.seed) setQuery(request.seed);
  }
  const { count, current } = useEditorState({
    editor,
    selector: ({ editor: state }) => {
      const search = getMarkdownSearch(state);
      return { count: search?.matches.length ?? 0, current: search?.current ?? -1 };
    },
  });

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [request.id]);

  useEffect(() => {
    if (editor.isDestroyed) return;
    searchMarkdown(editor, query, caseSensitive);
    revealCurrentMatch(editor, barRef.current);
  }, [editor, query, caseSensitive]);

  useEffect(
    () => () => {
      if (!editor.isDestroyed) closeMarkdownSearch(editor);
    },
    [editor]
  );

  const step = (direction: 1 | -1) => {
    stepMarkdownSearch(editor, direction);
    revealCurrentMatch(editor, barRef.current);
  };

  const replace = () => {
    replaceMarkdownMatch(editor, replacement);
    revealCurrentMatch(editor, barRef.current);
  };

  const handleFindKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
    event.preventDefault();
    step(event.shiftKey ? -1 : 1);
  };

  const handleReplaceKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (event.metaKey || event.ctrlKey) replaceAllMarkdownMatches(editor, replacement);
    else replace();
  };

  const status = query
    ? count === 0
      ? { shown: 'No results', spoken: 'No results' }
      : { shown: `${current + 1}/${count}`, spoken: `Match ${current + 1} of ${count}` }
    : null;
  const canReplace = replacing && !readOnly;

  return (
    <div
      ref={barRef}
      data-markdown-find=""
      className="absolute top-10 right-2 z-10 flex max-w-[calc(100%-1rem)] items-start gap-1 rounded-md border bg-background p-1 shadow-md"
    >
      {!readOnly && (
        <IconButton
          label={replacing ? 'Hide replace' : 'Replace'}
          size="xs"
          tooltipSide="bottom"
          aria-expanded={replacing}
          onClick={() => setReplacing((open) => !open)}
          className="mt-0.5"
        >
          {replacing ? <CaretDown className="size-3.5" /> : <CaretRight className="size-3.5" />}
        </IconButton>
      )}
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex items-center gap-1">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleFindKeyDown}
            placeholder="Find"
            aria-label="Find"
            spellCheck={false}
            className="w-40 min-w-0 shrink rounded bg-muted px-2 py-1 text-sm outline-hidden placeholder:text-muted-foreground focus:ring-1 focus:ring-primary/50"
          />
          {status && (
            <span
              role="status"
              className={cn(
                'shrink-0 px-1 text-2xs tabular-nums',
                count === 0 ? 'text-error' : 'text-muted-foreground'
              )}
            >
              <span aria-hidden>{status.shown}</span>
              <span className="sr-only">{status.spoken}</span>
            </span>
          )}
          <IconButton
            label="Match case"
            size="xs"
            tooltipSide="bottom"
            aria-pressed={caseSensitive}
            onClick={() => {
              setCaseSensitive((matchCase) => !matchCase);
              inputRef.current?.focus();
            }}
            className={cn('text-2xs font-semibold', caseSensitive && 'bg-accent text-foreground')}
          >
            Aa
          </IconButton>
          <IconButton
            label="Previous match"
            shortcut="Shift+Enter"
            size="xs"
            tooltipSide="bottom"
            disabled={count === 0}
            onClick={() => step(-1)}
          >
            <CaretUp className="size-4" />
          </IconButton>
          <IconButton
            label="Next match"
            shortcut="Enter"
            size="xs"
            tooltipSide="bottom"
            disabled={count === 0}
            onClick={() => step(1)}
          >
            <CaretDown className="size-4" />
          </IconButton>
          <IconButton
            label="Close find"
            shortcut="Escape"
            size="xs"
            tooltipSide="bottom"
            onClick={onClose}
          >
            <X className="size-4" />
          </IconButton>
        </div>
        {canReplace && (
          <div className="flex items-center gap-1">
            <input
              type="text"
              value={replacement}
              onChange={(event) => setReplacement(event.target.value)}
              onKeyDown={handleReplaceKeyDown}
              placeholder="Replace"
              aria-label="Replace"
              spellCheck={false}
              className="w-40 min-w-0 shrink rounded bg-muted px-2 py-1 text-sm outline-hidden placeholder:text-muted-foreground focus:ring-1 focus:ring-primary/50"
            />
            <IconButton
              label="Replace"
              shortcut="Enter"
              size="xs"
              tooltipSide="bottom"
              disabled={count === 0}
              onClick={replace}
            >
              <ArrowBendDownLeft className="size-4" />
            </IconButton>
            <IconButton
              label="Replace all"
              shortcut={formatShortcutForDisplay('Cmd+Enter')}
              size="xs"
              tooltipSide="bottom"
              disabled={count === 0}
              onClick={() => replaceAllMarkdownMatches(editor, replacement)}
            >
              <Checks className="size-4" />
            </IconButton>
          </div>
        )}
      </div>
    </div>
  );
}

/** Scrolls the current match into view, a third of the way down, when it's off screen or under the bar. */
function revealCurrentMatch(editor: Editor, bar: HTMLElement | null): void {
  const search = getMarkdownSearch(editor);
  const match = search?.matches[search.current];
  const scroller = editor.view.dom.closest('[data-markdown-scroller]');
  if (!match || !(scroller instanceof HTMLElement)) return;
  const viewport = scroller.getBoundingClientRect();
  const { top, bottom } = editor.view.coordsAtPos(match.from);
  const visibleTop = Math.max(viewport.top, bar?.getBoundingClientRect().bottom ?? 0);
  if (top >= visibleTop && bottom <= viewport.bottom) return;
  scroller.scrollTop += top - viewport.top - viewport.height / 3;
}
