import fs from 'node:fs';
import path from 'node:path';

import { test as base, expect, seedDefaultProject } from './electron-app';

import type { ElectronApplication, Page } from '@playwright/test';

const README = [
  '# Demo Project',
  '',
  'A sample TypeScript project for demonstrating Komla file views.',
  '',
  '## Getting Started',
  '',
].join('\n');

const BRANCH = 'markdown-menu/readme';

const test = base.extend({
  seedSandbox: async ({ cleanSandbox: _cleanSandbox }, provide) => {
    seedDefaultProject({
      branchPrefix: 'markdown-menu/',
      initialFile: { name: 'README.md', content: README },
    });
    await provide();
  },
});

/** Opens README.md in the full-window file viewer, in the rich Markdown editor. */
async function openReadme(appWindow: Page) {
  const newWorkspace = appWindow.getByRole('button', { name: 'New Workspace' }).first();
  await expect(newWorkspace).toBeVisible({ timeout: 15_000 });
  await newWorkspace.click();
  const create = appWindow.getByRole('dialog', { name: 'Create Workspace' });
  await create.locator('input[placeholder$="swift-fox"]').fill(BRANCH);
  await create.getByRole('button', { name: /^(Launch|Create)/ }).click();
  await expect(appWindow.locator('.xterm').first()).toBeVisible({ timeout: 30_000 });

  const [{ workingDirectory }] = await appWindow.evaluate(() => window.api.getWorkspaces());
  fs.writeFileSync(path.join(workingDirectory, 'package.json'), '{ "name": "demo" }\n');

  await appWindow.keyboard.press(
    process.platform === 'darwin' ? 'Meta+Shift+E' : 'Control+Shift+E'
  );
  const dialog = appWindow.locator('[role="dialog"]');
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  const editor = dialog.getByRole('textbox', { name: 'Markdown editor' });
  // The viewer may still open the changed package.json after the click, replacing README.md.
  await expect(async () => {
    await dialog.getByRole('treeitem', { name: 'README.md' }).click();
    await expect(editor).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 20_000 });
  return { dialog, editor };
}

function readClipboard(electronApp: ElectronApplication): Promise<string> {
  return electronApp.evaluate(({ clipboard }) => clipboard.readText());
}

function writeClipboard(electronApp: ElectronApplication, text: string): Promise<void> {
  return electronApp.evaluate(({ clipboard }, value) => clipboard.writeText(value), text);
}

