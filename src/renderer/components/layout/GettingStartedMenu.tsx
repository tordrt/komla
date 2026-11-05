import {
  Lightbulb,
  Browsers,
  Keyboard,
  ChatCircle,
  ChatText,
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
  Star,
  SidebarSimple,
} from '@phosphor-icons/react';
import React, { useEffect, useId, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { StatusBarButton } from '@/components/layout/status-bar/StatusBarButton';
import { AgentPresetIcon } from '@/components/terminal/AgentPresetIcon';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { openCustomizeAgent } from '@/lib/customize-agent';
import { openKomlaGitHub } from '@/lib/komla-github';
import { openPromptDraft } from '@/lib/prompt-draft';
import { useWorkspaceExceptTitles } from '@/lib/workspace-except-titles';
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
import { ASK_FOR_PANEL, buildCustomizePrompt } from '../../../shared/constants/customize-prompt';
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

/** Everything else, offered as a compact tile, its subtitle a short line under the title. */
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
    title: 'Connect your agent to Komla',
    subtitle: 'Your agent adds notifications and the Komla skill',
    runsAgent: true,
  },
  {
    id: 'project-setup',
    title: 'Set up project in Komla',
    subtitle: 'Quick Commands, Setup steps & automations',
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
    id: 'demo',
    title: 'Komla CLI demo',
    subtitle: 'Watch an agent drive Komla',
    icon: Sparkle,
  },
  {
    id: 'komla-skill',
    title: 'Komla skill',
    subtitle: 'Teach agents the Komla CLI',
    icon: BookOpenText,
  },
  {
    id: 'panels',
    title: 'Custom sidebar panels',
    subtitle: 'Panels an agent builds you',
    icon: SidebarSimple,
  },
  {
    id: 'status-bar',
    title: 'Custom status bar items',
    subtitle: 'Live info like agent usage',
    icon: Layout,
  },
  {
    id: 'customize',
    title: 'Customize with an agent',
    subtitle: 'Hooks, shortcuts, themes',
    icon: SlidersHorizontal,
  },
  {
    id: 'automations',
    title: 'Automations',
    subtitle: 'Run agents on a schedule',
    icon: CalendarDots,
  },
  {
    id: 'remote-control',
    title: 'Phone access',
    subtitle: 'Answer agents on the go',
    icon: DeviceMobile,
    alpha: true,
  },
  {
    id: 'dictation',
    title: 'Voice dictation',
    subtitle: 'Speak instead of typing',
    icon: Microphone,
  },
  {
    id: 'prompt-draft',
    title: 'Prompt draft',
    subtitle: 'Draft a prompt as you read',
    icon: ChatText,
  },
  {
    id: 'shortcuts',
    title: 'Keyboard shortcuts',
    subtitle: 'Work without the mouse',
    icon: Keyboard,
  },
  {
    id: 'multi-window',
    title: 'New window',
    subtitle: 'Spread work across windows',
    icon: Browsers,
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
  hideHint = 'Tips is also in the settings menu',
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
  // It shows no titles, so an agent's spinner doesn't re-render it.
  const selectedWorkspace = useWorkspacesStore(
    useWorkspaceExceptTitles((s) =>
      s.workspaces.find((workspace) => workspace.id === s.selectedWorkspaceId)
    )
  );
  const selectedWorkspaceId = selectedWorkspace?.id;
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
        window.api.listPlugins(),
        // Panels can be a project's own, so the open workspace's are the ones to count.
        selectedWorkspaceId
          ? window.api.listSidebarPanels(selectedWorkspaceId)
          : Promise.resolve({ panels: [] }),
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

      // A plugin counts once Komla can read it, on or off.
      const pluginsResult = results[9];
      const panelsResult = results[10];
      if (
        (isOk(pluginsResult) && pluginsResult.value.some((plugin) => plugin.state !== 'invalid')) ||
        (isOk(panelsResult) && panelsResult.value.panels.length > 0)
      ) {
        done.add('panels');
      }

      if (config?.selfIntegrationTipCompleted === true) done.add('self-integration');

      if (!cancelled) setCheckedDoneIds(done);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, config?.selfIntegrationTipCompleted, selectedWorkspaceId]);

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
      case 'customize':
      case 'panels': {
        setOpen(false);
        const prompt = buildCustomizePrompt(tipId === 'panels' ? ASK_FOR_PANEL : undefined);
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
      case 'prompt-draft':
        setOpen(false);
        openPromptDraft();
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

  // The prompt draft is a workspace's.
  const moreTips = MORE_TIPS.filter((tip) => tip.id !== 'prompt-draft' || selectedWorkspace);
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
        sideOffset={8}
        collisionPadding={8}
        className="flex max-h-[var(--radix-popover-content-available-height)] w-96 flex-col p-0 light:border-foreground/20 light:shadow-[0_12px_32px_-6px_rgb(0_0_0/0.16),0_2px_6px_rgb(0_0_0/0.06)]"
        onOpenAutoFocus={(e) => e.preventDefault()}
        // Hide the button only once Tips has closed: mid-fade, Tips would jump to the menu's anchor.
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          if (!hideButtonOnClose.current) return;
          hideButtonOnClose.current = false;
          onHideButton?.();
        }}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-foreground/10 py-1.5 pr-1.5 pl-3.5">
          <h2 className="text-[13px] font-semibold">Tips</h2>
          <button
            type="button"
            className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-ui text-muted-foreground-70 transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
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
            <div className="grid grid-cols-2 gap-x-1 gap-y-0.5">
              {moreTips.map((tip) => (
                <MoreTipTile
                  key={tip.id}
                  tip={tip}
                  done={doneTipIds.has(tip.id)}
                  onAction={() => void handleTipAction(tip.id)}
                />
              ))}
            </div>
          </TipSection>

          <div className="mx-1.5 mb-1.5 flex flex-col gap-0.5 pt-1.5 text-ui text-muted-foreground-70 before:mx-2 before:mb-1 before:border-t before:border-foreground/8 before:content-['']">
            <p className="flex gap-2 px-2 py-1.5">
              <Tray className="mt-px size-3.5 shrink-0" />
              <span>
                <span className="font-medium text-muted-foreground">Done with a workspace?</span>{' '}
                Snooze it for later, or move it to the Trash, which keeps it {TRASH_RETENTION_DAYS}{' '}
                days.
              </span>
            </p>
            <button
              type="button"
              className="group/star flex items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
              onClick={() => {
                setOpen(false);
                openKomlaGitHub();
              }}
            >
              <Star className="size-3.5 shrink-0 group-hover/star:text-warning" />
              <span>
                <span className="font-medium text-muted-foreground">Enjoying Komla?</span> Give it a
                star on GitHub.
              </span>
            </button>
          </div>
        </div>

        {onHideButton && (
          <div className="flex shrink-0 items-center gap-2 border-t border-foreground/10 py-1.5 pr-1.5 pl-3.5">
            <span className="min-w-0 truncate text-ui text-muted-foreground-70">{hideHint}</span>
            <button
              type="button"
              className="ml-auto shrink-0 rounded-md px-2 py-1 text-ui font-medium text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
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
    <section
      aria-labelledby={headingId}
      className="flex flex-col px-1.5 pt-1 pb-1.5 not-first:pt-3.5"
    >
      <div className="flex items-center justify-between px-2 pt-2 pb-1.5">
        <h3 id={headingId} className="text-ui font-medium text-muted-foreground">
          {label}
        </h3>
        {progress && (
          <span
            className={`flex items-center gap-1 text-2xs tabular-nums ${allDone ? 'text-success' : 'text-muted-foreground-70'}`}
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
              className={`h-[3px] flex-1 rounded-full ${done ? 'bg-komla/80' : 'bg-foreground/10'}`}
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
  done: 'bg-success/12 text-success',
  next: 'bg-komla/15 text-komla ring-1 ring-komla/45 ring-inset',
  todo: 'ring-1 ring-foreground/15 ring-inset text-muted-foreground',
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
      className={`group/tip flex w-full items-center gap-2.5 rounded-md px-2 text-left ${state === 'done' ? 'py-1.5' : 'py-2'} focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden ${state === 'next' && !expanded ? 'bg-komla/[0.07] hover:bg-komla/[0.11]' : 'hover:bg-foreground/[0.06]'}`}
    >
      <span
        className={`flex shrink-0 items-center justify-center rounded-full text-2xs font-semibold tabular-nums ${state === 'done' ? 'mx-0.5 size-5' : 'size-6'} ${STEP_MARKER[state]}`}
      >
        {state === 'done' ? <Check weight="bold" className="size-3" /> : number}
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={`block text-xs font-medium ${state === 'done' ? 'text-muted-foreground' : ''}`}
        >
          {step.title}
          {state === 'done' && <span className="sr-only"> (done)</span>}
        </span>
        {/* A step done needs no more saying, so it keeps to one line. */}
        {state !== 'done' && (
          <span className="block text-ui text-muted-foreground">{step.subtitle}</span>
        )}
      </span>
      {expanded === undefined && step.runsAgent ? (
        <span className="flex shrink-0 items-center gap-1 text-2xs font-medium text-muted-foreground-70 group-hover/tip:text-komla">
          <Play weight="fill" className="size-2.5" />
          Run
          <span className="sr-only">, starts an agent</span>
        </span>
      ) : (
        <CaretRight
          aria-hidden="true"
          className={`size-3.5 shrink-0 text-muted-foreground-60 transition-transform group-hover/tip:text-foreground ${expanded ? 'rotate-90' : ''}`}
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
    <button
      type="button"
      onClick={onAction}
      className="group/tip flex min-w-0 items-start gap-2 rounded-md px-2 py-1 text-left hover:bg-foreground/[0.06] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
    >
      <Icon className="mt-px size-3.5 shrink-0 text-muted-foreground group-hover/tip:text-foreground" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-ui">
          <span className={`truncate ${done ? 'text-muted-foreground' : ''}`}>{tip.title}</span>
          {done && (
            <>
              <Check aria-hidden="true" weight="bold" className="size-3 shrink-0 text-success" />
              <span className="sr-only"> (done)</span>
            </>
          )}
          {tip.alpha && (
            <span className="shrink-0 rounded px-1 text-[10px] leading-3.5 font-medium text-muted-foreground-70 ring-1 ring-foreground/12 ring-inset">
              Alpha
            </span>
          )}
        </span>
        <span
          className={`block truncate text-2xs ${done ? 'text-muted-foreground-50' : 'text-muted-foreground-70'}`}
        >
          {tip.subtitle}
        </span>
      </span>
    </button>
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
    title: `Connect ${listAgentNames(agents.map((agent) => agent.name))} to Komla`,
    subtitle: several
      ? 'Each one sets up its own integration'
      : `${agents[0].name} sets up its own integration`,
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
    // Expanded, the tint holds the step and what it opened, so they read as one. Blue only for
    // the next step, so no other step looks current.
    <div
      className={
        expanded
          ? `rounded-md pb-2 ${state === 'next' ? 'bg-komla/[0.07]' : 'bg-foreground/[0.035]'}`
          : undefined
      }
    >
      <StepRow
        step={namedStep}
        number={number}
        state={state}
        expanded={expanded}
        onAction={() => setExpanded(!expanded)}
      />
      {expanded && (
        <div className="mr-2 ml-10.5 space-y-2">
          <p className="text-ui text-muted-foreground">
            {inWorkspace
              ? several
                ? 'Opens a tab for each.'
                : `Opens ${agents[0].name} in a new tab.`
              : 'Opens New Workspace with the setup prompt.'}{' '}
            {several ? 'Each checks' : 'It checks'} what it supports and asks before changing
            anything.
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
            size="sm"
            className="h-6 px-2.5 text-ui"
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
    </div>
  );
}
