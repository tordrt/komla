import fs from 'node:fs';
import path from 'node:path';

import { test as base, expect, seedDefaultProject, SANDBOX_DIR } from './electron-app';

import type { Page } from '@playwright/test';

const test = base.extend({
  seedSandbox: async ({ cleanSandbox: _cleanSandbox }, provide) => {
    seedDefaultProject({
      branchPrefix: 'imported-files/',
      initialFile: { name: 'README.md', content: 'readme\n' },
    });
    await provide();
  },
});

/** Imports a file as a terminal paste does, and re-lists the workspace's files as it does. */
async function importFile(page: Page, cwd: string, name: string): Promise<void> {
  const source = path.join(SANDBOX_DIR, 'to-import', name);
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, `contents of ${name}\n`);
  await page.evaluate(async ([dir, file]) => window.api.importExternalFile(dir, file), [
    cwd,
    source,
  ] as const);
}

async function openWorkspace(page: Page): Promise<string> {
  await expect(page.getByRole('button', { name: 'New Workspace' }).first()).toBeVisible({
    timeout: 15_000,
  });
  await page.getByRole('button', { name: 'New Workspace' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Create Workspace' });
  await dialog.locator('input[placeholder$="swift-fox"]').fill('imported-files/one');
  await dialog.getByRole('button', { name: /^(Launch|Create)/ }).click();
  await expect(dialog).toBeHidden({ timeout: 10_000 });
  // The workspace has no directory until its worktree is made, which can outlast the dialog.
  let cwd = '';
  await expect(async () => {
    cwd = await page.evaluate(async () => (await window.api.getWorkspaces())[0].workingDirectory);
    expect(cwd).not.toBe('');
  }).toPass({ timeout: 15_000 });
  return cwd;
}

/** Reloads, so the file list starts empty, selects the workspace again and opens its file panel. */
async function reopenWorkspace(page: Page): Promise<void> {
  await page.reload();
  await page.getByRole('button', { name: /^Workspace details for / }).click({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Toggle file panel' }).click();
  await expect(page.getByRole('separator', { name: 'Resize file tree panel' })).toBeVisible();
}

test.describe('Imported files', () => {
  test.describe.configure({ timeout: 90_000 });

  test('lists them below the tree, in both tabs, and keeps them manageable', async ({
    appWindow,
  }) => {
    const cwd = await openWorkspace(appWindow);
    await importFile(appWindow, cwd, 'design.txt');
    const section = appWindow.getByRole('region', { name: 'Imported files' });

    // The Diff tab loads the list by itself, which would be empty without the section asking.
    await reopenWorkspace(appWindow);
    await expect(section.getByRole('button', { name: 'design.txt', exact: true })).toBeVisible({
      timeout: 15_000,
    });

    // It opens as a file, not as a diff it doesn't have.
    await section.getByRole('button', { name: 'design.txt', exact: true }).click();
    await expect(appWindow.getByText('contents of design.txt')).toBeVisible({ timeout: 10_000 });
    await expect(section.getByRole('button', { name: 'design.txt', exact: true })).toHaveAttribute(
      'aria-current',
      'true'
    );

    // The tree can list changes while it stays open as a file; it has no diff to switch to.
    await appWindow.getByRole('button', { name: 'Files', exact: true }).click();
    await appWindow.getByRole('button', { name: 'Diff', exact: true }).click();
    await expect(appWindow.getByText('contents of design.txt')).toBeVisible();
    await section.getByRole('button', { name: 'design.txt', exact: true }).click();

    // Rename takes focus once the menu lets it go, and stays until committed.
    await section
      .getByRole('button', { name: 'design.txt', exact: true })
      .click({ button: 'right' });
    await appWindow.getByRole('menuitem', { name: 'Rename' }).click();
    const input = section.getByRole('textbox', { name: 'Rename design.txt' });
    await expect(input).toBeFocused();
    // Typing replaces the selected name and leaves the extension.
    await appWindow.keyboard.type('mock');
    await appWindow.keyboard.press('Enter');
    await expect(section.getByRole('button', { name: 'mock.txt', exact: true })).toBeVisible();
    expect(fs.existsSync(path.join(cwd, '.komla-files', 'mock.txt'))).toBe(true);

    // Moving one into the project goes through Cut, and Paste on the tree's rows.
    await section.getByRole('button', { name: 'mock.txt', exact: true }).click({ button: 'right' });
    await appWindow.getByRole('menuitem', { name: 'Cut' }).click();
    await appWindow.getByRole('button', { name: 'Files', exact: true }).click();
    await appWindow.locator('[data-item-path="README.md"]').click({ button: 'right' });
    await appWindow.getByRole('menuitem', { name: 'Paste' }).click();
    await expect.poll(() => fs.existsSync(path.join(cwd, 'mock.txt'))).toBe(true);
    await expect(section).toBeHidden();
    await expect(appWindow.locator('[data-item-path="mock.txt"]')).toBeVisible();
  });

  test('caps its height, so a pile of files leaves the tree room', async ({ appWindow }) => {
    const cwd = await openWorkspace(appWindow);
    for (let index = 0; index < 40; index += 1) {
      await importFile(appWindow, cwd, `clipboard-${index}.png`);
    }
    await reopenWorkspace(appWindow);
    const section = appWindow.getByRole('region', { name: 'Imported files' });
    await expect(section).toBeVisible({ timeout: 15_000 });
    await expect(section.getByText('40')).toBeVisible();

    const { sectionHeight, panelHeight, listScrolls } = await section.evaluate((element) => {
      const list = element.querySelector('ul')!;
      return {
        sectionHeight: element.getBoundingClientRect().height,
        panelHeight: element.parentElement!.getBoundingClientRect().height,
        listScrolls: list.scrollHeight > list.clientHeight,
      };
    });
    expect(sectionHeight).toBeLessThanOrEqual(panelHeight * 0.36);
    expect(listScrolls).toBe(true);
  });
});
