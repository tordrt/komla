import fs from 'fs';
import path from 'path';

import { buildPresetsJson } from './agent-profiles';
import { test as base, expect, SANDBOX_DIR, seedDefaultProject } from './electron-app';

const test = base.extend({
  seedSandbox: async ({ cleanSandbox: _cleanSandbox }, provide) => {
    seedDefaultProject({ branchPrefix: 'prompt-size/' });
    // The prompt only shows with an agent to send it to.
    fs.writeFileSync(
      path.join(SANDBOX_DIR, 'settings', 'agent-presets.json'),
      JSON.stringify(buildPresetsJson())
    );
    await provide();
  },
});

test.describe('New workspace prompt', () => {
  test('grows to fit a prompt a tip opens it with', async ({ appWindow }) => {
    const tips = appWindow.getByRole('button', { name: 'Tips' });
    await expect(tips).toBeVisible({ timeout: 15_000 });
    await tips.click();
    await appWindow.getByRole('button', { name: /Set up project in Komla/ }).click();

    const prompt = appWindow.getByRole('dialog', { name: 'Create Workspace' }).getByLabel('Prompt');
    await expect(prompt).toHaveValue(/Set up this project in Komla/);
    // Tall enough to show all of it, rather than a sliver to scroll through.
    await expect
      .poll(() => prompt.evaluate((el) => el.clientHeight - el.scrollHeight))
      .toBeGreaterThanOrEqual(0);
  });

  for (const height of [600, 800]) {
    test(`stops growing before the dialog leaves a ${height}px window`, async ({
      electronApp,
      appWindow,
    }) => {
      await electronApp.evaluate(
        ({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(1280, size),
        height
      );
      await expect.poll(() => appWindow.evaluate(() => window.innerHeight)).toBe(height);
      const newWorkspace = appWindow.getByRole('button', { name: 'New Workspace' }).first();
      await expect(newWorkspace).toBeVisible({ timeout: 15_000 });
      await newWorkspace.click();
      const dialog = appWindow.getByRole('dialog', { name: 'Create Workspace' });
      const prompt = dialog.getByLabel('Prompt');
      await prompt.fill(Array.from({ length: 80 }, (_, i) => `Step ${i + 1}`).join('\n'));

      const { promptHeight, scrollHeight } = await prompt.evaluate((el) => ({
        promptHeight: el.clientHeight,
        scrollHeight: el.scrollHeight,
      }));
      // The dialog's box is clamped while its content overflows visibly, so measure the form.
      const bottom = await dialog.evaluate(
        (el) => el.querySelector('form')!.getBoundingClientRect().bottom
      );
      expect(promptHeight).toBeLessThan(scrollHeight);
      // Several lines even in a short window; past the old 200px cap in a taller one.
      expect(promptHeight).toBeGreaterThan(height >= 800 ? 200 : 120);
      // Room to spare for a notice, an error or the add-project form below the prompt.
      expect(height - bottom).toBeGreaterThanOrEqual(160);
    });
  }

  test('wraps a long unbroken line instead of widening', async ({ appWindow }) => {
    const newWorkspace = appWindow.getByRole('button', { name: 'New Workspace' }).first();
    await expect(newWorkspace).toBeVisible({ timeout: 15_000 });
    await newWorkspace.click();
    const dialog = appWindow.getByRole('dialog', { name: 'Create Workspace' });
    const prompt = dialog.getByLabel('Prompt');
    await prompt.fill(`https://example.com/${'a'.repeat(600)}`);

    const { promptRight, formRight } = await prompt.evaluate((el) => ({
      promptRight: el.getBoundingClientRect().right,
      formRight: el.closest('form')!.getBoundingClientRect().right,
    }));
    expect(promptRight).toBeLessThanOrEqual(formRight);
  });
});
