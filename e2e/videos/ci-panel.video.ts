/**
 * Landing video: "A panel for whatever you check all day". The agent that opened a pull request is
 * asked for a sidebar panel with its CI checks, and Komla shows the change for review. Once
 * applied, a CI tab lists the checks by state, one failing. Re-running the failed one shows it
 * running, then everything passed.
 */
import {
  BILLING,
  CI_PANEL_WORLD,
  PANEL_TITLE,
  PROMPT,
  PULL_REQUEST_FAILED,
  PULL_REQUEST_PASSED,
  PULL_REQUEST_RERUNNING,
} from './ci-panel.scene';
import {
  videoTest as test,
  expect,
  setFilePanel,
  setPullRequest,
  setRerun,
  waitForAgentTurn,
} from './video-fixtures';

// Same aspect as the 1280×736 slot on the landing page.
test.use({ world: CI_PANEL_WORLD, windowSize: { width: 1152, height: 662 } });

test('ci panel', async ({ appWindow: page, director }) => {
  test.setTimeout(180_000);
  const review = page.getByRole('dialog', { name: 'Review settings changes' });

  setPullRequest(BILLING.branch, PULL_REQUEST_FAILED);
  setRerun(BILLING.branch, PULL_REQUEST_RERUNNING);
  // Its agent starts when the workspace is first opened, and the terminal takes the width.
  await page.getByRole('button', { name: `Workspace details for ${BILLING.title}` }).click();
  await setFilePanel(page, false);
  await page.waitForTimeout(2500); // agent banner and history
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

  // The agent proposes the panel, and Komla shows it before it's saved.
  director.speed(2);
  await expect(review).toBeVisible({ timeout: 30_000 });
  director.speed(1);
  await director.hold(2.0);
  await director.click(review.getByRole('button', { name: 'Apply changes' }), { duration: 0.7 });
  await waitForAgentTurn(BILLING.branch);
  await director.hold(0.8);

  // The panel is a tab in the sidebar, beside Diff and Files.
  await director.click(page.getByRole('button', { name: 'Toggle file panel' }), { duration: 0.7 });
  await director.click(page.getByTitle(PANEL_TITLE, { exact: true }), { duration: 0.6 });
  // The frame that shows: a new page loads in a hidden one first.
  const checks = page
    .locator(`iframe[title="${PANEL_TITLE}"]:not([aria-hidden="true"])`)
    .contentFrame();
  await expect(checks.getByText('e2e', { exact: true })).toBeVisible({ timeout: 15_000 });
  await director.hold(2.5);

  // Re-running the failed check starts it again.
  await director.click(page.getByRole('button', { name: 'Re-run failed' }), { duration: 0.8 });
  await expect(checks.getByText('Running', { exact: true }).first()).toBeVisible({
    timeout: 15_000,
  });
  await director.hold(1.8);

  // It passes; the panel catches up on its next refresh.
  setPullRequest(BILLING.branch, PULL_REQUEST_PASSED);
  director.speed(3);
  await expect(checks.getByText('All passed')).toBeVisible({ timeout: 30_000 });
  director.speed(1);
  await director.hold(2.5);

  await director.finish({
    name: 'landing-ci-panel-demo-cropped-dark',
    width: 1280,
    height: 736,
    loopFade: 0.5,
  });
});
