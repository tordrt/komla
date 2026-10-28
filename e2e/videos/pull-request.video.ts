/**
 * Landing video: "Ship it and know when CI is done". The agent pushes and opens a pull request,
 * and the hooks guide's CI script tags its card "CI running" with a spinner. We look at another
 * workspace until the checks pass and the CI badge lands on the card, then go back to find it
 * tagged In review.
 */
import {
  BILLING,
  CHECKOUT,
  PROMPT,
  PULL_REQUEST_PASSED,
  PULL_REQUEST_RUNNING,
  PULL_REQUEST_WORLD,
  writeCiHook,
} from './pull-request.scene';
import { videoTest as test, expect, setPullRequest, waitForAgentTurn } from './video-fixtures';

test.use({ world: PULL_REQUEST_WORLD });

test('pull request', async ({ appWindow: page, director }) => {
  test.setTimeout(240_000);
  const card = (title: string) =>
    page.getByRole('button', { name: `Workspace details for ${title}` });
  const billing = card(BILLING.title);

  // Its agent starts when it's first opened.
  await card(CHECKOUT.title).click();
  await page.waitForTimeout(2500); // agent banner
  await billing.click();
  await page.waitForTimeout(2500); // agent banner
  writeCiHook();
  // GitHub has the pull request once the agent pushes; see setPullRequest().
  setPullRequest(BILLING.branch, PULL_REQUEST_RUNNING);
  await page.getByRole('textbox', { name: 'Terminal input' }).first().focus();

  await director.start();
  await director.hold(0.5);
  await director.type(PROMPT);
  await director.hold(0.3);
  await page.keyboard.press('Enter');
  await waitForAgentTurn(BILLING.branch);

  // The hook's next run finds the checks under way.
  writeCiHook();
  const running = billing.getByText('CI running', { exact: true });
  await expect(running).toBeVisible({ timeout: 20_000 });
  await director.hold(1.2);

  // They pass while we're elsewhere.
  await director.click(card(CHECKOUT.title), { duration: 0.8 });
  await director.hold(1.2);
  setPullRequest(BILLING.branch, PULL_REQUEST_PASSED);
  writeCiHook();
  const badge = billing.getByText('CI', { exact: true });
  await expect(badge).toBeVisible({ timeout: 20_000 });
  await director.moveTo(badge, { duration: 0.8 });
  await director.hold(1.4);

  await director.click(billing, { duration: 0.6 });
  await expect(billing.getByText('In review', { exact: true })).toBeVisible();
  await director.hold(0.6);
  director.poster();
  await director.hold(1.4);

  await director.finish({
    name: 'landing-pull-request-demo-cropped-dark',
    width: 1280,
    height: 736,
    loopFade: 0.5,
  });
});
