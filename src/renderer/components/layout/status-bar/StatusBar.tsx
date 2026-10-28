import { Fragment, useEffect } from 'react';

import { useConfigStore } from '@/stores/config.store';
import { applyStatusCommandResult } from '@/stores/status-items.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';

import { GitProgressIndicator } from '../GitProgressIndicator';
import { TargetBranchSelector } from '../TargetBranchSelector';
import { UnifiedMenu } from '../UnifiedMenu';

import { AgentsStatusSegment } from './AgentsStatusSegment';
import { AgentUsageSegment } from './AgentUsageSegment';
import { AutomationsStatusSegment } from './AutomationsStatusSegment';
import { CommitGraphStatusSegment } from './CommitGraphStatusSegment';
import { useCustomStatusItems } from './CustomStatusItemsSegment';
import { EditorStatusSegment } from './EditorStatusSegment';
import { FileSearchStatusSegment } from './FileSearchStatusSegment';
import { FileViewerStatusSegment } from './FileViewerStatusSegment';
import { KeepAwakeStatusSegment } from './KeepAwakeStatusSegment';
import { NotesStatusSegment } from './NotesStatusSegment';
import { NotificationSoundsStatusSegment } from './NotificationSoundsStatusSegment';
import { PullRequestStatusSegment } from './PullRequestStatusSegment';
import { ResourceUsageSegment } from './ResourceUsageSegment';
import { SshHostsStatusSegment } from './SshHostsStatusSegment';
import {
  isCustomStatusItemKey,
  isStatusBarItemShown,
  statusBarPlacement,
  type StatusBarItemId,
  type StatusBarPlacedId,
  type StatusBarPlacement,
  type StatusBarSide,
} from './status-bar-items';
import {
  StatusBarContextMenu,
  StatusBarCustomizePopover,
  StatusBarItem,
} from './StatusBarContextMenu';
import { TipsStatusSegment } from './TipsStatusSegment';
import { UpdateStatusSegment } from './UpdateStatusSegment';

import type { TipsActions } from '../GettingStartedMenu';
import type * as React from 'react';

type ItemConfig = Parameters<typeof isStatusBarItemShown>[0];

type CustomItems = ReturnType<typeof useCustomStatusItems>;

/** Each item's content. Tips, which needs the app's actions, is rendered on its own. */
const SEGMENTS: Record<Exclude<StatusBarItemId, 'tips'>, () => React.ReactNode> = {
  'git-menu': () => <UnifiedMenu inStatusBar />,
  'target-branch': () => <TargetBranchSelector inStatusBar />,
  'pull-request': () => <PullRequestStatusSegment />,
  'open-in-editor': () => <EditorStatusSegment />,
  'file-search': () => <FileSearchStatusSegment />,
  'file-viewer': () => <FileViewerStatusSegment mode="browse" />,
  'diff-viewer': () => <FileViewerStatusSegment mode="diff" />,
  notes: () => <NotesStatusSegment />,
  'commit-graph': () => <CommitGraphStatusSegment />,
  agents: () => <AgentsStatusSegment />,
  'claude-code-usage': () => <AgentUsageSegment source="claude-code" />,
  'codex-usage': () => <AgentUsageSegment source="codex" />,
  automations: () => <AutomationsStatusSegment />,
  'notification-sounds': () => <NotificationSoundsStatusSegment />,
  'keep-awake': () => <KeepAwakeStatusSegment />,
  'ssh-hosts': () => <SshHostsStatusSegment />,
  'system-metrics': () => <ResourceUsageSegment />,
};

/**
 * Where git and setup progress go: after the git menu, or after the target branch when it follows
 * the git menu or shows alone. Without either, they open the left side. Git progress shows only
 * while the git menu is hidden, since the menu shows a running operation in its own place.
 */
function progressAnchor(placed: StatusBarPlacement): StatusBarPlacedId | undefined {
  for (const items of [placed.left, placed.right]) {
    const git = items.indexOf('git-menu');
    if (git !== -1) return items[git + 1] === 'target-branch' ? 'target-branch' : 'git-menu';
  }
  return [...placed.left, ...placed.right].find((id) => id === 'target-branch');
}

