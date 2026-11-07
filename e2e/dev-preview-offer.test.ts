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

function sidebarCard(appWindow: Page, branch: string) {
  return appWindow
    .locator('.sidebar-surface .workspace-card-hover')
    .filter({ hasText: branch })
    .first();
}

test.describe('komla preview', () => {
  test.describe.configure({ timeout: 60_000 });

  // A project's remembered choice outlives the run in the Electron profile, and would open the
  // page without asking.
  test.beforeEach(async ({ appWindow }) => {
    const stored = await appWindow.evaluate(() =>
      localStorage.getItem('komla:browser-offer-targets')
    );
    if (stored === null) return;
    await appWindow.evaluate(() => localStorage.removeItem('komla:browser-offer-targets'));
    await appWindow.reload();
  });

  test('asks in the workspace where to open the page, opening nothing', async ({ appWindow }) => {
    const cwd = await createWorkspace(appWindow, 'preview-offer/one');
    const port = await readServerPort();
    const globeDot = appWindow
      .getByRole('button', { name: 'Open in default browser' })
      .locator('[data-offer-dot]');
    const ask = appWindow.getByRole('dialog', { name: 'Preview ready' });

    expect(await previewOverMcp(port, { cwd, url: 'http://localhost:5173/' })).toContain('offered');

    await expect(ask).toContainText('localhost:5173');
    await expect(ask.getByRole('button', { name: 'Open in browser' })).toBeVisible();
    await expect(globeDot).toBeVisible();
    // The workspace on screen asks in the callout, so its card needs no mark.
    await expect(
      sidebarCard(appWindow, 'preview-offer/one').locator('[data-offer-mark]')
    ).toHaveCount(0);
    await expect(appWindow.locator('.toast-enter')).toHaveCount(0);
    await expect(appWindow.locator('[data-browser-address]')).toHaveCount(0);

    // Typing to the agent, Escape included, leaves the question up.
    await appWindow.locator('.xterm').filter({ visible: true }).click();
    await appWindow.keyboard.press('Escape');
    await appWindow.keyboard.type('ls');
    await expect(ask).toBeVisible();
    await appWindow.screenshot({ path: test.info().outputPath('offer.png') });

    // An agent restarting its server on another port replaces the question.
    await previewOverMcp(port, { cwd, url: 'http://localhost:5174/' });
    await expect(ask).toHaveCount(1);
    await expect(ask).toContainText('localhost:5174');

    await ask.getByRole('button', { name: 'Open in Komla' }).click();
    await expect(appWindow.locator('[data-browser-address]')).toBeVisible();
    await expect(ask).toHaveCount(0);
    await expect(globeDot).toHaveCount(0);
  });

  test('waits for its own workspace instead of interrupting another', async ({ appWindow }) => {
    const cwd = await createWorkspace(appWindow, 'preview-offer/first');
    await createWorkspace(appWindow, 'preview-offer/second');
    const port = await readServerPort();
    const ask = appWindow.getByRole('dialog', { name: 'Preview ready' });
    const firstCard = sidebarCard(appWindow, 'preview-offer/first');

    await previewOverMcp(port, { cwd, url: 'http://localhost:5173/' });

    await expect(firstCard.locator('[data-offer-mark]')).toBeVisible();
    await expect(ask).toHaveCount(0);
    await expect(appWindow.locator('.toast-enter')).toHaveCount(0);

    await firstCard.click();
    await expect(ask).toContainText('localhost:5173');
    await expect(firstCard.locator('[data-offer-mark]')).toHaveCount(0);

    await ask.getByRole('button', { name: 'Dismiss' }).click();
    await expect(ask).toHaveCount(0);
    await expect(
      appWindow.getByRole('button', { name: 'Open in default browser' }).locator('[data-offer-dot]')
    ).toHaveCount(0);
  });

  test("opens the page in Komla's browser right away when asked to, clearing an offer", async ({
    appWindow,
  }) => {
    const cwd = await createWorkspace(appWindow, 'preview-offer/open');
    const port = await readServerPort();
    const globe = appWindow.getByRole('button', { name: 'Open in default browser' });
    const ask = appWindow.getByRole('dialog', { name: 'Preview ready' });

    await previewOverMcp(port, { cwd, url: 'http://localhost:5173/' });
    await expect(globe.locator('[data-offer-dot]')).toBeVisible();
    await expect(globe).toHaveAccessibleDescription('An agent offered a page');
    await expect(ask).toHaveCount(1);

    await previewOverMcp(port, { cwd, url: 'http://localhost:5173/', open: true });

    await expect(appWindow.locator('[data-browser-address]')).toBeVisible();
    // The page shows, so its offer no longer waits in a question or under the globe button.
    await expect(ask).toHaveCount(0);
    await expect(globe.locator('[data-offer-dot]')).toHaveCount(0);
  });
});
