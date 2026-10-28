/**
 * Landing video: "Review, roll back and edit every agent change in one place".
 * The agent edits files while the Diff panel fills in, then we open a split
 * diff, revert the block where it dropped a nav link, tweak a line in place
 * and save.
 */
import { DARK_MODE_PROMPT, DARK_MODE_WORKSPACE } from './change-review.scene';
import { hostExec } from './ssh-host';
import { videoTest as test, expect, waitForAgentTurn } from './video-fixtures';
import { acmeWorld } from './worlds';

const world = acmeWorld([DARK_MODE_WORKSPACE]);
// Wide enough that the diff stays side by side: Monaco falls back to the
// inline view below 900px.
test.use({ world, windowSize: { width: 1440, height: 828 } });

test('change review', async ({ appWindow: page, director }) => {
  test.setTimeout(120_000);
  const diffEditor = page.locator('.monaco-diff-editor').first();

  // Load Monaco once off camera so the first diff opens instantly on camera.
  await page.getByRole('button', { name: 'Workspace details for Search API' }).click();
  await page.getByRole('treeitem', { name: 'search.ts' }).click();
  await expect(diffEditor.locator('.view-line').first()).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Close preview' }).click();

  await page.getByRole('button', { name: 'Workspace details for Dark Mode' }).click();
  await expect(page.getByText('No changes yet').filter({ visible: true })).toBeVisible();
  await page.waitForTimeout(2500); // agent banner
  await page.getByRole('textbox', { name: 'Terminal input' }).first().focus();

  await director.start();
  await director.hold(0.5);
  await director.type(DARK_MODE_PROMPT);
  await director.hold(0.3);
  await page.keyboard.press('Enter');
  await waitForAgentTurn(DARK_MODE_WORKSPACE.branch);
  await director.hold(0.4);

  await director.click(page.getByRole('treeitem', { name: 'Header.tsx' }), { duration: 0.8 });
  const original = diffEditor.locator('.editor.original');
  const modified = diffEditor.locator('.editor.modified');
  const docsLine = original.locator('.view-line').filter({ hasText: 'Docs</Link>' });
  const toggleLine = modified.locator('.view-line').filter({ hasText: '<ThemeToggle label=' });
  await expect(docsLine).toBeVisible();
  await expect(toggleLine).toBeVisible();
  const box = (await diffEditor.boundingBox())!;
  // Frame both sides of the diff's changes at ~1.4x.
  await director.camera(
    { x: box.x - 10, y: box.y - 50, width: box.width + 20, height: 480 },
    { padding: 0 }
  );
  await director.hold(1.2);
  director.poster();

  // Roll back the block where the agent dropped the Docs link. Every block has
  // a revert button in the gutter, shown on hover; take the one level with it.
  const revertButtons = diffEditor.getByRole('button', { name: 'Revert Block' });
  const docsY = (await docsLine.boundingBox())!.y;
  const buttonYs = await revertButtons.evaluateAll((els) =>
    els.map((el) => el.getBoundingClientRect().y)
  );
  const nearest = buttonYs.reduce(
    (best, y, i) => (Math.abs(y - docsY) < Math.abs(buttonYs[best] - docsY) ? i : best),
    0
  );
  const revert = revertButtons.nth(nearest);
  await director.moveTo(revert, { duration: 0.9 });
  await director.hold(0.4);
  await director.click(revert, { duration: 0.1 });
  await expect(modified.locator('.view-line').filter({ hasText: 'Docs</Link>' })).toBeVisible();
  await director.hold(0.9);

  // Edit the agent's change in place: label="Dark mode" → label="Dark mode toggle".
  // Keep Monaco's word suggestions out of the shot.
  await page.addStyleTag({
    content: '.monaco-editor .suggest-widget { display: none !important; }',
  });
  const text = (await toggleLine.locator('span').first().boundingBox())!;
  await director.click(
    { x: text.x + text.width - 4, y: text.y + text.height / 2 },
    { duration: 0.6 }
  );
  await page.keyboard.press('End');
  for (let i = 0; i < '" />'.length; i++) await page.keyboard.press('ArrowLeft');
  await director.type(' toggle', { delay: 55 });
  await director.hold(0.3);
  await director.press('Meta+s');
  await director.hold(0.4);
  // When the save lands, Komla swaps in a freshly loaded diff and briefly
  // draws a blank or pre-save one; cut straight to the new diff.
  director.speed(1000);
  await expect(page.getByText('6 hidden lines').filter({ visible: true }).first()).toBeVisible();
  await page.waitForTimeout(300);
  director.speed(1);
  await director.hold(0.6);

  await director.camera('full', { duration: 0.8 });
  await director.hold(1.4);

  await director.finish({
    name: 'landing-diff-demo-cropped-dark',
    width: 1280,
    height: 736,
    loopFade: 0.5,
  });

  // The save wrote both the revert and the edit to the devbox.
  const header = hostExec(
    `cat "$(grep -rl --include=Header.tsx 'ThemeToggle label' . | head -n 1)"`
  );
  expect(header).toContain('<Link href="/docs">Docs</Link>');
  expect(header).toContain('<ThemeToggle label="Dark mode toggle" />');
});
