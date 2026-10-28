import fs from 'fs';
import path from 'path';

import { test as base, expect, SANDBOX_DIR, seedDefaultProject } from './electron-app';

const test = base.extend({
  seedSandbox: async ({ cleanSandbox: _cleanSandbox }, provide) => {
    seedDefaultProject({ branchPrefix: 'notify/' });
    await provide();
  },
});

async function readServerPort(): Promise<number> {
  const portFile = path.join(SANDBOX_DIR, 'port');
  for (let attempt = 0; attempt < 40; attempt++) {
    if (fs.existsSync(portFile)) {
      const port = Number(fs.readFileSync(portFile, 'utf8').trim());
      if (Number.isFinite(port) && port > 0) return port;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('HTTP server port file never appeared');
}

test.describe('HTTP /api/v1/notify', () => {
  test('POST /api/v1/notify with matching cwd returns 200 and triggers the renderer-visible effect', async ({
    appWindow,
  }) => {
    const port = await readServerPort();

    const seedWorkspace = await appWindow.evaluate(async () =>
      window.api.createWorkspace({
        mode: 'worktree',
        projectId: 'e2e-project',
        branchName: 'notify/target',
      })
    );
    expect(seedWorkspace).not.toHaveProperty('__workspaceCreateError');
    const workingDirectory = (seedWorkspace as { workingDirectory: string }).workingDirectory;
    expect(workingDirectory).toBeTruthy();

    // Wait for provisioning to clear so the workspace's workingDirectory is final.
    await expect
      .poll(async () =>
        appWindow.evaluate(async () =>
          (await window.api.getWorkspaces()).map((w) => ({
            branchName: w.branchName,
            provisioning: w.provisioning ?? false,
            provisionError: w.provisionError ?? null,
          }))
        )
      )
      .toEqual(
        expect.arrayContaining([
          { branchName: 'notify/target', provisioning: false, provisionError: null },
        ])
      );

    const baseline = Date.now();

    const response = await fetch(`http://127.0.0.1:${port}/api/v1/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cwd: workingDirectory,
        kind: 'input-required',
        source: 'claude-code',
        message: 'permission prompt',
      }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean };
    expect(body).toEqual({ success: true });

    await expect
      .poll(async () =>
        appWindow.evaluate(async (branch) => {
          const workspaces = await window.api.getWorkspaces();
          const target = workspaces.find((w) => w.branchName === branch);
          return target
            ? {
                needsAttention: target.needsAttention ?? false,
                attentionKind: target.attention?.kind ?? null,
                attentionSource: target.attention?.source ?? null,
                attentionMessage: target.attention?.message ?? null,
                attentionUpdatedAt: target.attention?.updatedAt ?? 0,
              }
            : null;
        }, 'notify/target')
      )
      .toEqual({
        needsAttention: true,
        attentionKind: 'input-required',
        attentionSource: 'claude-code',
        attentionMessage: 'permission prompt',
        attentionUpdatedAt: expect.any(Number),
      });

    const finalUpdatedAt = await appWindow.evaluate(async (branch) => {
      const target = (await window.api.getWorkspaces()).find((w) => w.branchName === branch);
      return target?.attention?.updatedAt ?? 0;
    }, 'notify/target');
    expect(finalUpdatedAt).toBeGreaterThanOrEqual(baseline);
  });

  test('Codex title fallback stops the spinner and emits completion attention', async ({
    appWindow,
  }) => {
    const port = await readServerPort();
    const result = await appWindow.evaluate(() =>
      window.api.createWorkspace({
        mode: 'worktree',
        projectId: 'e2e-project',
        branchName: 'notify/title-fallback',
        windowId: new URLSearchParams(window.location.search).get('windowId') ?? undefined,
      })
    );
    expect(result).not.toHaveProperty('__workspaceCreateError');
    const workspaceId = (result as { id: string }).id;
    await expect
      .poll(() =>
        appWindow.evaluate(
          async (id) =>
            (await window.api.getWorkspaces()).find((w) => w.id === id)?.provisioning ?? false,
          workspaceId
        )
      )
      .toBe(false);
    const terminal = await appWindow.evaluate(
      (id) => window.api.addTerminal(id, 'Review terminal', null, 'tab', 'host-shell'),
      workspaceId
    );
    await expect
      .poll(() =>
        appWindow.evaluate(
          async ({ workspaceId, terminalId }) =>
            (await window.api.getWorkspaces())
              .find((w) => w.id === workspaceId)
              ?.terminals.find((t) => t.id === terminalId)?.status,
          { workspaceId, terminalId: terminal.id }
        )
      )
      .toBe('running');
    const workspace = await appWindow.evaluate(
      async (id) => (await window.api.getWorkspaces()).find((w) => w.id === id)!,
      workspaceId
    );
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cwd: workspace.workingDirectory,
        terminalId: terminal.id,
        source: 'codex',
        kind: 'activity',
      }),
    });
    expect(response.status).toBe(200);
    await expect
      .poll(() =>
        appWindow.evaluate(
          async ({ workspaceId, terminalId }) =>
            (await window.api.getWorkspaces())
              .find((w) => w.id === workspaceId)
              ?.terminals.find((t) => t.id === terminalId)?.agentActive,
          { workspaceId, terminalId: terminal.id }
        )
      )
      .toBe(true);
    // Replay Codex's explicit title state transition through a real shell/PTY.
    await appWindow.evaluate(
      (id) =>
        window.api.sendInput(
          id,
          "printf '\\033]2;⠋ project\\007'; sleep 0.1; printf '\\033]2;project\\007'; sleep 3\r"
        ),
      terminal.id
    );
    await expect
      .poll(() =>
        appWindow.evaluate(
          async ({ workspaceId, terminalId }) =>
            (await window.api.getWorkspaces())
              .find((w) => w.id === workspaceId)
              ?.terminals.find((t) => t.id === terminalId)?.agentActive,
          { workspaceId, terminalId: terminal.id }
        )
      )
      .toBe(false);
    const attention = await appWindow.evaluate(
      async ({ workspaceId, terminalId }) =>
        (await window.api.getWorkspaces())
          .find((w) => w.id === workspaceId)
          ?.terminals.find((t) => t.id === terminalId)?.attention,
      { workspaceId, terminalId: terminal.id }
    );
    expect(attention).toMatchObject({ kind: 'turn-complete', source: 'codex' });
  });

  test('POST /api/v1/notify with unknown cwd returns 404', async ({
    electronApp: _electronApp,
  }) => {
    const port = await readServerPort();

    const response = await fetch(`http://127.0.0.1:${port}/api/v1/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cwd: '/tmp/never-a-real-workspace',
      }),
    });

    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string; cwd: string };
    expect(body.error).toBe('No matching workspace found');
    expect(body.cwd).toBe('/tmp/never-a-real-workspace');
  });
});
