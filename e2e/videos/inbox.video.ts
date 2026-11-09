/**
 * Inbox mode: workspaces that need you rise to the top of their project, above
 * a line, input before done. Dark Mode asks and jumps to the top of acme-web;
 * Rate Limiting asks and lands above acme-api's Done. Each one seen to and left
 * drops to just below the line.
 */
import {
  ASK,
  AUTH,
  DARK_MODE,
  FINISH,
  GO,
  HOLD,
  INBOX_WORLD,
  NAV,
  RATE_LIMIT,
  SEARCH,
  STRIPE,
} from './inbox.scene';
import {
  videoTest as test,
  expect,
  setFilePanel,
  waitForAgentAt,
  waitForAgentTurn,
  type Rect,
  type VideoWorkspace,
} from './video-fixtures';

// Same aspect as a 900×1050 portrait slot.
test.use({ world: INBOX_WORLD, windowSize: { width: 600, height: 700 } });

test('inbox', async ({ appWindow: page, director }) => {
  test.setTimeout(240_000);
  const card = (workspace: VideoWorkspace) =>
    page.getByRole('button', {
      name: `Workspace details for ${workspace.title}`,
    });
  const terminal = page.getByRole('textbox', { name: 'Terminal input' }).filter({ visible: true });
  const divider = page.getByRole('separator', { name: 'End of Inbox' });
  const open = async (workspace: VideoWorkspace) => {
    await card(workspace).click();
    await setFilePanel(page, false);
  };
  // The sidebar's full width from a project's header down, at the frame's aspect.
  const group = async (workspaces: VideoWorkspace[]): Promise<Rect> => {
    const boxes = await Promise.all(workspaces.map(async (w) => (await card(w).boundingBox())!));
    const top = Math.min(...boxes.map((box) => box.y)) - 40;
    const bottom = Math.max(...boxes.map((box) => box.y + box.height)) + 12;
    const width = Math.max(...boxes.map((box) => box.x + box.width)) + 12;
    const height = Math.max(bottom - top, (width * 7) / 6);
    return { x: 0, y: top, width: (height * 6) / 7, height };
  };
  const ACME_WEB_CARDS = [AUTH, DARK_MODE, NAV];
  const ACME_API_CARDS = [STRIPE, RATE_LIMIT, SEARCH];
  // A blank spot in the terminal on screen, clear of a prompt's options.
  const terminalSpot = async () => {
    const box = (await page.locator('.xterm-screen').filter({ visible: true }).boundingBox())!;
    return { x: box.x + box.width * 0.55, y: box.y + box.height * 0.1 };
  };

  await open(SEARCH);
  await open(STRIPE);
  // Search finishes while another workspace is in view, so its Done badge stays.
  director.cue(SEARCH.branch, GO);
  await waitForAgentAt(STRIPE.branch, FINISH);
  await open(NAV);
  await waitForAgentAt(NAV.branch, HOLD);
  await open(RATE_LIMIT);
  await waitForAgentAt(RATE_LIMIT.branch, ASK);
  await open(DARK_MODE);
  await waitForAgentAt(DARK_MODE.branch, ASK);
  await open(AUTH);
  await waitForAgentAt(AUTH.branch, GO);
  await waitForAgentTurn(SEARCH.branch);
  await expect(card(SEARCH)).toContainText('Done');
  // Search Endpoint leads acme-api, above the line.
  await expect(divider).toHaveCount(1);
  await terminal.first().focus();
  // Off to the side, where it can't hover anything into view.
  await page.mouse.move(560, 660);

  await director.start();
  // The video autoplays, so its poster is the first frame: no jump when playback starts.
  director.poster();
  director.cue(AUTH.branch, GO);
  await director.camera(await group(ACME_WEB_CARDS), {
    padding: 0,
    duration: 0.8,
  });
  await director.hold(0.6);

  // Dark Mode asks, and rises to the top of acme-web above a line of its own.
  director.cue(DARK_MODE.branch, ASK);
  await expect(card(DARK_MODE)).toContainText(/input/i);
  await expect(divider).toHaveCount(2);
  await director.moveTo(card(DARK_MODE), { duration: 0.6 });
  await director.hold(1.2);

  // Rate Limiting asks too, and lands above acme-api's Done: input comes first.
  await director.camera(await group(ACME_API_CARDS), {
    padding: 0,
    duration: 0.8,
  });
  director.cue(RATE_LIMIT.branch, ASK);
  await expect(card(RATE_LIMIT)).toContainText(/input/i);
  await director.hold(0.4);
  // Then Stripe Billing finishes, and joins the Inbox below Search Endpoint.
  director.cue(STRIPE.branch, FINISH);
  await expect(card(STRIPE)).toContainText('Done', { timeout: 15_000 });
  await director.hold(1.2);

  // Seeing to Dark Mode: it keeps its place while it's open.
  await director.camera('full', { duration: 0.7 });
  await director.click(card(DARK_MODE), { duration: 0.7 });
  await expect(terminal).toHaveCount(1);
  await director.hold(0.5);
  await director.click(await terminalSpot(), { duration: 0.5 });
  await director.hold(0.3);
  await director.press('Enter');
  await director.hold(0.8);

  // On to Rate Limiting: Dark Mode, left behind, drops below acme-web's line.
  await director.click(card(RATE_LIMIT), { duration: 0.7 });
  await director.camera(await group(ACME_WEB_CARDS), {
    padding: 0,
    duration: 0.7,
  });
  await director.hold(1.4);
  await director.camera('full', { duration: 0.7 });
  await director.click(await terminalSpot(), { duration: 0.5 });
  await director.hold(0.3);
  await director.press('Enter');
  await director.hold(0.6);

  // And on to Search Endpoint: Rate Limiting drops below acme-api's line, Stripe Billing still above it.
  await director.click(card(SEARCH), { duration: 0.7 });
  await director.camera(await group(ACME_API_CARDS), {
    padding: 0,
    duration: 0.7,
  });
  await director.hold(1.8);

  await director.finish({
    name: 'inbox-mode-dark',
    width: 900,
    height: 1050,
    loopFade: 0.6,
  });
});
