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

// In stateless mode (Komla uses sessionIdGenerator: undefined), the transport
// skips session validation entirely — calls work without a prior initialize.
// The transport responds via SSE: each `data:` line carries one JSON-RPC response.
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

test.describe('MCP JSON-RPC', () => {
  test.describe.configure({ timeout: 90_000 });

  test('tools/list exposes the Komla spawn/title tools', async ({ appWindow: _appWindow }) => {
    const port = await readServerPort();

    const response = await mcpCall(port, { id: 1, method: 'tools/list' });

    expect(response.error).toBeUndefined();
    const result = response.result as { tools: Array<{ name: string }> };
    const names = result.tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'spawn_agent_in_new_workspace',
        'set_workspace_title',
        'spawn_agent_new_tab',
      ])
    );
  });

  test('tools/call spawn_agent_in_new_workspace creates a workspace', async ({ appWindow }) => {
    const port = await readServerPort();

    // The MCP tool resolves the project by finding an existing workspace at `cwd`
    // (the realistic flow: an agent already running inside workspace A spawns
    // workspace B). So seed a workspace first and use its workingDirectory.
    const seedWorkspace = await appWindow.evaluate(async () =>
      window.api.createWorkspace({
        mode: 'worktree',
        projectId: 'e2e-project',
        branchName: 'mcp/seed',
      })
    );
    expect(seedWorkspace).not.toHaveProperty('__workspaceCreateError');
    const seedCwd = (seedWorkspace as { workingDirectory: string }).workingDirectory;
    expect(seedCwd).toBeTruthy();

    const response = await mcpCall(port, {
      id: 2,
      method: 'tools/call',
      params: {
        name: 'spawn_agent_in_new_workspace',
        arguments: {
          cwd: seedCwd,
          branchName: 'mcp/spawned',
        },
      },
    });

    expect(response.error).toBeUndefined();
    const result = response.result as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    if (result.isError) {
      throw new Error(`MCP spawn failed: ${result.content[0]?.text ?? 'no text'}`);
    }
    expect(result.content[0].text).toContain('mcp/spawned');

    // Round-trip: the new workspace should appear alongside the seed AND finish
    // provisioning. The MCP path forces deferBranchNaming, so the placeholder
    // shows up immediately with the correct branchName — we have to wait for the
    // background worktree creation to land (provisioning cleared, no
    // provisionError) to know the spawn actually succeeded end-to-end.
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
          expect.objectContaining({ branchName: 'mcp/seed' }),
          { branchName: 'mcp/spawned', provisioning: false, provisionError: null },
        ])
      );
  });
});
