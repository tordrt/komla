import {
  ArrowLeft,
  ArrowUp,
  CaretLeft,
  CaretRight,
  Code,
  Copy,
  DownloadSimple,
  Eye,
  File,
  Folder,
  FolderOpen,
  MagnifyingGlass,
  SidebarSimple,
  TerminalWindow,
} from '@phosphor-icons/react';
import {
  createContext,
  lazy,
  Suspense,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from 'react';

import { ErrorBoundary } from '@/components/ErrorBoundary';
import { LinuxWindowControlsEnd } from '@/components/layout/LinuxWindowControls';
import { useTopRowStyle } from '@/components/layout/title-bar-metrics';
import { PromptDraftButton, PromptDraftOutlet } from '@/components/prompt-draft/PromptDraft';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { IconButton } from '@/components/ui/icon-button';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Spinner } from '@/components/ui/spinner';
import { BrowserPreviewFrame } from '@/components/workspaces/file-viewer/BrowserPreviewFrame';
import { FileTypeIcon } from '@/components/workspaces/file-viewer/file-icon-utils';
import { getSidebarToggleShortcutLabel } from '@/components/workspaces/file-viewer/file-viewer-keyboard';
import { formatFileReference } from '@/components/workspaces/file-viewer/file-viewer-utils';
import { ImagePane } from '@/components/workspaces/file-viewer/ImagePane';
import { MarkdownPreview } from '@/components/workspaces/file-viewer/MarkdownPreview';
import { formatFileSize, MediaPane } from '@/components/workspaces/file-viewer/MediaPane';
import { downloadViewerFile, isOnSshHost } from '@/lib/download-viewer-file';
import { getFocusedPromptTerminalId } from '@/lib/focused-terminal';
import { formatRelativeTime } from '@/lib/format-time';
import { ensureMonacoInitialized } from '@/lib/monaco-loader';
import { useEditorSurfaceBackground } from '@/lib/palette-runtime';
import { getRevealInFileManagerLabel } from '@/lib/platform-labels';
import { isInPromptDraft } from '@/lib/prompt-draft';
import { claimShortcutEvent } from '@/lib/shortcut-claims';
import { focusTerminalRenderer } from '@/lib/terminal-renderer-runtime';
import { cn } from '@/lib/utils';
import { useFileViewerStore } from '@/stores/file-viewer.store';
import { useLayoutStore } from '@/stores/layout.store';
import {
  canStepQuickLook,
  isQuickLookFolder,
  quickLookFullPath,
  quickLookItemKey,
  quickLookReferencePath,
  quickLookSidebar,
  useQuickLookStore,
  type QuickLookFolderSection,
  type QuickLookItem,
  type QuickLookListed,
  type QuickLookSession,
} from '@/stores/quick-look.store';
import { formatShortcutForDisplay } from '@/stores/shortcuts.store';
import { useToastStore } from '@/stores/toast.store';
import { useViewedFile } from '@/stores/viewed-file.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';

import { getViewableFileKind, type ViewableFileKind } from '../../../shared/image-utils';

import { openInFilePanel } from './file-panel';
import { PaneOutline } from './PaneOutline';
import { rememberTerminalFiles, useTerminalFileViewerItems } from './terminal-files';

import type { ViewerFile, ViewerFileSource } from '../../../shared/types/viewer-file';
import type { editor as monacoEditor } from 'monaco-editor';

// The editor needs Monaco set up first, as the file panel does when it opens.
const EditorPane = lazy(async () => {
  const [{ EditorPane: Pane }] = await Promise.all([
    import('@/components/workspaces/file-viewer/EditorPane'),
    ensureMonacoInitialized(),
  ]);
  return { default: Pane };
});

type ViewMode = 'preview' | 'source';

const VIEW_MODE_OPTIONS = [
  { value: 'preview', label: 'Preview', icon: <Eye className="size-3.5" /> },
  { value: 'source', label: 'Source', icon: <Code className="size-3.5" /> },
] as const;

/** The arrows step through the files: left and up to the one above in the sidebar. */
const STEP_KEYS = new Map<string, -1 | 1>([
  ['ArrowLeft', -1],
  ['ArrowUp', -1],
  ['ArrowRight', 1],
  ['ArrowDown', 1],
]);

const STEP_BUTTON_CLASS =
  'absolute top-1/2 -translate-y-1/2 rounded-full border border-foreground/10 bg-background/80 text-foreground shadow-lg backdrop-blur-sm transition-opacity hover:bg-background opacity-0 group-hover/body:opacity-100 focus-visible:opacity-100';

/** The source editor on screen and the file in it, for the lines selected there. */
interface ShownEditor {
  item: QuickLookItem;
  editor: monacoEditor.ICodeEditor;
}

type ShownEditorRef = RefObject<ShownEditor | null>;

/** Puts a reference to a file into a terminal's prompt, then goes back to that terminal. */
type InsertInTerminal = (terminalId: string, reference: string) => void;

