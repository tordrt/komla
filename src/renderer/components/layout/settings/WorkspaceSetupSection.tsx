import { CaretDown, CaretUp, Info, ListChecks, Plus, Robot, X } from '@phosphor-icons/react';
import React from 'react';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { useSshHostsStore } from '@/stores/ssh-hosts.store';

import { settingsCardId } from './settings-search';
import { SettingsCard } from './SettingsCard';

import type {
  Action,
  AgentPlacement,
  AgentPreset,
  SetupDestination,
  SetupStep,
  SetupStepPlacement,
  SetupTrigger,
} from '@/types';

interface SetupPreset {
  label: string;
  name: string;
  command: string;
  placement: SetupStepPlacement;
  agent?: boolean;
  destination?: SetupDestination;
  trigger?: SetupTrigger;
}

const INSTALL_PRESETS: SetupPreset[] = [
  {
    label: 'npm install',
    name: 'Install dependencies',
    command: 'npm install',
    placement: 'background',
    trigger: 'workspace-creation',
  },
  {
    label: 'pnpm install',
    name: 'Install dependencies',
    command: 'pnpm install',
    placement: 'background',
    trigger: 'workspace-creation',
  },
  {
    label: 'yarn install',
    name: 'Install dependencies',
    command: 'yarn install',
    placement: 'background',
    trigger: 'workspace-creation',
  },
  {
    label: 'bun install',
    name: 'Install dependencies',
    command: 'bun install',
    placement: 'background',
    trigger: 'workspace-creation',
  },
  {
    label: 'Install in local copy',
    name: 'Install dependencies in local copy',
    command: 'npm install',
    placement: 'background',
    destination: 'ssh-local-copy',
    trigger: 'workspace-creation',
  },
];

const DEV_SERVER_PRESETS: SetupPreset[] = [
  { label: 'npm run dev', name: 'Dev server', command: 'npm run dev', placement: 'tab' },
  { label: 'pnpm dev', name: 'Dev server', command: 'pnpm dev', placement: 'tab' },
  { label: 'yarn dev', name: 'Dev server', command: 'yarn dev', placement: 'tab' },
  { label: 'bun dev', name: 'Dev server', command: 'bun dev', placement: 'tab' },
  { label: 'docker compose up', name: 'Docker', command: 'docker compose up', placement: 'tab' },
];

const TEARDOWN_PRESETS: SetupPreset[] = [
  {
    label: 'docker compose down',
    name: 'Stop containers',
    command: 'docker compose down',
    placement: 'background',
    trigger: 'workspace-stop',
  },
];

const LAYOUT_PRESETS: SetupPreset[] = [
  { label: 'New terminal tab', name: 'Terminal', command: '', placement: 'tab' },
  { label: 'Split right', name: 'Terminal', command: '', placement: 'split-right' },
  { label: 'Split bottom', name: 'Terminal', command: '', placement: 'split-bottom' },
];

const FILES_CONFIG_PRESETS: SetupPreset[] = [
  {
    label: 'Copy .env',
    name: 'Copy .env',
    command: 'cp "{{localProjectPath}}/.env" .env',
    placement: 'background',
    destination: 'local-workspace-repository',
    trigger: 'workspace-creation',
  },
  {
    label: 'Git submodules',
    name: 'Init submodules',
    command: 'git submodule update --init --recursive',
    placement: 'background',
    trigger: 'workspace-creation',
  },
  {
    label: 'Copy .env to local copy',
    name: 'Copy .env to local copy',
    command: 'cp "{{localProjectPath}}/.env" .env',
    placement: 'background',
    destination: 'ssh-local-copy',
    trigger: 'workspace-creation',
  },
  {
    label: 'Upload .env to SSH',
    name: 'Upload .env to SSH workspace',
    command:
      'scp -P {{sshPort}} "{{localProjectPath}}/.env" "{{sshTarget}}:{{workspacePath}}/.env"',
    placement: 'background',
    destination: 'ssh-local-copy',
    trigger: 'workspace-creation',
  },
];

