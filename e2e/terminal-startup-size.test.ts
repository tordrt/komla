import fs from 'fs';
import path from 'path';

import {
  test as base,
  E2E_GIT_IDENTITY_ENV,
  expect,
  SANDBOX_DIR,
  seedDefaultProject,
  type Page,
} from './electron-app';

const SIZE_LOG = path.join(SANDBOX_DIR, 'shell-sizes.log');
const SHELL = path.join(SANDBOX_DIR, 'size-recording-shell.sh');

// A shell that notes the size it starts at, before it draws any prompt, then runs a plain sh.
const test = base.extend({
  appEnv: { ...E2E_GIT_IDENTITY_ENV, SHELL },
  seedSandbox: async ({ cleanSandbox: _cleanSandbox }, provide) => {
    seedDefaultProject({ branchPrefix: 'startup-size/' });
    fs.writeFileSync(
      SHELL,
      `#!/bin/sh\necho "start $KOMLA_TERMINAL_ID $(stty size)" >> '${SIZE_LOG}'\nPS1='$ ' exec /bin/sh -i\n`,
      { mode: 0o755 }
    );
    await provide();
  },
});

/** Each line is `<event> <terminal id> <rows> <cols>`. */
function sizeLog(): string[] {
  return fs.existsSync(SIZE_LOG) ? fs.readFileSync(SIZE_LOG, 'utf8').trim().split('\n') : [];
}

/** The size the shell in `pane` started at, and the size it has once the pane has settled. */
async function startAndSettledSize(appWindow: Page, pane: ReturnType<Page['locator']>) {
  const before = sizeLog().filter((line) => line.startsWith('now ')).length;
  await pane.click();
  await appWindow.keyboard.type(`echo "now $KOMLA_TERMINAL_ID $(stty size)" >> '${SIZE_LOG}'`);
  await appWindow.keyboard.press('Enter');
  await expect
    .poll(() => sizeLog().filter((line) => line.startsWith('now ')).length)
    .toBe(before + 1);
  const now = sizeLog().filter((line) => line.startsWith('now '))[before];
  const [, terminalId, ...size] = now.split(' ');
  const start = sizeLog().find((line) => line.startsWith(`start ${terminalId} `));
  return { start: start?.split(' ').slice(2).join(' '), now: size.join(' ') };
}

test.describe('Terminal startup size', () => {
  test.describe.configure({ timeout: 60_000 });
  // The shell is a POSIX script, and Windows starts PowerShell and holds nothing.
  test.skip(process.platform === 'win32', 'POSIX shells only');

  // A shell that drew its prompt at a size the pane didn't have redrew it on the resize that
  // followed, and bash left part of the first prompt above the second.
  test('a new shell starts at the size of its pane', async ({ appWindow }) => {
    await expect(appWindow.getByRole('button', { name: 'New Workspace' }).first()).toBeVisible({
      timeout: 15_000,
    });
    await appWindow.getByRole('button', { name: 'New Workspace' }).first().click();
    const dialog = appWindow.getByRole('dialog', { name: 'Create Workspace' });
    await dialog.locator('input[placeholder$="swift-fox"]').fill('startup-size/one');
    // The sandbox seeds no agent preset, so the submit button reads "Create" rather than "Launch".
    await dialog.getByRole('button', { name: /^(Launch|Create)/ }).click();
    const panes = appWindow.locator('.xterm').filter({ visible: true });
    await expect(panes).toHaveCount(1, { timeout: 10_000 });

    const first = await startAndSettledSize(appWindow, panes.first());
    expect(first.start).toBe(first.now);

    await panes.first().click({ button: 'right' });
    await appWindow.getByRole('menuitem', { name: 'Split Right' }).click();
    await expect(panes).toHaveCount(2, { timeout: 10_000 });

    const split = await startAndSettledSize(appWindow, panes.last());
    expect(split.start).toBe(split.now);
  });
});
