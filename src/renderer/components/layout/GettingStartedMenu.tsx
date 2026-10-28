import {
  Lightbulb,
  Wrench,
  Plugs,
  Browsers,
  Keyboard,
  ChatCircle,
  Tray,
  Cloud,
  Microphone,
  Sparkle,
  Check,
  Plug,
  CaretRight,
  SlidersHorizontal,
  CalendarDots,
  Layout,
  BookOpenText,
  DeviceMobile,
} from '@phosphor-icons/react';
import React, { useEffect, useId, useRef, useState } from 'react';

import { StatusBarButton } from '@/components/layout/status-bar/StatusBarButton';
import { AgentPresetIcon } from '@/components/terminal/AgentPresetIcon';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { openCustomizeAgent } from '@/lib/customize-agent';
import { offerKomlaSkillInstall } from '@/stores/agent-launch-defaults-dialog.store';
import { useAgentPresetsStore } from '@/stores/agent-presets.store';
import { useConfigStore } from '@/stores/config.store';
import { openNewWorkspaceDialog, useDialogsStore } from '@/stores/dialogs.store';
import { useLayoutStore } from '@/stores/layout.store';
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

type TipSection = 'setup' | 'explore';

interface TipDef {
  id: string;
  title: string;
  subtitle: string;
  actionLabel?: string;
  icon: React.ElementType;
  section: TipSection;
}

const SECTION_LABELS: Record<TipSection, string> = {
  setup: 'Set up Komla',
  explore: 'More to explore',
};

