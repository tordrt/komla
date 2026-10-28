import { foundOnHost } from '../../../shared/lib/terminal-execution-state';
import { createLogger } from '../../lib/logger';

import { ManagedRemoteTerminalRegistry } from './registry';

import type {
  CreateManagedRemoteTerminalRequest,
  ManagedRemoteTerminalContext,
  ManagedRemoteTerminalCreationTicket,
  ManagedRemoteTerminalAttachmentResult,
  ManagedRemoteTerminalLifecycleAdapters,
  ManagedRemoteTerminalRecovery,
  ManagedRemoteTerminalState,
  ManagedRemoteTerminalTarget,
  ReplaceManagedRemoteTerminalRequest,
} from './types';
import type { TerminalStatus } from '../../../shared/types/terminal';

export * from './types';

const logger = createLogger('ManagedRemoteTerminalLifecycleService');

interface PendingExitObservation {
  backend: ManagedRemoteTerminalContext['backend'];
  terminals: Map<
    string,
    {
      context: ManagedRemoteTerminalContext;
      detached: ManagedRemoteTerminalState;
      generation: number;
      resolves: Array<() => void>;
    }
  >;
}

export class ManagedRemoteTerminalLifecycleService {
  private readonly registry: ManagedRemoteTerminalRegistry;
  private readonly recoveredWorkspaceIds = new Set<string>();
  private readonly recoveries = new Map<string, Promise<ManagedRemoteTerminalRecovery>>();
  private readonly releasingTerminalIds = new Set<string>();
  private readonly stoppingWorkspaceCounts = new Map<string, number>();
  private readonly stoppingTerminalCounts = new Map<string, number>();
  private readonly pendingExitObservations = new Map<string, PendingExitObservation>();

  constructor(private readonly adapters: ManagedRemoteTerminalLifecycleAdapters) {
    this.registry = new ManagedRemoteTerminalRegistry(adapters.workspace);
  }

  create(request: CreateManagedRemoteTerminalRequest): ManagedRemoteTerminalCreationTicket {
    this.assertAttachmentAllowed(request.terminalId, request.releaseStartSlot, request.workspaceId);
    const context = this.requireContext(request.terminalId, request.workspaceId);
    const generation = this.nextGeneration(request.terminalId);
    const state: ManagedRemoteTerminalState = {
      terminalId: request.terminalId,
      workspaceId: request.workspaceId,
      generation,
      attachment: { kind: 'starting', generation },
      remoteSession: { kind: 'unknown' },
      persistence: 'unknown',
    };
    this.commit(context, state);

    let settleSuperseded: (() => void) | undefined;
    let settlePrepared!: (
      result:
        | { kind: 'ready'; state: ManagedRemoteTerminalState }
        | { kind: 'failed'; state: ManagedRemoteTerminalState; message: string }
        | { kind: 'superseded'; state: ManagedRemoteTerminalState }
    ) => void;
    const ready = new Promise<
      | { kind: 'ready'; state: ManagedRemoteTerminalState }
      | { kind: 'failed'; state: ManagedRemoteTerminalState; message: string }
      | { kind: 'superseded'; state: ManagedRemoteTerminalState }
    >((resolve) => {
      settlePrepared = resolve;
      settleSuperseded = () =>
        resolve({ kind: 'superseded', state: this.state(request.terminalId) });
    });

    this.registry.beginPending(request.terminalId, {
      generation,
      mayHaveRemoteSession: false,
      cancel: () => {
        request.releaseStartSlot();
        settleSuperseded?.();
      },
    });
    void this.prepareAndSpawn(context, request, state).then(settlePrepared);

    return { terminalId: request.terminalId, initialState: state, ready };
  }

