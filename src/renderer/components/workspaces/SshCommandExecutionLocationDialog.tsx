import { ArrowRight, Desktop, GitBranch, HardDrives, Robot } from '@phosphor-icons/react';
import { useId, useRef } from 'react';

import { ChoiceCheck, choiceClass } from '@/components/layout/OnboardingChrome';
import { Button } from '@/components/ui/button';
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

/**
 * Asks once per project where Terminal Commands run in its SSH workspaces. The two options are
 * drawn as the two machines, joined by the one-way sync that feeds the local copy, so the choice
 * reads as where things run rather than as two paragraphs.
 */
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
  const local = choice === 'local-copy-actions';
  const overrideHintId = useId();
  const host = hostName ?? 'the SSH host';
  const confirmRef = useRef<HTMLButtonElement>(null);

  return (
    <Dialog open={open} onOpenChange={(choiceOpen) => !choiceOpen && onCancel()}>
      <DialogContent
        className="sm:max-w-xl"
        // The confirm button, not the first card, takes focus: a focus ring on a card reads as a
        // second selection, and Enter then confirms the choice that's shown.
        onOpenAutoFocus={(event) => {
          const confirmButton = confirmRef.current;
          if (!confirmButton || confirmButton.disabled) return;
          event.preventDefault();
          confirmButton.focus();
        }}
      >
        <DialogHeader className="pr-6">
          <DialogTitle>Where should Terminal Commands run by default?</DialogTitle>
          <DialogDescription>
            Applies to {projectName}. You can change it later in Project Settings.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">
          <div
            role="group"
            aria-label="Where Terminal Commands run"
            aria-describedby={overrideHintId}
            className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:gap-0"
          >
            <MachineCard
              icon={HardDrives}
              title="Remote machine"
              detail={hostName && <span className="font-mono">{hostName}</span>}
              hint="Web, backend, CLI, and library work"
              selected={!local}
              onSelect={() => onChoiceChange('remote')}
              footer={
                <>
                  <Robot className="size-3.5" />
                  <GitBranch className="size-3.5" />
                  <span>Agents and Git stay here</span>
                </>
              }
            />
            <SyncLink active={local} />
            <MachineCard
              icon={Desktop}
              title="This computer"
              detail="Local copy"
              hint="Desktop, mobile, and locally interactive apps"
              selected={local}
              onSelect={() => onChoiceChange('local-copy-actions')}
              footer={<span>Synced from {host}, one way</span>}
            />
          </div>

          <div
            aria-live="polite"
            className="rounded-lg bg-muted/40 px-3.5 py-3 text-xs leading-relaxed text-muted-foreground"
          >
            {local ? (
              <>
                <p className="mb-1.5 font-medium text-foreground">How the Local copy works</p>
                <ul className="list-disc space-y-1 pl-4 marker:text-komla/70">
                  <li>
                    Source syncs from {host} whenever it changes. Edits made in the Local copy
                    aren’t uploaded, and the next sync overwrites them.
                  </li>
                  <li>
                    Gitignored files, such as dependencies, build caches, and{' '}
                    <code className="font-mono text-foreground/80">.env</code>, stay in the Local
                    copy between syncs, so install and add secrets there, or with Workspace Setup.
                  </li>
                  <li>Git metadata isn’t copied.</li>
                </ul>
              </>
            ) : (
              <p>
                Commands run next to your agents and code. Open a dev server from the Browser
                dropdown and Komla forwards its port to this computer.
              </p>
            )}
          </div>

          <p id={overrideHintId} className="text-xs text-muted-foreground">
            Want one command somewhere else, such as a dev server or test run? Override this default
            for that Quick Command under Advanced.
          </p>
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
          <Button ref={confirmRef} type="button" disabled={saving} onClick={onConfirm}>
            {saving && <Spinner className="mr-1.5" />}
            {local ? 'Run on this computer' : 'Run remotely'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The one-way sync between the two machines; lit while the local copy is chosen. */
function SyncLink({ active }: { active: boolean }) {
  return (
    <div
      aria-hidden
      className={cn(
        'hidden w-12 flex-col items-center justify-center gap-1 transition-colors duration-200 sm:flex',
        active ? 'text-komla' : 'text-muted-foreground/40'
      )}
    >
      <span className="flex w-full items-center">
        <span
          className={cn(
            'h-px flex-1 border-t transition-colors duration-200',
            active ? 'border-solid border-komla/70' : 'border-dashed border-border'
          )}
        />
        <ArrowRight
          weight="bold"
          className={cn(
            '-ml-0.5 size-3 transition-transform duration-200 motion-reduce:transition-none',
            active && 'translate-x-0.5'
          )}
        />
      </span>
      <span className="text-[10px] leading-none">sync</span>
    </div>
  );
}

function MachineCard({
  icon: CardIcon,
  title,
  detail,
  hint,
  selected,
  onSelect,
  footer,
}: {
  icon: Icon;
  title: string;
  detail?: React.ReactNode;
  hint: string;
  selected: boolean;
  onSelect: () => void;
  footer: React.ReactNode;
}) {
  const titleId = useId();
  const descriptionId = useId();
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onClick={onSelect}
      className={cn('flex flex-col gap-3 rounded-xl p-4 text-left', choiceClass(selected))}
    >
      <span className="flex w-full items-start justify-between">
        <span
          className={cn(
            'flex size-10 items-center justify-center rounded-lg transition-colors',
            selected ? 'bg-komla/15 text-komla' : 'bg-muted text-muted-foreground'
          )}
        >
          <CardIcon className="size-5" />
        </span>
        {selected ? (
          <ChoiceCheck />
        ) : (
          <span className="m-0.5 size-4 rounded-full ring-1 ring-border ring-inset" />
        )}
      </span>

      <span className="block min-w-0 space-y-0.5">
        <span id={titleId} className="block text-sm font-medium">
          {title}
        </span>
        {detail && <span className="block truncate text-xs text-muted-foreground">{detail}</span>}
      </span>

      <span id={descriptionId} className="block text-xs leading-relaxed text-foreground/80">
        {hint}
      </span>

      <span
        className={cn(
          'mt-auto flex items-center gap-1.5 border-t pt-2.5 text-[11px] transition-colors',
          selected ? 'border-komla/20 text-komla' : 'border-border text-muted-foreground'
        )}
      >
        {footer}
      </span>
    </button>
  );
}
