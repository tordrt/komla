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
  <div id="links" class="k-row">
    <a id="web" class="k-link" href="https://example.com/pull/1">Pull request</a>
    <a id="script" class="k-link" href="javascript:document.body.dataset.ran = 'html'">Script</a>
    <svg width="16" height="16"><a id="svg" href="https://example.com/pull/2"><rect width="16" height="16" fill="currentColor"/></a></svg>
    <span id="shadow"></span>
    <a id="swap" class="k-link" href="data:text/html,<p id=swapped>Swapped</p>">Data</a>
  </div>
  <a id="anchor" class="k-link" href="#links">Back to the links</a>
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
// A link inside a web component's shadow root, as Lit or Shoelace render them.
const shadowLink = document.createElement('a');
shadowLink.id = 'in-shadow';
shadowLink.href = 'https://example.com/pull/3';
shadowLink.textContent = 'Shadow';
document.querySelector('#shadow').attachShadow({ mode: 'open' }).append(shadowLink);
document.body.dataset.ready = 'true';
`;

// A page in Komla's theme, as `komla skill integrations` describes, with a button that runs one of
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

// A plugin with code of its own, in TypeScript, which feeds its panel.
const PLUGIN_MAIN = `
import type { KomlaPlugin } from '@komla/sdk/plugin';

interface Hello { from: string; printed: string; workspaces: number }

export function activate(komla: KomlaPlugin) {
  console.log('code started');
  komla.panels.onOpen('code', async ({ workspace }) => {
    const printed = (await komla.exec('echo from-the-workspace', { workspace })).trim();
    const { workspaces } = await komla.workspace.list();
    komla.panels.post('code', { from: 'code', printed, workspaces: workspaces.length } satisfies Hello, { workspace });
  });
  komla.panels.onMessage('code', async (message, { activated }) => {
    // The page asks for a token while there is none, and the code keeps it in its settings.
    if (typeof message === 'object' && message !== null && 'signIn' in message) {
      if (!activated) throw new Error('Sign in from a click');
      await komla.settings.set({ token: String(message.signIn) });
      return { signedIn: Boolean(komla.settings.get('token')) };
    }
    return { echo: message, activated };
  });
}
`;

const PLUGIN_HTML = `<!doctype html>
<html><head><link rel="stylesheet" href="/__komla/komla.css"></head>
<body>
<p id="data">…</p>
<button id="ping" class="k-button">Ping</button>
<p id="reply"></p>
<div class="k-stack">
  <input id="token" class="k-input" type="password" placeholder="API token">
  <button id="sign-in" class="k-button k-primary">Sign in</button>
  <button id="open-settings" class="k-button">Open settings</button>
</div>
<p id="signed"></p>
<script>
komla.openSettings().then(
  () => { document.body.dataset.openAlone = 'ok'; },
  (error) => { document.body.dataset.openAlone = error.code; }
);
// The page can't submit a form, so a click sends what the user typed.
document.querySelector('#sign-in').addEventListener('click', async () => {
  const signed = document.querySelector('#signed');
  await komla.send({ signIn: document.querySelector('#token').value }).then(
    (reply) => { signed.textContent = JSON.stringify(reply); },
    (error) => { signed.textContent = error.code + ': ' + error.message; }
  );
});
document.querySelector('#open-settings').addEventListener('click', () => komla.openSettings());
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
        settings: [{ id: 'token', title: 'API token', type: 'secret' }],
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

type Page = import('@playwright/test').Page;

/** Moves the sidebar's edge with the arrow keys, ArrowRight to narrow it, as far as it goes. */
async function resizeSidebar(appWindow: Page, key: 'ArrowLeft' | 'ArrowRight') {
  await appWindow.getByRole('separator', { name: 'Resize file tree panel' }).focus();
  for (let press = 0; press < 60; press++) await appWindow.keyboard.press(key);
}

/** The sidebar's width, as its resize handle reports it. */
function sidebarWidth(appWindow: Page) {
  return appWindow
    .getByRole('separator', { name: 'Resize file tree panel' })
    .getAttribute('aria-valuenow');
}

/** The sidebar's tabs as the row shows them, by name. */
function sidebarTabNames(appWindow: Page) {
  return appWindow.locator('[data-sidebar-tab]').allTextContents();
}