test.describe('Markdown editor context menu', () => {
  test.describe.configure({ timeout: 90_000 });

  test('cuts, copies and pastes through the real clipboard, as Markdown', async ({
    electronApp,
    appWindow,
  }) => {
    const { editor } = await openReadme(appWindow);
    const heading = editor.getByRole('heading', { name: 'Demo Project' });

    // Copy: the heading comes out as Markdown, not as its plain text.
    await heading.click({ clickCount: 3 });
    await heading.click({ button: 'right' });
    await appWindow.getByRole('menuitem', { name: /^Copy/ }).click();
    await expect.poll(() => readClipboard(electronApp)).toContain('# Demo Project');
    await expect(appWindow.getByRole('menu')).toBeHidden();
    await expect(heading).toBeVisible();

    // Paste: Markdown text on the clipboard arrives as formatted blocks, at the right-click.
    await writeClipboard(electronApp, '## Pasted heading\n\n- pasted item\n');
    const paragraph = editor.getByText('A sample TypeScript project');
    await paragraph.click({ button: 'right', position: { x: 2, y: 2 } });
    await appWindow.getByRole('menuitem', { name: /^Paste/ }).click();
    await expect(editor.getByRole('heading', { name: 'Pasted heading' })).toBeVisible();
    await expect(editor.getByRole('listitem').filter({ hasText: 'pasted item' })).toBeVisible();

    // Cut: the selected heading leaves the file and lands on the clipboard.
    const pasted = editor.getByRole('heading', { name: 'Pasted heading' });
    await pasted.click({ clickCount: 3 });
    await pasted.click({ button: 'right' });
    await appWindow.getByRole('menuitem', { name: /^Cut/ }).click();
    await expect(editor.getByRole('heading', { name: 'Pasted heading' })).toBeHidden();
    await expect.poll(() => readClipboard(electronApp)).toContain('## Pasted heading');
  });

  test('applies formatting to the selection, and types on from the editor', async ({
    appWindow,
  }) => {
    const { editor } = await openReadme(appWindow);
    const paragraph = editor.getByText('A sample TypeScript project');

    await paragraph.click({ clickCount: 3 });
    await paragraph.click({ button: 'right' });
    await appWindow.getByRole('menuitemcheckbox', { name: /^Bold/ }).click();
    await expect(editor.locator('p strong')).toContainText('A sample TypeScript project');

    // Focus came back to the editor.
    await appWindow.keyboard.press('End');
    await appWindow.keyboard.type(' typed');
    await expect(editor.locator('p').first()).toContainText('typed');
  });

  test('copies from an editor that can not take focus', async ({ electronApp, appWindow }) => {
    const { editor } = await openReadme(appWindow);
    // As a read-only file's editor is. The menu still offers its full list, but Copy runs the same.
    await editor.evaluate((dom) => {
      (dom as HTMLElement & { editor: { setEditable: (on: boolean) => void } }).editor.setEditable(
        false
      );
    });
    const heading = editor.getByRole('heading', { name: 'Demo Project' });

    await writeClipboard(electronApp, 'before');
    await heading.click({ clickCount: 3 });
    await heading.click({ button: 'right' });
    await appWindow.getByRole('menuitem', { name: /^Copy/ }).click();

    await expect.poll(() => readClipboard(electronApp)).toContain('# Demo Project');
  });

  test('selects everything in an editor that can not take focus, without a click first', async ({
    electronApp,
    appWindow,
  }) => {
    const { editor } = await openReadme(appWindow);
    await editor.evaluate((dom) => {
      (dom as HTMLElement & { editor: { setEditable: (on: boolean) => void } }).editor.setEditable(
        false
      );
      // A file that opens read-only never has the DOM selection in its editor.
      window.getSelection()?.removeAllRanges();
    });
    const heading = editor.getByRole('heading', { name: 'Demo Project' });

    // In the margin, so the DOM selection isn't in the editor yet.
    await appWindow
      .locator('[data-markdown-scroller]')
      .click({ button: 'right', position: { x: 5, y: 5 } });
    await appWindow.getByRole('menuitem', { name: /^Select All/ }).click();
    await expect
      .poll(() => appWindow.evaluate(() => window.getSelection()?.toString() ?? ''))
      .toContain('Getting Started');

    await writeClipboard(electronApp, 'before');
    await heading.click({ button: 'right' });
    await appWindow.getByRole('menuitem', { name: /^Copy/ }).click();
    await expect.poll(() => readClipboard(electronApp)).toContain('## Getting Started');
  });

  test('leaves other menus alone, and gives plain text fields a native one', async ({
    electronApp,
    appWindow,
  }) => {
    const { dialog, editor } = await openReadme(appWindow);
    // Counts native menus without opening them: an open one holds macOS in its own event loop,
    // so the app couldn't close after the test.
    await electronApp.evaluate(({ Menu }) => {
      const state = globalThis as unknown as { popups: number };
      state.popups = 0;
      Menu.prototype.popup = () => {
        state.popups += 1;
      };
    });
    const nativePopups = () =>
      electronApp.evaluate(() => (globalThis as unknown as { popups: number }).popups);

    // The editor's own menu takes the right-click, so no native one opens over it.
    await editor.getByText('A sample TypeScript project').click({ button: 'right' });
    await expect(appWindow.getByRole('menuitem', { name: /^Paste/ })).toBeVisible();
    expect(await nativePopups()).toBe(0);
    await appWindow.keyboard.press('Escape');
    await expect(appWindow.getByRole('menu')).toBeHidden();

    // The find bar's input is a plain text field.
    await editor.getByText('A sample TypeScript project').click();
    await appWindow.keyboard.press(process.platform === 'darwin' ? 'Meta+F' : 'Control+F');
    const find = dialog.locator('[data-markdown-find] input').first();
    await expect(find).toBeVisible();
    await find.click({ button: 'right' });
    await expect.poll(nativePopups).toBe(1);

    // Monaco draws its own menu over its hidden text field, so it stays out of this one too.
    await dialog.locator('[data-item-path="package.json"]').dblclick();
    const monaco = dialog.locator('.monaco-editor .view-lines').first();
    await expect(monaco).toBeVisible({ timeout: 15_000 });
    await monaco.click({ button: 'right' });
    await expect(appWindow.locator('.monaco-menu').first()).toBeVisible();
    expect(await nativePopups()).toBe(1);
  });
});
