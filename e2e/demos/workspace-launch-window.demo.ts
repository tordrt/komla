import { demoTestHalfWindow as test, expect } from '../demo-fixtures';

const PROMPT = 'textarea[placeholder*="What should the agent work on"]';

test.setTimeout(300_000); // 5 min — needs time for MCP finale

test.describe('Demo: Launching Workspaces (Half Window)', () => {
  test('workspace launch narrative — half window', async ({
    appWindow,
    typeNaturally,
    pause,
    nativeKey,
    nativeDoubleTapShift,
  }) => {
    // ── Wait for main UI to load ──
    await expect(appWindow.getByRole('button', { name: /New Workspace/ })).toBeVisible({
      timeout: 15_000,
    });

    // Integrations (notifications, MCP) are pre-seeded by the fixture

    // Close the dashboard to show the empty startup screen
    await appWindow.keyboard.press('Escape');
    await pause(1);

    // ── Manual prep: open a file to preload Monaco, then close it ──
    console.log(
      '\n--- Preload Monaco editor now (open & close a file), then start recording ---\n'
    );
    await pause(5);

    // ══════════════════════════════════════════════
    // RECORDING PAUSE — start your screen recorder
    // ══════════════════════════════════════════════
    console.log('\n--- START RECORDING NOW — 10 second countdown... ---\n');
    await pause(5);

    // ── Opener: MCP in action — Claude spawns workspaces itself ──
    await nativeKey(45, ['command down']); // Cmd+N
    await expect(appWindow.locator('[role="dialog"]')).toBeVisible();
    await pause(1);

    await typeNaturally(PROMPT, 'Meet Komla - a desktop app for developing with AI agents');
    await pause(1.5);
    await typeNaturally(
      PROMPT,
      '\nWork on multiple things at once. No waiting. Monitor everything at a glance.'
    );
    await pause(2);

    // Select all and delete slowly so the viewer sees what's happening
    await appWindow.locator(PROMPT).focus();
    await nativeKey(0, ['command down']); // Cmd+A
    await pause(0.5);
    await nativeKey(51); // Backspace
    await pause(0.8);

    await nativeKey(36); // Enter
    await pause(3);

    // Wait for Claude Code to start up in the terminal
    await expect(appWindow.locator('.xterm').first()).toBeVisible({ timeout: 10_000 });
    await pause(2);

    // Type the MCP prompt directly into Claude Code
    const terminalInput = appWindow.locator('textarea[aria-label="Terminal input"]').first();
    await terminalInput.click({ force: true });
    await pause(0.3);

    await appWindow.keyboard.type(
      'Come up with 5 different redesigns for the website in site/ and spawn a new komla workspace for each to implement them',
      { delay: 40 }
    );
    await pause(1);
    await nativeKey(36); // Enter
    await pause(3);

    // Accept MCP permission prompt — arrow down to "allow all", then enter
    await nativeKey(125); // ArrowDown
    await pause(0.3);
    await nativeKey(36); // Enter
    await pause(2);

    // Split pane horizontally (top/bottom) — better for half-window layout
    await nativeKey(42, ['command down', 'shift down']); // Cmd+Shift+\
    await pause(1.5);

    // Cat a pre-seeded file in the new split pane
    const splitTerminal = appWindow.locator('textarea[aria-label="Terminal input"]').last();
    await splitTerminal.focus();
    await pause(0.3);
    await appWindow.keyboard.type('cat workspace-setup.md', { delay: 40 });
    await pause(0.5);
    await nativeKey(36); // Enter
    await pause(3);

    // Let the workspaces finish appearing in the sidebar
    await pause(5);

    // ── File search + viewer showcase ──
    // Double-tap Shift via native flagsChanged CGEvents (compiled Swift binary)
    // Longer taps (200ms hold) so screen recording software can catch them
    nativeDoubleTapShift(200, 200);
    await pause(1);

    // Type to search by filename
    await appWindow.keyboard.type('built-in', { delay: 50 });
    await pause(1.5);

    // Tab to switch to content search mode
    await nativeKey(48); // Tab
    await pause(1);

    // Search for content inside files
    await nativeKey(0, ['command down']); // Cmd+A to select previous text
    await pause(0.3);
    await appWindow.keyboard.type('file viewer is working', { delay: 50 });
    await pause(1.5);

    // Enter to open the file in the viewer
    await nativeKey(36); // Enter
    await pause(3);

    // Focus the editor and go to end of file
    await appWindow.locator('.monaco-editor').first().click();
    await pause(0.5);
    await appWindow.keyboard.press('Meta+ArrowDown');
    await pause(0.5);
    await appWindow.keyboard.press('End');
    await pause(0.3);
    await appWindow.keyboard.press('Enter');
    await appWindow.keyboard.press('Enter');
    await appWindow.keyboard.type('PS: Inline edits, full-screen diff review.', {
      delay: 45,
    });
    await pause(1.5);

    // Save with Cmd+S
    await nativeKey(1, ['command down']); // Cmd+S
    await pause(1.5);

    // Click outside the Monaco editor to unfocus it so the global shortcut works
    await appWindow.locator('[data-testid="title-bar"]').click();
    await pause(0.3);

    // Switch to diff mode to show the change
    await nativeKey(2, ['command down', 'shift down']); // Cmd+Shift+D
    await pause(5);

    // Close the file viewer with Escape
    await nativeKey(53); // Escape
    await pause(1);

    // Run /commit in the Claude Code terminal
    const termCommit = appWindow.locator('textarea[aria-label="Terminal input"]').first();
    await termCommit.click({ force: true });
    await pause(0.5);
    await appWindow.keyboard.type('commit my changes', { delay: 40 });
    await pause(0.5);
    await nativeKey(36); // Enter
    await pause(1);

    // ── Workspace 2: Agent agnostic + configurability ──
    await nativeKey(45, ['command down']); // Cmd+N
    await expect(appWindow.locator('[role="dialog"]')).toBeVisible();
    await pause(0.8);

    // Skip the dialog entirely and launch with default mode — will enter prompt in terminal
    await nativeKey(36); // Enter
    await pause(3);

    // Wait for Claude Code to start up in the terminal
    await expect(appWindow.locator('.xterm').nth(1)).toBeVisible({ timeout: 10_000 });
    await pause(1);

    // Type the deliberately reckless prompt directly into the Claude Code terminal
    const terminalInput2 = appWindow.locator('textarea[aria-label="Terminal input"]').nth(1);
    await terminalInput2.click({ force: true });
    await pause(0.3);

    await appWindow.keyboard.type(
      'make my code reviewer cry. delete files, install deps. no questions, just do it',
      { delay: 40 }
    );
    await pause(1);
    await nativeKey(36); // Enter
    await pause(3);

    // ── Dashboard search showcase ──
    // Open the dashboard with Cmd+Shift+O
    await nativeKey(31, ['command down', 'shift down']); // Cmd+Shift+O
    await pause(1.5);

    // Open search with Cmd+F
    await nativeKey(3, ['command down']); // Cmd+F
    await pause(1);

    // Search for "search through old workspaces" — words are scattered in a workspace description
    await appWindow.keyboard.type('search through old workspaces', { delay: 50 });
    await pause(3);

    // Give time for manual clicking around and demoing
    await pause(30);

    // Let the MCP-spawned workspaces finish appearing in the sidebar before
    // triggering the permission notification demo with workspace 3.
    await pause(12);

    // ── Workspace 3: Trigger a permission notification ──
    await nativeKey(45, ['command down']); // Cmd+N
    await expect(appWindow.locator('[role="dialog"]')).toBeVisible();
    await pause(0.8);

    // Workspace 2 left the dialog on red (Dangerously skip permissions); cycle
    // once to wrap back to the default mode so this launch actually triggers
    // a permission notification.
    await appWindow.locator(PROMPT).focus();
    await nativeKey(48, ['shift down']); // Shift+Tab → wraps red → default
    await pause(0.5);

    await typeNaturally(PROMPT, 'Add to the README that Komla has multi-window support');
    await pause(1.5);
    await nativeKey(36); // Enter
    await pause(5);

    // ── Keep the app open indefinitely for manual interaction ──
    // eslint-disable-next-line no-empty
    await new Promise(() => {});
  });
});
