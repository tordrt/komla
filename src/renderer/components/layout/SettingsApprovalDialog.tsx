import { ShieldCheck } from '@phosphor-icons/react';
import { useEffect, useId, useState, type ReactNode } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { longestCommonSubsequence } from '@/lib/longest-common-subsequence';
import { endAppearancePreview, previewAppearance } from '@/lib/theme-palette';
import { cn } from '@/lib/utils';

import type { BadgeTone } from '@/components/ui/badge';
import type { SettingsApprovalDecision, SettingsApprovalPrompt } from '@/types';

const operationLabels = {
  add: 'Add',
  edit: 'Edit',
  delete: 'Delete',
  change: 'Change',
} as const;

const operationTones: Record<keyof typeof operationLabels, BadgeTone> = {
  add: 'success',
  edit: 'info',
  delete: 'error',
  change: 'info',
};

const MAX_VISIBLE_CHANGES = 12;

const codeBlockClassName =
  'max-h-36 overflow-auto rounded bg-background/80 font-mono text-xs leading-5 break-words whitespace-pre-wrap text-foreground';

type DiffLine = { kind: 'same' | 'removed' | 'added'; text: string };

/** Lines both versions keep, in order, with the ones only one of them has between. */
function diffLines(before: string[], after: string[]): DiffLine[] {
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  for (const [keptI, keptJ] of longestCommonSubsequence(before, after)) {
    while (i < keptI) lines.push({ kind: 'removed', text: before[i++] });
    while (j < keptJ) lines.push({ kind: 'added', text: after[j++] });
    lines.push({ kind: 'same', text: before[i++] });
    j++;
  }
  while (i < before.length) lines.push({ kind: 'removed', text: before[i++] });
  while (j < after.length) lines.push({ kind: 'added', text: after[j++] });
  return lines;
}

const isWordBoundary = (text: string, index: number) =>
  index === 0 || index === text.length || /\s/.test(text[index - 1]) || /\s/.test(text[index]);

/** Where two versions of a line start and stop differing, at whole words. */
function changedSpan(before: string, after: string): { start: number; end: number } {
  const shorter = Math.min(before.length, after.length);
  let start = 0;
  while (start < shorter && before[start] === after[start]) start++;
  while (start > 0 && !(isWordBoundary(before, start) && isWordBoundary(after, start))) start--;
  let end = 0;
  while (end < shorter - start && before.at(-end - 1) === after.at(-end - 1)) end++;
  while (
    end > 0 &&
    !(isWordBoundary(before, before.length - end) && isWordBoundary(after, after.length - end))
  )
    end--;
  return { start, end };
}

function DiffLineText({ text, span }: { text: string; span?: { start: number; end: number } }) {
  if (!span) return text;
  // The spaces around the changed words stay unmarked.
  const changed = text.slice(span.start, text.length - span.end);
  const middle = changed.trim();
  if (!middle) return text;
  const start = span.start + changed.indexOf(middle);
  const end = start + middle.length;
  return (
    <>
      {text.slice(0, start)}
      <mark className="rounded-sm bg-current/20 px-0.5 text-inherit">{middle}</mark>
      {text.slice(end)}
    </>
  );
}

function LabeledContent({ label, children }: { label: string; children: ReactNode }) {
  const labelId = useId();
  return (
    <figure aria-labelledby={labelId} className="mt-2">
      <figcaption id={labelId} className="text-xs text-muted-foreground">
        {label}
      </figcaption>
      {children}
    </figure>
  );
}

