/**
 * Landing video: "Ask your agent for the status bar item you want". Antigravity CLI is asked to
 * show how much of its weekly limit is left. It reads `agy -p /usage`, writes the script and the
 * item, and Komla shows the change for review. Once applied, the item is in the bar, and clicking
 * it opens each model group's share left and when it resets.
 */
import { ITEM_LABEL, PROMPT, USAGE_WORKSPACE, USAGE_WORLD } from './agy-usage.scene';
import { videoTest as test, expect, setFilePanel, waitForAgentTurn } from './video-fixtures';

// Same aspect as the 1280×736 slot on the landing page.
test.use({ world: USAGE_WORLD, windowSize: { width: 1152, height: 662 } });

test('agy usage', async ({ appWindow: page, director }) => {
  test.setTimeout(180_000);
  const review = page.getByRole('dialog', { name: 'Review settings changes' });
  const item = page.getByRole('button', { name: /Gemini 38% left/ });

  // Its agent starts when the workspace is first opened, and the terminal takes the width.
  await page
    .getByRole('button', { name: `Workspace details for ${USAGE_WORKSPACE.title}` })
    .click();
  await setFilePanel(page, false);
  await page.waitForTimeout(2500); // agent banner
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

  // The agent proposes the item, and Komla shows it before it's saved.
  director.speed(2);
  await expect(review).toBeVisible({ timeout: 30_000 });
  director.speed(1);
  await director.hold(2.0);
  await director.click(review.getByRole('button', { name: 'Apply changes' }), { duration: 0.7 });
  await waitForAgentTurn(USAGE_WORKSPACE.branch);
  await expect(item).toBeVisible({ timeout: 20_000 });
  await director.hold(1.0);

  // The item opens a popover with each model group.
  await director.click(item, { duration: 0.8 });
  const details = page.locator(`iframe[title="${ITEM_LABEL}"]`).contentFrame();
  await expect(details.getByText('Claude and GPT models')).toBeVisible({ timeout: 15_000 });
  await director.hold(3.0);

  await director.finish({
    name: 'landing-usage-item-demo-cropped-dark',
    width: 1280,
    height: 736,
    loopFade: 0.5,
  });
});
