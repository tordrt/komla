import { useRef } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useOpenFolderStore } from '@/stores/open-folder.store';

/** Asks whether a Git repository picked with Open Folder becomes a project. */
export function OpenFolderDialogHost() {
  const open = useOpenFolderStore((s) => s.open);
  const folder = useOpenFolderStore((s) => s.folder);
  const repoRoot = useOpenFolderStore((s) => s.repoRoot);
  const answer = useOpenFolderStore((s) => s.answer);
  const addRef = useRef<HTMLButtonElement>(null);
  const name = repoRoot.split(/[/\\]/).filter(Boolean).pop() ?? repoRoot;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) answer(null);
      }}
    >
      <DialogContent
        className="sm:max-w-md"
        onOpenAutoFocus={(event) => {
          // Adding the project is the recommended answer, so Enter picks it.
          event.preventDefault();
          addRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle className="truncate">Add {name} as a project?</DialogTitle>
          <DialogDescription className="break-words">
            {folder === repoRoot
              ? 'This folder is a Git repository.'
              : `This folder is inside the Git repository at ${repoRoot}, which Add as project adds.`}{' '}
            As a project, each workspace gets its own worktree and branch. Opened as a folder, the
            workspace works in the folder itself, on whatever branch is checked out.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => answer('folder')}>
            Open folder only
          </Button>
          <Button ref={addRef} onClick={() => answer('project')}>
            Add as project
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
