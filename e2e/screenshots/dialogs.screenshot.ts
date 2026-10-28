import { AGENT } from '../agent-profiles';
import { configuredTest as test, expect } from '../screenshot-fixtures';

test.describe('Dialog Screenshots', () => {
  test('capture New Workspace dialog', async ({ appWindow, takeScreenshot }) => {
    await expect(appWindow.getByRole('button', { name: /New Workspace/ })).toBeVisible({
      timeout: 15_000,
    });

    await appWindow.getByRole('button', { name: /New Workspace/ }).click();

    await expect(appWindow.locator('[role="dialog"]')).toBeVisible();
    await appWindow.waitForTimeout(300);

    const promptTextarea = appWindow.locator(
      'textarea[placeholder*="What should the agent work on"]'
    );
    await promptTextarea.click();
    await promptTextarea.type('Add settings sync with retry handling.');
    await appWindow.waitForTimeout(150);

    await appWindow.getByRole('button', { name: 'Generate branch name with AI' }).click();
    await expect(appWindow.getByText('AI generated')).toBeVisible();
    await appWindow.waitForTimeout(150);

    await takeScreenshot('dialog-new-workspace');
  });

  test('capture New Workspace dialog with launch mode and prompt', async ({
    appWindow,
    takeScreenshot,
  }) => {
    // Pick the most permissive launch mode the active agent offers — for
    // claude/codex this is "Dangerously skip permissions"; gemini calls it
    // "YOLO"; opencode only has "Plan".
    const launchMode = AGENT.launchModes?.[AGENT.launchModes.length - 1];
    if (!launchMode) {
      test.skip(true, `No launch modes defined for agent: ${AGENT.id}`);
      return;
    }

    await expect(appWindow.getByRole('button', { name: /New Workspace/ })).toBeVisible({
      timeout: 15_000,
    });

    await appWindow.getByRole('button', { name: /New Workspace/ }).click();

    await expect(appWindow.locator('[role="dialog"]')).toBeVisible();
    await appWindow.waitForTimeout(300);

    const modeButton = appWindow.locator('button[title^="Click to select agent and launch mode"]');
    await modeButton.click();
    await appWindow.waitForTimeout(100);
    await appWindow
      .getByRole('menuitem', { name: `${AGENT.displayName}, ${launchMode.name}`, exact: true })
      .click();
    await appWindow.waitForTimeout(100);

    // Type an example initial prompt — use keyboard input to trigger textarea auto-resize
    const promptTextarea = appWindow.locator(
      'textarea[placeholder*="What should the agent work on"]'
    );
    await promptTextarea.click();
    await promptTextarea.type(
      'Refactor auth to use JWT tokens instead of session cookies. Add token refresh in the middleware.'
    );
    await appWindow.waitForTimeout(200);

    await takeScreenshot('dialog-new-workspace-launch-mode');
  });

  test('capture Keyboard Shortcuts dialog', async ({ appWindow, takeScreenshot }) => {
    await expect(appWindow.getByRole('button', { name: /New Workspace/ })).toBeVisible({
      timeout: 15_000,
    });

    await appWindow.getByRole('button', { name: 'Settings', exact: true }).click();
    await appWindow.getByRole('menuitem', { name: 'Shortcuts' }).click();

    await expect(appWindow.locator('[role="dialog"]')).toBeVisible({ timeout: 5000 });
    await appWindow.waitForTimeout(300);
    await takeScreenshot('dialog-shortcuts');
  });

  test('capture Feedback dialog', async ({ appWindow, takeScreenshot }) => {
    await expect(appWindow.getByRole('button', { name: /New Workspace/ })).toBeVisible({
      timeout: 15_000,
    });

    await appWindow.getByRole('button', { name: 'Settings', exact: true }).click();
    await appWindow.getByRole('menuitem', { name: 'Feedback' }).click();

    await expect(appWindow.locator('[role="dialog"]')).toBeVisible({ timeout: 5000 });
    await appWindow.waitForTimeout(300);
    await takeScreenshot('dialog-feedback');
  });
});
