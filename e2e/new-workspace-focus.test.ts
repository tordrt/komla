import fs from 'fs';
import path from 'path';

import {
  test as base,
  e2eSandboxDir,
  expect,
  SANDBOX_DIR,
  seedDefaultProject,
} from './electron-app';

const test = base.extend({
  seedSandbox: async ({ cleanSandbox: _cleanSandbox }, provide) => {
    seedDefaultProject({ branchPrefix: 'new-workspace-focus/' });
    // The prompt only shows with an agent to send it to. This one is a plain shell, which
    // prints the file link to open Quick Look from.
    fs.writeFileSync(
      path.join(SANDBOX_DIR, 'settings', 'agent-presets.json'),
      JSON.stringify({
        presets: [{ id: 'shell-agent', name: 'Shell agent', openCommand: 'sh' }],
        activePresets: [{ presetId: 'shell-agent', lastUsedAt: Date.now() }],
      })
    );
    await provide();
  },
});

// Outside the workspace, so its link opens Quick Look rather than the file panel.
const OUTSIDE_DIR = e2eSandboxDir('new-workspace-focus');
const OUTSIDE_FILE = path.join(OUTSIDE_DIR, 'build-output.log');
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

test.beforeEach(() => {
  fs.mkdirSync(OUTSIDE_DIR, { recursive: true });
  fs.writeFileSync(OUTSIDE_FILE, 'step 1 ok\n');
});

test.afterEach(() => {
  fs.rmSync(OUTSIDE_DIR, { recursive: true, force: true });
});

test('focuses the prompt when New Workspace opens over Quick Look', async ({ appWindow }) => {
  test.skip(process.platform === 'win32', 'The agent is a POSIX shell');
  test.setTimeout(60_000);
  await appWindow.getByRole('button', { name: 'New Workspace' }).first().click();
  const createDialog = appWindow.getByRole('dialog', { name: 'Create Workspace' });
  const prompt = createDialog.getByLabel('Prompt');
  await expect(prompt).toBeFocused();
  await createDialog.locator('input[placeholder$="swift-fox"]').fill('new-workspace-focus/one');
  await createDialog.getByRole('button', { name: /^(Launch|Create)/ }).click();
  await expect(createDialog).toBeHidden();

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
  await expect(quickLook).toBeFocused();

  // Quick Look's focus trap took the focus back from the prompt, leaving it on the project picker.
  await appWindow.keyboard.press(`${mod}+n`);
  await expect(createDialog).toBeVisible();
  await expect(prompt).toBeFocused();
});
