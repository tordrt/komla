import { randomUUID } from 'crypto';

import { SetupStepResolver } from './step-resolution';

import type { ResolvedSetupStep } from './step-resolution';
import type {
  Workspace,
  Terminal,
  Project,
  SetupActivityRun,
  SetupStep,
  SetupStepPlacement,
  AgentPlacement,
  TerminalExecutionLocation,
} from '../../../shared/types';
import type { WorkspaceSetupDependencies } from '../workspace-setup.service';

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function isLocalMirrorUnsupportedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:requires? rsync|rsync(?::|\s).*(?:command not found|not found|no such file)|not yet supported on Windows)/i.test(
    message
  );
}

interface CancellableSetupRun {
  cancel(): Promise<void>;
}

/** How a background command Action runs. */
export interface BackgroundActionLaunch {
  command?: string;
  executionLocation?: TerminalExecutionLocation;
}

/** A background command Action's run, which shows with Setup's activity. */
interface ActionRun {
  actionId: string;
  command?: string;
  executionLocation: TerminalExecutionLocation;
}

const SETUP_ACTIVITY_OUTPUT_LIMIT = 64 * 1024;
const SETUP_ACTIVITY_TRUNCATION_MARKER = '\n… earlier output truncated …\n';
const SETUP_ACTIVITY_RUN_LIMIT = 50;
const SETUP_ACTIVITY_BROADCAST_INTERVAL_MS = 100;
/** How long one workspace-stop step may run before it is stopped. */
export const STOP_STEP_TIME_LIMIT_MS = 60_000;

function shouldRunSetupStep(step: SetupStep, phase: 'create' | 'start'): boolean {
  if (step.trigger === 'workspace-stop') return false;
  return phase === 'create' || step.trigger !== 'workspace-creation';
}

export class WorkspaceSetupService {
  constructor(private configuredDependencies?: WorkspaceSetupDependencies) {}

  configure(dependencies: WorkspaceSetupDependencies): void {
    this.configuredDependencies = dependencies;
  }

  private get dependencies(): WorkspaceSetupDependencies {
    if (!this.configuredDependencies)
      throw new Error('Workspace Setup Automation is not configured');
    return this.configuredDependencies;
  }

  private get resolver(): SetupStepResolver {
    return new SetupStepResolver(this.dependencies);
  }

  private remoteSetupRuns = new Map<string, Set<CancellableSetupRun>>();
  // Stops a background Action's run by activity id, until the run ends.
  private actionRunStops = new Map<string, () => Promise<void>>();
  private setupActivityBroadcastTimers = new Map<string, NodeJS.Timeout>();
  private stopStepRuns = new Map<string, Promise<void>>();

  private cancelRemote(workspaceId: string): Promise<void> | undefined {
    const runs = this.remoteSetupRuns.get(workspaceId);
    if (!runs?.size) return undefined;
    return Promise.allSettled([...runs].map((run) => run.cancel())).then(() => undefined);
  }

  /** Preserve the workspace lifecycle handoffs without exposing execution or timer state. */
  cancel(workspaceId: string, scope?: 'remote'): Promise<void> | undefined;
  cancel(workspaceId: string, scope: 'pending' | 'updates'): void;
  cancel(
    workspaceId: string,
    scope: 'pending' | 'remote' | 'updates' = 'remote'
  ): Promise<void> | undefined {
    if (scope === 'remote') return this.cancelRemote(workspaceId);
    if (scope === 'updates') {
      this.cancelSetupActivityBroadcast(workspaceId);
      return undefined;
    }
    const workspace = this.dependencies.getWorkspace(workspaceId);
    if (workspace) this.cancelPendingSetupLaunches(workspace);
    return undefined;
  }

  clearActive(workspaceId: string): void {
    const workspace = this.dependencies.getWorkspace(workspaceId);
    if (workspace) this.clearActiveSetupActivities(workspace);
  }

