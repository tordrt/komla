import { ShieldCheck } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';

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
import { endAppearancePreview, previewAppearance } from '@/lib/theme-palette';

import type { SettingsApprovalDecision, SettingsApprovalPrompt } from '@/types';

const operationLabels = {
  add: 'Add',
  edit: 'Edit',
  delete: 'Delete',
  change: 'Change',
} as const;

const MAX_VISIBLE_CHANGES = 12;

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
                        <Badge tone={change.operation === 'delete' ? 'error' : 'primary'} size="md">
                          {operationLabels[change.operation]}
                        </Badge>
                      </div>

                      {change.content !== undefined && (
                        <pre className="mt-2 max-h-36 overflow-auto rounded bg-background/80 px-2.5 py-1.5 font-mono text-xs leading-5 break-words whitespace-pre-wrap text-foreground">
                          {change.content}
                        </pre>
                      )}

                      {change.moreContent?.map((more) => (
                        <div key={more.label} className="mt-2">
                          <div className="text-xs text-muted-foreground">{more.label}</div>
                          <pre className="mt-1 max-h-36 overflow-auto rounded bg-background/80 px-2.5 py-1.5 font-mono text-xs leading-5 break-words whitespace-pre-wrap text-foreground">
                            {more.content}
                          </pre>
                        </div>
                      ))}

                      {supportingDetails.length > 0 && (
                        <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                          {supportingDetails.map((detail) => (
                            <div key={detail.label} className="flex min-w-0 gap-1">
                              <dt className="shrink-0 text-muted-foreground">{detail.label}:</dt>
                              <dd className="font-medium break-words text-foreground">
                                {detail.value}
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
