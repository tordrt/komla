/**
 * Landing video: "Start a task the moment you think of it". While Claude Code
 * works on card retries, New Workspace is open and listening: we say the task
 * and launch. It starts in a workspace of its own and names
 * itself, and we never leave ours.
 *
 * The slot shows only the top of the video, so everything that matters stays
 * in the top half of the frame.
 */
import {
  DICTATES,
  GO,
  LAUNCHED,
  NEW_WORKSPACE_WORLD,
  RECEIPTS_PROMPT,
  RECEIPTS_TITLE,
  RETRIES,
} from './new-workspace.scene';
import { videoTest as test, expect, setFilePanel, waitForAgentAt } from './video-fixtures';

// Same aspect as the 900×1050 slot on the landing page; small enough that the dialog fills the
// visible band.
const WINDOW = { width: 680, height: 793 };
test.use({ world: NEW_WORKSPACE_WORLD, windowSize: WINDOW });

test('new workspace', async ({ appWindow: page, director }) => {
  test.setTimeout(120_000);
  const terminal = page.getByRole('textbox', { name: 'Terminal input' }).filter({ visible: true });
  const card = (title: string) =>
    page.getByRole('button', { name: `Workspace details for ${title}` });
  const dialog = page.getByRole('dialog');
  const prompt = page.getByPlaceholder(/What should the agent work on/);
  const launch = dialog.getByRole('button', { name: /^Launch/ });
  await card(RETRIES.title).click();
  // The terminal gets the width.
  await setFilePanel(page, false);
  await waitForAgentAt(RETRIES.branch, GO);
  // A sidebar card with keyboard focus opens its info popover, so keep focus in the terminal.
  await terminal.first().focus();
  // Opened off camera, so the video and its poster start on the dialog; it records as it opens.
  await page.getByRole('button', { name: 'New Workspace', exact: true }).first().click();
  await expect(dialog).toBeVisible();
  const stop = page.getByRole('button', { name: 'Done' });
  if (DICTATES) await expect(stop).toBeVisible();
  await page.mouse.move(WINDOW.width - 40, WINDOW.height - 40);

  await director.start();
  // The dialog is open from the first frame, which is also the poster.
  director.poster();
  director.cue(RETRIES.branch, GO);

  if (DICTATES) {
    // Past the end of the speech, with room to spare, since a clipped last word is misheard. The
    // video has no sound, so the waveform can play fast.
    director.speed(3);
    await director.hold(3.9);
    director.speed(1);
    await director.click(stop, { duration: 0.6 });
    director.speed(3);
    await expect(prompt).toHaveValue(RECEIPTS_PROMPT, { timeout: 15_000 });
    director.speed(1);
  } else {
    await director.hold(0.6);
    director.speed(2);
    await director.type(RECEIPTS_PROMPT);
    director.speed(1);
  }
  await director.hold(0.8);

  director.cue(RETRIES.branch, LAUNCHED);
  await director.click(launch, { duration: 0.6 });

  // It opens above ours, on its own branch, and names itself, while Claude Code carries on here.
  await expect(dialog).toBeHidden();
  await expect(card(RECEIPTS_TITLE)).toBeVisible({ timeout: 20_000 });
  await director.hold(1.6);
  await director.hold(1.8);

  await director.finish({
    name: 'landing-new-workspace-dialog-demo-cropped-dark',
    width: 900,
    height: 1050,
    loopFade: 0.6,
  });
});
