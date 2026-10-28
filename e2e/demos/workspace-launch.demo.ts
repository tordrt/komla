import { demoTest as test, expect } from '../demo-fixtures';

const PROMPT = 'textarea[placeholder*="What should the agent work on"]';

test.setTimeout(300_000); // 5 min — needs time for MCP finale

test.describe('Demo: Launching Workspaces', () => {
  test('workspace launch narrative', async ({
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

    await typeNaturally(PROMPT, 'Run and monitor isolated AI coding agents, side by side');
    await pause(1.5);
    await typeNaturally(
      PROMPT,
      '\nWork on multiple things at once. No waiting. Watch every agent in real time.'
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
      'Redesign the website in site/ — spawn 5 komla workspaces, each with a different approach',
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

    // Split pane vertically while MCP workspaces spawn in the background
    await nativeKey(42, ['command down']); // Cmd+\
    await pause(1.5);

    // Cat a pre-seeded file in the new split pane
    const splitTerminal = appWindow.locator('textarea[aria-label="Terminal input"]').last();
    await splitTerminal.focus();
    await pause(0.3);
    await appWindow.keyboard.type('cat workspace-setup.md', { delay: 40 });
    await pause(0.5);
    await nativeKey(36); // Enter
    await pause(3);

    // Let the MCP-spawned workspaces finish appearing in the sidebar and
    // settle in (longer pause gives the agents time to actually do work
    // before we move on to the launch-modes walkthrough).
    await pause(12);

    // ── Workspace 2: Launch modes walkthrough ──
    // Marketing copy explains the launch mode picker while we cycle through
    // it and wrap back to the default mode. Then we wipe the copy and launch
    // with an empty prompt so Claude Code starts cleanly.
    await nativeKey(45, ['command down']); // Cmd+N
    await expect(appWindow.locator('[role="dialog"]')).toBeVisible();
    await pause(1);

    await typeNaturally(PROMPT, 'Bring any CLI agent — Claude Code, Codex, OpenCode, your own.');
    await pause(2);

    // Cycle launch modes (Default → Plan → Accept edits → Auto → Dangerously skip → Default).
    // Pause on each so the viewer registers the colored pill changing.
    await nativeKey(48, ['shift down']); // → Plan (blue)
    await pause(1);
    await nativeKey(48, ['shift down']); // → Accept edits (purple)
    await pause(1);
    await nativeKey(48, ['shift down']); // → Auto (orange)
    await pause(1);
    await nativeKey(48, ['shift down']); // → Dangerously skip (red)
    await pause(1);
    await nativeKey(48, ['shift down']); // → wraps back to default
    await pause(1.5);

    // Wipe the info copy slowly so the viewer sees what's happening
    await appWindow.locator(PROMPT).focus();
    await nativeKey(0, ['command down']); // Cmd+A
    await pause(0.5);
    await nativeKey(51); // Backspace
    await pause(0.8);

    // Enter to launch with empty prompt on the default mode
    await nativeKey(36); // Enter
    await pause(3);

    // Wait for Claude Code to start up in the new workspace.
    // Filter to :visible — the DOM has many hidden .xterm nodes from
    // MCP-spawned and trashed workspaces, so .last() and nth() both drift.
    await expect(appWindow.locator('.xterm:visible').first()).toBeVisible({ timeout: 10_000 });
    await pause(2);

    // ── Workspace 3: Trigger a permission notification ──
    // Workspace 2 left the dialog on the default mode, so this launch
    // actually triggers a prompt.
    await nativeKey(45, ['command down']); // Cmd+N
    await expect(appWindow.locator('[role="dialog"]')).toBeVisible();
    await pause(0.8);

    await appWindow.locator(PROMPT).focus();
    await typeNaturally(PROMPT, 'Add a highlights section to the README');
    await pause(1.5);
    await nativeKey(36); // Enter
    await pause(5);

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

    // Give time for manual clicking around and demoing.
    // Exit the dashboard manually before Phase 2 starts.
    await pause(30);

    // ══════════════════════════════════════════════
    // PHASE 2 — File viewer + editing showcase
    // ══════════════════════════════════════════════

    // ── File search + viewer showcase ──
    // Double-tap Shift via native flagsChanged CGEvents (compiled Swift binary)
    // Longer taps (200ms hold) so screen recording software can catch them
    nativeDoubleTapShift(200, 200);
    await pause(1);

    // Initial query — short content match to show results populating
    await appWindow.keyboard.type('stay in control', { delay: 50 });
    await pause(1.5);

    // Tab to switch to content search mode
    await nativeKey(48); // Tab
    await pause(1);

    // Refine to a more specific phrase from the file
    await nativeKey(0, ['command down']); // Cmd+A to select previous text
    await pause(0.3);
    await appWindow.keyboard.type('every isolated agent', { delay: 50 });
    await pause(1.5);

    // Enter to open the file in the viewer
    await nativeKey(36); // Enter
    await pause(3);

    // Focus the editor and go to end of file. Click the hidden textarea
    // directly — clicking the wrapper can leave Monaco's input target
    // unfocused (or get yanked back to the file tree's focus-steal).
    await appWindow.locator('.monaco-editor textarea').first().click();
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

    // ── Keep the app open indefinitely for manual interaction ──
    // eslint-disable-next-line no-empty
    await new Promise(() => {});
  });
});
