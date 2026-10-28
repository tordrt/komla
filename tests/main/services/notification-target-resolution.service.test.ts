import { describe, expect, it, vi } from 'vitest';

import { notificationTargetResolutionService } from '../../../src/main/services/notification-target-resolution.service';

import { createTerminal, createWorkspace } from '../../factories';

import type {
  NotificationTargetResolutionContext,
  NotificationTargetPayload,
} from '../../../src/main/services/notification-target-resolution.service';
import type { Workspace } from '../../../src/shared/types';

function createContext(
  workspaces: Workspace[],
  resolveByCwd: NotificationTargetResolutionContext['resolveWorkspaceByCwd'] = () => ({
    error: 'No matching workspace found',
  })
): NotificationTargetResolutionContext {
  return {
    findWorkspaceByTerminalId: vi.fn((terminalId: string) =>
      workspaces.find((workspace) =>
        workspace.terminals.some((terminal) => terminal.id === terminalId)
      )
    ),
    getWorkspace: vi.fn((workspaceId: string) =>
      workspaces.find((workspace) => workspace.id === workspaceId)
    ),
    resolveWorkspaceByCwd: vi.fn(resolveByCwd),
  };
}

function resolve(
  payload: NotificationTargetPayload,
  context: NotificationTargetResolutionContext
) {
  return notificationTargetResolutionService.resolve(payload, context);
}

