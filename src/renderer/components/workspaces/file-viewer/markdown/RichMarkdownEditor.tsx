import { Placeholder } from '@tiptap/extensions';
import { Selection } from '@tiptap/pm/state';
import { EditorContent, useEditor } from '@tiptap/react';
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import {
  ensureMonacoInitialized,
  subscribeKomlaEditorTheme,
  subscribeShikiLanguageLoads,
} from '@/lib/monaco-loader';
import { forwardAppShortcut } from '@/lib/monaco-shortcut-forwarding';
import { useEditorSurfaceBackground } from '@/lib/palette-runtime';
import { claimShortcutEvent } from '@/lib/shortcut-claims';
import { cn } from '@/lib/utils';
import { formatShortcutForDisplay } from '@/stores/shortcuts.store';

import { MarkdownClipboard } from './markdown-clipboard';
import { codeHighlightKey, MarkdownCodeHighlight } from './markdown-code-highlight';
import { MarkdownCodec } from './markdown-codec';
import { createMarkdownExtensions } from './markdown-extensions';
import { createImageNodeView, resolveMarkdownImagePath } from './markdown-image-view';
import { findHeading, resolveMarkdownLink } from './markdown-links';
import { INLINE_NODE, MarkdownSearch } from './markdown-search';
import { MarkdownSlashCommands } from './markdown-slash-commands';
import { MarkdownSoftBreaks } from './markdown-soft-breaks';
import { isPrimaryClick, MarkdownContextMenu } from './MarkdownContextMenu';
import { MarkdownFindBar } from './MarkdownFindBar';
import { MarkdownSlashMenu } from './MarkdownSlashMenu';
import { MarkdownToolbar } from './MarkdownToolbar';

import type { MarkdownSnapshot } from './markdown-codec';
import type { MarkdownFileLinks } from './markdown-links';
import type { SlashMenuState } from './markdown-slash-commands';
import type { FindRequest } from './MarkdownFindBar';
import type { Editor } from '@tiptap/core';
import type { EditorView } from '@tiptap/pm/view';
import type { UseEditorOptions } from '@tiptap/react';

/** What the file viewer reads from the rich editor in place of Monaco. */
export interface MarkdownEditorHandle {
  /** The file text as it would be saved now. */
  getMarkdown: () => string;
  /** Scrolls to the block that starts at or before a line of the loaded file. */
  revealLine: (line: number) => void;
}

interface RichMarkdownEditorProps {
  filePath: string;
  content: string;
  /**
   * The file's text as last loaded or saved. While the last report matches it,
   * edits report at once, so the file never reads as saved with edits held back.
   */
  savedContent?: string | null;
  readOnly: boolean;
  onChange?: (content: string) => void;
  readImage: (path: string) => Promise<{ data: string; mimeType: string }>;
  /** Opens the workspace files links point to. Without it, links to files don't open. */
  fileLinks?: MarkdownFileLinks;
  autoFocus?: boolean;
  /** Moves keyboard focus into the editor, then calls onFocused. */
  focusRequested?: boolean;
  onFocused?: () => void;
  /** Rendered at the end of the toolbar. */
  toolbarEnd?: React.ReactNode;
  ref?: React.Ref<MarkdownEditorHandle>;
}

/** After an edit is reported, later edits within this window are reported together. */
const CHANGE_BATCH_MS = 150;

let sharedCodec: MarkdownCodec | null = null;
function getCodec(): MarkdownCodec {
  sharedCodec ??= new MarkdownCodec();
  return sharedCodec;
}