const AGENT_PRESETS: SetupPreset[] = [
  {
    label: 'Add agent',
    name: 'Agent',
    command: '',
    placement: 'split-right',
    agent: true,
  },
];

const PRESET_CATEGORIES = [
  { label: 'Dependencies', presets: INSTALL_PRESETS },
  { label: 'Dev Servers', presets: DEV_SERVER_PRESETS },
  { label: 'Teardown', presets: TEARDOWN_PRESETS },
  { label: 'Agents & Quick Commands', presets: AGENT_PRESETS },
  { label: 'Layout', presets: LAYOUT_PRESETS },
  { label: 'Files & Config', presets: FILES_CONFIG_PRESETS },
];

// Words that usually start a process that never exits, such as `npm run dev` or `docker compose up`.
// Path segments like /dev/null and flags like --dev don't count.
const LONG_RUNNING_COMMAND =
  /(?<![\w/.-])(?:dev|watch|serve|server|start|up)(?![\w/.-])|--watch\b/i;

// Paths on this computer, which an SSH workspace's commands can't read.
const DESKTOP_PATH_VARIABLES = ['localProjectPath', 'projectPath'];

const DESTINATION_EXAMPLES: Record<SetupDestination, string> = {
  'workspace-repository': '/home/alex/.komla/worktrees/acme/feature-login',
  'local-workspace-repository': '/Users/alex/.komla/worktrees/acme/feature-login',
  'ssh-workspace-repository': '/home/alex/.komla/worktrees/acme/feature-login',
  'ssh-local-copy': '/Users/alex/.komla/mirrors/acme/feature-login',
};

interface WorkspaceSetupSectionProps {
  steps: SetupStep[];
  agentPlacement: AgentPlacement;
  agentLayoutOrder: number;
  actions: Action[];
  presets: AgentPreset[];
  onStepsChange: (steps: SetupStep[]) => void;
  onAgentPlacementChange: (placement: AgentPlacement) => void;
  onAgentLayoutOrderChange: (order: number) => void;
  /** Shown beside the Setup steps title. */
  action?: React.ReactNode;
}

