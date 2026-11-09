/**
 * Inbox mode with working workspaces folded away: switched on from the
 * sidebar's filter menu, the list keeps only the workspaces that need you, and
 * the working ones wait on a Working shelf at the bottom until they finish or
 * ask. One finishes and one asks, each leaving the shelf for the top of its
 * project; the one answered and left folds back onto the shelf.
 */
import type { Locator } from '@playwright/test';

import {
  ASK,
  AUTH,
  DARK_MODE,
  FINISH,
  GO,
  HOLD,
  INBOX_FOLDED_WORLD,
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
test.use({
  world: INBOX_FOLDED_WORLD,
  windowSize: { width: 600, height: 700 },
});

test('inbox folded', async ({ appWindow: page, director }) => {
  test.setTimeout(240_000);
  const card = (workspace: VideoWorkspace) =>
    page.getByRole('button', {
      name: `Workspace details for ${workspace.title}`,
    });
  const terminal = page.getByRole('textbox', { name: 'Terminal input' }).filter({ visible: true });
  const filter = page.getByRole('button', { name: /^Filter workspaces/ });
  const menu = page.getByRole('menu');
  const inbox = page.getByRole('menuitemcheckbox', { name: 'Inbox mode' });
  const foldWorking = page.getByRole('menuitemcheckbox', {
    name: 'Workspaces with a working agent',
  });
  const workingShelf = page.getByRole('region', { name: 'Working' });
  const workingHeader = workingShelf.getByRole('button').first();
  const open = async (workspace: VideoWorkspace) => {
    await card(workspace).click();
    await setFilePanel(page, false);
  };
  // The sidebar's width, at the frame's aspect, centred on `target` as far as the window allows.
  const sidebarAround = async (target: Locator): Promise<Rect> => {
    const box = (await target.boundingBox())!;
    const width = (await card(AUTH).boundingBox())!.x * 2 + (await card(AUTH).boundingBox())!.width;
    const height = (width * 7) / 6;
    return { x: 0, y: box.y + box.height / 2 - height / 2, width, height };
  };
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
  // Dark Mode asked a while ago, so the list opens with one waiting and one done among the rest.
  director.cue(DARK_MODE.branch, ASK);
  await expect(card(DARK_MODE)).toContainText(/input/i);
  await waitForAgentTurn(SEARCH.branch);
  await expect(card(SEARCH)).toContainText('Done');
  await terminal.first().focus();
  // Off to the side, where it can't hover anything into view.
  await page.mouse.move(560, 660);

  await director.start();
  // The video autoplays, so its poster is the first frame: no jump when playback starts.
  director.poster();
  director.cue(AUTH.branch, GO);
  await director.hold(0.8);

  // Inbox mode, from the filter menu at the foot of the sidebar.
  await director.click(filter, { duration: 0.7 });
  await expect(inbox).toBeVisible();
  await director.camera(menu, { padding: 40, duration: 0.6 });
  await director.moveTo(inbox, { duration: 0.5 });
  // Its tooltip, beside the menu, says what it does.
  const tooltip = page.getByRole('tooltip');
  await expect(tooltip).toBeVisible({ timeout: 5000 });
  const [menuBox, tooltipBox] = [(await menu.boundingBox())!, (await tooltip.boundingBox())!];
  const right = Math.max(menuBox.x + menuBox.width, tooltipBox.x + tooltipBox.width) + 24;
  await director.camera(
    {
      x: menuBox.x - 24,
      y: menuBox.y - 24,
      width: right - menuBox.x + 24,
      height: menuBox.height + 48,
    },
    { padding: 0, duration: 0.5 }
  );
  await director.hold(1.8);
  await director.click(inbox, { duration: 0.3 });
  // Turning it on folds working workspaces away too.
  await expect(foldWorking).toHaveAttribute('aria-checked', 'true');
  await director.moveTo(foldWorking, { duration: 0.5 });
  await director.hold(1.0);
  await director.click(await terminalSpot(), { duration: 0.6 });
  await expect(menu).toBeHidden();

  // Only the workspaces that need you are left, and a Working shelf at the bottom.
  await director.camera('full', { duration: 0.7 });
  await expect(workingShelf).toBeVisible();
  await director.hold(1.4);

  // Stripe Billing finishes: it leaves the shelf for acme-api, under Search Endpoint.
  director.cue(STRIPE.branch, FINISH);
  await expect(card(STRIPE)).toContainText('Done', { timeout: 15_000 });
  await director.camera(await sidebarAround(card(SEARCH)), {
    padding: 0,
    duration: 0.7,
  });
  await director.hold(1.0);
  // Rate Limiting asks, and lands above them both: input comes first.
  director.cue(RATE_LIMIT.branch, ASK);
  await expect(card(RATE_LIMIT)).toContainText(/input/i);
  await director.hold(1.2);

  // Answering it: it's working again, but stays put while it's open.
  await director.camera('full', { duration: 0.7 });
  await director.click(card(RATE_LIMIT), { duration: 0.7 });
  await expect(terminal).toHaveCount(1);
  await director.hold(0.4);
  await director.click(await terminalSpot(), { duration: 0.5 });
  await director.hold(0.3);
  await director.press('Enter');
  await director.hold(0.8);

  // On to Stripe Billing: Rate Limiting, left behind and working, folds onto the shelf.
  await director.click(card(STRIPE), { duration: 0.7 });
  await director.hold(1.2);

  // The shelf opens to show who's still working.
  await director.click(workingHeader, { duration: 0.7 });
  await director.moveTo(await terminalSpot(), { duration: 0.6 });
  await director.hold(1.8);

  await director.finish({
    name: 'inbox-mode-folded-dark',
    width: 900,
    height: 1050,
    loopFade: 0.6,
  });
});
