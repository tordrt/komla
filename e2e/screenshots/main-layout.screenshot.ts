import { configuredTest as test, expect } from '../screenshot-fixtures';

test.describe('Main Layout Screenshots', () => {
  test('capture main app layout', async ({ appWindow, takeScreenshot }) => {
    // Wait for the main UI to load (New Workspace button is visible)
    await expect(appWindow.getByRole('button', { name: /New Workspace/ })).toBeVisible({
      timeout: 15_000,
    });

    await takeScreenshot('main-layout');
  });
});
