/**
 * Landing video: "Describe a theme and Komla restyles itself". We answer the
 * appearance agent's question; Komla previews the theme it designs across the
 * whole window, and we apply it.
 */
import { THEME, THEME_PROMPT, THEME_WORLD } from './theme-agent.scene';
import { videoTest as test, expect, waitForAgentTurn } from './video-fixtures';

// Same aspect as the 1280×720 slot on the landing page.
test.use({ world: THEME_WORLD, windowSize: { width: 1152, height: 648 } });

test('theme agent', async ({ appWindow: page, director }) => {
  test.setTimeout(120_000);
  const review = page.getByRole('dialog', { name: 'Review settings changes' });

  await page.getByRole('button', { name: `Workspace details for ${THEME.title}` }).click();
  await page.waitForTimeout(2500); // agent banner and history
  await page.getByRole('textbox', { name: 'Terminal input' }).first().focus();

  await director.start();
  director.poster();
  await director.hold(0.6);
  await director.type(THEME_PROMPT);
  await director.hold(0.3);
  await page.keyboard.press('Enter');

  // Komla previews the theme behind its review dialog until we decide.
  await expect(review).toBeVisible({ timeout: 15_000 });
  await director.hold(1.8);
  await director.click(review.getByRole('button', { name: 'Apply changes' }), { duration: 0.7 });
  await waitForAgentTurn(THEME.branch);
  await director.hold(1.6);

  await director.finish({
    name: 'landing-theme-agent-demo-cropped-dark',
    width: 1280,
    height: 720,
    loopFade: 0.6,
  });
});
