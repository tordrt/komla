import { FolderOpen } from '@phosphor-icons/react';

import { useFolderDrop } from '@/hooks/useFolderDrop';
import { cn } from '@/lib/utils';

import type { ReactNode } from 'react';

/** Opens a folder dropped on it from outside Komla, outlining itself while one is dragged over. */
export function FolderDropZone({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  const { isDraggingOver, dropHandlers } = useFolderDrop();
  return (
    <div className={cn('relative', className)} {...dropHandlers}>
      {children}
      {isDraggingOver && (
        <div className="pointer-events-none absolute inset-1.5 flex flex-col items-center justify-center gap-1.5 rounded-lg border-2 border-dashed border-primary/60 bg-card/95 text-xs font-medium text-foreground">
          <FolderOpen aria-hidden="true" className="size-5 text-primary" />
          Drop a folder to open it
        </div>
      )}
    </div>
  );
}
