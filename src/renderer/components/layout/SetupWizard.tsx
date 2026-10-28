import { CaretDown, CaretUp, Check, Plus } from '@phosphor-icons/react';
import React, { useState, useEffect, useCallback } from 'react';

import { ProjectCreationForm } from '@/components/projects/ProjectCreationForm';
import { addedConfigAliases } from '@/components/ssh-hosts/SshConfigHostPicker';
import { AgentPresetIcon, hasAgentPresetLogo } from '@/components/terminal/AgentPresetIcon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Input } from '@/components/ui/input';
import { KomlaBackdrop } from '@/components/ui/komla-backdrop';
import { KomlaMark } from '@/components/ui/komla-mark';
import { Spinner } from '@/components/ui/spinner';
import { clearOnboardingProjectId, storeOnboardingProjectId } from '@/lib/onboarding-progress';
import { cn } from '@/lib/utils';
import { useAgentPresetsStore } from '@/stores/agent-presets.store';
import { useConfigStore } from '@/stores/config.store';
import { useSshHostDialogStore } from '@/stores/ssh-host-dialog.store';
import { deriveAgentName } from '@/utils/agent-name';
import { getDefaultBranchPrefix } from '@/utils/branch-prefix';

import {
  AGENTS_WITH_AUTO_INTEGRATIONS,
  POPULAR_OTHER_AGENTS,
  RECOMMENDED_AGENTS,
} from '../../../shared/constants/agents';
import { hasDuplicateLevelNames } from '../../../shared/lib/level-picker';

import { OnboardingAnalyticsStep } from './OnboardingAnalyticsStep';
import { OnboardingConnectStep, useAgentConnections } from './OnboardingConnectStep';
import { OnboardingFoundAgents } from './OnboardingFoundAgents';
import { OnboardingLaunchStep } from './OnboardingLaunchStep';
import { OnboardingMachineStep } from './OnboardingMachineStep';
import { OnboardingZoomControl } from './OnboardingZoomControl';
import { integrationFilterForAgent } from './settings/AgentIntegrations';
import { CommandInputs } from './settings/CommandInputs';

import type { LaunchAgent } from './OnboardingConnectStep';
import type { AgentMachine } from './OnboardingMachineStep';
import type { AgentPreset, LaunchMode, Project, ReasoningLevel, SshConfigHost } from '@/types';

