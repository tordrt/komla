import fs from 'fs';
import path from 'path';

import { test as base, expect, seedDefaultProject } from './electron-app';

const test = base.extend({
  seedSandbox: async ({ cleanSandbox: _cleanSandbox }, provide) => {
    seedDefaultProject({ branchPrefix: 'prompt-draft/' });
    await provide();
  },
});

// Outside the workspace, as a screenshot or log an agent wrote to /tmp, so its link opens Quick
// Look rather than the file panel.
const OUTSIDE_DIR = '/tmp/komla-e2e-prompt-draft';
const OUTSIDE_FILE = path.join(OUTSIDE_DIR, 'build-output.log');
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

test.beforeEach(() => {
  fs.mkdirSync(OUTSIDE_DIR, { recursive: true });
  fs.writeFileSync(OUTSIDE_FILE, 'step 1 ok\nstep 2 failed: timeout\n');
});

test.afterEach(() => {
  fs.rmSync(OUTSIDE_DIR, { recursive: true, force: true });
});

test('drafts a prompt over Quick Look, opened from a /tmp link in a terminal', async ({
  appWindow,
}) => {
  test.setTimeout(60_000);
  await appWindow.getByRole('button', { name: 'New Workspace' }).first().click();
  const createDialog = appWindow.getByRole('dialog', { name: 'Create Workspace' });
  await createDialog.locator('input[placeholder$="swift-fox"]').fill('prompt-draft/quick-look');
  await createDialog.getByRole('button', { name: /^(Launch|Create)/ }).click();

  const screen = appWindow
    .locator('.xterm')
    .filter({ visible: true })
    .first()
    .locator('.xterm-screen');
  await expect(screen).toBeVisible({ timeout: 10_000 });
  await screen.click();
  // On the top row, by itself, where a click can find it.
  await appWindow.keyboard.type(`clear; echo ${OUTSIDE_FILE}`);
  await appWindow.keyboard.press('Enter');

  const quickLook = appWindow.getByRole('dialog', { name: 'build-output.log' });
  await expect(async () => {
    const box = await screen.boundingBox();
    expect(box).not.toBeNull();
    // A file link opens on Cmd+click, Ctrl+click on Windows and Linux.
    await appWindow.keyboard.down(mod);
    await appWindow.mouse.move(box!.x + 40, box!.y + 8);
    await appWindow.mouse.click(box!.x + 40, box!.y + 8);
    await appWindow.keyboard.up(mod);
    await expect(quickLook).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 20_000 });

  await quickLook.getByRole('button', { name: 'Prompt draft' }).click();
  const draft = quickLook.getByRole('dialog', { name: 'Prompt draft' });
  const prompt = draft.getByRole('textbox', { name: 'Prompt' });
  // Inside Quick Look, whose focus trap would keep focus from a window outside it.
  await expect(prompt).toBeFocused();
  await expect(prompt).toHaveValue('');
  await draft.getByRole('button', { name: 'Insert @path to build-output.log' }).click();
  await expect(prompt).toHaveValue(`@${OUTSIDE_FILE} `);

  // Typing stays in the draft: the arrows don't step to another file, nor does Escape close the
  // viewer.
  await appWindow.keyboard.type('why did step 2 fail?');
  await appWindow.keyboard.press('ArrowLeft');
  await appWindow.keyboard.press(`${mod}+Shift+C`);
  await expect(prompt).toHaveValue(`@${OUTSIDE_FILE} why did step 2 fail @${OUTSIDE_FILE} ?`);
  await expect(quickLook).toBeVisible();

  await appWindow.screenshot({ path: test.info().outputPath('prompt-draft-quick-look.png') });

  await appWindow.keyboard.press('Escape');
  await expect(draft).toBeHidden();
  await expect(quickLook).toBeVisible();

  // Back over the workspace once Quick Look closes, with the text kept.
  await appWindow.keyboard.press('Escape');
  // Pressed straight away, while Quick Look is still fading out.
  await appWindow.keyboard.press(`${mod}+Shift+X`);
  await expect(appWindow.getByRole('textbox', { name: 'Prompt' })).toHaveValue(
    `@${OUTSIDE_FILE} why did step 2 fail @${OUTSIDE_FILE} ?`
  );
});
