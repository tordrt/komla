/**
 * Landing video: "Spin up a fresh agent without breaking flow". While Claude
 * Code works on card retries, we dictate a new task and launch it with Claude
 * Code, already set to skip permissions. It starts in a workspace of its own
 * and we never leave ours.
 */
import {
  GO,
  LAUNCHED,
  NEW_WORKSPACE_WORLD,
  RECEIPTS_AGENT,
  RECEIPTS_PROMPT,
  RECEIPTS_TITLE,
  RETRIES,
} from './new-workspace.scene';
import { videoTest as test, expect, waitForAgentAt } from './video-fixtures';

// Same aspect as the 900×1050 slot on the landing page.
test.use({ world: NEW_WORKSPACE_WORLD, windowSize: { width: 772, height: 900 } });

test('new workspace', async ({ appWindow: page, director }) => {
  test.setTimeout(120_000);
  const terminal = page.getByRole('textbox', { name: 'Terminal input' }).filter({ visible: true });

  await page.getByRole('button', { name: `Workspace details for ${RETRIES.title}` }).click();
  // The terminal gets the width.
  await page.getByRole('button', { name: 'Toggle file panel' }).click();
  await waitForAgentAt(RETRIES.branch, GO);
  // A sidebar card with keyboard focus opens its info popover, so keep focus in the terminal.
  await terminal.first().focus();
  await page.mouse.move(740, 860);

  await director.start();
  // The video autoplays, so its poster is the first frame: no jump when playback starts.
  director.poster();
  director.cue(RETRIES.branch, GO);
  await director.hold(1);

  // The dialog records as it opens; the microphone hears the task spoken.
  await director.press('Meta+n');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  // Tight enough that the window's traffic lights stay out of the shot.
  await director.camera(dialog, { padding: 24, duration: 0.6 });
  const stop = page.getByRole('button', { name: 'Done' });
  await expect(stop).toBeVisible();
  // Past the end of the speech, with room to spare, since a clipped last word is misheard.
  await director.hold(3.9);
  await director.press('Enter');
  const prompt = page.getByPlaceholder(/What should the agent work on/);
  await expect(prompt).toHaveValue(RECEIPTS_PROMPT, { timeout: 15_000 });
  await director.hold(1.2);
  director.cue(RETRIES.branch, LAUNCHED);
  await director.press('Enter');

  // It opens above ours, on its own branch, and names itself...
  await director.camera({ x: 0, y: 0, width: 480, height: 560 }, { padding: 0, duration: 0.6 });
  await expect(
    page.getByRole('button', { name: `Workspace details for ${RECEIPTS_TITLE}` })
  ).toBeVisible({ timeout: 20_000 });
  await director.hold(1.2);
  // ...while Claude Code carries on here, and the new one finishes there without us leaving.
  director.cue(RECEIPTS_AGENT, GO);
  await director.camera('full', { duration: 0.8 });
  await director.hold(3.4);

  await director.finish({
    name: 'landing-new-workspace-dialog-demo-cropped-dark',
    width: 900,
    height: 1050,
    loopFade: 0.6,
  });
});
