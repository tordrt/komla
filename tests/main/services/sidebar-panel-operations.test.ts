import { describe, expect, it, vi } from 'vitest';

import { komlaOperationCapability } from '../../../src/main/services/komla-operation/capabilities';
import { KomlaOperationError } from '../../../src/main/services/komla-operation/operation';
import { parseKomlaOperation } from '../../../src/main/services/komla-operation/schema';
import {
  runSidebarPanelOperation,
  type PanelOperationDependencies,
  type PanelOperationPanel,
} from '../../../src/main/services/sidebar-panel-operations';

const board: PanelOperationPanel = {
  title: 'Board',
  page: 'panels/board',
  capabilities: ['workspace.tag', 'agent.launch.tab'],
};

function setup(panel: PanelOperationPanel | null = board, confirmed = true) {
  const dependencies = {
    findPanel: vi.fn(() => panel ?? undefined),
    parse: parseKomlaOperation,
    capabilityOf: komlaOperationCapability,
    execute: vi.fn(async () => ({ done: true })),
    confirm: vi.fn(async () => confirmed),
  } satisfies PanelOperationDependencies;
  return dependencies;
}

const launch = { type: 'agent.launch', destination: 'tab', prompt: 'Fix the flaky test' };

describe('runSidebarPanelOperation', () => {
  it("runs what needs no capability in the panel's workspace", async () => {
    const dependencies = setup();
    const result = await runSidebarPanelOperation(dependencies, {
      workspaceId: 'ws-1',
      panelId: 'board',
      request: { type: 'workspace.list' },
      activated: false,
    });

    expect(result).toEqual({ ok: true, result: { done: true } });
    expect(dependencies.findPanel).toHaveBeenCalledWith('ws-1', 'board');
    expect(dependencies.execute).toHaveBeenCalledWith(
      { workspaceId: 'ws-1' },
      { type: 'workspace.list' }
    );
  });

  it('acts on the workspace the page names, as --workspace does', async () => {
    const dependencies = setup();
    await runSidebarPanelOperation(dependencies, {
      workspaceId: 'ws-1',
      panelId: 'board',
      request: { type: 'workspace.tag', tag: 'Blocked' },
      targetWorkspaceId: 'ws-2',
      activated: false,
    });

    expect(dependencies.execute).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws-2', targeted: true }),
      expect.objectContaining({ type: 'workspace.tag' })
    );
  });

  it("refuses what the panel doesn't declare", async () => {
    const dependencies = setup();
    const result = await runSidebarPanelOperation(dependencies, {
      workspaceId: 'ws-1',
      panelId: 'board',
      request: { type: 'workspace.title', title: 'Hi' },
      activated: true,
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'CAPABILITY_NOT_DECLARED',
        message:
          "workspace.title needs the workspace.title capability, which the panel Board doesn't declare in sidebar-panels.json.",
        details: { capability: 'workspace.title' },
      },
    });
    expect(dependencies.execute).not.toHaveBeenCalled();
  });

  it('asks before a risky operation, and only from a click in the page', async () => {
    const dependencies = setup();
    const alone = await runSidebarPanelOperation(dependencies, {
      workspaceId: 'ws-1',
      panelId: 'board',
      request: launch,
      activated: false,
    });
    expect(alone).toMatchObject({ ok: false, error: { code: 'NEEDS_USER_ACTION' } });
    expect(dependencies.confirm).not.toHaveBeenCalled();

    const clicked = await runSidebarPanelOperation(dependencies, {
      workspaceId: 'ws-1',
      panelId: 'board',
      request: launch,
      activated: true,
    });
    expect(clicked).toEqual({ ok: true, result: { done: true } });
    expect(dependencies.confirm).toHaveBeenCalledWith({
      panel: '“Board” from sidebar-panels.json',
      action: 'launch an agent in a new tab',
      detail: 'destination: tab\nprompt: Fix the flaky test',
    });
  });

  it('drafts a launch from a click without asking, as the user starts it', async () => {
    const dependencies = setup({ ...board, capabilities: ['agent.launch.workspace'] }, false);
    const draft = { type: 'agent.launch', destination: 'workspace', prompt: 'Fix it', draft: true };

    const alone = await runSidebarPanelOperation(dependencies, {
      workspaceId: 'ws-1',
      panelId: 'board',
      request: draft,
      activated: false,
    });
    expect(alone).toMatchObject({ ok: false, error: { code: 'NEEDS_USER_ACTION' } });

    const clicked = await runSidebarPanelOperation(dependencies, {
      workspaceId: 'ws-1',
      panelId: 'board',
      request: draft,
      activated: true,
    });
    expect(clicked).toEqual({ ok: true, result: { done: true } });
    expect(dependencies.confirm).not.toHaveBeenCalled();
    expect(dependencies.execute).toHaveBeenCalledWith({ workspaceId: 'ws-1' }, draft);

    // A launch still asks, though the request names `draft` with another value.
    const undrafted = await runSidebarPanelOperation(dependencies, {
      workspaceId: 'ws-1',
      panelId: 'board',
      request: { ...draft, draft: undefined },
      activated: true,
    });
    expect(undrafted).toMatchObject({ ok: false, error: { code: 'DECLINED' } });
  });

  it('does nothing the user declines', async () => {
    const dependencies = setup({ ...board, plugin: { name: 'Board' } }, false);
    const result = await runSidebarPanelOperation(dependencies, {
      workspaceId: 'ws-1',
      panelId: 'board',
      request: launch,
      activated: true,
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'DECLINED' } });
    expect(dependencies.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ panel: '“Board” from the plugin Board' })
    );
    expect(dependencies.execute).not.toHaveBeenCalled();
  });

  it("answers with Komla's error for a bad request or a failed operation", async () => {
    const dependencies = setup();
    const invalid = await runSidebarPanelOperation(dependencies, {
      workspaceId: 'ws-1',
      panelId: 'board',
      request: { type: 'workspace.list', extra: true },
      activated: false,
    });
    expect(invalid).toMatchObject({ ok: false, error: { code: 'INVALID_OPERATION' } });

    dependencies.execute.mockRejectedValueOnce(
      new KomlaOperationError('WORKSPACE_NOT_FOUND', 'Gone.', 404)
    );
    const gone = await runSidebarPanelOperation(dependencies, {
      workspaceId: 'ws-1',
      panelId: 'board',
      request: { type: 'tag.list' },
      activated: false,
    });
    expect(gone).toEqual({ ok: false, error: { code: 'WORKSPACE_NOT_FOUND', message: 'Gone.' } });

    dependencies.execute.mockRejectedValueOnce(new Error('disk full'));
    const failed = await runSidebarPanelOperation(dependencies, {
      workspaceId: 'ws-1',
      panelId: 'board',
      request: { type: 'tag.list' },
      activated: false,
    });
    expect(failed).toEqual({
      ok: false,
      error: { code: 'OPERATION_FAILED', message: 'Komla could not complete the operation.' },
    });
  });

  it('answers only for a panel with a page the workspace shows', async () => {
    for (const panel of [null, { title: 'Checks' }]) {
      const result = await runSidebarPanelOperation(setup(panel), {
        workspaceId: 'ws-1',
        panelId: 'checks',
        request: { type: 'workspace.list' },
        activated: true,
      });
      expect(result).toMatchObject({ ok: false, error: { code: 'PANEL_NOT_FOUND' } });
    }
  });
});
