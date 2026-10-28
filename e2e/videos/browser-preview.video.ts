/**
 * Landing video: "See what the agent built". The agent adds yearly billing and
 * starts its dev server; the globe lists that server and the docs link it
 * printed, and the server's menu opens the page in a split beside the agent,
 * where it restyles live as the agent keeps working.
 */
import {
  ANNUAL,
  STAND_OUT_PROMPT,
  BROWSER_WORLD,
  DOCS_URL,
  PREVIEW_PORT,
  YEARLY_PROMPT,
} from './browser-preview.scene';
import { videoTest as test, expect, waitForAgentTurn } from './video-fixtures';

// Wide enough for the terminal and the page side by side; renders to the 1280×736 slot.
test.use({ world: BROWSER_WORLD, windowSize: { width: 1440, height: 828 } });

test('browser preview', async ({ appWindow: page, electronApp, director }) => {
  test.setTimeout(180_000);
  const terminal = page.getByRole('textbox', { name: 'Terminal input' }).filter({ visible: true });
  const links = page.getByRole('dialog').filter({ hasText: 'opens in Komla' });
  const previewShowing = () =>
    expect
      .poll(
        () =>
          electronApp.evaluate(({ BrowserWindow }) => {
            const [win] = BrowserWindow.getAllWindows();
            return win.contentView.children.some((view) => {
              if (!('webContents' in view) || !view.getVisible()) return false;
              const { webContents } = view as Electron.WebContentsView;
              return webContents.getURL().startsWith('http') && !webContents.isLoading();
            });
          }),
        { intervals: [50], timeout: 30_000 }
      )
      .toBe(true);

  await page.getByRole('button', { name: `Workspace details for ${ANNUAL.title}` }).click();
  // The terminal and the page share the width.
  await page.getByRole('button', { name: 'Toggle file panel' }).click();
  await page.waitForTimeout(2500); // agent banner
  await terminal.first().focus();

  await director.start();
  await director.hold(0.5);
  await director.type(YEARLY_PROMPT);
  await director.hold(0.3);
  await page.keyboard.press('Enter');
  await waitForAgentTurn(ANNUAL.branch);
  await director.hold(0.8);

  // The globe lists the dev server and the docs link from the terminal.
  await director.click(page.getByRole('button', { name: 'Open in default browser' }));
  await expect(links).toBeVisible();
  const server = links.getByRole('button').filter({ hasText: `:${PREVIEW_PORT}` });
  const docs = links.getByRole('button').filter({ hasText: new URL(DOCS_URL).host });
  // Servers show once their page titles are read, or after a second.
  await expect(server).toBeVisible({ timeout: 15_000 });
  // The link's row is drawn again once the page's title is read.
  await expect(docs).toContainText('GitHub', { timeout: 15_000 });
  await director.camera(links, { padding: 120, duration: 0.7 });
  await director.hold(0.6);
  await director.moveTo(docs, { duration: 0.6 });
  await director.hold(0.9);
  await director.moveTo(server, { duration: 0.5 });
  await director.hold(0.6);
  director.poster();
  await director.click(server, { duration: 0.2, button: 'right' });
  await director.hold(0.5);
  await director.click(page.getByRole('menuitem', { name: 'Open in Split Right' }), {
    duration: 0.5,
  });
  await director.camera('full', { duration: 0.7 });

  // The first visit forwards the port from the SSH host; skim past it.
  director.speed(3);
  await previewShowing();
  director.speed(1);
  await director.hold(1.4);

  // The page restyles live as the agent keeps working.
  await director.click(page.locator('.xterm-screen').filter({ visible: true }).first(), {
    duration: 0.6,
  });
  await terminal.first().focus();
  await director.type(STAND_OUT_PROMPT);
  await director.hold(0.3);
  await page.keyboard.press('Enter');
  await waitForAgentTurn(ANNUAL.branch, 2);
  await director.hold(2);

  await director.finish({
    name: 'landing-browser-preview-demo-cropped-dark',
    width: 1280,
    height: 736,
    loopFade: 0.5,
  });
});