  stopBackground(workspaceId: string): void;
  stopBackground(workspaceId: string, options: { waitForExit: true }): Promise<void>;
  stopBackground(workspaceId: string, options?: { waitForExit: true }): void | Promise<void> {
    return options?.waitForExit
      ? this.dependencies.background.killForWorkspaceAndWait(workspaceId)
      : this.dependencies.background.killForWorkspace(workspaceId);
  }

  async dispose(): Promise<void> {
    const cleanup = Array.from(this.remoteSetupRuns.keys()).flatMap((id) => {
      const completion = this.cancelRemote(id);
      return completion ? [completion] : [];
    });
    await Promise.all(cleanup);
    for (const timer of this.setupActivityBroadcastTimers.values()) clearTimeout(timer);
    this.setupActivityBroadcastTimers.clear();
  }

  /**
   * Apply project setup steps to a workspace: spawn background processes
   * and create terminal layout. Used during both create and restart.
   * Returns the primary (agent) terminal if setup steps were applied, null otherwise.
   * `phase` is 'create' on workspace creation and 'start' on restart — steps
   * that run only on workspace creation are skipped when starting.
   */
  start(
    workspace: Workspace,
    primaryAgentCommand: string | null,
    phase: 'create' | 'start'
  ): Terminal | null {
    if (!workspace.isWorktree || !workspace.projectId) return null;

    const project = this.dependencies.projects.get(workspace.projectId);
    if (!project) return null;

    const projectSetupSteps = project.setupSteps || [];
    const setupSteps = projectSetupSteps.filter((s) => shouldRunSetupStep(s, phase));
    if (setupSteps.length === 0) return null;

    const agentPlacement: AgentPlacement =
      project.agentPlacement === 'split-right' || project.agentPlacement === 'split-bottom'
        ? project.agentPlacement
        : 'tab';
    const agentLayoutOrder = project.agentLayoutOrder ?? 0;
    // Resolve action-based steps: replace actionId with resolved command.
    // Uses the same resolution logic as addAgentTab() for prompt-type actions.
    // Carry a commandKind per step: prompt-action steps resolve to agent
    // commands; plain shell steps and command-action steps are shell commands.
    const resolvedSteps: ResolvedSetupStep[] = [];
    for (const step of setupSteps) {
      const resolved = this.resolver.resolve(step, workspace, project);
      if (resolved) resolvedSteps.push(resolved);
    }

    // Skip background steps with empty commands.
    const validSteps = resolvedSteps.filter(
      (s) => s.placement !== 'background' || s.command.trim()
    );

    // Dispatch in configured list order without awaiting any step. The primary
    // agent occupies its configured slot in that same launch sequence.
    const configuredIndex = new Map(projectSetupSteps.map((step, index) => [step.id, index]));
    const agentInsertIndex = validSteps.filter(
      (step) => (configuredIndex.get(step.id) ?? Number.MAX_SAFE_INTEGER) < agentLayoutOrder
    ).length;
    const launchItems: Array<ResolvedSetupStep | 'primary-agent'> = [...validSteps];
    launchItems.splice(agentInsertIndex, 0, 'primary-agent');
    const setupRunId = randomUUID();
    const currentActivities = workspace.setupActivities ?? [];
    const retainedActivities = currentActivities.filter(
      (activity) => activity.state !== 'unsupported' || activity.setupRunId === setupRunId
    );
    if (retainedActivities.length !== currentActivities.length) {
      workspace.setupActivities = retainedActivities;
      this.flushSetupActivityBroadcast(workspace);
    }

    return this.dispatchSetupLaunchItems(
      workspace,
      launchItems,
      primaryAgentCommand,
      agentPlacement,
      setupRunId
    );
  }