// Featured agent card (the four with one-click setup).
function FeaturedAgentCard({
  preset,
  isSelected,
  onSelect,
}: {
  preset: Pick<AgentPreset, 'name' | 'openCommand'>;
  isSelected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      aria-pressed={isSelected}
      className={cn(
        'relative flex items-center justify-between gap-2 rounded-lg border p-3 text-left transition-all',
        isSelected
          ? 'border-primary/50 bg-primary/5 ring-2 ring-primary/50'
          : 'border-border hover:bg-muted/50'
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <AgentPresetIcon preset={preset} className="size-4 shrink-0" />
        <span className="truncate font-medium">{preset.name}</span>
      </div>
      {isSelected && (
        <div className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary">
          <Check className="size-3 text-primary-foreground" />
        </div>
      )}
      {RECOMMENDED_AGENTS.includes(preset.name) && (
        <Badge tone="primary" variant="solid" className="absolute -top-2 right-2">
          Recommended
        </Badge>
      )}
    </button>
  );
}

// Secondary agent — compact chip for self-integration agents.
function AgentChip({
  preset,
  isSelected,
  onSelect,
}: {
  preset: Pick<AgentPreset, 'name' | 'openCommand'>;
  isSelected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      aria-pressed={isSelected}
      title={preset.name}
      className={cn(
        'flex items-center justify-start gap-1.5 rounded-md border px-2.5 py-2 text-left text-sm transition-all',
        isSelected
          ? 'border-primary/50 bg-primary/5 ring-2 ring-primary/50'
          : 'border-border hover:bg-muted/50'
      )}
    >
      {isSelected && <Check className="size-3 shrink-0 text-primary" />}
      <AgentPresetIcon preset={preset} className="size-3.5 shrink-0" />
      <span className="truncate font-medium">{preset.name}</span>
    </button>
  );
}

interface SetupWizardProps {
  onComplete?: () => void;
  /** Project created by an earlier, unfinished onboarding; resumes at the agent step. */
  resumeProjectId?: string;
}

const projectStep = 1;
const agentStep = 2;
const connectStep = 3;
const machineStep = 4;
const analyticsStep = 5;
const stepLabels = ['Project', 'Agent', 'Connect', 'Machine'];

type AgentTemplate = Omit<AgentPreset, 'id'>;

// Agents with one-click integration, each with the one it uses, apart from the
// agents that set up their own.
function splitByIntegration(agents: LaunchAgent[]) {
  return {
    integrationAgents: agents.flatMap((agent) => {
      const filter = integrationFilterForAgent(agent.name);
      return filter ? [{ ...agent, filter }] : [];
    }),
    selfIntegratingAgents: agents.filter((agent) => !integrationFilterForAgent(agent.name)),
  };
}

export function SetupWizard({ onComplete, resumeProjectId }: SetupWizardProps) {
  const { config, updateConfig, loadConfig } = useConfigStore();
  const { templates, loadTemplates, createActivePresets } = useAgentPresetsStore();

  // Shell Only is opt-in via Settings, not part of onboarding.
  const agentTemplates = templates.filter((t) => t.name !== 'Shell Only');
  // Featured = one-click integration agents; the rest self-integrate. Custom
  // is its own escape hatch at the end.
  const featuredTemplates = agentTemplates.filter((t) =>
    AGENTS_WITH_AUTO_INTEGRATIONS.includes(t.name)
  );
  const otherTemplates = agentTemplates.filter(
    (t) => !AGENTS_WITH_AUTO_INTEGRATIONS.includes(t.name) && t.name !== 'Custom'
  );
  const popularOtherTemplates = otherTemplates.filter((t) => POPULAR_OTHER_AGENTS.includes(t.name));
  const restOtherTemplates = otherTemplates.filter((t) => !POPULAR_OTHER_AGENTS.includes(t.name));
  const orderedOtherTemplates = [...popularOtherTemplates, ...restOtherTemplates].sort(
    (a, b) => Number(hasAgentPresetLogo(b)) - Number(hasAgentPresetLogo(a))
  );
  const customTemplate = agentTemplates.find((t) => t.name === 'Custom');

  const [step, setStep] = useState(resumeProjectId ? agentStep : projectStep);
  // Templates whose CLI is installed on this computer; null while Komla looks.
  const [detectedAgentNames, setDetectedAgentNames] = useState<string[] | null>(null);
  const [selectedTemplateName, setSelectedTemplateName] = useState<string>('');
  // Guards the agent-selected telemetry ping to once per wizard completion.
  const agentSelectedTrackedRef = React.useRef(false);
  const [openCommand, setOpenCommand] = useState('');
  const [continueCommand, setContinueCommand] = useState('');
  const [promptCommand, setPromptCommand] = useState('');
  const [launchModes, setLaunchModes] = useState<LaunchMode[]>([]);
  const [reasoningLevels, setReasoningLevels] = useState<ReasoningLevel[]>([]);
  const [displayName, setDisplayName] = useState('');
  const [displayNameTouched, setDisplayNameTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showAllAgents, setShowAllAgents] = useState(false);
  const createdProjectIdRef = React.useRef<string | null>(resumeProjectId ?? null);
  // A skipped Project step can be gone back to; one that added a project can't (see below).
  const [skippedProject, setSkippedProject] = useState(false);
  // The agents already added, so retrying Start working after a failure adds nothing twice.
  const createdPresetsRef = React.useRef<string | null>(null);
  // Agents Komla found that the user unticked; any it finds later start ticked.
  const [excludedAgentNames, setExcludedAgentNames] = useState<ReadonlySet<string>>(new Set());
  // Set when the user leaves the agents Komla found for the agent picker, say after a wrong match.
  const [pickingOtherAgent, setPickingOtherAgent] = useState(false);
  const [templatesLoaded, setTemplatesLoaded] = useState(false);
  const [machine, setMachine] = useState<AgentMachine>('local');
  const [sshConfigHosts, setSshConfigHosts] = useState<SshConfigHost[]>([]);
  const [pickedSshAlias, setPickedSshAlias] = useState<string | null>(null);
  const sshConfigHostsRequestedRef = React.useRef(false);
  // Usage analytics are asked once; setup asks, on a step of its own, unless the user already
  // answered. Decided as setup opens, so saving the answer doesn't take the step away mid-way.
  const [askAnalytics] = useState(() => config?.usageTelemetryConsentAnswered !== true);
  const labels = askAnalytics ? [...stepLabels, 'Analytics'] : stepLabels;
  const [shareAnalytics, setShareAnalytics] = useState<boolean | null>(null);
  const [crashReports, setCrashReports] = useState(() => config?.errorReportingEnabled !== false);

  const detectAgents = useCallback(() => {
    window.api
      .detectInstalledAgents()
      .then(setDetectedAgentNames)
      .catch((err: unknown) => {
        console.error('Failed to detect installed agents:', err);
        setDetectedAgentNames([]);
      });
  }, []);

  // Load templates and look for installed agents on mount, so the result is
  // usually ready by the time the Project step is done.
  useEffect(() => {
    void loadTemplates().finally(() => setTemplatesLoaded(true));
    detectAgents();
  }, [loadTemplates, detectAgents]);

  // Demo prompts use the shared skill-fetch builder and its data-dir fallback.

  // Set default selection when templates load
  useEffect(() => {
    if (templates.length > 0 && !selectedTemplateName) {
      const defaultTemplate = templates.find((t) => t.name === 'Claude Code') || templates[0];
      setSelectedTemplateName(defaultTemplate.name);
      setOpenCommand(defaultTemplate.openCommand);
      setContinueCommand(defaultTemplate.continueCommand);
      setPromptCommand(defaultTemplate.promptCommand);
      setLaunchModes(defaultTemplate.launchModes);
      setReasoningLevels(defaultTemplate.reasoningLevels ?? []);
    }
  }, [templates, selectedTemplateName]);

  // Komla always has agent templates, so none once loading is done means it failed.
  const templatesFailed = templatesLoaded && templates.length === 0;
  const detecting = !templatesFailed && (detectedAgentNames === null || templates.length === 0);
  const detectedNames = new Set(detectedAgentNames);
  const detectedTemplates = detecting
    ? []
    : agentTemplates.filter((t) => detectedNames.has(t.name));
  // The agent step lists the agents Komla found to choose from, and shows the
  // agent picker when it finds none or the user asks for it.
  const usesDetectedAgents = detectedTemplates.length > 0 && !pickingOtherAgent;
  const chosenTemplates = detectedTemplates.filter((t) => !excludedAgentNames.has(t.name));

  const isCustomPreset = selectedTemplateName === 'Custom';
  // The built-in "Custom" preset has no real name — "Custom" reads poorly in
  // launch-step copy, so use the display name (or the launch command's binary).
  const agentLabel = isCustomPreset
    ? displayName.trim() || deriveAgentName(openCommand) || 'your agent'
    : selectedTemplateName;
  const launchAgents: LaunchAgent[] = usesDetectedAgents
    ? chosenTemplates.map((t) => ({ name: t.name, label: t.name, preset: t }))
    : [
        {
          name: selectedTemplateName,
          label: agentLabel,
          preset: { name: selectedTemplateName, openCommand },
        },
      ];
  const { integrationAgents, selfIntegratingAgents } = splitByIntegration(launchAgents);
  const { connections, pending, errors, toggle } = useAgentConnections(
    integrationAgents.map((agent) => agent.filter),
    step === connectStep
  );

  const handleToggleAgent = (name: string) => {
    setExcludedAgentNames((current) => {
      const next = new Set(current);
      if (!next.delete(name)) next.add(name);
      return next;
    });
  };

  const handleCheckAgain = () => {
    setDetectedAgentNames(null);
    detectAgents();
  };

  const handleRetryTemplates = () => {
    setTemplatesLoaded(false);
    void loadTemplates().finally(() => setTemplatesLoaded(true));
  };

  // Update command fields when template changes
  const handleTemplateChange = (templateName: string) => {
    // Re-picking the selected agent would reset its edited commands and levels.
    if (templateName === selectedTemplateName) return;
    setSelectedTemplateName(templateName);
    const template = templates.find((t) => t.name === templateName);
    if (template) {
      setOpenCommand(template.openCommand);
      setContinueCommand(template.continueCommand);
      setPromptCommand(template.promptCommand);
      setLaunchModes(template.launchModes);
      setReasoningLevels(template.reasoningLevels ?? []);
      setDisplayName(deriveAgentName(template.openCommand));
      setDisplayNameTouched(false);
    }
    // Featured agents ship verified commands; the "Other agents" templates are
    // best-effort defaults, so surface them for the user to check.
    setShowAdvanced(!AGENTS_WITH_AUTO_INTEGRATIONS.includes(templateName));
    setError(null);
  };

  const handleMachineChange = (next: AgentMachine) => {
    setMachine(next);
    if (next !== 'ssh' || sshConfigHostsRequestedRef.current) return;
    sshConfigHostsRequestedRef.current = true;
    // Hosts the user already reaches over SSH, leaving out the ones Komla already has.
    Promise.all([window.api.listSshConfigHosts(), window.api.listSshHosts().catch(() => [])])
      .then(([entries, hosts]) => {
        const added = addedConfigAliases(entries, hosts);
        setSshConfigHosts(entries.filter((entry) => !added.has(entry.alias.toLowerCase())));
      })
      .catch(() => {});
  };

  const handleCompleteWithProject = (project: Project) => {
    createdProjectIdRef.current = project.id;
    setSkippedProject(false);
    // Remember the project so quitting before setup finishes resumes at the agent step.
    storeOnboardingProjectId(project.id);
    setStep(agentStep);
  };

  const handleSkipProject = () => {
    createdProjectIdRef.current = null;
    clearOnboardingProjectId();
    setSkippedProject(true);
    setStep(agentStep);
  };

  // The agent picked on the agent step, with its commands as edited there.
  const buildPickedPreset = (): AgentTemplate => {
    const trimmedModes = launchModes.flatMap((mode) => {
      const name = mode.name.trim();
      if (!name && !(mode.arguments ?? '').trim()) return [];
      return [
        {
          ...mode,
          name,
          ...(mode.arguments !== undefined ? { arguments: mode.arguments.trim() } : {}),
        },
      ];
    });
    const trimmedLevels = reasoningLevels.flatMap((level) => {
      const name = level.name.trim();
      const args = level.arguments.trim();
      return name || args ? [{ ...level, name, arguments: args }] : [];
    });
    // An agent without levels stays unset, so it can still pick up levels
    // added to its template later.
    const hasLevels =
      templates.find((t) => t.name === selectedTemplateName)?.reasoningLevels !== undefined ||
      trimmedLevels.length > 0;

    return {
      name: isCustomPreset
        ? displayName.trim() || deriveAgentName(openCommand) || 'Custom'
        : selectedTemplateName,
      openCommand: openCommand.trim(),
      continueCommand: continueCommand.trim(),
      promptCommand: promptCommand.trim(),
      launchModes: trimmedModes,
      reasoningLevels: hasLevels ? trimmedLevels : undefined,
      isBuiltin: false,
    };
  };

  const handleComplete = async () => {
    setIsCreating(true);
    setError(null);

    try {
      const presets = usesDetectedAgents
        ? chosenTemplates.map((template) => ({ ...template, isBuiltin: false }))
        : [buildPickedPreset()];
      const presetsKey = JSON.stringify(presets);
      if (createdPresetsRef.current !== presetsKey) {
        await createActivePresets(presets);
        createdPresetsRef.current = presetsKey;
      }

      const { ok } = await updateConfig({
        agentSetupComplete: true,
        ...(createdProjectIdRef.current && { defaultProjectId: createdProjectIdRef.current }),
        // Tips offers the self-integration skill to agents without one-click setup.
        ...(selfIntegratingAgents.length > 0 && { selfIntegrationTipCreated: true }),
        // The first launch of an agent that can't notify Komla yet points at its setup.
        notificationsNudgePending: true,
        selfSetupNudgePending: true,
        // The first screen after setup points at Tips.
        tipsIntroPending: true,
        ...(askAnalytics &&
          shareAnalytics !== null && {
            usageTelemetryEnabled: shareAnalytics,
            errorReportingEnabled: crashReports,
          }),
      });
      if (ok) clearOnboardingProjectId();

      // Reload config to update hasProjects state
      await loadConfig();

      // Record the default agent. A custom agent is reported by its template
      // name, never the name the user gave it. Fire-and-forget — telemetry
      // must never block onboarding.
      const selectedAgent = usesDetectedAgents ? presets[0].name : selectedTemplateName;
      if (!agentSelectedTrackedRef.current && selectedAgent) {
        agentSelectedTrackedRef.current = true;
        void window.api.trackAgentSelected(selectedAgent);
      }

      // The SSH host is added once setup is done, so a failed check never holds it up.
      if (machine === 'ssh') {
        useSshHostDialogStore.getState().openAdd('onboarding', {
          configHost: sshConfigHosts.find((host) => host.alias === pickedSshAlias),
        });
      }

      // Notify parent that setup is complete (avoids full page reload)
      onComplete?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsCreating(false);
    }
  };

  const handleNext = async () => {
    if (step === agentStep && usesDetectedAgents) {
      setStep(connectStep);
      setError(null);
    } else if (step === agentStep) {
      if (isCustomPreset && !openCommand.trim()) {
        setError('Please enter the open command');
        return;
      }
      const incompleteModes = launchModes.filter(
        (m) => (m.arguments ?? '').trim() && !m.name.trim()
      );
      if (incompleteModes.length > 0) {
        setError('Every launch mode must have a name');
        setShowAdvanced(true);
        return;
      }
      // A level without arguments would launch the same as Default.
      if (reasoningLevels.some((level) => !level.name.trim() !== !level.arguments.trim())) {
        setError('Every effort level needs a name and arguments');
        setShowAdvanced(true);
        return;
      }
      if (hasDuplicateLevelNames(reasoningLevels)) {
        setError('Every effort level needs its own name');
        setShowAdvanced(true);
        return;
      }
      setStep(connectStep);
      setError(null);
    }
  };

  const showAgentPicker =
    step === agentStep && !detecting && !templatesFailed && !usesDetectedAgents;

  return (
    <div className="relative flex h-full items-center justify-center p-8">
      <KomlaBackdrop />
      <div className="relative flex max-h-full w-full max-w-xl flex-col gap-6 overflow-hidden">
        {/* Header */}
        <div className="shrink-0 text-center">
          <h1 className="flex items-center justify-center gap-2.5 text-3xl font-semibold">
            Welcome to{' '}
            <span className="flex items-center gap-2 rounded-full bg-komla/15 py-1.5 pr-4.5 pl-2.5 ring-1 ring-komla/30 ring-inset">
              <KomlaMark className="size-7" />
              Komla
            </span>
          </h1>
        </div>

        {/* Progress indicator with labels */}
        <div className="flex shrink-0 justify-center gap-4">
          {labels.map((label, i) => {
            const s = i + 1;
            return (
              <div key={label} className="flex flex-col items-center gap-1">
                <div
                  className={cn(
                    'h-1.5 w-8 rounded-full transition-colors',
                    s <= step ? 'bg-primary' : 'bg-muted'
                  )}
                />
                <span
                  className={cn(
                    'text-2xs font-medium transition-colors',
                    s === step ? 'text-primary' : 'text-muted-foreground/60'
                  )}
                >
                  {label}
                </span>
              </div>
            );
          })}
        </div>

        <div key={step} className="wizard-step-enter min-h-0 flex-1 overflow-y-auto p-6">
          {step === agentStep && detecting && (
            <p
              role="status"
              className="flex items-center justify-center gap-2 text-sm text-muted-foreground"
            >
              <Spinner size="xs" />
              Looking for agents on this computer…
            </p>
          )}

          {step === agentStep && templatesFailed && (
            <Callout
              tone="error"
              role="alert"
              action={
                <Button size="sm" variant="outline" onClick={handleRetryTemplates}>
                  Try again
                </Button>
              }
            >
              Komla couldn’t load its list of agents.
            </Callout>
          )}

          {step === agentStep && !detecting && usesDetectedAgents && (
            <OnboardingFoundAgents
              found={detectedTemplates}
              notInstalled={agentTemplates.filter(
                (t) => t.name !== 'Custom' && !detectedNames.has(t.name)
              )}
              excluded={excludedAgentNames}
              onToggle={handleToggleAgent}
              onCheckAgain={handleCheckAgain}
              onPickOther={() => setPickingOtherAgent(true)}
            />
          )}

          {showAgentPicker && (
            <div className="space-y-5">
              <div>
                <h2 className="text-lg font-semibold">Choose Your AI Agent</h2>
                <p className="text-sm text-muted-foreground">
                  You can always add more agents in Settings later.
                </p>
              </div>

              {pickingOtherAgent ? (
                <Callout
                  tone="info"
                  action={
                    <Button size="sm" variant="outline" onClick={() => setPickingOtherAgent(false)}>
                      Show found agents
                    </Button>
                  }
                >
                  Pick the agent you use instead of the ones Komla found.
                </Callout>
              ) : (
                <Callout
                  tone="info"
                  action={
                    <Button size="sm" variant="outline" onClick={handleCheckAgain}>
                      Check again
                    </Button>
                  }
                >
                  Komla didn’t find an agent CLI on this computer, and it doesn’t install them.
                  Install one and check again, or pick the agent you use.
                </Callout>
              )}

              {/* Featured agents — one-click Komla integration */}
              <div className="space-y-2">
                <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  One-click setup
                </p>
                <div className="grid grid-cols-2 gap-3">
                  {featuredTemplates.map((template) => (
                    <FeaturedAgentCard
                      key={template.name}
                      preset={template}
                      isSelected={template.name === selectedTemplateName}
                      onSelect={() => handleTemplateChange(template.name)}
                    />
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">One-click hooks setup.</p>
              </div>

              {/* Other agents — compact chips, self-integration */}
              <div className="space-y-2">
                <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  Other agents
                </p>
                <div className="grid grid-cols-3 gap-2">
                  {(showAllAgents
                    ? orderedOtherTemplates
                    : orderedOtherTemplates.slice(0, popularOtherTemplates.length)
                  ).map((template) => (
                    <AgentChip
                      key={template.name}
                      preset={template}
                      isSelected={template.name === selectedTemplateName}
                      onSelect={() => handleTemplateChange(template.name)}
                    />
                  ))}
                </div>
                {restOtherTemplates.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setShowAllAgents(!showAllAgents)}
                    className="flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {showAllAgents ? (
                      <CaretUp className="size-3.5" />
                    ) : (
                      <CaretDown className="size-3.5" />
                    )}
                    {showAllAgents ? 'Show fewer' : `Show ${restOtherTemplates.length} more`}
                  </button>
                )}
                {customTemplate && (
                  <button
                    onClick={() => handleTemplateChange('Custom')}
                    aria-pressed={isCustomPreset}
                    className={cn(
                      'flex w-full items-center justify-start gap-1.5 rounded-md border px-2.5 py-2 text-left text-sm transition-all',
                      isCustomPreset
                        ? 'border-primary/50 bg-primary/5 ring-2 ring-primary/50'
                        : 'border-border hover:bg-muted/50'
                    )}
                  >
                    <Plus className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="font-medium">Custom agent</span>
                  </button>
                )}
              </div>

              {/* Command customization */}
              {isCustomPreset ? (
                <div className="space-y-3 pt-2">
                  <p className="text-xs text-muted-foreground">
                    Tell Komla how to start, resume, and prompt your agent. These commands run in
                    the workspace terminal.
                  </p>
                  <CommandInputs
                    openCommand={openCommand}
                    onOpenCommandChange={(value) => {
                      setOpenCommand(value);
                      if (!displayNameTouched) setDisplayName(deriveAgentName(value));
                    }}
                    continueCommand={continueCommand}
                    onContinueCommandChange={setContinueCommand}
                    promptCommand={promptCommand}
                    onPromptCommandChange={setPromptCommand}
                    launchModes={launchModes}
                    onLaunchModesChange={setLaunchModes}
                    reasoningLevels={reasoningLevels}
                    onReasoningLevelsChange={setReasoningLevels}
                    alwaysExpanded
                    showExamplePlaceholders
                  />

                  <div className="grid gap-2">
                    <label className="text-sm font-medium">Display name</label>
                    <Input
                      value={displayName}
                      onChange={(e) => {
                        setDisplayName(e.target.value);
                        setDisplayNameTouched(true);
                      }}
                      placeholder="e.g., Aider"
                    />
                    <p className="text-xs text-muted-foreground">
                      Auto-filled from the open command — shown when picking this agent
                    </p>
                  </div>
                </div>
              ) : (
                <div className="pt-2">
                  <button
                    type="button"
                    className="flex items-center gap-1.5 text-sm font-medium text-foreground transition-colors hover:text-primary"
                    onClick={() => setShowAdvanced(!showAdvanced)}
                  >
                    {showAdvanced ? (
                      <CaretUp className="size-4" />
                    ) : (
                      <CaretDown className="size-4" />
                    )}
                    Customize commands
                  </button>

                  <div
                    className="wizard-collapsible"
                    data-open={showAdvanced}
                    inert={!showAdvanced}
                  >
                    <div>
                      <div className="space-y-3 pt-3">
                        <p className="text-xs text-muted-foreground">
                          {AGENTS_WITH_AUTO_INTEGRATIONS.includes(selectedTemplateName) ? (
                            <>
                              Komla runs these to start, resume, and prompt {selectedTemplateName}.
                              Edit them or add launch modes and effort levels to match how you run
                              the agent.
                            </>
                          ) : (
                            <>
                              Komla runs these to start, resume, and prompt {selectedTemplateName}.
                              These are best-effort defaults — give them a look and confirm they
                              match the version you have installed.
                            </>
                          )}
                        </p>
                        <CommandInputs
                          openCommand={openCommand}
                          onOpenCommandChange={setOpenCommand}
                          continueCommand={continueCommand}
                          onContinueCommandChange={setContinueCommand}
                          promptCommand={promptCommand}
                          onPromptCommandChange={setPromptCommand}
                          launchModes={launchModes}
                          onLaunchModesChange={setLaunchModes}
                          reasoningLevels={reasoningLevels}
                          onReasoningLevelsChange={setReasoningLevels}
                          alwaysExpanded
                        />
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {error && <p className="text-sm text-error">{error}</p>}
            </div>
          )}

          {step === connectStep && (
            <OnboardingConnectStep
              agents={integrationAgents}
              others={selfIntegratingAgents}
              connections={connections}
              pending={pending}
              errors={errors}
              onToggle={(agent, on) => void toggle(agent, on)}
            />
          )}

          {step === machineStep && (
            <OnboardingMachineStep
              machine={machine}
              onMachineChange={handleMachineChange}
              configHosts={sshConfigHosts}
              pickedAlias={pickedSshAlias}
              onPickAlias={setPickedSshAlias}
            />
          )}

          {step === analyticsStep && (
            <OnboardingAnalyticsStep
              share={shareAnalytics}
              onShareChange={setShareAnalytics}
              crashReports={crashReports}
              onCrashReportsChange={setCrashReports}
            />
          )}

          {step === projectStep && (
            <div className="space-y-5">
              <div>
                <h2 className="text-lg font-semibold">Add Your First Project</h2>
              </div>

              <ProjectCreationForm
                onSuccess={handleCompleteWithProject}
                onCreatingChange={setIsCreating}
                defaultBranchPrefix={getDefaultBranchPrefix(selectedTemplateName)}
                skipLabel="Skip for now"
                onSkip={handleSkipProject}
                disabled={isCreating}
                hideProjectColor
                hideAdvanced
              />

              {error && <p className="text-sm text-error">{error}</p>}
            </div>
          )}
        </div>

        {/* Pinned nav for the Agent step — stays in view so selecting an agent
            never requires scrolling to reach Continue. Back shows only when the
            Project step was skipped: going back after one has been created leaves
            an orphaned project in storage. */}
        {step === agentStep && !detecting && !templatesFailed && (
          <div className="flex shrink-0 gap-3 px-6 pb-6">
            {skippedProject && (
              <Button variant="ghost" onClick={() => setStep(projectStep)}>
                Back
              </Button>
            )}
            <Button
              onClick={handleNext}
              disabled={usesDetectedAgents && chosenTemplates.length === 0}
              className="flex-1"
            >
              Continue
            </Button>
          </div>
        )}

        {/* Pinned like the Agent step nav, so expanding "What changes?" never
            scrolls the buttons out of view. */}
        {step === connectStep && (
          <div className="flex shrink-0 items-center justify-between gap-3 px-6 pb-6">
            <Button variant="ghost" onClick={() => setStep(agentStep)} disabled={pending !== null}>
              Back
            </Button>
            <Button
              onClick={() => setStep(machineStep)}
              disabled={pending !== null}
              className="min-w-36"
            >
              Continue
            </Button>
          </div>
        )}

        {step === machineStep && askAnalytics && (
          <div className="flex shrink-0 items-center justify-between gap-3 px-6 pb-6">
            <Button variant="ghost" onClick={() => setStep(connectStep)}>
              Back
            </Button>
            <Button onClick={() => setStep(analyticsStep)} className="min-w-36">
              Continue
            </Button>
          </div>
        )}

        {/* Setup finishes on the last step: Analytics, or Machine once analytics were answered. */}
        {(step === analyticsStep || (step === machineStep && !askAnalytics)) && (
          <div className="shrink-0 px-6 pb-6">
            <OnboardingLaunchStep
              isCreating={isCreating}
              error={error}
              onBack={() => setStep(step === analyticsStep ? machineStep : connectStep)}
              onFinish={() => handleComplete()}
              finishDisabled={step === analyticsStep && shareAnalytics === null}
            />
          </div>
        )}

        <OnboardingZoomControl className="shrink-0 self-center" />
      </div>
    </div>
  );
}
