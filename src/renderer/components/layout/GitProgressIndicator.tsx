import { Spinner } from '@/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { latestGitOperation, useGitProgressStore } from '@/stores/git-progress.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';

import type { GitOperation } from '@/stores/git-progress.store';

/**
 * The operation as a present participle (merge → Merging, fast-forward → Fast-forwarding).
 * Capitalized here rather than with CSS, which would also capitalize after the hyphen.
 */
export function gitOperationLabel(operation: GitOperation): string {
  const verb = operation.operation;
  const participle = verb.endsWith('e') ? verb.slice(0, -1) + 'ing' : verb + 'ing';
  return participle.charAt(0).toUpperCase() + participle.slice(1);
}

/**
 * What a running operation is doing, for a tooltip: the operation, then Git's own stage with its
 * percentage, which restarts at each stage.
 */
export function GitOperationDetails({ operation }: { operation: GitOperation }) {
  return (
    <span className="flex min-w-0 flex-col">
      <span>{gitOperationLabel(operation)}…</span>
      {operation.stage && (
        <span className="text-muted-foreground">
          {operation.stage}
          {operation.percent > 0 && <span className="tabular-nums"> {operation.percent}%</span>}
        </span>
      )}
    </span>
  );
}

/**
 * Git progress in the status bar while the git menu, which shows the operation in its own place,
 * is hidden from it. The label goes first when the bar is narrow; the spinner always stays.
 */
export function GitProgressIndicator() {
  const workingDirectory = useWorkspacesStore(
    (s) => s.workspaces.find((w) => w.id === s.selectedWorkspaceId)?.workingDirectory
  );
  const activeOp = useGitProgressStore((s) =>
    workingDirectory === undefined ? undefined : latestGitOperation(s.operations, workingDirectory)
  );

  if (!activeOp) return null;
  const label = gitOperationLabel(activeOp);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="status"
          aria-label={label}
          className="flex h-(--status-bar-item-height) min-w-0 items-center gap-1 px-1.5 whitespace-nowrap text-muted-foreground"
        >
          <Spinner size="xs" />
          <span className="truncate @max-3xl:hidden">{label}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">
        <GitOperationDetails operation={activeOp} />
      </TooltipContent>
    </Tooltip>
  );
}