describe('notificationTargetResolutionService', () => {
  it('lets terminalId choose the workspace before workspaceId', () => {
    const workspaceOne = createWorkspace({
      id: 'ws-1',
      terminals: [createTerminal({ id: 'term-1' })],
    });
    const workspaceTwo = createWorkspace({
      id: 'ws-2',
      terminals: [createTerminal({ id: 'term-2' })],
    });
    const context = createContext([workspaceOne, workspaceTwo]);

    const result = resolve(
      { cwd: '/projects/shared', workspaceId: 'ws-1', terminalId: 'term-2' },
      context
    );

    expect(result.workspace).toBe(workspaceTwo);
    expect(result.terminalId).toBe('term-2');
    expect(result.hasInvalidTerminalId).toBe(false);
    expect(context.resolveWorkspaceByCwd).not.toHaveBeenCalled();
  });

  it('uses workspaceId when no terminalId is provided', () => {
    const workspace = createWorkspace({ id: 'ws-1' });
    const context = createContext([workspace]);

    const result = resolve({ cwd: '/projects/app', workspaceId: 'ws-1' }, context);

    expect(result.workspace).toBe(workspace);
    expect(result.terminalId).toBeUndefined();
    expect(result.hasInvalidTerminalId).toBe(false);
    expect(context.resolveWorkspaceByCwd).not.toHaveBeenCalled();
  });

  it('falls back to cwd when terminalId is stale', () => {
    const workspace = createWorkspace({
      id: 'ws-1',
      workingDirectory: '/projects/app',
      terminals: [createTerminal({ id: 'term-1' })],
    });
    const context = createContext([workspace], () => ({ workspace }));

    const result = resolve({ cwd: '/projects/app', terminalId: 'stale-term' }, context);

    expect(result.workspace).toBe(workspace);
    expect(result.terminalId).toBeUndefined();
    expect(result.hasInvalidTerminalId).toBe(true);
    expect(result.warnings).toEqual([
      {
        kind: 'terminal-not-found',
        workspaceId: undefined,
        terminalId: 'stale-term',
        cwd: '/projects/app',
      },
    ]);
  });

  it('keeps terminal attribution when cwd resolves to a workspace containing the terminal', () => {
    const workspace = createWorkspace({
      id: 'ws-1',
      workingDirectory: '/projects/app',
      terminals: [createTerminal({ id: 'term-1' })],
    });
    const context = createContext([workspace], () => ({ workspace }));
    vi.mocked(context.findWorkspaceByTerminalId).mockReturnValue(undefined);

    const result = resolve({ cwd: '/projects/app', terminalId: 'term-1' }, context);

    expect(result.workspace).toBe(workspace);
    expect(result.terminalId).toBe('term-1');
    expect(result.hasInvalidTerminalId).toBe(false);
  });

  describe("a Codex hook, which may carry the ids of the Terminal that started Codex's shared process", () => {
    const own = createWorkspace({
      id: 'ws-own',
      workingDirectory: '/projects/own',
      terminals: [createTerminal({ id: 'term-own' })],
    });
    const other = createWorkspace({
      id: 'ws-other',
      workingDirectory: '/projects/other',
      terminals: [createTerminal({ id: 'term-other' })],
    });

    it("goes to the workspace of its cwd, not another workspace's Terminal", () => {
      const context = createContext([own, other], () => ({ workspace: own }));

      const result = resolve(
        {
          cwd: '/projects/own',
          workspaceId: 'ws-other',
          terminalId: 'term-other',
          source: 'codex',
        },
        context
      );

      expect(result.workspace).toBe(own);
      expect(result.terminalId).toBeUndefined();
      expect(result.hasInvalidTerminalId).toBe(false);
    });

    it('goes to the workspace of its cwd when the Terminal that started the process is gone', () => {
      const context = createContext([own, other], () => ({ workspace: own }));

      const result = resolve(
        { cwd: '/projects/own', workspaceId: 'ws-other', terminalId: 'gone', source: 'codex' },
        context
      );

      expect(result.workspace).toBe(own);
      expect(result.terminalId).toBeUndefined();
      expect(result.hasInvalidTerminalId).toBe(false);
    });

    it('keeps a Terminal of the workspace of its cwd', () => {
      const context = createContext([own, other], () => ({ workspace: own }));

      const result = resolve(
        { cwd: '/projects/own', workspaceId: 'ws-own', terminalId: 'term-own', source: 'codex' },
        context
      );

      expect(result.workspace).toBe(own);
      expect(result.terminalId).toBe('term-own');
      expect(result.hasInvalidTerminalId).toBe(false);
    });

    it('falls back to its ids when no single workspace matches its cwd', () => {
      const context = createContext([own, other]);

      const result = resolve(
        { cwd: '/elsewhere', workspaceId: 'ws-other', terminalId: 'term-other', source: 'codex' },
        context
      );

      expect(result.workspace).toBe(other);
      expect(result.terminalId).toBe('term-other');
    });
  });

  it('falls back to cwd when terminalId does not belong to workspaceId', () => {
    const workspace = createWorkspace({
      id: 'ws-1',
      workingDirectory: '/projects/app',
      terminals: [createTerminal({ id: 'term-1' })],
    });
    const context = createContext([workspace], () => ({ workspace }));

    const result = resolve(
      { cwd: '/projects/app', workspaceId: 'ws-1', terminalId: 'stale-term' },
      context
    );

    expect(result.workspace).toBe(workspace);
    expect(result.terminalId).toBeUndefined();
    expect(result.hasInvalidTerminalId).toBe(true);
    expect(result.warnings.map((warning) => warning.kind)).toEqual([
      'terminal-not-found',
      'terminal-not-in-workspace',
    ]);
  });

  it('returns notFound when cwd resolution rejects an ambiguous match', () => {
    const context = createContext([], () => ({
      error:
        'Multiple workspaces match cwd: /projects/shared. This MCP tool cannot safely choose a workspace unless exactly one matching workspace is running.',
    }));

    const result = resolve({ cwd: '/projects/shared', terminalId: 'stale-term' }, context);

    expect(result.workspace).toBeUndefined();
    expect(result.terminalId).toBeUndefined();
    expect(result.hasInvalidTerminalId).toBe(true);
    expect(result.error).toContain('Multiple workspaces match cwd');
    expect(result.warnings.map((warning) => warning.kind)).toEqual([
      'terminal-not-found',
      'cwd-not-resolved',
    ]);
  });
});
