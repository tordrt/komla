/**
 * Landing video: "Get back to where you were". We're in Card Retries, Claude
 * Code and Codex side by side. The command center opens on the workspaces
 * waiting on us; a word from a workspace's description finds it among the
 * rest, and its title takes us back to Card Retries, its panes just as we
 * left them.
 */
import {
  ASK,
  BACK_QUERY,
  CARD_RETRIES,
  CODEX_TESTS,
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
  agentCommand,
  expect,
  setFilePanel,
  SPLIT_DOWN,
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
  const jumpTo = page.getByRole('button', { name: /^Jump to/ });
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
  // Dark Mode asks while we're elsewhere.
  director.cue(DARK_MODE.branch, ASK);
  await expect(card(DARK_MODE.title)).toContainText(/input/i);
  await waitForAgentTurn(SEARCH.branch);
  await expect(card(SEARCH.title)).toContainText('Done');

  // Card Retries: Claude Code, with Codex writing its tests in a pane below.
  await open(CARD_RETRIES.title);
  await waitForAgentAt(CARD_RETRIES.branch, GO);
  await terminal.first().focus();
  await page.keyboard.press(SPLIT_DOWN);
  await expect(terminal).toHaveCount(2);
  await terminal.last().focus();
  await page.keyboard.type(agentCommand(COMMAND_CENTER_WORLD, CODEX_TESTS));
  await page.keyboard.press('Enter');
  await waitForAgentAt(CODEX_TESTS, HOLD);
  await terminal.first().focus();
  // Off to the side, where it can't hover anything into view.
  await page.mouse.move(1110, 600);

  await director.start();
  // The video autoplays, so its poster is the first frame: no jump when playback starts.
  director.poster();
  director.cue(CARD_RETRIES.branch, GO);
  await director.hold(1.0);

  // The command center leads with the agents waiting on us.
  await director.click(jumpTo, { duration: 0.8 });
  await expect(commandCenter).toBeVisible();
  await director.camera(commandCenter, { padding: 40, duration: 0.7 });
  await director.moveTo(result(DARK_MODE.title), { duration: 0.5 });
  await director.hold(1.2);

  // A word from a workspace's description finds it.
  await director.type(QUERY, { delay: 90 });
  await expect(commandCenter.getByRole('option')).toHaveCount(1);
  // Framed once the results narrow to it, as the dialog shrinks with them.
  await director.camera(commandCenter, { padding: 60, duration: 0.6 });
  await director.moveTo(result(WEBHOOKS.title), { duration: 0.6 });
  await director.hold(1.3);
  await director.click(result(WEBHOOKS.title), { duration: 0.3 });
  await expect(commandCenter).toBeHidden();
  await director.camera('full', { duration: 0.7 });
  await expect(terminal).toHaveCount(1);
  await director.hold(1.4);

  // And back to Card Retries by its title, both agents where we left them.
  await director.click(jumpTo, { duration: 0.8 });
  await expect(commandCenter).toBeVisible();
  await director.camera(commandCenter, { padding: 40, duration: 0.6 });
  await director.type(BACK_QUERY, { delay: 90 });
  await expect(result(CARD_RETRIES.title)).toBeVisible();
  await director.click(result(CARD_RETRIES.title), { duration: 0.5 });
  await expect(commandCenter).toBeHidden();
  await director.camera('full', { duration: 0.7 });
  await expect(terminal).toHaveCount(2);
  await director.moveTo({ x: 1110, y: 600 }, { duration: 0.8 });
  await director.hold(1.8);

  await director.finish({
    name: 'landing-command-center-demo-cropped-dark',
    width: 1280,
    height: 736,
    loopFade: 0.5,
  });
});