/** WYSIWYG editing of a Markdown file that saves untouched parts of the file unchanged. */
export function RichMarkdownEditor({
  filePath,
  content,
  savedContent,
  readOnly,
  onChange,
  readImage,
  fileLinks,
  autoFocus = false,
  focusRequested = false,
  onFocused,
  toolbarEnd,
  ref,
}: RichMarkdownEditorProps) {
  const codec = getCodec();
  // Later content arrives through the reload effect below.
  const [initial] = useState(() => codec.load(content));
  // Where the focus was as the editor began to open, for an editor opened to take it.
  const [focusedAtOpen] = useState(() => document.activeElement);
  const snapshotRef = useRef<MarkdownSnapshot>(initial.snapshot);
  const lastReportedRef = useRef(content);
  // Reports the file viewer may not have rendered back yet, so they aren't mistaken for disk changes.
  const unconfirmedReportsRef = useRef(new Set<string>());
  const batchTimerRef = useRef<number | null>(null);
  const pendingRef = useRef(false);
  const onChangeRef = useRef(onChange);
  const savedContentRef = useRef(savedContent);
  const readImageRef = useRef(readImage);
  const fileLinksRef = useRef(fileLinks);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [slashMenu, setSlashMenu] = useState<SlashMenuState | null>(null);
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const background = useEditorSurfaceBackground();
  const [findRequest, setFindRequest] = useState<FindRequest | null>(null);

  useLayoutEffect(() => {
    onChangeRef.current = onChange;
    savedContentRef.current = savedContent;
    readImageRef.current = readImage;
    fileLinksRef.current = fileLinks;
  });

  const report = useCallback(
    (editor: Editor) => {
      pendingRef.current = false;
      const markdown = codec.serialize(snapshotRef.current, editor.state.doc);
      if (markdown === lastReportedRef.current) return;
      lastReportedRef.current = markdown;
      unconfirmedReportsRef.current.add(markdown);
      onChangeRef.current?.(markdown);
    },
    [codec]
  );

  // Report the first edit at once so the file reads as unsaved right away, then batch.
  const handleUpdate = useCallback(
    (editor: Editor) => {
      if (batchTimerRef.current !== null && lastReportedRef.current !== savedContentRef.current) {
        pendingRef.current = true;
        return;
      }
      report(editor);
      if (batchTimerRef.current !== null) return;
      batchTimerRef.current = window.setTimeout(() => {
        batchTimerRef.current = null;
        if (pendingRef.current) report(editor);
      }, CHANGE_BATCH_MS);
    },
    [report]
  );

  const flush = useCallback(
    (editor: Editor) => {
      if (batchTimerRef.current !== null) {
        window.clearTimeout(batchTimerRef.current);
        batchTimerRef.current = null;
      }
      if (pendingRef.current) report(editor);
    },
    [report]
  );

  const [options] = useState<UseEditorOptions>(() => ({
    extensions: createMarkdownExtensions({
      imageNodeView: createImageNodeView(async (src) => {
        if (/^data:image\//i.test(src)) return src;
        const path = resolveMarkdownImagePath(filePath, src);
        if (!path) return null;
        const image = await readImageRef.current(path);
        return `data:${image.mimeType};base64,${image.data}`;
      }),
      extra: [
        Placeholder.configure({ placeholder: 'Write, or type / for blocks' }),
        MarkdownCodeHighlight,
        MarkdownSoftBreaks,
        MarkdownClipboard.configure({ codec }),
        MarkdownSlashCommands.configure({ onChange: setSlashMenu }),
        MarkdownSearch,
      ],
    }),
    content: initial.doc,
    editable: !readOnly,
    // TipTap's own autofocus lands a frame or two after the editor is created, whatever the user
    // did meanwhile: the address of the browser Setup opened beside a new note lost what was
    // typed into it. The focus waits as TipTap's does, and is left where the user typed since.
    onCreate: ({ editor }) => {
      if (!autoFocus) return;
      requestAnimationFrame(() => {
        if (editor.isDestroyed || typingElsewhere(editor.view.dom, focusedAtOpen)) return;
        editor.view.dispatch(editor.state.tr.setSelection(Selection.atStart(editor.state.doc)));
        editor.view.focus();
      });
    },
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: {
        class: 'markdown-preview markdown-editor mx-auto min-h-full max-w-3xl px-8 py-6',
        'aria-label': 'Markdown editor',
      },
      handleClick: (view, _position, event) =>
        openClickedLink(view, event, filePath, fileLinksRef.current),
      handleDOMEvents: {
        // Links open only through handleClick. Followed by the page, a link would open a web
        // page a second time, and a relative one as a page that isn't there.
        click: (_view, event) => {
          if (event.target instanceof Element && event.target.closest('a[href]')) {
            event.preventDefault();
          }
          return false;
        },
      },
    },
    onUpdate: ({ editor }) => handleUpdate(editor),
    onBlur: ({ editor }) => flush(editor),
  }));
  const editor = useEditor(options, []);

  useEffect(() => {
    editor.setEditable(!readOnly, false);
  }, [editor, readOnly]);

  const notifyFocused = useEffectEvent(() => onFocused?.());
  useEffect(() => {
    if (!focusRequested) return;
    // At the selection it had, where the note was left scrolled.
    editor.commands.focus(null, { scrollIntoView: false });
    // TipTap focuses on the next frame; a focus that didn't land leaves the request to lapse.
    const frame = requestAnimationFrame(() => {
      if (!editor.isDestroyed && editor.view.hasFocus()) notifyFocused();
    });
    return () => cancelAnimationFrame(frame);
  }, [editor, focusRequested]);

  // Code blocks color once Monaco's highlighter and their grammar are ready, and again when
  // the theme changes.
  useEffect(() => {
    const recolor = () => {
      if (!editor.isDestroyed) {
        editor.view.dispatch(editor.state.tr.setMeta(codeHighlightKey, true));
      }
    };
    void ensureMonacoInitialized().then(recolor, () => {});
    const unsubscribeTheme = subscribeKomlaEditorTheme(recolor);
    const unsubscribeLanguages = subscribeShikiLanguageLoads(recolor);
    return () => {
      unsubscribeTheme();
      unsubscribeLanguages();
    };
  }, [editor]);

  // The file changed on disk (an agent edited it) while there were no unsaved edits.
  useEffect(() => {
    const unconfirmed = unconfirmedReportsRef.current;
    if (content === lastReportedRef.current) {
      unconfirmed.clear();
      return;
    }
    if (unconfirmed.has(content) || editor.isDestroyed) return;
    const loaded = codec.load(content);
    snapshotRef.current = loaded.snapshot;
    lastReportedRef.current = content;
    const { from } = editor.state.selection;
    editor
      .chain()
      .command(({ tr }) => {
        // Undo shouldn't bring back what the file said before it changed on disk.
        tr.setMeta('addToHistory', false);
        return true;
      })
      .setContent(loaded.doc, { emitUpdate: false })
      .setTextSelection(from)
      .run();
  }, [codec, content, editor]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    // Formatting keys like Cmd+B shouldn't also run the app shortcuts on the same keys,
    // and the app shortcuts code editors pass on, such as New note, work here too.
    const claimHandledShortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented) {
        if (event.metaKey || event.ctrlKey) claimShortcutEvent(event);
      } else if (forwardAppShortcut(event)) {
        event.preventDefault();
      }
    };
    // A click in the margin below the text puts the cursor at the end.
    const focusEnd = (event: MouseEvent) => {
      if (!isPrimaryClick(event) || event.target !== scroller || !editor.isEditable) return;
      event.preventDefault();
      editor.commands.focus('end');
    };
    scroller.addEventListener('keydown', claimHandledShortcut);
    scroller.addEventListener('mousedown', focusEnd);
    return () => {
      scroller.removeEventListener('keydown', claimHandledShortcut);
      scroller.removeEventListener('mousedown', focusEnd);
    };
  }, [editor]);

  // While editing, a link says how to open it, and shows as clickable while the key is held.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const hint = `${formatShortcutForDisplay('Cmd+Click', window.api?.platform)} to open`;
    const syncModifier = (event: KeyboardEvent | MouseEvent) => {
      scroller.toggleAttribute('data-link-modifier', isLinkModifier(event));
    };
    const clearModifier = () => scroller.removeAttribute('data-link-modifier');
    // On the scroller, outside the editor's own DOM, which would read a change as an edit.
    const syncHint = (event: MouseEvent) => {
      syncModifier(event);
      const link = clickedLink(event);
      if (
        link &&
        editor.isEditable &&
        linkTarget(editor.view, link, filePath, fileLinksRef.current)
      ) {
        scroller.title = hint;
      } else {
        scroller.removeAttribute('title');
      }
    };
    window.addEventListener('keydown', syncModifier);
    window.addEventListener('keyup', syncModifier);
    window.addEventListener('blur', clearModifier);
    scroller.addEventListener('mouseover', syncHint);
    return () => {
      window.removeEventListener('keydown', syncModifier);
      window.removeEventListener('keyup', syncModifier);
      window.removeEventListener('blur', clearModifier);
      scroller.removeEventListener('mouseover', syncHint);
    };
  }, [editor, filePath]);

  // Cmd+F opens the find bar from anywhere in the editor, the toolbar and the bar included.
  useEffect(() => {
    if (!container) return;
    const openFind = (event: KeyboardEvent) => {
      if (!isFindShortcut(event)) return;
      event.preventDefault();
      claimShortcutEvent(event);
      // In the bar, the selection is the current match, which would replace what was typed.
      const inBar = event.target instanceof Element && event.target.closest('[data-markdown-find]');
      const seed = inBar ? '' : selectionSearchSeed(editor);
      setFindRequest((request) => ({ id: (request?.id ?? 0) + 1, seed }));
    };
    container.addEventListener('keydown', openFind);
    return () => container.removeEventListener('keydown', openFind);
  }, [container, editor]);

  const closeFind = useCallback(() => {
    setFindRequest(null);
    // The cursor stays on the match it was at. A read-only editor can't take focus, so its
    // scroller does, or Cmd+F and Escape would no longer reach the editor.
    if (editor.isEditable) editor.commands.focus();
    else scrollerRef.current?.focus();
  }, [editor]);

  // While the bar is open, Escape anywhere in the editor closes it, as in the Source view.
  const findOpen = findRequest !== null;
  const closeFindOnEscape = useEffectEvent((event: KeyboardEvent) => {
    // The slash menu closes first, and Escape that ends an IME composition belongs to the input.
    // Not defaultPrevented: the file viewer's dialog prevents every Escape before it gets here.
    if (event.key !== 'Escape' || event.isComposing || slashMenu) return;
    event.preventDefault();
    // The file viewer would close on it too.
    event.stopPropagation();
    closeFind();
  });
  useEffect(() => {
    if (!container || !findOpen) return;
    const onKeyDown = (event: KeyboardEvent) => closeFindOnEscape(event);
    // In the capture phase, so the slash menu is still open when Escape is for it.
    container.addEventListener('keydown', onKeyDown, true);
    return () => container.removeEventListener('keydown', onKeyDown, true);
  }, [container, findOpen]);

  useImperativeHandle(
    ref,
    () => ({
      getMarkdown: () => {
        flush(editor);
        return lastReportedRef.current;
      },
      revealLine: (line) => revealLine(editor, snapshotRef.current, line),
    }),
    [editor, flush]
  );

  // Report the last edits before Source mode or another file takes over.
  useEffect(() => () => flush(editor), [editor, flush]);

  return (
    <div
      ref={setContainer}
      data-markdown-find-open={findOpen ? '' : undefined}
      className="relative flex min-h-0 flex-1 flex-col"
      style={{ backgroundColor: background }}
    >
      <MarkdownToolbar editor={editor} readOnly={readOnly}>
        {toolbarEnd}
      </MarkdownToolbar>
      {/* Focusable so Cmd+F reaches the editor when it's read-only and can't take focus itself. */}
      <MarkdownContextMenu editor={editor} readOnly={readOnly} scrollerRef={scrollerRef}>
        <div
          ref={scrollerRef}
          tabIndex={readOnly ? -1 : undefined}
          data-markdown-scroller=""
          className={cn(
            'min-h-0 flex-1 overflow-auto outline-hidden',
            readOnly && 'cursor-default'
          )}
        >
          <EditorContent editor={editor} className="min-h-full" />
        </div>
      </MarkdownContextMenu>
      {findRequest && (
        <MarkdownFindBar
          editor={editor}
          readOnly={readOnly}
          request={findRequest}
          onClose={closeFind}
        />
      )}
      {slashMenu && <MarkdownSlashMenu menu={slashMenu} container={container} />}
    </div>
  );
}