/** The terminal behind the viewer, where the user was working, which references can go into. */
interface ReferenceTarget {
  terminalId: string | null;
  insert: InsertInTerminal;
}

const ReferenceTargetContext = createContext<ReferenceTarget>({
  terminalId: null,
  insert: () => {},
});

/**
 * How an agent prompt refers to an item: `@` and its path, with the lines selected in its source,
 * as the file panel's Copy @path gives them.
 */
function referenceTo(item: QuickLookItem, shown: ShownEditor | null): string {
  return formatFileReference(
    quickLookReferencePath(item),
    shown?.item === item ? shown.editor : null
  );
}

function copyText(text: string, shown = text) {
  window.api.copyToClipboard(text);
  useToastStore.getState().addToast(`Copied ${shown}`, 'success');
}

/** With a trailing space, so the paste is ready for the rest of the prompt. */
function copyReference(reference: string) {
  copyText(`${reference} `, reference);
}

function getCopyReferenceShortcutLabel(): string {
  return formatShortcutForDisplay('Cmd+Shift+C', window.api?.platform);
}

type Pending = { status: 'loading' } | { status: 'error'; message: string };
type Loaded<T> = Pending | { status: 'loaded'; value: T };

type ViewerRequest<T> = (
  workspaceId: string,
  terminalId: string,
  source: ViewerFileSource
) => Promise<T>;

const readFile: ViewerRequest<ViewerFile> = (workspaceId, terminalId, source) =>
  window.api.readViewerFile(workspaceId, terminalId, source);
const getPreviewUrl: ViewerRequest<string> = (workspaceId, terminalId, source) =>
  window.api.getViewerPreviewUrl(workspaceId, terminalId, source);

/** Shows the files and folders terminal links point to, one at a time, without copying them. */
export function QuickLookDialog() {
  const session = useQuickLookStore((s) => s.session);
  const step = useQuickLookStore((s) => s.step);
  const close = useQuickLookStore((s) => s.close);
  const toggleSidebar = useQuickLookStore((s) => s.toggleSidebar);
  const contentRef = useRef<HTMLDivElement>(null);
  const shownEditor = useRef<ShownEditor | null>(null);
  // The terminal a reference went into, which takes focus once the viewer closes.
  const returnToTerminal = useRef<string | null>(null);
  const isOpen = session !== null;
  const listed = useTerminalFileViewerItems(session?.workspaceId ?? '');
  // The full file viewer covers the terminals, which a reference would go into out of sight.
  const fileViewerCovers = useFileViewerStore(
    (s) => session !== null && s.fileViewerWorkspaceId === session.workspaceId
  );
  // Read again as panes close or take focus while the viewer is open.
  const focusedTerminalId = useLayoutStore(() =>
    session ? getFocusedPromptTerminalId(session.workspaceId) : null
  );

  const insertInTerminal: InsertInTerminal = (terminalId, reference) => {
    window.api.sendInput(terminalId, `${reference} `);
    returnToTerminal.current = terminalId;
    close();
  };

  // On the window, so the arrows still work after the last file disables the button in focus,
  // and claimed while capturing, before the file viewer behind moves through its own list.
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const delta = STEP_KEYS.get(event.key);
      // With a modifier, an arrow is another shortcut, such as Cmd+Up for the previous workspace.
      if (delta === undefined || hasModifier(event)) return;
      // Menus and dialogs over the viewer, outside it, keep their arrows.
      const { target } = event;
      if (
        target !== document.body &&
        !(target instanceof Node && contentRef.current?.contains(target))
      ) {
        return;
      }
      if (ownsArrowKeys(target)) return;
      event.preventDefault();
      claimShortcutEvent(event);
      step(delta, listed);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [isOpen, step, listed]);

  return (
    <Dialog
      open={session !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent
        ref={contentRef}
        showCloseButton={false}
        floating={false}
        // The whole window, title bar included, as Settings: the header is the top row.
        className="!top-0 !left-0 flex !h-screen !max-h-none !w-full !max-w-none !translate-x-0 !translate-y-0 flex-col !gap-0 overflow-hidden !rounded-none !border-0 !bg-[oklch(var(--chrome))] !p-0"
        onOpenAutoFocus={(event) => {
          // The viewer itself takes focus, so Enter doesn't press its first button.
          event.preventDefault();
          (event.currentTarget as HTMLElement).focus();
        }}
        onEscapeKeyDown={(event) => {
          // The prompt draft floating over the viewer closes on its own Escape.
          if (isInPromptDraft(event.target)) event.preventDefault();
        }}
        onCloseAutoFocus={(event) => {
          const terminalId = returnToTerminal.current;
          returnToTerminal.current = null;
          if (!terminalId) return;
          event.preventDefault();
          focusTerminalRenderer(terminalId);
        }}
        onKeyDown={(event) => {
          // Cmd+B and Cmd+Shift+C, as in the file viewer; claimed so the file panel behind
          // doesn't act on them too.
          if (isSidebarToggle(event.nativeEvent)) {
            event.preventDefault();
            claimShortcutEvent(event.nativeEvent);
            toggleSidebar();
          } else if (session && isCopyReference(event.nativeEvent)) {
            event.preventDefault();
            claimShortcutEvent(event.nativeEvent);
            copyReference(referenceTo(session.item, shownEditor.current));
          }
        }}
      >
        {session && (
          <ReferenceTargetContext.Provider
            value={{
              terminalId: fileViewerCovers ? null : focusedTerminalId,
              insert: insertInTerminal,
            }}
          >
            <QuickLookContent session={session} listed={listed} shownEditor={shownEditor} />
          </ReferenceTargetContext.Provider>
        )}
        {/* Inside the viewer, which keeps focus and clicks within itself. Gone as soon as the
            viewer closes, not once it has faded out, so the draft goes back to the window. */}
        {session && <PromptDraftOutlet workspaceId={session.workspaceId} />}
      </DialogContent>
    </Dialog>
  );
}

