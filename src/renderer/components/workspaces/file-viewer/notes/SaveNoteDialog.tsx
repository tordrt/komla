import { useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

interface SaveNoteDialogProps {
  open: boolean;
  /** Where the note is saved unless the user changes it, relative to the workspace. */
  defaultPath: string;
  onCancel: () => void;
  /** Saves the note at the path; resolves to an error to show, or null once saved. */
  onSave: (path: string) => Promise<string | null>;
}

/**
 * Asks where in the project to save a note; the only time a note needs a name.
 * Give it a new key for each opening, so it starts from defaultPath.
 */
export function SaveNoteDialog({ open, defaultPath, onCancel, onSave }: SaveNoteDialogProps) {
  const [path, setPath] = useState(defaultPath);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const save = async () => {
    if (saving || !path.trim()) return;
    setSaving(true);
    try {
      setError(await onSave(path));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) onCancel();
      }}
    >
      <DialogContent
        className="max-w-md"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          const input = inputRef.current;
          if (!input) return;
          input.focus();
          // Select the name, so typing replaces it and keeps the extension.
          const dot = defaultPath.lastIndexOf('.');
          input.setSelectionRange(0, dot > 0 ? dot : defaultPath.length);
        }}
      >
        <DialogHeader>
          <DialogTitle>Save to project</DialogTitle>
          <DialogDescription>
            Saves the note as a file in this workspace and removes it from Notes.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <label htmlFor="save-note-path" className="text-xs font-medium text-muted-foreground">
            Path in the project
          </label>
          <Input
            ref={inputRef}
            id="save-note-path"
            value={path}
            onChange={(event) => {
              setPath(event.target.value);
              setError(null);
            }}
            aria-invalid={!!error}
            aria-describedby={error ? 'save-note-error' : undefined}
            spellCheck={false}
            autoComplete="off"
          />
          {error && (
            <p id="save-note-error" role="alert" className="text-xs text-error">
              {error}
            </p>
          )}
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button disabled={saving || !path.trim()} onClick={() => void save()}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
