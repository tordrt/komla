import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { test as base, expect, SANDBOX_DIR, seedDefaultProject } from './electron-app';

import type { Page } from '@playwright/test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = process.env.KOMLA_E2E_SCREENSHOT_DIR;

function seedSetupSteps(setupSteps: unknown[]) {
  seedDefaultProject({ branchPrefix: 'setup-panes/' });
  const file = path.join(SANDBOX_DIR, 'settings', 'projects.json');
  const projects = JSON.parse(fs.readFileSync(file, 'utf8'));
  projects.projects[0].setupSteps = setupSteps;
  fs.writeFileSync(file, JSON.stringify(projects));
}

const browserStep = (urls: string[]) => ({
  id: 'browser',
  name: 'App',
  command: '',
  placement: 'split-right',
  kind: 'browser',
  urls,
});

// The project's Workspace Setup opens a browser beside the agent and a note in a tab of its own.
const test = base.extend({
  seedSandbox: async ({ cleanSandbox: _cleanSandbox }, provide) => {
    seedSetupSteps([
      browserStep([]),
      { id: 'note', name: 'Note', command: '', placement: 'tab', kind: 'note' },
    ]);
    await provide();
  },
});

// The browser opens two pages as the workspace is created, and the tabs it had after that.
const restartTest = base.extend({
  seedSandbox: async ({ cleanSandbox: _cleanSandbox }, provide) => {
    seedSetupSteps([browserStep(['http://localhost:4321/first', 'http://localhost:4321/second'])]);
    await provide();
  },
});

// A browser beside the agent and a note below it, as the workspace is created.
const stopTest = base.extend({
  seedSandbox: async ({ cleanSandbox: _cleanSandbox }, provide) => {
    seedSetupSteps([
      browserStep(['http://localhost:4321/first']),
      { id: 'note', name: 'Note', command: '', placement: 'split-bottom', kind: 'note' },
    ]);
    await provide();
  },
});

// A dev server that learns its page only once it runs shows it with `komla preview --open`.
// An unpackaged app finds no CLI to install, so its terminals get the one `npm run build:native`
// built for this computer, when there is one.
const BUILT_CLI = path.join(
  __dirname,
  '..',
  'native',
  'artifacts',
  `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-unknown-linux-musl`,
  'komla'
);
const cliUrlTest = base.extend({
  seedSandbox: async ({ cleanSandbox: _cleanSandbox }, provide) => {
    seedSetupSteps([
      browserStep([]),
      {
        id: 'server',
        name: 'Server',
        command: 'komla preview --open http://localhost:4321/admin',
        placement: 'background',
        trigger: 'every-workspace-start',
      },
    ]);
    const previous = process.env.KOMLA_CLI;
    process.env.KOMLA_CLI = BUILT_CLI;
    await provide();
    if (previous === undefined) delete process.env.KOMLA_CLI;
    else process.env.KOMLA_CLI = previous;
  },
});

async function createWorkspace(appWindow: Page, branch: string) {
  await expect(appWindow.getByRole('button', { name: 'New Workspace' }).first()).toBeVisible({
    timeout: 15_000,
  });
  await appWindow.getByRole('button', { name: 'New Workspace' }).first().click();
  const dialog = appWindow.getByRole('dialog', { name: 'Create Workspace' });
  await dialog.locator('input[placeholder$="swift-fox"]').fill(branch);
  await dialog.getByRole('button', { name: /^(Launch|Create)/ }).click();
}

async function screenshot(appWindow: Page, name: string) {
  if (SCREENSHOT_DIR) await appWindow.screenshot({ path: path.join(SCREENSHOT_DIR, name) });
}

test.describe('Workspace Setup panes', () => {
  test.describe.configure({ timeout: 90_000 });

  test('opens a browser beside the agent and a blank note in a tab of its own', async ({
    appWindow,
  }) => {
    await createWorkspace(appWindow, 'setup-panes/new');

    const browser = appWindow.locator('[data-pane-surface="browser"]').filter({ visible: true });
    await expect(browser).toHaveCount(1, { timeout: 15_000 });
    await expect(appWindow.locator('.xterm').filter({ visible: true })).toHaveCount(1);
    await screenshot(appWindow, 'setup-panes-layout.png');

    // The note waits in the next tab, kept with the workspace's notes.
    await appWindow.getByRole('button', { name: 'Untitled note' }).first().click();
    await expect(
      appWindow.locator('[data-pane-surface="note"]').filter({ visible: true })
    ).toHaveCount(1, { timeout: 10_000 });
    await screenshot(appWindow, 'setup-panes-note.png');
  });

  test('lists browser and note steps in the Workspace Setup editor', async ({ appWindow }) => {
    await createWorkspace(appWindow, 'setup-panes/editor');
    await appWindow
      .getByRole('button', { name: 'seed-repo', exact: true })
      .click({ button: 'right' });
    await appWindow.getByRole('menuitem', { name: 'Workspace Setup' }).click();

    const app = appWindow.getByRole('article', { name: 'Setup step App' });
    await expect(app.getByPlaceholder('http://localhost:3000')).toBeVisible({ timeout: 10_000 });
    await expect(appWindow.getByRole('article', { name: 'Setup step Note' })).toContainText(
      'A blank note'
    );
    await expect(app.getByRole('combobox', { name: 'Kind for App' })).toHaveValue('browser');
    await expect(appWindow.getByRole('button', { name: 'Add browser' })).toBeVisible();
    await screenshot(appWindow, 'setup-panes-editor.png');
  });
});

