import fs from 'fs';
import path from 'path';

import { test as base, expect, SANDBOX_DIR, seedDefaultProject } from './electron-app';

const test = base.extend({
  seedSandbox: async ({ cleanSandbox: _cleanSandbox }, provide) => {
    seedDefaultProject({ branchPrefix: 'http/' });
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

test.describe('HTTP API', () => {
  test('creates a workspace via POST /api/v1/workspace', async ({ appWindow }) => {
    const port = await readServerPort();

    const response = await fetch(`http://127.0.0.1:${port}/api/v1/workspace`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project: 'seed-repo',
        branchName: 'http/api-test',
      }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      success: boolean;
      workspace: { id: string; name: string; branchName?: string };
    };
    expect(body.success).toBe(true);
    expect(body.workspace.branchName).toBe('http/api-test');

    // Confirm the workspace is visible to the renderer (full round-trip).
    await expect
      .poll(async () =>
        appWindow.evaluate(async () => (await window.api.getWorkspaces()).map((w) => w.branchName))
      )
      .toContain('http/api-test');
  });

  test('returns 404 when project name is unknown', async ({ electronApp: _electronApp }) => {
    const port = await readServerPort();

    const response = await fetch(`http://127.0.0.1:${port}/api/v1/workspace`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project: 'does-not-exist',
        branchName: 'http/missing',
      }),
    });

    expect(response.status).toBe(404);
    const body = (await response.json()) as {
      error: string;
      availableProjects?: string[];
    };
    expect(body.error).toContain('does-not-exist');
    expect(body.availableProjects).toContain('seed-repo');
  });
});