/**
 * Whether the focus went to a field outside the editor since `focusedBefore`. A menu handing
 * the focus back to its trigger as it closes is not typing, so the editor still takes it then.
 */
function typingElsewhere(editorDom: HTMLElement, focusedBefore: Element | null): boolean {
  const active = document.activeElement;
  if (!active || active === focusedBefore || editorDom.contains(active)) return false;
  return (
    active instanceof HTMLInputElement ||
    active instanceof HTMLTextAreaElement ||
    (active instanceof HTMLElement && active.isContentEditable)
  );
}

/** The selected text, or '' when it spans lines or has an image in it, which a search can't match. */
function selectionSearchSeed(editor: Editor): string {
  const { from, to } = editor.state.selection;
  const selected = editor.state.doc.textBetween(from, to, '\n', INLINE_NODE);
  return selected.includes('\n') || selected.includes(INLINE_NODE) ? '' : selected;
}

function isFindShortcut(event: KeyboardEvent): boolean {
  const mod = window.api?.platform === 'darwin' ? event.metaKey : event.ctrlKey;
  return mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f';
}

/**
 * The key a click opens a link with while editing: Cmd on macOS, where Ctrl+click is a
 * right-click, and Ctrl elsewhere, where the Windows or Super key belongs to the system.
 */