  async stop(
    target: ManagedRemoteTerminalTarget,
    options: { skipTrackedAbsentSessions?: boolean } = {}
  ): Promise<void> {
    const workspaceId = 'workspaceId' in target ? target.workspaceId : undefined;
    if (workspaceId) {
      this.stoppingWorkspaceCounts.set(
        workspaceId,
        (this.stoppingWorkspaceCounts.get(workspaceId) ?? 0) + 1
      );
    }
    let terminalIds: string[] = [];
    try {
      terminalIds = this.contextsFor(target).map((context) => context.terminal.id);
      for (const terminalId of terminalIds) {
        this.stoppingTerminalCounts.set(
          terminalId,
          (this.stoppingTerminalCounts.get(terminalId) ?? 0) + 1
        );
      }
      await this.terminate(target, false, false, false, options.skipTrackedAbsentSessions === true);
    } finally {
      for (const terminalId of terminalIds) {
        const remainingStops = (this.stoppingTerminalCounts.get(terminalId) ?? 1) - 1;
        if (remainingStops === 0) {
          this.stoppingTerminalCounts.delete(terminalId);
        } else {
          this.stoppingTerminalCounts.set(terminalId, remainingStops);
        }
      }
      if (workspaceId) {
        const remainingStops = (this.stoppingWorkspaceCounts.get(workspaceId) ?? 1) - 1;
        if (remainingStops === 0) {
          this.stoppingWorkspaceCounts.delete(workspaceId);
        } else {
          this.stoppingWorkspaceCounts.set(workspaceId, remainingStops);
        }
      }
    }
  }

  async release(
    target: ManagedRemoteTerminalTarget,
    options: { skipRemoteConfirmation?: boolean; observeUnknownFirst?: boolean } = {}
  ): Promise<void> {
    const terminalIds = this.contextsFor(target).map((context) => context.terminal.id);
    const alreadyReleasing = terminalIds.find((terminalId) =>
      this.releasingTerminalIds.has(terminalId)
    );
    if (alreadyReleasing) {
      throw new Error(`Managed remote terminal ${alreadyReleasing} is already being released`);
    }
    for (const terminalId of terminalIds) {
      this.releasingTerminalIds.add(terminalId);
    }
    try {
      await this.terminate(
        target,
        true,
        options.skipRemoteConfirmation === true,
        options.observeUnknownFirst === true
      );
    } finally {
      for (const terminalId of terminalIds) {
        this.releasingTerminalIds.delete(terminalId);
      }
    }
  }

  cancelPendingLaunches(target: ManagedRemoteTerminalTarget): void {
    for (const context of this.contextsFor(target)) {
      const pending = this.registry.pendingIntent(context.terminal.id);
      if (!pending) continue;
      const current = this.currentOrHydratedState(context);
      const generation = this.registry.advanceGeneration(context.terminal.id);
      this.commit(context, {
        ...current,
        generation,
        attachment: { kind: 'absent' },
        remoteSession: pending.mayHaveRemoteSession ? current.remoteSession : { kind: 'absent' },
        failure: undefined,
      });
      this.cancelPending(context.terminal.id);
    }
  }

  async attachmentExited(terminalId: string): Promise<void> {
    const context = this.adapters.workspace.findTerminal(terminalId);
    if (!context) return;
    const current = this.currentOrHydratedState(context);
    const generation = this.registry.advanceGeneration(terminalId);
    const detached: ManagedRemoteTerminalState = {
      ...current,
      generation,
      attachment: { kind: 'absent' },
      remoteSession:
        current.persistence === 'supported'
          ? { kind: 'unknown', lastObserved: 'present' }
          : { kind: 'unknown' },
    };
    this.commit(context, detached);
    if (current.persistence !== 'supported') {
      this.adapters.workspace.reconcileObservation();
      return;
    }
    await this.enqueueExitObservation(context, detached, generation);
  }

  attachmentStatusChanged(terminalId: string, status: TerminalStatus): boolean {
    const context = this.adapters.workspace.findTerminal(terminalId);
    if (!context) return false;
    const current = this.currentOrHydratedState(context);
    const generation = this.registry.generation(terminalId) || current.generation;
    this.commit(context, {
      ...current,
      generation,
      attachment:
        status === 'running'
          ? { kind: 'attached', generation }
          : status === 'starting'
            ? { kind: 'starting', generation }
            : { kind: 'absent' },
      remoteSession: status === 'stopped' ? { kind: 'unknown' } : current.remoteSession,
    });
    if (status === 'running') {
      this.adapters.workspace.prepareObservationInBackground(context.workspaceId);
    }
    return true;
  }

  /** What this device tracks of a Terminal as a sync's host check starts. */
  hostCheckBaseline(terminalId: string): ManagedRemoteTerminalState | undefined {
    return this.registry.optionalState(terminalId);
  }

