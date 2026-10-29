/**
 * Landing video: "Find any workspace, and the ones waiting on you". The
 * command center opens on the workspaces whose agents need attention; one
 * click takes us to the one asking, and we answer it. Then a word from a
 * workspace's description finds it among the rest.
 */
import {
  ASK,
  COMMAND_CENTER_WORLD,
  DARK_MODE,
  GO,
  HOLD,
  QUERY,
  RATE_LIMIT,
  SEARCH,
  WEBHOOKS,
} from './command-center.scene';
import {
  videoTest as test,
  expect,
  setFilePanel,
  waitForAgentAt,
  waitForAgentTurn,
} from './video-fixtures';

// Same aspect as the 1280×736 slot on the landing page.
test.use({ world: COMMAND_CENTER_WORLD, windowSize: { width: 1152, height: 662 } });

test('command center', async ({ appWindow: page, director }) => {
  test.setTimeout(180_000);
  const card = (title: string) =>
    page.getByRole('button', { name: `Workspace details for ${title}` });
  const terminal = page.getByRole('textbox', { name: 'Terminal input' }).filter({ visible: true });
  const commandCenter = page.getByRole('dialog', { name: 'Command Center' });
  const result = (title: string) =>
    commandCenter.getByRole('option').filter({ hasText: title }).first();
  // Each opened once before, so its agent has started and the terminal gets the width.
  const open = async (title: string) => {
    await card(title).click();
    await setFilePanel(page, false);
    await page.waitForTimeout(1500); // agent banner and history
  };

  await open(SEARCH.title);
  await open(WEBHOOKS.title);
  // Search finishes while another workspace is in view, or its Done would count as seen.
  director.cue(SEARCH.branch, GO);
  await open(DARK_MODE.title);
  await waitForAgentAt(DARK_MODE.branch, ASK);
  await open(RATE_LIMIT.title);
  await waitForAgentAt(RATE_LIMIT.branch, HOLD);
  await waitForAgentTurn(SEARCH.branch);
  await expect(card(SEARCH.title)).toContainText('Done');
  await terminal.first().focus();
  // Off to the side, where it can't hover anything into view.
  await page.mouse.move(1110, 600);

  await director.start();
  director.poster();
  await director.hold(0.6);

  // Dark Mode stops for permission while we're in Rate Limiting.
  director.cue(DARK_MODE.branch, ASK);
  director.speed(2);
  await expect(card(DARK_MODE.title)).toContainText(/input/i);
  director.speed(1);
  await director.hold(0.6);

  // The command center leads with the agents waiting on us.
  await director.click(page.getByRole('button', { name: /^Jump to/ }), { duration: 0.9 });
  await expect(commandCenter).toBeVisible();
  await director.camera(commandCenter, { padding: 40, duration: 0.7 });
  await director.hold(0.6);
  await director.moveTo(result(SEARCH.title), { duration: 0.5 });
  await director.hold(0.7);
  await director.click(result(DARK_MODE.title), { duration: 0.5 });
  await expect(commandCenter).toBeHidden();
  await director.camera('full', { duration: 0.7 });

  // There it asks, and we answer it.
  await expect(terminal).toHaveCount(1);
  await director.hold(0.8);
  const asking = (await page.locator('.xterm-screen').filter({ visible: true }).boundingBox())!;
  await director.click(
    { x: asking.x + asking.width * 0.6, y: asking.y + asking.height * 0.1 },
    { duration: 0.6 }
  );
  await director.hold(0.3);
  await director.press('Enter');
  await director.hold(1.0);

  // A word from a workspace's description finds it.
  await director.press('Meta+p');
  await expect(commandCenter).toBeVisible();
  await director.hold(0.4);
  await director.type(QUERY, { delay: 90 });
  await expect(commandCenter.getByRole('option')).toHaveCount(1);
  // Framed once the results narrow to it, as the dialog shrinks with them.
  await director.camera(commandCenter, { padding: 60, duration: 0.6 });
  await director.moveTo(result(WEBHOOKS.title), { duration: 0.6 });
  await director.hold(1.4);
  await director.click(result(WEBHOOKS.title), { duration: 0.3 });
  await expect(commandCenter).toBeHidden();
  await director.camera('full', { duration: 0.7 });
  await director.hold(1.6);

  await director.finish({
    name: 'landing-command-center-demo-cropped-dark',
    width: 1280,
    height: 736,
    loopFade: 0.5,
  });
});
