/**
 * Showcase: ports forward themselves. The agent starts its dev server on the
 * devbox SSH host and previews it; Komla offers to open it, and the page opens
 * beside the agent at localhost, through a tunnel Komla made, which the SSH
 * host's status bar item lists with the rest of its forwarded ports.
 */
import { PRICING_WEB, YEARLY_EVENTS } from './browser-preview.scene';
import {
  videoTest as test,
  expect,
  setFilePanel,
  waitForAgentAt,
  waitForAgentTurn,
  waitForPageLoaded,
  type VideoWorkspace,
  type VideoWorld,
} from './video-fixtures';
import { BACKGROUND_WORKSPACES, DEVBOX } from './worlds';

const PORT = 5173;
const URL = `http://localhost:${PORT}`;
const GO = 'go';

const PRICING: VideoWorkspace = {
  id: 'ws-pricing',
  projectId: PRICING_WEB.id,
  title: 'Yearly Pricing',
  branch: 'yearly-pricing',
  minutesAgo: 0,
  agent: {
    title: '✳ Yearly pricing',
    turns: [
      {
        auto: true,
        afterMs: 200,
        prompt: 'Add yearly billing to the pricing page and show me',
        verb: 'Pricing',
        doneVerb: 'Baked',
        events: [
          { waitFor: GO },
          // The yearly edits, then its dev server on the devbox instead of the scene's own port.
          ...YEARLY_EVENTS.filter((event) => !('serve' in event)),
          { serve: 'site', port: PORT, command: 'npm run dev', delay: 500 },
          { bash: `komla preview ${URL}`, delay: 600 },
          { say: `The dev server is running on devbox at\n${URL}`, delay: 300 },
        ],
      },
    ],
  },
};

const WORLD: VideoWorld = {
  sshHost: DEVBOX,
  projects: [PRICING_WEB],
  workspaces: [PRICING, ...BACKGROUND_WORKSPACES],
  // Pages open beside the terminal instead of over it.
  config: { defaultInlinePreviewLayout: 'side-by-side' },
};

// Wide enough for the terminal and the page side by side; renders to a 1280×736 slot.
const WINDOW = { width: 1440, height: 828 };
test.use({ world: WORLD, windowSize: WINDOW });

test('ssh ports', async ({ appWindow: page, electronApp, director }) => {
  test.setTimeout(180_000);
  const terminal = page.getByRole('textbox', { name: 'Terminal input' }).filter({ visible: true });
  const offer = page.getByRole('dialog', { name: 'Preview ready' });
  const hosts = page.getByRole('button', { name: /^SSH hosts:/ });
  const ports = page.getByRole('list', { name: /^Ports forwarded for/ });

  await page.getByRole('button', { name: `Workspace details for ${PRICING.title}` }).click();
  await setFilePanel(page, false);
  await waitForAgentAt(PRICING.branch, GO);
  await terminal.first().focus();
  await page.mouse.move(WINDOW.width - 40, WINDOW.height - 60);

  await director.start();
  director.poster();
  director.cue(PRICING.branch, GO);
  // The agent's edits, then its dev server on the devbox; Komla offers to open the page.
  director.speed(2);
  await expect(offer).toBeVisible({ timeout: 30_000 });
  director.speed(1);
  await director.camera(offer, { padding: 140, duration: 0.6 });
  await director.hold(1.2);
  await director.click(offer.getByRole('button', { name: 'Open in Komla' }), { duration: 0.7 });
  await director.camera('full', { duration: 0.6 });

  // It opens beside the agent at localhost, through a tunnel to the devbox.
  director.speed(2);
  await waitForPageLoaded(electronApp, `:${PORT}`);
  director.speed(1);
  await waitForAgentTurn(PRICING.branch);
  await director.hold(1.6);

  // The devbox's status bar item lists the port it forwards, and for which workspace.
  await director.click(hosts, { duration: 0.8 });
  await expect(ports).toBeVisible();
  await director.camera(page.getByRole('dialog').filter({ has: ports }), {
    padding: 70,
    duration: 0.6,
  });
  await director.moveTo(ports.getByRole('listitem').first(), { duration: 0.5 });
  await director.hold(2.2);
  await director.camera('full', { duration: 0.6 });
  await director.press('Escape', { badge: false });
  await expect(ports).toBeHidden();
  await director.hold(1.2);

  await director.finish({
    name: 'showcase-ssh-ports-dark',
    width: 1280,
    height: 736,
    loopFade: 0.5,
  });
});
