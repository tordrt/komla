import { demoTest as test, expect } from '../demo-fixtures';

const PROMPT = 'textarea[placeholder*="What should the agent work on"]';

test.setTimeout(300_000);

test.describe('Demo: Hook (MCP spawn)', () => {
  test('hook — spawn parallel workspaces from one prompt', async ({
    appWindow,
    typeNaturally,
    pause,
    nativeKey,
  }) => {
    await expect(appWindow.getByRole('button', { name: /New Workspace/ })).toBeVisible({
      timeout: 15_000,
    });

    // Close the dashboard to show the empty startup screen
    await appWindow.keyboard.press('Escape');
    await pause(1);

    console.log('\n--- START RECORDING NOW — 5 second countdown... ---\n');
    await pause(5);

    // Open the launch dialog and type the MCP spawn prompt directly
    await nativeKey(45, ['command down']); // Cmd+N
    await expect(appWindow.locator('[role="dialog"]')).toBeVisible();
    await pause(1);

    await typeNaturally(
      PROMPT,
      'Redesign the website in site/ — spawn 5 komla workspaces, each with a different approach'
    );
    await pause(1);

    await nativeKey(36); // Enter
    await pause(3);

    // Wait for Claude Code to come up in the new terminal
    await expect(appWindow.locator('.xterm:visible').first()).toBeVisible({ timeout: 15_000 });
    await pause(3);

    // Accept MCP permission prompt — arrow down to "allow all", then enter
    await nativeKey(125); // ArrowDown
    await pause(0.3);
    await nativeKey(36); // Enter
    await pause(2);

    // Split pane vertically while MCP workspaces spawn in the background
    await nativeKey(42, ['command down']); // Cmd+\
    await pause(1.5);

    // Cat a pre-seeded file in the new split pane
    const splitTerminal = appWindow.locator('textarea[aria-label="Terminal input"]').last();
    await splitTerminal.focus();
    await pause(0.3);
    await appWindow.keyboard.type('cat komla-overview.md', { delay: 40 });
    await pause(0.5);
    await nativeKey(36); // Enter
    await pause(3);

    // Keep the app open for manual exploration / extra recording
    // eslint-disable-next-line no-empty
    await new Promise(() => {});
  });
});
