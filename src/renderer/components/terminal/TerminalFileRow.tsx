import { Folder } from '@phosphor-icons/react';

import { FileTypeIcon } from '@/components/workspaces/file-viewer/file-icon-utils';
import { cn } from '@/lib/utils';

import { TerminalFilePreviewCard, terminalFilePreviewKind } from './TerminalFilePreviewCard';

import type { TerminalFile } from '@/stores/terminal-files.store';
import type { MouseEvent } from 'react';

/** A file's name and the folder it's in, as printed. */
function fileParts({ path }: TerminalFile): { name: string; folder: string } {
  const trimmed = path.replace(/[\\/]$/, '');
  const slash = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return { name: trimmed.slice(slash + 1), folder: slash < 0 ? '' : trimmed.slice(0, slash + 1) };
}

/** A file from a terminal, with the folder it's in. */
export function FileRow({
  file,
  active,
  onOpen,
  onHover,
}: {
  file: TerminalFile;
  active: boolean;
  onOpen: (event: MouseEvent) => void;
  onHover: () => void;
}) {
  const { name, folder } = fileParts(file);
  const isFolder = /[\\/]$/.test(file.path);
  return (
    <TerminalFilePreviewCard file={file}>
      <button
        type="button"
        // The preview card names the file itself.
        title={terminalFilePreviewKind(file.path) ? undefined : file.path}
        data-active={active || undefined}
        onClick={onOpen}
        onMouseMove={onHover}
        className={cn(
          'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs',
          active && 'bg-muted'
        )}
      >
        {isFolder ? (
          <Folder className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <FileTypeIcon fileName={name} className="size-3.5 shrink-0" />
        )}
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="shrink-0 text-foreground">
            {name}
            {file.lineNumber !== undefined && (
              <span className="text-muted-foreground">:{file.lineNumber}</span>
            )}
          </span>
          <span className="truncate font-mono text-2xs text-muted-foreground" dir="rtl">
            {/* Right to left, so a long folder loses its start rather than the part by the name. */}
            <bdi>{folder}</bdi>
          </span>
        </span>
      </button>
    </TerminalFilePreviewCard>
  );
}
