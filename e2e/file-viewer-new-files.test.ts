import fs from 'fs';
import path from 'path';

import { test as base, expect, seedDefaultProject } from './electron-app';

const test = base.extend({
  seedSandbox: async ({ cleanSandbox: _cleanSandbox }, provide) => {
    seedDefaultProject({
      branchPrefix: 'new-files/',
      initialFile: { name: 'README.md', content: 'original content\n' },
    });
    await provide();
  },
});

test('the diff viewer shows a new Markdown file as rich text and closes without asking', async ({
  appWindow,
}) => {
  test.setTimeout(90_000);
  await expect(appWindow.getByRole('button', { name: 'New Workspace' }).first()).toBeVisible({
    timeout: 15_000,
  });
  const expand = appWindow.getByRole('button', { name: 'Expand sidebar' });
  if (await expand.isVisible()) await expand.click();
  await appWindow.getByRole('button', { name: 'New Workspace' }).first().click();
  const create = appWindow.getByRole('dialog', { name: 'Create Workspace' });
  await create.locator('input[placeholder$="swift-fox"]').fill('notes');
  await create.getByRole('button', { name: /^(Launch|Create)/ }).click();
  await expect(appWindow.getByRole('button', { name: 'Toggle file panel' })).toBeVisible({
    timeout: 20_000,
  });

  const workingDirectory = await appWindow.evaluate(async () => {
    const [workspace] = await window.api.getWorkspaces();
    return workspace.workingDirectory;
  });
  fs.writeFileSync(path.join(workingDirectory, 'README.md'), 'original content\nchanged\n');
  fs.writeFileSync(path.join(workingDirectory, 'RELEASE.md'), '# Release notes\n\nA new file.\n');

  // The full-window diff viewer (Cmd+Shift+G on macOS, Ctrl+Shift+D elsewhere).
  await appWindow.keyboard.press(
    process.platform === 'darwin' ? 'Meta+Shift+G' : 'Control+Shift+D'
  );
  const dialog = appWindow.getByRole('dialog').filter({ has: appWindow.getByRole('tree') });
  // The changed README's diff shows first.
  await expect(dialog.locator('.monaco-diff-editor').first()).toBeVisible({ timeout: 15_000 });

  await dialog.getByRole('treeitem', { name: 'RELEASE.md' }).first().click({ timeout: 15_000 });
  await expect(dialog.getByRole('heading', { name: 'Release notes' })).toBeVisible({
    timeout: 10_000,
  });
  await expect(dialog.locator('.monaco-diff-editor')).toHaveCount(0);

  // The README's diff editor went away with it, so nothing reads as unsaved.
  await appWindow.keyboard.press('Escape');
  await expect(appWindow.getByText('Unsaved Changes')).toHaveCount(0);
  await expect(dialog).toBeHidden();
});
