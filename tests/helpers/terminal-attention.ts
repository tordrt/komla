import { vi } from 'vitest';

import {
  TerminalAttention,
  type AgentHook,
  type HookTarget,
} from '../../src/main/services/terminal-attention/terminal-attention';

import type { Terminal, Workspace } from '../../src/shared/types';

/**
 * A Terminal Attention State module over an in-memory workspace store, with every port recorded.
 * Workspaces are the live objects the module writes its fields onto.
 */
export function createAttentionHarness(initial: Workspace[] = []) {
  const workspaces = new Map(initial.map((workspace) => [workspace.id, workspace]));
  const store = {
    workspaces: () => workspaces.values(),
    get: (workspaceId: string) => workspaces.get(workspaceId),
    broadcast: vi.fn<(workspace: Workspace) => void>(),
    save: vi.fn<() => void>(),
    saveNow: vi.fn<(workspaceId: string) => Promise<void>>(() => Promise.resolve()),
  };
  const windows = {
    attentionRaised: vi.fn(),
    badge: vi.fn<(count: number) => void>(),
  };
  const relay = {
    interrupted: vi.fn<(workspace: Workspace, terminalId: string, sources: string[]) => void>(),
  };
  const promptSubmitted =
    vi.fn<(workspaceId: string, prompt: string, terminalId?: string) => void>();
  const agentReplied = vi.fn<(workspaceId: string, reply: string, terminalId?: string) => void>();
  const turnActivity = vi.fn<(workspaceId: string) => void>();
  const milestone = vi.fn<(name: string, properties: Record<string, unknown>) => void>();
  const attention = new TerminalAttention({
    store,
    windows,
    relay,
    promptSubmitted,
    agentReplied,
    turnActivity,
    milestone,
  });

  return {
    attention,
    store,
    windows,
    relay,
    promptSubmitted,
    agentReplied,
    turnActivity,
    milestone,
    add: (workspace: Workspace): void => {
      workspaces.set(workspace.id, workspace);
    },
    remove: (workspaceId: string): void => {
      workspaces.delete(workspaceId);
    },
    workspace: (workspaceId: string): Workspace => {
      const workspace = workspaces.get(workspaceId);
      if (!workspace) throw new Error(`No workspace ${workspaceId} in the harness`);
      return workspace;
    },
    terminal: (terminalId: string): Terminal => {
      for (const workspace of workspaces.values()) {
        const terminal = workspace.terminals.find((candidate) => candidate.id === terminalId);
        if (terminal) return terminal;
      }
      throw new Error(`No terminal ${terminalId} in the harness`);
    },
    /** A hook matched to a Terminal, as the notify endpoint resolves it. */
    toTerminal: (terminalId: string): HookTarget => {
      for (const workspace of workspaces.values()) {
        if (workspace.terminals.some((terminal) => terminal.id === terminalId)) {
          return { workspace, terminalId, hasInvalidTerminalId: false };
        }
      }
      throw new Error(`No terminal ${terminalId} in the harness`);
    },
    /** A hook matched to a workspace by id or folder, without a Terminal. */
    toWorkspace: (
      workspaceId: string,
      options: { hasInvalidTerminalId?: boolean } = {}
    ): HookTarget => ({
      workspace: workspaces.get(workspaceId),
      hasInvalidTerminalId: options.hasInvalidTerminalId ?? false,
    }),
    /** Sends a hook and lets it settle, advancing fake timers past the 750 ms settle. */
    settle: async (target: HookTarget, hook: AgentHook) => {
      const outcome = attention.hook(target, hook);
      await vi.advanceTimersByTimeAsync(1_000);
      return outcome;
    },
  };
}

export type AttentionHarness = ReturnType<typeof createAttentionHarness>;
