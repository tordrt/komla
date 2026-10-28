import { Folder } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';

import { openFolder } from '@/lib/open-folder';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/config.store';

const SHOWN_FOLDERS = 5;

/** The folders opened last, to open again from a window without workspaces. */
export function RecentFolders({ className }: { className?: string }) {
  // Main says which are still there whenever the list changes.
  const storedFolders = useConfigStore((state) => state.config?.recentFolders);
  const [recentFolders, setRecentFolders] = useState<string[]>([]);
  useEffect(() => {
    let current = true;
    window.api
      .getRecentFolders()
      .then((folders) => current && setRecentFolders(folders))
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [storedFolders]);
  if (recentFolders.length === 0) return null;

  return (
    // Full width, so it takes a line of its own below the empty-state button.
    <section aria-labelledby="recent-folders" className={cn('w-full basis-full', className)}>
      <h3
        id="recent-folders"
        className="mx-auto max-w-sm px-2 pb-1 text-left text-2xs font-medium text-muted-foreground"
      >
        Recent folders
      </h3>
      <ul className="mx-auto max-w-sm text-left">
        {recentFolders.slice(0, SHOWN_FOLDERS).map((folder) => {
          const name = folder.split(/[\\/]/).filter(Boolean).pop() ?? folder;
          return (
            <li key={folder}>
              <button
                type="button"
                title={folder}
                onClick={() => void openFolder(folder)}
                className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-accent/50 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden"
              >
                <Folder aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="shrink-0 text-foreground">{name}</span>
                {/* rtl truncates from the left; bdi keeps the path itself in LTR order */}
                <span
                  className="min-w-0 truncate font-mono text-2xs text-muted-foreground"
                  dir="rtl"
                >
                  <bdi>{folder}</bdi>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