/** The address of the one browser on screen, which sits beside the agent's terminal. */
async function expectBrowserBesideAgentAt(appWindow: Page, url: string) {
  const browser = appWindow.locator('[data-pane-surface="browser"]').filter({ visible: true });
  await expect(browser).toHaveCount(1, { timeout: 15_000 });
  await expect(appWindow.locator('.xterm').filter({ visible: true })).toHaveCount(1);
  await expect(browser.locator('[data-browser-address]')).toHaveValue(url, { timeout: 15_000 });
}

cliUrlTest(
  'shows a page a step opens with komla preview in the browser step, in its place',
  async ({ appWindow }) => {
    cliUrlTest.skip(
      process.platform !== 'linux' || !fs.existsSync(BUILT_CLI),
      'Needs the Linux CLI from npm run build:native'
    );
    await createWorkspace(appWindow, 'setup-panes/cli');
    await expectBrowserBesideAgentAt(appWindow, 'http://localhost:4321/admin');
    await screenshot(appWindow, 'setup-panes-cli.png');
    // The page took the browser's blank tab rather than opening beside it.
    await expect(
      appWindow.locator('[data-pane-surface="browser"]').getByRole('button', { name: 'New tab' })
    ).toHaveCount(0);
  }
);

restartTest(
  'opens the Setup browser in its place again on restart, with the tabs it had',
  async ({ appWindow }) => {
    await createWorkspace(appWindow, 'setup-panes/restart');
    await expectBrowserBesideAgentAt(appWindow, 'http://localhost:4321/first');
    const browser = appWindow.locator('[data-pane-surface="browser"]').filter({ visible: true });
    const address = browser.locator('[data-browser-address]');
    await address.fill('http://localhost:4321/typed');
    await address.press('Enter');
    await expect(address).toHaveValue('http://localhost:4321/typed');

    await appWindow.getByText('setup-panes/restart').first().click({ button: 'right' });
    await appWindow.getByRole('menuitem', { name: 'Restart Workspace' }).click();

    // A fresh browser would show the step's first page again.
    await expectBrowserBesideAgentAt(appWindow, 'http://localhost:4321/typed');
    await screenshot(appWindow, 'setup-panes-restarted.png');
  }
);

stopTest(
  'opens the browser and note in their places after a stop, and not a pane closed before one',
  async ({ appWindow }) => {
    stopTest.setTimeout(120_000);
    await createWorkspace(appWindow, 'setup-panes/stop');
    const browser = appWindow.locator('[data-pane-surface="browser"]').filter({ visible: true });
    const note = appWindow.locator('[data-pane-surface="note"]').filter({ visible: true });
    await expectBrowserBesideAgentAt(appWindow, 'http://localhost:4321/first');
    await expect(note).toHaveCount(1, { timeout: 10_000 });

    const address = browser.locator('[data-browser-address]');
    await address.fill('http://localhost:4321/typed');
    await address.press('Enter');
    await expect(address).toHaveValue('http://localhost:4321/typed');
    await note.locator('.ProseMirror').click();
    await appWindow.keyboard.type('Check the login page');
    // The note saves as you type, and the layout once it settles.
    await appWindow.waitForTimeout(2_000);

    const card = appWindow.getByText('setup-panes/stop').first();
    await card.click({ button: 'right' });
    await appWindow.getByRole('menuitem', { name: 'Stop Workspace' }).click();
    await expect(appWindow.locator('.xterm').filter({ visible: true })).toHaveCount(0, {
      timeout: 15_000,
    });

    // Opening the stopped workspace starts it again.
    await card.click();
    await expectBrowserBesideAgentAt(appWindow, 'http://localhost:4321/typed');
    await expect(note).toHaveCount(1, { timeout: 10_000 });
    await expect(note.locator('.ProseMirror')).toContainText('Check the login page');
    await screenshot(appWindow, 'setup-panes-after-stop.png');

    await note.getByRole('button', { name: 'Close pane' }).click();
    await expect(note).toHaveCount(0);
    await appWindow.waitForTimeout(2_000);
    await card.click({ button: 'right' });
    await appWindow.getByRole('menuitem', { name: 'Restart Workspace' }).click();

    await expectBrowserBesideAgentAt(appWindow, 'http://localhost:4321/typed');
    await expect(note).toHaveCount(0);
  }
);
