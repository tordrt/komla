import { CaretDown, CaretUp, Info, ListChecks, Plus, Robot, X } from '@phosphor-icons/react';
import React from 'react';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { IconButton } from '@/components/ui/icon-button';
import { InfoTip } from '@/components/ui/info-tip';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useSshHostsStore } from '@/stores/ssh-hosts.store';

import {
  DEFAULT_SECRET_FILE,
  MAX_SECRET_FILE_CONTENTS,
  secretFileNames,
  secretFileProblem,
} from '../../../../shared/lib/secret-file';
import { setupStepPane } from '../../../../shared/lib/setup-panes';
import { SETUP_STEP_KINDS } from '../../../../shared/types/project';

import { settingsCardId } from './settings-search';
import { SettingsCard } from './SettingsCard';

import type {
  Action,
  AgentPlacement,
  AgentPreset,
  SecretFileStatus,
  SetupDestination,
  SetupStep,
  SetupStepKind,
  SetupStepPane,
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
  /** A Secret file, written to this file, in place of a command. */
  secretFile?: string;
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

// A server's terminal ends when its workspace stops, so it starts again with the workspace.
const DEV_SERVER_PRESETS: SetupPreset[] = [
  {
    label: 'npm run dev',
    name: 'Dev server',
    command: 'npm run dev',
    placement: 'tab',
    trigger: 'every-workspace-start',
  },
  {
    label: 'pnpm dev',
    name: 'Dev server',
    command: 'pnpm dev',
    placement: 'tab',
    trigger: 'every-workspace-start',
  },
  {
    label: 'yarn dev',
    name: 'Dev server',
    command: 'yarn dev',
    placement: 'tab',
    trigger: 'every-workspace-start',
  },
  {
    label: 'bun dev',
    name: 'Dev server',
    command: 'bun dev',
    placement: 'tab',
    trigger: 'every-workspace-start',
  },
  {
    label: 'docker compose up',
    name: 'Docker',
    command: 'docker compose up',
    placement: 'tab',
    trigger: 'every-workspace-start',
  },
];

const FILES_CONFIG_PRESETS: SetupPreset[] = [
  {
    label: 'Secret .env',
    name: 'Secret .env',
    command: '',
    placement: 'background',
    trigger: 'workspace-creation',
    secretFile: DEFAULT_SECRET_FILE,
  },
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
  { label: 'Dev servers', presets: DEV_SERVER_PRESETS },
  { label: 'Agents and Quick Commands', presets: AGENT_PRESETS },
  { label: 'Files and config', presets: FILES_CONFIG_PRESETS },
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
  'ssh-local-copy': '/Users/alex/.komla/local-copies/acme/feature-login',
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
  /** What this computer holds for each saved Secret file step, by step. */
  secretFiles?: Record<string, SecretFileStatus>;
  /** Whether this computer's keychain encrypts Secret files, or undefined until Komla knows. */
  keychain?: boolean;
  /** New contents for Secret file steps, by step, '' to remove them, saved with the project. */
  pendingSecretFiles?: Record<string, string>;
  /** Sets a step's new contents, or with undefined keeps what it has. */
  onSecretFileChange?: (stepId: string, contents: string | undefined) => void;
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
  secretFiles = {},
  keychain,
  pendingSecretFiles = {},
  onSecretFileChange = () => {},
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
        trigger: preset.trigger ?? 'workspace-creation',
        ...(preset.agent ? { agent: {} } : {}),
        ...(preset.secretFile ? { kind: 'secret-file' as const, file: preset.secretFile } : {}),
      },
    ]);
  };

  const addStep = (kind: SetupStepKind) => {
    onStepsChange([
      ...steps,
      {
        id: crypto.randomUUID(),
        name: kind === 'terminal' ? '' : STEP_KIND_NAMES[kind],
        command: '',
        // A browser or note always shows, so it opens beside the item before it.
        placement: setupStepPane({ kind }) ? 'split-right' : 'background',
        destination: 'workspace-repository',
        ...(kind === 'terminal'
          ? { trigger: 'workspace-creation' as const }
          : kind === 'secret-file'
            ? { kind, file: DEFAULT_SECRET_FILE, trigger: 'workspace-creation' as const }
            : { kind }),
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
        trigger: 'workspace-creation',
      },
    ]);
  };

  const updateStep = (stepId: string, updates: Partial<SetupStep>) => {
    onStepsChange(steps.map((s) => (s.id === stepId ? { ...s, ...updates } : s)));
  };

  const changeStepKind = (stepId: string, kind: SetupStepKind) => {
    onStepsChange(steps.map((s) => (s.id === stepId ? withStepKind(s, kind) : s)));
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
            <h3 className="text-base font-semibold text-foreground">Setup steps</h3>
            {action}
          </div>
          <p className="mt-1 text-[13px] leading-relaxed text-pretty text-muted-foreground">
            Steps run in this order each time a workspace starts, without holding it up.
            Creation-only steps run once, when the workspace is first created.
            {steps.length > 0 && ' A split joins the pane before it; a new tab starts a new group.'}
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
                    const stepPane = setupStepPane(s);
                    const secretFile = s.kind === 'secret-file';
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
                    // A browser or note opens in Komla, so it has nowhere to run.
                    const showDestination =
                      !stepPane &&
                      (sshDestinationsAvailable ||
                        (destination !== 'workspace-repository' &&
                          destination !== 'local-workspace-repository'));
                    const trigger = s.trigger ?? 'every-workspace-start';
                    const runsInBackground = !stepPane && s.placement === 'background';
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
                          <Select
                            compact
                            aria-label={`Kind for ${s.name || 'setup step'}`}
                            value={s.kind ?? 'terminal'}
                            onChange={(e) =>
                              changeStepKind(currentStepId, e.target.value as SetupStepKind)
                            }
                            className="w-[104px] shrink-0"
                          >
                            {SETUP_STEP_KINDS.map((kind) => (
                              <option key={kind} value={kind}>
                                {STEP_KIND_NAMES[kind]}
                              </option>
                            ))}
                          </Select>
                          {!secretFile && (
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
                              {!stepPane && <option value="background">Background</option>}
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
                            className="hover:text-error"
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
                        {!stepPane && (
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
                                updateStep(currentStepId, { trigger: next });
                              }}
                            >
                              <option value="every-workspace-start">Every workspace start</option>
                              <option value="workspace-creation">Workspace creation only</option>
                            </Select>
                          </div>
                        )}
                        {!stepPane && !secretFile && (
                          <div className="order-4">
                            <SetupVariableExamples
                              destination={s.destination ?? 'workspace-repository'}
                            />
                          </div>
                        )}
                        {stepPane ? (
                          <PaneStepTarget
                            pane={stepPane}
                            name={s.name || 'setup step'}
                            urls={s.urls ?? []}
                            onUrlsChange={(urls) => updateStep(currentStepId, { urls })}
                          />
                        ) : secretFile ? (
                          <SecretFileTarget
                            name={s.name || 'setup step'}
                            file={s.file ?? ''}
                            status={secretFiles[s.id]}
                            keychain={keychain}
                            pending={pendingSecretFiles[s.id]}
                            onFileChange={(file) => updateStep(currentStepId, { file })}
                            onContentsChange={(contents) => onSecretFileChange(s.id, contents)}
                          />
                        ) : stepAgent ? (
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
                        {runsInBackground && LONG_RUNNING_COMMAND.test(stepCommand) && (
                          <StepWarning>
                            Background steps should run a command that exits on its own. For
                            long-running processes (dev servers, watchers), use a visible placement
                            instead.
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
            className="rounded-lg border border-dashed border-border/60 light:border-foreground/20"
            icon={<ListChecks weight="duotone" />}
            title="No setup steps yet"
            description="Add a terminal, browser, note or secret file, or one from Quick add below."
            action={<AddStepButtons onAdd={addStep} />}
          />
        )}
        {steps.length > 0 && (
          <div className="mt-2">
            <AddStepButtons onAdd={addStep} dashed />
          </div>
        )}
      </section>

      {/* Quick Add */}
      <SettingsCard
        title="Quick add"
        description="Common steps, added to the end of the setup order."
      >
        <div className="space-y-4">
          {PRESET_CATEGORIES.map(({ label, presets }) => (
            <div key={label}>
              <span className="mb-2 block text-xs font-medium text-foreground/80">{label}</span>
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
                      className="h-7 gap-1 pl-2 text-xs"
                      onClick={() => addPresetStep(preset)}
                    >
                      <Plus className="size-3 text-muted-foreground" />
                      {preset.label}
                    </Button>
                  ) : null
                )}
                {label === 'Agents and Quick Commands' && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 gap-1 pl-2 text-xs"
                    onClick={addActionStep}
                  >
                    <Plus className="size-3 text-muted-foreground" />
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

const STEP_KIND_NAMES: Record<SetupStepKind, string> = {
  terminal: 'Terminal',
  browser: 'Browser',
  note: 'Note',
  'secret-file': 'Secret file',
};

/**
 * The step as another kind: a browser or note runs no agent or Quick Command, always shows and
 * opens only as the workspace is created, so it takes a visible placement and no trigger; a
 * Secret file runs nothing either, out of sight, and writes .env on creation unless it already
 * named a file; a terminal drops the pages and runs on creation, as a new one does. A name that
 * was only the old kind's takes the new one's.
 */
function withStepKind(step: SetupStep, kind: SetupStepKind): SetupStep {
  const previous = step.kind ?? 'terminal';
  if (previous === kind) return step;
  const name =
    !step.name || step.name === STEP_KIND_NAMES[previous] ? STEP_KIND_NAMES[kind] : step.name;
  const {
    kind: _kind,
    urls,
    file,
    agent: _agent,
    actionId: _actionId,
    trigger: _trigger,
    ...rest
  } = step;
  // Only a terminal runs an agent or a Quick Command, so a pane step had none to keep.
  if (kind === 'terminal') return { ...rest, name, trigger: 'workspace-creation' };
  if (kind === 'secret-file') {
    return {
      ...rest,
      name,
      kind,
      // It runs none, so a terminal's command would only linger unseen.
      command: '',
      file: file ?? DEFAULT_SECRET_FILE,
      placement: 'background',
      trigger: 'workspace-creation',
    };
  }
  return {
    ...rest,
    name,
    kind,
    ...(kind === 'browser' && urls !== undefined ? { urls } : {}),
    placement: step.placement === 'background' ? 'split-right' : step.placement,
  };
}

/** A button for each kind of step, which adds it to the end of the setup order. */
function AddStepButtons({
  onAdd,
  dashed = false,
}: {
  onAdd: (kind: SetupStepKind) => void;
  dashed?: boolean;
}) {
  return (
    <div className={dashed ? 'grid grid-cols-4 gap-1.5' : 'flex flex-wrap justify-center gap-1.5'}>
      {SETUP_STEP_KINDS.map((kind) => (
        <Button
          key={kind}
          variant="outline"
          size="sm"
          className={dashed ? 'h-8 border-dashed text-xs text-muted-foreground' : 'h-7 text-xs'}
          onClick={() => onAdd(kind)}
        >
          <Plus className="mr-1 size-3" />
          Add {STEP_KIND_NAMES[kind].toLowerCase()}
        </Button>
      ))}
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

/** What a browser or note step opens, in place of the command a terminal step runs. */
function PaneStepTarget({
  pane,
  name,
  urls,
  onUrlsChange,
}: {
  pane: SetupStepPane;
  name: string;
  urls: string[];
  onUrlsChange: (urls: string[]) => void;
}) {
  if (pane === 'note') {
    return (
      <div className="order-1 grid grid-cols-[64px_minmax(0,1fr)] items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">Open</span>
        <p className="text-xs text-muted-foreground">
          A blank note, kept with the workspace&apos;s notes. It opens as the workspace is created,
          and after that with the workspace, as it was when the workspace stopped.
        </p>
      </div>
    );
  }
  const pages = urls.length > 0 ? urls : [''];
  return (
    <div className="order-1 grid grid-cols-[64px_minmax(0,1fr)] items-start gap-2">
      <span className="pt-2 text-xs font-medium text-muted-foreground">Open</span>
      <div className="space-y-1.5">
        {pages.map((url, index) => (
          // oxlint-disable-next-line react/no-array-index-key -- a page is its place in the list
          <div key={index} className="flex items-center gap-1.5">
            <Input
              aria-label={`Page ${index + 1} for ${name}`}
              value={url}
              onChange={(e) =>
                onUrlsChange(pages.map((page, i) => (i === index ? e.target.value : page)))
              }
              placeholder={index === 0 ? 'http://localhost:3000' : 'https://example.com'}
              className="h-8 flex-1 font-mono text-xs"
            />
            {pages.length > 1 && (
              <IconButton
                label={`Remove page ${index + 1} for ${name}`}
                size="xs"
                className="hover:text-error"
                onClick={() => onUrlsChange(pages.filter((_, i) => i !== index))}
              >
                <X className="size-3.5" />
              </IconButton>
            )}
          </div>
        ))}
        <div className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-muted-foreground"
            onClick={() => onUrlsChange([...pages, ''])}
          >
            <Plus className="mr-1 size-3" />
            Add page
          </Button>
          <InfoTip ariaLabel="Open pages from a command" side="bottom">
            To open a page from a command, add a terminal step that runs{' '}
            <code>komla preview --open &lt;url&gt;</code>, in the background or alongside a command
            that runs in the foreground, such as your dev server.
          </InfoTip>
        </div>
      </div>
    </div>
  );
}

/**
 * The file a Secret file step writes and what it holds: the names its saved contents set, never
 * their values, which only go one way, from here to this computer's keychain.
 */
function SecretFileTarget({
  name,
  file,
  status,
  keychain,
  pending,
  onFileChange,
  onContentsChange,
}: {
  name: string;
  file: string;
  status: SecretFileStatus | undefined;
  keychain: boolean | undefined;
  /** New contents to save, '' to remove them, or undefined to keep what is saved. */
  pending: string | undefined;
  onFileChange: (file: string) => void;
  onContentsChange: (contents: string | undefined) => void;
}) {
  // Editing, though nothing is typed yet: '' would mean removing the contents.
  const [editing, setEditing] = React.useState(false);
  // Contents that saved close the editor, which shows what they set; the same again doesn't.
  const statusKey = JSON.stringify(status ?? null);
  const [shownStatus, setShownStatus] = React.useState(statusKey);
  if (statusKey !== shownStatus) {
    setShownStatus(statusKey);
    setEditing(false);
  }
  const fileProblem = secretFileProblem(file);
  const typing = editing || (pending !== undefined && pending !== '');
  const names = typing ? secretFileNames(pending ?? '') : (status?.names ?? []);
  return (
    <>
      <label className="order-1 grid grid-cols-[64px_minmax(0,1fr)] items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">Write</span>
        <Input
          aria-label={`File for ${name}`}
          value={file}
          onChange={(e) => onFileChange(e.target.value)}
          placeholder={DEFAULT_SECRET_FILE}
          className="h-8 font-mono text-xs"
        />
      </label>
      <div className="order-1 grid grid-cols-[64px_minmax(0,1fr)] items-start gap-2">
        <span className="pt-1.5 text-xs font-medium text-muted-foreground">Contents</span>
        <div className="space-y-1.5">
          {typing ? (
            <>
              <Textarea
                aria-label={`Contents for ${name}`}
                autoFocus={editing && pending === undefined}
                value={pending ?? ''}
                onChange={(e) => {
                  setEditing(true);
                  // Emptied while typing keeps what is saved; Remove removes it.
                  onContentsChange(e.target.value || undefined);
                }}
                placeholder={'API_KEY=…\nDATABASE_URL=…'}
                spellCheck={false}
                autoComplete="off"
                className="min-h-24 font-mono text-xs"
              />
              <div className="flex items-center gap-1.5">
                <p className="flex-1 text-ui leading-tight text-muted-foreground">
                  {status
                    ? 'Replaces the saved contents when you save.'
                    : 'Saved to this computer when you save.'}
                </p>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() => {
                    setEditing(false);
                    onContentsChange(undefined);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </>
          ) : pending === '' ? (
            <div className="flex items-center gap-1.5">
              <p className="flex-1 pt-1.5 text-xs text-muted-foreground">
                Removed from this computer when you save.
              </p>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => onContentsChange(undefined)}
              >
                Keep them
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              <p className="min-w-0 flex-1 pt-1.5 text-xs text-muted-foreground">
                {status
                  ? names.length > 0
                    ? `Sets ${names.join(', ')}`
                    : 'Saved, without a NAME=value line'
                  : 'None yet. Until there are, this step fails.'}
              </p>
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => setEditing(true)}
              >
                {status ? 'Replace' : 'Add contents'}
              </Button>
              {status && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs hover:text-error"
                  onClick={() => onContentsChange('')}
                >
                  Remove
                </Button>
              )}
            </div>
          )}
          {typing && (pending?.length ?? 0) > MAX_SECRET_FILE_CONTENTS && (
            <StepWarning>A Secret file holds at most 64 KB, so these won’t save.</StepWarning>
          )}
          {typing && names.length > 0 && (
            <p className="text-ui leading-tight text-muted-foreground">Sets {names.join(', ')}</p>
          )}
          {status?.storage === 'keychain' && keychain === false && (
            <StepWarning>
              This computer’s keychain isn’t available, so the step can’t decrypt them.
            </StepWarning>
          )}
          {keychain !== undefined && (
            <p className="text-ui leading-tight text-muted-foreground">
              {secretFileStorageNote(status, keychain)} Agents in the workspace can read the file
              once it’s written.
            </p>
          )}
        </div>
      </div>
      {fileProblem && <StepWarning>{fileProblem}</StepWarning>}
    </>
  );
}

/** Where a Secret file's contents are kept, which is never the project's settings. */
function secretFileStorageNote(status: SecretFileStatus | undefined, keychain: boolean): string {
  if (!keychain) {
    return status?.storage === 'keychain'
      ? 'Encrypted by the keychain and kept out of the project’s settings.'
      : 'This computer has no keychain, so they’re kept unencrypted, readable by you alone, and out of the project’s settings.';
  }
  return status?.storage === 'file'
    ? 'Kept unencrypted from before this computer had a keychain, until the step next runs, and out of the project’s settings.'
    : 'Encrypted by this computer’s keychain and kept out of the project’s settings.';
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