  private dispatchSetupLaunchItems(
    workspace: Workspace,
    launchItems: Array<ResolvedSetupStep | 'primary-agent'>,
    primaryAgentCommand: string | null,
    agentPlacement: AgentPlacement,
    setupRunId: string
  ): Terminal | null {
    let primaryTerminalId: string | undefined;
    let visibleTerminalCount = 0;
    for (const item of launchItems) {
      if (item === 'primary-agent') {
        const terminal = this.dependencies.addTerminal(
          workspace.id,
          workspace.name,
          primaryAgentCommand,
          visibleTerminalCount === 0 ? undefined : agentPlacement,
          'agent'
        );
        visibleTerminalCount += 1;
        if (terminal instanceof Promise) {
          void terminal.then((started) => {
            workspace.primaryTerminalId = started.id;
          });
        } else {
          primaryTerminalId = terminal.id;
        }
        continue;
      }
      if (item.placement === 'background') {
        this.launchBackgroundSetupStep(workspace, item, setupRunId);
        continue;
      }
      const terminal = this.launchVisibleSetupStep(
        workspace,
        item,
        visibleTerminalCount === 0 ? undefined : item.placement,
        setupRunId
      );
      if (terminal) {
        visibleTerminalCount += 1;
      }
    }

    workspace.primaryTerminalId = primaryTerminalId;
    return workspace.terminals.find((t) => t.id === primaryTerminalId) || null;
  }

