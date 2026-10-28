import {
  Lightbulb,
  Browsers,
  Keyboard,
  ChatCircle,
  Tray,
  Microphone,
  Sparkle,
  Check,
  CaretRight,
  Play,
  SlidersHorizontal,
  CalendarDots,
  Layout,
  BookOpenText,
  DeviceMobile,
} from '@phosphor-icons/react';
import React, { useEffect, useId, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { StatusBarButton } from '@/components/layout/status-bar/StatusBarButton';
import { AgentPresetIcon } from '@/components/terminal/AgentPresetIcon';
import { AlphaBadge, Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { openCustomizeAgent } from '@/lib/customize-agent';
import { useActionsStore } from '@/stores/actions.store';
import { offerKomlaSkillInstall } from '@/stores/agent-launch-defaults-dialog.store';
import { useAgentPresetsStore } from '@/stores/agent-presets.store';
import { useConfigStore } from '@/stores/config.store';
import { openNewWorkspaceDialog, useDialogsStore } from '@/stores/dialogs.store';
import { useLayoutStore } from '@/stores/layout.store';
import { useProjectsStore } from '@/stores/projects.store';
import { useSshHostDialogStore } from '@/stores/ssh-host-dialog.store';
import { useStatusBarCustomizeStore } from '@/stores/status-bar-customize.store';
import { useToastStore } from '@/stores/toast.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';
import { TRASH_RETENTION_DAYS } from '@/types';
import { listAgentNames } from '@/utils/agent-name';

import { AGENTS_WITH_AUTO_INTEGRATIONS } from '../../../shared/constants/agents';
import { buildCustomizePrompt } from '../../../shared/constants/customize-prompt';
import { buildOnboardingDemoPrompt } from '../../../shared/constants/onboarding-demo-prompt';
import { buildProjectSetupPrompt } from '../../../shared/constants/project-setup-prompt';

import type { SettingsDialogTarget } from '@/stores/settings-dialog.store';
import type { AgentPreset } from '@/types';

interface TipDef {
  id: string;
  title: string;
  subtitle: string;
}

/** A step worth taking first, in the order to take it. */
interface StepDef extends TipDef {
  /** Starts an agent with a prompt, rather than opening a page or panel. */
  runsAgent?: boolean;
}

/** Everything else, offered as a compact tile; the subtitle shows on hover. */
interface MoreTipDef extends TipDef {
  icon: React.ElementType;
  alpha?: boolean;
}

const STEPS: StepDef[] = [
  {
    id: 'agent-integrations',
    title: 'Set up agent integrations',
    subtitle: 'Get notified when your agents finish or need you',
  },
  {
    id: 'self-integration',
    title: 'Integrate your agent with Komla',
    subtitle: 'Your agent adds notifications and the Komla skill',
    runsAgent: true,
  },
  {
    id: 'project-setup',
    title: 'Set up project in Komla',
    subtitle: 'Get Quick Commands, Setup steps & automations',
    runsAgent: true,
  },
  {
    id: 'ssh',
    title: 'Set up an SSH host',
    subtitle: 'Run agents on another machine, a VM or a container',
  },
];

const MORE_TIPS: MoreTipDef[] = [
  {
    id: 'komla-skill',
    title: 'Komla skill',
    subtitle: 'Teach your agents how to use the Komla CLI',
    icon: BookOpenText,
  },
  {
    id: 'customize',
    title: 'Customize with an agent',
    subtitle: 'Ask your agent for hooks, shortcuts, a theme and more',
    icon: SlidersHorizontal,
  },
  {
    id: 'automations',
    title: 'Automations',
    subtitle: 'Run an agent on a schedule, here or on an SSH host',
    icon: CalendarDots,
  },
  {
    id: 'remote-control',
    title: 'Phone access',
    subtitle: 'Check on agents and answer prompts from your phone, over Tailscale',
    icon: DeviceMobile,
    alpha: true,
  },
  {
    id: 'status-bar',
    title: 'Status bar items',
    subtitle: 'Show Claude Code or Codex usage, or add your own',
    icon: Layout,
  },
  {
    id: 'dictation',
    title: 'Voice dictation',
    subtitle: 'Dictate prompts instead of typing them',
    icon: Microphone,
  },
  {
    id: 'shortcuts',
    title: 'Keyboard shortcuts',
    subtitle: 'Navigate workspaces & panes without the mouse',
    icon: Keyboard,
  },
  {
    id: 'multi-window',
    title: 'New window',
    subtitle: 'Work across several Komla windows at once',
    icon: Browsers,
  },
  {
    id: 'demo',
    title: 'Komla CLI demo',
    subtitle: 'Watch an agent try Komla’s CLI commands',
    icon: Sparkle,
  },
];

interface GettingStartedMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenShortcuts: () => void;
  onOpenSettingsTab: (tab: string, target?: Omit<SettingsDialogTarget, 'tab'>) => void;
  onOpenFeedback: () => void;
  onOpenNewWorkspace: () => void;
  /** With the Tips button hidden, the menu opens beside this element instead. */
  anchorRef?: React.RefObject<HTMLElement | null>;
  /** Opens above its button or anchor, for one along the bottom of the window. */
  side?: 'top' | 'bottom';
  /** Which edge of the button or anchor the menu lines up with. */
  align?: 'start' | 'end';
  /** Offers "Hide from status bar"; called once Tips has finished closing. */
  onHideButton?: () => void;
  /** Beside the hide link: where Tips can still be found. */
  hideHint?: string;
}

/** What Tips links to; without every one of them Tips isn't offered. */
export type TipsActions = Pick<
  GettingStartedMenuProps,
  'onOpenShortcuts' | 'onOpenSettingsTab' | 'onOpenFeedback' | 'onOpenNewWorkspace'
>;

/**
 * Opens a tab in the workspace for each agent to set itself up, one at a time so they
 * open in order, and shows the first. Setup leaves the workspace's agent, and the one
 * New Workspace picks, as they were.
 */
async function openSetupTabs(workspaceId: string, agents: AgentPreset[], prompt: string) {
  const { addAgentTab } = useWorkspacesStore.getState();
  const { addTab, showTabInFullPane } = useLayoutStore.getState();
  const terminalIds: string[] = [];
  for (const agent of agents) {
    const terminal = await addAgentTab(workspaceId, prompt, undefined, agent.id, {
      keepWorkspaceAgent: true,
    });
    addTab(workspaceId, terminal.id);
    terminalIds.push(terminal.id);
  }
  showTabInFullPane(terminalIds[0]);
}

/**
 * Marks agent setup done once New Workspace started every agent, or names the ones it
 * didn't start so they can be set up from Tips later.
 */
function finishSelfSetup(agents: AgentPreset[], startedIds: string[]) {
  const started = new Set(startedIds);
  const notStarted = agents.filter((agent) => !started.has(agent.id));
  if (notStarted.length === 0) {
    void useConfigStore.getState().updateConfig({ selfIntegrationTipCompleted: true });
    return;
  }
  const names = listAgentNames(notStarted.map((agent) => agent.name));
  useToastStore
    .getState()
    .addToast(
      notStarted.length > 1
        ? `${names} weren’t started. Set them up from Tips.`
        : `${names} wasn’t started. Set it up from Tips.`,
      'info'
    );
}

export function GettingStartedMenu({
  open,
  onOpenChange: setOpen,
  onOpenShortcuts,
  onOpenSettingsTab,
  onOpenFeedback,
  onOpenNewWorkspace,
  anchorRef,
  side = 'bottom',
  align = 'end',
  onHideButton,
  hideHint = 'Tips stays in the settings menu',
}: GettingStartedMenuProps) {
  const { config, updateConfig, hasProjects } = useConfigStore();
  const { presets, activePreset, activePresets, loadPresets } = useAgentPresetsStore();
  // What the status checks found done; null until the first check, when no count is shown.
  const [checkedDoneIds, setCheckedDoneIds] = useState<Set<string> | null>(null);
  // What project setup leaves behind: Setup steps, or Quick Commands of a project's own.
  const scopedProjectIds = useActionsStore(
    useShallow((s) => [...new Set(s.actions.flatMap((action) => action.projectIds ?? []))])
  );
  const projectSetUp = useProjectsStore((s) =>
    s.projects.some(
      (project) => (project.setupSteps?.length ?? 0) > 0 || scopedProjectIds.includes(project.id)
    )
  );
  const hideButtonOnClose = useRef(false);
  const selectedWorkspace = useWorkspacesStore((s) =>
    s.workspaces.find((workspace) => workspace.id === s.selectedWorkspaceId)
  );
  // Agent-led setup opens as tabs in the open workspace. SSH workspaces run agents
  // elsewhere, so setup there starts from New Workspace as before.
  const setupWorkspaceId =
    selectedWorkspace && selectedWorkspace.backend?.kind !== 'ssh' ? selectedWorkspace.id : null;
  const selfSetupAgents = activePresets.flatMap((entry) => {
    const preset = presets.find((candidate) => candidate.id === entry.presetId);
    return preset &&
      preset.openCommand.trim() &&
      !AGENTS_WITH_AUTO_INTEGRATIONS.includes(preset.name)
      ? [preset]
      : [];
  });

  // The self-integration tip targets users who skipped onboarding's project
  // step while picking an agent with no one-click integration — they never saw
  // the wizard's "Launch self-integration skill" button.
  const showSelfIntegrationTip =
    config?.selfIntegrationTipCreated === true ||
    (!hasProjects &&
      activePreset != null &&
      activePreset.openCommand.trim().length > 0 &&
      !AGENTS_WITH_AUTO_INTEGRATIONS.includes(activePreset.name));

  // Refresh the active preset when the popover opens so the self-integration
  // tip's visibility reflects the current agent selection.
  useEffect(() => {
    if (open) void loadPresets();
  }, [open, loadPresets]);

  const doneTipIds = new Set(checkedDoneIds);
  if (projectSetUp) doneTipIds.add('project-setup');

  // Refresh "done" status each time the popover opens
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      const done = new Set<string>();

      const results = await Promise.allSettled([
        window.api.getNotificationHookDetails(),
        window.api.getCodexNotificationHookDetails(),
        window.api.getAntigravityNotificationHookDetails(),
        window.api.getOpenCodeNotificationHookDetails(),
        window.api.getKomlaSkillStatus(),
        window.api.voiceGetModelStatus(),
        window.api.listSshHosts(),
        window.api.listAutomations(),
        window.api.pairedDevicesList(),
      ]);

      const isOk = <R extends PromiseSettledResult<unknown>>(
        r: R
      ): r is Extract<R, PromiseFulfilledResult<unknown>> => r.status === 'fulfilled';

      const hasNotifications = results
        .slice(0, 4)
        .some(
          (result) =>
            isOk(result) &&
            (result.value as { isConfigured?: boolean } | null)?.isConfigured === true
        );
      if (hasNotifications) done.add('agent-integrations');

      const skillResult = results[4];
      if (isOk(skillResult) && skillResult.value.isConfigured) done.add('komla-skill');

      const voiceResult = results[5];
      if (isOk(voiceResult) && voiceResult.value === 'ready') done.add('dictation');

      const sshHostsResult = results[6];
      if (isOk(sshHostsResult) && sshHostsResult.value.length > 0) done.add('ssh');

      // SSH hosts count with what was last read from them, so listing doesn't wait on them.
      const automationsResult = results[7];
      if (
        isOk(automationsResult) &&
        automationsResult.value.some((snapshot) => snapshot.automations.length > 0)
      ) {
        done.add('automations');
      }

      const devicesResult = results[8];
      if (isOk(devicesResult) && devicesResult.value.length > 0) done.add('remote-control');

      if (config?.selfIntegrationTipCompleted === true) done.add('self-integration');

      if (!cancelled) setCheckedDoneIds(done);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, config?.selfIntegrationTipCompleted]);

  // One tab per agent in the open workspace, so setup needs no workspace of its own.
  // Without one, New Workspace opens with these agents picked instead of the default. It
  // may start fewer, such as one in a folder project.
  const startSelfSetup = async (agents: AgentPreset[]) => {
    setOpen(false);
    try {
      const status = await window.api.getMcpStatus();
      const prompt = status.generic?.integrationPrompt;
      if (!prompt) return;
      // Setup is underway, so launching one of these agents needs no nudge to set it up.
      void updateConfig({ selfSetupNudgePending: false });
      if (!setupWorkspaceId) {
        openNewWorkspaceDialog({
          prompt,
          prefill: {
            presetIds: agents.map((agent) => agent.id),
            onLaunch: (startedIds) => finishSelfSetup(agents, startedIds),
          },
        });
        return;
      }
      await openSetupTabs(setupWorkspaceId, agents, prompt);
      void updateConfig({ selfIntegrationTipCompleted: true });
    } catch (err) {
      console.error('Failed to start agent setup:', err);
      useToastStore
        .getState()
        .addToast(`Couldn’t start agent setup: ${(err as Error).message}`, 'error');
    }
  };

  // Settings opened from Tips attributes an SSH host added during the visit to Tips.
  const openTipSettings = (tab: string) => onOpenSettingsTab(tab, { sshSetupSource: 'tips' });

  const handleTipAction = async (tipId: string) => {
    switch (tipId) {
      case 'demo': {
        useDialogsStore.getState().setNewWorkspaceDialogPrompt(buildOnboardingDemoPrompt());
        setOpen(false);
        onOpenNewWorkspace();
        break;
      }
      case 'project-setup': {
        useDialogsStore.getState().setNewWorkspaceDialogPrompt(buildProjectSetupPrompt());
        setOpen(false);
        onOpenNewWorkspace();
        break;
      }
      case 'self-integration': {
        const status = await window.api.getMcpStatus();
        const prompt = status.generic?.integrationPrompt;
        if (prompt) {
          useDialogsStore.getState().setNewWorkspaceDialogPrompt(prompt);
          void updateConfig({
            selfIntegrationTipCompleted: true,
            selfSetupNudgePending: false,
          });
          setOpen(false);
          onOpenNewWorkspace();
        }
        break;
      }
      case 'status-bar':
        setOpen(false);
        if (config?.showStatusBar === false) void updateConfig({ showStatusBar: true });
        useStatusBarCustomizeStore.getState().show();
        break;
      case 'customize': {
        setOpen(false);
        const prompt = buildCustomizePrompt();
        if (!selectedWorkspace) {
          useDialogsStore.getState().setNewWorkspaceDialogPrompt(prompt);
          onOpenNewWorkspace();
          break;
        }
        await openCustomizeAgent(selectedWorkspace.id, prompt);
        break;
      }
      case 'agent-integrations':
        setOpen(false);
        openTipSettings('integrations');
        break;
      case 'komla-skill':
        setOpen(false);
        // Installed, it opens where it can be removed; otherwise a dialog asks first.
        if (doneTipIds.has('komla-skill')) {
          openTipSettings('integrations');
          break;
        }
        offerKomlaSkillInstall();
        break;
      case 'ssh':
        setOpen(false);
        useSshHostDialogStore.getState().openAdd('tips');
        break;
      case 'automations':
        setOpen(false);
        openTipSettings('automations');
        break;
      case 'dictation':
        setOpen(false);
        openTipSettings('voice');
        break;
      case 'remote-control':
        setOpen(false);
        openTipSettings('remote');
        break;
      case 'multi-window':
        setOpen(false);
        void window.api.createWindow();
        break;
      case 'shortcuts':
        setOpen(false);
        onOpenShortcuts();
        break;
    }
  };

  // Until Tips is first opened, a dot on the button points new users at it.
  const showDiscoveryHint = config != null && config.onboardingTipsViewed !== true;
  const showNewDot = showDiscoveryHint && !open;

  // Follows `open` rather than the button, so opening Tips from the settings menu counts too.
  useEffect(() => {
    if (open && showDiscoveryHint) void updateConfig({ onboardingTipsViewed: true });
  }, [open, showDiscoveryHint, updateConfig]);

  // Opened from anywhere, Tips no longer needs the pointer at it shown after setup.
  const introPending = config?.tipsIntroPending === true;
  useEffect(() => {
    if (open && introPending) void updateConfig({ tipsIntroPending: false });
  }, [open, introPending, updateConfig]);

  const steps = STEPS.filter((step) => step.id !== 'self-integration' || showSelfIntegrationTip);
  // Only once statuses are in, so the highlight doesn't jump from the first step.
  const nextStepId = checkedDoneIds
    ? steps.find((step) => !doneTipIds.has(step.id))?.id
    : undefined;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {anchorRef ? (
        <PopoverAnchor virtualRef={anchorRef} />
      ) : (
        <TipsButton showNewDot={showNewDot} />
      )}

      <PopoverContent
        side={side}
        align={align}
        className="flex max-h-[var(--radix-popover-content-available-height)] w-96 flex-col p-0"
        onOpenAutoFocus={(e) => e.preventDefault()}
        // Hide the button only once Tips has closed: mid-fade, Tips would jump to the menu's anchor.
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          if (!hideButtonOnClose.current) return;
          hideButtonOnClose.current = false;
          onHideButton?.();
        }}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-border/60 py-1.5 pr-1.5 pl-3.5">
          <h2 className="text-sm font-semibold tracking-tight">Tips</h2>
          <button
            type="button"
            className="flex items-center gap-1.5 rounded px-1.5 py-1 text-ui text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
            onClick={() => {
              setOpen(false);
              onOpenFeedback();
            }}
          >
            <ChatCircle className="size-3.5" />
            Share feedback
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <TipSection
            label="Start here"
            progress={checkedDoneIds ? steps.map((step) => doneTipIds.has(step.id)) : undefined}
          >
            <ol className="flex flex-col">
              {steps.map((step, index) => {
                const state = doneTipIds.has(step.id)
                  ? 'done'
                  : step.id === nextStepId
                    ? 'next'
                    : 'todo';
                return (
                  <li key={step.id}>
                    {step.id === 'self-integration' && selfSetupAgents.length > 0 ? (
                      <SelfSetupStep
                        step={step}
                        number={index + 1}
                        state={state}
                        agents={selfSetupAgents}
                        inWorkspace={setupWorkspaceId !== null}
                        onStart={(agents) => void startSelfSetup(agents)}
                      />
                    ) : (
                      <StepRow
                        step={step}
                        number={index + 1}
                        state={state}
                        onAction={() => void handleTipAction(step.id)}
                      />
                    )}
                  </li>
                );
              })}
            </ol>
          </TipSection>

          <TipSection label="More to explore">
            <div className="grid grid-cols-2 gap-0.5">
              {MORE_TIPS.map((tip) => (
                <MoreTipTile
                  key={tip.id}
                  tip={tip}
                  done={doneTipIds.has(tip.id)}
                  onAction={() => void handleTipAction(tip.id)}
                />
              ))}
            </div>
          </TipSection>

          <p className="mx-3.5 flex gap-2.5 border-t border-border/60 py-2.5 text-ui text-muted-foreground">
            <Tray className="mt-px size-3.5 shrink-0" />
            <span>
              <span className="font-medium text-foreground">Done with a workspace?</span> Snooze it
              for later, or move it to the Trash, which keeps it {TRASH_RETENTION_DAYS} days.
            </span>
          </p>
        </div>

        {onHideButton && (
          <div className="flex shrink-0 items-center gap-2 border-t border-border/60 py-1.5 pr-1.5 pl-3.5">
            <span className="min-w-0 truncate text-2xs text-muted-foreground/70">{hideHint}</span>
            <button
              type="button"
              className="ml-auto shrink-0 rounded px-1.5 py-1 text-2xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
              onClick={() => {
                hideButtonOnClose.current = true;
                setOpen(false);
              }}
            >
              Hide from status bar
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** Tips in the status bar: the bulb, with a dot until Tips is first opened. */
function TipsButton({ showNewDot }: { showNewDot: boolean }) {
  const newHintId = useId();

  return (
    <>
      <PopoverTrigger asChild>
        <StatusBarButton
          tooltip="Tips"
          aria-label="Tips"
          aria-describedby={showNewDot ? newHintId : undefined}
        >
          <span className="relative flex">
            <Lightbulb className="size-3.5" />
            {showNewDot && (
              <span
                aria-hidden="true"
                className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-primary"
              />
            )}
          </span>
        </StatusBarButton>
      </PopoverTrigger>
      {showNewDot && (
        <span id={newHintId} className="sr-only">
          New: setup steps and demos
        </span>
      )}
    </>
  );
}

/** A titled part of Tips, optionally counting how many of its steps are done. */
function TipSection({
  label,
  progress,
  children,
}: {
  label: string;
  /** Whether each step is done, in order. */
  progress?: boolean[];
  children: React.ReactNode;
}) {
  const headingId = useId();
  const doneCount = progress?.filter(Boolean).length ?? 0;
  const allDone = progress != null && doneCount === progress.length;
  return (
    <section aria-labelledby={headingId} className="flex flex-col px-1.5 pt-1 pb-1.5">
      <div className="flex items-center justify-between px-2 pt-2 pb-1.5">
        <h3 id={headingId} className="text-ui font-medium text-muted-foreground">
          {label}
        </h3>
        {progress && (
          <span
            className={`flex items-center gap-1 text-2xs tabular-nums ${allDone ? 'text-success' : 'text-muted-foreground'}`}
          >
            {allDone ? (
              <>
                <Check weight="bold" className="size-3" />
                All set
              </>
            ) : (
              `${doneCount} of ${progress.length} done`
            )}
          </span>
        )}
      </div>
      {progress && (
        <div aria-hidden="true" className="mx-2 mb-1.5 flex gap-1">
          {progress.map((done, index) => (
            <span
              key={index}
              className={`h-1 flex-1 rounded-full ${done ? 'bg-success' : 'bg-muted'}`}
            />
          ))}
        </div>
      )}
      {children}
    </section>
  );
}

type StepState = 'done' | 'next' | 'todo';

const STEP_MARKER: Record<StepState, string> = {
  done: 'bg-success/15 text-success',
  next: 'bg-foreground text-background',
  todo: 'border border-border text-muted-foreground',
};

function StepRow({
  step,
  number,
  state,
  onAction,
  expanded,
}: {
  step: StepDef;
  number: number;
  state: StepState;
  onAction: () => void;
  /** Set when the row shows or hides more below it. */
  expanded?: boolean;
}) {
  return (
    <button
      type="button"
      aria-expanded={expanded}
      aria-current={state === 'next' ? 'step' : undefined}
      onClick={onAction}
      className={`group/tip flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden ${state === 'next' ? 'bg-accent/60' : ''}`}
    >
      <span
        className={`flex size-6 shrink-0 items-center justify-center rounded-full text-2xs font-semibold tabular-nums ${STEP_MARKER[state]}`}
      >
        {state === 'done' ? <Check weight="bold" className="size-3.5" /> : number}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-medium">
          {step.title}
          {state === 'done' && <span className="sr-only"> (done)</span>}
        </span>
        <span className="block text-ui text-muted-foreground">{step.subtitle}</span>
      </span>
      {expanded === undefined && step.runsAgent ? (
        <Badge
          variant="outline"
          className="gap-0.5 group-hover/tip:text-foreground group-hover/tip:ring-foreground/30"
        >
          <Play weight="fill" className="size-2" />
          Run
        </Badge>
      ) : (
        <CaretRight
          aria-hidden="true"
          className={`size-3.5 shrink-0 text-muted-foreground/60 transition-transform group-hover/tip:text-foreground ${expanded ? 'rotate-90' : ''}`}
        />
      )}
    </button>
  );
}

function MoreTipTile({
  tip,
  done,
  onAction,
}: {
  tip: MoreTipDef;
  done: boolean;
  onAction: () => void;
}) {
  const Icon = tip.icon;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onAction}
          className="group/tip flex h-8 min-w-0 items-center gap-2 rounded-md px-2 text-left text-ui hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
        >
          {done ? (
            <Check weight="bold" className="size-3.5 shrink-0 text-success" />
          ) : (
            <Icon className="size-3.5 shrink-0 text-muted-foreground group-hover/tip:text-foreground" />
          )}
          <span className="truncate">{tip.title}</span>
          {done && <span className="sr-only"> (done)</span>}
          {tip.alpha && <AlphaBadge />}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{tip.subtitle}</TooltipContent>
    </Tooltip>
  );
}

