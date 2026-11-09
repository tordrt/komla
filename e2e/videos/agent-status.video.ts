/**
 * Landing video: "Step in only where you're needed". Agents work across two
 * projects, two of them in one workspace. Dark Mode is waiting on permission,
 * and its card says what for; we answer it. Auth Flow finishes, then Rate
 * Limiting stops to ask, and we answer that one too.
 */
import {
  ASK,
  AUTH,
  DARK_MODE,
  FINISH,
  GO,
  HOLD,
  NAV,
  NAV_TESTS,
  SEARCH,
  STATUS_WORLD,
  STRIPE,
} from './agent-status.scene';
import { RATE_LIMIT } from './inbox.scene';
import {
  videoTest as test,
  agentCommand,
  expect,
  setFilePanel,
  SPLIT_DOWN,
  waitForAgentAt,
  waitForAgentTurn,
  type VideoWorkspace,
} from './video-fixtures';

// Same aspect as the 900×1050 slot on the landing page.
// Rate Limiting stops to ask too.
const WORLD = {
  ...STATUS_WORLD,
  workspaces: STATUS_WORLD.workspaces.map((w) => (w.id === RATE_LIMIT.id ? RATE_LIMIT : w)),
};
test.use({ world: WORLD, windowSize: { width: 600, height: 700 } });

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
    await setFilePanel(page, false);
  };
  await open(SEARCH);
  await open(STRIPE);
  // Search finishes while another workspace is in view, or its Done would count as seen.
  director.cue(SEARCH.branch, GO);
  await waitForAgentAt(STRIPE.branch, FINISH);
  await open(NAV);
  await waitForAgentAt(NAV.branch, HOLD);
  // A second agent writes tests in a pane below, so the card counts two at work.
  await terminal.first().focus();
  await page.keyboard.press(SPLIT_DOWN);
  await expect(terminal).toHaveCount(2);
  await terminal.last().focus();
  await page.keyboard.type(agentCommand(WORLD, NAV_TESTS));
  await page.keyboard.press('Enter');
  await waitForAgentAt(NAV_TESTS, HOLD);
  await open(RATE_LIMIT);
  await waitForAgentAt(RATE_LIMIT.branch, ASK);
  await open(DARK_MODE);
  await waitForAgentAt(DARK_MODE.branch, ASK);
  await open(AUTH);
  await waitForAgentAt(AUTH.branch, GO);
  // Dark Mode asked a moment ago, so the first frame has a card waiting, one working and one done.
  director.cue(DARK_MODE.branch, ASK);
  await expect(card(DARK_MODE)).toContainText(/input/i);
  await waitForAgentTurn(SEARCH.branch);
  await expect(card(SEARCH)).toContainText('Done');
  await terminal.first().focus();
  // Off to the side, where it can't hover anything into view.
  await page.mouse.move(560, 660);

  // Answers the agent on screen from a blank spot in its terminal, clear of the prompt's options.
  const answer = async () => {
    await expect(terminal).toHaveCount(1);
    await director.hold(0.6);
    const [asking] = await panes();
    await director.click(
      { x: asking.x + asking.width * 0.55, y: asking.y + asking.height * 0.1 },
      { duration: 0.6 }
    );
    await director.hold(0.3);
    await director.press('Enter');
  };

  await director.start();
  // The video autoplays, so its poster is the first frame: no jump when playback starts.
  director.poster();
  director.cue(AUTH.branch, GO);
  await director.hold(0.6);

  // Its card says what it's waiting for.
  await director.moveTo(card(DARK_MODE), { duration: 0.6 });
  const why = page.getByText('Claude needs your permission to use Bash').first();
  await expect(why).toBeVisible({ timeout: 5000 });
  await director.hold(1.4);
  await director.click(card(DARK_MODE), { duration: 0.3 });
  await answer();
  await director.hold(0.6);

  // Auth Flow finishes in the background; Komla shows Done about a second after it stops.
  director.cue(AUTH.branch, FINISH);
  await waitForAgentTurn(AUTH.branch);
  await expect(card(AUTH)).toContainText('Done');
  await director.hold(0.8);

  // Then Rate Limiting stops to ask.
  director.cue(RATE_LIMIT.branch, ASK);
  await expect(card(RATE_LIMIT)).toContainText(/input/i);
  await director.hold(1.0);
  await director.click(card(RATE_LIMIT), { duration: 0.7 });
  await answer();
  await director.hold(1.4);

  await director.finish({
    name: 'landing-notifications-cropped-dark',
    width: 900,
    height: 1050,
    loopFade: 0.6,
  });
});
