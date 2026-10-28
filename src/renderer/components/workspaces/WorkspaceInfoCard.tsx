import { Cloud, GitBranch, GitFork } from '@phosphor-icons/react';
import React from 'react';

import { cn } from '@/lib/utils';
import { formatSshTarget } from '@/lib/workspace-host';
import { isSshWorkspace } from '@/types';

import { getWorkspaceDynamicTitle } from '../../../shared/lib/workspace-title';

import { WorkspaceTagBadge } from './WorkspaceTagBadge';

import type { SshHost, Workspace } from '@/types';

export {
  getWorkspaceDisplayTitle,
  getWorkspaceDynamicTitle,
} from '../../../shared/lib/workspace-title';

// Spinner glyphs agents such as Claude Code put in front of their terminal title.
const AGENT_TITLE_GLYPHS = /^[\u2800-\u28ff·✢✳✶✻✽*]+\s*/u;

/** An agent's title without the spinner glyph in front, for places that draw no spinner of it. */
export function stripAgentTitleGlyphs(title: string): string {
  return title.replace(AGENT_TITLE_GLYPHS, '');
}

/** Workspace details shown when hovering a sidebar or dashboard workspace card. */
export function WorkspaceInfoCardContent({
  workspace,
  sshHost,
  children,
  showLocation = true,
  showBranch = true,
}: {
  workspace: Workspace;
  sshHost: SshHost | null;
  /** More about it under its name, such as what one of its agents said. */
  children?: React.ReactNode;
  /** Whether the footer tells its host and branch. */
  showLocation?: boolean;
  /** Whether the footer names the branch; off where the card already shows it. */
  showBranch?: boolean;
}) {
  const dynamicTitle = getWorkspaceDynamicTitle(workspace);
  const displayTitle = workspace.customName || dynamicTitle || workspace.name;
  // A custom name hides the agent's live terminal title, so the details show it.
  const liveTitle =
    workspace.customName && dynamicTitle !== workspace.customName ? dynamicTitle : undefined;
  const isRemoteWorkspace = isSshWorkspace(workspace);
  const branchName = showBranch && workspace.isWorktree ? workspace.branchName : undefined;
  const hasBranchLine = !!branchName || !!workspace.branchedFrom;
  const hasLocation = isRemoteWorkspace || hasBranchLine;
  const BranchIcon = branchName ? GitBranch : GitFork;
  const sshTarget = sshHost ? formatSshTarget(sshHost) : undefined;
  const sshHostName = sshHost?.name || sshHost?.hostname || 'SSH';

  // What the workspace is on top; its host and branch in one tinted line under it, as the
  // new-workspace dialog sets its project, host and branch under the prompt. The path and a
  // branch the card shows are copied from its context menu instead.
  return (
    <div>
      <div className="px-3.5 py-3">
        <div className="text-[13px] leading-snug font-semibold break-words text-popover-foreground">
          {displayTitle}
        </div>
        {liveTitle && (
          <div className="mt-0.5 text-xs break-words text-muted-foreground">{liveTitle}</div>
        )}
        {workspace.customDescription && (
          <div className="mt-2 text-xs leading-relaxed text-popover-foreground/80">
            {workspace.customDescription}
          </div>
        )}
        {/* Here too, as a notification or a busy agent takes the tag's place on the card. */}
        {workspace.tag && (
          <div className="mt-2 flex min-w-0 items-baseline gap-1.5 text-xs">
            <WorkspaceTagBadge
              data-workspace-info-tag
              tag={workspace.tag}
              className="max-w-full shrink-0"
            />
            {(workspace.tagTooltip || workspace.tagSource === 'pull-request') && (
              <span className="min-w-0 break-words text-muted-foreground">
                {workspace.tagTooltip ?? 'From the pull request'}
              </span>
            )}
          </div>
        )}
        {children}
      </div>

      {showLocation && hasLocation && (
        <div className="flex min-w-0 items-center gap-3 border-t border-foreground/10 bg-foreground/[0.03] px-3.5 py-2 text-ui text-popover-foreground/90 select-text">
          {isRemoteWorkspace && (
            <span
              className={cn(
                'flex min-w-0 items-center gap-1.5',
                hasBranchLine ? 'max-w-1/2 shrink-0' : 'flex-1'
              )}
              title={sshTarget}
            >
              <Cloud className="size-3.5 shrink-0 text-muted-foreground/70" />
              <span className={cn('truncate', !hasBranchLine && 'max-w-1/2 shrink-0')}>
                {sshHostName}
              </span>
              {/* With the line to itself, the host also says who it logs in as, and where. */}
              {!hasBranchLine && sshTarget && sshHostName !== sshTarget && (
                <span className="min-w-0 truncate font-mono text-muted-foreground">
                  {sshTarget}
                </span>
              )}
            </span>
          )}
          {(branchName || workspace.branchedFrom) && (
            <span className="flex min-w-0 flex-1 items-center gap-1.5">
              <BranchIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
              {branchName && (
                <span className="min-w-0 truncate font-mono" title={branchName}>
                  {branchName}
                </span>
              )}
              {workspace.branchedFrom && (
                <span
                  className={cn(
                    'truncate font-mono text-muted-foreground',
                    branchName && 'max-w-1/2 shrink-0'
                  )}
                >
                  <span className="font-sans">from </span>
                  {workspace.branchedFrom}
                </span>
              )}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
