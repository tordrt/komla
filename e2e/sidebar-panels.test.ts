import fs from 'node:fs';
import path from 'node:path';

import { test as base, expect, SANDBOX_DIR, seedDefaultProject } from './electron-app';

const SCREENSHOTS = process.env.SIDEBAR_PANELS_SCREENSHOT_DIR;
const OUTPUT = path.join(SANDBOX_DIR, 'checks-panel.json');
const COUNT = path.join(SANDBOX_DIR, 'board-count');

// A panel's own page, as a built app would be: HTML that loads a module script and Komla's
// stylesheet from its folder, gets its command's output as data, and calls Komla through `komla`.
const BOARD_HTML = `<!doctype html>
<html>
<head>
<link rel="stylesheet" href="/__komla/komla.css">
<script type="module" src="./app.js"></script>
</head>
<body>
<div class="k-stack">
  <div class="k-row"><span id="count" class="k-badge k-success">…</span></div>
  <ul id="workspaces" class="k-list"></ul>
  <button id="bump" class="k-button k-primary">Bump</button>
  <button id="title" class="k-button">Set title</button>
</div>
</body>
</html>`;

const BOARD_SCRIPT = `
const count = document.querySelector('#count');
komla.onData((data) => { count.textContent = 'Count ' + data.count; });
const { workspaces } = await komla.call({ type: 'workspace.list' });
document.querySelector('#workspaces').innerHTML = workspaces
  .map((workspace) => '<li class="k-item">' + workspace.name + '</li>')
  .join('');
// Without a click, a page can't run a command or open a folder, and nothing it didn't declare.
const outcome = (promise) => promise.then(() => 'ok', (error) => error.code);
document.body.dataset.runAlone = await outcome(komla.run('bump'));
document.body.dataset.openAlone = await outcome(komla.call({ type: 'folder.open', path: '/' }));
document.body.dataset.snooze = await outcome(komla.call({ type: 'workspace.snooze', until: '1h' }));
document.querySelector('#bump').addEventListener('click', () => komla.run('bump'));
document.querySelector('#title').addEventListener('click', () =>
  komla.call({ type: 'workspace.title', title: 'Titled by a panel' })
);
document.body.dataset.ready = 'true';
`;

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

// A plugin with code of its own, in TypeScript, which feeds its panel and badges its tab.
const PLUGIN_MAIN = `
import type { KomlaPlugin } from '@komla/sdk/plugin';

interface Hello { from: string; printed: string; workspaces: number }

export function activate(komla: KomlaPlugin) {
  console.log('code started');
  komla.panels.onOpen('code', async ({ workspace }) => {
    const printed = (await komla.exec('echo from-the-workspace', { workspace })).trim();
    const { workspaces } = await komla.workspace.list();
    komla.panels.post('code', { from: 'code', printed, workspaces: workspaces.length } satisfies Hello, { workspace });
    komla.panels.setBadge('code', { text: 2, tone: 'warning' }, { workspace });
  });
  komla.panels.onMessage('code', (message, { activated }) => ({ echo: message, activated }));
}
`;

const PLUGIN_HTML = `<!doctype html>
<html><head><link rel="stylesheet" href="/__komla/komla.css"></head>
<body>
<p id="data">…</p>
<button id="ping" class="k-button">Ping</button>
<p id="reply"></p>
<script>
komla.onData((data) => { document.querySelector('#data').textContent = JSON.stringify(data); });
document.querySelector('#ping').addEventListener('click', async () => {
  const reply = await komla.send({ ping: 1 });
  document.querySelector('#reply').textContent = JSON.stringify(reply);
});
</script>
</body></html>`;

