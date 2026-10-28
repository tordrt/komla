/**
 * Landing video: "Every agent's status at a glance". Agents work across two
 * projects; one finishes, one stops for permission. Its card leads to its
 * workspace, where the pane that asked is outlined next to a second agent; we
 * answer it, then hop back as the first agent finishes.
 */
import {
  ASK,
  AUTH,
  DARK_MODE,
  DARK_MODE_TESTS,
  FINISH,
  GO,
  HOLD,
  NAV,
  RATE_LIMIT,
  SEARCH,
  STATUS_WORLD,
  STRIPE,
} from './agent-status.scene';
import {
  videoTest as test,
  agentCommand,
  expect,
  waitForAgentAt,
  waitForAgentTurn,
  type VideoWorkspace,
} from './video-fixtures';

// Same aspect as the 900×1050 slot on the landing page.
test.use({ world: STATUS_WORLD, windowSize: { width: 600, height: 700 } });

test('agent status', async ({ appWindow: page, director }) => {
  test.setTimeout(180_000);
  const card = (workspace: VideoWorkspace) =>
    page.getByRole('button', { name: `Workspace details for ${workspace.title}` });
  const terminal = page.getByRole('textbox', { name: 'Terminal input' }).filter({ visible: true });
  // Visible panes, top to bottom.
  const panes = async () => {
    const boxes = await page.locator('.xterm-screen').filter({ visible: true }).all();
    const rects = await Promise.all(boxes.map(async (box) => (await box.boundingBox())!));
    return rects.sort((a, b) => a.y - b.y);
  };

  // The file panel would squeeze the terminal in this narrow window.
  const open = async (workspace: VideoWorkspace) => {
    await card(workspace).click();
    await page.getByRole('button', { name: 'Toggle file panel' }).click();
  };
  await open(SEARCH);
  await open(STRIPE);
  // Search finishes while another workspace is in view, or its Done would count as seen.
  director.cue(SEARCH.branch, GO);
  await waitForAgentAt(STRIPE.branch, FINISH);
  await open(NAV);
  await waitForAgentAt(NAV.branch, HOLD);
  await open(RATE_LIMIT);
  await waitForAgentAt(RATE_LIMIT.branch, HOLD);
  await open(DARK_MODE);
  await waitForAgentAt(DARK_MODE.branch, ASK);
  // A second agent writes tests in a pane below, which keeps focus, so the pane
  // above is outlined when it asks for input.
  await terminal.first().focus();
  await page.keyboard.press('Meta+Shift+d');
  await expect(terminal).toHaveCount(2);
  await terminal.last().focus();
  await page.keyboard.type(agentCommand(STATUS_WORLD, DARK_MODE_TESTS));
  await page.keyboard.press('Enter');
  await waitForAgentAt(DARK_MODE_TESTS, GO);
  await open(AUTH);
  await waitForAgentAt(AUTH.branch, GO);
  await waitForAgentTurn(SEARCH.branch);
  await expect(card(SEARCH)).toContainText('Done');
  await terminal.first().focus();
  // Off to the side, where it can't hover anything into view.
  await page.mouse.move(560, 660);

  await director.start();
  // The video autoplays, so its poster is the first frame: no jump when playback starts.
  director.poster();
  director.cue(AUTH.branch, GO);
  await director.hold(1.0);

  director.cue(DARK_MODE.branch, ASK);
  // With two agents, the card shows each one's state as an icon.
  await expect(card(DARK_MODE)).toContainText('needs input');
  await director.hold(1.1);
  await director.click(card(DARK_MODE), { duration: 0.7 });
  director.cue(DARK_MODE_TESTS, GO);
  await expect(terminal).toHaveCount(2);
  // The pane that asked stays outlined until it's focused.
  await director.hold(1.2);
  // A blank spot inside the frame, clear of the prompt's options.
  const [asking] = await panes();
  await director.click(
    { x: asking.x + asking.width * 0.55, y: asking.y + asking.height * 0.1 },
    { duration: 0.6 }
  );
  await director.hold(0.4);
  await director.press('Enter');
  await director.hold(0.6);

  // Komla shows Done about a second after an agent stops.
  director.cue(STRIPE.branch, FINISH);
  await director.hold(1.2);
  director.cue(AUTH.branch, FINISH);
  await waitForAgentTurn(AUTH.branch);
  await expect(card(AUTH)).toContainText('Done');
  await expect(card(STRIPE)).toContainText('Done');
  await director.hold(0.7);
  await director.click(card(AUTH), { duration: 0.7 });
  await terminal.first().focus();
  const [screen] = await panes();
  await director.moveTo(
    { x: screen.x + screen.width * 0.5, y: screen.y + screen.height * 0.7 },
    { duration: 0.5 }
  );
  await director.hold(1.2);

  await director.finish({
    name: 'landing-notifications-cropped-dark',
    width: 900,
    height: 1050,
    // The window's top left: the sidebar's cards and the start of the terminal.
    frame: { x: 0, y: 0, width: 514, height: 600 },
    loopFade: 0.6,
  });
});
