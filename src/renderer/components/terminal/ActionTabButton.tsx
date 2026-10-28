import { CaretDown, Play, Sparkle } from '@phosphor-icons/react';
import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

import { ActionRunList, keepEscapeForActionSearch } from '@/components/actions/ActionRunList';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  ACTIVITY_LABEL_ATTRIBUTE,
  WorkspaceSetupActivity,
} from '@/components/workspaces/SetupActivityPanel';
import { useActionLauncher } from '@/hooks/useActionLauncher';
import {
  getActionMenuGroups,
  getActionPreview,
  getDefaultAction,
  type ActionMenuGroup,
} from '@/lib/action-menu-order';
import { cn } from '@/lib/utils';
import { openNewActionEditor } from '@/stores/action-editor.store';
import { useActionsStore } from '@/stores/actions.store';
import { useAgentPresetsStore } from '@/stores/agent-presets.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';

import type { TabRoom } from './TabStripScroller';
import type { Action, AgentPreset } from '@/types';

interface ActionTabButtonProps {
  workspaceId: string;
  /** How far the tabs beside it can still shrink, so the setup activity drops its label last. */
  tabRoom?: TabRoom;
}

const buttonClass =
  'flex items-center text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring';

// The gap after the icon, which goes with the label.
const LABEL_GAP_PX = 6;
// How much of the label must still show while it truncates; a shorter label drops
// as soon as it would be cut.
const LABEL_MIN_PX = 48;
// Spare room the label needs, beyond its minimum, before it comes back. Without it
// the label would fit exactly, leave no room, and drop again.
const EXPAND_SLACK_PX = 8;

// How crowded the slot is: 0 shows both labels, 1 drops the button's, 2 the setup activity's too.
type Crowding = 0 | 1 | 2;

/**
 * How much the slot should drop: the button's label truncates as the tabs take its room, and
 * drops once less than its minimum would show, until that much fits again. When the tabs can
 * shrink no further and scroll, the setup activity before the button drops its label as well,
 * until they have room for it again.
 */
function useCrowding(
  slotRef: RefObject<HTMLDivElement | null>,
  activityRef: RefObject<HTMLDivElement | null>,
  buttonRef: RefObject<HTMLDivElement | null>,
  labelRef: RefObject<HTMLSpanElement | null>,
  labelText: string,
  tabRoom: TabRoom | undefined
): Crowding {
  const [crowding, setCrowding] = useState<Crowding>(0);

  useLayoutEffect(() => {
    const slot = slotRef.current;
    const activity = activityRef.current;
    const button = buttonRef.current;
    const label = labelRef.current;
    if (!slot || !activity || !button || !label) return;
    const update = () => {
      // Not laid out: a hidden workspace view.
      if (slot.clientWidth === 0) return;
      const { paddingLeft, paddingRight } = getComputedStyle(slot);
      const padding = (parseFloat(paddingLeft) || 0) + (parseFloat(paddingRight) || 0);
      // The activity's margin, while it shows, is room the slot doesn't have either.
      const activityWidth =
        activity.offsetWidth &&
        activity.offsetWidth + (parseFloat(getComputedStyle(activity).marginRight) || 0);
      const spare = slot.clientWidth - padding - activityWidth - button.offsetWidth;
      // scrollWidth is the text's own width, even while truncated or visually hidden.
      const minShown = Math.min(label.scrollWidth, LABEL_MIN_PX);
      const activityLabel = activity.querySelector<HTMLElement>(`[${ACTIVITY_LABEL_ATTRIBUTE}]`);
      const room = tabRoom?.px ?? Infinity;
      setCrowding((was) => {
        if (was === 0) return label.clientWidth < minShown - 1 ? 1 : 0;
        if (was === 1) {
          if (spare >= LABEL_GAP_PX + minShown + EXPAND_SLACK_PX) return 0;
          return activityLabel && room < 1 ? 2 : 1;
        }
        const activityLabelWidth = activityLabel ? LABEL_GAP_PX + activityLabel.scrollWidth : 0;
        return room >= activityLabelWidth + EXPAND_SLACK_PX ? 1 : 2;
      });
    };
    update();
    if (tabRoom) tabRoom.onChange = update;
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update);
    observer?.observe(slot);
    observer?.observe(activity);
    observer?.observe(button);
    return () => {
      observer?.disconnect();
      if (tabRoom?.onChange === update) tabRoom.onChange = undefined;
    };
  }, [slotRef, activityRef, buttonRef, labelRef, labelText, tabRoom]);

  return crowding;
}

/**
 * Tab bar split button for Actions: the label reruns the workspace's default Action, the
 * caret opens a searchable list of every Action for this project; running one from the
 * list makes it the default. With none yet, it opens the
 * editor instead. It fills the rest of the tab row, pinned to its right edge, with the
 * workspace's setup and background command progress before it; when the tabs need the room
 * its label truncates, then it shows only its icon, and then so does the progress.
 */