const agentListFormat = new Intl.ListFormat('en', { type: 'conjunction' });

// The self-integration step, naming the agents without one-click setup and which of them to set up.
function SelfSetupStep({
  step,
  number,
  state,
  agents,
  inWorkspace,
  onStart,
}: {
  step: StepDef;
  number: number;
  state: StepState;
  agents: AgentPreset[];
  /** Setup opens as tabs in the open workspace, rather than from New Workspace. */
  inWorkspace: boolean;
  onStart: (agents: AgentPreset[]) => void;
}) {
  const several = agents.length > 1;
  const namedStep = {
    ...step,
    title: `Integrate ${listAgentNames(agents.map((agent) => agent.name))} with Komla`,
    subtitle: several
      ? 'No one-click setup, so they set themselves up'
      : 'No one-click setup, so it sets itself up',
  };
  const [expanded, setExpanded] = useState(false);
  // Agents left out; the rest start ticked.
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(new Set());
  const chosen = agents.filter((agent) => !skipped.has(agent.id));

  const toggle = (id: string) => {
    setSkipped((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  };

  return (
    <>
      <StepRow
        step={namedStep}
        number={number}
        state={state}
        expanded={expanded}
        onAction={() => setExpanded(!expanded)}
      />
      {expanded && (
        <div className="mr-2 mb-1.5 ml-10.5 space-y-2">
          <p className="text-ui text-muted-foreground">
            {inWorkspace
              ? several
                ? 'Opens a tab for each in this workspace.'
                : 'Opens it in a new tab in this workspace.'
              : 'Opens New Workspace with the setup prompt.'}{' '}
            The agent checks what it supports and asks before changing anything.
          </p>
          {several && (
            <ul aria-label="Agents to set up" className="space-y-1">
              {agents.map((agent) => (
                <li key={agent.id}>
                  <label className="flex cursor-pointer items-center gap-2 text-xs">
                    <Checkbox checked={!skipped.has(agent.id)} onChange={() => toggle(agent.id)} />
                    <AgentPresetIcon preset={agent} className="size-3.5 shrink-0" />
                    {agent.name}
                  </label>
                </li>
              ))}
            </ul>
          )}
          <Button
            variant="outline"
            size="sm"
            className="h-6 px-2 text-ui"
            disabled={chosen.length === 0}
            onClick={() => onStart(chosen)}
          >
            Set up{' '}
            {chosen.length > 2
              ? `${chosen.length} agents`
              : agentListFormat.format(chosen.map((agent) => agent.name)) || 'agents'}
          </Button>
        </div>
      )}
    </>
  );
}
