import { useEffect, useRef, useCallback, useState } from 'react';

import { Spinner } from '@/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatRelativeTime } from '@/lib/format-time';
import { cn } from '@/lib/utils';

import type { BlameLineMap } from './useBlameState';
import type { BlameHunk } from '@/types';
import type { editor as monacoEditor } from 'monaco-editor';

const DEFAULT_BLAME_WIDTH = 180;
const MIN_BLAME_WIDTH = 120;
const MAX_BLAME_WIDTH = 400;
const BLAME_WIDTH_STORAGE_KEY = 'komla.blameGutterWidth';
const MONACO_LINE_HEIGHT_OPTION = 75 as Parameters<
  monacoEditor.IStandaloneCodeEditor['getOption']
>[0];

function getStoredBlameWidth(): number {
  if (typeof window === 'undefined') return DEFAULT_BLAME_WIDTH;
  const stored = window.localStorage.getItem(BLAME_WIDTH_STORAGE_KEY);
  const parsed = stored ? Number(stored) : NaN;
  if (!Number.isFinite(parsed)) return DEFAULT_BLAME_WIDTH;
  return Math.min(MAX_BLAME_WIDTH, Math.max(MIN_BLAME_WIDTH, parsed));
}

interface BlameGutterProps {
  editor: monacoEditor.IStandaloneCodeEditor | null;
  blameLineMap: BlameLineMap;
  blameAnnotations: BlameHunk[];
  onHunkClick: (hunk: BlameHunk) => void;
  onHide: () => void;
  loading: boolean;
}

interface VisibleRow {
  top: number;
  height: number;
  hunk: BlameHunk;
}

export function BlameGutter({
  editor,
  blameLineMap,
  blameAnnotations,
  onHunkClick,
  onHide,
  loading,
}: BlameGutterProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [rows, setRows] = useState<VisibleRow[]>([]);
  const [width, setWidth] = useState(getStoredBlameWidth);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const rafRef = useRef<number>(0);

  const updateRows = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      if (!editor) return;

      const model = editor.getModel();
      if (!model || blameLineMap.size === 0) {
        setRows([]);
        return;
      }

      const visibleRanges = editor.getVisibleRanges();
      if (visibleRanges.length === 0) {
        setRows([]);
        return;
      }

      const firstVisible = Math.max(1, visibleRanges[0].startLineNumber - 5);
      const lastVisible = Math.min(
        model.getLineCount(),
        visibleRanges[visibleRanges.length - 1].endLineNumber + 5
      );
      const scrollTop = editor.getScrollTop();

      const newRows: VisibleRow[] = [];
      let lastHunk: BlameHunk | null = null;

      for (let lineNum = firstVisible; lineNum <= lastVisible; lineNum++) {
        const hunk = blameLineMap.get(lineNum);
        if (!hunk) continue;

        // Only render the first line of each hunk within visible range
        if (hunk === lastHunk) continue;
        lastHunk = hunk;

        const top = editor.getTopForLineNumber(lineNum) - scrollTop;
        const lineHeight = editor.getOption(MONACO_LINE_HEIGHT_OPTION) as number;
        // Calculate visible portion of hunk
        const hunkEndLine = Math.min(hunk.startLine + hunk.lineCount - 1, lastVisible);
        const hunkStartLine = Math.max(hunk.startLine, firstVisible);
        const visibleLines = hunkEndLine - hunkStartLine + 1;
        const height = lineHeight * visibleLines;

        newRows.push({ top, height, hunk });
      }
      setRows(newRows);
    });
  }, [editor, blameLineMap]);

  useEffect(() => {
    if (!editor) return;
    updateRows();
    const disposables = [
      editor.onDidScrollChange(updateRows),
      editor.onDidLayoutChange(updateRows),
    ];
    return () => {
      cancelAnimationFrame(rafRef.current);
      disposables.forEach((d) => d.dispose());
    };
  }, [editor, updateRows]);

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = width;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      const handleMouseMove = (e: MouseEvent) => {
        const newWidth = Math.min(
          MAX_BLAME_WIDTH,
          Math.max(MIN_BLAME_WIDTH, startWidth + (e.clientX - startX))
        );
        setWidth(newWidth);
        window.localStorage.setItem(BLAME_WIDTH_STORAGE_KEY, String(newWidth));
      };

      const handleMouseUp = () => {
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    },
    [width]
  );

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
  }, []);

  // Dismiss context menu on click outside or another right-click
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!contextMenu) return;
    const dismiss = (e: MouseEvent) => {
      if (menuRef.current && menuRef.current.contains(e.target as Node)) return;
      setContextMenu(null);
    };
    document.addEventListener('mousedown', dismiss);
    document.addEventListener('contextmenu', dismiss);
    return () => {
      document.removeEventListener('mousedown', dismiss);
      document.removeEventListener('contextmenu', dismiss);
    };
  }, [contextMenu]);

  if (loading) {
    return (
      <div
        style={{ width }}
        className="flex shrink-0 items-center justify-center border-r border-border/40 bg-muted/10"
      >
        <Spinner label="Loading blame" className="text-muted-foreground" />
      </div>
    );
  }

  if (blameAnnotations.length === 0) return null;

  return (
    <div className="flex shrink-0 flex-row" style={{ width }}>
      <div
        ref={containerRef}
        style={{ position: 'relative', overflow: 'hidden', flex: 1 }}
        className="bg-muted/10 select-none"
        onContextMenu={handleContextMenu}
      >
        {rows.map((row) => (
          <Tooltip key={`${row.hunk.commitHash}-${row.hunk.startLine}`}>
            <TooltipTrigger asChild>
              <button
                onClick={() => onHunkClick(row.hunk)}
                style={{
                  position: 'absolute',
                  top: row.top,
                  height: row.height,
                  width: '100%',
                  left: 0,
                }}
                className={cn(
                  'flex items-start overflow-hidden px-2 pt-px text-left',
                  'cursor-pointer transition-colors hover:bg-muted/40',
                  'text-muted-foreground'
                )}
              >
                <div
                  className="flex w-full items-baseline gap-1.5 overflow-hidden leading-tight"
                  style={{ marginTop: 1 }}
                >
                  <span className="shrink-0 font-mono text-2xs text-primary/60">
                    {row.hunk.shortHash}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-2xs">{row.hunk.author}</span>
                  <span className="shrink-0 text-[9px] text-muted-foreground/70">
                    {formatRelativeTime(row.hunk.timestamp * 1000)}
                  </span>
                </div>
              </button>
            </TooltipTrigger>
            <TooltipContent side="right" className="max-w-xs">
              <div className="text-xs">
                <p className="font-medium">{row.hunk.summary}</p>
                <p className="mt-1 text-muted-foreground">
                  {row.hunk.author} &middot; {row.hunk.shortHash} &middot;{' '}
                  {formatRelativeTime(row.hunk.timestamp * 1000)}
                </p>
              </div>
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
      {/* Resize handle */}
      <div
        className="w-[3px] shrink-0 cursor-col-resize border-r border-border/40 transition-colors hover:bg-primary/30 active:bg-primary/50"
        onMouseDown={handleResizeStart}
      />
      {/* Context menu */}
      {contextMenu && (
        <div
          ref={menuRef}
          data-native-overlay="menu"
          className="floating-surface fixed z-50 min-w-[140px] rounded-md border py-1 shadow-xl"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            className="w-full px-3 py-1.5 text-left text-xs transition-colors hover:bg-accent"
            onClick={() => {
              setContextMenu(null);
              onHide();
            }}
          >
            Hide Blame
          </button>
        </div>
      )}
    </div>
  );
}
