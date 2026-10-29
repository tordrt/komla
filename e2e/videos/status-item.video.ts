/**
 * Landing video: "Make the status bar your own". We ask the agent for a status
 * bar item for the migrations the branch's database hasn't run and apply the
 * change it proposes. The item's popover lists them and runs them, which tags
 * the card while they run, and a notification lands on the card once they're
 * applied.
 */
import { CHECKOUT, INVITES, PROMPT, STATUS_ITEM_WORLD } from './status-item.scene';
import { videoTest as test, expect, setFilePanel, waitForAgentTurn } from './video-fixtures';

// Same aspect as the 1280×736 slot on the landing page.
test.use({ world: STATUS_ITEM_WORLD, windowSize: { width: 1152, height: 662 } });

test('status item', async ({ appWindow: page, director }) => {
  test.setTimeout(180_000);
  const card = (title: string) =>
    page.getByRole('button', { name: `Workspace details for ${title}` });
  const invites = card(INVITES.title);
  const review = page.getByRole('dialog', { name: 'Review settings changes' });
  const item = (text: string) => page.getByRole('button', { name: new RegExp(text) });

  // Each opened once before, so the hop there doesn't show it starting, and each terminal gets
  // the width.
  for (const title of [CHECKOUT.title, INVITES.title]) {
    await card(title).click();
    await setFilePanel(page, false);
    await page.waitForTimeout(2500); // agent banner and history
  }
  await page
    .getByRole('textbox', { name: 'Terminal input' })
    .filter({ visible: true })
    .first()
    .focus();
  await page.mouse.move(1110, 600);

  await director.start();
  director.poster();
  await director.hold(0.6);
  director.speed(1.5);
  await director.type(PROMPT);
  director.speed(1);
  await director.hold(0.3);
  await page.keyboard.press('Enter');

  // The agent proposes the item, and Komla shows it, with its commands, before it's saved.
  director.speed(2);
  await expect(review).toBeVisible({ timeout: 20_000 });
  director.speed(1);
  await director.hold(1.6);
  await director.click(review.getByRole('button', { name: 'Apply changes' }), { duration: 0.7 });
  await waitForAgentTurn(INVITES.branch);
  const pending = item('2 migrations pending');
  await expect(pending).toBeVisible({ timeout: 20_000 });
  await director.hold(1.0);

  // Its popover lists the branch's pending migrations, and runs them.
  await director.click(pending, { duration: 0.8 });
  const run = page.getByRole('button', { name: 'Run migrations' });
  await expect(run).toBeVisible({ timeout: 15_000 });
  // Its page, which the item's popover command prints.
  const sheet = page.locator('iframe[title="Migrations"]').contentFrame();
  await expect(sheet.getByText('add_invite_expiry', { exact: true })).toBeVisible();
  await director.camera(page.getByRole('dialog').last(), { padding: 80, duration: 0.6 });
  // A click in the popover's first seconds can close it, so it's read for a while first.
  await director.hold(0.8);
  // Off the item first: its tooltip would stay open over the button.
  await director.moveTo(page.getByRole('heading', { name: 'Migrations' }), { duration: 0.5 });
  await expect(page.getByRole('tooltip')).toBeHidden();
  await director.hold(0.4);
  await director.moveTo(sheet.getByText('create_invites', { exact: true }), { duration: 0.5 });
  await director.hold(0.9);
  await director.moveTo(sheet.getByText('add_invite_expiry', { exact: true }), { duration: 0.4 });
  await director.hold(0.8);
  await director.click(run, { duration: 0.5 });
  await director.camera('full', { duration: 0.6 });

  // The card says they're running while we work elsewhere, and tells us when they're applied.
  await expect(invites).toContainText('Migrating', { timeout: 15_000 });
  await director.hold(0.8);
  await director.click(card(CHECKOUT.title), { duration: 0.7 });
  // Off the cards, whose info opens on hover, and close on the sidebar.
  await director.moveTo({ x: 760, y: 420 }, { duration: 0.6 });
  await director.camera({ x: 0, y: 0, width: 576, height: 331 }, { padding: 0, duration: 0.6 });
  await expect(invites).toContainText('Migrations applied', { timeout: 20_000 });
  await director.hold(2.0);
  await director.camera('full', { duration: 0.6 });
  await director.click(invites, { duration: 0.6 });
  await expect(item('Migrations up to date')).toBeVisible({ timeout: 15_000 });
  await director.hold(2.0);

  await director.finish({
    name: 'landing-status-item-demo-cropped-dark',
    width: 1280,
    height: 736,
    loopFade: 0.5,
  });
});