/** One block with what an edit removes and adds, instead of the old and new versions in full. */
function ContentDiff({ label, before, after }: { label: string; before: string; after: string }) {
  const lines = diffLines(before.split('\n'), after.split('\n'));
  const removed = lines.filter((line) => line.kind === 'removed');
  const added = lines.filter((line) => line.kind === 'added');
  // A single line replaced in place marks the words that change within it.
  const replaced =
    removed.length === 1 && added.length === 1 && lines[lines.indexOf(removed[0]) + 1] === added[0];
  const changed = replaced ? changedSpan(removed[0].text, added[0].text) : undefined;
  // A line that changes as a whole has nothing to single out.
  const kept =
    changed &&
    removed[0].text.slice(0, changed.start) +
      removed[0].text.slice(removed[0].text.length - changed.end);
  const span = kept?.trim() ? changed : undefined;

  return (
    <LabeledContent label={label}>
      <div className={cn('mt-1', codeBlockClassName)}>
        {lines.map((line, index) => {
          const sign = line.kind === 'removed' ? '−' : line.kind === 'added' ? '+' : ' ';
          const content = (
            <>
              <span aria-hidden="true" className="w-5 shrink-0 text-center select-none">
                {sign}
              </span>
              <span className="min-w-0 pr-2.5">
                <DiffLineText text={line.text} span={line.kind === 'same' ? undefined : span} />
              </span>
            </>
          );
          const key = `${line.kind}:${index}`;
          if (line.kind === 'removed') {
            return (
              <del key={key} className="flex bg-error/10 text-error no-underline">
                {content}
              </del>
            );
          }
          if (line.kind === 'added') {
            return (
              <ins key={key} className="flex bg-success/10 text-success no-underline">
                {content}
              </ins>
            );
          }
          return (
            <div key={key} className="flex text-muted-foreground">
              {content}
            </div>
          );
        })}
      </div>
    </LabeledContent>
  );
}