const TIPS: TipDef[] = [
  {
    id: 'agent-integrations',
    title: 'Set up agent integrations',
    subtitle: 'Get notified when your agents finish or need you',
    actionLabel: 'Settings',
    icon: Plugs,
    section: 'setup',
  },
  {
    id: 'self-integration',
    title: 'Integrate your agent with Komla',
    subtitle: 'Let your agent wire up notifications & the Komla skill itself',
    actionLabel: 'Run',
    icon: Plug,
    section: 'setup',
  },
  {
    id: 'project-setup',
    title: 'Run project setup skill',
    subtitle: 'Get quick commands, workspace setup & automation recommendations',
    actionLabel: 'Run',
    icon: Wrench,
    section: 'setup',
  },
  {
    id: 'ssh',
    title: 'Set up an SSH host',
    subtitle: 'Run agents on another machine, a VM or a container',
    actionLabel: 'Set up',
    icon: Cloud,
    section: 'setup',
  },
  {
    id: 'komla-skill',
    title: 'Install the Komla skill',
    subtitle: 'Teach your agents how to use the Komla CLI',
    actionLabel: 'Install',
    icon: BookOpenText,
    section: 'setup',
  },
  {
    id: 'demo',
    title: 'Komla CLI demo',
    subtitle: 'See Komla’s CLI commands in action',
    actionLabel: 'Run',
    icon: Sparkle,
    section: 'setup',
  },
  {
    id: 'status-bar',
    title: 'Customize the status bar',
    subtitle: 'Pick items like Claude Code or Codex usage, or add custom ones',
    actionLabel: 'Customize',
    icon: Layout,
    section: 'setup',
  },
  {
    id: 'automations',
    title: 'Schedule an automation',
    subtitle: 'Run an agent on a schedule, here or on an SSH host',
    actionLabel: 'Settings',
    icon: CalendarDots,
    section: 'setup',
  },
  {
    id: 'customize',
    title: 'Customize Komla with your agent',
    subtitle: 'Ask for status bar items, hooks, shortcuts or a theme',
    actionLabel: 'Run',
    icon: SlidersHorizontal,
    section: 'explore',
  },
  {
    id: 'dictation',
    title: 'Set up voice dictation',
    subtitle: 'Dictate prompts instead of typing them',
    actionLabel: 'Settings',
    icon: Microphone,
    section: 'explore',
  },
  {
    id: 'remote-control',
    title: 'Use Komla from your phone',
    subtitle: 'Check on agents and answer prompts. Needs Tailscale (alpha)',
    actionLabel: 'Settings',
    icon: DeviceMobile,
    section: 'explore',
  },
  {
    id: 'multi-window',
    title: 'Multi-window support',
    subtitle: 'Work across multiple Komla windows',
    actionLabel: 'Try',
    icon: Browsers,
    section: 'explore',
  },
  {
    id: 'shortcuts',
    title: 'Learn keyboard shortcuts',
    subtitle: 'Navigate workspaces & panes without the mouse',
    actionLabel: 'View',
    icon: Keyboard,
    section: 'explore',
  },
  {
    id: 'feedback',
    title: 'Share feedback',
    subtitle: 'Feature requests & bug reports',
    actionLabel: 'Open',
    icon: ChatCircle,
    section: 'explore',
  },
  {
    id: 'workspace-lifecycle',
    title: 'Done with a workspace?',
    subtitle: `Snooze it for later, or move it to the Trash, which keeps it ${TRASH_RETENTION_DAYS} days`,
    icon: Tray,
    section: 'explore',
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
  const [doneTipIds, setDoneTipIds] = useState<Set<string>>(new Set());
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

      if (!cancelled) setDoneTipIds(done);
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
          void updateConfig({ selfIntegrationTipCompleted: true, selfSetupNudgePending: false });
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
      case 'feedback':
        setOpen(false);
        onOpenFeedback();
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
        className="max-h-[var(--radix-popover-content-available-height)] w-80 overflow-y-auto p-0"
        onOpenAutoFocus={(e) => e.preventDefault()}
        // Hide the button only once Tips has closed: mid-fade, Tips would jump to the menu's anchor.
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          if (!hideButtonOnClose.current) return;
          hideButtonOnClose.current = false;
          onHideButton?.();
        }}
      >
        <div className="px-3 py-2.5">
          <span className="text-sm font-semibold tracking-tight">Tips</span>
        </div>
        <div className="border-b border-border/60" />

        <div className="flex flex-col p-1.5">
          {(['setup', 'explore'] as TipSection[]).map((section, sectionIdx) => {
            const sectionTips = TIPS.filter(
              (tip) =>
                tip.section === section && (tip.id !== 'self-integration' || showSelfIntegrationTip)
            );
            if (sectionTips.length === 0) return null;

            const Section = section === 'explore' ? 'details' : 'section';
            const Heading = section === 'explore' ? 'summary' : 'div';
            return (
              <Section key={section} className="group flex flex-col gap-0.5">
                <Heading
                  className={`flex cursor-pointer list-none items-center justify-between px-2 pb-1 text-2xs font-semibold tracking-wide text-muted-foreground/60 uppercase ${sectionIdx === 0 ? 'pt-1' : 'pt-2.5'}`}
                >
                  {SECTION_LABELS[section]}
                  {section === 'explore' && <CaretRight className="size-3 group-open:rotate-90" />}
                </Heading>
                {sectionTips.map((tip) =>
                  tip.id === 'self-integration' && selfSetupAgents.length > 0 ? (
                    <SelfSetupTip
                      key={tip.id}
                      tip={tip}
                      doneTipIds={doneTipIds}
                      agents={selfSetupAgents}
                      inWorkspace={setupWorkspaceId !== null}
                      onStart={(agents) => void startSelfSetup(agents)}
                    />
                  ) : (
                    <TipRow
                      key={tip.id}
                      tip={tip}
                      doneTipIds={doneTipIds}
                      onAction={handleTipAction}
                    />
                  )
                )}
              </Section>
            );
          })}
        </div>

        {onHideButton && (
          <div className="flex items-center gap-2 border-t border-border/60 px-3 py-1.5">
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

function TipRow({
  tip,
  doneTipIds,
  onAction,
  expanded,
}: {
  tip: TipDef;
  doneTipIds: Set<string>;
  onAction: (tipId: string) => Promise<void>;
  /** Set when the row shows or hides more below it. */
  expanded?: boolean;
}) {
  const Icon = tip.icon;
  const isDone = doneTipIds.has(tip.id);

  const Row = tip.actionLabel ? 'button' : 'div';
  return (
    <Row
      aria-expanded={expanded}
      onClick={tip.actionLabel ? () => void onAction(tip.id) : undefined}
      className={`flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left ${tip.actionLabel ? 'hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden' : ''} ${isDone ? 'opacity-60' : ''}`}
    >
      <div className="flex size-6 shrink-0 items-center justify-center">
        {isDone ? (
          <Check weight="bold" className="size-4 text-success" />
        ) : (
          <Icon className="size-4 text-muted-foreground" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-xs font-medium">{tip.title}</div>
        <div className="text-ui text-muted-foreground">{tip.subtitle}</div>
      </div>
      {tip.actionLabel && (
        <span className="shrink-0 text-ui text-muted-foreground">
          {isDone ? 'Open' : tip.actionLabel}
        </span>
      )}
    </Row>
  );
}

const agentListFormat = new Intl.ListFormat('en', { type: 'conjunction' });

// The self-integration tip, naming the agents without one-click setup and which of them to set up.
function SelfSetupTip({
  tip,
  doneTipIds,
  agents,
  inWorkspace,
  onStart,
}: {
  tip: TipDef;
  doneTipIds: Set<string>;
  agents: AgentPreset[];
  /** Setup opens as tabs in the open workspace, rather than from New Workspace. */
  inWorkspace: boolean;
  onStart: (agents: AgentPreset[]) => void;
}) {
  const several = agents.length > 1;
  const namedTip = {
    ...tip,
    title: `Integrate ${listAgentNames(agents.map((agent) => agent.name))} with Komla`,
    subtitle: several
      ? 'They have no one-click setup, so they wire up notifications & the Komla skill themselves'
      : 'It has no one-click setup, so it wires up notifications & the Komla skill itself',
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
      <TipRow
        tip={namedTip}
        doneTipIds={doneTipIds}
        expanded={expanded}
        onAction={async () => setExpanded(!expanded)}
      />
      {expanded && (
        <div className="mr-2 mb-1.5 ml-10 space-y-2">
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
