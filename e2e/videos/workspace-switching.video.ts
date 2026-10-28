/**
 * Landing video: "Switch workspaces without losing your place". Four agents
 * work in workspaces laid out their own way: a page beside its agent, an open
 * diff, three panes, and tabs. We step down the sidebar with ⌘↓, which skips
 * the stopped workspaces below them, and round to the top, and each is as we
 * left it, with its agent further along.
 */
import { MANAGED_TMUX_SOCKET_NAME } from '../../src/shared/lib/ssh-tmux-attach';

import {
  CODEX_TESTS,
  DARK_MODE,
  GO,
  HOLD,
  PREVIEW,
  PRICING,
  PRICING_PORT,
  RATE_LIMIT,
  RATE_LIMIT_REVIEW,
  RETRIES,
  SWITCH_WORLD,
} from './workspace-switching.scene';
import { hostExec } from './ssh-host';
import {
  videoTest as test,
  agentCommand,
  expect,
  openBrowserBeside,
  waitForAgentAt,
  type VideoWorkspace,
} from './video-fixtures';

// Same aspect as the 1280×736 slot on the landing page.
test.use({ world: SWITCH_WORLD, windowSize: { width: 1152, height: 662 } });

test('workspace switching', async ({ appWindow: page, electronApp, director }) => {
  test.setTimeout(180_000);
  const card = (workspace: VideoWorkspace) =>
    page.getByRole('button', { name: `Workspace details for ${workspace.title}` });
  const terminal = page.getByRole('textbox', { name: 'Terminal input' }).filter({ visible: true });
  const toggleFilePanel = () => page.getByRole('button', { name: 'Toggle file panel' }).click();
  const run = async (command: string) => {
    await page.keyboard.type(command);
    await page.keyboard.press('Enter');
  };

  // Card Retries: Claude Code, with Codex beside it and the tests below.
  await card(RETRIES).click();
  await toggleFilePanel();
  await waitForAgentAt(RETRIES.branch, GO);
  // Its retries land before the tests run.
  director.cue(RETRIES.branch, GO);
  await terminal.first().focus();
  await page.keyboard.press('Meta+d');
  await expect(terminal).toHaveCount(2);
  await run(agentCommand(SWITCH_WORLD, CODEX_TESTS));
  await waitForAgentAt(CODEX_TESTS, HOLD);
  await waitForAgentAt(RETRIES.branch, HOLD);
  await page.keyboard.press('Meta+Shift+d');
  await expect(terminal).toHaveCount(3);
  await run('npm test');

  // Rate Limiting: Claude Code in one tab, Codex reviewing in another.
  await card(RATE_LIMIT).click();
  await waitForAgentAt(RATE_LIMIT.branch, HOLD);
  await terminal.first().focus();
  await page.keyboard.press('Meta+t');
  await expect(terminal).toHaveCount(1);
  await run(agentCommand(SWITCH_WORLD, RATE_LIMIT_REVIEW));
  await waitForAgentAt(RATE_LIMIT_REVIEW, GO);
  // The file tree rather than the changes, next to the tabs.
  await page.getByRole('button', { name: 'Files', exact: true }).last().click();

  // Dark Mode: the diff of the file its agent is editing.
  await card(DARK_MODE).click();
  await waitForAgentAt(DARK_MODE.branch, GO);
  await page.getByRole('treeitem', { name: 'Header.tsx' }).click();
  await expect(page.locator('.monaco-diff-editor .view-line').first()).toBeVisible({
    timeout: 20_000,
  });
  // Beside the agent rather than over it.
  await page.getByRole('radio', { name: 'Split' }).click();

  // Pricing Page: the page in a browser beside its agent, about to be restyled.
  await card(PRICING).click();
  await waitForAgentAt(PRICING.branch, PREVIEW);
  await openBrowserBeside(page);
  director.cue(PRICING.branch, PREVIEW);
  await waitForAgentAt(PRICING.branch, GO);
  await expect
    .poll(
      () =>
        electronApp.evaluate(({ BrowserWindow }, port) => {
          const [win] = BrowserWindow.getAllWindows();
          return win.contentView.children.some((view) => {
            if (!('webContents' in view) || !view.getVisible()) return false;
            const { webContents } = view as Electron.WebContentsView;
            return webContents.getURL().includes(`:${port}/`) && !webContents.isLoading();
          });
        }, PRICING_PORT),
      { intervals: [100], timeout: 30_000 }
    )
    .toBe(true);
  // The page gets the width.
  await toggleFilePanel();
  // Show each workspace once more, so none is shown again for the first time on camera.
  const running = SWITCH_WORLD.workspaces.filter((workspace) => !workspace.stopped);
  for (let i = 0; i < running.length; i++) {
    await terminal.first().focus();
    await page.keyboard.press('Meta+ArrowDown');
    await page.waitForTimeout(1000);
  }
  // Dark Mode's terminal keeps lines its agent drew while the terminal was
  // narrower than tmux's client, wrapped and stacked. Reset it, and leave the
  // copy mode that puts tmux in; start() has tmux repaint the screen.
  await terminal.first().focus();
  await page.keyboard.press('Meta+2');
  await page.waitForTimeout(1000);
  const darkTab = page.locator('[data-tab-id]').filter({ visible: true }).first();
  await electronApp.evaluate(
    ({ BrowserWindow }, id) =>
      BrowserWindow.getAllWindows()[0].webContents.send('terminal:reset', id),
    await darkTab.getAttribute('data-tab-id')
  );
  await page.waitForTimeout(500);
  const tmux = `tmux -L ${MANAGED_TMUX_SOCKET_NAME}`;
  hostExec(
    `${tmux} list-panes -a -F '#{pane_id} #{pane_in_mode}' | while read -r pane mode; do [ "$mode" = 1 ] && ${tmux} send-keys -t "$pane" -X cancel; done; true`
  );
  await terminal.first().focus();
  await page.keyboard.press('Meta+1');
  await page.waitForTimeout(1000);
  // A sidebar card with keyboard focus opens its info popover, so keep focus in the terminal.
  await terminal.first().focus();
  // Setup keys sometimes reach the pricing agent's prompt; clear them.
  await page.keyboard.press('Control+u');
  await page.mouse.move(1100, 620);

  await director.start();
  // The video autoplays, so its poster is the first frame: no jump when playback starts.
  director.poster();
  await director.hold(0.6);
  director.cue(PRICING.branch, GO);
  await director.hold(0.4);

  // Komla focuses each workspace's terminal as it opens, so ⌘↓ keeps reaching it.
  await director.press('Meta+ArrowDown');
  director.cue(DARK_MODE.branch, GO);
  await director.hold(1.4);

  await director.press('Meta+ArrowDown');
  await director.hold(1.6);

  await director.press('Meta+ArrowDown');
  director.cue(RATE_LIMIT_REVIEW, GO);
  await director.hold(1.8);

  // Round to the pricing page, finished while we were away.
  await director.press('Meta+ArrowDown');
  await director.hold(1.8);

  await director.finish({
    name: 'landing-workspace-switching-demo-cropped-dark',
    width: 1280,
    height: 736,
    loopFade: 0.6,
  });
});
