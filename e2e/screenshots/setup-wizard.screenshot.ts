import { freshTest as test, expect } from '../screenshot-fixtures';

test.describe('Setup Wizard Screenshots', () => {
  test('capture all wizard steps', async ({ appWindow, takeScreenshot }) => {
    // Step 1: AI Agent selection
    await expect(appWindow.getByText('Choose Your AI Agent')).toBeVisible({ timeout: 15_000 });
    await takeScreenshot('setup-wizard-step1-agent');

    // Step 2: Setup Integrations
    await appWindow.getByRole('button', { name: 'Continue' }).click();
    await expect(appWindow.getByText('Set Up Integrations')).toBeVisible();
    await takeScreenshot('setup-wizard-step2-setup');

    // Step 3: Add project
    await appWindow.getByRole('button', { name: 'Continue' }).click();
    await expect(appWindow.getByText('Add Your First Project')).toBeVisible();
    await takeScreenshot('setup-wizard-step3-project');

    // Step 4: Features
    await appWindow.getByRole('button', { name: 'Skip for now' }).click();
    await expect(appWindow.getByRole('heading', { name: 'Features' })).toBeVisible();
    await takeScreenshot('setup-wizard-step4-features');

    // Step 5: Appearance
    await appWindow.getByRole('button', { name: 'Continue' }).click();
    await expect(appWindow.getByRole('heading', { name: 'Appearance' })).toBeVisible();
    await takeScreenshot('setup-wizard-step5-appearance');

    // Step 6: Shortcuts
    await appWindow.getByRole('button', { name: 'Continue' }).click();
    await expect(appWindow.getByRole('heading', { name: 'Essential Shortcuts' })).toBeVisible();
    await takeScreenshot('setup-wizard-step6-shortcuts');
  });
});
