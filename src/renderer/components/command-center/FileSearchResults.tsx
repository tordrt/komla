import { List, type ListImperativeAPI, type RowComponentProps } from 'react-window';

import { Spinner } from '@/components/ui/spinner';
import { getDirPath, getFileName } from '@/components/workspaces/file-viewer/file-viewer-utils';
import { cn } from '@/lib/utils';

import type { FileSearchResult } from '@/components/workspaces/file-viewer/types';
import type { useFileSearchState } from '@/components/workspaces/file-viewer/useFileViewerState';
import type { ContentSearchState } from '@/hooks/useContentSearch';
import type { CommandCenterFileMode } from '@/stores/command-center.store';
import type { ContentSearchResult } from '@/types';
import type { CSSProperties, JSX, MouseEvent, RefObject } from 'react';

const FILE_ITEM_HEIGHT = 52;
const CONTENT_ITEM_HEIGHT = 64;
const LIST_HEIGHT = 340;

function resultRowClassName(isHighlighted: boolean): string {
  return cn(
    'flex cursor-pointer flex-col justify-center rounded-md px-2 text-sm',
    isHighlighted ? 'bg-accent text-accent-foreground' : 'text-foreground'
  );
}

/** The keys held while a row is picked, which choose where its file opens. */
export type PickModifiers = Pick<MouseEvent, 'shiftKey' | 'metaKey' | 'ctrlKey'>;

/** What every row needs to act as an option of the search input's listbox. */
interface RowOptionProps {
  selectedIndex: number;
  optionId: (index: number) => string;
  onHover: (index: number) => void;
  onPick: (index: number, modifiers: PickModifiers) => void;
}

function rowOptionAttributes(index: number, props: RowOptionProps) {
  return {
    id: props.optionId(index),
    role: 'option',
    'aria-selected': index === props.selectedIndex,
    // Keep focus in the search input, as the workspace rows do.
    onMouseDown: (event: MouseEvent) => event.preventDefault(),
    onMouseMove: () => {
      if (index !== props.selectedIndex) props.onHover(index);
    },
    onClick: (event: MouseEvent) => props.onPick(index, event),
  } as const;
}

// ============================================================================
// File Search Result Row
// ============================================================================

interface FileListRowData extends RowOptionProps {
  filteredFiles: FileSearchResult[];
}

function FileListRow({ index, style, ...data }: RowComponentProps<FileListRowData>) {
  return (
    <FileListItem
      style={style}
      file={data.filteredFiles[index]}
      isHighlighted={index === data.selectedIndex}
      attributes={rowOptionAttributes(index, data)}
    />
  );
}

// react-window rebuilds every row's style when the selection changes, so memo can't skip one.
function FileListItem({
  file,
  isHighlighted,
  attributes,
  style,
}: {
  file: FileSearchResult;
  isHighlighted: boolean;
  attributes: ReturnType<typeof rowOptionAttributes>;
  style?: CSSProperties;
}) {
  const fileName = getFileName(file.path);
  const dirPath = getDirPath(file.path);

  return (
    <div
      {...attributes}
      style={style}
      className={cn(resultRowClassName(isHighlighted), file.gitIgnored && 'opacity-70')}
    >
      <span className="truncate font-mono text-ui font-medium">
        {file.fileNameMatches && file.fileNameMatches.length > 0
          ? renderHighlightedText(fileName, file.fileNameMatches)
          : fileName}
      </span>
      {dirPath && (
        <span className="truncate font-mono text-ui text-muted-foreground">
          {file.pathMatches && file.pathMatches.length > 0
            ? renderHighlightedText(dirPath, file.pathMatches)
            : dirPath}
        </span>
      )}
    </div>
  );
}

function renderHighlightedText(text: string, ranges: ReadonlyArray<readonly [number, number]>) {
  if (ranges.length === 0) return text;
  const parts: JSX.Element[] = [];
  let lastIndex = 0;

  for (const [start, end] of ranges) {
    if (start > lastIndex) {
      parts.push(<span key={`t-${lastIndex}`}>{text.slice(lastIndex, start)}</span>);
    }
    parts.push(
      <span key={`h-${start}`} className="font-semibold text-primary">
        {text.slice(start, end)}
      </span>
    );
    lastIndex = end;
  }

  if (lastIndex < text.length) {
    parts.push(<span key={`t-${lastIndex}`}>{text.slice(lastIndex)}</span>);
  }

  return <>{parts}</>;
}

// ============================================================================
// Content Search Result Row
// ============================================================================

interface ContentListRowData extends RowOptionProps {
  results: ContentSearchResult[];
}

function ContentListRow({ index, style, ...data }: RowComponentProps<ContentListRowData>) {
  return (
    <ContentListItem
      style={style}
      result={data.results[index]}
      isHighlighted={index === data.selectedIndex}
      attributes={rowOptionAttributes(index, data)}
    />
  );
}

