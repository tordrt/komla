import { Code, TextAa } from '@phosphor-icons/react';
import React, { Suspense, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { ErrorBoundary } from '@/components/ErrorBoundary';
import { usePaneDragBar } from '@/components/terminal/PaneDragGrip';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Spinner } from '@/components/ui/spinner';
import { useEditorSurfaceBackground } from '@/lib/palette-runtime';
import { claimShortcutEvent } from '@/lib/shortcut-claims';
import { cn } from '@/lib/utils';
import { formatShortcutForDisplay } from '@/stores/shortcuts.store';

import {
  getMarkdownViewMode,
  RICH_MARKDOWN_MAX_LENGTH,
  setMarkdownViewMode,
  subscribeMarkdownViewMode,
} from './markdown-view-mode';

import type { MarkdownViewMode } from './markdown-view-mode';
import type { MarkdownEditorHandle } from './RichMarkdownEditor';

const RichMarkdownEditor = React.lazy(() =>
  import('./RichMarkdownEditor').then((m) => ({ default: m.RichMarkdownEditor }))
);

const TOGGLE_SHORTCUT = 'Cmd+/';

interface MarkdownContentAreaProps {
  filePath: string;
  fileContent: string | null;
  /** The file's text as last loaded or saved. */
  savedContent?: string | null;
  loadingFile: boolean;
  fileError: string | null;
  readOnly: boolean;
  /** Blame needs the source editor's gutter. */
  sourceOnly: boolean;
  onChange?: (content: string) => void;
  onMarkdownEditorMount?: (handle: MarkdownEditorHandle | null) => void;
  readImage: (path: string) => Promise<{ data: string; mimeType: string }>;
  /** The Monaco editor for Source mode. */
  sourceEditor: React.ReactNode;
  /** Buttons shown before the view toggle. */
  actions?: React.ReactNode;
  /** Buttons shown after the view toggle, at the end of the row. */
  trailingActions?: React.ReactNode;
  /** Focuses the editor when it first shows. */
  autoFocus?: boolean;
}

/**
 * Whether the file's text is there to show. Once it has shown, a reload from
 * disk (an agent's edit) keeps the editor, which updates in place.
 */
function useContentReady(
  fileContent: string | null,
  loadingFile: boolean,
  fileError: string | null
): boolean {
  const [shown, setShown] = useState(false);
  const ready = fileContent !== null && !fileError && (!loadingFile || shown);
  if (ready && !shown) setShown(true);
  return ready;
}

/** A Markdown file in the file viewer: rich text by default, its source on request. */
export function MarkdownContentArea({
  filePath,
  fileContent,
  savedContent,
  loadingFile,
  fileError,
  readOnly,
  sourceOnly,
  onChange,
  onMarkdownEditorMount,
  readImage,
  sourceEditor,
  actions,
  trailingActions,
  autoFocus = false,
}: MarkdownContentAreaProps) {
  const preferredMode = useSyncExternalStore(
    subscribeMarkdownViewMode,
    getMarkdownViewMode,
    getMarkdownViewMode
  );
  const containerRef = useRef<HTMLDivElement>(null);
  // Set when the toggle here switched views, so focus follows into the new editor.
  const [focusNewView, setFocusNewView] = useState(autoFocus);
  const background = useEditorSurfaceBackground();
  // In a pane, the header's empty space drags the pane, as the Rich editor's toolbar does.
  const dragBar = usePaneDragBar();
  const ready = useContentReady(fileContent, loadingFile, fileError);
  const tooLarge = (fileContent?.length ?? 0) > RICH_MARKDOWN_MAX_LENGTH;
  const richUnavailable = sourceOnly
    ? 'Rich text is off while blame is shown'
    : tooLarge
      ? 'Too large to edit as rich text'
      : null;
  const mode: MarkdownViewMode = preferredMode === 'rich' && !richUnavailable ? 'rich' : 'source';
  const shortcut = formatShortcutForDisplay(TOGGLE_SHORTCUT, window.api?.platform);

  const switchTo = (next: MarkdownViewMode) => {
    if (next !== mode) setFocusNewView(true);
    setMarkdownViewMode(next);
  };

  // Monaco mounts after its chunk loads and stays hidden until ready, so keep trying.
  useEffect(() => {
    const container = containerRef.current;
    if (!focusNewView || mode !== 'source' || !container) return;
    const focusSource = () => {
      const input = container.querySelector<HTMLElement>('.monaco-editor textarea');
      input?.focus();
      return !!input && document.activeElement === input;
    };
    if (focusSource()) return;
    const observer = new MutationObserver(() => {
      if (focusSource()) observer.disconnect();
    });
    observer.observe(container, { attributes: true, childList: true, subtree: true });
    return () => observer.disconnect();
  }, [focusNewView, mode]);

  const toggle = (
    <SegmentedControl
      aria-label="Markdown view"
      iconOnly
      value={mode}
      onValueChange={switchTo}
      options={[
        {
          value: 'rich',
          label: 'Rich text',
          icon: <TextAa className="size-3.5" />,
          disabled: !!richUnavailable,
          title: richUnavailable ?? undefined,
          shortcut,
        },
        { value: 'source', label: 'Source', icon: <Code className="size-3.5" />, shortcut },
      ]}
    />
  );
  const toolbarEnd =
    actions || trailingActions ? (
      <div className="flex shrink-0 items-center gap-1">
        {actions}
        {toggle}
        {trailingActions}
      </div>
    ) : (
      toggle
    );

  const header = (
    <div
      className={cn(
        'flex h-8 shrink-0 items-center justify-between gap-2 border-b border-border px-2',
        dragBar && 'cursor-grab active:cursor-grabbing'
      )}
      {...dragBar}
    >
      <span className="truncate text-xs font-medium text-muted-foreground">
        {richUnavailable && preferredMode === 'rich' ? richUnavailable : 'Markdown'}
      </span>
      {toolbarEnd}
    </div>
  );

  return (
    <div
      ref={containerRef}
      // The Source header and the loading page sit on the Rich editor's color, so the toolbar row
      // keeps one color across modes.
      className="flex min-h-0 flex-1 flex-col"
      style={{ backgroundColor: background }}
      onKeyDownCapture={(event) => {
        // Matched by the character, so it also works where / needs Shift.
        if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key === '/') {
          event.preventDefault();
          event.stopPropagation();
          claimShortcutEvent(event.nativeEvent);
          if (!richUnavailable) switchTo(mode === 'rich' ? 'source' : 'rich');
        }
      }}
    >
      {mode === 'rich' && ready && fileContent !== null ? (
        <ErrorBoundary
          key={`markdown:${filePath}`}
          // Keeps the header, whose toggle switches to Source and whose buttons still work.
          fallback={(error) => (
            <>
              {header}
              <div className="flex flex-1 items-center justify-center p-4 text-center text-sm text-muted-foreground">
                Couldn't show this file as rich text: {error.message}
              </div>
            </>
          )}
        >
          <Suspense
            fallback={
              <>
                {header}
                <div className="flex flex-1 items-center justify-center text-muted-foreground">
                  <Spinner size="lg" className="size-5" />
                </div>
              </>
            }
          >
            <RichMarkdownEditor
              ref={onMarkdownEditorMount}
              filePath={filePath}
              content={fileContent}
              savedContent={savedContent}
              readOnly={readOnly}
              onChange={onChange}
              readImage={readImage}
              autoFocus={focusNewView}
              toolbarEnd={toolbarEnd}
            />
          </Suspense>
        </ErrorBoundary>
      ) : (
        <>
          {header}
          {sourceEditor}
        </>
      )}
    </div>
  );
}
