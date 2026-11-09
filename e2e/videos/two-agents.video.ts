/**
 * Showcase: one task, two agents. In New Workspace we tick Claude Code and
 * Codex in the agent menu and launch both; each starts in a workspace of its
 * own and names itself, and we look at how each went about it.
 */
import type { Locator } from '@playwright/test';

import {
  CLAUDE_TITLE,
  CODEX_TITLE,
  GO,
  HOLD,
  PROMPT,
  RATE_LIMIT,
  RETRIES,
  SEARCH,
  TWO_AGENTS_WORLD,
} from './two-agents.scene';
import {
  videoTest as test,
  expect,
  setFilePanel,
  waitForAgentAt,
  waitForAgentTurn,
} from './video-fixtures';

// Same aspect as a 1280×736 slot.
test.use({ world: TWO_AGENTS_WORLD, windowSize: { width: 1152, height: 662 } });

test('two agents', async ({ appWindow: page, director }) => {
  test.setTimeout(180_000);
  const card = (title: string) =>
    page.getByRole('button', { name: `Workspace details for ${title}` });
  const terminal = page.getByRole('textbox', { name: 'Terminal input' }).filter({ visible: true });
  const dialog = page.getByRole('dialog');
  const prompt = page.getByPlaceholder(/What should the agent work on/);
  const agentPill = dialog.getByTitle(/^Click to select agent|^Edit parallel/);
  const menu = page.getByRole('menu');
  const claudeRow = page.getByRole('menuitem', { name: /^Show Claude Code launch modes/ });
  const claudeSkip = page.getByRole('menuitemcheckbox', {
    name: 'Claude Code, Dangerously skip permissions',
  });
  const codexRow = page.getByRole('menuitem', { name: /^Show Codex launch modes/ });
  const codexDefault = page.getByRole('menuitemcheckbox', { name: 'Codex, Default' });
  const launch = dialog.getByRole('button', { name: /^Launch/ });
  const open = async (title: string) => {
    await card(title).click();
    await setFilePanel(page, false);
  };

  await open(SEARCH.title);
  await open(RATE_LIMIT.title);
  director.cue(SEARCH.branch, GO);
  await waitForAgentAt(RATE_LIMIT.branch, HOLD);
  await waitForAgentTurn(SEARCH.branch);
  await open(RETRIES.title);
  await waitForAgentAt(RETRIES.branch, GO);
  await terminal.first().focus();
  await page.mouse.move(1110, 600);

  await director.start();
  director.poster();
  director.cue(RETRIES.branch, GO);
  await director.hold(0.6);

  await director.click(page.getByRole('button', { name: 'New Workspace', exact: true }).first(), {
    duration: 0.7,
  });
  await expect(prompt).toBeVisible();
  await director.camera(dialog, { padding: 80, duration: 0.6 });
  director.speed(3);
  await director.type(PROMPT);
  director.speed(1);
  await director.hold(0.4);

  // Both agents, from the agent menu's Select multiple.
  await director.click(agentPill, { duration: 0.6 });
  await expect(menu).toBeVisible();
  await director.camera(menu, { padding: 120, duration: 0.5 });
  await director.click(menu.getByRole('button', { name: 'Select multiple' }), { duration: 0.6 });
  // Claude Code in the mode it runs in on the devbox, and Codex in its default. Hovering an agent
  // lists its modes beside it, so the pointer crosses into that column level with the agent's row
  // before moving along it: a slant would pass over the other agent and switch the column.
  const across = async (row: Locator, column: Locator) => {
    const [from, to] = [(await row.boundingBox())!, (await column.boundingBox())!];
    await director.moveTo(
      { x: to.x + to.width / 2, y: from.y + from.height / 2 },
      { duration: 0.4 }
    );
  };
  await director.moveTo(claudeRow, { duration: 0.5 });
  await expect(claudeSkip).toBeVisible();
  await across(claudeRow, claudeSkip);
  await director.click(claudeSkip, { duration: 0.4 });
  await expect(claudeSkip).toHaveAttribute('aria-checked', 'true');
  await director.moveTo(codexRow, { duration: 0.5 });
  await expect(codexDefault).toBeVisible();
  await across(codexRow, codexDefault);
  await director.click(codexDefault, { duration: 0.4 });
  await expect(codexDefault).toHaveAttribute('aria-checked', 'true');
  await director.hold(0.6);
  await director.click(menu.getByRole('button', { name: /^Done/ }), { duration: 0.6 });
  await expect(launch).toHaveText(/Launch 2/);
  await director.camera(dialog, { padding: 80, duration: 0.5 });
  await director.hold(0.8);
  await director.click(launch, { duration: 0.5 });

  // Each starts in a workspace of its own and names itself.
  await expect(dialog).toBeHidden();
  await director.camera({ x: 0, y: 0, width: 576, height: 331 }, { padding: 0, duration: 0.6 });
  await expect(card(CLAUDE_TITLE)).toBeVisible({ timeout: 30_000 });
  await expect(card(CODEX_TITLE)).toBeVisible({ timeout: 30_000 });
  await director.hold(1.2);
  await director.camera('full', { duration: 0.6 });

  // How each went about it.
  await director.click(card(CLAUDE_TITLE), { duration: 0.7 });
  await director.hold(1.8);
  await director.click(card(CODEX_TITLE), { duration: 0.6 });
  await director.hold(2.0);

  await director.finish({
    name: 'showcase-two-agents-dark',
    width: 1280,
    height: 736,
    loopFade: 0.5,
  });
});
