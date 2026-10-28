/**
 * Landing video: "Run agents on a remote machine". An agent on the SSH host
 * starts the test suite, we quit Komla, and when Komla opens again the agent
 * has fixed the failures without us and wraps up.
 */
import { AWAY, AWAY_CAPTION, BACK, UPGRADE, UPGRADE_PROMPT } from './remote-agents.scene';
import {
  videoTest as test,
  expect,
  relaunchApp,
  waitForAgentAt,
  waitForAgentTurn,
} from './video-fixtures';
import { acmeWorld } from './worlds';

const windowSize = { width: 1152, height: 662 };
// Same aspect as the 1280×736 slot on the landing page.
test.use({ world: acmeWorld([UPGRADE]), windowSize });

test('remote agents', async ({ appWindow: page, electronApp, director }) => {
  test.setTimeout(300_000);
  const card = (p: typeof page) =>
    p.getByRole('button', { name: `Workspace details for ${UPGRADE.title}` });
  const terminal = (p: typeof page) =>
    p.getByRole('textbox', { name: 'Terminal input' }).filter({ visible: true }).first();

  await card(page).click();
  await page.waitForTimeout(2500); // agent banner
  await terminal(page).focus();

  await director.start();
  await director.hold(0.5);
  await director.type(UPGRADE_PROMPT);
  await director.hold(0.3);
  await page.keyboard.press('Enter');
  await waitForAgentAt(UPGRADE.branch, AWAY);
  // Before the ⌘Q badge starts to fade in.
  director.poster();
  await director.hold(1.4);
  // Quit as ⌘Q would, once this take has stopped recording.
  director.showKeys('Meta+q');
  await director.hold(0.4);
  await director.cut(AWAY_CAPTION);
  await Promise.all([
    electronApp.waitForEvent('close'),
    electronApp.evaluate(({ app }) => app.quit()).catch(() => undefined),
  ]);

  // With Komla closed, the agent keeps going in its tmux session on the host.
  director.cue(UPGRADE.branch, AWAY);
  await waitForAgentAt(UPGRADE.branch, BACK, 120_000);

  const relaunched = await relaunchApp(windowSize);
  try {
    const next = relaunched.page;
    await expect(card(next)).toBeVisible({ timeout: 60_000 });
    await card(next).click();
    await expect(terminal(next)).toBeAttached({ timeout: 30_000 });
    await next.waitForTimeout(3000); // reattach to the agent's tmux session
    await terminal(next).focus();

    await director.resume(relaunched.app, next);
    await director.hold(1.6);
    director.cue(UPGRADE.branch, BACK);
    await waitForAgentTurn(UPGRADE.branch);
    await director.hold(2);

    await director.finish({
      name: 'landing-remote-agents-demo-cropped-dark',
      width: 1280,
      height: 736,
      loopFade: 0.5,
    });
  } finally {
    await relaunched.app.close().catch(() => undefined);
  }
});