export function SettingsApprovalDialog() {
  const [queue, setQueue] = useState<SettingsApprovalPrompt[]>([]);
  const [submitting, setSubmitting] = useState<SettingsApprovalDecision | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Long lists start collapsed; the prompt the user expanded stays expanded.
  const [expandedPromptId, setExpandedPromptId] = useState<string | null>(null);
  const active = queue[0];
  const showAllChanges = active !== undefined && expandedPromptId === active.id;
  const visibleChanges =
    (showAllChanges ? active.changes : active?.changes.slice(0, MAX_VISIBLE_CHANGES)) ?? [];
  const hiddenChangeCount = active ? active.changes.length - visibleChanges.length : 0;
  const preview = active?.preview;

  // Show proposed appearance live until the prompt ends, however it ends.
  useEffect(() => {
    if (!preview) return;
    previewAppearance(preview);
    return () => {
      void endAppearancePreview();
    };
  }, [preview]);

  useEffect(() => {
    const removeRequested = window.api.onSettingsApprovalRequested((prompt) => {
      setQueue((current) =>
        current.some((candidate) => candidate.id === prompt.id) ? current : [...current, prompt]
      );
    });
    const removeDismissed = window.api.onSettingsApprovalDismissed((id) => {
      setQueue((current) => current.filter((prompt) => prompt.id !== id));
    });
    // Recover a prompt delivered while this listener was mounting or remounting.
    void window.api.requestPendingSettingsApproval();
    return () => {
      removeRequested();
      removeDismissed();
    };
  }, []);

  const decide = async (decision: SettingsApprovalDecision): Promise<void> => {
    if (!active || submitting) return;
    const id = active.id;
    setSubmitting(decision);
    setError(null);
    try {
      await window.api.resolveSettingsApproval(id, decision);
      setQueue((current) => current.filter((prompt) => prompt.id !== id));
    } catch (decisionError) {
      setError(
        decisionError instanceof Error
          ? decisionError.message
          : 'Komla could not submit this decision.'
      );
    } finally {
      setSubmitting(null);
    }
  };

  return (
    <Dialog
      open={Boolean(active)}
      onOpenChange={(open) => {
        if (!open) void decide('cancel');
      }}
    >
      <DialogContent
        className="max-w-2xl gap-0 overflow-hidden p-0"
        showCloseButton={false}
        // A preview needs the window behind the dialog to stay visible.
        overlayClassName={preview ? 'bg-black/10 backdrop-blur-none' : undefined}
        // Clicking the previewed window to look closer shouldn't cancel the change.
        onInteractOutside={preview ? (event) => event.preventDefault() : undefined}
      >
        {active && (
          <>
            <DialogHeader className="border-b border-border px-5 py-4">
              <div className="flex items-start gap-3">
                <div className="rounded-md bg-primary/10 p-1.5 text-primary">
                  <ShieldCheck className="size-4" weight="duotone" />
                </div>
                <div className="min-w-0 space-y-1">
                  <DialogTitle>Review settings changes</DialogTitle>
                  <DialogDescription>
                    An agent wants Komla to update{' '}
                    <span className="font-medium text-foreground">{active.target}</span>.
                    {preview && ' Komla is previewing it; nothing is saved until you apply it.'}
                  </DialogDescription>
                </div>
              </div>
            </DialogHeader>

            {active.warning && (
              <div className="border-b border-border px-5 py-3">
                <Callout tone="warning">{active.warning}</Callout>
              </div>
            )}

            <div className="max-h-[60vh] overflow-y-auto bg-muted/10 px-5">
              <div className="divide-y divide-border/70">
                {visibleChanges.map((change, index) => {
                  const typeDetail = change.details.find((detail) => detail.label === 'Type');
                  const supportingDetails = change.details.filter(
                    (detail) => detail.label !== 'Type'
                  );

                  return (
                    <section
                      key={`${change.kind}:${change.title}:${index}`}
                      className="py-3.5 first:pt-3 last:pb-3"
                    >
                      <div className="flex min-w-0 items-start justify-between gap-3">
                        <div className="min-w-0">
                          <h3 className="text-sm leading-5 font-semibold break-words text-foreground">
                            {change.title}
                          </h3>
                          <div className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
                            <span className="capitalize">{change.kind.replaceAll('-', ' ')}</span>
                            {(typeDetail?.value || change.contentLabel) && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span>{typeDetail?.value ?? change.contentLabel}</span>
                              </>
                            )}
                          </div>
                        </div>
                        <Badge tone={operationTones[change.operation]} size="md">
                          {operationLabels[change.operation]}
                        </Badge>
                      </div>

                      {change.content !== undefined && (
                        <pre className={cn('mt-2 px-2.5 py-1.5', codeBlockClassName)}>
                          {change.content}
                        </pre>
                      )}

                      {change.moreContent?.map((more) =>
                        more.previous === undefined ? (
                          <LabeledContent key={more.label} label={more.label}>
                            <pre className={cn('mt-1 px-2.5 py-1.5', codeBlockClassName)}>
                              {more.content}
                            </pre>
                          </LabeledContent>
                        ) : (
                          <ContentDiff
                            key={more.label}
                            label={more.label}
                            before={more.previous}
                            after={more.content}
                          />
                        )
                      )}

                      {supportingDetails.length > 0 && (
                        <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                          {supportingDetails.map((detail) => (
                            <div key={detail.label} className="flex min-w-0 gap-1">
                              <dt className="shrink-0 text-muted-foreground">{detail.label}:</dt>
                              <dd className="flex min-w-0 flex-wrap items-baseline gap-x-1 font-medium break-words text-foreground">
                                {detail.previous !== undefined && (
                                  <>
                                    <del className="font-normal text-muted-foreground">
                                      {detail.previous}
                                    </del>
                                    <span aria-hidden="true" className="text-muted-foreground">
                                      →
                                    </span>
                                  </>
                                )}
                                <span>{detail.value}</span>
                              </dd>
                            </div>
                          ))}
                        </dl>
                      )}
                    </section>
                  );
                })}
              </div>

              {hiddenChangeCount > 0 && (
                <div className="border-t border-border/70 py-2 text-center">
                  <Button variant="ghost" size="sm" onClick={() => setExpandedPromptId(active.id)}>
                    Show all {active.changes.length} changes
                  </Button>
                </div>
              )}
            </div>

            {error && (
              <div className="border-t border-border px-5 py-3">
                <Callout tone="error" role="alert">
                  {error}
                </Callout>
              </div>
            )}

            <DialogFooter className="border-t border-border px-5 py-3">
              <Button
                variant="outline"
                autoFocus
                disabled={submitting !== null}
                onClick={() => void decide('cancel')}
              >
                {submitting === 'cancel' ? 'Cancelling…' : 'Cancel'}
              </Button>
              <Button disabled={submitting !== null} onClick={() => void decide('apply')}>
                {submitting === 'apply' ? 'Applying…' : 'Apply changes'}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
