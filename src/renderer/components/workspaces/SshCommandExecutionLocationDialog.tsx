import { Check, Desktop, HardDrives } from '@phosphor-icons/react';
import { useId } from 'react';

import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

import type { SshWorkspaceMode } from '@/types';
import type { Icon } from '@phosphor-icons/react';
import type React from 'react';

interface SshCommandExecutionLocationDialogProps {
  open: boolean;
  projectName: string;
  /** The SSH host's name, shown on the remote option when known. */
  hostName?: string;
  choice: SshWorkspaceMode;
  saving: boolean;
  error: string | null;
  onChoiceChange: (choice: SshWorkspaceMode) => void;
  onCancel: () => void;
  onConfirm: () => void;
}

export function SshCommandExecutionLocationDialog({
  open,
  projectName,
  hostName,
  choice,
  saving,
  error,
  onChoiceChange,
  onCancel,
  onConfirm,
}: SshCommandExecutionLocationDialogProps) {
  const local = choice === 'local-mirror-actions';

  return (
    <Dialog open={open} onOpenChange={(choiceOpen) => !choiceOpen && onCancel()}>
      <DialogContent>
        <DialogHeader className="pr-6">
          <DialogTitle>Where should Terminal Commands run by default?</DialogTitle>
          <DialogDescription>
            Applies to {projectName}. Change it in Project Settings, or override it for one command
            under Advanced when you edit it. Agents and Git always stay on the remote machine.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-3">
          <div
            role="group"
            aria-label="Where Terminal Commands run"
            className="grid grid-cols-1 gap-2"
          >
            <LocationCard
              icon={HardDrives}
              title="Remote machine"
              detail={hostName}
              hint="Best for web, backend, CLI, and library development"
              selected={!local}
              onSelect={() => onChoiceChange('remote')}
            >
              Runs next to your agents and code. Open a dev server from the Browser dropdown and its
              port is forwarded automatically.
            </LocationCard>
            <LocationCard
              icon={Desktop}
              title="This computer"
              hint="Best for desktop, mobile, and locally interactive apps"
              selected={local}
              onSelect={() => onChoiceChange('local-mirror-actions')}
            >
              Runs in a disposable local copy synced from the SSH workspace, so you can try the app
              by hand.
            </LocationCard>
          </div>

          {local && (
            <Callout tone="neutral" title="How the local copy works" className="leading-relaxed">
              <ul className="list-disc space-y-1 pl-4">
                <li>
                  Source syncs one way from the SSH workspace when it changes. Edits made in the
                  copy aren’t uploaded and are overwritten by the next sync.
                </li>
                <li>
                  Gitignored files, such as dependencies, build caches, and{' '}
                  <code className="font-mono">.env</code>, stay in the copy between syncs, so
                  install and add secrets there, or with Workspace Setup.
                </li>
                <li>Git metadata isn’t copied.</li>
              </ul>
            </Callout>
          )}
        </DialogBody>

        {error && (
          <p role="alert" className="text-sm text-error">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={saving} onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" disabled={saving} onClick={onConfirm}>
            {saving && <Spinner className="mr-1.5" />}
            {local ? 'Run on this computer' : 'Run remotely'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LocationCard({
  icon: CardIcon,
  title,
  detail,
  hint,
  selected,
  onSelect,
  children,
}: React.PropsWithChildren<{
  icon: Icon;
  title: string;
  detail?: string;
  hint: string;
  selected: boolean;
  onSelect: () => void;
}>) {
  const titleId = useId();
  const descriptionId = useId();
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onClick={onSelect}
      className={cn(
        'flex items-start gap-3 rounded-lg border p-3 text-left transition-all focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden',
        selected
          ? 'border-primary/50 bg-primary/5 ring-2 ring-primary/50'
          : 'border-border hover:bg-muted/50'
      )}
    >
      <CardIcon
        className={cn(
          'mt-0.5 size-4 shrink-0',
          selected ? 'text-primary' : 'text-muted-foreground'
        )}
      />
      <span className="block min-w-0 flex-1 space-y-0.5">
        <span className="flex min-w-0 items-baseline gap-2">
          <span id={titleId} className="shrink-0 text-sm font-medium">
            {title}
          </span>
          {detail && (
            <span className="truncate font-mono text-xs text-muted-foreground">{detail}</span>
          )}
        </span>
        <span id={descriptionId} className="block space-y-0.5 text-xs leading-relaxed">
          <span className="block font-medium text-foreground/80">{hint}</span>
          <span className="block text-muted-foreground">{children}</span>
        </span>
      </span>
      <span
        className={cn(
          'flex size-5 shrink-0 items-center justify-center rounded-full border',
          selected ? 'border-primary bg-primary' : 'border-border'
        )}
      >
        {selected && <Check className="size-3 text-primary-foreground" weight="bold" />}
      </span>
    </button>
  );
}