export function WorkspaceSetupSection({
  steps,
  agentPlacement,
  agentLayoutOrder,
  actions,
  presets,
  onStepsChange,
  onAgentPlacementChange,
  onAgentLayoutOrderChange,
  action,
}: WorkspaceSetupSectionProps) {
  const sshDestinationsAvailable = useSshHostsStore(
    (state) => !state.hasLoaded || state.hosts.length > 0
  );
  // Setup can't prepare a Local copy on Windows yet, so its steps would always end unsupported.
  const localCopyAvailable = window.api.platform !== 'win32';
  const presetsById = React.useMemo(
    () => new Map(presets.map((preset) => [preset.id, preset])),
    [presets]
  );
  const actionsById = React.useMemo(
    () => new Map(actions.map((action) => [action.id, action])),
    [actions]
  );

  const addPresetStep = (preset: SetupPreset) => {
    onStepsChange([
      ...steps,
      {
        id: crypto.randomUUID(),
        name: preset.name,
        command: preset.command,
        placement: preset.placement,
        destination: preset.destination ?? 'workspace-repository',
        trigger: preset.trigger ?? 'every-workspace-start',
        ...(preset.agent ? { agent: {} } : {}),
      },
    ]);
  };

  const addCustomStep = () => {
    onStepsChange([
      ...steps,
      {
        id: crypto.randomUUID(),
        name: '',
        command: '',
        placement: 'background',
        destination: 'workspace-repository',
        trigger: 'every-workspace-start',
      },
    ]);
  };

  const addActionStep = () => {
    onStepsChange([
      ...steps,
      {
        id: crypto.randomUUID(),
        name: 'Quick command',
        command: '',
        placement: 'tab',
        actionId: '',
        destination: 'workspace-repository',
        trigger: 'every-workspace-start',
      },
    ]);
  };

  const updateStep = (stepId: string, updates: Partial<SetupStep>) => {
    onStepsChange(steps.map((s) => (s.id === stepId ? { ...s, ...updates } : s)));
  };

  const deleteStep = (stepId: string) => {
    const next = steps.filter((s) => s.id !== stepId);
    if (agentLayoutOrder > next.length) {
      onAgentLayoutOrderChange(next.length);
    }
    onStepsChange(next);
  };

  const moveItemUp = (layoutIndex: number) => {
    if (layoutIndex <= 0) return;
    const clampedAgentOrder = Math.min(Math.max(0, agentLayoutOrder), steps.length);
    if (layoutIndex === clampedAgentOrder) {
      onAgentLayoutOrderChange(agentLayoutOrder - 1);
    } else if (layoutIndex - 1 === clampedAgentOrder) {
      onAgentLayoutOrderChange(agentLayoutOrder + 1);
    } else {
      const stepIdx = layoutIndex < clampedAgentOrder ? layoutIndex : layoutIndex - 1;
      if (stepIdx <= 0) return;
      const next = [...steps];
      [next[stepIdx], next[stepIdx - 1]] = [next[stepIdx - 1], next[stepIdx]];
      onStepsChange(next);
    }
  };

  const moveItemDown = (layoutIndex: number, totalSlots: number) => {
    if (layoutIndex >= totalSlots - 1) return;
    const clampedAgentOrder = Math.min(Math.max(0, agentLayoutOrder), steps.length);
    if (layoutIndex === clampedAgentOrder) {
      onAgentLayoutOrderChange(agentLayoutOrder + 1);
    } else if (layoutIndex + 1 === clampedAgentOrder) {
      onAgentLayoutOrderChange(agentLayoutOrder - 1);
    } else {
      const stepIdx = layoutIndex < clampedAgentOrder ? layoutIndex : layoutIndex - 1;
      if (stepIdx >= steps.length - 1) return;
      const next = [...steps];
      [next[stepIdx], next[stepIdx + 1]] = [next[stepIdx + 1], next[stepIdx]];
      onStepsChange(next);
    }
  };

  return (
    <div className="space-y-6">
      {/* Setup steps */}
      <section
        id={settingsCardId('Setup steps')}
        className="scroll-mt-6 rounded-xl ring-offset-4 ring-offset-background transition-shadow duration-300 data-[search-target]:ring-2 data-[search-target]:ring-primary/40"
      >
        <div className="mb-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-foreground">Setup steps</h3>
            {action}
          </div>
          <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
            Steps start in this order whenever a workspace starts and never block it. Creation-only
            steps run once, when the workspace is first created. Splits attach to the previous
            terminal; a new tab starts a new group. Stop steps run in the background after a
            workspace&apos;s terminals stop, to end what outlives them, such as containers started
            with <code>docker compose up -d</code>.
          </p>
        </div>
        {steps.length > 0 ? (
          <>
            <div className="space-y-1.5">
              {(() => {
                const items: React.ReactNode[] = [];
                let stepIdx = 0;
                let hasVisibleTerminal = false;
                const totalSlots = steps.length + 1;
                const clampedAgentOrder = Math.min(Math.max(0, agentLayoutOrder), steps.length);

                for (let i = 0; i < totalSlots; i++) {
                  const isFirst = i === 0;
                  const isLast = i === totalSlots - 1;
                  const layoutIndex = i;

                  if (i === clampedAgentOrder) {
                    // Agent row
                    items.push(
                      <div
                        key="agent"
                        className="flex items-center gap-3 rounded-xl border-2 border-accent/50 bg-accent/5 px-4 py-3 shadow-xs"
                      >
                        <Robot className="size-4 shrink-0 text-accent" />
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium">Agent</p>
                          <p className="text-xs text-muted-foreground">Your AI coding agent</p>
                        </div>
                        {hasVisibleTerminal && (
                          <Select
                            compact
                            aria-label="Show agent in"
                            value={agentPlacement}
                            onChange={(e) =>
                              onAgentPlacementChange(e.target.value as AgentPlacement)
                            }
                            className="w-[120px] shrink-0"
                          >
                            <option value="tab">New tab</option>
                            <option value="split-right">Split right</option>
                            <option value="split-bottom">Split bottom</option>
                          </Select>
                        )}
                        <MoveButtons
                          name="agent"
                          isFirst={isFirst}
                          isLast={isLast}
                          onMoveUp={() => moveItemUp(layoutIndex)}
                          onMoveDown={() => moveItemDown(layoutIndex, totalSlots)}
                        />
                      </div>
                    );
                    hasVisibleTerminal = true;
                  } else {
                    const s = steps[stepIdx];
                    if (!s) {
                      stepIdx++;
                      continue;
                    }
                    const currentStepId = s.id;
                    const stepAgent = s.agent;
                    const stepAgentPreset = stepAgent?.presetId
                      ? presetsById.get(stepAgent.presetId)
                      : undefined;
                    const selectedAction = s.actionId ? actionsById.get(s.actionId) : undefined;
                    const destination = s.destination ?? 'workspace-repository';
                    const allowsDesktopSshDestinations =
                      destination === 'ssh-local-copy' ||
                      (localCopyAvailable &&
                        !stepAgent &&
                        (!s.actionId || selectedAction?.type === 'command'));
                    // Without SSH hosts every workspace is local, so local-only is the default.
                    const showDestination =
                      sshDestinationsAvailable ||
                      (destination !== 'workspace-repository' &&
                        destination !== 'local-workspace-repository');
                    const trigger = s.trigger ?? 'every-workspace-start';
                    const runsOnStop = trigger === 'workspace-stop';
                    // A stop step runs a command after the terminals are gone, never an agent.
                    const canRunOnStop =
                      runsOnStop ||
                      (!stepAgent && (!s.actionId || selectedAction?.type === 'command'));
                    const runsInBackground = s.placement === 'background';
                    const stepCommand = s.actionId
                      ? selectedAction?.type === 'command'
                        ? selectedAction.content
                        : ''
                      : s.command;
                    const canRunOverSsh =
                      destination === 'ssh-workspace-repository' ||
                      (destination === 'workspace-repository' && sshDestinationsAvailable);
                    const desktopPathVariable = canRunOverSsh
                      ? DESKTOP_PATH_VARIABLES.find((variable) =>
                          stepCommand.includes(`{{${variable}}}`)
                        )
                      : undefined;
                    items.push(
                      <article
                        key={s.id}
                        aria-label={`Setup step ${s.name || 'Unnamed'}`}
                        className="flex flex-col gap-2 rounded-xl border border-border/50 bg-card/70 p-4 shadow-xs"
                      >
                        <div className="flex items-center gap-1.5">
                          <Input
                            value={s.name}
                            onChange={(e) => updateStep(currentStepId, { name: e.target.value })}
                            placeholder="Step name"
                            className="h-8 flex-1 text-xs"
                          />
                          {!runsOnStop && (
                            <Select
                              compact
                              aria-label={`Show in for ${s.name || 'setup step'}`}
                              value={s.placement}
                              onChange={(e) =>
                                updateStep(currentStepId, {
                                  placement: e.target.value as SetupStepPlacement,
                                })
                              }
                              className="w-[120px] shrink-0"
                            >
                              <option value="background">Background</option>
                              <option value="tab">New tab</option>
                              <option value="split-right">Split right</option>
                              <option value="split-bottom">Split bottom</option>
                            </Select>
                          )}
                          <MoveButtons
                            name={s.name || 'step'}
                            isFirst={isFirst}
                            isLast={isLast}
                            onMoveUp={() => moveItemUp(layoutIndex)}
                            onMoveDown={() => moveItemDown(layoutIndex, totalSlots)}
                          />
                          <IconButton
                            label={`Remove ${s.name || 'step'}`}
                            size="xs"
                            className="hover:text-destructive"
                            onClick={() => deleteStep(currentStepId)}
                          >
                            <X className="size-3.5" />
                          </IconButton>
                        </div>
                        {showDestination && (
                          <div className="order-2 grid grid-cols-[64px_minmax(0,1fr)] items-center gap-2">
                            <label
                              htmlFor={`setup-destination-${s.id}`}
                              className="text-xs font-medium text-muted-foreground"
                            >
                              Run in
                            </label>
                            <div>
                              <Select
                                compact
                                id={`setup-destination-${s.id}`}
                                aria-label={`Run in for ${s.name || 'setup step'}`}
                                value={destination}
                                onChange={(e) =>
                                  updateStep(currentStepId, {
                                    destination: e.target.value as SetupDestination,
                                  })
                                }
                              >
                                <option value="workspace-repository">
                                  Workspace repository (local or SSH)
                                </option>
                                <option value="local-workspace-repository">
                                  Local workspace repository only
                                </option>
                                <option value="ssh-workspace-repository">
                                  SSH workspace repository only
                                </option>
                                {allowsDesktopSshDestinations && (
                                  <option value="ssh-local-copy">
                                    Local copy of SSH workspace
                                  </option>
                                )}
                              </Select>
                            </div>
                          </div>
                        )}
                        <div className="order-3 grid grid-cols-[64px_minmax(0,1fr)] items-center gap-2">
                          <label
                            htmlFor={`setup-trigger-${s.id}`}
                            className="text-xs font-medium text-muted-foreground"
                          >
                            Run on
                          </label>
                          <Select
                            compact
                            id={`setup-trigger-${s.id}`}
                            aria-label={`Run on for ${s.name || 'setup step'}`}
                            value={trigger}
                            onChange={(e) => {
                              const next = e.target.value as SetupTrigger;
                              updateStep(currentStepId, {
                                trigger: next,
                                ...(next === 'workspace-stop'
                                  ? { placement: 'background' as const }
                                  : {}),
                              });
                            }}
                          >
                            <option value="every-workspace-start">Every workspace start</option>
                            <option value="workspace-creation">Workspace creation only</option>
                            {canRunOnStop && <option value="workspace-stop">Workspace stop</option>}
                          </Select>
                        </div>
                        <div className="order-4">
                          <SetupVariableExamples
                            destination={s.destination ?? 'workspace-repository'}
                          />
                        </div>
                        {stepAgent ? (
                          <div className="order-1 grid grid-cols-[64px_minmax(0,1fr)] items-start gap-2">
                            <span className="pt-2 text-xs font-medium text-muted-foreground">
                              Run
                            </span>
                            <div className="space-y-1.5">
                              <div className="grid grid-cols-2 gap-1.5">
                                <Select
                                  compact
                                  aria-label={`Agent preset for ${s.name || 'setup step'}`}
                                  value={stepAgentPreset ? stepAgent.presetId : ''}
                                  onChange={(e) => {
                                    const presetId = e.target.value;
                                    updateStep(currentStepId, {
                                      agent: presetId ? { presetId } : {},
                                    });
                                  }}
                                >
                                  <option value="">Same as workspace</option>
                                  {presets.map((preset) => (
                                    <option key={preset.id} value={preset.id}>
                                      {preset.name}
                                    </option>
                                  ))}
                                </Select>
                                {stepAgentPreset && stepAgent.presetId && (
                                  <Select
                                    compact
                                    aria-label={`Agent launch mode for ${s.name || 'setup step'}`}
                                    value={stepAgent.launchModeId ?? ''}
                                    onChange={(e) => {
                                      const launchModeId = e.target.value;
                                      updateStep(currentStepId, {
                                        agent: {
                                          presetId: stepAgent.presetId,
                                          ...(launchModeId ? { launchModeId } : {}),
                                        },
                                      });
                                    }}
                                  >
                                    <option value="">Default launch</option>
                                    {stepAgentPreset.launchModes.map((mode) => (
                                      <option key={mode.id} value={mode.id}>
                                        {mode.name}
                                      </option>
                                    ))}
                                  </Select>
                                )}
                              </div>
                              <p className="text-ui leading-tight text-muted-foreground">
                                Starts a fresh session without repeating the workspace prompt.
                              </p>
                            </div>
                          </div>
                        ) : 'actionId' in s ? (
                          <div className="order-1 grid grid-cols-[64px_minmax(0,1fr)] items-center gap-2">
                            <span className="text-xs font-medium text-muted-foreground">Run</span>
                            <Select
                              compact
                              value={s.actionId || ''}
                              onChange={(e) => {
                                const selectedAction = actions.find((a) => a.id === e.target.value);
                                updateStep(currentStepId, {
                                  actionId: e.target.value || '',
                                  name: selectedAction?.title || s.name,
                                  ...(selectedAction?.type !== 'command' &&
                                  s.destination === 'ssh-local-copy'
                                    ? { destination: 'workspace-repository' as const }
                                    : {}),
                                  ...(selectedAction &&
                                  selectedAction.type !== 'command' &&
                                  runsOnStop
                                    ? { trigger: 'every-workspace-start' as const }
                                    : {}),
                                });
                              }}
                            >
                              <option value="">Select a quick command...</option>
                              {actions.filter((a) => a.type !== 'command').length > 0 && (
                                <optgroup label="Saved Prompts">
                                  {actions
                                    .filter((a) => a.type !== 'command')
                                    .map((action) => (
                                      <option key={action.id} value={action.id}>
                                        {action.title}
                                      </option>
                                    ))}
                                </optgroup>
                              )}
                              {actions.filter((a) => a.type === 'command').length > 0 && (
                                <optgroup label="Terminal Commands">
                                  {actions
                                    .filter((a) => a.type === 'command')
                                    .map((action) => (
                                      <option key={action.id} value={action.id}>
                                        {action.title}
                                      </option>
                                    ))}
                                </optgroup>
                              )}
                            </Select>
                          </div>
                        ) : (
                          <label className="order-1 grid grid-cols-[64px_minmax(0,1fr)] items-center gap-2">
                            <span className="text-xs font-medium text-muted-foreground">Run</span>
                            <Input
                              value={s.command}
                              onChange={(e) =>
                                updateStep(currentStepId, { command: e.target.value })
                              }
                              placeholder="Shell command"
                              className="h-8 font-mono text-xs"
                            />
                          </label>
                        )}
                        {'actionId' in s && !s.actionId && (
                          <StepWarning>
                            Choose a quick command. Until then this step opens an empty terminal.
                          </StepWarning>
                        )}
                        {desktopPathVariable && (
                          <StepWarning>
                            {`{{${desktopPathVariable}}}`} is a folder on this computer, which SSH
                            workspaces can&apos;t read, so this step fails there. Run it in local
                            workspaces only, or use {'{{workspacePath}}'}.
                          </StepWarning>
                        )}
                        {runsInBackground &&
                          !runsOnStop &&
                          LONG_RUNNING_COMMAND.test(stepCommand) && (
                            <StepWarning>
                              Background steps should run a command that exits on its own. For
                              long-running processes (dev servers, watchers), use a visible
                              placement instead.
                            </StepWarning>
                          )}
                      </article>
                    );
                    if (!runsInBackground) {
                      hasVisibleTerminal = true;
                    }
                    stepIdx++;
                  }
                }
                return items;
              })()}
            </div>
          </>
        ) : (
          <EmptyState
            size="sm"
            className="rounded-lg border border-dashed border-border/60"
            icon={<ListChecks weight="duotone" />}
            title="No setup steps yet"
            description="Pick a common step from Quick add below, or add your own."
            action={
              <Button variant="outline" size="sm" className="h-7 text-xs" onClick={addCustomStep}>
                <Plus className="mr-1 size-3" />
                Add step
              </Button>
            }
          />
        )}
        {steps.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            className="mt-2 h-8 w-full border-dashed text-xs text-muted-foreground"
            onClick={addCustomStep}
          >
            <Plus className="mr-1 size-3" />
            Add step
          </Button>
        )}
      </section>

      {/* Quick Add */}
      <SettingsCard
        title="Quick add"
        description="Common steps, added to the end of the setup order."
      >
        <div className="space-y-2.5">
          {PRESET_CATEGORIES.map(({ label, presets }) => (
            <div key={label}>
              <span className="mb-1 block text-ui font-medium text-muted-foreground/70">
                {label}
              </span>
              <div className="flex flex-wrap gap-1.5">
                {presets.map((preset) =>
                  (localCopyAvailable || preset.destination !== 'ssh-local-copy') &&
                  (sshDestinationsAvailable ||
                    (preset.destination !== 'ssh-workspace-repository' &&
                      preset.destination !== 'ssh-local-copy')) ? (
                    <Button
                      key={preset.label}
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => addPresetStep(preset)}
                    >
                      {preset.label}
                    </Button>
                  ) : null
                )}
                {label === 'Agents & Quick Commands' && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={addActionStep}
                  >
                    Run quick command
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      </SettingsCard>
    </div>
  );
}

function MoveButtons({
  name,
  isFirst,
  isLast,
  onMoveUp,
  onMoveDown,
}: {
  name: string;
  isFirst: boolean;
  isLast: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  return (
    <div className="flex shrink-0 flex-col gap-0.5">
      <IconButton
        label={`Move ${name} up`}
        className="size-4 rounded-sm disabled:opacity-30"
        disabled={isFirst}
        onClick={onMoveUp}
      >
        <CaretUp className="size-3" />
      </IconButton>
      <IconButton
        label={`Move ${name} down`}
        className="size-4 rounded-sm disabled:opacity-30"
        disabled={isLast}
        onClick={onMoveDown}
      >
        <CaretDown className="size-3" />
      </IconButton>
    </div>
  );
}

function StepWarning({ children }: { children: React.ReactNode }) {
  return (
    <p className="order-6 flex items-start gap-1 text-ui leading-tight text-warning">
      <Info className="mt-px size-3.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

function SetupVariableExamples({ destination }: { destination: SetupDestination }) {
  const destinationDiffersFromWorkspace = destination === 'ssh-local-copy';
  const showLocalProjectPath =
    destination === 'local-workspace-repository' || destination === 'ssh-local-copy';
  const appliesToSsh =
    destination === 'workspace-repository' ||
    destination === 'ssh-workspace-repository' ||
    destination === 'ssh-local-copy';
  return (
    <details className="text-2xs text-muted-foreground">
      <summary className="cursor-pointer select-none">
        Variables available for this destination
      </summary>
      <div className="mt-1.5 grid gap-1 rounded-md bg-muted/30 p-2">
        <VariableExample
          name="destinationPath"
          description="Where this command runs"
          example={DESTINATION_EXAMPLES[destination]}
        />
        {destinationDiffersFromWorkspace && (
          <VariableExample
            name="workspacePath"
            description="The workspace on the SSH host"
            example="/home/alex/.komla/worktrees/acme/feature-login"
          />
        )}
        {showLocalProjectPath && (
          <VariableExample
            name="localProjectPath"
            description="The original project folder on this computer"
            example="/Users/alex/code/acme"
          />
        )}
        {appliesToSsh && (
          <>
            <VariableExample
              name="sshTarget"
              description="user@host"
              example="alex@devbox.example.com"
            />
            <VariableExample name="sshPort" description="SSH port" example="22" />
          </>
        )}
        <VariableExample name="branchName" description="Branch name" example="feature/login" />
      </div>
    </details>
  );
}

function VariableExample({
  name,
  description,
  example,
}: {
  name: string;
  description: string;
  example: string;
}) {
  return (
    <div className="grid grid-cols-[auto_1fr] gap-x-2">
      <code className="rounded bg-muted px-1">{`{{${name}}}`}</code>
      <span>
        {description}, for example <code>{example}</code>
      </span>
    </div>
  );
}