function isLinkModifier(event: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return window.api?.platform === 'darwin' ? event.metaKey : event.ctrlKey;
}

function clickedLink(event: MouseEvent): Element | null {
  return event.target instanceof Element ? event.target.closest('a[href]') : null;
}

type LinkTarget =
  | { kind: 'web'; url: string }
  | { kind: 'heading'; position: number }
  | { kind: 'file'; path: string };

/** Where a link goes, when it can open there: a file only where the host shows it. */
function linkTarget(
  view: EditorView,
  link: Element,
  filePath: string,
  fileLinks: MarkdownFileLinks | undefined
): LinkTarget | null {
  const target = resolveMarkdownLink(filePath, link.getAttribute('href') ?? '');
  if (target?.kind === 'file') return fileLinks?.canOpen(target.path) ? target : null;
  if (target?.kind !== 'heading') return target;
  const position = findHeading(view.state.doc, target.slug);
  return position === null ? null : { kind: 'heading', position };
}

/**
 * Links open with Cmd/Ctrl+click while editing, or a plain click when read-only. A link that
 * can't open is left to the editor, which puts the cursor in it.
 */
function openClickedLink(
  view: EditorView,
  event: MouseEvent,
  filePath: string,
  fileLinks: MarkdownFileLinks | undefined
): boolean {
  const link = clickedLink(event);
  if (!link || !isPrimaryClick(event) || (view.editable && !isLinkModifier(event))) return false;
  const target = linkTarget(view, link, filePath, fileLinks);
  if (target?.kind === 'web') void window.api.openExternal(target.url);
  else if (target?.kind === 'file') fileLinks?.open(target.path);
  else if (target?.kind === 'heading') revealPosition(view, target.position, 'start');
  return target !== null;
}

function revealLine(editor: Editor, snapshot: MarkdownSnapshot, line: number): void {
  if (editor.isDestroyed) return;
  let index = 0;
  snapshot.nodeLines.forEach((start, nodeIndex) => {
    if (start <= line) index = nodeIndex;
  });
  const { doc } = editor.state;
  index = Math.min(index, doc.childCount - 1);
  let position = 0;
  for (let child = 0; child < index; child++) position += doc.child(child).nodeSize;
  editor.commands.focus();
  revealPosition(editor.view, position, 'center');
}

/** Puts the cursor in the block at `position` and scrolls it into view. */
function revealPosition(view: EditorView, position: number, block: ScrollLogicalPosition): void {
  const { tr } = view.state;
  view.dispatch(tr.setSelection(Selection.near(tr.doc.resolve(position))));
  const element = view.nodeDOM(position);
  if (element instanceof HTMLElement) element.scrollIntoView({ block });
}
