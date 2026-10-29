/**
 * Landing hero: a working session. Agents work across two projects, each
 * workspace laid out its own way. Claude Code ticks off its plan beside Codex;
 * Yearly Billing shipped and is tagged CI running, and its status bar item
 * shows how its checks stand. Dark Mode stops for permission and we answer it,
 * Rate Limiting finishes, and then Yearly Billing's checks pass. All of it runs
 * on an SSH host.
 */
import {
  ASK,
  CARD_RETRIES,
  CODEX_TESTS,
  DARK_MODE,
  FINISH,
  GO,
  HERO_WORLD,
  HOLD,
  PLAN,
  PREVIEW,
  PREVIEW_PORT,
  PULL_REQUEST_APPROVED,
  PULL_REQUEST_RUNNING,
  RATE_LIMIT,
  SHIP_PROMPT,
  YEARLY_BILLING,
} from './hero.scene';
import { writeCiHook } from './pull-request.scene';
import {
  videoTest as test,
  agentCommand,
  expect,
  openBrowserBeside,
  setFilePanel,
  setPullRequest,
  waitForAgentAt,
  waitForAgentTurn,
  waitForPageLoaded,
} from './video-fixtures';

// A laptop-shaped window, tall enough for stacked panes; renders to the 1920×1200 hero slot.
test.use({ world: HERO_WORLD, windowSize: { width: 1280, height: 800 } });