/**
 * The items shown on one side, in the user's order, custom items among them, with git progress
 * after `progressAfter`. The left side opens with that progress when the branch isn't
 * on screen and closes with a warning about status-items.json; the right side opens with update
 * notices. The right side takes all the room the left doesn't use; when both overflow, the
 * left keeps up to 40%. That floor comes from its `w-[40%]`: `overflow-clip`, unlike `hidden`,
 * leaves its automatic minimum width at min(width, content).
 */
function SideItems({
  side,
  items,
  progressAfter,
  showGitProgress,
  customItems,
  tipsActions,
}: {
  side: StatusBarSide;
  items: StatusBarPlacedId[];
  progressAfter: StatusBarPlacedId | undefined;
  showGitProgress: boolean;
  customItems: CustomItems;
  tipsActions?: TipsActions;
}) {
  const hasWorkspace = useWorkspacesStore((s) =>
    s.workspaces.some((w) => w.id === s.selectedWorkspaceId)
  );
  const progress = hasWorkspace && showGitProgress && <GitProgressIndicator />;

  return (
    <div
      className={
        side === 'left'
          ? 'flex w-[40%] flex-1 items-center gap-1 overflow-clip'
          : 'flex items-center gap-1 overflow-hidden'
      }
    >
      {side === 'left' && !progressAfter && progress}
      {side === 'right' && <UpdateStatusSegment />}
      {items.map((id) => (
        <Fragment key={id}>
          {id === 'tips' ? (
            tipsActions && <TipsStatusSegment {...tipsActions} />
          ) : isCustomStatusItemKey(id) ? (
            customItems.rendered.get(id)
          ) : (
            <StatusBarItem id={id}>{SEGMENTS[id]()}</StatusBarItem>
          )}
          {id === progressAfter && progress}
        </Fragment>
      ))}
      {side === 'left' && customItems.extras}
    </div>
  );
}

/** Both halves of the bar, sharing the open workspace's custom items, run only while it shows. */
function StatusBarItems({
  config,
  tipsActions,
}: {
  config: ItemConfig;
  tipsActions?: TipsActions;
}) {
  const customItems = useCustomStatusItems();
  const hasWorkspace = useWorkspacesStore((s) =>
    s.workspaces.some((w) => w.id === s.selectedWorkspaceId)
  );
  // Custom items show once they have something to show; the branch items only for an open
  // workspace.
  const shown = (id: StatusBarPlacedId) =>
    isCustomStatusItemKey(id)
      ? customItems.rendered.has(id)
      : isStatusBarItemShown(config, id) &&
        (hasWorkspace || (id !== 'git-menu' && id !== 'target-branch'));
  const placement = statusBarPlacement(
    config,
    customItems.entries.map((entry) => entry.key)
  );
  const placed = { left: placement.left.filter(shown), right: placement.right.filter(shown) };
  const progressAfter = progressAnchor(placed);
  const showGitProgress = ![...placed.left, ...placed.right].includes('git-menu');
  return (
    <>
      <SideItems
        side="left"
        items={placed.left}
        progressAfter={progressAfter}
        showGitProgress={showGitProgress}
        customItems={customItems}
        tipsActions={tipsActions}
      />
      <SideItems
        side="right"
        items={placed.right}
        progressAfter={progressAfter}
        showGitProgress={showGitProgress}
        customItems={customItems}
        tipsActions={tipsActions}
      />
    </>
  );
}

/** The thin bar along the bottom of the window. Items hide themselves while they have nothing to show. */
export function StatusBar({ tipsActions }: { tipsActions?: TipsActions }) {
  const config = useConfigStore((s) => s.config);
  // While the bar is hidden too, so it shows what a refresh ran once it's shown again.
  useEffect(() => window.api.onStatusCommandResult(applyStatusCommandResult), []);
  if (!config || config.showStatusBar === false) return null;

  return (
    <>
      <StatusBarContextMenu>
        {/* On the sidebar's --chrome, so the bottom row reads as one with the sidebar. */}
        <footer
          data-status-bar
          data-testid="status-bar"
          className="window-chrome @container flex h-6 shrink-0 items-center gap-2 px-1.5 text-ui select-none"
        >
          <StatusBarItems config={config} tipsActions={tipsActions} />
        </footer>
      </StatusBarContextMenu>
      <StatusBarCustomizePopover />
    </>
  );
}
