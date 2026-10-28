import {
  ArrowSquareOut,
  CheckCircle,
  CircleDashed,
  GitPullRequest,
  MinusCircle,
  XCircle,
} from '@phosphor-icons/react';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/config.store';
import { useWorkspaceObservationStore } from '@/stores/workspace-observation.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';

import { STATUS_BAR_BUTTON_CLASS, StatusBarButton } from './StatusBarButton';

import type {
  PullRequestCheck,
  PullRequestCheckState,
  PullRequestCiState,
  PullRequestStatus,
  PullRequestSummary,
} from '../../../../shared/types/pull-request';
import type { Icon, IconWeight } from '@phosphor-icons/react';

const READ_INTERVAL_MS = 60_000;
/** Running checks are read again sooner, so the item turns as they finish. */
const RUNNING_READ_INTERVAL_MS = 20_000;

const CHECK_ICONS: Record<
  PullRequestCheckState,
  { icon: Icon; className: string; weight: IconWeight }
> = {
  failed: { icon: XCircle, className: 'text-error', weight: 'fill' },
  // An outline, as it isn't done yet.
  pending: { icon: CircleDashed, className: 'text-warning', weight: 'bold' },
  passed: { icon: CheckCircle, className: 'text-success', weight: 'fill' },
  skipped: { icon: MinusCircle, className: 'text-muted-foreground', weight: 'fill' },
};
const CHECK_ORDER: PullRequestCheckState[] = ['failed', 'pending', 'passed', 'skipped'];

const CI_LABELS: Record<PullRequestCiState, string> = {
  passed: 'CI passed',
  failed: 'CI failed',
  pending: 'CI running',
  none: 'No checks',
};
const STATE_LABELS: Record<PullRequestSummary['state'], string> = {
  open: 'Open',
  draft: 'Draft',
  merged: 'Merged',
  closed: 'Closed',
};

/**
 * Reads the workspace's pull request every minute while the window shows, every 20 seconds while
 * its checks run, and again when its branch is switched or pushed. Edits to its files don't count.
 */
function usePullRequestStatus(workspaceId: string): PullRequestStatus | undefined {
  const pushState = useWorkspaceObservationStore((s) => {
    const branch = s.projections.get(workspaceId)?.branch;
    return branch && `${branch.currentBranch}:${branch.hasRemote}:${branch.unpushedCommits}`;
  });
  const [status, setStatus] = useState<PullRequestStatus>();
  const running = status?.kind === 'pull-request' && status.pullRequest.ci === 'pending';
  useEffect(() => {
    let current = true;
    const read = () => {
      if (document.hidden) return;
      window.api.getWorkspacePullRequestStatus(workspaceId).then(
        (next) => {
          if (current) setStatus(next);
        },
        () => {}
      );
    };
    read();
    const timer = setInterval(read, running ? RUNNING_READ_INTERVAL_MS : READ_INTERVAL_MS);
    document.addEventListener('visibilitychange', read);
    return () => {
      current = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', read);
    };
  }, [workspaceId, pushState, running]);
  return status;
}

function CheckRow({ check }: { check: PullRequestCheck }) {
  const { icon: CheckIcon, className, weight } = CHECK_ICONS[check.state];
  const content = (
    <>
      <CheckIcon
        aria-hidden="true"
        weight={weight}
        className={cn('size-3.5 shrink-0', className)}
      />
      <span className="min-w-0 flex-1 truncate">{check.name}</span>
      <span className="sr-only">{check.state}</span>
    </>
  );
  return (
    <li>
      {check.url ? (
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-foreground/8 focus-visible:bg-foreground/8 focus-visible:outline-hidden"
          title={`Open ${check.name} on GitHub`}
          onClick={() => void window.api.openExternal(check.url!)}
        >
          {content}
        </button>
      ) : (
        <div className="flex items-center gap-2 px-2 py-1">{content}</div>
      )}
    </li>
  );
}