function QuickLookContent({
  session,
  listed,
  shownEditor,
}: {
  session: QuickLookSession;
  /** The workspace's files from terminals, which the sidebar lists. */
  listed: QuickLookListed;
  shownEditor: ShownEditorRef;
}) {
  const step = useQuickLookStore((s) => s.step);
  const close = useQuickLookStore((s) => s.close);
  const canStepBack = useQuickLookStore((s) => canStepQuickLook(s, -1, listed));
  const canStepForward = useQuickLookStore((s) => canStepQuickLook(s, 1, listed));
  const sidebarOpen = useQuickLookStore((s) => s.sidebarOpen);
  const toggleSidebar = useQuickLookStore((s) => s.toggleSidebar);
  const topRowStyle = useTopRowStyle();
  const { workspaceId, item } = session;
  const [viewMode, setViewMode] = useViewMode(item);
  const { source, hostPath } = item;
  const isFolder = isQuickLookFolder(item);
  const onSshHost = useWorkspacesStore((s) =>
    isOnSshHost(
      s.workspaces.find((w) => w.id === workspaceId),
      item.terminalId,
      source
    )
  );
  const name = fileName(item.path);
  const kind = isFolder ? null : getViewableFileKind(item.path);
  const { terminalId, insert } = useContext(ReferenceTargetContext);
  const reference = () => referenceTo(item, shownEditor.current);
  useViewedFile(workspaceId, item.path, reference);

  return (
    <>
      {/* Draggable and level with the window controls, on the chrome as the workspace's top row
          is, with no line under it. */}
      <div
        className="quick-look-chrome drag-region flex shrink-0 items-center gap-2 px-1.5"
        style={topRowStyle}
      >
        {/* Back, not a close X: on Linux the window's own close X sits at the right. */}
        <IconButton label="Back" shortcut="Esc" onClick={close}>
          <ArrowLeft className="size-4" />
        </IconButton>
        <IconButton
          label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
          shortcut={getSidebarToggleShortcutLabel()}
          onClick={toggleSidebar}
        >
          <SidebarSimple className="size-4" />
        </IconButton>
        {/* Where the file or folder is, as the terminal printed it: its folder, cut from the
            left so the folders nearest it stay, then its name. Right-click for its other paths. */}
        <ReferenceMenu item={item} reference={reference}>
          <div
            className="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-lg border border-foreground/10 bg-foreground/[0.03] pr-0.5 pl-2.5 text-[13px]"
            title={item.path}
          >
            <EntryIcon item={item} className="size-4" />
            <span className="flex min-w-0 flex-1">
              {/* rtl truncates from the left; bdi keeps the path itself in LTR order */}
              <span className="min-w-0 truncate text-muted-foreground" dir="rtl">
                <bdi>{folderOf(item.path)}</bdi>
              </span>
              <DialogTitle className="max-w-full shrink-0 truncate text-[13px] leading-5 font-medium tracking-normal">
                {name}
              </DialogTitle>
            </span>
            <DialogDescription className="sr-only">{item.path}</DialogDescription>
            {/* A click leaves focus where it was, so the arrows still step through the files. */}
            <IconButton
              label="Copy @path"
              shortcut={getCopyReferenceShortcutLabel()}
              size="xs"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => copyReference(reference())}
            >
              <Copy className="size-3.5" />
            </IconButton>
            {terminalId && (
              <IconButton
                label="Insert @path in terminal"
                size="xs"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => insert(terminalId, reference())}
              >
                <TerminalWindow className="size-3.5" />
              </IconButton>
            )}
          </div>
        </ReferenceMenu>
        <PromptDraftButton workspaceId={workspaceId} />
        {(kind === 'html' || kind === 'markdown') && (
          // A click leaves focus on the viewer, so the arrows still step through the files.
          <div onMouseDown={(event) => event.preventDefault()}>
            <SegmentedControl
              aria-label="View"
              iconOnly
              value={viewMode}
              onValueChange={setViewMode}
              options={VIEW_MODE_OPTIONS}
            />
          </div>
        )}
        {/* Opening a file from outside the workspace there would copy it into the workspace. */}
        {source.kind === 'workspace' && !isFolder && (
          <Button
            variant="outline"
            size="sm"
            className="h-7"
            onClick={() => {
              openInFilePanel(workspaceId, source.filePath, undefined);
              close();
            }}
          >
            Open in file panel
          </Button>
        )}
        {!isFolder && onSshHost && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1.5"
            onClick={() => void downloadViewerFile(workspaceId, item.terminalId, source)}
          >
            <DownloadSimple className="size-3.5" />
            Download
          </Button>
        )}
        {isFolder && hostPath && (
          <Button
            variant="outline"
            size="sm"
            className="h-7"
            onClick={() => window.api.showItemInFolder(hostPath)}
          >
            {getRevealInFileManagerLabel()}
          </Button>
        )}
        <LinuxWindowControlsEnd />
      </div>
      <div className="flex min-h-0 flex-1">
        {sidebarOpen && <QuickLookSidebar session={session} listed={listed} />}
        {/* The file is a rounded block on the chrome's gutter, as a pane in the workspace, on the
            page background, as a file pane's previews are; a file's source is on the editor's
            color (EditorSurface). */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col px-(--pane-gap) pb-(--pane-gap)">
          <div className="group/body relative flex min-h-0 flex-1 flex-col overflow-clip rounded-(--pane-radius) bg-background">
            {isFolder ? (
              <FolderBody item={item} name={name} />
            ) : (
              <QuickLookBody
                key={`${quickLookItemKey(item)}:${item.lineNumber ?? ''}`}
                workspaceId={workspaceId}
                item={item}
                kind={kind}
                name={name}
                viewMode={viewMode}
                shownEditor={shownEditor}
              />
            )}
            {/* Over the file only while the pointer is, so they don't cover it; the arrow keys
              step through the files too. */}
            {canStepBack && (
              <IconButton
                label="Previous file"
                variant="secondary"
                className={cn(STEP_BUTTON_CLASS, 'left-3')}
                onClick={() => step(-1, listed)}
              >
                <CaretLeft className="size-4" />
              </IconButton>
            )}
            {canStepForward && (
              <IconButton
                label="Next file"
                variant="secondary"
                className={cn(STEP_BUTTON_CLASS, 'right-3')}
                onClick={() => step(1, listed)}
              >
                <CaretRight className="size-4" />
              </IconButton>
            )}
            <PaneOutline focused={false} />
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * Preview or Source, as last chosen, from file to file. A link to a line shows the source at that
 * line, until changed while it is on screen, without changing the choice for other files.
 */
function useViewMode(item: QuickLookItem) {
  const [chosen, setChosen] = useState<{ mode: ViewMode; on: QuickLookItem | null }>({
    mode: 'preview',
    on: null,
  });
  const viewMode = item.lineNumber !== undefined && chosen.on !== item ? 'source' : chosen.mode;
  const choose = (mode: ViewMode) => setChosen({ mode, on: item });
  return [viewMode, choose] as const;
}

/**
 * A right-click menu of the ways to refer to a file or folder: its `@path` for an agent prompt,
 * copied or put into the terminal behind the viewer, and its path as printed and in full.
 */
function ReferenceMenu({
  item,
  reference,
  children,
}: {
  item: QuickLookItem;
  /** The file on screen's `@path`, which names the lines selected in its source. */
  reference?: () => string;
  children: ReactNode;
}) {
  const referenceToItem = reference ?? (() => referenceTo(item, null));
  const { terminalId, insert } = useContext(ReferenceTargetContext);
  const fullPath = quickLookFullPath(item);
  const { hostPath } = item;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent
        onKeyDown={(event) => {
          // The menu's own file, which for a row's menu isn't the one on screen. React would bubble
          // the key to the viewer, which copies that one, so it stops here.
          if (!isCopyReference(event.nativeEvent)) return;
          event.preventDefault();
          event.stopPropagation();
          claimShortcutEvent(event.nativeEvent);
          copyReference(referenceToItem());
        }}
      >
        <ContextMenuItem onSelect={() => copyReference(referenceToItem())}>
          <Copy />
          Copy @path
          <ContextMenuShortcut>{getCopyReferenceShortcutLabel()}</ContextMenuShortcut>
        </ContextMenuItem>
        {terminalId && (
          <ContextMenuItem onSelect={() => insert(terminalId, referenceToItem())}>
            <TerminalWindow />
            Insert @path in terminal
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => copyText(item.path)}>
          <Copy />
          Copy path
        </ContextMenuItem>
        {fullPath && (
          <ContextMenuItem onSelect={() => copyText(fullPath)}>
            <Copy />
            Copy full path
          </ContextMenuItem>
        )}
        {hostPath && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => window.api.showItemInFolder(hostPath)}>
              <MagnifyingGlass />
              {getRevealInFileManagerLabel()}
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

// Rows each list in the sidebar shows before "Show more", as in the files dropdown.
const SECTION_ROWS = 8;

/**
 * The files from terminals, the latest opened or printed first, then the rest of the folder on
 * screen, or of the file on screen.
 */
function QuickLookSidebar({
  session,
  listed,
}: {
  session: QuickLookSession;
  listed: QuickLookListed;
}) {
  const folder = useQuickLookStore((s) => s.folder);
  const sections = useMemo(
    () => quickLookSidebar({ session, folder }, listed),
    [session, folder, listed]
  );
  const onScreen = quickLookItemKey(session.item);
  const navRef = useRef<HTMLElement>(null);
  // Whether a file here has focus. It stays set when the arrows step into another folder and
  // the file with focus leaves the list, which sends focus nowhere.
  const hasFocus = useRef(false);

  // What the terminals printed since the files list last read them.
  useEffect(() => {
    rememberTerminalFiles(session.workspaceId);
  }, [session.workspaceId]);

  // Focus moves with the file on screen while a file here has it.
  useEffect(() => {
    if (!hasFocus.current) return;
    navRef.current?.querySelector<HTMLElement>('[aria-current="true"]')?.focus();
  }, [onScreen]);

  if (!sections) return null;
  return (
    <nav
      ref={navRef}
      onFocus={() => {
        hasFocus.current = true;
      }}
      onBlur={(event) => {
        if (event.relatedTarget)
          hasFocus.current = event.currentTarget.contains(event.relatedTarget);
      }}
      aria-label="Files"
      className="quick-look-chrome flex w-60 shrink-0 flex-col gap-3 overflow-y-auto p-1.5"
    >
      {sections.recent.length > 0 && (
        <TerminalSection title="Recent" items={sections.recent} onScreen={onScreen} />
      )}
      <FolderSection
        key={sections.folder.key}
        section={sections.folder}
        onScreen={onScreen}
        separated={sections.recent.length > 0}
      />
    </nav>
  );
}

/** How many of a list's rows show: SECTION_ROWS, or more to reach the file on screen. */
function useShownRows(items: QuickLookItem[], onScreen: string) {
  const [expanded, setExpanded] = useState(false);
  const index = items.findIndex((item) => quickLookItemKey(item) === onScreen);
  const shown = expanded ? items.length : Math.max(SECTION_ROWS, index + 1);
  return {
    rows: items.slice(0, shown),
    hidden: items.length - shown,
    expand: () => setExpanded(true),
  };
}

function ShowMore({
  count,
  noun,
  onClick,
}: {
  count: number;
  /** What the rows are, when the section has another list of other rows. */
  noun?: string;
  onClick: () => void;
}) {
  if (count <= 0) return null;
  return (
    <button
      type="button"
      onMouseDown={focusViewer}
      onClick={onClick}
      className="rounded-lg px-2 py-1 text-left text-2xs text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
    >
      Show {count} more{noun && ` ${noun}`}…
    </button>
  );
}

/** Files from terminals, each with the folder it's in, as printed. */
function TerminalSection({
  title,
  items,
  onScreen,
}: {
  title: string;
  items: QuickLookItem[];
  onScreen: string;
}) {
  return (
    <section aria-label={title} className="flex flex-col gap-0.5">
      <h3 className="px-2 pb-0.5 text-ui font-medium text-muted-foreground-60">{title}</h3>
      <SidebarRows items={items} onScreen={onScreen} folderHints />
    </section>
  );
}

/**
 * The folder on screen, or of the file on screen, as a tree: its other files, in the order the
 * arrows step through them, then its subfolders, under its name, with a way up to the folder it
 * is in. Each shows SECTION_ROWS, so many subfolders can't push its files out of sight.
 */
function FolderSection({
  section,
  onScreen,
  separated,
}: {
  section: QuickLookFolderSection;
  onScreen: string;
  /** Whether sections above it, which it is set apart from. */
  separated: boolean;
}) {
  const show = useQuickLookStore((s) => s.show);
  const { folder, parent, files, folders, status } = section;
  const { title, path } = folderLabel(folder);
  const isOnScreen = quickLookItemKey(folder) === onScreen;
  const heading = (
    <>
      <FolderOpen className="size-3.5 shrink-0" />
      <span className="truncate">{title}</span>
    </>
  );
  return (
    <section
      aria-label={title}
      className={cn('flex flex-col gap-0.5', separated && 'border-t border-border pt-3')}
    >
      <div className="flex items-center gap-1">
        <h3 className="flex min-w-0 flex-1 text-ui font-medium text-muted-foreground" title={path}>
          {/* The workspace root is no folder path, so it can't be shown. */}
          {isQuickLookFolder(folder) ? (
            <button
              type="button"
              aria-label={`Show ${title}`}
              aria-current={isOnScreen || undefined}
              onMouseDown={focusViewer}
              onClick={() => show(folder)}
              className={cn(
                'flex min-w-0 flex-1 items-center gap-1.5 rounded-lg px-2 py-1 text-left transition-colors duration-150 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden',
                isOnScreen && 'bg-accent text-foreground'
              )}
            >
              {heading}
            </button>
          ) : (
            <span className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1">{heading}</span>
          )}
        </h3>
        {parent && (
          <IconButton
            label={`Up to ${folderLabel(parent).title}`}
            size="xs"
            className="text-muted-foreground"
            onMouseDown={focusViewer}
            onClick={() => show(parent)}
          >
            <ArrowUp className="size-3.5" />
          </IconButton>
        )}
      </div>
      {/* Indented under the folder, along a guide line, as a file tree nests them. */}
      {files.length + folders.length > 0 && (
        <div className="ml-[15px] flex flex-col gap-0.5 border-l border-border pl-1.5">
          <SidebarRows items={files} onScreen={onScreen} />
          <SidebarRows items={folders} onScreen={onScreen} noun="folders" />
        </div>
      )}
      {status === 'loading' && <Spinner size="sm" className="mx-2 my-1 text-muted-foreground" />}
      {status === 'error' && (
        <p className="px-2 text-ui text-muted-foreground">Couldn&apos;t list this folder</p>
      )}
    </section>
  );
}

/** A list of the sidebar's files or folders, SECTION_ROWS of them, or more to reach the file on screen. */
function SidebarRows({
  items,
  onScreen,
  folderHints = false,
  noun,
}: {
  items: QuickLookItem[];
  onScreen: string;
  /** Whether each row names the folder its file is in, for files listed away from their folder. */
  folderHints?: boolean;
  noun?: string;
}) {
  const { rows, hidden, expand } = useShownRows(items, onScreen);
  if (rows.length === 0) return null;
  return (
    <>
      <ul className="flex flex-col gap-0.5">
        {rows.map((item) => {
          const key = quickLookItemKey(item);
          return (
            <SidebarFile
              key={key}
              item={item}
              isCurrent={key === onScreen}
              folderHint={folderHints ? parentPath(item.path) : undefined}
            />
          );
        })}
      </ul>
      <ShowMore count={hidden} noun={noun} onClick={expand} />
    </>
  );
}

/** The folder a path is in, as printed, ending in its separator. */
function parentPath(path: string): string {
  const trimmed = path.replace(/[\\/]$/, '');
  const slash = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return slash < 0 ? '' : trimmed.slice(0, slash + 1);
}

/** A folder's name, or Workspace for the workspace root, and its path. */
function folderLabel({ source }: QuickLookItem): { title: string; path: string } {
  if (source.kind === 'workspace') {
    const path = source.filePath.replace(/\/$/, '');
    return { title: path ? fileName(path) : 'Workspace', path: path || 'Workspace' };
  }
  const path = source.fullPath.replace(/\/$/, '') || '/';
  return { title: fileName(path), path };
}

/** A click puts focus on the viewer, not on what was clicked, which the arrows move on from. */
function focusViewer(event: MouseEvent<HTMLElement>) {
  event.preventDefault();
  event.currentTarget.closest<HTMLElement>('[role="dialog"]')?.focus();
}

function EntryIcon({ item, className }: { item: QuickLookItem; className: string }) {
  return isQuickLookFolder(item) ? (
    <Folder className={cn('shrink-0 text-muted-foreground', className)} />
  ) : (
    <FileTypeIcon fileName={fileName(item.path)} className={cn('shrink-0', className)} />
  );
}

/** A folder on screen: its subfolders and the files the viewer can show, to open one. */
function FolderBody({ item, name }: { item: QuickLookItem; name: string }) {
  const folder = useQuickLookStore((s) => s.folder);
  const show = useQuickLookStore((s) => s.show);
  if (!folder || folder.status === 'loading') {
    return <ViewerStatus pending={LOADING} item={item} name={name} />;
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-6">
      {folder.status === 'error' ? (
        <Callout tone="error" size="sm" className="mx-auto">
          Couldn&apos;t list this folder
        </Callout>
      ) : folder.items.length === 0 ? (
        <p className="m-auto text-sm text-muted-foreground">No folders or viewable files</p>
      ) : (
        <ul
          aria-label={`Contents of ${name}`}
          className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-1"
        >
          {folder.items.map((entry) => (
            <li key={quickLookItemKey(entry)}>
              <ReferenceMenu item={entry}>
                <button
                  type="button"
                  title={entry.path}
                  onMouseDown={focusViewer}
                  onClick={() => show(entry)}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors duration-150 hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
                >
                  <EntryIcon item={entry} className="size-4" />
                  <span className="truncate">{fileName(entry.path)}</span>
                  <ModifiedTime modifiedMs={entry.modifiedMs} />
                </button>
              </ReferenceMenu>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** How long ago an entry was modified; the title gives the full date. */
function ModifiedTime({ modifiedMs }: { modifiedMs: number | undefined }) {
  if (modifiedMs === undefined) return null;
  // Out of the button's name, which is the entry's name.
  return (
    <time
      aria-hidden
      dateTime={new Date(modifiedMs).toISOString()}
      className="ml-auto shrink-0 text-2xs text-muted-foreground-60 tabular-nums"
    >
      {formatRelativeTime(modifiedMs)}
    </time>
  );
}

function SidebarFile({
  item,
  isCurrent,
  folderHint,
}: {
  item: QuickLookItem;
  isCurrent: boolean;
  /** The folder the file is in, for a file listed away from its folder. */
  folderHint?: string;
}) {
  const show = useQuickLookStore((s) => s.show);
  const ref = useRef<HTMLButtonElement>(null);
  const name = fileName(item.path);
  const { modifiedMs } = item;
  const title =
    modifiedMs === undefined
      ? item.path
      : `${item.path}\nModified ${new Date(modifiedMs).toLocaleString(undefined, {
          dateStyle: 'medium',
          timeStyle: 'short',
        })}`;

  // Keeps the file on screen in view as the arrows move through a long folder.
  useEffect(() => {
    if (isCurrent) ref.current?.scrollIntoView?.({ block: 'nearest' });
  }, [isCurrent]);

  return (
    <li>
      <ReferenceMenu item={item}>
        <button
          ref={ref}
          type="button"
          title={title}
          aria-current={isCurrent || undefined}
          onMouseDown={focusViewer}
          onClick={() => show(item)}
          className={cn(
            'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-ui transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden',
            isCurrent
              ? 'bg-accent text-foreground'
              : 'text-muted-foreground-70 hover:bg-accent/40 hover:text-foreground'
          )}
        >
          <EntryIcon item={item} className="size-3.5" />
          <span className={cn('truncate', folderHint && 'max-w-[70%] shrink-0')}>{name}</span>
          {folderHint && (
            // Out of the button's name, like the time. Right to left, so a long folder loses its
            // start rather than the part by the name.
            <span
              aria-hidden
              dir="rtl"
              className="min-w-0 truncate text-2xs text-muted-foreground-50"
            >
              <bdi>{folderHint}</bdi>
            </span>
          )}
          <ModifiedTime modifiedMs={modifiedMs} />
        </button>
      </ReferenceMenu>
    </li>
  );
}

interface BodyProps {
  workspaceId: string;
  item: QuickLookItem;
  kind: ViewableFileKind | null;
  name: string;
}

function QuickLookBody({
  viewMode,
  shownEditor,
  ...props
}: BodyProps & { viewMode: ViewMode; shownEditor: ShownEditorRef }) {
  const { kind } = props;
  if (kind === 'pdf' || (kind === 'html' && viewMode === 'preview')) {
    return <PagePreview {...props} />;
  }
  if (kind === 'image' || kind === 'svg' || kind === 'audio' || kind === 'video') {
    return <BinaryPreview {...props} />;
  }
  const rendered = kind === 'markdown' && viewMode === 'preview';
  const text = <TextPreview {...props} rendered={rendered} shownEditor={shownEditor} />;
  // Rendered Markdown keeps the page background it paints itself.
  return rendered ? text : <EditorSurface>{text}</EditorSurface>;
}

/**
 * The code editor's color, under the source while it loads too, so stepping from file to file
 * doesn't flash the page background before the editor paints.
 */
function EditorSurface({ children }: { children: ReactNode }) {
  const background = useEditorSurfaceBackground();
  return (
    <div className="flex min-h-0 flex-1 flex-col" style={{ backgroundColor: background }}>
      {children}
    </div>
  );
}

/** HTML pages and PDFs, in the same locked-down frame the file panel uses. */
function PagePreview({ workspaceId, item, name }: BodyProps) {
  const url = useViewerRequest(workspaceId, item, getPreviewUrl);
  if (url.status !== 'loaded') return <ViewerStatus pending={url} item={item} name={name} />;
  return <BrowserPreviewFrame filePath={item.path} url={url.value} />;
}

/** Images, SVGs (as images, so their scripts never run), audio and video. */
function BinaryPreview({ workspaceId, item, kind, name }: BodyProps) {
  const file = useViewerRequest(workspaceId, item, readFile);
  if (file.status !== 'loaded') return <ViewerStatus pending={file} item={item} name={name} />;
  const { data, mimeType } = file.value;
  return kind === 'audio' || kind === 'video' ? (
    <MediaPane data={data} mimeType={mimeType} kind={kind} fileName={name} />
  ) : (
    <ImagePane data={data} mimeType={mimeType} fileName={name} />
  );
}

/** Markdown, text files, and files of other types that turn out to be text. */
function TextPreview({
  workspaceId,
  item,
  kind,
  name,
  rendered,
  shownEditor,
}: BodyProps & { rendered: boolean; shownEditor: ShownEditorRef }) {
  const file = useViewerRequest(workspaceId, item, readFile);
  const text = useMemo<Loaded<DecodedText>>(
    () =>
      file.status === 'loaded' ? { status: 'loaded', value: decodeText(file.value.data) } : file,
    [file]
  );
  if (text.status !== 'loaded') return <ViewerStatus pending={text} item={item} name={name} />;
  const decoded = text.value;
  if (kind === null && decoded.binary) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <File className="size-10 text-muted-foreground" />
        <div>
          <div className="text-sm font-medium">{name}</div>
          <div className="mt-1 text-xs text-muted-foreground">
            {formatFileSize(decoded.size)} · No preview for this type of file
          </div>
        </div>
        <HostFileActions item={item} />
      </div>
    );
  }
  if (rendered) return <MarkdownPreview markdown={decoded.text} />;
  return (
    <ErrorBoundary>
      <Suspense fallback={<ViewerStatus pending={LOADING} item={item} name={name} />}>
        <EditorPane
          filePath={item.path}
          fileContent={decoded.text}
          loading={false}
          error={null}
          readOnly
          onMount={(editor) => {
            shownEditor.current = { item, editor };
            if (item.lineNumber === undefined) return;
            editor.revealLineInCenter(item.lineNumber);
            editor.setPosition({ lineNumber: item.lineNumber, column: 1 });
          }}
        />
      </Suspense>
    </ErrorBoundary>
  );
}

const LOADING: Pending = { status: 'loading' };

function ViewerStatus({
  pending,
  item,
  name,
}: {
  pending: Pending;
  item: QuickLookItem;
  name: string;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6">
      {pending.status === 'error' ? (
        <>
          <Callout tone="error" size="sm">
            Couldn&apos;t show {name}: {pending.message}
          </Callout>
          <HostFileActions item={item} />
        </>
      ) : (
        <Spinner size="md" className="text-muted-foreground" />
      )}
    </div>
  );
}

/** Hands a file on this computer to the system, for types the viewer can't show. */
function HostFileActions({ item }: { item: QuickLookItem }) {
  const { hostPath } = item;
  if (!hostPath) return null;
  return (
    <div className="flex gap-2">
      <Button variant="outline" size="sm" onClick={() => void window.api.openPath(hostPath)}>
        Open in default app
      </Button>
      <Button variant="outline" size="sm" onClick={() => window.api.showItemInFolder(hostPath)}>
        {getRevealInFileManagerLabel()}
      </Button>
    </div>
  );
}

function useViewerRequest<T>(
  workspaceId: string,
  item: QuickLookItem,
  request: ViewerRequest<T>
): Loaded<T> {
  const [result, setResult] = useState<{ item: QuickLookItem; loaded: Loaded<T> } | null>(null);

  useEffect(() => {
    let cancelled = false;
    request(workspaceId, item.terminalId, item.source).then(
      (value) => {
        if (!cancelled) setResult({ item, loaded: { status: 'loaded', value } });
      },
      (error: unknown) => {
        if (!cancelled)
          setResult({ item, loaded: { status: 'error', message: errorMessage(error) } });
      }
    );
    return () => {
      cancelled = true;
    };
  }, [workspaceId, item, request]);

  return result?.item === item ? result.loaded : LOADING;
}

interface DecodedText {
  text: string;
  /** NUL bytes near the start, which text files don't have. */
  binary: boolean;
  size: number;
}

function decodeText(data: string): DecodedText {
  const raw = atob(data);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return {
    text: new TextDecoder().decode(bytes),
    binary: bytes.subarray(0, 8000).includes(0),
    size: bytes.length,
  };
}

/** The folder part of a path, with its trailing separator; empty for a bare name. */
function folderOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  return trimmed.slice(0, trimmed.length - fileName(path).length);
}

/** The last name in a path, a folder's without its trailing separator. */
function fileName(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() || path
  );
}

function isSidebarToggle(event: KeyboardEvent): boolean {
  return (
    (event.metaKey || event.ctrlKey) &&
    !event.shiftKey &&
    !event.altKey &&
    event.key.toLowerCase() === 'b'
  );
}

function isCopyReference(event: KeyboardEvent): boolean {
  return (
    (event.metaKey || event.ctrlKey) &&
    event.shiftKey &&
    !event.altKey &&
    event.key.toLowerCase() === 'c'
  );
}

function hasModifier(event: KeyboardEvent): boolean {
  return event.metaKey || event.ctrlKey || event.altKey || event.shiftKey;
}

/** Whether what has focus uses the arrow keys itself: text, the editor, media or a toggle. */
function ownsArrowKeys(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest(
      'input, textarea, select, audio, video, [contenteditable="true"], [role="radiogroup"], .monaco-editor'
    ) !== null
  );
}

/** Electron wraps main-process errors as "Error invoking remote method '<channel>': Error: <message>". */
function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}