  /**
   * A sync found no session on the host for a Terminal last seen running, e.g. one another
   * device stopped: it ended, as if stopped here, superseding exit checks still in flight.
   * Returns false when this device attached, observed or changed it since `baseline`, which
   * is newer than the answer. The caller saves and tells the windows once for all it ends.
   */
  sessionGoneFromHost(
    terminalId: string,
    baseline: ManagedRemoteTerminalState | undefined
  ): boolean {
    const context = this.adapters.workspace.findTerminal(terminalId);
    if (!context || this.registry.optionalState(terminalId) !== baseline) return false;
    if (this.registry.pendingIntent(terminalId)) return false;
    const current = this.currentOrHydratedState(context);
    if (current.attachment.kind !== 'absent') return false;
    const generation = this.registry.advanceGeneration(terminalId);
    this.registry.commit(
      context,
      { ...current, generation, remoteSession: { kind: 'absent' } },
      false
    );
    return true;
  }

  private enqueueExitObservation(
    context: ManagedRemoteTerminalContext,
    detached: ManagedRemoteTerminalState,
    generation: number
  ): Promise<void> {
    const hostId = context.backend.hostId;
    let pending = this.pendingExitObservations.get(hostId);
    if (!pending) {
      pending = { backend: context.backend, terminals: new Map() };
      this.pendingExitObservations.set(hostId, pending);
      setImmediate(() => void this.flushExitObservations(hostId, pending!));
    }
    return new Promise((resolve) => {
      const queued = pending.terminals.get(context.terminal.id);
      if (queued) {
        queued.context = context;
        queued.detached = detached;
        queued.generation = generation;
        queued.resolves.push(resolve);
      } else {
        pending.terminals.set(context.terminal.id, {
          context,
          detached,
          generation,
          resolves: [resolve],
        });
      }
    });
  }

