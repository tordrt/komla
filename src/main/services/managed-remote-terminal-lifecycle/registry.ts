import {
  decodeManagedExecution,
  encodeTerminalExecution,
} from '../../../shared/lib/terminal-execution-state';

import type {
  ManagedRemoteTerminalContext,
  ManagedRemoteTerminalState,
  ManagedRemoteTerminalWorkspaceAdapter,
  PendingManagedRemoteTerminalIntent,
} from './types';

export class ManagedRemoteTerminalRegistry {
  private readonly states = new Map<string, ManagedRemoteTerminalState>();
  private readonly generations = new Map<string, number>();
  private readonly pending = new Map<string, PendingManagedRemoteTerminalIntent>();

  constructor(private readonly workspace: ManagedRemoteTerminalWorkspaceAdapter) {}

  state(terminalId: string): ManagedRemoteTerminalState {
    const state = this.states.get(terminalId);
    if (!state) throw new Error(`Managed remote terminal ${terminalId} not found`);
    return state;
  }

  optionalState(terminalId: string): ManagedRemoteTerminalState | undefined {
    return this.states.get(terminalId);
  }

  currentOrHydrated(context: ManagedRemoteTerminalContext): ManagedRemoteTerminalState {
    const existing = this.states.get(context.terminal.id);
    if (existing) return existing;
    const generation = this.generation(context.terminal.id);
    const execution = decodeManagedExecution(context.terminal);
    const state: ManagedRemoteTerminalState = {
      terminalId: context.terminal.id,
      workspaceId: context.workspaceId,
      generation,
      attachment:
        execution.attachment === 'absent'
          ? { kind: 'absent' }
          : { kind: execution.attachment, generation },
      remoteSession: { kind: execution.remoteSession.kind },
      persistence: execution.persistence,
      ...(context.terminal.startupError
        ? {
            failure: {
              phase: 'preparation' as const,
              message: context.terminal.startupError,
            },
          }
        : {}),
    };
    this.states.set(context.terminal.id, state);
    return state;
  }

  /** `notify: false` leaves saving and telling the windows to a caller committing several. */
  commit(
    context: ManagedRemoteTerminalContext,
    state: ManagedRemoteTerminalState,
    notify = true
  ): void {
    this.write(context, state, false);
    if (notify) this.workspace.changed(context.workspaceId);
  }

  /**
   * Commits a state that differs only in its generation, superseding work in flight. What a
   * sync last saw on the host still holds, e.g. while a stop that may fail reaches the host.
   */
  commitGeneration(context: ManagedRemoteTerminalContext, state: ManagedRemoteTerminalState): void {
    this.write(context, state, true);
    this.workspace.changed(context.workspaceId);
  }

  private write(
    context: ManagedRemoteTerminalContext,
    state: ManagedRemoteTerminalState,
    keepHostCheck: boolean
  ): void {
    this.states.set(context.terminal.id, state);
    Object.assign(
      context.terminal,
      encodeTerminalExecution({
        kind: 'managed',
        attachment: state.attachment.kind,
        remoteSession: state.remoteSession,
        persistence: state.persistence,
        keepHostCheck,
      })
    );
    context.terminal.startupError = state.failure?.message;
  }

  generation(terminalId: string): number {
    return this.generations.get(terminalId) ?? 0;
  }

  nextGeneration(terminalId: string): number {
    this.cancelPending(terminalId);
    return this.advanceGeneration(terminalId);
  }

  advanceGeneration(terminalId: string): number {
    const generation = this.generation(terminalId) + 1;
    this.generations.set(terminalId, generation);
    return generation;
  }

  isCurrent(terminalId: string, generation: number): boolean {
    return this.generations.get(terminalId) === generation;
  }

  isCurrentOrUntracked(terminalId: string, generation: number): boolean {
    return (this.generations.get(terminalId) ?? generation) === generation;
  }

  beginPending(terminalId: string, pending: PendingManagedRemoteTerminalIntent): void {
    this.pending.set(terminalId, pending);
  }

  pendingIntent(terminalId: string): PendingManagedRemoteTerminalIntent | undefined {
    return this.pending.get(terminalId);
  }

  cancelPending(terminalId: string): PendingManagedRemoteTerminalIntent | undefined {
    const pending = this.pending.get(terminalId);
    if (!pending) return undefined;
    this.pending.delete(terminalId);
    pending.cancel();
    return pending;
  }

  finishPending(terminalId: string, generation: number): void {
    if (this.pending.get(terminalId)?.generation === generation) this.pending.delete(terminalId);
  }

  forget(terminalId: string): void {
    this.states.delete(terminalId);
    this.generations.delete(terminalId);
    this.pending.delete(terminalId);
  }
}
