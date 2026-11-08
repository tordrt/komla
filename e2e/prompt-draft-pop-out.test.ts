import { test as base, expect, seedDefaultProject } from './electron-app';

import type { ElectronApplication } from '@playwright/test';

const test = base.extend({
  seedSandbox: async ({ cleanSandbox: _cleanSandbox }, provide) => {
    seedDefaultProject({
      branchPrefix: 'prompt-draft-pop-out/',
      initialFile: { name: 'server.ts', content: "import http from 'http';\n" },
    });
    await provide();
  },
});

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

/** The popped-out draft's window, as main has it: whether it shows, and stays on top. */
function draftWindowState(electronApp: ElectronApplication) {
  return electronApp.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((each) =>
      each.webContents.getURL().includes('prompt-draft.html')
    );
    return window ? { visible: window.isVisible(), onTop: window.isAlwaysOnTop() } : null;
  });
}

test('pops the prompt draft out into a window of its own, over other apps, and back in', async ({
  electronApp,
  appWindow,
}) => {
  await appWindow.getByRole('button', { name: 'New Workspace' }).first().click();
  const createDialog = appWindow.getByRole('dialog', { name: 'Create Workspace' });
  await createDialog.locator('input[placeholder$="swift-fox"]').fill('prompt-draft-pop-out/viewer');
  await createDialog.getByRole('button', { name: /^(Launch|Create)/ }).click();
  await expect(appWindow.locator('.xterm').filter({ visible: true }).first()).toBeVisible({
    timeout: 10_000,
  });

  // The status bar's button opens it, and Escape closes it, leaving focus in the workspace.
  await appWindow.getByRole('button', { name: 'Prompt draft' }).click();
  const statusDraft = appWindow.getByRole('dialog', { name: 'Prompt draft' });
  await expect(statusDraft.getByRole('textbox', { name: 'Prompt' })).toBeFocused();
  await appWindow.keyboard.press('Escape');
  await expect(statusDraft).toBeHidden();

  // A file on screen in Komla, for the popped-out draft to refer to.
  await appWindow.keyboard.press(`${mod}+Shift+E`);
  const viewer = appWindow.getByRole('dialog', { name: 'viewer' });
  await expect(viewer).toBeVisible({ timeout: 10_000 });
  await viewer.getByRole('treeitem', { name: 'server.ts' }).click();
  await expect(viewer.locator('.monaco-editor').first()).toBeVisible({ timeout: 10_000 });

  await appWindow.keyboard.press(`${mod}+Shift+X`);
  const windowDraft = viewer.getByRole('dialog', { name: 'Prompt draft' });
  const windowPrompt = windowDraft.getByRole('textbox', { name: 'Prompt' });
  await expect(windowPrompt).toBeFocused();
  await appWindow.keyboard.type('Check');

  const popped = electronApp.waitForEvent('window', (page) =>
    page.url().includes('prompt-draft.html')
  );
  await windowDraft.getByRole('button', { name: 'Pop out over other apps' }).click();
  const draftPage = await popped;
  await expect(windowDraft).toBeHidden();
  const prompt = draftPage.getByRole('textbox', { name: 'Prompt' });
  await expect(prompt).toHaveValue('Check');
  await expect(prompt).toBeFocused();
  await expect.poll(() => draftWindowState(electronApp)).toEqual({ visible: true, onTop: true });

  // Typed on where the cursor was, with a reference to the file on screen in Komla.
  await draftPage.keyboard.type(' this');
  await draftPage.keyboard.press(`${mod}+Shift+C`);
  await expect(prompt).toHaveValue('Check this @server.ts ');
  await draftPage.screenshot({ path: test.info().outputPath('prompt-draft-popped-out.png') });

  // Closed, it keeps the text; Komla's shortcut shows it again.
  await draftPage.keyboard.press('Escape');
  await expect.poll(() => draftWindowState(electronApp)).toEqual({ visible: false, onTop: true });
  await appWindow.keyboard.press(`${mod}+Shift+X`);
  await expect.poll(() => draftWindowState(electronApp)).toEqual({ visible: true, onTop: true });
  await expect(prompt).toHaveValue('Check this @server.ts ');
  await expect(windowDraft).toBeHidden();

  // Copied, it closes, and Komla says so.
  await draftPage.keyboard.press(`${mod}+Enter`);
  await expect
    .poll(() => electronApp.evaluate(({ clipboard }) => clipboard.readText()))
    .toBe('Check this @server.ts');
  await expect.poll(() => draftWindowState(electronApp)).toEqual({ visible: false, onTop: true });
  await expect(appWindow.getByText('Copied the prompt')).toBeVisible();

  // Put back in Komla, its window goes, and the draft opens in Komla's with the text.
  await appWindow.keyboard.press(`${mod}+Shift+X`);
  await expect.poll(() => draftWindowState(electronApp)).toEqual({ visible: true, onTop: true });
  await draftPage.keyboard.press('End');
  await draftPage.keyboard.type('again');
  const closed = draftPage.waitForEvent('close');
  // The click closes the page, which can be before the click returns.
  await draftPage
    .getByRole('button', { name: 'Put back in Komla' })
    .click()
    .catch((error: unknown) => {
      if (!draftPage.isClosed()) throw error;
    });
  await closed;
  await expect.poll(() => draftWindowState(electronApp)).toBeNull();
  await expect(windowPrompt).toHaveValue('Check this @server.ts again');
  await expect(windowPrompt).toBeFocused();
});