function PullRequestPopover({ pullRequest }: { pullRequest: PullRequestSummary }) {
  const notifies = useConfigStore((s) => s.config?.pullRequestCiNotifications !== false);
  const updateConfig = useConfigStore((s) => s.updateConfig);
  const checks = [...pullRequest.checks].sort(
    (a, b) => CHECK_ORDER.indexOf(a.state) - CHECK_ORDER.indexOf(b.state)
  );
  const passed = checks.filter((check) => check.state === 'passed').length;
  return (
    <>
      <div className="border-b border-foreground/10 px-3 py-2">
        <h2 className="line-clamp-2 text-[13px] font-semibold">{pullRequest.title}</h2>
        <p className="text-ui text-muted-foreground">
          #{pullRequest.number} · {STATE_LABELS[pullRequest.state]}
          {checks.length > 0 && ` · ${passed} of ${checks.length} checks passed`}
        </p>
      </div>
      {checks.length > 0 ? (
        <ul
          aria-label="Checks"
          className="thin-scrollbar max-h-[min(50vh,22rem)] overflow-y-auto p-1"
        >
          {checks.map((check) => (
            <CheckRow key={`${check.name}:${check.url ?? ''}`} check={check} />
          ))}
        </ul>
      ) : (
        <p className="px-3 py-2.5 text-muted-foreground">No checks on this pull request.</p>
      )}
      <div className="flex items-center justify-between gap-3 border-t border-foreground/10 px-3 py-2">
        <label className="flex items-center gap-2 text-ui whitespace-nowrap">
          <Switch
            className="h-4 w-7 [&>span]:size-3 [&>span]:data-[state=checked]:translate-x-3"
            checked={notifies}
            onCheckedChange={(pullRequestCiNotifications) =>
              void updateConfig({ pullRequestCiNotifications })
            }
          />
          Notify when CI finishes
        </label>
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1.5 px-2.5 text-xs"
          onClick={() => void window.api.openExternal(pullRequest.url)}
        >
          <ArrowSquareOut aria-hidden="true" />
          Open on GitHub
        </Button>
      </div>
    </>
  );
}

const SIGNED_OUT_HINT = 'Run gh auth login to see this branch’s pull request';

function PullRequestItem({ workspaceId }: { workspaceId: string }) {
  const status = usePullRequestStatus(workspaceId);
  // Shown by default, so it stays out of the way of whoever doesn't use the GitHub CLI.
  if (!status || status.kind === 'none') return null;
  if (status.kind === 'unavailable' && status.reason === 'no-gh') return null;

  if (status.kind === 'unavailable') {
    const hint =
      status.reason === 'error'
        ? `Couldn’t read the pull request${status.message ? `: ${status.message}` : ''}`
        : SIGNED_OUT_HINT;
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          {/* Nothing to open: the tooltip says what's missing. */}
          <span
            tabIndex={0}
            aria-label={hint}
            className={cn(STATUS_BAR_BUTTON_CLASS, 'text-muted-foreground/60')}
          >
            <GitPullRequest aria-hidden="true" className="size-3.5" />
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">{hint}</TooltipContent>
      </Tooltip>
    );
  }

  const { pullRequest } = status;
  const open = pullRequest.state === 'open' || pullRequest.state === 'draft';
  const ci = open && pullRequest.ci !== 'none' ? CHECK_ICONS[pullRequest.ci] : undefined;
  const summary = [
    `#${pullRequest.number} ${pullRequest.title}`,
    open ? CI_LABELS[pullRequest.ci] : STATE_LABELS[pullRequest.state],
  ].join(' · ');
  const CiIcon = ci?.icon;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <StatusBarButton
          aria-label={`Pull request: ${summary}`}
          tooltip={summary}
          className="tabular-nums"
        >
          <GitPullRequest
            aria-hidden="true"
            className={cn('size-3.5', !open && 'text-muted-foreground/60')}
          />
          <span>#{pullRequest.number}</span>
          {CiIcon && (
            <CiIcon
              aria-hidden="true"
              weight={ci.weight}
              className={cn('size-3.5', ci.className)}
            />
          )}
        </StatusBarButton>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-88 p-0 text-xs">
        <PullRequestPopover pullRequest={pullRequest} />
      </PopoverContent>
    </Popover>
  );
}

/** The pull request of the open workspace's branch, with how its checks stand. */
export function PullRequestStatusSegment() {
  const workspace = useWorkspacesStore((s) =>
    s.workspaces.find((w) => w.id === s.selectedWorkspaceId)
  );
  if (!workspace?.isWorktree) return null;
  // Keyed, so one workspace's pull request never shows under another's.
  return <PullRequestItem key={workspace.id} workspaceId={workspace.id} />;
}
