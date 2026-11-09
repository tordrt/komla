/**
 * Landing hero: run agents in parallel and stay in control. In Card Retries,
 * Claude Code works with Codex in a pane beside it. We start a task from New
 * Workspace without leaving; Dark Mode stops for permission, its card says so,
 * and we go answer it. Pricing Page is done: its dev server opens beside the
 * agent from the globe. Rate Limiting finishes on its own, and its diff is in
 * the file panel. Then straight back to Card Retries, both agents where we left
 * them. All of it runs on an SSH host.
 */
import {
  ASK,
  CODEX_TESTS,
  DARK_MODE,
  DARK_MODE_PLAN,
  FINISH,
  GO,
  HERO_RETRIES,
  HERO_WORLD,
  HOLD,
  PREVIEW_PORT,
  PRICING,
  RATE_LIMIT,
  RECEIPTS_PROMPT,
  RECEIPTS_TITLE,
} from './hero.scene';
import {
  videoTest as test,
  agentCommand,
  expect,
  setFilePanel,
  SPLIT_RIGHT,
  waitForAgentAt,
  waitForAgentTurn,
  waitForPageLoaded,
} from './video-fixtures';

// A laptop-shaped window, wide enough for the diff's split view; renders to the 1920×1200 hero slot.
test.use({ world: HERO_WORLD, windowSize: { width: 1440, height: 900 } });

