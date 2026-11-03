import fs from 'fs';
import path from 'path';

import {
  test as base,
  expect,
  launchApp,
  SANDBOX_DIR,
  seedDefaultProject,
  type Page,
} from './electron-app';

const test = base.extend({
  seedSandbox: async ({ cleanSandbox: _cleanSandbox }, provide) => {
    seedDefaultProject({ branchPrefix: 'restore/' });
    await provide();
  },
});

const SCREENSHOT_DIR = process.env.KOMLA_E2E_SCREENSHOT_DIR;

async function waitForMainUi(window: Page): Promise<void> {
  await expect(window.getByRole('button', { name: 'New Workspace' }).first()).toBeVisible({
    timeout: 15_000,
  });
}

async function createFolderWorkspace(window: Page, name: string): Promise<string> {
  const dir = path.join(SANDBOX_DIR, name);
  fs.mkdirSync(dir, { recursive: true });
  const result = await window.evaluate(
    async ({ directoryPath, customName }) =>
      window.api.createWorkspace({ mode: 'directory', directoryPath, customName }),
    { directoryPath: dir, customName: name }
  );
  expect(result).not.toHaveProperty('__workspaceCreateError', true);
  return (result as { id: string }).id;
}

/** Ids of the workspaces with a running terminal, as main sees them. */
function runningWorkspaceIds(window: Page): Promise<string[]> {
  return window.evaluate(async () =>
    (await window.api.getWorkspaces())
      .filter((w) => w.terminals.some((t) => t.status === 'running'))
      .map((w) => w.id)
  );
}

test.describe('Workspaces running at the last quit', () => {
  test.describe.configure({ timeout: 120_000 });

  test('are offered for restart at the next launch, and restart', async ({
    seedSandbox: _seedSandbox,
  }) => {
    let running: string[];
    let stopped: string;
    {
      const { app, window } = await launchApp();
      try {
        await waitForMainUi(window);
        running = [
          await createFolderWorkspace(window, 'api-server'),
          await createFolderWorkspace(window, 'web-client'),
        ];
        stopped = await createFolderWorkspace(window, 'docs-site');
        await window.evaluate((id) => window.api.stopWorkspace(id), stopped);
        await expect
          .poll(() => runningWorkspaceIds(window))
          .toEqual(expect.arrayContaining(running));
        expect(await runningWorkspaceIds(window)).not.toContain(stopped);
      } finally {
        await app.close();
      }
    }

    const saved = JSON.parse(
      fs.readFileSync(path.join(SANDBOX_DIR, 'workspaces.json'), 'utf8')
    ) as Array<{ id: string; runningAtQuit?: boolean }>;
    expect(saved.filter((w) => w.runningAtQuit).map((w) => w.id)).toEqual(
      expect.arrayContaining(running)
    );
    expect(saved.find((w) => w.id === stopped)?.runningAtQuit).toBeUndefined();

    {
      const { app, window } = await launchApp();
      try {
        await waitForMainUi(window);
        expect(await runningWorkspaceIds(window)).toEqual([]);
        const banner = window.getByText('2 workspaces were running when Komla quit.');
        await expect(banner).toBeVisible({ timeout: 15_000 });
        // In the workspaces' saved order, where the newest comes first.
        await expect(window.getByText('web-client, api-server')).toBeVisible();
        if (SCREENSHOT_DIR) {
          await window.screenshot({ path: path.join(SCREENSHOT_DIR, 'offer.png') });
        }

        await window.getByRole('button', { name: 'Restart all' }).click();
        await expect(banner).toBeHidden();
        await expect
          .poll(() => runningWorkspaceIds(window), { timeout: 30_000 })
          .toEqual(expect.arrayContaining(running));
        expect(await runningWorkspaceIds(window)).not.toContain(stopped);
        if (SCREENSHOT_DIR) {
          await window.screenshot({ path: path.join(SCREENSHOT_DIR, 'restarted.png') });
        }
      } finally {
        await app.close();
      }
    }
  });
});
