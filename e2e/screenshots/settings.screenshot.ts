import { configuredTest as test, expect } from '../screenshot-fixtures';

test.describe('Settings Screenshots', () => {
  test('capture all settings tabs', async ({ appWindow, takeScreenshot }) => {
    // Wait for main UI to load
    await expect(appWindow.getByRole('button', { name: /New Workspace/ })).toBeVisible({
      timeout: 15_000,
    });

    // Open settings — the gear icon is the last button in the title bar
    const settingsBtn = appWindow.locator('[data-komla-title-bar="true"] button').last();
    await settingsBtn.click();

    // Wait for dialog to appear and animate in
    await expect(appWindow.locator('[role="dialog"]')).toBeVisible();
    await appWindow.waitForTimeout(300);

    // General tab (default)
    await takeScreenshot('settings-general');

    // AI Agent tab
    await appWindow.getByRole('tab', { name: 'Agent CLIs' }).click();
    await appWindow.waitForTimeout(200);
    await takeScreenshot('settings-agent');

    // Projects tab
    await appWindow.getByRole('tab', { name: 'Projects' }).click();
    await appWindow.waitForTimeout(200);
    await takeScreenshot('settings-projects');

    // License tab
    await appWindow.getByRole('tab', { name: 'License' }).click();
    await appWindow.waitForTimeout(200);
    await takeScreenshot('settings-license');
  });
});
