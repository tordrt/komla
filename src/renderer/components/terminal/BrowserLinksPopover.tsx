import { useMemo, useRef, useState, type ReactNode } from 'react';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { openTerminalUrl } from '@/lib/open-terminal-url';
import { openFilePane } from '@/lib/pane-surfaces';
import { openVirtualDesktop } from '@/lib/virtual-desktops';
import { useQuickLookStore } from '@/stores/quick-look.store';
import { formatShortcutForDisplay } from '@/stores/shortcuts.store';

import { getViewableFileKind } from '../../../shared/image-utils';

import { BrowserLinksList, type BrowserLinkPick } from './BrowserLinksList';
import {
  openTerminalFile,
  rememberTerminalFiles,
  terminalFileViewerItem,
  useTerminalFiles,
} from './terminal-files';

import type { OpenInTarget } from './OpenInPaneMenu';
import type { TerminalFile } from '@/stores/terminal-files.store';

// Pages, then Markdown, then pictures: what an agent most often makes for you to look at.
const FILE_KIND_RANK: Partial<Record<string, number>> = { html: 0, markdown: 1, image: 2, svg: 2 };

function fileKindRank(file: TerminalFile): number {
  return FILE_KIND_RANK[getViewableFileKind(file.path) ?? ''] ?? 3;
}

/**
 * The globe button's list: the workspace's servers, then its virtual desktops from
 * `komla desktop run`, which open in this computer's VNC app where it has one, then the links its terminals
 * printed or you opened, which open in the default browser (Shift: in Komla's browser;
 * right-click: in a new tab or split), then their files, which open as clicking their
 * links would. A server on an SSH host is
 * forwarded to this computer first. The terminals' files are read once the pointer or
 * focus reaches the button, so the list is ready by the click. The arrow keys and
 * Enter pick a row.
 */
export function BrowserLinksPopover({
  workspaceId,
  children,
}: {
  workspaceId: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const openInViewer = useQuickLookStore((s) => s.open);
  const fileGroups = useTerminalFiles(workspaceId);
  // Each kind keeps the opened files first, then the latest.
  const files = useMemo(
    () =>
      [...fileGroups.opened, ...fileGroups.mentioned].sort(
        (a, b) => fileKindRank(a) - fileKindRank(b)
      ),
    [fileGroups]
  );
  const remember = () => rememberTerminalFiles(workspaceId);

  const openPick = (picked: BrowserLinkPick, target: OpenInTarget) => {
    setOpen(false);
    const url = picked.kind === 'server' ? picked.candidate.url : picked.link.url;
    openTerminalUrl(url, target, {
      workspaceId,
      executionLocation: picked.kind === 'server' ? picked.candidate.executionLocation : undefined,
    });
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) remember();
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild onPointerEnter={remember} onFocus={remember}>
        {children}
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        className="flex max-h-[min(36rem,var(--radix-popover-content-available-height))] w-96 flex-col p-0"
        onOpenAutoFocus={(event) => {
          // The list takes focus, so the arrow keys move through its rows from the first.
          event.preventDefault();
          listRef.current?.focus();
        }}
      >
        <BrowserLinksList
          workspaceId={workspaceId}
          onPick={(picked, { shiftKey }) => openPick(picked, shiftKey ? 'preview' : 'external')}
          onPickIn={openPick}
          opensExternally
          emptyText="No running servers, links or files yet."
          desktops={{
            onOpen: (desktop, target) => {
              setOpen(false);
              openVirtualDesktop(workspaceId, desktop, target);
            },
          }}
          files={{
            files,
            onPick: (file) => {
              setOpen(false);
              openTerminalFile(file);
            },
            onOpenAll: () => {
              setOpen(false);
              openInViewer(workspaceId, terminalFileViewerItem(files[0]));
            },
            onOpenInPane: (file, placement) => {
              if (file.target.type !== 'workspace') return;
              setOpen(false);
              openFilePane(workspaceId, file.target.filePath, placement, file.lineNumber);
            },
          }}
          listRef={listRef}
          className="flex-1"
        />
        <div className="shrink-0 border-t border-border/60 px-3 py-2 text-2xs text-muted-foreground">
          {formatShortcutForDisplay('Shift+Click', window.api.platform)} opens in Komla ·
          Right-click for a new tab or split
        </div>
      </PopoverContent>
    </Popover>
  );
}