const test = base.extend({
  seedSandbox: async ({ cleanSandbox: _cleanSandbox }, provide) => {
    seedDefaultProject({ branchPrefix: 'sidebar-panels/' });
    fs.writeFileSync(
      OUTPUT,
      JSON.stringify({
        html: PAGE,
        buttons: [{ label: 'Rerun failed', run: 'rerun' }],
      })
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
          {
            id: 'notes',
            title: 'Notes',
            // Text for a terminal, with its colors.
            command: "printf '\\033[32mRemember\\033[0m the changelog'",
          },
          {
            id: 'board',
            title: 'Board',
            page: 'panels/board',
            command: `printf '{"count": %s}' "$(cat "${COUNT}" 2>/dev/null || echo 0)"`,
            commands: {
              bump: `echo $(( $(cat "${COUNT}" 2>/dev/null || echo 0) + 1 )) > "${COUNT}"`,
            },
            capabilities: ['workspace.title', 'folder.open'],
          },
        ],
      })
    );
    const board = path.join(settings, 'panels', 'board');
    fs.mkdirSync(board, { recursive: true });
    fs.writeFileSync(path.join(board, 'index.html'), BOARD_HTML);
    fs.writeFileSync(path.join(board, 'app.js'), BOARD_SCRIPT);

    const plugin = path.join(SANDBOX_DIR, 'plugins', 'coded');
    fs.mkdirSync(path.join(plugin, 'panels', 'code'), { recursive: true });
    fs.writeFileSync(
      path.join(plugin, 'komla-plugin.json'),
      JSON.stringify({
        id: 'coded',
        name: 'Coded',
        main: 'main.ts',
        contributes: {
          sidebarPanels: [{ id: 'code', title: 'Code', page: 'panels/code' }],
          statusItems: [{ id: 'open', command: 'echo Code panel', panel: 'code' }],
        },
      })
    );
    fs.writeFileSync(path.join(plugin, 'main.ts'), PLUGIN_MAIN);
    fs.writeFileSync(path.join(plugin, 'panels', 'code', 'index.html'), PLUGIN_HTML);
    // In development, it runs as its files are, without the digest Settings would approve.
    fs.writeFileSync(
      path.join(settings, 'plugins.json'),
      JSON.stringify({
        _version: 1,
        enabled: [{ id: 'coded', digest: '0'.repeat(64), development: true }],
      })
    );
    await provide();
  },
});

async function createWorkspace(appWindow: import('@playwright/test').Page, branch: string) {
  await appWindow.getByRole('button', { name: 'New Workspace' }).first().click({
    timeout: 15_000,
  });
  const dialog = appWindow.getByRole('dialog', { name: 'Create Workspace' });
  await dialog.locator('input[placeholder$="swift-fox"]').fill(branch);
  await dialog.getByRole('button', { name: /^(Launch|Create)/ }).click();
  // New workspaces start with the file panel closed.
  await appWindow.getByRole('button', { name: 'Toggle file panel' }).click({ timeout: 20_000 });
}

