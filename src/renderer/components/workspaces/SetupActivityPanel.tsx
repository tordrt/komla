import {
  ArrowClockwise,
  CaretRight,
  CheckCircle,
  Stop,
  WarningCircle,
  X,
} from '@phosphor-icons/react';
import React from 'react';

import { IconButton, ignoreFocusAfterPointer } from '@/components/ui/icon-button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useNow } from '@/hooks/useNow';
import { formatRunDuration } from '@/lib/format-time';
import { readableRunOutput } from '@/lib/setup-activity-output';
import { cn } from '@/lib/utils';
import { useToastStore } from '@/stores/toast.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';

import type { SetupActivityRun, Workspace } from '@/types';

const announcedSetupRunIds = new Set<string>();

function announceProblems(
  runs: SetupActivityRun[],
  workspace: Pick<Workspace, 'id' | 'name'>
): void {
  const problemsBySetupRun = new Map<string, SetupActivityRun[]>();
  for (const run of runs) {
    // A background Action's run notifies like an agent instead.
    if (run.actionId || (run.state !== 'failed' && run.state !== 'unsupported')) continue;
    const problems = problemsBySetupRun.get(run.setupRunId) ?? [];
    problems.push(run);
    problemsBySetupRun.set(run.setupRunId, problems);
  }
  for (const [setupRunId, problems] of problemsBySetupRun) {
    if (announcedSetupRunIds.has(setupRunId)) continue;
    announcedSetupRunIds.add(setupRunId);
    const failed = problems.some((run) => run.state === 'failed');
    const names = problems.map((run) => run.stepName).join(', ');
    useToastStore
      .getState()
      .addToast(
        failed
          ? `Setup failed in ${workspace.name}: ${names}`
          : `Setup unsupported in ${workspace.name}: ${names}`,
        failed ? 'error' : 'info',
        {
          action: {
            label: 'View',
            onClick: () => void useWorkspacesStore.getState().selectWorkspace(workspace.id),
          },
          dismissOnTimeout: false,
        }
      );
  }
}

export function SetupActivityNotifications({
  runs,
  workspace,
}: {
  runs: SetupActivityRun[];
  workspace: Pick<Workspace, 'id' | 'name'>;
}) {
  React.useEffect(() => announceProblems(runs, workspace), [runs, workspace]);
  return null;
}

export function SetupActivityNotificationCenter() {
  const workspaces = useWorkspacesStore((state) => state.workspaces);
  return (
    <>
      {workspaces.map((workspace) => (
        <SetupActivityNotifications
          key={workspace.id}
          workspace={workspace}
          runs={workspace.setupActivities ?? []}
        />
      ))}
    </>
  );
}

