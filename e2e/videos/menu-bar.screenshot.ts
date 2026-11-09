/**
 * Captures Komla's macOS menu bar item and its agents popover from the real screen, as a PNG
 * of each and a short screen recording. Run it with `scripts/capture-menu-bar.sh`; it skips
 * itself otherwise, so `npm run videos` doesn't touch your screen.
 *
 * The item and its popover are native: they live outside Komla's window, so the page recorder
 * can't see them. This asks macOS for the pixels (`screencapture`) and, to find and click the
 * item, for its position (System Events). Both need a permission for the terminal running this:
 * Screen Recording and Accessibility, under System Settings > Privacy & Security.
 *
 * The cast is the hero's: Card Retries working, Dark Mode waiting for permission, Pricing Page
 * done, and Rate Limiting finishing during the recording, so the item's counts change on screen.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  ASK,
  DARK_MODE,
  FINISH,
  GO,
  HERO_RETRIES,
  HERO_WORLD,
  PRICING,
  RATE_LIMIT,
} from './hero.scene';
import {
  videoTest as test,
  cueAgent,
  expect,
  setFilePanel,
  waitForAgentAt,
  waitForAgentTurn,
} from './video-fixtures';

import type { ElectronApplication, Page } from '@playwright/test';

const OUT_DIR = process.env.KOMLA_MENU_BAR_OUT ?? path.join(__dirname, 'output', 'menu-bar');
const RECORD_SECONDS = 14;

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

test.skip(process.platform !== 'darwin', 'The menu bar item exists only on macOS.');
test.skip(!process.env.KOMLA_MENU_BAR_CAPTURE, 'Run scripts/capture-menu-bar.sh.');
test.use({ world: HERO_WORLD, windowSize: { width: 760, height: 560 } });

/** The menu bar item's place on screen in points, read from System Events once it has appeared. */
async function menuBarItem(pid: number): Promise<Rect> {
  const script = `tell application "System Events"
  tell (first process whose unix id is ${pid})
    set theItem to menu bar item 1 of menu bar 2
    set p to position of theItem
    set s to size of theItem
    return ((item 1 of p) as text) & "," & ((item 2 of p) as text) & "," & ((item 1 of s) as text) & "," & ((item 2 of s) as text)
  end tell
end tell`;
  let failure = '';
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const [x, y, width, height] = execFileSync('osascript', ['-e', script], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
        .trim()
        .split(',')
        .map(Number);
      return { x, y, width, height };
    } catch (error) {
      failure = String((error as { stderr?: string }).stderr ?? error);
      // Not allowed (1743 / -25211) won't pass with waiting.
      if (/not allowed|assistive|-25211|-1719/i.test(failure)) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(
    `Could not find Komla's menu bar item through System Events:\n${failure}\n` +
      'Allow your terminal under System Settings > Privacy & Security > Accessibility.'
  );
}

/** Clicks the menu bar item as a user would. */
function clickMenuBarItem(pid: number): void {
  execFileSync('osascript', [
    '-e',
    `tell application "System Events" to tell (first process whose unix id is ${pid}) to click menu bar item 1 of menu bar 2`,
  ]);
}

const region = ({ x, y, width, height }: Rect) =>
  [x, y, width, height].map((n) => Math.round(n)).join(',');

function screenshot(file: string, area: Rect): void {
  // -x: no shutter sound. The PNG is at the display's own resolution (2x on Retina).
  execFileSync('screencapture', ['-x', '-R', region(area), file]);
}

/** The agents popover's window, once open: Komla's one alwaysOnTop panel. */
async function popoverBounds(app: ElectronApplication): Promise<Rect | null> {
  return app.evaluate(({ BrowserWindow }) => {
    const panel = BrowserWindow.getAllWindows().find((w) => w.isVisible() && w.isAlwaysOnTop());
    return panel ? panel.getBounds() : null;
  });
}

async function popoverPage(app: ElectronApplication): Promise<Page | null> {
  return app.windows().find((w) => w.url().includes('agents-menu-bar')) ?? null;
}

test('menu bar item', async ({ appWindow: page, electronApp }) => {
  test.setTimeout(300_000);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const pid = electronApp.process().pid!;
  const card = (title: string) =>
    page.getByRole('button', { name: `Workspace details for ${title}` });
  const open = async (title: string) => {
    await card(title).click();
    await setFilePanel(page, false);
  };

  // Each agent starts when its workspace is first opened.
  await open(PRICING.title);
  await waitForAgentAt(PRICING.branch, GO);
  await open(RATE_LIMIT.title);
  // Pricing Page finishes with another workspace in view, so it stays Done.
  cueAgent(PRICING.branch, GO);
  await waitForAgentAt(RATE_LIMIT.branch, FINISH);
  await open(DARK_MODE.title);
  await waitForAgentAt(DARK_MODE.branch, ASK);
  await waitForAgentTurn(PRICING.branch);
  await open(HERO_RETRIES.title);
  await waitForAgentAt(HERO_RETRIES.branch, GO);
  await expect(card(PRICING.title)).toContainText('Done');

  // Komla's window to the left, out from under the popover.
  const screen = await electronApp.evaluate(({ screen: electronScreen, BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.isVisible())!;
    win.setPosition(24, 80);
    return electronScreen.getPrimaryDisplay().bounds;
  });

  const item = await menuBarItem(pid);
  const menuBarHeight = item.y + item.height;
  // The right edge of the menu bar: this item, its neighbours and the clock.
  const barArea: Rect = {
    x: screen.x + screen.width - 520,
    y: screen.y,
    width: 520,
    height: menuBarHeight,
  };
  const itemArea: Rect = {
    x: item.x - 40,
    y: screen.y,
    width: item.width + 80,
    height: menuBarHeight,
  };
  screenshot(path.join(OUT_DIR, 'menu-bar-item.png'), itemArea);
  screenshot(path.join(OUT_DIR, 'menu-bar.png'), barArea);

  // The recording: the menu bar's right edge and the popover under it.
  const videoArea: Rect = {
    x: screen.x + screen.width - 640,
    y: screen.y,
    width: 640,
    height: 520,
  };
  const videoFile = path.join(OUT_DIR, 'menu-bar.mov');
  fs.rmSync(videoFile, { force: true });
  const recording = spawn(
    'screencapture',
    ['-v', '-x', '-V', String(RECORD_SECONDS), '-R', region(videoArea), videoFile],
    { stdio: 'ignore' }
  );
  const recorded = new Promise<void>((resolve, reject) => {
    recording.once('error', reject);
    recording.once('exit', () => resolve());
  });
  // The recorder takes a moment to start.
  await page.waitForTimeout(2000);

  // Rate Limiting finishes: the item gains a Done.
  cueAgent(RATE_LIMIT.branch, FINISH);
  await waitForAgentTurn(RATE_LIMIT.branch);
  await page.waitForTimeout(2500);

  // Open its popover.
  clickMenuBarItem(pid);
  await expect.poll(() => popoverBounds(electronApp), { timeout: 15_000 }).not.toBeNull();
  await page.waitForTimeout(1500);
  const popover = (await popoverPage(electronApp))!;
  const bounds = (await popoverBounds(electronApp))!;
  screenshot(path.join(OUT_DIR, 'menu-bar-popover.png'), {
    x: Math.min(bounds.x, videoArea.x),
    y: screen.y,
    width: screen.x + screen.width - Math.min(bounds.x, videoArea.x),
    height: bounds.y + bounds.height - screen.y,
  });

  // A row's card on hover, with its last prompt.
  await popover
    ?.getByText(DARK_MODE.title)
    .first()
    .hover({ timeout: 3000 })
    .catch(() => undefined);
  await page.waitForTimeout(2500);
  const hovered = await popoverBounds(electronApp);
  if (hovered) {
    screenshot(path.join(OUT_DIR, 'menu-bar-popover-card.png'), {
      x: Math.min(hovered.x, videoArea.x),
      y: screen.y,
      width: screen.x + screen.width - Math.min(hovered.x, videoArea.x),
      height: hovered.y + hovered.height - screen.y,
    });
  }

  // Closed the way a menu is: by clicking the item again.
  clickMenuBarItem(pid);
  await recorded;
  console.log(`Menu bar captures are in ${OUT_DIR}`);
});