test('hero', async ({ appWindow: page, electronApp, director }) => {
  test.setTimeout(240_000);
  const card = (title: string) =>
    page.getByRole('button', { name: `Workspace details for ${title}` });
  const terminal = page.getByRole('textbox', { name: 'Terminal input' }).filter({ visible: true });
  // A sidebar card with keyboard focus opens its info popover, so keep focus in the terminal.
  const focusTerminal = () => terminal.first().focus();
  const run = async (command: string) => {
    await page.keyboard.type(command);
    await page.keyboard.press('Enter');
  };
  const billing = card(YEARLY_BILLING.title);
  const pullRequest = page.getByRole('button', { name: /^Pull request:/ });
  const checks = page.getByRole('dialog').filter({ hasText: 'checks passed' });
  // Tagged by the hooks guide's CI script, which leaves the notifying to Komla's own.
  const tagCi = () => writeCiHook({ notify: false });
  // Komla's read of its pull request, by the id Komla gave it on the SSH host.
  const readPullRequest = () =>
    page.evaluate(async (branch) => {
      const workspaces = await window.api.getWorkspaces();
      const { id } = workspaces.find((workspace) => workspace.branchName === branch)!;
      return window.api.getWorkspacePullRequestStatus(id);
    }, YEARLY_BILLING.branch);

  // Rate Limiting works in the background; its agent starts when it's first opened.
  await card(RATE_LIMIT.title).click();
  await waitForAgentAt(RATE_LIMIT.branch, FINISH);

  // Dark Mode: the diff of its theme tokens beside the agent, which is about to ask.
  await card(DARK_MODE.title).click();
  await waitForAgentAt(DARK_MODE.branch, ASK);
  await setFilePanel(page, true);
  await page.getByRole('treeitem', { name: 'tokens.css' }).click();
  await expect(page.locator('.monaco-diff-editor .view-line').first()).toBeVisible({
    timeout: 20_000,
  });

  // Yearly Billing: its page in a browser beside the agent, which then ships it.
  await billing.click();
  // The terminal and the page share the width.
  await setFilePanel(page, false);
  await waitForAgentAt(YEARLY_BILLING.branch, PREVIEW);
  await openBrowserBeside(page);
  director.cue(YEARLY_BILLING.branch, PREVIEW);
  await waitForAgentTurn(YEARLY_BILLING.branch);
  await waitForPageLoaded(electronApp, `:${PREVIEW_PORT}/`);
  // GitHub has the pull request once the agent pushes; see setPullRequest().
  setPullRequest(YEARLY_BILLING.branch, PULL_REQUEST_RUNNING);
  await focusTerminal();
  await run(SHIP_PROMPT);
  await waitForAgentTurn(YEARLY_BILLING.branch, 2);
  // The hook's next run finds the checks under way.
  tagCi();
  await expect(billing.getByText('CI running', { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(pullRequest).toHaveAccessibleName(/CI running/, { timeout: 20_000 });
  // Long enough for Komla to count the agent's finish as seen, or its Done badge would show.
  await page.waitForTimeout(2500);
  // Its pane keeps a Done border until it's clicked, which would show when we come back.
  const shipping = (await page.locator('.xterm-screen').filter({ visible: true }).boundingBox())!;
  await page.mouse.click(shipping.x + shipping.width * 0.6, shipping.y + shipping.height * 0.1);

  // Card Retries: Claude Code with Codex below it, and the plan open beside them.
  await card(CARD_RETRIES.title).click();
  await setFilePanel(page, true);
  await page.getByRole('treeitem', { name: PLAN }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Open in Split Right' }).click();
  await expect(page.getByText('Never retry')).toBeVisible({ timeout: 20_000 });
  await setFilePanel(page, false);
  await waitForAgentAt(CARD_RETRIES.branch, GO);
  await focusTerminal();
  await page.keyboard.press('ControlOrMeta+Shift+d');
  await expect(terminal).toHaveCount(2);
  await terminal.last().focus();
  await run(agentCommand(HERO_WORLD, CODEX_TESTS));
  await waitForAgentAt(CODEX_TESTS, HOLD);
  await focusTerminal();
  await expect(billing).not.toContainText('Done');
  // Off to the side, where it can't hover anything into view.
  await page.mouse.move(1240, 770);

  // The sidebar's cards, at the window's aspect.
  const cards = await Promise.all(
    [YEARLY_BILLING, DARK_MODE, CARD_RETRIES, RATE_LIMIT].map(
      async ({ title }) => (await card(title).boundingBox())!
    )
  );
  const sidebarHeight = Math.max(...cards.map((box) => box.y + box.height)) + 16;
  const sidebar = { x: 0, y: 0, width: sidebarHeight * 1.6, height: sidebarHeight };

  await director.start();
  // The hero autoplays, so its poster is the first frame: no jump when playback starts.
  director.poster();
  // Claude Code adds the retries and ticks the step off its plan.
  director.cue(CARD_RETRIES.branch, GO);
  await director.hold(2.6);

  // Yearly Billing's checks are running, and its status bar item shows how far they've got.
  await director.click(billing, { duration: 0.8 });
  await director.hold(0.7);
  await director.click(pullRequest, { duration: 0.8 });
  await expect(checks).toBeVisible();
  await director.camera(checks, { padding: 180, duration: 0.7 });
  await director.hold(0.5);
  await director.moveTo(checks.getByRole('button', { name: /unit tests/ }), { duration: 0.5 });
  await director.hold(1.8);
  await director.camera('full', { duration: 0.7 });
  await director.press('Escape');
  await expect(checks).toBeHidden();

  // Dark Mode stops for permission, and we go answer it.
  director.cue(DARK_MODE.branch, ASK);
  director.speed(2);
  await expect(card(DARK_MODE.title)).toContainText(/input/i);
  director.speed(1);
  await director.hold(0.8);
  await director.click(card(DARK_MODE.title), { duration: 0.8 });
  await expect(page.getByRole('radio', { name: 'Split' })).toBeVisible();
  await director.hold(0.8);
  // A blank spot in the agent's terminal, clear of the prompt's options.
  const asking = (await page.locator('.xterm-screen').filter({ visible: true }).boundingBox())!;
  await director.click(
    { x: asking.x + asking.width * 0.6, y: asking.y + asking.height * 0.1 },
    { duration: 0.6 }
  );
  await director.hold(0.3);
  await director.press('Enter');
  await director.hold(0.8);

  // Rate Limiting finishes in the background.
  director.cue(RATE_LIMIT.branch, FINISH);
  await director.camera(sidebar, { padding: 0, duration: 0.7 });
  director.speed(2);
  await expect(card(RATE_LIMIT.title)).toContainText('Done', { timeout: 15_000 });
  director.speed(1);
  await director.hold(1.2);

  // Then Yearly Billing's checks pass, and Komla notifies.
  setPullRequest(YEARLY_BILLING.branch, PULL_REQUEST_APPROVED);
  director.speed(3);
  // Komla reads the checks it watches every half minute; this read stands in for the next one.
  await expect(async () => {
    await readPullRequest();
    await expect(billing.getByText('CI', { exact: true })).toBeVisible({ timeout: 1000 });
  }).toPass({ intervals: [1000], timeout: 30_000 });
  director.speed(1);
  // The hook's next run finds them passed and drops the CI running tag.
  tagCi();
  await director.moveTo(billing.getByText('CI', { exact: true }), { duration: 0.7 });
  await expect(billing.getByText('CI running', { exact: true })).toBeHidden({ timeout: 15_000 });
  await director.hold(1.2);

  // Back in Yearly Billing, its item shows every check passed.
  await director.camera('full', { duration: 0.7 });
  await director.click(billing, { duration: 0.5 });
  await expect(pullRequest).toHaveAccessibleName(/CI passed/, { timeout: 15_000 });
  await director.hold(0.5);
  await director.click(pullRequest, { duration: 0.8 });
  await expect(checks).toBeVisible();
  await director.camera(checks, { padding: 180, duration: 0.7 });
  await director.hold(2.2);
  await director.camera('full', { duration: 0.7 });
  await director.press('Escape');
  await expect(checks).toBeHidden();
  await director.hold(0.8);

  await director.finish({
    name: 'komla-demo',
    width: 1920,
    height: 1200,
    loopFade: 0.6,
  });
});
