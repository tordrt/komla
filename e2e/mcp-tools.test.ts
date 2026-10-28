import fs from 'fs';
import path from 'path';

import { test as base, expect, SANDBOX_DIR, seedDefaultProject } from './electron-app';

const test = base.extend({
  seedSandbox: async ({ cleanSandbox: _cleanSandbox }, provide) => {
    seedDefaultProject({ branchPrefix: 'mcp/' });
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

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

async function mcpCall(
  port: number,
  call: { id: number; method: string; params?: unknown }
): Promise<JsonRpcResponse> {
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', ...call }),
  });

  if (!response.ok) {
    throw new Error(`MCP request failed ${response.status}: ${await response.text()}`);
  }

  const text = await response.text();
  for (const line of text.split('\n')) {
    if (line.startsWith('data:')) {
      const payload = line.slice(5).trim();
      if (payload) return JSON.parse(payload) as JsonRpcResponse;
    }
  }
  throw new Error(`MCP response had no data line. Body: ${text}`);
}

test.describe('MCP tools', () => {
  test.describe.configure({ timeout: 90_000 });

  test("set_workspace_title updates a workspace's customName/customDescription", async ({
    appWindow,
  }) => {
    const port = await readServerPort();

    const seedWorkspace = await appWindow.evaluate(async () =>
      window.api.createWorkspace({
        mode: 'worktree',
        projectId: 'e2e-project',
        branchName: 'mcp/seed-title',
      })
    );
    expect(seedWorkspace).not.toHaveProperty('__workspaceCreateError');
    const cwd = (seedWorkspace as { workingDirectory: string }).workingDirectory;
    expect(cwd).toBeTruthy();

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
          { branchName: 'mcp/seed-title', provisioning: false, provisionError: null },
        ])
      );

    const response = await mcpCall(port, {
      id: 1,
      method: 'tools/call',
      params: {
        name: 'set_workspace_title',
        arguments: { cwd, title: 'Renamed', description: 'From MCP' },
      },
    });

    expect(response.error).toBeUndefined();
    const result = response.result as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    if (result.isError) {
      throw new Error(`set_workspace_title failed: ${result.content[0]?.text ?? 'no text'}`);
    }

    await expect
      .poll(async () =>
        appWindow.evaluate(async () =>
          (await window.api.getWorkspaces())
            .filter((w) => w.branchName === 'mcp/seed-title')
            .map((w) => ({
              customName: w.customName ?? null,
              customDescription: w.customDescription ?? null,
            }))
        )
      )
      .toEqual([{ customName: 'Renamed', customDescription: 'From MCP' }]);
  });

  test('spawn_agent_new_tab adds a terminal to the workspace', async ({ appWindow }) => {
    const port = await readServerPort();

    const seedWorkspace = await appWindow.evaluate(async () =>
      window.api.createWorkspace({
        mode: 'worktree',
        projectId: 'e2e-project',
        branchName: 'mcp/seed-tab',
      })
    );
    expect(seedWorkspace).not.toHaveProperty('__workspaceCreateError');
    const cwd = (seedWorkspace as { workingDirectory: string }).workingDirectory;
    expect(cwd).toBeTruthy();

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
          { branchName: 'mcp/seed-tab', provisioning: false, provisionError: null },
        ])
      );

    const baseline = await appWindow.evaluate(async () => {
      const workspaces = await window.api.getWorkspaces();
      const w = workspaces.find((ws) => ws.branchName === 'mcp/seed-tab');
      return w ? w.terminals.length : -1;
    });
    expect(baseline).toBeGreaterThanOrEqual(0);

    const response = await mcpCall(port, {
      id: 2,
      method: 'tools/call',
      params: {
        name: 'spawn_agent_new_tab',
        arguments: { cwd, prompt: 'hello' },
      },
    });

    expect(response.error).toBeUndefined();
    const result = response.result as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    if (result.isError) {
      throw new Error(`spawn_agent_new_tab failed: ${result.content[0]?.text ?? 'no text'}`);
    }
    expect(result.content[0].text).toContain('spawned');

    await expect
      .poll(async () =>
        appWindow.evaluate(async () => {
          const workspaces = await window.api.getWorkspaces();
          const w = workspaces.find((ws) => ws.branchName === 'mcp/seed-tab');
          return w ? w.terminals.length : -1;
        })
      )
      .toBe(baseline + 1);
  });
});