function ContentListItem({
  result,
  isHighlighted,
  attributes,
  style,
}: {
  result: ContentSearchResult;
  isHighlighted: boolean;
  attributes: ReturnType<typeof rowOptionAttributes>;
  style?: CSSProperties;
}) {
  const fileName = getFileName(result.path);
  const dirPath = getDirPath(result.path);

  return (
    <div {...attributes} style={style} className={resultRowClassName(isHighlighted)}>
      <div className="flex items-center gap-2">
        <span className="truncate font-medium">{fileName}</span>
        <span className="shrink-0 text-xs text-muted-foreground">:{result.lineNumber}</span>
        {dirPath && (
          <span className="ml-auto truncate text-xs text-muted-foreground">{dirPath}</span>
        )}
      </div>
      <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
        {renderHighlightedContent(result.lineContent, result.matches)}
      </div>
    </div>
  );
}

function renderHighlightedContent(content: string, matches: Array<{ start: number; end: number }>) {
  if (matches.length === 0) return content;

  // Truncate long lines for display
  const maxLength = 150;
  let displayContent = content;
  let offset = 0;

  // If content is too long, try to center around first match
  if (content.length > maxLength && matches.length > 0) {
    const firstMatch = matches[0];
    const center = Math.floor((firstMatch.start + firstMatch.end) / 2);
    const start = Math.max(0, center - maxLength / 2);
    const end = Math.min(content.length, start + maxLength);
    displayContent =
      (start > 0 ? '...' : '') + content.slice(start, end) + (end < content.length ? '...' : '');
    offset = start > 0 ? start - 3 : 0; // Account for '...' prefix
  }

  // Sort matches and filter to visible range
  const sortedMatches = [...matches]
    .sort((a, b) => a.start - b.start)
    .filter((m) => m.end > offset && m.start < offset + displayContent.length)
    .map((m) => ({
      start: Math.max(0, m.start - offset),
      end: Math.min(displayContent.length, m.end - offset),
    }));

  if (sortedMatches.length === 0) return displayContent;

  const parts: JSX.Element[] = [];
  let lastIndex = 0;

  for (const match of sortedMatches) {
    if (match.start > lastIndex) {
      parts.push(
        <span key={`t-${lastIndex}`}>{displayContent.slice(lastIndex, match.start)}</span>
      );
    }
    parts.push(
      <span
        key={`h-${match.start}`}
        className="rounded bg-primary/10 px-0.5 font-semibold text-primary"
      >
        {displayContent.slice(match.start, match.end)}
      </span>
    );
    lastIndex = match.end;
  }

  if (lastIndex < displayContent.length) {
    parts.push(<span key={`t-${lastIndex}`}>{displayContent.slice(lastIndex)}</span>);
  }

  return <>{parts}</>;
}

// ============================================================================
// Results
// ============================================================================

interface FileSearchResultsProps extends RowOptionProps {
  mode: CommandCenterFileMode;
  query: string;
  loading: boolean;
  itemCount: number;
  listboxId: string;
  listRef: RefObject<ListImperativeAPI | null>;
  fileState: ReturnType<typeof useFileSearchState>;
  contentState: ContentSearchState;
}

/** The command center's file and content search results, virtualized for large repos. */
export function FileSearchResults({
  mode,
  query,
  loading,
  itemCount,
  listboxId,
  listRef,
  fileState,
  contentState,
  ...rowOptionProps
}: FileSearchResultsProps) {
  // Keep earlier results on screen while a new search runs so the list doesn't jump.
  if (loading && itemCount === 0) {
    return (
      <div className="flex h-20 items-center justify-center text-sm text-muted-foreground">
        <Spinner size="lg" className="mr-2 size-5" />
        {mode === 'files' ? 'Loading files...' : 'Searching...'}
      </div>
    );
  }
  if (itemCount === 0) {
    return (
      <div className="flex h-20 items-center justify-center text-sm text-muted-foreground">
        {mode === 'content' && !query.trim() ? 'Type to search file contents' : 'No results found'}
      </div>
    );
  }
  const listProps = {
    id: listboxId,
    role: 'listbox',
    'aria-label': 'Results',
    listRef,
    style: { height: LIST_HEIGHT, width: '100%' },
  } as const;
  // The list positions its rows itself, so the padding goes around it.
  return (
    <div className="p-1">
      {mode === 'files' ? (
        <List
          {...listProps}
          rowCount={fileState.filteredFiles.length}
          rowHeight={FILE_ITEM_HEIGHT}
          rowComponent={FileListRow}
          rowProps={{ filteredFiles: fileState.filteredFiles, ...rowOptionProps }}
        />
      ) : (
        <List
          {...listProps}
          rowCount={contentState.results.length}
          rowHeight={CONTENT_ITEM_HEIGHT}
          rowComponent={ContentListRow}
          rowProps={{ results: contentState.results, ...rowOptionProps }}
        />
      )}
    </div>
  );
}
