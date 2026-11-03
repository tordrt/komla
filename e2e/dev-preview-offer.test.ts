import fs from 'fs';
import path from 'path';

import { test as base, expect, SANDBOX_DIR, seedDefaultProject } from './electron-app';

import type { Page } from '@playwright/test';

const test = base.extend({
  seedSandbox: async ({ cleanSandbox: _cleanSandbox }, provide) => {
    seedDefaultProject({ branchPrefix: 'preview-offer/' });
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

/** Calls the MCP tool `komla preview` shares its operation with, and returns its text. */
async function previewOverMcp(port: number, args: Record<string, unknown>): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'open_browser_preview', arguments: args },
    }),
  });
  const data = (await response.text()).split('\n').find((line) => line.startsWith('data:'));
  const result = JSON.parse(data!.slice(5)).result as {
    content: Array<{ text: string }>;
    isError?: boolean;
  };
  if (result.isError) throw new Error(result.content[0]?.text);
  return result.content[0].text;
}

async function createWorkspace(appWindow: Page, branch: string): Promise<string> {
  await expect(appWindow.getByRole('button', { name: 'New Workspace' }).first()).toBeVisible({
    timeout: 15_000,
  });
  await appWindow.getByRole('button', { name: 'New Workspace' }).first().click();
  const dialog = appWindow.getByRole('dialog', { name: 'Create Workspace' });
  await dialog.locator('input[placeholder$="swift-fox"]').fill(branch);
  await dialog.getByRole('button', { name: /^(Launch|Create)/ }).click();
  await expect(appWindow.locator('.xterm').filter({ visible: true })).toHaveCount(1, {
    timeout: 10_000,
  });
  return appWindow.evaluate(
    async (name) =>
      (await window.api.getWorkspaces()).find((w) => w.branchName === name)!.workingDirectory,
    branch
  );
}

test.describe('komla preview', () => {
  test.describe.configure({ timeout: 60_000 });

  test('offers the page with a toast and a dot on the globe button, opening nothing', async ({
    appWindow,
  }) => {
    const cwd = await createWorkspace(appWindow, 'preview-offer/one');
    const port = await readServerPort();
    const globeDot = appWindow
      .getByRole('button', { name: 'Open in default browser' })
      .locator('[data-offer-dot]');

    expect(await previewOverMcp(port, { cwd, url: 'http://localhost:5173/' })).toContain('offered');

    const toast = appWindow.locator('.toast-enter').filter({ hasText: 'Preview ready' });
    await expect(toast).toHaveText(/Preview ready: localhost:5173/);
    await expect(toast.getByRole('button', { name: 'Open in browser' })).toBeVisible();
    await expect(globeDot).toBeVisible();
    await expect(appWindow.locator('[data-browser-address]')).toHaveCount(0);
    await appWindow.screenshot({ path: test.info().outputPath('offer.png') });

    // An agent restarting its server on another port replaces the toast.
    await previewOverMcp(port, { cwd, url: 'http://localhost:5174/' });
    await expect(toast).toHaveCount(1);
    await expect(toast).toHaveText(/localhost:5174/);

    await toast.getByRole('button', { name: 'Open in Komla' }).click();
    await expect(appWindow.locator('[data-browser-address]')).toBeVisible();
    await expect(globeDot).toHaveCount(0);
  });

  test("opens the page in Komla's browser right away when asked to, clearing an offer", async ({
    appWindow,
  }) => {
    const cwd = await createWorkspace(appWindow, 'preview-offer/open');
    const port = await readServerPort();
    const globe = appWindow.getByRole('button', { name: 'Open in default browser' });
    const toast = appWindow.locator('.toast-enter').filter({ hasText: 'Preview ready' });

    await previewOverMcp(port, { cwd, url: 'http://localhost:5173/' });
    await expect(globe.locator('[data-offer-dot]')).toBeVisible();
    await expect(globe).toHaveAccessibleDescription('An agent offered a page');
    await expect(toast).toHaveCount(1);

    await previewOverMcp(port, { cwd, url: 'http://localhost:5173/', open: true });

    await expect(appWindow.locator('[data-browser-address]')).toBeVisible();
    // Well before the toast would time out on its own.
    await expect(toast).toHaveCount(0, { timeout: 2_000 });
    // The page shows, so its offer no longer waits in a toast or under the globe button.
    await expect(globe.locator('[data-offer-dot]')).toHaveCount(0);
  });
});
