import { File as FileIcon, ImageSquare, X } from '@phosphor-icons/react';
import { useEffect, useEffectEvent, useState } from 'react';

import { IconButton } from '@/components/ui/icon-button';
import { hasFileDrop } from '@/lib/file-drop';

import { isImageFile } from '../../../shared/image-utils';
import { MAX_PROMPT_ATTACHMENTS } from '../../../shared/types/workspace';

export function attachmentName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/** Adds paths not already attached, up to the most one prompt carries. */
export function addPromptAttachments(current: string[], paths: string[]): string[] {
  const next = [...current];
  for (const path of paths) {
    if (next.length >= MAX_PROMPT_ATTACHMENTS) break;
    if (!next.includes(path)) next.push(path);
  }
  return next;
}

export interface TransferFile {
  file: File;
  path: string;
}

/**
 * The files on disk in a paste or drop. Folders are left out where Chromium
 * tells them apart, and so are images that only exist in memory.
 */
export function getTransferFiles(
  dataTransfer: DataTransfer,
  getPathForFile: (file: File) => string
): TransferFile[] {
  const files: TransferFile[] = [];
  for (const item of Array.from(dataTransfer.items)) {
    if (item.kind !== 'file') continue;
    if (item.webkitGetAsEntry?.()?.isDirectory) continue;
    const file = item.getAsFile();
    const path = file ? getPathForFile(file) : '';
    if (file && path) files.push({ file, path });
  }
  return files;
}

/**
 * Paths of the files that can be read. Reading a folder fails, which catches
 * pasted folders on platforms where Chromium doesn't flag them as folders.
 */
export async function readableFilePaths(files: TransferFile[]): Promise<string[]> {
  const readable = await Promise.all(
    files.map(({ file }) =>
      file
        .slice(0, 1)
        .arrayBuffer()
        .then(
          () => true,
          () => false
        )
    )
  );
  return files.filter((_, i) => readable[i]).map(({ path }) => path);
}

/** Whether a paste holds an image that only exists on the clipboard, like a screenshot. */
export function hasClipboardImage(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.items).some(
    (item) => item.kind === 'file' && item.type.startsWith('image/')
  );
}

/**
 * Takes files dropped anywhere in the window while `enabled`, so a drop needn't
 * hit the prompt. Returns whether files are being dragged over the window.
 */
export function useWindowFileDrop(
  enabled: boolean,
  onDrop: (dataTransfer: DataTransfer) => void
): boolean {
  const [isDragging, setIsDragging] = useState(false);
  const handleDrop = useEffectEvent(onDrop);

  useEffect(() => {
    if (!enabled) return;
    // dragenter and dragleave fire for every element crossed, so count them.
    let depth = 0;
    const onDragEnter = (e: DragEvent) => {
      if (!e.dataTransfer || !hasFileDrop(e.dataTransfer)) return;
      depth++;
      setIsDragging(true);
    };
    const onDragOver = (e: DragEvent) => {
      if (!e.dataTransfer || !hasFileDrop(e.dataTransfer)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    };
    const onDragLeave = (e: DragEvent) => {
      if (!e.dataTransfer || !hasFileDrop(e.dataTransfer)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setIsDragging(false);
    };
    const onDragEnd = () => {
      depth = 0;
      setIsDragging(false);
    };
    const onWindowDrop = (e: DragEvent) => {
      onDragEnd();
      // Something under the pointer, like another dialog, already took it.
      if (e.defaultPrevented || !e.dataTransfer || !hasFileDrop(e.dataTransfer)) return;
      e.preventDefault();
      handleDrop(e.dataTransfer);
    };
    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('dragend', onDragEnd);
    window.addEventListener('drop', onWindowDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('dragend', onDragEnd);
      window.removeEventListener('drop', onWindowDrop);
      setIsDragging(false);
    };
  }, [enabled]);

  return isDragging;
}

export function DropToAttachOverlay() {
  return (
    <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center rounded-lg border-2 border-primary/60 bg-background/60 text-sm font-medium text-foreground backdrop-blur-[1px] reduce-effects:bg-background/90">
      Drop to attach
    </div>
  );
}

interface PromptAttachmentListProps {
  attachments: string[];
  onRemove: (path: string) => void;
}

export function PromptAttachmentList({ attachments, onRemove }: PromptAttachmentListProps) {
  if (attachments.length === 0) return null;
  return (
    <ul aria-label="Attachments" className="mt-1.5 flex flex-wrap gap-1.5">
      {attachments.map((path) => {
        const name = attachmentName(path);
        const Icon = isImageFile(path) ? ImageSquare : FileIcon;
        return (
          <li
            key={path}
            className="flex max-w-[240px] items-center gap-1 rounded-md border bg-muted/40 py-0.5 pr-0.5 pl-1.5 text-xs text-muted-foreground"
          >
            <Icon className="size-3.5 shrink-0" />
            <span className="truncate" title={path}>
              {name}
            </span>
            <IconButton
              label={`Remove ${name}`}
              size="xs"
              tooltipSide="bottom"
              className="size-5 shrink-0 rounded hover:text-foreground"
              onClick={() => onRemove(path)}
            >
              <X className="size-3" />
            </IconButton>
          </li>
        );
      })}
    </ul>
  );
}