test('hero', async ({ appWindow: page, electronApp, director }) => {
  test.setTimeout(240_000);
  const card = (title: string) =>
    page.getByRole('button', { name: `Workspace details for ${title}` });
  const terminal = page.getByRole('textbox', { name: 'Terminal input' }).filter({ visible: true });
  const newWorkspace = page.getByRole('button', { name: 'New Workspace', exact: true }).first();
  const dialog = page.getByRole('dialog');
  const prompt = page.getByPlaceholder(/What should the agent work on/);
  const launch = dialog.getByRole('button', { name: /^Launch/ });
  const globe = page.getByRole('button', { name: 'Open in default browser' });
  const links = page.getByRole('dialog').filter({ hasText: 'opens in Komla' });
  const server = links.getByRole('button').filter({ hasText: `:${PREVIEW_PORT}` });
  const open = async (title: string) => {
    await card(title).click();
    await setFilePanel(page, false);
  };
  // A task typed into New Workspace, opened from the sidebar.
  const startTask = async (task: string) => {
    await director.click(newWorkspace, { duration: 0.7 });
    await expect(prompt).toBeVisible();
    director.speed(3);
    await director.type(task);
    director.speed(1);
    await director.hold(0.4);
  };

  // Each agent starts when it's first opened. Pricing Page starts its dev server; the globe
  // reads its list once, before the video starts.
  await open(PRICING.title);
  await waitForAgentAt(PRICING.branch, GO);
  await globe.click();
  await expect(server).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press('Escape');
  await expect(links).toBeHidden();
  // The diff viewer loads on first use: once here, so the video's opens at once.
  await setFilePanel(page, true);
  await page.getByRole('treeitem', { name: 'billing.css' }).click({ timeout: 15_000 });
  const diff = page.locator('.monaco-diff-editor').filter({ visible: true }).first();
  await expect(diff.locator('.view-line').first()).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole('button', { name: 'Close preview' }).click();
  await expect(diff).toBeHidden();
  await setFilePanel(page, false);
  await open(RATE_LIMIT.title);
  // Pricing Page finishes while another workspace is in view, so its Done badge stays.
  director.cue(PRICING.branch, GO);
  await waitForAgentAt(RATE_LIMIT.branch, FINISH);
  await open(DARK_MODE.title);
  // Its plan, in a markdown pane beside the agent.
  await setFilePanel(page, true);
  await page.getByRole('treeitem', { name: DARK_MODE_PLAN }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Open in Split Right' }).click();
  await expect(page.getByText('Keep contrast')).toBeVisible({ timeout: 20_000 });
  await setFilePanel(page, false);
  await waitForAgentAt(DARK_MODE.branch, ASK);
  await waitForAgentTurn(PRICING.branch);

  // Card Retries: Claude Code, with Codex writing its tests in a pane beside it.
  await open(HERO_RETRIES.title);
  await waitForAgentAt(HERO_RETRIES.branch, GO);
  await terminal.first().focus();
  await page.keyboard.press(SPLIT_RIGHT);
  await expect(terminal).toHaveCount(2);
  await terminal.last().focus();
  await page.keyboard.type(agentCommand(HERO_WORLD, CODEX_TESTS));
  await page.keyboard.press('Enter');
  await waitForAgentAt(CODEX_TESTS, HOLD);
  await terminal.first().focus();
  await expect(card(PRICING.title)).toContainText('Done');
  // Off to the side, where it can't hover anything into view.
  await page.mouse.move(1400, 870);

  await director.start();
  // The hero autoplays, so its poster is the first frame: no jump when playback starts.
  director.poster();
  // Claude Code adds the retries while Codex writes their tests.
  director.cue(HERO_RETRIES.branch, GO);
  await director.hold(0.8);

  // A task, the moment it comes to mind, without leaving Card Retries.
  await startTask(RECEIPTS_PROMPT);
  await director.click(launch, { duration: 0.5 });
  await expect(dialog).toBeHidden();
  await expect(card(RECEIPTS_TITLE)).toBeVisible({ timeout: 30_000 });
  await director.hold(0.6);

  // Dark Mode stops for permission, and its card says so.
  director.cue(DARK_MODE.branch, ASK);
  await expect(card(DARK_MODE.title)).toContainText(/input/i);
  await director.hold(0.4);

  // We go answer it...
  await director.click(card(DARK_MODE.title), { duration: 0.7 });
  await expect(terminal).toHaveCount(1);
  const asking = (await page.locator('.xterm-screen').filter({ visible: true }).boundingBox())!;
  await director.click(
    { x: asking.x + asking.width * 0.6, y: asking.y + asking.height * 0.1 },
    { duration: 0.6 }
  );
  await director.hold(0.3);
  await director.press('Enter');
  await director.hold(0.9);

  // Rate Limiting finishes on its own while we look at Pricing Page.
  director.cue(RATE_LIMIT.branch, FINISH);

  // Pricing Page is done; its dev server, forwarded from the devbox, opens beside the agent.
  await director.click(card(PRICING.title), { duration: 0.7 });
  await director.hold(0.4);
  await director.click(globe, { duration: 0.6 });
  await expect(server).toBeVisible();
  await director.hold(0.5);
  await director.click(server, { duration: 0.4, button: 'right' });
  await director.hold(0.3);
  await director.click(page.getByRole('menuitem', { name: 'Open in Split Right' }), {
    duration: 0.4,
  });
  director.speed(3);
  await waitForPageLoaded(electronApp, `:${PREVIEW_PORT}/`);
  director.speed(1);
  await director.hold(1.6);

  // Rate Limiting's changes, in the file panel.
  await expect(card(RATE_LIMIT.title)).toContainText('Done', {
    timeout: 15_000,
  });
  await director.click(card(RATE_LIMIT.title), { duration: 0.7 });
  await director.click(page.getByRole('button', { name: 'Toggle file panel' }), {
    duration: 0.6,
  });
  const file = page.getByRole('treeitem', { name: 'rate-limit.ts' });
  await expect(file).toBeVisible({ timeout: 15_000 });
  await director.hold(0.4);
  await director.click(file, { duration: 0.5 });
  await expect(diff.locator('.view-line').first()).toBeVisible({
    timeout: 15_000,
  });
  await director.hold(2.0);

  // ...and straight back, both agents where we left them.
  await director.click(card(HERO_RETRIES.title), { duration: 0.7 });
  await expect(terminal).toHaveCount(2);
  await director.hold(2.0);

  await director.finish({
    name: 'komla-demo',
    width: 1920,
    height: 1200,
    loopFade: 0.6,
  });
});