test.describe('Sidebar panels', () => {
  test.skip(process.platform === 'win32', 'The panel runs POSIX shell commands');
  test.describe.configure({ timeout: 90_000 });

  test('shows a panel beside Diff and Files, runs its buttons, and gives the tree back', async ({
    appWindow,
  }) => {
    await createWorkspace(appWindow, 'sidebar-panels/checks');
    const tab = appWindow.getByRole('button', { name: 'Checks', exact: true });
    await tab.click({ timeout: 20_000 });

    const panel = appWindow.locator('[data-sidebar-panel="checks"]');
    const page = panel.frameLocator('iframe');
    await expect(page.locator('#e2e')).toHaveText('End-to-end', {
      timeout: 20_000,
    });
    // The page fills the panel rather than growing to its content.
    const frameBox = await panel.locator('iframe').boundingBox();
    const panelBox = await panel.boundingBox();
    expect(frameBox!.height).toBeGreaterThan(panelBox!.height - 120);
    if (SCREENSHOTS)
      await appWindow.screenshot({
        path: path.join(SCREENSHOTS, 'html-panel.png'),
      });

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
    const remember = appWindow
      .locator('[data-sidebar-panel="notes"]')
      .getByText('Remember', { exact: true });
    await expect(remember).toBeVisible({ timeout: 20_000 });
    await expect(remember).toHaveClass(/text-success/);
    if (SCREENSHOTS) {
      await appWindow.screenshot({
        path: path.join(SCREENSHOTS, 'terminal-panel.png'),
      });
    }

    // Files brings the tree back; the panel's tab keeps the panel picked last.
    await appWindow.getByRole('button', { name: 'Files', exact: true }).click();
    await expect(appWindow.locator('[data-sidebar-panel]')).toHaveCount(0);
    await expect(appWindow.getByRole('button', { name: 'Notes', exact: true })).toBeVisible();
  });

  test('runs a page of its own that gets data and reaches Komla through komla', async ({
    appWindow,
  }) => {
    await createWorkspace(appWindow, 'sidebar-panels/board');
    await appWindow.getByRole('button', { name: 'Sidebar panels' }).click({ timeout: 20_000 });
    await appWindow.getByRole('menuitemradio', { name: 'Board' }).click();

    const page = appWindow.locator('[data-sidebar-panel="board"]').frameLocator('iframe');
    await expect(page.locator('body')).toHaveAttribute('data-ready', 'true', {
      timeout: 20_000,
    });
    await expect(page.locator('#count')).toHaveText('Count 0');
    await expect(page.locator('#workspaces .k-item')).toHaveText(['Board']);
    await expect(page.locator('body')).toHaveAttribute('data-run-alone', 'NEEDS_USER_ACTION');
    await expect(page.locator('body')).toHaveAttribute('data-open-alone', 'NEEDS_USER_ACTION');
    await expect(page.locator('body')).toHaveAttribute('data-snooze', 'CAPABILITY_NOT_DECLARED');
    // Komla's stylesheet styles the page in the window's theme.
    const radius = await page
      .locator('#bump')
      .evaluate((button) => getComputedStyle(button).borderRadius);
    expect(radius).toBe('6px');

    // A click runs one of its commands, and the data that comes after shows it.
    await page.locator('#bump').click();
    await expect(page.locator('#count')).toHaveText('Count 1', {
      timeout: 15_000,
    });
    await page.locator('#title').click();
    await expect
      .poll(
        async () =>
          appWindow.evaluate(async () => (await window.api.getWorkspaces())[0].customName),
        {
          timeout: 15_000,
        }
      )
      .toBe('Titled by a panel');
    if (SCREENSHOTS)
      await appWindow.screenshot({
        path: path.join(SCREENSHOTS, 'page-panel.png'),
      });
  });

  test("runs a plugin's code, which feeds its panel, badges its tab and answers its page", async ({
    appWindow,
  }) => {
    await createWorkspace(appWindow, 'sidebar-panels/code');
    await appWindow.getByRole('button', { name: 'Files', exact: true }).click({ timeout: 20_000 });
    // The plugin's status item opens its panel.
    await appWindow
      .getByRole('button', { name: 'Code panel, opens its panel in the sidebar' })
      .click({ timeout: 30_000 });

    const page = appWindow.locator('[data-sidebar-panel="coded.code"]').frameLocator('iframe');
    await expect(page.locator('#data')).toHaveText(
      JSON.stringify({ from: 'code', printed: 'from-the-workspace', workspaces: 1 }),
      { timeout: 30_000 }
    );
    await expect(appWindow.locator('[data-sidebar-panel-badge="coded.code"]').first()).toHaveText(
      '2'
    );

    await page.locator('#ping').click();
    await expect(page.locator('#reply')).toHaveText(
      JSON.stringify({ echo: { ping: 1 }, activated: true }),
      { timeout: 15_000 }
    );
    if (SCREENSHOTS)
      await appWindow.screenshot({ path: path.join(SCREENSHOTS, 'plugin-code-panel.png') });
  });
});
