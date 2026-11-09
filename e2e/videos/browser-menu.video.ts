/**
 * Landing video: "Everything your agents made, one click away". An agent
 * leaves its dev server, Firefox on a virtual desktop, an HTML audit in its
 * scratchpad and a published artifact. The globe collects them all for the
 * workspace, and the server opens beside the agent.
 */
import {
  ARTIFACT_URL,
  AUDIT,
  BROWSER_MENU_WORLD,
  DESKTOP_APP,
  PREVIEW_PORT,
  REPORT,
} from './browser-menu.scene';
import {
  videoTest as test,
  expect,
  setFilePanel,
  waitForAgentTurn,
  waitForPageLoaded,
} from './video-fixtures';

// Wide enough for the terminal and the page side by side; renders to the 1280×736 slot.
test.use({ world: BROWSER_MENU_WORLD, windowSize: { width: 1440, height: 828 } });

test('browser menu', async ({ appWindow: page, electronApp, director }) => {
  test.setTimeout(180_000);
  const terminal = page.getByRole('textbox', { name: 'Terminal input' }).filter({ visible: true });
  const globe = page.getByRole('button', { name: 'Open in default browser' });
  const links = page.getByRole('dialog').filter({ hasText: 'opens in Komla' });
  const row = (text: string) => links.getByRole('button').filter({ hasText: text });
  const desktopApp = DESKTOP_APP.split(' ')[0];
  const desktop = row(desktopApp);
  // The desktop is named after its app's command, which has the server's address in it.
  const server = row(`:${PREVIEW_PORT}`).filter({ hasNotText: desktopApp });
  const artifact = row(new URL(ARTIFACT_URL).host);
  const report = row(REPORT.split('/').at(-1)!);

  await page.getByRole('button', { name: `Workspace details for ${AUDIT.title}` }).click();
  await waitForAgentTurn(AUDIT.branch);
  // The terminal gets the width, so the agent's paths fit on a line.
  await setFilePanel(page, false);
  // The list's titles and previews are read once, before the video starts.
  await globe.click();
  await expect(server).toBeVisible({ timeout: 15_000 });
  // The page's favicon comes with the rest of its preview, which the server's hover card shows.
  await expect(server.locator('img')).toBeVisible({ timeout: 15_000 });
  await expect(artifact).toContainText('Claude', { timeout: 15_000 });
  // Listed once `komla desktop run` has started it.
  await expect(desktop).toBeVisible({ timeout: 30_000 });
  await expect(report).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(links).toBeHidden();
  await terminal.first().focus();
  await page.mouse.move(1400, 790);

  await director.start();
  director.poster();
  await director.hold(1.2);

  // The globe lists all of it: the server, the desktop, the artifact and the report.
  await director.click(globe);
  await expect(links).toBeVisible();
  await expect(server).toBeVisible();
  await director.hold(0.6);
  await director.moveTo(desktop, { duration: 0.6 });
  await director.hold(0.8);
  await director.moveTo(artifact, { duration: 0.5 });
  await director.hold(1.4);
  await director.moveTo(report, { duration: 0.5 });
  await director.hold(1.4);
  // Long enough for the server's hover card, after its 400 ms delay, to be read.
  await director.moveTo(server, { duration: 0.5 });
  await director.hold(2.2);

  // The page opens beside the agent, its port forwarded from the SSH host the agent runs on.
  await director.click(server, { duration: 0.2, button: 'right' });
  await director.hold(0.5);
  await director.click(page.getByRole('menuitem', { name: 'Open in Split Right' }), {
    duration: 0.5,
  });
  director.speed(3);
  await waitForPageLoaded(electronApp);
  director.speed(1);
  await director.hold(2.4);

  await director.finish({
    name: 'landing-browser-menu-demo-cropped-dark',
    width: 1280,
    height: 736,
    loopFade: 0.5,
  });
});
