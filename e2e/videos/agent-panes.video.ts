/**
 * Landing video: "Arrange agents and terminals your way". While Claude Code
 * works, we split its pane, swap the new shell for Codex from the pane menu,
 * open a terminal below Codex to run the tests, and drag it under Claude.
 */
import { CODEX_TESTS, GO, HOLD, PANES_WORLD, RETRIES } from './agent-panes.scene';
import { videoTest as test, expect, waitForAgentAt } from './video-fixtures';

// Same aspect as the 1280×732 slot on the landing page.
test.use({ world: PANES_WORLD, windowSize: { width: 1152, height: 659 } });

test('agent panes', async ({ appWindow: page, director }) => {
  test.setTimeout(120_000);
  const terminal = page.getByRole('textbox', { name: 'Terminal input' }).filter({ visible: true });
  // Visible panes' screens, left to right, then top to bottom.
  const panes = async () => {
    const boxes = await page.locator('.xterm-screen').filter({ visible: true }).all();
    const rects = await Promise.all(boxes.map(async (box) => (await box.boundingBox())!));
    return rects.sort((a, b) => a.x - b.x || a.y - b.y);
  };
  const menuItem = (name: string | RegExp) => page.getByRole('menuitem', { name });

  await page.getByRole('button', { name: `Workspace details for ${RETRIES.title}` }).click();
  // The terminals get the width; the file panel isn't what this video is about.
  await page.getByRole('button', { name: 'Toggle file panel' }).click();
  await waitForAgentAt(RETRIES.branch, GO);
  await terminal.first().focus();

  await director.start();
  director.poster();
  director.cue(RETRIES.branch, GO);
  await director.hold(0.8);

  // Split Claude's pane from its menu.
  const [claude] = await panes();
  await director.click(
    { x: claude.x + claude.width * 0.72, y: claude.y + claude.height * 0.3 },
    { button: 'right', duration: 0.7 }
  );
  await director.hold(0.5);
  await director.click(menuItem(/^Split Right/), { duration: 0.5 });
  await expect(terminal).toHaveCount(2);
  await director.hold(0.4);

  // Swap the new shell for Codex.
  const [, shell] = await panes();
  await director.click(
    { x: shell.x + shell.width * 0.45, y: shell.y + shell.height * 0.3 },
    { button: 'right', duration: 0.6 }
  );
  await director.hold(0.3);
  await director.moveTo(menuItem('Replace With'), { duration: 0.5 });
  // Codex's row, which starts it in its own launch mode; its launch mode icon leads the name.
  await director.click(menuItem(/Codex$/), { duration: 0.45 });
  await director.hold(1.2);

  // A terminal below Codex to run the tests.
  await director.press('Meta+Shift+d');
  await expect(terminal).toHaveCount(3);
  await director.hold(0.6);
  await director.type('npm test');
  await waitForAgentAt(CODEX_TESTS, HOLD);
  await director.hold(0.2);
  await page.keyboard.press('Enter');
  await director.hold(1.4);

  // Drag the terminal under Claude by the grip at its pane's top middle.
  const [left, , tests] = await panes();
  const grips = await page.getByTestId('pane-drag-grip').all();
  const gripBoxes = await Promise.all(grips.map((grip) => grip.boundingBox()));
  const grip = gripBoxes.find(
    (box) =>
      box &&
      box.x > tests.x &&
      box.x + box.width < tests.x + tests.width &&
      box.y < tests.y &&
      box.y > tests.y - 40
  );
  if (!grip) throw new Error('No drag grip above the tests pane');
  await director.drag(
    { x: grip.x + grip.width / 2, y: grip.y + grip.height / 2 },
    { x: left.x + left.width * 0.5, y: left.y + left.height * 0.9 },
    { duration: 1.0 }
  );
  await expect.poll(async () => (await panes())[0].height).toBeLessThan(left.height * 0.7);
  await director.hold(1.4);

  await director.finish({
    name: 'landing-agent-pane-shortcuts-demo-cropped-dark',
    width: 1280,
    height: 732,
    loopFade: 0.6,
  });
});