  private async flushExitObservations(
    hostId: string,
    pending: PendingExitObservation
  ): Promise<void> {
    if (this.pendingExitObservations.get(hostId) !== pending) return;
    this.pendingExitObservations.delete(hostId);
    try {
      const activeIds = await this.adapters.session.observe(pending.backend, [
        ...pending.terminals.keys(),
      ]);
      let changed = false;
      for (const [terminalId, { context, detached, generation }] of pending.terminals) {
        if (!this.isCurrent(terminalId, generation)) continue;
        // An ended session still ran in tmux: like one stopped here, its Terminal stays saved and
        // synced, so other devices don't take it for a tab closed here.
        this.commit(context, {
          ...detached,
          remoteSession: activeIds.has(terminalId) ? { kind: 'present' } : { kind: 'absent' },
        });
        changed = true;
      }
      if (changed) this.adapters.workspace.reconcileObservation();
    } catch (error) {
      for (const [terminalId, { context }] of pending.terminals) {
        logger.warn('Could not confirm Managed Remote Terminal Session after attachment exit', {
          terminalId,
          workspaceId: context.workspaceId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      for (const { resolves } of pending.terminals.values()) {
        for (const resolve of resolves) resolve();
      }
    }
  }

  private async terminate(
    target: ManagedRemoteTerminalTarget,
    release: boolean,
    skipRemoteConfirmation = false,
    observeUnknownFirst = false,
    skipTrackedAbsentSessions = false
  ): Promise<void> {
    const contexts = this.contextsFor(target);
    if (observeUnknownFirst && contexts[0]) {
      await this.observeUnknownSessions(contexts);
    }
    const remoteTerminalIds: string[] = [];
    for (const context of contexts) {
      const pending = this.registry.pendingIntent(context.terminal.id);
      // Only state this lifecycle observed counts; hydrated state may come from stale persistence.
      const trackedAbsent =
        skipTrackedAbsentSessions &&
        !pending &&
        this.registry.optionalState(context.terminal.id)?.remoteSession.kind === 'absent';
      // A failed launch here started no session, but another device may have started one.
      const launchFailedHere =
        !!context.terminal.startupError && !foundOnHost(context, context.terminal);
      const current = this.currentOrHydratedState(context);
      const generation = this.registry.advanceGeneration(context.terminal.id);
      if (pending) {
        this.commit(context, {
          ...current,
          generation,
          attachment: { kind: 'absent' },
          remoteSession: pending.mayHaveRemoteSession
            ? { kind: 'unknown', lastObserved: 'present' }
            : { kind: 'absent' },
          failure: undefined,
        });
        this.cancelPending(context.terminal.id);
      } else {
        this.registry.commitGeneration(context, { ...current, generation });
      }
      if (!trackedAbsent && !launchFailedHere && pending?.mayHaveRemoteSession !== false) {
        remoteTerminalIds.push(context.terminal.id);
      }
    }
    if (!skipRemoteConfirmation && remoteTerminalIds.length > 0 && contexts[0]) {
      await this.adapters.session.stopAndConfirmAbsent(contexts[0].backend, remoteTerminalIds);
    }
    await this.terminateAttachments(contexts, release);
    this.adapters.workspace.reconcileObservation();
  }

  private async observeUnknownSessions(contexts: ManagedRemoteTerminalContext[]): Promise<void> {
    const unknownContexts = contexts.filter(
      (context) => this.currentOrHydratedState(context).remoteSession.kind === 'unknown'
    );
    if (unknownContexts.length === 0) return;
    const activeIds = await this.adapters.session.observe(
      contexts[0].backend,
      unknownContexts.map((context) => context.terminal.id)
    );
    for (const context of unknownContexts) {
      const current = this.currentOrHydratedState(context);
      this.commit(context, {
        ...current,
        remoteSession: activeIds.has(context.terminal.id)
          ? { kind: 'present' }
          : { kind: 'absent' },
      });
    }
  }

  private async terminateAttachments(
    contexts: ManagedRemoteTerminalContext[],
    release: boolean
  ): Promise<void> {
    for (const context of contexts) {
      if (release) {
        await this.adapters.attachment.release(context.terminal.id);
      } else {
        this.adapters.attachment.stop(context.terminal.id);
      }
      const current = this.currentOrHydratedState(context);
      const generation = this.registry.advanceGeneration(context.terminal.id);
      this.commit(context, {
        ...current,
        generation,
        attachment: { kind: 'absent' },
        remoteSession: { kind: 'absent' },
        failure: undefined,
      });
      if (release) {
        this.registry.forget(context.terminal.id);
      }
    }
  }

  replace(
    request: ReplaceManagedRemoteTerminalRequest
  ): Promise<ManagedRemoteTerminalAttachmentResult> {
    return this.attachExisting(request, 'replace');
  }

  reconnect(
    request: Omit<ReplaceManagedRemoteTerminalRequest, 'explicit'>
  ): ManagedRemoteTerminalAttachmentResult | Promise<ManagedRemoteTerminalAttachmentResult> {
    this.assertAttachmentAllowed(request.terminalId, request.releaseStartSlot);
    const context = this.requireContext(request.terminalId);
    const current = this.currentOrHydratedState(context);
    if (current.persistence === 'supported') {
      return this.fastReconnect(context, current, request);
    }
    return this.attachExisting(request, 'reconnect');
  }

  recover(workspaceId: string): Promise<ManagedRemoteTerminalRecovery> {
    const existing = this.recoveries.get(workspaceId);
    if (existing) return existing;
    const recovery = this.recoverOnce(workspaceId).finally(() => {
      if (this.recoveries.get(workspaceId) === recovery) {
        this.recoveries.delete(workspaceId);
      }
    });
    this.recoveries.set(workspaceId, recovery);
    return recovery;
  }

  state(terminalId: string): ManagedRemoteTerminalState {
    return this.registry.state(terminalId);
  }

  private async prepareAndSpawn(
    context: ManagedRemoteTerminalContext,
    request: CreateManagedRemoteTerminalRequest,
    initialState: ManagedRemoteTerminalState
  ): Promise<
    | { kind: 'ready'; state: ManagedRemoteTerminalState }
    | { kind: 'failed'; state: ManagedRemoteTerminalState; message: string }
    | { kind: 'superseded'; state: ManagedRemoteTerminalState }
  > {
    try {
      const persistenceDetection = this.detectPersistenceInBackground(
        context,
        initialState.generation
      );
      // Preserve a cancellation window for synchronous shutdown and pane removal without
      // waiting for the remote capability check itself.
      await Promise.resolve();
      if (persistenceDetection.failure) throw persistenceDetection.failure.error;
      if (!this.isCurrent(context.terminal.id, initialState.generation)) {
        request.releaseStartSlot();
        return {
          kind: 'superseded',
          state: this.registry.optionalState(context.terminal.id) ?? initialState,
        };
      }
      const preparedContext = this.requireContext(context.terminal.id, context.workspaceId);
      const launch = this.adapters.session.buildAttachment({
        backend: preparedContext.backend,
        workspaceId: preparedContext.workspaceId,
        terminalId: preparedContext.terminal.id,
        command: request.command,
        action: 'start',
        keepShellOpenAfterCommand: request.keepShellOpenAfterCommand,
        companion: preparedContext.companion,
      });
      this.adapters.attachment.spawn({
        terminalId: context.terminal.id,
        workspaceId: context.workspaceId,
        cwd: launch.cwd,
        command: launch.command,
        startupMode: launch.startupMode,
        localLoginShell: launch.localLoginShell,
      });
      this.adapters.workspace.prepareObservationInBackground(context.workspaceId);
      this.finishPending(context.terminal.id, initialState.generation);
      request.releaseStartSlot();
      return { kind: 'ready', state: initialState };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!this.isCurrent(context.terminal.id, initialState.generation)) {
        request.releaseStartSlot();
        return {
          kind: 'superseded',
          state: this.registry.optionalState(context.terminal.id) ?? initialState,
        };
      }
      const failed: ManagedRemoteTerminalState = {
        ...initialState,
        attachment: { kind: 'absent' },
        failure: { phase: 'preparation', message },
      };
      this.commit(context, failed);
      this.finishPending(context.terminal.id, initialState.generation);
      this.adapters.workspace.reconcileObservation();
      request.releaseStartSlot();
      return { kind: 'failed', state: failed, message };
    }
  }

  private detectPersistenceInBackground(
    context: ManagedRemoteTerminalContext,
    generation: number
  ): { failure?: { error: unknown } } {
    const result: { failure?: { error: unknown } } = {};
    let detection: Promise<boolean>;
    try {
      detection = this.adapters.session.supportsPersistence(context.backend);
    } catch (error) {
      result.failure = { error };
      logger.debug('Could not detect Managed Remote Terminal persistence', {
        terminalId: context.terminal.id,
        workspaceId: context.workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
      return result;
    }
    void detection.then(
      (supported) => {
        if (!this.isCurrent(context.terminal.id, generation)) return;
        const currentContext = this.adapters.workspace.findTerminal(context.terminal.id);
        const current = this.registry.optionalState(context.terminal.id);
        if (!currentContext || currentContext.workspaceId !== context.workspaceId || !current)
          return;
        this.commit(currentContext, {
          ...current,
          persistence: supported ? 'supported' : 'unsupported',
        });
      },
      (error) => {
        result.failure = { error };
        logger.debug('Could not detect Managed Remote Terminal persistence', {
          terminalId: context.terminal.id,
          workspaceId: context.workspaceId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    );
    return result;
  }

  private async attachExisting(
    request: ReplaceManagedRemoteTerminalRequest,
    action: 'reconnect' | 'replace'
  ): Promise<ManagedRemoteTerminalAttachmentResult> {
    this.assertAttachmentAllowed(request.terminalId, request.releaseStartSlot);
    const context = this.requireContext(request.terminalId);
    let previous = this.currentOrHydratedState(context);
    if (action === 'replace' && !request.explicit && previous.remoteSession.kind === 'unknown') {
      let activeIds: Set<string>;
      try {
        activeIds = await this.adapters.session.observe(context.backend, [request.terminalId]);
      } catch (error) {
        request.releaseStartSlot();
        throw new Error(
          `Could not confirm the remote agent state; terminal replacement was cancelled. ${String(error)}`
        );
      }
      if (activeIds.has(request.terminalId)) {
        previous = { ...previous, remoteSession: { kind: 'present' } };
        this.commit(context, previous);
        request.releaseStartSlot();
        throw new Error(
          'A running remote session was recovered; reconnect to it instead of replacing it.'
        );
      }
      previous = { ...previous, remoteSession: { kind: 'absent' } };
      this.commit(context, previous);
    }

    const generation = this.nextGeneration(request.terminalId);
    const starting: ManagedRemoteTerminalState = {
      ...previous,
      generation,
      attachment: { kind: 'starting', generation },
      remoteSession: { kind: 'unknown' },
      failure: undefined,
    };
    this.commit(context, starting);
    this.registry.beginPending(request.terminalId, {
      generation,
      mayHaveRemoteSession: previous.remoteSession.kind === 'present' || action === 'reconnect',
      cancel: request.releaseStartSlot,
    });

    let authorized = false;
    try {
      if (action === 'replace') {
        await this.adapters.workspace.prepareObservationBestEffort(context.workspaceId);
      }
      const supported = await this.adapters.session.supportsPersistence(context.backend);
      if (!this.isCurrent(request.terminalId, generation)) {
        request.releaseStartSlot();
        return {
          kind: 'superseded',
          state: this.registry.optionalState(request.terminalId) ?? starting,
        };
      }
      request.onAuthorized?.();
      authorized = true;
      const prepared: ManagedRemoteTerminalState = {
        ...starting,
        persistence: supported ? 'supported' : 'unsupported',
      };
      this.commit(context, prepared);
      const preparedContext = this.requireContext(request.terminalId, context.workspaceId);
      const launch = this.adapters.session.buildAttachment({
        backend: preparedContext.backend,
        workspaceId: preparedContext.workspaceId,
        terminalId: request.terminalId,
        command: request.command,
        action,
        keepShellOpenAfterCommand: request.keepShellOpenAfterCommand,
        companion: preparedContext.companion,
      });
      this.adapters.attachment.replace({
        terminalId: request.terminalId,
        workspaceId: context.workspaceId,
        cwd: launch.cwd,
        command: launch.command,
        cols: request.cols,
        rows: request.rows,
        startupMode: launch.startupMode,
        localLoginShell: launch.localLoginShell,
      });
      if (action === 'reconnect') {
        this.adapters.workspace.prepareObservationInBackground(context.workspaceId);
      }
      this.finishPending(request.terminalId, generation);
      request.releaseStartSlot();
      return { kind: 'ready', state: prepared };
    } catch (error) {
      if (this.isCurrent(request.terminalId, generation)) {
        const failed: ManagedRemoteTerminalState =
          action === 'reconnect' && !authorized
            ? { ...previous, generation }
            : { ...starting, attachment: { kind: 'absent' } };
        this.commit(context, failed);
        this.finishPending(request.terminalId, generation);
        this.adapters.workspace.reconcileObservation();
      }
      request.releaseStartSlot();
      throw error;
    }
  }

  private fastReconnect(
    context: ManagedRemoteTerminalContext,
    previous: ManagedRemoteTerminalState,
    request: Omit<ReplaceManagedRemoteTerminalRequest, 'explicit'>
  ): ManagedRemoteTerminalAttachmentResult {
    const generation = this.nextGeneration(request.terminalId);
    const starting: ManagedRemoteTerminalState = {
      ...previous,
      generation,
      attachment: { kind: 'starting', generation },
      remoteSession: { kind: 'unknown' },
      failure: undefined,
    };
    this.commit(context, starting);
    try {
      const preparedContext = this.requireContext(request.terminalId, context.workspaceId);
      const launch = this.adapters.session.buildAttachment({
        backend: preparedContext.backend,
        workspaceId: preparedContext.workspaceId,
        terminalId: request.terminalId,
        command: request.command,
        action: 'reconnect',
        keepShellOpenAfterCommand: request.keepShellOpenAfterCommand,
        companion: preparedContext.companion,
      });
      this.adapters.attachment.replace({
        terminalId: request.terminalId,
        workspaceId: context.workspaceId,
        cwd: launch.cwd,
        command: launch.command,
        cols: request.cols,
        rows: request.rows,
        startupMode: launch.startupMode,
        localLoginShell: launch.localLoginShell,
      });
      this.adapters.workspace.prepareObservationInBackground(context.workspaceId);
      request.releaseStartSlot();
      return { kind: 'ready', state: starting };
    } catch (error) {
      this.commit(context, { ...starting, attachment: { kind: 'absent' } });
      request.releaseStartSlot();
      throw error;
    }
  }

  private async recoverOnce(workspaceId: string): Promise<ManagedRemoteTerminalRecovery> {
    const workspace = this.adapters.workspace.findWorkspace(workspaceId);
    if (!workspace) throw new Error(`Managed remote workspace ${workspaceId} not found`);
    const contexts = this.contextsFor({ workspaceId }).filter(
      (context) => context.terminal.status === 'stopped'
    );
    if (!this.adapters.session.hasHost(workspace.backend)) {
      const states = new Map<string, ManagedRemoteTerminalState>();
      for (const context of contexts) {
        const current = this.currentOrHydratedState(context);
        const absent: ManagedRemoteTerminalState = {
          ...current,
          attachment: { kind: 'absent' },
          remoteSession: { kind: 'absent' },
        };
        this.commit(context, absent);
        states.set(context.terminal.id, absent);
      }
      this.recoveredWorkspaceIds.add(workspaceId);
      return { states, endedTerminalIds: new Set(), hostMissing: true };
    }
    if (this.recoveredWorkspaceIds.has(workspaceId)) {
      return {
        states: new Map(
          contexts.map((context) => [context.terminal.id, this.currentOrHydratedState(context)])
        ),
        endedTerminalIds: new Set(),
        hostMissing: false,
      };
    }

    const baselines = contexts.map((context) => ({
      context,
      generation: this.currentOrHydratedState(context).generation,
      status: context.terminal.status,
      remoteSessionActive: context.terminal.remoteSessionActive,
    }));
    const activeIds = await this.adapters.session.observe(
      workspace.backend,
      contexts.map((context) => context.terminal.id)
    );
    const states = new Map<string, ManagedRemoteTerminalState>();
    const endedTerminalIds = new Set<string>();
    for (const baseline of baselines) {
      const { context } = baseline;
      if (
        context.terminal.status !== baseline.status ||
        context.terminal.remoteSessionActive !== baseline.remoteSessionActive ||
        !this.isCurrentOrUntracked(context.terminal.id, baseline.generation)
      ) {
        continue;
      }
      const active = activeIds.has(context.terminal.id);
      const state: ManagedRemoteTerminalState = {
        ...this.currentOrHydratedState(context),
        attachment: { kind: 'absent' },
        remoteSession: active ? { kind: 'present' } : { kind: 'absent' },
        persistence: active ? 'supported' : 'unsupported',
      };
      this.commit(context, state);
      states.set(context.terminal.id, state);
      if (!active) endedTerminalIds.add(context.terminal.id);
    }
    if (
      contexts.some(
        (context) =>
          context.terminal.status === 'starting' ||
          context.terminal.status === 'running' ||
          context.terminal.remoteSessionActive === true
      )
    ) {
      await this.adapters.workspace.prepareObservationBestEffort(workspaceId);
    }
    this.recoveredWorkspaceIds.add(workspaceId);
    return { states, endedTerminalIds, hostMissing: false };
  }

  private requireContext(terminalId: string, workspaceId?: string): ManagedRemoteTerminalContext {
    const context = this.adapters.workspace.findTerminal(terminalId);
    if (!context || (workspaceId && context.workspaceId !== workspaceId)) {
      throw new Error(`Managed remote terminal ${terminalId} not found`);
    }
    return context;
  }

  private assertAttachmentAllowed(
    terminalId: string,
    releaseStartSlot: () => void,
    workspaceId?: string
  ): void {
    if (workspaceId && this.stoppingWorkspaceCounts.has(workspaceId)) {
      releaseStartSlot();
      throw new Error(`Managed remote workspace ${workspaceId} is being stopped`);
    }
    if (this.releasingTerminalIds.has(terminalId)) {
      releaseStartSlot();
      throw new Error(`Managed remote terminal ${terminalId} is being released`);
    }
    if (this.stoppingTerminalCounts.has(terminalId)) {
      releaseStartSlot();
      throw new Error(`Managed remote terminal ${terminalId} is being stopped`);
    }
  }

  private contextsFor(target: ManagedRemoteTerminalTarget): ManagedRemoteTerminalContext[] {
    if ('terminalId' in target) return [this.requireContext(target.terminalId)];
    const workspace = this.adapters.workspace.findWorkspace(target.workspaceId);
    if (!workspace) throw new Error(`Managed remote workspace ${target.workspaceId} not found`);
    return workspace.terminals
      .map((terminal) => this.adapters.workspace.findTerminal(terminal.id))
      .filter((context): context is ManagedRemoteTerminalContext => Boolean(context));
  }

  private currentOrHydratedState(
    context: ManagedRemoteTerminalContext
  ): ManagedRemoteTerminalState {
    return this.registry.currentOrHydrated(context);
  }

  private nextGeneration(terminalId: string): number {
    return this.registry.nextGeneration(terminalId);
  }

  private isCurrent(terminalId: string, generation: number): boolean {
    return this.registry.isCurrent(terminalId, generation);
  }

  private isCurrentOrUntracked(terminalId: string, generation: number): boolean {
    return this.registry.isCurrentOrUntracked(terminalId, generation);
  }

  private cancelPending(terminalId: string) {
    return this.registry.cancelPending(terminalId);
  }

  private finishPending(terminalId: string, generation: number): void {
    this.registry.finishPending(terminalId, generation);
  }

  private commit(context: ManagedRemoteTerminalContext, state: ManagedRemoteTerminalState): void {
    this.registry.commit(context, state);
  }
}
