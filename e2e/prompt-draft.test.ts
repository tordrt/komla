import { test as base, expect, seedDefaultProject } from './electron-app';

const test = base.extend({
  seedSandbox: async ({ cleanSandbox: _cleanSandbox }, provide) => {
    seedDefaultProject({
      branchPrefix: 'prompt-draft/',
      initialFile: {
        name: 'server.ts',
        content: "import http from 'http';\n\nhttp.createServer().listen(3000);\n",
      },
    });
    await provide();
  },
});

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

test('drafts a prompt over the full file viewer, referring to the lines selected', async ({
  electronApp,
  appWindow,
}) => {
  await appWindow.getByRole('button', { name: 'New Workspace' }).first().click();
  const createDialog = appWindow.getByRole('dialog', { name: 'Create Workspace' });
  await createDialog.locator('input[placeholder$="swift-fox"]').fill('prompt-draft/viewer');
  await createDialog.getByRole('button', { name: /^(Launch|Create)/ }).click();
  await expect(appWindow.locator('.xterm').filter({ visible: true }).first()).toBeVisible({
    timeout: 10_000,
  });

  await appWindow.keyboard.press(`${mod}+Shift+E`);
  const viewer = appWindow.getByRole('dialog', { name: 'viewer' });
  await expect(viewer).toBeVisible({ timeout: 10_000 });
  await viewer.getByRole('treeitem', { name: 'server.ts' }).click();
  const editor = viewer.locator('.monaco-editor').first();
  await expect(editor).toBeVisible({ timeout: 10_000 });

  // Lines 1 to 3 selected in the file.
  await editor.click();
  await appWindow.keyboard.press(`${mod}+Home`);
  await appWindow.keyboard.press('Shift+ArrowDown');
  await appWindow.keyboard.press('Shift+ArrowDown');
  await appWindow.keyboard.press('Shift+End');

  // Pressed in the editor, which passes the shortcut on.
  await appWindow.keyboard.press(`${mod}+Shift+Y`);
  const draft = viewer.getByRole('dialog', { name: 'Prompt draft' });
  const prompt = draft.getByRole('textbox', { name: 'Prompt' });
  await expect(prompt).toBeFocused();

  // Typed into the draft, not the viewer's focus trap or shortcuts.
  await appWindow.keyboard.type('Explain');
  await appWindow.keyboard.press(`${mod}+Shift+C`);
  await expect(prompt).toHaveValue('Explain @server.ts:1-3 ');
  await draft.getByRole('button', { name: 'Insert @path to server.ts' }).click();
  await expect(prompt).toHaveValue('Explain @server.ts:1-3 @server.ts:1-3 ');
  // The textarea's own undo takes a reference back out.
  await appWindow.keyboard.press(`${mod}+Z`);
  await expect(prompt).toHaveValue('Explain @server.ts:1-3 ');

  // Cmd+C copies the text selected in the draft, not the viewer's @path.
  await appWindow.keyboard.press(`${mod}+A`);
  await appWindow.keyboard.press(`${mod}+C`);
  await expect
    .poll(() => electronApp.evaluate(({ clipboard }) => clipboard.readText()))
    .toBe('Explain @server.ts:1-3 ');
  await appWindow.keyboard.press('End');

  // A click in the draft keeps the viewer open, as its focus stays inside the viewer.
  await prompt.click();
  await expect(viewer).toBeVisible();

  await appWindow.screenshot({ path: test.info().outputPath('prompt-draft.png') });

  // Escape closes the draft, leaving the viewer and giving focus back to the editor.
  await appWindow.keyboard.press('Escape');
  await expect(draft).toBeHidden();
  await expect(viewer).toBeVisible();
  await expect
    .poll(() => appWindow.evaluate(() => !!document.activeElement?.closest('.monaco-editor')))
    .toBe(true);

  // The text stays for the next time.
  await appWindow.keyboard.press(`${mod}+Shift+Y`);
  await expect(prompt).toHaveValue('Explain @server.ts:1-3 ');
});
