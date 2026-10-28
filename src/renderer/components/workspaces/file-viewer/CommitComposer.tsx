import { GitCommit, Sparkle } from '@phosphor-icons/react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { type CommitScope } from '@/types';

/** Git convention for summary length; longer summaries get cut off in many Git tools. */
const SUMMARY_GUIDE_LENGTH = 72;

interface CommitComposerProps {
  workspaceId: string;
  workingDirectory: string;
  disabled?: boolean;
  onCommitted: () => Promise<void> | void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  showTrigger?: boolean;
  isRemoteWorkspace?: boolean;
}

function formatFileCount(count: number): string {
  return `${count} changed ${count === 1 ? 'file' : 'files'}`;
}

function getErrorMessage(cause: unknown, fallback: string): string {
  if (!(cause instanceof Error)) return fallback;
  return cause.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}

export function CommitComposer({
  workspaceId,
  workingDirectory,
  disabled,
  onCommitted,
  open: controlledOpen,
  onOpenChange,
  showTrigger = true,
  isRemoteWorkspace = false,
}: CommitComposerProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [scope, setScope] = useState<CommitScope | null>(null);
  const [fileCount, setFileCount] = useState(0);
  // File counts per scope, known when Git reports staged changes the user could leave out.
  const [scopeCounts, setScopeCounts] = useState<Record<CommitScope, number> | null>(null);
  // True once the user types into the message, so Generate asks before replacing it.
  const [messageEdited, setMessageEdited] = useState(false);
  const [confirmingReplace, setConfirmingReplace] = useState(false);
  const [inspecting, setInspecting] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nothingToCommit, setNothingToCommit] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const wasOpenRef = useRef(false);

  const setOpen = (nextOpen: boolean) => {
    setInternalOpen(nextOpen);
    onOpenChange?.(nextOpen);
  };

  const generate = useCallback(async () => {
    if (inspecting || generating || submitting) return;
    // When the user picked a scope, draft from that scope; otherwise Git picks it again.
    const requestedScope = scopeCounts && scope ? scope : undefined;
    setConfirmingReplace(false);
    setGenerating(true);
    setError(null);
    setNothingToCommit(false);
    setSubject('');
    setBody('');
    setMessageEdited(false);
    if (!requestedScope) {
      setScope(null);
      setFileCount(0);
    }
    try {
      const draft = isRemoteWorkspace
        ? await window.api.generateWorkspaceCommitDraft(workspaceId)
        : await window.api.generateCommitDraft(workingDirectory, requestedScope);
      setSubject(draft.subject);
      setBody(draft.body ?? '');
      setScope(draft.scope);
      setFileCount(draft.fileCount);
      setError(draft.generationError ?? null);
    } catch (cause) {
      setError(getErrorMessage(cause, 'Could not generate a commit message'));
    } finally {
      setGenerating(false);
    }
  }, [
    generating,
    inspecting,
    isRemoteWorkspace,
    scope,
    scopeCounts,
    submitting,
    workingDirectory,
    workspaceId,
  ]);

  const requestGenerate = () => {
    if (messageEdited && (subject.trim() || body.trim())) {
      setConfirmingReplace(true);
      return;
    }
    void generate();
  };

  const inspectScope = useCallback(async () => {
    if (inspecting || generating || submitting) return;
    setInspecting(true);
    setError(null);
    setNothingToCommit(false);
    setSubject('');
    setBody('');
    setScope(null);
    setFileCount(0);
    setScopeCounts(null);
    setMessageEdited(false);
    setConfirmingReplace(false);
    try {
      const result = isRemoteWorkspace
        ? await window.api.inspectWorkspaceCommitScope(workspaceId)
        : await window.api.inspectCommitScope(workingDirectory);
      setScope(result.scope);
      setFileCount(result.fileCount);
      if (result.stagedFileCount && result.allFileCount !== undefined) {
        setScopeCounts({ staged: result.stagedFileCount, all: result.allFileCount });
      }
    } catch (cause) {
      const message = getErrorMessage(cause, 'Could not inspect changes');
      if (message === 'There are no changes to commit') {
        setNothingToCommit(true);
      } else {
        setError(message);
      }
    } finally {
      setInspecting(false);
    }
  }, [generating, inspecting, isRemoteWorkspace, submitting, workingDirectory, workspaceId]);

  useEffect(() => {
    if (open && !wasOpenRef.current && !scope) void inspectScope();
    wasOpenRef.current = open;
  }, [inspectScope, open, scope]);

  const handleOpenChange = (nextOpen: boolean) => {
    if (submitting) return;
    setOpen(nextOpen);
  };

  const submit = async () => {
    if (submitting || generating || inspecting || !scope) return;
    if (!subject.trim()) {
      setError('Commit subject is required');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const input = {
        subject: subject.trim(),
        body: body.trim() || null,
        scope,
      };
      await (isRemoteWorkspace
        ? window.api.commitWorkspaceChanges(workspaceId, input)
        : window.api.commitChanges(workingDirectory, input));
      setSubject('');
      setBody('');
      setScope(null);
      setFileCount(0);
      setScopeCounts(null);
      setMessageEdited(false);
      setConfirmingReplace(false);
      setOpen(false);
      const statusRefresh = isRemoteWorkspace
        ? Promise.resolve()
        : window.api.refreshGitStatus(workspaceId);
      await Promise.allSettled([statusRefresh, onCommitted()]);
    } catch (cause) {
      setError(getErrorMessage(cause, 'Commit failed'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <CommitComposerTrigger showTrigger={showTrigger} disabled={disabled} />
      <PopoverContent align="end" className="w-[380px] p-3">
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
          onKeyDown={(event) => {
            if (
              event.key === 'Enter' &&
              (event.metaKey || event.ctrlKey) &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              void submit();
            }
          }}
        >
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-medium">Commit changes</div>
              {scope && !scopeCounts && (
                <div className="text-xs text-muted-foreground">
                  {`${formatFileCount(fileCount)} · ${scope === 'staged' ? 'staged changes only' : 'all changes'}`}
                </div>
              )}
            </div>
            {!nothingToCommit && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 gap-1 px-2 text-xs"
                onClick={requestGenerate}
                disabled={inspecting || generating || submitting || !scope}
              >
                {generating ? <Spinner size="sm" /> : <Sparkle className="size-3.5" />}
                {subject && !messageEdited ? 'Regenerate' : 'Generate'}
              </Button>
            )}
          </div>

          {scopeCounts && !nothingToCommit && (
            <SegmentedControl
              aria-label="Changes to commit"
              value={scope ?? 'staged'}
              onValueChange={setScope}
              options={[
                { value: 'staged', label: `Staged (${scopeCounts.staged})` },
                { value: 'all', label: `All changes (${scopeCounts.all})` },
              ]}
              disabled={inspecting || generating || submitting}
              fill
            />
          )}

          {confirmingReplace && (
            <ReplaceMessageCallout
              onKeep={() => setConfirmingReplace(false)}
              onReplace={() => void generate()}
            />
          )}

          {nothingToCommit ? (
            <div aria-live="polite">
              <EmptyState
                size="sm"
                icon={<GitCommit weight="duotone" />}
                title="Nothing to commit"
                description="Your working tree is clean. Make a change, then try again."
              />
            </div>
          ) : (
            <CommitMessageFields
              subject={subject}
              body={body}
              inspecting={inspecting}
              generating={generating}
              disabled={inspecting || generating || submitting}
              onSubjectChange={(value) => {
                setSubject(value);
                setMessageEdited(true);
              }}
              onBodyChange={(value) => {
                setBody(value);
                setMessageEdited(true);
              }}
            />
          )}

          {error && (
            <Callout tone="error" size="sm" role="alert">
              {error}
            </Callout>
          )}

          <CommitComposerFooter
            showCommit={!nothingToCommit}
            scope={scope}
            submitting={submitting}
            submitDisabled={inspecting || generating || submitting || !scope || !subject.trim()}
            onCancel={() => setOpen(false)}
          />
        </form>
      </PopoverContent>
    </Popover>
  );
}

function CommitComposerTrigger({
  showTrigger,
  disabled,
}: {
  showTrigger: boolean;
  disabled?: boolean;
}) {
  if (!showTrigger) {
    return (
      <PopoverAnchor asChild>
        <span aria-hidden className="block size-0" />
      </PopoverAnchor>
    );
  }
  return (
    <PopoverTrigger asChild>
      <Button
        variant="secondary"
        size="sm"
        className="h-7 gap-1.5 px-2 text-xs font-normal"
        disabled={disabled}
      >
        <GitCommit className="size-3.5" />
        Commit changes…
      </Button>
    </PopoverTrigger>
  );
}

function ReplaceMessageCallout({
  onKeep,
  onReplace,
}: {
  onKeep: () => void;
  onReplace: () => void;
}) {
  return (
    <Callout
      tone="warning"
      size="sm"
      action={
        <>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={onKeep}
          >
            Keep mine
          </Button>
          <Button type="button" size="sm" className="h-6 px-2 text-xs" onClick={onReplace}>
            Replace
          </Button>
        </>
      }
    >
      Replace your message with a generated one?
    </Callout>
  );
}

function CommitMessageFields({
  subject,
  body,
  inspecting,
  generating,
  disabled,
  onSubjectChange,
  onBodyChange,
}: {
  subject: string;
  body: string;
  inspecting: boolean;
  generating: boolean;
  disabled: boolean;
  onSubjectChange: (subject: string) => void;
  onBodyChange: (body: string) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-3">
          <label className="block text-xs font-medium" htmlFor="commit-subject">
            Summary
          </label>
          <span
            id="commit-subject-length"
            title={`Summaries over ${SUMMARY_GUIDE_LENGTH} characters get cut off in many Git tools`}
            className={cn(
              'text-ui tabular-nums',
              subject.length > SUMMARY_GUIDE_LENGTH ? 'text-warning' : 'text-muted-foreground'
            )}
          >
            {subject.length}/{SUMMARY_GUIDE_LENGTH}
          </span>
        </div>
        <Input
          id="commit-subject"
          value={subject}
          onChange={(event) => onSubjectChange(event.target.value)}
          placeholder={
            inspecting
              ? 'Loading changes…'
              : generating
                ? 'Generating from changes…'
                : 'Summarize your changes'
          }
          className="h-9 text-sm"
          disabled={disabled}
          aria-describedby="commit-subject-length"
          autoFocus
        />
      </div>
      <div className="space-y-1.5">
        <label className="block text-xs font-medium" htmlFor="commit-body">
          Description <span className="font-normal text-muted-foreground">(optional)</span>
        </label>
        <Textarea
          id="commit-body"
          value={body}
          onChange={(event) => onBodyChange(event.target.value)}
          placeholder="Add context about what changed and why"
          className="min-h-24 resize-y"
          disabled={disabled}
        />
      </div>
    </div>
  );
}

function CommitComposerFooter({
  showCommit,
  scope,
  submitting,
  submitDisabled,
  onCancel,
}: {
  showCommit: boolean;
  scope: CommitScope | null;
  submitting: boolean;
  submitDisabled: boolean;
  onCancel: () => void;
}) {
  return (
    <div className="flex items-center justify-end gap-2">
      <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={submitting}>
        Cancel
      </Button>
      {showCommit && (
        <Button type="submit" size="sm" disabled={submitDisabled}>
          {submitting && <Spinner size="sm" className="mr-1.5" />}
          {scope === 'all' ? 'Stage all changes and commit' : 'Commit staged changes'}
        </Button>
      )}
    </div>
  );
}
