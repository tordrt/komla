import { fileViewerTest as test, expect } from '../screenshot-fixtures';

test.describe('File View Screenshots', () => {
  test('capture file explorer, diff viewer, and file search', async ({
    appWindow,
    takeScreenshot,
  }) => {
    // Wait for the workspace card to appear and select it
    const workspaceCard = appWindow.getByText('demo-workspace').first();
    await expect(workspaceCard).toBeVisible({ timeout: 15_000 });
    await workspaceCard.click({ force: true });
    await appWindow.waitForTimeout(2000);

    // === File Explorer ===
    // Click the Folder icon button (1st in the title bar left group)
    const titleBarButtons = appWindow.locator('[data-komla-title-bar="true"] button');
    await titleBarButtons.first().click();

    // Wait for the file viewer dialog to open and file tree to populate
    const dialog = appWindow.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await appWindow.waitForTimeout(1000);
    await expect(dialog.locator('[data-item-path]').first()).toBeVisible({ timeout: 10_000 });

    // Expand the src folder, then src/utils subfolder
    await dialog.locator('[data-item-path="src"]').click();
    await appWindow.waitForTimeout(300);
    await dialog.locator('[data-item-path="src/utils"]').click();
    await appWindow.waitForTimeout(300);

    // Double-click helpers.ts to open it as a pinned tab
    await dialog.locator('[data-item-path="src/utils/helpers.ts"]').dblclick();
    await expect(dialog.locator('.monaco-editor')).toBeVisible({ timeout: 5000 });
    await appWindow.waitForTimeout(500);

    // Double-click README.md to open it as a second pinned tab
    await dialog.locator('[data-item-path="README.md"]').dblclick();
    await appWindow.waitForTimeout(500);

    // Single-click src/index.ts to open it as a preview tab (showcases TypeScript syntax highlighting)
    await dialog.locator('[data-item-path="src/index.ts"]').click();
    await appWindow.waitForTimeout(500);

    await takeScreenshot('file-viewer');

    // === Diff Viewer ===
    // Switch to diff mode via keyboard shortcut
    await appWindow.keyboard.press('Meta+d');
    await appWindow.waitForTimeout(1000);

    // Wait for changed-file entries and click the first one
    await expect(dialog.locator('[data-item-path]').first()).toBeVisible({ timeout: 5000 });
    await dialog.locator('[data-item-path]').first().click();

    // Wait for Monaco diff editor to load and render (split view has 2 editors)
    await expect(dialog.locator('.monaco-editor').first()).toBeVisible({ timeout: 5000 });
    await appWindow.waitForTimeout(1000);

    await takeScreenshot('diff-viewer');

    // === File Search ===
    // Close the file viewer dialog
    await appWindow.keyboard.press('Escape');
    await appWindow.waitForTimeout(300);

    // Click the MagnifyingGlass button (3rd in the title bar left group)
    await titleBarButtons.nth(2).click();

    // Wait for the search picker dialog
    const searchDialog = appWindow.locator('[role="dialog"]');
    await expect(searchDialog).toBeVisible({ timeout: 5000 });
    await appWindow.waitForTimeout(300);

    // Type a search query
    await searchDialog.locator('input[placeholder="Search files..."]').fill('helpers');
    await appWindow.waitForTimeout(500);

    await takeScreenshot('file-search');
  });
});
