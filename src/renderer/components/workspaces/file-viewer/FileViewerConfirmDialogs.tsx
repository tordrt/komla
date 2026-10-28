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
import {
  describeFileViewerTransition,
  type FileViewerTransition,
} from '@/lib/file-viewer-transition';

import type { FileChange } from '@/types';

interface ConfirmDialogsProps {
  // Delete
  fileToDelete: { path: string; isDirectory: boolean } | null;
  /** An SSH workspace deletes with rm, while a local one moves to the trash. */
  deletesPermanently: boolean;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
  // Create
  createTarget: { parentDir: string; type: 'file' | 'directory' } | null;
  createValue: string;
  onCreateValueChange: (value: string) => void;
  onCancelCreate: () => void;
  onConfirmCreate: () => void;
  // Restore
  fileToRestore: { path: string; status: FileChange['status'] } | null;
  onCancelRestore: () => void;
  onConfirmRestore: () => void;
  // Rollback all
  rollbackAllConfirmOpen: boolean;
  onCancelRollbackAll: () => void;
  onConfirmRollbackAll: () => void;
  // Unsaved changes
  unsavedConfirmOpen: boolean;
  pendingTransition: FileViewerTransition | null;
  onCancelUnsaved: () => void;
  onConfirmDiscard: () => void;
  // Overwrite
  overwriteTarget: { src: string; dest: string; isDirectory: boolean } | null;
  onCancelOverwrite: () => void;
  onConfirmOverwrite: () => void;
  // Conflict
  conflictDialogOpen: boolean;
  conflictFilePath: string | null | undefined;
  onKeepMyChanges: () => void;
  onReloadFromDisk: () => void;
}

function restoreTitle(status: FileChange['status'] | undefined): string {
  if (status === 'deleted') return 'Restore Deleted File';
  if (status === 'untracked' || status === 'added') return 'Remove New File';
  return 'Rollback Changes';
}

function restoreActionLabel(status: FileChange['status'] | undefined): string {
  if (status === 'deleted') return 'Restore';
  if (status === 'untracked' || status === 'added') return 'Remove';
  return 'Rollback';
}

function overwriteParentDir(dest: string): string {
  return dest.includes('/') ? dest.slice(0, dest.lastIndexOf('/')) : 'the root directory';
}

