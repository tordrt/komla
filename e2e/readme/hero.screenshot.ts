/**
 * The README's hero image, docs/readme/hero.webp: the hero video's world, held at a moment that
 * shows what Komla is for. Claude Code and Codex work side by side in Card Retries while the
 * sidebar says which of the other agents is working, done or waiting for an answer.
 *
 * `npm run screenshots:readme` takes it. It needs what the hero video does (see "Landing videos"
 * in e2e/AGENTS.md), and on Linux a virtual display big enough for the window at 2×:
 * `xvfb-run -a -s "-screen 0 3200x2000x24" npm run screenshots:readme`.
 */
import path from 'path';
import { fileURLToPath } from 'url';

import sharp from 'sharp';

import { TRAFFIC_LIGHTS } from '../../scripts/traffic-lights.mjs';
import {
  ASK,
  CODEX_TESTS,
  DARK_MODE,
  FINISH,
  GO,
  HERO_RETRIES,
  HERO_WORLD,
  HOLD,
  PRICING,
  RATE_LIMIT,
} from '../videos/hero.scene';
import {
  videoTest as test,
  agentCommand,
  cueAgent,
  expect,
  setFilePanel,
  SPLIT_RIGHT,
  type VideoWorkspace,
  type VideoWorld,
  waitForAgentAt,
  waitForAgentTurn,
} from '../videos/video-fixtures';

const OUTPUT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'docs',
  'readme',
  'hero.webp'
);
// Tall enough for Claude Code's banner, the retries' diff and its prompt in one pane.
const WINDOW = { width: 1280, height: 860 };
// The README shows it 960 wide, so 2× stays sharp on a high-density display.
const PIXEL_RATIO = 2;

/** The macOS traffic lights, which are OS chrome a page screenshot leaves out. */
function trafficLights(): Buffer {
  const s = PIXEL_RATIO;
  const { x, y, gap, radius, colors } = TRAFFIC_LIGHTS;
  const circles = colors.map(
    (color, i) =>
      `<circle cx="${(x + i * gap) * s}" cy="${y * s}" r="${radius * s}" fill="${color}" stroke="rgba(0,0,0,0.25)" stroke-width="${0.5 * s}"/>`
  );
  const width = (x + gap * colors.length) * s;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${y * 2 * s}">${circles.join('')}</svg>`
  );
}

const GATEWAY = 'src/billing/gateway.js';
const retriesTurn = HERO_RETRIES.agent!.turns![0];
// Claude Code adds the retries Codex is testing and stops there. The gateway's timeout, which
// follows in the video, would push Claude Code's banner out of view.
const retriesEvents = retriesTurn.events.filter(
  (event) =>
    !(('edit' in event && event.edit === GATEWAY) || ('arg' in event && event.arg === GATEWAY))
);
if (retriesEvents.length !== retriesTurn.events.length - 2) {
  throw new Error(
    `Card Retries no longer reads and then edits ${GATEWAY}; see agent-panes.scene.ts`
  );
}
const RETRIES: VideoWorkspace = {
  ...HERO_RETRIES,
  agent: { ...HERO_RETRIES.agent, turns: [{ ...retriesTurn, events: retriesEvents }] },
};
const WORLD: VideoWorld = {
  ...HERO_WORLD,
  workspaces: HERO_WORLD.workspaces.map((workspace) =>
    workspace === HERO_RETRIES ? RETRIES : workspace
  ),
};

test.use({ world: WORLD, windowSize: WINDOW, pixelRatio: PIXEL_RATIO });

test('README hero', async ({ appWindow: page }) => {
  test.setTimeout(240_000);
  const card = (title: string) =>
    page.getByRole('button', { name: `Workspace details for ${title}` });
  const terminal = page.getByRole('textbox', { name: 'Terminal input' }).filter({ visible: true });
  // Each agent starts when its workspace is first opened.
  const open = async (title: string) => {
    await card(title).click();
    await setFilePanel(page, false);
  };

  await open(PRICING.title);
  await waitForAgentAt(PRICING.branch, GO);
  await open(RATE_LIMIT.title);
  // Pricing Page finishes while another workspace is in view, so its Done badge stays.
  cueAgent(PRICING.branch, GO);
  await waitForAgentTurn(PRICING.branch);
  await expect(card(PRICING.title)).toContainText('Done');
  // Rate Limiting stays at work.
  await waitForAgentAt(RATE_LIMIT.branch, FINISH);
  await open(DARK_MODE.title);
  await waitForAgentAt(DARK_MODE.branch, ASK);

  // Card Retries: Claude Code, with Codex writing its tests in a pane beside it.
  await open(RETRIES.title);
  await waitForAgentAt(RETRIES.branch, GO);
  await terminal.first().focus();
  await page.keyboard.press(SPLIT_RIGHT);
  await expect(terminal).toHaveCount(2);
  await terminal.last().focus();
  await page.keyboard.type(agentCommand(WORLD, CODEX_TESTS));
  await page.keyboard.press('Enter');
  await waitForAgentAt(CODEX_TESTS, HOLD);
  cueAgent(RETRIES.branch, GO);
  await waitForAgentAt(RETRIES.branch, HOLD);
  // A click, as focusing its input alone leaves Codex's the focused pane, which names the tab. In
  // the pane's bottom corner, below and beside what the agent printed, so it clicks no link.
  const claudeCode = page.locator('.xterm-screen').filter({ visible: true }).first();
  const pane = (await claudeCode.boundingBox())!;
  await claudeCode.click({ position: { x: pane.width - 8, y: pane.height - 8 } });

  // Dark Mode stops for permission while Card Retries is in view, and its card says so.
  cueAgent(DARK_MODE.branch, ASK);
  await expect(card(DARK_MODE.title)).toContainText(/input/i);
  // The agents are where the still wants them before Komla shows it: wait for the host to report
  // both agents' changes, Claude Code's retries and Codex's tests, and for the status bar's tally.
  // A card's change counts sit beside its details button, in the card itself.
  const counts = (title: string) => card(title).locator('xpath=..');
  await expect(
    counts(RETRIES.title),
    "Card Retries' card counts the retries and their tests, as agent-panes.scene.ts writes them"
  ).toContainText('+35', { timeout: 30_000 });
  for (const { title } of WORLD.workspaces) await expect(counts(title)).toContainText(/\+\d/);
  await expect(page.getByRole('button', { name: /1 needs input/ })).toBeVisible();
  // Off to the side, where it hovers nothing into view.
  await page.mouse.move(WINDOW.width - 40, WINDOW.height - 60);

  const shot = sharp(await page.screenshot());
  // The traffic lights are drawn for this density, and the README is laid out for it.
  const { width, height } = await shot.metadata();
  expect([width, height]).toEqual([WINDOW.width * PIXEL_RATIO, WINDOW.height * PIXEL_RATIO]);
  if (process.platform === 'darwin') shot.composite([{ input: trafficLights(), top: 0, left: 0 }]);
  await shot.webp({ lossless: true }).toFile(OUTPUT);
});
