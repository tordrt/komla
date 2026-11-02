import fs from 'node:fs';
import path from 'node:path';

import { test as base, expect, SANDBOX_DIR, seedDefaultProject } from './electron-app';

const SCREENSHOTS = process.env.SIDEBAR_PANELS_SCREENSHOT_DIR;
const OUTPUT = path.join(SANDBOX_DIR, 'checks-panel.json');

// A page in Komla's theme, as `komla skill status-items` describes, with a button that runs one of
// the panel's commands.
const PAGE = `<style>
  .row { display: flex; gap: 8px; padding: 4px 0; border-bottom: 1px solid var(--border) }
  .row > :nth-child(2) { flex: 1 }
  .pass { color: var(--success) } .fail { color: var(--error) }
  .muted { color: var(--muted-foreground) }
</style>
<div class="row"><span class="pass">\uf00c</span><span>Unit tests</span><span class="muted">2m</span></div>
<div class="row"><span class="pass">\uf00c</span><span>Lint</span><span class="muted">40s</span></div>
<div class="row"><span class="fail">\uf00d</span><span id="e2e">End-to-end</span><span class="muted">6m</span></div>`;

const test = base.extend({
  seedSandbox: async ({ cleanSandbox: _cleanSandbox }, provide) => {
    seedDefaultProject({ branchPrefix: 'sidebar-panels/' });
    fs.writeFileSync(
      OUTPUT,
      JSON.stringify({ html: PAGE, buttons: [{ label: 'Rerun failed', run: 'rerun' }] })
    );
    const settings = path.join(SANDBOX_DIR, 'settings');
    fs.mkdirSync(settings, { recursive: true });
    fs.writeFileSync(
      path.join(settings, 'sidebar-panels.json'),
      JSON.stringify({
        _version: 1,
        panels: [
          {
            id: 'checks',
            title: 'Checks',
            command: `cat "${OUTPUT}"`,
            commands: {
              rerun: `echo $(( $(cat "${SANDBOX_DIR}/reruns" 2>/dev/null || echo 0) + 1 )) > "${SANDBOX_DIR}/reruns"`,
            },
          },
          { id: 'notes', title: 'Notes', command: "printf '**Remember** the changelog'" },
        ],
      })
    );
    await provide();
  },
});

test.describe('Sidebar panels', () => {
  test.skip(process.platform === 'win32', 'The panel runs POSIX shell commands');
  test.describe.configure({ timeout: 90_000 });

  test('shows a panel beside Diff and Files, runs its buttons, and gives the tree back', async ({
    appWindow,
  }) => {
    await appWindow.getByRole('button', { name: 'New Workspace' }).first().click({
      timeout: 15_000,
    });
    const dialog = appWindow.getByRole('dialog', { name: 'Create Workspace' });
    await dialog.locator('input[placeholder$="swift-fox"]').fill('sidebar-panels/checks');
    await dialog.getByRole('button', { name: /^(Launch|Create)/ }).click();

    // New workspaces start with the file panel closed.
    await appWindow.getByRole('button', { name: 'Toggle file panel' }).click({ timeout: 20_000 });
    const tab = appWindow.getByRole('button', { name: 'Checks', exact: true });
    await tab.click({ timeout: 20_000 });

    const panel = appWindow.locator('[data-sidebar-panel="checks"]');
    const page = panel.frameLocator('iframe');
    await expect(page.locator('#e2e')).toHaveText('End-to-end', { timeout: 20_000 });
    // The page fills the panel rather than growing to its content.
    const frameBox = await panel.locator('iframe').boundingBox();
    const panelBox = await panel.boundingBox();
    expect(frameBox!.height).toBeGreaterThan(panelBox!.height - 120);
    if (SCREENSHOTS) await appWindow.screenshot({ path: path.join(SCREENSHOTS, 'html-panel.png') });

    await panel.getByRole('button', { name: 'Rerun failed' }).click();
    const reruns = path.join(SANDBOX_DIR, 'reruns');
    await expect
      .poll(() => (fs.existsSync(reruns) ? fs.readFileSync(reruns, 'utf8').trim() : ''), {
        timeout: 15_000,
      })
      .toBe('1');

    // The other panel, from the tab's menu.
    await appWindow.getByRole('button', { name: 'Sidebar panels' }).click();
    await appWindow.getByRole('menuitemradio', { name: 'Notes' }).click();
    await expect(
      appWindow.locator('[data-sidebar-panel="notes"]').getByText('Remember')
    ).toBeVisible({
      timeout: 20_000,
    });
    if (SCREENSHOTS) {
      await appWindow.screenshot({ path: path.join(SCREENSHOTS, 'markdown-panel.png') });
    }

    // Files brings the tree back; the panel's tab keeps the panel picked last.
    await appWindow.getByRole('button', { name: 'Files', exact: true }).click();
    await expect(appWindow.locator('[data-sidebar-panel]')).toHaveCount(0);
    await expect(appWindow.getByRole('button', { name: 'Notes', exact: true })).toBeVisible();
  });
});