/** The trigger, with `label` as its tooltip when there is one. */
function OptionalTooltip({ label, children }: { label?: string; children: React.ReactElement }) {
  if (!label) return children;
  return (
    <Tooltip>
      <TooltipTrigger asChild onFocus={ignoreFocusAfterPointer}>
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** Marks the indicator's label, which a crowded tab row measures and drops. */
export const ACTIVITY_LABEL_ATTRIBUTE = 'data-activity-label';

/**
 * The workspace's setup and background command progress, opening the details. `compact` shows
 * only its icon, with the label as a tooltip.
 */
export function SetupActivityIndicator({
  workspace,
  compact = false,
}: {
  workspace: Workspace;
  compact?: boolean;
}) {
  const runs = workspace.setupActivities ?? [];
  const activeRun = runs.reduce<SetupActivityRun | undefined>((latest, run) => {
    if (run.state !== 'preparing' && run.state !== 'running') return latest;
    return !latest || run.startedAt > latest.startedAt ? run : latest;
  }, undefined);
  const hasSucceeded = runs.some((run) => run.state === 'succeeded');
  const hasProblem = runs.some((run) => run.state === 'failed' || run.state === 'unsupported');
  const [showSuccess, setShowSuccess] = React.useState(false);
  const wasActive = React.useRef(Boolean(activeRun));

  React.useEffect(() => {
    let hideTimer: ReturnType<typeof setTimeout> | undefined;
    if (activeRun || hasProblem) {
      setShowSuccess(false);
    } else if (wasActive.current && hasSucceeded) {
      setShowSuccess(true);
      hideTimer = setTimeout(() => setShowSuccess(false), 5_000);
    }
    wasActive.current = Boolean(activeRun);
    return () => {
      if (hideTimer) clearTimeout(hideTimer);
    };
  }, [activeRun, hasProblem, hasSucceeded]);

  if (!activeRun && !showSuccess && !hasProblem) return null;

  const problemRuns = runs.filter((run) => run.state === 'failed' || run.state === 'unsupported');
  const latestProblemRun = problemRuns.reduce<SetupActivityRun | undefined>(
    (latest, run) => (!latest || run.startedAt > latest.startedAt ? run : latest),
    undefined
  );
  const latestRun =
    activeRun ??
    latestProblemRun ??
    runs.reduce((latest, run) => (run.startedAt > latest.startedAt ? run : latest));
  const currentRuns = runs.filter((run) => run.setupRunId === latestRun.setupRunId);
  const completedCount = currentRuns.filter(
    (run) => run.state !== 'preparing' && run.state !== 'running'
  ).length;
  const visibleRunIds = new Set([...currentRuns, ...problemRuns].map((run) => run.id));
  const visibleRuns = runs.filter((run) => visibleRunIds.has(run.id));
  const hasFailure = problemRuns.some((run) => run.state === 'failed');
  const status = hasProblem ? 'problem' : activeRun ? 'running' : 'success';
  const { label, ariaLabel } = describeIndicator(status, latestRun, problemRuns, hasFailure, {
    completed: completedCount,
    total: currentRuns.length,
  });

  return (
    <Popover>
      <OptionalTooltip label={compact ? label : undefined}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={ariaLabel}
            className={cn(
              'no-drag flex h-7 shrink-0 items-center gap-1.5 px-1.5 text-ui font-medium transition-colors',
              status === 'problem'
                ? hasFailure
                  ? 'text-error hover:text-error/80'
                  : 'text-warning hover:text-warning/80'
                : status === 'running'
                  ? 'text-muted-foreground hover:text-foreground'
                  : 'text-success hover:text-success/80'
            )}
          >
            {status === 'problem' ? (
              <WarningCircle className="size-3" weight="fill" />
            ) : status === 'running' ? (
              <Spinner size="xs" />
            ) : (
              <CheckCircle className="size-3" weight="fill" />
            )}
            <span {...{ [ACTIVITY_LABEL_ATTRIBUTE]: '' }} className={cn(compact && 'sr-only')}>
              {label}
            </span>
          </button>
        </PopoverTrigger>
      </OptionalTooltip>
      <PopoverContent align="end" className="w-96 p-0 text-xs">
        <SetupActivityPanel workspace={workspace} runs={visibleRuns} />
      </PopoverContent>
    </Popover>
  );
}

/**
 * The workspace's setup and background command progress. Only it follows each update to the
 * workspace, such as a command's output, so what shows it doesn't render again for them.
 */
export function WorkspaceSetupActivity({
  workspaceId,
  compact,
}: {
  workspaceId: string;
  compact?: boolean;
}) {
  const workspace = useWorkspacesStore((s) => s.workspaces.find((w) => w.id === workspaceId));
  return workspace ? <SetupActivityIndicator workspace={workspace} compact={compact} /> : null;
}

// How near the end, in pixels, still counts as at the end.
const OUTPUT_END_SLACK_PX = 4;

/**
 * A run's output, opened at its end, where the latest lines and any error are. It follows new
 * output while scrolled to the end, and stays put while the user reads further up.
 */
function RunOutput({ id, text }: { id: string; text: string }) {
  const ref = React.useRef<HTMLPreElement>(null);
  const atEnd = React.useRef(true);
  React.useLayoutEffect(() => {
    if (ref.current && atEnd.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [text]);
  return (
    <pre
      id={id}
      ref={ref}
      onScroll={(event) => {
        const { scrollTop, scrollHeight, clientHeight } = event.currentTarget;
        atEnd.current = scrollHeight - scrollTop - clientHeight <= OUTPUT_END_SLACK_PX;
      }}
      className="thin-scrollbar mt-0.5 mr-1 mb-1.5 ml-[1.875rem] max-h-36 overflow-auto rounded-md bg-foreground/[0.05] px-2 py-1.5 font-mono text-2xs leading-relaxed break-words whitespace-pre-wrap text-muted-foreground"
    >
      {text}
    </pre>
  );
}

/** The indicator's text and accessible name. A background Action's run is named after it. */
function describeIndicator(
  status: 'problem' | 'running' | 'success',
  latestRun: SetupActivityRun,
  problemRuns: SetupActivityRun[],
  hasFailure: boolean,
  { completed, total }: { completed: number; total: number }
): { label: string; ariaLabel: string } {
  if (status === 'problem') {
    const count = problemRuns.length;
    const problems = `${count} ${count === 1 ? 'problem' : 'problems'}`;
    if (problemRuns.every((run) => run.actionId)) {
      const label =
        count === 1 ? `${problemRuns[0].stepName} failed` : `Quick Commands failed (${count})`;
      return { label, ariaLabel: count === 1 ? label : `Quick Commands failed: ${problems}` };
    }
    const problemLabel = hasFailure ? 'Setup failed' : 'Setup needs attention';
    return { label: `${problemLabel} (${count})`, ariaLabel: `${problemLabel}: ${problems}` };
  }
  const actionName = latestRun.actionId ? latestRun.stepName : undefined;
  if (status === 'running') {
    return actionName
      ? { label: actionName, ariaLabel: `${actionName} running` }
      : {
          label: `Setup ${completed}/${total}`,
          ariaLabel: `Setup running: ${completed} of ${total} complete`,
        };
  }
  const label = actionName ? `${actionName} done` : 'Setup complete';
  return { label, ariaLabel: label };
}

const isActive = (run: SetupActivityRun) => run.state === 'preparing' || run.state === 'running';
const hasProblem = (run: SetupActivityRun) => run.state === 'failed' || run.state === 'unsupported';

/** A running run's time so far, ticking each second. */
function RunningTime({ since }: { since: number }) {
  return <>{formatRunDuration(useNow() - since)}</>;
}

function RunStateIcon({ run }: { run: SetupActivityRun }) {
  if (isActive(run)) return <Spinner size="sm" className="text-muted-foreground" />;
  if (run.state === 'succeeded') {
    return (
      <CheckCircle aria-hidden="true" className="size-3.5 shrink-0 text-success" weight="fill" />
    );
  }
  return (
    <WarningCircle
      aria-hidden="true"
      className={cn('size-3.5 shrink-0', run.state === 'failed' ? 'text-error' : 'text-warning')}
      weight="fill"
    />
  );
}

/** How long the run has taken, or how it ended when it went wrong. */
function RunStatus({ run }: { run: SetupActivityRun }) {
  let status: React.ReactNode = null;
  if (isActive(run)) status = <RunningTime since={run.startedAt} />;
  else if (run.state === 'failed')
    status = run.exitCode !== undefined ? `Exit ${run.exitCode}` : 'Failed';
  else if (run.state === 'unsupported') status = 'Unsupported';
  else if (run.completedAt !== undefined)
    status = formatRunDuration(run.completedAt - run.startedAt);
  return (
    <span
      className={cn(
        'shrink-0 text-2xs text-muted-foreground tabular-nums',
        run.state === 'failed' && 'text-error',
        run.state === 'unsupported' && 'text-warning'
      )}
    >
      {status}
    </span>
  );
}

/** Stop for a running background Action; Retry, when it can, and Dismiss for a problem. */
function RunActions({ workspace, run }: { workspace: Workspace; run: SetupActivityRun }) {
  if (run.actionId && isActive(run)) {
    return (
      <IconButton
        label="Stop"
        size="xs"
        onClick={() => void window.api.stopBackgroundActionRun(workspace.id, run.id)}
      >
        <Stop weight="fill" />
      </IconButton>
    );
  }
  if (!hasProblem(run)) return null;
  const retry = () => {
    void (
      run.actionId
        ? window.api.runBackgroundAction(workspace.id, run.actionId, {
            command: run.command,
            executionLocation: run.executionLocation,
          })
        : window.api.retrySetupStep(workspace.id, run.stepId)
    ).catch((error) =>
      useToastStore
        .getState()
        .addToast(error instanceof Error ? error.message : 'Could not retry Setup step', 'error')
    );
  };
  return (
    <>
      {run.retryable && (
        <IconButton label="Retry" size="xs" onClick={retry}>
          <ArrowClockwise />
        </IconButton>
      )}
      <IconButton
        label="Dismiss"
        size="xs"
        onClick={() => void window.api.dismissSetupActivity(workspace.id, run.id)}
      >
        <X />
      </IconButton>
    </>
  );
}

function RunRow({ workspace, run }: { workspace: Workspace; run: SetupActivityRun }) {
  const text = `${run.error ? `${run.error}${run.output ? '\n' : ''}` : ''}${readableRunOutput(run.output)}`;
  const hasOutput = text.trim() !== '';
  // Running and failed runs open on their output; one that succeeded folds it away.
  const [toggled, setToggled] = React.useState<boolean>();
  const expanded = hasOutput && (toggled ?? (isActive(run) || hasProblem(run)));
  const outputId = React.useId();

  return (
    <li>
      <div className="flex h-8 items-center gap-2 rounded-md pr-1 pl-2 hover:bg-foreground/5">
        <RunStateIcon run={run} />
        {hasOutput ? (
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={outputId}
            className="flex min-w-0 flex-1 items-center gap-1 text-left font-medium"
            onClick={() => setToggled(!expanded)}
          >
            <span className="truncate">{run.stepName}</span>
            <CaretRight
              aria-hidden="true"
              weight="bold"
              className={cn(
                'size-2.5 shrink-0 text-muted-foreground transition-transform',
                expanded && 'rotate-90'
              )}
            />
          </button>
        ) : (
          <span className="min-w-0 flex-1 truncate font-medium">{run.stepName}</span>
        )}
        <RunStatus run={run} />
        <RunActions workspace={workspace} run={run} />
      </div>
      {expanded && <RunOutput id={outputId} text={text} />}
    </li>
  );
}

/** The header's summary: the one run's state, or how many runs are done and how many failed. */
function summarize(runs: SetupActivityRun[]): string {
  const failed = runs.filter((run) => run.state === 'failed').length;
  const unsupported = runs.filter((run) => run.state === 'unsupported').length;
  if (runs.length === 1) {
    const [run] = runs;
    return isActive(run)
      ? 'Running'
      : run.state === 'succeeded'
        ? 'Done'
        : failed
          ? 'Failed'
          : 'Unsupported';
  }
  const done = runs.filter((run) => !isActive(run)).length;
  return [
    done === runs.length ? 'Done' : `${done} of ${runs.length} done`,
    failed > 0 && `${failed} failed`,
    unsupported > 0 && `${unsupported} unsupported`,
  ]
    .filter(Boolean)
    .join(' · ');
}

export function SetupActivityPanel({
  workspace,
  runs = workspace.setupActivities ?? [],
}: {
  workspace: Workspace;
  runs?: SetupActivityRun[];
}) {
  if (runs.length === 0) return null;
  const heading = runs.every((run) => run.actionId)
    ? 'Background Quick Commands'
    : 'Workspace setup';

  return (
    <section aria-label={heading}>
      <div className="flex items-center justify-between gap-3 border-b border-foreground/10 px-3 py-2">
        <h2 className="text-[13px] font-semibold">{heading}</h2>
        <span className="text-ui text-muted-foreground tabular-nums">{summarize(runs)}</span>
      </div>
      <ul className="thin-scrollbar max-h-[min(60vh,28rem)] space-y-0.5 overflow-y-auto p-1.5">
        {runs.map((run) => (
          <RunRow key={run.id} workspace={workspace} run={run} />
        ))}
      </ul>
    </section>
  );
}