  private launchVisibleSetupStep(
    workspace: Workspace,
    step: ResolvedSetupStep,
    layoutHint: Exclude<SetupStepPlacement, 'background'> | undefined,
    setupRunId: string
  ): Terminal | Promise<Terminal> | null {
    const unsupportedReason = step.destinationResolution?.unsupportedReason;
    if (step.validationError || unsupportedReason) {
      const activity = this.beginSetupActivity(workspace, step, 'preparing', setupRunId);
      this.finishSetupActivity(
        workspace,
        activity.id,
        unsupportedReason ? 'unsupported' : 'failed',
        {
          error: unsupportedReason ?? step.validationError,
        }
      );
      return null;
    }
    try {
      return this.dependencies.addTerminal(
        workspace.id,
        step.name,
        step.command,
        layoutHint,
        step.commandKind,
        step.destinationResolution?.executionLocation ?? 'workspace',
        step.destinationResolution?.prepare
      );
    } catch (error) {
      const activity = this.beginSetupActivity(workspace, step, 'running', setupRunId);
      this.finishSetupActivity(workspace, activity.id, 'failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private beginSetupActivity(
    workspace: Workspace,
    step: ResolvedSetupStep,
    state: 'preparing' | 'running',
    setupRunId: string,
    actionRun?: ActionRun
  ): SetupActivityRun {
    const activity: SetupActivityRun = {
      id: randomUUID(),
      workspaceId: workspace.id,
      setupRunId,
      stepId: step.id,
      stepName: step.name,
      executionLocation: step.destinationResolution?.executionLocation,
      ...actionRun,
      retryable: step.placement === 'background',
      state,
      startedAt: Date.now(),
      output: '',
    };
    const activities = [...(workspace.setupActivities ?? [])];
    while (activities.length >= SETUP_ACTIVITY_RUN_LIMIT) {
      const succeededIndex = activities.findIndex((candidate) => candidate.state === 'succeeded');
      if (succeededIndex < 0) break;
      activities.splice(succeededIndex, 1);
    }
    workspace.setupActivities = [...activities, activity];
    this.flushSetupActivityBroadcast(workspace);
    return activity;
  }

  private launchBackgroundSetupStep(
    workspace: Workspace,
    step: ResolvedSetupStep,
    setupRunId: string,
    actionRun?: ActionRun
  ): void {
    const destination = step.destinationResolution;
    const activity = this.beginSetupActivity(
      workspace,
      step,
      destination?.prepare ? 'preparing' : 'running',
      setupRunId,
      actionRun
    );
    if (step.validationError) {
      this.finishSetupActivity(workspace, activity.id, 'failed', {
        error: step.validationError,
      });
      return;
    }
    if (!destination) return;
    if (destination.unsupportedReason) {
      this.finishSetupActivity(workspace, activity.id, 'unsupported', {
        error: destination.unsupportedReason,
      });
      return;
    }

    const location = this.dependencies.locations.resolve(workspace, destination.executionLocation);
    const launch = () => {
      const activityIsCurrent = workspace.setupActivities?.some(
        (candidate) =>
          candidate.id === activity.id &&
          (candidate.state === 'preparing' || candidate.state === 'running')
      );
      if (this.dependencies.getWorkspace(workspace.id) !== workspace || !activityIsCurrent) return;
      this.setSetupActivityRunning(workspace, activity.id);
      let cancellable: CancellableSetupRun | undefined;
      const settle = () => {
        this.actionRunStops.delete(activity.id);
        if (!cancellable) return;
        const current = this.remoteSetupRuns.get(workspace.id);
        current?.delete(cancellable);
        if (current?.size === 0) this.remoteSetupRuns.delete(workspace.id);
      };
      try {
        const run = location.runBackground({
          name: step.name,
          command: step.command,
          onData: (data) => this.appendSetupActivityOutput(workspace, activity.id, data),
          onExit: (exitCode) => {
            settle();
            if (this.dependencies.getWorkspace(workspace.id) !== workspace) return;
            this.finishSetupActivity(
              workspace,
              activity.id,
              exitCode === 0 ? 'succeeded' : 'failed',
              { exitCode }
            );
          },
          onError: (error) => {
            settle();
            this.failBackgroundRun(workspace, activity.id, error);
          },
        });
        const stop = run.stop ?? run.cancel;
        if (actionRun && stop) this.actionRunStops.set(activity.id, stop);
        if (run.cancel) {
          cancellable = { cancel: run.cancel };
          let runs = this.remoteSetupRuns.get(workspace.id);
          if (!runs) {
            runs = new Set();
            this.remoteSetupRuns.set(workspace.id, runs);
          }
          runs.add(cancellable);
        }
      } catch (error) {
        this.finishSetupActivity(workspace, activity.id, 'failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
    if (destination.prepare) {
      void destination
        .prepare()
        .then(launch)
        .catch((error) =>
          this.finishSetupActivity(
            workspace,
            activity.id,
            isLocalMirrorUnsupportedError(error) ? 'unsupported' : 'failed',
            {
              error: error instanceof Error ? error.message : String(error),
            }
          )
        );
    } else {
      launch();
    }
  }

  private failBackgroundRun(workspace: Workspace, activityId: string, error: unknown): void {
    if (this.dependencies.getWorkspace(workspace.id) !== workspace) return;
    if (isAbortError(error)) {
      workspace.setupActivities = (workspace.setupActivities ?? []).filter(
        (candidate) => candidate.id !== activityId
      );
      this.flushSetupActivityBroadcast(workspace);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    const exitCode =
      error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'number'
        ? (error as { code: number }).code
        : undefined;
    this.finishSetupActivity(workspace, activityId, 'failed', { error: message, exitCode });
  }

  private setSetupActivityRunning(workspace: Workspace, activityId: string): void {
    const activity = workspace.setupActivities?.find((candidate) => candidate.id === activityId);
    if (!activity || activity.state === 'running') return;
    activity.state = 'running';
    this.flushSetupActivityBroadcast(workspace);
  }

  private appendSetupActivityOutput(workspace: Workspace, activityId: string, chunk: string): void {
    if (!chunk) return;
    const activity = workspace.setupActivities?.find((candidate) => candidate.id === activityId);
    if (!activity) return;
    const combined = activity.output + chunk;
    if (combined.length > SETUP_ACTIVITY_OUTPUT_LIMIT) {
      const keep = SETUP_ACTIVITY_OUTPUT_LIMIT - SETUP_ACTIVITY_TRUNCATION_MARKER.length;
      activity.output = SETUP_ACTIVITY_TRUNCATION_MARKER + combined.slice(-keep);
      activity.truncated = true;
    } else {
      activity.output = combined;
    }
    this.scheduleSetupActivityBroadcast(workspace);
  }

  private finishSetupActivity(
    workspace: Workspace,
    activityId: string,
    state: 'succeeded' | 'failed' | 'unsupported',
    details: { exitCode?: number; error?: string }
  ): void {
    const activity = workspace.setupActivities?.find((candidate) => candidate.id === activityId);
    if (!activity) return;
    activity.state = state;
    activity.completedAt = Date.now();
    activity.exitCode = details.exitCode;
    activity.error = details.error;
    this.flushSetupActivityBroadcast(workspace);
    if (activity.actionId) this.dependencies.notifyActionRunFinished(workspace, activity);
  }

  dismiss(workspaceId: string, activityId: string): Workspace {
    const workspace = this.dependencies.getWorkspace(workspaceId);
    if (!workspace) throw new Error(`Workspace ${workspaceId} not found`);
    workspace.setupActivities = (workspace.setupActivities ?? []).filter(
      (activity) => activity.id !== activityId
    );
    this.flushSetupActivityBroadcast(workspace);
    return workspace;
  }

  private scheduleSetupActivityBroadcast(workspace: Workspace): void {
    if (this.setupActivityBroadcastTimers.has(workspace.id)) return;
    const timer = setTimeout(() => {
      this.setupActivityBroadcastTimers.delete(workspace.id);
      if (this.dependencies.getWorkspace(workspace.id) === workspace)
        this.dependencies.broadcastWorkspaceUpdate(workspace);
    }, SETUP_ACTIVITY_BROADCAST_INTERVAL_MS);
    this.setupActivityBroadcastTimers.set(workspace.id, timer);
  }

  private cancelSetupActivityBroadcast(workspaceId: string): void {
    const timer = this.setupActivityBroadcastTimers.get(workspaceId);
    if (timer) clearTimeout(timer);
    this.setupActivityBroadcastTimers.delete(workspaceId);
  }

  private flushSetupActivityBroadcast(workspace: Workspace): void {
    this.cancelSetupActivityBroadcast(workspace.id);
    if (this.dependencies.getWorkspace(workspace.id) === workspace)
      this.dependencies.broadcastWorkspaceUpdate(workspace);
  }

  private clearActiveSetupActivities(workspace: Workspace): void {
    const activities = workspace.setupActivities ?? [];
    const completed = activities.filter(
      (activity) => activity.state !== 'preparing' && activity.state !== 'running'
    );
    if (completed.length === activities.length) return;
    workspace.setupActivities = completed;
    this.flushSetupActivityBroadcast(workspace);
  }

  private cancelPendingSetupLaunches(workspace: Workspace): void {
    const activities = workspace.setupActivities ?? [];
    const retained = activities.filter((activity) => activity.state !== 'preparing');
    if (retained.length === activities.length) return;
    workspace.setupActivities = retained;
    this.flushSetupActivityBroadcast(workspace);
  }

  /**
   * Runs a command Action without a terminal; its run shows with Setup's activity. `command` is
   * the Action's content with launch values such as its target branch filled in.
   */
  runAction(
    workspaceId: string,
    actionId: string,
    { command, executionLocation = 'workspace' }: BackgroundActionLaunch = {}
  ): Workspace {
    const workspace = this.dependencies.getWorkspace(workspaceId);
    if (!workspace) throw new Error(`Workspace ${workspaceId} not found`);
    const action = this.dependencies.actions.get(actionId);
    if (!action) throw new Error(`Quick Command ${actionId} not found`);
    if (action.type !== 'command') throw new Error('Only Terminal Commands run in the background');
    const project = workspace.projectId
      ? this.dependencies.projects.get(workspace.projectId)
      : undefined;
    const step: SetupStep = {
      id: action.id,
      name: action.title,
      command: '',
      placement: 'background',
      actionId: action.id,
      destination: executionLocation === 'local-mirror' ? 'ssh-local-copy' : 'workspace-repository',
    };
    const launched = command === undefined ? undefined : { ...action, content: command };
    const resolved = this.resolver.resolve(step, workspace, project, true, launched);
    if (!resolved) throw new Error('This Quick Command cannot run in this workspace');
    // Retry replaces a failed or unsupported run instead of listing it again.
    workspace.setupActivities = (workspace.setupActivities ?? []).filter(
      (activity) =>
        activity.actionId !== actionId ||
        (activity.state !== 'failed' && activity.state !== 'unsupported')
    );
    this.launchBackgroundSetupStep(workspace, resolved, randomUUID(), {
      actionId,
      command,
      executionLocation,
    });
    return workspace;
  }

  /**
   * Runs the project's workspace-stop steps one after another, for a workspace whose terminals
   * have stopped. Each step that outlives `timeLimitMs` is stopped. Resolves once all have ended;
   * a step that fails shows in Setup's activity and doesn't keep the next one from running.
   */
  runStopSteps(workspace: Workspace, timeLimitMs = STOP_STEP_TIME_LIMIT_MS): Promise<void> {
    const running = this.stopStepRuns.get(workspace.id);
    if (running) return running;
    const project = this.setupProject(workspace);
    const steps = this.stopSteps(project);
    if (!project || steps.length === 0) return Promise.resolve();
    const setupRunId = randomUUID();
    return this.trackStopSteps(workspace.id, async () => {
      for (const step of steps) {
        // Placement doesn't apply: a stop step never opens a terminal.
        const resolved = this.resolver.resolve(
          { ...step, placement: 'background' },
          workspace,
          project
        );
        if (!resolved) continue;
        if (resolved.commandKind === 'agent') {
          this.finishSetupActivity(
            workspace,
            this.beginSetupActivity(workspace, resolved, 'running', setupRunId).id,
            'failed',
            { error: 'A workspace-stop step runs a command, not an agent' }
          );
          continue;
        }
        if (!resolved.command.trim()) continue;
        await this.runStopStep(workspace, resolved, setupRunId, timeLimitMs);
      }
    });
  }

  /** Runs after the workspace's stop steps under way, and counts as one of them until it ends. */
  private trackStopSteps(workspaceId: string, run: () => Promise<void>): Promise<void> {
    const tracked: Promise<void> = (this.stopStepRuns.get(workspaceId) ?? Promise.resolve())
      .then(run)
      .finally(() => {
        if (this.stopStepRuns.get(workspaceId) === tracked) this.stopStepRuns.delete(workspaceId);
      });
    this.stopStepRuns.set(workspaceId, tracked);
    return tracked;
  }

  hasStopSteps(workspace: Workspace): boolean {
    return this.stopSteps(this.setupProject(workspace)).length > 0;
  }

  private setupProject(workspace: Workspace): Project | undefined {
    return workspace.isWorktree && workspace.projectId
      ? this.dependencies.projects.get(workspace.projectId)
      : undefined;
  }

  private stopSteps(project: Project | undefined): SetupStep[] {
    return (project?.setupSteps ?? []).filter((step) => step.trigger === 'workspace-stop');
  }

  /** Runs a failed stop step again, as a stop runs it: a start or deletion waits for it. */
  private retryStopStep(workspace: Workspace, project: Project, step: SetupStep): Workspace {
    const resolved = this.resolver.resolve(
      { ...step, placement: 'background' },
      workspace,
      project,
      true
    );
    if (!resolved || resolved.commandKind === 'agent') {
      throw new Error('Setup step is not applicable to this workspace');
    }
    workspace.setupActivities = (workspace.setupActivities ?? []).filter(
      (activity) =>
        activity.stepId !== step.id ||
        (activity.state !== 'failed' && activity.state !== 'unsupported')
    );
    void this.trackStopSteps(workspace.id, () =>
      this.runStopStep(workspace, resolved, randomUUID(), STOP_STEP_TIME_LIMIT_MS)
    );
    return workspace;
  }

  /** The workspace's running workspace-stop steps, which a start or deletion waits for. */
  stopStepsSettled(workspaceId: string): Promise<void> | undefined {
    return this.stopStepRuns.get(workspaceId);
  }

  private async runStopStep(
    workspace: Workspace,
    step: ResolvedSetupStep,
    setupRunId: string,
    timeLimitMs: number
  ): Promise<void> {
    const destination = step.destinationResolution;
    const activity = this.beginSetupActivity(workspace, step, 'running', setupRunId);
    if (step.validationError || !destination || destination.unsupportedReason) {
      this.finishSetupActivity(
        workspace,
        activity.id,
        destination?.unsupportedReason ? 'unsupported' : 'failed',
        { error: destination?.unsupportedReason ?? step.validationError }
      );
      return;
    }
    try {
      await destination.prepare?.();
      const location = this.dependencies.locations.resolve(
        workspace,
        destination.executionLocation
      );
      let timer: NodeJS.Timeout | undefined;
      const exitCode = await new Promise<number>((resolve, reject) => {
        const run = location.runBackground({
          name: step.name,
          command: step.command,
          onData: (data) => this.appendSetupActivityOutput(workspace, activity.id, data),
          onExit: resolve,
          onError: reject,
        });
        timer = setTimeout(() => {
          void (run.stop ?? run.cancel)?.();
          reject(new Error(`Stopped after ${Math.round(timeLimitMs / 1000)} seconds`));
        }, timeLimitMs);
      }).finally(() => clearTimeout(timer));
      this.finishSetupActivity(workspace, activity.id, exitCode === 0 ? 'succeeded' : 'failed', {
        exitCode,
      });
    } catch (error) {
      this.finishSetupActivity(
        workspace,
        activity.id,
        isLocalMirrorUnsupportedError(error) ? 'unsupported' : 'failed',
        { error: error instanceof Error ? error.message : String(error) }
      );
    }
  }

  /** Stops a background Action's run and drops it from the activity, without notifying. */
  async stopRun(workspaceId: string, activityId: string): Promise<void> {
    const workspace = this.dependencies.getWorkspace(workspaceId);
    if (!workspace) throw new Error(`Workspace ${workspaceId} not found`);
    const stop = this.actionRunStops.get(activityId);
    this.actionRunStops.delete(activityId);
    workspace.setupActivities = (workspace.setupActivities ?? []).filter(
      (activity) => activity.id !== activityId
    );
    this.flushSetupActivityBroadcast(workspace);
    await stop?.();
  }

  retry(workspaceId: string, stepId: string): Workspace {
    const workspace = this.dependencies.getWorkspace(workspaceId);
    if (!workspace) throw new Error(`Workspace ${workspaceId} not found`);
    if (!workspace.projectId) throw new Error('Workspace has no Project setup');
    const project = this.dependencies.projects.get(workspace.projectId);
    const step = project?.setupSteps?.find((candidate) => candidate.id === stepId);
    if (!project || !step) throw new Error(`Setup step ${stepId} not found`);
    if (step.trigger === 'workspace-stop') return this.retryStopStep(workspace, project, step);
    if (step.placement !== 'background') {
      throw new Error('Only background Setup steps have retryable activity');
    }
    const resolved = this.resolver.resolve(step, workspace, project, true);
    if (!resolved) {
      throw new Error('Setup step is not applicable to this workspace');
    }
    workspace.setupActivities = (workspace.setupActivities ?? []).filter(
      (activity) =>
        activity.stepId !== stepId ||
        (activity.state !== 'failed' && activity.state !== 'unsupported')
    );
    this.launchBackgroundSetupStep(workspace, resolved, randomUUID());
    return workspace;
  }
}