export function ActionTabButton({ workspaceId, tabRoom }: ActionTabButtonProps) {
  const { actions, loadActions } = useActionsStore();
  const presets = useAgentPresetsStore((s) => s.presets);
  const projectId = useWorkspacesStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.projectId
  );
  const defaultActionId = useWorkspacesStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.defaultActionId
  );
  // A run from the list changes the default; one from the label keeps a fallback once run.
  const { runAction, actionInputDialog } = useActionLauncher(workspaceId);

  const slotRef = useRef<HTMLDivElement>(null);
  const activityRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  const caretRef = useRef<HTMLButtonElement>(null);

  const actionMenuGroups = getActionMenuGroups(actions, projectId);
  const defaultAction = getDefaultAction(actionMenuGroups, defaultActionId);
  const crowding = useCrowding(
    slotRef,
    activityRef,
    buttonRef,
    labelRef,
    defaultAction?.title ?? '',
    tabRoom
  );
  const compact = crowding > 0;
  // min-w-min: the label can give up its room, but the tabs scroll before the icons are
  // squeezed, so the button is never clipped.
  const slotClass = 'flex h-full min-w-min flex-1 items-center justify-end pr-2 pl-1';
  // nowrap: the slot's min-content then counts the activity's label on one line, as it shows.
  const activity = (
    <div ref={activityRef} className="mr-0.5 flex shrink-0 whitespace-nowrap empty:hidden">
      <WorkspaceSetupActivity
        key={workspaceId}
        workspaceId={workspaceId}
        compact={crowding === 2}
      />
    </div>
  );
  // The grid track keeps the label out of the button's min-content width, so the label
  // truncates instead of pushing the tabs.
  const renderLabel = (text: string) => (
    <span className={cn('grid grid-cols-[minmax(0,max-content)]', compact && 'sr-only')}>
      <span ref={labelRef} className="max-w-24 truncate text-xs font-medium">
        {text}
      </span>
    </span>
  );

  // From a workspace, a new Action starts scoped to its project. The list is gone by the
  // time the editor closes, and so is the empty-state button once an Action is saved.
  const openEditorForNewAction = () =>
    openNewActionEditor(projectId, () =>
      (caretRef.current ?? slotRef.current?.querySelector('button'))?.focus()
    );

  if (!defaultAction) {
    return (
      <div ref={slotRef} className={slotClass}>
        {activity}
        <div ref={buttonRef} className="flex">
          <Tooltip delayDuration={600}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={openEditorForNewAction}
                aria-label="New quick command"
                className={cn(buttonClass, 'h-6 gap-1.5 rounded-md bg-foreground/[0.06] px-1.5')}
              >
                <Play weight="fill" className="size-3 shrink-0" />
                {renderLabel('Quick command')}
              </button>
            </TooltipTrigger>
            <TooltipContent>Save a command or prompt to run in one click</TooltipContent>
          </Tooltip>
        </div>
        {actionInputDialog}
      </div>
    );
  }

  const defaultPreview = getActionPreview(defaultAction);

  return (
    <div ref={slotRef} className={slotClass}>
      {activity}
      {/* One filled control with a divider, so the run button and its caret read as a pair.
          Open is read from aria-expanded, since the tooltip owns the trigger's data-state. */}
      <div
        ref={buttonRef}
        className="group/action-split flex h-6 items-stretch overflow-hidden rounded-md bg-foreground/[0.06]"
      >
        <Tooltip delayDuration={600}>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={(event) => {
                // The second click of a double-click would run it again.
                if (event.detail > 1) return;
                runAction(defaultAction);
              }}
              aria-label={`Run ${defaultAction.title}`}
              className={cn(buttonClass, 'gap-1.5 pr-1.5 pl-2')}
            >
              {defaultAction.type === 'command' ? (
                <Play weight="fill" className="size-3 shrink-0" />
              ) : (
                <Sparkle className="size-3 shrink-0" />
              )}
              {renderLabel(defaultAction.title)}
            </button>
          </TooltipTrigger>
          <TooltipContent className="max-w-80">
            <span className="flex flex-col gap-0.5">
              <span>Run {defaultAction.title}</span>
              <span
                className={cn(
                  'truncate text-muted-foreground',
                  defaultAction.type === 'command' && 'font-mono'
                )}
              >
                {defaultPreview}
              </span>
            </span>
          </TooltipContent>
        </Tooltip>
        <ActionListMenu
          caretRef={caretRef}
          groups={actionMenuGroups}
          presets={presets}
          initialActiveId={defaultAction.id}
          onOpen={() => void loadActions()}
          onRun={runAction}
          onNew={openEditorForNewAction}
          onManage={() =>
            window.dispatchEvent(new CustomEvent('open-settings', { detail: 'actions' }))
          }
        />
      </div>
      {actionInputDialog}
    </div>
  );
}

interface ActionListMenuProps {
  caretRef: RefObject<HTMLButtonElement | null>;
  groups: ActionMenuGroup[];
  presets: AgentPreset[];
  initialActiveId: string;
  onOpen: () => void;
  onRun: (action: Action) => void;
  onNew: () => void;
  onManage: () => void;
}

/**
 * The split button's caret and its list. It owns whether the list is open, so the list
 * starts closed whenever the button comes back after the project had no Actions.
 */
function ActionListMenu({
  caretRef,
  groups,
  presets,
  initialActiveId,
  onOpen,
  onRun,
  onNew,
  onManage,
}: ActionListMenuProps) {
  const [open, setOpen] = useState(false);

  const closeThen = (run: () => void) => {
    setOpen(false);
    run();
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) onOpen();
      }}
    >
      <Tooltip delayDuration={600}>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              ref={caretRef}
              type="button"
              aria-label="More quick commands"
              className={cn(
                buttonClass,
                'shrink-0 justify-center border-l border-foreground/10 px-1 aria-expanded:bg-accent aria-expanded:text-foreground'
              )}
            >
              <CaretDown weight="bold" className="size-3" />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>More quick commands</TooltipContent>
      </Tooltip>
      <PopoverContent
        align="end"
        className="w-80 p-0"
        onCloseAutoFocus={(event) => event.preventDefault()}
        onEscapeKeyDown={keepEscapeForActionSearch}
      >
        <ActionRunList
          groups={groups}
          presets={presets}
          initialActiveId={initialActiveId}
          onRun={(action) => closeThen(() => onRun(action))}
          onNew={() => closeThen(onNew)}
          onManage={() => closeThen(onManage)}
        />
      </PopoverContent>
    </Popover>
  );
}
