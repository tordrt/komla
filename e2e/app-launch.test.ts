import { test, expect } from './electron-app';

test.describe('App Launch', () => {
  test('window opens with correct title', async ({ appWindow }) => {
    const title = await appWindow.title();
    expect(title).toBe('Komla');
  });

  test('root element renders', async ({ appWindow }) => {
    const root = appWindow.locator('#root');
    await expect(root).toBeAttached();
  });

  test('shows SetupWizard on fresh launch', async ({ appWindow }) => {
    // Fresh sandbox has no projects and agentSetupComplete is false,
    // so the SetupWizard should appear (see App.tsx:323)
    const heading = appWindow.getByText('Welcome to Komla');
    await expect(heading).toBeVisible({ timeout: 15_000 });
  });

  test('main process is accessible', async ({ electronApp }) => {
    // Verify we can evaluate code in the main process
    const pid = await electronApp.evaluate(({ app: _app }) => process.pid);
    expect(pid).toBeGreaterThan(0);
  });
});
