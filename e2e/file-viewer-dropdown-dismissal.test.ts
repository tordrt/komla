import { fileViewerTest as test, expect } from './screenshot-fixtures';

test('dropdowns do not dismiss the fullscreen diff viewer', async ({ appWindow }) => {
  const workspaceCard = appWindow.getByText('demo-workspace').first();
  await expect(workspaceCard).toBeVisible({ timeout: 15_000 });
  await workspaceCard.click({ force: true });

  // The full-window diff viewer, by its shortcut (Cmd+Shift+G on macOS, where Cmd+Shift+D splits
  // the pane, and Ctrl+Shift+D elsewhere).
  await appWindow.keyboard.press(
    process.platform === 'darwin' ? 'Meta+Shift+G' : 'Control+Shift+D'
  );

  const dialog = appWindow.getByRole('dialog', { name: 'demo-workspace' });
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await expect(dialog.locator('.monaco-editor').first()).toBeVisible({ timeout: 10_000 });

  const dismissMenuInsideViewer = async () => {
    // Click low in the text editor (not the split diff's gutter): the menus drop down from the
    // toolbars above it and can cover its top edge.
    const editorBounds = await dialog.locator('.monaco-editor:not(.gutter)').first().boundingBox();
    expect(editorBounds).not.toBeNull();
    // Radix starts listening for outside clicks a tick after a menu mounts, so a click that
    // lands right after the menu appears can be missed on fast machines; retry until it closes.
    await expect(async () => {
      await appWindow.mouse.click(
        editorBounds!.x + 20,
        editorBounds!.y + editorBounds!.height - 20
      );
      await expect(appWindow.locator('[role="menu"]')).toBeHidden({ timeout: 1_000 });
    }).toPass({ timeout: 10_000 });
    await expect(appWindow.getByPlaceholder('Filter branches...')).toBeHidden();
    await expect(dialog).toBeVisible();
  };

  await dialog.getByRole('button', { name: /^Compare:/ }).click();
  await expect(appWindow.getByPlaceholder('Filter branches...')).toBeVisible();
  await dismissMenuInsideViewer();

  // The viewer covers the status bar, so its branch menus are in its own top row.
  const branchButtons = dialog.getByRole('button', { name: 'main', exact: true });

  await branchButtons.first().click();
  await expect(appWindow.getByRole('menuitem', { name: 'Commit changes…' })).toBeVisible();
  await dismissMenuInsideViewer();

  await branchButtons.nth(1).click();
  await expect(appWindow.getByText('Target branch', { exact: false }).first()).toBeVisible();
  await dismissMenuInsideViewer();

  await appWindow.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});
