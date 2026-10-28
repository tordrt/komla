/**
 * Landing hero: from an empty Komla, a workspace launched on an SSH host fans a
 * pricing-page redesign out to four more, then we hop through them as each
 * page restyles live beside its agent.
 */
import {
  DESIGNS,
  HERO_WORLD,
  LEAD_AGENT,
  LEAD_PROMPT,
  LEAD_TITLE,
  PREVIEW_CUE,
  RESTYLE_CUE,
} from './hero.scene';
import {
  videoTest as test,
  expect,
  openBrowserBeside,
  waitForAgentAt,
  waitForAgentTurn,
} from './video-fixtures';

// Same aspect as the 1920×822 hero slot on the landing page.
test.use({ world: HERO_WORLD, windowSize: { width: 1336, height: 572 } });

test('hero', async ({ appWindow: page, electronApp, director }) => {
  test.setTimeout(300_000);
  const terminal = page.getByRole('textbox', { name: 'Terminal input' }).filter({ visible: true });
  // A sidebar card with keyboard focus opens its info popover, so keep focus in the terminal.
  const focusTerminal = () => terminal.first().focus();
  const card = (title: string) =>
    page.getByRole('button', { name: `Workspace details for ${title}` });
  // The pages are tunnelled from the host, so each loads from a port on this computer.
  const pageShowing = () =>
    expect
      .poll(
        () =>
          electronApp.evaluate(({ BrowserWindow }) => {
            const [win] = BrowserWindow.getAllWindows();
            return win.contentView.children.some((view) => {
              if (!('webContents' in view) || !view.getVisible()) return false;
              const { webContents } = view as Electron.WebContentsView;
              const url = webContents.getURL();
              return url.startsWith('http://127.0.0.1:') && !webContents.isLoading();
            });
          }),
        { intervals: [50], timeout: 30_000 }
      )
      .toBe(true);

  // Off to the side, where it can't hover anything into view.
  await page.mouse.move(1250, 530);

  await director.start();
  // The hero autoplays, so its poster is the first frame: no jump when playback starts.
  director.poster();
  await director.hold(0.6);
  await director.press('Meta+n');
  const prompt = page.getByPlaceholder(/What should the agent work on/);
  await expect(prompt).toBeVisible();
  await prompt.focus();
  await director.camera(page.getByRole('dialog'), { padding: 60, duration: 0.6 });
  await director.hold(0.4);
  director.speed(2.5);
  await director.type(LEAD_PROMPT, { delay: 30 });
  director.speed(1);
  await director.hold(0.6);
  await director.press('Enter');
  await director.camera('full', { duration: 0.6 });

  // Komla clones and creates the worktree on the host, then the agent gets the
  // prompt, names its workspace and spawns four more over MCP.
  director.speed(3);
  await expect(page.getByRole('button', { name: /^Workspace details for / }).first()).toBeVisible({
    timeout: 60_000,
  });
  director.speed(2);
  await waitForAgentTurn(LEAD_AGENT, 1, 120_000);
  director.speed(1);
  await director.hold(0.6);

  // Off the beat, give each design workspace a browser beside its agent and let the agent open
  // its page there. The first visit also starts the SSH tunnel to the page.
  director.speed(4);
  for (const design of DESIGNS) await waitForAgentAt(design.branch, PREVIEW_CUE, 120_000);
  await director.offCamera(async () => {
    for (const design of DESIGNS) {
      await card(design.name).click();
      await openBrowserBeside(page);
      director.cue(design.branch, PREVIEW_CUE);
      await waitForAgentAt(design.branch, RESTYLE_CUE, 60_000);
      await pageShowing();
    }
    await card(LEAD_TITLE).click();
    await focusTerminal();
  });
  director.speed(1);

  // Sidebar shortcuts follow the order shown: newest workspace first.
  const order = await page
    .getByRole('button', { name: /^Workspace details for / })
    .evaluateAll((cards) => cards.map((el) => el.getAttribute('aria-label')));
  const shortcut = (name: string) => {
    const index = order.indexOf(`Workspace details for ${name}`);
    if (index < 0 || index > 8) throw new Error(`No ⌘1–9 shortcut for ${name} in ${order}`);
    return `Meta+${index + 1}`;
  };

  for (const design of DESIGNS) {
    await focusTerminal();
    await director.press(shortcut(design.name));
    await director.hold(0.3);
    director.cue(design.branch, RESTYLE_CUE);
    await director.hold(2.6);
  }

  // Flip through the finished designs, then back to the lead agent.
  for (const design of DESIGNS) {
    await focusTerminal();
    await director.press(shortcut(design.name));
    await director.hold(0.8);
  }
  await focusTerminal();
  await director.press(shortcut(LEAD_TITLE));
  await director.hold(1.4);

  await director.finish({
    name: 'komla-demo',
    width: 1920,
    height: 822,
    loopFade: 0.6,
  });
});
