import { Copy } from '@phosphor-icons/react';

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';

import { copyCommitHash } from './copy-commit-hash';

import type * as React from 'react';

/** A commit row's right-click menu. */
export function CommitContextMenu({ hash, children }: { hash: string; children: React.ReactNode }) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => copyCommitHash(hash)}>
          <Copy />
          Copy Commit Hash
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
