/**
 * Showcase: Automations. An agent task on a schedule, listed in the status
 * bar: we run it now, and the run starts in a workspace of its own, its agent
 * already at work, named for the run, while ours carries on.
 */
import { AUTH, GO, HOLD, NAV, SEARCH } from './agent-status.scene';
import {
  videoTest as test,
  CLAUDE_PRESET,
  DEFAULT_AGENT,
  expect,
  setFilePanel,
  waitForAgentAt,
  waitForAgentTurn,
  type AgentScene,
  type VideoWorld,
} from './video-fixtures';
import { ACME_API, ACME_WEB } from './worlds';

const NAME = 'Dependency updates';
const PROMPT = 'Update outdated dependencies, run the tests, and open a pull request if they pass.';

/** The run's agent: it checks what's outdated and starts updating. */
const updatesAgent: AgentScene = {
  title: '✳ Dependency updates',
  turns: [
    {
      events: [
        {
          tool: 'Bash',
          arg: 'npm outdated',
          result: [
            'vite      5.4.2   5.4.11',
            'vitest    2.0.5   2.1.8',
            'typescript 5.5.4  5.7.2',
          ],
          delay: 600,
        },
        { think: 900 },
        {
          tool: 'Bash',
          arg: 'npm install vite@5.4.11 vitest@2.1.8 typescript@5.7.2',
          result: ['changed 3 packages in 4s'],
          delay: 900,
        },
        { waitFor: HOLD },
      ],
    },
  ],
};

const WORLD: VideoWorld = {
  projects: [ACME_WEB, ACME_API],
  workspaces: [
    { ...AUTH, minutesAgo: 2 },
    { ...NAV, minutesAgo: 15 },
    { ...SEARCH, minutesAgo: 30 },
  ],
  spawnedAgents: { [DEFAULT_AGENT]: updatesAgent },
  terminal: { font: { size: 13 } },
};

// Same aspect as a 1280×736 slot.
test.use({ world: WORLD, windowSize: { width: 1152, height: 662 } });

test('automations', async ({ appWindow: page, director }) => {
  test.setTimeout(180_000);
  const card = (title: string) =>
    page.getByRole('button', { name: `Workspace details for ${title}` });
  const terminal = page.getByRole('textbox', { name: 'Terminal input' }).filter({ visible: true });
  const item = page.getByRole('button', { name: /^Automations:/ });
  const list = page.getByRole('list', { name: 'Automations' });

  // A weekday-morning automation for the project, run by Claude Code.
  await page.evaluate(
    async ({ name, prompt, projectId, presetId }) => {
      await window.api.saveAutomation({
        name,
        prompt,
        projectId,
        target: { kind: 'local' },
        presetId,
        schedule: {
          cron: '0 9 * * 1-5',
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
        enabled: true,
        missedRunGraceMinutes: 60,
      });
    },
    {
      name: NAME,
      prompt: PROMPT,
      projectId: ACME_WEB.id,
      presetId: `video-${CLAUDE_PRESET.command}`,
    }
  );

  for (const workspace of [SEARCH, NAV]) {
    await card(workspace.title).click();
    await setFilePanel(page, false);
  }
  director.cue(SEARCH.branch, GO);
  await waitForAgentAt(NAV.branch, HOLD);
  await waitForAgentTurn(SEARCH.branch);
  await card(AUTH.title).click();
  await setFilePanel(page, false);
  await waitForAgentAt(AUTH.branch, GO);
  await expect(item).toBeVisible({ timeout: 15_000 });
  await terminal.first().focus();
  await page.mouse.move(1110, 600);

  await director.start();
  director.poster();
  director.cue(AUTH.branch, GO);
  await director.hold(1.0);

  // The status bar lists the automation and when it next runs.
  await director.click(item, { duration: 0.8 });
  await expect(list).toBeVisible();
  const popover = page.getByRole('dialog').filter({ has: list });
  await director.camera(popover, { padding: 80, duration: 0.6 });
  await director.hold(1.4);
  // Run it now rather than waiting for Monday.
  await director.click(page.getByRole('button', { name: `Run ${NAME} now` }), { duration: 0.6 });
  await director.hold(0.6);
  await director.camera('full', { duration: 0.6 });
  await director.press('Escape', { badge: false });

  // The run starts in a workspace of its own, while ours carries on.
  // Named for the automation.
  const run = card(NAME);
  await expect(run).toBeVisible({ timeout: 30_000 });
  await director.camera({ x: 0, y: 0, width: 576, height: 331 }, { padding: 0, duration: 0.6 });
  await director.hold(1.6);
  await director.camera('full', { duration: 0.6 });
  await director.click(run, { duration: 0.7 });
  await director.hold(2.4);

  await director.finish({
    name: 'showcase-automations-dark',
    width: 1280,
    height: 736,
    loopFade: 0.5,
  });
});