test.describe('Sidebar panels', () => {
  test.skip(process.platform === 'win32', 'The panel runs POSIX shell commands');
  test.describe.configure({ timeout: 90_000 });

  test('shows a panel from the menu beside Diff and Files, runs its buttons, and gives the tree back', async ({
    appWindow,
  }) => {
    await createWorkspace(appWindow, 'sidebar-panels/checks');
    // At its narrowest the sidebar shows two tabs, Diff and Files, and the panels are in the
    // menu after them.
    await resizeSidebar(appWindow, 'ArrowRight');
    await expect.poll(() => sidebarTabNames(appWindow)).toEqual(['Diff', 'Files']);
    const narrowest = await sidebarWidth(appWindow);
    await appWindow.getByRole('button', { name: 'Sidebar tabs' }).click({ timeout: 20_000 });
    await appWindow.getByRole('menuitem', { name: 'Checks' }).click();
    // In the sidebar's tab row: the workspace, and so its terminal tab, is named Checks too.
    await expect(
      appWindow.getByTestId('file-panel-header').getByRole('button', { name: 'Checks', exact: true })
    ).toBeVisible();
    // A panel's tab, wider than Files, doesn't widen the sidebar.
    expect(await sidebarWidth(appWindow)).toBe(narrowest);

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

    // The other panel, from the menu at the end of the tabs.
    await appWindow.getByRole('button', { name: 'Sidebar tabs' }).click();
    if (SCREENSHOTS)
      await appWindow.screenshot({ path: path.join(SCREENSHOTS, 'sidebar-tabs-menu.png') });
    await appWindow.getByRole('menuitem', { name: 'Notes' }).click();
    const remember = appWindow
      .locator('[data-sidebar-panel="notes"]')
      .getByText('Remember', { exact: true });
    await expect(remember).toBeVisible({ timeout: 20_000 });
    await expect(remember).toHaveClass(/text-success/);
    expect(await sidebarWidth(appWindow)).toBe(narrowest);
    if (SCREENSHOTS) {
      await appWindow.screenshot({
        path: path.join(SCREENSHOTS, 'terminal-panel.png'),
      });
    }

    // Notes took the last tab's place while it shows, and left the order alone, so widened, the
    // sidebar shows Diff and Files first as before.
    await resizeSidebar(appWindow, 'ArrowLeft');
    await expect.poll(async () => (await sidebarTabNames(appWindow)).length).toBeGreaterThan(2);
    expect((await sidebarTabNames(appWindow)).slice(0, 2)).toEqual(['Diff', 'Files']);
    if (SCREENSHOTS)
      await appWindow.screenshot({ path: path.join(SCREENSHOTS, 'sidebar-tabs-wide.png') });

    // At the narrowest, dragging Notes in the menu to the top puts it first in the row.
    await resizeSidebar(appWindow, 'ArrowRight');
    await appWindow.getByRole('button', { name: 'Sidebar tabs' }).click();
    const views = appWindow.getByRole('menu', { name: 'Sidebar tabs' });
    await expect(views.getByRole('separator').first()).toHaveText("Doesn't fit");
    const firstView = views.getByRole('menuitem').first();
    await views
      .getByRole('menuitem', { name: 'Notes' })
      .dragTo(firstView, { targetPosition: { x: 8, y: 2 } });
    await expect(firstView).toHaveText('Notes');
    if (SCREENSHOTS)
      await appWindow.screenshot({ path: path.join(SCREENSHOTS, 'sidebar-tabs-menu-dragged.png') });
    await appWindow.keyboard.press('Escape');
    await expect.poll(() => sidebarTabNames(appWindow)).toEqual(['Notes', 'Diff']);

    // Right-clicking Notes puts another view in its place: the first one its submenu has.
    await appWindow.getByRole('button', { name: 'Notes', exact: true }).click({ button: 'right' });
    // From the keyboard: at the window's edge the submenu opens over the menu, where a pointer
    // on its way to an item would close it.
    await appWindow.getByRole('menuitem', { name: 'Replace Notes with' }).focus();
    await appWindow.keyboard.press('ArrowRight');
    const firstItem = appWindow.locator('[role="menuitem"]:focus');
    await expect(firstItem).toHaveCount(1);
    const replacement = (await firstItem.textContent())!;
    if (SCREENSHOTS)
      await appWindow.screenshot({ path: path.join(SCREENSHOTS, 'sidebar-tab-replace.png') });
    await appWindow.keyboard.press('Enter');
    await expect.poll(() => sidebarTabNames(appWindow)).toContain(replacement);
    await expect(appWindow.getByRole('button', { name: 'Notes', exact: true })).toHaveCount(0);

    // Widened, dragging the second tab onto the left half of the first moves it before that one.
    await resizeSidebar(appWindow, 'ArrowLeft');
    await expect.poll(async () => (await sidebarTabNames(appWindow)).length).toBeGreaterThan(2);
    const [first, second] = await sidebarTabNames(appWindow);
    const firstTab = appWindow.locator('[data-sidebar-tab]').first();
    const firstBox = (await firstTab.boundingBox())!;
    await appWindow
      .locator('[data-sidebar-tab]')
      .nth(1)
      .dragTo(firstTab, { targetPosition: { x: 4, y: firstBox.height / 2 } });
    await expect
      .poll(async () => (await sidebarTabNames(appWindow)).slice(0, 2))
      .toEqual([second, first]);
    if (SCREENSHOTS)
      await appWindow.screenshot({ path: path.join(SCREENSHOTS, 'sidebar-tabs-dragged.png') });

    // Files, from its tab or the menu, gives the tree back.
    const filesTab = appWindow.getByRole('button', { name: 'Files', exact: true });
    if (await filesTab.count()) await filesTab.click();
    else {
      await appWindow.getByRole('button', { name: 'Sidebar tabs' }).click();
      await appWindow.getByRole('menuitem', { name: 'Files', exact: true }).click();
    }
    await expect(appWindow.locator('[data-sidebar-panel]')).toHaveCount(0);
  });

  test('runs a page of its own that gets data and reaches Komla through komla', async ({
    appWindow,
  }) => {
    await createWorkspace(appWindow, 'sidebar-panels/board');
    await appWindow.getByRole('button', { name: 'Sidebar tabs' }).click({ timeout: 20_000 });
    await appWindow.getByRole('menuitem', { name: 'Board' }).click();

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

  test("opens a page's web links in the browser, SVG and shadow DOM ones too, and keeps others in the page", async ({
    appWindow,
    electronApp,
  }) => {
    await electronApp.evaluate(({ shell }) => {
      const opened: string[] = [];
      (globalThis as { e2eOpenedUrls?: string[] }).e2eOpenedUrls = opened;
      shell.openExternal = async (url: string) => {
        opened.push(url);
      };
    });
    const openedUrls = () =>
      electronApp.evaluate(() => (globalThis as { e2eOpenedUrls?: string[] }).e2eOpenedUrls);
    await createWorkspace(appWindow, 'sidebar-panels/links');
    await appWindow.getByRole('button', { name: 'Sidebar tabs' }).click({ timeout: 20_000 });
    await appWindow.getByRole('menuitem', { name: 'Board' }).click();
    const page = appWindow.locator('[data-sidebar-panel="board"]').frameLocator('iframe');
    await expect(page.locator('body')).toHaveAttribute('data-ready', 'true', {
      timeout: 20_000,
    });

    // Links in SVG and in a shadow root open as others do, and one to anything but the web stays
    // put rather than leaving an error page in the panel.
    await page.locator('#svg rect').click();
    await page.locator('#in-shadow').click();
    await page.locator('#script').click();
    await page.locator('#swap').click();
    await page.locator('#web').click();
    // The page's own links work as usual.
    await page.locator('#anchor').click();
    await expect.poll(() => page.locator('body').evaluate(() => location.hash)).toBe('#links');

    await expect
      .poll(openedUrls)
      .toEqual([
        'https://example.com/pull/2',
        'https://example.com/pull/3',
        'https://example.com/pull/1',
      ]);
    await expect(page.locator('#count')).toBeVisible();
    await expect(page.locator('body')).not.toHaveAttribute('data-ran');
    if (SCREENSHOTS)
      await appWindow.screenshot({
        path: path.join(SCREENSHOTS, 'page-links.png'),
      });
  });

  test("runs a plugin's code, which feeds its panel and answers its page", async ({
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

    await page.locator('#ping').click();
    await expect(page.locator('#reply')).toHaveText(
      JSON.stringify({ echo: { ping: 1 }, activated: true }),
      { timeout: 15_000 }
    );
    if (SCREENSHOTS)
      await appWindow.screenshot({ path: path.join(SCREENSHOTS, 'plugin-code-panel.png') });
  });

  test("lets a plugin's page sign in with a token its code keeps, or open its settings", async ({
    appWindow,
  }) => {
    await createWorkspace(appWindow, 'sidebar-panels/sign-in');
    await appWindow.getByRole('button', { name: 'Files', exact: true }).click({ timeout: 20_000 });
    await appWindow
      .getByRole('button', { name: 'Code panel, opens its panel in the sidebar' })
      .click({ timeout: 30_000 });
    const page = appWindow.locator('[data-sidebar-panel="coded.code"]').frameLocator('iframe');
    // Without a click, a page can't open Settings.
    await expect(page.locator('body')).toHaveAttribute('data-open-alone', 'NEEDS_USER_ACTION', {
      timeout: 30_000,
    });

    await page.locator('#token').fill('tok_from_page');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.locator('#signed')).toHaveText(JSON.stringify({ signedIn: true }), {
      timeout: 15_000,
    });

    // Settings opens at the plugin, which knows only that its token is set.
    await page.getByRole('button', { name: 'Open settings' }).click();
    const row = appWindow.locator('[data-plugin="coded"]');
    await expect(row).toBeInViewport({ timeout: 15_000 });
    await expect(row.getByLabel('API token')).toHaveAttribute(
      'placeholder',
      'Set. Type a new one to replace it'
    );
    if (SCREENSHOTS)
      await row.screenshot({ path: path.join(SCREENSHOTS, 'plugin-open-settings.png') });
    const listed = await appWindow.evaluate(async () =>
      JSON.stringify(await window.api.listPlugins())
    );
    expect(listed).not.toContain('tok_from_page');
  });
});