export function FileViewerConfirmDialogs({
  fileToDelete,
  deletesPermanently,
  onCancelDelete,
  onConfirmDelete,
  createTarget,
  createValue,
  onCreateValueChange,
  onCancelCreate,
  onConfirmCreate,
  fileToRestore,
  onCancelRestore,
  onConfirmRestore,
  rollbackAllConfirmOpen,
  onCancelRollbackAll,
  onConfirmRollbackAll,
  unsavedConfirmOpen,
  pendingTransition,
  onCancelUnsaved,
  onConfirmDiscard,
  overwriteTarget,
  onCancelOverwrite,
  onConfirmOverwrite,
  conflictDialogOpen,
  conflictFilePath,
  onKeepMyChanges,
  onReloadFromDisk,
}: ConfirmDialogsProps) {
  // Destructive dialogs focus Cancel so Delete-then-Enter can't confirm by accident,
  // except a delete that goes to the trash.
  const deleteCancelRef = useRef<HTMLButtonElement>(null);
  const deleteConfirmRef = useRef<HTMLButtonElement>(null);
  const restoreCancelRef = useRef<HTMLButtonElement>(null);
  const overwriteCancelRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      {/* Delete confirmation */}
      <Dialog
        open={fileToDelete !== null}
        onOpenChange={(open) => {
          if (!open) onCancelDelete();
        }}
      >
        <DialogContent
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            (deletesPermanently ? deleteCancelRef : deleteConfirmRef).current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>{fileToDelete?.isDirectory ? 'Delete Folder' : 'Delete File'}</DialogTitle>
            <DialogDescription>
              {fileToDelete?.isDirectory ? (
                <>
                  Are you sure you want to delete <strong>{fileToDelete.path}</strong> and all of
                  its contents?
                </>
              ) : (
                <>
                  Are you sure you want to delete <strong>{fileToDelete?.path}</strong>?
                </>
              )}
              {deletesPermanently && ' It is deleted permanently on the remote host.'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button ref={deleteCancelRef} variant="outline" onClick={onCancelDelete}>
              Cancel
            </Button>
            <Button ref={deleteConfirmRef} variant="destructive" onClick={onConfirmDelete}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create file/folder dialog */}
      <Dialog
        open={createTarget !== null}
        onOpenChange={(open) => {
          if (!open) onCancelCreate();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{createTarget?.type === 'file' ? 'New File' : 'New Folder'}</DialogTitle>
            <DialogDescription>
              {createTarget?.parentDir ? (
                <>
                  Enter a name for the new {createTarget.type === 'file' ? 'file' : 'folder'} in{' '}
                  <strong>{createTarget.parentDir}</strong>
                </>
              ) : (
                <>Enter a name for the new {createTarget?.type === 'file' ? 'file' : 'folder'}</>
              )}
            </DialogDescription>
          </DialogHeader>
          <input
            type="text"
            value={createValue}
            onChange={(e) => onCreateValueChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                onConfirmCreate();
              }
            }}
            placeholder={createTarget?.type === 'file' ? 'filename.txt' : 'folder-name'}
            className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm ring-offset-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={onCancelCreate}>
              Cancel
            </Button>
            <Button onClick={onConfirmCreate} disabled={!createValue.trim()}>
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Restore confirmation */}
      <Dialog
        open={fileToRestore !== null}
        onOpenChange={(open) => {
          if (!open) onCancelRestore();
        }}
      >
        <DialogContent
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            restoreCancelRef.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>{restoreTitle(fileToRestore?.status)}</DialogTitle>
            <DialogDescription>
              {fileToRestore?.status === 'deleted' ? (
                <>
                  Are you sure you want to restore <strong>{fileToRestore.path}</strong> to its last
                  committed state?
                </>
              ) : fileToRestore?.status === 'untracked' || fileToRestore?.status === 'added' ? (
                <>
                  Are you sure you want to remove <strong>{fileToRestore?.path}</strong>? This file
                  will be deleted.
                </>
              ) : (
                <>
                  Are you sure you want to rollback all changes to{' '}
                  <strong>{fileToRestore?.path}</strong>? This will restore it to its last committed
                  state.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button ref={restoreCancelRef} variant="outline" onClick={onCancelRestore}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={onConfirmRestore}>
              {restoreActionLabel(fileToRestore?.status)}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rollback all confirmation */}
      <Dialog
        open={rollbackAllConfirmOpen}
        onOpenChange={(open) => {
          if (!open) onCancelRollbackAll();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rollback All Changes</DialogTitle>
            <DialogDescription>
              Are you sure you want to rollback all uncommitted changes? This will restore all
              modified files to their last committed state and remove untracked files.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={onCancelRollbackAll}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={onConfirmRollbackAll}>
              Rollback All
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Unsaved changes confirmation */}
      <Dialog
        open={unsavedConfirmOpen}
        onOpenChange={(open) => {
          if (!open) onCancelUnsaved();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Unsaved Changes</DialogTitle>
            <DialogDescription>
              You have unsaved changes. Are you sure you want to{' '}
              {describeFileViewerTransition(pendingTransition)}?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={onCancelUnsaved}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={onConfirmDiscard}>
              Discard
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Overwrite confirmation */}
      <Dialog
        open={overwriteTarget !== null}
        onOpenChange={(open) => {
          if (!open) onCancelOverwrite();
        }}
      >
        <DialogContent
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            overwriteCancelRef.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>File Already Exists</DialogTitle>
            <DialogDescription>
              <strong>{overwriteTarget?.dest.split('/').pop()}</strong> already exists in{' '}
              {overwriteTarget ? overwriteParentDir(overwriteTarget.dest) : ''}. Do you want to
              overwrite it?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button ref={overwriteCancelRef} variant="outline" onClick={onCancelOverwrite}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={onConfirmOverwrite}>
              Overwrite
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* External change conflict resolution */}
      <Dialog
        open={conflictDialogOpen}
        onOpenChange={(open) => {
          if (!open) onKeepMyChanges();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>File Changed Externally</DialogTitle>
            <DialogDescription>
              <strong>{conflictFilePath?.split('/').pop()}</strong> has been modified on disk while
              you have unsaved changes. What would you like to do?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={onKeepMyChanges}>
              Keep My Changes
            </Button>
            <Button variant="destructive" onClick={onReloadFromDisk}>
              Reload from Disk
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
