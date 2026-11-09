/**
 * Landing video: "Your agents keep working when your laptop sleeps". Agents
 * run on the devbox SSH host; Pricing Page's page is open beside its agent on
 * a port Komla forwards. The pane's devbox mark shows where the agent runs.
 * The camera pulls back to the desktop and Komla quits; the agents carry on.
 * Reopened from the dock, Komla starts up with the page showing the agent's
 * restyle and Rate Limiting done.
 */
import {
  FINISH,
  HOLD,
  NAV,
  PREVIEW,
  PREVIEW_PORT,
  PRICING,
  RATE_LIMIT,
  REMOTE_WORLD,
  RESTYLE,
} from './remote.scene';
import {
  videoTest as test,
  expect,
  openBrowserBeside,
  quitApp,
  relaunchApp,
  setFilePanel,
  waitForAgentAt,
  waitForAgentTurn,
  waitForPageLoaded,
} from './video-fixtures';

import type { Page } from '@playwright/test';

// Wide enough for the terminal and the page side by side; renders to the 1280×736 slot.
const WINDOW = { width: 1440, height: 828 };
test.use({ world: REMOTE_WORLD, windowSize: WINDOW });

test('remote', async ({ appWindow, electronApp, director }) => {
  test.setTimeout(300_000);
  let page: Page = appWindow;
  const card = (title: string) =>
    page.getByRole('button', { name: `Workspace details for ${title}` });
  const terminal = () =>
    page.getByRole('textbox', { name: 'Terminal input' }).filter({ visible: true });
  const open = async (title: string) => {
    await card(title).click();
    await setFilePanel(page, false);
  };
  const terminalSpot = async () => {
    const box = (await page
      .locator('.xterm-screen')
      .filter({ visible: true })
      .first()
      .boundingBox())!;
    return { x: box.x + box.width * 0.5, y: box.y + box.height * 0.6 };
  };

  await open(RATE_LIMIT.title);
  await waitForAgentAt(RATE_LIMIT.branch, FINISH);
  await open(NAV.title);
  await waitForAgentAt(NAV.branch, HOLD);
  // Pricing Page: its page open beside the agent, on the port Komla forwards from the devbox.
  await open(PRICING.title);
  await waitForAgentAt(PRICING.branch, PREVIEW);
  await openBrowserBeside(page);
  director.cue(PRICING.branch, PREVIEW);
  await waitForAgentTurn(PRICING.branch);
  await waitForPageLoaded(electronApp, `:${PREVIEW_PORT}/`);
  // Long enough for Komla to count the agent's finish as seen, or its Done badge would show.
  await page.waitForTimeout(2500);
  await waitForAgentAt(PRICING.branch, RESTYLE);
  await terminal().first().focus();
  await page.mouse.move(WINDOW.width - 40, WINDOW.height - 60);

  await director.start();
  // The video autoplays, so its poster is the first frame: no jump when playback starts.
  director.poster();
  await director.hold(1.0);

  // The pane's devbox mark: where the agent runs, and in which directory.
  const mark = page.getByText('devbox', { exact: true }).filter({ visible: true }).first();
  await director.moveTo(mark, { duration: 0.8 });
  await expect(page.getByTestId('remote-path')).toBeVisible();
  await director.hold(2.2);
  await director.moveTo(await terminalSpot(), { duration: 0.6 });
  await expect(page.getByTestId('remote-path')).toBeHidden();
  await director.hold(0.6);
  // Back to the desktop, and quit.
  await director.camera('desktop', { duration: 1.0 });
  await director.hold(1.0);
  director.showKeys('Meta+Q');
  await director.hold(0.6);
  await director.cut('Komla quit. The agents kept working on devbox.');

  // Closed, the agents carry on: the restyle lands and Rate Limiting finishes, its hooks queued
  // on the host until Komla is back.
  await quitApp(electronApp);
  director.cue(PRICING.branch, RESTYLE);
  director.cue(RATE_LIMIT.branch, FINISH);
  await waitForAgentTurn(PRICING.branch, 2, 60_000);
  await waitForAgentTurn(RATE_LIMIT.branch, 1, 60_000);

  // Reopened from the dock, recorded from its first frame: Komla starts up and the agents'
  // finishes, queued on the devbox while it was closed, arrive as Done.
  const relaunched = await relaunchApp(WINDOW, {
    onWindow: async (app, window) => {
      page = window;
      // The real pointer rests where it hovers nothing; the drawn one is on the dock.
      await window.mouse.move(WINDOW.width / 2, 40);
      await director.resume(app, window, { fromDock: true });
    },
  });
  try {
    await expect(card(PRICING.title)).toBeVisible({ timeout: 60_000 });
    // Reconnecting to the devbox can take a while; it plays back faster.
    director.speed(3);
    await expect(card(PRICING.title)).toContainText('Done', { timeout: 60_000 });
    await expect(card(RATE_LIMIT.title)).toContainText('Done', { timeout: 60_000 });
    director.speed(1);
    await page
      .getByRole('button', { name: 'Dismiss notification update notice' })
      .click({ timeout: 1000 })
      .catch(() => undefined);
    await director.hold(0.8);
    // In from the desktop: both agents finished while Komla was closed.
    await director.camera('full', { duration: 1.0 });
    await director.hold(0.6);
    await director.moveTo(card(PRICING.title), { duration: 0.8 });
    await director.hold(0.6);
    await director.click(card(PRICING.title), { duration: 0.3 });
    // The page reopens beside the agent, with the agent's restyle. A Linux dry run can't always
    // quit in time and is killed before Komla saves its layout, so the globe opens it again.
    director.speed(2);
    const restored = await waitForPageLoaded(relaunched.app, `:${PREVIEW_PORT}/`, {
      timeout: 6000,
    }).then(
      () => true,
      () => false
    );
    director.speed(1);
    await director.offCamera(async () => {
      await setFilePanel(page, false);
      if (restored) return;
      await page.getByRole('button', { name: 'Open in default browser' }).click();
      const links = page.getByRole('dialog').filter({ hasText: 'opens in Komla' });
      const server = links.getByRole('button').filter({ hasText: `:${PREVIEW_PORT}` });
      await server.click({ button: 'right', timeout: 15_000 });
      await page.getByRole('menuitem', { name: 'Open in Split Right' }).click();
      await waitForPageLoaded(relaunched.app, `:${PREVIEW_PORT}/`);
    });
    await director.hold(1.8);
    await director.hold(1.6);

    await director.finish({
      name: 'landing-remote-demo-cropped-dark',
      width: 1280,
      height: 736,
      loopFade: 0.5,
      desktop: true,
    });
  } catch (error) {
    await page
      .screenshot({ path: test.info().outputPath('relaunched.png') })
      .catch(() => undefined);
    throw error;
  } finally {
    await quitApp(relaunched.app);
  }
});
